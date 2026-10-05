'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const axios = require('axios');
const logger = require('../logger');
const config = require('../config');

/**
 * 台标服务：
 * 1. EPG 同步后按频道名归一化匹配，回填 channels.epg_id / logo
 * 2. /logo/:channelId 代理抓取远程台标并缓存到本地磁盘，客户端只访问本服务
 * 3. 在线台标库匹配：按频道名到若干公开台标仓库里找同名图片（可在后台多选启用哪些源）
 */

const LOGO_DIR = path.join(config.DATA_DIR, 'logos');
try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch {}

/**
 * 台标源注册表。
 *
 * 每个源只需要描述「仓库 + 子目录 + 可用扩展名 + CDN 前缀」，匹配引擎和后台的
 * 多选列表都从这里派生 —— 以后再加一个台标库只改这一处。
 *
 * bases 里同一个源的多个 CDN 会**并发**探测、按数组顺序取第一个可用的：
 * 原先 admin.js 里是串行 for-await，raw.githubusercontent.com 在部分网络下会
 * 一直挂到超时，把整个匹配拖慢；并发探测后慢的那个源不再拖累结果。
 */
const LOGO_SOURCES = [
  {
    id: 'fanmingming',
    label: 'fanmingming/live',
    repo: 'fanmingming/live',
    subdir: 'tv/',
    exts: ['png'],
    page: 'https://github.com/fanmingming/live',
    desc: 'IPTV 直播源配套台标库，大陆央视 / 卫视 / 地方台覆盖最全',
    bases: [
      'https://fastly.jsdelivr.net/gh/fanmingming/live@main/',
      'https://cdn.jsdelivr.net/gh/fanmingming/live@main/',
      'https://raw.githubusercontent.com/fanmingming/live/main/',
    ],
  },
  {
    id: 'hidigital',
    label: 'HiDigital/Logo',
    repo: 'HiDigital/Logo',
    subdir: '',
    // 这个仓库 700 张图里 696 张是 png、4 张是 jpg，两种都要探
    exts: ['png', 'jpg'],
    page: 'https://github.com/HiDigital/Logo',
    desc: '港台 / 海外 / 付费频道台标（东森、三立、TVB、凤凰、IHOT、NewTV、CIBN 等），2021 年后未再更新',
    bases: [
      'https://fastly.jsdelivr.net/gh/HiDigital/Logo@main/',
      'https://cdn.jsdelivr.net/gh/HiDigital/Logo@main/',
      'https://raw.githubusercontent.com/HiDigital/Logo/main/',
    ],
  },
];

/** 后台多选结果存在 settings 表；键不存在 = 全部启用（保持老库升级后的行为） */
const LOGO_SOURCES_KEY = 'logoSources';

/** 给后台用的源清单（不含内部探测细节） */
function listLogoSources() {
  return LOGO_SOURCES.map((s) => ({
    id: s.id, label: s.label, repo: s.repo, page: s.page, desc: s.desc,
  }));
}

function allLogoSources() {
  return LOGO_SOURCES.slice();
}

function getSourceById(id) {
  return LOGO_SOURCES.find((s) => s.id === id) || null;
}

/**
 * 当前启用的源。
 * - settings 里没有这个键（老库刚升级）→ 全部启用
 * - 有键但是空数组 → 返回空（后台明确取消了全部勾选，匹配接口会给出提示）
 */
function getEnabledLogoSources(db) {
  let raw;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LOGO_SOURCES_KEY);
    raw = row ? row.value : null;
  } catch (e) {
    logger.warn(`[logo] 读取台标源配置失败，按全部启用处理：${e.message}`);
    return LOGO_SOURCES.slice();
  }
  if (raw == null) return LOGO_SOURCES.slice();
  let ids;
  try { ids = JSON.parse(raw); } catch { return LOGO_SOURCES.slice(); }
  if (!Array.isArray(ids)) return LOGO_SOURCES.slice();
  const want = new Set(ids.map(String));
  return LOGO_SOURCES.filter((s) => want.has(s.id));
}

