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
  libraryFilter: '',     // 第 3 步品类筛选（空 = 全部）
  matrix: null,          // 最近一次分析的参数矩阵（网页人工核对用）
  thresholds: [],        // 项目门槛行 {fieldKey, op, value}
  fieldTemplate: null,   // 固定字段字典（门槛下拉），进入第 4 步时加载
  collecting: false,
  aborted: false,
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload; // 校验类错误带 errors[] 逐条展示
    throw error;
  }
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
  if (step === 4) { renderAiMode(); loadExports(); loadFieldTemplate(); renderMatrix(); }
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
      <div class="tree-line ${line.profileId === state.currentProfileId ? 'active' : ''}" role="button" tabindex="0" data-vendor="${esc(vendor.vendorId)}" data-profile="${esc(line.profileId)}">
        <span class="tree-line-name">${esc(line.displayName)}${line.custom ? `<span class="tree-custom-tag" title="${esc(t('profile.customTip'))}">${esc(t('profile.customTag'))}</span>` : ''}</span>${line.documentCount ? `<span class="tree-count">${line.documentCount}</span>` : `<span class="tree-count pending-tag">${t('common.pending')}</span>`}
        ${line.custom ? `<span class="tree-line-ops"><button class="tree-op edit" data-op="edit" title="${esc(t('common.edit'))}">✎</button><button class="tree-op del" data-op="del" title="${esc(t('common.delete'))}">×</button></span>` : ''}
      </div>`).join('');
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
  tree.querySelectorAll('.tree-line').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentVendorId = btn.dataset.vendor;
      state.currentProfileId = btn.dataset.profile;
      state.expanded.add(btn.dataset.vendor);
      renderTree();
      renderDocTable($('docSearch').value);
    });
    // div[role=button] 需补键盘激活（原生 button 的等价行为）
    btn.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); btn.click(); }
    });
  });
  // 自定义产品线：编辑带出表单，删除需确认（内置产品线无此操作按钮）
  tree.querySelectorAll('.tree-op').forEach((btn) => btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const profileId = btn.closest('.tree-line').dataset.profile;
    if (btn.dataset.op === 'edit') await openProfileDlg(profileId);
    else await removeCustomProfile(profileId);
  }));
}

function renderDocTable(filter = '') {
  const line = currentLine();
  if (!line) { $('docTable').innerHTML = `<div class="muted empty">${t('step1.pickFirst')}</div>`; $('lineInfo').textContent = ''; return; }
  const needle = filter.trim().toLowerCase();
  const docs = line.documents.filter((doc) => !needle
    || `${doc.series} ${doc.modelNames.join(' ')} ${doc.officialFileName} ${doc.description || ''}`.toLowerCase().includes(needle));
  $('lineInfo').textContent = `${vendorOf(state.currentVendorId).vendorName} · ${line.displayName} · ${line.documents.length} ${t('step1.docCount')}`;
  if (!line.documents.length) {
    $('docTable').innerHTML = `<div class="muted empty">${t('common.pending')} · ${esc(line.displayName)}<br><span class="small">${t('step1.pickFirst')}</span></div>`;
    return;
  }
  if (!docs.length) { $('docTable').innerHTML = `<div class="muted empty">${t('step1.noMatch')}</div>`; return; }
  const rows = docs.map((doc) => {
    const checked = state.selected.has(doc.documentId);
    const collected = state.collected.has(doc.documentId);
    const tags = [
      collected ? `<span class="badge st-pos">● ${t('common.collected')}</span>` : '',
      doc.pdfUrl ? '<span class="tag dim">PDF</span>' : '',
      doc.productPageUrl ? '<span class="tag dim">WEB</span>' : '',
    ].filter(Boolean).join(' ');
    return `<tr class="doc-tr ${checked ? 'checked' : ''}" data-id="${esc(doc.documentId)}">
      <td><input type="checkbox" ${checked ? 'checked' : ''}></td>
      <td>${esc(doc.series)}</td>
      <td class="mono">${esc(doc.modelNames.join('、') || '—')}</td>
      <td>${tags}</td>
      <td class="doc-desc" title="${esc(doc.description || '')}">${esc(doc.description || '')}</td>
    </tr>`;
  }).join('');
  $('docTable').innerHTML = `
    <table class="probe-table doc-table">
      <thead><tr>
        <th></th><th>${t('common.series')}</th><th>${t('common.model')}</th>
        <th>${t('common.status')}</th><th>${t('common.description')}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  enhanceResizable($('docTable'), 'catalog');
  $('docTable').querySelectorAll('.doc-tr').forEach((tr) => tr.addEventListener('click', (event) => {
    if (event.target.tagName === 'INPUT') return;
    toggleDocSelect(tr.dataset.id);
  }));
  $('docTable').querySelectorAll('.doc-tr input').forEach((input) => input.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDocSelect(input.closest('.doc-tr').dataset.id);
  }));
}

