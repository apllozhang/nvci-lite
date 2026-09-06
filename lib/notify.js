'use strict';

// 厂商更新事件外发：推指标到 Victoriametrics 文本导入接口（/api/v1/import/prometheus），
// 供 n9e（Nightingale）建告警规则消费（例：count_over_time(nvci_probe_updated_info[1h]) > 0）。
// fire-and-forget：推送失败只记日志，绝不影响探测主流程。
function vmConfig() {
  const url = (process.env.NVCI_LITE_VM_URL || '').replace(/\/+$/, '');
  return { url, enabled: Boolean(url) };
}

function escapeLabel(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ');
}

function metricLine({ vendorName, series, documentId, sha256 }, at = Date.now()) {
  const labels = [
    `vendor="${escapeLabel(vendorName)}"`,
    `series="${escapeLabel(series)}"`,
    `document="${escapeLabel(documentId)}"`,
    `sha256="${escapeLabel(String(sha256 || '').slice(0, 12))}"`,
  ].join(',');
  return `nvci_probe_updated_info{${labels}} 1 ${at}\n`;
}

async function pushUpdatedEvent(payload, { fetchImpl = fetch } = {}) {
  const { url, enabled } = vmConfig();
  if (!enabled) return { skipped: true };
  const response = await fetchImpl(`${url}/api/v1/import/prometheus`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: metricLine(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`VM import HTTP ${response.status}`);
  return { skipped: false };
}

module.exports = { escapeLabel, metricLine, pushUpdatedEvent, vmConfig };
