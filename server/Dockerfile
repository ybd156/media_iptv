FROM node:24-alpine

# ffmpeg 用于录制功能与组播转封装；数据库使用 Node 内置 node:sqlite，无原生模块编译依赖
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 生产模式：Express 在非 production 下会在错误响应里返回堆栈，等于把内部路径与
# 源码行号泄露给局域网内任何客户端
ENV NODE_ENV=production

# 先只拷贝依赖清单，命中缓存层；带 lockfile 用 npm ci 才能装出可复现的依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# 数据目录：sqlite 数据库、录像、日志
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

# 不要以 root 运行：node 官方镜像自带非 root 的 node 用户
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# 端口可通过 PORT 覆盖，默认 9527
EXPOSE 9527

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9527)+'/admin/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式让 node 成为 PID 1；服务端自身注册了 SIGTERM handler，
# 会先杀掉 ffmpeg 录制子进程并 checkpoint 数据库再退出
CMD ["node", "src/index.js"]
