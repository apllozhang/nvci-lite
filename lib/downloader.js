'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

// Alpine(musl) 的 getaddrinfo 遇到「A 记录正常、AAAA 返回 NXDOMAIN」或超长 CNAME 链
// （如 download.h3c.com 的 trafficmanager GSLB）会整体判 ENOTFOUND（musl 对截断响应不做 TCP 重试），
// 宿主机 glibc 则正常。这里给全局 fetch 换 c-ares resolve4 的 lookup 绕开 musl 缺陷。
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        dns.resolve4(hostname, (err, addresses) => {
          if (err || !addresses || !addresses.length) {
            return callback(err || new Error(`no A record: ${hostname}`));
          }
          // undici autoSelectFamily 时要求地址数组，否则要求 (address, family)
          if (options && options.all) {
            callback(null, addresses.map((address) => ({ address, family: 4 })));
          } else {
            callback(null, addresses[0], 4);
          }
        });
      },
    },
  }));
} catch { /* undici 不可用时退回系统解析 */ }

// 采集方法论精简自 NVCI collector-core.js：官方域名白名单 + HTTPS-only、
// 手动重定向逐跳断言、三层超时、流式字节上限、PDF 签名检查、SHA-256 双校验、
// HEAD 元数据增量比对、原子写。Lite 去掉审批链/快照链，采集即用。
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_DOWNLOAD_HEADER_TIMEOUT_MS = 45000;
const DEFAULT_DOWNLOAD_BODY_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_MAX_PDF_BYTES = 52428800;
const USER_AGENT = 'NVCI-Lite/0.1 (local public-document collector)';

class GateError extends Error {
  constructor(decision, message) { super(message); this.decision = decision; }
}

function hashBuffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function writeBufferAtomic(destination, buffer) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, destination);
}

function nowIso(now = new Date()) { return now.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function assertAllowedUrl(rawUrl, context, allowTrustedRedirect = false) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new GateError('needs_route_validation', `仅允许 HTTPS 来源：${rawUrl}`);
  // 人工修正链接：操作员在界面上显式登记并留痕的新地址，HTTPS 是硬门槛，
  // 白名单可放宽（等同人工批准），但重定向仍走受信域名逐跳断言
  if (context.allowManualUrl) return url;
  const official = context.officialDomains || [];
  const trustedRedirects = context.trustedRedirectDomains || [];
  const allowed = official.includes(url.hostname) || (allowTrustedRedirect && trustedRedirects.includes(url.hostname));
  if (!allowed) throw new GateError('needs_route_validation', `来源域名不在官方域名或受控重定向白名单：${url.hostname}`);
  return url;
}

async function safeFetch(rawUrl, options, context, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let current = assertAllowedUrl(rawUrl, context).toString();
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const upstreamSignal = options.signal;
    const signal = upstreamSignal ? AbortSignal.any([controller.signal, upstreamSignal]) : controller.signal;
    let response;
    try {
      response = await fetchImpl(current, { ...options, signal, redirect: 'manual' });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）：${current}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current, redirectCount };
    const location = response.headers.get('location');
    if (!location) throw new Error(`重定向缺少 Location：${current}`);
    current = assertAllowedUrl(new URL(location, current).toString(), context, true).toString();
  }
  throw new Error(`重定向次数超过限制：${rawUrl}`);
}

