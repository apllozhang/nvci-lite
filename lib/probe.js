'use strict';

// 彩页资料探测校验：对 bundled-profiles 登记的全部公开来源做周期性有效性验证。
// 方法论与采集完全一致（复用 downloader）：HTTPS-only 官方域名白名单、重定向逐跳断言、
// HEAD 元数据优先、完整校验时才下载（PDF 签名检查 + SHA-256 建档）、顺序请求、声明 UA、
// 不绕过登录/验证码/访问控制。
// 建档：probe-state.json 记录每条资料最近一次探测状态与 SHA-256；与 bundled 基线
// expectedSha256 或上次建档哈希不一致时判定「厂商已更新」，告警不阻断（与采集口径相同）。

const fs = require('fs');
const notify = require('./notify');

const {
  assertAllowedUrl,
  collectDocument,
  DEFAULT_TIMEOUT_MS,
  GateError,
  headerMetadata,
  nowIso,
  safeFetch,
  USER_AGENT,
  writeBufferAtomic,
} = require('./downloader');

const PROBE_STATE_LABELS = {
  valid_unchanged: '有效·未变',
  link_ok: '链接可访问',
  baseline_matched: '新建档·与基线一致',
  updated: '厂商已更新',
  new_archived: '新建档（无基线）',
  unreachable: '资源不可用',
  redirect_broken: '跳转超出白名单',
  not_pdf: '非 PDF 内容',
  corrupt: '文件无法解析',
  too_large: '超出大小限制',
  network_error: '网络异常',
  vendor_throttled: '品牌限流·本轮跳过',
  manual_ok: '人工确认有效',
  manual_invalid: '人工确认失效',
  paused: '暂缓跟踪',
  manual_settled: '人工已裁定·跳过',
};

const FAILED_STATES = new Set(['unreachable', 'redirect_broken', 'not_pdf', 'corrupt', 'too_large', 'network_error']);
// 人工裁定态：自动巡检跳过，只有「立即重测/修正链接/上传 PDF」会重新裁定
const MANUAL_SETTLED = new Set(['manual_ok', 'manual_invalid', 'paused']);

// 判定失败是否属于"疑似被限流"：403/429/5xx/网络异常会随请求频率变化，
// 404/内容类失败降频无益，不参与熔断计数。
function isThrottleRelevant(result) {
  if (result.probeStatus === 'network_error') return true;
  if (result.probeStatus === 'unreachable') {
    const status = Number(result.httpStatus) || 0;
    return status === 403 || status === 429 || status >= 500;
  }
  return false;
}

function classifyDecision(decision) {
  if (decision === 'needs_route_validation') return 'redirect_broken';
  if (decision === 'source_unavailable') return 'unreachable';
  if (decision === 'non_pdf_response') return 'not_pdf';
  if (decision === 'parse_failed') return 'corrupt';
  if (decision === 'restricted_excluded') return 'too_large';
  return 'network_error';
}

function classifyError(error) {
  return classifyDecision(error instanceof GateError ? error.decision : '');
}

// 完整校验分类：基于 collectDocument 结果行 + 目录基线 + 上次建档哈希。
function classifyCollectRow(row, document, previousEntry) {
  if (row.status === 'completed') {
    if (row.decision === 'reuse_unchanged') return 'valid_unchanged';
    if (!previousEntry) {
      // 首次建档：warning 表示与 bundled 基线不一致
      if (row.warning) return 'updated';
      return document.expectedSha256 ? 'baseline_matched' : 'new_archived';
    }
    if (previousEntry.sha256 && previousEntry.sha256 !== row.sha256) return 'updated';
    return 'valid_unchanged';
  }
  return classifyDecision(row.decision);
}

