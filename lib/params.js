'use strict';

// 参数矩阵：规则兜底抽取（中英文彩页常见参数）+ 矩形合并。
// 三态值：ok（有值）/ not_disclosed（未披露，不得推断为不支持）/ extract_failed（有文本但没抽到）。
// LLM 抽取结果（ai.js 产出）使用同一矩阵结构合并进来。
const FIELD_TEMPLATE = [
  { key: 'form_factor', label: '外形/机架高度', group: '物理规格', patterns: [/\b(1U|2U|1RU|2RU|半宽\s*1RU|half[- ]rack)\b/i] },
  { key: 'port_config', label: '端口配置', group: '端口', patterns: [/\b(\d+\s*[×xX]\s*(?:10\/100\/1000|10GE|25GE|40GE|100GE|400GE|2\.5GE|5GE|GE)(?:BASE[^，。\s]*)?(?:\s*[+＋]\s*\d+\s*[×xX]\s*(?:10\/100\/1000|10GE|25GE|40GE|100GE|400GE|GE)[^，。\s]*)*)/, /(\d+\s*(?:个)?\s*(?:10\/100\/1000BASE-T|千兆电口|万兆光口|2\.5G\s*BASE-T|GE\s*电口|SFP\+?|QSFP28?))/i] },
  { key: 'downlink_ports', label: '下行端口数', group: '端口', patterns: [/(?:下行|downlink)[^\d]{0,12}(\d+)\s*(?:个|口|×|x)?/i] },
  { key: 'uplink_ports', label: '上行端口数', group: '端口', patterns: [/(?:上行|uplink)[^\d]{0,12}(\d+)\s*(?:个|口|×|x)?/i] },
  { key: 'switching_capacity', label: '交换容量', group: '转发性能', patterns: [/(?:交换容量|背板带宽|switching capacity)[^\dTGM0-9]{0,20}([0-9.]+\s*[TGM]bit\/s)/i, /([0-9.]+\s*[TGM]bits?\/s)[^\n]{0,20}(?:switching capacity|交换容量)/i] },
  { key: 'forwarding_rate', label: '包转发率', group: '转发性能', patterns: [/(?:包转发率|转发速率|forwarding (?:rate|performance|capacity))[^\d0-9]{0,20}([0-9.]+\s*[TGM]pps)/i, /([0-9.]+\s*[TGM]pps)[^\n]{0,20}(?:forwarding|包转发)/i] },
  { key: 'poe_capability', label: 'PoE 能力', group: '供电', patterns: [/(PoE\+?(?:供电|功率|power)?[^\n]{0,30}?)(\d+\s*(?:\.\d+)?\s*W(?:atts)?)\b(?:[^，。\n]{0,20}(?:总|total))?/i, /支持\s*(PoE\+?)/, /\b(PoE\+)\b/] },
  { key: 'poe_budget', label: 'PoE 总功率', group: '供电', patterns: [/(?:PoE(?:供电)?(?:总)?(?:功率|预算|budget))[^\d]{0,15}([0-9.]+\s*W)/i] },
  { key: 'power_consumption', label: '额定功耗', group: '供电', patterns: [/(?:额定功率|系统功耗|整机功耗|典型功耗|power consumption|rated power)[^\d]{0,15}([0-9.]+\s*(?:至|-|~)?\s*[0-9.]*\s*W)/i] },
  { key: 'mac_table', label: 'MAC 地址表', group: '转发性能', patterns: [/(?:MAC(?:地址表|表)?|mac address table)[^\d]{0,15}([0-9,]+\s*[KMG]?)\s*(?:条|entries)?/i] },
  { key: 'vlan_count', label: 'VLAN 数量', group: '协议特性', patterns: [/(?:VLAN(?:数量|个数)?)[^\d]{0,10}([0-9,]+)/i, /([0-9,]+)\s*(?:个)?\s*VLAN/i] },
  { key: 'mgmt', label: '管理方式', group: '管理', patterns: [/([^\n，。]{0,30}(?:Web管理|SNMP|Telnet|SSH|云管理|Web网管)[^\n，。]{0,40})/i] },
  { key: 'operating_temp', label: '工作温度', group: '环境适应', patterns: [/((?:-?\d+(?:\.\d+)?\s*°?C\s*(?:至|to|~|-)\s*-?\d+(?:\.\d+)?\s*°?C))/] },
  { key: 'latency', label: '时延', group: '转发性能', patterns: [/(?:时延|延迟|latency)[^\d]{0,15}([0-9.]+\s*[µu]?s)/i] },
];

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

// 合并多型号参数为矩阵：fields 按 group 分组有序；values 按 documentId 四态。
// initTemplate=true 时用固定字段模板预置全部行——关键字段即使没抽到也要显示为「未找到」，
// 避免"没抽到"被无声折叠后误读成"彩页未披露"；抽取不完整的原因经 meta.incompleteDocs 传递。
function buildMatrix(entries, { initTemplate = false } = {}) {
  // entries: [{ documentId, label, params: [{key,label,group,value,quote,page,status,source,reviewNote}] }]
  const fieldMap = new Map();
  if (initTemplate) {
    for (const field of FIELD_TEMPLATE) {
      fieldMap.set(field.key, { key: field.key, label: field.label, group: field.group, order: 0, values: {} });
    }
  }
  const knownOrder = new Map(FIELD_TEMPLATE.map((field, index) => [field.key, index]));
  for (const entry of entries) {
    for (const param of entry.params) {
      if (!fieldMap.has(param.key)) {
        fieldMap.set(param.key, { key: param.key, label: param.label, group: param.group || '其他', order: knownOrder.has(param.key) ? knownOrder.get(param.key) : 1000, values: {} });
      }
      fieldMap.get(param.key).values[entry.documentId] = {
        value: param.value || '',
        quote: param.quote || '',
        page: param.page || 0,
        status: param.status || (param.value ? 'ok' : 'not_disclosed'),
        source: param.source || '',
        reviewNote: param.reviewNote || '',
        candidates: Array.isArray(param.candidates) ? param.candidates : [],
      };
    }
  }
  const documents = entries.map((entry) => ({ documentId: entry.documentId, label: entry.label }));
  for (const field of fieldMap.values()) {
    for (const doc of documents) {
      if (!field.values[doc.documentId]) {
        field.values[doc.documentId] = { value: '', quote: '', page: 0, status: 'not_disclosed', source: '', reviewNote: '' };
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
    const distinctValues = new Set(uniqueCandidates.map((cand) => normalizeValueText(cand.value)).filter(Boolean));
    // 胜出者：证据级别最高，同级先到
    let winner = params[0];
    for (const param of params) {
      if (evidenceRank(param) > evidenceRank(winner)) winner = param;
    }
    if (distinctValues.size <= 1) {
      merged.push({ ...winner, candidates: uniqueCandidates });
    } else {
      merged.push({
        ...winner,
        status: 'pending_review',
        reviewNote: `取值冲突（${distinctValues.size} 个候选）：${[...distinctValues].slice(0, 3).map((v) => v.slice(0, 40)).join('；')}`,
        candidates: uniqueCandidates,
      });
    }
  }
  return merged;
}

module.exports = { FIELD_TEMPLATE, extractParamsByRules, buildMatrix, cellStatusText, evidenceRank, mergeParams };
