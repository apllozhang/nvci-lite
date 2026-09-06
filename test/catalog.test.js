'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalog, findDocuments } = require('../lib/catalog');

test('目录聚合：品牌数与资料条目数与 bundled-profiles 一致', () => {
  const catalog = loadCatalog();
  assert.ok(catalog.vendorCount >= 7, `应至少聚合 7 个品牌，实际 ${catalog.vendorCount}`);
  assert.ok(catalog.documentCount >= 900, `资料条目应达 900+，实际 ${catalog.documentCount}`);
  const vendorIds = catalog.vendors.map((vendor) => vendor.vendorId);
  for (const expected of ['huawei', 'h3c', 'cisco', 'ruijie', 'ale', 'extreme', 'hpe']) {
    assert.ok(vendorIds.includes(expected), `缺少品牌 ${expected}`);
  }
});

test('华为产品线文档携带白名单与 PDF 直链', () => {
  const catalog = loadCatalog();
  const huawei = catalog.vendors.find((vendor) => vendor.vendorId === 'huawei');
  assert.ok(huawei, '应包含华为');
  const doc = huawei.productLines[0].documents[0];
  assert.equal(doc.vendorName, '华为');
  assert.ok(doc.pdfUrl.startsWith('https://'));
  assert.ok(doc.officialDomains.length >= 1, '官方域名白名单不应为空');
  assert.ok(doc.expectedSha256.length === 64 || doc.expectedSha256 === '');
});

test('旧版 schema（ale）兼容：vendorName 有回退、文档可检索', () => {
  const catalog = loadCatalog();
  const ale = catalog.vendors.find((vendor) => vendor.vendorId === 'ale');
  assert.ok(ale, '应包含 ALE');
  assert.equal(ale.vendorName, 'ALE');
  const omniswitch = ale.productLines.find((line) => line.displayName === 'OmniSwitch 彩页');
  assert.ok(omniswitch && omniswitch.documents.length === 15, 'ALE OmniSwitch 应有 15 条资料');
  // 占位产品线（待登记）应可见但无资料
  const placeholder = ale.productLines.find((line) => line.documentCount === 0);
  assert.ok(placeholder, '应包含待登记占位产品线');
  const found = findDocuments([omniswitch.documents[0].documentId]);
  assert.equal(found.length, 1);
});

test('findDocuments 忽略未知 ID', () => {
  assert.deepEqual(findDocuments(['not_exist_id']), []);
});
