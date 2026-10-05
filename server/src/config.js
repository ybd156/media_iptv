'use strict';

const path = require('path');

/**
 * 全局配置
 * PORT      - 服务端口，默认 9527
 * DATA_DIR  - 数据目录（sqlite / 录像 / 日志），默认 server/data
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

module.exports = {
  PORT: parseInt(process.env.PORT || '9527', 10),
  DATA_DIR,
  // 各子目录
  DB_FILE: path.join(DATA_DIR, 'iptv.db'),
  RECORD_DIR: path.join(DATA_DIR, 'records'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  // 客户端默认播放配置（可被 settings 表覆盖）
  DEFAULT_PLAYER_CONFIG: {
    engine: 'exo',
    bufferMs: 5000,
    liveOffsetMs: 3000,
    scaleMode: 'fit',
    autoStart: false,
  },
  // admin 会话有效期（毫秒）：12 小时
  ADMIN_SESSION_TTL: 12 * 60 * 60 * 1000,
};
