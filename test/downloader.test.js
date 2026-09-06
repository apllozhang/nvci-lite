'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectDocument, inspectPdf, assertAllowedUrl, hashBuffer } = require('../lib/downloader');
const { Store } = require('../lib/store');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-lite-')); }

const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n');

function makeResponse(status, headers, buffer) {
  const headerMap = new Map(Object.entries(headers));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? '' },
    body: null,
    arrayBuffer: async () => {
      if (!buffer) return new ArrayBuffer(0);
      // Buffer 可能共享底层内存池，必须按 byteOffset/byteLength 切片
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function makeFetch({ pdf = MINIMAL_PDF, status = 200, headers = {} } = {}) {
  const defaultHeaders = { 'content-type': 'application/pdf', etag: '"v1"', 'content-length': String(pdf.length), ...headers };
  return async (_url, options = {}) => {
    if ((options.method || 'GET') === 'HEAD') return makeResponse(status, defaultHeaders, null);
    return makeResponse(status, defaultHeaders, pdf);
  };
}

function makeDocument(overrides = {}) {
  return {
    documentId: 'huawei_test_01',
    vendorName: '华为',
    series: 'CloudEngine S5731-S',
    modelNames: ['S5731-S24P4X'],
    pdfUrl: 'https://e.huawei.com/marketingcloud/test.pdf',
    productPageUrl: 'https://e.huawei.com/cn/products/switches/s5731-s',
    officialFileName: '华为 CloudEngine S5731-S 彩页.pdf',
    expectedSha256: hashBuffer(MINIMAL_PDF),
    officialDomains: ['e.huawei.com'],
    trustedRedirectDomains: [],
    ...overrides,
  };
}

test('assertAllowedUrl：HTTPS + 官方域名白名单', () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://e.huawei.com/a.pdf', { officialDomains: ['e.huawei.com'] }));
  assert.throws(() => assertAllowedUrl('http://e.huawei.com/a.pdf', { officialDomains: ['e.huawei.com'] }), /HTTPS/);
  assert.throws(() => assertAllowedUrl('https://evil.com/a.pdf', { officialDomains: ['e.huawei.com'] }), /白名单/);
  assert.throws(() => assertAllowedUrl('https://mirror.com/a.pdf', { officialDomains: ['e.huawei.com'], trustedRedirectDomains: [] }, true), /白名单/);
  assert.doesNotThrow(() => assertAllowedUrl('https://mirror.com/a.pdf', { officialDomains: ['e.huawei.com'], trustedRedirectDomains: ['mirror.com'] }, true));
});

test('inspectPdf：签名、页数检查', () => {
  const inspection = inspectPdf(MINIMAL_PDF);
  assert.equal(inspection.pageCount, 1);
  assert.throws(() => inspectPdf(Buffer.from('not a pdf at all %%EOF')), /签名/);
  assert.throws(() => inspectPdf(Buffer.from('%PDF-1.4 no eof marker')), /结束标记/);
});

test('collectDocument：成功下载、入缓存、索引更新、SHA-256 基线一致', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const row = await collectDocument({ document: makeDocument(), store, fetchImpl: makeFetch() });
    assert.equal(row.status, 'completed');
    assert.equal(row.decision, 'downloaded');
    assert.equal(row.sha256, hashBuffer(MINIMAL_PDF));
    assert.equal(row.warning, '');
    assert.ok(store.pdfExists(row.sha256));
    const entry = store.getIndexEntry('huawei_test_01');
    assert.equal(entry.sha256, row.sha256);
    assert.equal(entry.status, 'completed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectDocument：元数据未变时复用缓存，不重复下载', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const first = await collectDocument({ document: makeDocument(), store, fetchImpl: makeFetch() });
    let getCount = 0;
    const countingFetch = async (url, options = {}) => {
      if ((options.method || 'GET') === 'GET') getCount += 1;
      return makeFetch()(url, options);
    };
    const second = await collectDocument({ document: makeDocument(), store, fetchImpl: countingFetch });
    assert.equal(second.decision, 'reuse_unchanged');
    assert.equal(second.sha256, first.sha256);
    assert.equal(getCount, 0, '复用时不应发起 GET 下载');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectDocument：基线哈希不一致时给 warning 但不阻断', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const row = await collectDocument({
      document: makeDocument({ expectedSha256: 'a'.repeat(64) }),
      store,
      fetchImpl: makeFetch(),
    });
    assert.equal(row.status, 'completed');
    assert.match(row.warning, /SHA-256 与基线不一致/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectDocument：非 PDF 响应被门禁拦截', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const row = await collectDocument({
      document: makeDocument(),
      store,
      fetchImpl: makeFetch({ pdf: Buffer.from('<html>hello</html>'), headers: { 'content-type': 'text/html' } }),
    });
    assert.equal(row.status, 'failed');
    assert.equal(row.decision, 'non_pdf_response');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectDocument：白名单外域名直接失败', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const row = await collectDocument({
      document: makeDocument({ pdfUrl: 'https://other-vendor.com/x.pdf' }),
      store,
      fetchImpl: makeFetch(),
    });
    assert.equal(row.status, 'failed');
    assert.equal(row.decision, 'needs_route_validation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
