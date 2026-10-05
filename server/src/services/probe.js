'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');
const { detectFfmpeg } = require('./proxy');
const { splitStreamUrl } = require('./streamUrl');

/**
 * 直播源画质探测（服务端后台）：
 * 1. HLS 源（.m3u8）走快速通道：直接 HTTP 拉播放列表，解析 RESOLUTION=宽x高，亚秒级完成
 * 2. 其它源用 ffprobe（优先）或 ffmpeg -i 解析 stderr 的 Video: ... 1920x1080
 * 结果写入 channel_urls.width/height；/channels 按高度降序下发，换台即落在最高清线路。
 * 并发 4，ffprobe 单条 10 秒超时；失败的 6 小时后重试，避免卡死队列。
 */

let ffprobePath = null;
function detectFfprobe() {
  if (ffprobePath !== null) return ffprobePath || null;
  // 优先与 ffmpeg 同目录的 ffprobe
  const ff = detectFfmpeg();
  if (ff) {
    const sibling = path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) {
      ffprobePath = sibling;
      return ffprobePath;
    }
  }
  try {
    const { spawnSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['ffprobe'], { encoding: 'utf8' });
    ffprobePath = r.status === 0 && r.stdout ? r.stdout.split(/\r?\n/)[0].trim() : false;
  } catch {
    ffprobePath = false;
  }
  return ffprobePath || null;
}

/** 解析 `url|User-Agent=xxx|Referer=xxx` 存储形式（统一实现见 services/streamUrl.js） */
const splitUrl = splitStreamUrl;
const { resolveUserAgent, globalUserAgent } = require('./ua');

/**
 * HLS 快速通道：拉 m3u8 文本解析 RESOLUTION（ master 播放列表带全部清晰度档位，取最高）。
 * 返回 {width,height}；非 m3u8 / 媒体列表无 RESOLUTION / 网络失败均返回 null（回退 ffprobe）。
 */
async function probeViaPlaylist(url, headers) {
  if (!/\.m3u8(\?|#|$)/i.test(url)) return null;
  try {
    const h = { 'User-Agent': headers['user-agent'] || 'MediaIptv-Probe/1.0' };
    if (headers.referer) h.Referer = headers.referer;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000), headers: h, redirect: 'follow' });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text.includes('#EXTM3U')) return null;
    if (!text.includes('#EXT-X-STREAM-INF')) return null; // 媒体列表，分辨率在分片里，交给 ffprobe
    let best = null;
    const re = /RESOLUTION=(\d{2,5})x(\d{2,5})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const w = parseInt(m[1], 10);
      const hh = parseInt(m[2], 10);
      if (!best || hh > best.height) best = { width: w, height: hh };
    }
    return best;
  } catch {
    return null;
  }
}

