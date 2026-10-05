'use strict';

/**
 * 客户端版本信息来自 GitHub Release（可选渠道）。
 *
 * 为什么由**服务端**去读，而不是让电视自己连 GitHub：
 *   TV/盒子在国内直连 api.github.com 基本不可用，"检查更新"会变成"经常失败"。
 *   服务端（NAS）读一次、缓存住，客户端仍然只问服务端 —— 客户端一行都不用改。
 *
 * 版本号的来源：GitHub Release 的 tag 只有 `v1.11.15` 这种名字，没有 versionCode。
 * 而客户端的 hasUpdate 判断要用 versionCode（拿不到就当成"已是最新"，永远不提示更新），
 * 所以发布脚本 tools/release-github.sh 会把元数据写进 Release 正文：
 *
 *     versionCode: 71
 *     sha256: f4209714...
 *
 * 这里解析它们。解析不到时还可以退回后台手工填的 settings.githubVersionCode ——
 * 也就是说"服务端给版本号"这件事有两条路：Release 正文自动带，或后台手填。
 *
 * 下载地址用 asset 的原始地址，前面拼后台配置的加速前缀（settings.githubMirror）。
 * ghproxy 这类服务就是「前缀 + 原始地址」的用法；留空则直接用 github.com 原始地址。
 */

const logger = require('../logger');

const API = 'https://api.github.com';
const UA = 'MediaIptv-Server';
/** 成功结果的缓存时长：GitHub 有速率限制，别让每个客户端请求都去打一次 */
const OK_TTL_MS = 30 * 60 * 1000;
/** 失败结果的缓存时长：上游挂了/被墙时也不能让每次心跳都去等一次超时 */
const FAIL_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 8000;

/** { at, data, error }；data 非空表示上一次读取成功 */
let cache = { at: 0, data: null, error: '' };

function settingValue(db, key) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!r) return '';
    return String(r.value).replace(/^"|"$/g, '').trim();
  } catch (_) {
    return '';
  }
}

/** GitHub 相关配置；没配 repo 就返回 null（调用方回退到服务端本地更新包） */
function settingsOf(db) {
  const repo = settingValue(db, 'githubRepo');
  return {
    repo,
    mirror: settingValue(db, 'githubMirror'),
    token: settingValue(db, 'githubToken'),
    versionCodeFallback: parseInt(settingValue(db, 'githubVersionCode'), 10) || 0,
  };
}

/** `owner/repo` 形式校验：挡掉把整个 URL 填进来的情况（那样拼出来的 API 地址必然 404） */
function isValidRepo(repo) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ''));
}

/**
 * 从 Release 正文里抠出发布脚本写进去的元数据行。
 *
 * 两个坑，都是实测踩出来的：
 *
 * 1. **必须在元数据块里找，而不是整篇正文里找。** 更新说明里完全可能出现
 *    `sha256: ...` 这样的字眼（比如"这一版的做法"里举了个例子），整篇正则一抓就抓错。
 *    所以发布脚本把元数据包在 `<!-- mediaiptv-meta ... -->` 里，这里优先只看这个块。
 *
 * 2. **没有块时要取最后一个匹配，而不是第一个。** 已经发出去的 Release 正文里
 *    可能既有说明中的示例、又有末尾追加的真实值 —— 取第一个就会把示例当成真值，
 *    客户端下载后 sha256 校验失败、装不上。脚本总是把元数据追加在末尾，
 *    所以"最后一个"才是对的。
 *
 * @returns {{versionCode:number, sha256:string, notes:string}}
 */
function parseMeta(body) {
  const text = String(body || '');

  // 取**最后一个**元数据块 —— 这个"最后"是必须的，不是保守起见：
  // 本项目的 RELEASE_NOTES 里先后写过两次"元数据长什么样"的示例，
  // 一次是 `sha256: f4209714…`、一次是 `<!-- mediaiptv-meta … -->`，
  // 两次都被解析器当成了真值（第二次连注释块的定界符一起被匹配走，捕获到的只有" …"）。
  // 发布脚本总是把真正的元数据放在正文末尾，所以"最后一个"才是对的。
  let block = null;
  const blockRe = /<!--\s*mediaiptv-meta\s*([\s\S]*?)-->/gi;
  let bm;
  while ((bm = blockRe.exec(text)) !== null) block = bm[1];
  const scope = block !== null ? block : text;

  const pick = (name) => {
    const re = new RegExp(`^\\s*${name}\\s*[:=]\\s*(\\S+)\\s*$`, 'gmi');
    let m;
    let last = '';
    while ((m = re.exec(scope)) !== null) last = m[1];
    return last;
  };

  return {
    versionCode: parseInt(pick('versionCode'), 10) || 0,
    sha256: pick('sha256').toLowerCase(),
    // 给客户端展示的说明：去掉所有元数据块，以及散落在正文里的元数据行
    notes: text
      .replace(/<!--\s*mediaiptv-meta\s*[\s\S]*?-->/gi, '')
      .split('\n')
      .filter((l) => !/^\s*(versionCode|sha256|size)\s*[:=]/i.test(l))
      .join('\n')
      .trim(),
  };
}

