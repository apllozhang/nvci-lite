'use strict';

const { safeFetch, readResponseBuffer } = require('./downloader');
const { USER_AGENT } = require('./downloader');

// 产品页参数采集：静态抓取尽力而为。JS 动态渲染页拿不到正文时明确标注原因，
// 不引入浏览器，不影响 PDF 主流程。
const MAX_PAGE_BYTES = 3145728; // 3MB
const PAGE_TIMEOUT_MS = 20000;

function htmlToMarkdown(html) {
  const TurndownService = require('turndown');
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer']);
  return turndown.turndown(html);
}

function looksLikeEmptyShell(markdown, html) {
  const text = String(markdown).replace(/[#*`\-\s>|]/g, '');
  if (text.length < 200) return true;
  const appRootCount = (html.match(/<div\s+id=["']?(app|root|__next)["']?/gi) || []).length;
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  return appRootCount > 0 && scriptCount >= 5 && text.length < 800;
}

async function fetchPageMarkdown({ document, fetchImpl = fetch }) {
  if (!document.productPageUrl) {
    return { status: 'skipped', reason: '该条资料未登记产品页网址', markdown: '' };
  }
  const context = { officialDomains: document.officialDomains, trustedRedirectDomains: document.trustedRedirectDomains };
  try {
    const result = await safeFetch(document.productPageUrl, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    }, context, fetchImpl, PAGE_TIMEOUT_MS);
    if (!result.response.ok) {
      return { status: 'failed', reason: `产品页 HTTP ${result.response.status}`, markdown: '' };
    }
    const contentType = result.response.headers.get('content-type') || '';
    if (contentType && !contentType.includes('html')) {
      return { status: 'skipped', reason: `产品页返回类型 ${contentType}，非 HTML`, markdown: '' };
    }
    const buffer = await readResponseBuffer(result.response, MAX_PAGE_BYTES, PAGE_TIMEOUT_MS);
    const html = buffer.toString('utf8');
    const markdown = htmlToMarkdown(html);
    if (looksLikeEmptyShell(markdown, html)) {
      return { status: 'partial', reason: '产品页为脚本动态渲染，静态抓取仅得到页面骨架；参数请以 PDF 彩页为准', markdown: markdown.slice(0, 4000), finalUrl: result.finalUrl };
    }
    return { status: 'ok', reason: '', markdown, finalUrl: result.finalUrl };
  } catch (error) {
    return { status: 'failed', reason: String(error.message || error), markdown: '' };
  }
}

module.exports = { fetchPageMarkdown, htmlToMarkdown };