// 轻量探测：仅 HEAD 元数据，不下载。语义约束：「链接可访问」只证明 URL 活着，
// 仅当与上次建档的元数据（ETag/Last-Modified/长度）完全一致时才可标「有效·未变」——
// 可访问不能证明内容没变。部分站点对 HEAD 返回异常码时以 GET Range 回退验证（含 PDF 类型检查）。
async function lightProbeDocument({ document, previous = null, fetchImpl = fetch }) {
  const context = {
    officialDomains: document.officialDomains,
    trustedRedirectDomains: document.trustedRedirectDomains,
    allowManualUrl: Boolean(document.urlOverride),
  };
  const row = {
    documentId: document.documentId,
    vendorName: document.vendorName,
    series: document.series,
    officialFileName: document.officialFileName,
    sourceUrl: document.pdfUrl,
    startedAt: nowIso(),
  };
  try {
    assertAllowedUrl(document.pdfUrl, context);
    const head = await safeFetch(document.pdfUrl, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } }, context, fetchImpl, DEFAULT_TIMEOUT_MS);
    Object.assign(row, headerMetadata(head.response));
    row.finalUrl = head.finalUrl;
    const headOk = row.status >= 200 && row.status < 400;
    if (!headOk && (row.status === 403 || row.status === 405)) {
      // WAF 拒绝 HEAD 但放行 GET 时，回退 GET Range 探测（同一 URL、同一声明 UA），并检查 PDF 类型
      const get = await safeFetch(document.pdfUrl, { method: 'GET', headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' } }, context, fetchImpl, DEFAULT_TIMEOUT_MS);
      if (get.response.body) await get.response.body.cancel().catch(() => {});
      Object.assign(row, headerMetadata(get.response));
      row.finalUrl = get.finalUrl;
      if (row.status === 200 || row.status === 206) {
        const getType = String(row.contentType || '').toLowerCase();
        if (getType && !getType.includes('pdf') && !getType.includes('octet-stream')) {
          return { ...row, probeStatus: 'not_pdf', detail: `HEAD 被拒（403/405），GET 回退返回类型 ${row.contentType}` };
        }
        return { ...row, probeStatus: classifyByHistory(row, previous), detail: 'HEAD 被拒（403/405），GET 回退验证通过' };
      }
      return { ...row, probeStatus: 'unreachable', detail: `HEAD 与 GET 均异常（HEAD ${head.status} / GET ${row.status}）` };
    }
    if (!headOk) return { ...row, probeStatus: 'unreachable', detail: `HTTP ${row.status}` };
    const declaredType = String(row.contentType || '').toLowerCase();
    if (declaredType && !declaredType.includes('pdf') && !declaredType.includes('octet-stream')) {
      return { ...row, probeStatus: 'not_pdf', detail: `Content-Type ${row.contentType}` };
    }
    return { ...row, probeStatus: classifyByHistory(row, previous), detail: '' };
  } catch (error) {
    return { ...row, probeStatus: classifyError(error), detail: String(error.message || error) };
  }
}

// 仅当存在强校验器（ETag / Last-Modified）且逐项一致（长度也相同）才可判「有效·未变」；
// 只有长度相同不能证明内容没变——同长度新文件完全可能，此时只到「链接可访问」，
// 内容是否变化由完整校验的哈希确认。
function classifyByHistory(row, previous) {
  if (!previous) return 'link_ok';
  const strongValidator = previous.etag || previous.lastModified;
  if (!strongValidator) return 'link_ok';
  const same = (!previous.etag || previous.etag === row.etag)
    && (!previous.lastModified || previous.lastModified === row.lastModified)
    && (previous.contentLength === row.contentLength);
  return same ? 'valid_unchanged' : 'link_ok';
}

