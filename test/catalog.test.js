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
  // 无线接入与无线管理两条线已登记（原空占位已补齐：OmniAccess AP ×13、OmniVista 网管 ×2）
  const omniaccess = ale.productLines.find((line) => line.category === 'wireless_ap');
  assert.ok(omniaccess && omniaccess.documentCount >= 10, 'OmniAccess 无线 AP 应已登记');
  const stellar = ale.productLines.find((line) => line.category === 'wireless_mgmt');
  assert.ok(stellar && stellar.documentCount >= 2, 'Stellar 网管应已登记');
  const found = findDocuments([omniswitch.documents[0].documentId]);
  assert.equal(found.length, 1);
});

test('findDocuments 忽略未知 ID', () => {
  assert.deepEqual(findDocuments(['not_exist_id']), []);
});

test('Cisco 拆线与品类标注：园区/数据中心/工业三线，documentId 保持稳定', () => {
  const catalog = loadCatalog();
  const cisco = catalog.vendors.find((vendor) => vendor.vendorId === 'cisco');
  assert.equal(cisco.productLines.length, 3, '拆为三条产品线');
  assert.deepEqual(cisco.productLines.map((line) => line.category), ['campus_switch', 'dc_switch', 'industrial']);
  const total = cisco.productLines.reduce((sum, line) => sum + line.documentCount, 0);
  assert.equal(total, 69, '拆线不丢条目');
  const ids = cisco.productLines.flatMap((line) => line.documents.map((doc) => doc.documentId));
  assert.equal(new Set(ids).size, 69, 'documentId 无重复（拆线不换 ID）');
  // 全目录品类字段齐备
  const withoutCategory = catalog.vendors.flatMap((v) => v.productLines).filter((line) => !line.category);
  assert.deepEqual(withoutCategory, [], '所有产品线都有品类');
});

test('品类推断兜底：产品线名关键词映射标准品类', () => {
  const { inferCategory } = require('../lib/catalog');
  assert.equal(inferCategory('01 园区交换机'), 'campus_switch');
  assert.equal(inferCategory('02 数据中心交换机'), 'dc_switch');
  assert.equal(inferCategory('无线接入'), 'wireless_ap');
  assert.equal(inferCategory('路由器'), 'router');
  assert.equal(inferCategory('安全网关'), 'security');
  assert.equal(inferCategory('管理平台'), 'mgmt_platform');
  assert.equal(inferCategory('03 工业交换机'), 'industrial');
  assert.equal(inferCategory('Juniper EX4300 官方资料'), 'other', '无关键词回落 other');
});

test('自定义来源叠加：归入目录并带 custom 标记，冲突条目跳过并警告', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-custom-'));
  // 取内置真实存在的 documentId 制造冲突（内置基准不可覆盖）
  const builtinId = loadCatalog().vendors
    .flatMap((vendor) => vendor.productLines.flatMap((line) => line.documents.map((doc) => doc.documentId)))[0];
  // 一个自定义来源 + 一条与内置冲突的 documentId（vendorId 沿用 juniper：
  // Juniper 已升级内置品牌，验证的是「自定义线叠加到既有厂商」的真实场景）
  fs.writeFileSync(path.join(dir, 'juniper_ex4300.json'), JSON.stringify({
    schemaVersion: '2.2-lite', custom: true,
    profileId: 'juniper_switches_ex4300', vendorId: 'juniper', vendorName: 'Juniper Networks',
    displayName: 'Juniper EX4300 官方资料', officialDomains: ['www.juniper.net'],
    productLine: { id: 'switches', name: '交换机', libraryRootName: 'Juniper产品彩页' },
    subseries: { id: 'ex4300', name: 'EX4300' },
    sources: [
      { documentId: 'juniper_ex4300_1', series: 'EX4300', modelNames: ['EX4300-24T', 'EX4300-48T'], pdfUrl: 'https://www.juniper.net/a.pdf', officialFileName: 'a.pdf' },
      { documentId: builtinId, series: '冲突', modelNames: ['X'], pdfUrl: 'https://www.juniper.net/b.pdf', officialFileName: 'b.pdf' },
    ],
  }), 'utf8');
  const catalog = loadCatalog(undefined, dir);
  const juniper = catalog.vendors.find((vendor) => vendor.vendorId === 'juniper');
  assert.ok(juniper, 'juniper 应出现在目录（内置 + 自定义叠加）');
  assert.equal(juniper.vendorName, 'Juniper Networks');
  // 按 profileId 精确定位自定义线（内置线先注册，不能用下标取）
  const line = juniper.productLines.find((item) => item.profileId === 'juniper_switches_ex4300');
  assert.ok(line, '自定义线应叠加在 juniper 厂商下');
  assert.equal(line.custom, true, '自定义产品线带 custom 标记');
  assert.equal(line.documentCount, 1, '冲突条目被跳过，仅 1 条生效');
  assert.ok(catalog.warnings.some((w) => w.includes(builtinId)), '冲突记入 warnings');
  const found = findDocuments(['juniper_ex4300_1'], undefined, dir);
  assert.equal(found.length, 1, '自定义条目可被采集检索');
  fs.rmSync(dir, { recursive: true, force: true });
});
