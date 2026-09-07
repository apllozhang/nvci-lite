'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConfirmations, upsertConfirmation, removeConfirmation, applyConfirmations,
} = require('../lib/confirm');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-confirm-'));
}

function buildMatrix() {
  return {
    documents: [
      { documentId: 'doc-a', label: 'A 系列', sha256: 'sha-a-1' },
      { documentId: 'doc-b', label: 'B 系列', sha256: 'sha-b-1' },
    ],
    groups: [{
      group: '转发性能',
      fields: [{
        key: 'switching_capacity',
        label: '交换容量',
        values: {
          'doc-a': { value: '128Gbit/s', quote: '交换容量 128Gbit/s', page: 1, status: 'pending_review', source: 'ai', reviewNote: '取值冲突', candidates: [] },
          'doc-b': { value: '176Gbit/s', quote: '', page: 0, status: 'ok', source: 'rule', reviewNote: '' },
        },
      }],
    }],
    meta: {},
  };
}

test('确认存储：同键覆盖（最后一次生效）；model 不同互不覆盖（T05 三元组键）', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', value: '370W', docSha256: 's1' });
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', value: '500W', model: 'S5731-48T4X', note: '以规格表为准', docSha256: 's1' });
  let list = loadConfirmations(dir);
  assert.equal(list.length, 2, '系列级（model 为空）与型号级确认是两条独立记录');
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', value: '515W', model: 'S5731-48T4X', docSha256: 's1' });
  list = loadConfirmations(dir);
  assert.equal(list.length, 2, '同键（documentId+model+paramKey）仍只保留最后一条');
  const modelConf = list.find((item) => item.model === 'S5731-48T4X');
  assert.equal(modelConf.value, '515W');
  assert.ok(modelConf.confirmedAt);
});

test('确认存储：校验拒绝空值与超长值', () => {
  const dir = tempDir();
  assert.throws(() => upsertConfirmation(dir, { documentId: 'd', paramKey: 'k', value: '  ' }), /确认值不能为空/);
  assert.throws(() => upsertConfirmation(dir, { documentId: 'd', paramKey: 'k', value: 'x'.repeat(201) }), /确认值过长/);
  assert.throws(() => upsertConfirmation(dir, { documentId: '', paramKey: 'k', value: 'v' }), /documentId/);
});

test('确认存储：删除按 documentId+paramKey 精确匹配', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'k1', value: 'v', docSha256: 's' });
  assert.equal(removeConfirmation(dir, 'doc-a', 'k2'), false);
  assert.equal(removeConfirmation(dir, 'doc-a', 'k1'), true);
  assert.deepEqual(loadConfirmations(dir), []);
});

test('applyConfirmations：型号级确认不串系列列（键含 model，T05）', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'switching_capacity', value: '336Gbit/s', model: 'S5731-S24T4X', docSha256: 'sha-a-1' });
  const matrix = buildMatrix();
  const stats = applyConfirmations(matrix, loadConfirmations(dir));
  assert.equal(stats.applied, 0, '确认绑定型号 S5731-S24T4X，系列列（model 为空）不匹配不生效');
  const cell = matrix.groups[0].fields[0].values['doc-a'];
  assert.equal(cell.source, 'ai', '机器结论保持原样');
});

test('applyConfirmations：SHA 一致时系列级确认在系列列生效并留快照', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'switching_capacity', value: '336Gbit/s', docSha256: 'sha-a-1' });
  const matrix = buildMatrix();
  const stats = applyConfirmations(matrix, loadConfirmations(dir));
  assert.equal(stats.applied, 1);
  const cell = matrix.groups[0].fields[0].values['doc-a'];
  assert.equal(cell.value, '336Gbit/s');
  assert.equal(cell.status, 'ok');
  assert.equal(cell.source, 'manual');
  assert.equal(cell.manual.model, '');
  assert.deepEqual(cell.preConfirm, { value: '128Gbit/s', status: 'pending_review', source: 'ai', reviewNote: '取值冲突', unattributed: false });
  // 其他文档同字段不受影响
  assert.equal(matrix.groups[0].fields[0].values['doc-b'].source, 'rule');
});

