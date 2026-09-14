'use strict';

// 远端临时脚本：从 /data/probe-state.json 删除指定 documentId。
// 入参：process.env.GHOST_IDS（逗号分隔）

const fs = require('fs');

const ids = String(process.env.GHOST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!ids.length) {
  console.error('GHOST_IDS 为空');
  process.exit(1);
}

const p = '/data/probe-state.json';
const state = JSON.parse(fs.readFileSync(p, 'utf8'));
const removed = [];

for (const id of ids) {
  if (state.documents && state.documents[id]) {
    delete state.documents[id];
    removed.push(id);
  }
}

for (const run of state.runs || []) {
  if (!Array.isArray(run.results)) continue;
  run.results = run.results.filter((row) => !ids.includes(row.documentId));
}

fs.writeFileSync(p, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ removed, remaining: Object.keys(state.documents || {}).length }));
