'use strict';
// 缺口补采（稳健版）：
// ① 监视服务端在途批量采集，直到缺口入库数连续多轮趋稳
// ② 剩余缺口逐条采集（单条请求响应必在超时内，可断点续跑）
// ③ 汇总成功/失败清单
const fs = require('fs');
const BASE = 'http://10.20.30.203:8789';
const PASSWORD = 'admin123456';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const gapIds = JSON.parse(fs.readFileSync(process.env.TEMP + '/gap-ids.json', 'utf8'));
  const gapSet = new Set(gapIds);
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (login.status !== 200) throw new Error('登录失败');
  const getCollectedOfGap = async () => {
    const docs = await fetch(`${BASE}/api/library`, { headers: { cookie } }).then((r) => r.json()).then((p) => p.documents);
    return docs.filter((d) => gapSet.has(d.documentId));
  };

  // ① 监视在途批量：入库数连续 4 轮（每轮 90s）无变化即认为在途批次结束
  console.log('—— 阶段 1：监视在途批量采集 ——');
  let lastCount = -1;
  let stableRounds = 0;
  let rounds = 0;
  let collected = [];
  while (rounds < 40) {
    collected = await getCollectedOfGap();
    console.log(`[${new Date().toISOString().slice(11, 19)}] 缺口已入库 ${collected.length}/${gapIds.length}`);
    if (collected.length === lastCount) {
      stableRounds += 1;
      if (stableRounds >= 4) { console.log('入库数已趋稳，在途批次结束'); break; }
    } else {
      stableRounds = 0;
    }
    lastCount = collected.length;
    rounds += 1;
    await sleep(90000);
  }
  const doneIds = new Set(collected.map((d) => d.documentId));
  let remaining = gapIds.filter((id) => !doneIds.has(id));
  console.log(`在途批次结束后剩余缺口：${remaining.length} 条`);

  // ② 逐条采集剩余缺口
  console.log('—— 阶段 2：剩余缺口逐条采集 ——');
  const ok = collected.map((d) => ({ id: d.documentId, status: 'completed(pre-batch)', pages: d.pageCount || 0 }));
  const failed = [];
  for (const [index, id] of remaining.entries()) {
    try {
      const response = await fetch(`${BASE}/api/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ documentIds: [id] }),
        signal: AbortSignal.timeout(360000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const row = payload.results[0] || {};
      if (row.status === 'completed') {
        ok.push({ id, status: 'completed', pages: row.pageCount || 0 });
        console.log(` ✔ [${index + 1}/${remaining.length}] ${id} ${row.pageCount || '?'}页`);
      } else {
        failed.push({ id, status: row.status, err: String(row.error || '').slice(0, 80) });
        console.log(` ✘ [${index + 1}/${remaining.length}] ${id} ${row.status} ${String(row.error || '').slice(0, 80)}`);
      }
    } catch (error) {
      failed.push({ id, status: 'client_error', err: String(error.message || error).slice(0, 80) });
      console.log(` ✘ [${index + 1}/${remaining.length}] ${id} ${String(error.message || error).slice(0, 80)}`);
    }
  }

  // ③ 汇总
  console.log(`\n汇总：成功 ${ok.length} / ${gapIds.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败清单：');
    for (const f of failed) console.log(` ✘ ${f.id} [${f.status}] ${f.err}`);
  }
  fs.writeFileSync(process.env.TEMP + '/collect-gap-result.json', JSON.stringify({ ok, failed }, null, 2));
  console.log('结果已写入 collect-gap-result.json');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
