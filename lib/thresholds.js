'use strict';

// 采购门槛三态判定（方案 §9.2）：满足 / 不满足 / 未知，由程序按数值计算。
// 未知不折算为不满足：取值待核对、字段缺失、单位不可比、多数值无法自动判定时一律未知。
// 门槛是项目条件，不是产品事实——判定结果只描述「当前证据下是否满足门槛」。
const {
  normalizeForMatch, extractNumTokens, convertibleMagnitude, canonicalUnit, isMeasureUnit,
} = require('./value-normalize');

const THRESHOLD_OPS = {
  // test(cellValue, thresholdValue)：门槛语义 = 取值对门槛的关系（ge = 取值 ≥ 门槛）
  ge: { label: '≥', test: (cell, threshold) => cell >= threshold },
  gt: { label: '>', test: (cell, threshold) => cell > threshold },
  le: { label: '≤', test: (cell, threshold) => cell <= threshold },
  lt: { label: '<', test: (cell, threshold) => cell < threshold },
};

// 解析门槛输入「24」「370W」「0.2Tbit/s」→ {num, unit}；无法解析返回 null。
function parseThresholdValue(raw) {
  const norm = normalizeForMatch(raw);
  const match = norm.match(/^(\d+(?:\.\d+)?)([a-zμ°%/+×x]*)$/);
  if (!match) return null;
  const unit = match[2] || '';
  if (unit && !isMeasureUnit(unit)) return null; // 单位不认识 → 未知，不猜
  return { num: match[1], unit };
}

// 单元格取值 → 可比较数值 {magnitude}；不可比返回 {reason}。
function comparableCellNumber(cellValue) {
  const tokens = extractNumTokens(normalizeForMatch(cellValue));
  if (!tokens.length) return { reason: '取值不含数值' };
  if (tokens.length > 1) return { reason: '取值含多个数值（如分组端口），需人工判定' };
  return { token: tokens[0] };
}

// 门槛与取值比较：单位可比（同族可换算或同单位）才比较，跨量纲返回不可比。
function compareValues(threshold, token) {
  if (!threshold.unit && !token.unit) return { a: parseFloat(threshold.num), b: parseFloat(token.num) };
  if (threshold.unit && !token.unit) return { reason: '取值未含与门槛可比的单位' };
  if (!threshold.unit && token.unit) return { reason: `门槛未指定单位而取值为 ${token.num}${token.unit}（请填写含单位的门槛，如 ${threshold.num}${token.unit}）` };
  const sameUnit = canonicalUnit(threshold.unit) === canonicalUnit(token.unit);
  if (sameUnit) return { a: parseFloat(threshold.num), b: parseFloat(token.num) };
  const magA = convertibleMagnitude(threshold.num, threshold.unit);
  const magB = convertibleMagnitude(token.num, token.unit);
  if (magA && magB && magA.family === magB.family) {
    return { a: magA.value, b: magB.value, converted: true };
  }
  return { reason: '单位不可比' };
}

// evaluateThresholds(matrix, thresholds, options)
//   thresholds: [{fieldKey, op, value}]（op ∈ ge/gt/le/lt）
//   返回 [{fieldKey, fieldLabel, op, opLabel, value, results: {documentId: {verdict, reason, basis}}}]
//   verdict: 'pass' | 'fail' | 'unknown'；basis 为人类可读判定依据。
function evaluateThresholds(matrix, thresholds) {
  const fieldIndex = new Map();
  for (const group of matrix.groups || []) {
    for (const field of group.fields || []) fieldIndex.set(field.key, field);
  }
  return (Array.isArray(thresholds) ? thresholds : []).map((threshold) => {
    const op = THRESHOLD_OPS[threshold.op];
    const parsed = op ? parseThresholdValue(threshold.value) : null;
    const field = fieldIndex.get(threshold.fieldKey);
    const row = {
      fieldKey: threshold.fieldKey,
      fieldLabel: field ? field.label : threshold.fieldKey,
      op: threshold.op,
      opLabel: op ? op.label : String(threshold.op),
      value: String(threshold.value || ''),
      results: {},
    };
    for (const doc of matrix.documents || []) {
      // 列键用 columnId（T05 型号分列），单列时与 documentId 相同
      const columnId = doc.columnId || doc.documentId;
      if (!op) { row.results[columnId] = { verdict: 'unknown', reason: '门槛条件不合法' }; continue; }
      if (!parsed) { row.results[columnId] = { verdict: 'unknown', reason: '门槛值无法解析' }; continue; }
      if (!field) { row.results[columnId] = { verdict: 'unknown', reason: '字段不在矩阵中' }; continue; }
      const cell = field.values[columnId];
      if (!cell || cell.status === 'pending_review') {
        row.results[columnId] = { verdict: 'unknown', reason: cell ? `取值待核对（${cell.reviewNote || '机器推测'}）` : '无取值' };
        continue;
      }
      if (cell.status !== 'ok' || !cell.value) {
        row.results[columnId] = { verdict: 'unknown', reason: '未找到适用值' };
        continue;
      }
      const cellNumber = comparableCellNumber(cell.value);
      if (cellNumber.reason) { row.results[columnId] = { verdict: 'unknown', reason: cellNumber.reason }; continue; }
      const comparison = compareValues(parsed, cellNumber.token);
      if (comparison.reason) { row.results[columnId] = { verdict: 'unknown', reason: comparison.reason }; continue; }
      const pass = op.test(comparison.b, comparison.a);
      row.results[columnId] = {
        verdict: pass ? 'pass' : 'fail',
        basis: `${cell.value}（${cell.source === 'manual' ? '人工核对' : '有依据'}） ${op.label} ${threshold.value}`,
      };
    }
    return row;
  });
}

module.exports = { evaluateThresholds, THRESHOLD_OPS, parseThresholdValue };
