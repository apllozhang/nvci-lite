'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackup, restoreBackup, listBackupFiles, rotate, SCHEMA_VERSION } = require('../lib/backup');

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-backup-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ documents: [{ documentId: 'a' }] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'confirmations.json'), JSON.stringify({ schemaVersion: '1.1', confirmations: [] }), 'utf8');
  fs.mkdirSync(path.join(dir, 'custom-profiles'));
  fs.writeFileSync(path.join(dir, 'custom-profiles', 'juniper.json'), JSON.stringify({ profileId: 'juniper', sources: [] }), 'utf8');
  fs.mkdirSync(path.join(dir, 'exports')); // 导出物不入备份
  fs.writeFileSync(path.join(dir, 'exports', 'x.xlsx'), 'binary', 'utf8');
  return dir;
}

test('备份：打包根级与自定义来源 JSON，排除导出物与非 JSON', () => {
  const dir = tempDataDir();
  const result = createBackup(dir);
  assert.equal(result.fileCount, 3, 'index + confirmations + custom-profiles/juniper');
  assert.ok(fs.existsSync(result.outPath));
  const bundle = JSON.parse(fs.readFileSync(result.outPath, 'utf8'));
  assert.equal(bundle.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(bundle.files).sort(), ['confirmations.json', 'custom-profiles/juniper.json', 'index.json']);
  assert.ok(bundle.files['index.json'].includes('documents'));
});

test('备份：损坏的 JSON 当场报错，不产出坏备份', () => {
  const dir = tempDataDir();
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not-json', 'utf8');
  assert.throws(() => createBackup(dir), /JSON| Unexpected|positions/i);
});

test('恢复：latest 语义 + 内容还原 + 只动 bundle 内文件', () => {
  const dir = tempDataDir();
  createBackup(dir);
  // 备份后修改现场：覆盖 + 新增 + 将删除的文件
  fs.writeFileSync(path.join(dir, 'index.json'), '{"documents":[]}', 'utf8');
  fs.writeFileSync(path.join(dir, 'extra.json'), '{"x":1}', 'utf8');
  fs.rmSync(path.join(dir, 'custom-profiles', 'juniper.json'));
  const result = restoreBackup(dir, 'latest');
  assert.deepEqual(result.restored.sort(), ['confirmations.json', 'custom-profiles/juniper.json', 'index.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).documents.length, 1, '覆盖被还原');
  assert.ok(fs.existsSync(path.join(dir, 'custom-profiles', 'juniper.json')), '被删文件被还原');
  assert.ok(fs.existsSync(path.join(dir, 'extra.json')), 'bundle 外的文件不受影响');
});

test('恢复：不存在的文件名报错并列出可用备份', () => {
  const dir = tempDataDir();
  createBackup(dir);
  assert.throws(() => restoreBackup(dir, 'backup-nope.json'), /备份文件不存在/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-backup-empty-'));
  assert.throws(() => restoreBackup(empty, 'latest'), /备份文件不存在/);
});

test('轮转：超出 keep 数删除最旧', () => {
  const dir = tempDataDir();
  for (let i = 0; i < 5; i += 1) {
    createBackup(dir, new Date(Date.parse(`2026-09-0${i + 1}T10:00:00Z`)));
  }
  assert.equal(listBackupFiles(dir).length, 5);
  const removed = rotate(dir, 3);
  assert.equal(removed.length, 2, '删除最旧 2 份');
  assert.equal(listBackupFiles(dir).length, 3);
  const left = listBackupFiles(dir);
  assert.ok(left[0] > left[left.length - 1] === false, '保持文件名排序（时间序）');
});

test('脱敏（评审 R5）：settings.json 的 ai.apiKey 不进备份，redacted 留痕，恢复后回落 env', () => {
  const dir = tempDataDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    storage: { pdfSubdir: '' },
    ai: { protocol: 'openai', baseUrl: 'https://api.example.com/v4', model: 'glm-4.6', visionModel: '', apiKey: 'SECRET-KEY-VALUE' },
  }), 'utf8');
  const result = createBackup(dir);
  assert.deepEqual(result.redacted, ['settings.json:ai.apiKey'], '脱敏清单留痕');
  const bundle = JSON.parse(fs.readFileSync(result.outPath, 'utf8'));
  const restoredSettings = JSON.parse(bundle.files['settings.json']);
  assert.equal(restoredSettings.ai.apiKey, '', '备份内密钥为空串（恢复后回落环境变量）');
  assert.equal(restoredSettings.ai.model, 'glm-4.6', '非敏感字段保留');
  assert.ok(!JSON.stringify(bundle).includes('SECRET-KEY-VALUE'), 'bundle 全文不含密钥明文');
  // 恢复落盘同样无密钥
  restoreBackup(dir, 'latest');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.ai.apiKey, '');
});

test('恢复路径穿越（评审 §4.3）：bundle 内 ../ 相对路径必须拒绝且不落盘', () => {
  const dir = tempDataDir();
  createBackup(dir);
  const evilName = listBackupFiles(dir)[0];
  const evilPath = path.join(dir, 'backups', evilName);
  const bundle = JSON.parse(fs.readFileSync(evilPath, 'utf8'));
  bundle.files['../evil.json'] = '{"hacked":true}';
  fs.writeFileSync(evilPath, JSON.stringify(bundle), 'utf8');
  assert.throws(() => restoreBackup(dir, evilName), /越界/, '路径越界必须抛错');
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.json')), '越界文件未写盘');
});
