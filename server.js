'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { loadCatalog, findDocuments } = require('./lib/catalog');
const profileSchema = require('./lib/profile-schema');
const { collectDocument, hashBuffer, inspectPdf, nowIso, safeFetch, USER_AGENT } = require('./lib/downloader');
const { Store } = require('./lib/store');
const { extractPdfText } = require('./lib/pdf-text');
const { extractParamsByRules, buildMatrix, buildModelColumnParams, mergeParams } = require('./lib/params');
const ai = require('./lib/ai');
const { buildExcel, buildWordDocx, buildMaterialPack } = require('./lib/report');
const { fetchPageMarkdown } = require('./lib/page-markdown');
const { autoAssign, matchDocuments } = require('./lib/match');
const vision = require('./lib/vision');
const { FAILED_STATES, MANUAL_SETTLED, ProbeRunner, ProbeState, PROBE_STATE_LABELS, classifyCollectRow, startScheduleLoop } = require('./lib/probe');
const settings = require('./lib/settings');
const confirm = require('./lib/confirm');
const aiCache = require('./lib/ai-cache');
const thresholds = require('./lib/thresholds');
const { FIELD_TEMPLATE } = require('./lib/params');

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.NVCI_LITE_DATA_DIR || path.join(__dirname, 'data');
const PASSWORD = process.env.NVCI_LITE_PASSWORD || '';
const MAX_COLLECT = 50;
// T05 型号分列上限：彩页明确覆盖 2~该数个型号时每型号独立一列；更多型号（长尾全系列彩页）
// 拆列导致矩阵过宽且单型号可抽值稀疏，保持单列，型号归属交由人工确认对话框标注
const MAX_MODEL_COLUMNS = 4;

const store = new Store(DATA_DIR);
settings.init(DATA_DIR);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- 彩页资料探测校验（手动 + 定时） ----------

const probeState = new ProbeState(path.join(DATA_DIR, 'probe-state.json'));
const probeRunner = new ProbeRunner({
  store,
  state: probeState,
  allDocuments: () => loadCatalog().vendors.flatMap((vendor) => vendor.productLines.flatMap((line) => line.documents)),
});
const probeSchedule = startScheduleLoop({
  runner: probeRunner,
  schedule: process.env.NVCI_LITE_PROBE_SCHEDULE || '04:30',
  log: (message) => console.log(JSON.stringify({ event: 'nvci_lite_probe', message, at: new Date().toISOString() })),
});

function resolveProbeDocuments(body) {
  const all = probeRunner.allDocuments();
  if (Array.isArray(body?.documentIds) && body.documentIds.length) {
    const wanted = new Set(body.documentIds.map(String));
    return all.filter((doc) => wanted.has(doc.documentId));
  }
  let scope = all;
  if (body?.vendorId) scope = scope.filter((doc) => doc.vendorId === String(body.vendorId));
  if (body?.onlyFailed) {
    scope = scope.filter((doc) => {
      const record = probeState.data.documents[doc.documentId];
      return record && FAILED_STATES.has(record.lastProbeStatus);
    });
  }
  return scope;
}

app.post('/api/probe/start', auth, (req, res) => {
  try {
    const mode = req.body?.mode === 'light' ? 'light' : 'full';
    const documents = resolveProbeDocuments(req.body);
    const run = probeRunner.start({ documents, trigger: 'manual', mode });
    res.json({ ok: true, runId: run.runId, total: documents.length, mode });
  } catch (error) {
    const conflict = String(error.message || '').includes('已有校验任务');
    res.status(conflict ? 409 : 400).json({ error: String(error.message || error) });
  }
});

app.post('/api/probe/stop', auth, (_req, res) => {
  probeRunner.requestStop();
  res.json({ ok: true });
});

app.get('/api/probe/status', auth, (_req, res) => {
  const lastRun = probeState.data.runs[0] || null;
  res.json({
    running: probeRunner.isRunning,
    progress: probeRunner.current,
    schedule: {
      enabled: probeSchedule.enabled,
      schedule: probeSchedule.schedule,
      nextScheduledAt: probeSchedule.nextScheduledAt,
    },
    totalsByStatus: probeState.summaryCounts(),
    stateLabels: PROBE_STATE_LABELS,
    lastRun: lastRun ? { ...lastRun, results: undefined } : null,
  });
});

