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
  assert.equal(cellStatusText('ok'), '有依据');
  assert.equal(cellStatusText('pending_review'), '待核对');
  assert.equal(cellStatusText('not_disclosed'), '未找到');
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

test('冲突保留：规则 128 与 AI 256 不一致时保留双方候选并标待核对', () => {
  const { mergeParams } = require('../lib/params');
  const ruleParams = [
    { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '128Gbit/s', quote: '交换容量 128Gbit/s', page: 2, status: 'ok', source: 'rule' },
  ];
  const aiParams = [
    { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '256Gbit/s', quote: '交换容量 256Gbit/s', page: 2, status: 'ok', source: 'ai' },
  ];
  const merged = mergeParams(aiParams, ruleParams);
  assert.equal(merged.length, 1, '冲突不产生重复行');
  const field = merged[0];
  assert.equal(field.source, 'rule', '高证据级别胜出');
  assert.equal(field.status, 'pending_review', '冲突时胜出值也降为待核对');
  assert.match(field.reviewNote, /128Gbit\/s/, '候选一（规则值）保留在批注');
  assert.match(field.reviewNote, /256Gbit\/s/, '候选二（AI 值）保留在批注');
  assert.ok(Array.isArray(field.candidates) && field.candidates.length === 2, 'candidates 保留双方');
  // 第三候选（与胜出值同来源同值）不得清除冲突（第二轮复核复现：256→128 序列）
  const seq1 = mergeParams(
    [{ key: 'cap', value: '256Gbit/s', quote: 'q', page: 1, status: 'ok', source: 'ai' }],
    [{ key: 'cap', value: '128Gbit/s', quote: '交换容量 128Gbit/s', page: 2, status: 'ok', source: 'rule' }],
  );
  assert.equal(seq1[0].status, 'pending_review', '前两项先产生冲突');
  const seq2 = mergeParams(
    [{ key: 'cap', value: '128Gbit/s', quote: '交换容量 128Gbit/s', page: 2, status: 'ok', source: 'rule' }],
    seq1,
  );
  assert.equal(seq2[0].status, 'pending_review', '第三个同值候选不得把冲突自动恢复为 ok');
  assert.match(seq2[0].reviewNote, /256Gbit\/s/, '256 候选仍保留');
  assert.match(seq2[0].reviewNote, /128Gbit\/s/, '128 候选仍在');
  // 取值一致（仅单位写法差异归一化后相同）不算冲突
  const same = mergeParams(
    [{ key: 'poe', value: '370 W', quote: 'q', status: 'ok', source: 'ai' }],
    [{ key: 'poe', value: '370W', quote: 'q', status: 'ok', source: 'rule' }],
  );
  assert.equal(same[0].status, 'ok', '归一化后同值不触发冲突');
});

test('单位换算等价（T08）：1.28Tbit/s 与 1280Gbit/s 不算冲突', () => {
  const { mergeParams } = require('../lib/params');
  const merged = mergeParams(
    [{ key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '1280Gbit/s', quote: 'q', status: 'ok', source: 'ai' }],
    [{ key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '1.28Tbit/s', quote: 'q', status: 'ok', source: 'rule' }],
  );
  assert.equal(merged[0].status, 'ok', '同量纲换算等价不触发待核对');
  assert.equal(merged[0].source, 'rule', '规则高证据级别胜出');
});

test('限定词不因换算等价被吞并：≤60W 与 60W 保持互异冲突（方案 §5.3）', () => {
  const { mergeParams } = require('../lib/params');
  const merged = mergeParams(
    [{ key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '≤60W', quote: 'q', status: 'ok', source: 'ai' }],
    [{ key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '60W', quote: 'q', status: 'ok', source: 'rule' }],
  );
  assert.equal(merged[0].status, 'pending_review', '上限语义不得与精确值合并');
});

test('模板初始化：双方都无参数时矩阵仍含全部固定字段行', () => {
  const { FIELD_TEMPLATE } = require('../lib/params');
  const matrix = buildMatrix([
    { documentId: 'a', label: 'A 系列', params: [] },
    { documentId: 'b', label: 'B 系列', params: [] },
  ], { initTemplate: true });
  const rows = matrix.groups.flatMap((group) => group.fields);
  assert.equal(rows.length, FIELD_TEMPLATE.length, '固定模板字段全部在矩阵中');
  for (const field of rows) {
    assert.equal(field.values.a.status, 'not_disclosed', `${field.key} 应显示未找到而非被折叠`);
    assert.equal(field.values.b.status, 'not_disclosed');
  }
});

