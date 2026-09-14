'use strict';

// 参数矩阵：规则兜底抽取（中英文彩页常见参数）+ 矩形合并。
// 三态值：ok（有值）/ not_disclosed（未披露，不得推断为不支持）/ extract_failed（有文本但没抽到）。
// LLM 抽取结果（ai.js 产出）使用同一矩阵结构合并进来。
// 列模型（T05）：entry 带 model 时按「documentId#model」拆列——同一彩页多型号各占一列，
// 规则抽取值无型号归属，标 unattributed 提示「系列值」，防止系列值静默冒充型号值。
const { valuesEquivalent, normalizeKey } = require('./value-normalize');

// 竞品对标补充字段（对标 competitor-product-tracker 性能矩阵密度）：
// 定位/OS/最高速率/静态满载功耗/插槽——官网或彩页常有，原先 16 键模板覆盖不足。
const FIELD_TEMPLATE = [
  { key: 'positioning', label: '产品定位', group: '场景定位', patterns: [/((?:园区|数据中心|工业|接入|汇聚|核心|分支)[^\n。，]{0,18}(?:交换机|核心|汇聚|接入|场景|部署))/i, /((?:Campus|Data\s*Center|Industrial)[^\n.]{0,20}(?:switch|access|aggregation|core))/i] },
  { key: 'os_version', label: '操作系统', group: '软件', patterns: [/(Comware\s*V?\d+(?:\.\d+)?(?:\s*R\d+)?)/i, /(Cisco\s*IOS(?:\s*(?:XE|XR))?[^\n，。]{0,12})/i, /(?:操作系统|OS版本|software)[^\n]{0,8}([A-Za-z][^\n，。]{2,24})/i] },
  { key: 'max_speed', label: '最高速率', group: '转发性能', patterns: [/(?:最高速率|最高端口速率|up\s*to)[^\d]{0,12}(\d+\s*[TGM]bit\/?s?)/i, /(\d+\s*[TGM]bit\/s)\s*(?:端口|及以下|以下)/i] },
  { key: 'form_factor', label: '外形/机架高度', group: '物理规格', patterns: [/\b(1U|2U|1RU|2RU|半宽\s*1RU|half[- ]rack)\b/i] },
  { key: 'port_config', label: '端口配置', group: '端口', patterns: [/\b(\d+\s*[×xX]\s*(?:10\/100\/1000|10GE|25GE|40GE|100GE|400GE|2\.5GE|5GE)(?:BASE[^，。\s]*)?(?:\s*[+＋]\s*\d+\s*[×xX]\s*(?:10\/100\/1000|10GE|25GE|40GE|100GE|400GE|GE)[^，。\s]*)*)/, /(\d+\s*(?:个)?\s*(?:10\/100\/1000BASE-T|千兆电口|万兆光口|2\.5G\s*BASE-T|GE\s*电口|SFP\+?|QSFP28?))/i] },
  { key: 'downlink_ports', label: '下行端口数', group: '端口', patterns: [/(?:下行|downlink)[^\d]{0,12}(\d+)\s*(?:个|口|×|x)?/i] },
  { key: 'uplink_ports', label: '上行端口数', group: '端口', patterns: [/(?:上行|uplink)[^\d]{0,12}(\d+)\s*(?:个|口|×|x)?/i] },
  { key: 'switching_capacity', label: '交换容量', group: '转发性能', patterns: [/(?:交换容量|背板带宽|switching capacity)[^\dTGM0-9]{0,20}([0-9.]+\s*[TGM]bit\/s)/i, /([0-9.]+\s*[TGM]bits?\/s)[^\n]{0,20}(?:switching capacity|交换容量)/i] },
  { key: 'forwarding_rate', label: '包转发率', group: '转发性能', patterns: [/(?:包转发率|转发速率|forwarding (?:rate|performance|capacity))[^\d0-9]{0,20}([0-9.]+\s*[TGM]pps)/i, /([0-9.]+\s*[TGM]pps)[^\n]{0,20}(?:forwarding|包转发)/i] },
  { key: 'poe_capability', label: 'PoE 能力', group: '供电', patterns: [/(PoE\+?(?:供电|功率|power)?[^\n]{0,30}?)(\d+\s*(?:\.\d+)?\s*W(?:atts)?)\b(?:[^，。\n]{0,20}(?:总|total))?/i, /支持\s*(PoE\+?)/, /\b(PoE\+)\b/] },
  { key: 'poe_budget', label: 'PoE 总功率', group: '供电', patterns: [/(?:PoE(?:供电)?(?:总)?(?:功率|预算|budget))[^\d]{0,15}([0-9.]+\s*W)/i] },
  { key: 'power_static', label: '静态功耗', group: '供电', patterns: [/(?:静态功耗|idle\s*power|power\s*\(idle\))[^\d]{0,15}([0-9.]+\s*W)/i] },
  { key: 'power_max', label: '满载功耗', group: '供电', patterns: [/(?:满载功耗|满负荷功耗|最大功耗|typical\s*power\s*\(max\)|power\s*\(max\))[^\d]{0,15}([0-9.]+\s*W)/i] },
  { key: 'power_consumption', label: '额定功耗', group: '供电', patterns: [/(?:额定功率|系统功耗|整机功耗|典型功耗|power consumption|rated power)[^\d]{0,15}([0-9.]+\s*(?:至|-|~)?\s*[0-9.]*\s*W)/i] },
  { key: 'expansion_slots', label: '扩展插槽', group: '物理规格', patterns: [/(?:扩展插槽|业务插槽|uplink\s*module\s*slots?)[^\d]{0,12}(\d+\s*(?:个|slot)?)/i, /(\d+)\s*(?:个)?\s*(?:扩展|业务)\s*插槽/i] },
  { key: 'mac_table', label: 'MAC 地址表', group: '转发性能', patterns: [/(?:MAC(?:地址表|表)?|mac address table)[^\d]{0,15}([0-9,]+\s*[KMG]?)\s*(?:条|entries)?/i] },
  { key: 'vlan_count', label: 'VLAN 数量', group: '协议特性', patterns: [/(?:VLAN(?:数量|个数)?)[^\d]{0,10}([0-9,]+)/i, /([0-9,]+)\s*(?:个)?\s*VLAN/i] },
  { key: 'stacking', label: '堆叠能力', group: '可靠性', patterns: [/(?:支持|supports?)[^\n，。]{0,16}?(\d+\s*(?:台|units?|members?)\s*(?:堆叠|stacking|stack)[^\n，。]{0,20})/i, /((?:智能|虚拟化)?堆叠[（(]?[^\n，。]{0,30}[）)]?)/] },
  { key: 'power_redundancy', label: '电源冗余', group: '可靠性', patterns: [/(冗余电源|电源冗余|redundant\s+(?:power|psu)|RPS[^\n，。]{0,16})/i] },
  { key: 'mgmt', label: '管理方式', group: '管理', patterns: [/([^\n，。]{0,30}(?:Web管理|SNMP|Telnet|SSH|云管理|Web网管)[^\n，。]{0,40})/i] },
  { key: 'operating_temp', label: '工作温度', group: '环境适应', patterns: [/((?:-?\d+(?:\.\d+)?\s*°?C\s*(?:至|to|~|-)\s*-?\d+(?:\.\d+)?\s*°?C))/] },
  { key: 'latency', label: '时延', group: '转发性能', patterns: [/(?:时延|延迟|latency)[^\d]{0,15}([0-9.]+\s*[µu]?s)/i] },
];

