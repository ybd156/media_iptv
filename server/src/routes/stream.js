'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pipeUpstream, pipeMulticast } = require('../services/proxy');
const streamAuth = require('../services/streamAuth');
const { splitStreamUrl } = require('../services/streamUrl');
const { resolveUserAgent } = require('../services/ua');
const recordIndex = require('../services/recordIndex');
const config = require('../config');
const logger = require('../logger');

/**
 * 流分发路由
 * /stream/live/:channelUrlId  - 代理转发直播源
 * /stream/record/:id          - 录像文件流式播放（支持 Range）
 * /stream/record/:id/index.m3u8 - 回看：同一段录像按关键帧切片的 VOD 播放列表
 *
 * 两条路由都需要 URL 签名（?t=&s=，由 /api/client/channels 与 /catchup/list 下发）。
 * 播放器无法附加自定义 header，所以签名只能走查询参数；可用
 * settings.streamAuth='0' 整体关闭以兼容旧版客户端。
 */
module.exports = function streamRoutes(db) {
  const router = express.Router();

  // 设置项缓存：直播流是最高频的请求路径，原先每个请求都要查一次 settings 表
  // 拿全局 UA。缓存 30 秒，管理后台改完最迟半分钟生效。
  const SETTINGS_TTL_MS = 30 * 1000;
  let settingsCacheAt = 0;
  let settingsCache = {};
  const getSetting = (key) => {
    const now = Date.now();
    if (now - settingsCacheAt > SETTINGS_TTL_MS) {
      settingsCache = {};
      for (const r of db.prepare('SELECT key, value FROM settings').all()) {
        try { settingsCache[r.key] = JSON.parse(r.value); } catch (_) { settingsCache[r.key] = r.value; }
      }
      settingsCacheAt = now;
    }
    return settingsCache[key];
  };

  router.get('/live/:channelUrlId', streamAuth.middleware('live'), (req, res) => {
    const id = parseInt(req.params.channelUrlId, 10);
    // 经 channel → source 关联取出按源配置的 UA（优先级：?ua > 源地址内联 > 源UA > 全局UA）
    const row = db.prepare(
      `SELECT cu.url, s.ua AS source_ua FROM channel_urls cu
       LEFT JOIN channels c ON c.id = cu.channel_id
       LEFT JOIN sources s ON s.id = c.source_id
       WHERE cu.id = ?`
    ).get(id);
    if (!row) {
      return res.status(404).json({ code: 404, msg: 'channel url not found', data: null });
    }
    // 解析 `url|User-Agent=xxx|Referer=xxx` 存储形式
    const { url, headers } = splitStreamUrl(row.url);
    // UA 统一由 services/ua.js 决策：?ua > 地址内联 > 源 UA > 全局 UA。
    // 客户端直连、画质探测、定时录像用的是同一份规则，不会再出现
    // 「后台填了 UA，播放能用、录像不生效」这种从界面上看不出来的问题。
    const ua = resolveUserAgent({
      rawUrl: row.url,
      sourceUa: row.source_ua,
      globalUa: getSetting('streamUserAgent'),
      override: req.query.ua,
    });
    if (ua.ua) headers['user-agent'] = ua.ua;

    // 组播源（rtp:// / udp://）：ffmpeg 拉流转 MPEG-TS over HTTP
    if (/^(rtp|udp):\/\//i.test(url)) {
      pipeMulticast(url, req, res);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ code: 400, msg: 'unsupported protocol', data: null });
    }
    pipeUpstream(url, req, res, headers);
  });

  // ---------- 时移（滚动 HLS）----------
  // 签名放在**路径**里而不是查询串：m3u8 里的分片是相对路径，相对解析只保留路径前缀、
  // 查询串会丢，那样分片请求就带不上签名了。放路径里则自动跟着分片一起传下去。
  const timeshift = require('../services/timeshift');

  const timeshiftAuth = (req, res, next) => {
    const id = parseInt(req.params.channelUrlId, 10);
    if (streamAuth.verify('live', id, req.params.t, req.params.s)) return next();
    logger.warn(`[timeshift] 拒绝未签名请求 id=${req.params.channelUrlId} ip=${req.ip}`);
    return res.status(403).json({ code: 403, msg: '时移地址签名无效或已过期，请重新获取频道列表', data: null });
  };

  // 播放列表：第一次请求会拉起 ffmpeg，之后每次请求刷新空闲计时
  router.get('/timeshift/:channelUrlId/:t/:s/index.m3u8', timeshiftAuth, (req, res) => {
    const id = parseInt(req.params.channelUrlId, 10);
    const session = timeshift.ensureSession(db, id);
    if (!session) {
      return res.status(503).json({ code: 503, msg: '时移不可用（线路不存在，或系统没有 ffmpeg）', data: null });
    }
    // 录像共用模式：播放列表是按需生成的文本，不落盘
    const base = `${req.protocol}://${req.headers.host}`;
    const text = timeshift.recordPlaylistText(db, id, base);
    if (text !== null) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(text);
    }
    const file = timeshift.playlistPath(id);
    if (!file) {
      // ffmpeg 刚起来还没吐出第一个分片。返回 503 让播放器稍后重试，
      // 比返回一个空列表好 —— 空列表会让 ExoPlayer 直接判定流结束。
      return res.status(503).json({ code: 503, msg: '时移缓冲正在建立，请稍候', data: null });
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });

  // 分片：名字走白名单（seg00001.ts），挡住目录穿越
  router.get('/timeshift/:channelUrlId/:t/:s/:seg', timeshiftAuth, (req, res) => {
    const id = parseInt(req.params.channelUrlId, 10);
    // 分片请求也算「有人在看」；顺带把可能已经退出的会话拉回来
    timeshift.ensureSession(db, id);
    const file = timeshift.segmentPath(id, req.params.seg);
    if (!file) return res.status(404).end();
    res.setHeader('Content-Type', 'video/mp2t');
    // 分片内容不会变，但会被 ffmpeg 删掉，所以缓存时间给短一点
    res.setHeader('Cache-Control', 'public, max-age=60');
    fs.createReadStream(file).pipe(res);
  });

  // 回看：整段录像的 VOD 播放列表（按关键帧切成字节范围小块）。
  // 客户端原来直接播 /stream/record/:id 这个 100~200MB 的整文件：
  //   - 每次 seek 都要从文件开头重读（TS 没有索引），局域网上也是几秒的卡顿；
  //   - 时间轴只能靠播放器二分搜索猜，"拖进度条不流畅"就是这么来的。
  // 换成切片列表后，一次 seek 只取一小块（10 秒 ≈ 6MB），而且总时长是确定的。
  router.get('/record/:id/index.m3u8', streamAuth.middleware('record'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT file FROM recordings WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ code: 404, msg: 'recording not found', data: null });
    }
    const full = path.resolve(config.RECORD_DIR, row.file);
    if (!full.startsWith(path.resolve(config.RECORD_DIR) + path.sep)) {
      return res.status(403).json({ code: 403, msg: 'forbidden', data: null });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ code: 404, msg: 'file missing on disk', data: null });
    }
    const base = `${req.protocol}://${req.headers.host}`;
    const text = recordIndex.vodPlaylist(full, `${base}/stream/record/${id}?${streamAuth.query('record', id)}`);
    if (!text) {
      // 索引拿不到（没 ffprobe / 文件还没有关键帧）：让客户端自己退避重试
      return res.status(503).json({ code: 503, msg: '回看切片索引还没准备好', data: null });
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  });

  router.get('/record/:id', streamAuth.middleware('record'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT file FROM recordings WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ code: 404, msg: 'recording not found', data: null });
    }
    // 防目录穿越：拼回 RECORD_DIR 后必须仍在其内
    const full = path.resolve(config.RECORD_DIR, row.file);
    if (!full.startsWith(path.resolve(config.RECORD_DIR) + path.sep)) {
      return res.status(403).json({ code: 403, msg: 'forbidden', data: null });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ code: 404, msg: 'file missing on disk', data: null });
    }
    const stat = fs.statSync(full);
    const range = req.headers.range;
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(full, { start, end }).pipe(res);
        return;
      }
    }
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(full).pipe(res);
  });

  // 录像流异常兜底
  router.use((err, req, res, next) => {
    logger.error(`[stream] error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ code: 500, msg: err.message, data: null });
    else res.end();
  });

  return router;
};