async function readResponseBuffer(response, maxBytes = DEFAULT_MAX_PDF_BYTES, timeoutMs = DEFAULT_DOWNLOAD_BODY_IDLE_TIMEOUT_MS) {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      let timer;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`响应体读取超时（${timeoutMs}ms）`)), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) throw new GateError('restricted_excluded', `下载内容超过限制：${total} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    try { await reader.cancel(); } catch { /* best-effort cancellation */ }
    throw error;
  }
}

function headerMetadata(response) {
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
    contentLength: Number(response.headers.get('content-length') || 0),
  };
}

function sameMetadata(previous, current) {
  if (!previous) return false;
  return previous.etag === current.etag
    && previous.lastModified === current.lastModified
    && previous.contentLength === current.contentLength
    && previous.contentType === current.contentType
    && previous.status === current.status;
}

function inspectPdf(buffer) {
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new GateError('non_pdf_response', '下载内容未通过 PDF 文件签名检查');
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  if (!tail.includes('%%EOF')) throw new GateError('parse_failed', 'PDF 缺少结束标记，无法通过基础可读性检查');
  const text = buffer.toString('latin1');
  const pageObjects = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  const pageTreeCount = Number((text.match(/\/Count\s+(\d+)/) || [])[1] || 0);
  const pageCount = pageObjects || pageTreeCount;
  if (pageCount < 1) throw new GateError('parse_failed', 'PDF 未识别到页面对象或页树计数，无法通过基础可读性检查');
  const title = (text.match(/\/Title\s*\(([^)]{1,240})\)/) || [])[1] || '';
  return { pageCount, title };
}

// 单条采集：HEAD 元数据比对 → 未变复用缓存；有变化/无缓存则下载 → 签名检查 →
// SHA-256 入内容寻址缓存；与 bundled 基线 expectedSha256 不一致时标 warning 但不阻断。
async function collectDocument({ document, store, fetchImpl = fetch, force = false }) {
  const context = {
    officialDomains: document.officialDomains,
    trustedRedirectDomains: document.trustedRedirectDomains,
    allowManualUrl: Boolean(document.urlOverride),
  };
  const row = {
    documentId: document.documentId,
    vendorName: document.vendorName,
    series: document.series,
    officialFileName: document.officialFileName,
    sourceUrl: document.pdfUrl,
    startedAt: nowIso(),
  };
  try {
    assertAllowedUrl(document.pdfUrl, context);
    const head = await safeFetch(document.pdfUrl, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } }, context, fetchImpl, DEFAULT_TIMEOUT_MS);
    const metadata = headerMetadata(head.response);
    row.finalUrl = head.finalUrl;
    row.httpStatus = metadata.status;
    Object.assign(row, metadata);
    const headOk = metadata.status >= 200 && metadata.status < 400;
    // 部分 WAF 一律拒绝 HEAD 方法但放行 GET（如锐捷 403），此时跳过元数据比对直接走下载；
    // GET 是同一 URL、同一声明 UA 的正常获取方式，不属于绕过访问控制
    const headRejected = !headOk && (metadata.status === 403 || metadata.status === 405);
    if (!headOk && !headRejected) throw new GateError('source_unavailable', `HTTP 状态异常：${metadata.status}`);
    if (headOk) {
      const declaredType = metadata.contentType.toLowerCase();
      if (declaredType && !declaredType.includes('pdf') && !declaredType.includes('octet-stream')) throw new GateError('non_pdf_response', `Content-Type 不是 PDF：${metadata.contentType}`);
    }

    const index = store.loadIndex();
    const previous = index.documents[document.documentId];
    const cachedPdfExists = previous?.sha256 && store.pdfExists(previous.sha256);
    // index 里 HTTP 状态存为 httpStatus（row.status 是业务状态 completed/failed，两者不能混用）
    const previousMeta = previous && {
      etag: previous.etag || '',
      lastModified: previous.lastModified || '',
      contentLength: previous.contentLength || 0,
      contentType: previous.contentType || '',
      status: previous.httpStatus || 0,
    };
    const reusable = !force && !headRejected && headOk && cachedPdfExists && sameMetadata(previousMeta, metadata);
    if (reusable) {
      row.decision = 'reuse_unchanged';
      row.sha256 = previous.sha256;
      row.pageCount = previous.pageCount || 0;
      row.warning = previous.warning || '';
      row.status = 'completed';
      row.completedAt = nowIso();
      return row;
    }

    const get = await safeFetch(document.pdfUrl, { method: 'GET', headers: { 'User-Agent': USER_AGENT } }, context, fetchImpl, DEFAULT_DOWNLOAD_HEADER_TIMEOUT_MS);
    if (!get.response.ok) throw new Error(`下载 HTTP 状态异常：${get.response.status}`);
    const buffer = await readResponseBuffer(get.response);
    const inspection = inspectPdf(buffer);
    const sha256 = hashBuffer(buffer);
    store.writePdf(sha256, buffer);

    const baselineChanged = Boolean(document.expectedSha256 && document.expectedSha256 !== sha256);
    row.decision = 'downloaded';
    row.sha256 = sha256;
    row.bytes = buffer.length;
    row.pageCount = inspection.pageCount;
    row.pdfTitle = inspection.title;
    row.warning = baselineChanged ? `SHA-256 与基线不一致（厂商可能已更新彩页）：expected=${document.expectedSha256.slice(0, 12)}… actual=${sha256.slice(0, 12)}…` : '';
    row.status = 'completed';
    row.completedAt = nowIso();

    store.upsertIndexEntry({
      ...row,
      httpStatus: metadata.status,
      modelNames: document.modelNames,
      productPageUrl: document.productPageUrl,
      materialPageUrl: document.materialPageUrl,
      productLineName: document.productLineName,
      profileDisplayName: document.profileDisplayName,
      expectedSha256: document.expectedSha256,
      officialDomains: document.officialDomains,
      trustedRedirectDomains: document.trustedRedirectDomains,
      pdfPath: store.pdfRelativePath(sha256),
    });
    return row;
  } catch (error) {
    row.status = 'failed';
    // GateError 自带决策码；其余（超时、连接失败等）按网络异常归类，白名单路径永远走 GateError
    row.decision = error?.decision || 'network_error';
    row.error = String(error.message || error);
    row.completedAt = nowIso();
    return row;
  }
}

module.exports = {
  GateError,
  assertAllowedUrl,
  collectDocument,
  hashBuffer,
  headerMetadata,
  inspectPdf,
  nowIso,
  readResponseBuffer,
  safeFetch,
  sameMetadata,
  writeBufferAtomic,
  DEFAULT_MAX_PDF_BYTES,
  USER_AGENT,
};
