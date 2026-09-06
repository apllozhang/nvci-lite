'use strict';

const state = {
  step: 1,
  catalog: null,
  aiStatus: null,
  currentVendorId: null,
  currentProfileId: null,
  expanded: new Set(),
  selected: new Map(),   // documentId -> document（待采集清单）
  collected: new Set(),  // 已采集 documentId
  library: [],           // 服务端已采集清单
  cmpSel: new Set(),     // 对比勾选
  collecting: false,
  aborted: false,
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

/* ---------- 全局告警铃铛（厂商更新 / 来源异常） ---------- */

const alerts = { list: [], labels: {}, open: false };

async function refreshAlerts() {
  try {
    const payload = await api('/api/probe/alerts');
    alerts.list = payload.alerts || [];
    alerts.labels = payload.stateLabels || {};
    const count = alerts.list.length;
    $('alertCount').textContent = count > 99 ? '99+' : String(count);
    $('alertCount').classList.toggle('hidden', count === 0);
    $('alertBell').classList.toggle('ringing', count > 0);
    $('alertGenerated').textContent = payload.generatedAt ? `· ${payload.generatedAt.slice(0, 16).replace('T', ' ')}` : '';
    renderAlertList();
  } catch { /* 静默，等待下一轮 */ }
}

function renderAlertList() {
  const box = $('alertList');
  if (!alerts.list.length) {
    box.innerHTML = '<div class="muted empty">暂无告警：已建档彩页均有效或与基线一致</div>';
    return;
  }
  box.innerHTML = alerts.list.map((item) => {
    const isUpdate = item.type === 'updated';
    return `<div class="alert-item">
      <span class="alert-dot ${isUpdate ? 'dot-updated' : 'dot-error'}"></span>
      <div class="alert-body">
        <div class="alert-title">${esc(item.vendorName)} · ${esc(item.series)}</div>
        <div class="muted small">${isUpdate ? '⚠ 彩页与建档哈希不一致，厂商可能已更新' : `✘ ${esc(alerts.labels[item.status] || item.status)}`}${item.detail ? ` · ${esc(item.detail)}` : ''} · ${esc(String(item.checkedAt).slice(0, 16).replace('T', ' '))}</div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 全局 toast ---------- */

function toast(type, message, duration = 4200) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  $('toastWrap').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ---------- 步骤流转（带守卫，步骤条可点击） ---------- */

async function goStep(step) {
  if (state.collecting && step !== 2) { toast('warn', '正在采集中，请先停止或等待完成'); return; }
  if (step === 2 && state.selected.size === 0) { toast('warn', '请先在第 1 步勾选至少一份资料'); return; }
  if (step === 3 || step === 4) {
    const ok = await ensureLibrary();
    if (!ok) return;
    if (![...state.collected].length) { toast('warn', '还没有已采集的彩页，请先完成第 2 步采集'); return; }
  }
  if (step === 4 && state.cmpSel.size < 2) { toast('warn', '请先在第 3 步勾选至少 2 个对比产品'); return; }

  state.step = step;
  for (let i = 1; i <= 5; i += 1) $(`step${i}`).classList.toggle('hidden', i !== step);
  refreshStepBar();
  if (step === 2) renderCollectSummary();
  if (step === 3) renderLibrary();
  if (step === 4) { renderAiMode(); loadExports(); }
  if (step === 5) renderProbe();
}

function refreshStepBar() {
  document.querySelectorAll('.step').forEach((el) => {
    const number = Number(el.dataset.step);
    el.classList.toggle('active', number === state.step);
    el.classList.toggle('done', number < state.step);
  });
}

/* ---------- 步骤 1：品牌树 + 勾选表 + 已选托盘 ---------- */

function vendorOf(vendorId) { return state.catalog.vendors.find((v) => v.vendorId === vendorId); }
function currentLine() {
  const vendor = vendorOf(state.currentVendorId);
  return vendor?.productLines.find((l) => l.profileId === state.currentProfileId);
}

function renderTree() {
  const tree = $('catalogTree');
  tree.innerHTML = state.catalog.vendors.map((vendor) => {
    const total = vendor.productLines.reduce((sum, line) => sum + line.documentCount, 0);
    const open = state.expanded.has(vendor.vendorId);
    const lines = vendor.productLines.map((line) => `
      <button class="tree-line ${line.profileId === state.currentProfileId ? 'active' : ''}" data-vendor="${esc(vendor.vendorId)}" data-profile="${esc(line.profileId)}">
        <span class="tree-line-name">${esc(line.displayName)}</span><span class="tree-count">${line.documentCount}</span>
      </button>`).join('');
    return `<div class="tree-brand">
      <button class="tree-brand-btn ${open ? 'open' : ''}" data-vendor="${esc(vendor.vendorId)}">
        <span class="tree-arrow">${open ? '▾' : '▸'}</span>
        <span class="tree-brand-name">${esc(vendor.vendorName)}</span>
        <span class="tree-count">${total}</span>
      </button>
      <div class="tree-lines ${open ? '' : 'hidden'}">${lines}</div>
    </div>`;
  }).join('');

  tree.querySelectorAll('.tree-brand-btn').forEach((btn) => btn.addEventListener('click', () => {
    const vendorId = btn.dataset.vendor;
    const wasOpen = state.expanded.has(vendorId);
    if (wasOpen) state.expanded.delete(vendorId);
    else {
      state.expanded.add(vendorId);
      // 展开时若尚未选中该品牌下的产品线，默认选中第一条，右侧立即有内容
      if (vendorOf(vendorId).productLines.every((line) => line.profileId !== state.currentProfileId)) {
        const vendor = vendorOf(vendorId);
        state.currentVendorId = vendorId;
        state.currentProfileId = vendor.productLines[0].profileId;
        renderDocTable($('docSearch').value);
      }
    }
    renderTree();
  }));
  tree.querySelectorAll('.tree-line').forEach((btn) => btn.addEventListener('click', () => {
    state.currentVendorId = btn.dataset.vendor;
    state.currentProfileId = btn.dataset.profile;
    state.expanded.add(btn.dataset.vendor);
    renderTree();
    renderDocTable($('docSearch').value);
  }));
}

function renderDocTable(filter = '') {
  const line = currentLine();
  if (!line) { $('docTable').innerHTML = '<div class="muted empty">← 请先在左侧选择品牌和产品线</div>'; $('lineInfo').textContent = ''; return; }
  const needle = filter.trim().toLowerCase();
  const docs = line.documents.filter((doc) => !needle
    || `${doc.series} ${doc.modelNames.join(' ')} ${doc.officialFileName}`.toLowerCase().includes(needle));
  $('lineInfo').textContent = `${vendorOf(state.currentVendorId).vendorName} · ${line.displayName} · ${line.documents.length} 份`;
  $('docTable').innerHTML = docs.map((doc) => docRowHtml(doc)).join('') || '<div class="muted empty">没有匹配的资料</div>';
  bindDocRows($('docTable'));
}

function docRowHtml(doc) {
  const checked = state.selected.has(doc.documentId);
  const collected = state.collected.has(doc.documentId);
  return `<label class="doc-row ${checked ? 'checked' : ''}" data-id="${esc(doc.documentId)}">
    <input type="checkbox" ${checked ? 'checked' : ''}>
    <span class="doc-series">${esc(doc.series)}</span>
    <span class="doc-models">${esc(doc.modelNames.join('、') || '—')}</span>
    ${collected ? '<span class="tag">已采集</span>' : ''}
    ${doc.pdfUrl ? '<span class="tag dim">PDF</span>' : ''}
    ${doc.productPageUrl ? '<span class="tag dim">产品页</span>' : ''}
  </label>`;
}

function bindDocRows(container) {
  container.querySelectorAll('.doc-row').forEach((row) => row.addEventListener('click', (event) => {
    const id = row.dataset.id;
    const line = currentLine();
    const doc = line.documents.find((d) => d.documentId === id);
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.set(id, doc);
    row.classList.toggle('checked', state.selected.has(id));
    row.querySelector('input').checked = state.selected.has(id);
    updateTray();
  }));
}

function refreshRowById(documentId) {
  const row = document.querySelector(`#docTable .doc-row[data-id="${CSS.escape(documentId)}"]`);
  if (row) {
    row.classList.toggle('checked', state.selected.has(documentId));
    const input = row.querySelector('input');
    if (input) input.checked = state.selected.has(documentId);
  }
}

function updateTray() {
  $('selCount').textContent = state.selected.size;
  $('toStep2').disabled = state.selected.size === 0;
  const tray = $('selTray');
  tray.classList.toggle('hidden', state.selected.size === 0);
  tray.innerHTML = `<span class="tray-label">已选 ${state.selected.size} 份</span>`
    + [...state.selected.values()].map((doc) => `
      <span class="tray-chip">${esc(doc.vendorName)} · ${esc(doc.series)}
        <button class="tray-x" data-id="${esc(doc.documentId)}" title="移除">×</button>
      </span>`).join('');
  tray.querySelectorAll('.tray-x').forEach((btn) => btn.addEventListener('click', (event) => {
    event.stopPropagation();
    state.selected.delete(btn.dataset.id);
    refreshRowById(btn.dataset.id);
    updateTray();
  }));
}

/* ---------- 步骤 2：逐条采集 + 进度条 ---------- */

function renderCollectSummary() {
  const docs = [...state.selected.values()];
  if (!docs.length) { $('collectSummary').innerHTML = '<div class="muted">未选择资料，请回第 1 步勾选</div>'; return; }
  const pending = docs.filter((d) => !state.collected.has(d.documentId));
  const cached = docs.length - pending.length;
  const rows = pending.map((doc) => `<li>${esc(doc.vendorName)} · ${esc(doc.series)}</li>`).join('');
  $('collectSummary').innerHTML = `<div class="muted">待采集 ${pending.length} 份${cached ? `，已采集 ${cached} 份（自动跳过，可回第 1 步加选后增量采集）` : ''}：</div><ul class="collect-list">${rows}</ul>`;
}

function rowHtml(row, cached = false) {
  if (cached) {
    return `<div class="collect-row done"><span class="badge ok">已采集</span><span class="doc-series">${esc(row.series)}</span><span class="muted small">跳过，不重复下载</span></div>`;
  }
  if (row.status === 'completed') {
    const label = row.decision === 'reuse_unchanged' ? '已缓存·复用' : '✔ 已下载';
    return `<div class="collect-row done">
      <span class="badge ok">${label}</span>
      <span class="doc-series">${esc(row.series)}</span>
      <span class="muted small">${row.sha256 ? `SHA-256 ${esc(row.sha256.slice(0, 12))}… · ${row.pageCount || '?'} 页` : ''}</span>
      ${row.warning ? `<span class="warn" title="${esc(row.warning)}">⚠ 哈希与基线不一致</span>` : ''}
      ${row.pageMarkdown ? `<span class="tag ${row.pageMarkdown.status === 'ok' ? '' : 'dim'}" title="${esc(row.pageMarkdown.reason || '')}">产品页：${row.pageMarkdown.status === 'ok' ? '已存 Markdown' : row.pageMarkdown.status}</span>` : ''}
    </div>`;
  }
  return `<div class="collect-row fail-row">
    <span class="badge fail">✘ 失败</span>
    <span class="doc-series">${esc(row.series)}</span>
    <span class="error">${esc(row.error || '未知原因')}</span>
  </div>`;
}

function setProgress(done, total, label) {
  const wrap = $('progressWrap');
  wrap.classList.remove('hidden');
  const percent = total ? Math.round((done / total) * 100) : 0;
  $('progressFill').style.width = `${percent}%`;
  $('progressFill').className = `progress-fill ${done >= total && total > 0 ? 'full' : ''}`;
  $('progressText').textContent = total
    ? `${done}/${total}（${percent}%）${label ? ` · 正在处理：${label}` : ''}`
    : '';
}

async function startCollect() {
  if (state.collecting) return;
  const includePages = $('includePages').checked;
  const docs = [...state.selected.values()];
  if (!docs.length) { toast('warn', '请先在第 1 步勾选资料'); return; }
  const pending = docs.filter((d) => !state.collected.has(d.documentId));
  const cachedDocs = docs.filter((d) => state.collected.has(d.documentId));

  state.collecting = true;
  state.aborted = false;
  $('startCollect').disabled = true;
  $('startCollect').classList.add('hidden');
  $('stopCollect').classList.remove('hidden');
  $('toStep3').classList.add('hidden');
  $('collectResults').innerHTML = cachedDocs.map((doc) => rowHtml({ series: doc.series }, true)).join('');
  setProgress(0, pending.length, '');

  let done = 0;
  let failed = 0;
  const failures = [];
  for (const doc of pending) {
    if (state.aborted) { toast('warn', `已停止：完成 ${done}/${pending.length}，剩余未采`); break; }
    setProgress(done + failed, pending.length, `${doc.vendorName} ${doc.series}`);
    try {
      const payload = await api('/api/collect', {
        method: 'POST',
        body: JSON.stringify({ documentIds: [doc.documentId], includePages }),
      });
      const row = payload.results[0];
      if (row.status === 'completed') {
        done += 1;
        state.collected.add(doc.documentId);
      } else {
        failed += 1;
        failures.push(doc.series);
      }
      $('collectResults').insertAdjacentHTML('beforeend', rowHtml(row));
    } catch (error) {
      failed += 1;
      failures.push(doc.series);
      $('collectResults').insertAdjacentHTML('beforeend', rowHtml({ series: doc.series, status: 'failed', error: error.message }));
    }
    setProgress(done + failed, pending.length, '');
  }

  state.collecting = false;
  $('stopCollect').classList.add('hidden');
  $('startCollect').classList.remove('hidden');
  $('startCollect').disabled = false;
  $('startCollect').textContent = pending.length ? '继续采集（自动跳过已成功）' : '重新采集';
  renderCollectSummary();
  if (done > 0) $('toStep3').classList.remove('hidden');

  if (state.aborted) return;
  if (failed === 0 && done === pending.length && pending.length > 0) {
    toast('success', `采集全部完成：${done} 份成功`);
    setTimeout(() => { if (state.step === 2) goStep(3); }, 900);
  } else if (failed > 0) {
    toast('error', `采集结束：成功 ${done}，失败 ${failed}（${failures.slice(0, 3).join('、')}${failures.length > 3 ? '…' : ''}）`, 6000);
  } else if (pending.length === 0) {
    toast('info', '所选资料均已采集过，可直接进入下一步');
  }
}

/* ---------- 步骤 3：选对比 ---------- */

async function ensureLibrary() {
  try {
    const payload = await api('/api/library');
    state.library = payload.documents;
    state.collected = new Set(payload.documents.map((doc) => doc.documentId));
    return true;
  } catch (error) {
    toast('error', `已采集清单加载失败：${error.message}`);
    return false;
  }
}

async function renderLibrary() {
  const box = $('libraryList');
  if (!state.library.length) {
    box.innerHTML = '<div class="muted empty">还没有已采集的彩页，请回第 1、2 步先采集。</div>';
    return;
  }
  box.innerHTML = state.library.map((doc) => `
    <label class="doc-row ${state.cmpSel.has(doc.documentId) ? 'checked' : ''}" data-id="${esc(doc.documentId)}">
      <input type="checkbox" ${state.cmpSel.has(doc.documentId) ? 'checked' : ''}>
      <span class="vendor-chip">${esc(doc.vendorName)}</span>
      <span class="doc-series">${esc(doc.series)}</span>
      <span class="doc-models">${esc(doc.modelNames.join('、') || '—')}</span>
      <span class="muted small">${doc.pageCount || '?'} 页${doc.warning ? ' · ⚠ 哈希与基线不一致' : ''}${doc.pageMarkdown?.status === 'ok' ? ' · 已保存网页' : ''}</span>
    </label>`).join('');
  box.querySelectorAll('.doc-row').forEach((row) => row.addEventListener('click', () => {
    const id = row.dataset.id;
    if (state.cmpSel.has(id)) state.cmpSel.delete(id); else state.cmpSel.add(id);
    row.classList.toggle('checked', state.cmpSel.has(id));
    row.querySelector('input').checked = state.cmpSel.has(id);
    $('cmpCount').textContent = state.cmpSel.size;
    $('toStep4').disabled = state.cmpSel.size < 2;
  }));
}

/* ---------- 步骤 4：分析 ---------- */

function renderAiMode() {
  const configured = state.aiStatus?.configured;
  $('aiMode').textContent = configured
    ? `AI 已配置（${state.aiStatus.model}）· 参数抽取 + Word 分析将自动生成`
    : 'AI 未配置 · 将导出「AI 材料包」，可整体复制给任意 AI 生成同结构分析';
  $('aiHint').textContent = configured
    ? '取消勾选则只做规则抽取，输出 Excel + 材料包（不调用 AI 接口）。'
    : '如需自动生成 Word 报告：设置环境变量 NVCI_LITE_AI_BASE、NVCI_LITE_AI_KEY、NVCI_LITE_AI_MODEL 后重启。';
  $('useAi').checked = Boolean(configured);
  $('useAi').disabled = !configured;
}

async function startAnalyze() {
  const button = $('startAnalyze');
  if (state.cmpSel.size < 2) { toast('warn', '至少选择 2 个对比产品'); return; }
  button.disabled = true;
  button.textContent = '分析中…（PDF 抽取 + 参数对齐，可能需要 1–3 分钟）';
  $('analyzeResult').innerHTML = '';
  try {
    const payload = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ documentIds: [...state.cmpSel], useAi: $('useAi').checked && !$('useAi').disabled }),
    });
    const wordFailed = payload.files.some((file) => file.kind === 'word_failed');
    $('analyzeResult').innerHTML = `
      <div class="analyze-ok">✔ 完成：对齐 ${payload.paramFieldCount} 个参数字段${payload.aiErrors?.length ? `（${payload.aiErrors.length} 个型号 AI 抽取失败已用规则兜底）` : ''}</div>
      ${payload.files.map((file) => file.kind === 'word_failed'
        ? `<div class="warn">Word 生成失败：${esc(file.error)}（Excel 与材料包仍可用）</div>`
        : `<a class="file-card" href="/api/exports/${encodeURIComponent(file.fileName)}" download>
             <span class="file-icon">${file.kind === 'excel' ? '📊' : file.kind === 'word' ? '📄' : '📦'}</span>
             <span>${esc(file.fileName)}</span>
             <span class="muted small">${file.kind === 'excel' ? 'Excel 参数对照' : file.kind === 'word' ? 'Word 分析报告' : 'AI 材料包 Markdown'}</span>
           </a>`).join('')}`;
    if (wordFailed) toast('warn', '报告已生成，但 Word 部分失败（详见页面说明）', 6000);
    else toast('success', '报告生成完成，可点击文件下载');
    loadExports();
  } catch (error) {
    $('analyzeResult').innerHTML = `<div class="error">${esc(error.message)}</div>`;
    toast('error', `分析失败：${error.message}`, 6000);
  } finally {
    button.disabled = false;
    button.textContent = '生成报告（Excel 参数对照 + Word 分析 / AI 材料包）';
  }
}

