'use strict';

// 状态备份/恢复（评审阶段0：状态文件无备份策略）：
// - 范围：数据目录根下的全部 *.json（index/confirmations/probe-state/settings/ai-cache）
//   + custom-profiles/*.json——人工核对与自定义登记是不可再生数据，必须可恢复。
// - 不含 PDF 库与导出物：体积大且可由来源重采；NAS 宿主卷级备份属部署侧职责。
// - 形态：单文件 JSON bundle（含 schemaVersion 与文件清单），人工可检、恢复零依赖。
// - 轮转：默认保留最近 14 份，超出删最旧。

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';
const BACKUP_DIR_NAME = 'backups';
const DEFAULT_KEEP = 14;
const CUSTOM_DIR_NAME = 'custom-profiles';

function backupDir(dataDir) {
  return path.join(dataDir, BACKUP_DIR_NAME);
}

function listBackupFiles(dataDir) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^backup-\d{4}-\d{2}-\d{2}T.+\.json$/.test(name))
    .sort();
}

// 收集待备份文件（相对 dataDir 的 POSIX 风格路径 → 绝对路径）
function collectStateFiles(dataDir) {
  const files = [];
  for (const name of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, name);
    if (fs.statSync(full).isFile() && name.endsWith('.json')) files.push(name);
  }
  const customDir = path.join(dataDir, CUSTOM_DIR_NAME);
  if (fs.existsSync(customDir)) {
    for (const name of fs.readdirSync(customDir)) {
      if (name.endsWith('.json')) files.push(`${CUSTOM_DIR_NAME}/${name}`);
    }
  }
  return files;
}

// 生成 bundle：{ schemaVersion, createdAt, files: { 相对路径: 原始文本 } }
function createBackup(dataDir, now = new Date()) {
  const relatives = collectStateFiles(dataDir);
  if (!relatives.length) throw new Error(`数据目录没有可备份的状态文件：${dataDir}`);
  const files = {};
  for (const relative of relatives) {
    files[relative] = fs.readFileSync(path.join(dataDir, relative), 'utf8');
    JSON.parse(files[relative]); // 备份前先验证是合法 JSON：坏文件当场暴露，不带进备份
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `backup-${stamp}.json`;
  fs.mkdirSync(backupDir(dataDir), { recursive: true });
  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    fileCount: relatives.length,
    files,
  };
  const outPath = path.join(backupDir(dataDir), fileName);
  const temp = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, outPath);
  const removed = rotate(dataDir);
  return { fileName, outPath, fileCount: relatives.length, removed };
}

// 轮转：只保留最近 keep 份，返回被删除的文件名
function rotate(dataDir, keep = DEFAULT_KEEP) {
  const all = listBackupFiles(dataDir);
  const excess = all.slice(0, Math.max(0, all.length - keep));
  for (const name of excess) fs.unlinkSync(path.join(backupDir(dataDir), name));
  return excess;
}

// 恢复：fileName 传具体文件名或 'latest'。逐文件原子写（temp+rename），
// 只覆盖 bundle 内的文件，不动其他数据；恢复 probe-state 等内存态需重启服务。
function restoreBackup(dataDir, fileName) {
  const all = listBackupFiles(dataDir);
  const target = fileName === 'latest' ? all[all.length - 1] : fileName;
  if (!target || !all.includes(target)) {
    throw new Error(`备份文件不存在：${target || '（无备份）'}；现有：${all.join('、') || '无'}`);
  }
  const bundle = JSON.parse(fs.readFileSync(path.join(backupDir(dataDir), target), 'utf8'));
  if (bundle.schemaVersion !== SCHEMA_VERSION || !bundle.files || typeof bundle.files !== 'object') {
    throw new Error(`备份文件格式无效（schemaVersion=${bundle.schemaVersion}）：${target}`);
  }
  const restored = [];
  for (const [relative, content] of Object.entries(bundle.files)) {
    JSON.parse(content); // 恢复前同样验证
    const dest = path.join(dataDir, relative);
    if (!dest.startsWith(path.join(dataDir, ''))) throw new Error(`备份内路径越界：${relative}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const temp = `${dest}.restore-tmp-${process.pid}`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, dest);
    restored.push(relative);
  }
  return { fileName: target, createdAt: bundle.createdAt, restored };
}

module.exports = { createBackup, restoreBackup, listBackupFiles, rotate, backupDir, SCHEMA_VERSION, DEFAULT_KEEP };
