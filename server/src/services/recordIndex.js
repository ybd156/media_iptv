'use strict';

/**
 * 录像文件的「关键帧切片索引」。
 *
 * 为什么需要它：
 *   录像分片是**整文件**（默认 300 秒、100~200MB）。时移/回看如果直接拿整片当 HLS 分片、
 *   或直接播原文件：播放器为了拿"直播边缘"要从分片开头读起（TS 没有索引），一次就是几十上百 MB；
 *   每次 seek 也要从文件开头重读。所以按**关键帧**把它切成字节范围小块
 *   （`#EXT-X-BYTERANGE`），一次 seek 只取一小块（10 秒 ≈ 6MB），局域网上几十毫秒。
 *
 * 1.11.17 的架构改动：**扫描全部改成异步**。
 *
 *   原先用 spawnSync 调 ffprobe，单次扫 200MB 约 0.45 秒，而这 0.45 秒里
 *   **整个 Node 事件循环是停住的** —— 同一时刻所有客户端请求（心跳、EPG、别的频道的分片）
 *   一起卡住。线上日志里 `index.m3u8` 出现过 2.7 秒的响应，就是几次扫描叠在一起。
 *   现在改成 spawn + Promise：等待扫描时事件循环照常服务其他请求，代价只是
 *   "这一个请求多等一会儿"，而不是"所有人都多等"。
 *
 *   并发去重：同一个文件的扫描只会跑一次，多个请求同时要同一份索引时共享同一个 Promise。
 *
 * 索引仍然按文件缓存：已写完的文件（size 不变）长期复用并落盘；还在录的文件最多
 * [OPEN_TTL_MS] 重扫一次，且至少长了 [OPEN_RESCAN_BYTES] 才值得重扫。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../logger');

/** 目标切片长度（秒）。源的关键帧间隔实测 10 秒，切片必须从关键帧开始，所以这也是下限。 */
const CHUNK_SECONDS = 10;
/** 索引缓存：file -> { at, size, closed, chunks } */
const cache = new Map();
/** 还在录的文件最多多久重扫一次。切片每 10 秒才多一个，6 秒足够新；
 *  再短就是白烧 CPU（每次全量扫 200MB ≈ 0.45s），再长直播边缘就落后得多。 */
const OPEN_TTL_MS = 6_000;
/** 还在录的文件至少长了这么多字节才重扫（约 2 秒内容） */
const OPEN_RESCAN_BYTES = 1_500_000;
const CACHE_MAX = 128;
/** ffprobe 输出上限：200MB 的 TS 关键帧表约几 MB，64MB 是安全余量 */
const MAX_OUTPUT = 64 * 1024 * 1024;
const SCAN_TIMEOUT_MS = 30_000;

let ffprobeBin; // undefined=未探测, null=没有

/** 正在扫描的文件 key -> Promise，避免同一个文件被并发扫多次 */
const inflight = new Map();

/* ------------------------------------------------------------------ *
 * 落盘索引：服务器重启后不用把窗口里 24 个分片（每个 200MB）重扫一遍。
 * 只存**已写完**的文件（size+mtime 稳定），命中条件就是 size+mtime 都没变。
 * ------------------------------------------------------------------ */
const STORE_FILE = path.join(config.DATA_DIR, 'record-index.json');
const STORE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const STORE_MAX_ENTRIES = 4000;
let store = null;
let saveTimer = null;

