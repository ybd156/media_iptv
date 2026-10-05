'use strict';

const axios = require('axios');
const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../logger');

/**
 * XMLTV EPG 抓取与解析。
 *
 * 解析放在 worker 线程里（见 epgWorker.js）：原先的实现在主线程上串行做
 * gunzipSync + toString + xml2js 全同步解析，实测 27 万条节目会把事件循环
 * 冻结 7.3 秒、峰值内存 897MB —— 期间所有直播流转发中断。
 *
 * 标准 XMLTV 结构：
 * <tv>
 *   <channel id="cctv1"><display-name>CCTV-1</display-name></channel>
 *   <programme start="20240101080000 +0800" stop="..." channel="cctv1"><title>...</title></programme>
 * </tv>
 */

const WORKER_FILE = path.join(__dirname, 'epgWorker.js');

/**
 * 拉取 XMLTV 原始字节（不解压、不转字符串，交给 worker 处理）。
 * 按二进制拉取：.xml.gz 文件以 gzip 文件形式传输（非 HTTP content-encoding），
 * axios 不会自动解压。
 * @returns {Promise<Buffer>}
 */
async function fetchEpg(url) {
  logger.info(`[epg] fetching ${url}`);
  const resp = await axios.get(url, {
    timeout: 60000,
    responseType: 'arraybuffer',
    maxContentLength: 512 * 1024 * 1024,
    headers: {
      'User-Agent': 'MediaIptv-EPG-Fetcher/1.0',
      'Accept-Encoding': 'identity', // 禁用传输层压缩，自己判断文件格式
    },
  });
  return Buffer.from(resp.data);
}

/**
 * 在 worker 线程里流式解析 XMLTV，节目按批回调。
 *
 * @param {Buffer} buffer 原始字节（gzip 或明文）
 * @param {(programmes: Array<{epgId,date,start,end,title}>) => void} onBatch
 *        每约 5000 条节目回调一次。回调在主线程同步执行，应尽快完成（例如一次批量入库）。
 * @returns {Promise<{channelMap: Map<string,{name:string,icon:string}>, programmes: number}>}
 */
function parseXmltv(buffer, onBatch) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, { workerData: { buffer } });
    let total = 0;
    let channelMap = new Map();
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    worker.on('message', (msg) => {
      if (msg.type === 'batch') {
        try {
          onBatch(msg.programmes);
        } catch (e) {
          settle(reject, e);
          worker.terminate();
        }
      } else if (msg.type === 'channels') {
        channelMap = new Map(msg.channels);
      } else if (msg.type === 'done') {
        total = msg.total;
      } else if (msg.type === 'error') {
        settle(reject, new Error(msg.message));
        worker.terminate();
      }
    });

    worker.on('error', (e) => settle(reject, e));
    worker.on('exit', (code) => {
      if (code !== 0) settle(reject, new Error(`epg worker 异常退出（code=${code}）`));
      else settle(resolve, { channelMap, programmes: total });
    });
  });
}

module.exports = { fetchEpg, parseXmltv };
