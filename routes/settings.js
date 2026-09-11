'use strict';

// 运行时设置路由（AI 对接热生效；存储路径重启生效）。
// 从 server.js 原样拆出（逻辑零改动），依赖经 ctx 注入：{ auth }。

const express = require('express');
const settings = require('../lib/settings');

module.exports = function settingsRoutes(ctx) {
  const { auth } = ctx;
  const router = express.Router();

  router.get('/api/settings', auth, (_req, res) => {
    const view = settings.publicView({
      base: process.env.NVCI_LITE_AI_BASE || '',
      apiKey: process.env.NVCI_LITE_AI_KEY || '',
      model: process.env.NVCI_LITE_AI_MODEL || '',
      protocol: process.env.NVCI_LITE_AI_PROTOCOL || 'openai',
    });
    const sec = settings.get().security || {};
    view.security = { ...view.security, authMode: sec.passwordHash ? 'settings' : ((process.env.NVCI_LITE_PASSWORD || '') ? 'env' : 'none') };
    res.json(view);
  });

  router.put('/api/settings', auth, (req, res) => {
    try {
      const patch = req.body || {};
      // 修改口令（界面热生效）：校验当前口令 → 哈希落 settings.json → 轮换会话密钥
      if (patch.passwordChange) {
        const { currentPassword, newPassword } = patch.passwordChange;
        if (ctx.authRequired() && !ctx.passwordMatches(currentPassword)) {
          return res.status(400).json({ error: '当前口令不正确' });
        }
        const next = String(newPassword || '');
        if (next && next.length < 8) {
          return res.status(400).json({ error: '新口令至少 8 位；留空表示清除口令（恢复免登录或环境变量）' });
        }
        if (next) settings.setPassword(next);
        else settings.clearPassword();
        ctx.rotateSessions(); // 全部会话立即失效，含本次操作者——需用新口令重登
      }
      const rest = { ...patch };
      delete rest.passwordChange;
      const hasRest = Object.keys(rest).length > 0;
      if (hasRest) settings.update(rest);
      const view = settings.publicView({
        base: process.env.NVCI_LITE_AI_BASE || '',
        apiKey: process.env.NVCI_LITE_AI_KEY || '',
        model: process.env.NVCI_LITE_AI_MODEL || '',
        protocol: process.env.NVCI_LITE_AI_PROTOCOL || 'openai',
      });
      const sec = settings.get().security || {};
      view.security = { ...view.security, authMode: sec.passwordHash ? 'settings' : ((process.env.NVCI_LITE_PASSWORD || '') ? 'env' : 'none') };
      res.json({ ok: true, settings: view, passwordChanged: Boolean(patch.passwordChange) });
    } catch (error) {
      res.status(500).json({ error: `设置保存失败：${String(error.message || error)}` });
    }
  });

  return router;
};
