'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../lib/login-guard');

test('登录失败限制：连续失败达上限后锁定，窗口过期自动解锁', () => {
  guard.reset();
  const now = 1_000_000;
  const ip = '10.0.0.1';
  for (let i = 0; i < guard.MAX_FAILURES - 1; i += 1) {
    guard.recordFailure(ip, now);
    assert.equal(guard.check(ip, now).allowed, true, `第 ${i + 1} 次失败尚未锁定`);
  }
  guard.recordFailure(ip, now);
  assert.equal(guard.check(ip, now).allowed, false, '达到上限后锁定');
  assert.ok(guard.check(ip, now).retryAfterSec > 0, '锁定返回剩余秒数');
  // 窗口过期：解锁且计数清零
  const later = now + guard.WINDOW_MS + 1;
  assert.equal(guard.check(ip, later).allowed, true, '窗口过期后解锁');
  assert.equal(guard.check(ip, later).retryAfterSec, undefined, '解锁后无剩余时间');
});

test('登录失败限制：成功登录清零计数；不同 IP 互不影响', () => {
  guard.reset();
  const now = 2_000_000;
  guard.recordFailure('ip-a', now);
  guard.recordFailure('ip-a', now);
  guard.recordSuccess('ip-a');
  assert.equal(guard.check('ip-a', now).allowed, true, '成功后清零');
  // ip-b 独立计数：失败 9 次不锁定，ip-a 不受影响
  for (let i = 0; i < 9; i += 1) guard.recordFailure('ip-b', now);
  assert.equal(guard.check('ip-b', now).allowed, true);
  assert.equal(guard.check('ip-a', now).allowed, true);
  guard.recordFailure('ip-b', now);
  assert.equal(guard.check('ip-b', now).allowed, false, 'ip-b 达上限锁定');
  assert.equal(guard.check('ip-a', now).allowed, true, 'ip-a 不被连带');
});

test('登录失败限制：锁定期间继续失败不延长窗口外语义（固定窗口语义）', () => {
  guard.reset();
  const now = 3_000_000;
  for (let i = 0; i < guard.MAX_FAILURES + 5; i += 1) guard.recordFailure('ip-c', now);
  assert.equal(guard.check('ip-c', now).allowed, false);
  const beforeUnlock = now + Math.floor(guard.WINDOW_MS / 2);
  assert.equal(guard.check('ip-c', beforeUnlock).allowed, false, '窗口中段仍锁定');
});
