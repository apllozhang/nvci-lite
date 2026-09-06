'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVisionMessages, extractParamsWithVision, isWeakText, visionConfig, VISION_EXTRACT_PROMPT } = require('../lib/vision');

function makeExtraction(pages, charsPerPage) {
  const fullText = (charsPerPage || '').repeat(pages) || '';
  return { pageCount: pages, pages: Array.from({ length: pages }, (_, i) => ({ page: i + 1, lines: ['x'] })), fullText };
}

test('弱文字判定：图片型彩页命中，正常文字层不命中', () => {
  // 锐捷 RG-MACC 实测：106 字符 / 6 页
  const weak = { pageCount: 6, pages: Array.from({ length: 6 }, (_, i) => ({ page: i + 1, lines: [] })), fullText: 'x'.repeat(106) };
  assert.equal(isWeakText(weak), true);
  // 正常文字层：5000 字符 / 30 页
  const strong = { pageCount: 30, pages: Array.from({ length: 30 }, (_, i) => ({ page: i + 1, lines: [] })), fullText: 'x'.repeat(5000) };
  assert.equal(isWeakText(strong), false);
  assert.equal(isWeakText(null), false);
  assert.equal(isWeakText({ pages: [] }), false);
});

test('视觉消息：图片块在前文本在后，系统提示独立，base64 原样透传', () => {
  const images = [
    { page: 1, mediaType: 'image/jpeg', base64: 'AAAA' },
    { page: 2, mediaType: 'image/jpeg', base64: 'BBBB' },
  ];
  const messages = buildVisionMessages({ vendorName: '锐捷网络', series: 'RG-MACC', modelNames: ['RG-MACC'] }, images);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('视觉') || messages[0].content.includes('图片'), '应使用视觉版提示词');
  assert.equal(messages[0].content, VISION_EXTRACT_PROMPT);
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content.length, 3);
  assert.deepEqual(messages[1].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  assert.deepEqual(messages[1].content[1].source.data, 'BBBB');
  assert.match(messages[1].content[2].text, /锐捷网络 RG-MACC/);
  assert.match(messages[1].content[2].text, /第 1-2 页/);
});

test('视觉抽取：模型覆盖、thinking 过滤、参数映射 source=vision', async () => {
  const payload = JSON.stringify({ params: [
    { key: 'port_config', label: '端口配置', group: '端口', value: '8×GE', quote: '不应出现', page: 2 },
    { key: 'poe_budget', label: 'PoE 总功率', group: '供电', value: '123W', page: 3 },
  ] });
  let captured = null;
  const mockFetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: payload }] }) };
  };
  const fakeRender = async () => [
    { page: 1, mediaType: 'image/jpeg', base64: 'IMG1' },
    { page: 2, mediaType: 'image/jpeg', base64: 'IMG2' },
    { page: 3, mediaType: 'image/jpeg', base64: 'IMG3' },
  ];
  // 与 ai.test.js 同款环境注入：anthropic 协议下 mock 才与响应结构对齐
  const savedEnv = {};
  const envKeys = ['NVCI_LITE_AI_BASE', 'NVCI_LITE_AI_KEY', 'NVCI_LITE_AI_MODEL', 'NVCI_LITE_AI_PROTOCOL'];
  for (const [key, value] of Object.entries({
    NVCI_LITE_AI_BASE: 'https://open.bigmodel.cn/api/anthropic',
    NVCI_LITE_AI_KEY: 'test-key',
    NVCI_LITE_AI_MODEL: 'glm-4.6v',
    NVCI_LITE_AI_PROTOCOL: 'anthropic',
  })) { savedEnv[key] = process.env[key]; process.env[key] = value; }
  try {
    const params = await extractParamsWithVision(
      { vendorName: '锐捷网络', series: 'RG-MACC', modelNames: [] },
      Buffer.from('pdf'),
      { renderImages: fakeRender, fetchImpl: mockFetch },
    );
    assert.equal(captured.url, 'https://open.bigmodel.cn/api/anthropic/v1/messages');
    assert.equal(captured.body.model, 'glm-4.6v', '视觉模型应可覆盖文本模型配置');
    assert.equal(captured.body.messages[0].content.filter((block) => block.type === 'image').length, 3, 'user 消息应含 3 个图片块');
  const byKey = new Map(params.map((param) => [param.key, param]));
  assert.equal(byKey.get('port_config').source, 'vision');
  assert.equal(byKey.get('port_config').quote, '', '图片抽取无文字层可校验，引用应为空');
  assert.equal(byKey.get('port_config').page, 2);
  assert.equal(byKey.get('port_config').status, 'pending_review', '图片抽取值一律待复核');
  assert.equal(byKey.get('poe_budget').status, 'pending_review');
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('visionConfig：默认关闭，模型默认值与环境变量覆盖', () => {
  const saved = process.env.NVCI_LITE_VISION_MODEL;
  const savedMode = process.env.NVCI_LITE_VISION;
  try {
    delete process.env.NVCI_LITE_VISION_MODEL;
    delete process.env.NVCI_LITE_VISION;
    assert.equal(visionConfig().mode, 'off', '默认应关闭（幻觉风险：图片抽取无原文可校验）');
    assert.equal(visionConfig().model, 'glm-4.6v');
    process.env.NVCI_LITE_VISION_MODEL = 'glm-4v-plus';
    assert.equal(visionConfig().model, 'glm-4v-plus');
    process.env.NVCI_LITE_VISION = 'auto';
    assert.equal(visionConfig().mode, 'auto');
  } finally {
    if (saved === undefined) delete process.env.NVCI_LITE_VISION_MODEL;
    else process.env.NVCI_LITE_VISION_MODEL = saved;
    if (savedMode === undefined) delete process.env.NVCI_LITE_VISION;
    else process.env.NVCI_LITE_VISION = savedMode;
  }
});

