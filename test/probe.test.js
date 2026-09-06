'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifyCollectRow, lightProbeDocument, nextRunAt, parseSchedule, ProbeState, PROBE_STATE_LABELS } = require('../lib/probe');

const DOC = {
  documentId: 'doc-1',
  vendorName: 'ALE',
  series: 'OmniSwitch 2260',
  officialFileName: 'os2260.pdf',
  pdfUrl: 'https://www.al-enterprise.com/x.pdf',
  officialDomains: ['www.al-enterprise.com'],
  trustedRedirectDomains: [],
  expectedSha256: 'a'.repeat(64),
};

const completedRow = (overrides = {}) => ({
  status: 'completed',
  decision: 'downloaded',
  sha256: 'a'.repeat(64),
  warning: '',
  error: '',
  ...overrides,
});

test('探测分类：缓存复用 → 有效未变', () => {
  assert.equal(classifyCollectRow(completedRow({ decision: 'reuse_unchanged' }), DOC, { sha256: 'a'.repeat(64) }), 'valid_unchanged');
});

test('探测分类：首次建档按基线分三态', () => {
  // 与基线一致
  assert.equal(classifyCollectRow(completedRow(), DOC, null), 'baseline_matched');
  // 与基线不一致（collectDocument 会置 warning）
  assert.equal(classifyCollectRow(completedRow({ sha256: 'b'.repeat(64), warning: 'SHA-256 与基线不一致' }), DOC, null), 'updated');
  // 无基线的首次建档
  const noBaseline = { ...DOC, expectedSha256: '' };
  assert.equal(classifyCollectRow(completedRow(), noBaseline, null), 'new_archived');
});

test('探测分类：与上次建档哈希比对判更新', () => {
  assert.equal(classifyCollectRow(completedRow({ sha256: 'b'.repeat(64) }), DOC, { sha256: 'a'.repeat(64) }), 'updated');
  assert.equal(classifyCollectRow(completedRow(), DOC, { sha256: 'a'.repeat(64) }), 'valid_unchanged');
});

test('探测分类：失败决策码映射', () => {
  assert.equal(classifyCollectRow({ status: 'failed', decision: 'source_unavailable' }, DOC, null), 'unreachable');
  assert.equal(classifyCollectRow({ status: 'failed', decision: 'needs_route_validation' }, DOC, null), 'redirect_broken');
  assert.equal(classifyCollectRow({ status: 'failed', decision: 'non_pdf_response' }, DOC, null), 'not_pdf');
  assert.equal(classifyCollectRow({ status: 'failed', decision: 'parse_failed' }, DOC, null), 'corrupt');
  assert.equal(classifyCollectRow({ status: 'failed', decision: 'network_error' }, DOC, null), 'network_error');
});

function headResponse(status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || '' },
  };
}