function toggleDocSelect(documentId) {
  const line = currentLine();
  const doc = line && line.documents.find((d) => d.documentId === documentId);
  if (!doc) return;
  if (state.selected.has(documentId)) state.selected.delete(documentId);
  else state.selected.set(documentId, doc);
  renderDocTable($('docSearch').value);
  updateTray();
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
  // 全部已采集（本次零下载）也要给出下一步入口，否则页面只有提示语没有按钮
  const allCollected = [...state.selected.keys()].every((id) => state.collected.has(id));
  if (done > 0 || allCollected) $('toStep3').classList.remove('hidden');

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

/* ---------- 步骤 3：选对比（品类化分组） ---------- */

// 标准品类顺序（其他/未分类固定垫底）；标签与说明走 i18n
const CATEGORY_ORDER = ['campus_switch', 'dc_switch', 'wireless_ap', 'wireless_mgmt', 'router', 'security', 'mgmt_platform', 'industrial', 'other'];
const categoryMeta = (key) => ({
  key,
  label: t(`cat.${key}`) ,
  desc: t(`cat.${key}.desc`),
});

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

function libraryCategoryOf(doc) {
  const key = doc.category || 'other';
  return CATEGORY_ORDER.includes(key) ? key : 'other';
}

function renderCatChips() {
  const counts = new Map();
  for (const doc of state.library) {
    const key = libraryCategoryOf(doc);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const present = CATEGORY_ORDER.filter((key) => counts.has(key));
  const chips = [{ key: '', label: t('common.all'), count: state.library.length }]
    .concat(present.map((key) => ({ key, label: categoryMeta(key).label, count: counts.get(key) })));
  $('catChips').innerHTML = chips.map((chip) => `
    <button class="chip ${state.libraryFilter === chip.key ? 'st-info active' : 'st-neutral'}" data-cat="${esc(chip.key)}">
      ${esc(chip.label)} <span class="chip-count">${chip.count}</span>
    </button>`).join('');
  $('catChips').querySelectorAll('button[data-cat]').forEach((btn) => btn.addEventListener('click', () => {
    state.libraryFilter = btn.dataset.cat;
    renderLibrary();
  }));
}

async function renderLibrary() {
  const box = $('libraryList');
  if (!state.library.length) {
    box.innerHTML = '<div class="muted empty">还没有已采集的彩页，请回第 1、2 步先采集。</div>';
    renderCatChips();
    return;
  }
  renderCatChips();
  const filter = state.libraryFilter || '';
  const docs = state.library.filter((doc) => !filter || libraryCategoryOf(doc) === filter);
  // 品类 → 厂商 两级分组；品类按标准顺序，厂商按出现顺序
  const byCategory = new Map();
  for (const doc of docs) {
    const cat = libraryCategoryOf(doc);
    if (!byCategory.has(cat)) byCategory.set(cat, new Map());
    const byVendor = byCategory.get(cat);
    if (!byVendor.has(doc.vendorName)) byVendor.set(doc.vendorName, []);
    byVendor.get(doc.vendorName).push(doc);
  }
  const orderedCats = CATEGORY_ORDER.filter((key) => byCategory.has(key));
  box.innerHTML = orderedCats.map((cat) => {
    const meta = categoryMeta(cat);
    const byVendor = byCategory.get(cat);
    const vendorBlocks = [...byVendor.entries()].map(([vendorName, list]) => `
      <div class="cmp-vendor">${esc(vendorName)}<span class="muted small">· ${list.length}</span></div>
      ${list.map((doc) => `
      <label class="doc-row ${state.cmpSel.has(doc.documentId) ? 'checked' : ''}" data-id="${esc(doc.documentId)}">
        <input type="checkbox" ${state.cmpSel.has(doc.documentId) ? 'checked' : ''}>
        <span class="doc-series">${esc(doc.series)}</span>
        <span class="doc-models">${esc(doc.modelNames.join('、') || '—')}</span>
        <span class="muted small">${doc.pageCount || '?'} 页${doc.warning ? ' · ⚠ 哈希与基线不一致' : ''}${doc.pageMarkdown?.status === 'ok' ? ' · 已保存网页' : ''}</span>
      </label>`).join('')}`).join('');
    return `<div class="cmp-category">
      <div class="cmp-cat-head"><span class="cmp-cat-name">${esc(meta.label)}</span><span class="muted small">${meta.desc}</span></div>
      ${vendorBlocks}
    </div>`;
  }).join('');
  box.querySelectorAll('.doc-row').forEach((row) => row.addEventListener('click', () => {
    const id = row.dataset.id;
    if (state.cmpSel.has(id)) state.cmpSel.delete(id); else state.cmpSel.add(id);
    row.classList.toggle('checked', state.cmpSel.has(id));
    row.querySelector('input').checked = state.cmpSel.has(id);
    $('cmpCount').textContent = state.cmpSel.size;
    $('toStep4').disabled = state.cmpSel.size < 2;
  }));
}

/* ---------- 步骤 4：项目门槛（三态判定，方案 §4.4/§9.2） ---------- */

const THRESHOLD_OP_OPTIONS = [
  { value: 'ge', label: () => t('thr.ge') },
  { value: 'gt', label: () => t('thr.gt') },
  { value: 'le', label: () => t('thr.le') },
  { value: 'lt', label: () => t('thr.lt') },
];

async function loadFieldTemplate() {
  renderThresholdRows();
  if (state.fieldTemplate) return;
  try {
    const payload = await api('/api/field-template');
    state.fieldTemplate = payload.fields || [];
    renderThresholdRows();
  } catch { /* 字典加载失败不阻断分析：行内仍可手填 */ }
}

function addThresholdRow() {
  if (state.thresholds.length >= 5) { toast('warn', t('thr.limit')); return; }
  const firstField = state.fieldTemplate?.[0];
  state.thresholds.push({ fieldKey: firstField ? firstField.key : 'downlink_ports', op: 'ge', value: '' });
  renderThresholdRows();
}

function removeThresholdRow(index) {
  state.thresholds.splice(index, 1);
  renderThresholdRows();
}

function renderThresholdRows() {
  const box = $('thresholdRows');
  if (!state.thresholds.length) { box.innerHTML = ''; return; }
  const fieldOptions = (selected) => (state.fieldTemplate || [])
    .map((field) => `<option value="${esc(field.key)}" ${field.key === selected ? 'selected' : ''}>${esc(field.label)}</option>`).join('');
  const opOptions = (selected) => THRESHOLD_OP_OPTIONS
    .map((op) => `<option value="${op.value}" ${op.value === selected ? 'selected' : ''}>${esc(op.label())}</option>`).join('');
  box.innerHTML = state.thresholds.map((row, index) => `
    <div class="thr-row" data-index="${index}">
      <select class="thr-field">${fieldOptions(row.fieldKey)}</select>
      <select class="thr-op">${opOptions(row.op)}</select>
      <input type="text" class="thr-value" maxlength="40" placeholder="${esc(t('thr.valuePh'))}" value="${esc(row.value)}">
      <button type="button" class="btn ghost thr-del" title="${esc(t('thr.remove'))}">×</button>
    </div>`).join('');
  box.querySelectorAll('.thr-row').forEach((el) => {
    const index = Number(el.dataset.index);
    el.querySelector('.thr-field').addEventListener('change', (event) => { state.thresholds[index].fieldKey = event.target.value; });
    el.querySelector('.thr-op').addEventListener('change', (event) => { state.thresholds[index].op = event.target.value; });
    el.querySelector('.thr-value').addEventListener('input', (event) => { state.thresholds[index].value = event.target.value; });
    el.querySelector('.thr-del').addEventListener('click', () => removeThresholdRow(index));
  });
}

function thresholdPayload() {
  return state.thresholds
    .map((row) => ({ fieldKey: row.fieldKey, op: row.op, value: row.value.trim() }))
    .filter((row) => row.fieldKey && row.value);
}

const THRESHOLD_VERDICT_META = {
  pass: { text: () => t('thr.pass'), cls: 'th-pass' },
  fail: { text: () => t('thr.fail'), cls: 'th-fail' },
  unknown: { text: () => t('thr.unknown'), cls: 'th-unknown' },
};

function renderThresholdResult(rows) {
  const box = $('thresholdResult');
  if (!rows || !rows.length || !state.matrix) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const docs = state.matrix.documents;
  const head = `<thead><tr><th>${esc(t('thr.resultField'))}</th>${docs.map((doc) => `<th title="${esc(doc.label)}">${esc(doc.label)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((row) => `<tr>
    <td class="thr-label">${esc(row.fieldLabel)} ${esc(row.opLabel)} ${esc(row.value)}</td>
    ${docs.map((doc) => {
      const result = row.results[doc.documentId] || { verdict: 'unknown', reason: '—' };
      const meta = THRESHOLD_VERDICT_META[result.verdict] || THRESHOLD_VERDICT_META.unknown;
      const detail = result.reason || result.basis || '';
      return `<td class="${meta.cls}" title="${esc(detail)}">${esc(meta.text())}${detail ? `<span class="muted small"> · ${esc(detail)}</span>` : ''}</td>`;
    }).join('')}
  </tr>`).join('');
  box.innerHTML = `
    <div class="thr-result-title">${esc(t('thr.result'))}</div>
    <table class="matrix-table thr-table">${head}<tbody>${body}</tbody></table>
    <p class="muted small">${esc(t('thr.staleHint'))}</p>`;
  box.classList.remove('hidden');
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
  state.matrix = null;
  renderMatrix();
  renderThresholdResult(null);
  try {
    const payload = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        documentIds: [...state.cmpSel],
        useAi: $('useAi').checked && !$('useAi').disabled,
        thresholds: thresholdPayload(),
      }),
    });
    const wordFailed = payload.files.some((file) => file.kind === 'word_failed');
    const confirmedNote = payload.confirmedCount ? `，人工已确认 ${payload.confirmedCount} 项` : '';
    const staleNote = payload.staleConfirmationCount ? `，${payload.staleConfirmationCount} 项旧确认因彩页更新失效` : '';
    const cachedNote = payload.aiCachedCount ? `，AI 抽取缓存命中 ${payload.aiCachedCount} 份` : '';
    $('analyzeResult').innerHTML = `
      <div class="analyze-ok">✔ 完成：对齐 ${payload.paramFieldCount} 个参数字段${payload.aiErrors?.length ? `（${payload.aiErrors.length} 个型号 AI 抽取失败已用规则兜底）` : ''}${confirmedNote}${staleNote}${cachedNote}</div>
      ${payload.files.map((file) => file.kind === 'word_failed'
        ? `<div class="warn">Word 生成失败：${esc(file.error)}（Excel 与材料包仍可用）</div>`
        : `<a class="file-card" href="/api/exports/${encodeURIComponent(file.fileName)}" download>
             <span class="file-icon">${file.kind === 'excel' ? '📊' : file.kind === 'word' ? '📄' : '📦'}</span>
             <span>${esc(file.fileName)}</span>
             <span class="muted small">${file.kind === 'excel' ? 'Excel 参数对照' : file.kind === 'word' ? 'Word 分析报告' : 'AI 材料包 Markdown'}</span>
           </a>`).join('')}`;
    state.matrix = payload.matrix || null;
    renderMatrix();
    renderThresholdResult(payload.matrix?.thresholds);
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

/* ---------- 步骤 4：参数对照矩阵 + 人工核对 ---------- */

const MATRIX_STATUS_TEXT = {
  ok: () => t('matrix.stOk'),
  pending_review: () => t('matrix.stPending'),
  not_disclosed: () => t('matrix.stNotFound'),
  extract_failed: () => t('matrix.stFailed'),
};
const MATRIX_SOURCE_TEXT = { rule: () => t('matrix.srcRule'), ai: () => t('matrix.srcAi'), vision: () => t('matrix.srcVision'), manual: () => t('matrix.srcManual') };

function renderMatrix() {
  const wrap = $('matrixWrap');
  const hasMatrix = Boolean(state.matrix?.groups?.length);
  $('matrixTitle').classList.toggle('hidden', !hasMatrix);
  $('matrixHint').classList.toggle('hidden', !hasMatrix);
  $('matrixMeta').classList.toggle('hidden', !hasMatrix);
  if (!hasMatrix) { wrap.innerHTML = ''; return; }
  const docs = state.matrix.documents;
  const head = `<thead><tr><th class="mx-field">${esc(t('matrix.field'))}</th>${docs.map((doc) => `<th title="${esc(doc.label)}">${esc(doc.label)}</th>`).join('')}</tr></thead>`;
  const body = state.matrix.groups.map((group) => `
    <tr class="mx-group"><td colspan="${docs.length + 1}">${esc(group.group)}</td></tr>
    ${group.fields.map((field) => `<tr><td class="mx-field">${esc(field.label)}</td>${docs.map((doc) => matrixCellHtml(field, doc)).join('')}</tr>`).join('')}
  `).join('');
  wrap.innerHTML = `<table class="matrix-table">${head}<tbody>${body}</tbody></table>`;
  wrap.querySelectorAll('td.mx-click').forEach((td) => td.addEventListener('click', () => {
    openConfirmDlg(td.dataset.doc, td.dataset.key);
  }));
  updateMatrixMeta();
}

function matrixCellHtml(field, doc) {
  // 列键用 columnId（T05 型号分列：同一彩页多型号各占一列），单列时与 documentId 相同
  const columnId = doc.columnId || doc.documentId;
  const cell = field.values[columnId];
  if (!cell) return '<td class="mx-cell"></td>';
  const manual = cell.source === 'manual' && cell.manual;
  const clickable = cell.status === 'pending_review' || manual || cell.staleConfirmation || cell.unattributed;
  const marker = manual
    ? `<span class="mx-manual" title="${esc(t('matrix.confirmedMark'))}">✓</span>`
    : cell.status === 'pending_review' ? '<span class="mx-pend">○</span>' : '';
  // 系列值（T05）：值来自整份彩页（规则/视觉抽取或 AI 全系列判定），未验证归属到本型号
  const seriesMark = cell.unattributed && !manual
    ? `<span class="mx-series" title="${esc(t('matrix.seriesNote'))}">${esc(t('matrix.seriesVal'))}</span>`
    : '';
  const text = (cell.status === 'ok' || cell.status === 'pending_review') && cell.value
    ? esc(cell.value)
    : `<span class="muted">（${esc(MATRIX_STATUS_TEXT[cell.status] ? MATRIX_STATUS_TEXT[cell.status]() : cell.status)}）</span>`;
  const staleMark = cell.staleConfirmation ? '<span class="mx-stale" title="stale">!</span>' : '';
  const cls = ['mx-cell', manual ? 'is-manual' : '', cell.status === 'pending_review' ? 'is-pending' : ''].filter(Boolean).join(' ');
  return `<td class="${cls}${clickable ? ' mx-click' : ''}"${clickable ? ` data-doc="${esc(columnId)}" data-key="${esc(field.key)}"` : ''}>${marker}${staleMark}${seriesMark}${text}</td>`;
}

function updateMatrixMeta() {
  let pending = 0;
  let confirmed = 0;
  let stale = 0;
  for (const group of state.matrix.groups) {
    for (const field of group.fields) {
      for (const doc of state.matrix.documents) {
        const cell = field.values[doc.columnId || doc.documentId];
        if (!cell) continue;
        if (cell.status === 'pending_review') pending += 1;
        if (cell.source === 'manual' && cell.manual) confirmed += 1;
        if (cell.staleConfirmation) stale += 1;
      }
    }
  }
  $('matrixMeta').innerHTML = [
    pending ? `<span class="chip st-info">○ ${esc(t('matrix.pendingCount'))} ${pending}</span>` : '',
    confirmed ? `<span class="chip st-pos">✓ ${esc(t('matrix.confirmedCount'))} ${confirmed}</span>` : '',
    stale ? `<span class="chip st-warn">! ${esc(t('matrix.staleCount'))} ${stale}</span>` : '',
  ].filter(Boolean).join(' ');
}

function findMatrixCell(columnId, paramKey) {
  for (const group of state.matrix.groups) {
    for (const field of group.fields) {
      if (field.key !== paramKey) continue;
      const doc = state.matrix.documents.find((entry) => (entry.columnId || entry.documentId) === columnId);
      if (!doc) return null;
      return { field, doc, cell: field.values[columnId] || null };
    }
  }
  return null;
}

async function openConfirmDlg(columnId, paramKey) {
  const hit = findMatrixCell(columnId, paramKey);
  if (!hit || !hit.cell) return;
  const { field, doc, cell } = hit;
  const candidates = Array.isArray(cell.candidates) && cell.candidates.length
    ? cell.candidates
    : (cell.value ? [{ source: cell.source, value: cell.value, quote: cell.quote, page: cell.page }] : []);
  const candHtml = candidates.length
    ? candidates.map((cand, index) => `
        <label class="cand-item">
          <input type="radio" name="candPick" value="${index}">
          <div class="cand-main">
            <div class="cand-value">${esc(cand.value || '—')} <span class="cand-src muted small">${esc(cand.source ? (MATRIX_SOURCE_TEXT[cand.source] ? MATRIX_SOURCE_TEXT[cand.source]() : cand.source) : '—')}${cand.page ? ` · ${esc(t('matrix.page'))} ${cand.page}` : ''}</span></div>
            ${cand.quote ? `<div class="cand-quote">${esc(cand.quote)}</div>` : ''}
          </div>
        </label>`).join('')
    : `<div class="muted small">${esc(t('matrix.noCandidates'))}</div>`;
  const staleHtml = cell.staleConfirmation
    ? `<div class="warn small">${esc(t('matrix.staleWarn'))}：${esc(cell.staleConfirmation.value)}${cell.staleConfirmation.model ? `（${esc(cell.staleConfirmation.model)}）` : ''}</div>`
    : '';
  const manualHtml = cell.manual
    ? `<div class="analyze-ok small">${esc(t('matrix.confirmedMark'))}：${esc(cell.value)} · ${esc(cell.manual.confirmedAt ? cell.manual.confirmedAt.slice(0, 16).replace('T', ' ') : '')}${cell.manual.model ? ` · ${esc(t('common.model'))} ${esc(cell.manual.model)}` : ''}${cell.manual.note ? ` · ${esc(cell.manual.note)}` : ''}</div>`
    : '';
  // 型号归属提示（T05）：系列值未经型号归属验证 / seriesWide 为 AI 判定的全系列通用值
  const scopeHtml = cell.unattributed
    ? `<div class="warn small">${cell.seriesWide ? esc(t('matrix.seriesWideNote')) : esc(t('matrix.seriesNote'))}</div>`
    : '';
  const models = (doc.modelNames || []).map((name) => `<option value="${esc(name)}">`).join('');
  // 型号列（doc.model 非空）确认默认绑定该型号；已有确认沿用其型号，系列列留空
  const defaultModel = cell.manual?.model || doc.model || '';
  $('confirmDlg').innerHTML = `
    <div class="dlg-head"><span>${esc(doc.label)} · ${esc(field.label)}</span><button class="dlg-x" id="cfClose">×</button></div>
    <div class="dlg-body">
      ${staleHtml}${manualHtml}${scopeHtml}
      <div class="dlg-sec">
        <div class="dlg-sec-title">${esc(t('matrix.candidates'))}</div>
        <div class="cand-list">${candHtml}</div>
      </div>
      <div class="dlg-sec">
        <div class="dlg-sec-title">${esc(t('matrix.value'))}</div>
        <div class="dlg-row"><input type="text" id="cfValue" maxlength="200" placeholder="${esc(t('matrix.valuePh'))}" value="${esc(cell.value || '')}"></div>
        <div class="dlg-row"><input type="text" id="cfModel" maxlength="100" list="cfModels" placeholder="${esc(t('matrix.modelPh'))}" value="${esc(defaultModel)}"><datalist id="cfModels">${models}</datalist></div>
        <div class="dlg-row"><input type="text" id="cfNote" maxlength="500" placeholder="${esc(t('matrix.notePh'))}" value="${esc(cell.manual?.note || '')}"></div>
      </div>
      <p class="muted small">${esc(t('matrix.bindNote'))}</p>
    </div>
    <div class="dlg-foot">
      <button class="btn ghost hidden" id="cfClear">${esc(t('matrix.clear'))}</button>
      <div class="spacer"></div>
      <button class="btn ghost" id="cfCancel">${esc(t('common.cancel'))}</button>
      <button class="btn primary" id="cfSave">${esc(t('matrix.save'))}</button>
    </div>`;
  if (cell.manual) $('cfClear').classList.remove('hidden');
  $('confirmDlg').querySelectorAll('input[name="candPick"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const cand = candidates[Number(radio.value)];
      if (cand && radio.checked) $('cfValue').value = cand.value || '';
    });
  });
  $('cfClose').addEventListener('click', closeConfirmDlg);
  $('cfCancel').addEventListener('click', closeConfirmDlg);
  $('cfClear').addEventListener('click', () => clearConfirm(columnId, paramKey));
  $('cfSave').addEventListener('click', () => saveConfirm(columnId, paramKey));
  $('confirmMask').classList.remove('hidden');
  $('cfValue').focus();
}

