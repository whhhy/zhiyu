# ============================================================
# 语雀形态的公司内部知识库 —— 内网部署镜像
# ------------------------------------------------------------
# 目标：**一条命令起服务**。
#   docker build -t yuque-kb .
#   docker run -d -p 8080:8080 -v /data/yuque:/data yuque-kb
#
# ⚠️⚠️ 上面那条命令适合**本机试玩**，别直接照搬到公司内网
# ------------------------------------------------------------
# 实测（2026-10-06，起一个挂空卷的全新容器看日志）：
#   [seed] 数据库为空，正在初始化…
#   [seed] 完成：6 账号 / 2 空间 / 4 知识库 / 32 目录 / 26 文档
#   [seed] 管理员账号：admin   密码：yuque@2026
#   [seed] 上面这组是默认口令。正式使用前请设置 YQ_ADMIN_PASSWORD…
#
# 也就是说：**一个公开口令的管理员账号 + 26 篇写得很真的演示文档**，
# 而那条提示只在 `docker logs` 里 —— 不专门去看就不知道。
# 演示文档会和真实文档混在同一个工作台里，且**没有任何东西会提醒你**。
#
# 正式部署请用 `docker compose up -d`，它和上面那条命令**不是一回事**：
#
#   入口                     管理员口令              演示数据
#   docker run（就是上面那条）  yuque@2026（公开）      **会导入 26 篇**
#   docker compose up -d     占位符 → **拒绝启动**   不导入
#
# compose 里那道「拒绝启动」是刻意的：口令字面量就写在仓库里，
# 任何拿到这个项目的人都知道；给它一个能跑起来的公开口令，
# 等于把「抄了 compose 忘了改」这个低级失误直接变成一次入侵。
# 所以 compose 宁可起不来、并在日志里说清原因，也不给一个能登进去的账号。
#
# 真的想用默认口令在本机跑，显式写出来：
#   YQ_ALLOW_PLACEHOLDER_PASSWORD=1
#
# 两条入口的完整说明在 DEPLOY.md 第一节。
#
# 为什么不用多阶段 + nginx：
# node 直接托管 dist/ 就够了（vite base 用的是相对路径，任意子路径都能跑）。
# 多套一层 nginx 只会让「日志在哪看」「改配置要重启谁」变复杂 ——
# 内网运维最怕的就是这种。真的需要网关时，反代这一个端口即可。
#
# ------------------------------------------------------------
# ⚠️ 源仓库（npm registry）**必须可配置** —— 2026-10-06 实测踩到
#
# 这一份 DEPLOY 教的是**内网部署**，而内网机器连公网 npm registry
# 十有八九是连不上的（实测：容器里 `npm ci` 报
# `npm error Exit handler never called!` —— 那是 npm 拿不到包之后
# 连自己的错误处理都崩了的症状，**不是**磁盘满、也不是代码问题）。
#
# 后果很直接：`docker build` 在内网机器上失败 → 镜像出不来 →
# 照 DEPLOY 第一节抄命令的人**卡在第一步**，而报错完全指不到「网络」。
#
# 所以 registry 做成构建参数，不写死：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t yuque-kb .
# 公司有内部 npm 镜像的，把地址换成自己的即可。
# 默认值仍是公网的 registry.npmjs.org —— 那是「什么都没配」时最不意外的选择。
# ============================================================

ARG NPM_REGISTRY=https://registry.npmjs.org

# ---- 构建前端 ----
FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_REGISTRY

# ⚠️⚠️ 2026-10-08 补的：这一行之前**根本没有声明**，于是
#   `docker build --build-arg VITE_API_BASE=/knowledge -t yuque-kb .`
# 传进来的值被静默丢弃，`npm run build` 拿到的是空 —— 镜像里装的是
# **根路径产物**。而 compose 文件与 DEPLOY 都教「子路径部署要
# `VITE_API_BASE=/knowledge npm run build`」，照做的人**在 Docker 路径上
# 无论如何都拿不到子路径产物**，而症状是全站 API 404、页面整个坏掉。
#
#   实测：带 --build-arg 构建，启动日志仍打「API 前缀 = 空（同源部署）」。
#
# Docker 的 build-arg **必须在阶段里 ARG 声明**，声明在别的阶段或
# 干脆没声明，传进来也等于没传 —— 这就是为什么它能一路错到部署那天。
ARG VITE_API_BASE=

# 先只拷依赖清单，让 npm ci 这一层能被缓存住
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --registry=$NPM_REGISTRY

COPY . .
RUN npm run build

# ---- 运行时 ----
# 只装生产依赖：node:sqlite 是内置的，不需要编译任何原生模块
FROM node:22-alpine AS runtime
WORKDIR /app
ARG NPM_REGISTRY

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    YQ_DB=/data/yuque.db

# 运行时真正需要的依赖只有一个：ws。
# 前端产物与 server 源码直接从构建阶段拷过来。
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts --registry=$NPM_REGISTRY \
    || npm install --omit=dev --no-audit --no-fund ws@8 --registry=$NPM_REGISTRY

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/index.html ./index.html
COPY --from=build /app/tsconfig.json ./tsconfig.json

# 数据库挂在这里。建一个非 root 用户，别让容器以 root 跑 ——
# 内网环境被扫到时，root 容器的爆炸半径小得多。
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "./server/alias-hooks.mjs", "server/index.ts"]
