'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');

test('导出文件名：同组合连续生成不互相覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-store-name-'));
  try {
    const store = new Store(dir);
    const a = store.exportFileName('对比_A_vs_B', 'xlsx');
    const b = store.exportFileName('对比_A_vs_B', 'xlsx');
    assert.notEqual(a, b, '毫秒级时间戳保证连续两次生成不同');
    assert.match(a, /_对比_A_vs_B_\d{9}\.xlsx$/, '含日期+时分秒毫秒');
    assert.match(b, /_对比_A_vs_B_\d{9}\.xlsx$/);
    // 已落盘文件占名时追加序号（防跨进程覆盖）
    fs.writeFileSync(path.join(dir, b), 'x');
    const c = store.exportFileName('对比_A_vs_B', 'xlsx');
    assert.notEqual(c, b, '与磁盘已有文件同名时必须让位');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('索引损坏：保留损坏原件备份，不静默丢弃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-store-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.json'), '{ 损坏的 JSON', 'utf8');
    const store = new Store(dir);
    assert.deepEqual(Object.keys(store.loadIndex().documents), [], '损坏后以空索引继续服务');
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('index.json.corrupt-'));
    assert.equal(backups.length, 1, '损坏原件已备份');
    assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /损坏的 JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('library()：透传来源方式（自动采集/人工上传）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-store-src-'));
  try {
    const store = new Store(dir);
    const buffer = Buffer.from('%PDF-1.4 test');
    store.writePdf('a'.repeat(64), buffer);
    store.upsertIndexEntry({ documentId: 'auto-1', vendorName: 'V', series: 'S', status: 'completed', sha256: 'a'.repeat(64), completedAt: '2026-09-06T00:00:00Z' });
    store.upsertIndexEntry({ documentId: 'man-1', vendorName: 'V', series: 'S2', status: 'completed', sha256: 'a'.repeat(64), completedAt: '2026-09-06T00:00:00Z', collectedBy: 'manual-upload' });
    const byId = new Map(store.library().map((doc) => [doc.documentId, doc]));
    assert.equal(byId.get('auto-1').collectedBy, 'auto');
    assert.equal(byId.get('man-1').collectedBy, 'manual-upload');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
