'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCustomProfile } = require('../lib/profile-schema');

function validInput(overrides = {}) {
  return {
    vendorId: 'juniper',
    vendorName: 'Juniper Networks',
    productLineName: '交换机',
    subseriesName: 'EX4300',
    officialDomains: 'www.juniper.net, juniper.net',
    sources: [
      { modelNames: 'EX4300-24T, EX4300-48T', pdfUrl: 'https://www.juniper.net/docs/ex4300.pdf', officialFileName: 'ex4300-datasheet' },
    ],
    ...overrides,
  };
}

test('合法来源：生成完整 profile，文件名补 .pdf，标识自动生成', () => {
  const { profile, errors } = normalizeCustomProfile(validInput());
  assert.deepEqual(errors, []);
  assert.equal(profile.vendorId, 'juniper');
  assert.ok(Array.isArray(profile.officialDomains) && profile.officialDomains.includes('juniper.net'));
  assert.equal(profile.sources[0].officialFileName, 'ex4300-datasheet.pdf', '文件名自动补 .pdf');
  assert.equal(profile.sources[0].modelNames.length, 2, '逗号分隔型号拆为数组');
  assert.match(profile.profileId, /^juniper_/);
  assert.equal(profile.custom, true);
  assert.equal(profile.sources[0].documentId.length > 0, true, '条目标识自动生成');
});

test('域名白名单违规：PDF 主机不在白名单被拒绝', () => {
  const { profile, errors } = normalizeCustomProfile(validInput({
    sources: [{ modelNames: 'EX4300-24T', pdfUrl: 'https://mirror.example.com/ex4300.pdf' }],
  }));
  assert.equal(profile, null);
  assert.ok(errors.some((line) => line.includes('不在官方域名白名单')));
});

test('HTTP 明文被拒绝：仅允许 HTTPS', () => {
  const { errors } = normalizeCustomProfile(validInput({
    sources: [{ modelNames: 'EX4300-24T', pdfUrl: 'http://www.juniper.net/ex4300.pdf' }],
  }));
  assert.ok(errors.some((line) => line.includes('必须使用 HTTPS')));
});

test('覆盖型号必填：缺型号的条目被拒绝（方法论：型号归属是登记核心）', () => {
  const { errors } = normalizeCustomProfile(validInput({
    sources: [{ modelNames: '  ', pdfUrl: 'https://www.juniper.net/docs/ex4300.pdf' }],
  }));
  assert.ok(errors.some((line) => line.includes('覆盖型号必填')));
});

test('同一 PDF 重复登记被拒绝：多型号应并入同一条目', () => {
  const { errors } = normalizeCustomProfile(validInput({
    sources: [
      { modelNames: 'EX4300-24T', pdfUrl: 'https://www.juniper.net/docs/ex4300.pdf' },
      { modelNames: 'EX4300-48T', pdfUrl: 'https://www.juniper.net/docs/ex4300.pdf' },
    ],
  }));
  assert.ok(errors.some((line) => line.includes('PDF URL 与其他条目重复')));
});

test('品牌标识归一化：非法字符替换为下划线，纯非拉丁字符报错；域名带协议自动剥离', () => {
  const normalized = normalizeCustomProfile(validInput({ vendorId: 'Ju Niper!' }));
  assert.deepEqual(normalized.errors, [], '带空格与感叹号的标识归一为 ju_niper 后合法');
  assert.equal(normalized.profile.vendorId, 'ju_niper');
  const nonLatin = normalizeCustomProfile(validInput({ vendorId: '中兴通讯' }));
  assert.ok(nonLatin.errors.length > 0, '纯中文标识无法归一为合法 id，应报错');
  const domainsWithProto = normalizeCustomProfile(validInput({
    officialDomains: 'https://www.juniper.net/path, juniper.net',
    sources: [{ modelNames: 'EX4300-24T', pdfUrl: 'https://www.juniper.net/ex4300.pdf' }],
  }));
  assert.deepEqual(domainsWithProto.errors, [], '域名输入允许带协议与路径，剥离开后校验');
  assert.ok(domainsWithProto.profile.officialDomains.includes('www.juniper.net'));
});

test('空条目与超长输入被拒绝', () => {
  const empty = normalizeCustomProfile(validInput({ sources: [] }));
  assert.ok(empty.errors.some((line) => line.includes('1–50 条')));
  const noDomains = normalizeCustomProfile(validInput({ officialDomains: '' }));
  assert.ok(noDomains.errors.some((line) => line.includes('官方域名白名单')));
});