app.get('/api/probe/alerts', auth, (_req, res) => {
  res.json({ alerts: probeState.alerts(), stateLabels: PROBE_STATE_LABELS, generatedAt: new Date().toISOString() });
});

app.get('/api/probe/states', auth, (_req, res) => {
  const states = {};
  for (const [documentId, doc] of Object.entries(probeState.data.documents)) {
    states[documentId] = {
      lastProbeStatus: doc.lastProbeStatus,
      lastDetail: doc.lastDetail || '',
      manualNote: doc.manualNote || '',
      manualSettled: Boolean(doc.manualSettled),
      urlOverride: doc.urlOverride || '',
      lastCheckedAt: doc.lastCheckedAt || '',
    };
  }
  res.json({ states, stateLabels: PROBE_STATE_LABELS });
});

app.get('/api/probe/runs', auth, (_req, res) => {
  res.json({
    runs: probeState.data.runs.map(({ results, ...summary }) => ({ ...summary, resultCount: results.length })),
  });
});

app.get('/api/probe/runs/:runId', auth, (req, res) => {
  const run = probeState.data.runs.find((item) => item.runId === req.params.runId);
  if (!run) return res.status(404).json({ error: '校验记录不存在' });
  res.json(run);
});

// ---------- 人工校验模块：自动化两轮仍异常的资料，人工兜底 ----------

const MANUAL_MARKS = { manual_ok: '人工确认有效', manual_invalid: '人工确认失效', paused: '暂缓跟踪' };

// 单条立即校验：绕过批量队列直接执行一次完整校验（含人工修正链接），批量任务运行时拒绝以免状态竞争
async function runSingleProbe(documentId) {
  const document = findDocuments([documentId])[0];
  if (!document) return { status: 404, body: { error: '资料不存在' } };
  if (probeRunner.isRunning) return { status: 409, body: { error: '批量校验进行中，请等待完成或先停止' } };
  const previousProbe = probeState.data.documents[documentId] || null;
  const effectiveDoc = previousProbe?.urlOverride
    ? { ...document, pdfUrl: previousProbe.urlOverride, urlOverride: previousProbe.urlOverride }
    : document;
  const previousEntry = previousProbe?.sha256 ? { sha256: previousProbe.sha256 } : store.getIndexEntry(documentId);
  try {
    const row = await collectDocument({ document: effectiveDoc, store });
    const result = { ...row, probeStatus: classifyCollectRow(row, effectiveDoc, previousEntry) || 'network_error', detail: row.error || '', clearManual: true };
    result.httpStatus = Number(result.httpStatus) || 0;
    probeState.recordResult(`manual-${Date.now()}`, effectiveDoc, result, previousProbe);
    probeState.save();
    return {
      status: 200,
      body: { ok: true, probeStatus: result.probeStatus, detail: result.detail, sha256: result.sha256 || '', pageCount: result.pageCount || 0, warning: result.warning || '', stateLabels: PROBE_STATE_LABELS },
    };
  } catch (error) {
    return { status: 500, body: { error: `校验执行失败：${String(error.message || error)}` } };
  }
}

app.post('/api/probe/manual/match', auth, (req, res) => {
  const fileNames = [...new Set(Array.isArray(req.body?.fileNames) ? req.body.fileNames.map(String).slice(0, 200) : [])];
  if (!fileNames.length) return res.status(400).json({ error: '请提供文件名列表' });
  const all = probeRunner.allDocuments();
  const results = fileNames.map((fileName) => {
    const candidates = matchDocuments(fileName, all);
    return { fileName, auto: autoAssign(candidates), candidates };
  });
  res.json({ results, catalogSize: all.length });
});

app.post('/api/probe/retry', auth, async (req, res) => {
  const outcome = await runSingleProbe(String(req.body?.documentId || ''));
  res.status(outcome.status).json(outcome.body);
});

app.post('/api/probe/manual/:documentId/url', auth, async (req, res) => {
  const documentId = String(req.params.documentId || '');
  if (!findDocuments([documentId]).length) return res.status(404).json({ error: '资料不存在' });
  let url;
  try { url = new URL(String(req.body?.url || '').trim()); } catch { return res.status(400).json({ error: 'URL 格式无效' }); }
  if (url.protocol !== 'https:') return res.status(400).json({ error: '仅允许 HTTPS 链接（采集方法论硬性要求）' });
  const previous = probeState.data.documents[documentId];
  if (previous) {
    previous.urlOverride = url.toString();
    previous.urlOverrideAt = nowIso();
    previous.manualSettled = false;
    probeState.save();
  }
  const outcome = await runSingleProbe(documentId);
  if (outcome.status === 409) return res.json({ ok: true, urlOverride: url.toString(), note: '链接已保存；批量校验进行中，稍后在界面点「立即重测」生效' });
  res.status(outcome.status).json({ ...outcome.body, urlOverride: url.toString() });
});

