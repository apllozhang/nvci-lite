'use strict';

// NVCI Lite 部署工具：SSH 到 fnOS NAS，打包上传、Docker Compose 构建、健康检查。
// 用法：node deploy.js probe|push|status|logs
// ssh2 为本仓库 devDependency（旧版曾复用 ../tools，该共享目录已清理）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('ssh2');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy.config.json'), 'utf8'));
const PROJECT_DIR = __dirname;

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

function execCmd(conn, command, { sudoPassword = '', timeoutMs = 600000 } = {}) {
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
      stream.stdin.write(`${sudoPassword}\n`);
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

function sftpWrite(conn, content, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(content, 'utf8');
    });
  });
}

// profiles 已收编进仓库（27 个产品线文件）。仅当旧版 ../NVCI 工作区仍存在时才做
// 同步刷新；否则直接使用仓库自带版本——绝不先删后拷，防止源目录缺失时清空 profiles/。
function refreshProfiles() {
  const source = path.join(PROJECT_DIR, '..', 'NVCI', 'automation', 'bundled-profiles');
  const target = path.join(PROJECT_DIR, 'profiles');
  const targetCount = fs.existsSync(target)
    ? fs.readdirSync(target).filter((name) => name.endsWith('.json')).length : 0;
  if (!fs.existsSync(source)) {
    console.log(`profiles：使用仓库自带 ${targetCount} 个产品线文件（未发现 ../NVCI 旧工作区）`);
    return;
  }
  fs.cpSync(source, target, { recursive: true });
  const count = fs.readdirSync(target).filter((name) => name.endsWith('.json')).length;
  console.log(`profiles 刷新：${count} 个厂商配置（来源 ../NVCI）`);
}

function packTar() {
  const out = path.join(os.tmpdir(), `nvci-lite-deploy-${Date.now()}.tgz`);
  // 排除 .env：远端 .env 由 deploy.config.env 生成、在解压前写入；
  // 若本地 .env 进包，解压会覆盖刚写好的远端配置（口令/AI Key 全部被本地开发值顶掉）
  const excludes = ['./node_modules', './node_modules/*', './data', './data/*', './deploy.config.json', './.env', './start.bat'];
  // --force-local：GNU tar 会把 "C:\..." 里的盘符冒号误判为远程主机名
  execSync(`tar --force-local -czf "${out}" -C "${PROJECT_DIR}" ${excludes.map((item) => `--exclude "${item}"`).join(' ')} .`, { stdio: 'pipe' });
  const megabytes = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
  console.log(`打包完成：${out}（${megabytes} MB）`);
  return out;
}

async function probe() {
  const conn = await sshConnect(CONFIG);
  try {
    const checks = [
      ['系统', 'cat /etc/os-release 2>/dev/null | head -2 || uname -a'],
      ['Docker', 'docker ps >/dev/null 2>&1 && echo "docker: ok(免sudo)" || (echo P@ssw0rd@5121 | sudo -S docker ps >/dev/null 2>&1 && echo "docker: ok(需sudo)" || echo "docker: 不可用")'],
      ['Compose', 'docker compose version 2>/dev/null || docker-compose version 2>/dev/null || echo "compose: 不可用"'],
      ['fnOS存储目录', 'ls -d /vol1/1000/docker 2>/dev/null || echo "/vol1/1000/docker 不存在"'],
      ['已有NVCI', 'ls -d /vol1/1000/docker/nvci* 2>/dev/null || echo "无已有 nvci 目录"'],
      ['端口8788', '(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":8788 " && echo "8788 已被占用" || echo "8788 空闲"'],
      ['磁盘空间', 'df -h /vol1 2>/dev/null | tail -1 || df -h / | tail -1'],
    ];
    for (const [label, cmd] of checks) {
      const result = await execCmd(conn, cmd, { sudoPassword: CONFIG.password });
      console.log(`${label}: ${(result.stdout || result.stderr).trim().split('\n')[0]}`);
    }
  } finally { conn.end(); }
}

// 远程备份：容器内跑 scripts/backup.js（状态 JSON 落在 /data/backups，宿主卷持久化）
async function remoteBackup(conn, { quiet = false } = {}) {
  const result = await execCmd(conn, `docker exec nvci-lite node /app/scripts/backup.js /data`, { sudoPassword: CONFIG.password, timeoutMs: 60000 });
  const output = (result.stdout || result.stderr || '').trim();
  if (!quiet) console.log(output);
  // 返回 JSON 行（脚本首行输出）；容器未运行等情况返回 null，调用方决定是否致命
  try { return JSON.parse(output.split('\n').find((line) => line.startsWith('{')) || 'null'); } catch { return null; }
}

async function backupCmd() {
  const conn = await sshConnect(CONFIG);
  try {
    console.log('远程备份（容器内 /data → /data/backups）…');
    const result = await remoteBackup(conn);
    if (!result || !result.ok) throw new Error('远程备份失败（容器未运行或数据目录为空）');
    const listed = await execCmd(conn, `docker exec nvci-lite sh -c "ls -1 /data/backups | tail -5"`, { sudoPassword: CONFIG.password });
    console.log(`最近备份：\n${(listed.stdout || '').trim().split('\n').map((line) => `  ${line}`).join('\n')}`);
  } finally { conn.end(); }
}