// 建档存储：每条资料最近一次探测结论 + 最近 30 次运行记录（明细仅留最近 5 轮）+ 品牌级限流节拍。
class ProbeState {
  constructor(filePath) {
    this.filePath = filePath;
    this.maxRuns = 30;
    this.detailRuns = 5;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.documents && Array.isArray(parsed.runs)) {
        if (!parsed.vendorPace || typeof parsed.vendorPace !== 'object') parsed.vendorPace = {};
        return parsed;
      }
    } catch { /* 首次运行或损坏时重建 */ }
    return { schemaVersion: 1, documents: {}, runs: [], vendorPace: {}, updatedAt: '' };
  }

  save() {
    this.data.updatedAt = nowIso();
    writeBufferAtomic(this.filePath, Buffer.from(`${JSON.stringify(this.data, null, 2)}\n`, 'utf8'));
  }

  recordResult(runId, document, result, previous) {
    const ok = !FAILED_STATES.has(result.probeStatus);
    // 人工裁定在重测/修正链接/上传时被重新裁定清除，标记动作则置位
    const manualSettled = result.clearManual ? false : (result.manualSettled ?? previous?.manualSettled ?? false);
    this.data.documents[document.documentId] = {
      documentId: document.documentId,
      vendorName: document.vendorName,
      series: document.series,
      lastProbeStatus: result.probeStatus,
      lastDetail: result.detail || '',
      lastDecision: result.decision || '',
      lastCheckedAt: nowIso(),
      lastRunId: runId,
      sha256: result.sha256 || previous?.sha256 || '',
      baselineSha256: document.expectedSha256 || '',
      baselineMatches: Boolean(result.sha256 && document.expectedSha256 && result.sha256 === document.expectedSha256),
      httpStatus: result.httpStatus || 0,
      contentLength: result.contentLength || 0,
      lastModified: result.lastModified || '',
      etag: result.etag || '',
      consecutiveFailures: ok ? 0 : (previous?.consecutiveFailures || 0) + 1,
      // 人工校验字段：修正链接与裁定备注需跨探测保留
      urlOverride: previous?.urlOverride || '',
      urlOverrideAt: previous?.urlOverrideAt || '',
      manualNote: result.manualNote ?? previous?.manualNote ?? '',
      manualAt: result.manualNote ? nowIso() : (previous?.manualAt || ''),
      manualSettled,
      lastSourceUrl: document.pdfUrl,
    };
  }

  pushRun(run) {
    this.data.runs.unshift(run);
    this.data.runs = this.data.runs.slice(0, this.maxRuns);
    // 完整明细只保留最近 5 轮，更早的压成摘要，控制建档文件体积
    this.data.runs = this.data.runs.map((item, index) => (
      index < this.detailRuns || !Array.isArray(item.results) ? item : { ...item, results: [] }
    ));
  }

  summaryCounts() {
    const counts = {};
    for (const doc of Object.values(this.data.documents)) {
      counts[doc.lastProbeStatus] = (counts[doc.lastProbeStatus] || 0) + 1;
    }
    return counts;
  }

  // 品牌级节拍（毫秒）：失败翻倍、成功减半，跨运行记忆，避免对同一站点越挫越勇
  vendorPace(vendorId) { return Number(this.data.vendorPace?.[vendorId]) || 0; }

  setVendorPace(vendorId, ms) {
    if (!this.data.vendorPace) this.data.vendorPace = {};
    this.data.vendorPace[vendorId] = ms;
  }

  // 告警日志：厂商更新 + 真实异常（品牌限流跳过属延期重试，不算告警）
  alerts() {
    const list = [];
    for (const doc of Object.values(this.data.documents)) {
      if (doc.lastProbeStatus === 'updated' || FAILED_STATES.has(doc.lastProbeStatus)) {
        list.push({
          type: doc.lastProbeStatus === 'updated' ? 'updated' : 'error',
          documentId: doc.documentId,
          vendorName: doc.vendorName,
          series: doc.series,
          status: doc.lastProbeStatus,
          detail: doc.lastDetail || '',
          checkedAt: doc.lastCheckedAt || '',
        });
      }
    }
    return list.sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt))).slice(0, 200);
  }
}

// 运行引擎：顺序逐条探测，支持停止；每 10 条落盘一次。
// 限流保护：品牌级自适应节拍（失败翻倍、成功减半，跨运行记忆），
// 同一品牌连续疑似限流达到阈值后，本轮跳过该品牌剩余资料（下次运行自动重试）。
class ProbeRunner {
  constructor({ store, state, allDocuments, fetchImpl, basePaceMs = 250, maxPaceMs = 10000, breakerThreshold = 10 }) {
    this.store = store;
    this.state = state;
    this.allDocuments = allDocuments;
    this.fetchImpl = fetchImpl;
    this.basePaceMs = basePaceMs;
    this.maxPaceMs = maxPaceMs;
    this.breakerThreshold = breakerThreshold;
    this.running = false;
    this.stopRequested = false;
    this.current = null;
  }

  get isRunning() { return this.running; }

  requestStop() {
    if (this.running) this.stopRequested = true;
  }

  start({ documents, trigger = 'manual', mode = 'full' }) {
    if (this.running) throw new Error('已有校验任务在进行中');
    if (!Array.isArray(documents) || !documents.length) throw new Error('校验范围为空');
    this.running = true;
    this.stopRequested = false;
    const run = {
      runId: `probe-${Date.now()}`,
      trigger,
      mode,
      scope: documents.length,
      startedAt: nowIso(),
      finishedAt: '',
      totals: {},
      stopReason: '',
      results: [],
    };
    this.current = { runId: run.runId, index: 0, total: documents.length, vendorName: '', series: '' };
    void this.execute(run, documents);
    return run;
  }

