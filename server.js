'use strict';

// 组装层：单例（store/探测器）、鉴权中间件与登录会话、路由挂载、静态资源、启动。
// 业务路由按领域拆在 routes/*（probe/catalog/collect/profiles/confirm/analyze/settings），
// 每个模块导出 (ctx) => router 工厂，依赖经 ctx 显式注入。

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { loadCatalog } = require('./lib/catalog');
const { Store } = require('./lib/store');
const ai = require('./lib/ai');
const { FAILED_STATES, ProbeRunner, ProbeState, startScheduleLoop } = require('./lib/probe');
const settings = require('./lib/settings');
const loginGuard = require('./lib/login-guard');

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.NVCI_LITE_DATA_DIR || path.join(__dirname, 'data');
const PASSWORD = process.env.NVCI_LITE_PASSWORD || '';
const MAX_COLLECT = 50;
// T05 型号分列上限：彩页明确覆盖 2~该数个型号时每型号独立一列；更多型号（长尾全系列彩页）
// 拆列导致矩阵过宽且单型号可抽值稀疏，保持单列，型号归属交由人工确认对话框标注
const MAX_MODEL_COLUMNS = 4;

const store = new Store(DATA_DIR);
settings.init(DATA_DIR);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- 探测器单例 ----------

const probeState = new ProbeState(path.join(DATA_DIR, 'probe-state.json'));
const probeRunner = new ProbeRunner({
  store,
  state: probeState,
  allDocuments: () => loadCatalog().vendors.flatMap((vendor) => vendor.productLines.flatMap((line) => line.documents)),
});
const probeSchedule = startScheduleLoop({
  runner: probeRunner,
  schedule: process.env.NVCI_LITE_PROBE_SCHEDULE || '04:30',
  log: (message) => console.log(JSON.stringify({ event: 'nvci_lite_probe', message, at: new Date().toISOString() })),
});

// ---------- 鉴权：可选口令 + 签名 cookie（会话密钥存数据目录） ----------

function secretPath() { return path.join(store.rootDir, '.session-secret'); }
function sessionSecret() {
  try { return fs.readFileSync(secretPath(), 'utf8').trim(); } catch { /* 首次生成 */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath(), secret, 'utf8');
  return secret;
}
function signToken(expiresAt) {
  return crypto.createHmac('sha256', sessionSecret()).update(`lite.${expiresAt}`).digest('hex');
}
function validSession(req) {
  const token = req.cookies?.nvci_lite || '';
  const [prefix, expiresAt, signature] = token.split('.');
  if (prefix !== 'lite' || !expiresAt || !signature) return false;
  if (Date.now() > Number(expiresAt)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(signToken(expiresAt)));
  } catch { return false; }
}

// 极简 cookie 解析（不引 cookie-parser）
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) req.cookies[name] = decodeURIComponent(rest.join('='));
  }
  next();
});

function auth(req, res, next) {
  if (!PASSWORD || validSession(req)) return next();
  res.status(401).json({ error: '未登录或会话已过期' });
}

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.json({ ok: true, authRequired: false });
  // 登录失败限制：同 IP 连续失败达上限后锁定窗口期，防暴力穷举
  const ip = req.socket.remoteAddress || 'unknown';
  const guard = loginGuard.check(ip);
  if (!guard.allowed) {
    return res.status(429).json({ error: `失败次数过多，已临时锁定，请 ${Math.ceil(guard.retryAfterSec / 60)} 分钟后再试` });
  }
  if (String(req.body?.password || '') !== PASSWORD) {
    loginGuard.recordFailure(ip);
    return res.status(401).json({ error: '口令错误' });
  }
  loginGuard.recordSuccess(ip);
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  // secure 条件位：HTTPS 部署下自动带上；内网明文 HTTP 下保持关闭（Secure cookie 不随明文请求发送）
  res.cookie('nvci_lite', `lite.${expiresAt}.${signToken(expiresAt)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure });
  res.json({ ok: true, authRequired: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authRequired: Boolean(PASSWORD), authenticated: !PASSWORD || validSession(req) });
});

// ---------- 业务路由挂载（依赖经 ctx 注入） ----------

const routeCtx = { auth, store, probeState, probeRunner, probeSchedule, DATA_DIR, MAX_COLLECT, MAX_MODEL_COLUMNS };
app.use(require('./routes/probe')(routeCtx));
app.use(require('./routes/catalog')(routeCtx));
app.use(require('./routes/collect')(routeCtx));
app.use(require('./routes/profiles')(routeCtx));
app.use(require('./routes/confirm')(routeCtx));
app.use(require('./routes/analyze')(routeCtx));
app.use(require('./routes/settings')(routeCtx));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(JSON.stringify({
    event: 'nvci_lite_started',
    port: PORT,
    dataDir: store.rootDir,
    authRequired: Boolean(PASSWORD),
    aiConfigured: ai.isConfigured(),
    catalog: (() => { try { const catalog = loadCatalog(); return { vendors: catalog.vendorCount, documents: catalog.documentCount }; } catch { return { vendors: 0, documents: 0 }; } })(),
  }));
});