function closeConfirmDlg() {
  $('confirmMask').classList.add('hidden');
  $('confirmDlg').innerHTML = '';
}

async function saveConfirm(columnId, paramKey) {
  const value = $('cfValue').value.trim();
  if (!value) { toast('warn', t('matrix.valueRequired')); return; }
  const hit = findMatrixCell(columnId, paramKey);
  // 型号列上的确认默认绑定该型号（输入留空时兜底），避免存出匹配不到任何列的系列级确认
  const model = $('cfModel').value.trim() || hit?.doc.model || '';
  try {
    await api('/api/confirmations', {
      method: 'POST',
      body: JSON.stringify({
        documentId: hit?.doc.documentId,
        paramKey,
        value,
        model,
        note: $('cfNote').value.trim(),
      }),
    });
    if (hit?.cell) {
      hit.cell.value = value;
      hit.cell.status = 'ok';
      hit.cell.source = 'manual';
      hit.cell.manual = { confirmedAt: new Date().toISOString(), model, note: $('cfNote').value.trim() };
      hit.cell.staleConfirmation = null;
    }
    renderMatrix();
    closeConfirmDlg();
    toast('success', t('matrix.saved'));
  } catch (error) {
    toast('error', `${t('matrix.saveFailed')}：${error.message}`, 6000);
  }
}

