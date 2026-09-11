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

// 字段 key 同义词（§5.1 字段字典防分裂）：模型自造 key 归一到字段字典键。
// 在抽取时（ai.js）与矩阵构建时（params.js）双重生效——后者兜底已缓存的旧抽取结果。
// 分裂组来源：CE16800 实战验收实测（同 label 三种 key：机箱尺寸/交换架构各三分裂等）。
const KEY_SYNONYMS = {
  capacity: 'switching_capacity', total_capacity: 'switching_capacity', backplane: 'switching_capacity',
  switching: 'switching_capacity', throughput: 'forwarding_rate', packet_forwarding: 'forwarding_rate',
  forwarding_performance: 'forwarding_rate', packet_rate: 'forwarding_rate',
  poe: 'poe_capability', poe_support: 'poe_capability', poe_power: 'poe_budget',
  poe_total_power: 'poe_budget', poe_budget_watts: 'poe_budget',
  power: 'power_consumption', power_supply: 'power_consumption', power_rating: 'power_consumption',
  rated_power: 'power_consumption', temperature: 'operating_temp', operating_temperature: 'operating_temp',
  ports: 'port_config', port: 'port_config', interface: 'port_config', port_configuration: 'port_config',
  mac: 'mac_table', mac_address: 'mac_table', mac_size: 'mac_table', mac_entries: 'mac_table',
  management: 'mgmt', mgmt_mode: 'mgmt', management_mode: 'mgmt',
  form: 'form_factor', height: 'form_factor', rack_unit: 'form_factor',
  uplink: 'uplink_ports', downlink: 'downlink_ports', vlan: 'vlan_count', vlans: 'vlan_count',
  stack: 'stacking', stack_support: 'stacking', power_redundant: 'power_redundancy',
  rps: 'power_redundancy', redundant_power: 'power_redundancy',
  // —— CE16800 实战验收实测分裂组 ——
  switching_arch: 'switching_architecture', switch_architecture: 'switching_architecture',
  hw_redundancy: 'power_redundancy', redundancy_design: 'power_redundancy', hardware_redundancy: 'power_redundancy',
  voltage_range: 'max_voltage_range',
  chassis_size: 'chassis_dimensions', chassis_dimension: 'chassis_dimensions',
  weight: 'empty_weight', device_weight: 'empty_weight',
  m_lag: 'mlag',
  line_cards: 'line_card_config', line_card: 'line_card_config', line_speed_cards: 'line_card_config',
  service_slots: 'business_slots', slot_count: 'business_slots',
};

function normalizeKey(key) {
  return KEY_SYNONYMS[key] || key;
}

module.exports = {
  normalizeForMatch, canonicalUnit, isMeasureUnit, detectNegation,
  extractNumTokens, convertibleMagnitude, numTokensEquivalent, valuesEquivalent, qualifierOf,
  normalizeKey,
};