/** 保存启用的源，返回落库后的 id 列表 */
function setEnabledLogoSources(db, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const saved = LOGO_SOURCES.filter((s) => want.has(s.id)).map((s) => s.id);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(LOGO_SOURCES_KEY, JSON.stringify(saved));
  return saved;
}

/** 频道名归一化：忽略大小写/空格/连字符/括号/常见画质后缀，提升命中率 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s\-_·（）()【】\[\]]/g, '')
    .replace(/(超高清|超清|高清|标清|4k|8k|fhd|uhd|hd|sd)$/g, '')
    .replace(/频道|电视台$/g, '')
    .trim();
}

/**
 * 台标文件名候选（**不做小写化**：仓库里 CCTV1.png 与 hbo.png 并存，CDN 大小写敏感）。
 * 顺序即优先级：先原名去空格，再归一化名（去连字符/画质后缀/「频道」「电视台」）。
 */
function logoNameCandidates(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const noSpace = raw.replace(/\s/g, '');
  const normalized = raw
    .replace(/[\s\-_·（）()【】\[\]]/g, '')
    .replace(/(超高清|超清|高清|标清|4k|8k|fhd|uhd|hd|sd)$/i, '')
    .replace(/频道|电视台$/, '')
    .trim();
  return [...new Set([noSpace, normalized].filter(Boolean))];
}

/** 单次 HEAD 探测，200 才算命中（其它状态码/异常都当没有） */
async function headOk(url, timeout) {
  try {
    const resp = await axios.head(url, { timeout, maxRedirects: 3, validateStatus: () => true });
    return resp.status === 200;
  } catch (_) {
    return false;
  }
}

/**
 * 在一个源里按候选名找台标，返回命中的 URL 或 null。
 * 同一个候选名的多个 CDN / 扩展名并发探测，按声明顺序取第一个 200。
 */
async function probeSource(src, name, timeout) {
  const urls = [];
  for (const base of src.bases) {
    for (const ext of src.exts) {
      urls.push(`${base}${src.subdir}${encodeURIComponent(name)}.${ext}`);
    }
  }
  const results = await Promise.all(urls.map((u) => headOk(u, timeout)));
  const idx = results.findIndex(Boolean);
  return idx === -1 ? null : urls[idx];
}

/**
 * 在线匹配缺失台标：对 logo 为空的频道，按频道名依次在各启用源里探测，
 * 命中即写回 channels.logo 并停止该频道的后续探测（源数组顺序 = 优先级）。
 *
 * @param {object} db
 * @param {{sources?: object[], concurrency?: number, timeout?: number}} [opts]
 * @returns {Promise<{tried:number, matched:number, bySource:Object<string,number>, sources:string[], channelCount:number}>}
 */
async function matchLogosOnline(db, opts = {}) {
  const sources = Array.isArray(opts.sources) ? opts.sources.filter(Boolean) : getEnabledLogoSources(db);
  const concurrency = Math.max(1, Math.min(16, Number(opts.concurrency) || 8));
  const timeout = Math.max(1000, Math.min(10000, Number(opts.timeout) || 2500));

  const channels = db.prepare("SELECT id, name FROM channels WHERE logo IS NULL OR logo = ''").all();
  const bySource = {};
  for (const s of sources) bySource[s.id] = 0;
  const upd = db.prepare('UPDATE channels SET logo = ? WHERE id = ?');

  let tried = 0, matched = 0;
  const queue = [...channels];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (;;) {
      const ch = queue.shift();
      if (!ch) return;
      tried++;
      const candidates = logoNameCandidates(ch.name);
      for (const src of sources) {
        let hit = null;
        for (const name of candidates) {
          hit = await probeSource(src, name, timeout);
          if (hit) break;
        }
        if (hit) {
          upd.run(hit, ch.id);
          matched++;
          bySource[src.id]++;
          break; // 已命中，不再往后面的源找
        }
      }
    }
  });
  await Promise.all(workers);

  logger.info(
    `[logo] 在线匹配完成：待匹配 ${channels.length} 个频道，尝试 ${tried} 个，命中 ${matched} 个` +
    `（${sources.map((s) => `${s.id}:${bySource[s.id]}`).join(' ')}）`
  );
  return {
    tried, matched, bySource, channelCount: channels.length,
    sources: sources.map((s) => s.id),
  };
}