async function loadExports() {
  try {
    const payload = await api('/api/exports');
    $('exportList').innerHTML = payload.exports.length
      ? payload.exports.map((file) => `<a class="file-card" href="/api/exports/${encodeURIComponent(file.fileName)}" download>
          <span>${esc(file.fileName)}</span><span class="muted small">${(file.bytes / 1024).toFixed(0)} KB · ${esc(file.createdAt.slice(0, 16).replace('T', ' '))}</span>
        </a>`).join('')
      : '<div class="muted small">暂无导出文件</div>';
  } catch { $('exportList').innerHTML = ''; }
}

/* ---------- 步骤 5：彩页资料探测校验 ---------- */

const probe = {
  pollTimer: null,
  currentRunId: null,
  statusLabels: {},
  lastResults: [],
  wasRunning: false,
  currentState: {},
  sort: { key: 'time', dir: 'desc' },
  page: 1,
  pageSize: 20,
};

// 状态排序权重：正常 < 提示 < 警告 < 异常
const PROBE_SEVERITY = {
  valid_unchanged: 0, baseline_matched: 0, manual_ok: 0,
  new_archived: 1, manual_invalid: 1, paused: 1, vendor_throttled: 1, manual_settled: 1,
  updated: 2, too_large: 2,
  unreachable: 3, redirect_broken: 3, not_pdf: 3, corrupt: 3, network_error: 3,
};