/** ffprobe/ffmpeg 探测单条源，返回 { width, height } 或 null */
function probeViaFfmpeg(url, headers) {
  return new Promise((resolve) => {
    const probe = detectFfprobe();
    let args;
    let bin;
    if (probe) {
      bin = probe;
      args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'];
    } else {
      bin = detectFfmpeg();
      if (!bin) return resolve(null);
      args = ['-hide_banner', '-v', 'info'];
    }
    if (headers['user-agent']) args.push('-user_agent', headers['user-agent']);
    if (headers['referer']) args.push('-headers', `Referer: ${headers.referer}\r\n`);
    if (/^(rtp|udp):\/\//i.test(url) || /\/rtp\/|\/udp\//i.test(url)) {
      args.push('-analyzeduration', '2000000', '-probesize', '2000000');
    }
    if (probe) {
      args.push(url);
    } else {
      args.push('-i', url, '-f', 'null', '-');
    }

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const done = (r) => {
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch {}
      resolve(r);
    };
    // HTTP(S) 源 3 秒超时；HTTP 伪装的组播（/rtp/ /udp/）首包慢，放宽到 10 秒
    const timeoutMs = /\/rtp\/|\/udp\//i.test(url) ? 10000 : 3000;
    const timer = setTimeout(() => done(null), timeoutMs);

    proc.stdout.on('data', (d) => {
      out += d.toString();
      if (probe) {
        const m = out.match(/(\d{2,5}),(\d{2,5})/);
        if (m) done({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
      }
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (!probe) {
        // ffmpeg -i 模式：从 stderr 解析 "Video: h264 ... 1920x1080"
        const m = err.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        if (m) done({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
      }
    });
    proc.on('error', () => done(null));
    proc.on('exit', () => {
      if (probe) {
        const m = out.match(/(\d{2,5}),(\d{2,5})/);
        done(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
      } else {
        const m = err.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        done(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
      }
    });
  });
}

/** 探测单条源：HLS 快速通道优先，失败回退 ffprobe/ffmpeg */
/**
 * @param {string} rawUrl 存储形式的源地址
 * @param {string} [ua]   已决策好的 User-Agent（优先于地址内联的那个）
 */
async function probeOne(rawUrl, ua) {
  const { url, headers } = splitUrl(rawUrl);
  if (ua) headers['user-agent'] = ua;
  const fast = await probeViaPlaylist(url, headers);
  if (fast) return fast;
  return probeViaFfmpeg(url, headers);
}

// ---- 后台队列 ----
let running = false;
let total = 0;
let finished = 0;

function probeStatus() {
  return { running, total, finished };
}

/**
 * 后台探测所有未探测或探测过期的线路（非阻塞）。
 * force=true 时重新探测全部。
 * 成功结果 24 小时内不重探；失败（height 为 null）1 小时后重试，
 * 避免一次防盗链/超时失败导致高清源整天被排到队尾。
 */
function startProbe(db, { force = false } = {}) {
  if (running) return probeStatus();
  const okAgo = Math.floor(Date.now() / 1000) - 24 * 3600;
  const failAgo = Math.floor(Date.now() / 1000) - 3600;
  const where = `FROM channel_urls cu
                 LEFT JOIN channels c ON c.id = cu.channel_id
                 LEFT JOIN sources s ON s.id = c.source_id`;
  const select = `SELECT cu.id, cu.url, s.ua AS source_ua ${where}`;
  const rows = force
    ? db.prepare(select).all()
    : db.prepare(`${select}
                  WHERE cu.probe_at IS NULL
                     OR (cu.height IS NOT NULL AND cu.probe_at < ?)
                     OR (cu.height IS NULL AND cu.probe_at < ?)`).all(okAgo, failAgo);
  if (rows.length === 0) return { running: false, total: 0, finished: 0 };

  running = true;
  total = rows.length;
  finished = 0;
  logger.info(`[probe] start background probe: ${rows.length} sources`);
  const update = db.prepare('UPDATE channel_urls SET width = ?, height = ?, probe_at = ? WHERE id = ?');

  (async () => {
    // HLS 快速通道亚秒级完成；HTTP 源 3 秒超时，组播源跳过（需 ffmpeg 拉流，不适合批量探测）
    const CONCURRENCY = 16;
    let idx = 0;
    const worker = async () => {
      while (idx < rows.length) {
        const row = rows[idx++];
        try {
          const rawUrl = String(row.url).split('|')[0].trim();
          // 纯组播（rtp:// udp://）无法 HTTP 直接探测，跳过
          if (/^(rtp|udp):\/\//i.test(rawUrl)) {
            update.run(null, null, Math.floor(Date.now() / 1000), row.id);
            finished++;
            continue;
          }
          // 用统一的 UA 决策（内联 > 源 UA > 全局 UA）。
          // 原先这里是「源里没 UA 就不管」，既没有全局兜底，又用字符串 includes 判断
          // 内联 UA 是否存在 —— URL 的查询参数里带 user-agent= 就会被误判。
          const ua = resolveUserAgent({
            rawUrl: row.url,
            sourceUa: row.source_ua,
            globalUa: globalUserAgent(db),
          }).ua;
          const r = await probeOne(row.url, ua);
          update.run(r ? r.width : null, r ? r.height : null, Math.floor(Date.now() / 1000), row.id);
          if (r) logger.info(`[probe] #${row.id} -> ${r.width}x${r.height}`);
        } catch (e) {
          logger.warn(`[probe] #${row.id} failed: ${e.message}`);
        }
        finished++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    running = false;
    logger.info(`[probe] background probe done: ${finished}/${total}`);
  })().catch((e) => {
    running = false;
    logger.error(`[probe] queue error: ${e.message}`);
  });
  return probeStatus();
}

module.exports = { startProbe, probeStatus, probeOne };
