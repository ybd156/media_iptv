'use strict';

const path = require('path');
const fs = require('fs');
// Node >= 22.13 内置 SQLite（node:sqlite），无需原生编译，便于飞牛 fnOS FPK 离线打包
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const logger = require('./logger');

let db = null;

function open() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
  db = new DatabaseSync(config.DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // node:sqlite 没有 better-sqlite3 的 db.transaction()，挂一个等价实现保持路由层不变
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  };
  migrate();
  seedAdmin();
  applyAdminPasswordEnv();
}

function migrate() {
  const sql = `
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      model TEXT,
      android_version TEXT,
      token TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      last_seen INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      logo TEXT,
      epg_id TEXT,
      sort INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS channel_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      sort INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS epg_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      url TEXT NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS epg_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epg_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      title TEXT NOT NULL,
      UNIQUE(epg_id, date, start)
    );

    CREATE TABLE IF NOT EXISTS record_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      mode TEXT CHECK(mode IN ('always','daily')) NOT NULL,
      start_time TEXT,
      end_time TEXT,
      retention_days INTEGER DEFAULT 7,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      file TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      status TEXT DEFAULT 'ok' CHECK(status IN ('ok','failed','recording'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT DEFAULT '',
      play_mode TEXT DEFAULT '' CHECK(play_mode IN ('','proxy','direct','direct_plain')),
      auto_update INTEGER DEFAULT 0,
      update_interval INTEGER DEFAULT 12,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER
    );

    -- 客户端更新包：管理员上传 APK，服务端解析版本号后存这里，客户端按 version_code 判断有没有新版
    CREATE TABLE IF NOT EXISTS app_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_code INTEGER NOT NULL,
      version_name TEXT NOT NULL,
      package_name TEXT,
      file TEXT NOT NULL,
      size INTEGER,
      sha256 TEXT,
      notes TEXT DEFAULT '',
      uploaded_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `;
  db.exec(sql);

  // 增量迁移：channel_urls 增加画质探测字段（老库升级时补列）
  for (const col of [
    "ALTER TABLE channel_urls ADD COLUMN width INTEGER",
    "ALTER TABLE channel_urls ADD COLUMN height INTEGER",
    "ALTER TABLE channel_urls ADD COLUMN probe_at INTEGER",
    "ALTER TABLE channels ADD COLUMN source_id INTEGER",
    "ALTER TABLE sources ADD COLUMN ua TEXT DEFAULT ''",
    // 密码算法标记：老库里的行会拿到 'sha256'，登录成功后就地升级为 scrypt
    "ALTER TABLE admins ADD COLUMN algo TEXT DEFAULT 'sha256'",
  ]) {
    try { db.exec(col); } catch (_) { /* 列已存在 */ }
  }

  // 索引：原先一张都没建，以下查询全部退化为全表扫描。
  // 实测 20 万行 recordings / 1.5 万行 channel_urls 下：
  //   /catchup/days 18.4ms -> 0.052ms，/epg 的 hasRecord 31.3ms -> 0.003ms
  // 这些查询在客户端每次启动、每次换台、以及录像清理时都会跑。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_urls_channel    ON channel_urls(channel_id);
    CREATE INDEX IF NOT EXISTS idx_channels_source         ON channels(source_id);
    CREATE INDEX IF NOT EXISTS idx_channels_group_name     ON channels(group_id, name);
    CREATE INDEX IF NOT EXISTS idx_recordings_channel_date ON recordings(channel_id, date);
    CREATE INDEX IF NOT EXISTS idx_recordings_date         ON recordings(date);
    CREATE INDEX IF NOT EXISTS idx_record_tasks_channel    ON record_tasks(channel_id);
    CREATE INDEX IF NOT EXISTS idx_epg_programs_date       ON epg_programs(date);
  `);

  // 历史遗留清理：同一频道下完全相同的 URL 重复行（旧版导入不去重导致，
  // 会让客户端线路列表出现重复项、自动换源重复尝试同一条线路）。
  // 每组重复保留信息最全的一行（优先已有画质探测结果的），其余删除。
  try {
    const dupGroups = db.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT 1 FROM channel_urls GROUP BY channel_id, url HAVING COUNT(*) > 1)'
    ).get().c;
    if (dupGroups > 0) {
      const removed = db.prepare(`
        DELETE FROM channel_urls WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY channel_id, url
              ORDER BY (height IS NULL), COALESCE(height, 0) DESC, id
            ) AS rn FROM channel_urls
          ) WHERE rn = 1
        )
      `).run().changes;
      logger.warn(`[db] 清理重复线路：删除 ${removed} 行（${dupGroups} 组重复 URL）`);
    }
  } catch (e) {
    logger.warn(`[db] 线路去重跳过：${e.message}`);
  }

  logger.info('[db] tables ensured');
}

function seedAdmin() {
  const exists = db.prepare("SELECT 1 FROM admins WHERE username = 'admin'").get();
  if (!exists) {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    // FPK 安装向导可通过 ADMIN_PASSWORD 环境变量指定初始管理员密码
    const initialPwd = (process.env.ADMIN_PASSWORD || 'admin').trim() || 'admin';
    const hash = crypto.scryptSync(initialPwd, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    db.prepare("INSERT INTO admins (username, password_hash, salt, algo) VALUES ('admin', ?, ?, 'scrypt')").run(hash, salt);
    logger.warn('[db] default admin created (username: admin)' + (process.env.ADMIN_PASSWORD ? ' — password from ADMIN_PASSWORD env' : ' / default password: admin — please change it in admin panel'));
  }
}

/**
 * 仅在「管理员从未自己改过密码」时，才用环境变量里的初始密码覆盖。
 *
 * 原先的实现是：只要 env 里的密码与库中哈希不一致就无条件改写。而 FPK 的
 * cmd/main 每次启动都会从 ${TRIM_PKGVAR}/admin_password 读取并导出 ADMIN_PASSWORD，
 * 于是管理员在后台改完密码后，服务一重启就被静默改回安装向导里那个值。
 */
function applyAdminPasswordEnv() {
  const envPwd = (process.env.ADMIN_PASSWORD || '').trim();
  if (!envPwd || envPwd === 'admin') return;
  const changed = db.prepare("SELECT value FROM settings WHERE key = 'adminPwdChanged'").get();
  if (changed) return; // 用户已自行修改过密码，环境变量不再生效
  const row = db.prepare("SELECT salt, password_hash, algo FROM admins WHERE username = 'admin'").get();
  if (!row) return;
  const { verifyPassword, hashPassword } = require('./auth');
  if (verifyPassword(envPwd, row.salt, row.password_hash, row.algo || 'sha256')) return; // 已经一致
  const crypto = require('crypto');
  const newSalt = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE admins SET password_hash = ?, salt = ?, algo = 'scrypt' WHERE username = 'admin'")
    .run(hashPassword(envPwd, newSalt), newSalt);
  logger.warn('[db] admin password initialised from ADMIN_PASSWORD env (仅首次，之后请用后台修改)');
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { open, getDb };