async function clearConfirm(columnId, paramKey) {
  const hit = findMatrixCell(columnId, paramKey);
  // 确认键含 model（T05）：按生效确认记录的型号精确删除，避免误删同彩页其他型号的确认
  const model = hit?.cell?.manual?.model || hit?.doc.model || '';
  try {
    await api(`/api/confirmations?documentId=${encodeURIComponent(hit?.doc.documentId || '')}&paramKey=${encodeURIComponent(paramKey)}&model=${encodeURIComponent(model)}`, { method: 'DELETE' });
    if (hit?.cell) {
      const snapshot = hit.cell.preConfirm;
      delete hit.cell.manual;
      hit.cell.staleConfirmation = null;
      if (snapshot) {
        hit.cell.value = snapshot.value;
        hit.cell.status = snapshot.status;
        hit.cell.source = snapshot.source;
        hit.cell.reviewNote = snapshot.reviewNote;
        if ('unattributed' in snapshot) hit.cell.unattributed = snapshot.unattributed;
      } else {
        hit.cell.status = 'pending_review';
        hit.cell.reviewNote = '';
      }
    }
    renderMatrix();
    closeConfirmDlg();
    toast('info', t('matrix.cleared'));
  } catch (error) {
    toast('error', `${t('matrix.clearFailed')}：${error.message}`, 6000);
  }
}

/* ---------- 自定义厂商/产品线来源（彩页归档，方法论见 README） ---------- */

// 条目编辑区状态：[{ modelNames, pdfUrl, officialFileName, productPageUrl }]
state.profileEntries = [];

function profileEntryRow(entry, index) {
  return `<div class="pf-entry" data-idx="${index}">
    <div class="pf-entry-head"><span class="pf-idx">#${index + 1}</span><button class="btn ghost pf-entry-x" data-idx="${index}" title="${esc(t('common.delete'))}">×</button></div>
    <div class="dlg-row"><input type="text" class="pf-models" maxlength="500" placeholder="${esc(t('profile.modelsPh'))}" value="${esc(entry.modelNames || '')}"></div>
    <div class="dlg-row"><input type="url" class="pf-pdf" maxlength="500" placeholder="${esc(t('profile.pdfPh'))}" value="${esc(entry.pdfUrl || '')}"></div>
    <div class="dlg-row two">
      <input type="text" class="pf-file" maxlength="200" placeholder="${esc(t('profile.filePh'))}" value="${esc(entry.officialFileName || '')}">
      <input type="url" class="pf-page" maxlength="500" placeholder="${esc(t('profile.pagePh'))}" value="${esc(entry.productPageUrl || '')}">
    </div>
  </div>`;
}

function renderProfileEntries() {
  const wrap = $('pfEntries');
  if (!wrap) return;
  wrap.innerHTML = state.profileEntries.length
    ? state.profileEntries.map(profileEntryRow).join('')
    : `<div class="muted small">${esc(t('profile.emptyEntries'))}</div>`;
  wrap.querySelectorAll('.pf-entry input').forEach((input) => {
    input.addEventListener('input', () => {
      const idx = Number(input.closest('.pf-entry').dataset.idx);
      const field = { 'pf-models': 'modelNames', 'pf-pdf': 'pdfUrl', 'pf-file': 'officialFileName', 'pf-page': 'productPageUrl' }[input.className.split(' ')[0]];
      if (field) state.profileEntries[idx][field] = input.value;
    });
  });
  wrap.querySelectorAll('.pf-entry-x').forEach((btn) => btn.addEventListener('click', () => {
    state.profileEntries.splice(Number(btn.dataset.idx), 1);
    renderProfileEntries();
  }));
}

function collectProfileForm() {
  return {
    vendorId: $('pfVendorId').value.trim(),
    vendorName: $('pfVendorName').value.trim(),
    productLineName: $('pfLine').value.trim(),
    subseriesName: $('pfSub').value.trim(),
    officialDomains: $('pfDomains').value.trim(),
    trustedRedirectDomains: $('pfRedirect').value.trim(),
    profileId: $('profileDlg').dataset.profileId || '',
    sources: state.profileEntries.map((entry) => ({ ...entry })),
  };
}