function loadStore() {
  if (store) return store;
  store = {};
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (obj && typeof obj === 'object') store = obj;
  } catch (_) { /* 首次运行或文件损坏：当空表 */ }
  return store;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const keys = Object.keys(store);
      if (keys.length > STORE_MAX_ENTRIES) {
        // 淘汰最旧的：entries 带 at 时间戳，按它排序砍掉多余的
        keys.sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
        for (const k of keys.slice(0, keys.length - STORE_MAX_ENTRIES)) delete store[k];
      }
      const tmp = `${STORE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_FILE);
    } catch (e) {
      logger.warn(`[recordIndex] 索引落盘失败：${e.message}`);
    }
  }, 5000);
  if (saveTimer.unref) saveTimer.unref();
}

/** 落盘索引命中：size+mtime 都没变，直接拿旧结果（省掉一次全量扫描） */
function hydrateFromStore(file, st) {
  const saved = loadStore()[file];
  if (!saved || !Array.isArray(saved.chunks) || !saved.chunks.length) return null;
  if (saved.size !== st.size || saved.mtime !== st.mtimeMs) return null;
  if (Date.now() - (saved.at || 0) > STORE_MAX_AGE_MS) return null;
  cache.set(file, { at: Date.now(), size: st.size, closed: true, chunks: saved.chunks });
  return saved.chunks;
}

/** 探测 ffprobe：优先 PATH，其次与 ffmpeg 同目录 */
function detectFfprobe() {
  if (ffprobeBin !== undefined) return ffprobeBin;
  const { spawnSync } = require('child_process');
  const candidates = [];
  if (process.env.FFPROBE_PATH) candidates.push(process.env.FFPROBE_PATH);
  for (const cmd of ['which', 'where']) {
    try {
      const r = spawnSync(cmd, ['ffprobe'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        candidates.push(r.stdout.split(/\r?\n/)[0].trim());
        break;
      }
    } catch (_) { /* 换下一个 */ }
  }
  candidates.push('ffprobe');
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) { ffprobeBin = bin; return ffprobeBin; }
    } catch (_) { /* 换下一个 */ }
  }
  ffprobeBin = null;
  logger.warn('[recordIndex] 找不到 ffprobe，时移/回看会退回整片粒度（会卡）');
  return ffprobeBin;
}

/**
 * 跑一个外部命令并把输出收全（异步）。
 * @returns {Promise<{code:number,out:string}|null>} null 表示超时或启动失败
 */
function runCapture(bin, args, { timeout = SCAN_TIMEOUT_MS, maxOutput = MAX_OUTPUT } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let truncated = false;
    let proc;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let timer;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      return finish(null);
    }
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* 忽略 */ }
      finish(null);
    }, timeout);
    if (timer.unref) timer.unref();

    proc.stdout.on('data', (d) => {
      if (truncated) return;
      out += d;
      if (out.length > maxOutput) { truncated = true; out = ''; }
    });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => {
      if (truncated) return finish(null);
      finish(code === 0 && out ? { code, out } : null);
    });
  });
}

/**
 * 扫一遍视频关键帧（异步）。
 * @returns {Promise<Array<{t:number,pos:number}>|null>} 按**字节顺序**排列
 */
async function scanKeyframes(file) {
  const bin = detectFfprobe();
  if (!bin) return null;
  const r = await runCapture(bin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,pos,flags',
    '-of', 'csv=p=0',
    file,
  ]);
  if (!r) return null;
  const kf = [];
  for (const line of r.out.split('\n')) {
    // 输出形如 `31511.520000,564,K__,`（末尾还有一个空字段）
    const parts = line.trim().split(',');
    if (parts.length < 3) continue;
    const flags = parts[2] || '';
    if (!flags.includes('K')) continue;
    const t = parseFloat(parts[0]);
    const pos = parseInt(parts[1], 10);
    if (!Number.isFinite(t) || !Number.isFinite(pos) || pos < 0) continue;
    kf.push({ t, pos });
  }
  // B 帧会让 pts 与字节顺序不一致，按字节排；关键帧的 pts 本身是单调的
  kf.sort((a, b) => a.pos - b.pos);
  return kf;
}

/** 文件总时长（秒）；拿不到返回 0 */
async function fileDuration(file) {
  const bin = detectFfprobe();
  if (!bin) return 0;
  const r = await runCapture(bin, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { timeout: 15_000 });
  if (!r) return 0;
  const d = parseFloat((r.out || '').trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function evictIfNeeded() {
  if (cache.size <= CACHE_MAX) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [k] of entries.slice(0, cache.size - CACHE_MAX)) cache.delete(k);
}

/**
 * 取一个录像文件的切片表（异步）。
 *
 * 缓存命中直接返回；未命中才真的跑 ffprobe，且**同一个文件的并发请求共享同一次扫描**。
 *
 * @param {string} file 绝对路径
 * @param {boolean} closed 文件是否已写完（写完的最后一片长度才确定，可以放进播放列表）
 * @returns {Promise<Array<{offset:number,length:number,duration:number,tRel:number}>>}
 *          tRel = 该片起点相对文件第一个关键帧的秒数（调用方用它换算绝对时间）
 */
async function chunksOf(file, closed) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return []; }

  const hit = cache.get(file);
  if (hit && hit.closed === !!closed) {
    const fresh = closed
      ? hit.size === st.size
      : (Date.now() - hit.at < OPEN_TTL_MS) || (st.size - hit.size < OPEN_RESCAN_BYTES);
    if (fresh) return hit.chunks;
  }
  if (closed) {
    const saved = hydrateFromStore(file, st);
    if (saved) return saved;
  }

  const key = `${file}|${closed ? 1 : 0}|${st.size}`;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    const kf = await scanKeyframes(file);
    if (!kf || !kf.length) {
      // 扫不出关键帧（非 TS / 没有视频轨）：退回"整文件一片"，至少不崩
      const chunks = st.size > 0 ? [{ offset: 0, length: st.size, duration: 0, tRel: 0 }] : [];
      cache.set(file, { at: Date.now(), size: st.size, closed: !!closed, chunks });
      evictIfNeeded();
      return chunks;
    }
    const dur = await fileDuration(file);
    const t0 = kf[0].t;
    const chunks = [];
    for (let i = 0; i < kf.length; i++) {
      const isLast = i + 1 >= kf.length;
      if (isLast && !closed) break; // 还在写的最后一片：长度未定，不放进去
      const offset = kf[i].pos;
      const end = isLast ? st.size : kf[i + 1].pos;
      const length = end - offset;
      if (length <= 0) continue;
      const tRel = kf[i].t - t0;
      const duration = isLast
        ? Math.max(0.5, (dur || (kf[i].t - t0 + CHUNK_SECONDS)) - tRel)
        : kf[i + 1].t - kf[i].t;
      chunks.push({ offset, length, duration, tRel });
    }
    cache.set(file, { at: Date.now(), size: st.size, closed: !!closed, chunks });
    evictIfNeeded();
    if (closed) {
      // 已写完的分片：索引落盘，服务器重启后不用重扫
      loadStore()[file] = { size: st.size, mtime: st.mtimeMs, at: Date.now(), chunks };
      scheduleSave();
    }
    return chunks;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 回看用的 VOD 播放列表：整段录像按关键帧切片，带 `#EXT-X-ENDLIST`。
 * 播放器因此能精确 seek（一次只取一小块），也能立刻知道总时长。
 * @param {string} file 绝对路径
 * @param {string} chunkUrl 分片地址（含签名），所有切片共用它 + 字节范围
 * @returns {Promise<string|null>}
 */
