'use strict';

// 进程内指标（评审 R4 最小集）：无依赖 Prometheus 文本格式，/metrics 拉取。
// 计数器 + 单 gauge，标签基数刻意收敛（status/outcome/result 枚举值），防高基数。
// 指标是进程内存态：重启归零（probe 的持久结论以 probe-state.json 为准，不在此重复）。

const counters = new Map(); // `${name}#{label套}` -> { labels, value }

function inc(name, labels = {}, value = 1) {
  const key = `${name}|${JSON.stringify(labels)}`;
  const entry = counters.get(key);
  if (entry) entry.value += value;
  else counters.set(key, { name, labels, value });
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderCounters() {
  const lines = [];
  const seen = new Set();
  for (const { name, labels, value } of counters.values()) {
    if (!seen.has(name)) {
      lines.push(`# TYPE ${name} counter`);
      seen.add(name);
    }
    const labelPairs = Object.entries(labels)
      .map(([key, val]) => `${key}="${escapeLabel(val)}"`).join(',');
    lines.push(`${name}{${labelPairs}} ${value}`);
  }
  return lines.join('\n');
}

function renderProcess() {
  const memory = process.memoryUsage();
  return [
    '# TYPE nvci_process_uptime_seconds gauge',
    `nvci_process_uptime_seconds ${Math.round(process.uptime())}`,
    '# TYPE nvci_process_memory_rss_bytes gauge',
    `nvci_process_memory_rss_bytes ${memory.rss}`,
    '# TYPE nvci_process_heap_used_bytes gauge',
    `nvci_process_heap_used_bytes ${memory.heapUsed}`,
  ].join('\n');
}

function render() {
  return `${renderCounters()}\n${renderProcess()}\n`;
}

module.exports = { inc, render };
