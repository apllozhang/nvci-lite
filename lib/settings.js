'use strict';

// 运行时设置：data/settings.json，PUT 后热更新内存缓存。
// AI 对接配置优先级：settings > 环境变量；存储路径设置重启后生效（容器卷边界）。

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  storage: { pdfSubdir: '' },
  ai: { protocol: '', baseUrl: '', model: '', visionModel: '', apiKey: '' },
};

let cache = null;
let filePath = '';

function init(dataDir) {
  filePath = path.join(dataDir, 'settings.json');
  reload();
}

function reload() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = {
      storage: { ...DEFAULTS.storage, ...(parsed.storage || {}) },
      ai: { ...DEFAULTS.ai, ...(parsed.ai || {}) },
    };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function get() {
  if (!cache) reload();
  return cache;
}

function update(patch) {
  const next = get();
  if (patch && typeof patch === 'object') {
    if (patch.storage && typeof patch.storage === 'object') next.storage = { ...next.storage, ...patch.storage };
    if (patch.ai && typeof patch.ai === 'object') {
      // 空串视为"沿用环境变量"，不覆盖已有值
      for (const [key, value] of Object.entries(patch.ai)) {
        if (typeof value === 'string' && value.trim() !== '') next.ai[key] = value.trim();
      }
    }
  }
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
  cache = next;
  return next;
}

// API Key 永不回传明文：只返回是否已配置（settings 或 env）
function aiMerged(envConfig) {
  const settings = get().ai;
  return {
    protocol: settings.protocol || envConfig.protocol,
    base: settings.baseUrl || envConfig.base,
    model: settings.model || envConfig.model,
    apiKey: settings.apiKey || envConfig.apiKey,
  };
}

function publicView(envConfig) {
  const settings = get();
  const merged = aiMerged(envConfig);
  return {
    storage: { pdfSubdir: settings.storage.pdfSubdir, dataDir: path.dirname(filePath) },
    ai: {
      protocol: merged.protocol,
      baseUrl: merged.base,
      model: merged.model,
      visionModel: settings.ai.visionModel || '',
      apiKeyConfigured: Boolean(merged.apiKey),
      apiKeySource: settings.ai.apiKey ? 'settings' : (envConfig.apiKey ? 'env' : ''),
    },
  };
}

module.exports = { aiMerged, get, init, publicView, update };
