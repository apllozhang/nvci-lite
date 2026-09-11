'use strict';

// 目录与元数据路由：品牌目录（公开）、字段字典、AI 状态（公开）。
// 从 server.js 原样拆出（逻辑零改动）。

const express = require('express');
const { loadCatalog } = require('../lib/catalog');
const ai = require('../lib/ai');
const { FIELD_TEMPLATE } = require('../lib/params');

module.exports = function catalogRoutes(ctx) {
  const { auth } = ctx;
  const router = express.Router();

  router.get('/api/catalog', (_req, res) => {
    res.json(loadCatalog());
  });

  // 固定字段字典：第 4 步门槛编辑器的字段下拉来源（方案 §5.1）
  router.get('/api/field-template', auth, (_req, res) => {
    res.json({ fields: FIELD_TEMPLATE.map(({ key, label, group }) => ({ key, label, group })) });
  });

  router.get('/api/ai-status', (_req, res) => {
    const config = ai.aiConfig();
    res.json({ configured: config.configured, model: config.configured ? config.model : '', mode: config.configured ? 'auto' : 'material_pack' });
  });

  return router;
};
