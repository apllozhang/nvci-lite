'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// chatCompletion 读取进程环境变量，测试内用临时覆盖并恢复。
// 必须 await fn() 完成后再恢复：finally 里直接 return fn() 会在拿到 Promise 的瞬间
// 恢复环境，异步用例中的后续 AI 调用就会退回默认协议（曾在双调用用例中真实踩到）。
async function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('anthropic 协议：URL、认证头、system 拆分与响应解析', async () => {
  const { chatCompletion } = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    let captured = null;
    const mockFetch = async (url, options) => {
      captured = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: '{"params":[]}' }] }),
      };
    };
    const content = await chatCompletion({
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '用户输入' },
      ],
      fetchImpl: mockFetch,
    });
    assert.equal(content, '{"params":[]}');
    assert.equal(captured.url, 'https://open.bigmodel.cn/api/anthropic/v1/messages');
    assert.equal(captured.headers['x-api-key'], 'test-key');
    assert.equal(captured.body.system, '系统提示');
    assert.deepEqual(captured.body.messages, [{ role: 'user', content: '用户输入' }]);
    assert.equal(captured.body.model, 'glm-4.6');
  });
});

test('openai 协议：默认端点、Bearer、response_format 与响应解析', async () => {
  const { chatCompletion } = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://api.example.com/v4',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
  }, async () => {
    let captured = null;
    const mockFetch = async (url, options) => {
      captured = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '结果文本' } }] }),
      };
    };
    const content = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], json: true, fetchImpl: mockFetch });
    assert.equal(content, '结果文本');
    assert.equal(captured.url, 'https://api.example.com/v4/chat/completions');
    assert.equal(captured.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(captured.body.response_format, { type: 'json_object' });
  });
});

test('非 2xx 响应抛错并带状态码', async () => {
  const { chatCompletion } = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'bad-key',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    const mockFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: mockFetch, maxRetries: 0 }),
      /HTTP 401/,
    );
  });
});

test('parseJsonContent：围栏、无围栏、被截断的 JSON 均可解析', () => {
  // parseJsonContent 未导出，经模块内引用测试；这里直接用 require 重取并走导出包装
  const ai = require('../lib/ai');
  assert.ok(ai.parseJsonContent, 'parseJsonContent 应导出以便测试');
  assert.deepEqual(ai.parseJsonContent('```json\n{"params":[{"key":"a"}]}\n```'), { params: [{ key: 'a' }] });
  assert.deepEqual(ai.parseJsonContent('{"ok":true}'), { ok: true });
  // max_tokens 截断：围栏未闭合、最后一个对象不完整
  const truncated = '```json\n{"params":[{"key":"a","value":"1"},{"key":"b","value":"2"},{"key":"c","va';
  assert.deepEqual(ai.parseJsonContent(truncated), { params: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] });
});

test('extractParamsWithAi：引用经原文校验，命中回填实际页码，未命中清空', async () => {
  const ai = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    const payload = JSON.stringify({ params: [
      { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '598Gbit/s', quote: '交换容量：598Gbit/s', page: 9 },
      { key: 'vlan_count', label: 'VLAN 数量', group: '协议特性', value: '4094', quote: '这段引用不在原文里', page: 3 },
    ] });
    // 模拟带 thinking 块的 GLM 回复：解析必须只取 text 块
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'thinking', thinking: '思考过程' }, { type: 'text', text: payload }] }),
    });
    const extraction = {
      pageCount: 2,
      pages: [{ page: 1, lines: ['交换容量： 598Gbit/s（典型值）'] }, { page: 2, lines: ['其他内容'] }],
      fullText: '交换容量： 598Gbit/s（典型值）\n其他内容',
    };
    const params = await ai.extractParamsWithAi(
      { vendorName: '华为', series: 'S5731', modelNames: ['S5731-L24T4S-A'] },
      extraction,
      { fetchImpl: mockFetch },
    );
    const byKey = new Map(params.map((param) => [param.key, param]));
    assert.equal(byKey.get('switching_capacity').quote, '交换容量：598Gbit/s', '空白差异不应影响校验命中');
    assert.equal(byKey.get('switching_capacity').page, 1, '页码应按原文实际位置机械回填，而非采信模型口述');
    assert.equal(byKey.get('switching_capacity').source, 'ai');
    assert.equal(byKey.get('switching_capacity').status, 'ok', '引用核实通过且值被引用支持时保持有依据');
    assert.equal(byKey.get('vlan_count').quote, '', '未命中原文的引用应清空');
    assert.equal(byKey.get('vlan_count').page, 0, '引用未核实时页码一并清零');
    assert.equal(byKey.get('vlan_count').status, 'pending_review', '引用未核实的值应降为待复核');
  });
});