const PROBE_BADGE_CLASS = {
  valid_unchanged: 'ok',
  link_ok: 'info',
  baseline_matched: 'ok',
  updated: 'warn',
  new_archived: 'info',
  unreachable: 'err',
  redirect_broken: 'err',
  not_pdf: 'err',
  corrupt: 'err',
  too_large: 'warn',
  network_error: 'err',
  vendor_throttled: 'info',
  manual_ok: 'ok',
  manual_invalid: 'info',
  paused: 'info',
  manual_settled: 'info',
};

// 需要人工兜底的异常状态
const MANUAL_ELIGIBLE = new Set(['unreachable', 'redirect_broken', 'not_pdf', 'corrupt', 'too_large', 'network_error', 'vendor_throttled']);

function fmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function renderProbeSchedule(schedule, totals, labels) {
  const info = $('probeScheduleInfo');
  if (schedule?.enabled) {
    const next = schedule.nextScheduledAt ? schedule.nextScheduledAt.slice(0, 16).replace('T', ' ') : '计算中';
    info.textContent = `定时校验：每日 ${schedule.schedule} · 下次 ${next}`;
  } else {
    info.textContent = '定时校验未启用（NVCI_LITE_PROBE_ENABLED=true 开启）· 可手动触发';
  }
  const entries = Object.entries(totals || {});
  $('probeTotals').innerHTML = entries.length
    ? entries.map(([key, count]) => `<span class="probe-chip"><span class="badge ${PROBE_BADGE_CLASS[key] || 'info'}">${esc(labels[key] || key)}</span> ${count}</span>`).join('')
    : '<span class="muted small">还没有校验记录，点击「开始校验」建立第一轮哈希档案</span>';
  const filter = $('probeFilter');
  const current = filter.value;
  filter.innerHTML = '<option value="">全部状态</option>'
    + entries.map(([key]) => `<option value="${esc(key)}">${esc(labels[key] || key)}</option>`).join('');
  filter.value = current;
  if (filter.value !== current) filter.value = '';
}

