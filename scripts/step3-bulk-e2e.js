'use strict';
// 第 3 步品类级批量选择（全选/反选）无头验收：
// 折叠态可用（不触发折叠切换）、大批量 confirm 双路径、筛选作用域（厂商 chip 收窄后无弹窗）、反选归零。
// 依赖已采集库 → 默认对生产跑；选择状态纯前端不落库，无副作用。
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://10.20.30.203:8789';
const PW = process.env.NVCI_PW || 'admin123456';
const ok = (name, cond, detail) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--disable-gpu', '--no-sandbox', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 120)));
  let dialogMsg = null;
  page.on('dialog', async (d) => { dialogMsg = d.message(); await d.accept(); });

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1000);
  await page.type('#passwordInput', PW);
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.querySelector('#catalogTree')?.textContent.includes('ALE'), { timeout: 15000 });

  // 直接进第 3 步（需要已采集库；生产库非空）
  await page.evaluate(() => document.querySelector('.step[data-step="3"]')?.click());
  await page.waitForFunction(() => document.querySelectorAll('#libraryList .cmp-category').length > 0, { timeout: 15000 });
  await sleep(500);

  // 预带入的选择先清空，保证断言确定性
  const hadPreCarry = await page.evaluate(() => !document.querySelector('#cmpClearAll').classList.contains('hidden'));
  if (hadPreCarry) { await page.click('#cmpClearAll'); await sleep(300); }
  ok('起始 cmpSel = 0', await page.evaluate(() => document.querySelector('#cmpCount').textContent) === '0');

  // 默认全折叠（无筛选态），品类头批量按钮存在
  ok('品类头批量按钮存在', await page.evaluate(() => document.querySelectorAll('#libraryList .cat-mini').length) >= 2);
  ok('默认品类折叠态', await page.evaluate(() => document.querySelector('#libraryList .cmp-category').classList.contains('folded')));

  // 取份数最大的品类，折叠态直接点全选（自动接受 confirm）
  const maxCat = await page.evaluate(() => {
    const cats = [...document.querySelectorAll('#libraryList .cmp-category')];
    return cats.map((c) => ({
      cat: c.querySelector('.cmp-cat-head').dataset.cat,
      n: parseInt(c.querySelector('.cmp-cat-head .chip-count').textContent, 10),
    })).sort((a, b) => b.n - a.n)[0];
  });
  ok('最大品类 > 20 份（走确认路径）', maxCat.n > 20, `${maxCat.cat} = ${maxCat.n} 份`);
  dialogMsg = null;
  await page.click(`#libraryList .cat-mini[data-op="all"][data-cat="${maxCat.cat}"]`);
  await sleep(400);
  ok('大批量弹出确认框且含份数', dialogMsg !== null && dialogMsg.includes(String(maxCat.n)), dialogMsg || '未弹窗');
  ok('折叠态全选生效', await page.evaluate(() => document.querySelector('#cmpCount').textContent) === String(maxCat.n),
    await page.evaluate(() => document.querySelector('#cmpCount').textContent));
  ok('批量按钮不触发折叠切换（仍折叠）', await page.evaluate(() => document.querySelector('#libraryList .cmp-category').classList.contains('folded')));

  // 同品类反选 → 该品类全部退出，cmpSel 归零
  await page.click(`#libraryList .cat-mini[data-op="invert"][data-cat="${maxCat.cat}"]`);
  await sleep(400);
  ok('反选后归零（全选中反选）', await page.evaluate(() => document.querySelector('#cmpCount').textContent) === '0');

  // 筛选作用域：点厂商 chip ALE 收窄后，品类批量只作用于命中集（ALE 采集量小，≤20 不弹窗）
  await page.evaluate(() => {
    [...document.querySelectorAll('#vendorChips button')].find((b) => /ALE/.test(b.textContent))?.click();
  });
  await sleep(500);
  const scoped = await page.evaluate(() => {
    const head = document.querySelector('#libraryList .cmp-cat-head');
    return { cat: head.dataset.cat, n: parseInt(head.querySelector('.chip-count').textContent, 10) };
  });
  ok('厂商筛选后品类命中 ≤ 20（免确认路径）', scoped.n > 0 && scoped.n <= 20, `${scoped.cat} = ${scoped.n} 份`);
  dialogMsg = null;
  await page.click(`#libraryList .cat-mini[data-op="all"][data-cat="${scoped.cat}"]`);
  await sleep(400);
  ok('小批量不弹确认框', dialogMsg === null, dialogMsg || '无弹窗');
  ok('筛选作用域全选数量精确', await page.evaluate(() => document.querySelector('#cmpCount').textContent) === String(scoped.n),
    await page.evaluate(() => document.querySelector('#cmpCount').textContent));
  // 反选清掉，且不影响其他品类（此态下其他品类本就未选 → 归零）
  await page.click(`#libraryList .cat-mini[data-op="invert"][data-cat="${scoped.cat}"]`);
  await sleep(400);
  ok('筛选作用域反选归零', await page.evaluate(() => document.querySelector('#cmpCount').textContent) === '0');

  // 清理 + 无页面错误
  await page.evaluate(() => { const b = document.querySelector('#cmpClearAll'); if (!b.classList.contains('hidden')) b.click(); });
  await sleep(300);
  ok('无页面错误', pageErrors.length === 0, pageErrors.join(' | ') || '无页面错误');

  await browser.close();
  console.log(process.exitCode ? '\n== 存在失败断言 ==' : '\n== 全部断言通过 ==');
})().catch((e) => { console.error('脚本失败:', e.message); process.exit(1); });
