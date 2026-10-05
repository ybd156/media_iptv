'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * 简单日志模块：控制台 + 文件输出
 * 文件按天滚动：DATA_DIR/logs/server-YYYY-MM-DD.log，同时维护 server.log 软副本语义
 * （Windows 上软链不方便，直接以当天日期文件写入；/admin/api/logs 读取当天文件，
 *   找不到则回退读取最近日期的文件）
 */

let logDirReady = false;
let currentDate = null;
let stream = null;

function ensureDir() {
  if (!logDirReady) {
    fs.mkdirSync(config.LOG_DIR, { recursive: true });
    logDirReady = true;
  }
}

function getStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDate || !stream) {
    if (stream) {
      try { stream.end(); } catch (_) { /* ignore */ }
    }
    currentDate = today;
    ensureDir();
    stream = fs.createWriteStream(path.join(config.LOG_DIR, `server-${today}.log`), { flags: 'a' });
  }
  return stream;
}

function write(level, args) {
  const time = new Date().toISOString();
  const msg = args
    .map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  const line = `[${time}] [${level}] ${msg}\n`;
  try {
    getStream().write(line);
  } catch (_) { /* 日志失败不影响主流程 */ }
  const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  consoleFn(line.trim());
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),

  /**
   * 读取日志尾部 n 行（供管理后台查看）。
   * 从文件末尾反向读取固定大小的块，避免把整个日志文件读进内存
   * （原先 readFileSync 整个文件再切尾部，日志涨到几十 MB 时既慢又占内存）。
   */
  tail(n = 200) {
    ensureDir();
    const files = fs.readdirSync(config.LOG_DIR)
      .filter((f) => f.startsWith('server-') && f.endsWith('.log'))
      .sort();
    if (files.length === 0) return [];
    const file = path.join(config.LOG_DIR, files[files.length - 1]);

    const MAX_BYTES = 2 * 1024 * 1024; // 最多回看末尾 2MB，足够容纳 2000 行
    let fd;
    try {
      const size = fs.statSync(file).size;
      const readBytes = Math.min(size, MAX_BYTES);
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, size - readBytes);
      let content = buf.toString('utf8');
      // 若不是从头读的，丢弃第一个不完整的行
      if (readBytes < size) {
        const nl = content.indexOf('\n');
        if (nl >= 0) content = content.slice(nl + 1);
      }
      const lines = content.split('\n').filter((l) => l.length > 0);
      return lines.slice(-n);
    } catch (e) {
      return [];
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      }
    }
  },
};
