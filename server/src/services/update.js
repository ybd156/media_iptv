'use strict';

/**
 * 客户端更新包管理。
 *
 * 服务端只负责「存最新几个 APK + 告诉客户端有没有新版」，安装动作在客户端。
 * 版本号**从 APK 里读**（services/apk.js），不让后台上传时手填 —— 手填迟早会填错，
 * 而填错的后果是客户端永远提示有新版、或者永远收不到更新。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { readApkInfo } = require('./apk');

const UPDATE_DIR = path.join(config.DATA_DIR, 'updates');
try { fs.mkdirSync(UPDATE_DIR, { recursive: true }); } catch (_) { /* 忽略 */ }

/** 服务端只保留最近几个版本，和 dist/ 的策略保持一致 */
const KEEP_VERSIONS = 2;

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function publicShape(row, req) {
  if (!row) return null;
  return {
    versionCode: row.version_code,
    versionName: row.version_name,
    size: row.size,
    sha256: row.sha256,
    notes: row.notes || '',
    uploadedAt: row.uploaded_at,
    url: req ? `${req.protocol}://${req.headers.host}/api/client/apk` : '/api/client/apk',
  };
}

function getLatest(db) {
  return db.prepare('SELECT * FROM app_updates ORDER BY version_code DESC LIMIT 1').get() || null;
}

function listUpdates(db) {
  return db.prepare('SELECT * FROM app_updates ORDER BY version_code DESC').all();
}

function getUpdate(db, id) {
  return db.prepare('SELECT * FROM app_updates WHERE id = ?').get(id) || null;
}

/** 取某个更新包的磁盘路径，并挡住目录穿越 */
function filePathOf(row) {
  if (!row || !row.file) return null;
  const p = path.join(UPDATE_DIR, path.basename(row.file));
  if (!p.startsWith(UPDATE_DIR + path.sep)) return null;
  return fs.existsSync(p) ? p : null;
}

/** 只保留最近 keep 个版本，其余连文件一起删 */
function pruneUpdates(db, keep = KEEP_VERSIONS) {
  const rows = listUpdates(db);
  const doomed = rows.slice(keep);
  for (const r of doomed) {
    const p = filePathOf(r);
    if (p) { try { fs.unlinkSync(p); } catch (_) { /* 忽略 */ } }
    db.prepare('DELETE FROM app_updates WHERE id = ?').run(r.id);
    logger.info(`[update] 清理旧更新包 ${r.version_name}(${r.version_code})`);
  }
  return doomed.length;
}

/**
 * 收下一个上传的 APK：解析版本 → 落盘 → 落库 → 清理旧版本。
 * @returns {{ok:true, row:object}|{ok:false, error:string}}
 */
function saveUpdate(db, tmpPath, notes = '') {
    let info;
    try {
        info = readApkInfo(tmpPath);
    } catch (e) {
        return { ok: false, error: `读不出 APK 信息：${e.message}` };
    }
    if (!info.packageName) return { ok: false, error: 'APK 里读不到包名' };
    if (info.packageName.endsWith('.debug')) {
        return { ok: false, error: `这是 debug 包（${info.packageName}），不能作为更新包下发` };
    }
    if (info.packageName !== 'com.mediaiptv.tv') {
        return { ok: false, error: `不是本应用的安装包（包名 ${info.packageName}）` };
    }
    if (!info.versionCode || !info.versionName) {
        return { ok: false, error: 'APK 里读不到 versionCode / versionName' };
    }

    const file = `mediaiptv_v${info.versionName}_${info.versionCode}.apk`;
    const dest = path.join(UPDATE_DIR, file);
    try {
        fs.copyFileSync(tmpPath, dest);
    } catch (e) {
        return { ok: false, error: `保存失败：${e.message}` };
    }

    const size = fs.statSync(dest).size;
    const sha256 = sha256File(dest);

    // 同一 versionCode 重复上传就覆盖记录，避免列表里出现两条同版本
    db.prepare('DELETE FROM app_updates WHERE version_code = ?').run(info.versionCode);
    const r = db.prepare(
        `INSERT INTO app_updates (version_code, version_name, package_name, file, size, sha256, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(info.versionCode, info.versionName, info.packageName, file, size, sha256, notes || '');

    pruneUpdates(db, KEEP_VERSIONS);
    logger.info(`[update] 已收下更新包 ${info.versionName}(${info.versionCode}) ${(size / 1048576).toFixed(1)}MB`);
    return { ok: true, row: getUpdate(db, Number(r.lastInsertRowid)) };
}

function removeUpdate(db, id) {
  const row = getUpdate(db, id);
  if (!row) return false;
  const p = filePathOf(row);
  if (p) { try { fs.unlinkSync(p); } catch (_) { /* 忽略 */ } }
  db.prepare('DELETE FROM app_updates WHERE id = ?').run(id);
  return true;
}

module.exports = {
  UPDATE_DIR, KEEP_VERSIONS,
  getLatest, listUpdates, getUpdate, filePathOf,
  saveUpdate, removeUpdate, pruneUpdates, publicShape,
};
