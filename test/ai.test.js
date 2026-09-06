'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// chatCompletion 读取进程环境变量，测试内用临时覆盖并恢复
function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
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
    assert.equal(byKey.get('switching_capacity').status, 'ok', '引用核实通过的值保持有值');
    assert.equal(byKey.get('vlan_count').quote, '', '未命中原文的引用应清空');
    assert.equal(byKey.get('vlan_count').page, 0, '引用未核实时页码一并清零');
    assert.equal(byKey.get('vlan_count').status, 'pending_review', '引用未核实的值应降为待复核');
  });
});
