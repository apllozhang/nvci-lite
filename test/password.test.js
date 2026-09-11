'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassword, verifyPassword } = require('../lib/password');
const settings = require('../lib/settings');

test('password：哈希/校验往返，错口令与被篡改盐都拒绝', () => {
  const { passwordHash, passwordSalt } = hashPassword('Nvci@Lite2026');
  assert.notEqual(passwordHash, 'Nvci@Lite2026', '不落明文');
  assert.equal(verifyPassword('Nvci@Lite2026', passwordHash, passwordSalt), true);
  assert.equal(verifyPassword('wrong', passwordHash, passwordSalt), false);
  assert.equal(verifyPassword('Nvci@Lite2026', passwordHash, '00'.repeat(16)), false, '盐被篡改拒绝');
  assert.equal(verifyPassword('', '', ''), false, '空哈希拒绝');
  // 同口令两次哈希盐不同（防彩虹表）
  const again = hashPassword('Nvci@Lite2026');
  assert.notEqual(again.passwordSalt, passwordSalt);
});

test('settings：security 段落盘与读取，setPassword/clearPassword 热生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-setpass-'));
  settings.init(dir);
  assert.equal(settings.get().security.passwordHash, '', '默认无口令哈希');
  settings.setPassword('Nvci@Lite2026');
  assert.ok(settings.get().security.passwordHash.length > 0);
  assert.equal(settings.publicView({}).security.passwordSet, true);
  // 落盘后再初始化（模拟重启）仍生效
  settings.init(dir);
  assert.equal(settings.get().security.passwordHash.length > 0, true);
  // update 只接受哈希字段：明文口令不落设置
  settings.update({ security: { passwordHash: 'x', passwordSalt: 'y', plaintext: 'leak' } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.security.plaintext, undefined, '未知字段不落盘');
  settings.clearPassword();
  assert.equal(settings.get().security.passwordHash, '');
  fs.rmSync(dir, { recursive: true, force: true });
});