// 打开弹窗：profileId 省略 = 新建；传入 = 编辑已有自定义来源（拉原始 JSON 回填）
async function openProfileDlg(profileId = '') {
  let profile = null;
  if (profileId) {
    try {
      const payload = await api('/api/profiles');
      profile = payload.profiles.find((item) => item.profileId === profileId) || null;
    } catch { /* 拉取失败按新建处理 */ }
    if (!profile) { toast('error', t('profile.loadFailed')); return; }
  }
  const vendors = (state.catalog?.vendors || [])
    .map((vendor) => `<option value="${esc(vendor.vendorId)}">${esc(vendor.vendorName)}</option>`).join('');
  $('profileDlg').innerHTML = `
    <div class="dlg-head"><span>${esc(profileId ? t('profile.editTitle') : t('profile.title'))}</span><button class="dlg-x" id="pfClose">×</button></div>
    <div class="dlg-body">
      <div class="dlg-sec">
        <div class="dlg-sec-title">${esc(t('profile.secBase'))}</div>
        <div class="dlg-row two">
          <input type="text" id="pfVendorId" maxlength="64" list="pfVendorIds" placeholder="${esc(t('profile.vendorIdPh'))}" value="${esc(profile?.vendorId || '')}"><datalist id="pfVendorIds">${vendors}</datalist>
          <input type="text" id="pfVendorName" maxlength="80" placeholder="${esc(t('profile.vendorNamePh'))}" value="${esc(profile?.vendorName || '')}">
        </div>
        <div class="dlg-row two">
          <input type="text" id="pfLine" maxlength="80" placeholder="${esc(t('profile.linePh'))}" value="${esc(profile?.productLine?.name || '')}">
          <input type="text" id="pfSub" maxlength="120" placeholder="${esc(t('profile.subPh'))}" value="${esc(profile?.subseries?.name || '')}">
        </div>
        <div class="dlg-row"><input type="text" id="pfDomains" maxlength="400" placeholder="${esc(t('profile.domainsPh'))}" value="${esc((profile?.officialDomains || []).join(', '))}"></div>
        <div class="dlg-row"><input type="text" id="pfRedirect" maxlength="400" placeholder="${esc(t('profile.redirectPh'))}" value="${esc((profile?.trustedRedirectDomains || []).join(', '))}"></div>
        <p class="muted small">${esc(t('profile.domainNote'))}</p>
      </div>
      <div class="dlg-sec">
        <div class="dlg-sec-title">${esc(t('profile.secEntries'))}</div>
        <div id="pfEntries" class="pf-entries"></div>
        <button class="btn ghost" id="pfAddEntry">＋ ${esc(t('profile.addEntry'))}</button>
      </div>
      <div class="dlg-sec">
        <div class="dlg-sec-title">${esc(t('profile.secCheck'))}</div>
        <div id="pfCheckResult"></div>
        <button class="btn ghost" id="pfCheck">🔍 ${esc(t('profile.sampleCheck'))}</button>
        <p class="muted small">${esc(t('profile.checkNote'))}</p>
      </div>
    </div>
    <div class="dlg-foot">
      <div class="spacer"></div>
      <button class="btn ghost" id="pfCancel">${esc(t('common.cancel'))}</button>
      <button class="btn primary" id="pfSave">${esc(t('profile.save'))}</button>
    </div>`;
  state.profileEntries = profile?.sources?.map((source) => ({
    modelNames: (source.modelNames || []).join(', '),
    pdfUrl: source.pdfUrl || '',
    officialFileName: source.officialFileName || '',
    productPageUrl: source.productPageUrl || '',
  })) || [{ modelNames: '', pdfUrl: '', officialFileName: '', productPageUrl: '' }];
  $('profileDlg').dataset.profileId = profileId;
  renderProfileEntries();
  $('pfAddEntry').addEventListener('click', () => { state.profileEntries.push({ modelNames: '', pdfUrl: '', officialFileName: '', productPageUrl: '' }); renderProfileEntries(); });
  $('pfClose').addEventListener('click', closeProfileDlg);
  $('pfCancel').addEventListener('click', closeProfileDlg);
  $('pfCheck').addEventListener('click', sampleCheckProfile);
  $('pfSave').addEventListener('click', saveProfile);
  $('profileMask').classList.remove('hidden');
}

function closeProfileDlg() {
  $('profileMask').classList.add('hidden');
  $('profileDlg').innerHTML = '';
  $('profileDlg').dataset.profileId = '';
}

async function sampleCheckProfile() {
  const result = $('pfCheckResult');
  if (!result) return;
  result.innerHTML = `<div class="muted small">${esc(t('profile.checking'))}</div>`;
  try {
    const payload = await api('/api/profiles/sample-check', { method: 'POST', body: JSON.stringify(collectProfileForm()) });
    result.innerHTML = payload.results.map((item) => `
      <div class="${item.ok ? 'analyze-ok' : 'error'} small">
        ${item.ok ? '✔' : '✘'} ${esc(item.series || item.documentId)}：${esc(item.detail)}
      </div>`).join('') + (payload.ok
      ? `<div class="analyze-ok small">${esc(t('profile.sampleOk'))}</div>`
      : `<div class="warn small">${esc(t('profile.sampleFail'))}</div>`);
  } catch (error) {
    const errors = Array.isArray(error.payload?.errors) ? error.payload.errors : [];
    result.innerHTML = errors.map((line) => `<div class="error small">✘ ${esc(line)}</div>`).join('')
      || `<div class="error small">${esc(error.message)}</div>`;
  }
}

async function saveProfile() {
  try {
    await api('/api/profiles', { method: 'POST', body: JSON.stringify(collectProfileForm()) });
    toast('success', t('profile.saved'));
    closeProfileDlg();
    await reloadCatalog();
  } catch (error) {
    const errors = Array.isArray(error.payload?.errors) ? error.payload.errors : [];
    toast('error', `${t('profile.saveFailed')}：${errors.length ? errors[0] : error.message}`, 8000);
    if (errors.length) {
      const result = $('pfCheckResult');
      if (result) result.innerHTML = errors.map((line) => `<div class="error small">✘ ${esc(line)}</div>`).join('');
    }
  }
}

async function removeCustomProfile(profileId) {
  const line = state.catalog.vendors.flatMap((v) => v.productLines).find((l) => l.profileId === profileId);
  if (!confirm(`${t('profile.deleteConfirm')}${line ? `「${line.displayName}」` : ''}`)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
    toast('info', t('profile.deleted'));
    if (state.currentProfileId === profileId) state.currentProfileId = '';
    await reloadCatalog();
  } catch (error) {
    toast('error', `${t('profile.deleteFailed')}：${error.message}`);
  }
}

// 目录加载告警（自定义来源冲突被跳过等）：静默跳过会让操作者误以为登记成功
function renderCatalogWarnings() {
  const box = $('catalogWarnings');
  if (!box) return;
  const warnings = state.catalog?.warnings || [];
  box.classList.toggle('hidden', !warnings.length);
  if (!warnings.length) { box.innerHTML = ''; return; }
  box.innerHTML = warnings.map((line) => `<div>⚠ ${esc(line)}</div>`).join('')
    + `<button class="cw-x" title="${esc(t('common.close'))}">×</button>`;
  box.querySelector('.cw-x').addEventListener('click', () => box.classList.add('hidden'));
}

// 目录重载：保留当前选中与展开状态（自定义来源增删后调用）
async function reloadCatalog() {
  const catalog = await api('/api/catalog');
  const keepVendor = state.currentVendorId;
  const keepProfile = state.currentProfileId;
  state.catalog = catalog;
  if (keepVendor && vendorOf(keepVendor)) {
    state.currentVendorId = keepVendor;
    const lines = vendorOf(keepVendor).productLines;
    state.currentProfileId = lines.some((l) => l.profileId === keepProfile) ? keepProfile : (lines[0]?.profileId || '');
  }
  renderCatalogWarnings();
  renderTree();
  renderDocTable($('docSearch').value);
}

function initProfileDialog() {
  const btn = $('addProfileBtn');
  if (btn) btn.addEventListener('click', () => openProfileDlg());
  const mask = $('profileMask');
  if (mask) mask.addEventListener('click', (event) => { if (event.target === mask) closeProfileDlg(); });
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
  currentRunInfo: null,
  statusLabels: {},
  lastResults: [],
  wasRunning: false,
  currentState: {},
  sort: { key: 'time', dir: 'desc' },
  page: 1,
  pageSize: 20,
  filterStatus: '',
  lastSchedule: null,
  lastTotals: null,
};