  async execute(run, documents) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const skipVendors = new Set();
    const vendorStreak = new Map();
    try {
      for (let i = 0; i < documents.length; i += 1) {
        if (this.stopRequested) { run.stopReason = '手动停止'; break; }
        const document = documents[i];
        const previousProbe = this.state.data.documents[document.documentId] || null;
        // 人工已裁定的资料自动巡检跳过（重测/修正链接/上传会重新裁定）
        if (previousProbe?.manualSettled && MANUAL_SETTLED.has(previousProbe.lastProbeStatus)) {
          run.totals.manual_settled = (run.totals.manual_settled || 0) + 1;
          continue;
        }
        if (skipVendors.has(document.vendorId)) {
          run.totals.vendor_throttled = (run.totals.vendor_throttled || 0) + 1;
          const checkedAt = nowIso();
          run.results.push({
            documentId: document.documentId,
            vendorName: document.vendorName,
            series: document.series,
            officialFileName: document.officialFileName,
            probeStatus: 'vendor_throttled',
            detail: `同品牌连续 ${this.breakerThreshold} 次疑似限流，本轮跳过（下次运行自动重试）`,
            httpStatus: 0,
            contentType: '',
            contentLength: 0,
            lastModified: '',
            sha256: '',
            warning: '',
            pageCount: 0,
            checkedAt,
          });
          this.state.recordResult(run.runId, document, { probeStatus: 'vendor_throttled', httpStatus: 0, detail: `连续 ${this.breakerThreshold} 次疑似限流，本轮跳过` }, previousProbe);
          continue;
        }
        this.current = { runId: run.runId, index: i + 1, total: documents.length, vendorName: document.vendorName, series: document.series };
        await sleep(Math.max(this.basePaceMs, this.state.vendorPace(document.vendorId)));
        // 人工修正链接生效：人工登记的新地址优先于 bundled 登记地址
        const effectiveDoc = previousProbe?.urlOverride
          ? { ...document, pdfUrl: previousProbe.urlOverride, urlOverride: previousProbe.urlOverride }
          : document;
        const previousEntry = previousProbe?.sha256
          ? { sha256: previousProbe.sha256 }
          : this.store.getIndexEntry(document.documentId);
        let result;
        if (run.mode === 'light') {
          result = await lightProbeDocument({ document: effectiveDoc, previous: previousProbe, fetchImpl: this.fetchImpl });
        } else {
          const row = await collectDocument({ document: effectiveDoc, store: this.store, fetchImpl: this.fetchImpl });
          result = { ...row, probeStatus: classifyCollectRow(row, effectiveDoc, previousEntry), detail: row.error || '' };
        }
        result.probeStatus = result.probeStatus || 'network_error';
        result.clearManual = true;
        // 归一化 HTTP 状态：轻量模式在 status，完整模式在 httpStatus（业务 status 是 completed/failed）
        result.httpStatus = Number(run.mode === 'light' ? result.status : result.httpStatus) || 0;
        run.totals[result.probeStatus] = (run.totals[result.probeStatus] || 0) + 1;

        // 品牌节拍：成功减半（回到基准封底），疑似限流失败翻倍（封顶）
        const currentPace = Math.max(this.basePaceMs, this.state.vendorPace(document.vendorId));
        if (!FAILED_STATES.has(result.probeStatus)) {
          this.state.setVendorPace(document.vendorId, Math.max(this.basePaceMs, Math.floor(currentPace / 2)));
          vendorStreak.set(document.vendorId, 0);
        } else if (isThrottleRelevant(result)) {
          const streak = (vendorStreak.get(document.vendorId) || 0) + 1;
          vendorStreak.set(document.vendorId, streak);
          this.state.setVendorPace(document.vendorId, Math.min(this.maxPaceMs, currentPace * 2));
          if (streak >= this.breakerThreshold) {
            skipVendors.add(document.vendorId);
            run.stopReason = `${run.stopReason ? `${run.stopReason}；` : ''}${document.vendorName} 连续 ${streak} 次疑似限流，本轮跳过其余资料`;
            console.log(JSON.stringify({ event: 'nvci_lite_probe_alert', level: 'warn', type: 'vendor_throttled', vendorName: document.vendorName, streak, pace: this.state.vendorPace(document.vendorId), at: nowIso() }));
          }
        }
        // 更新告警日志：厂商悄悄换彩页是竞对情报，必须留痕
        if (result.probeStatus === 'updated') {
          console.log(JSON.stringify({ event: 'nvci_lite_probe_alert', level: 'warn', type: 'updated', vendorName: document.vendorName, series: document.series, documentId: document.documentId, sha256: result.sha256, baseline: document.expectedSha256 || '', at: nowIso() }));
          // 外发监控指标（victoriametrics 文本导入，供 n9e 告警规则消费），失败不影响主流程
          notify.pushUpdatedEvent({
            vendorName: document.vendorName,
            series: document.series,
            documentId: document.documentId,
            sha256: result.sha256,
          }).then((pushed) => {
            if (!pushed.skipped) console.log(JSON.stringify({ event: 'nvci_lite_probe_alert_pushed', type: 'updated', documentId: document.documentId, at: nowIso() }));
          }).catch((error) => {
            console.log(JSON.stringify({ event: 'nvci_lite_probe_alert_push_failed', type: 'updated', documentId: document.documentId, error: String(error.message || error), at: nowIso() }));
          });
        }

        run.results.push({
          documentId: document.documentId,
          vendorName: document.vendorName,
          series: document.series,
          officialFileName: document.officialFileName,
          probeStatus: result.probeStatus,
          detail: result.detail || '',
          httpStatus: result.httpStatus || 0,
          contentType: result.contentType || '',
          contentLength: result.contentLength || 0,
          lastModified: result.lastModified || '',
          sha256: result.sha256 || '',
          warning: result.warning || '',
          pageCount: result.pageCount || 0,
          sourceUrl: effectiveDoc.pdfUrl,
          urlOverridden: Boolean(previousProbe?.urlOverride),
          checkedAt: result.completedAt || nowIso(),
        });
        this.state.recordResult(run.runId, effectiveDoc, result, previousProbe);
        if ((i + 1) % 10 === 0) this.state.save();
      }
    } catch (error) {
      run.stopReason = `运行异常：${String(error.message || error)}`;
    } finally {
      run.finishedAt = nowIso();
      this.state.pushRun(run);
      this.state.save();
      this.running = false;
      this.current = null;
    }
  }
}

