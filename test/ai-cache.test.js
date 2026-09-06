'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiCache = require('../lib/ai-cache');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-aicache-'));
}

test('抽取缓存：put/get 往返，key 含文档哈希与提示词版本', () => {
  const dir = tempDir();
  const key = aiCache.cacheKey({ documentId: 'doc-a', sha256: 'sha1', model: 'glm-5.3-flash', promptRev: 'r3' });
  const params = [{ key: 'switching_capacity', value: '128Gbit/s', quote: 'q', status: 'ok', source: 'ai' }];
  assert.equal(aiCache.getCached(dir, key), null, '未写入前不命中');
  aiCache.putCached(dir, key, params);
  assert.deepEqual(aiCache.getCached(dir, key), params, '写入后命中');
  // 任一维度变化都不命中（彩页更新 / 换模型 / 提示词改版）
  assert.equal(aiCache.getCached(dir, aiCache.cacheKey({ documentId: 'doc-a', sha256: 'sha2', model: 'glm-5.3-flash', promptRev: 'r3' })), null);
  assert.equal(aiCache.getCached(dir, aiCache.cacheKey({ documentId: 'doc-a', sha256: 'sha1', model: 'glm-4.6', promptRev: 'r3' })), null);
  assert.equal(aiCache.getCached(dir, aiCache.cacheKey({ documentId: 'doc-a', sha256: 'sha1', model: 'glm-5.3-flash', promptRev: 'r4' })), null);
});

test('抽取缓存：空结果不缓存（失败重试仍有机会）', () => {
  const dir = tempDir();
  aiCache.putCached(dir, 'k-empty', []);
  assert.equal(aiCache.getCached(dir, 'k-empty'), null);
});

test('抽取缓存：同键覆盖、容量上限淘汰最旧', () => {
  const dir = tempDir();
  aiCache.putCached(dir, 'k1', [{ value: 'v1' }]);
  aiCache.putCached(dir, 'k1', [{ value: 'v2' }]);
  assert.deepEqual(aiCache.getCached(dir, 'k1'), [{ value: 'v2' }], '同键最后一次生效');
  for (let i = 0; i < aiCache.CACHE_LIMIT + 10; i += 1) {
    aiCache.putCached(dir, `bulk-${i}`, [{ value: String(i) }]);
  }
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'ai-cache.json'), 'utf8'));
  assert.equal(Object.keys(cache.entries).length, aiCache.CACHE_LIMIT, '超限淘汰至容量上限');
  assert.equal(aiCache.getCached(dir, 'k1'), null, '最旧的 k1 被淘汰');
  assert.notEqual(aiCache.getCached(dir, `bulk-${aiCache.CACHE_LIMIT + 9}`), null, '最新保留');
});

test('抽取缓存：dropDocument 清理该文档全部版本', () => {
  const dir = tempDir();
  aiCache.putCached(dir, 'doc-a|sha1|m|r3', [{ value: '1' }]);
  aiCache.putCached(dir, 'doc-a|sha2|m|r3', [{ value: '2' }]);
  aiCache.putCached(dir, 'doc-b|sha1|m|r3', [{ value: '3' }]);
  assert.equal(aiCache.dropDocument(dir, 'doc-a'), 2);
  assert.equal(aiCache.getCached(dir, 'doc-a|sha1|m|r3'), null);
  assert.notEqual(aiCache.getCached(dir, 'doc-b|sha1|m|r3'), null, '其他文档不受影响');
});

test('抽取缓存：损坏文件视为空缓存不阻断', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'ai-cache.json'), '{broken', 'utf8');
  assert.equal(aiCache.getCached(dir, 'any'), null);
  aiCache.putCached(dir, 'k', [{ value: 'v' }]);
  assert.deepEqual(aiCache.getCached(dir, 'k'), [{ value: 'v' }]);
});