// 状态排序权重：正常 < 提示 < 警告 < 异常
const PROBE_SEVERITY = {
  valid_unchanged: 0, baseline_matched: 0, manual_ok: 0,
  new_archived: 1, manual_invalid: 1, paused: 1, vendor_throttled: 1, manual_settled: 1,
  updated: 2, too_large: 2,
  unreachable: 3, redirect_broken: 3, not_pdf: 3, corrupt: 3, network_error: 3,
};

// 状态元数据：短标签 + 形状前缀（色弱双通道）+ 样式类，与 docs/UI美化设计方案.md 3.1 表一致
const PROBE_CHIP_META = {
  valid_unchanged: { key: 'chip.valid_unchanged', shape: '●', cls: 'st-pos' },
  baseline_matched: { key: 'chip.baseline_matched', shape: '●', cls: 'st-pos' },
  manual_ok: { key: 'chip.manual_ok', shape: '●', cls: 'st-pos' },
  new_archived: { key: 'chip.new_archived', shape: '○', cls: 'st-info' },
  link_ok: { key: 'chip.link_ok', shape: '○', cls: 'st-info' },
  pending_review: { key: 'chip.pending_review', shape: '○', cls: 'st-info' },
  updated: { key: 'chip.updated', shape: '▲', cls: 'st-warn' },
  too_large: { key: 'chip.too_large', shape: '▲', cls: 'st-warn' },
  vendor_throttled: { key: 'chip.vendor_throttled', shape: '—', cls: 'st-neutral' },
  paused: { key: 'chip.paused', shape: '—', cls: 'st-neutral' },
  manual_invalid: { key: 'chip.manual_invalid', shape: '—', cls: 'st-neutral' },
  manual_settled: { key: 'chip.manual_settled', shape: '—', cls: 'st-neutral' },
  unreachable: { key: 'chip.error', shape: '■', cls: 'st-err' },
  redirect_broken: { key: 'chip.error', shape: '■', cls: 'st-err' },
  not_pdf: { key: 'chip.error', shape: '■', cls: 'st-err' },
  corrupt: { key: 'chip.error', shape: '■', cls: 'st-err' },
  network_error: { key: 'chip.error', shape: '■', cls: 'st-err' },
};
// 五种错误态在芯片上合并为一个「异常」筛选（__error）
const PROBE_ERROR_SET = new Set(['unreachable', 'redirect_broken', 'not_pdf', 'corrupt', 'network_error']);
// 芯片展示顺序：正向 → 提醒 → 信息 → 异常 → 中性
const PROBE_CHIP_ORDER = ['', 'valid_unchanged', 'baseline_matched', 'manual_ok', 'updated', 'too_large', 'new_archived', 'link_ok', '__error', 'vendor_throttled', 'paused', 'manual_invalid'];

// 需要人工兜底的异常状态
const MANUAL_ELIGIBLE = new Set(['unreachable', 'redirect_broken', 'not_pdf', 'corrupt', 'too_large', 'network_error', 'vendor_throttled']);

function fmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function renderProbeSchedule(schedule, totals, labels) {
  probe.lastSchedule = schedule;
  probe.lastTotals = totals;
  const info = $('probeScheduleInfo');
  if (schedule?.enabled) {
    const next = schedule.nextScheduledAt ? schedule.nextScheduledAt.slice(0, 16).replace('T', ' ') : '计算中';
    info.textContent = `定时校验：每日 ${schedule.schedule} · 下次 ${next}`;
  } else {
    info.textContent = '定时校验未启用（NVCI_LITE_PROBE_ENABLED=true 开启）· 可手动触发';
  }
  const entries = Object.entries(totals || {});
  if (!entries.length) {
    $('probeTotals').innerHTML = '<span class="muted small">还没有校验记录，点击「开始校验」建立第一轮哈希档案</span>';
    return;
  }
  // 错误五态合并为一个「异常」芯片；其余逐状态展示
  const groups = new Map();
  let allCount = 0;
  for (const [key, count] of entries) {
    allCount += count;
    const groupKey = PROBE_ERROR_SET.has(key) ? '__error' : key;
    groups.set(groupKey, (groups.get(groupKey) || 0) + count);
  }
  const chips = [{ key: '', short: '全部', shape: '', cls: 'st-all', count: allCount, title: '显示全部状态' }];
  for (const [key, count] of groups) {
    const meta = key === '__error'
      ? { key: 'chip.error', cls: 'st-err', title: '不可达 / 跳转越界 / 非PDF / 无法解析 / 网络异常' }
      : PROBE_CHIP_META[key];
    if (meta) chips.push({ key, count, title: labels[key] || meta.short, ...meta });
  }
  chips.sort((a, b) => {
    const ia = PROBE_CHIP_ORDER.indexOf(a.key); const ib = PROBE_CHIP_ORDER.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  $('probeTotals').innerHTML = chips.map((chip) => {
    const selected = (probe.filterStatus || '') === chip.key ? 'selected' : '';
    const disabled = chip.count === 0 && chip.key !== '' ? 'disabled' : '';
    return `<button type="button" class="chip ${chip.cls} ${selected} ${disabled}" data-status="${esc(chip.key)}" title="${esc(chip.title)}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="dot"></span>${esc(chip.short)} <span class="cnt">${chip.count}</span></button>`;
  }).join('');
  $('probeTotals').querySelectorAll('.chip:not(.disabled)').forEach((chip) => chip.addEventListener('click', () => {
    probe.filterStatus = probe.filterStatus === chip.dataset.status ? '' : chip.dataset.status;
    probe.page = 1;
    renderProbeSchedule(probe.lastSchedule, probe.lastTotals, probe.statusLabels);
    renderProbeResults(probe.lastResults);
  }));
}

/* 状态图例（首次展开时构建） */
function renderLegend() {
  const pop = $('legendPop');
  if (!pop || pop.dataset.built === '1') return;
  pop.dataset.built = '1';
  const rows = Object.keys(PROBE_CHIP_META)
    .filter((key) => key !== 'manual_settled')
    .map((key) => {
      const meta = PROBE_CHIP_META[key];
      const full = probe.statusLabels[key] || key;
      return `<div class="lg-row"><span class="lg-shape">${meta.shape}</span><span class="lg-name">${esc(meta.short)}</span><span class="lg-desc">${esc(full)}</span></div>`;
    }).join('');
  pop.innerHTML = `<h4>状态图例</h4>${rows}<div class="lg-row"><span class="lg-shape">■</span><span class="lg-name">异常</span><span class="lg-desc">不可达 / 跳转越界 / 非PDF / 无法解析 / 网络异常（点击上方芯片可筛选对应状态）</span></div>`;
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

/* ---------- 表格通用：默认自动换行，列宽可拖拽调整（结果表/历史表） ---------- */

// 各表默认列宽（px）；null = 弹性列吃掉剩余宽度
const COL_DEFAULTS = {
  results: ['100px', '96px', '150px', '60px', '54px', '132px', '112px', null, '84px'],
  history: ['128px', '84px', '70px', '76px', null, '70px'],
  catalog: ['38px', '160px', '210px', '120px', null],
};
const COL_MIN_PX = 56;

const colWidthKey = (id) => `nvci-colw-${id}`;
function loadColWidths(id) {
  try { return JSON.parse(localStorage.getItem(colWidthKey(id))) || {}; } catch { return {}; }
}
function saveColWidths(id, widths) {
  try { localStorage.setItem(colWidthKey(id), JSON.stringify(widths)); } catch { /* 隐私模式等场景静默 */ }
}
// 双击手柄恢复默认：清记忆并重渲当前表
const COL_RERENDER = {
  results: () => renderProbeResults(probe.lastResults),
  history: () => renderRunsTable(),
};

function startColDrag(event, table, cols, ths, index, saved, tableId) {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  // 首次拖拽：从 th 实测宽度冻结全部列（col.clientWidth 跨浏览器不可靠），表转为可横向扩展
  const widths = ths.map((th) => Math.round(th.getBoundingClientRect().width));
  cols.forEach((col, i) => { col.style.width = `${widths[i]}px`; });
  const baseTotal = widths.reduce((sum, w) => sum + w, 0);
  table.style.width = `${baseTotal}px`;
  const startX = event.clientX;
  const startWidth = widths[index];
  const parentWidth = table.parentElement ? table.parentElement.clientWidth : 0;
  handle.classList.add('dragging');
  document.body.classList.add('col-dragging');
  const onMove = (move) => {
    const width = Math.max(COL_MIN_PX, startWidth + (move.clientX - startX));
    cols[index].style.width = `${width}px`;
    table.style.width = `${Math.max(parentWidth, baseTotal - startWidth + width)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    handle.classList.remove('dragging');
    document.body.classList.remove('col-dragging');
    saved[index] = cols[index].style.width;
    saveColWidths(tableId, saved);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function enhanceResizable(container, tableId) {
  const table = container && container.querySelector('table.probe-table');
  if (!table) return;
  const defaults = COL_DEFAULTS[tableId] || [];
  const saved = loadColWidths(tableId);
  // 注意：不能给表套 overflow-x 容器——sticky 表头在有滚动框的祖先里会失效（竖向粘性被劫持）。
  // 拖宽后表格超出容器时由页面级横向滚动兜底。
  const ths = [...table.querySelectorAll('thead th')];
  const colgroup = document.createElement('colgroup');
  const cols = ths.map((th, index) => {
    const col = document.createElement('col');
    const width = saved[index] || defaults[index];
    if (width) col.style.width = width;
    colgroup.appendChild(col);
    return col;
  });
  table.prepend(colgroup);
  table.style.tableLayout = 'fixed';
  // 每个表头右缘挂拖拽手柄（sticky th 自带定位上下文）
  ths.forEach((th, index) => {
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    handle.title = '拖动调整列宽 · 双击恢复默认';
    handle.addEventListener('mousedown', (event) => startColDrag(event, table, cols, ths, index, saved, tableId));
    handle.addEventListener('click', (event) => event.stopPropagation()); // 避免误触排序
    handle.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      saveColWidths(tableId, {});
      COL_RERENDER[tableId] && COL_RERENDER[tableId]();
    });
    th.appendChild(handle);
  });
}


/* 轮次横条：当前表格显示的是哪一轮 */
function renderRunCaption() {
  const c = probe.currentRunInfo;
  if (!c) return '';
  const when = String(c.startedAt).slice(0, 16).replace('T', ' ');
  const text = `当前显示：<b>${esc(when)}</b> · ${c.trigger === 'scheduled' ? '定时' : '手动'} · ${c.mode === 'light' ? '轻量' : '完整'}（${c.count} 条）`;
  return c.isLatest
    ? `<div class="run-caption">${text}<span class="muted small">最新一轮</span></div>`
    : `<div class="run-caption">${text}<span class="muted small">历史轮次</span><button type="button" class="rc-clear" id="rcLatest">× 恢复最新</button></div>`;
}

async function loadLatestRun({ scroll = true } = {}) {
  try {
    const payload = await api('/api/probe/runs');
    history.rows = payload.runs;
    renderRunsTable();
    const latest = payload.runs[0];
    if (!latest) return;
    const detail = await api(`/api/probe/runs/${encodeURIComponent(latest.runId)}`);
    probe.currentRunId = latest.runId;
    probe.currentRunInfo = {
      runId: latest.runId, startedAt: latest.startedAt, trigger: latest.trigger, mode: latest.mode,
      count: latest.resultCount ?? latest.scope ?? 0, isLatest: true,
    };
    renderProbeResults(detail.results || []);
    if (scroll) scrollToResults();
  } catch (error) {
    toast('error', `加载最新校验轮次失败：${error.message}`);
  }
}

function scrollToResults() {
  const box = $('probeResults');
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const table = box && box.querySelector('.probe-table');
  if (table) {
    table.classList.remove('flash');
    void table.offsetWidth; // 重启动画
    table.classList.add('flash');
  }
}

function renderProbeResults(results) {
  probe.lastResults = results || [];
  const filter = probe.filterStatus || '';
  const needle = $('probeSearch').value.trim().toLowerCase();
  const rows = probe.lastResults.filter((row) => {
    const display = displayStatusOf(row);
    const statusHit = !filter || display === filter || (filter === '__error' && PROBE_ERROR_SET.has(display));
    return statusHit
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
    const meta = PROBE_CHIP_META[display] || { key: display, shape: '', cls: 'st-neutral' };
    const changed = display !== row.probeStatus;
    const sha = current?.sha256 || row.sha256;
    const sizeText = sha ? `SHA ${esc(String(sha).slice(0, 10))}…` : (row.contentLength ? fmtBytes(row.contentLength) : '—');
    const notes = [
      row.warning ? '⚠ 与基线不一致' : '',
      (row.urlOverridden || current?.urlOverride) ? '🔧 链接已人工修正' : '',
      changed ? `本轮记录：${esc(probe.statusLabels[row.probeStatus] || row.probeStatus)}` : '',
      current?.manualNote ? `<span class="tag" title="${esc(current.manualNote)}">✍ ${esc(current.manualNote)}</span>` : '',
      current?.manualSettled ? '<span class="muted small">自动巡检跳过</span>' : '',
      row.detail ? (changed ? `<span class="error" title="${esc(row.detail)}">历史异常</span>` : `<span class="error">${esc(row.detail)}</span>`) : '',
    ].filter(Boolean).join(' ');
    const timeText = String(row.checkedAt).slice(0, 16).replace('T', ' ');
    return `<tr>
      <td><span class="badge ${meta.cls}" title="${esc(probe.statusLabels[display] || display)}">${meta.shape} ${esc(t(meta.key))}</span></td>
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

  const rangeEl = $('probeRange');
  if (rangeEl) {
    rangeEl.textContent = total === 0 ? '共 0 条' : `第 ${startNo + 1}-${Math.min(startNo + (size > 0 ? size : total), total)} 条，共 ${total} 条`;
  }
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
    ${renderRunCaption()}
    <table class="probe-table">
      <thead><tr>
        ${th('status', t('common.status'))}${th('vendor', t('common.vendor'))}${th('series', t('common.series'))}<th>HTTP</th>${th('pages', t('common.pages'))}<th>SHA-256</th>${th('time', t('common.time'))}
        <th>${t('common.note')}</th><th>${t('common.operation')}</th>
      </tr></thead>
      <tbody>${bodyRows || '<tr><td colspan="9" class="muted empty">没有符合筛选条件的记录</td></tr>'}</tbody>
    </table>
    <div class="pager pager-bottom"><div class="pager-btns">${pagerBtns}</div></div>`;
  enhanceResizable($('probeResults'), 'results');

  const rcLatest = $('rcLatest');
  if (rcLatest) rcLatest.addEventListener('click', () => { loadLatestRun(); });
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
        ${th('startedAt', t('common.time'))}${th('trigger', t('common.trigger'))}${th('mode', t('common.mode'))}${th('count', t('common.items'))}${th('status', t('common.status'))}
        <th>${t('common.operation')}</th>
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

  enhanceResizable($('probeRuns'), 'history');
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
      probe.currentRunInfo = {
        runId: run.runId, startedAt: run.startedAt, trigger: run.trigger, mode: run.mode,
        count: run.resultCount ?? run.scope ?? 0,
        isLatest: history.rows[0]?.runId === run.runId,
      };
      renderProbeResults(detail.results || []);
      scrollToResults();
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
    const latest = history.rows[0];
    probe.currentRunInfo = {
      runId: run.runId, startedAt: run.startedAt, trigger: run.trigger, mode: run.mode,
      count: run.results?.length || run.resultCount || run.scope || 0,
      isLatest: !latest || latest.runId === run.runId,
    };
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
  // 状态筛选已由顶部芯片承担；此处只绑搜索、每页与图例
  $('probeSearch').oninput = () => { probe.page = 1; renderProbeResults(probe.lastResults); };
  const pgSizeTop = $('pgSizeTop');
  if (pgSizeTop && !pgSizeTop.dataset.bound) {
    pgSizeTop.dataset.bound = '1';
    pgSizeTop.value = String(probe.pageSize);
    pgSizeTop.addEventListener('change', () => {
      probe.pageSize = Number(pgSizeTop.value) || 0;
      probe.page = 1;
      renderProbeResults(probe.lastResults);
    });
  }
  const legendBtn = $('legendBtn');
  if (legendBtn && !legendBtn.dataset.bound) {
    legendBtn.dataset.bound = '1';
    legendBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      renderLegend();
      $('legendPop').classList.toggle('hidden');
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#legendPop') && !event.target.closest('#legendBtn')) {
        $('legendPop')?.classList.add('hidden');
      }
    });
  }
  await pollProbe();
  // 进入第 5 步即展示最新一轮结果（带「最新一轮」横条），无需先点历史
  await loadLatestRun({ scroll: false });
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
  const badgeClass = (PROBE_CHIP_META[probeInfo.lastProbeStatus] || { cls: 'st-neutral' }).cls;
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
  const meta = PROBE_CHIP_META[payload.probeStatus] || { cls: 'st-neutral' };
  box.innerHTML = `<div class="analyze-ok">✔ 校验完成：<span class="badge ${meta.cls}">${esc(label)}</span>
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

/* ---------- 顶栏三件套：主题 / 语言 / 设置 ---------- */

function initTheme() {
  const saved = localStorage.getItem('nvci-theme') || 'light';
  document.body.classList.toggle('theme-dark', saved === 'dark');
  $('themeBtn').textContent = saved === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const dark = !document.body.classList.contains('theme-dark');
  document.body.classList.toggle('theme-dark', dark);
  localStorage.setItem('nvci-theme', dark ? 'dark' : 'light');
  $('themeBtn').textContent = dark ? '☀️' : '🌙';
}

function buildLangMenu() {
  $('langMenu').innerHTML = I18N_LANGS.map((lang) =>
    `<button class="lang-item ${I18N_STATE.lang === lang.code ? 'active' : ''}" data-lang="${lang.code}">${lang.label}</button>`).join('');
  $('langMenu').querySelectorAll('.lang-item').forEach((btn) => btn.addEventListener('click', (event) => {
    event.stopPropagation();
    setLang(btn.dataset.lang);
    $('langMenu').classList.add('hidden');
    applyI18n();
    buildLangMenu();
    refreshUI();
    toast('info', I18N[I18N_STATE.lang] ? btn.textContent : btn.textContent, 1800);
  }));
}

function refreshUI() {
  applyI18n();
  renderTree();
  renderDocTable($('docSearch').value);
  updateTray();
  if (state.step === 2) renderCollectSummary();
  if (state.step === 3) renderLibrary();
  if (state.step === 4) { renderAiMode(); loadExports(); loadFieldTemplate(); renderMatrix(); }
  if (state.step === 5) { renderProbe(); }
}

async function openSettings() {
  try {
    const view = await api('/api/settings');
    $('sDataDir').textContent = view.storage.dataDir || '—';
    $('sProtocol').value = view.ai.protocol || '';
    $('sBaseUrl').value = view.ai.baseUrl || '';
    $('sModel').value = view.ai.model || '';
    $('sVisionModel').value = view.ai.visionModel || '';
    $('sApiKey').value = '';
    $('sApiKey').placeholder = view.ai.apiKeyConfigured ? t('settings.apiKeyMasked') : 'API Key';
    $('sAiState').textContent = view.ai.apiKeyConfigured ? `● ${t('top.aiOn')}` : '';
    const modeText = { settings: t('settings.passModeSettings'), env: t('settings.passModeEnv'), none: t('settings.passModeNone') };
    $('sPassMode').textContent = `● ${modeText[view.security?.authMode] || ''}`;
    ['sCurPass', 'sNewPass', 'sNewPass2'].forEach((id) => { $(id).value = ''; });
  } catch (error) { toast('error', error.message); }
  $('settingsMask').classList.remove('hidden');
}

async function savePassword() {
  const currentPassword = $('sCurPass').value;
  const newPassword = $('sNewPass').value;
  const confirm2 = $('sNewPass2').value;
  if (newPassword !== confirm2) { toast('warn', t('settings.passMismatch')); return; }
  if (newPassword && newPassword.length < 8) { toast('warn', t('settings.passShort')); return; }
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ passwordChange: { currentPassword, newPassword } }) });
    toast('success', t('settings.passSaved'));
    // 会话已被服务端轮换：强制重新登录
    $('settingsMask').classList.add('hidden');
    $('loginMask').classList.remove('hidden');
    $('passwordInput').value = '';
    $('passwordInput').focus();
  } catch (error) { toast('error', error.message); }
}