// 功能特性模板：✓/△/✗/未披露。未披露 ≠ 不支持——只有明确「不支持」才写 ✗。
const FEATURE_GROUP = '功能特性';
const FEATURE_MARKS = { yes: '✓', partial: '△', no: '✗' };
const FEATURE_TEMPLATE = [
  { key: 'feat_stacking_irf', label: '堆叠/IRF', yes: [/支持[^。\n]{0,12}(?:IRF\d?|堆叠|stacking)/i, /\bIRF2?\b/i], partial: [/部分支持[^。\n]{0,10}(?:堆叠|IRF)/i], no: [/不支持[^。\n]{0,10}(?:堆叠|IRF|stacking)/i] },
  { key: 'feat_mlag', label: 'M-LAG', yes: [/支持[^。\n]{0,12}M-?LAG/i, /\bM-?LAG\b/i], partial: [/部分支持[^。\n]{0,10}M-?LAG/i], no: [/不支持[^。\n]{0,10}M-?LAG/i] },
  { key: 'feat_vxlan_evpn', label: 'VXLAN+EVPN', yes: [/支持[^。\n]{0,16}VXLAN/i, /VXLAN[^\n]{0,8}EVPN/i], partial: [/部分支持[^。\n]{0,12}VXLAN/i], no: [/不支持[^。\n]{0,12}VXLAN/i] },
  { key: 'feat_openflow_sdn', label: 'OpenFlow/SDN', yes: [/支持[^。\n]{0,12}OpenFlow/i, /\bOpenFlow\b/i], partial: [/部分支持[^。\n]{0,10}OpenFlow/i], no: [/不支持[^。\n]{0,10}OpenFlow/i] },
  { key: 'feat_macsec', label: 'MACsec', yes: [/支持[^。\n]{0,12}MACsec/i, /\bMACsec\b/i], partial: [/部分支持[^。\n]{0,10}MACsec/i], no: [/不支持[^。\n]{0,10}MACsec/i] },
  { key: 'feat_ptp_1588', label: '1588v2 PTP', yes: [/支持[^。\n]{0,16}(?:1588|PTP)/i, /\b1588v?2\b/i], partial: [/部分支持[^。\n]{0,12}(?:1588|PTP)/i], no: [/不支持[^。\n]{0,12}(?:1588|PTP)/i] },
  { key: 'feat_telemetry', label: 'Telemetry', yes: [/支持[^。\n]{0,12}Telemetry/i, /\bTelemetry\b/i], partial: [/部分支持[^。\n]{0,10}Telemetry/i], no: [/不支持[^。\n]{0,10}Telemetry/i] },
  { key: 'feat_integrated_ac', label: '融合 AC', yes: [/支持[^。\n]{0,16}(?:融合AC|Integrated\s*AC|无线控制器)/i], partial: [/部分支持[^。\n]{0,12}(?:融合AC|无线)/i], no: [/不支持[^。\n]{0,12}(?:融合AC|无线控制器)/i] },
  { key: 'feat_issu', label: 'ISSU', yes: [/支持[^。\n]{0,12}ISSU/i, /\bISSU\b/i], partial: [/部分支持[^。\n]{0,10}ISSU/i], no: [/不支持[^.\n]{0,10}ISSU/i] },
];

