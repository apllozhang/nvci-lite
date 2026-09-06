'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildExcel, buildWordDocx, buildMaterialPack } = require('../lib/report');
const { buildMatrix } = require('../lib/params');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nvci-lite-report-')); }

const ENTRIES = [
  {
    documentId: 'a', label: '华为 S5731-S',
    params: [
      { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '598Gbit/s', quote: '交换容量：598Gbit/s', page: 1, status: 'ok', source: 'rule' },
      { key: 'form_factor', label: '外形/机架高度', group: '物理规格', value: '1U', quote: '外形：1U 高度', page: 1, status: 'ok', source: 'rule' },
    ],
  },
  {
    documentId: 'b', label: 'H3C S5120V3',
    params: [
      { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '336Gbit/s', quote: '背板带宽 336Gbit/s', page: 2, status: 'ok', source: 'ai' },
    ],
  },
];

const DOCUMENTS = [
  { documentId: 'a', vendorName: '华为', series: 'S5731-S', modelNames: ['S5731-S24P4X'], officialFileName: 'a.pdf', pdfUrl: 'https://example.com/a.pdf', productPageUrl: '', sha256: 'a'.repeat(64), pageCount: 4, collectedAt: '2026-09-03', warning: '' },
  { documentId: 'b', vendorName: '新华三 H3C', series: 'S5120V3-EI', modelNames: ['S5120V3-28P-EI'], officialFileName: 'b.pdf', pdfUrl: 'https://example.com/b.pdf', productPageUrl: '', sha256: 'b'.repeat(64), pageCount: 3, collectedAt: '2026-09-03', warning: '' },
];

test('Excel：三个工作表生成且参数行含三态', async () => {
  const dir = tempDir();
  try {
    const outPath = path.join(dir, 'out.xlsx');
    await buildExcel({ matrix: buildMatrix(ENTRIES), documents: DOCUMENTS, outPath });
    assert.ok(fs.existsSync(outPath) && fs.statSync(outPath).size > 4000);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['参数对照', '资料清单', '原文片段']);
    const cell = workbook.worksheets[0].getCell('A2').value;
    assert.equal(cell, '参数', '第 2 行应为表头');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Excel：待复核单元格显示取值并带批注', async () => {
  const dir = tempDir();
  try {
    const outPath = path.join(dir, 'out.xlsx');
    const entries = [{
      documentId: 'a', label: '锐捷 RG-MACC',
      params: [
        { key: 'switching_capacity', label: '交换容量', group: '转发性能', value: '176Gbps', quote: '', page: 2, status: 'pending_review', source: 'vision' },
      ],
    }];
    const documents = [{ documentId: 'a', vendorName: '锐捷网络', series: 'RG-MACC', modelNames: [], officialFileName: 'm.pdf', pdfUrl: 'https://example.com/m.pdf', productPageUrl: '', sha256: 'c'.repeat(64), pageCount: 6, collectedAt: '2026-09-06', warning: '' }];
    await buildExcel({ matrix: buildMatrix(entries), documents, outPath });
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.worksheets[0];
    const valueCell = sheet.getCell('C4'); // 第 3 行为分组行，第 4 行为首个参数行
    assert.equal(valueCell.value, '176Gbps', '待复核值应照常显示');
    assert.equal(valueCell.font.italic, true, '待复核值应为斜体');
    assert.match(String(valueCell.note || ''), /待核对/, '应有待核对批注');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Excel：无参数资料的字段单元格显示「（未找到）」而非「（未披露）」', async () => {
  const dir = tempDir();
  try {
    const outPath = path.join(dir, 'out.xlsx');
    const entries = [{ documentId: 'a', label: '空资料', params: [] }];
    await buildExcel({ matrix: buildMatrix(entries, { initTemplate: true }), documents: DOCUMENTS.slice(0, 1), outPath });
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.worksheets[0];
    const cells = [];
    sheet.eachRow((row, rowNum) => {
      if (rowNum <= 2) return;
      const field = String(row.getCell(1).value || '');
      if (!field || field.startsWith('【') || field.startsWith('说明：')) return;
      cells.push(String(row.getCell(3).value || ''));
    });
    assert.ok(cells.length >= 14, `模板字段行应齐全，实际 ${cells.length}`);
    assert.ok(cells.every((text) => text === '（未找到）'), `全部应为（未找到），样例：${cells[0]}`);
    assert.ok(!cells.includes('（未披露）'), '不得再出现旧语义（未披露）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word：docx 生成且为有效 zip 包', async () => {
  const dir = tempDir();
  try {
    const outPath = path.join(dir, 'out.docx');
    const analysis = {
      executive_summary: '两系列定位接近，华为在交换容量与 PoE 预算上占优。',
      hard_gates: [{ field: '交换容量', finding: '598 vs 336Gbit/s，高密场景差异显著。' }],
      parameter_analysis: [{ field: '外形', finding: '两者均 1U。' }],
      key_deviations: ['PoE 预算差 130W。'],
      scenario_advice: [{ scenario: '高密无线 AP 供电', recommendation: '倾向华为 S5731-S。' }],
      procurement_questions: ['请厂商确认整机 PoE 预算实测值。'],
    };
    await buildWordDocx({ analysis, matrix: buildMatrix(ENTRIES), documents: DOCUMENTS, outPath });
    const buffer = fs.readFileSync(outPath);
    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK', 'docx 应为 zip 开头');
    assert.ok(buffer.length > 5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AI 材料包：单个 Markdown 含提示词、矩阵 JSON 与全文', () => {
  const dir = tempDir();
  try {
    const outPath = path.join(dir, 'pack.md');
    buildMaterialPack({
      matrix: buildMatrix(ENTRIES),
      documents: DOCUMENTS,
      extractions: [{ label: '华为 S5731-S', pageCount: 1, pages: [{ page: 1, lines: ['交换容量：598Gbit/s'] }] }],
      outPath,
    });
    const text = fs.readFileSync(outPath, 'utf8');
    assert.match(text, /AI 分析材料包/);
    assert.match(text, /提示词/);
    assert.match(text, /"switching_capacity"|switching_capacity/);
    assert.match(text, /交换容量：598Gbit\/s/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
