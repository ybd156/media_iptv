'use strict';

const express = require('express');
const fs = require('fs');
const { clientMiddleware, generateClientToken } = require('../auth');
const streamAuth = require('../services/streamAuth');
const { splitStreamUrl } = require('../services/streamUrl');
const { resolveUserAgent } = require('../services/ua');
const config = require('../config');
const timeshift = require('../services/timeshift');

/**
 * 客户端 API（安卓 TV）
 * 统一响应 {code, msg, data}：code=0 成功，1001 待审核，401 未授权
 * 除 /register 外均需 header: X-Device-Id + X-Token
 */
module.exports = function clientRoutes(db) {
  const router = express.Router();
  const ok = (res, data) => res.json({ code: 0, msg: 'ok', data });

  /**
   * 拼出下发给客户端的基地址。
   * 原先硬编码 `http://`，反代到 HTTPS 时客户端会拿到 http 地址而连不上；
   * 这里尊重 X-Forwarded-Proto。
   */
  const baseUrlOf = (req) => {
    const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = fwd || req.protocol || 'http';
    return `${proto}://${req.headers.host}`;
  };

  /** 读取 settings 里的单个值（自动 JSON 解析） */
  const getSetting = (k) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    if (!row) return '';
    try { return JSON.parse(row.value); } catch (_) { return row.value; }
  };

  // 设备注册：首次插入 pending；已 approved 返回 token
  router.post('/register', (req, res) => {
    const { deviceId, model, androidVersion } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ code: 400, msg: 'deviceId required', data: null });
    }
    const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (existing) {
      if (existing.status === 'approved') {
        return ok(res, { status: 'approved', token: existing.token });
      }
      return ok(res, { status: existing.status });
    }
    db.prepare(
      "INSERT INTO devices (id, model, android_version, status, last_seen) VALUES (?, ?, ?, 'pending', strftime('%s','now'))"
    ).run(deviceId, model || '', androidVersion || '');
    return ok(res, { status: 'pending' });
  });

  // 台标缓存代理：GET /logo/:channelId（图片由 Glide 直接加载，无法带鉴权头，故放在中间件之前公开）
  require('../services/logo').registerLogoRoute(router, db);

  // 客户端更新：版本查询 + APK 下载。
  // 和台标一样放在鉴权之前：安装环节由系统下载器/安装器发起，带不上设备 token；
  // 而且「设备还没审核通过」时也可能需要升级客户端，锁在鉴权后面反而升不了。
  // APK 本身不是机密（任何能连到这个端口的人本来就能装）。
  const updateSvc = require('../services/update');
  const githubRelease = require('../services/githubRelease');

  router.get('/version', async (req, res) => {
    const currentCode = parseInt(req.query.versionCode, 10);
    const hasCurrent = Number.isFinite(currentCode);

    // 版本信息优先取 GitHub Release（后台配了仓库才走这条渠道，见 services/githubRelease.js）。
    // 没配、读不到、或版本信息不完整，一律回退到服务端本地上传的更新包 —— 行为与以前完全一致，
    // 所以没配 GitHub 的部署不会因为这次改动改变任何表现。
    let latest = null;
    try {
      latest = await githubRelease.latest(db);
    } catch (_) { /* latest() 内部已吞异常，这里再兜一层，绝不让版本查询 500 */ }
    if (!latest) {
      const row = updateSvc.getLatest(db);
      if (row) latest = updateSvc.publicShape(row, req);
    }

    if (!latest) {
      return ok(res, { hasUpdate: false, current: hasCurrent ? currentCode : null, latest: null });
    }
    ok(res, {
      // 客户端没报 versionCode 时不下结论（null），让它自己按 versionName 判断
      hasUpdate: hasCurrent ? latest.versionCode > currentCode : null,
      current: hasCurrent ? currentCode : null,
      latest,
    });
  });

  router.get('/apk', (req, res) => {
    const latest = updateSvc.getLatest(db);
    const file = updateSvc.filePathOf(latest);
    if (!file) {
      return res.status(404).json({ code: 404, msg: '服务器上还没有更新包', data: null });
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', latest.size || fs.statSync(file).size);
    res.setHeader('Content-Disposition', `attachment; filename="mediaiptv_v${latest.version_name}.apk"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });

  // 以下接口需要设备已授权
  router.use(clientMiddleware(db));

  // 心跳：返回状态、服务器时间、播放配置
  router.get('/heartbeat', (req, res) => {
    const device = db.prepare('SELECT status FROM devices WHERE id = ?').get(req.deviceId);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'playerConfig'").get();
    let playerConfig = config.DEFAULT_PLAYER_CONFIG;
    if (row) {
      try { playerConfig = { ...playerConfig, ...JSON.parse(row.value) }; } catch (_) { /* ignore */ }
    }
    // 服务端能力：客户端据此决定「进度条/回看」能不能进。
    // 客户端**不再有自己的时移开关** —— 服务端没开就不给进，
    // 避免出现"客户端开着、服务端关着"导致每个频道都提示"本线路不支持时移"。
    const tsOn = String((db.prepare("SELECT value FROM settings WHERE key='timeshift'").get() || {}).value || '')
      .replace(/^"|"$/g, '') === '1';
    let recOn = false;
    try { recOn = db.prepare('SELECT COUNT(*) c FROM record_tasks').get().c > 0; } catch (_) { /* 表不存在则视为未开 */ }
    ok(res, {
      status: device.status,
      serverTime: Math.floor(Date.now() / 1000),
      config: playerConfig,
      features: {
        timeshift: tsOn,
        timeshiftWindowMin: tsOn ? timeshift.windowMinutes(db) : 0,
        record: recOn,
      },
    });
  });

  // 频道列表（按分组）。播放模式 settings.playMode：
  //   proxy        - 服务器代理转发（默认，隐藏原始源地址）
  //   direct       - 客户端直连原始地址，携带 UA（源里存的或全局配置）
  //   direct_plain - 客户端直连原始地址，不带 UA
  // 单个直播源可在 sources.play_mode 覆盖全局设置（'' = 跟随全局）。
  // 线路顺序：已探测出分辨率的按高度降序（换台即落在最高清线路），未探测的保持原顺序排在后面。
  router.get('/channels', (req, res) => {
    const base = baseUrlOf(req);
    const globalPlayMode = String(getSetting('playMode') || 'proxy');
    const globalUa = String(getSetting('streamUserAgent') || '').trim();
    // 时移开关：开了才给每个线路附带 timeshiftUrl，客户端据此切到滚动 HLS
    const timeshiftOn = String(getSetting('timeshift') || '') === '1';

    const groups = db.prepare('SELECT * FROM groups ORDER BY sort, id').all();
    const channels = db.prepare(
      'SELECT c.*, s.play_mode AS source_play_mode, s.ua AS source_ua FROM channels c LEFT JOIN sources s ON s.id = c.source_id ORDER BY c.sort, c.id'
    ).all();
    const urls = db.prepare(
      'SELECT * FROM channel_urls ORDER BY CASE WHEN height IS NULL THEN 1 ELSE 0 END, height DESC, sort, id'
    ).all();

    // 每个频道的有效播放模式：源级覆盖 > 全局；按源 UA 同样随频道走
    const modeByChannel = new Map();
    const uaByChannel = new Map();
    for (const c of channels) {
      modeByChannel.set(c.id, c.source_play_mode || globalPlayMode);
      uaByChannel.set(c.id, String(c.source_ua || '').trim());
    }

    // 哪些频道配了启用的录制任务（见下面时移地址的判断）
    const recChannelIds = new Set();
    try {
      for (const r of db.prepare('SELECT DISTINCT channel_id FROM record_tasks WHERE enabled = 1').all()) {
        recChannelIds.add(r.channel_id);
      }
    } catch (_) { /* 表不存在则视为都没录像 */ }

    const urlsByChannel = new Map();
    for (const u of urls) {
      if (!urlsByChannel.has(u.channel_id)) urlsByChannel.set(u.channel_id, []);
      const playMode = modeByChannel.get(u.channel_id) || 'proxy';
      const [raw] = u.url.split('|');
      const isMulticast = /^(rtp|udp):\/\//i.test(raw.trim());
      let url;
      let userAgent = '';
      // 组播源客户端无法直连，始终走服务器代理（ffmpeg 转封装）
      if (playMode === 'proxy' || isMulticast) {
        // 扩展名提示：让客户端播放器能正确选择 HLS/TS 解复用器
        const ext = /\.m3u8(\?|$)/i.test(raw) ? '.m3u8' : (/\.flv(\?|$)/i.test(raw) ? '.flv' : '');
        // 流地址带签名（播放器无法带 header，故签名走查询参数）
        url = `${base}/stream/live/${u.id}${ext}?${streamAuth.query('live', u.id)}`;
      } else {
        url = raw.trim();
        if (playMode === 'direct') {
          // 与「服务端代理 / 画质探测 / 定时录像」共用同一份 UA 决策规则
          userAgent = resolveUserAgent({
            rawUrl: u.url,
            sourceUa: uaByChannel.get(u.channel_id),
            globalUa,
          }).ua;
        }
      }
      // 时移地址：签名放路径里（分片是相对路径，查询串传不下去）。
      // 组播源同样提供时移 —— 原先这里把组播排除掉，结果是"时移开关一开，
      // 一部分频道能拖、一部分不能"，用户看到的就是"有些并没有"。
      // 组播本来就要经 ffmpeg 转封装，改成输出 HLS 只是换了个输出格式，代价相同。
      let timeshiftUrl = '';
      // 只对**有录像**的频道下发时移地址：没录像时服务端只能退回滚动 HLS，
      // 那种"只能退几分钟"的时移是用户明确不要的。
      if (timeshiftOn && recChannelIds.has(u.channel_id)) {
        const sig = streamAuth.signature('live', u.id);
        timeshiftUrl = `${base}/stream/timeshift/${u.id}/${sig.t}/${sig.s}/index.m3u8`;
      }
      urlsByChannel.get(u.channel_id).push({
        id: u.id,
        url,
        height: u.height || 0,
        userAgent,
        timeshiftUrl,
      });
    }
    const itemOf = (c) => ({
      id: c.id,
      name: c.name,
      // 这个频道当前有没有在录像：客户端只对它为 true 的频道显示进度条
      hasRecording: recChannelIds.has(c.id),
      // 台标统一走服务端缓存代理，客户端不直接访问外部 URL
      logo: c.logo ? `${base}/api/client/logo/${c.id}` : '',
      epgId: c.epg_id || '',
      urls: urlsByChannel.get(c.id) || [],
    });

    const channelsByGroup = new Map();
    for (const c of channels) {
      if (!channelsByGroup.has(c.group_id)) channelsByGroup.set(c.group_id, []);
      channelsByGroup.get(c.group_id).push(itemOf(c));
    }
    const data = groups.map((g) => ({
      id: g.id,
      name: g.name,
      channels: channelsByGroup.get(g.id) || [],
    }));

    // 未归组（group_id 为空）或分组已被删（group_id 悬空）的频道**不能丢**。
    // 原实现只按 groups 做映射，这些频道在客户端会彻底消失 ——
    // 而后台「删除分组」的提示写的恰恰是"组内频道会保留但变为未分组"，
    // 也就是删完分组之后，那些频道用户既看不到也看不了。
    const knownGroupIds = new Set(groups.map((g) => g.id));
    const orphans = channels.filter((c) => !knownGroupIds.has(c.group_id)).map(itemOf);
    if (orphans.length > 0) {
      // id=0 是"未分组"的哨兵值：真实分组 id 从 1 开始，不会撞
      data.push({ id: 0, name: '未分组', channels: orphans });
    }
    ok(res, { groups: data });
  });

  // 全部频道"正在播出/即将播出"：频道列表每行显示当前节目用
  router.get('/epg/now', (req, res) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const nowRows = db.prepare(
      `SELECT c.id AS channelId, p.title, p.start, p.end FROM channels c
       JOIN epg_programs p ON p.epg_id = c.epg_id AND p.date = ? AND p.start <= ? AND p.end > ?
       WHERE c.epg_id IS NOT NULL AND c.epg_id != ''`
    ).all(date, time, time);
    const nextRows = db.prepare(
      `SELECT c.id AS channelId, p.title, p.start, p.end FROM channels c
       JOIN epg_programs p ON p.epg_id = c.epg_id AND p.date = ? AND p.start >= ?
       WHERE c.epg_id IS NOT NULL AND c.epg_id != ''
       GROUP BY c.id HAVING p.start = MIN(p.start)`
    ).all(date, time);

    const nowMap = {};
    for (const r of nowRows) nowMap[r.channelId] = { title: r.title, start: r.start, end: r.end };
    const nextMap = {};
    for (const r of nextRows) nextMap[r.channelId] = { title: r.title, start: r.start, end: r.end };
    ok(res, { now: nowMap, next: nextMap });
  });

  // EPG 查询：按频道的 epg_id 查节目单，附带该时段是否有录像
  router.get('/epg', (req, res) => {
    const channelId = parseInt(req.query.channelId, 10);
    const date = req.query.date || '';
    if (!channelId || !date) {
      return res.status(400).json({ code: 400, msg: 'channelId and date required', data: null });
    }
    const channel = db.prepare('SELECT epg_id FROM channels WHERE id = ?').get(channelId);
    if (!channel) {
      return res.status(404).json({ code: 404, msg: 'channel not found', data: null });
    }
    const programs = db.prepare(
      'SELECT start, end, title FROM epg_programs WHERE epg_id = ? AND date = ? ORDER BY start'
    ).all(channel.epg_id || '', date);

    const recordings = db.prepare(
      'SELECT start, end FROM recordings WHERE channel_id = ? AND date = ?'
    ).all(channelId, date);

    const list = programs.map((p) => ({
      ...p,
      hasRecord: recordings.some((r) => r.start < p.end && r.end > p.start),
    }));
    ok(res, { date, programs: list });
  });

  // 可回看日期列表
  router.get('/catchup/days', (req, res) => {
    const channelId = parseInt(req.query.channelId, 10);
    if (!channelId) {
      return res.status(400).json({ code: 400, msg: 'channelId required', data: null });
    }
    const rows = db.prepare(
      "SELECT DISTINCT date FROM recordings WHERE channel_id = ? AND status = 'ok' ORDER BY date DESC"
    ).all(channelId);
    ok(res, { days: rows.map((r) => r.date) });
  });

  // 某日回看分段列表
  router.get('/catchup/list', (req, res) => {
    const channelId = parseInt(req.query.channelId, 10);
    const date = req.query.date || '';
    if (!channelId || !date) {
      return res.status(400).json({ code: 400, msg: 'channelId and date required', data: null });
    }
    const base = baseUrlOf(req);
    const rows = db.prepare(
      "SELECT id, start, end FROM recordings WHERE channel_id = ? AND date = ? AND status = 'ok' ORDER BY start"
    ).all(channelId, date);
    ok(res, {
      segments: rows.map((r) => ({
        id: r.id,
        start: r.start,
        end: r.end,
        // 下发**按关键帧切片的 VOD 播放列表**，而不是整段 100~200MB 的 TS：
        // 后者每次 seek 都要从文件开头重读（TS 没有索引），局域网上也要几秒 ——
        // 「回看拉流卡、拖进度条不流畅」的根因就在这个粒度上。
        url: `${base}/stream/record/${r.id}/index.m3u8?${streamAuth.query('record', r.id)}`,
      })),
    });
  });

  // 客户端上报实际播放分辨率：比 ffprobe 更快收集画质数据，覆盖真实可用线路
  router.post('/report-resolution', (req, res) => {
    const { urlId, width, height } = req.body || {};
    if (!urlId || !width || !height) return res.status(400).json({ code: 400, msg: 'urlId/width/height required', data: null });
    try {
      db.prepare('UPDATE channel_urls SET width = ?, height = ?, probe_at = ? WHERE id = ?')
        .run(width, height, Math.floor(Date.now() / 1000), urlId);
    } catch (_) { /* 忽略写入失败 */ }
    ok(res, null);
  });

  return router;
};