test('applyConfirmations：彩页已更新（SHA 不一致）确认不生效，标记失效待复核', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'switching_capacity', value: '336Gbit/s', docSha256: 'sha-a-OLD' });
  const matrix = buildMatrix();
  const stats = applyConfirmations(matrix, loadConfirmations(dir));
  assert.equal(stats.applied, 0);
  assert.equal(stats.stale, 1);
  const cell = matrix.groups[0].fields[0].values['doc-a'];
  assert.equal(cell.value, '128Gbit/s', '机器结论保持原样');
  assert.equal(cell.status, 'pending_review');
  assert.equal(cell.staleConfirmation.value, '336Gbit/s');
});

test('applyConfirmations：确认值进入待核对单元格后，状态由人工裁决恢复 ok', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-b', paramKey: 'switching_capacity', value: '208Gbit/s', docSha256: 'sha-b-1' });
  const matrix = buildMatrix();
  applyConfirmations(matrix, loadConfirmations(dir));
  const cell = matrix.groups[0].fields[0].values['doc-b'];
  assert.equal(cell.status, 'ok');
  assert.equal(cell.source, 'manual');
  assert.equal(cell.value, '208Gbit/s');
});

test('确认存储（T05）：同彩页不同型号的确认互不覆盖，remove 按 model 精确删除', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', model: 'S5731-S24', value: '370W', docSha256: 's1' });
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', model: 'S5731-S48', value: '500W', docSha256: 's1' });
  const list = loadConfirmations(dir);
  assert.equal(list.length, 2, '型号不同是两条独立确认');
  assert.equal(removeConfirmation(dir, 'doc-a', 'poe_budget', 'S5731-S24'), true, '只删 S24 的确认');
  const remains = loadConfirmations(dir);
  assert.equal(remains.length, 1);
  assert.equal(remains[0].model, 'S5731-S48', 'S48 的确认保留');
});

test('applyConfirmations（T05）：确认按「documentId+model」精确匹配列，同彩页异型号不串列', () => {
  const dir = tempDir();
  const sha = 'sha-m-1';
  upsertConfirmation(dir, { documentId: 'doc-m', model: 'S5731-S24', paramKey: 'poe_budget', value: '370W', docSha256: sha });
  const matrix = {
    documents: [
      { columnId: 'doc-m#S5731-S24', documentId: 'doc-m', model: 'S5731-S24', label: 'A S24', sha256: sha },
      { columnId: 'doc-m#S5731-S48', documentId: 'doc-m', model: 'S5731-S48', label: 'A S48', sha256: sha },
    ],
    groups: [{
      group: '供电',
      fields: [{
        key: 'poe_budget',
        label: 'PoE 总功率',
        values: {
          'doc-m#S5731-S24': { value: '370W（系列值）', quote: '', page: 0, status: 'ok', source: 'rule', reviewNote: '', unattributed: true },
          'doc-m#S5731-S48': { value: '500W', quote: '', page: 0, status: 'ok', source: 'ai', reviewNote: '' },
        },
      }],
    }],
    meta: {},
  };
  const stats = applyConfirmations(matrix, loadConfirmations(dir));
  assert.equal(stats.applied, 1);
  const s24 = matrix.groups[0].fields[0].values['doc-m#S5731-S24'];
  assert.equal(s24.source, 'manual');
  assert.equal(s24.unattributed, false, '人工确认后型号归属视为已验证');
  assert.equal(s24.preConfirm.unattributed, true, '快照保留原系列值标记，清除确认可还原');
  const s48 = matrix.groups[0].fields[0].values['doc-m#S5731-S48'];
  assert.equal(s48.source, 'ai', 'S48 列不受 S24 确认影响');
});

test('loadConfirmations（T05）：旧 schema 记录（无 model 字段）迁移为系列级', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'confirmations.json'), JSON.stringify({
    schemaVersion: '1.0',
    confirmations: [{ documentId: 'doc-old', paramKey: 'poe_budget', value: '370W', note: '', docSha256: 's1', confirmedAt: '2026-09-01T00:00:00.000Z' }],
  }), 'utf8');
  const list = loadConfirmations(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].model, '', '旧记录视为系列级确认');
});
