'use strict';
// 规范对齐前后对比截图：NAS（旧）vs 本地（新），同视角；本地加按钮悬停浮起特写
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function shotStep1(base, outFile, { login } = {}) {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--disable-gpu', '--no-sandbox'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  if (login) {
    await page.type('#passwordInput', login);
    await page.click('#loginBtn');
    await page.waitForFunction(() => document.querySelector('#catalogTree')?.textContent.includes('ALE'), { timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tree-brand-btn')].find((el) => /ALE/i.test(el.textContent));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    const l = [...document.querySelectorAll('.tree-line')].find((el) => /OmniSwitch/.test(el.textContent));
    if (l) l.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width: 1440, height: 620 } });
  await browser.close();
}

(async () => {
  await shotStep1('http://10.20.30.203:8789', 'test/design-before.png', { login: 'Nvci@Lite2026' });
  console.log('before ✓');
  await shotStep1('http://127.0.0.1:8788', 'test/design-after.png');
  console.log('after ✓');

  // 悬停浮起特写：本地「下一步」按钮 hover 前后
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--disable-gpu', '--no-sandbox'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8788', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tree-brand-btn')].find((el) => /ALE/i.test(el.textContent));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => {
    const l = [...document.querySelectorAll('.tree-line')].find((el) => /OmniSwitch/.test(el.textContent));
    if (l) l.click();
  });
  await new Promise((r) => setTimeout(r, 700));
  const btn = await page.$('#toStep2');
  const box = await btn.boundingBox();
  const clip = { x: Math.max(0, box.x - 420), y: Math.max(0, box.y - 60), width: 470, height: 140 };
  await page.screenshot({ path: 'test/design-hover-0.png', clip });
  await btn.hover();
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: 'test/design-hover-1.png', clip });
  await browser.close();
  console.log('hover ✓');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
