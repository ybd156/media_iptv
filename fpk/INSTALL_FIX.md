# fpk 无法安装：根因与修复

## 结论（根因）

**不是包结构问题，是 `cmd/install_callback` 在自定义数据目录建不出来时 `exit 1`，把整个安装判成了失败。**

现场证据（本机 `/var/log/apps/mediaiptv.log` 最后一次安装尝试，2026-10-04 12:51）：

```
卸载 MediaIptv...
保留数据目录
开始安装 MediaIptv...
mkdir: cannot create directory '/vol1/1000/docker': Permission denied
无法创建数据目录 /vol1/1000/docker/mediaiptv
```

链路是这样的：

1. `wizard/install` 把数据目录的默认值硬编码成 `/vol1/1000/docker/mediaiptv`，而且是 `required: true`；
   用户一路点「下一步」就等于接受这个路径。
2. 应用按 `config/privilege` 的 `run-as: package` 以专用用户 `mediaiptv`(uid 980) 运行。
   `/vol1/1000` 是用户家目录（`stat` 为 `0 1569804232:root`），包用户既进不去也建不了父目录。
3. `cmd/install_callback` 里：

   ```bash
   mkdir -p "${wizard_data}" || { echo "无法创建数据目录 ${wizard_data}"; exit 1; }
   ```

   `exit 1` → 飞牛应用框架按非零退出码判定安装失败（见官方《应用框架》：生命周期脚本 0 成功 / 1 失败）。

也就是说：**只要用户不改默认值、或填了一个没授权给应用的目录，这个包在任何机器上都装不上。**

## 改动

| 文件 | 改动 |
| --- | --- |
| `package/cmd/install_callback` | 数据目录改为「可选、失败即回退」：路径非法/建不出来/写不进去都只告警，改用 `${TRIM_PKGVAR}/data`，`exit 0`；只有真写成功才记录 `wizard_data_path`；写测试用真建探针文件，不信 `[ -w ]` |
| `package/wizard/install` | `wizard_data` 默认值改为空、去掉 `required`、加 `placeholder` 与宽松 pattern（空值合法） |
| `package/i18n/zh-CN`、`en-US` | 说明「留空 = 用应用默认目录」「自定义目录需先在应用设置 → 访问权限里授权」 |
| `package/cmd/main` | 启动时再验一次数据目录可写，不可写就回退并写日志；导出 `PATH` |
| `package/cmd/{config,uninstall,upgrade}_callback` | 导出 `PATH`（TRIM_* 环境不带 PATH，参考飞牛官方模板 `cmd/common`） |
| `package/config/privilege` | 显式声明 `username`/`groupname` |

## 验证

### 1. 复现原始故障（旧包里的脚本）

```
$ TRIM_APPDEST=... TRIM_PKGVAR=$V wizard_data=/vol1/1000/docker/mediaiptv \
    bash /tmp/oldfpk/cmd/install_callback
开始安装 MediaIptv...
mkdir: cannot create directory '/vol1/1000/docker': Permission denied
无法创建数据目录 /vol1/1000/docker/mediaiptv
>>> 旧脚本 exit=1
```

### 2. 修复后的沙箱测试（`bash fpk/test_install_callback.sh`）

```
[1] 向导留空（推荐路径：用应用默认目录）      ✓ exit 0, 不记录 wizard_data_path
[2] 一个建不出来的 /vol 路径（原故障场景）    ✓ exit 0, 不记录, 输出「不可用」告警
[3] 合法且可写的自定义目录                    ✓ exit 0, 正确记录路径
[4] 非法路径（不在 /vol 下）                  ✓ exit 0, 回退
[5] 含 .. 的路径                              ✓ exit 0, 回退
[6] server_port / admin_password 正常写入      ✓ 权限 600
== 结果: 6 通过 / 0 失败 ==
```

### 3. 重建后的包与 payload 自检

- `fnpack build`（官方 1.0.4）成功，产物 `mediaiptv_all_v1.2.4.fpk`，96,139,646 字节，
  sha256 `6314405e14f7e4435e9f192028dafae939ef1d3705e0bb74b8fd1588ea97624c`。
- 包内 `cmd/*` 755、`manifest`/`config`/`wizard`/`i18n` 644、内层 `server/node_*` 与 `ui/index.cgi` 755。
- `manifest` 里的 `checksum` 与 `md5(app.tgz)` 一致（fnpack 自己算的，可被框架校验）。
- 从包内解出的 payload 实跑：内置 Node `v24.9.0` 启动成功，`GET /` → 302、`GET /admin/` → 200、
  `/api/client/channels` 返回 401 鉴权、SQLite 建库成功、`ADMIN_PASSWORD` 生效、SIGTERM 优雅退出。

### 4. 直接拿**发布产物**跑完整生命周期

把 `mediaiptv_all_v1.2.4.fpk` 解到模拟的 `/var/apps/mediaiptv` + `target` 布局，再用假的 `TRIM_*` 环境跑：

```
[安装] 向导留空                                   rc=0  数据目录：使用应用默认目录 .../var/data
[安装] 向导填 /vol1/1000/docker/mediaiptv（原默认值）rc=0  告警 + 回退，不记录 wizard_data_path
[启动] cmd/main start                             rc=0
[状态] cmd/main status                            rc=0  Running (PID 904552)
[访问] GET /admin/                                200
[数据] var/data 下生成 iptv.db / logos / logs / records
[停止] cmd/main stop                              rc=0；之后 status rc=3（未运行），无残留进程
```

### 5. 对抗性路径输入（全部 rc=0、全部回退、无一记录）

```
/vol1/   /vol1/..   /vol1/.   /vol1/...   /vol1//etc
/vol1/../../etc/passwd   "/vol1/x"（前导空格）   /vol1/x/../..   /vol2/@appdata/mediaiptv
```

即：路径穿越、整卷根目录、前导空格都被挡在「回退」一侧，不会写进 `wizard_data_path`。

## 备注

- 本文记录的是 `1.2.4` 上修掉安装失败的那一版；**后续版本 `1.3.0` 已包含此修复**，
  并且版本号已经提上去（`fpk/package/manifest` = 1.3.0、`server/package.json` = 1.3.0、
  Android `versionCode` = 24），见仓库根目录的 `RELEASE_1.3.0.md`。
- 本次构建是在沙箱里对 `fpk/package` 做了一份规范化副本（目录 755 / 文件 644 / 可执行位显式设置）后再跑的 `fnpack`，
  因为当前工作区挂载把源文件呈现成 mode 000，`fnpack` 复制到 /tmp 时无法写入。正常在你自己账号下执行 `build.sh` 不需要这一步。
