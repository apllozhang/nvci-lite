'use strict';

// 自定义厂商/产品线来源路由（彩页归档方法论：完整版 SOURCE_CONFIGURATION_GUIDE）。
// 从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth, DATA_DIR }。

const express = require('express');
const fs = require('fs');
const path = require('path');
const profileSchema = require('../lib/profile-schema');
const { safeFetch, USER_AGENT } = require('../lib/downloader');

module.exports = function profileRoutes(ctx) {
  const { auth, DATA_DIR } = ctx;
  const router = express.Router();
  const CUSTOM_PROFILES_DIR = path.join(DATA_DIR, 'custom-profiles');

  function customProfilePath(profileId) {
    // 只允许落在自定义目录内的安全文件名，防路径穿越
    const safe = String(profileId || '').replace(/[^a-z0-9_-]/gi, '');
    if (!safe) return null;
    return path.join(CUSTOM_PROFILES_DIR, `${safe}.json`);
  }

  router.get('/api/profiles', auth, (_req, res) => {
    const profiles = [];
    if (fs.existsSync(CUSTOM_PROFILES_DIR)) {
      for (const name of fs.readdirSync(CUSTOM_PROFILES_DIR).filter((n) => n.endsWith('.json')).sort()) {
        const profile = JSON.parse(fs.readFileSync(path.join(CUSTOM_PROFILES_DIR, name), 'utf8'));
        profiles.push(profile);
      }
    }
    res.json({ profiles });
  });

  router.post('/api/profiles', auth, (req, res) => {
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

  router.delete('/api/profiles/:profileId', auth, (req, res) => {
    const filePath = customProfilePath(req.params.profileId);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '自定义来源不存在' });
    try { fs.unlinkSync(filePath); } catch (error) {
      return res.status(500).json({ error: `删除失败：${String(error.message || error)}` });
    }
    res.json({ ok: true });
  });

  // 样本检查（方法论核心环节）：对已登记的前 5 条 PDF 低频 HEAD 验证——
  // HTTPS 域名白名单、HTTP 状态、Content-Type；不下载文件体。
  router.post('/api/profiles/sample-check', auth, async (req, res) => {
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

  return router;
};
