'use strict';

/**
 * XMLTV 解析 worker 线程。
 *
 * 为什么需要独立线程：原先的实现在主线程上串行做三件同步重活
 *   ① zlib.gunzipSync ② buf.toString('utf8') ③ xml2js 解析（async 默认为 false，实际全同步）
 * 实测一份 39.9MB / 2.2MB gzip / 268800 条节目的 XMLTV：
 *   事件循环被冻结 7290ms（20ms 心跳只跑了 11 次）、峰值 RSS 897MB。
 * 这 7 秒里服务端无法转发任何直播流、无法响应任何 API。
 *
 * 现在的做法：
 *   - 解析全部在 worker 线程内完成，主线程事件循环不再被冻结
 *   - 用 sax 流式解析，不构建整棵 DOM（xml2js 会为每个节点建对象，内存爆炸）
 *   - 节目按 5000 条一批回传，主线程只做批量入库，两侧内存都是常数级
 *   - 时间转换不再走 dayjs（27 万次 dayjs 调用本身就很慢），改为直接算 UTC 毫秒
 */

const { parentPort, workerData } = require('worker_threads');
const zlib = require('zlib');
const sax = require('sax');

/** 每批回传的节目数：太大则单次主线程插入停顿久，太小则消息开销高 */
const BATCH_SIZE = 5000;

const pad = (n) => (n < 10 ? '0' + n : String(n));

/**
 * XMLTV 时间戳（`YYYYMMDDHHmmss +ZZZZ`）→ 服务器本地时间的 { date, time }。
 * 无时区时按 +08:00 处理，与原 parseXmltvTime 的默认值一致。
 */
function formatLocal(str) {
  if (!str) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/.exec(String(str).trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, sign, oh, om] = m;
  let ms = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  if (Number.isNaN(ms)) return null;
  if (sign) {
    const off = (+oh * 60 + +om) * 60000;
    ms -= sign === '+' ? off : -off;
  } else {
    ms -= 8 * 3600000;
  }
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

function parse(xmlText) {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const channelMap = new Map();
    const buffer = [];
    let total = 0;

    let curChannel = null;   // 正在解析的 <channel>
    let curProgramme = null; // 正在解析的 <programme>
    let text = '';
    let capture = null;      // 'display-name' | 'title' | null

    const flush = () => {
      if (buffer.length === 0) return;
      parentPort.postMessage({ type: 'batch', programmes: buffer.splice(0, buffer.length) });
    };

    parser.onopentag = (node) => {
      const name = node.name;
      const attrs = node.attributes || {};
      if (name === 'channel') {
        curChannel = { id: attrs.id ? String(attrs.id) : '', name: '', icon: '' };
      } else if (name === 'display-name' && curChannel) {
        capture = 'display-name';
        text = '';
      } else if (name === 'icon' && curChannel) {
        if (!curChannel.icon && attrs.src) curChannel.icon = String(attrs.src);
      } else if (name === 'programme') {
        curProgramme = {
          channel: attrs.channel ? String(attrs.channel) : '',
          start: attrs.start ? String(attrs.start) : '',
          stop: attrs.stop ? String(attrs.stop) : '',
          title: '',
        };
      } else if (name === 'title' && curProgramme) {
        capture = 'title';
        text = '';
      }
    };

    parser.ontext = (t) => { if (capture) text += t; };
    parser.oncdata = (t) => { if (capture) text += t; };

    parser.onclosetag = (name) => {
      if (name === 'display-name' && curChannel) {
        if (!curChannel.name) curChannel.name = text.trim();
        capture = null;
      } else if (name === 'title' && curProgramme) {
        // 同名节目可能有多个 <title lang="..">，取第一个
        if (!curProgramme.title) curProgramme.title = text.trim();
        capture = null;
      } else if (name === 'channel' && curChannel) {
        if (curChannel.id) {
          channelMap.set(curChannel.id, {
            name: curChannel.name || curChannel.id,
            icon: curChannel.icon || '',
          });
        }
        curChannel = null;
      } else if (name === 'programme' && curProgramme) {
        const start = formatLocal(curProgramme.start);
        const end = formatLocal(curProgramme.stop);
        if (curProgramme.channel && start && end) {
          buffer.push({
            epgId: curProgramme.channel,
            date: start.date,
            start: start.time,
            end: end.time,
            title: curProgramme.title,
          });
          total++;
          if (buffer.length >= BATCH_SIZE) flush();
        }
        curProgramme = null;
      }
    };

    parser.onerror = (e) => reject(e instanceof Error ? e : new Error(String(e)));
    parser.onend = () => {
      flush();
      resolve({ channels: [...channelMap.entries()], total });
    };

    try {
      parser.write(xmlText).close();
    } catch (e) {
      reject(e);
    }
  });
}

(async () => {
  try {
    const input = Buffer.from(workerData.buffer);
    let xml;
    // gzip 魔数 1f 8b：.gz 文件或被错误声明的压缩内容统一解压（异步，走线程池）
    if (input.length > 2 && input[0] === 0x1f && input[1] === 0x8b) {
      xml = await new Promise((res, rej) => {
        zlib.gunzip(input, (e, out) => (e ? rej(e) : res(out)));
      });
    } else {
      xml = input;
    }
    const { channels, total } = await parse(xml.toString('utf8'));
    parentPort.postMessage({ type: 'channels', channels });
    parentPort.postMessage({ type: 'done', total });
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
})();