const PERF_FIELD_KEYS = ['positioning', 'os_version', 'max_speed', 'port_config', 'switching_capacity', 'forwarding_rate', 'expansion_slots', 'poe_budget', 'power_static', 'power_max', 'power_consumption', 'operating_temp', 'latency', 'mac_table'];

function findQuoteLine(lines, value) {
  for (const line of lines) {
    if (value && line.includes(value.slice(0, Math.min(12, value.length)))) return line.slice(0, 160);
  }
  return '';
}

// 规则兜底抽取：逐字段逐页匹配，命中即取值并记录页码与原文。
function extractParamsByRules(extraction) {
  const params = [];
  for (const field of FIELD_TEMPLATE) {
    const hit = matchFieldWithPage(field, extraction.pages);
    if (hit) {
      params.push({ key: field.key, label: field.label, group: field.group, value: hit.value, quote: hit.quote, page: hit.page, status: 'ok', source: 'rule' });
    }
  }
  return params;
}

// 功能特性规则抽取：✓/△/✗；仅明确「不支持」才写 ✗，其余无命中保持未披露（不进 params）。
function extractFeaturesByRules(extraction) {
  const params = [];
  const pages = Array.isArray(extraction?.pages) ? extraction.pages : [];
  for (const field of FEATURE_TEMPLATE) {
    let hit = null;
    let mark = null;
    for (const page of pages) {
      const text = page.lines.join('\n');
      for (const pattern of field.no || []) {
        const m = text.match(pattern);
        if (m) {
          hit = { value: FEATURE_MARKS.no, page: page.page, quote: findQuoteLine(page.lines, m[0].slice(0, 40)) };
          mark = 'no';
          break;
        }
      }
      if (hit) break;
      for (const pattern of field.partial || []) {
        const m = text.match(pattern);
        if (m) {
          hit = { value: FEATURE_MARKS.partial, page: page.page, quote: findQuoteLine(page.lines, m[0].slice(0, 40)) };
          mark = 'partial';
          break;
        }
      }
      if (hit) break;
      for (const pattern of field.yes || []) {
        const m = text.match(pattern);
        if (m) {
          hit = { value: FEATURE_MARKS.yes, page: page.page, quote: findQuoteLine(page.lines, m[0].slice(0, 40)) };
          mark = 'yes';
          break;
        }
      }
      if (hit) break;
    }
    if (hit && mark) {
      params.push({
        key: field.key,
        label: field.label,
        group: FEATURE_GROUP,
        value: hit.value,
        quote: hit.quote,
        page: hit.page,
        status: 'ok',
        source: 'rule',
        reviewNote: mark === 'partial' ? '部分支持（官网原文含部分/可选表述）' : '',
      });
    }
  }
  return params;
}

