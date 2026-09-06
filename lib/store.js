'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Lite 数据目录：内容寻址 PDF 缓存 + 产品页 Markdown 缓存 + 导出产物 + 采集索引。
// 目录布局：
//   data/cache/pdfs/<sha256>.pdf
//   data/cache/pages/<hash>.md
//   data/exports/
//   data/index.json
class Store {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.pdfDir = path.join(this.rootDir, 'cache', 'pdfs');
    this.pageDir = path.join(this.rootDir, 'cache', 'pages');
    this.exportsDir = path.join(this.rootDir, 'exports');
    this.indexFile = path.join(this.rootDir, 'index.json');
    for (const dir of [this.pdfDir, this.pageDir, this.exportsDir, this.rootDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.writeJsonAtomic(this.indexFile, this.loadIndex());
  }

  writeJsonAtomic(filePath, value) {
    const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, filePath);
  }

  loadIndex() {
    let raw;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch {
      return { schemaVersion: '1.0', documents: {}, updatedAt: '' }; // 文件不存在：首次运行
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.protectCorruptIndex('parse', error);
      return { schemaVersion: '1.0', documents: {}, updatedAt: '' };
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.documents) {
      this.protectCorruptIndex('structure', new Error('index 缺少 documents 结构'));
      return { schemaVersion: '1.0', documents: {}, updatedAt: '' };
    }
    return parsed;
  }

  // 损坏原件保护：备份成功才允许后续写回；备份失败则阻断写索引（防覆盖原件造成数据丢失）
  protectCorruptIndex(reason, error) {
    const backup = `${this.indexFile}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(this.indexFile, backup);
      console.log(JSON.stringify({ event: 'nvci_lite_index_corrupt', level: 'error', reason, backup, error: String(error.message || error), at: new Date().toISOString() }));
    } catch (backupError) {
      this.indexWriteBlocked = true;
      console.log(JSON.stringify({ event: 'nvci_lite_index_backup_failed', level: 'error', reason, backupError: String(backupError.message || backupError), at: new Date().toISOString() }));
    }
  }

  saveIndex(index) {
    if (this.indexWriteBlocked) {
      console.log(JSON.stringify({ event: 'nvci_lite_index_write_blocked', level: 'error', at: new Date().toISOString() }));
      return;
    }
    index.updatedAt = new Date().toISOString();
    this.writeJsonAtomic(this.indexFile, index);
  }

  upsertIndexEntry(row) {
    const index = this.loadIndex();
    const existing = index.documents[row.documentId] || {};
    index.documents[row.documentId] = { ...existing, ...row };
    this.saveIndex(index);
  }

  getIndexEntry(documentId) {
    return this.loadIndex().documents[documentId] || null;
  }

  pdfPath(sha256) { return path.join(this.pdfDir, `${sha256}.pdf`); }

  pdfRelativePath(sha256) { return path.join('cache', 'pdfs', `${sha256}.pdf`); }

  pdfExists(sha256) {
    try { return fs.statSync(this.pdfPath(sha256)).size > 0; } catch { return false; }
  }

  readPdf(sha256) { return fs.readFileSync(this.pdfPath(sha256)); }

  writePdf(sha256, buffer) {
    const destination = this.pdfPath(sha256);
    if (this.pdfExists(sha256)) return destination;
    const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, destination);
    return destination;
  }

  writePageMarkdown(documentId, markdown, meta = {}) {
    const hash = crypto.createHash('sha256').update(markdown).digest('hex').slice(0, 16);
    const fileName = `${documentId}.${hash}.md`;
    fs.writeFileSync(path.join(this.pageDir, fileName), markdown, 'utf8');
    return { path: path.join('cache', 'pages', fileName), bytes: Buffer.byteLength(markdown), ...meta };
  }

  readPageMarkdown(relativePath) {
    return fs.readFileSync(path.join(this.rootDir, relativePath), 'utf8');
  }

  library() {
    const index = this.loadIndex();
    return Object.values(index.documents)
      .filter((entry) => entry.status === 'completed' && this.pdfExists(entry.sha256))
      .map((entry) => ({
        documentId: entry.documentId,
        vendorName: entry.vendorName,
        series: entry.series,
        modelNames: entry.modelNames || [],
        productLineName: entry.productLineName,
        officialFileName: entry.officialFileName,
        pdfUrl: entry.sourceUrl || entry.pdfUrl,
        productPageUrl: entry.productPageUrl || '',
        sha256: entry.sha256,
        pageCount: entry.pageCount || 0,
        bytes: entry.bytes || 0,
        warning: entry.warning || '',
        collectedBy: entry.collectedBy || 'auto',
        collectedAt: entry.completedAt || entry.updatedAt || '',
        pageMarkdown: entry.pageMarkdown || null,
      }))
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName, 'zh-CN') || a.series.localeCompare(b.series, 'zh-CN'));
  }

  // 一次分析的 Excel/Word/材料包共享同一 base（runId 语义）：毫秒 + 随机后缀，
  // 同毫秒并发分析也不共用文件名；磁盘占用任一扩展名时追加序号。
  exportBaseName(stem) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '') + String(now.getMilliseconds()).padStart(3, '0');
    const rand = require('crypto').randomBytes(2).toString('hex');
    const safeStem = String(stem).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
    let candidate = `${day}_${safeStem}_${time}${rand}`;
    const taken = (base) => ['.xlsx', '.docx', '.md'].some((ext) => fs.existsSync(path.join(this.exportsDir, base + ext)));
    for (let seq = 2; taken(candidate); seq += 1) {
      candidate = `${day}_${safeStem}_${time}${rand}-${seq}`;
    }
    return candidate;
  }

  exportFileName(stem, extension) {
    return `${this.exportBaseName(stem)}.${extension}`;
  }

  exportPath(fileName) { return path.join(this.exportsDir, fileName); }

  listExports() {
    return fs.readdirSync(this.exportsDir)
      .filter((name) => /\.(xlsx|docx|md)$/i.test(name))
      .map((name) => {
        const full = path.join(this.exportsDir, name);
        const stat = fs.statSync(full);
        return { fileName: name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

module.exports = { Store };