/**
 * EPG 同步后调用：把 DB 中 epg_id 为空的频道按名称匹配到 XMLTV 频道，
 * 同时回填台标（若频道原本无 logo）。
 * @param {object} db better-sqlite3 句柄
 * @param {Map<string,{name:string,icon:string}>} channelMap XMLTV id -> {name, icon}
 * @returns {{matched:number, logoFilled:number}}
 */
function matchChannelsToEpg(db, channelMap) {
  // 建立 归一化名 -> {epgId, icon} 索引
  const nameIdx = new Map();
  for (const [epgId, info] of channelMap.entries()) {
    const key = normalizeName(info.name);
    if (key && !nameIdx.has(key)) nameIdx.set(key, { epgId, icon: info.icon || '' });
  }

  const channels = db.prepare('SELECT id, name, epg_id, logo FROM channels').all();
  const updEpg = db.prepare('UPDATE channels SET epg_id = ? WHERE id = ?');
  const updLogo = db.prepare('UPDATE channels SET logo = ? WHERE id = ?');
  let matched = 0, logoFilled = 0;

  const tx = db.transaction(() => {
    for (const ch of channels) {
      const key = normalizeName(ch.name);
      const hit = nameIdx.get(key);
      if (!hit) continue;
      if (!ch.epg_id) {
        updEpg.run(hit.epgId, ch.id);
        matched++;
      }
      if (!ch.logo && hit.icon) {
        updLogo.run(hit.icon, ch.id);
        logoFilled++;
      }
    }
  });
  tx();
  logger.info(`[logo] EPG 频道匹配: ${matched} 个频道补全 epg_id, ${logoFilled} 个频道补全台标`);
  return { matched, logoFilled };
}

/** 下载远程台标到本地缓存（带磁盘缓存，重复请求直接读文件） */
function fetchAndCacheLogo(url, cacheFile) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('bad url')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      timeout: 10000,
      headers: { 'User-Agent': 'MediaIptv-LogoFetcher/1.0' },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return fetchAndCacheLogo(res.headers.location, cacheFile).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const tmp = cacheFile + '.tmp';
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close();
        try { fs.renameSync(tmp, cacheFile); resolve(cacheFile); }
        catch (e) { reject(e); }
      });
      ws.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 注册台标路由：GET /logo/:channelId
 * 优先读磁盘缓存；未命中则从 channels.logo 远程地址抓取并缓存。
 * 挂载在 client 路由（需设备 token）。
 */
function registerLogoRoute(router, db) {
  router.get('/logo/:channelId', async (req, res) => {
    const channelId = parseInt(req.params.channelId, 10);
    if (!channelId) return res.status(400).end();

    // 磁盘缓存命中
    const cached = fs.readdirSync(LOGO_DIR).filter((f) => f.startsWith(`${channelId}.`));
    if (cached.length > 0) {
      const file = path.join(LOGO_DIR, cached[0]);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Type', guessContentType(cached[0]));
      return fs.createReadStream(file).pipe(res);
    }

    const ch = db.prepare('SELECT logo FROM channels WHERE id = ?').get(channelId);
    if (!ch || !ch.logo) return res.status(404).end();

    const ext = (path.extname(new URL(ch.logo).pathname) || '.png').slice(0, 5);
    const cacheFile = path.join(LOGO_DIR, `${channelId}${ext}`);
    try {
      await fetchAndCacheLogo(ch.logo, cacheFile);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Type', guessContentType(`${channelId}${ext}`));
      fs.createReadStream(cacheFile).pipe(res);
    } catch (e) {
      logger.warn(`[logo] fetch failed channel=${channelId} url=${ch.logo}: ${e.message}`);
      res.status(502).end();
    }
  });
}

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
}

module.exports = {
  normalizeName,
  matchChannelsToEpg,
  registerLogoRoute,
  LOGO_DIR,
  // 在线台标库（多源）
  LOGO_SOURCES,
  LOGO_SOURCES_KEY,
  allLogoSources,
  listLogoSources,
  getSourceById,
  getEnabledLogoSources,
  setEnabledLogoSources,
  logoNameCandidates,
  matchLogosOnline,
};
