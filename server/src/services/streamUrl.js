'use strict';

/**
 * 直播源地址解析。
 *
 * 源地址以 `url|User-Agent=xxx|Referer=xxx` 形式存储（M3U 里常见）。
 * 这套解析原先在 stream.js / probe.js / recorder.js / client.js 里各写了一遍，
 * 且行为不一致（有的把键小写化、有的只认 User-Agent、有的按第一个 '=' 切分导致
 * 值里含 '=' 时被截断）。这里统一成一份实现。
 *
 * @param {string} raw
 * @returns {{url: string, headers: Record<string,string>}} headers 的键统一小写
 */
function splitStreamUrl(raw) {
  const [url, ...params] = String(raw == null ? '' : raw).split('|');
  const headers = {};
  for (const p of params) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    const v = p.slice(i + 1).trim();
    if (k) headers[k] = v;
  }
  return { url: url.trim(), headers };
}

/** 从存储形式里取 User-Agent（无则返回 null） */
function userAgentOf(raw) {
  const { headers } = splitStreamUrl(raw);
  return headers['user-agent'] || null;
}

module.exports = { splitStreamUrl, userAgentOf };
