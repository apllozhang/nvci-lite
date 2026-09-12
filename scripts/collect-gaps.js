'use strict';
// 缺口补采：读取审计生成的 gap-ids.json，分批（≤50/批）调用采集接口，汇总结果
const fs = require('fs');
const BASE = 'http://10.20.30.203:8789';
const PASSWORD = 'admin123456';

(async () => {
  const ids = JSON.parse(fs.readFileSync(process.env.TEMP + '/gap-ids.json', 'utf8'));
  console.log(`缺口合计 ${ids.length} 条，分批采集…`);
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (login.status !== 200) throw new Error('登录失败');

  const all = [];
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    console.log(`—— 批次 ${start / 50 + 1}（${batch.length} 条）——`);
    const response = await fetch(`${BASE}/api/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ documentIds: batch }),
    });
    if (!response.ok) { console.log('批次失败：HTTP', response.status, (await response.text()).slice(0, 200)); continue; }
    const payload = await response.json();
    for (const row of payload.results) {
      all.push({ id: row.documentId, status: row.status, pages: row.pageCount || 0, err: (row.error || '').slice(0, 60) });
      const mark = row.status === 'completed' ? '✔' : '✘';
      console.log(` ${mark} ${row.documentId} ${row.status}${row.pageCount ? ` ${row.pageCount}页` : ''}${row.error ? ` ${String(row.error).slice(0, 60)}` : ''}`);
    }
  }
  const ok = all.filter((x) => x.status === 'completed');
  const failed = all.filter((x) => x.status !== 'completed');
  console.log(`\n汇总：成功 ${ok.length} / ${all.length}，失败 ${failed.length}`);
  if (failed.length) console.log('失败清单：', JSON.stringify(failed, null, 1));
  fs.writeFileSync(process.env.TEMP + '/collect-gap-result.json', JSON.stringify({ ok, failed }, null, 2));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