async function fetchStates() {
  try {
    const payload = await api('/api/probe/states');
    probe.currentState = payload.states || {};
    probe.statusLabels = { ...probe.statusLabels, ...payload.stateLabels };
  } catch { /* 静默，下轮再取 */ }
}

// 展示状态：人工裁定/最新档案状态优先于历史运行快照
function displayStatusOf(row) {
  return probe.currentState[row.documentId]?.lastProbeStatus || row.probeStatus;
}

function cmpProbeRows(a, b) {
  const { key, dir } = probe.sort;
  const sign = dir === 'asc' ? 1 : -1;
  let va; let vb;
  if (key === 'status') { va = PROBE_SEVERITY[displayStatusOf(a)] ?? 9; vb = PROBE_SEVERITY[displayStatusOf(b)] ?? 9; }
  else if (key === 'http') { va = a.httpStatus || 0; vb = b.httpStatus || 0; }
  else if (key === 'pages') { va = a.pageCount || 0; vb = b.pageCount || 0; }
  else if (key === 'time') { va = a.checkedAt || ''; vb = b.checkedAt || ''; }
  else if (key === 'vendor') { va = a.vendorName || ''; vb = b.vendorName || ''; }
  else { va = a.series || ''; vb = b.series || ''; }
  if (typeof va === 'string') return va.localeCompare(vb, 'zh-CN') * sign;
  return (va - vb) * sign;
}

function pageList(current, pages) {
  const wanted = new Set([1, pages, current - 1, current, current + 1]);
  const list = [...wanted].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of list) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

function renderProbeResults(results) {
  probe.lastResults = results || [];
  const filter = $('probeFilter').value;
  const needle = $('probeSearch').value.trim().toLowerCase();
  const rows = probe.lastResults.filter((row) => {
    const display = displayStatusOf(row);
    return (!filter || display === filter)
      && (!needle || `${row.vendorName} ${row.series} ${row.officialFileName}`.toLowerCase().includes(needle));
  }).sort(cmpProbeRows);
  const total = rows.length;
  const size = probe.pageSize;
  const pages = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
  if (probe.page > pages) probe.page = pages;
  const startNo = size > 0 ? (probe.page - 1) * size : 0;
  const pageRows = size > 0 ? rows.slice(startNo, startNo + size) : rows;

  const arrow = (key) => (probe.sort.key === key
    ? (probe.sort.dir === 'asc' ? '<span class="sort-on">▲</span>' : '<span class="sort-on">▼</span>')
    : '<span class="sort-idle">⇅</span>');
  const th = (key, label) => `<th class="sortable" data-sort="${key}">${label} ${arrow(key)}</th>`;

  const bodyRows = pageRows.map((row) => {
    const current = probe.currentState[row.documentId];
    const display = displayStatusOf(row);
    const changed = display !== row.probeStatus;
    const sha = current?.sha256 || row.sha256;
    const sizeText = sha ? `SHA ${esc(String(sha).slice(0, 10))}…` : (row.contentLength ? fmtBytes(row.contentLength) : '—');
    const notes = [
      row.warning ? '⚠ 与基线不一致' : '',
      (row.urlOverridden || current?.urlOverride) ? '🔧 链接已人工修正' : '',
      changed ? `本轮记录：${esc(probe.statusLabels[row.probeStatus] || row.probeStatus)}` : '',
      current?.manualNote ? `<span class="tag" title="${esc(current.manualNote)}">✍ ${esc(current.manualNote)}</span>` : '',
      current?.manualSettled ? '<span class="muted small">自动巡检跳过</span>' : '',
      row.detail ? (changed ? '<span class="error" title="' + esc(row.detail) + '">历史异常</span>' : `<span class="error">${esc(row.detail)}</span>`) : '',
    ].filter(Boolean).join(' ');
    const timeText = String(row.checkedAt).slice(0, 16).replace('T', ' ');
    return `<tr>
      <td><span class="badge ${PROBE_BADGE_CLASS[display] || 'info'}">${esc(probe.statusLabels[display] || display)}</span></td>
      <td>${esc(row.vendorName)}</td>
      <td title="${esc(row.officialFileName || '')}">${esc(row.series)}</td>
      <td>${row.httpStatus || '—'}</td>
      <td>${row.pageCount || '—'}</td>
      <td class="mono">${sizeText}</td>
      <td class="nowrap">${timeText}</td>
      <td class="probe-notes">${notes || '—'}</td>
      <td>${(MANUAL_ELIGIBLE.has(display) || current?.manualSettled) ? `<button class="btn mini manual-btn" data-id="${esc(row.documentId)}">人工校验</button>` : ''}</td>
    </tr>`;
  }).join('');

  const rangeText = total === 0 ? '共 0 条' : `第 ${startNo + 1}-${Math.min(startNo + (size > 0 ? size : total), total)} 条，共 ${total} 条`;
  const pagerBtns = size > 0 ? [
    `<button class="pg" data-page="1" ${probe.page <= 1 ? 'disabled' : ''}>«</button>`,
    `<button class="pg" data-page="${probe.page - 1}" ${probe.page <= 1 ? 'disabled' : ''}>‹</button>`,
    ...pageList(probe.page, pages).map((p) => (p === '…'
      ? '<span class="pg-ellipsis">…</span>'
      : `<button class="pg ${p === probe.page ? 'active' : ''}" data-page="${p}">${p}</button>`)),
    `<button class="pg" data-page="${probe.page + 1}" ${probe.page >= pages ? 'disabled' : ''}>›</button>`,
    `<button class="pg" data-page="${pages}" ${probe.page >= pages ? 'disabled' : ''}>»</button>`,
  ].join('') : '';

  $('probeResults').innerHTML = `
    <table class="probe-table">
      <thead><tr>
        ${th('status', '状态')}${th('vendor', '品牌')}${th('series', '系列')}${th('http', 'HTTP')}${th('pages', '页数')}<th>大小 / SHA-256</th>${th('time', '检查时间')}
        <th>备注</th><th>操作</th>
      </tr></thead>
      <tbody>${bodyRows || '<tr><td colspan="9" class="muted empty">没有符合筛选条件的记录</td></tr>'}</tbody>
    </table>
    <div class="pager">
      <label class="muted small">每页
        <select id="pgSize">
          <option value="20" ${probe.pageSize === 20 ? 'selected' : ''}>20</option>
          <option value="50" ${probe.pageSize === 50 ? 'selected' : ''}>50</option>
          <option value="100" ${probe.pageSize === 100 ? 'selected' : ''}>100</option>
          <option value="0" ${probe.pageSize === 0 ? 'selected' : ''}>全部</option>
        </select>
      </label>
      <span class="muted small">${rangeText}</span>
      <div class="pager-btns">${pagerBtns}</div>
    </div>`;

  $('probeResults').querySelectorAll('th.sortable').forEach((el) => el.addEventListener('click', () => {
    const key = el.dataset.sort;
    if (probe.sort.key === key) probe.sort.dir = probe.sort.dir === 'asc' ? 'desc' : 'asc';
    else probe.sort = { key, dir: key === 'time' ? 'desc' : 'asc' };
    probe.page = 1;
    renderProbeResults(probe.lastResults);
  }));
  $('probeResults').querySelectorAll('.manual-btn').forEach((btn) => btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const row = probe.lastResults.find((item) => item.documentId === btn.dataset.id);
    if (row) openManualDlg(row.documentId);
  }));
  const pgSize = $('pgSize');
  if (pgSize) pgSize.addEventListener('change', () => {
    probe.pageSize = Number(pgSize.value) || 0;
    probe.page = 1;
    renderProbeResults(probe.lastResults);
  });
  $('probeResults').querySelectorAll('.pg[data-page]').forEach((btn) => btn.addEventListener('click', () => {
    probe.page = Number(btn.dataset.page);
    renderProbeResults(probe.lastResults);
  }));
}