app.post('/api/probe/manual/:documentId/status', auth, (req, res) => {
  const mark = String(req.body?.mark || '');
  if (!MANUAL_MARKS[mark]) return res.status(400).json({ error: '无效的人工标记' });
  const documentId = String(req.params.documentId || '');
  const document = findDocuments([documentId])[0];
  if (!document) return res.status(404).json({ error: '资料不存在' });
  const note = String(req.body?.note || '').slice(0, 200);
  probeState.recordResult(`manual-${Date.now()}`, document, { probeStatus: mark, detail: note || MANUAL_MARKS[mark], httpStatus: 0, manualNote: note || MANUAL_MARKS[mark], manualSettled: true }, probeState.data.documents[documentId] || null);
  probeState.save();
  res.json({ ok: true, status: mark });
});

app.post('/api/probe/manual/:documentId/pdf', auth, express.raw({ type: 'application/pdf', limit: '60mb' }), (req, res) => {
  const documentId = String(req.params.documentId || '');
  const document = findDocuments([documentId])[0];
  if (!document) return res.status(404).json({ error: '资料不存在' });
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) return res.status(400).json({ error: '未收到 PDF 内容' });
  try {
    // 签名 + 可读性 + 页数检查（与自动采集同一套 inspectPdf）
    const inspection = inspectPdf(buffer);
    const sha256 = hashBuffer(buffer);
    store.writePdf(sha256, buffer);
    const baselineChanged = Boolean(document.expectedSha256 && document.expectedSha256 !== sha256);
    const previousProbe = probeState.data.documents[documentId] || null;
    const previousEntry = previousProbe?.sha256 ? { sha256: previousProbe.sha256 } : store.getIndexEntry(documentId);
    const result = {
      status: 'completed', decision: 'downloaded', sha256, bytes: buffer.length,
      pageCount: inspection.pageCount, httpStatus: 0, detail: '人工上传',
      warning: baselineChanged ? `SHA-256 与基线不一致（厂商可能已更新彩页）：expected=${document.expectedSha256.slice(0, 12)}… actual=${sha256.slice(0, 12)}…` : '',
      clearManual: true,
    };
    result.probeStatus = classifyCollectRow(result, document, previousEntry) || 'new_archived';
    store.upsertIndexEntry({
      documentId,
      vendorName: document.vendorName,
      series: document.series,
      modelNames: document.modelNames,
      productLineName: document.productLineName,
      profileDisplayName: document.profileDisplayName,
      officialFileName: document.officialFileName,
      sourceUrl: previousProbe?.urlOverride || document.pdfUrl,
      productPageUrl: document.productPageUrl,
      materialPageUrl: document.materialPageUrl,
      sha256,
      bytes: buffer.length,
      pageCount: inspection.pageCount,
      status: 'completed',
      decision: 'downloaded',
      completedAt: nowIso(),
      warning: result.warning,
      httpStatus: 0,
      expectedSha256: document.expectedSha256,
      officialDomains: document.officialDomains,
      trustedRedirectDomains: document.trustedRedirectDomains,
      pdfPath: store.pdfRelativePath(sha256),
      collectedBy: 'manual-upload',
    });
    probeState.recordResult(`manual-${Date.now()}`, document, result, previousProbe);
    probeState.save();
    res.json({ ok: true, probeStatus: result.probeStatus, sha256, pageCount: inspection.pageCount, warning: result.warning, stateLabels: PROBE_STATE_LABELS });
  } catch (error) {
    res.status(400).json({ error: `PDF 未通过校验：${String(error.message || error)}` });
  }
});

