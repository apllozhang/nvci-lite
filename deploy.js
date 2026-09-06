'use strict';

// NVCI Lite 部署工具：SSH 到 fnOS NAS，打包上传、Docker Compose 构建、健康检查。
// 用法：node deploy.js probe|push|status|logs
// ssh2 复用 ../tools/node_modules，避免重复安装。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require(path.join(__dirname, '..', 'tools', 'node_modules', 'ssh2'));

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
  const excludes = ['./node_modules', './node_modules/*', './data', './data/*', './deploy.config.json', './start.bat'];
  execSync(`tar -czf "${out}" -C "${PROJECT_DIR}" ${excludes.map((item) => `--exclude "${item}"`).join(' ')} .`, { stdio: 'pipe' });
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

async function push() {
  refreshProfiles();
  const tarball = packTar();
  const remoteTar = `/tmp/${path.basename(tarball)}`;
  const remoteDir = CONFIG.remoteDir;
  const conn = await sshConnect(CONFIG);
  try {
    console.log(`创建远端目录 ${remoteDir} …`);
    await execCmd(conn, `mkdir -p ${JSON.stringify(remoteDir)}/profiles`, { sudoPassword: CONFIG.password });
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
const actions = { probe, push, status, logs };
if (!actions[command]) {
  console.error('用法：node deploy.js probe|push|status|logs');
  process.exit(1);
}
actions[command]().catch((error) => { console.error(`✖ ${error.message}`); process.exit(1); });
