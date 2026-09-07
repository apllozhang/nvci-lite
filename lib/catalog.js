'use strict';

const fs = require('fs');
const path = require('path');

// 品牌目录：聚合 7 品牌 957 条公开官方彩页来源（原 NVCI bundled-profiles 已收编进仓库 profiles/）。
// 查找顺序：NVCI_LITE_PROFILES_DIR 环境变量 → 仓库自带 profiles/ → 旧版 ../NVCI 兄弟目录。
function defaultProfilesDir() {
  if (process.env.NVCI_LITE_PROFILES_DIR) return process.env.NVCI_LITE_PROFILES_DIR;
  const repoProfiles = path.join(__dirname, '..', 'profiles');
  if (fs.existsSync(repoProfiles)
    && fs.readdirSync(repoProfiles).some((name) => name.endsWith('.json'))) {
    return repoProfiles;
  }
  return path.join(__dirname, '..', '..', 'NVCI', 'automation', 'bundled-profiles');
}

// 自定义来源目录（新增厂商/产品线的彩页归档，方案见完整版 SOURCE_CONFIGURATION_GUIDE）：
// 与内置目录同 schema，叠加加载。documentId/profileId 与内置冲突时跳过自定义侧并记入
// catalog.warnings——内置基准不可被本地文件覆盖，避免破坏 957 条官方登记的可信度。
function defaultCustomProfilesDir() {
  if (process.env.NVCI_LITE_CUSTOM_PROFILES_DIR) return process.env.NVCI_LITE_CUSTOM_PROFILES_DIR;
  const dataRoot = process.env.NVCI_LITE_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dataRoot, 'custom-profiles');
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
    description: source.description || '',
    productPageUrl: source.productPageUrl || '',
    materialPageUrl: source.materialPageUrl || '',
    pdfUrl: source.pdfUrl || '',
    officialFileName: source.officialFileName || `${source.documentId}.pdf`,
    expectedSha256: source.expectedSha256 || '',
    officialDomains: profile.officialDomains || [],
    trustedRedirectDomains: profile.trustedRedirectDomains || [],
  };
}

function loadCatalog(profilesDir = defaultProfilesDir(), customDir = defaultCustomProfilesDir()) {
  const vendors = new Map();
  let documentCount = 0;
  const warnings = [];
  const seenProfileIds = new Set();
  const seenDocumentIds = new Set();
  // 内置目录先加载（基准不可覆盖），自定义目录叠加（新厂商/产品线彩页归档）
  const locations = [
    { dir: profilesDir, custom: false },
    { dir: customDir, custom: true },
  ];
  for (const { dir, custom } of locations) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
      : [];
    for (const name of files) {
      const profile = readJson(path.join(dir, name), null);
      // sources 允许为空数组（占位产品线：界面显示"待登记"，不参与采集/探测范围）
      if (!profile || !Array.isArray(profile.sources)) continue;
      if (profile.profileId && seenProfileIds.has(profile.profileId)) {
        warnings.push(`自定义来源 ${name} 的 profileId「${profile.profileId}」与已有来源冲突，已跳过整个文件`);
        continue;
      }
      const documents = [];
      for (const source of profile.sources) {
        const doc = normalizeDocument(profile, source);
        if (seenDocumentIds.has(doc.documentId)) {
          warnings.push(`自定义来源 ${profile.profileId || name} 的条目 ${doc.documentId} 与已有条目冲突，已跳过该条`);
          continue;
        }
        seenDocumentIds.add(doc.documentId);
        documents.push(doc);
      }
      if (profile.profileId) seenProfileIds.add(profile.profileId);
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
      const first = documents[0] || {};
      vendor.productLines.push({
        profileId: profile.profileId,
        displayName: profile.displayName || `${vendor.vendorName} ${first.productLineName || ''}`.trim(),
        productLineName: first.productLineName || profile.displayName || '',
        subseriesName: first.subseriesName || profile.displayName || '',
        documentCount: documents.length,
        modelCount: new Set(documents.flatMap((doc) => doc.modelNames)).size,
        officialDomains: profile.officialDomains || [],
        documents,
        // 自定义来源标记：前端显示徽标并允许编辑/删除；内置产品线只读
        custom,
        sampleCheck: custom ? (profile.sampleCheck || null) : undefined,
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    profilesDir,
    customProfilesDir: customDir,
    vendorCount: vendors.size,
    documentCount,
    warnings,
    vendors: [...vendors.values()],
  };
}

function findDocuments(documentIds, profilesDir = defaultProfilesDir(), customDir = defaultCustomProfilesDir()) {
  const wanted = new Set(documentIds);
  const found = [];
  for (const vendor of loadCatalog(profilesDir, customDir).vendors) {
    for (const line of vendor.productLines) {
      for (const doc of line.documents) {
        if (wanted.has(doc.documentId)) found.push(doc);
      }
    }
  }
  return found;
}

module.exports = { loadCatalog, findDocuments, defaultProfilesDir, defaultCustomProfilesDir, VENDOR_NAME_FALLBACK };
