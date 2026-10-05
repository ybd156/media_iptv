'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cron = require('node-cron');
const dayjs = require('dayjs');
const config = require('../config');
const logger = require('../logger');
const { splitStreamUrl } = require('./streamUrl');
const { resolveUserAgent, globalUserAgent } = require('./ua');

/**
 * 录制调度器
 * - mode=always: 持续录制，ffmpeg 按 30 分钟分段切片
 * - mode=daily : 每天 start_time 启动、end_time 停止
 * - 每天 04:00 按 retention_days 清理过期录像与 DB 记录
 * - ffmpeg 不存在时录制功能整体降级（日志提示，不影响其他功能）
 */

// taskId -> { proc, cronJobs: [], stopping }
const running = new Map();

let ffmpegPath = null;

function detectFfmpeg() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    ffmpegPath = r.stdout.split(/\r?\n/)[0].trim();
    logger.info(`[recorder] ffmpeg found: ${ffmpegPath}`);
  } else {
    ffmpegPath = null;
    logger.warn('[recorder] ffmpeg NOT found, recording features disabled');
  }
  return ffmpegPath;
}

function channelDir(channelId, date) {
  return path.join(config.RECORD_DIR, String(channelId), date);
}

/** 从频道取第一个 URL（解析 `url|User-Agent=xxx` 形式） */
function pickChannelUrl(db, channelId) {
  // 连 sources 一起查：原先只读地址内联的 UA，导致「源 UA / 全局 UA」对录像完全不生效 ——
  // 后台填了 UA，播放和探测都正常，录像却 403，而且界面上看不出来。
  const row = db.prepare(
    `SELECT cu.url, s.ua AS source_ua FROM channel_urls cu
     LEFT JOIN channels c ON c.id = cu.channel_id
     LEFT JOIN sources s ON s.id = c.source_id
     WHERE cu.channel_id = ? ORDER BY cu.sort, cu.id LIMIT 1`
  ).get(channelId);
  if (!row) return null;
  const { url } = splitStreamUrl(row.url);
  const ua = resolveUserAgent({
    rawUrl: row.url,
    sourceUa: row.source_ua,
    globalUa: globalUserAgent(db),
  }).ua;
  return { url, ua: ua || null };
}

/** 启动一个 ffmpeg 录制进程（always 模式用 segment muxer 自动切片） */
/**
 * 录像的视频编码模式：
 *   copy（默认）—— 原样存，零转码；
 *   hevc / h264  —— 用核显压缩（实测这台 N100 的 hevc_qsv / hevc_vaapi 都可用）。
 * 后台设置项 recordEncode 控制。
 */
function recordEncodeMode(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'recordEncode'").get();
    const v = String((row || {}).value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return ['hevc', 'h264'].includes(v) ? v : 'copy';
  } catch (_) { return 'copy'; }
}

