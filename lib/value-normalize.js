'use strict';

// 数值标准化与单位换算（方案 §5.3）：ai.js（值-引用校验）、params.js（合并等价判断）、
// thresholds.js（门槛比较）共用。原则：能可靠换算的才换算（同量纲十进制前缀），
// 换算不了的一律保守不等价——禁止靠"数字相同"放宽。
const UNIT_CANONICAL = { tbps: 'tbit/s', gbps: 'gbit/s', mbps: 'mbit/s', kbps: 'kbit/s', watts: 'w' };

// 度量单位（参与严格比较：数值与单位都对才放行）
const MEASURE_UNITS = new Set(['tbit/s', 'gbit/s', 'mbit/s', 'kbit/s', 'pps', 'mpps', 'gpps',
  'kw', 'w', 'va', 'v', 'a', 'mm', 'cm', 'km', 'kg', 'g',
  'tb', 'gb', 'mb', 'kb', 'ghz', 'mhz', 'hz', '°c', '%', 'h', 'rpm', 'db', 'u', 'ru']);

// 可十进制换算的单位族：基单位 → 前缀指数。同族才可跨单位比较（1.28Tbit/s ≡ 1280Gbit/s）。
const CONVERSION_FAMILIES = {
  'bit/s': { k: 1e3, m: 1e6, g: 1e9, t: 1e12 },
  pps: { k: 1e3, m: 1e6, g: 1e9 },
  hz: { k: 1e3, m: 1e6, g: 1e9 },
  b: { k: 1e3, m: 1e6, g: 1e9, t: 1e12 },
  w: { k: 1e3 },
};

// 否定表达（在归一化文本上做子串检测；单字"不"过于宽泛不收录）
const NEGATION_MARKS = ['不支持', '不可', '无法', '不带', '没有', '未', '无', '非',
  'notsupported', 'unsupport', 'doesnot', 'cannot', 'donot', 'notavailable', 'n/a'];

function normalizeForMatch(text) {
  return String(text)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/℃/g, '°c')
    .replace(/×/g, 'x') // 乘号与字母 x 视为同一连接（24×10GE ≡ 24x10GE）
    .replace(/\s+/g, '')
    .toLowerCase();
}

function canonicalUnit(unit) {
  return UNIT_CANONICAL[unit] || unit;
}

function isMeasureUnit(unit) {
  return MEASURE_UNITS.has(unit) || MEASURE_UNITS.has(canonicalUnit(unit));
}

function detectNegation(normalizedText) {
  return NEGATION_MARKS.some((mark) => normalizedText.includes(mark));
}

// 从归一化文本提取 数值+紧随单位 token：'128gbit/s' → {num:'128',unit:'gbit/s'}；
// '24x10/100/1000base-t' → 24(x)、10、100、1000(base)——复合结构在值与引用同构时自然对齐。
// 范围连接词 'to'（0°cto45°c）会黏进单位尾部，若去掉 to 后是已知度量单位则剥离。
function extractNumTokens(normalizedText) {
  const tokens = [];
  const re = /(\d+(?:\.\d+)?)([a-zμ°%/+×x]*)/g;
  let match;
  while ((match = re.exec(normalizedText)) !== null) {
    if (!match[1]) continue;
    let unit = match[2] || '';
    if (unit.length > 2 && unit.endsWith('to') && isMeasureUnit(unit.slice(0, -2))) unit = unit.slice(0, -2);
    tokens.push({ num: match[1], unit });
  }
  return tokens;
}

// 换算幅度：{num:'1.28', unit:'tbit/s'} → {value: 1.28e12, family:'bit/s'}；不可换算返回 null。
function convertibleMagnitude(num, unit) {
  if (!unit || !isMeasureUnit(unit)) return null;
  const canonical = canonicalUnit(unit);
  for (const [family, prefixes] of Object.entries(CONVERSION_FAMILIES)) {
    if (canonical === family) return { value: parseFloat(num), family };
    for (const [prefix, exp] of Object.entries(prefixes)) {
      if (canonical === `${prefix}${family}`) return { value: parseFloat(num) * exp, family };
    }
  }
  return null;
}

// 单个数值 token 等价判断：
// - 数字与单位都相同 → 等价；
// - 数字不同但同族单位换算后相等（1.28Tbit/s vs 1280Gbit/s）→ 等价；
// - 数字相同而度量单位不同（128Gbit/s vs 128Tbit/s）→ 不等价；
// - 跨族或不可换算 → 不等价（保守）。
function numTokensEquivalent(a, b) {
  if (a.num === b.num) {
    if (!a.unit || !b.unit) return true;
    return canonicalUnit(a.unit) === canonicalUnit(b.unit);
  }
  const magA = convertibleMagnitude(a.num, a.unit);
  const magB = convertibleMagnitude(b.num, b.unit);
  if (!magA || !magB || magA.family !== magB.family) return false;
  const scale = Math.max(Math.abs(magA.value), Math.abs(magB.value), 1);
  return Math.abs(magA.value - magB.value) <= 1e-9 * scale;
}

// 完整取值等价判断（合并去重用）：
// - 无数值 token → 归一化字符串相等；
// - 含数值 → token 数相同且能两两配对等价（顺序无关，处理 0°c~45°c 之类边界序）；
// - 限定词（≤≥<>~）视为取值的一部分：≤60W 与 60W 不等价，避免丢失上限语义。
function qualifierOf(normalizedText) {
  const marks = normalizedText.match(/[≤≥<>=~]/g) || [];
  return [...marks].sort().join('');
}

function valuesEquivalent(textA, textB) {
  const normA = normalizeForMatch(textA);
  const normB = normalizeForMatch(textB);
  if (qualifierOf(normA) !== qualifierOf(normB)) return false;
  const tokensA = extractNumTokens(normA);
  const tokensB = extractNumTokens(normB);
  if (!tokensA.length || !tokensB.length) return normA === normB;
  if (tokensA.length !== tokensB.length) return false;
  const used = new Set();
  return tokensA.every((tokenA) => {
    const index = tokensB.findIndex((tokenB, i) => !used.has(i) && numTokensEquivalent(tokenA, tokenB));
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

module.exports = {
  normalizeForMatch, canonicalUnit, isMeasureUnit, detectNegation,
  extractNumTokens, convertibleMagnitude, numTokensEquivalent, valuesEquivalent, qualifierOf,
};
