'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractParamsByRules, buildMatrix, cellStatusText } = require('../lib/params');

const HUAWEI_LINES = [
  '华为 CloudEngine S5731-S 系列交换机彩页',
  '端口：24×10/100/1000BASE-T + 4×10GE SFP+',
  '交换容量：598Gbit/s',
  '包转发率：126Mpps',
  '支持 PoE+，整机 PoE 供电功率 500W',
  '额定功率：典型 45W',
  '外形：1U 高度，工作温度 -5°C 至 45°C',
];

const H3C_LINES = [
  '新华三 S5120V3-EI 系列以太网交换机',
  '24 个 10/100/1000BASE-T 电口，4 个 SFP+ 光口',
  '背板带宽 336Gbit/s',
  '转发速率 108Mpps',
  '支持 PoE+ 供电，PoE budget 370W',
  'MAC 地址表 16K',
];

function makeExtraction(lines) {
  return { pageCount: 1, pages: [{ page: 1, lines }], fullText: lines.join('\n') };
}

test('规则抽取：中文彩页常见参数命中', () => {
  const params = extractParamsByRules(makeExtraction(HUAWEI_LINES));
  const byKey = new Map(params.map((param) => [param.key, param]));
  assert.match(byKey.get('switching_capacity')?.value || '', /598Gbit\/s/);
  assert.match(byKey.get('forwarding_rate')?.value || '', /126Mpps/);
  assert.match(byKey.get('port_config')?.value || '', /24×10\/100\/1000BASE-T/);
  assert.match(byKey.get('form_factor')?.value || '', /1U/);
  assert.ok(byKey.get('operating_temp'), '工作温度应命中');
  for (const param of params) {
    assert.ok(param.quote.length > 0, `参数 ${param.key} 应带原文引用`);
    assert.equal(param.page, 1);
  }
});

test('规则抽取：第二种表述风格也能命中核心字段', () => {
  const params = extractParamsByRules(makeExtraction(H3C_LINES));
  const byKey = new Map(params.map((param) => [param.key, param]));
  assert.match(byKey.get('switching_capacity')?.value || '', /336Gbit\/s/);
  assert.match(byKey.get('forwarding_rate')?.value || '', /108Mpps/);
});

test('参数矩阵：合并、补齐三态、分组有序', () => {
  const entries = [
    { documentId: 'a', label: '华为 S5731', params: extractParamsByRules(makeExtraction(HUAWEI_LINES)) },
    { documentId: 'b', label: 'H3C S5120', params: extractParamsByRules(makeExtraction(H3C_LINES)) },
  ];
  const matrix = buildMatrix(entries);
  assert.equal(matrix.documents.length, 2);
  const capacityField = matrix.groups.flatMap((group) => group.fields).find((field) => field.key === 'switching_capacity');
  assert.ok(capacityField, '交换容量字段应在矩阵中');
  assert.equal(capacityField.values.a.value, '598Gbit/s');
  const formFactorB = capacityField.values; // 占位引用，下方断言独立字段
  const ffField = matrix.groups.flatMap((group) => group.fields).find((field) => field.key === 'form_factor');
  assert.equal(ffField.values.b.status, 'not_disclosed', 'H3C 样例未写外形时标未披露');
  assert.equal(ffField.values.b.value, '');
});

test('四态文案', () => {
  assert.equal(cellStatusText('ok'), '有值');
  assert.equal(cellStatusText('pending_review'), '待复核');
  assert.equal(cellStatusText('not_disclosed'), '未披露');
  assert.equal(cellStatusText('extract_failed'), '抽取失败');
});

test('参数合并：同键规则优先，LLM 补齐其余键并去重', () => {
  const { mergeParams } = require('../lib/params');
  const aiParams = [
    { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '598 Gbit/s（AI 转写）', quote: '', page: 0, status: 'ok', source: 'ai' },
    { key: 'mtu', label: '最大 MTU', group: '协议特性', value: '9216', quote: '', page: 0, status: 'ok', source: 'ai' },
    { key: 'mtu', label: '最大 MTU', group: '协议特性', value: '9000', quote: '', page: 0, status: 'ok', source: 'ai' },
  ];
  const ruleParams = [
    { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '598Gbit/s', quote: '交换容量：598Gbit/s', page: 2, status: 'ok', source: 'rule' },
  ];
  const merged = mergeParams(aiParams, ruleParams);
  const byKey = new Map(merged.map((param) => [param.key, param]));
  assert.equal(byKey.get('switching_capacity').source, 'rule', '同键冲突时规则优先');
  assert.equal(byKey.get('switching_capacity').value, '598Gbit/s');
  assert.equal(byKey.get('mtu').value, '9216', 'LLM 重复键应取首个');
  assert.equal(merged.length, 2, '合并后不应有重复键');
  assert.deepEqual(mergeParams(null, null), [], '空入参安全');
});

test('证据分级：待复核值让位于已核验值，同级先到先得', () => {
  const { mergeParams } = require('../lib/params');
  // 视觉待复核 vs 规则有值：规则胜
  const visionPending = [
    { key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '370W（编造嫌疑）', quote: '', page: 0, status: 'pending_review', source: 'vision' },
    { key: 'mtu', label: '最大 MTU', group: '协议特性', value: '9216', quote: '', page: 0, status: 'pending_review', source: 'vision' },
  ];
  const ruleHit = [
    { key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '370W', quote: 'PoE budget 370W', page: 3, status: 'ok', source: 'rule' },
  ];
  const merged = mergeParams(visionPending, ruleHit);
  const byKey = new Map(merged.map((param) => [param.key, param]));
  assert.equal(byKey.get('poe_budget').source, 'rule', '待复核不得顶替已核验值');
  assert.equal(byKey.get('mtu').source, 'vision', '规则未命中的键由待复核值补位');
  // 视觉待复核 vs AI 待复核：先到先得（保持已合并结果中的 AI 值）
  const aiPending = [{ key: 'mtu', label: '最大 MTU', group: '协议特性', value: '9000', quote: '', page: 0, status: 'pending_review', source: 'ai' }];
  const merged2 = mergeParams(aiPending, visionPending);
  assert.equal(new Map(merged2.map((p) => [p.key, p])).get('mtu').source, 'vision', '同级待复核冲突时先到先得');
  // AI 已核验引用 vs AI 待复核：已核验胜
  const aiVerified = [{ key: 'mtu', label: '最大 MTU', group: '协议特性', value: '9216', quote: 'MTU 9216', page: 4, status: 'ok', source: 'ai' }];
  const merged3 = mergeParams(aiPending, aiVerified);
  assert.equal(new Map(merged3.map((p) => [p.key, p])).get('mtu').value, '9216', '已核验引用应胜过待复核');
});