function startFfmpeg(db, task, entry) {
  const src = pickChannelUrl(db, task.channel_id);
  if (!src) {
    logger.error(`[recorder] task ${task.id}: no url for channel ${task.channel_id}`);
    return null;
  }
  const date = dayjs().format('YYYY-MM-DD');
  const dir = channelDir(task.channel_id, date);
  fs.mkdirSync(dir, { recursive: true });

  // 分段文件名带时间戳，ffmpeg 的 strftime 展开 %Y%m%d%H%M%S
  const outPattern = path.join(dir, '%Y%m%d%H%M%S.ts');

  const args = ['-hide_banner', '-loglevel', 'warning'];
  // 同 timeshift：-reconnect* / -user_agent 只对 http(s) 有效，
  // 对 rtsp 或本地路径会让 ffmpeg 以 "Option not found" 直接退出。
  const isHttp = /^https?:\/\//i.test(src.url);
  if (isHttp) {
    // 上游返回 4xx/5xx 或网络抖动时**不要让 ffmpeg 退出**。
    // 原先只加了 -reconnect，但实测这些源会返 503 —— 一退出就落到下面
    // "10 秒后重启"，每次重启只录到不到 1 秒：结果是每 15 秒一个文件、
    // 每个文件里只有 0.8 秒内容（线上实测），录像实际上是废的，
    // 时移共用它就是黑屏。让 ffmpeg 内部重试，一次跑到底。
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '10',
      '-reconnect_on_http_error', '4xx,5xx',
      '-reconnect_on_network_error', '1'
    );
    if (src.ua) args.push('-user_agent', src.ua);
  }
  args.push(
    // 直播源的时间戳会跳（线上实测：音频 DTS 从 86400 跳回 454），
    // 而 -c copy 到 segment/HLS 封装器**要求 DTS 单调递增**，否则 mpegts 封装器
    // 直接报 "non monotonically increasing dts" 并以 code=-22 退出 ——
    // 这就是"每几秒重启一次、每片只录到一点点"的真正原因（不是网络问题，
    // 所以 -reconnect* 那套完全无效）。让 ffmpeg 忽略输入 DTS、必要时重建 PTS，
    // 并把起始时间归零，就能一次录到底。
    // 源在分片边界会**重启音频时间戳**（实测音频 DTS 从 79920 跳回 454），
    // 而 mpegts 封装器要求 DTS 单调递增，于是直接以 code=-22 退出、ffmpeg code=234。
    // +igndts 只作用于解复用器，管不住封装器 —— 真正有效的做法是**不信任源的任何时间戳**，
    // 让 ffmpeg 用墙上时钟重新生成，这样输出天然单调。
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+genpts+igndts',
    '-i', src.url,
    // 音频**不重编码**，直接 -c copy 让客户端自己解。
    // 当初改成重编码 AC3 是为了绕"音频时间戳跳导致封装器 -22 退出"，
    // 后来定位到真正的原因是下面 -reset_timestamps 那处（已去掉），
    // 既然根治了就不该让服务端白转一道 —— 而且 AV3A 这类源本来也解不了。
    ...(recordEncodeMode(db) !== 'copy' && !(entry && entry.encodeFailed)
      ? [
        // 核显压缩：N100 的 QSV。实测 hevc_qsv / hevc_vaapi 都可用
        // （应用在 fnOS 里通过 privilege 的 join-groups 拿到了 render 组权限）。
        '-init_hw_device', 'qsv=hw:/dev/dri/renderD128',
        '-c:v', recordEncodeMode(db) === 'h264' ? 'h264_qsv' : 'hevc_qsv',
        // ICQ 恒定质量：23 对电视直播基本看不出差别，体积比 copy 小一半以上
        '-global_quality', '23',
        '-preset', 'veryfast',
        // 音频始终不重编码
        '-c:a', 'copy',
      ]
      : ['-c', 'copy']),
    '-avoid_negative_ts', 'make_zero',
    '-max_interleave_delta', '0',
    '-f', 'segment',
    // 分片长度可在后台配置（分钟）。默认 30 分钟 —— 太长会让回看/时移的定位粒度变粗，
    // 太短则文件数量暴涨、扫描和清理都变慢。
    '-segment_time', String(recordSegmentSeconds(db)),
    '-segment_format', 'mpegts',
    // **不要加 -reset_timestamps 1**。它要在每个分片把时间戳重置回 0，而这个源的
    // copy 流时间戳本身就不干净（音频/视频 DTS 会倒退），一重置 mpegts 封装器就报
    // "non monotonically increasing dts" 并以 -22 退出 —— 表现为每几秒重启一次、
    // 每个文件只录到不到 1 秒。实测对照：
    //   带 reset：错误 2 处、22 秒只产出 1 个文件
    //   去掉它：  错误 0 处、22 秒产出 4 个文件（正是 -segment_time 6 应有的数量）
    // 去掉后每个分片的时间戳是连续的，回看/HLS 都能正确处理。
    '-strftime', '1',
    outPattern,
  );

  if (entry) entry.startedAt = Date.now();
  logger.info(`[recorder] task ${task.id} start ffmpeg for channel ${task.channel_id}`);
  const proc = spawn(ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => {
    const text = d.toString();
    // 后台始终能看到最近几行（不受下面节流影响）
    rememberStderr(task.id, text);
    // 日志节流：源在分片边界上会让视频 DTS 轻微回跳（实测 90kHz 下约 20ms），
    // ffmpeg 会**每帧**打一条 "Non-monotonic DTS ... changing to ..." 警告 ——
    // 这是正常的自愈行为（不是错误，ffmpeg 不再退出），但不节流会把服务端日志刷爆。
    const now = Date.now();
    if (now - (stderrLogAt.get(task.id) || 0) > 3000) {
      stderrLogAt.set(task.id, now);
      logger.warn(`[recorder] task ${task.id} ffmpeg: ${text.trim().slice(0, 300)}`);
    }
  });
  proc.on('exit', (code) => {
    logger.warn(`[recorder] task ${task.id} ffmpeg exited code=${code}`);
    // 退出原因也记进去：后台要能直接看到"为什么退出"，否则只能靠猜
    rememberStderr(task.id, `--- ffmpeg 退出 code=${code} ---`);
    const entry = running.get(task.id);
    // 开了硬件压缩但很快就退出 → 说明核显初始化没成功（驱动/权限问题）。
    // 自动退回 -c copy，**只退一次**（用 encodeFailed 标记），否则会无限失败重启。
    if (entry && !entry.stopping && !entry.encodeFailed && recordEncodeMode(db) !== 'copy'
        && Date.now() - (entry.startedAt || 0) < 20000) {
      const ran = Math.round((Date.now() - (entry.startedAt || 0)) / 1000);
      entry.encodeFailed = true;
      logger.warn(`[recorder] task ${task.id}: 硬件编码未成功（跑了 ${ran}s 就退出），自动退回 -c copy`);
      rememberStderr(task.id, '--- 硬件编码未成功，已自动退回 -c copy（本任务后续都用 copy）---');
    }
    if (entry && !entry.stopping && task.mode === 'always' && task.enabled) {
      // always 模式意外退出，2 秒后重启（原来 10 秒，等于每轮白丢 10 秒）
      logger.info(`[recorder] task ${task.id} will restart in 2s`);
      setTimeout(() => {
        const e = running.get(task.id);
        if (e && !e.stopping) {
          e.proc = startFfmpeg(db, task, e);
        }
      }, 2000);
    }
  });
  return proc;
}

