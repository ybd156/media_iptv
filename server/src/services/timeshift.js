'use strict';

/**
 * 时移（timeshift）：让直播可以暂停、可以往回拖。
 *
 * 1.11.17 架构改动：**时移就是「录像窗口」**，不再为时移单独跑 ffmpeg。
 *
 * 旧实现有两条路径：
 *   a) 有录像的频道 → 「录像共用」：把录像分片按关键帧切成小块当时间轴；
 *   b) 没录像的频道 → 现场拉起一路 ffmpeg 攒滚动 HLS 窗口。
 *
 * 路径 b 的「初始起来」代价极高：ffmpeg 从启动到第一个分片落盘实测 **5.2 秒**
 * （avformat 探测 + 攒满一个分片时长 + 关键帧对齐），这 5 秒里播放列表根本不存在，
 * 客户端只能反复拿 503 —— 就是「点完时移要卡一会儿」。而这 5 秒压不掉，实测过：
 *   - `-hls_init_time 1`：ffmpeg 8.1.1 上会把**所有**分片切成 1 秒（33 秒窗口里 33 个
 *     1.0s 分片），分片数翻 4 倍，还让播放器按 3×TARGETDURATION=3 秒贴边播，反而更糟；
 *   - 只压探测期（`-probesize`/`-analyzeduration`）：首片 5.2s → 4.8s，没有意义
 *     （探测期和「攒够一个分片内容」的时间本来就重叠）。
 *
 * 统一之后语义变清晰：**有没有时移 = 这个频道有没有在录像**。
 *   - 有录像 → 历史一直在那里，索引一次建好，时移与回看共用同一份数据；
 *   - 没录像 → 服务端不下发时移地址（见 routes/client.js 的 recChannelIds），
 *     客户端也就没有入口，不会出现「点了才知道不能用」。
 *
 * 代价（明确的取舍，不是副作用）：
 *   - 没开录像的频道不再有时移；
 *   - 刚开录像的频道要等第一个分片写完才有历史。分片时长由 recordSegmentMin 决定，
 *     想更快就调小它（代价是索引扫描更频繁、磁盘文件更多）。
 *
 * 会话本身现在只是「谁最近在用时移」的记录：没有子进程要管、没有临时目录要清，
 * 空闲超时后从表里移除即可。
 */

const path = require('path');
const config = require('../config');
const logger = require('../logger');
const streamAuth = require('./streamAuth');

const DEFAULT_WINDOW_MIN = 30;
/** 多久没人请求就认为这个频道不再被观看（会话表里的条目，没有进程要停） */
const IDLE_STOP_MS = 120_000;
const SWEEP_INTERVAL_MS = 30_000;

/** channelUrlId -> { mode:'record', channelId, lastAccess, startedAt, chunked, lastScan } */
const sessions = new Map();

let sweepTimer = null;

/** 该线路属于哪个频道 */
function channelIdOf(db, channelUrlId) {
  try {
    const r = db.prepare('SELECT channel_id FROM channel_urls WHERE id = ?').get(channelUrlId);
    return r ? r.channel_id : null;
  } catch (_) { return null; }
}

/** 这个频道有没有录像记录 —— 有才谈得上时移 */
function hasRecordings(db, channelId) {
  if (!channelId) return false;
  try {
    return db.prepare("SELECT COUNT(*) c FROM recordings WHERE channel_id = ? AND status = 'ok'").get(channelId).c > 0;
  } catch (_) { return false; }
}

/** 判定结果缓存：录像是否可用，不必每次请求都去探 */
const usableCache = new Map(); // channelId -> { at, ok }
const USABLE_TTL_MS = 60_000;
/**
 * 只剩一条录像时，它至少要已经录了这么久才提供时移（秒）。
 *
 * 为什么要这条：用户在后台清理录像后，库里只剩"正在录的那一片"，
 * 如果这时候一律判不可用，用户会看到"删完录像时移就废了"。
 * 60 秒是能拖动的最短长度 —— 再短的话进度条几乎没有可拖范围，不如不给。
 */
const MIN_SINGLE_RECORDING_SEC = 60;

