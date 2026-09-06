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
// 第二步值-引用一致性：引用真实存在还不够，取值必须被引用支持
// （归一化包含，或取值中的每个数字组都能在引用中找到），否则降为待复核。
function normalizeForMatch(text) {
  return String(text)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function numberGroups(text) {
  return String(text).match(/\d+(?:[.,]\d+)*(?:\/\d+)*/g) || [];
}

function valueSupportedByQuote(value, quote) {
  const normValue = normalizeForMatch(value);
  const normQuote = normalizeForMatch(quote);
  if (!normValue) return false;
  if (normQuote.includes(normValue)) return true;
  const groups = numberGroups(value);
  if (!groups.length) {
    // 无数字取值（如管理方式描述）：取前 12 个归一化字符做锚点
    return normQuote.includes(normValue.slice(0, Math.min(12, normValue.length)));
  }
  const quoteGroups = new Set(numberGroups(quote));
  return groups.every((group) => quoteGroups.has(group));
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
    const value = String(param.value || '').trim();
    const verified = verifyQuoteAgainstPages(quote, extraction.pages);
    const cell = {
      key: String(param.key || '').trim() || 'unknown',
      label: String(param.label || param.key || '未命名字段').trim(),
      group: String(param.group || '其他').trim(),
      value,
      quote: '',
      page: 0,
      status: 'not_disclosed',
      source: 'ai',
      reviewNote: '',
    };
    if (!value) return cell;
    if (!verified.verified) {
      // 引用未通过原文校验的值不可机械复核，降为待复核（与视觉抽取同一待遇）
      cell.status = 'pending_review';
      cell.reviewNote = '引用未在原文中找到';
      return cell;
    }
    cell.quote = quote;
    cell.page = verified.page;
    if (!valueSupportedByQuote(value, quote)) {
      // 引用真实存在但取值不被引用支持（如原文 128Gbit/s 被写成 999Gbit/s）
      cell.status = 'pending_review';
      cell.reviewNote = '取值与引用原文不一致';
    } else {
      cell.status = 'ok';
    }
    return cell;
  });
}

// 对比分析：基于参数矩阵 + 关键原文生成结构化分析（Word 报告的骨架）。
const ANALYSIS_SYSTEM_PROMPT = `你是网络设备选型与竞品分析专家。基于给定的多品牌产品参数矩阵与彩页要点，输出结构化对比分析。
规则：
1. 结论必须基于给定参数；参数为"未找到"时明确说明"本次资料未找到该参数"，禁止推断为不支持。
2. 标注"（待核对）"的值是机器推测或来源冲突值，未经充分校验：可以引用但要注明"待人工核对"，重要结论不得单独依赖待核对值。
3. 每条关键结论尽量标注其依据字段与原文引用（矩阵中已附）；用户未提供采购门槛时，只报告差异，不自行宣布淘汰或替代结论。
4. 指出关键偏离（端口数/PoE/交换容量等）、适用场景。
5. 采购验证问题要具体可执行（向厂商/代理验证什么、要什么证据）。
6. 输出严格 JSON：
{"executive_summary":"…","parameter_analysis":[{"field":"参数名","finding":"对比发现"}],"hard_gates":[{"field":"参数名","finding":"门槛差异与影响"}],"key_deviations":["…"],"scenario_advice":[{"scenario":"场景","recommendation":"建议与理由"}],"procurement_questions":["…"]}`;

async function analyzeWithAi(matrix, documents) {
  const matrixSummary = matrix.groups.map((group) => {
    const rows = group.fields.map((field) => {
      const cells = matrix.documents.map((doc) => {
        const cell = field.values[doc.documentId];
        if (cell.status === 'ok') {
          const quote = cell.quote ? `｜原文:「${cell.quote.slice(0, 40)}」(第${cell.page}页)` : '';
          return `${doc.label}=${cell.value}${quote}`;
        }
        if (cell.status === 'pending_review') {
          const reason = cell.reviewNote ? `（待核对·${cell.reviewNote.slice(0, 40)}）` : '（待核对）';
          return `${doc.label}=${cell.value}${reason}`;
        }
        return `${doc.label}=未找到`;
      }).join('；');
      return `${field.label}（${group.group}）：${cells}`;
    });
    return `【${group.group}】\n${rows.join('\n')}`;
  }).join('\n\n');
  const incompleteNote = (matrix.meta?.incompleteDocs || []).length
    ? `\n\n审阅完整性提示（相关结论需弱化）：\n${matrix.meta.incompleteDocs.map((item) => `- ${item.label}：${item.reason}`).join('\n')}`
    : '';
  const docSummary = documents.map((doc) => `- ${doc.label}：${doc.vendorName} ${doc.series}，彩页 ${doc.pageCount || '?'} 页，SHA-256 ${String(doc.sha256 || '').slice(0, 12)}…`).join('\n');
  const content = await chatCompletion({
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: `对比对象：\n${docSummary}\n\n参数矩阵（含原文引用与待核对原因）：\n${matrixSummary}${incompleteNote}` },
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
