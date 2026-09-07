'use strict';

// 人工核对确认（轻量参数核对）：按「资料 documentId × 型号 model × 字段 paramKey」保存一条
// 人工结论，绑定确认时的文档 SHA-256 作为版本依据——彩页更新后旧确认自动失效，需重新核对。
// model 为空表示系列级列；同一彩页不同型号的确认互不干扰（T05 型号分列）。
// 吸收 NVCI「型号—字段—证据—版本」四要素，但不引入审批队列：同一键最后一次确认生效。
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.1';
const MAX_VALUE_LEN = 200;
const MAX_NOTE_LEN = 500;

function confirmationsFile(dataDir) {
  return path.join(dataDir, 'confirmations.json');
}

function loadConfirmations(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(confirmationsFile(dataDir), 'utf8'));
    if (parsed && Array.isArray(parsed.confirmations)) {
      // 旧记录（schema 1.0）无 model 字段：视为系列级（model=''）
      return parsed.confirmations.map((item) => ({ ...item, model: String(item.model || '') }));
    }
  } catch {
    // 文件不存在或损坏：视为空，等价首次运行（本文件可随时由人工重建，不阻断分析）
  }
  return [];
}

function saveConfirmations(dataDir, confirmations) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = confirmationsFile(dataDir);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, confirmations }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function validateConfirmationInput(input) {
  if (!input.documentId || typeof input.documentId !== 'string') return 'documentId 不能为空';
  if (!input.paramKey || typeof input.paramKey !== 'string') return 'paramKey 不能为空';
  if (typeof input.value !== 'string' || !input.value.trim()) return '确认值不能为空';
  if (input.value.length > MAX_VALUE_LEN) return `确认值过长（超过 ${MAX_VALUE_LEN} 字符）`;
  if (String(input.note || '').length > MAX_NOTE_LEN) return `备注过长（超过 ${MAX_NOTE_LEN} 字符）`;
  return '';
}

function upsertConfirmation(dataDir, input) {
  const error = validateConfirmationInput(input);
  if (error) throw new Error(error);
  const record = {
    documentId: input.documentId,
    model: String(input.model || '').trim().slice(0, 100),
    paramKey: input.paramKey,
    value: input.value.trim(),
    note: String(input.note || '').trim().slice(0, MAX_NOTE_LEN),
    docSha256: String(input.docSha256 || ''),
    confirmedAt: new Date().toISOString(),
  };
  const remains = loadConfirmations(dataDir).filter(
    (item) => !(item.documentId === record.documentId && item.model === record.model && item.paramKey === record.paramKey),
  );
  remains.push(record);
  saveConfirmations(dataDir, remains);
  return record;
}

function removeConfirmation(dataDir, documentId, paramKey, model = '') {
  const list = loadConfirmations(dataDir);
  const remains = list.filter((item) => !(item.documentId === documentId && item.model === model && item.paramKey === paramKey));
  if (remains.length === list.length) return false;
  saveConfirmations(dataDir, remains);
  return true;
}

// 把人工确认应用进参数矩阵（分析流水线在 buildMatrix 之后、导出之前调用）。
// 矩阵列（matrix.documents）携带 documentId + model（系列列 model=''），确认按
// 「documentId + model + paramKey」精确匹配列；SHA 一致才生效，彩页更新则标记失效。
function applyConfirmations(matrix, confirmations) {
  const byColumnKey = new Map();
  for (const conf of Array.isArray(confirmations) ? confirmations : []) {
    byColumnKey.set(`${conf.documentId}|${conf.model || ''}|${conf.paramKey}`, conf);
  }
  let applied = 0;
  let stale = 0;
  for (const group of matrix.groups) {
    for (const field of group.fields) {
      for (const doc of matrix.documents) {
        const conf = byColumnKey.get(`${doc.documentId}|${doc.model || ''}|${field.key}`);
        const cell = field.values[doc.columnId || doc.documentId];
        if (!conf || !cell) continue;
        if (conf.docSha256 && doc.sha256 && conf.docSha256 !== doc.sha256) {
          cell.staleConfirmation = { value: conf.value, model: conf.model || '', confirmedAt: conf.confirmedAt };
          stale += 1;
          continue;
        }
        // 覆盖前留快照：网页端「清除确认」可还原机器原始结论（值/状态/来源）
        cell.preConfirm = { value: cell.value, status: cell.status, source: cell.source, reviewNote: cell.reviewNote || '', unattributed: Boolean(cell.unattributed) };
        cell.value = conf.value;
        cell.status = 'ok';
        cell.source = 'manual';
        cell.unattributed = false;
        cell.manual = { confirmedAt: conf.confirmedAt, model: conf.model || '', note: conf.note || '' };
        applied += 1;
      }
    }
  }
  return { applied, stale };
}

module.exports = {
  loadConfirmations,
  saveConfirmations,
  upsertConfirmation,
  removeConfirmation,
  applyConfirmations,
};
