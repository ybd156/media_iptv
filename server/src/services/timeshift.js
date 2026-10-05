'use strict';

/**
 * 时移（timeshift）：让直播可以暂停、可以往回拖。
 *
 * 做法是**按需**把直播流转成滚动 HLS：客户端第一次请求播放列表时拉起一个 ffmpeg，
 * 用 `-f hls -hls_list_size N -hls_flags delete_segments` 维护一个固定长度的滑动窗口，
 * 窗口外的分片由 ffmpeg 自己删掉。客户端（ExoPlayer）原生支持 HLS，
 * 于是暂停 / 回退 / 追到直播边缘都由播放器自己完成，服务端不用管会话状态。
 *
 * 几个刻意的取舍：
 *   - **按需启动**：没人看的时候不占 CPU。空闲 [IDLE_STOP_MS] 后自动停掉并清目录。
 *   - **`-c copy` 不转码**：时移只是缓冲，不该为了缓冲把 CPU 吃满；代价是只能回退到
 *     缓冲区里已有的分片，不能改变编码。
 *   - **签名走路径**：m3u8 里的分片是相对路径，相对解析会丢掉查询串，
 *     所以签名放进路径（见 streamAuth.signature 的注释）。
 *   - 组播源（rtp/udp）走不了这条路：它本来就是靠 ffmpeg 拉流转封装，
 *     时移会让链路变成「ffmpeg 拉组播 → HLS」，可以支持但先不做，直接不提供。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const logger = require('../logger');
const { splitStreamUrl } = require('./streamUrl');
const { resolveUserAgent, globalUserAgent } = require('./ua');

const ROOT = path.join(config.DATA_DIR, 'timeshift');
const SEGMENT_SECONDS = 4;
/**
 * 试过但**不能用**的加速手段：`-hls_init_time 1`（文档上说是"只把初始列表的分片切短"）。
 *
 * 实测（ffmpeg 8.1.1 + 线上这个源）：它不是只影响首片，而是把**所有分片**都切成 1 秒 ——
 * 33 秒窗口里 33 个分片全是 1.0s，播放列表写成 `#EXT-X-TARGETDURATION:1`。
 * 后果：分片数放大 4 倍（小文件、请求频率），更要命的是播放器按
 * 3×TARGETDURATION = 3 秒贴直播边缘播，而分片实际 4 秒才出一个 —— 正好踩回
 * 1.11.14 修掉的"贴边播 → 等下一个关键帧分片 → 卡十几秒"那个坑。
 *
 * 单独加 `-analyzeduration/-probesize` 压探测期也测过：首片从 5.2s 变 4.8s，没有意义
 * （探测期和"攒够一个分片内容"的时间本来是重叠的）。
 *
 * 结论：首片的 4 秒等待消不掉，只能靠**提前把窗口建起来**（客户端进频道后静默预热）。
 */
const DEFAULT_WINDOW_MIN = 30;
/** 多久没人请求就停掉 ffmpeg（客户端切台/退出后不会一直占着 CPU） */
const streamAuth = require('./streamAuth');

const IDLE_STOP_MS = 120_000;
/**
 * 会话重启时，目录里的内容还能不能续写。
 * 上游一断 ffmpeg 就退出，下次请求会重建会话；如果重建时清空目录，
 * **整个时移窗口就从零开始** —— 实测用户服务器上窗口长期只有 4 分钟左右、
 * MEDIA-SEQUENCE 一直是 0，就是这个原因（他的源会返 503）。
 * 只要播放列表是刚刚还在写的（90 秒内），就续写而不是重开。
 */
const RESUME_WINDOW_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;

/** channelUrlId -> { dir, proc, lastAccess, startedAt, listSize } */
const sessions = new Map();

let sweepTimer = null;
let ffmpegBin; // undefined=未探测, null=没有

function dirOf(channelUrlId) {
  return path.join(ROOT, String(channelUrlId));
}

/** 与 proxy.js 同款探测：优先 PATH 里的 ffmpeg */
function detectFfmpeg() {
  if (ffmpegBin !== undefined) return ffmpegBin;
  for (const cmd of ['which', 'where']) {
    try {
      const r = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) {
        ffmpegBin = r.stdout.split(/\r?\n/)[0].trim();
        return ffmpegBin;
      }
    } catch (_) { /* 换下一个 */ }
  }
  ffmpegBin = null;
  return ffmpegBin;
}

