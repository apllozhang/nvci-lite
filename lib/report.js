'use strict';

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { cellStatusText } = require('./params');

// Excel 参数对照表：三个工作表（参数对照 / 资料清单 / 原文片段）。
async function buildExcel({ matrix, documents, outPath }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NVCI Lite';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('参数对照', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  // 列键用 columnId（T05 型号分列：同一彩页多型号各占一列），单列时与 documentId 相同
  sheet.columns = [
    { key: 'field', width: 22 },
    { key: 'group', width: 12 },
    ...matrix.documents.map((doc) => ({ key: doc.columnId || doc.documentId, width: 30 })),
  ];
  sheet.mergeCells(1, 1, 1, 2 + matrix.documents.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `多品牌参数对照表 · 生成于 ${new Date().toLocaleString('zh-CN')} · 来源：厂商公开彩页`;
  titleCell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  titleCell.alignment = { horizontal: 'center' };
  const headerRow = sheet.getRow(2);
  headerRow.values = ['参数', '分组', ...matrix.documents.map((doc) => doc.label)];
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };

  for (const group of matrix.groups) {
    const groupRow = sheet.addRow({ field: `【${group.group}】`, group: '' });
    groupRow.font = { bold: true };
    groupRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    for (const field of group.fields) {
      const row = { field: field.label, group: group.group };
      for (const doc of matrix.documents) {
        const columnId = doc.columnId || doc.documentId;
        const cell = field.values[columnId];
        // 待复核：值照给（有参考价值），蓝色斜体 + 批注提示未经原文校验
        row[columnId] = cell.status === 'ok' || cell.status === 'pending_review' ? cell.value
          : `（${cellStatusText(cell.status)}）`;
      }
      const added = sheet.addRow(row);
      for (const doc of matrix.documents) {
        const columnId = doc.columnId || doc.documentId;
        const value = field.values[columnId];
        const status = value.status;
        const cell = added.getCell(columnId);
        if (status === 'not_disclosed') { cell.font = { color: { argb: 'FF808080' }, italic: true }; }
        else if (status === 'extract_failed') { cell.font = { color: { argb: 'FFC55A11' }, bold: true }; }
        else if (status === 'pending_review') {
          cell.font = { color: { argb: 'FF2E74B5' }, italic: true };
          const origin = value.source === 'vision' ? '视觉模型' : 'AI';
          const reason = value.reviewNote ? `：${value.reviewNote}` : '';
          cell.note = `待核对：${origin}抽取值${reason || '，未经原文引用校验'}，请人工核对后再采用`;
        } else if (status === 'ok' && value.source === 'manual') {
          const meta = value.manual || {};
          const when = meta.confirmedAt ? meta.confirmedAt.slice(0, 16).replace('T', ' ') : '';
          cell.note = `人工核对确认${meta.model ? `（型号 ${meta.model}）` : ''}${when ? ` · ${when}` : ''}${meta.note ? `：${meta.note}` : ''}`;
        }
      }
    }
  }
  sheet.addRow({});
  const notes = ['说明：「未找到」指本次资料未写明或未抽到该参数，不代表不支持；「待核对」为机器推测或存在来源冲突的值（蓝色斜体，批注含原因），须人工核对后方可作为决策依据；「抽取失败」指文本已抽取但规则未识别，请查看「原文片段」人工核对；「人工核对」为网页端逐字段确认过的值，批注含确认型号与时间。'];
  for (const item of matrix.meta?.incompleteDocs || []) {
    notes.push(`不完整审阅提醒 · ${item.label}：${item.reason}，相关结论以人工核对为准。`);
  }
  let noteRow = sheet.addRow({ field: notes[0] });
  noteRow.font = { color: { argb: 'FF808080' }, size: 9 };
  for (const extra of notes.slice(1)) {
    noteRow = sheet.addRow({ field: extra });
    noteRow.font = { color: { argb: 'FFB7791F' }, size: 9 };
  }

  const libSheet = workbook.addWorksheet('资料清单');
  libSheet.columns = [
    { header: '品牌', key: 'vendorName', width: 16 },
    { header: '系列', key: 'series', width: 26 },
    { header: '型号', key: 'modelNames', width: 36 },
    { header: '彩页文件', key: 'officialFileName', width: 40 },
    { header: '来源方式', key: 'collectedBy', width: 10 },
    { header: 'PDF 链接', key: 'pdfUrl', width: 50 },
    { header: '产品页', key: 'productPageUrl', width: 50 },
    { header: 'SHA-256', key: 'sha256', width: 68 },
    { header: '页数', key: 'pageCount', width: 8 },
    { header: '采集时间', key: 'collectedAt', width: 22 },
    { header: '警告', key: 'warning', width: 40 },
  ];
  libSheet.getRow(1).font = { bold: true };
  for (const doc of documents) {
    libSheet.addRow({
      vendorName: doc.vendorName,
      series: doc.series,
      modelNames: (doc.modelNames || []).join('、'),
      officialFileName: doc.officialFileName,
      collectedBy: doc.collectedBy === 'manual-upload' ? '人工上传' : '自动采集',
      pdfUrl: doc.pdfUrl,
      productPageUrl: doc.productPageUrl || '',
      sha256: doc.sha256,
      pageCount: doc.pageCount,
      collectedAt: doc.collectedAt,
      warning: doc.warning || '',
    });
  }

  const quoteSheet = workbook.addWorksheet('原文片段');
  quoteSheet.columns = [
    { header: '品牌/系列', key: 'label', width: 34 },
    { header: '参数', key: 'field', width: 22 },
    { header: '取值', key: 'value', width: 30 },
    { header: '原文片段', key: 'quote', width: 80 },
    { header: '页码', key: 'page', width: 8 },
    { header: '抽取方式', key: 'source', width: 10 },
  ];
  quoteSheet.getRow(1).font = { bold: true };
  const sourceLabels = { rule: '规则', ai: 'AI', vision: '视觉模型', manual: '人工核对' };
  for (const group of matrix.groups) {
    for (const field of group.fields) {
      for (const doc of matrix.documents) {
        const cell = field.values[doc.columnId || doc.documentId];
        if (cell.status === 'ok' && cell.quote) {
          quoteSheet.addRow({ label: doc.label, field: field.label, value: cell.value, quote: cell.quote, page: cell.page || '', source: sourceLabels[cell.source] || cell.source || '' });
        }
      }
    }
  }

  // 门槛判定（方案 §9.2）：程序三态计算结果随报告导出，未知不折算为不满足
  if (Array.isArray(matrix.thresholds) && matrix.thresholds.length) {
    const thrSheet = workbook.addWorksheet('门槛判定');
    thrSheet.columns = [
      { header: '门槛', key: 'threshold', width: 42 },
      ...matrix.documents.map((doc) => ({ header: doc.label, key: doc.columnId || doc.documentId, width: 30 })),
    ];
    thrSheet.getRow(1).font = { bold: true };
    const verdictText = { pass: '✔ 满足', fail: '✘ 不满足', unknown: '？ 未知' };
    const verdictStyle = {
      pass: { font: { color: { argb: 'FF00857D' }, bold: true } },
      fail: { font: { color: { argb: 'FFA50034' }, bold: true } },
      unknown: { font: { color: { argb: 'FF808080' }, italic: true } },
    };
    for (const row of matrix.thresholds) {
      const added = thrSheet.addRow({ threshold: `${row.fieldLabel} ${row.opLabel} ${row.value}` });
      for (const doc of matrix.documents) {
        const columnId = doc.columnId || doc.documentId;
        const result = row.results[columnId] || { verdict: 'unknown', reason: '无判定' };
        const cell = added.getCell(columnId);
        cell.value = verdictText[result.verdict]
          + (result.reason ? `（${result.reason}）` : result.basis ? ` · ${result.basis}` : '');
        Object.assign(cell, JSON.parse(JSON.stringify(verdictStyle[result.verdict] || verdictStyle.unknown)));
      }
    }
    const noteRow = thrSheet.addRow({
      threshold: '说明：「未知」指证据不足（取值待核对/未找到/单位不可比/多数值需人工判定），不计为不满足；门槛是项目条件，判定不改变参数事实。',
    });
    noteRow.font = { color: { argb: 'FF808080' }, size: 9 };
  }

  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

// Word 分析报告（偏向分析叙事），矩阵数据作为附表。
async function buildWordDocx({ analysis, matrix, documents, outPath }) {
  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = require('docx');

  const heading = (text, level) => new Paragraph({ text, heading: level });
  const paragraph = (text, options = {}) => new Paragraph({ children: [new TextRun({ text, ...options })], spacing: { after: 120 } });

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '多品牌网络设备对比分析报告', bold: true, size: 40 })],
      spacing: { after: 200 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `生成于 ${new Date().toLocaleString('zh-CN')} · NVCI Lite · 依据厂商公开彩页`, color: '808080', size: 20 })],
      spacing: { after: 300 },
    }),
    heading('一、对比对象与资料来源', HeadingLevel.HEADING_1),
    paragraph('本报告基于以下厂商公开彩页（PDF）自动抽取参数后生成，每个文件均做 SHA-256 核验，可在「资料清单」Excel 中查证原文链接。'),
  ];

  const sourceRows = [
    new TableRow({
      tableHeader: true,
      children: ['品牌', '系列', '型号', '彩页文件', 'SHA-256（前 12 位）'].map((cell) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true })] })] })),
    }),
    ...documents.map((doc) => new TableRow({
      children: [
        doc.vendorName, doc.series, (doc.modelNames || []).join('、') || '—', doc.officialFileName, String(doc.sha256 || '').slice(0, 12),
      ].map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
    })),
  ];
  children.push(new Table({ rows: sourceRows, width: { size: 100, type: WidthType.PERCENTAGE } }));

  children.push(heading('二、执行摘要', HeadingLevel.HEADING_1));
  children.push(paragraph(analysis.executive_summary || '（本次未生成执行摘要）'));

  children.push(heading('三、硬门槛差异', HeadingLevel.HEADING_1));
  if (analysis.hard_gates?.length) {
    for (const gate of analysis.hard_gates) children.push(paragraph(`【${gate.field}】${gate.finding}`, { bullet: { level: 0 } }));
  } else {
    children.push(paragraph('未识别出一票否决级的硬门槛差异。'));
  }

  children.push(heading('四、逐参数对比分析', HeadingLevel.HEADING_1));
  if (analysis.parameter_analysis?.length) {
    for (const item of analysis.parameter_analysis) children.push(paragraph(`【${item.field}】${item.finding}`, { bullet: { level: 0 } }));
  } else {
    children.push(paragraph('（本次未生成逐参数分析）'));
  }

  children.push(heading('五、关键偏离', HeadingLevel.HEADING_1));
  if (analysis.key_deviations?.length) {
    for (const deviation of analysis.key_deviations) children.push(paragraph(deviation, { bullet: { level: 0 } }));
  } else {
    children.push(paragraph('未发现关键偏离项。'));
  }

  children.push(heading('六、适用场景建议', HeadingLevel.HEADING_1));
  if (analysis.scenario_advice?.length) {
    for (const advice of analysis.scenario_advice) children.push(paragraph(`【${advice.scenario}】${advice.recommendation}`, { bullet: { level: 0 } }));
  } else {
    children.push(paragraph('（本次未生成场景建议）'));
  }

  children.push(heading('七、采购验证问题清单', HeadingLevel.HEADING_1));
  if (analysis.procurement_questions?.length) {
    analysis.procurement_questions.forEach((question, index) => children.push(paragraph(`${index + 1}. ${question}`)));
  } else {
    children.push(paragraph('（本次未生成采购验证问题）'));
  }

  children.push(heading('八、参数对照附表', HeadingLevel.HEADING_1));
  children.push(paragraph('完整参数对照、资料清单与原文片段见同批生成的 Excel 文件。标注「未找到」表示本次资料未写明或未抽到该参数，不代表不支持，采购时应向厂商验证；蓝色「待核对」为机器推测或来源冲突值，须人工核对后采用。', { color: '808080' }));

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// AI 材料包（无 Key 模式）：单个 Markdown，含提示词 + 参数矩阵 JSON + 各型号彩页全文，
// 整体复制给任何 AI 对话即可得到同结构分析。
function buildMaterialPack({ matrix, documents, extractions, outPath }) {
  const lines = [];
  lines.push('# NVCI Lite · AI 分析材料包');
  lines.push('');
  lines.push(`> 生成于 ${new Date().toLocaleString('zh-CN')}。使用方法：把本文件全部内容复制给任意 AI 对话（GLM/ChatGPT/文心等），AI 会按文首提示词输出结构化对比分析。`);
  lines.push('');
  lines.push('## 提示词（请先阅读后连同下方材料一起发给 AI）');
  lines.push('');
  lines.push('```text');
  lines.push('你是网络设备选型与竞品分析专家。请基于下方「参数矩阵」与「彩页全文」输出对比分析，要求：');
  lines.push('1. 结论只基于给定参数；参数为「未找到」时明确说明本次资料未找到，禁止推断为不支持。');
  lines.push('2. 标注「待核对」的值是机器推测或来源冲突值（未经充分校验），引用时须注明待人工核对，重要结论不得单独依赖。');
  lines.push('3. 未提供采购门槛时只报告差异，不自行宣布淘汰或替代；指出关键偏离（端口/PoE/交换容量等）、适用场景。');
  lines.push('4. 采购验证问题要具体可执行。');
  lines.push('5. 输出章节：执行摘要 / 门槛与关键偏离 / 逐参数对比 / 适用场景建议 / 采购验证问题清单。');
  lines.push('```');
  lines.push('');
  lines.push('## 参数矩阵（规则抽取，可能不全，请结合全文核对）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(matrix, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## 资料来源');
  lines.push('');
  for (const doc of documents) {
    lines.push(`- ${doc.vendorName} ${doc.series}（型号：${(doc.modelNames || []).join('、') || '—'}）：${doc.officialFileName}，SHA-256 ${doc.sha256}`);
  }
  for (const extraction of extractions) {
    lines.push('');
    lines.push(`## 彩页全文 · ${extraction.label}（${extraction.pageCount} 页）`);
    lines.push('');
    for (const page of extraction.pages) {
      lines.push(`### 第 ${page.page} 页`);
      lines.push('```text');
      lines.push(page.lines.join('\n'));
      lines.push('```');
    }
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

module.exports = { buildExcel, buildWordDocx, buildMaterialPack };
