'use strict';

// 组装层：单例（store/探测器）、横切中间件（requestId/安全头/访问日志/错误信封/指标）、
// 鉴权与登录、路由挂载、静态资源、启动。业务路由在 routes/*（工厂注入），逻辑在 lib/*。

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
const metrics = require('./lib/metrics');

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

// 反向代理信任边界（评审 R2）：部署在 Nginx/网关后时设置 NVCI_LITE_TRUST_PROXY，
// 否则 req.secure 恒为 false（Cookie Secure 不生效）、登录限流按代理 IP 计数。直连部署不设置。
const trustProxy = process.env.NVCI_LITE_TRUST_PROXY;
if (trustProxy) {
  app.set('trust proxy', trustProxy === 'true' ? true : (/^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy));
}

// ---------- 横切中间件 ----------

// requestId（评审 R1）：入站透传或自生成，响应回写，错误信封与日志统一携带
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.requestId = (typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming)) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// 安全响应头（评审 R6）：前端无内联脚本，CSP 可以从紧；style 留 unsafe-inline 因模板含内联样式属性
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// 访问日志（评审 R3）：API 全量记录；静态资源只在异常时记录（降噪）。
// 登录路径打码，绝不出现口令/会话材料。
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const isApi = req.path.startsWith('/api/');
    if (!isApi && res.statusCode < 400) return;
    const route = (req.baseUrl || '') + (req.route?.path || req.path);
    const maskedPath = req.path.startsWith('/api/login') ? '/api/login' : req.path;
    console.log(JSON.stringify({
      event: 'http', requestId: req.requestId, method: req.method, path: maskedPath, route,
      status: res.statusCode, durationMs: Date.now() - start,
    }));
    if (isApi) metrics.inc('nvci_http_requests_total', { method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

// 错误信封（评审 R1，零触碰增量式）：保留 error 字符串（前端按字符串消费，不破坏），
// 顶层追加稳定 code 与 requestId——按 code 分支的能力随时可用，前端无需同步改造。
const STATUS_CODES = {
  400: 'VALIDATION_FAILED', 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 500: 'INTERNAL',
};
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string' && res.statusCode >= 400) {
      body.code = body.code || STATUS_CODES[res.statusCode] || 'ERROR';
      body.requestId = req.requestId;
    }
    return originalJson(body);
  };
  next();
});

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

// 口令比较走摘要 + timingSafeEqual（评审 R7）：定长摘要消除长度与内容的时序面
function passwordMatches(submitted) {
  const a = crypto.createHash('sha256').update(String(submitted || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.json({ ok: true, authRequired: false });
  // 登录失败限制：同 IP 连续失败达上限后锁定窗口期，防暴力穷举
  // IP 取 req.ip 而非 socket.remoteAddress（评审 v4 N1）：Express 按 trust proxy 解析——
  // 反代部署取真实客户端 IP，直连部署二者等价；无 trust proxy 时忽略可伪造的 XFF 头
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const guard = loginGuard.check(ip);
  if (!guard.allowed) {
    metrics.inc('nvci_login_total', { outcome: 'locked' });
    console.log(JSON.stringify({ event: 'login_locked', requestId: req.requestId, ip }));
    return res.status(429).json({ error: `失败次数过多，已临时锁定，请 ${Math.ceil(guard.retryAfterSec / 60)} 分钟后再试` });
  }
  if (!passwordMatches(req.body?.password)) {
    loginGuard.recordFailure(ip);
    metrics.inc('nvci_login_total', { outcome: 'failed' });
    console.log(JSON.stringify({ event: 'login_failed', requestId: req.requestId, ip }));
    return res.status(401).json({ error: '口令错误' });
  }
  loginGuard.recordSuccess(ip);
  metrics.inc('nvci_login_total', { outcome: 'success' });
  console.log(JSON.stringify({ event: 'login_success', requestId: req.requestId, ip }));
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  // secure 条件位：HTTPS 部署下自动带上；内网明文 HTTP 下保持关闭（Secure cookie 不随明文请求发送）
  res.cookie('nvci_lite', `lite.${expiresAt}.${signToken(expiresAt)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure });
  res.json({ ok: true, authRequired: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authRequired: Boolean(PASSWORD), authenticated: !PASSWORD || validSession(req) });
});

// 指标端点（评审 R4）：Prometheus 文本格式，仅聚合计数与进程 gauge，无业务数据，公开供抓取
app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.render());
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
