'use strict';

// 运行时设置路由（AI 对接热生效；存储路径重启生效）。
// 从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth }。

const express = require('express');
const settings = require('../lib/settings');

module.exports = function settingsRoutes(ctx) {
  const { auth } = ctx;
  const router = express.Router();

  router.get('/api/settings', auth, (_req, res) => {
    res.json(settings.publicView({
      base: process.env.NVCI_LITE_AI_BASE || '',
      apiKey: process.env.NVCI_LITE_AI_KEY || '',
      model: process.env.NVCI_LITE_AI_MODEL || '',
      protocol: process.env.NVCI_LITE_AI_PROTOCOL || 'openai',
    }));
  });

  router.put('/api/settings', auth, (req, res) => {
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

  return router;
};