/** 时移窗口（分钟）：settings.timeshiftWindowMin，非法值回退默认 */
/** 目录里的时移会话是否还能续写（播放列表存在且刚被写过＝刚断掉，不是陈年残留） */
function isSessionResumable(dir) {
  try {
    return Date.now() - fs.statSync(path.join(dir, 'index.m3u8')).mtimeMs < RESUME_WINDOW_MS;
  } catch (_) {
    return false;
  }
}

/** 该线路属于哪个频道 */
function channelIdOf(db, channelUrlId) {
  try {
    const r = db.prepare('SELECT channel_id FROM channel_urls WHERE id = ?').get(channelUrlId);
    return r ? r.channel_id : null;
  } catch (_) { return null; }
}

/** 这个频道有没有可用录像 —— 有就走"共用录像"模式，不再另跑 ffmpeg */
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
 * 录像能不能当时间轴用。
 * 光"有录像记录"不够 —— 线上实测过一种坏法：录像 ffmpeg 每 15 秒退出重启一次，
 * 每个文件里只有 0.8 秒内容。拿这种录像做时移，时间轴和实际内容完全对不上，表现就是黑屏。
 *
 * 判据：在**最近几个已经写完的分片**里，只要有任意一片的真实时长接近配置的分片长度，
 * 就认为录像可用。三个刻意的取舍：
 *   - **不探最新那一片**：scanSegments 会把正在录制的文件也登记进库，它的时长天然
 *     只有"已经录了多久"（线上实测 13:03:18 探到 115.95s / 分片 300s），拿它判会
 *     把健康录像判成"不可靠"，而且每 5 分钟翻转一次（分片刚开头判否、快写完判是）。
 *   - **不只看最新那一片（已完成）**：服务端升级会重启录像进程，重启时那一片必然被
 *     截短（线上 14:01 重启后有一片只有 25 秒），只看它同样会误判。
 *   - **要求最新录像还在时移窗口内**：否则录像是很久以前的，拿它当"直播时间轴"没意义。
 */
function recordingsUsable(db, channelId) {
  const hit = usableCache.get(channelId);
  if (hit && Date.now() - hit.at < USABLE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const rows = db.prepare(
      `SELECT date, start, file FROM recordings
       WHERE channel_id = ? AND status = 'ok' ORDER BY date DESC, start DESC LIMIT 4`
    ).all(channelId);
    if (rows.length >= 2) {
      // 配置的分片长度（recordSegmentMin 分钟），判"是不是明显短于它"
      let expected = 1800;
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
        if (!fs.existsSync(file)) continue;
        const chunks = recordIndex.chunksOf(file, true);
        const dur = chunks.reduce((a, c) => a + c.duration, 0);
        if (dur > best) best = dur;
        if (dur >= expected * 0.5) { ok = true; break; }
      }
      if (!ok) {
        logger.warn(`[timeshift] channel #${channelId} 的录像不可靠（最近已完成分片最长 ${best.toFixed(1)}s，配置 ${expected}s），时移退回滚动 HLS`);
      }
    }
  } catch (_) { ok = false; }
  usableCache.set(channelId, { at: Date.now(), ok });
  return ok;
}

function secOfDay(hms) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(hms || ''));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

/** "YYYY-MM-DD" + "HH:MM:SS" → 毫秒时间戳 */
function startMsOf(date, start) {
  const a = secOfDay(start);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (a === null || !m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0).getTime() + a * 1000;
}

function windowMinutes(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'timeshiftWindowMin'").get();
    if (row) {
      const v = parseInt(String(row.value).replace(/^"|"$/g, ''), 10);
      if (Number.isFinite(v) && v >= 5 && v <= 360) return v;
    }
  } catch (_) { /* 用默认 */ }
  return DEFAULT_WINDOW_MIN;
}

function touch(channelUrlId) {
  const s = sessions.get(channelUrlId);
  if (s) s.lastAccess = Date.now();
}

/** 停掉一个会话并清掉它的分片目录 */
function stopSession(channelUrlId, reason = '') {
  const s = sessions.get(channelUrlId);
  if (!s) return false;
  sessions.delete(channelUrlId);
  try { if (s.proc && s.proc.exitCode === null) s.proc.kill('SIGKILL'); } catch (_) { /* 忽略 */ }
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  if (reason) logger.info(`[timeshift] #${channelUrlId} 会话结束（${reason}）`);
  return true;
}

/**
 * 确保某个源地址的时移会话在跑，返回会话对象；ffmpeg 不可用或源不存在时返回 null。
 * @param {object} db
 * @param {number} channelUrlId
 */