test('值-引用一致性：真实引用携带错误数值不得进入有依据状态（报告复现用例）', async () => {
  const ai = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6v',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    // 原文写 128Gbit/s，模型却返回 value=999Gbit/s 并引用真实存在的原句
    const payload = JSON.stringify({ params: [
      { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '999Gbit/s', quote: '交换容量 128Gbit/s', page: 1 },
    ] });
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: payload }] }),
    });
    const extraction = {
      pageCount: 1,
      pages: [{ page: 1, lines: ['交换容量 128Gbit/s'] }],
      fullText: '交换容量 128Gbit/s',
    };
    const params = await ai.extractParamsWithAi(
      { vendorName: '华为', series: 'S5731', modelNames: [] },
      extraction,
      { fetchImpl: mockFetch },
    );
    assert.equal(params[0].status, 'pending_review', '引用真实但值不被引用支持 → 待核对');
    assert.equal(params[0].quote, '交换容量 128Gbit/s', '真实引用保留供人工核对');
    assert.equal(params[0].reviewNote, '取值与引用原文不一致');
    // 对照：数值改写但数字组一致的合法转写（如 598 Gbit/s → 598Gbit/s）应保持 ok
    const payloadOk = JSON.stringify({ params: [
      { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '128 Gbit/s', quote: '交换容量 128Gbit/s', page: 1 },
    ] });
    const mockFetchOk = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: payloadOk }] }),
    });
    const paramsOk = await ai.extractParamsWithAi(
      { vendorName: '华为', series: 'S5731', modelNames: [] },
      extraction,
      { fetchImpl: mockFetchOk },
    );
    assert.equal(paramsOk[0].status, 'ok', '数值与单位一致的合法转写应保持有依据');
  });
});

test('值-引用一致性反例矩阵：单位不一致 / 数字截断 / 否定含义（第二轮复核复现用例）', async () => {
  const ai = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    const cases = [
      // [原文引用, 模型值, 期望状态, 说明]
      ['交换容量 128Gbit/s', '128Tbit/s', 'pending_review', '单位不一致：Gbit/s ≠ Tbit/s'],
      ['交换容量 128Gbit/s', '28Gbit/s', 'pending_review', '数字截断：28 是 128 的子串也不得放行'],
      ['不支持 OSPF', '支持 OSPF', 'pending_review', '含义相反：否定表达'],
      ['PoE 总功率 370W', '370 W', 'ok', '合法：单位空格差异'],
      ['工作温度 -5°C 至 45°C', '-5℃~45℃', 'ok', '合法：全角 ℃ 与波浪线转写'],
      ['MAC 地址表 16K', '16K entries', 'ok', '合法：单位与数字一致（附加词不否定）'],
      ['包转发率 126Mpps', '126 mpps', 'ok', '合法：大小写与空格'],
      ['不支持 IPv6 路由', '不支持 IPv6 路由', 'ok', '合法：双方都否定'],
      ['交换容量 1.28Tbit/s', '1280Gbit/s', 'ok', '合法：同量纲单位换算等价（T08）'],
      ['Switching capacity 1280 Gbit/s', '1.28Tbit/s', 'ok', '合法：反向换算等价（T08）'],
      ['交换容量 1.28Tbit/s', '1.28Gbit/s', 'pending_review', '换算不得放行量纲错误：G 与 T 差三个数量级'],
    ];
    for (const [quote, value, expected, name] of cases) {
      const payload = JSON.stringify({ params: [
        { key: 'f1', label: '字段', group: '其他', value, quote, page: 1 },
      ] });
      const mockFetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: payload }] }),
      });
      const extraction = { pageCount: 1, pages: [{ page: 1, lines: [quote] }], fullText: quote };
      const params = await ai.extractParamsWithAi(
        { vendorName: 'V', series: 'S', modelNames: [] },
        extraction,
        { fetchImpl: mockFetch },
      );
      assert.equal(params[0].status, expected, `${name}：${value} vs "${quote}"`);
    }
  });
});

test('extractParamsWithAi（T05）：targetModel 注入提示词，输出携带 modelScope 与 seriesWide', async () => {  const ai = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    let capturedBody = '';
    const payload = JSON.stringify({ params: [
      { key: 'downlink_ports', label: '下行端口数', group: '端口', value: '24', quote: 'S5731-S24 24 端口', page: 1, seriesWide: false },
      { key: 'operating_temp', label: '工作温度', group: '环境适应', value: '0°C 至 45°C', quote: '工作温度 0°C 至 45°C', page: 1, seriesWide: true },
    ] });
    const mockFetch = async (_url, options) => {
      capturedBody = String(options.body || '');
      return {
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: payload }] }),
      };
    };
    const extraction = {
      pageCount: 1,
      pages: [{ page: 1, lines: ['S5731-S24 24 端口', '工作温度 0°C 至 45°C'] }],
      fullText: 'S5731-S24 24 端口\n工作温度 0°C 至 45°C',
    };
    const params = await ai.extractParamsWithAi(
      { vendorName: '华为', series: 'S5731-S', modelNames: ['S5731-S24', 'S5731-S48'] },
      extraction,
      { fetchImpl: mockFetch, targetModel: 'S5731-S24' },
    );
    assert.match(capturedBody, /目标型号：S5731-S24/, '目标型号应注入用户提示词并说明归属规则');
    const byKey = new Map(params.map((param) => [param.key, param]));
    assert.equal(byKey.get('downlink_ports').modelScope, 'S5731-S24', 'cell 记录归属目标型号');
    assert.equal(byKey.get('downlink_ports').seriesWide, false);
    assert.equal(byKey.get('operating_temp').seriesWide, true, 'AI 全系列通用标记透传到 cell');
  });
});