/* ---------- 历史校验：可排序表格 + 分页 ---------- */

const history = { rows: [], sort: { key: 'startedAt', dir: 'desc' }, page: 1, pageSize: 10 };

function historyStatusOf(run) {
  if (!run.finishedAt) return 'running';
  return run.stopReason ? 'stopped' : 'done';
}

function cmpHistoryRows(a, b) {
  const { key, dir } = history.sort;
  const sign = dir === 'asc' ? 1 : -1;
  let va; let vb;
  if (key === 'count') { va = a.resultCount ?? a.scope ?? 0; vb = b.resultCount ?? b.scope ?? 0; }
  else if (key === 'status') { const rank = { running: 0, stopped: 1, done: 2 }; va = rank[historyStatusOf(a)] ?? 9; vb = rank[historyStatusOf(b)] ?? 9; }
  else if (key === 'trigger') { va = a.trigger || ''; vb = b.trigger || ''; }
  else if (key === 'mode') { va = a.mode || ''; vb = b.mode || ''; }
  else { va = a.startedAt || ''; vb = b.startedAt || ''; }
  if (typeof va === 'string') return va.localeCompare(vb, 'zh-CN') * sign;
  return (va - vb) * sign;
}

function renderRunsTable() {
  const rows = (history.rows || []).slice().sort(cmpHistoryRows);
  const total = rows.length;
  const size = history.pageSize;
  const pages = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
  if (history.page > pages) history.page = pages;
  const startNo = size > 0 ? (history.page - 1) * size : 0;
  const pageRows = size > 0 ? rows.slice(startNo, startNo + size) : rows;

  const arrow = (key) => (history.sort.key === key
    ? (history.sort.dir === 'asc' ? '<span class="sort-on">▲</span>' : '<span class="sort-on">▼</span>')
    : '<span class="sort-idle">⇅</span>');
  const th = (key, label) => `<th class="sortable" data-sort="${key}">${label} ${arrow(key)}</th>`;

  const bodyRows = pageRows.map((run) => {
    const status = historyStatusOf(run);
    const statusLabel = status === 'running' ? '运行中' : status === 'stopped' ? '已停止' : '完成';
    const badge = status === 'running' ? 'warn' : status === 'stopped' ? 'info' : 'ok';
    return `<tr>
      <td class="nowrap">${esc(String(run.startedAt).slice(0, 16).replace('T', ' '))}</td>
      <td>${run.trigger === 'scheduled' ? '定时' : '手动'}</td>
      <td>${run.mode === 'light' ? '轻量' : '完整'}</td>
      <td>${run.resultCount ?? run.scope ?? 0}</td>
      <td><span class="badge ${badge}">${statusLabel}</span>${run.stopReason ? `<div class="muted small" title="${esc(run.stopReason)}">${esc(run.stopReason.slice(0, 18))}…</div>` : ''}</td>
      <td><button class="btn mini run-view" data-run="${esc(run.runId)}">查看</button></td>
    </tr>`;
  }).join('');

  const rangeText = total === 0 ? '共 0 轮' : `第 ${startNo + 1}-${Math.min(startNo + (size > 0 ? size : total), total)} 轮，共 ${total} 轮`;
  const pagerBtns = size > 0 ? [
    `<button class="pg" data-page="1" ${history.page <= 1 ? 'disabled' : ''}>«</button>`,
    `<button class="pg" data-page="${history.page - 1}" ${history.page <= 1 ? 'disabled' : ''}>‹</button>`,
    ...pageList(history.page, pages).map((p) => (p === '…'
      ? '<span class="pg-ellipsis">…</span>'
      : `<button class="pg ${p === history.page ? 'active' : ''}" data-page="${p}">${p}</button>`)),
    `<button class="pg" data-page="${history.page + 1}" ${history.page >= pages ? 'disabled' : ''}>›</button>`,
    `<button class="pg" data-page="${pages}" ${history.page >= pages ? 'disabled' : ''}>»</button>`,
  ].join('') : '';

  $('probeRuns').innerHTML = `
    <table class="probe-table">
      <thead><tr>
        ${th('startedAt', '开始时间')}${th('trigger', '触发方式')}${th('mode', '模式')}${th('count', '资料数')}${th('status', '状态')}
        <th>操作</th>
      </tr></thead>
      <tbody>${bodyRows || '<tr><td colspan="6" class="muted empty">暂无历史校验</td></tr>'}</tbody>
    </table>
    <div class="pager">
      <label class="muted small">每页
        <select id="runPgSize">
          <option value="10" ${history.pageSize === 10 ? 'selected' : ''}>10</option>
          <option value="20" ${history.pageSize === 20 ? 'selected' : ''}>20</option>
          <option value="30" ${history.pageSize === 30 ? 'selected' : ''}>30</option>
          <option value="0" ${history.pageSize === 0 ? 'selected' : ''}>全部</option>
        </select>
      </label>
      <span class="muted small">${rangeText}</span>
      <div class="pager-btns">${pagerBtns}</div>
      <span class="muted small">明细仅保留最近 5 轮，更早轮次只可看摘要</span>
    </div>`;

  $('probeRuns').querySelectorAll('th.sortable').forEach((el) => el.addEventListener('click', () => {
    const key = el.dataset.sort;
    if (history.sort.key === key) history.sort.dir = history.sort.dir === 'asc' ? 'desc' : 'asc';
    else history.sort = { key, dir: key === 'startedAt' ? 'desc' : 'asc' };
    history.page = 1;
    renderRunsTable();
  }));
  const runPgSize = $('runPgSize');
  if (runPgSize) runPgSize.addEventListener('change', () => {
    history.pageSize = Number(runPgSize.value) || 0;
    history.page = 1;
    renderRunsTable();
  });
  $('probeRuns').querySelectorAll('.pg[data-page]').forEach((btn) => btn.addEventListener('click', () => {
    history.page = Number(btn.dataset.page);
    renderRunsTable();
  }));
  $('probeRuns').querySelectorAll('.run-view').forEach((btn) => btn.addEventListener('click', async () => {
    const run = history.rows.find((item) => item.runId === btn.dataset.run);
    if (!run) return;
    try {
      const detail = await api(`/api/probe/runs/${encodeURIComponent(run.runId)}`);
      probe.currentRunId = run.runId;
      renderProbeResults(detail.results || []);
      const totalCount = Object.values(detail.totals || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      if (totalCount > 0 && (!detail.results || !detail.results.length)) {
        toast('info', '该轮明细已归档（仅保留最近 5 轮完整明细）', 5000);
      }
      $('probeRuns').querySelectorAll('.run-view').forEach((el) => el.classList.toggle('active', el.dataset.run === run.runId));
    } catch (error) { toast('error', `加载校验记录失败：${error.message}`); }
  }));
}

async function loadProbeRuns() {
  try {
    const payload = await api('/api/probe/runs');
    history.rows = payload.runs;
    renderRunsTable();
  } catch { $('probeRuns').innerHTML = '<div class="muted small">历史校验加载失败</div>'; }
}

async function pollProbe() {
  clearTimeout(probe.pollTimer);
  probe.pollTimer = null;
  try {
    const status = await api('/api/probe/status');
    probe.statusLabels = status.stateLabels || probe.statusLabels;
    renderProbeSchedule(status.schedule, status.totalsByStatus, probe.statusLabels);
    if (status.running) {
      probe.wasRunning = true;
      $('startProbe').disabled = true;
      $('stopProbe').classList.remove('hidden');
      const p = status.progress || {};
      const percent = p.total ? Math.round((p.index / p.total) * 100) : 0;
      $('probeProgressWrap').classList.remove('hidden');
      $('probeProgressFill').style.width = `${percent}%`;
      $('probeProgressFill').className = `progress-fill ${p.index >= p.total && p.total > 0 ? 'full' : ''}`;
      $('probeProgressText').textContent = `${p.index || 0}/${p.total || '?'}（${percent}%）· 正在校验：${p.vendorName || ''} ${p.series || ''}`;
      probe.pollTimer = setTimeout(pollProbe, 2000);
      return;
    }
    $('startProbe').disabled = false;
    $('stopProbe').classList.add('hidden');
    $('probeProgressWrap').classList.add('hidden');
    if (probe.wasRunning) {
      probe.wasRunning = false;
      if (status.lastRun) {
        probe.currentRunId = status.lastRun.runId;
        const summary = Object.entries(status.lastRun.totals || {}).map(([key, count]) => `${probe.statusLabels[key] || key} ${count}`).join('，');
        toast('success', `校验完成：${summary || '无结果'}`, 6000);
      }
      loadProbeRuns();
      await refreshRunResults();
      refreshAlerts();
    }
    probe.pollTimer = setTimeout(pollProbe, 8000);
  } catch {
    probe.pollTimer = setTimeout(pollProbe, 8000);
  }
}

async function refreshRunResults() {
  await fetchStates();
  if (!probe.currentRunId) { renderProbeResults([]); return; }
  try {
    const run = await api(`/api/probe/runs/${encodeURIComponent(probe.currentRunId)}`);
    renderProbeResults(run.results || []);
  } catch { renderProbeResults([]); }
}

async function renderProbe() {
  // 品牌下拉（保留「仅上次异常项」）
  const scope = $('probeScope');
  const current = scope.value || 'all';
  const vendors = (state.catalog?.vendors || []).map((vendor) => `<option value="${esc(vendor.vendorId)}">${esc(vendor.vendorName)}（${vendor.productLines.reduce((sum, line) => sum + line.documentCount, 0)} 条）</option>`).join('');
  scope.innerHTML = '<option value="all">全部品牌</option>' + vendors + '<option value="__failed__">仅上次异常项</option>';
  scope.value = [...scope.options].some((option) => option.value === current) ? current : 'all';
  $('probeFilter').oninput = () => { probe.page = 1; renderProbeResults(probe.lastResults); };
  $('probeSearch').oninput = () => { probe.page = 1; renderProbeResults(probe.lastResults); };
  await pollProbe();
  await loadProbeRuns();
  await refreshRunResults();
}

async function startProbe() {
  const scope = $('probeScope').value;
  const body = { mode: $('probeMode').value };
  if (scope === '__failed__') body.onlyFailed = true;
  else if (scope !== 'all') body.vendorId = scope;
  try {
    const payload = await api('/api/probe/start', { method: 'POST', body: JSON.stringify(body) });
    probe.currentRunId = payload.runId;
    probe.wasRunning = true;
    renderProbeResults([]);
    toast('info', `校验已启动：${payload.total} 条（${payload.mode === 'light' ? '轻量探测' : '完整校验'}），后台运行中`);
    clearTimeout(probe.pollTimer);
    probe.pollTimer = null;
    pollProbe();
  } catch (error) {
    toast('error', `校验启动失败：${error.message}`, 6000);
  }
}

/* ---------- 人工校验对话框 ---------- */

const manual = { documentId: null };

async function openManualDlg(documentId) {
  manual.documentId = documentId;
  let info;
  try { info = await api(`/api/probe/docinfo/${encodeURIComponent(documentId)}`); }
  catch (error) { toast('error', `加载资料详情失败：${error.message}`); return; }
  const probeInfo = info.probe || {};
  const statusLabel = probeInfo.lastProbeStatus ? (probe.statusLabels[probeInfo.lastProbeStatus] || probeInfo.lastProbeStatus) : '未校验';
  const badgeClass = PROBE_BADGE_CLASS[probeInfo.lastProbeStatus] || 'info';
  $('manualDlg').innerHTML = `
    <div class="dlg-head">
      <span>人工校验 · ${esc(info.vendorName)} ${esc(info.series)}</span>
      <button class="dlg-x" id="mClose" title="关闭">×</button>
    </div>
    <div class="dlg-body">
      <div class="dlg-state">当前状态：<span class="badge ${badgeClass}">${esc(statusLabel)}</span>
        ${probeInfo.lastDetail ? `<span class="muted small">${esc(probeInfo.lastDetail)}</span>` : ''}
        ${probeInfo.manualSettled ? '<span class="tag">人工已裁定 · 自动巡检跳过中</span>' : ''}
      </div>
      <div class="dlg-field">
        <span class="dlg-label">官方登记地址</span>
        <a href="${esc(info.pdfUrl)}" target="_blank" rel="noopener">浏览器打开验证 ↗</a>
        <span class="muted small">${esc(info.officialFileName)}</span>
      </div>
      ${probeInfo.urlOverride ? `<div class="warn small">🔧 已人工修正为：${esc(probeInfo.urlOverride)}（${esc(probeInfo.urlOverrideAt || '').slice(0, 16).replace('T', ' ')}）</div>` : ''}
      <div class="dlg-sec">
        <button class="btn primary" id="mRetry">立即重测（完整校验）</button>
        <span class="muted small">自动跑一遍 HEAD → 下载 → 签名 → SHA-256 建档</span>
      </div>
      <div class="dlg-sec">
        <div class="dlg-sec-title">修正链接</div>
        <div class="dlg-row">
          <input type="url" id="mUrl" placeholder="粘贴新的官网 PDF 地址（HTTPS）">
          <button class="btn" id="mUrlGo">保存并校验</button>
        </div>
        <div class="muted small">原地址失效时使用；仅允许 HTTPS，登记后自动重测，重定向仍受白名单约束</div>
      </div>
      <div class="dlg-sec">
        <div class="dlg-sec-title">上传本机下载的 PDF</div>
        <div class="dlg-row">
          <input type="file" id="mFile" accept="application/pdf,.pdf">
          <button class="btn" id="mFileGo">上传并校验</button>
        </div>
        <div class="muted small">站点完全打不开时：你在浏览器手动下载后上传，系统做签名/页数/SHA-256 校验并建档（与基线比对）</div>
      </div>
      <div class="dlg-sec">
        <div class="dlg-sec-title">人工裁定</div>
        <div class="dlg-row">
          <select id="mMark">
            <option value="manual_ok">人工确认有效</option>
            <option value="manual_invalid">人工确认失效（无素材）</option>
            <option value="paused">暂缓跟踪</option>
          </select>
          <input type="text" id="mNote" placeholder="备注：谁确认的 / 依据（选填）">
          <button class="btn" id="mMarkGo">提交裁定</button>
        </div>
        <div class="muted small">裁定后自动巡检跳过该条，不再产生告警；「立即重测」可解除</div>
      </div>
      <div id="mResult"></div>
    </div>`;
  $('manualMask').classList.remove('hidden');

  $('mClose').addEventListener('click', closeManualDlg);
  $('mRetry').addEventListener('click', () => manualAction(api('/api/probe/retry', { method: 'POST', body: JSON.stringify({ documentId }) })));
  $('mUrlGo').addEventListener('click', () => {
    const url = $('mUrl').value.trim();
    if (!url) { toast('warn', '请先粘贴新链接'); return; }
    manualAction(api(`/api/probe/manual/${encodeURIComponent(documentId)}/url`, { method: 'POST', body: JSON.stringify({ url }) }));
  });
  $('mFileGo').addEventListener('click', async () => {
    const file = $('mFile').files[0];
    if (!file) { toast('warn', '请先选择 PDF 文件'); return; }
    if (file.size > 50 * 1024 * 1024) { toast('warn', '文件超过 50MB 上限'); return; }
    try {
      const buffer = await file.arrayBuffer();
      const response = await fetch(`/api/probe/manual/${encodeURIComponent(documentId)}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buffer,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      showManualResult(payload, payload.stateLabels);
      await afterManualAction();
    } catch (error) {
      showManualResult({ error: error.message });
      toast('error', `上传校验失败：${error.message}`, 6000);
    }
  });
  $('mMarkGo').addEventListener('click', () => {
    const mark = $('mMark').value;
    const note = $('mNote').value.trim();
    manualAction(api(`/api/probe/manual/${encodeURIComponent(documentId)}/status`, { method: 'POST', body: JSON.stringify({ mark, note }) }));
  });
}

function showManualResult(payload, labels) {
  const box = $('mResult');
  if (!box) return;
  if (payload.error) { box.innerHTML = `<div class="error">✘ ${esc(payload.error)}</div>`; return; }
  const label = labels?.[payload.probeStatus] || probe.statusLabels?.[payload.probeStatus] || payload.probeStatus || '';
  const badge = PROBE_BADGE_CLASS[payload.probeStatus] || 'info';
  box.innerHTML = `<div class="analyze-ok">✔ 校验完成：<span class="badge ${badge}">${esc(label)}</span>
    ${payload.pageCount ? `· ${payload.pageCount} 页` : ''}
    ${payload.sha256 ? `· SHA-256 ${esc(payload.sha256.slice(0, 12))}…` : ''}
    ${payload.warning ? `<div class="warn small">${esc(payload.warning)}</div>` : ''}
    ${payload.note ? `<div class="muted small">${esc(payload.note)}</div>` : ''}
  </div>`;
}

async function manualAction(promise) {
  const box = $('mResult');
  if (box) box.innerHTML = '<div class="muted small">执行中…（完整校验可能需要几十秒）</div>';
  try {
    const payload = await promise;
    showManualResult(payload, payload.stateLabels);
    await afterManualAction();
  } catch (error) {
    showManualResult({ error: error.message });
    toast('error', error.message, 6000);
  }
}

async function afterManualAction() {
  probe.wasRunning = false;
  await refreshRunResults();
  loadProbeRuns();
  refreshAlerts();
}

function closeManualDlg() {
  $('manualMask').classList.add('hidden');
  $('manualDlg').innerHTML = '';
  manual.documentId = null;
}

/* ---------- 批量导入：多选 PDF 按文件名匹配资料 ---------- */

const batch = { files: [], plan: [], running: false };

function openBatchDlg() {
  batch.files = [];
  batch.plan = [];
  batch.running = false;
  $('batchDlg').innerHTML = `
    <div class="dlg-head"><span>批量导入 PDF · 按文件名自动匹配资料</span><button class="dlg-x" id="bClose">×</button></div>
    <div class="dlg-body">
      <div class="dlg-sec">
        <div class="dlg-row">
          <input type="file" id="bFiles" multiple accept="application/pdf,.pdf">
          <button class="btn primary" id="bMatch">匹配资料</button>
        </div>
        <div class="muted small">选择一个或多个 PDF（建议用官网原始文件名），系统按登记文件名 / 系列 / 型号自动匹配并给出候选与理由；你可改选后逐个上传。上传走与单个上传相同的签名 + 页数 + SHA-256 校验，自动与基线比对建档。</div>
      </div>
      <div id="bPlan"></div>
      <div class="dlg-row hidden" id="bGoRow">
        <button class="btn primary" id="bGo">开始导入（0 份）</button>
        <span class="muted small" id="bProgress"></span>
      </div>
      <div id="bResult"></div>
    </div>`;
  $('batchMask').classList.remove('hidden');
  $('bClose').addEventListener('click', closeBatchDlg);
  $('bMatch').addEventListener('click', matchBatchFiles);
  $('bGo').addEventListener('click', runBatchUpload);
}

function closeBatchDlg() {
  if (batch.running) { toast('warn', '批量导入进行中，请等待完成'); return; }
  $('batchMask').classList.add('hidden');
  $('batchDlg').innerHTML = '';
}

async function matchBatchFiles() {
  const files = [...$('bFiles').files];
  if (!files.length) { toast('warn', '请先选择 PDF 文件'); return; }
  batch.files = files;
  $('bPlan').innerHTML = '<div class="muted small">匹配中…</div>';
  try {
    const payload = await api('/api/probe/manual/match', {
      method: 'POST',
      body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
    });
    batch.plan = payload.results.map((item) => ({
      ...item,
      file: files.find((file) => file.name === item.fileName),
      assign: item.auto || '',
      status: '',
    }));
    renderBatchPlan();
  } catch (error) {
    $('bPlan').innerHTML = `<div class="error">匹配失败：${esc(error.message)}</div>`;
  }
}

function renderBatchPlan() {
  const rows = batch.plan.map((item, index) => {
    const options = item.candidates.map((candidate) => `
      <option value="${esc(candidate.documentId)}" ${candidate.documentId === item.assign ? 'selected' : ''}>
        ${esc(candidate.vendorName)} · ${esc(candidate.series)}（${candidate.score} 分：${esc(candidate.reasons.join('、') || '低置信')}）
      </option>`).join('');
    let statusHtml = '';
    if (item.status === 'ok') statusHtml = `<span class="badge ok">${esc(item.resultLabel || '已导入')}</span>`;
    else if (item.status === 'fail') statusHtml = `<span class="error">${esc(item.error || '失败')}</span>`;
    else if (item.status === 'skip') statusHtml = '<span class="muted small">已跳过</span>';
    return `<div class="batch-row" data-idx="${index}">
      <div class="batch-file" title="${esc(item.fileName)}">${esc(item.fileName)}</div>
      <select class="batch-assign" data-idx="${index}">
        <option value="">— 跳过 —</option>
        ${options || '<option value="">无匹配候选（可尝试改用官网原文件名）</option>'}
      </select>
      <div class="batch-status">${statusHtml}</div>
    </div>`;
  }).join('');
  $('bPlan').innerHTML = rows || '<div class="muted small">无文件</div>';
  $('bPlan').querySelectorAll('.batch-assign').forEach((sel) => sel.addEventListener('change', () => {
    batch.plan[Number(sel.dataset.idx)].assign = sel.value;
    updateBatchGo();
  }));
  updateBatchGo();
}

function updateBatchGo() {
  const assigned = batch.plan.filter((item) => item.assign).length;
  $('bGoRow').classList.toggle('hidden', batch.plan.length === 0);
  $('bGo').disabled = assigned === 0 || batch.running;
  $('bGo').textContent = `开始导入（${assigned} 份）`;
}

async function runBatchUpload() {
  if (batch.running) return;
  const jobs = batch.plan.filter((item) => item.assign);
  if (!jobs.length) { toast('warn', '没有已指派资料的文件'); return; }
  batch.running = true;
  updateBatchGo();
  let done = 0;
  for (const job of jobs) {
    if (batch.plan.find((p) => p.fileName === job.fileName && p.assign === job.assign).status === 'ok') { done += 1; continue; }
    $('bProgress').textContent = `${done + 1}/${jobs.length} · ${job.fileName}`;
    try {
      const buffer = await job.file.arrayBuffer();
      const response = await fetch(`/api/probe/manual/${encodeURIComponent(job.assign)}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buffer,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      job.status = 'ok';
      job.resultLabel = (payload.stateLabels?.[payload.probeStatus] || probe.statusLabels[payload.probeStatus] || payload.probeStatus) + (payload.pageCount ? ` · ${payload.pageCount}页` : '');
    } catch (error) {
      job.status = 'fail';
      job.error = error.message;
    }
    done += 1;
    renderBatchPlan();
  }
  batch.running = false;
  $('bProgress').textContent = '';
  updateBatchGo();
  const okCount = batch.plan.filter((item) => item.status === 'ok').length;
  const failCount = batch.plan.filter((item) => item.status === 'fail').length;
  $('bResult').innerHTML = `<div class="analyze-ok">批量导入完成：成功 ${okCount}，失败 ${failCount}${failCount ? '（原因见各行）' : ''}。建档后可在第 3 步直接选入对比。</div>`;
  toast(okCount ? 'success' : 'error', `批量导入完成：成功 ${okCount}，失败 ${failCount}`, 6000);
  await afterManualAction();
}

/* ---------- 登录与初始化 ---------- */

async function init() {
  try {
    const session = await api('/api/session');
    if (session.authRequired && !session.authenticated) {
      $('loginMask').classList.remove('hidden');
      return;
    }
  } catch { /* 忽略，继续加载 */ }
  await boot();
}

async function boot() {
  $('loginMask').classList.add('hidden');
  try {
    const [catalog, aiStatus, library] = await Promise.all([api('/api/catalog'), api('/api/ai-status'), api('/api/library')]);
    state.catalog = catalog;
    state.aiStatus = aiStatus;
    state.library = library.documents;
    state.collected = new Set(library.documents.map((doc) => doc.documentId));
  } catch (error) {
    $('catalogTree').innerHTML = `<div class="error">目录加载失败：${esc(error.message)}</div>`;
    return;
  }
  $('aiBadge').textContent = state.aiStatus.configured ? `AI · ${state.aiStatus.model}` : 'AI 未配置';
  $('aiBadge').classList.toggle('on', state.aiStatus.configured);
  // 默认展开第一个品牌并选中其第一条产品线
  if (state.catalog.vendors.length) {
    state.currentVendorId = state.catalog.vendors[0].vendorId;
    state.currentProfileId = state.catalog.vendors[0].productLines[0].profileId;
    state.expanded.add(state.currentVendorId);
  }
  renderTree();
  renderDocTable();
  updateTray();
  refreshStepBar();
  refreshAlerts();
  setInterval(refreshAlerts, 60000);
}

$('loginBtn').addEventListener('click', async () => {
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('passwordInput').value }) });
    $('loginError').textContent = '';
    boot();
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});
$('passwordInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('loginBtn').click(); });

document.querySelectorAll('.step').forEach((el) => el.addEventListener('click', () => goStep(Number(el.dataset.step))));
$('docSearch').addEventListener('input', (event) => renderDocTable(event.target.value));
$('toStep2').addEventListener('click', () => goStep(2));
$('backToStep1').addEventListener('click', () => goStep(1));
$('startCollect').addEventListener('click', startCollect);
$('stopCollect').addEventListener('click', () => { state.aborted = true; $('stopCollect').disabled = true; setTimeout(() => { $('stopCollect').disabled = false; }, 1500); });
$('toStep3').addEventListener('click', () => goStep(3));
$('backToStep2').addEventListener('click', () => goStep(2));
$('gotoStep1').addEventListener('click', () => goStep(1));
$('toStep4').addEventListener('click', () => goStep(4));
$('backToStep3').addEventListener('click', () => goStep(3));
$('startAnalyze').addEventListener('click', startAnalyze);
$('startProbe').addEventListener('click', startProbe);
$('stopProbe').addEventListener('click', () => { api('/api/probe/stop', { method: 'POST', body: '{}' }).catch(() => {}); toast('info', '已请求停止，当前这条校验完成后退出'); });
$('alertBell').addEventListener('click', () => {
  alerts.open = !alerts.open;
  $('alertPanel').classList.toggle('hidden', !alerts.open);
  if (alerts.open) refreshAlerts();
});
document.addEventListener('click', (event) => {
  if (!alerts.open) return;
  if (event.target.closest('#alertBell') || event.target.closest('#alertPanel')) return;
  alerts.open = false;
  $('alertPanel').classList.add('hidden');
});
$('batchBtn').addEventListener('click', openBatchDlg);
$('manualMask').addEventListener('click', (event) => { if (event.target === $('manualMask')) closeManualDlg(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('manualMask').classList.contains('hidden')) closeManualDlg(); });
$('probeBack').addEventListener('click', () => goStep(1));
$('restart').addEventListener('click', () => {
  state.selected.clear();
  state.cmpSel.clear();
  updateTray();
  $('cmpCount').textContent = '0';
  $('toStep4').disabled = true;
  goStep(1);
  toast('info', '已重置选择，可重新开始一轮对比');
});

init();
