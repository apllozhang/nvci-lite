'use strict';

// 访问口令哈希：scrypt + 随机盐，定时安全比较。settings.json 只存哈希不存明文，
// 备份 bundle 随 settings.json 带走的是不可逆哈希（评审 R5 的脱敏规则不受影响）。

const crypto = require('crypto');

function hashPassword(plain) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(String(plain), passwordSalt, 32).toString('hex');
  return { passwordHash, passwordSalt };
}

function verifyPassword(plain, passwordHash, passwordSalt) {
  if (!passwordHash || !passwordSalt) return false;
  try {
    const candidate = crypto.scryptSync(String(plain || ''), String(passwordSalt), 32);
    const stored = Buffer.from(String(passwordHash), 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