test('key 同义词（实战验收）：验收实测的分裂 key 归一到字典键', () => {
  const { normalizeKey } = require('../lib/value-normalize');
  assert.equal(normalizeKey('chassis_size'), 'chassis_dimensions');
  assert.equal(normalizeKey('chassis_dimension'), 'chassis_dimensions');
  assert.equal(normalizeKey('switching_arch'), 'switching_architecture');
  assert.equal(normalizeKey('switch_architecture'), 'switching_architecture');
  assert.equal(normalizeKey('hw_redundancy'), 'power_redundancy');
  assert.equal(normalizeKey('m_lag'), 'mlag');
  assert.equal(normalizeKey('service_slots'), 'business_slots');
  assert.equal(normalizeKey('weight'), 'empty_weight');
  assert.equal(normalizeKey('downlink_ports'), 'downlink_ports', '字典键原样保留');
});

test('长彩页分段抽取（验收实战：ALE 全量输入返空）：按页边界分段、跨段合并、归一化', async () => {
  const ai = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    const calls = [];
    const mockFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const userContent = body.messages[0].content; // anthropic：system 独立字段，messages 仅 user 一条
      calls.push(userContent);
      const payload = userContent.includes('第 1/')
        ? JSON.stringify({ params: [
            { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '953Tbps', quote: '交换容量 953Tbps', page: 1 },
          ] })
        : JSON.stringify({ params: [
            { key: 'chassis_size', label: '机箱尺寸', group: '物理规格', value: '483x985x438mm', quote: '483x985x438mm', page: 3 },
            { key: 'downlink_ports', label: '下行端口数', group: '端口', value: '24', quote: '24 端口', page: 3 },
          ] });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: payload }] }) };
    };
    // 8 页 × ~6K 字 ≈ 48K 字符 > 单段 28K → 分段；引用分别在第 1 页与第 3 页，验证跨段全页校验
    const pages = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, lines: [`第${i + 1}页填充`.padEnd(6000, '数'), i === 0 ? '交换容量 953Tbps' : '', i === 2 ? '483x985x438mm 24 端口' : ''] }));
    const extraction = { pageCount: 8, pages, fullText: pages.flatMap((p) => p.lines).join('\n') };
    const params = await ai.extractParamsWithAi(
      { vendorName: '华为', series: 'CE16800', modelNames: [] },
      extraction,
      { fetchImpl: mockFetch },
    );
    assert.ok(calls.length >= 2, `超长彩页应分段调用（实际 ${calls.length} 段）`);
    for (const seg of calls) assert.ok(seg.includes('段。只抽取本段文本'), '每段提示词带分段说明');
    assert.ok(calls.some((seg) => seg.includes('【第 1 页】')), '首页被覆盖');
    assert.ok(calls.some((seg) => seg.includes('【第 8 页】')), '末页被覆盖');
    assert.ok(!calls.some((seg) => seg.includes('【第 1 页】') && seg.includes('【第 8 页】')), '页边界切段：单段不同时含首尾页');
    const byKey = new Map(params.map((p) => [p.key, p]));
    assert.equal(byKey.get('switching_capacity').value, '953Tbps', '段 1 参数保留');
    assert.equal(byKey.get('switching_capacity').status, 'ok', '跨段引用按全页校验命中');
    assert.equal(byKey.get('chassis_dimensions').value, '483x985x438mm', '段 2 参数保留且 chassis_size 归一');
    assert.equal(byKey.get('downlink_ports').value, '24');
  });
});

test('长彩页分段抽取：部分段失败仍返回成功段，全失败才抛错', async () => {
  const ai = require('../lib/ai');
  await withEnv({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  }, async () => {
    let callIndex = 0;
    const mockFetch = async () => {
      callIndex += 1;
      if (callIndex === 1) throw new Error('AI 接口 HTTP 500：段一失败');
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ params: [
        { key: 'mac_table', label: 'MAC 地址表', group: '转发性能', value: '16K', quote: 'MAC 16K', page: 2 },
      ] }) }] }) };
    };
    const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, lines: [`第${i + 1}页填充`.padEnd(3000, '数'), i === 1 ? 'MAC 16K' : ''] }));
    const extraction = { pageCount: 6, pages, fullText: pages.flatMap((p) => p.lines).join('\n') };
    const params = await ai.extractParamsWithAi({ vendorName: 'V', series: 'S', modelNames: [] }, extraction, { fetchImpl: mockFetch });
    assert.equal(params.find((p) => p.key === 'mac_table').value, '16K', '段一失败不拖垮整体，段二结果保留');
  });
});
