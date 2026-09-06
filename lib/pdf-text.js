'use strict';

// PDF 文本抽取：pdfjs-dist legacy 构建（CJS，Node 环境免 worker），按页输出，
// 行内按 y 坐标聚合、组内按 x 排序，尽量保留彩页规格表的行结构。
let pdfjsModule = null;

function loadPdfjs() {
  if (!pdfjsModule) {
    pdfjsModule = require('pdfjs-dist/legacy/build/pdf.js');
  }
  return pdfjsModule;
}

function groupItemsToLines(items) {
  const rows = [];
  const tolerance = 3;
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
    if (!row) {
      row = { y, cells: [] };
      rows.push(row);
    }
    row.cells.push({ x, str: item.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.cells.sort((a, b) => a.x - b.x);
    let line = '';
    let previousEnd = null;
    for (const cell of row.cells) {
      if (previousEnd !== null) {
        const gap = cell.x - previousEnd;
        if (gap > 1 && !/\s$/.test(line) && !/^\s/.test(cell.str)) line += gap > 20 ? '    ' : ' ';
      }
      line += cell.str;
      previousEnd = cell.x + (cell.width || 0);
    }
    return line.replace(/\s{2,}/g, '  ').trimEnd();
  }).filter((line) => line.trim());
}

async function extractPdfText(buffer, { maxPages = 60 } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  try {
    const pageCount = doc.numPages;
    const pages = [];
    const limit = Math.min(pageCount, maxPages);
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = groupItemsToLines(content.items);
      pages.push({ page: pageNumber, lines });
    }
    const fullText = pages.map((page) => page.lines.join('\n')).join('\n');
    return { pageCount, pages, fullText, truncated: pageCount > limit };
  } finally {
    await doc.destroy();
  }
}

module.exports = { extractPdfText };
