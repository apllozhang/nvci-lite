'use strict';

const fs = require('fs');
const path = require('path');

// 品牌目录：聚合原 NVCI 已验证的 bundled-profiles（7 品牌 957 条公开官方彩页来源）。
// 默认读取工作区内 ../NVCI/automation/bundled-profiles，可用 NVCI_LITE_PROFILES_DIR 覆盖。
function defaultProfilesDir() {
  return process.env.NVCI_LITE_PROFILES_DIR
    || path.join(__dirname, '..', '..', 'NVCI', 'automation', 'bundled-profiles');
}

const VENDOR_NAME_FALLBACK = {
  ale: 'ALE', cisco: 'Cisco', extreme: 'Extreme Networks', h3c: '新华三 H3C',
  hpe: 'HPE Networking', huawei: '华为', ruijie: '锐捷网络',
};

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

// 兼容 bundled-profiles 新（schemaVersion 2.x：vendorName/productLine/subseries 对象）
// 与旧（1.x：仅 productLinePath，如 ale_omniswitch）两种结构。
function normalizeDocument(profile, source) {
  const vendorId = String(profile.vendorId || 'unknown');
  return {
    documentId: source.documentId,
    vendorId,
    vendorName: profile.vendorName || VENDOR_NAME_FALLBACK[vendorId] || vendorId,
    profileId: profile.profileId,
    profileDisplayName: profile.displayName || `${vendorId} 官方资料`,
    productLineName: profile.productLine?.name || profile.productLinePath?.[1] || '未分类',
    subseriesName: profile.subseries?.name || profile.displayName || '未分类',
    series: source.series || '',
    modelNames: Array.isArray(source.modelNames) ? source.modelNames : [],
    productPageUrl: source.productPageUrl || '',
    materialPageUrl: source.materialPageUrl || '',
    pdfUrl: source.pdfUrl || '',
    officialFileName: source.officialFileName || `${source.documentId}.pdf`,
    expectedSha256: source.expectedSha256 || '',
    officialDomains: profile.officialDomains || [],
    trustedRedirectDomains: profile.trustedRedirectDomains || [],
  };
}

function loadCatalog(profilesDir = defaultProfilesDir()) {
  const files = fs.existsSync(profilesDir)
    ? fs.readdirSync(profilesDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  const vendors = new Map();
  let documentCount = 0;
  for (const name of files) {
    const profile = readJson(path.join(profilesDir, name), null);
    if (!profile || !Array.isArray(profile.sources) || !profile.sources.length) continue;
    const documents = profile.sources.map((source) => normalizeDocument(profile, source));
    documentCount += documents.length;
    const vendorId = profile.vendorId || 'unknown';
    if (!vendors.has(vendorId)) {
      vendors.set(vendorId, {
        vendorId,
        vendorName: profile.vendorName || VENDOR_NAME_FALLBACK[vendorId] || vendorId,
        productLines: [],
      });
    }
    const vendor = vendors.get(vendorId);
    vendor.productLines.push({
      profileId: profile.profileId,
      displayName: profile.displayName || `${vendor.vendorName} ${documents[0].productLineName}`,
      productLineName: documents[0].productLineName,
      subseriesName: documents[0].subseriesName,
      documentCount: documents.length,
      modelCount: new Set(documents.flatMap((doc) => doc.modelNames)).size,
      officialDomains: profile.officialDomains || [],
      documents,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    profilesDir,
    vendorCount: vendors.size,
    documentCount,
    vendors: [...vendors.values()],
  };
}

function findDocuments(documentIds, profilesDir = defaultProfilesDir()) {
  const wanted = new Set(documentIds);
  const found = [];
  for (const vendor of loadCatalog(profilesDir).vendors) {
    for (const line of vendor.productLines) {
      for (const doc of line.documents) {
        if (wanted.has(doc.documentId)) found.push(doc);
      }
    }
  }
  return found;
}

module.exports = { loadCatalog, findDocuments, defaultProfilesDir, VENDOR_NAME_FALLBACK };