function matchFieldWithPage(field, pages) {
  for (const page of pages) {
    const text = page.lines.join('\n');
    for (const pattern of field.patterns) {
      const match = text.match(pattern);
      if (match) {
        const value = (match[1] || match[0]).replace(/\s+/g, ' ').trim();
        return { value, page: page.page, quote: findQuoteLine(page.lines, value) };
      }
    }
  }
  return null;
}

// 合并多列参数为矩阵：fields 按 group 分组有序；values 按列（columnId）四态。
// entry: {documentId, model?, label, params}；model 非空时 columnId = `${documentId}#${model}`。
// initTemplate=true 时用固定字段模板预置全部行——关键字段即使没抽到也要显示为「未找到」，
// 避免"没抽到"被无声折叠后误读成"彩页未披露"；抽取不完整的原因经 meta.incompleteDocs 传递。
function columnIdOf(entry) {
  return entry.model ? `${entry.documentId}#${entry.model}` : entry.documentId;
}

function buildMatrix(entries, { initTemplate = false } = {}) {
  // entries: [{documentId, model?, label, params: [{key,label,group,value,quote,page,status,source,reviewNote}]}]
  const fieldMap = new Map();
  if (initTemplate) {
    for (const field of FIELD_TEMPLATE) {
      fieldMap.set(field.key, { key: field.key, label: field.label, group: field.group, order: 0, values: {} });
    }
    for (const field of FEATURE_TEMPLATE) {
      fieldMap.set(field.key, { key: field.key, label: field.label, group: FEATURE_GROUP, order: 500 + FEATURE_TEMPLATE.indexOf(field), values: {} });
    }
  }
  const knownOrder = new Map(FIELD_TEMPLATE.map((field, index) => [field.key, index]));
  FEATURE_TEMPLATE.forEach((field, index) => knownOrder.set(field.key, 500 + index));
  for (const entry of entries) {
    const columnId = columnIdOf(entry);
    for (const rawParam of entry.params) {
      // key 归一化兜底（验收实战）：已缓存的旧抽取结果携带分裂 key（如 chassis_size/
      // chassis_dimension 三种写法），构建矩阵时再归一一次，同字段不因 key 分裂拆成多行
      const param = { ...rawParam, key: normalizeKey(String(rawParam.key || '').trim()) };
      if (!fieldMap.has(param.key)) {
        fieldMap.set(param.key, { key: param.key, label: param.label, group: param.group || '其他', order: knownOrder.has(param.key) ? knownOrder.get(param.key) : 1000, values: {} });
      }
      fieldMap.get(param.key).values[columnId] = {
        value: param.value || '',
        quote: param.quote || '',
        page: param.page || 0,
        status: param.status || (param.value ? 'ok' : 'not_disclosed'),
        source: param.source || '',
        reviewNote: param.reviewNote || '',
        candidates: Array.isArray(param.candidates) ? param.candidates : [],
        modelScope: param.modelScope || '',
        seriesWide: Boolean(param.seriesWide),
        unattributed: Boolean(param.unattributed),
      };
    }
  }
  const documents = entries.map((entry) => ({
    columnId: columnIdOf(entry),
    documentId: entry.documentId,
    model: entry.model || '',
    label: entry.label,
  }));
  for (const field of fieldMap.values()) {
    for (const doc of documents) {
      if (!field.values[doc.columnId]) {
        field.values[doc.columnId] = { value: '', quote: '', page: 0, status: 'not_disclosed', source: '', reviewNote: '' };
      }
    }
  }
  const groups = new Map();
  for (const field of [...fieldMap.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'zh-CN'))) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  return { documents, groups: [...groups.entries()].map(([group, fields]) => ({ group, fields })), meta: { incompleteDocs: [] } };
}

