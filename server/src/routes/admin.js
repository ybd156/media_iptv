'use strict';

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const {
  hashPassword, verifyPassword, generateSalt, createAdminSession, adminMiddleware,
  generateClientToken, dropAdminSessions, ALGO_SCRYPT, ALGO_LEGACY,
} = require('../auth');
const { parseM3U, txtToM3u, isTxtFormat, decodeBuffer } = require('../services/m3u');
const m3uSvc = require('../services/m3u');
const { fetchEpg, parseXmltv } = require('../services/epg');
const probe = require('../services/probe');
const recorder = require('../services/recorder');
const streamAuth = require('../services/streamAuth');
const logger = require('../logger');
const config = require('../config');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * 管理后台 API (/admin/api)
 * POST /login 公开；其余需要 Authorization: Bearer <token>
 */
module.exports = function adminRoutes(db) {
  const router = express.Router();
  const ok = (res, data) => res.json({ code: 0, msg: 'ok', data });

  // ---------- 登录 ----------
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ code: 400, msg: 'username and password required', data: null });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    const algo = (admin && admin.algo) || ALGO_LEGACY;
    if (!admin || !verifyPassword(password, admin.salt, admin.password_hash, algo)) {
      return res.status(401).json({ code: 401, msg: 'invalid credentials', data: null });
    }
    // 老库里的 sha256 哈希：登录成功后就地升级为 scrypt，用户无感
    if (algo !== ALGO_SCRYPT) {
      const salt = generateSalt();
      db.prepare("UPDATE admins SET password_hash = ?, salt = ?, algo = 'scrypt' WHERE id = ?")
        .run(hashPassword(password, salt), salt, admin.id);
      logger.info(`[auth] 管理员 ${username} 的密码哈希已升级为 scrypt`);
    }
    ok(res, { token: createAdminSession(username) });
  });

  // 修改密码
  router.post('/password', adminMiddleware, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ code: 400, msg: 'oldPassword and newPassword required', data: null });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ code: 400, msg: '新密码至少 6 位', data: null });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(req.adminUser);
    if (!admin || !verifyPassword(oldPassword, admin.salt, admin.password_hash, admin.algo || ALGO_LEGACY)) {
      return res.status(401).json({ code: 401, msg: 'old password incorrect', data: null });
    }
    // 换 salt 而不是复用旧 salt；改完让其它会话立即失效
    const salt = generateSalt();
    db.prepare("UPDATE admins SET password_hash = ?, salt = ?, algo = 'scrypt' WHERE id = ?")
      .run(hashPassword(newPassword, salt), salt, admin.id);
    // 标记「用户已自行改过密码」，此后 ADMIN_PASSWORD 环境变量不再覆盖它
    db.prepare("INSERT INTO settings (key, value) VALUES ('adminPwdChanged', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    dropAdminSessions(admin.username);
    logger.info(`[auth] 管理员 ${admin.username} 已修改密码`);
    ok(res, null);
  });

  // 以下接口全部需要登录
  router.use(adminMiddleware);

  // ---------- 统计 ----------
  // 录像占用空间：递归遍历目录 + 逐文件 statSync，1 万个分片就是 1 万次系统调用，
  // 而概览页每次切进来都会请求。缓存 30 秒，代价是数字最多滞后半分钟。
  let recordBytesCache = { at: 0, value: 0 };
  const RECORD_BYTES_TTL_MS = 30 * 1000;
  const computeRecordBytes = () => {
    const now = Date.now();
    if (now - recordBytesCache.at < RECORD_BYTES_TTL_MS) return recordBytesCache.value;
    let total = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        try { total += fs.statSync(p).size; } catch (_) { /* 文件可能刚被清理 */ }
      }
    };
    walk(config.RECORD_DIR);
    recordBytesCache = { at: now, value: total };
    return total;
  };

  router.get('/stats', (req, res) => {
    const channelCount = db.prepare('SELECT COUNT(*) AS c FROM channels').get().c;
    const deviceCount = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
    const onlineCount = db.prepare("SELECT COUNT(*) AS c FROM devices WHERE status = 'approved' AND last_seen > strftime('%s','now') - 120").get().c;
    const pendingDevices = db.prepare("SELECT COUNT(*) AS c FROM devices WHERE status = 'pending'").get().c;

    ok(res, { channelCount, deviceCount, onlineCount, pendingDevices, recordBytes: computeRecordBytes() });
  });

  // ---------- 分组 CRUD ----------
  router.get('/groups', (req, res) => {
    ok(res, db.prepare('SELECT * FROM groups ORDER BY sort, id').all());
  });
  router.post('/groups', (req, res) => {
    const { name, sort = 0 } = req.body || {};
    if (!name) return res.status(400).json({ code: 400, msg: 'name required', data: null });
    const r = db.prepare('INSERT INTO groups (name, sort) VALUES (?, ?)').run(name, sort);
    ok(res, { id: Number(r.lastInsertRowid) });
  });
  router.put('/groups/:id', (req, res) => {
    const { name, sort } = req.body || {};
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g) return res.status(404).json({ code: 404, msg: 'group not found', data: null });
    db.prepare('UPDATE groups SET name = ?, sort = ? WHERE id = ?')
      .run(name !== undefined ? name : g.name, sort !== undefined ? sort : g.sort, g.id);
    ok(res, null);
  });
  router.delete('/groups/:id', (req, res) => {
    db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
    ok(res, null);
  });

  // ---------- 频道 CRUD（含 channel_urls） ----------
  router.get('/channels', (req, res) => {
    const channels = db.prepare(
      'SELECT c.*, s.name AS source_name FROM channels c LEFT JOIN sources s ON s.id = c.source_id ORDER BY c.sort, c.id'
    ).all();
    const urls = db.prepare('SELECT * FROM channel_urls ORDER BY sort, id').all();
    const byChannel = new Map();
    for (const u of urls) {
      if (!byChannel.has(u.channel_id)) byChannel.set(u.channel_id, []);
      byChannel.get(u.channel_id).push({ id: u.id, url: u.url, sort: u.sort });
    }
    ok(res, channels.map((c) => ({ ...c, urls: byChannel.get(c.id) || [] })));
  });

  const saveChannel = (body, channelId) => {
    const { name, groupId = null, logo = '', epgId = '', sort = 0, urls = [] } = body;
    const tx = db.transaction(() => {
      let id = channelId;
      if (id) {
        db.prepare('UPDATE channels SET name = ?, group_id = ?, logo = ?, epg_id = ?, sort = ? WHERE id = ?')
          .run(name, groupId, logo, epgId, sort, id);
        db.prepare('DELETE FROM channel_urls WHERE channel_id = ?').run(id);
      } else {
        const r = db.prepare('INSERT INTO channels (name, group_id, logo, epg_id, sort) VALUES (?, ?, ?, ?, ?)')
          .run(name, groupId, logo, epgId, sort);
        id = Number(r.lastInsertRowid);
      }
      const ins = db.prepare('INSERT INTO channel_urls (channel_id, url, sort) VALUES (?, ?, ?)');
      urls.forEach((u, i) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url) ins.run(id, url, typeof u === 'object' && u.sort !== undefined ? u.sort : i);
      });
      return id;
    });
    return tx();
  };

  router.post('/channels', (req, res) => {
    if (!req.body || !req.body.name) return res.status(400).json({ code: 400, msg: 'name required', data: null });
    const id = saveChannel(req.body, null);
    ok(res, { id });
  });
  router.put('/channels/:id', (req, res) => {
    const c = db.prepare('SELECT id FROM channels WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ code: 404, msg: 'channel not found', data: null });
    saveChannel(req.body || {}, c.id);
    ok(res, null);
  });
  router.delete('/channels/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    // ?withRecordings=1：连这个频道的录像一起删（文件 + 记录）。
    // 不加这个参数就只删频道，录像留着（下次还会以"孤儿录像"被清理）。
    const withRec = String((req.query && req.query.withRecordings) || '') === '1';
    let removed = 0;
    if (withRec) removed = deleteRecordingsOfChannel(id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    ok(res, { removedRecordings: removed });
  });

  // 按源批量删除频道（保留源记录本身；在源管理页可连源一起删）
  router.post('/channels/batch-delete', (req, res) => {
    const sourceId = parseInt((req.body && req.body.sourceId) || 0, 10);
    if (!sourceId) return res.status(400).json({ code: 400, msg: 'sourceId required', data: null });
    const tx = db.transaction(() => {
      const ids = db.prepare('SELECT id FROM channels WHERE source_id = ?').all(sourceId).map((r) => r.id);
      for (const cid of ids) {
        db.prepare('DELETE FROM channel_urls WHERE channel_id = ?').run(cid);
        db.prepare('DELETE FROM channels WHERE id = ?').run(cid);
      }
      return ids.length;
    });
    const removed = tx();
    logger.info(`[admin] batch-delete source #${sourceId}: removed ${removed} channels`);
    ok(res, { removedChannels: removed });
  });

  // 单个频道在线检测（HEAD 原始 URL，返回耗时与状态）
  router.get('/channels/:id/check', async (req, res) => {
    const u = db.prepare('SELECT url FROM channel_urls WHERE channel_id = ? ORDER BY sort, id LIMIT 1').get(req.params.id);
    if (!u) return res.status(404).json({ code: 404, msg: 'no url', data: null });
    const [url] = u.url.split('|');
    const started = Date.now();
    try {
      const resp = await axios.head(url, { timeout: 8000, maxRedirects: 3, validateStatus: () => true });
      ok(res, { online: resp.status < 400, status: resp.status, elapsedMs: Date.now() - started });
    } catch (e) {
      // 有些源不支持 HEAD，降级 GET 试一次
      try {
        const resp = await axios.get(url, { timeout: 8000, maxRedirects: 3, validateStatus: () => true, responseType: 'stream' });
        resp.data.destroy();
        ok(res, { online: resp.status < 400, status: resp.status, elapsedMs: Date.now() - started });
      } catch (e2) {
        ok(res, { online: false, status: 0, elapsedMs: Date.now() - started, error: e2.message });
      }
    }
  });

  // ---------- M3U / TXT 订阅导入 ----------

  /** 去掉返回给管理端的内部字段（channelIds 只在服务端做差异删除时用） */
  const publicStats = ({ channelIds, ...rest }) => rest;

  /**
   * 把已解析的频道列表写入数据库。
   *
   * 关键设计：**已存在的频道做 upsert，绝不「先删光再重建」**。
   * 早期实现是「删除该源全部频道 → 重新导入」，而 record_tasks.channel_id 带
   * ON DELETE CASCADE，于是每次订阅刷新（默认每 12 小时自动一次）都会静默清空
   * 用户配好的录制任务；同时新频道拿到新 id，历史 recordings.channel_id 全部失联，
   * 回看列表直接变空。改成 upsert 后频道 id 保持稳定，录制任务与录像历史都不受影响。
   *
   * @param {Array} flat parseM3U 的 flat 结果
   * @param {number|null} sourceId 归属的直播源
   * @param {{replaceUrls?: boolean}} opts
   *        replaceUrls=true  —— 订阅刷新语义：替换已存在频道的线路
   *        replaceUrls=false —— 手动导入语义：保留原有线路并补齐缺失的（多源合并）
   * @returns {{importedChannels:number, importedUrls:number, skipped:number, groups:number, channelIds:Set<number>}}
   */
  const importParsed = (flat, sourceId = null, { replaceUrls = false } = {}) => {
    if (flat.length === 0) {
      throw new Error('未能解析出任何频道（支持 M3U 或 "频道名,URL" TXT 格式）');
    }
    const tx = db.transaction(() => {
      const findGroup = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insGroup = db.prepare('INSERT INTO groups (name, sort) VALUES (?, ?)');
      // 按「分组 + 频道名」全局匹配。刻意不加 source_id 约束：手动导入会把已存在的
      // 频道归属到新源，若刷新时只匹配「本源或无所属」的频道，就会为同一个频道再建一行，
      // 造成重复频道。全局匹配保证 upsert 永不产生重复行。
      const findChannel = db.prepare('SELECT id, logo, epg_id FROM channels WHERE name = ? AND group_id = ?');
      const insChannel = db.prepare('INSERT INTO channels (name, group_id, logo, epg_id, sort, source_id) VALUES (?, ?, ?, ?, ?, ?)');
      const updChannel = db.prepare('UPDATE channels SET logo = ?, epg_id = ?, source_id = ? WHERE id = ?');
      const delUrls = db.prepare('DELETE FROM channel_urls WHERE channel_id = ?');
      const findUrls = db.prepare('SELECT url FROM channel_urls WHERE channel_id = ?');
      const insUrl = db.prepare('INSERT INTO channel_urls (channel_id, url, sort) VALUES (?, ?, ?)');

      // 新分组/新频道的 sort 从现有最大值之后续排，避免与既有数据交错
      let groupSort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM groups').get().n || 0;
      let channelSort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM channels').get().n || 0;

      // 频道 → 已存在的 URL 集合。手动导入是「合并」语义（保留原有线路并补齐），
      // 原先不查重导致同一份列表重复导入时线路无限累积（旧库里已能看到重复行），
      // 这里按 url 查重，使重复导入变成幂等操作。
      const urlCache = new Map();

      let importedChannels = 0;
      let importedUrls = 0;
      let skipped = 0;
      const groupIds = new Map();
      const channelIds = new Set();
      for (const ch of flat) {
        let gid = groupIds.get(ch.group);
        if (!gid) {
          const g = findGroup.get(ch.group);
          if (g) {
            gid = g.id;
          } else {
            gid = Number(insGroup.run(ch.group, groupSort++).lastInsertRowid);
          }
          groupIds.set(ch.group, gid);
        }
        const exist = findChannel.get(ch.name, gid);
        let cid;
        if (exist) {
          cid = exist.id;
          updChannel.run(
            ch.logo || exist.logo || '',
            ch.epgId || exist.epg_id || '',
            sourceId,
            cid,
          );
          skipped++;
        } else {
          cid = Number(insChannel.run(ch.name, gid, ch.logo, ch.epgId, channelSort++, sourceId).lastInsertRowid);
          importedChannels++;
        }
        channelIds.add(cid);

        // 刷新订阅：整组替换线路；手动导入：保留原有线路，只补齐缺失的
        let urls = urlCache.get(cid);
        if (replaceUrls) {
          delUrls.run(cid);
          urls = new Set();
        } else if (!urls) {
          urls = new Set(findUrls.all(cid).map((r) => r.url));
        }
        urlCache.set(cid, urls);

        let sort = urls.size;
        for (const url of ch.urls) {
          const u = String(url || '').trim();
          if (!u || urls.has(u)) continue;
          urls.add(u);
          insUrl.run(cid, u, sort++);
          importedUrls++;
        }
      }
      return { importedChannels, importedUrls, skipped, groups: groupIds.size, channelIds };
    });
    return tx();
  };

  /** 订阅源导入时是否合并同名/同 epgId 的频道（后台开关，默认开） */
  const mergeOnImport = () => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'mergeChannels'").get();
      const v = String((row || {}).value || '').replace(/^"|"$/g, '').trim();
      return v !== '0'; // 没设置过 = 开
    } catch (_) { return true; }
  };

  const importM3U = (text, sourceId = null, opts = {}) => {
    if (isTxtFormat(text)) {
      text = txtToM3u(text);
    }
    const { flat } = parseM3U(text, { merge: mergeOnImport() });
    return importParsed(flat, sourceId, opts);
  };

  // 创建直播源记录
  const createSource = (name, url = '', playMode = '', autoUpdate = 0) => {
    const r = db.prepare('INSERT INTO sources (name, url, play_mode, auto_update) VALUES (?, ?, ?, ?)')
      .run(name, url, playMode, autoUpdate ? 1 : 0);
    return Number(r.lastInsertRowid);
  };

  // 拉取订阅 URL 文本（带 GBK 回退解码）
  const fetchSourceText = async (url) => {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'MediaIptv-Server/1.0' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = decodeBuffer(buf);
    if (!text.includes('#EXTINF') && !isTxtFormat(text)) {
      throw new Error('内容不是可识别的直播源列表（支持 M3U / TXT 格式）');
    }
    return text;
  };

  /**
   * 刷新订阅源：对已存在的频道做 upsert（保持频道 id 稳定），
   * 只删除「刷新前属于该源、刷新后已从订阅里消失」的频道。
   *
   * 这些消失频道的录制任务会随外键级联删除——频道已不在订阅里，无法再录制，
   * 属预期行为；数量会写进日志与返回值，便于排查。
   */
  const refreshSource = async (source) => {
    if (!source.url) throw new Error('该源没有订阅地址，无法刷新');
    const text = await fetchSourceText(source.url);

    // 刷新前该源拥有的频道，用于计算差异
    const before = new Set(
      db.prepare('SELECT id FROM channels WHERE source_id = ?').all(source.id).map((r) => r.id),
    );

    const stats = importM3U(text, source.id, { replaceUrls: true });

    const vanished = [...before].filter((id) => !stats.channelIds.has(id));
    let removedChannels = 0;
    let removedTasks = 0;
    if (vanished.length > 0) {
      const delTx = db.transaction(() => {
        const countTasks = db.prepare('SELECT COUNT(*) AS c FROM record_tasks WHERE channel_id = ?');
        const delUrls = db.prepare('DELETE FROM channel_urls WHERE channel_id = ?');
        const delChannel = db.prepare('DELETE FROM channels WHERE id = ?');
        for (const cid of vanished) {
          removedTasks += countTasks.get(cid).c;
          delUrls.run(cid);      // 外键已设 ON DELETE CASCADE，这里显式清理以防 PRAGMA 被关掉
          delChannel.run(cid);
          removedChannels++;
        }
      });
      delTx();
    }

    db.prepare("UPDATE sources SET updated_at = strftime('%s','now') WHERE id = ?").run(source.id);
    logger.info(
      `[sources] refresh #${source.id} ${source.name}: 新增 ${stats.importedChannels} / 更新 ${stats.skipped} / ` +
      `线路 ${stats.importedUrls} / 消失频道 ${removedChannels}（连带录制任务 ${removedTasks}）`,
    );
    return { ...stats, removedChannels, removedTasks };
  };

  router.post('/channels/import', upload.single('file'), (req, res) => {
    let text = null;
    if (req.file) text = decodeBuffer(req.file.buffer);
    else if (req.body && req.body.text) text = req.body.text;
    if (!text) return res.status(400).json({ code: 400, msg: 'no m3u content', data: null });
    try {
      // 本地导入也登记为一个源（无 URL，不能自动更新），便于按源管理与按源代理
      const srcName = (req.file && req.file.originalname)
        || (req.body && req.body.sourceName)
        || `手动导入 ${new Date().toLocaleString('zh-CN')}`;
      const sourceId = createSource(srcName, '');
      const stats = importM3U(text, sourceId);
      logger.info(`[admin] M3U imported (source #${sourceId} ${srcName}): ${JSON.stringify(publicStats(stats))}`);
      // 导入后后台探测新线路画质，完成后 /channels 自动按清晰度排序
      probe.startProbe(db);
      ok(res, { ...publicStats(stats), sourceId });
    } catch (e) {
      logger.error(`[admin] M3U import failed: ${e.message}`);
      res.status(400).json({ code: 400, msg: `import failed: ${e.message}`, data: null });
    }
  });

  // 从远程 URL 导入 M3U（订阅链接）。相同 URL 已有源时执行刷新（替换该源频道）
  router.post('/channels/import-url', async (req, res) => {
    const url = (req.body && req.body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ code: 400, msg: 'invalid url (must start with http/https)', data: null });
    }
    try {
      let source = db.prepare('SELECT * FROM sources WHERE url = ?').get(url);
      if (source) {
        const stats = await refreshSource(source);
        probe.startProbe(db);
        return ok(res, { ...publicStats(stats), sourceId: source.id, refreshed: true });
      }
      let name = (req.body && req.body.name || '').trim();
      if (!name) { try { name = new URL(url).hostname; } catch { name = '订阅源'; } }
      const sourceId = createSource(name, url);
      const text = await fetchSourceText(url);
      const stats = importM3U(text, sourceId);
      db.prepare("UPDATE sources SET updated_at = strftime('%s','now') WHERE id = ?").run(sourceId);
      logger.info(`[admin] M3U imported from URL ${url} (source #${sourceId}): ${JSON.stringify(publicStats(stats))}`);
      probe.startProbe(db);
      ok(res, { ...publicStats(stats), sourceId });
    } catch (e) {
      logger.error(`[admin] M3U URL import failed (${url}): ${e.message}`);
      res.status(400).json({ code: 400, msg: `import failed: ${e.message}`, data: null });
    }
  });

  // ---------- 直播源管理 ----------
  router.get('/sources', (req, res) => {
    const list = db.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM channels c WHERE c.source_id = s.id) AS channel_count
       FROM sources s ORDER BY s.id`
    ).all();
    ok(res, list);
  });

  router.post('/sources', async (req, res) => {
    const { name = '', url = '', playMode = '', autoUpdate = false, ua = '' } = req.body || {};
    if (!name.trim()) return res.status(400).json({ code: 400, msg: 'name required', data: null });
    if (url && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ code: 400, msg: 'invalid url', data: null });
    }
    const sourceId = createSource(name.trim(), url.trim(), playMode, autoUpdate);
    if (ua) db.prepare('UPDATE sources SET ua = ? WHERE id = ?').run(String(ua).trim(), sourceId);
    if (url) {
      try {
        const text = await fetchSourceText(url.trim());
        const stats = importM3U(text, sourceId);
        db.prepare("UPDATE sources SET updated_at = strftime('%s','now') WHERE id = ?").run(sourceId);
        probe.startProbe(db);
        return ok(res, { id: sourceId, ...publicStats(stats) });
      } catch (e) {
        return res.status(400).json({ code: 400, msg: `源已创建但首次拉取失败: ${e.message}`, data: { id: sourceId } });
      }
    }
    ok(res, { id: sourceId });
  });

  router.put('/sources/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ code: 404, msg: 'source not found', data: null });
    const b = req.body || {};
    db.prepare('UPDATE sources SET name = ?, play_mode = ?, auto_update = ?, ua = ? WHERE id = ?').run(
      b.name !== undefined ? String(b.name).trim() : s.name,
      b.playMode !== undefined ? b.playMode : s.play_mode,
      b.autoUpdate !== undefined ? (b.autoUpdate ? 1 : 0) : s.auto_update,
      b.ua !== undefined ? String(b.ua).trim() : (s.ua || ''),
      s.id,
    );
    ok(res, null);
  });

  router.delete('/sources/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const tx = db.transaction(() => {
      const ids = db.prepare('SELECT id FROM channels WHERE source_id = ?').all(id).map((r) => r.id);
      for (const cid of ids) {
        db.prepare('DELETE FROM channel_urls WHERE channel_id = ?').run(cid);
        db.prepare('DELETE FROM channels WHERE id = ?').run(cid);
      }
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      return ids.length;
    });
    const removed = tx();
    ok(res, { removedChannels: removed });
  });

  router.post('/sources/:id/refresh', async (req, res) => {
    const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ code: 404, msg: 'source not found', data: null });
    try {
      const stats = await refreshSource(s);
      probe.startProbe(db);
      ok(res, publicStats(stats));
    } catch (e) {
      res.status(400).json({ code: 400, msg: `refresh failed: ${e.message}`, data: null });
    }
  });

  // 订阅源自动更新：每小时检查一次，超过 update_interval（默认 12h）未更新的自动刷新
  cron.schedule('23 * * * *', async () => {
    const due = db.prepare(
      `SELECT * FROM sources WHERE auto_update = 1 AND url != ''
       AND (updated_at IS NULL OR updated_at < strftime('%s','now') - COALESCE(update_interval, 12) * 3600)`
    ).all();
    for (const s of due) {
      try {
        logger.info(`[sources] auto refresh #${s.id} ${s.name}`);
        await refreshSource(s);
      } catch (e) {
        logger.error(`[sources] auto refresh #${s.id} failed: ${e.message}`);
      }
    }
    if (due.length > 0) probe.startProbe(db);
  });

  // ---------- EPG 源与同步 ----------
  router.get('/epg/sources', (req, res) => {
    ok(res, db.prepare('SELECT * FROM epg_sources ORDER BY id').all());
  });
  router.post('/epg/sources', (req, res) => {
    const { name = '', url } = req.body || {};
    if (!url) return res.status(400).json({ code: 400, msg: 'url required', data: null });
    const r = db.prepare('INSERT INTO epg_sources (name, url) VALUES (?, ?)').run(name, url);
    ok(res, { id: Number(r.lastInsertRowid) });
  });
  router.delete('/epg/sources/:id', (req, res) => {
    db.prepare('DELETE FROM epg_sources WHERE id = ?').run(req.params.id);
    ok(res, null);
  });

  const syncEpg = async () => {
    const { matchChannelsToEpg } = require('../services/logo');
    const sources = db.prepare('SELECT * FROM epg_sources').all();
    // upsert 而非 INSERT OR REPLACE：后者命中唯一约束时是「删旧行 + 插新行」，
    // 会让 rowid 持续膨胀并产生双倍写放大。
    const ins = db.prepare(
      `INSERT INTO epg_programs (epg_id, date, start, end, title) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(epg_id, date, start) DO UPDATE SET end = excluded.end, title = excluded.title`
    );
    let total = 0;
    for (const s of sources) {
      try {
        const buf = await fetchEpg(s.url);
        // 解析在 worker 线程完成，节目按批回传；主线程只做批量入库，
        // 单批 5000 条一次事务，避免长时间占用事件循环。
        const { channelMap, programmes } = await parseXmltv(buf, (batch) => {
          const tx = db.transaction(() => {
            for (const p of batch) ins.run(p.epgId, p.date, p.start, p.end, p.title);
          });
          tx();
        });
        db.prepare("UPDATE epg_sources SET updated_at = strftime('%s','now') WHERE id = ?").run(s.id);
        total += programmes;
        logger.info(`[epg] source ${s.url} synced: ${programmes} programmes`);
        // 同步后按频道名匹配，补全 epg_id 与台标
        matchChannelsToEpg(db, channelMap);
      } catch (e) {
        logger.error(`[epg] source ${s.url} sync failed: ${e.message}`);
      }
    }
    // 清理历史节目：/epg 与 /epg/now 只查当天，旧数据纯占盘且会让表无限增长
    try {
      const removed = db.prepare("DELETE FROM epg_programs WHERE date < date('now','-2 day')").run().changes;
      if (removed > 0) logger.info(`[epg] 清理过期节目 ${removed} 条（保留最近 2 天）`);
    } catch (e) {
      logger.warn(`[epg] 清理过期节目失败：${e.message}`);
    }
    return total;
  };

  router.post('/epg/sync', async (req, res) => {
    const total = await syncEpg();
    ok(res, { programmes: total });
  });

  router.post('/epg/auto', (req, res) => {
    const { enabled } = req.body || {};
    db.prepare("INSERT INTO settings (key, value) VALUES ('epgAutoSync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(enabled ? '1' : '0');
    ok(res, { enabled: !!enabled });
  });

  // 节目预览（管理端）：与客户端 /epg 逻辑一致，含可回看标记
  router.get('/epg/preview', (req, res) => {
    const channelId = parseInt(req.query.channelId, 10);
    const date = req.query.date || '';
    if (!channelId || !date) {
      return res.status(400).json({ code: 400, msg: 'channelId and date required', data: null });
    }
    const channel = db.prepare('SELECT epg_id FROM channels WHERE id = ?').get(channelId);
    if (!channel) return res.status(404).json({ code: 404, msg: 'channel not found', data: null });
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
    ok(res, { date, epgId: channel.epg_id || '', programs: list });
  });

  // EPG 自动同步任务（每天 06:00，开关在 settings.epgAutoSync）
  cron.schedule('0 6 * * *', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'epgAutoSync'").get();
    if (row && row.value === '1') {
      logger.info('[epg] auto sync triggered');
      syncEpg().catch((e) => logger.error(`[epg] auto sync error: ${e.message}`));
    }
  });

  // ---------- 系统诊断 ----------
  /**
   * 把「现在到底是什么状态」一次说清楚。
   *
   * 为什么值得单独做一页：这个项目里反复出现过「界面说有、其实没生效」的问题 ——
   * 后台播放配置整块无效、录像不读源 UA、未分组频道从列表里消失、
   * rtsp 源录像因 ffmpeg 选项直接退出……每次排查都得翻代码。
   * 这里把关键事实集中暴露出来，让「有没有在跑」一眼可见。
   */
  const diagnostics = (req, res) => {
    const timeshiftSvc = require('../services/timeshift');
    const logoSvc = require('../services/logo');
    const updateSvc = require('../services/update');

    const setting = (k) => {
      try {
        const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
        return r && r.value != null ? String(r.value).replace(/^"|"$/g, '') : '';
      } catch (_) { return ''; }
    };
    const count = (sql) => {
      try { const r = db.prepare(sql).get(); return r ? Number(Object.values(r)[0] || 0) : 0; } catch (_) { return 0; }
    };
    const scalar = (sql, col) => {
      try { const r = db.prepare(sql).get(); return r ? r[col] : null; } catch (_) { return null; }
    };

    let dbSizeBytes = 0;
    try { dbSizeBytes = fs.statSync(config.DB_FILE).size; } catch (_) { /* 还没有库文件 */ }

    let logoCached = 0;
    try { logoCached = fs.readdirSync(logoSvc.LOGO_DIR).length; } catch (_) { /* 目录还没建 */ }

    let appUpdates = 0;
    try { appUpdates = updateSvc.listUpdates().length; } catch (_) { /* 忽略 */ }

    const probeStat = (() => {
      try {
        return db.prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN height IS NOT NULL THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN probe_at IS NOT NULL AND height IS NULL THEN 1 ELSE 0 END) AS failed,
                  MAX(probe_at) AS last_at
           FROM channel_urls`
        ).get() || {};
      } catch (_) { return {}; }
    })();

    const ffmpeg = recorder.detectFfmpeg() || '';

    ok(res, {
      server: {
        version: (() => { try { return require('../../package.json').version || ''; } catch (_) { return ''; } })(),
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        dataDir: config.DATA_DIR,
        dbSizeBytes,
      },
      tools: { ffmpeg },
      sources: {
        total: count('SELECT COUNT(*) AS n FROM sources'),
        autoUpdate: count('SELECT COUNT(*) AS n FROM sources WHERE auto_update = 1'),
        withOwnUa: count("SELECT COUNT(*) AS n FROM sources WHERE ua IS NOT NULL AND TRIM(ua) != ''"),
        lastUpdated: scalar('SELECT MAX(updated_at) AS t FROM sources', 't'),
      },
      channels: {
        total: count('SELECT COUNT(*) AS n FROM channels'),
        groups: count('SELECT COUNT(*) AS n FROM groups'),
        // 这些频道不属于任何分组，客户端会单独显示为「未分组」一组
        ungrouped: count(`SELECT COUNT(*) AS n FROM channels c WHERE c.group_id IS NULL
                          OR c.group_id NOT IN (SELECT id FROM groups)`),
      },
      urls: {
        total: Number(probeStat.total || 0),
        probed: Number(probeStat.ok || 0),
        probeFailed: Number(probeStat.failed || 0),
        lastProbeAt: probeStat.last_at || null,
      },
      epg: {
        sources: count('SELECT COUNT(*) AS n FROM epg_sources'),
        programs: count('SELECT COUNT(*) AS n FROM epg_programs'),
        autoSync: setting('epgAutoSync') === '1',
      },
      recording: {
        tasks: count('SELECT COUNT(*) AS n FROM record_tasks'),
        files: count('SELECT COUNT(*) AS n FROM recordings'),
      },
      // 硬件转码能力：服务端要把录像压成 H.265 就得靠核显（QSV/VAAPI）。
      // fnOS 的应用默认跑在 package 用户下、读不到 /dev/dri —— 需要在应用中心
      // 的「访问权限」里把 /dev/dri 授权给本应用。这里直接探一次给出结论。
      hardware: (() => {
        const dri = '/dev/dri/renderD128';
        const out = { driPath: dri, driReadable: false, hevcQsv: false, hevcVaapi: false, note: '' };
        try { fs.accessSync(dri, fs.constants.R_OK); out.driReadable = true; } catch (e) { out.note = `读不到 ${dri}：${e.code || e.message}`; return out; }
        const probe = (args) => {
          try { execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args, '-f', 'null', '-'], { timeout: 10000, stdio: 'ignore' }); return true; } catch (_) { return false; }
        };
        const src = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '1'];
        out.hevcVaapi = probe(['-vaapi_device', dri, ...src, '-vf', 'format=nv12,hwupload', '-c:v', 'hevc_vaapi']);
        out.hevcQsv = probe(['-init_hw_device', `qsv=hw:${dri}`, ...src, '-c:v', 'hevc_qsv']);
        if (!out.hevcQsv && !out.hevcVaapi) out.note = '设备可读，但 QSV/VAAPI 都初始化失败（可能缺驱动或权限不足）';
        return out;
      })(),
      timeshift: {
        enabled: setting('timeshift') === '1',
        windowMin: timeshiftSvc.windowMinutes(db),
        // 1.11.17 起时移就是「录像窗口」：决定时移可用性的是录像，不再是 ffmpeg。
        // 这里给出录像分片长度，方便对照「刚开录像的频道要等多久才有历史」。
        recordSegmentMin: (() => {
          try {
            const v = parseInt(String(setting('recordSegmentMin') || '').replace(/^"|"$/g, ''), 10);
            return Number.isFinite(v) && v >= 1 && v <= 720 ? v : 5;
          } catch (_) { return 5; }
        })(),
        activeSessions: timeshiftSvc.status(),
      },
      stream: {
        authEnabled: streamAuth.isEnabled(),
        playMode: setting('playMode') || 'proxy',
        globalUa: setting('streamUserAgent'),
      },
      logo: {
        enabledSources: (() => { try { return logoSvc.getEnabledLogoSources(db).map((x) => x.id); } catch (_) { return []; } })(),
        cachedFiles: logoCached,
      },
      devices: {
        approved: count("SELECT COUNT(*) AS n FROM devices WHERE status = 'approved'"),
        pending: count("SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'"),
      },
      appUpdates: { published: appUpdates },
    });
  };
  router.get('/diagnostics', diagnostics);

  // ---------- 时移 ----------
  const timeshift = require('../services/timeshift');

  /** 时移状态：开关、窗口、正在用时移的频道 */
  router.get('/timeshift', (req, res) => {
    let segmentMin = 5;
    try {
      const v = parseInt(String((db.prepare("SELECT value FROM settings WHERE key='recordSegmentMin'").get() || {}).value || '').replace(/^"|"$/g, ''), 10);
      if (Number.isFinite(v) && v >= 1 && v <= 720) segmentMin = v;
    } catch (_) { /* 用默认 */ }
    ok(res, {
      enabled: String((db.prepare("SELECT value FROM settings WHERE key='timeshift'").get() || {}).value || '').replace(/^"|"$/g, '') === '1',
      windowMin: timeshift.windowMinutes(db),
      // 时移 = 录像窗口：这里给的是**录像分片长度**（决定刚开录像的频道等多久才有历史）
      recordSegmentMin: segmentMin,
      sessions: timeshift.status(),
    });
  });

  /** 手动停掉所有时移会话（换源/调试时用，省 CPU） */
  router.post('/timeshift/stop', (req, res) => {
    const before = timeshift.status().length;
    timeshift.shutdown();
    ok(res, { stopped: before });
  });

  // ---------- User-Agent 诊断 ----------
  /**
   * 把「一个源地址最终会用哪个 UA」摊开给用户看。
   *
   * 为什么要做这个：UA 的优先级是四层（?ua > 地址内联 > 源 UA > 全局 UA），
   * 而且原来四条取流路径各写了一套规则（录像甚至完全不看源 UA 和全局 UA），
   * 用户在后台填了 UA 根本不知道有没有生效、在哪一层生效。
   * 现在四条路径共用 services/ua.js 的同一份规则，这个接口把决策过程原样返回。
   */
  router.get('/ua/explain', (req, res) => {
    const { resolveUserAgent, globalUserAgent } = require('../services/ua');
    const channelUrlId = parseInt(req.query.channelUrlId, 10);
    const sourceId = parseInt(req.query.sourceId, 10);
    const sql = `SELECT cu.id, cu.url, cu.channel_id, c.name AS channel_name,
                        s.id AS source_id, s.name AS source_name, s.ua AS source_ua
                 FROM channel_urls cu
                 LEFT JOIN channels c ON c.id = cu.channel_id
                 LEFT JOIN sources s ON s.id = c.source_id`;
    let row = null;
    if (channelUrlId) {
      row = db.prepare(`${sql} WHERE cu.id = ?`).get(channelUrlId);
    } else if (sourceId) {
      row = db.prepare(`${sql} WHERE c.source_id = ? ORDER BY cu.id LIMIT 1`).get(sourceId);
    }
    if (!row) {
      return res.status(404).json({ code: 404, msg: '找不到对应的源地址（该源可能还没有频道）', data: null });
    }
    const globalUa = globalUserAgent(db);
    const r = resolveUserAgent({ rawUrl: row.url, sourceUa: row.source_ua, globalUa });
    ok(res, {
      channelUrlId: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name || '',
      sourceId: row.source_id,
      sourceName: row.source_name || '',
      rawUrl: row.url,
      globalUa,
      ua: r.ua,
      from: r.from,
      layers: r.layers,
    });
  });

  // ---------- 台标管理 ----------
  // 在线台标库现在是**多源**的：源清单定义在 services/logo.js 的 LOGO_SOURCES，
  // 后台可以多选启用哪些源，匹配时按源数组顺序依次探测，先命中者胜。

  /** 清除某频道的磁盘台标缓存，使 /api/client/logo/:id 下次重新抓取 */
  const clearLogoCache = (channelId) => {
    const { LOGO_DIR } = require('../services/logo');
    try {
      for (const f of fs.readdirSync(LOGO_DIR)) {
        if (f.startsWith(`${channelId}.`)) fs.unlinkSync(path.join(LOGO_DIR, f));
      }
    } catch (_) { /* 忽略 */ }
  };

  // 手动设置/清除单个频道台标（logo 为空串 = 清除）
  router.post('/logos/set', (req, res) => {
    const channelId = parseInt((req.body && req.body.channelId) || 0, 10);
    const logo = String((req.body && req.body.logo) || '').trim();
    if (!channelId) return res.status(400).json({ code: 400, msg: 'channelId required', data: null });
    const ch = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
    if (!ch) return res.status(404).json({ code: 404, msg: 'channel not found', data: null });
    if (logo && !/^https?:\/\//i.test(logo)) {
      return res.status(400).json({ code: 400, msg: 'logo 必须是 http(s) 地址', data: null });
    }
    db.prepare('UPDATE channels SET logo = ? WHERE id = ?').run(logo, channelId);
    clearLogoCache(channelId);
    ok(res, { channelId, logo });
  });

  // 台标源清单 + 当前启用项（后台多选）
  router.get('/logos/sources', (req, res) => {
    const { listLogoSources, getEnabledLogoSources } = require('../services/logo');
    ok(res, {
      sources: listLogoSources(),
      enabled: getEnabledLogoSources(db).map((s) => s.id),
    });
  });

  // 保存启用的台标源（多选，至少一个）
  router.post('/logos/sources', (req, res) => {
    const { listLogoSources, setEnabledLogoSources } = require('../services/logo');
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
    const known = new Set(listLogoSources().map((s) => s.id));
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) {
      return res.status(400).json({ code: 400, msg: `未知的台标源：${unknown.join(', ')}`, data: null });
    }
    if (ids.length === 0) {
      return res.status(400).json({ code: 400, msg: '请至少勾选一个台标源', data: null });
    }
    ok(res, { enabled: setEnabledLogoSources(db, ids) });
  });

  // 在线匹配缺失台标：对 logo 为空的频道，按频道名在**已启用**的各源里探测
  router.post('/logos/match-online', async (req, res) => {
    const { matchLogosOnline, getEnabledLogoSources } = require('../services/logo');
    const sources = getEnabledLogoSources(db);
    if (!sources.length) {
      return res.status(400).json({ code: 400, msg: '请先在「台标源」里勾选至少一个来源', data: null });
    }
    const r = await matchLogosOnline(db, { sources });
    ok(res, r);
  });

  // ---------- 客户端更新包 ----------
  // 上传 APK → 服务端解析版本号 → 客户端通过 /api/client/version 得知有没有新版。
  // 用 diskStorage 而不是 memoryStorage：安装包几十 MB，走内存会白占一份。
  const updateSvc = require('../services/update');
  const updateUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, updateSvc.UPDATE_DIR),
      filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`),
    }),
    limits: { fileSize: 300 * 1024 * 1024 },
  });

  router.get('/updates', (req, res) => {
    const list = updateSvc.listUpdates(db);
    ok(res, {
      latest: updateSvc.publicShape(updateSvc.getLatest(db), req),
      list: list.map((r) => ({ ...updateSvc.publicShape(r, req), id: r.id, file: r.file })),
      keep: updateSvc.KEEP_VERSIONS,
    });
  });

  router.post('/updates', (req, res) => {
    updateUpload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ code: 400, msg: `上传失败：${err.message}`, data: null });
      }
      if (!req.file) {
        return res.status(400).json({ code: 400, msg: '没有收到文件（字段名应为 file）', data: null });
      }
      const tmp = req.file.path;
      const r = updateSvc.saveUpdate(db, tmp, String((req.body && req.body.notes) || ''));
      try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
      if (!r.ok) {
        return res.status(400).json({ code: 400, msg: r.error, data: null });
      }
      ok(res, { update: { ...updateSvc.publicShape(r.row, req), id: r.row.id, file: r.row.file } });
    });
  });

  router.delete('/updates/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ code: 400, msg: 'bad id', data: null });
    if (!updateSvc.removeUpdate(db, id)) {
      return res.status(404).json({ code: 404, msg: 'not found', data: null });
    }
    ok(res, { id });
  });

  // ---------- 设备管理 ----------
  router.get('/devices', (req, res) => {
    ok(res, db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all());
  });
  router.post('/devices/:id/approve', (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
    if (!d) return res.status(404).json({ code: 404, msg: 'device not found', data: null });
    const token = generateClientToken();
    db.prepare("UPDATE devices SET status = 'approved', token = ? WHERE id = ?").run(token, d.id);
    ok(res, { token });
  });
  router.post('/devices/:id/reject', (req, res) => {
    db.prepare("UPDATE devices SET status = 'rejected', token = NULL WHERE id = ?").run(req.params.id);
    ok(res, null);
  });
  router.delete('/devices/:id', (req, res) => {
    db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
    ok(res, null);
  });

  // ---------- 录制任务与录像 ----------
  router.get('/record/tasks', (req, res) => {
    ok(res, (db.prepare('SELECT * FROM record_tasks ORDER BY id').all()).map((r) => ({ ...r, lastStderr: recorder.lastStderr(r.id) })));
  });
  router.post('/record/tasks', (req, res) => {
    const { channelId, mode, startTime, endTime, retentionDays = 7, enabled = true } = req.body || {};
    if (!channelId || !mode) return res.status(400).json({ code: 400, msg: 'channelId and mode required', data: null });
    const r = db.prepare(
      'INSERT INTO record_tasks (channel_id, mode, start_time, end_time, retention_days, enabled) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(channelId, mode, startTime || null, endTime || null, retentionDays, enabled ? 1 : 0);
    const task = db.prepare('SELECT * FROM record_tasks WHERE id = ?').get(Number(r.lastInsertRowid));
    if (task.enabled) recorder.startTask(db, task);
    ok(res, { id: Number(r.lastInsertRowid) });
  });
  router.put('/record/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM record_tasks WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ code: 404, msg: 'task not found', data: null });
    const b = req.body || {};
    db.prepare(
      'UPDATE record_tasks SET channel_id = ?, mode = ?, start_time = ?, end_time = ?, retention_days = ?, enabled = ? WHERE id = ?'
    ).run(
      b.channelId !== undefined ? b.channelId : t.channel_id,
      b.mode !== undefined ? b.mode : t.mode,
      b.startTime !== undefined ? b.startTime : t.start_time,
      b.endTime !== undefined ? b.endTime : t.end_time,
      b.retentionDays !== undefined ? b.retentionDays : t.retention_days,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : t.enabled,
      t.id,
    );
    const updated = db.prepare('SELECT * FROM record_tasks WHERE id = ?').get(t.id);
    recorder.stopTask(t.id);
    if (updated.enabled) recorder.startTask(db, updated);
    ok(res, null);
  });
  router.delete('/record/tasks/:id', (req, res) => {
    recorder.stopTask(parseInt(req.params.id, 10));
    db.prepare('DELETE FROM record_tasks WHERE id = ?').run(req.params.id);
    ok(res, null);
  });

  /** 删除一个频道的全部录像（文件 + 记录），返回删除条数 */
  function deleteRecordingsOfChannel(channelId) {
    const rows = db.prepare('SELECT id, file FROM recordings WHERE channel_id = ?').all(channelId);
    const del = db.prepare('DELETE FROM recordings WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      try { fs.unlinkSync(path.join(config.RECORD_DIR, r.file)); } catch (_) { /* 文件可能已不在 */ }
      del.run(r.id); n++;
    }
    if (n) logger.info(`[admin] 删除频道 #${channelId} 的录像 ${n} 条`);
    return n;
  }

  /**
   * 录像体检：每个频道拿"相邻分片起点间隔的中位数"和**配置的分片长度**比。
   * 明显偏小说明录像在不停重启、每片只录到一点点（线上实测过 15 秒一片、每片 0.8 秒），
   * 这种录像拿来当回看/时移的时间轴是不对的，所以在这里直接标出来。
   */
  router.get('/recordings/stats', (req, res) => {
    const expected = (() => {
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'recordSegmentMin'").get();
        const v = parseInt(String((row || {}).value || '').replace(/^"|"$/g, ''), 10);
        return Number.isFinite(v) && v >= 1 && v <= 720 ? v * 60 : 1800;
      } catch (_) { return 1800; }
    })();
    const rows = db.prepare('SELECT channel_id, date, start, file FROM recordings ORDER BY channel_id, date, start').all();
    const byCh = new Map();
    for (const r of rows) {
      let e = byCh.get(r.channel_id);
      if (!e) { e = { channelId: r.channel_id, count: 0, bytes: 0, starts: [], lastDate: r.date, lastStart: r.start }; byCh.set(r.channel_id, e); }
      e.count++;
      try { e.bytes += fs.statSync(path.join(config.RECORD_DIR, r.file)).size; } catch (_) { /* 文件可能已被清理 */ }
      e.starts.push(`${r.date} ${r.start}`);
      if (`${r.date} ${r.start}` > `${e.lastDate} ${e.lastStart}`) { e.lastDate = r.date; e.lastStart = r.start; }
    }
    const nameOf = (id) => { const c = db.prepare('SELECT name FROM channels WHERE id = ?').get(id); return c ? c.name : `#${id}`; };
    const list = [];
    for (const e of byCh.values()) {
      // 相邻起点间隔的中位数（秒）
      const ms = e.starts.map((t) => new Date(t.replace(' ', 'T')).getTime()).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < ms.length; i++) { const d = (ms[i] - ms[i - 1]) / 1000; if (d > 0 && d < 86400) gaps.push(d); }
      gaps.sort((a, b) => a - b);
      const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      list.push({
        channelId: e.channelId, name: nameOf(e.channelId), count: e.count, bytes: e.bytes,
        lastAt: `${e.lastDate} ${e.lastStart}`, medianGapSec: Math.round(medianGap),
        expectedSec: expected,
        // 间隔中位数不到配置值的一半 → 录像在碎片化，标出来
        healthy: medianGap === 0 || medianGap >= expected * 0.5,
      });
    }
    list.sort((a, b) => b.bytes - a.bytes);
    ok(res, {
      // 录像目录：设置里填过就是那个值（后台输入框要回填），没填则回默认目录。
      // 直接读设置、和启动时的覆盖逻辑同源 —— 不去读 config.RECORD_DIR 的内存值，
      // 免得两处取值口径不一致。
      recordDir: (() => {
        try {
          const r = db.prepare("SELECT value FROM settings WHERE key = 'recordDir'").get();
          const v = String((r || {}).value || '').replace(/^"|"$/g, '').trim();
          return v || config.RECORD_DIR;
        } catch (_) { return config.RECORD_DIR; }
      })(),
      expectedSegmentSec: expected,
      totalCount: rows.length,
      totalBytes: list.reduce((s2, x) => s2 + x.bytes, 0),
      channels: list,
    });
  });

  /** 批量删除录像：按频道或按日期（date 之前） */
  router.delete('/recordings/bulk', (req, res) => {
    const channelId = parseInt((req.query && req.query.channelId) || 0, 10);
    const before = (req.query && req.query.before) || '';
    if (!channelId && !before) {
      return res.status(400).json({ code: 400, msg: 'channelId 或 before 至少给一个', data: null });
    }
    let sql = 'SELECT id, file FROM recordings WHERE 1=1';
    const params = [];
    if (channelId) { sql += ' AND channel_id = ?'; params.push(channelId); }
    if (before) { sql += ' AND date < ?'; params.push(before); }
    const rows = db.prepare(sql).all(...params);
    const del = db.prepare('DELETE FROM recordings WHERE id = ?');
    for (const r of rows) {
      try { fs.unlinkSync(path.join(config.RECORD_DIR, r.file)); } catch (_) { /* 忽略 */ }
      del.run(r.id);
    }
    logger.info(`[admin] 批量删除录像 ${rows.length} 条（channelId=${channelId || '-'} before=${before || '-'}）`);
    ok(res, { removed: rows.length });
  });

  /**
   * 维护：把**现有**频道按 epgId / 归一化名字重新整合。
   * 导入时的合并规则只对"新导入"生效，历史数据得靠这个按钮整一遍 ——
   * 否则用户重新导入前，旧的重复频道一直挂着。
   * 合并时把线路、录制任务、录像记录一起挪到保留的那个频道上，避免变成孤儿。
   */
  /**
   * 维护：把**现有**频道按导入时同一套规则重新整合。
   * 规则见 services/m3u.js 的 mergeChannels（epgId 优先，其次归一化名字/前缀匹配）。
   * 被并掉的频道的线路、录制任务、录像记录都会挪到保留的那个频道上，避免变成孤儿。
   */
  router.post('/channels/merge', (req, res) => {
    const all = db.prepare('SELECT id, name, epg_id, logo, group_id, source_id FROM channels ORDER BY id').all();
    // **按来源分组，只在同一个订阅源内部合并。**
    // 早先是全局合并的：一个源的频道会被并进另一个源的频道里，然后被删掉，
    // 那个源就变成 0 个频道（用户看到的现象是"直播源只剩一条"）。
    // 按来源分组后，每个源都保留自己的频道，只是把**源内**的重复条目并成一条多线路。
    const bySource = new Map();
    for (const c of all) {
      const k = c.source_id == null ? '__none__' : String(c.source_id);
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k).push(c);
    }
    const kept = [];
    for (const [, list] of bySource) {
      kept.push(...m3uSvc.mergeChannels(
        list.map((c) => ({ id: c.id, name: c.name, epgId: c.epg_id || '', logo: c.logo || '', group: '', urls: [] }))
      ));
    }
    const moveUrls = db.prepare('UPDATE channel_urls SET channel_id = ? WHERE channel_id = ?');
    const moveTasks = db.prepare('UPDATE record_tasks SET channel_id = ? WHERE channel_id = ?');
    const moveRecs = db.prepare('UPDATE recordings SET channel_id = ? WHERE channel_id = ?');
    const delCh = db.prepare('DELETE FROM channels WHERE id = ?');
    // 保留下来的频道如果原本没有 epgId / logo，而并进来的那条有，就补上 ——
    // 否则整合完 epgId 是空的，EPG 匹配和下次整合都会不准（实测就是这样）。
    const updEpg = db.prepare("UPDATE channels SET epg_id = ? WHERE id = ? AND (epg_id IS NULL OR epg_id = '')");
    const updLogo = db.prepare("UPDATE channels SET logo = ? WHERE id = ? AND (logo IS NULL OR logo = '')");
    let merged = 0;
    const tx = db.transaction(() => {
      for (const k of kept) {
        if (k.epgId) { try { updEpg.run(k.epgId, k.id); } catch (_) { /* 列可能不存在 */ } }
        if (k.logo) { try { updLogo.run(k.logo, k.id); } catch (_) { /* 同上 */ } }
        for (const deadId of (k.mergedIds || [])) {
          moveUrls.run(k.id, deadId);
          try { moveTasks.run(k.id, deadId); } catch (_) { /* 表可能不存在 */ }
          try { moveRecs.run(k.id, deadId); } catch (_) { /* 同上 */ }
          delCh.run(deadId);
          merged++;
        }
      }
    });
    tx();
    logger.info(`[admin] 重新整合频道：合并 ${merged} 个，保留 ${kept.length} 个`);
    ok(res, { merged, kept: kept.length });
  });

  router.get('/recordings', (req, res) => {
    const { channelId, date } = req.query;
    let sql = 'SELECT * FROM recordings WHERE 1=1';
    const params = [];
    if (channelId) { sql += ' AND channel_id = ?'; params.push(parseInt(channelId, 10)); }
    if (date) { sql += ' AND date = ?'; params.push(date); }
    sql += ' ORDER BY date DESC, start DESC LIMIT 500';
    // 带上签名后的播放地址：/stream/record 现在需要 URL 签名，后台的「播放」链接
    // 不能再用裸地址拼（否则点开就是 403）。
    const rows = db.prepare(sql).all(...params).map((r) => ({
      ...r,
      // 文件大小：后台列表要显示，不然用户不知道录像占了多少
      size: (() => { try { return fs.statSync(path.join(config.RECORD_DIR, r.file)).size; } catch (_) { return 0; } })(),
      playUrl: `/stream/record/${r.id}?${streamAuth.query('record', r.id)}`,
    }));
    ok(res, rows);
  });
  router.delete('/recordings/:id', (req, res) => {
    const r = db.prepare('SELECT file FROM recordings WHERE id = ?').get(req.params.id);
    if (r) {
      const full = path.resolve(config.RECORD_DIR, r.file);
      if (full.startsWith(path.resolve(config.RECORD_DIR) + path.sep) && fs.existsSync(full)) {
        try { fs.unlinkSync(full); } catch (e) { logger.error(`[admin] delete recording file failed: ${e.message}`); }
      }
      db.prepare('DELETE FROM recordings WHERE id = ?').run(req.params.id);
    }
    ok(res, null);
  });

  // ---------- 日志 ----------
  router.get('/logs', (req, res) => {
    const tail = Math.min(parseInt(req.query.tail, 10) || 200, 2000);
    ok(res, { lines: logger.tail(tail) });
  });

  // ---------- 线路画质探测 ----------
  router.post('/sources/probe', (req, res) => {
    const force = !!(req.body && req.body.force);
    ok(res, probe.startProbe(db, { force }));
  });
  router.get('/sources/probe', (req, res) => {
    ok(res, probe.probeStatus());
  });

  // ---------- 设置 ----------
  router.get('/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    for (const r of rows) {
      try { obj[r.key] = JSON.parse(r.value); } catch (_) { obj[r.key] = r.value; }
    }
    // 确保有默认播放器配置返回
    if (!obj.playerConfig) obj.playerConfig = config.DEFAULT_PLAYER_CONFIG;
    if (obj.epgAutoSync === undefined) obj.epgAutoSync = '0';
    if (obj.playMode === undefined) obj.playMode = 'proxy';
    if (obj.streamUserAgent === undefined) obj.streamUserAgent = '';
    if (obj.streamAuth === undefined) obj.streamAuth = '1';
    if (obj.githubRepo === undefined) obj.githubRepo = '';
    if (obj.githubMirror === undefined) obj.githubMirror = '';
    if (obj.githubVersionCode === undefined) obj.githubVersionCode = '';
    // 签名密钥与 GitHub token 不返回给前端
    delete obj.streamSecret;
    delete obj.githubToken;
    // 但要让前端知道"token 已经配过了"，否则用户会以为没保存成功而反复重填
    obj.githubTokenSet = !!(db.prepare("SELECT value FROM settings WHERE key = 'githubToken'").get() || {}).value;
    ok(res, obj);
  });
  router.put('/settings', (req, res) => {
    const body = req.body || {};
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const GITHUB_KEYS = ['githubRepo', 'githubMirror', 'githubVersionCode', 'githubToken'];
    let touchedGithub = false;
    const tx = db.transaction(() => {
      for (const [k, v] of Object.entries(body)) {
        // 白名单校验 key，避免写入任意配置
        if (['playerConfig', 'epgAutoSync', 'playMode', 'streamUserAgent', 'streamAuth', 'timeshift', 'timeshiftWindowMin', 'recordSegmentMin', 'recordDir', 'mergeChannels', 'recordEncode', ...GITHUB_KEYS].includes(k)) {
          // GitHub token 允许留空表示"不改动"：前端拿不到原值，回传空串时不能把已配的 token 抹掉
          if (k === 'githubToken' && String(v) === '') continue;
          up.run(k, typeof v === 'string' ? v : JSON.stringify(v));
          if (GITHUB_KEYS.includes(k)) touchedGithub = true;
        }
      }
    });
    tx();
    // streamAuth 改动需要立刻生效，重新读取开关
    streamAuth.init(db);
    // GitHub 配置改完立刻生效，不用等 30 分钟缓存过期
    if (touchedGithub) {
      try { require('../services/githubRelease').clearCache(); } catch (_) { /* 忽略 */ }
    }
    ok(res, null);
  });

  // 测试 GitHub 更新渠道：让后台能当场确认"仓库填对了没有"，
  // 而不是等客户端提示更新失败才发现仓库名写错。
  router.get('/github/test', async (req, res) => {
    try {
      const gh = require('../services/githubRelease');
      const result = await gh.test(db);
      ok(res, result);
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message, data: null });
    }
  });

  return router;
};