app.get('/api/probe/docinfo/:documentId', auth, (req, res) => {
  const documentId = String(req.params.documentId || '');
  const document = findDocuments([documentId])[0];
  if (!document) return res.status(404).json({ error: '资料不存在' });
  const probe = probeState.data.documents[documentId] || null;
  res.json({
    documentId,
    vendorName: document.vendorName,
    series: document.series,
    officialFileName: document.officialFileName,
    pdfUrl: document.pdfUrl,
    expectedSha256: document.expectedSha256 || '',
    probe: probe ? {
      lastProbeStatus: probe.lastProbeStatus,
      lastDetail: probe.lastDetail || '',
      urlOverride: probe.urlOverride || '',
      manualNote: probe.manualNote || '',
      manualSettled: Boolean(probe.manualSettled),
      lastCheckedAt: probe.lastCheckedAt || '',
    } : null,
  });
});

// 可选口令：设置 NVCI_LITE_PASSWORD 后，API 与页面需先登录（签名 cookie，会话密钥存数据目录）。
function secretPath() { return path.join(store.rootDir, '.session-secret'); }
function sessionSecret() {
  try { return fs.readFileSync(secretPath(), 'utf8').trim(); } catch { /* 首次生成 */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath(), secret, 'utf8');
  return secret;
}
function signToken(expiresAt) {
  return crypto.createHmac('sha256', sessionSecret()).update(`lite.${expiresAt}`).digest('hex');
}
function validSession(req) {
  const token = req.cookies?.nvci_lite || '';
  const [prefix, expiresAt, signature] = token.split('.');
  if (prefix !== 'lite' || !expiresAt || !signature) return false;
  if (Date.now() > Number(expiresAt)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(signToken(expiresAt)));
  } catch { return false; }
}

// 极简 cookie 解析（不引 cookie-parser）
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) req.cookies[name] = decodeURIComponent(rest.join('='));
  }
  next();
});

function auth(req, res, next) {
  if (!PASSWORD || validSession(req)) return next();
  res.status(401).json({ error: '未登录或会话已过期' });
}

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.json({ ok: true, authRequired: false });
  if (String(req.body?.password || '') !== PASSWORD) return res.status(401).json({ error: '口令错误' });
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  res.cookie('nvci_lite', `lite.${expiresAt}.${signToken(expiresAt)}`, { httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true, authRequired: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authRequired: Boolean(PASSWORD), authenticated: !PASSWORD || validSession(req) });
});

app.get('/api/catalog', (req, res) => {
  res.json(loadCatalog());
});

// ---------- 自定义厂商/产品线来源（彩页归档方法论：完整版 SOURCE_CONFIGURATION_GUIDE） ----------

const CUSTOM_PROFILES_DIR = path.join(DATA_DIR, 'custom-profiles');

