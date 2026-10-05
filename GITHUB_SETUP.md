# 把项目放到 GitHub，并让客户端更新走 GitHub

代码侧已经改完了，这份文档是**你要做的事**。全程大约 15 分钟。

---

## 0. 先说清楚：哪些东西绝对不能进仓库

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `android/release.jks` | 已忽略（`*.jks`） | 签名密钥。**泄露 = 别人能签出可覆盖安装到你电视上的"更新包"**，而客户端还会主动提示并安装它。请自己另存一份备份 |
| `android/signing.env` | 已忽略 | 签名密码。原先明文写在 `gradle.properties` 里，已移出 |
| `tools/github.env` | 已忽略 | 发布用 token |
| `server/data/` | 已忽略 | SQLite、录像、日志（含直播源地址、UA、流签名密钥） |
| `dist/`、`fpk/.cache/`、`android/app/build/` | 已忽略 | 构建产物，能重新生成 |

建仓库后可以自查一遍：

```bash
git ls-files | grep -E '\.jks$|signing\.env|github\.env|^server/data/|^dist/'
# 应该没有任何输出
```

---

## 1. 建仓库

1. 打开 https://github.com/signup 注册（已有账号跳过）；
2. 右上角 **+ → New repository**；
3. 名字填 `mediaiptv`，选 **Private**（私有）或 **Public**（公开）都行；
   - 公开：别人能看到代码，但**看不到你的密钥**（已忽略）；
   - 私有：需要 token 才能让服务端读 Release（见第 3 步）。
4. **不要**勾选 "Add a README / .gitignore / license"（本地已有，勾了会冲突）。

建完后记下仓库地址，形如 `https://github.com/你的用户名/mediaiptv`。

---

## 2. 推代码

**这一步必须在普通终端里做**（SSH 登录 NAS，或在你自己的电脑上）。原因：DSH 沙箱
把工作区里新建的文件呈现成 mode 000，git 连自己刚写的 `.git/config` 都读不回来
（报 `could not set 'core.filemode'`，然后 `not a git repository`），所以仓库没法在沙箱里替你建。

```bash
cd "/vol1/1000/DeepSeek Harness/MediaIptv"

# 一条命令：初始化 + 安全检查 + 提交 + 推送
bash tools/git-push.sh https://github.com/你的用户名/mediaiptv.git
```

脚本会先把所有改动暂存，然后**逐项检查敏感文件有没有被带进去**（密钥、签名密码、
发布 token、数据目录、构建产物），任何一项命中就直接中止、不提交 —— 免得推上去才发现。

推送时会要求输入用户名和密码 —— **密码处要填 Personal Access Token**，不是账号密码。
token 怎么来：GitHub → 右上角头像 → Settings → Developer settings →
Personal access tokens → Tokens (classic) → Generate new token (classic)，
勾 **repo** 即可，有效期随意。

> 也可以装 GitHub CLI 走 `gh auth login`，就不用每次填 token。

想分开做也行：

```bash
bash tools/git-push.sh          # 只 init + 安全检查 + 提交（不推送）
git remote add origin https://github.com/你的用户名/mediaiptv.git
git push -u origin main
```

---

## 3. 配置服务端

1. 把新版 fpk 装到 fnOS（应用中心 → MediaIptv → 手动升级 → 选 `dist/mediaiptv_all_v1.11.16.fpk`）；
2. 打开管理后台 → **系统设置 → 客户端更新（GitHub）**：
   - **仓库 (owner/repo)**：填 `你的用户名/mediaiptv`（只填这一段，别填整条网址）；
   - **下载加速前缀**：国内建议填 `https://ghproxy.net/`（留空则用 github.com 原始地址）；
     这类公益镜像域名会变，失效时回来改这里就行；
   - **versionCode 兜底**：留空即可（发布脚本会自动写进 Release 正文）；
   - **GitHub Token**：私有仓库必须填；公开仓库一般不填也行，但**撞速率限制时（提示 HTTP 403）必须填**。
     token 需要 `repo` 权限；填过之后留空表示"不改动"。
3. 点 **保存并测试连接** —— 应显示 `✓ 读到 1.11.15（versionCode 71）` 之类的信息。

> 没填仓库时，客户端更新继续走本地上传的更新包，行为和以前完全一样。

---

## 4. 发布第一个 Release（把现有 APK 传上去）

```bash
cd "/vol1/1000/DeepSeek Harness/MediaIptv"

# 1) 填发布凭据（模板见 tools/github.env.example）
cp tools/github.env.example tools/github.env
vi tools/github.env      # 填 GITHUB_REPO 和 GITHUB_TOKEN

# 2) 先空跑看看要发什么（不会真的发请求）
bash tools/release-github.sh --dry-run

# 3) 正式发布
bash tools/release-github.sh
```

脚本会：读 `dist/` 里最新的 APK → **从 APK 里读出 versionCode** → 算 sha256 →
从 `RELEASE_NOTES.md` 取这一版的说明 → 建 Release（tag `v1.11.15`）→ 上传 APK 和 fpk。

发布成功后到仓库的 Releases 页面确认一下，正文末尾应能看到：

```
versionCode: 71
sha256: ......
```

这两行是给服务端读的，客户端不显示。

---

## 5. 以后每次发新版

```bash
# 1) 改版本号（三处，都在版本升级时一起改）
#    fpk/package/manifest        version = x.y.z
#    android/app/build.gradle.kts  versionCode = 上一个 +1
#    server/package.json          version（只有服务端有改动时才需要）
# 2) 在 RELEASE_NOTES.md 顶部加一节
# 3) 构建
bash android/build-on-nas.sh     # 打 APK
bash fpk/build.sh                # 打 fpk
# 4) 发布到 GitHub
bash tools/release-github.sh
# 5) 提交
git add -A && git commit -m "1.11.x: ..." && git push
```

电视上的客户端在下次检查更新时（启动后 / 设置页手动点）就会读到新版本。

---

## 常见问题

**Q：客户端会不会直连 GitHub？**
不会。客户端只问服务端（`/api/client/version`），服务端去读 GitHub 并缓存 30 分钟。
这是刻意的：TV/盒子在国内直连 `api.github.com` 基本不可用，会变成"检查更新经常失败"。

**Q：服务端读 GitHub 失败会怎样？**
回退到服务端本地上传的更新包；两个都没有就回"没有更新包"。
失败结果会缓存 1 分钟，不会让每个客户端请求都去等一次超时。

**Q：加速前缀填了之后，服务端自己也走加速吗？**
不是。前缀只作用于**客户端下载 APK 的地址**。服务端读版本信息走的是 `api.github.com`
（如果服务端所在网络连不上 GitHub API，需要给 NAS 配代理）。

**Q：换了签名密钥怎么办？**
签名不同的 APK 无法覆盖安装，必须先在电视上卸载旧版。所以尽量别换。

**Q：仓库里没有 `release.jks`，换台电脑怎么构建？**
把备份的 `release.jks` 放回 `android/`，并把密码写进 `android/signing.env`
（或设 `RELEASE_STORE_FILE` 指向它）。密钥不在仓库里，这是刻意的。
