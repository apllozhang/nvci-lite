'use strict';

// 校验探测路由：自动/手动探测、人工兜底（改链接 / 上传 PDF / 人工标记）、告警与历史。
// 从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth, store, probeState, probeRunner, probeSchedule }。

const express = require('express');
const { findDocuments } = require('../lib/catalog');
const { collectDocument, hashBuffer, inspectPdf, nowIso } = require('../lib/downloader');
const { autoAssign, matchDocuments } = require('../lib/match');
const { FAILED_STATES, MANUAL_SETTLED, PROBE_STATE_LABELS, classifyCollectRow } = require('../lib/probe');

module.exports = function probeRoutes(ctx) {
  const { auth, store, probeState, probeRunner, probeSchedule } = ctx;
  const router = express.Router();

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

  router.post('/api/probe/start', auth, (req, res) => {
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

  router.post('/api/probe/stop', auth, (_req, res) => {
    probeRunner.requestStop();
    res.json({ ok: true });
  });

  router.get('/api/probe/status', auth, (_req, res) => {
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

  router.get('/api/probe/alerts', auth, (_req, res) => {
    res.json({ alerts: probeState.alerts(), stateLabels: PROBE_STATE_LABELS, generatedAt: new Date().toISOString() });
  });

  router.get('/api/probe/states', auth, (_req, res) => {
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

  router.get('/api/probe/runs', auth, (_req, res) => {
    res.json({
      runs: probeState.data.runs.map(({ results, ...summary }) => ({ ...summary, resultCount: results.length })),
    });
  });

  router.get('/api/probe/runs/:runId', auth, (req, res) => {
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

  router.post('/api/probe/manual/match', auth, (req, res) => {
    const fileNames = [...new Set(Array.isArray(req.body?.fileNames) ? req.body.fileNames.map(String).slice(0, 200) : [])];
    if (!fileNames.length) return res.status(400).json({ error: '请提供文件名列表' });
    const all = probeRunner.allDocuments();
    const results = fileNames.map((fileName) => {
      const candidates = matchDocuments(fileName, all);
      return { fileName, auto: autoAssign(candidates), candidates };
    });
    res.json({ results, catalogSize: all.length });
  });

  router.post('/api/probe/retry', auth, async (req, res) => {
    const outcome = await runSingleProbe(String(req.body?.documentId || ''));
    res.status(outcome.status).json(outcome.body);
  });

  router.post('/api/probe/manual/:documentId/url', auth, async (req, res) => {
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

  router.post('/api/probe/manual/:documentId/status', auth, (req, res) => {
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

  router.post('/api/probe/manual/:documentId/pdf', auth, express.raw({ type: 'application/pdf', limit: '60mb' }), (req, res) => {
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

  router.get('/api/probe/docinfo/:documentId', auth, (req, res) => {
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

  return router;
};