function customProfilePath(profileId) {
  // 只允许落在自定义目录内的安全文件名，防路径穿越
  const safe = String(profileId || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return null;
  return path.join(CUSTOM_PROFILES_DIR, `${safe}.json`);
}

app.get('/api/profiles', auth, (_req, res) => {
  const profiles = [];
  if (fs.existsSync(CUSTOM_PROFILES_DIR)) {
    for (const name of fs.readdirSync(CUSTOM_PROFILES_DIR).filter((n) => n.endsWith('.json')).sort()) {
      const profile = JSON.parse(fs.readFileSync(path.join(CUSTOM_PROFILES_DIR, name), 'utf8'));
      profiles.push(profile);
    }
  }
  res.json({ profiles });
});

app.post('/api/profiles', auth, (req, res) => {
  const { profile: normalized, errors } = profileSchema.normalizeCustomProfile(req.body || {});
  if (errors.length) return res.status(400).json({ error: '来源校验未通过', errors });
  const existingPath = customProfilePath(normalized.profileId);
  if (!existingPath) return res.status(400).json({ error: '来源配置标识无效' });
  // 覆盖更新时保留首次创建时间
  try {
    if (fs.existsSync(existingPath)) {
      const previous = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      normalized.createdAt = previous.createdAt || normalized.createdAt;
    }
    fs.mkdirSync(CUSTOM_PROFILES_DIR, { recursive: true });
    const temp = `${existingPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, existingPath);
  } catch (error) {
    return res.status(500).json({ error: `来源保存失败：${String(error.message || error)}` });
  }
  res.json({ ok: true, profile: normalized });
});

app.delete('/api/profiles/:profileId', auth, (req, res) => {
  const filePath = customProfilePath(req.params.profileId);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '自定义来源不存在' });
  try { fs.unlinkSync(filePath); } catch (error) {
    return res.status(500).json({ error: `删除失败：${String(error.message || error)}` });
  }
  res.json({ ok: true });
});

// 样本检查（方法论核心环节）：对已登记的前 5 条 PDF 低频 HEAD 验证——
// HTTPS 域名白名单、HTTP 状态、Content-Type；不下载文件体。
app.post('/api/profiles/sample-check', auth, async (req, res) => {
  const { profile: normalized, errors } = profileSchema.normalizeCustomProfile(req.body || {});
  if (errors.length) return res.status(400).json({ error: '来源校验未通过，请先修正', errors });
  const sample = normalized.sources.slice(0, 5);
  const context = {
    officialDomains: normalized.officialDomains,
    trustedRedirectDomains: normalized.trustedRedirectDomains,
  };
  const results = [];
  for (const source of sample) {
    try {
      const { response } = await safeFetch(
        source.pdfUrl,
        { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } },
        context,
      );
      const ok = response.status >= 200 && response.status < 300;
      const contentType = response.headers.get('content-type') || '';
      const pdfLike = /pdf|octet-stream/i.test(contentType);
      results.push({
        documentId: source.documentId,
        series: source.series,
        ok: ok && pdfLike,
        httpStatus: response.status,
        contentType,
        detail: !ok ? `HTTP ${response.status}` : (pdfLike ? '可访问 · PDF' : `可访问但 Content-Type 为 ${contentType || '未知'}，请确认是官方 PDF 直链`),
      });
    } catch (error) {
      results.push({ documentId: source.documentId, series: source.series, ok: false, httpStatus: 0, contentType: '', detail: String(error.message || error) });
    }
  }
  const passed = results.length > 0 && results.every((item) => item.ok);
  res.json({ ok: passed, results, checkedAt: new Date().toISOString() });
});

// 固定字段字典：第 4 步门槛编辑器的字段下拉来源（方案 §5.1）
app.get('/api/field-template', auth, (_req, res) => {
  res.json({ fields: FIELD_TEMPLATE.map(({ key, label, group }) => ({ key, label, group })) });
});

app.get('/api/ai-status', (req, res) => {
  const config = ai.aiConfig();
  res.json({ configured: config.configured, model: config.configured ? config.model : '', mode: config.configured ? 'auto' : 'material_pack' });
});

// ---------- 运行时设置（AI 对接热生效；存储路径重启生效） ----------

app.get('/api/settings', auth, (_req, res) => {
  res.json(settings.publicView({
    base: process.env.NVCI_LITE_AI_BASE || '',
    apiKey: process.env.NVCI_LITE_AI_KEY || '',
    model: process.env.NVCI_LITE_AI_MODEL || '',
    protocol: process.env.NVCI_LITE_AI_PROTOCOL || 'openai',
  }));
});

app.put('/api/settings', auth, (req, res) => {
  try {
    settings.update(req.body);
    const view = settings.publicView({
      base: process.env.NVCI_LITE_AI_BASE || '',
      apiKey: process.env.NVCI_LITE_AI_KEY || '',
      model: process.env.NVCI_LITE_AI_MODEL || '',
      protocol: process.env.NVCI_LITE_AI_PROTOCOL || 'openai',
    });
    res.json({ ok: true, settings: view });
  } catch (error) {
    res.status(500).json({ error: `设置保存失败：${String(error.message || error)}` });
  }
});

// ---------- 人工核对确认（轻量参数核对） ----------

app.get('/api/confirmations', auth, (_req, res) => {
  res.json({ confirmations: confirm.loadConfirmations(DATA_DIR) });
});

app.post('/api/confirmations', auth, (req, res) => {
  const input = req.body || {};
  const documentId = String(input.documentId || '');
  const doc = new Map(store.library().map((entry) => [entry.documentId, entry])).get(documentId);
  if (!doc) return res.status(400).json({ error: '该资料尚未采集，无法保存确认' });
  try {
    const record = confirm.upsertConfirmation(DATA_DIR, {
      documentId,
      paramKey: input.paramKey,
      value: input.value,
      model: input.model,
      note: input.note,
      docSha256: doc.sha256,
    });
    res.json({ ok: true, confirmation: record });
  } catch (error) {
    res.status(400).json({ error: `确认保存失败：${String(error.message || error)}` });
  }
});

app.delete('/api/confirmations', auth, (req, res) => {
  // model 参与确认键（T05）：同彩页不同型号的确认互不干扰；旧客户端不传 model 视为系列级
  const removed = confirm.removeConfirmation(DATA_DIR, String(req.query.documentId || ''), String(req.query.paramKey || ''), String(req.query.model || ''));
  res.json({ ok: removed });
});

app.post('/api/collect', auth, async (req, res) => {
  const documentIds = [...new Set(Array.isArray(req.body?.documentIds) ? req.body.documentIds.map(String) : [])];
  const includePages = Boolean(req.body?.includePages);
  if (!documentIds.length) return res.status(400).json({ error: '请至少选择一条资料' });
  if (documentIds.length > MAX_COLLECT) return res.status(400).json({ error: `单次采集上限 ${MAX_COLLECT} 条` });
  const documents = findDocuments(documentIds);
  const foundIds = new Set(documents.map((doc) => doc.documentId));
  const unknown = documentIds.filter((id) => !foundIds.has(id));
  const results = [];
  for (const document of documents) {
    const row = await collectDocument({ document, store });
    if (includePages && row.status === 'completed') {
      const page = await fetchPageMarkdown({ document });
      if (page.markdown && page.status !== 'failed') {
        const stored = store.writePageMarkdown(document.documentId, page.markdown, { status: page.status, reason: page.reason, finalUrl: page.finalUrl || '' });
        store.upsertIndexEntry({ documentId: document.documentId, pageMarkdown: stored });
        row.pageMarkdown = { ...stored };
      } else {
        store.upsertIndexEntry({ documentId: document.documentId, pageMarkdown: { status: page.status, reason: page.reason, path: '' } });
        row.pageMarkdown = { status: page.status, reason: page.reason };
      }
    }
    results.push(row);
  }
  res.json({
    total: results.length,
    completed: results.filter((row) => row.status === 'completed').length,
    failed: results.filter((row) => row.status === 'failed').length,
    unknown,
    results,
  });
});

app.get('/api/library', auth, (req, res) => {
  res.json({ documents: store.library() });
});

async function loadExtraction(entry) {
  const buffer = store.readPdf(entry.sha256);
  const extraction = await extractPdfText(buffer);
  return extraction;
}

app.post('/api/analyze', auth, async (req, res) => {
  const documentIds = [...new Set(Array.isArray(req.body?.documentIds) ? req.body.documentIds.map(String) : [])];
  const useAi = Boolean(req.body?.useAi);
  if (documentIds.length < 2) return res.status(400).json({ error: '对比分析至少选择 2 个产品' });
  if (documentIds.length > 6) return res.status(400).json({ error: '对比分析一次最多 6 个产品' });
  const library = new Map(store.library().map((doc) => [doc.documentId, doc]));
  const missing = documentIds.filter((id) => !library.has(id));
  if (missing.length) return res.status(400).json({ error: `以下产品尚未采集：${missing.join('、')}` });
  const documents = documentIds.map((id) => library.get(id));

  // 采购门槛（方案 §4.4/§9.2）：最多 5 条，{fieldKey, op(ge/gt/le/lt), value}
  const rawThresholds = Array.isArray(req.body?.thresholds) ? req.body.thresholds.slice(0, 5) : [];
  const thresholdList = [];
  for (const item of rawThresholds) {
    const fieldKey = String(item?.fieldKey || '').trim();
    const op = String(item?.op || '').trim();
    const value = String(item?.value || '').trim().slice(0, 40);
    if (!fieldKey || !thresholds.THRESHOLD_OPS[op] || !value) continue;
    thresholdList.push({ fieldKey, op, value });
  }

  try {
    const extractions = [];
    for (const doc of documents) {
      const extraction = await loadExtraction(doc);
      extractions.push({ documentId: doc.documentId, label: `${doc.vendorName} ${doc.series}`, extraction });
    }

    const columnsByDoc = await Promise.all(extractions.map(async (entry) => {
      const doc = documents.find((item) => item.documentId === entry.documentId);
      const ruleParams = extractParamsByRules(entry.extraction);
      // 视觉兜底（系列级，无型号归属）：文字层薄弱的彩页（扫描件/图片型）渲染页面图走视觉模型补参数
      const visionCfg = vision.visionConfig();
      let visionParams = null;
      if (useAi && ai.isConfigured() && visionCfg.mode !== 'off' && vision.isWeakText(entry.extraction)) {
        try {
          const pdfBuffer = store.readPdf(doc.sha256);
          visionParams = await vision.extractParamsWithVision(doc, pdfBuffer, { dpi: visionCfg.dpi, maxPages: visionCfg.maxPages });
          entry.visionUsed = visionParams.length > 0;
        } catch (error) {
          entry.visionError = String(error.message || error);
        }
      }
      // 抽取缓存（方案 §8.2）：彩页 SHA-256 + 模型 + 提示词版本 + 目标型号一致时复用，不重复调 AI
      const extractForTarget = async (targetModel) => {
        const key = aiCache.cacheKey({
          documentId: doc.documentId, sha256: doc.sha256,
          model: ai.aiConfig().model, promptRev: ai.EXTRACT_PROMPT_REV, targetModel,
        });
        const cached = aiCache.getCached(DATA_DIR, key);
        if (cached) {
          entry.aiFromCache = true;
          return cached;
        }
        const aiParams = await ai.extractParamsWithAi(doc, entry.extraction, { targetModel });
        aiCache.putCached(DATA_DIR, key, aiParams);
        return aiParams;
      };
      // T05 型号分列：AI 可用且彩页明确覆盖 2~MAX_MODEL_COLUMNS 个型号时，每个型号独立一列。
      // AI 按目标型号归属抽取；规则/视觉系列值经 buildModelColumnParams 标 unattributed
      // （型号归属未验证，界面提示「系列值」），防止系列值静默冒充型号值。
      if (useAi && ai.isConfigured() && Array.isArray(doc.modelNames)
        && doc.modelNames.length >= 2 && doc.modelNames.length <= MAX_MODEL_COLUMNS) {
        const seriesParams = visionParams ? mergeParams(visionParams, ruleParams) : ruleParams;
        const columns = [];
        for (const targetModel of doc.modelNames) {
          const label = `${entry.label} ${targetModel}`;
          try {
            const aiParams = await extractForTarget(targetModel);
            columns.push({ documentId: entry.documentId, model: targetModel, label, params: buildModelColumnParams(aiParams, seriesParams) });
          } catch (error) {
            entry.aiExtractError = String(error.message || error);
            // AI 失败降级：整列只剩系列值（均标 unattributed），归属交由人工核对
            columns.push({ documentId: entry.documentId, model: targetModel, label, params: seriesParams });
          }
        }
        return columns;
      }
      let params = ruleParams;
      if (useAi && ai.isConfigured()) {
        try {
          // 证据分级合并：同键冲突时保留双方候选并标待核对；AI 失败时仅用规则结果。
          params = mergeParams(await extractForTarget(''), params);
        } catch (error) {
          entry.aiExtractError = String(error.message || error);
        }
      }
      if (visionParams) params = mergeParams(visionParams, params);
      return [{ documentId: entry.documentId, model: '', label: entry.label, params }];
    }));

    // 固定字段模板初始化：关键字段没抽到也要显示为「未找到」，不完整审阅的原因随矩阵传递
    const matrix = buildMatrix(columnsByDoc.flat(), { initTemplate: true });
    // 列元数据注入（保留 buildMatrix 产出的 columnId/model/label）：sha256 供人工确认版本判定
    const docById = new Map(documents.map((doc) => [doc.documentId, doc]));
    matrix.documents = matrix.documents.map((column) => {
      const doc = docById.get(column.documentId);
      return { ...column, sha256: doc.sha256, modelNames: doc.modelNames || [], vendorName: doc.vendorName, series: doc.series };
    });
    const wantedIds = new Set(documentIds);
    const confirmations = confirm.loadConfirmations(DATA_DIR).filter((item) => wantedIds.has(item.documentId));
    const confirmedStats = confirm.applyConfirmations(matrix, confirmations);
    // 采购门槛三态判定（方案 §9.2）：在人工确认生效后计算，确认值按已核对参与判定
    if (thresholdList.length) matrix.thresholds = thresholds.evaluateThresholds(matrix, thresholdList);
    const incompleteDocs = [];
    for (const entry of extractions) {
      const reasons = [];
      if (entry.extraction.truncated) reasons.push(`仅抽取前 ${entry.extraction.pages.length} 页（彩页共 ${entry.extraction.pageCount} 页）`);
      if (entry.extraction.fullText.length > 60000) reasons.push('彩页文本超长，AI 输入被截断');
      if (vision.isWeakText(entry.extraction) && vision.visionConfig().mode === 'off') reasons.push('文字层薄弱（疑似图片型彩页），视觉抽取默认关闭');
      if (reasons.length) incompleteDocs.push({ documentId: entry.documentId, label: entry.label, reason: reasons.join('；') });
    }
    matrix.meta.incompleteDocs = incompleteDocs;

    const stem = `对比_${documents.map((doc) => doc.series.replace(/[\\/:*?"<>|\s]+/g, '')).join('_vs_')}`.slice(0, 120);
    // 同一次分析的三个产物共享 base（runId 语义），杜绝同毫秒并发互相占名
    const runBase = store.exportBaseName(stem);

    const excelPath = store.exportPath(`${runBase}.xlsx`);
    await buildExcel({ matrix, documents, outPath: excelPath });

    const files = [{ fileName: path.basename(excelPath), kind: 'excel' }];
    if (useAi && ai.isConfigured()) {
      try {
        const analysis = await ai.analyzeWithAi(matrix, documents);
        const wordPath = store.exportPath(`${runBase}.docx`);
        await buildWordDocx({ analysis, matrix, documents, outPath: wordPath });
        files.push({ fileName: path.basename(wordPath), kind: 'word' });
      } catch (error) {
        // Word 失败时自动降级导出材料包，保证分析产物始终可下载
        try {
          const packPath = store.exportPath(`${runBase}.md`);
          buildMaterialPack({
            matrix,
            documents,
            extractions: extractions.map((entry) => ({ label: entry.label, pageCount: entry.extraction.pageCount, pages: entry.extraction.pages })),
            outPath: packPath,
          });
          files.push({ fileName: '', kind: 'word_failed', error: String(error.message || error) });
          files.push({ fileName: path.basename(packPath), kind: 'material_pack' });
        } catch (packError) {
          files.push({ fileName: '', kind: 'word_failed', error: `${String(error.message || error)}；材料包降级也失败：${String(packError.message || packError)}` });
        }
      }
    } else {
      const packPath = store.exportPath(`${runBase}.md`);
      buildMaterialPack({
        matrix,
        documents,
        extractions: extractions.map((entry) => ({ label: entry.label, pageCount: entry.extraction.pageCount, pages: entry.extraction.pages })),
        outPath: packPath,
      });
      files.push({ fileName: path.basename(packPath), kind: 'material_pack' });
    }

    const aiErrors = extractions.filter((entry) => entry.aiExtractError).map((entry) => ({ documentId: entry.documentId, error: entry.aiExtractError }));
    const aiCachedCount = extractions.filter((entry) => entry.aiFromCache).length;
    const visionUsed = extractions.filter((entry) => entry.visionUsed).length;
    const visionErrors = extractions.filter((entry) => entry.visionError).map((entry) => ({ documentId: entry.documentId, error: entry.visionError }));
    const paramPendingCount = matrix.groups.reduce((sum, group) => sum + group.fields.filter((field) => Object.values(field.values).some((cell) => cell.status === 'pending_review')).length, 0);
    res.json({ ok: true, documents: documents.map((doc) => ({ documentId: doc.documentId, label: `${doc.vendorName} ${doc.series}` })), paramFieldCount: matrix.groups.reduce((sum, group) => sum + group.fields.length, 0), paramPendingCount, confirmedCount: confirmedStats.applied, staleConfirmationCount: confirmedStats.stale, aiCachedCount, visionUsed, visionErrors, aiErrors, files, matrix: { documents: matrix.documents, groups: matrix.groups, meta: matrix.meta, thresholds: matrix.thresholds || [] } });
  } catch (error) {
    res.status(500).json({ error: `分析失败：${String(error.message || error)}` });
  }
});

app.get('/api/exports', auth, (req, res) => {
  res.json({ exports: store.listExports() });
});

app.get('/api/exports/:fileName', auth, (req, res) => {
  const fileName = path.basename(String(req.params.fileName || ''));
  const fullPath = store.exportPath(fileName);
  if (!fullPath.startsWith(store.exportsDir) || !fs.existsSync(fullPath)) {
    return res.status(404).json({ error: '导出文件不存在' });
  }
  const mime = fileName.toLowerCase().endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : fileName.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'text/markdown';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  fs.createReadStream(fullPath).pipe(res);
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(JSON.stringify({
    event: 'nvci_lite_started',
    port: PORT,
    dataDir: store.rootDir,
    authRequired: Boolean(PASSWORD),
    aiConfigured: ai.isConfigured(),
    catalog: (() => { try { const catalog = loadCatalog(); return { vendors: catalog.vendorCount, documents: catalog.documentCount }; } catch { return { vendors: 0, documents: 0 }; } })(),
  }));
});
