'use strict';

// 自定义厂商/产品线来源校验（方法论文档：NVCI 完整版 SOURCE_CONFIGURATION_GUIDE.md）。
// 颗粒度：品牌 → 产品线 → 子系列 → 资料条目；一条条目可覆盖多个型号（同份官方
// Data sheet 覆盖 24/48 口 SKU 时应登记在同一条目，不为同一 PDF 建多条）。
// 硬约束与完整版一致：仅公开官方 HTTPS 域名白名单、资料条目 1–50、覆盖型号必填。
// 返回 { profile, errors } 而非 throw：API 层把 errors 原样带给前端逐项修正。

function safeId(value, label) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) {
    return { error: `${label}只能使用 2–64 位小写字母、数字、下划线或连字符（当前：${String(value || '').slice(0, 40) || '空'}）` };
  }
  return { value: normalized };
}

function text(value, label, min, max) {
  const normalized = String(value || '').trim();
  if (normalized.length < min || normalized.length > max) {
    return { error: `${label}长度必须为 ${min}–${max} 个字符` };
  }
  return { value: normalized };
}

function splitList(value) {
  return [...new Set(String(value || '').split(/[\n,;；，、]/).map((item) => item.trim()).filter(Boolean))];
}

function normalizeDomains(value, label, { required = true, max = 20 } = {}) {
  const items = splitList(Array.isArray(value) ? value.join(',') : value);
  if (!items.length) return required ? { error: `${label}至少填写 1 个主机名（只填域名，不带 https:// 和路径）` } : { value: [] };
  if (items.length > max) return { error: `${label}最多 ${max} 个` };
  const domains = [];
  for (const raw of items) {
    const domain = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')) {
      return { error: `${label}无效：${domain}` };
    }
    domains.push(domain);
  }
  return { value: [...new Set(domains)] };
}

// 完整版方法论：URL 必须 HTTPS 且主机名精确匹配官方域名白名单（信任跳转域名仅
// 允许出现在重定向链路，登记 URL 本身必须在官方域名内）。
function assertOfficialHttps(urlValue, officialDomains, label) {
  let url;
  try { url = new URL(String(urlValue || '')); } catch { return { error: `${label}不是有效 URL` }; }
  if (url.protocol !== 'https:') return { error: `${label}必须使用 HTTPS（当前 ${url.protocol}）` };
  if (!officialDomains.includes(url.hostname.toLowerCase())) {
    return { error: `${label}主机名 ${url.hostname} 不在官方域名白名单` };
  }
  return { value: url.toString() };
}

function slugFrom(value, fallback) {
  const ascii = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return safeId(ascii || fallback, '标识').value;
}