test('型号列组装（T05）：AI 型号归属值补齐，规则系列值标 unattributed，等价值视为归属已验证', () => {
  const { buildModelColumnParams } = require('../lib/params');
  const modelAiParams = [
    { key: 'downlink_ports', label: '下行端口数', group: '端口', value: '24', quote: 'S5731-S24 24×10/100/1000BASE-T', page: 2, status: 'ok', source: 'ai', modelScope: 'S5731-S24' },
    { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '598Gbit/s', quote: '交换容量 598Gbit/s', page: 2, status: 'ok', source: 'ai', seriesWide: true },
  ];
  const seriesParams = [
    { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '598Gbit/s', quote: '交换容量：598Gbit/s', page: 1, status: 'ok', source: 'rule' },
    { key: 'operating_temp', label: '工作温度', group: '环境适应', value: '-5°C 至 45°C', quote: '工作温度 -5°C 至 45°C', page: 1, status: 'ok', source: 'rule' },
  ];
  const byKey = new Map(buildModelColumnParams(modelAiParams, seriesParams).map((param) => [param.key, param]));
  assert.equal(byKey.get('downlink_ports').source, 'ai', 'AI 型号归属独有键直接补齐');
  assert.equal(byKey.get('downlink_ports').unattributed, false, 'AI 值型号归属明确');
  assert.equal(byKey.get('switching_capacity').unattributed, false, '规则系列值与 AI 型号值等价：归属已验证');
  assert.equal(byKey.get('switching_capacity').seriesWide, true, 'AI 全系列通用标记保留');
  assert.equal(byKey.get('operating_temp').unattributed, true, '规则独有系列值：型号归属未验证');
});

test('型号列组装（T05）：AI 型号值与规则系列值互异仍标待核对（不放松冲突裁决）', () => {
  const { buildModelColumnParams } = require('../lib/params');
  const merged = buildModelColumnParams(
    [{ key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '370W', quote: 'PoE 370W', page: 2, status: 'ok', source: 'ai' }],
    [{ key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '500W', quote: 'PoE 500W', page: 1, status: 'ok', source: 'rule' }],
  );
  assert.equal(merged[0].status, 'pending_review', '型号值与系列值互异：保留冲突交人工裁决');
  assert.equal(merged[0].unattributed, true, '胜出的系列值归属未验证');
  assert.ok(merged[0].candidates.length >= 2, '双方候选保留');
});

test('型号列组装（T05）：视觉兜底系列值同样标 unattributed', () => {
  const { buildModelColumnParams } = require('../lib/params');
  const merged = buildModelColumnParams([], [
    { key: 'mac_table', label: 'MAC 地址表', group: '转发性能', value: '16K', quote: 'MAC 16K', page: 1, status: 'ok', source: 'vision' },
  ]);
  assert.equal(merged[0].source, 'vision');
  assert.equal(merged[0].unattributed, true, '视觉值全页扫描无型号归属');
});

test('矩阵拆列（T05）：同一彩页多型号各占一列，型号值不得串列，四态按列补齐', () => {
  const entries = [
    { documentId: 'doc1', model: 'S5731-S24', label: '华为 S5731-S S5731-S24', params: [
      { key: 'downlink_ports', label: '下行端口数', group: '端口', value: '24', quote: 'q', page: 1, status: 'ok', source: 'ai' },
    ] },
    { documentId: 'doc1', model: 'S5731-S48', label: '华为 S5731-S S5731-S48', params: [
      { key: 'downlink_ports', label: '下行端口数', group: '端口', value: '48', quote: 'q', page: 1, status: 'ok', source: 'ai' },
      { key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '380W', quote: 'q', page: 1, status: 'ok', source: 'ai' },
    ] },
    { documentId: 'doc2', label: 'H3C S5120', params: extractParamsByRules(makeExtraction(H3C_LINES)) },
  ];
  const matrix = buildMatrix(entries);
  assert.deepEqual(
    matrix.documents.map((doc) => doc.columnId),
    ['doc1#S5731-S24', 'doc1#S5731-S48', 'doc2'],
    'columnId 按型号生成，系列列保持 documentId',
  );
  const fields = matrix.groups.flatMap((group) => group.fields);
  const ports = fields.find((field) => field.key === 'downlink_ports');
  assert.equal(ports.values['doc1#S5731-S24'].value, '24');
  assert.equal(ports.values['doc1#S5731-S48'].value, '48');
  assert.equal(ports.values.doc2.status, 'not_disclosed', 'H3C 样例无下行端口数字段');
  const poe = fields.find((field) => field.key === 'poe_budget');
  assert.equal(poe.values['doc1#S5731-S24'].status, 'not_disclosed', 'S24 列不得继承 S48 的 PoE 值（值与列归属正确，T05 验收）');
});
