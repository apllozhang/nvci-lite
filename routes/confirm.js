'use strict';

// 人工核对确认路由。从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth, DATA_DIR }。

const express = require('express');
const confirm = require('../lib/confirm');

module.exports = function confirmRoutes(ctx) {
  const { auth, DATA_DIR } = ctx;
  const router = express.Router();

  router.get('/api/confirmations', auth, (_req, res) => {
    res.json({ confirmations: confirm.loadConfirmations(DATA_DIR) });
  });

  router.post('/api/confirmations', auth, (req, res) => {
    const input = req.body || {};
    const documentId = String(input.documentId || '');
    const entry = ctx.store.library().find((item) => item.documentId === documentId);
    if (!entry) return res.status(400).json({ error: '该资料尚未采集，无法保存确认' });
    try {
      const record = confirm.upsertConfirmation(DATA_DIR, {
        documentId,
        paramKey: input.paramKey,
        value: input.value,
        model: input.model,
        note: input.note,
        docSha256: entry.sha256,
      });
      res.json({ ok: true, confirmation: record });
    } catch (error) {
      res.status(400).json({ error: `确认保存失败：${String(error.message || error)}` });
    }
  });

  router.delete('/api/confirmations', auth, (req, res) => {
    // model 参与确认键（T05）：同彩页不同型号的确认互不干扰；旧客户端不传 model 视为系列级
    const removed = confirm.removeConfirmation(DATA_DIR, String(req.query.documentId || ''), String(req.query.paramKey || ''), String(req.query.model || ''));
    res.json({ ok: removed });
  });

  return router;
};