function stopTask(taskId) {
  const entry = running.get(taskId);
  if (!entry) return;
  entry.stopping = true;
  for (const j of entry.cronJobs) j.stop();
  if (entry.proc) {
    try { entry.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
  running.delete(taskId);
  logger.info(`[recorder] task ${taskId} stopped`);
}

/** 录像分片长度（秒）：读设置 recordSegmentMin，缺省 30 分钟 */
function recordSegmentSeconds(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'recordSegmentMin'").get();
    const v = parseInt(String((row || {}).value || '').replace(/^"|"$/g, ''), 10);
    if (Number.isFinite(v) && v >= 1 && v <= 720) return v * 60;
  } catch (_) { /* 用默认 */ }
  return 30 * 60;
}

/**
 * 每个任务最近几行 ffmpeg 输出。
 * 录像"每 N 秒就重启、每片只录到一点点"这种问题，根因全在 ffmpeg 的退出原因里，
 * 而这些信息原来只写服务端日志 —— 后台看不到就只能猜。这里留一份给后台显示。
 */
const stderrTail = new Map();
/** 日志节流用的时间戳（每个任务上一次记日志的时间） */
const stderrLogAt = new Map();
function rememberStderr(taskId, text) {
  const lines = String(text).split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return;
  stderrTail.set(taskId, (stderrTail.get(taskId) || []).concat(lines).slice(-12));
}
function lastStderr(taskId) { return stderrTail.get(taskId) || []; }

function startTask(db, task) {
  stopTask(task.id); // 幂等：先停旧的
  if (!ffmpegPath) {
    logger.warn(`[recorder] task ${task.id} skipped: ffmpeg unavailable`);
    return;
  }
  const entry = { proc: null, cronJobs: [], stopping: false };
  running.set(task.id, entry);

  if (task.mode === 'always') {
    entry.proc = startFfmpeg(db, task, entry);
  } else if (task.mode === 'daily') {
    // start_time / end_time 形如 "HH:mm"
    const [sh, sm] = (task.start_time || '00:00').split(':');
    const [eh, em] = (task.end_time || '23:59').split(':');
    const startJob = cron.schedule(`${parseInt(sm, 10)} ${parseInt(sh, 10)} * * *`, () => {
      const e = running.get(task.id);
      if (e && !e.stopping) e.proc = startFfmpeg(db, task);
    });
    const stopJob = cron.schedule(`${parseInt(em, 10)} ${parseInt(eh, 10)} * * *`, () => {
      const e = running.get(task.id);
      if (e && e.proc) {
        try { e.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
        e.proc = null;
      }
    });
    entry.cronJobs.push(startJob, stopJob);
    // 如果当前时间已在录制窗口内，立即启动
    const now = dayjs();
    const start = dayjs(`${now.format('YYYY-MM-DD')} ${task.start_time}`, 'YYYY-MM-DD HH:mm');
    const end = dayjs(`${now.format('YYYY-MM-DD')} ${task.end_time}`, 'YYYY-MM-DD HH:mm');
    if (now.isAfter(start) && now.isBefore(end)) {
      entry.proc = startFfmpeg(db, task);
    }
  }
  logger.info(`[recorder] task ${task.id} started (mode=${task.mode})`);
}

/** 服务启动时恢复所有 enabled 任务 */
function restoreTasks(db) {
  if (!ffmpegPath) return;
  const tasks = db.prepare('SELECT * FROM record_tasks WHERE enabled = 1').all();
  for (const t of tasks) startTask(db, t);
  logger.info(`[recorder] restored ${tasks.length} enabled record tasks`);
}

/** 扫描录像目录，把新分段登记进 recordings 表（ffmpeg 分段文件名即开始时间） */
function scanSegments(db) {
  if (!fs.existsSync(config.RECORD_DIR)) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO recordings (channel_id, date, file, start, end, status)
     VALUES (?, ?, ?, ?, ?, 'ok')`
  );
  const updateEnd = db.prepare('UPDATE recordings SET end = ? WHERE file = ?');
  const existsStmt = db.prepare('SELECT id, end FROM recordings WHERE file = ?');
  /** 刚写完、可以预热切片索引的分片（见函数末尾） */
  const warmCandidates = [];

  // 目录层级用 withFileTypes 判断，省掉每个目录一次 statSync
  let channelEntries;
  try { channelEntries = fs.readdirSync(config.RECORD_DIR, { withFileTypes: true }); } catch (_) { return; }
  for (const chEnt of channelEntries) {
    if (!chEnt.isDirectory()) continue;
    const ch = chEnt.name;
    const chPath = path.join(config.RECORD_DIR, ch);
    const channelId = parseInt(ch, 10);
    if (Number.isNaN(channelId)) continue;
    let dateEntries;
    try { dateEntries = fs.readdirSync(chPath, { withFileTypes: true }); } catch (_) { continue; }
    for (const dEnt of dateEntries) {
      if (!dEnt.isDirectory()) continue;
      const dateDir = dEnt.name;
      const dPath = path.join(chPath, dateDir);
      for (const f of fs.readdirSync(dPath)) {
        if (!f.endsWith('.ts')) continue;
        const full = path.join(dPath, f);
        const m = f.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.ts$/);
        if (!m) continue;
        const startStr = `${m[4]}:${m[5]}:${m[6]}`;
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        // 顺手把"刚写完"的分片排进切片索引队列：时移/回看用它的关键帧索引
        // 把 300 秒的大分片切成 10 秒小块。索引很贵（ffprobe 扫 200MB ≈ 0.45s），
        // 放在这里预热，用户进时移时就不用等。范围取最近 2 小时（默认时移窗口），
        // 更早的分片由时移请求按需排队；索引会落盘，所以每个文件只扫一次。
        //
        // 10 秒（原 30 秒）：分片由 ffmpeg 的 segment 封装器写完即关闭，mtime 立刻稳定，
        // 不需要等半分钟"确认写完"。等 30 秒的代价是**这 30 秒内点回看的人**
        // 要现场冷扫一次（线上实测到 486ms 的 index.m3u8 请求）。
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 10_000 && ageMs < 2 * 3600 * 1000) warmCandidates.push(full);
        const endDate = dayjs(stat.mtime);
        const endStr = endDate.format('HH:mm:ss');
        // 统一正斜杠存储，保证 Windows/Linux 路径一致、去重生效
        const relFile = path.relative(config.RECORD_DIR, full).split(path.sep).join('/');
        const existing = existsStmt.get(relFile);
        if (!existing) {
          insert.run(channelId, dateDir, relFile, startStr, endStr);
        } else {
          // 分段仍在增长时刷新 end
          updateEnd.run(endStr, relFile);
        }
      }
    }
  }
  if (warmCandidates.length) {
    try { require('./recordIndex').warm(warmCandidates); } catch (_) { /* 预热失败不影响扫描 */ }
  }
}

/** 清理过期录像与 DB 记录 */
function cleanup(db) {
  const tasks = db.prepare('SELECT DISTINCT channel_id, retention_days FROM record_tasks').all();
  const delStmt = db.prepare('DELETE FROM recordings WHERE id = ?');
  const defaultRetention = 7;
  const cutoffMap = new Map();
  for (const t of tasks) {
    const days = t.retention_days || defaultRetention;
    const cutoff = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    // 同一频道多任务取最长的保留期
    if (!cutoffMap.has(t.channel_id) || cutoffMap.get(t.channel_id) < cutoff) {
      cutoffMap.set(t.channel_id, cutoff);
    }
  }
  // 频道已从 channels 表消失（订阅刷新后不再存在 / 手动删除）时，其录像在 App 里
  // 已无任何入口可以访问（/catchup/* 都按 channel_id 查）。这类孤儿录像原先因为
  // cutoffMap 里没有对应条目而被永久跳过，只会一直占盘，这里按默认保留期回收。
  const liveChannels = new Set(db.prepare('SELECT id FROM channels').all().map((r) => r.id));
  const orphanCutoff = dayjs().subtract(defaultRetention, 'day').format('YYYY-MM-DD');

  let removedFiles = 0;
  let removedRows = 0;
  let removedOrphans = 0;
  const rows = db.prepare('SELECT id, channel_id, date, file FROM recordings').all();
  for (const r of rows) {
    let cutoff = cutoffMap.get(r.channel_id);
    let orphan = false;
    if (!cutoff) {
      // 频道还在，只是没配录制任务 —— 保持原行为，不自动清理
      if (liveChannels.has(r.channel_id)) continue;
      cutoff = orphanCutoff;
      orphan = true;
    }
    if (r.date < cutoff) {
      const full = path.join(config.RECORD_DIR, r.file);
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
        removedFiles++;
        if (orphan) removedOrphans++;
      } catch (e) {
        logger.error(`[recorder] cleanup unlink failed ${full}: ${e.message}`);
      }
      delStmt.run(r.id);
      removedRows++;
    }
  }
  // 清理空目录
  if (fs.existsSync(config.RECORD_DIR)) {
    for (const ch of fs.readdirSync(config.RECORD_DIR)) {
      const chPath = path.join(config.RECORD_DIR, ch);
      if (!fs.statSync(chPath).isDirectory()) continue;
      for (const d of fs.readdirSync(chPath)) {
        const dPath = path.join(chPath, d);
        if (fs.statSync(dPath).isDirectory() && fs.readdirSync(dPath).length === 0) {
          fs.rmdirSync(dPath);
        }
      }
    }
  }
  logger.info(`[recorder] cleanup done: ${removedFiles} files, ${removedRows} db rows removed (含孤儿频道录像 ${removedOrphans})`);
}

/** 初始化：检测 ffmpeg、恢复任务、注册周期任务 */
function init(db) {
  detectFfmpeg();
  restoreTasks(db);
  // 每 2 分钟扫描一次分段文件，登记到 recordings
  cron.schedule('*/2 * * * *', () => {
    try { scanSegments(db); } catch (e) { logger.error(`[recorder] scanSegments error: ${e.message}`); }
  });
  // 每天 04:00 清理过期录像
  cron.schedule('0 4 * * *', () => {
    try { cleanup(db); } catch (e) { logger.error(`[recorder] cleanup error: ${e.message}`); }
  });
}

// pickChannelUrl 一并导出：它是「录像实际用哪个 UA」的唯一入口，
// 导出后既便于测试，也能给后台的 UA 诊断复用。
module.exports = { init, startTask, stopTask, detectFfmpeg, scanSegments, cleanup, running, pickChannelUrl, lastStderr };
