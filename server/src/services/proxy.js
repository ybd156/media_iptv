'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');
const logger = require('../logger');

/**
 * 组播源（rtp:// / udp://）通过 ffmpeg 拉流并转封装为 MPEG-TS over HTTP。
 * 客户端播放器只需支持 TS 流即可，无需原生组播支持。
 * ffmpeg 不存在时返回 503，不影响其他源。
 */
let ffmpegPath = null;
function detectFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      ffmpegPath = r.stdout.split(/\r?\n/)[0].trim();
      logger.info(`[proxy] ffmpeg found for multicast: ${ffmpegPath}`);
    } else {
      ffmpegPath = false;
    }
  } catch {
    ffmpegPath = false;
  }
  return ffmpegPath;
}

function pipeMulticast(url, req, res) {
  const ff = detectFfmpeg();
  if (!ff) {
    res.status(503).json({ code: 503, msg: 'ffmpeg 未安装，无法转换组播源', data: null });
    return;
  }
  // -c copy 零转码只换容器，CPU 占用极低；nobuffer/low_delay 压低延迟
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer+discardcorrupt',
    '-flags', 'low_delay',
    '-analyzeduration', '500000',
    '-probesize', '1000000',
    '-i', url,
    '-c', 'copy',
    '-f', 'mpegts',
    'pipe:1',
  ];
  logger.info(`[proxy] multicast via ffmpeg: ${url}`);
  const proc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  proc.stdout.pipe(res);

  let errBuf = '';
  proc.stderr.on('data', (d) => { errBuf += d.toString(); if (errBuf.length > 4096) errBuf = errBuf.slice(-4096); });

  const kill = (reason) => {
    logger.info(`[proxy] multicast ffmpeg kill (${reason}): ${url}`);
    try { proc.kill('SIGKILL'); } catch {}
    req.off('close', onClose);
    res.off('close', onClose);
  };
  const onClose = () => kill('client closed');
  req.on('close', onClose);
  res.on('close', onClose);

  proc.on('error', (e) => {
    logger.error(`[proxy] multicast ffmpeg spawn error: ${e.message}`);
    if (!res.headersSent) res.status(502).json({ code: 502, msg: `ffmpeg error: ${e.message}`, data: null });
    kill('spawn error');
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      logger.error(`[proxy] multicast ffmpeg exited code=${code}: ${errBuf.trim()}`);
    }
    if (!res.writableEnded) res.end();
  });
}

/**
 * 直播源 HTTP(S) 代理转发（原生 http/https 零拷贝流式转发）
 * 替代 axios，消除中间缓冲层，降低延迟与 CPU 占用。
 * 支持透传 Range / User-Agent；客户端断开时立即中止上游 socket。
 */

function pipeUpstream(url, req, res, extraHeaders = {}) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {
    ...(req.headers.range ? { Range: req.headers.range } : {}),
    ...(req.headers['user-agent'] ? { 'User-Agent': req.headers['user-agent'] } : {}),
    ...extraHeaders,
    Accept: '*/*',
    Connection: 'keep-alive',
  };

  // 移除 hop-by-hop 头，避免破坏分块传输
  delete headers.host;
  delete headers.connection;
  delete headers['proxy-connection'];

  const upstreamReq = lib.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout: 15000,
    },
    (upstreamRes) => {
      // 透传状态码
      res.statusCode = upstreamRes.statusCode || 200;

      // 透传关键响应头
      const pass = [
        'content-type', 'content-length', 'content-range', 'accept-ranges',
        'cache-control', 'etag', 'last-modified', 'transfer-encoding',
      ];
      for (const k of pass) {
        const v = upstreamRes.headers[k];
        if (v !== undefined) res.setHeader(k, v);
      }

      upstreamRes.pipe(res);

      upstreamRes.on('error', (err) => {
        logger.error(`[proxy] upstream response error for ${url}: ${err.message}`);
        if (!res.writableEnded) res.end();
      });
    }
  );

  upstreamReq.on('error', (err) => {
    logger.error(`[proxy] upstream request error for ${url}: ${err.message}`);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 502, msg: `Upstream error: ${err.message}`, data: null }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  upstreamReq.on('timeout', () => {
    logger.warn(`[proxy] upstream timeout for ${url}`);
    upstreamReq.destroy();
    if (!res.headersSent) {
      res.statusCode = 504;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 504, msg: 'Upstream timeout', data: null }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  // 客户端断开时立即关闭上游 socket，避免僵尸连接
  const onClientClose = () => {
    logger.info(`[proxy] client closed, destroy upstream for ${url}`);
    upstreamReq.destroy();
    req.off('close', onClientClose);
    res.off('close', onClientClose);
  };
  req.on('close', onClientClose);
  res.on('close', onClientClose);

  upstreamReq.end();
}

module.exports = { pipeUpstream, pipeMulticast, detectFfmpeg };
