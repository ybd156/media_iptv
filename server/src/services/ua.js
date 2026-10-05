'use strict';

/**
 * User-Agent 的统一决策。
 *
 * 背景：一个直播源最终用哪个 UA，原来在**四条路径里各写了一遍，而且规则不一样**：
 *
 *   | 路径 | 原优先级 |
 *   | --- | --- |
 *   | 服务端代理 stream.js   | ?ua > 地址内联 > 源 UA > 全局 UA |
 *   | 客户端直连 client.js   | 内联 > 源 UA > 全局 UA |
 *   | 画质探测 probe.js      | 内联 > 源 UA              ← 没有全局兜底 |
 *   | 定时录像 recorder.js   | 只看地址内联              ← 源 UA / 全局 UA 完全不生效 |
 *
 * 后果是：后台在「直播源」里填了 UA，播放正常、探测正常，**录像却 403**，
 * 而且从界面上完全看不出来 —— 用户根本不知道自己的 UA 最终在哪一层生效。
 *
 * 现在四条路径统一走 [resolveUserAgent]，并且把「最终是哪一层赢的」一起返回，
 * 后台可以直接展示出来，不用再猜。
 */

const { userAgentOf } = require('./streamUrl');

/**
 * 优先级从高到低，**数组顺序即语义，不要随意调整**。
 * 顺序变了会直接改变防盗链源的取流结果。
 */
const LAYERS = [
  { key: 'query', label: '播放地址参数 ?ua=' },
  { key: 'inline', label: '源地址内联 |User-Agent=' },
  { key: 'source', label: '直播源里填的 UA' },
  { key: 'global', label: '全局 UA（系统设置）' },
];

const norm = (v) => String(v == null ? '' : v).trim();

/**
 * 解析出最终生效的 UA。
 *
 * @param {{rawUrl?:string, sourceUa?:string, globalUa?:string, override?:string}} o
 *   rawUrl   存储形式的源地址（可能带 `|User-Agent=...|Referer=...`）
 *   sourceUa 该频道所属直播源上配置的 UA
 *   globalUa 系统设置里的全局 UA
 *   override 仅服务端代理用：请求上的 `?ua=` 覆盖
 * @returns {{ua:string, from:string, layers:Array<{key:string,label:string,value:string,used:boolean}>}}
 *   from: query | inline | source | global | none
 */
function resolveUserAgent(o = {}) {
  const values = {
    query: norm(o.override),
    inline: norm(userAgentOf(o.rawUrl)),
    source: norm(o.sourceUa),
    global: norm(o.globalUa),
  };

  let ua = '';
  let from = 'none';
  for (const { key } of LAYERS) {
    if (values[key]) {
      ua = values[key];
      from = key;
      break;
    }
  }

  return {
    ua,
    from,
    layers: LAYERS.map((l) => ({ key: l.key, label: l.label, value: values[l.key], used: l.key === from })),
  };
}

/** 系统设置里的全局 UA；读不到返回空串 */
function globalUserAgent(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'streamUserAgent'").get();
    if (!row) return '';
    try { return norm(JSON.parse(row.value)); } catch (_) { return norm(row.value); }
  } catch (_) {
    return '';
  }
}

module.exports = { resolveUserAgent, globalUserAgent, LAYERS };