/**
 * 录像能不能当时间轴用。
 *
 * 光「有录像记录」不够 —— 线上实测过一种坏法：录像 ffmpeg 每 15 秒退出重启一次，
 * 每个文件里只有 0.8 秒内容。拿这种录像做时移，时间轴和实际内容完全对不上，表现就是黑屏。
 *
 * 判据：在**最近几个已经写完的分片**里，只要有任意一片的真实时长接近配置的分片长度，
 * 就认为录像可用。三个刻意的取舍：
 *   - **不探最新那一片**：scanSegments 会把正在录制的文件也登记进库，它的时长天然
 *     只有「已经录了多久」，拿它判会把健康录像判成「不可靠」，而且每几分钟翻转一次。
 *   - **不只看最新那一片（已完成）**：服务端升级会重启录像进程，重启时那一片必然被
 *     截短，只看它同样会误判。
 *   - **要求最新录像还在时移窗口内**：否则录像是很久以前的，拿它当「直播时间轴」没意义。
 *
 * 因为 chunksOf 现在是异步的（要等 ffprobe），这个函数也返回 Promise。
 */
async function recordingsUsable(db, channelId) {
  const hit = usableCache.get(channelId);
  if (hit && Date.now() - hit.at < USABLE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const rows = db.prepare(
      `SELECT date, start, file FROM recordings
       WHERE channel_id = ? AND status = 'ok' ORDER BY date DESC, start DESC LIMIT 4`
    ).all(channelId);
    if (rows.length >= 2) {
      // 配置的分片长度（recordSegmentMin 分钟），判「是不是明显短于它」
      let expected = 300;
      try {
        const row2 = db.prepare("SELECT value FROM settings WHERE key = 'recordSegmentMin'").get();
        const v = parseInt(String((row2 || {}).value || '').replace(/^"|"$/g, ''), 10);
        if (Number.isFinite(v) && v >= 1 && v <= 720) expected = v * 60;
      } catch (_) { /* 用默认 */ }

      const newestMs = startMsOf(rows[0].date, rows[0].start);
      const freshEnough = newestMs !== null && Date.now() - newestMs < windowMinutes(db) * 60_000;
      if (!freshEnough) {
        usableCache.set(channelId, { at: Date.now(), ok: false });
        return false;
      }

      // 分片时长直接复用切片索引（recordIndex 内部有缓存，不额外多扫一遍）
      const recordIndex = require('./recordIndex');
      let best = 0;
      for (let i = 1; i < rows.length; i++) {
        const file = path.join(config.RECORD_DIR, rows[i].file);
        let chunks;
        try { chunks = await recordIndex.chunksOf(file, true); } catch (_) { chunks = null; }
        if (!chunks || !chunks.length) continue;
        const dur = chunks.reduce((a, c) => a + c.duration, 0);
        if (dur > best) best = dur;
        if (dur >= expected * 0.5) { ok = true; break; }
      }
      if (!ok) {
        logger.warn(`[timeshift] channel #${channelId} 的录像不可靠（最近已完成分片最长 ${best.toFixed(1)}s，配置 ${expected}s），不提供时移`);
      }
    } else if (rows.length === 1) {
      // 只有一条录像：刚在后台清理过录像、或录像任务刚恢复。
      //
      // 这一段必须单独处理。上面的逻辑刻意**跳过最新那一片**（它还在写，时长不完整），
      // 所以只剩一条时什么都判不了 → 直接判"不可用"。线上后果很直观：
      // 用户在后台点了「批量删除录像」，时移就整个没了，要等录像重新攒够两片
      // （默认 5 分钟一片 → 约 10 分钟）才恢复。而在用户看来"删录像"和"时移不能用"
      // 是两件不相干的事，只会觉得时移坏了。
      //
      // 判据改成看这个文件**已经录了多久**：够拖一段就提供时移，窗口就是这一段。
      const recordIndex = require('./recordIndex');
      const file = path.join(config.RECORD_DIR, rows[0].file);
      let dur = 0;
      try { dur = await recordIndex.fileDuration(file); } catch (_) { dur = 0; }
      ok = dur >= MIN_SINGLE_RECORDING_SEC;
      logger.info(`[timeshift] channel #${channelId} 只有 1 条录像（已录 ${dur.toFixed(0)}s）→ ${ok ? '提供时移' : '暂不提供时移'}`);
    }
  } catch (_) { ok = false; }
  usableCache.set(channelId, { at: Date.now(), ok });
  return ok;
}

/** "HH:mm:ss" → 当天秒数；解析不了返回 null */
function secOfDay(hms) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(hms || ''));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

/** "YYYY-MM-DD" + "HH:mm:ss" → 毫秒时间戳；解析不了返回 null */
function startMsOf(date, start) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const s = secOfDay(start);
  if (!d || s === null) return null;
  const t = new Date(+d[1], +d[2] - 1, +d[3], 0, 0, 0).getTime() + s * 1000;
  return Number.isFinite(t) ? t : null;
}

