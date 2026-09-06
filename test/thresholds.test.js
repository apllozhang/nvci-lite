'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateThresholds, parseThresholdValue, THRESHOLD_OPS } = require('../lib/thresholds');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-thr-'));
}

function buildMatrix() {
  return {
    documents: [
      { documentId: 'doc-a', label: 'A 系列' },
      { documentId: 'doc-b', label: 'B 系列' },
    ],
    groups: [{
      group: '端口',
      fields: [{
        key: 'downlink_ports',
        label: '下行端口数',
        values: {
          'doc-a': { value: '48', quote: '下行 48 口', page: 1, status: 'ok', source: 'rule' },
          'doc-b': { value: '16', quote: '下行 16 口', page: 1, status: 'ok', source: 'rule' },
        },
      }, {
        key: 'switching_capacity',
        label: '交换容量',
        values: {
          'doc-a': { value: '216Gbit/s', quote: '交换容量 216Gbit/s', page: 2, status: 'ok', source: 'rule' },
          'doc-b': { value: '', quote: '', page: 0, status: 'not_disclosed', source: '' },
        },
      }, {
        key: 'poe_budget',
        label: 'PoE 总功率',
        values: {
          'doc-a': { value: '370W', quote: 'PoE 预算 370W', page: 2, status: 'pending_review', source: 'ai', reviewNote: '取值与引用原文不一致' },
          'doc-b': { value: '240W', quote: 'PoE 240W', page: 1, status: 'ok', source: 'manual', manual: { confirmedAt: '2026-09-07T00:00:00Z', model: 'B-24', note: '' } },
        },
      }, {
        key: 'port_config',
        label: '端口配置',
        values: {
          'doc-a': { value: '24×10GE+2×40GE', quote: '24×10GE+2×40GE', page: 1, status: 'ok', source: 'rule' },
          'doc-b': { value: '8×10GE', quote: '8×10GE', page: 1, status: 'ok', source: 'rule' },
        },
      }],
    }],
    meta: {},
  };
}

test('parseThresholdValue：合法数值+单位解析，非法输入拒绝', () => {
  assert.deepEqual(parseThresholdValue('24'), { num: '24', unit: '' });
  assert.deepEqual(parseThresholdValue('370W'), { num: '370', unit: 'w' });
  assert.deepEqual(parseThresholdValue('0.2Tbit/s'), { num: '0.2', unit: 'tbit/s' });
  assert.equal(parseThresholdValue('约24'), null, '非纯数值拒绝');
  assert.equal(parseThresholdValue('24瓦'), null, '未知单位拒绝（不猜）');
  assert.equal(parseThresholdValue(''), null);
});

test('门槛判定：满足 / 不满足 按数值计算', () => {
  const rows = evaluateThresholds(buildMatrix(), [{ fieldKey: 'downlink_ports', op: 'ge', value: '24' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].results['doc-a'].verdict, 'pass', '48 ≥ 24 满足');
  assert.equal(rows[0].results['doc-b'].verdict, 'fail', '16 ≥ 24 不满足');
  assert.match(rows[0].results['doc-a'].basis, /48/);
});

test('门槛判定：跨单位换算比较（0.2Tbit/s vs 216Gbit/s）', () => {
  const rows = evaluateThresholds(buildMatrix(), [{ fieldKey: 'switching_capacity', op: 'ge', value: '0.2Tbit/s' }]);
  assert.equal(rows[0].results['doc-a'].verdict, 'pass', '216Gbit/s ≥ 0.2Tbit/s 经换算满足');
  assert.equal(rows[0].results['doc-b'].verdict, 'unknown', '未找到适用值 → 未知，不算不满足');
  assert.match(rows[0].results['doc-b'].reason, /未找到/);
});

test('门槛判定：待核对取值 → 未知；人工确认值参与判定', () => {
  const rows = evaluateThresholds(buildMatrix(), [{ fieldKey: 'poe_budget', op: 'ge', value: '300W' }]);
  assert.equal(rows[0].results['doc-a'].verdict, 'unknown', '取值待核对不能判定');
  assert.match(rows[0].results['doc-a'].reason, /待核对/);
  assert.equal(rows[0].results['doc-b'].verdict, 'fail', '人工确认的 240W 参与判定：240 ≥ 300 不满足');
});

test('门槛判定：多数值取值（分组端口）→ 未知需人工', () => {
  const rows = evaluateThresholds(buildMatrix(), [{ fieldKey: 'port_config', op: 'ge', value: '24' }]);
  assert.equal(rows[0].results['doc-a'].verdict, 'unknown', '24×10GE+2×40GE 含多个数值不自动归并');
  assert.match(rows[0].results['doc-a'].reason, /人工/);
});

test('门槛判定：字段不在矩阵 / 非法条件 → 未知', () => {
  const rows = evaluateThresholds(buildMatrix(), [
    { fieldKey: 'not_exist', op: 'ge', value: '10' },
    { fieldKey: 'downlink_ports', op: 'bad', value: '10' },
    { fieldKey: 'downlink_ports', op: 'ge', value: '很多' },
  ]);
  assert.equal(rows[0].results['doc-a'].verdict, 'unknown');
  assert.match(rows[0].results['doc-a'].reason, /矩阵/);
  assert.equal(rows[1].results['doc-a'].verdict, 'unknown', '非法条件');
  assert.equal(rows[2].results['doc-a'].verdict, 'unknown', '门槛值无法解析');
});

test('THRESHOLD_OPS：边界语义（ge 含等值，gt 不含）', () => {
  const rows = evaluateThresholds(buildMatrix(), [
    { fieldKey: 'downlink_ports', op: 'ge', value: '48' },
    { fieldKey: 'downlink_ports', op: 'gt', value: '16' },
  ]);
  assert.equal(rows[0].results['doc-a'].verdict, 'pass', '48 ≥ 48 满足（含等值）');
  assert.equal(rows[1].results['doc-b'].verdict, 'fail', '16 > 16 不满足（不含等值）');
  assert.ok(THRESHOLD_OPS.ge.test(5, 5) && !THRESHOLD_OPS.gt.test(5, 5));
});
