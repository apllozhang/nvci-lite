'use strict';

// 采集路由：批量采集彩页（含产品页 Markdown）与已采集资料库查询。
// 从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth, store, MAX_COLLECT }。

const express = require('express');
const { findDocuments } = require('../lib/catalog');
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
    res.json({
      total: results.length,
      completed: results.filter((row) => row.status === 'completed').length,
      failed: results.filter((row) => row.status === 'failed').length,
      unknown,
      results,
    });
  });

  router.get('/api/library', auth, (req, res) => {
    res.json({ documents: store.library() });
  });

  return router;
};
