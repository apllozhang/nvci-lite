'use strict';

// 文件名 → 资料匹配：登记文件名精确/互含 + 系列/型号词命中打分。
// 用于批量导入的人工确认界面：机器给候选和理由，人做最终指派。

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(fileName, doc) {
  const file = normalizeName(fileName);
  if (!file) return { score: 0, reasons: [] };
  const official = normalizeName(doc.officialFileName);
  const series = normalizeName(doc.series);
  const models = (doc.modelNames || []).map((m) => normalizeName(m)).filter((m) => m.length >= 3);
  const vendor = normalizeName(doc.vendorName || '');
  let score = 0;
  const reasons = [];
  if (official && official === file) {
    score += 100;
    reasons.push('文件名与登记文件名完全一致');
  } else if (official && (file.includes(official) || official.includes(file))) {
    score += 60;
    reasons.push('与登记文件名互含');
  }
  if (series && series.length >= 2 && file.includes(series)) {
    score += 50;
    reasons.push('含系列名');
  }
  const model = models.find((m) => file.includes(m));
  if (model) {
    score += 40;
    reasons.push(`含型号 ${model}`);
  }
  if (vendor && file.includes(vendor)) {
    score += 10;
    reasons.push('含品牌名');
  }
  return { score, reasons };
}

function matchDocuments(fileName, documents, { limit = 5, minScore = 40 } = {}) {
  return documents
    .map((doc) => {
      const { score, reasons } = scoreMatch(fileName, doc);
      return {
        documentId: doc.documentId,
        vendorName: doc.vendorName,
        series: doc.series,
        officialFileName: doc.officialFileName,
        modelNames: doc.modelNames || [],
        score,
        reasons,
      };
    })
    .filter((candidate) => candidate.score >= minScore)
    .sort((a, b) => b.score - a.score || a.series.localeCompare(b.series, 'zh-CN'))
    .slice(0, limit);
}

// 自动指派：最高分领先第二名 30 分以上且不低于 80 分时才机器拍板，其余交人工确认
function autoAssign(candidates) {
  if (!candidates.length) return '';
  if (candidates[0].score < 80) return '';
  if (candidates.length > 1 && candidates[0].score - candidates[1].score < 30) return '';
  return candidates[0].documentId;
}

module.exports = { autoAssign, matchDocuments, normalizeName, scoreMatch };