test('轻量探测：200 + PDF 类型 → 无历史时仅「链接可访问」，历史元数据一致才「有效·未变」', async () => {
  const mockFetch = async () => headResponse(200, { 'content-type': 'application/pdf', 'content-length': '1024', etag: '"v1"', 'last-modified': 'Mon, 01 Sep 2026 00:00:00 GMT' });
  const first = await lightProbeDocument({ document: DOC, fetchImpl: mockFetch });
  assert.equal(first.probeStatus, 'link_ok', '无历史可比时只标链接可访问');

  const same = await lightProbeDocument({ document: DOC, previous: { etag: '"v1"', lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT', contentLength: 1024 }, fetchImpl: mockFetch });
  assert.equal(same.probeStatus, 'valid_unchanged', '历史元数据逐项一致才标未变');

  const mockFetchV2 = async () => headResponse(200, { 'content-type': 'application/pdf', 'content-length': '2048', etag: '"v2"', 'last-modified': 'Tue, 02 Sep 2026 00:00:00 GMT' });
  const changed = await lightProbeDocument({ document: DOC, previous: { etag: '"v1"', lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT', contentLength: 1024 }, fetchImpl: mockFetchV2 });
  assert.equal(changed.probeStatus, 'link_ok', '元数据变化仍只标可访问，内容变化由完整校验确认');
});

test('轻量探测：404 → 资源不可用；非 PDF 类型 → not_pdf', async () => {
  const notFound = await lightProbeDocument({ document: DOC, fetchImpl: async () => headResponse(404, {}) });
  assert.equal(notFound.probeStatus, 'unreachable');
  const html = await lightProbeDocument({ document: DOC, fetchImpl: async () => headResponse(200, { 'content-type': 'text/html' }) });
  assert.equal(html.probeStatus, 'not_pdf');
});

test('轻量探测：重定向跳出白名单 → redirect_broken；网络异常 → network_error', async () => {
  const evil = await lightProbeDocument({
    document: DOC,
    fetchImpl: async () => headResponse(302, { location: 'https://evil.example.com/x.pdf' }),
  });
  assert.equal(evil.probeStatus, 'redirect_broken');
  const broken = await lightProbeDocument({ document: DOC, fetchImpl: async () => { throw new Error('请求超时'); } });
  assert.equal(broken.probeStatus, 'network_error');
});

test('建档：连续失败计数与运行记录封顶', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-state-'));
  const state = new ProbeState(path.join(dir, 'probe-state.json'));
  const failedResult = { probeStatus: 'unreachable', detail: 'HTTP 404', status: 404 };
  state.recordResult('run-1', DOC, failedResult, null);
  assert.equal(state.data.documents[DOC.documentId].consecutiveFailures, 1);
  state.recordResult('run-2', DOC, failedResult, state.data.documents[DOC.documentId]);
  assert.equal(state.data.documents[DOC.documentId].consecutiveFailures, 2);
  state.recordResult('run-3', DOC, { probeStatus: 'valid_unchanged', sha256: 'a'.repeat(64) }, state.data.documents[DOC.documentId]);
  assert.equal(state.data.documents[DOC.documentId].consecutiveFailures, 0);
  assert.equal(state.data.documents[DOC.documentId].baselineMatches, true);
  for (let i = 0; i < 35; i += 1) state.pushRun({ runId: `run-${i}`, results: [{ row: i }] });
  assert.equal(state.data.runs.length, 30, '运行记录应封顶 30 次');
  assert.equal(state.data.runs[0].runId, 'run-34');
  assert.equal(state.data.runs[4].results.length, 1, '最近 5 轮保留完整明细');
  assert.equal(state.data.runs[5].results.length, 0, '第 6 轮起明细压成摘要');
  assert.equal(state.data.runs[29].runId, 'run-5', '最旧保留到 run-5');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('人工修正链接：allowManualUrl 放行白名单外 HTTPS，HTTP 仍拒绝', () => {
  const { GateError, assertAllowedUrl } = require('../lib/downloader');
  const ctx = { officialDomains: ['www.al-enterprise.com'], allowManualUrl: true };
  const ok = assertAllowedUrl('https://www.new-vendor.cn/datasheet.pdf', ctx);
  assert.equal(ok.hostname, 'www.new-vendor.cn');
  assert.throws(() => assertAllowedUrl('http://www.new-vendor.cn/datasheet.pdf', ctx), GateError);
  // 未开启人工通道时白名单外仍然拒绝
  assert.throws(() => assertAllowedUrl('https://www.new-vendor.cn/datasheet.pdf', { officialDomains: ['www.al-enterprise.com'] }), GateError);
});

test('人工字段：recordResult 保留 urlOverride，标记置位/重测清除 manualSettled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-manual-'));
  try {
    const state = new ProbeState(path.join(dir, 'probe-state.json'));
    const prev = { sha256: 'a'.repeat(64), urlOverride: 'https://manual.example.com/new.pdf', urlOverrideAt: '2026-09-05T00:00:00Z', consecutiveFailures: 3 };
    state.recordResult('run-1', DOC, { probeStatus: 'paused', manualNote: '王工确认暂缓', httpStatus: 0, manualSettled: true }, prev);
    let doc = state.data.documents[DOC.documentId];
    assert.equal(doc.urlOverride, 'https://manual.example.com/new.pdf', '修正链接应跨探测保留');
    assert.equal(doc.manualSettled, true);
    assert.equal(doc.manualNote, '王工确认暂缓');
    assert.equal(doc.consecutiveFailures, 0, '人工裁定应清零连续失败');
    state.recordResult('run-2', DOC, { probeStatus: 'baseline_matched', sha256: 'a'.repeat(64), clearManual: true }, doc);
    doc = state.data.documents[DOC.documentId];
    assert.equal(doc.manualSettled, false, '重测应解除人工裁定');
    assert.equal(doc.urlOverride, 'https://manual.example.com/new.pdf', '重测不清除修正链接');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('人工裁定：自动巡检跳过，修正链接注入探测', async () => {
  const { ProbeRunner, MANUAL_SETTLED } = require('../lib/probe');
  assert.ok(MANUAL_SETTLED.has('manual_ok') && MANUAL_SETTLED.has('paused'));
  const { Store } = require('../lib/store');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-skip-'));
  try {
    const store = new Store(dir);
    const state = new ProbeState(path.join(dir, 'probe-state.json'));
    const docA = { ...DOC, documentId: 'settled-1', vendorId: 'ale', vendorName: 'ALE', expectedSha256: '' };
    const docB = { ...DOC, documentId: 'override-1', vendorId: 'ale', vendorName: 'ALE', expectedSha256: '', pdfUrl: 'https://www.al-enterprise.com/old.pdf' };
    state.recordResult('seed-1', docA, { probeStatus: 'manual_ok', manualNote: '人工确认', manualSettled: true }, null);
    state.recordResult('seed-2', docB, { probeStatus: 'unreachable', httpStatus: 403 }, null);
    state.data.documents[docB.documentId].urlOverride = 'https://mirror.example.com/new.pdf';
    state.data.documents[docB.documentId].urlOverrideAt = '2026-09-05T00:00:00Z';

    const seenUrls = [];
    const fetchImpl = async (url) => {
      seenUrls.push(String(url));
      return headerOnly(200, { 'content-type': 'application/pdf' });
    };
    const runner = new ProbeRunner({ store, state, allDocuments: () => [docA, docB], fetchImpl, basePaceMs: 1, maxPaceMs: 2, breakerThreshold: 99 });
    const run = runner.start({ documents: [docA, docB], trigger: 'manual', mode: 'light' });
    await new Promise((resolve) => {
      const timer = setInterval(() => { if (!runner.isRunning) { clearInterval(timer); resolve(); } }, 10);
    });
    assert.equal(run.totals.manual_settled, 1, '人工裁定条目应计入跳过');
    assert.equal(run.results.length, 1, '裁定条目不产生结果行');
    assert.ok(seenUrls.some((u) => u === 'https://mirror.example.com/new.pdf'), '探测应使用人工修正链接');
    assert.ok(!seenUrls.some((u) => u.includes('al-enterprise.com/old.pdf')), '旧地址不应被请求');
    assert.equal(run.results[0].probeStatus, 'link_ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('人工状态标签齐全', () => {
  for (const key of ['manual_ok', 'manual_invalid', 'paused', 'manual_settled']) {
    assert.ok(PROBE_STATE_LABELS[key], `${key} 应有中文标签`);
  }
});

test('定时：HH:MM 解析与下一次触发时间', () => {
  assert.deepEqual(parseSchedule('04:30'), { hour: 4, minute: 30 });
  assert.deepEqual(parseSchedule('23:05'), { hour: 23, minute: 5 });
  assert.throws(() => parseSchedule('25:00'));
  assert.throws(() => parseSchedule('abc'));
  const from = new Date('2026-09-05T03:00:00');
  assert.equal(nextRunAt('04:30', from).getDate(), 5, '当天未到点则今天触发');
  const later = new Date('2026-09-05T05:00:00');
  const next = nextRunAt('04:30', later);
  assert.equal(next.getDate(), 6, '已过点则明天触发');
  assert.equal(next.getHours(), 4);
});

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Page/Count 1>>\nendobj\ntrailer\n%%EOF');

function methodAwareFetch(responses) {
  // responses: { HEAD: fn(...), GET: fn(...) }，按请求方法分发
  return async (url, options = {}) => {
    const handler = responses[options.method || 'GET'];
    assert.ok(handler, `未预期的请求方法：${options.method}`);
    return handler(url, options);
  };
}

const pdfHeaders = { 'content-type': 'application/pdf', 'content-length': String(PDF_BYTES.length) };
const headerOnly = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name.toLowerCase()] || '' } });

test('完整校验：HEAD 被 403 拒绝时回退 GET 下载并建档', async () => {
  const { Store } = require('../lib/store');
  const { collectDocument } = require('../lib/downloader');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-collect-'));
  try {
    const store = new Store(dir);
    const fetchImpl = methodAwareFetch({
      HEAD: async () => headerOnly(403),
      GET: async () => ({ ok: true, status: 200, headers: { get: (name) => pdfHeaders[name.toLowerCase()] || '' }, arrayBuffer: async () => PDF_BYTES }),
    });
    const doc = { ...DOC, expectedSha256: '' };
    const row = await collectDocument({ document: doc, store, fetchImpl });
    assert.equal(row.status, 'completed', `应回退成功：${row.error || ''}`);
    assert.equal(row.httpStatus, 403, 'HTTP 状态保留 HEAD 响应码供审阅');
    assert.ok(row.sha256 && row.pdfExists !== false, '应完成下载并入库');
    const crypto = require('node:crypto');
    assert.equal(row.sha256, crypto.createHash('sha256').update(PDF_BYTES).digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('轻量探测：HEAD 403 → GET Range 回退（PDF 类型通过为 link_ok，HTML 为 not_pdf）', async () => {
  const pdfFetch = methodAwareFetch({
    HEAD: async () => headerOnly(403),
    GET: async () => ({ ...headerOnly(206, pdfHeaders), body: { cancel: async () => {} } }),
  });
  const okResult = await lightProbeDocument({ document: DOC, fetchImpl: pdfFetch });
  assert.equal(okResult.probeStatus, 'link_ok');
  assert.match(okResult.detail, /GET 回退/);
  assert.equal(okResult.status, 206, 'HTTP 状态来自 GET 回退响应');

  const htmlFetch = methodAwareFetch({
    HEAD: async () => headerOnly(403),
    GET: async () => ({ ...headerOnly(206, { 'content-type': 'text/html' }), body: { cancel: async () => {} } }),
  });
  const htmlResult = await lightProbeDocument({ document: DOC, fetchImpl: htmlFetch });
  assert.equal(htmlResult.probeStatus, 'not_pdf', 'GET 回退也必须检查 PDF 类型');
});

test('限流判定：403/429/5xx/网络异常参与，404 与内容类失败不参与', () => {
  const { isThrottleRelevant } = require('../lib/probe');
  assert.equal(isThrottleRelevant({ probeStatus: 'unreachable', httpStatus: 403 }), true);
  assert.equal(isThrottleRelevant({ probeStatus: 'unreachable', httpStatus: 429 }), true);
  assert.equal(isThrottleRelevant({ probeStatus: 'unreachable', httpStatus: 503 }), true);
  assert.equal(isThrottleRelevant({ probeStatus: 'unreachable', httpStatus: 404 }), false);
  assert.equal(isThrottleRelevant({ probeStatus: 'network_error', httpStatus: 0 }), true);
  assert.equal(isThrottleRelevant({ probeStatus: 'not_pdf', httpStatus: 200 }), false);
});

test('自动降频：失败翻倍封顶，成功减半回基准，熔断后本轮跳过该品牌', async () => {
  const { ProbeRunner } = require('../lib/probe');
  const { Store } = require('../lib/store');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-runner-'));
  try {
    const store = new Store(dir);
    const state = new ProbeState(path.join(dir, 'probe-state.json'));
    const vendorA = (n) => ({ ...DOC, documentId: `a-${n}`, vendorId: 'ale', vendorName: 'ALE', pdfUrl: 'https://www.al-enterprise.com/x.pdf' });
    const vendorB = { ...DOC, documentId: 'b-1', vendorId: 'cisco', vendorName: 'Cisco', pdfUrl: 'https://www.cisco.com/x.pdf', officialDomains: ['www.cisco.com'] };
    const documents = [...Array.from({ length: 6 }, (_, i) => vendorA(i)), vendorB, ...Array.from({ length: 2 }, (_, i) => vendorA(10 + i))];
    // A 品牌全部 403（HEAD 与 GET 都拒），B 品牌正常
    const fetchImpl = async (url) => headerOnly(String(url).includes('cisco.com') ? 200 : 403);
    const runner = new ProbeRunner({
      store, state, allDocuments: () => documents, fetchImpl,
      basePaceMs: 5, maxPaceMs: 20, breakerThreshold: 3,
    });
    const run = runner.start({ documents, trigger: 'manual', mode: 'light' });
    await new Promise((resolve) => {
      const timer = setInterval(() => { if (!runner.isRunning) { clearInterval(timer); resolve(); } }, 20);
    });
    assert.equal(run.stopReason.includes('ALE'), true, '熔断应写入 stopReason');
    const statuses = run.results.map((row) => row.probeStatus);
    assert.equal(statuses.filter((s) => s === 'unreachable').length, 3, '熔断阈值 3 次');
    assert.equal(statuses.filter((s) => s === 'vendor_throttled').length, 5, '熔断后 A 品牌剩余 5 条跳过');
    assert.equal(statuses.includes('link_ok'), true, 'B 品牌正常探测不受影响（轻量模式标链接可访问）');
    assert.equal(state.vendorPace('ale'), 20, '失败翻倍应封顶在 maxPaceMs');
    assert.equal(state.vendorPace('cisco'), 5, '成功后应回到基准节拍');
    const alertStatuses = state.alerts().map((item) => item.status);
    assert.ok(alertStatuses.includes('unreachable'), 'unreachable 应进入告警');
    assert.ok(!alertStatuses.includes('vendor_throttled'), '品牌限流跳过不算告警');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
