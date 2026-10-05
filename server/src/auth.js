'use strict';

const crypto = require('crypto');
const config = require('./config');

// admin session token 内存表: token -> {username, expireAt}
const adminSessions = new Map();

/**
 * 密码哈希。
 *
 * 原先用单轮 SHA-256 + 8 字节 salt，现代 GPU 每秒可试数十亿次，弱口令瞬间破解。
 * 现在用 scrypt（N=16384, r=8, p=1，单次约 16MB 内存 / 数十毫秒），
 * 并把算法名存在 admins.algo 列里，登录时对老库就地升级，无需人工干预。
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const ALGO_SCRYPT = 'scrypt';
const ALGO_LEGACY = 'sha256';

function hashPassword(password, salt, algo = ALGO_SCRYPT) {
  if (algo === ALGO_LEGACY) {
    // 仅用于校验老库里的历史哈希
    return crypto.createHash('sha256').update(password + salt).digest('hex');
  }
  return crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS).toString('hex');
}

/** 常数时间比较，避免按字节短路带来的时序侧信道 */
function verifyPassword(password, salt, expectedHash, algo = ALGO_SCRYPT) {
  let actual;
  try {
    actual = Buffer.from(hashPassword(password, salt, algo), 'hex');
  } catch {
    return false;
  }
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  if (actual.length === 0 || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function generateAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createAdminSession(username) {
  const token = generateAdminToken();
  const expireAt = Date.now() + config.ADMIN_SESSION_TTL;
  adminSessions.set(token, { username, expireAt });
  return token;
}

/** 让某个管理员的所有会话立即失效（改密码后调用） */
function dropAdminSessions(username) {
  for (const [token, sess] of adminSessions) {
    if (sess.username === username) adminSessions.delete(token);
  }
}

/** 清理过期会话，避免内存表无限增长（原先只在被访问到时才删除） */
function sweepAdminSessions() {
  const now = Date.now();
  let n = 0;
  for (const [token, sess] of adminSessions) {
    if (now > sess.expireAt) { adminSessions.delete(token); n++; }
  }
  return n;
}

// 每 10 分钟清一次过期会话
setInterval(sweepAdminSessions, 10 * 60 * 1000).unref();

function verifyAdminToken(token) {
  if (!token) return null;
  const sess = adminSessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expireAt) {
    adminSessions.delete(token);
    return null;
  }
  return sess.username;
}

function adminMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const user = verifyAdminToken(token);
  if (!user) {
    return res.status(401).json({ code: 401, msg: 'Unauthorized', data: null });
  }
  req.adminUser = user;
  next();
}

function generateClientToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 客户端中间件：校验 X-Device-Id + X-Token
function clientMiddleware(db) {
  const findDevice = db.prepare('SELECT status, token FROM devices WHERE id = ?');
  const touchDevice = db.prepare("UPDATE devices SET last_seen = strftime('%s','now') WHERE id = ?");
  // last_seen 节流：原先每个已鉴权请求都写一次库（WAL 下也是一次磁盘写），
  // 心跳 + 列表 + EPG + 上报分辨率叠加起来写放大很明显。60 秒记一次足够。
  const lastTouch = new Map();
  const TOUCH_INTERVAL_MS = 60 * 1000;

  return (req, res, next) => {
    const deviceId = req.headers['x-device-id'] || '';
    const token = req.headers['x-token'] || '';
    if (!deviceId || !token) {
      return res.status(401).json({ code: 401, msg: 'Unauthorized', data: null });
    }
    const device = findDevice.get(deviceId);
    if (!device) {
      return res.status(401).json({ code: 401, msg: 'Unauthorized', data: null });
    }
    if (device.status === 'pending') {
      return res.status(403).json({ code: 1001, msg: 'Pending approval', data: { status: 'pending' } });
    }
    if (device.status !== 'approved' || device.token !== token) {
      return res.status(401).json({ code: 401, msg: 'Unauthorized', data: null });
    }
    const now = Date.now();
    if (now - (lastTouch.get(deviceId) || 0) >= TOUCH_INTERVAL_MS) {
      lastTouch.set(deviceId, now);
      try { touchDevice.run(deviceId); } catch (_) { /* 忽略写入失败 */ }
    }
    req.deviceId = deviceId;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateSalt,
  createAdminSession,
  verifyAdminToken,
  dropAdminSessions,
  sweepAdminSessions,
  adminMiddleware,
  generateClientToken,
  clientMiddleware,
  ALGO_SCRYPT,
  ALGO_LEGACY,
};
