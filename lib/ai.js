'use strict';

// AI 分析：双协议直连，零 SDK。
//   NVCI_LITE_AI_PROTOCOL=openai     → OpenAI 兼容 {base}/chat/completions（Bearer）
//   NVCI_LITE_AI_PROTOCOL=anthropic  → Anthropic Messages {base}/v1/messages（x-api-key，智谱 GLM 的
//                                      https://open.bigmodel.cn/api/anthropic 即此协议）
// 未配置 Key 时由上层走「AI 材料包」导出路径。
function aiConfig() {
  const base = (process.env.NVCI_LITE_AI_BASE || '').replace(/\/+$/, '');
  const apiKey = process.env.NVCI_LITE_AI_KEY || '';
  const model = process.env.NVCI_LITE_AI_MODEL || 'glm-4.6';
  const protocol = (process.env.NVCI_LITE_AI_PROTOCOL || 'openai').toLowerCase();
  return { base, apiKey, model, protocol, configured: Boolean(base && apiKey) };
}

function isConfigured() { return aiConfig().configured; }

async function chatCompletionOnce({ messages, json, temperature, model }, { base, apiKey, model: configModel, protocol }, fetchImpl) {
  const useModel = model || configModel;
  if (protocol === 'anthropic') {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const rest = messages.filter((message) => message.role !== 'system');
    const body = { model: useModel, max_tokens: 8192, temperature, messages: rest };
    if (system) body.system = system;
    const response = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AI 接口 HTTP ${response.status}：${text.slice(0, 300)}`);
    }
    const payload = await response.json();
    const content = Array.isArray(payload?.content)
      ? payload.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      : '';
    if (!content) throw new Error('AI 接口返回为空');
    return content;
  }
  const body = { model: useModel, messages, temperature, max_tokens: 8192 };
  if (json) body.response_format = { type: 'json_object' };
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI 接口 HTTP ${response.status}：${text.slice(0, 300)}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 接口返回为空');
  return content;
}

async function chatCompletion({ messages, json = false, maxRetries = 2, temperature = 0.1, fetchImpl = fetch, model } = {}) {
  const config = aiConfig();
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const timedFetch = async (url, options) => fetchImpl(url, { ...options, signal: controller.signal });
    try {
      return await chatCompletionOnce({ messages, json, temperature, model }, config, timedFetch);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`AI 调用失败（已重试 ${maxRetries} 次）：${String(lastError?.message || lastError)}`);
}

function parseJsonContent(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const raw = (fenced ? fenced[1] : content).trim();
  try {
    return JSON.parse(raw);
  } catch { /* 输出可能被 max_tokens 截断，尝试修复 */ }
  // 截断修复：丢弃尾部不完整的对象，用最后一个完整对象收尾并闭合容器
  const repaired = raw.replace(/,\s*$/, '');
  for (let cut = repaired.lastIndexOf('}'); cut > 0; cut = repaired.lastIndexOf('}', cut - 1)) {
    try {
      return JSON.parse(`${repaired.slice(0, cut + 1)}]}`);
    } catch { /* 继续向前找完整边界 */ }
  }
  throw new Error(`AI 返回的 JSON 无法解析（可能被截断）：${raw.slice(0, 120)}`);
}

// 参数抽取：每型号一次调用，从彩页全文抽结构化参数（含原文引用与页码）。
const EXTRACT_SYSTEM_PROMPT = `你是网络设备彩页参数抽取专家。从给定产品彩页文本中抽取技术参数。
规则：
1. 只抽文本明确写出的值，禁止推断或编造；找不到就省略该字段。
2. value 保留原文数值与单位；quote 是含该值的原文片段（截 80 字内）；page 是片段所在页码（文本按页给出）。
3. key 用小写下划线英文（如 switching_capacity）；label 用中文参数名；group 从这些里选：物理规格/端口/转发性能/供电/可靠性/协议特性/管理/环境适应/其他。
4. 最多输出 25 个参数，优先覆盖：端口配置、交换容量、包转发率、PoE、功耗、外形、工作温度、可靠性，其余按重要性取舍。输出不要换行美化，紧凑 JSON。
5. 输出严格 JSON：{"params":[{"key":"","label":"","group":"","value":"","quote":"","page":1}]}`;

// 引用原文校验：全角转半角、去空白、小写后做子串匹配。命中则回填机械核实的页码；
// 未命中则清空引用与页码（宁缺毋滥，不把模型口述的引用当证据）。
function normalizeForMatch(text) {
  return String(text)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function verifyQuoteAgainstPages(quote, pages) {
  const needle = normalizeForMatch(quote);
  if (!needle) return { verified: false, page: 0 };
  for (const page of Array.isArray(pages) ? pages : []) {
    if (normalizeForMatch(page.lines.join('\n')).includes(needle)) {
      return { verified: true, page: page.page };
    }
  }
  return { verified: false, page: 0 };
}

async function extractParamsWithAi(document, extraction, { maxChars = 60000, fetchImpl } = {}) {
  const pageMarkers = extraction.pages.map((page) => `【第 ${page.page} 页】\n${page.lines.join('\n')}`).join('\n\n');
  const userPrompt = `产品：${document.vendorName} ${document.series}（型号：${(document.modelNames || []).join('、') || '未列出'}）