async function saveSettings(patch) {
  try {
    const payload = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    toast('success', t('settings.saved'));
    if (patch.ai) {
      const status = await api('/api/ai-status');
      state.aiStatus = status;
      $('aiBadge').textContent = status.configured ? `AI · ${status.model}` : 'AI ✕';
      $('aiBadge').classList.toggle('on', status.configured);
    }
    return payload;
  } catch (error) { toast('error', error.message); }
}

/* ---------- 侧栏收拢 / 展开收起全部 ---------- */

function applyTreeCollapsed(collapsed) {
  document.querySelector('.wizard-grid')?.classList.toggle('tree-collapsed', collapsed);
  $('treeExpandBtn').classList.toggle('hidden', !collapsed);
  localStorage.setItem('nvci-tree-collapsed', collapsed ? '1' : '0');
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
    const first = state.catalog.vendors[0];
    const withDocs = first.productLines.find((line) => line.documentCount > 0) || first.productLines[0];
    state.currentVendorId = first.vendorId;
    state.currentProfileId = withDocs.profileId;
    state.expanded.add(state.currentVendorId);
  }
  renderCatalogWarnings();
  renderTree();
  renderDocTable();
  updateTray();
  refreshStepBar();
  refreshAlerts();
  initProfileDialog();
  setInterval(refreshAlerts, 60000);
  applyI18n();
  initTheme();
  buildLangMenu();
  applyTreeCollapsed(localStorage.getItem('nvci-tree-collapsed') === '1');
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
initTheme();
$('themeBtn').addEventListener('click', toggleTheme);
$('langBtn').addEventListener('click', (event) => { event.stopPropagation(); $('langMenu').classList.toggle('hidden'); });
document.addEventListener('click', (event) => {
  if (!event.target.closest('.lang-wrap')) $('langMenu')?.classList.add('hidden');
});
$('settingsBtn').addEventListener('click', openSettings);
$('sClose').addEventListener('click', () => $('settingsMask').classList.add('hidden'));
$('sSavePass').addEventListener('click', savePassword);
$('settingsMask').addEventListener('click', (event) => { if (event.target === $('settingsMask')) $('settingsMask').classList.add('hidden'); });
$('sResetAi').addEventListener('click', async () => {
  if (!window.confirm('清除界面保存的 AI 配置，恢复使用环境变量？')) return;
  await saveSettings({ resetAi: true });
  openSettings();
});
$('sSaveAi').addEventListener('click', () => saveSettings({ ai: {
  protocol: $('sProtocol').value, baseUrl: $('sBaseUrl').value.trim(),
  model: $('sModel').value.trim(), visionModel: $('sVisionModel').value.trim(),
  apiKey: $('sApiKey').value.trim(),
} }));
$('expandAllBtn').addEventListener('click', () => {
  state.expanded = new Set(state.catalog.vendors.map((v) => v.vendorId));
  renderTree();
});
$('thresholdAdd').addEventListener('click', addThresholdRow);
$('collapseAllBtn').addEventListener('click', () => { state.expanded.clear(); renderTree(); });
$('treeCollapseBtn').addEventListener('click', () => applyTreeCollapsed(true));
$('treeExpandBtn').addEventListener('click', () => applyTreeCollapsed(false));
$('manualMask').addEventListener('click', (event) => { if (event.target === $('manualMask')) closeManualDlg(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('manualMask').classList.contains('hidden')) closeManualDlg(); });
$('confirmMask').addEventListener('click', (event) => { if (event.target === $('confirmMask')) closeConfirmDlg(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('confirmMask').classList.contains('hidden')) closeConfirmDlg(); });
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