// 型号列参数组装（T05）：AI 按目标型号归属抽取的结果 + 系列值（规则/视觉兜底）。
// 冲突裁决沿用 mergeParams（规则与 AI 互异仍标待核对）；规则/视觉来源值标记 unattributed
// （系列值、型号归属未验证）——除非 AI 型号归属值与之等价，视为归属已验证。
function buildModelColumnParams(modelAiParams, seriesRuleParams) {
  const merged = mergeParams(modelAiParams, seriesRuleParams);
  const aiByKey = new Map((Array.isArray(modelAiParams) ? modelAiParams : [])
    .filter((param) => param && param.key && param.status === 'ok')
    .map((param) => [param.key, param]));
  for (const param of merged) {
    if (param.source !== 'rule' && param.source !== 'vision') {
      param.unattributed = false; // AI 型号归属值：归属明确
      continue;
    }
    const aiSame = aiByKey.get(param.key);
    const verified = Boolean(aiSame && valuesEquivalent(aiSame.value, param.value));
    param.unattributed = !verified;
    // 等价合并时胜出的是规则系列值，AI 的归属语义标记（全系列通用等）不随候选丢失
    if (verified && aiSame) {
      param.seriesWide = Boolean(aiSame.seriesWide);
      if (aiSame.modelScope) param.modelScope = aiSame.modelScope;
    }
  }
  return merged;
}

function cellStatusText(status) {
  if (status === 'ok') return '有依据';
  if (status === 'pending_review') return '待核对';
  if (status === 'extract_failed') return '抽取失败';
  return '未找到';
}

function normalizeValueText(value) {
  return String(value || '').replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, '').toLowerCase();
}

// 证据分级：规则（正则命中+引用定位）> 通过原文校验的抽取值 > 待复核（无原文可证）
function evidenceRank(param) {
  if (!param) return 0;
  if (param.status === 'pending_review') return 1;
  if (param.source === 'rule') return 3;
  if (param.quote) return 2;
  return 1;
}

// 证据分级合并（两阶段裁决，防"第三个同值候选清除冲突"）：
// 1) 先按 key 收集本次全部候选（含已合并项携带的历史候选），2) 再统一比较——
//    只要归一化后仍存在 ≥2 个不同取值，该字段就是未解决冲突：胜出值降为待核对，
//    全部候选进 reviewNote 与 candidates，任何后续同值候选都不能把状态自动恢复为 ok；
//    冲突只能由人工在核对界面裁决。同值多来源不算冲突，取高证据级别者。
function mergeParams(primaryParams, secondaryParams) {
  const byKey = new Map();
  const collect = (list) => {
    for (const param of Array.isArray(list) ? list : []) {
      if (!param || !param.key) continue;
      if (!byKey.has(param.key)) byKey.set(param.key, []);
      byKey.get(param.key).push(param);
    }
  };
  collect(secondaryParams);
  collect(primaryParams);

  const merged = [];
  for (const [key, params] of byKey) {
    // 展开候选全集：已合并项的 candidates 先入列，再入本次各项
    const candidates = [];
    for (const param of params) {
      if (Array.isArray(param.candidates)) {
        for (const cand of param.candidates) candidates.push({ ...cand });
      }
      candidates.push({ source: param.source || '', value: param.value || '', quote: param.quote || '', page: param.page || 0 });
    }
    // 候选去重（来源+归一化值）
    const seen = new Set();
    const uniqueCandidates = candidates.filter((cand) => {
      const identity = `${cand.source}|${normalizeValueText(cand.value)}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    // 互异取值用等价判断统计（方案 §5.3）：同量纲可换算等价（1.28Tbit/s 与 1280Gbit/s
    // 不算冲突）；限定词不同（≤60W vs 60W）保持互异，不丢失上限语义。
    const distinctValues = [];
    for (const cand of uniqueCandidates) {
      if (!cand.value) continue;
      if (!distinctValues.some((existing) => valuesEquivalent(existing, cand.value))) distinctValues.push(cand.value);
    }
    // 胜出者：证据级别最高，同级先到
    let winner = params[0];
    for (const param of params) {
      if (evidenceRank(param) > evidenceRank(winner)) winner = param;
    }
    if (distinctValues.length <= 1) {
      merged.push({ ...winner, candidates: uniqueCandidates });
    } else {
      merged.push({
        ...winner,
        status: 'pending_review',
        reviewNote: `取值冲突（${distinctValues.length} 个候选）：${distinctValues.slice(0, 3).map((v) => v.slice(0, 40)).join('；')}`,
        candidates: uniqueCandidates,
      });
    }
  }
  return merged;
}

module.exports = {
  FIELD_TEMPLATE, FEATURE_TEMPLATE, FEATURE_GROUP, FEATURE_MARKS, PERF_FIELD_KEYS,
  extractParamsByRules, extractFeaturesByRules, buildMatrix, buildModelColumnParams,
  cellStatusText, evidenceRank, mergeParams, columnIdOf,
};
