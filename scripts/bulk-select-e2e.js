'use strict';
// 第 1 步批量选择（全选/全不选/反选）无头验收：
// ALE·OmniAccess 无线接入 13 份为样本，验证筛选作用域、托盘联动、反选、幂等、
// 以及 toast 遮挡死区回归（上一操作 toast 未消失时立即点相邻按钮必须生效）
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8790';
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
  // confirm 弹窗行为由测试动态指定：'accept' 接受 / 'dismiss' 取消；记录最近一次弹窗文案
  let dialogAction = null;
  let dialogMsg = null;
  page.on('dialog', async (d) => {
    dialogMsg = d.message();
    if (dialogAction === 'accept') await d.accept();
    else await d.dismiss();
  });

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1000);
  await page.type('#passwordInput', PW);
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.querySelector('#catalogTree')?.textContent.includes('ALE'), { timeout: 15000 });

  // 进入 ALE · OmniAccess 无线接入
  await page.evaluate(() => {
    [...document.querySelectorAll('.tree-brand-btn')].find((el) => /ALE/.test(el.textContent))?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll('.tree-line')].find((el) => /OmniAccess 无线接入/.test(el.textContent))?.click();
  });
  await sleep(600);

  const total = await page.evaluate(() => document.querySelectorAll('#docTable tbody tr').length);
  ok('ALE 无线接入加载 13 份', total === 13, `实际 ${total}`);
  ok('批量按钮组可见', await page.evaluate(() => !document.querySelector('#pickerBulk').classList.contains('hidden')));

  // 1) 全选 13 份 → 托盘 13（13 ≤ 20 阈值，不应弹确认框）
  dialogMsg = null;
  await page.click('#selAllBtn');
  await sleep(300);
  ok('13 份全选不弹确认框（阈值内）', dialogMsg === null, dialogMsg || '无弹窗');
  ok('全选后托盘 13', await page.evaluate(() => document.querySelector('#selCount').textContent) === '13');
  ok('全选后所有行勾上', await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('#docTable tbody input')];
    return inputs.length === 13 && inputs.every((i) => i.checked);
  }));
  ok('全选后清空全部按钮出现', await page.evaluate(() => !!document.querySelector('#trayClearAll')));

  // 2) 幂等：再点一次全选不应变成反选
  await page.click('#selAllBtn');
  await sleep(300);
  ok('重复全选仍是 13（幂等）', await page.evaluate(() => document.querySelector('#selCount').textContent) === '13');

  // 3) toast 死区回归：全选 toast（4.2s 存活期）未消失时立即点反选，必须生效
  await page.click('#selInvertBtn');
  await sleep(300);
  ok('toast 存活期内点反选不被遮挡', await page.evaluate(() => document.querySelector('#selCount').textContent) === '0',
    await page.evaluate(() => document.querySelector('#selCount').textContent));
  ok('toast 存活期内按钮中心不被 toast 覆盖', await page.evaluate(() => {
    const b = document.querySelector('#selInvertBtn').getBoundingClientRect();
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return el && (el.id === 'selInvertBtn' || el.closest('#selInvertBtn') || el.closest('.picker-bulk'));
  }));

  // 4) 清零后搜索筛选 → 全选只作用于可见行
  await page.type('#docSearch', 'AP15');
  await sleep(500);
  const visible = await page.evaluate(() => document.querySelectorAll('#docTable tbody tr').length);
  ok('筛选后可见行数 < 13', visible > 0 && visible < 13, `可见 ${visible}`);
  ok('筛选提示出现在行数信息', await page.evaluate(() => /当前显示/.test(document.querySelector('#lineInfo').textContent)));
  await page.click('#selAllBtn');
  await sleep(300);
  const selAfterFilteredAll = await page.evaluate(() => Number(document.querySelector('#selCount').textContent));
  ok('筛选后全选只加可见行', selAfterFilteredAll === visible, `托盘 ${selAfterFilteredAll} / 可见 ${visible}`);

  // 5) 清空筛选 → 可见行之外的不该被选中，已选也不丢
  await page.evaluate(() => { const i = document.querySelector('#docSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  const selAfterUnfilter = await page.evaluate(() => Number(document.querySelector('#selCount').textContent));
  ok('清空筛选后托盘保持筛选期选择', selAfterUnfilter === selAfterFilteredAll, `托盘 ${selAfterUnfilter}`);
  ok('筛选外行确实未被选中（作用域正确）', await page.evaluate((n) => {
    const inputs = [...document.querySelectorAll('#docTable tbody input')];
    return inputs.length === 13 && inputs.filter((i) => i.checked).length === n;
  }, selAfterUnfilter));

  // 6) 反选：13 - 已选 = 反选后数量
  await page.click('#selInvertBtn');
  await sleep(300);
  const selAfterInvert = await page.evaluate(() => Number(document.querySelector('#selCount').textContent));
  ok('反选数量 = 13 - 原已选', selAfterInvert === 13 - selAfterFilteredAll, `反选后 ${selAfterInvert}`);
  ok('反选后行勾选视觉同步', await page.evaluate((n) => {
    const inputs = [...document.querySelectorAll('#docTable tbody input')];
    return inputs.filter((i) => i.checked).length === n;
  }, selAfterInvert));

  // 7) 全不选 → 托盘清零、托盘隐藏
  await page.click('#selNoneBtn');
  await sleep(300);
  ok('全不选后托盘 0', await page.evaluate(() => document.querySelector('#selCount').textContent) === '0');
  ok('全不选后托盘隐藏', await page.evaluate(() => document.querySelector('#selTray').classList.contains('hidden')));

  // 8) 空选状态下再点全不选：无变化提示而非报错
  await page.click('#selNoneBtn');
  await sleep(300);
  ok('空态再点全不选不报错', pageErrors.length === 0, pageErrors.join(' | ') || '无页面错误');

  // ===== 大产品线确认弹窗：Cisco 数据中心交换机 52 份（>20 阈值，>50 上限话术） =====
  await page.evaluate(() => {
    [...document.querySelectorAll('.tree-brand-btn')].find((el) => /Cisco/.test(el.textContent))?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll('.tree-line')].find((el) => /数据中心交换机/.test(el.textContent))?.click();
  });
  await sleep(600);
  const dcTotal = await page.evaluate(() => document.querySelectorAll('#docTable tbody tr').length);
  ok('Cisco 数据中心交换机 > 20 份', dcTotal > 20, `实际 ${dcTotal}`);
  await page.evaluate(() => { const i = document.querySelector('#docSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });

  dialogAction = 'dismiss';
  dialogMsg = null;
  await page.click('#selAllBtn');
  await sleep(300);
  ok('大批量全选弹出确认框', dialogMsg !== null && dialogMsg.includes(String(dcTotal)), dialogMsg || '未弹窗');
  ok('取消确认后不勾选', await page.evaluate(() => document.querySelector('#selCount').textContent) === '0',
    await page.evaluate(() => document.querySelector('#selCount').textContent));
  if (dcTotal > 50) ok('超 50 上限时话术含上限提示', dialogMsg.includes('50'), dialogMsg || '');

  dialogAction = 'accept';
  await page.click('#selAllBtn');
  await sleep(300);
  ok('确认后全选生效', await page.evaluate(() => document.querySelector('#selCount').textContent) === String(dcTotal),
    await page.evaluate(() => document.querySelector('#selCount').textContent));
  dialogAction = null;
  await page.click('#selNoneBtn');
  await sleep(200);
  ok('大批量场景结束托盘归零', pageErrors.length === 0, pageErrors.join(' | ') || '无页面错误');

  await browser.close();
  console.log(process.exitCode ? '\n== 存在失败断言 ==' : '\n== 全部断言通过 ==');
})().catch((e) => { console.error('脚本失败:', e.message); process.exit(1); });