/** 时移窗口（分钟）：settings.timeshiftWindowMin，非法值回退默认 */
function windowMinutes(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'timeshiftWindowMin'").get();
    const v = parseInt(String((row || {}).value || '').replace(/^"|"$/g, ''), 10);
    if (Number.isFinite(v) && v >= 1 && v <= 24 * 60) return v;
  } catch (_) { /* 用默认 */ }
  return DEFAULT_WINDOW_MIN;
}

function touch(channelUrlId) {
  const s = sessions.get(channelUrlId);
  if (s) s.lastAccess = Date.now();
}

/** 结束一个时移会话（只是从表里移除：没有进程要杀、没有临时目录要清） */
function stopSession(channelUrlId, reason = '') {
  const s = sessions.get(channelUrlId);
  if (!s) return false;
  sessions.delete(channelUrlId);
  if (reason) logger.info(`[timeshift] #${channelUrlId} 会话结束（${reason}）`);
  return true;
}

/**
 * 确保某个源地址的时移会话存在，返回会话对象；这个频道没有可用录像时返回 null。
 *
 * 「没有可用录像」是正常情况、不是错误：服务端本来就只对配了录像任务的频道下发
 * 时移地址（routes/client.js 的 recChannelIds），拿不到地址的频道客户端也不会有入口。
 *
 * @returns {Promise<object|null>}
 */
async function ensureSession(db, channelUrlId) {
  const alive = sessions.get(channelUrlId);
  if (alive) {
    alive.lastAccess = Date.now();
    return alive;
  }

  const channelId = channelIdOf(db, channelUrlId);
  if (!hasRecordings(db, channelId) || !(await recordingsUsable(db, channelId))) {
    return null;
  }

  const session = {
    mode: 'record',
    channelId,
    lastAccess: Date.now(),
    startedAt: Date.now(),
    chunked: false,
    lastScan: 0,
  };
  sessions.set(channelUrlId, session);
  logger.info(`[timeshift] #${channelUrlId} 时移会话（channel #${channelId}，走录像时间轴）`);

  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of sessions) {
        if (now - s.lastAccess > IDLE_STOP_MS) stopSession(id, '空闲超时');
      }
    }, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }
  return session;
}

/**
 * 时移播放列表：按录像分片动态生成（不落盘）。
 *
 * 分片地址用绝对的 /stream/record/:id（带 record 签名、支持 Range），
 * 所以分片请求根本不经过时移那条路 —— 时移路由只负责这一个播放列表。
 *
 * @returns {Promise<string|null>} null 表示这个会话当前没有可用的录像分片
 */
