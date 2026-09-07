'use strict';

// AI 抽取结果缓存（方案 §8.2）：同一彩页（SHA-256 未变）+ 同模型 + 同提示词版本
// 不再重复调用 AI。缓存只省调用，不改变校验与合并语义——命中结果照常走
// mergeParams 与人工确认。文件 data/ai-cache.json，原子写入，容量上限淘汰最旧。
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';
const CACHE_LIMIT = 300;

function cacheFile(dataDir) {
  return path.join(dataDir, 'ai-cache.json');
}

function loadCache(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) return parsed;
  } catch {
    // 文件不存在或损坏：视为空缓存，等价首次运行（可随时重建，不阻断分析）
  }
  return { schemaVersion: SCHEMA_VERSION, entries: {} };
}

function saveCache(dataDir, cache) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = cacheFile(dataDir);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

// targetModel（T05 型号分列）进 key：同一彩页按不同目标型号抽取是独立结果，禁止互相复用
function cacheKey({ documentId, sha256, model, promptRev, targetModel = '' }) {
  return `${documentId}|${sha256}|${model}|${promptRev}|${targetModel}`;
}

// 命中返回参数数组，未命中返回 null。只接受数组形态，异常条目按未命中处理。
function getCached(dataDir, key) {
  const entry = loadCache(dataDir).entries[key];
  if (!entry || !Array.isArray(entry.params) || !entry.cachedAt) return null;
  return entry.params;
}

function putCached(dataDir, key, params) {
  if (!Array.isArray(params) || !params.length) return; // 空结果不缓存：失败重试仍有机会
  const cache = loadCache(dataDir);
  cache.entries[key] = { params, cachedAt: new Date().toISOString() };
  const keys = Object.keys(cache.entries);
  if (keys.length > CACHE_LIMIT) {
    // 淘汰最旧：按 cachedAt 排序删除多余的
    const sorted = keys.sort((a, b) => String(cache.entries[a].cachedAt).localeCompare(String(cache.entries[b].cachedAt)));
    for (const stale of sorted.slice(0, keys.length - CACHE_LIMIT)) delete cache.entries[stale];
  }
  saveCache(dataDir, cache);
}

function dropDocument(dataDir, documentId) {
  const cache = loadCache(dataDir);
  let removed = 0;
  for (const key of Object.keys(cache.entries)) {
    if (key.startsWith(`${documentId}|`)) { delete cache.entries[key]; removed += 1; }
  }
  if (removed) saveCache(dataDir, cache);
  return removed;
}

module.exports = { cacheKey, getCached, putCached, dropDocument, CACHE_LIMIT };