// 定时调度：每日 HH:MM（容器 TZ），零依赖 setTimeout 链。
function parseSchedule(schedule) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(schedule || '').trim());
  if (!match) throw new Error(`定时格式应为 HH:MM：${schedule}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function nextRunAt(schedule, from = new Date()) {
  const { hour, minute } = parseSchedule(schedule);
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function startScheduleLoop({ runner, schedule = '04:30', log = () => {} }) {
  const enabled = String(process.env.NVCI_LITE_PROBE_ENABLED || '').toLowerCase() === 'true';
  const stateInfo = { enabled, schedule, nextScheduledAt: '', timer: null };
  if (!enabled) return stateInfo;
  parseSchedule(schedule); // 启动时校验格式，配置错误立刻暴露
  const tick = () => {
    const next = nextRunAt(schedule);
    stateInfo.nextScheduledAt = next.toISOString();
    stateInfo.timer = setTimeout(() => {
      log(`定时彩页校验开始（每日 ${schedule}）`);
      try {
        const documents = runner.allDocuments();
        if (documents.length) {
          runner.start({
            documents,
            trigger: 'scheduled',
            mode: (process.env.NVCI_LITE_PROBE_MODE || 'full').toLowerCase(),
          });
        }
      } catch (error) {
        log(`定时校验启动失败：${String(error.message || error)}`);
      }
      tick();
    }, Math.max(1000, next.getTime() - Date.now()));
  };
  tick();
  return stateInfo;
}

module.exports = {
  FAILED_STATES,
  MANUAL_SETTLED,
  ProbeRunner,
  ProbeState,
  PROBE_STATE_LABELS,
  classifyCollectRow,
  classifyDecision,
  isThrottleRelevant,
  lightProbeDocument,
  nextRunAt,
  parseSchedule,
  startScheduleLoop,
};
