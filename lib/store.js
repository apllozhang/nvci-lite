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
    try {
      const index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (index && typeof index === 'object' && index.documents) return index;
    } catch { /* 首次运行或损坏时重建 */ }
    return { schemaVersion: '1.0', documents: {}, updatedAt: '' };
  }

  saveIndex(index) {
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
        collectedAt: entry.completedAt || entry.updatedAt || '',
        pageMarkdown: entry.pageMarkdown || null,
      }))
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName, 'zh-CN') || a.series.localeCompare(b.series, 'zh-CN'));
  }

  exportFileName(stem, extension) {
    const day = new Date().toISOString().slice(0, 10);
    const safeStem = String(stem).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
    return `${day}_${safeStem}.${extension}`;
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
