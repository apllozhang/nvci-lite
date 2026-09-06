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

test('确认存储：保存/读取/同键覆盖（最后一次生效）', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', value: '370W', docSha256: 's1' });
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'poe_budget', value: '500W', model: 'S5731-48T4X', note: '以规格表为准', docSha256: 's1' });
  const list = loadConfirmations(dir);
  assert.equal(list.length, 1, '同键应只保留最后一条');
  assert.equal(list[0].value, '500W');
  assert.equal(list[0].model, 'S5731-48T4X');
  assert.ok(list[0].confirmedAt);
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

test('applyConfirmations：SHA 一致时确认生效并留快照', () => {
  const dir = tempDir();
  upsertConfirmation(dir, { documentId: 'doc-a', paramKey: 'switching_capacity', value: '336Gbit/s', model: 'S5731-S24T4X', docSha256: 'sha-a-1' });
  const matrix = buildMatrix();
  const stats = applyConfirmations(matrix, loadConfirmations(dir));
  assert.equal(stats.applied, 1);
  const cell = matrix.groups[0].fields[0].values['doc-a'];
  assert.equal(cell.value, '336Gbit/s');
  assert.equal(cell.status, 'ok');
  assert.equal(cell.source, 'manual');
  assert.equal(cell.manual.model, 'S5731-S24T4X');
  assert.deepEqual(cell.preConfirm, { value: '128Gbit/s', status: 'pending_review', source: 'ai', reviewNote: '取值冲突' });
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