function ensureSession(db, channelUrlId) {
  const alive = sessions.get(channelUrlId);
  // 录像共用模式没有 ffmpeg 进程，`proc` 恒为 null —— 必须单独判活，
  // 否则每次请求都会走到下面的"进程已退出"，把会话反复销毁重建
  // （日志里就是「会话结束（进程已退出）」和「录像共用模式」交替刷屏）。
  if (alive && alive.mode === 'record') {
    alive.lastAccess = Date.now();
    return alive;
  }
  if (alive && alive.proc && alive.proc.exitCode === null) {
    alive.lastAccess = Date.now();
    return alive;
  }
  if (alive) stopSession(channelUrlId, '进程已退出');

  // ---- 录像共用：这个频道有录像时，直接复用录像分片的时间轴 ----
  // 不再为时移另起一路 ffmpeg 攒滚动窗口：窗口长度跟随录像保留期，
  // 也不占第二份磁盘。没有录像的频道才退回下面的滚动 HLS。
  const channelId = channelIdOf(db, channelUrlId);
  if (hasRecordings(db, channelId) && recordingsUsable(db, channelId)) {
    const rec = {
      dir: null, proc: null, mode: 'record', channelId,
      lastAccess: Date.now(), startedAt: Date.now(), listSize: 0,
    };
    sessions.set(channelUrlId, rec);
    logger.info(`[timeshift] #${channelUrlId} 录像共用模式（channel #${channelId}），不启动 ffmpeg`);
    return rec;
  }

  const bin = detectFfmpeg();
  if (!bin) return null;

  const row = db.prepare(
    `SELECT cu.url, s.ua AS source_ua FROM channel_urls cu
     LEFT JOIN channels c ON c.id = cu.channel_id
     LEFT JOIN sources s ON s.id = c.source_id
     WHERE cu.id = ?`
  ).get(channelUrlId);
  if (!row) return null;

  const { url } = splitStreamUrl(row.url);
  // 组播源**同样**支持时移。原先这里直接 return null，配合 client.js 里的
  // 同类判断，结果是"时移开关一开，组播频道全都没有时移" —— 用户看到的就是
  // "一开就全局开，但有些并没有"。组播本来就要经 ffmpeg 转封装，
  // 输出从 MPEG-TS 改成 HLS 并不额外增加一次转封装。

  const ua = resolveUserAgent({
    rawUrl: row.url,
    sourceUa: row.source_ua,
    globalUa: globalUserAgent(db),
  }).ua;

  const dir = dirOf(channelUrlId);
  // 续写还是重开：见 RESUME_WINDOW_MS 的说明。
  // 只有**过期残留**（上次会话结束已超过 90 秒）才清空，避免把很久以前的内容
  // 当成"直播窗口"续上来；刚断掉的重建一律保留分片继续累积。
  const resume = isSessionResumable(dir);
  if (!resume) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  if (resume) logger.info(`[timeshift] #${channelUrlId} 会话续写（保留已有分片，窗口不清零）`);

  const listSize = Math.max(10, Math.round((windowMinutes(db) * 60) / SEGMENT_SECONDS));
  const args = ['-hide_banner', '-loglevel', 'warning'];
  // -reconnect* 与 -user_agent 都是 **HTTP 协议专属选项**。对 rtsp:// 或本地路径
  // 加上它们，ffmpeg 会直接以 code=8 "Option not found" 退出（实测），
  // 时移会表现为「缓冲一直建立不起来」。所以按协议区分。
  const isHttp = /^https?:\/\//i.test(url);
  const isMulticast = /^(rtp|udp):\/\//i.test(url);
  if (isHttp) {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '10',
      // 上游返 4xx/5xx 时**不要让 ffmpeg 退出**：这个源实测会返 503，
      // 一退出会话就重建、窗口清零。让它在内部重试，窗口才能连续累积。
      '-reconnect_on_http_error', '4xx,5xx',
      '-reconnect_on_network_error', '1'
    );
    if (ua) args.push('-user_agent', ua);
  } else if (isMulticast) {
    // 组播：与直播代理同一套低延迟输入参数。
    // 不加这些的话，ffmpeg 要攒够 avformat 的探测缓冲才开始切分，
    // 表现为"点了时移要等十几秒才出画面"，和别的频道手感不一致。
    // 组播是持续推送的长连接，不需要 -reconnect*，而且它对 udp/rtp 也无意义。
    args.push(
      '-fflags', 'nobuffer+discardcorrupt',
      '-flags', 'low_delay',
      '-analyzeduration', '500000',
      '-probesize', '1000000'
    );
  }
  args.push(
    // 直播源的时间戳会跳（线上实测：音频 DTS 从 86400 跳回 454），
    // 而 -c copy 到 segment/HLS 封装器**要求 DTS 单调递增**，否则 mpegts 封装器
    // 直接报 "non monotonically increasing dts" 并以 code=-22 退出 ——
    // 这就是"每几秒重启一次、每片只录到一点点"的真正原因（不是网络问题，
    // 所以 -reconnect* 那套完全无效）。让 ffmpeg 忽略输入 DTS、必要时重建 PTS，
    // 并把起始时间归零，就能一次录到底。
    // 源在分片边界会**重启音频时间戳**（实测音频 DTS 从 79920 跳回 454），
    // 而 mpegts 封装器要求 DTS 单调递增，于是直接以 code=-22 退出、ffmpeg code=234。
    // +igndts 只作用于解复用器，管不住封装器 —— 真正有效的做法是**不信任源的任何时间戳**，
    // 让 ffmpeg 用墙上时钟重新生成，这样输出天然单调。
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+genpts+igndts',
    '-i', url,
    // 音频**重编码**成 AC3，不再 -c copy。
    // 这个源的音频时间戳本身是坏的（线上实测 DTS 从 64098 倒退到 2359，数值还极小），
    // mpegts 封装器要求 DTS 单调递增 → code=-22 退出、ffmpeg code=234。
    // +genpts+igndts、+use_wallclock_as_timestamps 都试过，没用 —— 只要走 copy，
    // 封装器就得信任源时间戳；**编码器输出的时间戳不可能非单调**，这是唯一能保证修好的办法。
    // 选 AC3 而非 AAC：这台电视的硬件音频解码器只有 AC3/EAC3/DTS-HD，AAC/MP3 只有软解，
    // 转 AC3 等于把音频解码挪到硬件上。视频仍 -c copy，零转码。
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-max_interleave_delta', '0',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', String(listSize),
    // append_list：续写模式必须带上，否则 ffmpeg 会把播放列表整个重写、
    // 分片编号从 0 开始，旧分片被覆盖，等于窗口还是清零了。
    '-hls_flags', resume ? 'delete_segments+omit_endlist+append_list' : 'delete_segments+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8')
  );

  let proc;
  try {
    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    logger.error(`[timeshift] #${channelUrlId} 启动 ffmpeg 失败：${e.message}`);
    return null;
  }
  proc.on('error', (e) => logger.error(`[timeshift] #${channelUrlId} ffmpeg 错误：${e.message}`));
  let tail = '';
  proc.stderr.on('data', (d) => {
    tail = (tail + d.toString()).slice(-800);
  });
  proc.on('exit', (code) => {
    const s = sessions.get(channelUrlId);
    if (s && s.proc === proc) sessions.delete(channelUrlId);
    if (code !== 0) logger.warn(`[timeshift] #${channelUrlId} ffmpeg 退出 code=${code} ${tail.trim().split('\n').pop() || ''}`);
  });

  const session = { dir, proc, lastAccess: Date.now(), startedAt: Date.now(), listSize };
  sessions.set(channelUrlId, session);
  logger.info(`[timeshift] #${channelUrlId} 会话启动，窗口 ${listSize * SEGMENT_SECONDS / 60} 分钟（分片 ${SEGMENT_SECONDS}s）`);

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