彩页文本（按页标注）：
${pageMarkers.slice(0, maxChars)}`;
  const content = await chatCompletion({
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    json: true,
    fetchImpl,
  });
  const parsed = parseJsonContent(content);
  const params = Array.isArray(parsed.params) ? parsed.params : [];
  return params.map((param) => {
    const quote = String(param.quote || '').trim().slice(0, 200);
    const verified = verifyQuoteAgainstPages(quote, extraction.pages);
    return {
      key: String(param.key || '').trim() || 'unknown',
      label: String(param.label || param.key || '未命名字段').trim(),
      group: String(param.group || '其他').trim(),
      value: String(param.value || '').trim(),
      quote: verified.verified ? quote : '',
      page: verified.verified ? verified.page : 0,
      // 引用未通过原文校验的值不可机械复核，降为待复核（与视觉抽取同一待遇）
      status: param.value ? (verified.verified ? 'ok' : 'pending_review') : 'not_disclosed',
      source: 'ai',
    };
  });
}

// 对比分析：基于参数矩阵 + 关键原文生成结构化分析（Word 报告的骨架）。
const ANALYSIS_SYSTEM_PROMPT = `你是网络设备选型与竞品分析专家。基于给定的多品牌产品参数矩阵与彩页要点，输出结构化对比分析。
规则：
1. 结论必须基于给定参数；参数为"未披露"时明确说明"彩页未披露"，禁止推断为不支持。
2. 标注"（待复核）"的值是视觉/AI 抽取的推测值，未经原文校验：可以引用但要注明"待人工复核"，重要结论不得单独依赖待复核值。
3. 指出硬门槛差异（端口数/PoE/交换容量等采购一票否决项）、关键偏离、适用场景。
4. 采购验证问题要具体可执行（向厂商/代理验证什么、要什么证据）。
5. 输出严格 JSON：
{"executive_summary":"…","parameter_analysis":[{"field":"参数名","finding":"对比发现"}],"hard_gates":[{"field":"参数名","finding":"门槛差异与影响"}],"key_deviations":["…"],"scenario_advice":[{"scenario":"场景","recommendation":"建议与理由"}],"procurement_questions":["…"]}`;

async function analyzeWithAi(matrix, documents) {
  const matrixSummary = matrix.groups.map((group) => {
    const rows = group.fields.map((field) => {
      const cells = matrix.documents.map((doc) => {
        const cell = field.values[doc.documentId];
        const text = cell.status === 'ok' ? cell.value
          : (cell.status === 'pending_review' ? `${cell.value}（待复核）` : '未披露');
        return `${doc.label}=${text}`;
      }).join('；');
      return `${field.label}（${group.group}）：${cells}`;
    });
    return `【${group.group}】\n${rows.join('\n')}`;
  }).join('\n\n');
  const docSummary = documents.map((doc) => `- ${doc.label}：${doc.vendorName} ${doc.series}，彩页 ${doc.pageCount || '?'} 页，SHA-256 ${String(doc.sha256 || '').slice(0, 12)}…`).join('\n');
  const content = await chatCompletion({
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: `对比对象：\n${docSummary}\n\n参数矩阵：\n${matrixSummary}` },
    ],
    json: true,
  });
  const parsed = parseJsonContent(content);
  return {
    executive_summary: String(parsed.executive_summary || ''),
    parameter_analysis: Array.isArray(parsed.parameter_analysis) ? parsed.parameter_analysis : [],
    hard_gates: Array.isArray(parsed.hard_gates) ? parsed.hard_gates : [],
    key_deviations: Array.isArray(parsed.key_deviations) ? parsed.key_deviations.map(String) : [],
    scenario_advice: Array.isArray(parsed.scenario_advice) ? parsed.scenario_advice : [],
    procurement_questions: Array.isArray(parsed.procurement_questions) ? parsed.procurement_questions.map(String) : [],
  };
}

module.exports = { aiConfig, isConfigured, chatCompletion, extractParamsWithAi, analyzeWithAi, parseJsonContent };
