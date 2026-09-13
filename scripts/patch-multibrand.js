'use strict';
// 一次性补丁（v2，CRLF 免疫）：跨品牌多选主路径
const fs = require('fs');
let app = fs.readFileSync('public/app.js', 'utf8');

if (!app.includes('cmpDropped')) {
  app = app.replace(
    '  cmpSel: new Set(),     // 对比勾选',
    '  cmpSel: new Set(),     // 对比勾选\n  cmpDropped: new Set(), // 第 3 步手动取消过的对比勾选（往返不再自动带回）',
  );
}

if (!app.includes('跨品牌多选主路径')) {
  const anchorG = '  if (step === 3) renderLibrary();';
  if (!app.includes(anchorG)) throw new Error('goStep 锚点未找到');
  app = app.replace(anchorG, [
    '  if (step === 3) {',
    '    // 跨品牌多选主路径：第 1 步勾选且已采集的自动带入对比（手动取消过的不再带回）',
    '    for (const id of state.selected.keys()) {',
    '      if (state.collected.has(id) && !state.cmpDropped.has(id)) state.cmpSel.add(id);',
    '    }',
    '    renderLibrary();',
    '  }',
  ].join('\n'));
}

if (!app.includes('第 1 步取消勾选 = 不再参与对比')) {
  const reT = /if \(state\.selected\.has\(documentId\)\) state\.selected\.delete\(documentId\);\r?\n  else state\.selected\.set\(documentId, doc\);/;
  if (!reT.test(app)) throw new Error('toggleDocSelect 锚点未找到');
  app = app.replace(reT, [
    '  if (state.selected.has(documentId)) {',
    '    state.selected.delete(documentId);',
    "    state.cmpSel.delete(documentId); // 第 1 步取消勾选 = 不再参与对比",
    '  } else {',
    '    state.selected.set(documentId, doc);',
    '    state.cmpDropped.delete(documentId); // 重新勾选视为重新想要',
    '  }',
  ].join('\n'));
}

if (!app.includes('cmpDropped.add(id)')) {
  const reR = /if \(event\.target === input\) \{\r?\n      if \(input\.checked\) state\.cmpSel\.add\(id\);\r?\n      else state\.cmpSel\.delete\(id\);\r?\n    \} else \{\r?\n      event\.preventDefault\(\);\r?\n      if \(state\.cmpSel\.has\(id\)\) state\.cmpSel\.delete\(id\);\r?\n      else state\.cmpSel\.add\(id\);\r?\n      input\.checked = state\.cmpSel\.has\(id\);\r?\n    \}/;
  if (!reR.test(app)) throw new Error('行点击锚点未找到');
  app = app.replace(reR, [
    'if (event.target === input) {',
    '      if (input.checked) { state.cmpSel.add(id); state.cmpDropped.delete(id); }',
    '      else { state.cmpSel.delete(id); state.cmpDropped.add(id); }',
    '    } else {',
    '      event.preventDefault();',
    "      if (state.cmpSel.has(id)) { state.cmpSel.delete(id); state.cmpDropped.add(id); }",
    '      else { state.cmpSel.add(id); state.cmpDropped.delete(id); }',
    '      input.checked = state.cmpSel.has(id);',
    '    }',
  ].join('\n'));
}

fs.writeFileSync('public/app.js', app);
console.log('跨品牌多选主路径补丁完成（含幂等检查）');