/** 播放列表路径；会话没起来或还没吐出第一个分片时返回 null */
/**
 * 录像共用模式的播放列表：按录像分片动态生成（不落盘）。
 * 分片地址用绝对的 /stream/record/:id（带 record 签名，支持 Range），
 * 所以分片请求根本不用经过时移那条路。
 * @returns {string|null} null 表示当前会话不是录像模式（调用方回落到读文件）
 */
function recordPlaylistText(db, channelUrlId, baseUrl) {
  const s = sessions.get(channelUrlId);
  if (!s || s.mode !== 'record') return null;
  // 录像分片是每 2 分钟扫描登记的。这里限频补扫一次，
  // 否则"直播边缘"最多会落后两分钟，用户会觉得回到直播后差了 2 分钟。
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

  // 每个录像分片（300 秒 / 100~200MB）再按**关键帧**切成字节范围小块。
  // 直接拿整片当 HLS 分片时，播放器为了取"直播边缘"要从分片开头读起，
  // 一次 seek 也要重读几十上百 MB —— 这就是"时移拉流卡、拖进度条不流畅"的根因。
  // 切成 10 秒小块后，一次只取一小块（≈6MB），局域网几十毫秒。
  //
  // 粒度**只会从整片升级到切片，不会退回去**：播放器是按时间在播放列表里定位分片的
  // （不是按序号硬映射），换结构最多重新缓冲一小块，不会跳内容；反过来退回整片则会
  // 让已经拖到精确位置的用户突然回到粗粒度。
  //
  // 线上教训（1.11.10 的坑）：只在**会话创建时**判定一次的话，服务端重启后索引还没
  // 预热完的那 30 秒里建的会话会一直停在整片粒度 —— 只要有人在看，会话就不会空闲
  // 过期，于是整个观看过程都在整片粒度：拖一次进度条要重读 200MB，画面卡十几秒，
  // 客户端的卡死监测判定"播放卡住，正在重新拉流"，用户看到的就是
  // 「拉进度条画面卡住 → 提示重新拉流 → 可网速明明在跑」。所以每个请求都复查一次。
  //
  // 索引本身很贵（ffprobe 全量扫 200MB ≈ 0.45s），正在录的那一片必须同步扫
  // （直播边缘靠它，它自己有 TTL 缓存），已写完的一律只读缓存。
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
    // 整片兜底时长：用"到下一个分片起点的间隔"，最后一片用已录时长
    const nextMs = i + 1 < picked.length ? picked[i + 1].ms : Date.now();
    let chunks = null;
    if (s.chunked) {
      if (isNewest) {
        try { chunks = recordIndex.chunksOf(full, false); } catch (_) { chunks = null; }
      } else {
        chunks = recordIndex.peek(full, true);
        if (!chunks) {
          // 已写完但索引还没建：**同步补一次**（约 0.45s），不要下发"整片"条目。
          // 混在切片里的整片条目会让播放器为了预取直播边缘去拉整个 200MB 文件，
          // 把正在播的那一路饿死 —— 线上表现是"拖过去先播 1~2 秒，然后卡 7~8 秒"。
          try { chunks = recordIndex.chunksOf(full, true); } catch (_) { chunks = null; }
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
  // 缺索引的按"从新到旧"补（用户拖进度条多半在直播边缘附近），后台慢慢扫
  if (needWarm.length) recordIndex.warm(needWarm.reverse());
  if (!items.length) return null;
  const maxDur = items.reduce((m, it) => Math.max(m, it.duration), 0);
  // 序号必须随窗口滚动递增，否则播放器会把新分片当成旧分片、认为列表没变。
  // 用"第一片的绝对时间 ÷ 切片长度"当序号：天然单调、跨会话重启也连续，
  // 不用再数"窗口外有多少片"（那要扫全部录像，代价随保留期增长）。
  const seq = Math.max(0, Math.floor(items[0].ms / (recordIndex.CHUNK_SECONDS * 1000)));
  const out = [
    '#EXTM3U', '#EXT-X-VERSION:4',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDur) || 6}`,
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    // HOLD-BACK：告诉播放器"直播边缘往后留 20 秒"。分片是 10 秒一个（关键帧对齐），
    // 不留余量的话播放器会贴着播放列表末尾播，而末尾那一片要等下一个关键帧才写出来 ——
    // 实测表现就是"进时移先黑十几秒""播到边缘卡住"。留两片余量后手上始终有下一片。
    // 不写这一条时 ExoPlayer 会按 3×TARGETDURATION（30 秒）算，同样能兜住。
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
      out.push(`#EXTINF:${(it.duration || SEGMENT_SECONDS).toFixed(3)},`);
      out.push(url);
    }
  }
  return out.join('\n') + '\n';
}

function playlistPath(channelUrlId) {
  const f = path.join(dirOf(channelUrlId), 'index.m3u8');
  return fs.existsSync(f) ? f : null;
}

/** 分片路径，带名字白名单，挡住目录穿越 */
function segmentPath(channelUrlId, segName) {
  const name = path.basename(String(segName || ''));
  if (!/^seg\d+\.ts$/.test(name)) return null;
  const f = path.join(dirOf(channelUrlId), name);
  return fs.existsSync(f) ? f : null;
}

function status() {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    channelUrlId: id,
    running: !!s.proc && s.proc.exitCode === null,
    idleMs: Date.now() - s.lastAccess,
    windowMin: (s.listSize * SEGMENT_SECONDS) / 60,
  }));
}

/** 进程退出前收尾（避免留下 ffmpeg 孤儿进程） */
function shutdown() {
  for (const id of Array.from(sessions.keys())) stopSession(id);
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  ensureSession, stopSession, touch, playlistPath, segmentPath, dirOf, recordPlaylistText,
  status, shutdown, windowMinutes, detectFfmpeg,
  SEGMENT_SECONDS, DEFAULT_WINDOW_MIN, IDLE_STOP_MS, RESUME_WINDOW_MS, ROOT,
};
