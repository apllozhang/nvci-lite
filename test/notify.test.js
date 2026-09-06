'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeLabel, metricLine, pushUpdatedEvent, vmConfig } = require('../lib/notify');

test('标签转义：反斜杠、引号、换行', () => {
  assert.equal(escapeLabel('a\\b'), 'a\\\\b');
  assert.equal(escapeLabel('说"话"'), '说\\"话\\"');
  assert.equal(escapeLabel('两\n行'), '两 行');
  assert.equal(escapeLabel(undefined), '');
});

test('指标行：标签齐全、sha256 截 12 位、毫秒时间戳', () => {
  const line = metricLine({
    vendorName: 'ALE',
    series: 'OmniSwitch 2260',
    documentId: 'ale-2260',
    sha256: 'a'.repeat(64),
  }, 1690000000000);
  assert.match(line, /^nvci_probe_updated_info\{.*\} 1 1690000000000\n$/);
  assert.match(line, /vendor="ALE"/);
  assert.match(line, /series="OmniSwitch 2260"/);
  assert.match(line, /document="ale-2260"/);
  assert.match(line, /sha256="aaaaaaaaaaaa"/);
});

test('pushUpdatedEvent：未配置 VM 地址时跳过，配置后推送正确端点与载荷', async () => {
  const saved = process.env.NVCI_LITE_VM_URL;
  try {
    delete process.env.NVCI_LITE_VM_URL;
    assert.deepEqual(await pushUpdatedEvent({}), { skipped: true }, '未配置应跳过');

    process.env.NVCI_LITE_VM_URL = 'http://10.20.30.203:8428/';
    let captured = null;
    const mockFetch = async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 204 };
    };
    const result = await pushUpdatedEvent({
      vendorName: '华为',
      series: 'S5731',
      documentId: 'hw-5731',
      sha256: 'b'.repeat(64),
    }, { fetchImpl: mockFetch });
    assert.deepEqual(result, { skipped: false });
    assert.equal(captured.url, 'http://10.20.30.203:8428/api/v1/import/prometheus', '末尾斜杠应被去掉');
    assert.equal(captured.options.method, 'POST');
    assert.match(captured.options.body, /^nvci_probe_updated_info\{vendor="华为",series="S5731",/);

    const badFetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(
      () => pushUpdatedEvent({ vendorName: 'x', series: 'y', documentId: 'z', sha256: '' }, { fetchImpl: badFetch }),
      /HTTP 500/,
    );
  } finally {
    if (saved === undefined) delete process.env.NVCI_LITE_VM_URL;
    else process.env.NVCI_LITE_VM_URL = saved;
  }
});

test('vmConfig：读取环境变量', () => {
  const saved = process.env.NVCI_LITE_VM_URL;
  try {
    delete process.env.NVCI_LITE_VM_URL;
    assert.equal(vmConfig().enabled, false);
    process.env.NVCI_LITE_VM_URL = 'http://vm:8428';
    assert.deepEqual(vmConfig(), { url: 'http://vm:8428', enabled: true });
  } finally {
    if (saved === undefined) delete process.env.NVCI_LITE_VM_URL;
    else process.env.NVCI_LITE_VM_URL = saved;
  }
});
