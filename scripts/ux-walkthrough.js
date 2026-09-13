'use strict';
// 普通用户视角全流程走查：逐步截图 + 状态采集，无 AI（材料包路径，快速走完）
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BASE = 'http://10.20.30.203:8789';
const PW = 'admin123456';
const issues = [];
const note = (s) => console.log('  [记录]', s);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--disable-gpu', '--no-sandbox', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { issues.push(`页面JS错误: ${String(e).slice(0, 150)}`); console.log('[pageerror]', String(e).slice(0, 150)); });
  page.on('console', (m) => { if (m.type() === 'error') { issues.push(`控制台错误: ${m.text().slice(0, 150)}`); } });
  const shot = (name) => page.screenshot({ path: `test/ux-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 1000 } });
  const dump = (label, obj) => console.log(label, JSON.stringify(obj).slice(0, 300));

  // ===== 登录 =====
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.type('#passwordInput', PW);
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.querySelector('#catalogTree')?.textContent.includes('ALE'), { timeout: 10000 }).catch(() => {});
  console.log('== 登录完成 ==');

  // ===== 第 1 步：选品牌与型号 =====
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tree-brand-btn')].find((el) => /Juniper/i.test(el.textContent));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    const l = [...document.querySelectorAll('.tree-line')].find((el) => /园区交换机/.test(el.textContent));
    if (l) l.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  await shot('1-step1-juniper-campus');
  const step1 = await page.evaluate(() => ({
    lineInfo: document.querySelector('#lineInfo').textContent,
    rows: document.querySelectorAll('#docTable tbody tr').length,
    searchPh: document.querySelector('#docSearch').placeholder,
    footerBtn: document.querySelector('#toStep2')?.textContent.trim(),
  }));
  dump('第1步 Juniper 园区:', step1);
  // 普通用户：勾两台 EX
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#docTable tbody tr')].filter((r) => /EX4100|EX4400/.test(r.textContent));
    rows.slice(0, 2).forEach((r) => r.click());
  });
  await new Promise((r) => setTimeout(r, 400));
  const tray = await page.evaluate(() => ({
    selCount: document.querySelector('#selCount')?.textContent,
    trayVisible: !document.querySelector('#selTray')?.classList.contains('hidden'),
  }));
  dump('第1步 已选托盘:', tray);
  if (tray.selCount !== '2') issues.push(`第1步勾选后托盘计数异常: ${tray.selCount}`);

  // ===== 第 2 步：采集 =====
  await page.evaluate(() => document.querySelector('#toStep2')?.click());
  await new Promise((r) => setTimeout(r, 1500));
  await shot('2-step2-collect');
  const step2 = await page.evaluate(() => ({
    body: document.querySelector('#step2').textContent.replace(/\s+/g, ' ').slice(0, 250),
    collectBtns: [...document.querySelectorAll('#step2 button')].map((b) => b.textContent.trim()).slice(0, 6),
  }));
  dump('第2步:', step2);

  // ===== 第 3 步：选对比产品 =====
  await page.evaluate(async () => { await goStep(3); });
  await new Promise((r) => setTimeout(r, 1000));
  await shot('3-step3-initial');
  const step3Init = await page.evaluate(() => ({
    searchVisible: Boolean(document.querySelector('#librarySearch')),
    chips: [...document.querySelectorAll('#catChips .chip')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')),
    foldedCount: document.querySelectorAll('#libraryList .cmp-category').length,
    visibleRows: document.querySelectorAll('#libraryList .doc-row').length,
    toStep4Disabled: document.querySelector('#toStep4').disabled,
  }));
  dump('第3步 初始态:', step3Init);
  // 普通用户：勾 Juniper 已采的两台 + 跨品类加一台 SRX1500（安全网关）
  await page.evaluate(() => {
    const campus = [...document.querySelectorAll('.cmp-cat-head')].find((el) => el.textContent.includes('园区'));
    if (campus) campus.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#libraryList .doc-row')].filter((r) => /EX4100|EX4400/.test(r.textContent));
    rows.slice(0, 2).forEach((r) => r.click());
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.type('#librarySearch', 'SRX1500');
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => document.querySelector('#libraryList .doc-row')?.click());
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => { document.querySelector('#librarySearch').value = ''; document.querySelector('#librarySearch').dispatchEvent(new Event('input', { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 600));
  await shot('3-step3-selected3');
  const step3 = await page.evaluate(() => ({
    count: document.querySelector('#cmpCount').textContent,
    warnShown: !document.querySelector('#cmpWarn').classList.contains('hidden'),
    warnText: document.querySelector('#cmpWarn').textContent.replace(/\s+/g, ' ').slice(0, 120),
    toStep4Enabled: !document.querySelector('#toStep4').disabled,
    peers: document.querySelectorAll('.doc-row.is-peer').length,
  }));
  dump('第3步 选完3台:', step3);
  if (step3.count !== '3') issues.push(`第3步勾3台后计数=${step3.count}`);
  if (!step3.toStep4Enabled) issues.push('第3步三台选完下一步仍禁用');
  if (!step3.warnShown) issues.push('第3步跨品类（园区×2+安全×1）未出警示');

  // ===== 第 4 步：分析报告（无 AI 材料包快速路径） =====
  await page.evaluate(() => document.querySelector('#toStep4')?.click());
  await new Promise((r) => setTimeout(r, 1000));
  await shot('4-step4-initial');
  const step4 = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('#step4 button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })).slice(0, 8),
    thresholdFields: document.querySelectorAll('#step4 select').length,
    exportList: document.querySelector('#exportList')?.textContent.replace(/\s+/g, ' ').slice(0, 120),
  }));
  dump('第4步 初始:', step4);
  // 加一条门槛（下拉+输入）
  const thrAdded = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('#step4 select')];
    if (!selects.length) return { hasThresholdUi: false };
    return { hasThresholdUi: true, selectCount: selects.length };
  });
  dump('第4步 门槛 UI:', thrAdded);

  // ===== 生成（材料包路径）=====
  const genBtn = await page.$('#generateBtn');
  if (genBtn) {
    const genStart = Date.now();
    await page.evaluate(() => { const b = document.querySelector('#generateBtn'); b.disabled = false; });
    await genBtn.click();
    // 轮询按钮状态变化（检测生成期间的用户反馈）
    let sawLoading = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const btnState = await page.evaluate(() => {
        const b = document.querySelector('#generateBtn');
        return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
      });
      if (btnState && (btnState.disabled || /生成中|分析中|\.\.\./.test(btnState.text))) { sawLoading = true; break; }
      if (!btnState) break;
    }
    // 等完成（最长 90s）
    await page.waitForFunction(() => {
      const b = document.querySelector('#generateBtn');
      return b && !b.disabled;
    }, { timeout: 90000 }).catch(() => {});
    const genElapsed = ((Date.now() - genStart) / 1000).toFixed(1);
    console.log(`== 生成耗时 ${genElapsed}s，过程中有加载反馈: ${sawLoading} ==`);
    if (!sawLoading) issues.push(`生成期间按钮无加载态反馈（耗时 ${genElapsed}s，普通用户会以为卡死）`);
    await shot('4-step4-generated');
    const exports1 = await page.evaluate(() => document.querySelector('#exportList')?.textContent.replace(/\s+/g, ' ').slice(0, 200));
    dump('第4步 生成后导出列表:', exports1);
    if (!exports1 || !/\.xlsx|\.md|\.docx/.test(exports1)) issues.push('生成后导出列表无文件');
  } else {
    issues.push('第4步未找到生成按钮 #generateBtn');
  }

  // ===== 第 5 步：彩页校验（轻量探 2 条）=====
  await page.evaluate(() => goStep(5));
  await new Promise((r) => setTimeout(r, 1500));
  await shot('5-step5-probe');
  const step5 = await page.evaluate(() => ({
    hasRunBtn: Boolean([...document.querySelectorAll('#step5 button')].find((b) => /校验|探测|检测/.test(b.textContent))),
    legendOrChips: document.querySelectorAll('#step5 .chip').length,
  }));
  dump('第5步:', step5);

  // ===== 设置面板 =====
  await page.evaluate(() => document.querySelector('#settingsBtn')?.click());
  await new Promise((r) => setTimeout(r, 600));
  await shot('6-settings');
  const settings = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('#settingsDlg .dlg-sec-title')].map((s) => s.textContent),
    passMode: document.querySelector('#sPassMode')?.textContent,
  }));
  dump('设置面板:', settings);
  await page.evaluate(() => document.querySelector('#sClose')?.click());

  // ===== 汇总 =====
  console.log('\n========== 走查问题清单 ==========');
  if (issues.length) issues.forEach((x, i) => console.log(`${i + 1}. ${x}`));
  else console.log('（未发现明显问题）');
  fs.writeFileSync(process.env.TEMP + '/ux-issues.json', JSON.stringify(issues, null, 2));
  await browser.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
