'use strict';

// 备份 CLI：容器内与宿主机通用（路径由调用方给定）。
// 用法：
//   node scripts/backup.js [dataDir]                          —— 立即备份（默认 ./data）
//   node scripts/backup.js restore <dataDir> <file|latest>    —— 恢复指定/最新备份
// 恢复 probe-state / settings 等内存态后需重启服务生效。

const path = require('path');
const backup = require('../lib/backup');

const args = process.argv.slice(2);

if (args[0] === 'restore') {
  const [, dataDir, fileName] = args;
  if (!dataDir || !fileName) {
    console.error('用法：node scripts/backup.js restore <dataDir> <fileName|latest>');
    process.exit(2);
  }
  try {
    const result = backup.restoreBackup(path.resolve(dataDir), fileName);
    console.log(JSON.stringify({ ok: true, ...result }));
    console.log(`已恢复 ${result.restored.length} 个文件（来自 ${result.fileName}）。内存态（probe-state 等）需重启服务后生效。`);
  } catch (error) {
    console.error(`恢复失败：${error.message}`);
    process.exit(1);
  }
} else {
  const dataDir = path.resolve(args[0] || 'data');
  try {
    const result = backup.createBackup(dataDir);
    console.log(JSON.stringify({ ok: true, ...result }));
    console.log(`备份完成：${result.fileName}（${result.fileCount} 个文件${result.removed.length ? `，轮转删除 ${result.removed.length} 份旧备份` : ''}）`);
  } catch (error) {
    console.error(`备份失败：${error.message}`);
    process.exit(1);
  }
}
