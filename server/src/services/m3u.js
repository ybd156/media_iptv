'use strict';

/**
 * M3U / M3U8 播放列表解析
 * 支持 #EXTINF 中的 tvg-id / tvg-logo / group-title / tvg-name 属性
 * 行格式：
 *   #EXTM3U
 *   #EXTINF:-1 tvg-id="cctv1" tvg-logo="http://..." group-title="央视",CCTV-1
 *   http://xxx/playlist.m3u8
 * 也支持管道参数：url|User-Agent=xxx（原样保留在 url 字段，播放时代理层解析）
 */

function parseAttrs(line) {
  const attrs = {};
  const re = /([a-zA-Z0-9-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

/**
 * @param {string} text M3U 文本
 * @returns {{groups: Array<{name, channels: Array}>, flat: Array}} 解析结果
 *   flat 中每个 channel: {name, epgId, logo, group, urls:[...]}
 *   同名同组的频道会合并为一个频道、多个 URL
 */
function parseM3U(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const flat = [];
  let current = null;

  const finalize = () => {
    if (current && current.urls.length > 0) {
      flat.push(current);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF:')) {
      finalize(); // 上一个频道结束
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      const meta = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
      const attrs = parseAttrs(meta);
      current = {
        name: name || attrs['tvg-name'] || 'Unknown',
        epgId: attrs['tvg-id'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '默认分组',
        urls: [],
      };
    } else if (line.startsWith('#')) {
      continue; // 其他注释行忽略
    } else {
      // 媒体地址行
      if (current) {
        current.urls.push(line);
      } else {
        flat.push({
          name: line,
          epgId: '',
          logo: '',
          group: '默认分组',
          urls: [line],
        });
      }
    }
  }
  finalize();

  // 合并开关：后台可关（关掉后订阅源里同名/同 epgId 的条目各自独立成频道）。
  // 默认合并，保持原有行为。
  const merged = (opts && opts.merge === false) ? flat : mergeChannels(flat);

  // 按分组聚合（保持出现顺序）
  const groupMap = new Map();
  for (const ch of merged) {
    if (!groupMap.has(ch.group)) groupMap.set(ch.group, []);
    groupMap.get(ch.group).push(ch);
  }
  const groups = [...groupMap.entries()].map(([name, channels]) => ({ name, channels }));

  return { groups, flat: merged };
}

/**
 * TXT 订阅格式（taoiptv/黑鸟/百川等常见）转 M3U：
 *   分组名,#genre#
 *   频道名,http://...
 * @returns {string} M3U 文本
 */
function txtToM3u(text) {
  const out = ['#EXTM3U'];
  let group = '默认分组';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/,#genre#$/i.test(line)) {
      group = line.replace(/,#genre#$/i, '').trim() || '默认分组';
      continue;
    }
    // 以协议开头的整行都当地址（"一行一个纯 URL"的列表很常见）：
    // 这种行**不能按逗号切** —— 地址的查询串里带逗号时会被切成两半，
    // 后半段过不了协议校验，整条就被静默丢掉了。
    if (/^(https?:|rtmp:|rtsp:|udp:|rtp:)/i.test(line)) {
      out.push(`#EXTINF:-1 group-title="${group.replace(/"/g, '')}",${nameFromUrl(line)}`);
      out.push(line);
      continue;
    }
    const idx = line.indexOf(',');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const url = line.slice(idx + 1).trim();
    if (!/^(https?:|rtmp:|rtsp:|udp:|rtp:)/i.test(url)) continue;
    if (!name) continue;
    out.push(`#EXTINF:-1 group-title="${group.replace(/"/g, '')}",${name}`);
    out.push(url);
  }
  return out.join('\n');
}

/**
 * 纯 URL 列表没有频道名，从地址里取一个能认出来的：路径最后一段去掉扩展名。
 * 拿不到就退回"频道"。用户可以之后在后台改名 —— 总比整条被丢掉好。
 */
function nameFromUrl(url) {
  try {
    const clean = String(url).split('?')[0].replace(/\/+$/, '');
    const seg = clean.split('/').pop() || '';
    const name = seg.replace(/\.(ts|m3u8|m3u|flv|mp4|mkv|avi|mp3|aac)$/i, '').trim();
    return name || '频道';
  } catch (_) {
    return '频道';
  }
}

/**
 * 频道名归一化 —— 用于"规则匹配是一样的就合并"。
 *
 * 同一个频道在不同订阅里写法五花八门：`CCTV-2` / `CCTV2` / `CCTV2 高清` /
 * `cctv2 HD` / `ＣＣＴＶ２`。这里统一成可比较的形式：
 *   全角转半角 → 转小写 → 去掉画质/编码/来源类标记 → 去掉所有非字母数字汉字。
 * 注意只做"明显是同一个频道"的归并，不做同义词映射（那需要频道词典，容易误合）。
 */
function normalizeChannelName(name) {
  return String(name || '')
    // 全角 → 半角
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    // 画质 / 编码 / 帧率 这类后缀
    .replace(/\b(4k|8k|uhd|fhd|hd|sd|h265|h264|hevc|avc|av3a|mcp|hdr|sdr|50fps|60fps|25fps|30fps)\b/g, '')
    // 中文常见后缀
    .replace(/(高清|超清|蓝光|标清|流畅|极速|备用|测试|线路\d*|源\d*|频道)/g, '')
    // 去掉所有非字母数字汉字（空格、横线、点、括号等）
    .replace(/[^0-9a-z\u4e00-\u9fa5]+/g, '')
    .trim();
}

/**
 * 把"其实是同一个频道"的条目并成一条，urls 累积成多条线路。
 * 导入和后台「重新整合现有频道」共用这一套规则。
 *
 * 匹配优先级（用户要求：**以 epgId 为正确的来匹配**）：
 *   1) 有 epgId 的按归一化 epgId 合并 —— 标准标识最可靠；
 *   2) **没有 epgId 的，主动归到已有 epgId 上**：归一化名字与某个 epgId 相同，
 *      或只多出一段**非数字**的描述后缀（cctv1综合 / cctv1-MCP → cctv1）。
 *      "非数字"这个限制是为了不把 CCTV10 误并进 CCTV1；后缀长度也设上限防误合；
 *   3) 剩下的按归一化名字两两合并。
 *
 * 实际数据就是这样：cctv1-MCP(无 epgId) / CCTV1综合(无 epgId) / CCTV1(epgId=CCTV1)
 * 三个必须并成一条，否则同一个频道会在列表里出现三次。
 *
 * @param {Array} list 每项 { name, epgId, logo, group, urls }
 * @returns {Array} 合并后的列表（保持首次出现顺序）
 */
function mergeChannels(list) {
  const norm = normalizeChannelName;
  const absorb = (tgt, ch) => {
    tgt.urls.push(...ch.urls);
    if (!tgt.epgId && ch.epgId) tgt.epgId = ch.epgId;
    if (!tgt.logo && ch.logo) tgt.logo = ch.logo;
    // 记下被并入的条目 id：后台「重新整合现有频道」要靠它把线路/录像挪过去
    if (ch.id != null) (tgt.mergedIds = tgt.mergedIds || []).push(ch.id);
  };
  const out = [];
  const byEpg = new Map();
  const byName = new Map();
  const leftover = [];
  for (const ch of list) {
    const epg = norm(ch.epgId || '');
    if (epg) {
      const hit = byEpg.get(epg);
      if (hit) absorb(hit, ch);
      else { byEpg.set(epg, ch); out.push(ch); }
    } else {
      leftover.push(ch);
    }
  }
  const epgKeys = [...byEpg.keys()];
  for (const ch of leftover) {
    const nn = norm(ch.name);
    let tgt = (nn && byEpg.get(nn)) || null;
    if (!tgt && nn) {
      let best = null;
      for (const k of epgKeys) {
        if (nn.length > k.length && nn.startsWith(k)) {
          const rest = nn.slice(k.length);
          // 余部**不能以数字开头**：这样 cctv10 的余部 "0" 会被拒（不并进 cctv1），
          // 而 cctv1av3a 的余部 "av3a" 以字母开头、可以并 —— 之前用"不含数字"误伤了 AV3A。
          if (rest.length <= 6 && !/^\d/.test(rest) && (!best || k.length > best.length)) best = k;
        }
      }
      if (best) tgt = byEpg.get(best);
    }
    if (!tgt && nn) tgt = byName.get(nn) || null;
    if (tgt) absorb(tgt, ch);
    else { out.push(ch); if (nn) byName.set(nn, ch); }
  }
  return out;
}

/** 判断是否为 TXT 订阅格式（而非 M3U） */
function isTxtFormat(text) {
  if (text.includes('#EXTINF')) return false;
  if (/,?#genre#/i.test(text)) return true;
  if (/^[^\n#]+,\s*(https?:|rtmp:|rtsp:|udp:)/im.test(text)) return true;
  // 一行一个纯 URL：既没有 #EXTINF 也没有"名字,地址"的分隔。
  // 不认这种格式的话，导入会解析出 0 个频道却报"导入完成"。
  return /^\s*(https?:|rtmp:|rtsp:|udp:|rtp:)\/\/\S+\s*$/im.test(text);
}

/** 解码响应/文件字节：优先 UTF-8（严格），失败回退 GBK（中文 IPTV 列表常见编码） */
function decodeBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

module.exports = { parseM3U, txtToM3u, isTxtFormat, decodeBuffer, nameFromUrl, normalizeChannelName, mergeChannels };