async function vodPlaylist(file, chunkUrl) {
  const chunks = await chunksOf(file, true);
  if (!chunks.length) return null;
  const maxDur = chunks.reduce((m, c) => Math.max(m, c.duration), 0);
  const out = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxDur))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (const c of chunks) {
    out.push(`#EXTINF:${c.duration.toFixed(3)},`);
    out.push(`#EXT-X-BYTERANGE:${c.length}@${c.offset}`);
    out.push(chunkUrl);
  }
  out.push('#EXT-X-ENDLIST');
  return out.join('\n') + '\n';
}

/** 仅供诊断/测试 */
function clearCache() { cache.clear(); }

/**
 * 只读缓存，**不做扫描**：给"播放列表要马上返回"的场景用。
 * 没索引就返回 null，调用方退回"整片一片"的老粒度，并调 [warm] 后台补索引。
 */
function peek(file, closed) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  const hit = cache.get(file);
  if (hit && hit.closed === !!closed) {
    if (!closed) return hit.chunks; // 还在录的：有就用，新鲜度由 chunksOf 负责
    if (hit.size === st.size) return hit.chunks;
  }
  return closed ? hydrateFromStore(file, st) : null;
}

/** 已经有索引（内存或落盘）就不用再排队扫 */
function hasIndex(file) {
  if (cache.has(file)) return true;
  let st;
  try { st = fs.statSync(file); } catch (_) { return true; } // 文件不在：别排队
  return !!hydrateFromStore(file, st);
}

// 后台补索引队列：一次只扫一个文件，扫完歇一会，别和录像写入/直播抢 IO。
// 间隔取 600ms：窗口里 24 个分片 ≈ 4.8GB 要读，太快会把磁盘打满。
const warmQueue = [];
let warmRunning = false;
const WARM_GAP_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function warm(files) {
  for (const f of files) {
    if (!f || warmQueue.includes(f) || hasIndex(f)) continue;
    warmQueue.push(f);
  }
  if (warmRunning) return;
  warmRunning = true;
  (async () => {
    while (warmQueue.length) {
      const file = warmQueue.shift();
      try { await chunksOf(file, true); } catch (_) { /* 扫不到就算了 */ }
      await sleep(WARM_GAP_MS);
    }
    warmRunning = false;
  })();
}

module.exports = { chunksOf, peek, warm, vodPlaylist, clearCache, hasIndex, CHUNK_SECONDS, OPEN_TTL_MS };
