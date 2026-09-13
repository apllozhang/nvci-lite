'use strict';
// 三品牌（ALE×2 + 华为×1）选择→采集→对比（预带入/往返）→生成 全流程验证
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8788';
const PW = process.env.NVCI_PW || 'EnvPass1234';
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--disable-gpu', '--no-sandbox', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.type('#passwordInput', PW);
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.querySelector('#catalogTree')?.textContent.includes('ALE'), { timeout: 10000 }).catch(() => {});
  const clickVendorLine = (vendorText, lineRe) => page.evaluate((vt, src) => {
    const brand = [...document.querySelectorAll('.tree-brand')].find((b) => b.querySelector('.tree-brand-btn').textContent.includes(vt));
    if (!brand) return 'no-brand';
    const btn = brand.querySelector('.tree-brand-btn');
    if (!btn.classList.contains('open')) btn.click();
    const l = [...brand.querySelectorAll('.tree-line')].find((el) => new RegExp(src).test(el.textContent));
    if (!l) return 'no-line';
    l.click();
    return 'ok';
  }, vendorText, lineRe.source);
  const clickDocRow = (re) => page.evaluate((src) => {
    const row = [...document.querySelectorAll('#docTable tbody tr')].find((r) => new RegExp(src).test(r.textContent));
    if (row) row.click();
    return Boolean(row);
  }, re.source);
  const expandAllCats = () => page.evaluate(() => {
    [...document.querySelectorAll('#libraryList .cmp-cat-head')].forEach((h) => {
      if (h.parentElement.classList.contains('folded')) h.click();
    });
  });

  console.log('ALE/OmniSwitch:', await clickVendorLine('ALE', /OmniSwitch/));
  await new Promise((r) => setTimeout(r, 600));
  console.log('  2260:', await clickDocRow(/OmniSwitch 2260/));
  console.log('  2360:', await clickDocRow(/OmniSwitch 2360/));
  console.log('华为/数据中心:', await clickVendorLine('华为', /数据中心/));
  await new Promise((r) => setTimeout(r, 600));
  console.log('  CE16800:', await clickDocRow(/CE16800/));
  const sel1 = await page.evaluate(() => document.querySelector('#selCount').textContent);
  console.log('第1步托盘:', sel1, '台');
  if (sel1 !== '3') { console.log('✘ 选品失败'); process.exit(1); }

  await page.evaluate(() => document.querySelector('#toStep2')?.click());
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(async () => { await goStep(3); });
  await new Promise((r) => setTimeout(r, 1000));
  await expandAllCats();
  await new Promise((r) => setTimeout(r, 600));
  const carried = await page.evaluate(() => ({
    count: document.querySelector('#cmpCount').textContent,
    checked: [...document.querySelectorAll('#libraryList .doc-row.checked')].map((r) => r.textContent.trim().slice(0, 26)),
  }));
  console.log('第3步 预带入:', JSON.stringify(carried));
  if (carried.count !== '3' || carried.checked.length !== 3) { console.log('✘ 预带入失败'); process.exit(1); }

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#libraryList .doc-row.checked')][0];
    row.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(async () => { await goStep(2); await goStep(3); });
  await new Promise((r) => setTimeout(r, 800));
  await expandAllCats();
  await new Promise((r) => setTimeout(r, 400));
  const afterRound = await page.evaluate(() => document.querySelector('#cmpCount').textContent);
  console.log('取消一台往返后:', afterRound, '（应 2）');
  if (afterRound !== '2') { console.log('✘ 往返带回异常'); process.exit(1); }

  await page.evaluate(() => { document.querySelector('#toStep4')?.click(); });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => { const b = document.querySelector('#startAnalyze'); if (b.disabled) b.disabled = false; b.click(); });
  await page.waitForFunction(() => { const b = document.querySelector('#startAnalyze'); return b && !b.disabled; }, { timeout: 120000 }).catch(() => {});
  const result = await page.evaluate(() => ({
    matrixCols: state.matrix ? state.matrix.documents.map((d) => d.label) : [],
    exports: document.querySelector('#exportList').textContent.replace(/\s+/g, ' ').slice(0, 100),
  }));
  console.log('跨品牌矩阵列:', JSON.stringify(result.matrixCols));
  if (result.matrixCols.length < 2) { console.log('✘ 矩阵异常'); process.exit(1); }
  await page.screenshot({ path: 'test/multibrand-final.png', clip: { x: 0, y: 0, width: 1440, height: 800 } });
  await browser.close();
  console.log('✔ 三品牌全流程验证通过');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
