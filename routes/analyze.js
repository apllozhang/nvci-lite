'use strict';

// 对比分析路由：分析流水线（规则/型号分列/视觉兜底 → 矩阵 → 确认 → 门槛 → 导出）
// 与导出物下载。从 server.js 原样拆出（逻辑零改动），
// 依赖经 ctx 注入：{ auth, store, DATA_DIR, MAX_MODEL_COLUMNS }。

const express = require('express');
const fs = require('fs');
const path = require('path');
const { extractPdfText } = require('../lib/pdf-text');
const { extractParamsByRules, buildMatrix, buildModelColumnParams, mergeParams } = require('../lib/params');
const ai = require('../lib/ai');
const { buildExcel, buildWordDocx, buildMaterialPack } = require('../lib/report');
const vision = require('../lib/vision');
const confirm = require('../lib/confirm');
const aiCache = require('../lib/ai-cache');
const thresholds = require('../lib/thresholds');

module.exports = function analyzeRoutes(ctx) {
  const { auth, store, DATA_DIR, MAX_MODEL_COLUMNS } = ctx;
  const router = express.Router();

  async function loadExtraction(entry) {
    const buffer = store.readPdf(entry.sha256);
    const extraction = await extractPdfText(buffer);
    return extraction;
  }

  router.post('/api/analyze', auth, async (req, res) => {
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

  router.get('/api/exports', auth, (_req, res) => {
    res.json({ exports: store.listExports() });
  });

  router.get('/api/exports/:fileName', auth, (req, res) => {
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

  return router;
};
