'use strict';

// 清理 probe-state 中目录已不存在的幽灵 documentId（如 ex4400_1）。
// 用法：node scripts/cleanup-ghost-probe.js <documentId...>
// 流程：远程备份 → 校验 ID 不在目录 → 从 probe-state.json 删除 → compose restart。

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deploy.config.json'), 'utf8'));
const REMOTE_SCRIPT = path.join(__dirname, 'remove-probe-ids.remote.js');
const ids = process.argv.slice(2).filter(Boolean);
if (!ids.length) {
  console.error('用法：node scripts/cleanup-ghost-probe.js <documentId...>');
  process.exit(1);
}

function sshConnect(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    conn.connect({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password,
      readyTimeout: 20000,
    });
  });
}

function execCmd(conn, command, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(`sudo -S -p '' -- sh -c ${JSON.stringify(command)}`, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => stream.close(), timeoutMs);
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }).on('data', (data) => { stdout += data; });
      stream.stderr.on('data', (data) => { stderr += data; });
      stream.stdin.write(`${CONFIG.password}\n`);
      stream.stdin.end();
    });
  });
}

function sftpUpload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (putErr) => (putErr ? reject(putErr) : resolve()));
    });
  });
}

(async () => {
  const conn = await sshConnect(CONFIG);
  try {
    console.log('1/4 远程备份 …');
    const backup = await execCmd(conn, 'docker exec nvci-lite node /app/scripts/backup.js /data', { timeoutMs: 60000 });
    console.log((backup.stdout || backup.stderr || '').trim().split('\n').slice(0, 2).join('\n'));
    if (backup.code !== 0) throw new Error('备份失败，已中止');

    console.log('2/4 校验幽灵 ID 不在目录中 …');
    const catalogCheck = await execCmd(conn, `docker exec nvci-lite node -e 'const {findDocuments}=require("/app/lib/catalog");const ids=process.env.GHOST_IDS.split(",");const found=findDocuments(ids).map(d=>d.documentId);console.log(JSON.stringify({found,missing:ids.filter(id=>!found.includes(id))}));'`, {
      timeoutMs: 30000,
    });
    // GHOST_IDS 需注入环境；上面没传则用第二条命令
    const catalogCheck2 = await execCmd(conn, `docker exec -e GHOST_IDS=${JSON.stringify(ids.join(','))} nvci-lite node -e 'const {findDocuments}=require("/app/lib/catalog");const ids=process.env.GHOST_IDS.split(",").filter(Boolean);const found=findDocuments(ids).map(d=>d.documentId);console.log(JSON.stringify({found,missing:ids.filter(id=>!found.includes(id))}));'`, {
      timeoutMs: 30000,
    });
    void catalogCheck;
    const checkLine = (catalogCheck2.stdout || '').trim().split('\n').find((line) => line.startsWith('{'));
    const check = JSON.parse(checkLine || '{}');
    if ((check.found || []).length) {
      throw new Error(`以下 ID 仍在目录中，拒绝删除：${check.found.join(', ')}`);
    }
    console.log(`  确认不在目录：${(check.missing || ids).join(', ')}`);

    console.log('3/4 从 probe-state.json 删除 …');
    await sftpUpload(conn, REMOTE_SCRIPT, '/tmp/remove-probe-ids.js');
    const remove = await execCmd(conn, `docker cp /tmp/remove-probe-ids.js nvci-lite:/tmp/remove-probe-ids.js && docker exec -e GHOST_IDS=${ids.join(',')} nvci-lite node /tmp/remove-probe-ids.js`, { timeoutMs: 30000 });
    if (remove.code !== 0) throw new Error(`删除失败：${remove.stderr || remove.stdout}`);
    console.log((remove.stdout || '').trim());

    console.log('4/4 重启容器使内存态生效 …');
    const restart = await execCmd(conn, `cd ${JSON.stringify(CONFIG.remoteDir)} && docker compose restart nvci-lite`, { timeoutMs: 120000 });
    if (restart.code !== 0) throw new Error(`重启失败：${restart.stderr || restart.stdout}`);
    console.log((restart.stdout || '').trim());
    console.log('✔ 清理完成');
  } finally {
    conn.end();
  }
})().catch((error) => {
  console.error(`✖ ${error.message}`);
  process.exit(1);
});
