'use strict';

const crypto = require('crypto');
const logger = require('../logger');

/**
 * 直播流 / 录像流的签名鉴权。
 *
 * 背景：原先 /stream/live/:id 与 /stream/record/:id **没有任何鉴权**，局域网内
 * 任何设备枚举 id 就能拉走全部直播源与录像 —— 而「服务器代理转发」的初衷正是
 * 隐藏原始源地址，等于白做。实测不带任何 header 请求 /stream/record/1 直接 200
 * 返回了录像内容。
 *
 * 为什么用 URL 查询参数而不是 header：ExoPlayer / ijk / 系统播放器都无法给流地址
 * 附加自定义 header，而签名随 URL 下发就能覆盖全部三种引擎、客户端零改动。
 *
 * 签名绑定 (kind, id, 过期时间)，用 settings 表里持久化的随机密钥做 HMAC-SHA256，
 * 因此重启后已下发的地址依然有效。TTL 取 7 天：TV 盒子可能连续开机数天不重新拉
 * 频道列表，TTL 太短会导致换台失败；而对「防止局域网内未授权设备枚举拉流」这个
 * 目标来说，7 天完全够用。
 *
 * 可通过 settings.streamAuth = '0' 关闭（例如仍需兼容旧版 APK）。
 */

const TTL_SEC = 7 * 24 * 3600;

let secret = null;
let enabled = true;

/** 初始化：从 settings 读取/生成密钥与开关。需在 db 打开之后调用。 */
function init(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'streamSecret'").get();
  if (row && row.value) {
    secret = String(row.value).replace(/^"|"$/g, '');
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('streamSecret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(secret);
    logger.info('[stream] 已生成流地址签名密钥');
  }

  const auth = db.prepare("SELECT value FROM settings WHERE key = 'streamAuth'").get();
  enabled = !(auth && String(auth.value).replace(/^"|"$/g, '') === '0');
  logger.info(`[stream] 流地址签名鉴权：${enabled ? '已启用' : '已关闭'}`);
}

function isEnabled() {
  return enabled;
}

/** 生成 `t=<过期秒>&s=<签名>` 查询串 */
function query(kind, id, ttlSec = TTL_SEC) {
  if (!enabled) return '';
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', secret || '').update(`${kind}:${id}:${exp}`).digest('hex').slice(0, 32);
  return `t=${exp}&s=${sig}`;
}

/**
 * 与 [query] 同源，但返回拆分后的两个值。
 *
 * 时移（HLS）必须把签名放进**路径**而不是查询串：m3u8 里的分片是相对路径，
 * 相对解析只保留路径前缀、查询串会丢 —— 那样分片请求就没签名了。
 * 所以地址形如 /stream/timeshift/<id>/<t>/<s>/index.m3u8，
 * 分片自动变成 /stream/timeshift/<id>/<t>/<s>/seg00001.ts，签名随路径传下去。
 */
function signature(kind, id, ttlSec = TTL_SEC) {
  if (!enabled) return { t: '0', s: '0' };
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', secret || '').update(`${kind}:${id}:${exp}`).digest('hex').slice(0, 32);
  return { t: String(exp), s: sig };
}

/** 校验签名。关闭鉴权时恒为 true。 */
function verify(kind, id, t, s) {
  if (!enabled) return true;
  if (!secret || !t || !s) return false;
  const exp = parseInt(t, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expect = crypto.createHmac('sha256', secret).update(`${kind}:${id}:${exp}`).digest('hex').slice(0, 32);
  const a = Buffer.from(String(s));
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 生成 Express 中间件。
 * @param {'live'|'record'} kind
 */
function middleware(kind) {
  return (req, res, next) => {
    if (!enabled) return next();
    const raw = req.params.channelUrlId !== undefined ? req.params.channelUrlId : req.params.id;
    // /stream/live/:id 后面会跟扩展名提示（123.m3u8），签名是按纯数字 id 算的，
    // 这里必须归一化，否则校验永远不通过。
    const id = /^\d+/.test(String(raw)) ? parseInt(raw, 10) : raw;
    if (verify(kind, id, req.query.t, req.query.s)) return next();
    logger.warn(`[stream] 拒绝未签名/签名过期的 ${kind} 请求 id=${raw} ip=${req.ip}`);
    return res.status(403).json({ code: 403, msg: '流地址签名无效或已过期，请重新获取频道列表', data: null });
  };
}

module.exports = { init, query, signature, verify, middleware, isEnabled, TTL_SEC };
