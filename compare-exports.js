'use strict';
// 对比基线(9-03, 修复前)与新导出(9-05, 修复后)两份 Excel 的参数矩阵完整度
const ExcelJS = require('exceljs');

async function stats(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet('参数对照');
  const quoteSheet = wb.getWorksheet('原文片段');
  const result = { file, totalFields: 0, okByDoc: {}, undisclosed: 0, extractFailed: 0, quotes: { total: 0, rule: 0, ai: 0 } };
  const docHeaders = [];
  const headerRow = sheet.getRow(2);
  headerRow.eachCell((cell, col) => { if (col > 2) docHeaders[col] = String(cell.value || ''); });
  for (const key of Object.keys(docHeaders)) result.okByDoc[docHeaders[key]] = 0;
  sheet.eachRow((row, rowNum) => {
    if (rowNum <= 2) return;
    const field = String(row.getCell(1).value || '');
    if (!field || field.startsWith('【') || field.startsWith('说明：')) return;
    result.totalFields += 1;
    for (const [colStr, label] of Object.entries(docHeaders)) {
      const text = String(row.getCell(Number(colStr)).value || '').trim();
      if (text === '（未披露）' || text === '') result.undisclosed += 1;
      else if (text === '（抽取失败）') result.extractFailed += 1;
      else result.okByDoc[label] += 1;
    }
  });
  quoteSheet.eachRow((row, rowNum) => {
    if (rowNum <= 1) return;
    const source = String(row.getCell(6).value || '').trim();
    result.quotes.total += 1;
    if (source === 'rule') result.quotes.rule += 1;
    else if (source === 'ai') result.quotes.ai += 1;
  });
  return result;
}

(async () => {
  const base = await stats('2026-09-03_对比_OmniSwitch2260_vs_CloudEngineS5731-S.xlsx');
  const now = await stats('2026-09-05_对比_CloudEngineS5731-S_vs_OmniSwitch2260.xlsx');
  const fmt = (s) => JSON.stringify(s.okByDoc, null, 0);
  console.log('=== 基线（2026-09-03，修复前） ===');
  console.log(`参数字段总数: ${base.totalFields}`);
  console.log(`有值分布: ${fmt(base)}`);
  console.log(`未披露单元格: ${base.undisclosed}, 抽取失败: ${base.extractFailed}`);
  console.log(`原文片段: ${base.quotes.total} 条 (rule=${base.quotes.rule}, ai=${base.quotes.ai})`);
  console.log('');
  console.log('=== 本次（2026-09-05，合并修复+引用校验+GLM-5.3-Flash） ===');
  console.log(`参数字段总数: ${now.totalFields}`);
  console.log(`有值分布: ${fmt(now)}`);
  console.log(`未披露单元格: ${now.undisclosed}, 抽取失败: ${now.extractFailed}`);
  console.log(`原文片段: ${now.quotes.total} 条 (rule=${now.quotes.rule}, ai=${now.quotes.ai})`);
  console.log('');
  console.log('=== 提升幅度 ===');
  console.log(`字段总数: ${base.totalFields} -> ${now.totalFields} (${now.totalFields - base.totalFields >= 0 ? '+' : ''}${now.totalFields - base.totalFields})`);
  for (const label of Object.keys(now.okByDoc)) {
    const before = base.okByDoc[label] ?? 0;
    console.log(`「${label}」有值: ${before} -> ${now.okByDoc[label]}`);
  }
  console.log(`原文片段: ${base.quotes.total} -> ${now.quotes.total} 条`);
})().catch((e) => { console.error(e); process.exit(1); });