/** 加速前缀拼接：`https://ghproxy.net/` + 原始地址 */
function joinMirror(mirror, url) {
  const m = String(mirror || '').trim();
  if (!m) return url;
  return m.endsWith('/') ? m + url : `${m}/${url}`;
}

/** 从资产里挑 APK：优先正式包，跳过 debug 包 */
function pickApkAsset(assets) {
  const apks = (assets || []).filter((a) => /\.apk$/i.test(a.name || ''));
  if (!apks.length) return null;
  return apks.find((a) => /^mediaiptv_v/i.test(a.name)) || apks[0];
}

async function fetchJson(url, token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) {
      // 403/404 要区分开：403 多半是没配 token 撞上速率限制
      throw new Error(`HTTP ${res.status}${res.status === 403 ? '（可能是 GitHub 速率限制，可在后台填 token）' : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取最新版本信息。
 * @returns {Promise<null|{versionCode:number,versionName:string,size:number,sha256:string,notes:string,uploadedAt:string,url:string,source:'github'}>}
 *          null 表示"这条渠道没配或这次读不到"，调用方应回退到服务端本地更新包
 */
async function latest(db) {
  const cfg = settingsOf(db);
  if (!isValidRepo(cfg.repo)) return null;

  const now = Date.now();
  const ttl = cache.data ? OK_TTL_MS : FAIL_TTL_MS;
  if (cache.at && now - cache.at < ttl) return cache.data;

  try {
    const rel = await fetchJson(`${API}/repos/${cfg.repo}/releases/latest`, cfg.token);
    const asset = pickApkAsset(rel.assets);
    if (!asset) throw new Error('这个 Release 里没有 .apk 资产');

    const tag = String(rel.tag_name || '').replace(/^v/i, '');
    const meta = parseMeta(rel.body);
    const versionName =
      tag || ((asset.name || '').match(/v?(\d+\.\d+\.\d+)/) || [])[1] || '';
    const versionCode = meta.versionCode || cfg.versionCodeFallback;

    if (!versionName) throw new Error('从 tag / 资产名里读不到版本号');
    if (!versionCode) {
      throw new Error('读不到 versionCode（Release 正文没有元数据行，后台也没填 githubVersionCode）');
    }

    const data = {
      versionCode,
      versionName,
      size: asset.size || 0,
      sha256: meta.sha256,
      notes: meta.notes,
      uploadedAt: rel.published_at || rel.created_at || '',
      url: joinMirror(cfg.mirror, asset.browser_download_url),
      source: 'github',
    };
    cache = { at: now, data, error: '' };
    logger.info(`[github] 最新版本 ${versionName}(${versionCode}) ← ${cfg.repo}，资产 ${asset.name}`);
    return data;
  } catch (e) {
    cache = { at: now, data: null, error: e.message };
    logger.warn(`[github] 读取 ${cfg.repo} 的 Release 失败：${e.message}（回退服务端本地更新包）`);
    return null;
  }
}

/** 后台改完配置后调用，别让新配置等满 30 分钟缓存 */
function clearCache() {
  cache = { at: 0, data: null, error: '' };
}

/** 给后台"测试连接"用：返回 {ok, message, info?} */
async function test(db) {
  const cfg = settingsOf(db);
  if (!isValidRepo(cfg.repo)) return { ok: false, message: '仓库要填 owner/repo 形式，例如 yourname/mediaiptv' };
  clearCache();
  const info = await latest(db);
  if (!info) return { ok: false, message: cache.error || '读取失败' };
  return {
    ok: true,
    message: `读到 ${info.versionName}（versionCode ${info.versionCode}）`,
    info,
  };
}

module.exports = { latest, test, clearCache, settingsOf, parseMeta, joinMirror, pickApkAsset, isValidRepo };
