'use strict';

// 采集路由：批量采集彩页（含产品页 Markdown）与已采集资料库查询。
// 从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth, store, MAX_COLLECT }。

const express = require('express');
const { findDocuments, loadCatalog } = require('../lib/catalog');
const { collectDocument } = require('../lib/downloader');
const { fetchPageMarkdown } = require('../lib/page-markdown');

module.exports = function collectRoutes(ctx) {
  const { auth, store, MAX_COLLECT } = ctx;
  const router = express.Router();

  router.post('/api/collect', auth, async (req, res) => {
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
    for (const row of results) {
      require('../lib/metrics').inc('nvci_collect_documents_total', { result: row.status || 'unknown' });
    }
    res.json({
      total: results.length,
      completed: results.filter((row) => row.status === 'completed').length,
      failed: results.filter((row) => row.status === 'failed').length,
      unknown,
      results,
    });
  });

  router.get('/api/library', auth, (req, res) => {
    // 品类联表（第 3 步品类化分组）：采集索引没有品类概念，按 documentId 从目录补齐
    const catByDoc = new Map();
    for (const vendor of loadCatalog().vendors) {
      for (const line of vendor.productLines) {
        for (const doc of line.documents) {
          catByDoc.set(doc.documentId, { category: line.category, productLineName: line.productLineName });
        }
      }
    }
    res.json({
      documents: store.library().map((doc) => ({
        ...doc,
        category: catByDoc.get(doc.documentId)?.category || 'other',
        productLineName: doc.productLineName || catByDoc.get(doc.documentId)?.productLineName || '',
      })),
    });
  });

  return router;
};
