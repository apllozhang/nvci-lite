'use strict';

// 视觉兜底抽取：文字层薄弱的彩页（扫描件/图片型）用 pdftoppm 渲染页面为 JPEG，
// 走智谱 Anthropic 协议的视觉模型抽参数，输出与规则/文本 LLM 同一矩阵结构（source: 'vision'）。
// 图片型彩页没有可校验的文字层，quote 一律留空，页码取图片序号。

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ai = require('./ai');
const settings = require('./settings');

function visionConfig() {
  // 默认 off：实测 GLM-4.6V 对无规格表的图片型彩页会照提示词字段清单编造参数值
  // （RG-MACC 案例核验于 2026-09-06），且图片抽取无文字层可做引用校验。
  // 需人工设置 NVCI_LITE_VISION=auto/on 启用，结果仅作线索、必须人工复核。
  const mode = String(process.env.NVCI_LITE_VISION || 'off').toLowerCase();
  return {
    mode, // off：关闭；auto/on：弱文字时触发
    model: settings.get().ai.visionModel || process.env.NVCI_LITE_VISION_MODEL || 'glm-4.6v',
    dpi: Number(process.env.NVCI_LITE_VISION_DPI) || 150,
    maxPages: Number(process.env.NVCI_LITE_VISION_PAGES) || 6,
  };
}

// 弱文字判定：文字层按页均摊过薄（<150 字符/页，前 5 页），规则与文本 LLM 在这类彩页上收不出参数
function isWeakText(extraction) {
  if (!extraction || !Array.isArray(extraction.pages) || !extraction.pages.length) return false;
  const sampledPages = Math.min(extraction.pages.length, 5);
  return extraction.fullText.length / sampledPages < 150;
}

const VISION_EXTRACT_PROMPT = `你是网络设备彩页参数抽取专家。给你若干张彩页页面图片（按顺序对应第 1..N 页），从图片中清晰可见的文字里抽取技术参数。
规则：
1. 只抽图片里明确写出的值，禁止推断或编造；看不清或不存在的字段直接省略。
2. value 保留原文数值与单位；quote 固定为空字符串；page 填该值所在图片的序号。
3. key 用小写下划线英文（如 switching_capacity）；label 用中文参数名；group 从这些里选：物理规格/端口/转发性能/供电/可靠性/协议特性/管理/环境适应/其他。
4. 最多输出 25 个参数，优先覆盖：端口配置、交换容量、包转发率、PoE、功耗、外形、工作温度、可靠性。输出不要换行美化，紧凑 JSON。
5. 输出严格 JSON：{"params":[{"key":"","label":"","group":"","value":"","quote":"","page":1}]}`;

function buildVisionMessages(document, images) {
  const content = images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
  }));
  content.push({
    type: 'text',
    text: `产品：${document.vendorName} ${document.series}（型号：${(document.modelNames || []).join('、') || '未列出'}）
以上 ${images.length} 张图片依次为彩页第 1-${images.length} 页，抽取技术参数。`,
  });
  return [
    { role: 'system', content: VISION_EXTRACT_PROMPT },
    { role: 'user', content },
  ];
}

// pdftoppm（poppler-utils）渲染前 N 页为 JPEG
async function renderPageImages(pdfBuffer, { dpi = 150, maxPages = 6 } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-vision-'));
  try {
    const input = path.join(tempDir, 'input.pdf');
    const prefix = path.join(tempDir, 'page');
    fs.writeFileSync(input, pdfBuffer);
    try {
      await execFileAsync('pdftoppm', [
        '-jpeg', '-jpegopt', 'quality=88',
        '-r', String(dpi),
        '-f', '1', '-l', String(maxPages),
        input, prefix,
      ], { timeout: 90000 });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('容器缺少 poppler（pdftoppm），请重建镜像（Dockerfile 已含 apk add poppler-utils）');
      throw new Error(`页面渲染失败：${String(error.message || error).slice(0, 120)}`);
    }
    const images = fs.readdirSync(tempDir)
      .filter((name) => name.endsWith('.jpg'))
      .sort((a, b) => (parseInt(a.match(/(\d+)\.jpg$/)[1], 10) - parseInt(b.match(/(\d+)\.jpg$/)[1], 10)))
      .map((name, index) => ({
        page: index + 1,
        mediaType: 'image/jpeg',
        base64: fs.readFileSync(path.join(tempDir, name)).toString('base64'),
      }));
    if (!images.length) throw new Error('页面渲染未产出图片');
    return images;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function extractParamsWithVision(document, pdfBuffer, { fetchImpl, dpi, maxPages, renderImages = renderPageImages } = {}) {
  const config = visionConfig();
  const images = await renderImages(pdfBuffer, { dpi: dpi || config.dpi, maxPages: maxPages || config.maxPages });
  const messages = buildVisionMessages(document, images);
  const content = await ai.chatCompletion({
    messages,
    json: true,
    model: config.model,
    fetchImpl,
  });
  const parsed = ai.parseJsonContent(content);
  const params = Array.isArray(parsed.params) ? parsed.params : [];
  return params.map((param) => ({
    key: String(param.key || '').trim() || 'unknown',
    label: String(param.label || param.key || '未命名字段').trim(),
    group: String(param.group || '其他').trim(),
    value: String(param.value || '').trim(),
    quote: '',
    page: Number(param.page) || 0,
    // 图片抽取无文字层可做引用校验，一律待复核（实测存在编造风险，见 RG-MACC 案例）
    status: param.value ? 'pending_review' : 'not_disclosed',
    source: 'vision',
  }));
}

module.exports = { buildVisionMessages, extractParamsWithVision, isWeakText, renderPageImages, visionConfig, VISION_EXTRACT_PROMPT };