async function recordPlaylistText(db, channelUrlId, baseUrl) {
  const s = sessions.get(channelUrlId);
  if (!s || s.mode !== 'record') return null;

  // 录像分片是每 2 分钟扫描登记的。这里限频补扫一次，
  // 否则「直播边缘」最多会落后两分钟，用户会觉得回到直播后差了 2 分钟。
  if (Date.now() - (s.lastScan || 0) > 20_000) {
    s.lastScan = Date.now();
    try { require('./recorder').scanSegments(db); } catch (_) { /* 扫不到不影响已有分片 */ }
  }

  const since = Date.now() - windowMinutes(db) * 60_000;
  const rows = db.prepare(
    `SELECT id, date, start, end, file FROM recordings
     WHERE channel_id = ? AND status = 'ok' ORDER BY date DESC, start DESC LIMIT 2000`
  ).all(s.channelId);
  const picked = [];
  for (const r of rows) {
    const ms = startMsOf(r.date, r.start);
    if (ms === null || ms < since) continue;
    picked.push({ id: r.id, ms, file: r.file });
  }
  if (!picked.length) return null;
  picked.reverse(); // 旧 → 新

  // 每个录像分片再按**关键帧**切成字节范围小块。
  // 直接拿整片当 HLS 分片时，播放器为了取「直播边缘」要从分片开头读起，
  // 一次 seek 也要重读几十上百 MB —— 这就是「拖进度条不流畅」的根因。
  //
  // 粒度**只会从整片升级到切片，不会退回去**：播放器是按时间在播放列表里定位分片的
  // （不是按序号硬映射），换结构最多重新缓冲一小块，不会跳内容；反过来退回整片则会
  // 让已经拖到精确位置的用户突然回到粗粒度。
  //
  // 线上教训（1.11.10 的坑）：只在**会话创建时**判定一次的话，服务端重启后索引还没
  // 预热完的那 30 秒里建的会话会一直停在整片粒度。所以每个请求都复查一次。
  const recordIndex = require('./recordIndex');
  const fullOf = (p) => path.join(config.RECORD_DIR, p.file);
  const closedFiles = picked.slice(0, -1).map(fullOf);
  const clampDur = (sec) => Math.min(3600, Math.max(1, sec));
  if (!s.chunked) {
    if (closedFiles.every((f) => recordIndex.peek(f, true))) {
      s.chunked = true;
      logger.info(`[timeshift] #${channelUrlId} 播放列表粒度升级为关键帧切片（${closedFiles.length} 个分片索引就绪）`);
    } else {
      recordIndex.warm(closedFiles);
    }
  }

  const items = [];
  const needWarm = [];
  for (let i = 0; i < picked.length; i++) {
    const isNewest = i === picked.length - 1;
    const full = fullOf(picked[i]);
    // 整片兜底时长：用「到下一个分片起点的间隔」，最后一片用已录时长
    const nextMs = i + 1 < picked.length ? picked[i + 1].ms : Date.now();
    let chunks = null;
    if (s.chunked) {
      if (isNewest) {
        // 正在录的那一片：拿不到就退回整片（它还在长，缓存新鲜度由 recordIndex 的 TTL 管）
        try { chunks = await recordIndex.chunksOf(full, false); } catch (_) { chunks = null; }
      } else {
        chunks = recordIndex.peek(full, true);
        if (!chunks) {
          // 已写完但索引还没建：**等它建完**（异步，约 0.45s），不要下发「整片」条目。
          // 混在切片里的整片条目会让播放器为了预取直播边缘去拉整个 200MB 文件，
          // 把正在播的那一路饿死 —— 线上表现是「拖过去先播 1~2 秒，然后卡 7~8 秒」。
          try { chunks = await recordIndex.chunksOf(full, true); } catch (_) { chunks = null; }
        }
        if (!chunks) needWarm.push(full);
      }
    }
    if (chunks && chunks.length) {
      for (const c of chunks) {
        items.push({
          id: picked[i].id,
          offset: c.offset,
          length: c.length,
          duration: c.duration,
          ms: picked[i].ms + c.tRel * 1000,
        });
      }
    } else {
      items.push({
        id: picked[i].id,
        offset: 0,
        length: 0,
        duration: clampDur((nextMs - picked[i].ms) / 1000),
        ms: picked[i].ms,
      });
    }
  }
  // 缺索引的按「从新到旧」补（用户拖进度条多半在直播边缘附近），后台慢慢扫
  if (needWarm.length) recordIndex.warm(needWarm.reverse());
  if (!items.length) return null;

  const maxDur = items.reduce((m, it) => Math.max(m, it.duration), 0);
  // 序号必须随窗口滚动递增，否则播放器会把新分片当成旧分片、认为列表没变。
  // 用「第一片的绝对时间 ÷ 切片长度」当序号：天然单调、跨会话重启也连续，
  // 不用再数「窗口外有多少片」（那要扫全部录像，代价随保留期增长）。
  const seq = Math.max(0, Math.floor(items[0].ms / (recordIndex.CHUNK_SECONDS * 1000)));
  const out = [
    '#EXTM3U', '#EXT-X-VERSION:4',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDur) || 6}`,
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    // HOLD-BACK：告诉播放器「直播边缘往后留 20 秒」。切片是 10 秒一个（关键帧对齐），
    // 不留余量的话播放器会贴着播放列表末尾播，而末尾那一片要等下一个关键帧才写出来 ——
    // 实测表现就是「进时移先黑十几秒」「播到边缘卡住」。留两片余量后手上始终有下一片。
    '#EXT-X-SERVER-CONTROL:HOLD-BACK=20.0',
  ];
  for (const it of items) {
    const url = `${baseUrl}/stream/record/${it.id}?${streamAuth.query('record', it.id)}`;
    if (it.length > 0) {
      out.push(`#EXTINF:${it.duration.toFixed(3)},`);
      out.push(`#EXT-X-BYTERANGE:${it.length}@${it.offset}`);
      out.push(url);
    } else {
      // 没有索引的兜底：整片一片（老行为）
      out.push(`#EXTINF:${(it.duration || 60).toFixed(3)},`);
      out.push(url);
    }
  }
  return out.join('\n') + '\n';
}

/** 当前在用时移的频道（后台展示用） */
function status() {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    channelUrlId: id,
    channelId: s.channelId,
    idleMs: Date.now() - s.lastAccess,
    chunked: !!s.chunked,
  }));
}

/** 进程退出前收尾（现在没有子进程，只需要清定时器与会话表） */
function shutdown() {
  sessions.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  ensureSession, stopSession, touch, recordPlaylistText,
  status, shutdown, windowMinutes,
  IDLE_STOP_MS, DEFAULT_WINDOW_MIN,
};
