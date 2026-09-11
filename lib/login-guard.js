'use strict';

// 登录失败限制（固定窗口）：同一来源 IP 连续失败达到上限后锁定一段时间，
// 成功登录立即清零。纯内存实现（重启即清空）——内网工具防暴力穷举够用，
// 不引入外部存储。进程重启视为窗口重置，属可接受语义。

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const buckets = new Map(); // ip -> { failures, windowStart, lockedUntil }

function bucketFor(ip, now) {
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { failures: 0, windowStart: now, lockedUntil: 0 };
    buckets.set(ip, bucket);
  }
  return bucket;
}

// 顺手清理完全过期的桶，防 Map 无限增长
function sweep(now) {
  for (const [ip, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS && now >= bucket.lockedUntil) buckets.delete(ip);
  }
}

// 返回 { allowed: true } 或 { allowed: false, retryAfterSec }
function check(ip, now = Date.now()) {
  sweep(now);
  const bucket = buckets.get(ip);
  if (bucket && now < bucket.lockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

function recordFailure(ip, now = Date.now()) {
  const bucket = bucketFor(ip, now);
  bucket.failures += 1;
  if (bucket.failures >= MAX_FAILURES) {
    bucket.lockedUntil = now + WINDOW_MS;
  }
}

function recordSuccess(ip) {
  buckets.delete(ip);
}

// 测试与运维用：清空全部状态
function reset() {
  buckets.clear();
}

module.exports = { check, recordFailure, recordSuccess, reset, MAX_FAILURES, WINDOW_MS };
