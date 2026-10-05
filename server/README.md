# MediaIptv Server

私有化部署的 IPTV 直播管理服务：管理自行导入的 M3U 播放列表与 XMLTV EPG，向局域网内的 Android TV 客户端分发直播流，并提供录制回看能力。

## 功能

- M3U/M3U8 导入（自动分组、多源合并、`url|User-Agent=xxx` 参数透传）
- XMLTV EPG 源管理与同步（支持每日 06:00 自动同步）
- 客户端设备注册 / 审核 / 踢出（token 鉴权）
- 直播流代理转发（客户端不接触原始源地址，支持自定义 UA / Range 透传）
- ffmpeg 录制：全天候 / 每日定时两种模式，30 分钟自动分段，按保留天数自动清理
- 录像回看（HTTP Range 拖动进度）
- Web 管理后台（深色中文界面，单页无构建）
- SQLite 存储，无外部服务依赖

## 快速开始（本地）

要求 Node.js >= 22.13（数据库使用 Node 内置 `node:sqlite`，无需原生编译）。

```bash
cd server
npm install
npm start
```

启动后访问：

- 管理后台：http://localhost:9527/admin/
- 默认账号：`admin` / `admin`（首次启动自动创建，**请立即在 系统设置 → 修改密码 中更改**）

## Docker 部署

```bash
cd server
docker build -t media-iptv .
docker run -d \
  --name media-iptv \
  -p 9527:9527 \
  -v iptv-data:/app/data \
  --restart unless-stopped \
  media-iptv
```

- 数据卷 `/app/data` 内含 SQLite 数据库（`iptv.db`）、录像（`records/`）、日志（`logs/`）
- 镜像内已安装 ffmpeg（录制功能依赖）
- 可用环境变量：
  - `PORT`（默认 `9527`）
  - `DATA_DIR`（默认容器内 `/app/data`，本地运行时 `./data`）

## 目录结构

```
server/
├── src/
│   ├── index.js      # 入口：Express + 路由挂载 + 静态托管
│   ├── config.js     # 端口 / 数据目录配置
│   ├── db.js         # node:sqlite 建表与默认 admin
│   ├── logger.js     # 控制台 + 按天滚动文件日志
│   ├── auth.js       # admin session / client token 中间件
│   ├── routes/
│   │   ├── client.js # /api/client/*
│   │   ├── admin.js  # /admin/api/*
│   │   └── stream.js # /stream/*
│   └── services/
│       ├── m3u.js      # M3U 解析
│       ├── epg.js      # XMLTV 抓取与解析
│       ├── proxy.js    # 直播源代理转发
│       └── recorder.js # ffmpeg 录制调度
└── public/admin/index.html  # 管理后台
```

## API 摘要

### 客户端 API `/api/client`（除 register 外需 header `X-Device-Id` + `X-Token`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/register` | `{deviceId, model, androidVersion}` 注册/查询状态，approved 返回 token |
| GET | `/heartbeat` | `{status, serverTime, config}` 播放配置 |
| GET | `/channels` | 分组频道树，url 为代理地址 `/stream/live/<id>` |
| GET | `/epg?channelId=&date=` | 当日节目单，含 `hasRecord` 回看标记 |
| GET | `/catchup/days?channelId=` | 有录像的日期列表 |
| GET | `/catchup/list?channelId=&date=` | 当日录像分段及播放地址 |

统一响应 `{code, msg, data}`；`code=0` 成功，`1001` 待审核，`401` 未授权。

### 流分发 `/stream`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stream/live/:channelUrlId?t=&s=` | 代理转发直播源（透传 Range/UA，需 URL 签名） |
| GET | `/stream/record/:id?t=&s=` | 录像文件流（支持 Range 拖动，需 URL 签名） |

**流地址签名鉴权**：两条路由都需要 `?t=<过期秒>&s=<HMAC 签名>`。签名由
`/api/client/channels` 与 `/api/client/catchup/list` 随地址一起下发，绑定
`(类型, id, 过期时间)`，密钥持久化在 `settings.streamSecret`（首次启动自动生成），
因此重启后已下发的地址依然有效，有效期 7 天。播放器（ExoPlayer / ijk / 系统播放器）
无法附加自定义 header，所以签名只能走查询参数。

这样局域网内未授权的设备就无法靠枚举 id 拉走直播流与录像。如需兼容旧版客户端，
可在管理后台「系统设置 → 直播源访问 → 流地址签名鉴权」里关闭
（等价于 `settings.streamAuth = '0'`）。

### 管理 API `/admin/api`（除 login 外需 header `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/login` | `{username, password}` → `{token}` |
| GET | `/stats` | 概览统计 |
| * | `/groups`、`/channels` | 分组/频道 CRUD |
| POST | `/channels/import` | M3U 文件上传（multipart `file`）或 `{text}` |
| GET | `/channels/:id/check` | 在线检测 |
| * | `/epg/sources`、`/epg/sync`、`/epg/auto` | EPG 源/手动同步/自动同步开关 |
| * | `/devices`、`/devices/:id/approve|reject` | 设备管理 |
| * | `/record/tasks`、`/recordings` | 录制任务与录像管理 |
| GET | `/logs?tail=200` | 服务端日志 |
| GET/PUT | `/settings` | PlayerConfig 等设置 |
| POST | `/password` | 修改管理员密码 |

## 注意事项

- 录制依赖 ffmpeg，运行时自动检测（`which`/`where`）；未安装时录制功能自动降级，其余功能不受影响
- 直播源地址支持 `url|User-Agent=xxx` 形式存储 UA，代理时自动带上
- 大 M3U 导入走 JSON body（上限 50MB）或文件上传均可
- 录像保存于 `DATA_DIR/records/<channelId>/<YYYY-MM-DD>/`，每天 04:00 按任务保留天数清理