// raw: 表单/API 提交的对象。errors 非空时 profile 为 null。
function normalizeCustomProfile(raw) {
  const errors = [];
  const input = raw || {};

  const vendorId = safeId(input.vendorId, '品牌标识');
  if (vendorId.error) errors.push(vendorId.error);
  const vendorName = text(input.vendorName, '品牌名称', 1, 80);
  if (vendorName.error) errors.push(vendorName.error);
  const lineName = text(input.productLineName, '产品线名称', 1, 80);
  if (lineName.error) errors.push(lineName.error);
  const subName = text(input.subseriesName, '子系列名称', 1, 120);
  if (subName.error) errors.push(subName.error);

  const officialDomains = normalizeDomains(input.officialDomains, '官方域名白名单');
  if (officialDomains.error) errors.push(officialDomains.error);
  const trustedRedirectDomains = normalizeDomains(input.trustedRedirectDomains, '信任跳转域名', { required: false });
  if (trustedRedirectDomains.error) errors.push(trustedRedirectDomains.error);

  const rawSources = Array.isArray(input.sources) ? input.sources : [];
  if (!rawSources.length || rawSources.length > 50) {
    errors.push('资料条目必须为 1–50 条');
  }

  const domains = officialDomains.value || [];
  const sources = [];
  const seenDocumentIds = new Set();
  const seenPdfUrls = new Set();
  if (!errors.length || rawSources.length) {
    rawSources.forEach((rawSource, index) => {
      const at = `第 ${index + 1} 条资料`;
      const source = { };

      const modelNames = splitList(Array.isArray(rawSource.modelNames) ? rawSource.modelNames.join(',') : rawSource.modelNames);
      if (!modelNames.length) errors.push(`${at}：覆盖型号必填（同一彩页覆盖多个型号时全部填入，逗号分隔）`);
      else if (modelNames.length > 100) errors.push(`${at}：覆盖型号最多 100 个`);
      source.modelNames = modelNames;

      const series = text(rawSource.series || subName.value, `${at}子系列`, 1, 120);
      if (series.error) errors.push(`${at}：${series.error}`);
      source.series = series.value || '';

      const pdfUrl = assertOfficialHttps(rawSource.pdfUrl, domains, `${at} PDF URL`);
      if (pdfUrl.error) errors.push(`${at}：${pdfUrl.error}`);
      else {
        source.pdfUrl = pdfUrl.value;
        if (seenPdfUrls.has(pdfUrl.value)) errors.push(`${at}：PDF URL 与其他条目重复（同一份彩页的多型号应登记在同一条目）`);
        seenPdfUrls.add(pdfUrl.value);
      }

      if (rawSource.productPageUrl) {
        const page = assertOfficialHttps(rawSource.productPageUrl, domains, `${at}产品页 URL`);
        if (page.error) errors.push(`${at}：${page.error}`);
        source.productPageUrl = page.value || '';
      } else source.productPageUrl = '';

      source.materialPageUrl = '';
      let fileName = String(rawSource.officialFileName || '').trim().replace(/[\\/\0]/g, '_');
      if (!fileName || fileName === '.' || fileName === '..') fileName = `${slugFrom(series.value, `series_${index + 1}`)}.pdf`;
      if (!fileName.toLowerCase().endsWith('.pdf')) fileName = `${fileName}.pdf`;
      source.officialFileName = fileName;

      // 条目标识可选：留空按子系列自动生成（同一来源内保序唯一）
      const rawDocId = String(rawSource.documentId || '').trim();
      let documentIdValue = '';
      if (rawDocId) {
        const idCheck = safeId(rawDocId, `${at}资料条目标识`);
        if (idCheck.error) errors.push(`${at}：${idCheck.error}`);
        else documentIdValue = idCheck.value;
      } else {
        documentIdValue = safeId(slugFrom(series.value, `doc_${index + 1}`) + `_${index + 1}`, `${at}资料条目标识`).value;
      }
      if (documentIdValue) {
        if (seenDocumentIds.has(documentIdValue)) errors.push(`${at}：资料条目标识 ${documentIdValue} 重复`);
        seenDocumentIds.add(documentIdValue);
        source.documentId = documentIdValue;
      }

      source.evidencePolicy = 'official_datasheet';
      source.expectedSha256 = String(rawSource.expectedSha256 || '').trim().slice(0, 128);
      source.description = String(rawSource.description || '').trim().slice(0, 200);
      sources.push(source);
    });
  }

  if (errors.length) return { profile: null, errors };

  const lineId = slugFrom(lineName.value, 'product_line');
  const subId = slugFrom(subName.value, 'subseries');
  const profileId = slugFrom(input.profileId, `${vendorId.value}_${lineId}_${subId}`);
  const idCheck = safeId(profileId, '来源配置标识');
  if (idCheck.error) return { profile: null, errors: [idCheck.error] };

  const now = new Date().toISOString();
  return {
    profile: {
      schemaVersion: '2.2-lite',
      custom: true,
      profileId: idCheck.value,
      vendorId: vendorId.value,
      vendorName: vendorName.value,
      displayName: input.displayName?.trim() || `${vendorName.value} ${subName.value} 官方资料`,
      mode: 'public_official_pdf_incremental',
      officialDomains: domains,
      trustedRedirectDomains: trustedRedirectDomains.value || [],
      sourcePolicy: '仅采集已登记的公开官方 PDF；域名白名单与 HTTPS 为硬约束，样本检查通过后方可长期巡检。',
      productLine: { id: lineId, name: lineName.value, libraryRootName: `${vendorName.value}产品彩页` },
      subseries: { id: subId, name: subName.value },
      sources,
      sampleCheck: input.sampleCheck && typeof input.sampleCheck === 'object' ? input.sampleCheck : null,
      createdAt: input.createdAt || now,
      updatedAt: now,
    },
    errors: [],
  };
}

module.exports = { normalizeCustomProfile };