async function restoreCmd() {
  const fileName = String(process.argv[3] || 'latest');
  const conn = await sshConnect(CONFIG);
  try {
    console.log(`远程恢复（${fileName}）…`);
    const result = await execCmd(conn, `docker exec nvci-lite node /app/scripts/backup.js restore /data ${JSON.stringify(fileName)}`, { sudoPassword: CONFIG.password, timeoutMs: 60000 });
    console.log((result.stdout || result.stderr || '').trim());
    if (result.code !== 0 || !/ok/.test(result.stdout || '')) throw new Error('恢复失败，数据未变更或部分变更，请查看上方输出');
    console.log('重启容器使内存态生效 …');
    const restarted = await execCmd(conn, `cd ${JSON.stringify(CONFIG.remoteDir)} && docker compose restart nvci-lite`, { sudoPassword: CONFIG.password, timeoutMs: 120000 });
    if (restarted.code !== 0) throw new Error('恢复完成但重启失败，请手动执行 docker compose restart');
    console.log('✔ 恢复完成');
  } finally { conn.end(); }
}

async function push() {
  refreshProfiles();
  const tarball = packTar();
  const remoteTar = `/tmp/${path.basename(tarball)}`;
  const remoteDir = CONFIG.remoteDir;
  const conn = await sshConnect(CONFIG);
  try {
    // 部署先备份：覆盖旧代码/重启服务前，线上状态先落一份快照（失败只警告不阻断）
    console.log('部署前备份 …');
    const preBackup = await remoteBackup(conn, { quiet: true });
    console.log(preBackup && preBackup.ok ? `  已备份 ${preBackup.fileName}（${preBackup.fileCount} 个文件）` : '  ⚠ 备份未成功（容器未运行或首次部署），继续部署');
    console.log(`创建远端目录 ${remoteDir} …`);
    // profiles 目录强制与仓库一致：tar 解压只增不删，本地删除的产品线文件会在远端
    // 残留成幽灵线（实例：cisco_01_switches 拆线后残留，旧 documentId 抢注导致新线空挂）
    await execCmd(conn, `rm -rf ${JSON.stringify(remoteDir)}/profiles && mkdir -p ${JSON.stringify(remoteDir)}/profiles`, { sudoPassword: CONFIG.password });
    console.log('上传代码包 …');
    await sftpUpload(conn, tarball, remoteTar);
    await sftpUpload(conn, path.join(PROJECT_DIR, 'docker-compose.yml'), `${remoteDir}/docker-compose.yml`);
    const envLines = Object.entries(CONFIG.env || {}).map(([key, value]) => `${key}=${value}`);
    await sftpWrite(conn, `${envLines.join('\n')}\n`, `${remoteDir}/.env`);
    console.log('解压 …');
    const extract = await execCmd(conn, `cd ${JSON.stringify(remoteDir)} && tar -xzf ${remoteTar} && rm -f ${remoteTar}`, { sudoPassword: CONFIG.password });
    if (extract.code !== 0) throw new Error(`解压失败：${extract.stderr}`);
    console.log('构建并启动 Docker 服务（首次构建约 2–5 分钟）…');
    const up = await execCmd(conn, `cd ${JSON.stringify(remoteDir)} && docker compose up -d --build 2>&1 | tail -5`, { sudoPassword: CONFIG.password, timeoutMs: 600000 });
    if (up.code !== 0 || /Error|error:.+/i.test(up.stderr)) {
      console.log(up.stdout); console.error(up.stderr);
      throw new Error('远端构建/启动失败');
    }
    console.log(up.stdout.trim());
    console.log('健康检查 …');
    const baseUrl = `http://${CONFIG.host}:${CONFIG.healthPort}`;
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const response = await fetch(`${baseUrl}/api/session`);
        if (response.ok) { healthy = true; break; }
      } catch { /* 未就绪继续等 */ }
      process.stdout.write('.');
    }
    console.log('');
    if (!healthy) throw new Error(`健康检查超时：${baseUrl}/api/session 90 秒内未就绪`);
    const catalog = await fetch(`${baseUrl}/api/catalog`).then((r) => r.json());
    console.log(`✔ 部署完成：${baseUrl}`);
    console.log(`  目录加载：${catalog.vendorCount} 品牌 / ${catalog.documentCount} 份彩页`);
    console.log(`  AI 模式：${CONFIG.env.NVCI_LITE_AI_KEY ? '已配置 ' + CONFIG.env.NVCI_LITE_AI_MODEL : '未配置'}`);
  } finally {
    conn.end();
    try { fs.unlinkSync(tarball); } catch { /* 忽略 */ }
  }
}

async function status() {
  const conn = await sshConnect(CONFIG);
  try {
    const result = await execCmd(conn, `cd ${JSON.stringify(CONFIG.remoteDir)} && docker compose ps && echo --- && docker compose logs --tail 5 nvci-lite 2>&1 | tail -8`, { sudoPassword: CONFIG.password });
    console.log(result.stdout || result.stderr);
  } finally { conn.end(); }
}

async function logs() {
  const conn = await sshConnect(CONFIG);
  try {
    const result = await execCmd(conn, `cd ${JSON.stringify(CONFIG.remoteDir)} && docker compose logs --tail 50 nvci-lite`, { sudoPassword: CONFIG.password });
    console.log(result.stdout || result.stderr);
  } finally { conn.end(); }
}

const command = process.argv[2] || 'probe';
const actions = { probe, push, status, logs, backup: backupCmd, restore: restoreCmd };
if (!actions[command]) {
  console.error('用法：node deploy.js probe|push|status|logs|backup|restore [备份文件名|latest]');
  process.exit(1);
}
actions[command]().catch((error) => { console.error(`✖ ${error.message}`); process.exit(1); });
