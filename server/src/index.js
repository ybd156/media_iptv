'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const config = require('./config');
const logger = require('./logger');
const dbModule = require('./db');
const recorder = require('./services/recorder');
const streamAuth = require('./services/streamAuth');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');
const streamRoutes = require('./routes/stream');

// 全局异常兜底：记录日志不崩溃
process.on('uncaughtException', (err) => {
  logger.error(`[fatal] uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`[fatal] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// 初始化数据目录与数据库
fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(config.RECORD_DIR, { recursive: true });
dbModule.open();
const db = dbModule.getDb();

// 录像存储位置可配置：settings.recordDir 有值时覆盖默认的 DATA_DIR/records。
// 放在这里（拿到 db 之后、启动录制调度之前）改一次即可 —— 其余代码都读 config.RECORD_DIR，
// 所以不需要到处传参。改完确保目录存在，否则录像起不来。
try {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'recordDir'").get();
  const dir = String((row || {}).value || '').replace(/^"|"$/g, '').trim();
  if (dir && dir.startsWith('/')) {
    config.RECORD_DIR = dir;
    fs.mkdirSync(config.RECORD_DIR, { recursive: true });
    logger.info(`[config] 录像目录被设置覆盖为 ${dir}`);
  }
} catch (e) {
  logger.warn(`[config] 读取录像目录设置失败：${e.message}`);
}

// 启动录制调度
recorder.init(db);

// 初始化流地址签名密钥（/stream/* 鉴权用）
streamAuth.init(db);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/**
 * 极简 gzip 压缩（不引入额外依赖）。
 * 大播放列表下 /api/client/channels 是客户端启动时最大的响应体，压缩后体积约降为
 * 1/5~1/10。OkHttp 默认带 Accept-Encoding: gzip 并自动解压，客户端零改动。
 *
 * 只包装 res.json（本服务所有 API 响应都经由它），不碰 express.static 与
 * /stream/* 的二进制流：前者靠浏览器缓存即可，后者压缩纯属浪费 CPU。
 */
app.use((req, res, next) => {
  if (req.method === 'HEAD' || req.path.startsWith('/stream/')) return next();
  if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.headersSent || res.getHeader('Content-Encoding')) return json(body);
    let buf;
    try { buf = Buffer.from(JSON.stringify(body)); } catch (_) { return json(body); }
    if (buf.length < 1024) return json(body); // 小响应压缩不划算
    zlib.gzip(buf, (err, gz) => {
      if (err || res.headersSent) return json(body);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', gz.length);
      res.end(gz);
    });
    return res;
  };
  next();
});

// 简易访问日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // 必须用 originalUrl：Express 挂载子路由时会临时剥掉 req.url 的挂载前缀，
    // 而 'finish' 在响应结束时才触发，此时 req.path 已是剥掉前缀后的路径
    // （/stream/live/1 变成 /live/1）。用 req.path 会导致这里的前缀判断永远为真，
    // 「直播流不写访问日志」的过滤完全失效，且所有日志路径都缺挂载前缀。
    const url = req.originalUrl || req.url;
    if (!url.startsWith('/stream/live')) {
      logger.info(`${req.method} ${url} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// 路由
app.use('/api/client', clientRoutes(db));
app.use('/admin/api', adminRoutes(db));
app.use('/stream', streamRoutes(db));

// 管理后台静态页面（HTML 不缓存，便于升级后立刻生效；其余静态资源缓存 1 小时）
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
app.get('/', (req, res) => res.redirect('/admin/'));

// 404 与错误处理
app.use((req, res) => {
  res.status(404).json({ code: 404, msg: 'not found', data: null });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // body-parser 的 JSON 解析错误是客户端输入问题，返回 400
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(err.type === 'entity.too.large' ? 413 : 400)
      .json({ code: 400, msg: err.type === 'entity.too.large' ? 'body too large' : 'invalid JSON body', data: null });
  }
  logger.error(`[http] error ${req.method} ${req.path}: ${err.stack || err.message}`);
  if (!res.headersSent) {
    res.status(500).json({ code: 500, msg: 'internal error', data: null });
  }
});

const server = app.listen(config.PORT, () => {
  logger.info(`MediaIptv server started`);
  logger.info(`  Admin panel : http://localhost:${config.PORT}/admin/`);
  logger.info(`  Client API  : http://localhost:${config.PORT}/api/client/`);
  logger.info(`  Data dir    : ${config.DATA_DIR}`);
});

/**
 * GitHub 更新渠道：启动时预热一次，之后每 25 分钟刷新。
 *
 * 为什么要预热：客户端「检查更新」打的是 /api/client/version，那条路径会去读 GitHub。
 * 冷启动的第一次请求要等一次 GitHub 往返（实测 2.2 秒才拿到 404/403），
 * 而客户端检查更新时用户就在等。预热 + 定时刷新让请求几乎总能命中缓存
 * （缓存 30 分钟，刷新间隔 25 分钟）。没配仓库时这个调用立刻返回，没有开销。
 */
try {
  const githubRelease = require('./services/githubRelease');
  const warmGithub = () => { Promise.resolve(githubRelease.latest(db)).catch(() => { /* 内部已记日志 */ }); };
  warmGithub();
  const ghTimer = setInterval(warmGithub, 25 * 60 * 1000);
  if (ghTimer.unref) ghTimer.unref();
} catch (_) { /* 更新渠道不可用不该拦住服务启动 */ }

/**
 * 优雅退出。
 *
 * 原先没有任何信号处理：fnOS 的 `cmd/main stop` 与 `docker stop` 都发 SIGTERM，
 * Node 默认立即退出，于是 recorder 里 spawn 的 ffmpeg 变成孤儿进程继续录制写盘
 * （父进程已死，它们被 reparent 到 init，PID 文件又已被删除，再也管不到），
 * 同时 SQLite 不做 WAL checkpoint、日志流不 flush。
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[fatal] 收到 ${signal}，开始优雅退出`);

  // 1. 停止接受新连接
  server.close();
  // 直播流是长连接，close() 不会主动结束它们；给 1 秒让正常请求收尾，然后强制断开
  const forceClose = setTimeout(() => {
    try { server.closeAllConnections(); } catch (_) { /* Node < 18.2 无此 API */ }
  }, 1000);
  forceClose.unref();

  // 1.5 收掉时移会话的 ffmpeg（同样是孤儿进程风险）
  try { require('./services/timeshift').shutdown(); } catch (_) { /* 忽略 */ }

  // 2. 先杀掉所有 ffmpeg 录制进程，避免留下孤儿
  for (const [taskId, entry] of recorder.running) {
    entry.stopping = true;
    for (const job of entry.cronJobs) {
      try { job.stop(); } catch (_) { /* ignore */ }
    }
    if (entry.proc) {
      try { entry.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    logger.info(`[recorder] task ${taskId} 已随服务停止`);
  }
  recorder.running.clear();

  // 3. 关闭数据库（触发 WAL checkpoint）
  try { db.close(); } catch (e) { logger.warn(`[db] close 失败: ${e.message}`); }

  // 4. 兜底：3 秒后强制退出，避免被挂起的连接拖住
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
