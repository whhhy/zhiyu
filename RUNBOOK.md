# 部署手册（内网）

> 这份是**新写的、未经那次 GBK 事故损坏**的部署步骤。
> `README.md` / `DEPLOY.md` 在 2026-10-05 被 `Set-Content` 按系统 ANSI（GBK）读坏过，
> 两份都还有乱码残留 —— 拿到完好版本后应当以它们为准，本文件可以退役。

---

## 1. 最短路径：几个环境变量 + 一条命令

**不需要 Docker。** 一个 Node 进程 + 一个数据目录就是完整部署。

```bash
# 1. 先构建前端产物（dist/）
npm run build

# 2. 设这几个变量
export PORT=8090
export YQ_DB=/var/lib/yuque/yuque.db     # 数据文件；目录要存在
export YQ_ADMIN_PASSWORD='你自己的口令' # 至少 8 位，含字母和数字
# 公司首次部署**必须**加这一行：空库时不要播演示内容
export YQ_DEMO=0

# 3. 起服务
node --import ./server/alias-hooks.mjs server/index.ts
```

起来之后本机访问 `http://<服务器内网IP>:8090`。
`HOST` 默认就是 `0.0.0.0`，**不用设**就已经对局域网开放。

---

## 2. 环境变量（每一条都对着源码核过）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。默认即局域网可达 |
| `YQ_DB` | `data/yuque.db` | SQLite 文件路径 |
| `YQ_ADMIN_ACCOUNT` | `admin` | **首次播种**时的管理员账号 |
| `YQ_ADMIN_PASSWORD` | `yuque@2026` | **首次播种**时的管理员口令 |
| `YQ_ADMIN_NAME` | `管理员` | 管理员显示名 |
| `YQ_DEMO` | 不设 = 播演示数据 | **`YQ_DEMO=0` = 播一个干净的空库**（公司首次部署用这个） |
| `YQ_TRASH_DAYS` | `30` | 回收站保留天数，0 = 不自动清除 |
| `YQ_SSO_HEADER` | 空 | 统一认证的用户头，如 `X-Forwarded-User`；留空 = 不启用 |
| `YQ_SSO_NAME_HEADER` / `YQ_SSO_EMAIL_HEADER` | 空 | 显示名 / 邮箱头 |
| `YQ_SSO_ONLY` | 空 | 设 `1` 则**只允许统一认证**，禁用本地注册与口令登录 |
| `YQ_TRUSTED_PROXY_IPS` | 空 | 逗号分隔；只有这些来源的请求才认网关认证头 |
| `YQ_TRUST_PROXY` | — | 设 `0` 一律不信任代理头 |
| `YQ_ALLOW_PLACEHOLDER_PASSWORD` | 空 | 仅本机试验用；设 `1` 才允许占位符口令启动 |

---

## 3. 首次部署 vs 已有数据

- **首次**：`YQ_DB` 指向的库**不存在或为空** → 服务端会自动播种。播什么**由 `YQ_DEMO` 决定**（实测值，2026-10-12）：

  | `YQ_DEMO` | 账号 | 空间 | 知识库 | 文稿 |
  |---|---|---|---|---|
  | 不设（默认值） | **6** | 2 | **4** | **26** |
  | `0` | 1 | 1（管理员的个人空间） | 0 | 0 |

  默认那一行意味着：照着第 1 节抄，公司内网的知识库会**自带**
  《产品手册》《技术文档大本营》《团队手册》《读书笔记》四个演示库、26 篇文档，
  外加 **5 个你没有创建过的账号**。**公司首次部署请设 `YQ_DEMO=0`。**
  （想先看看它长什么样再部署，本机试验时把这一行去掉即可。）
- **已有**：库非空 → **跳过播种**，直接用现有数据；此时 `YQ_ADMIN_PASSWORD` 不生效
  （口令早已在库里定死，要改请登录后在设置里改）。

> ⚠️ `YQ_ADMIN_PASSWORD` **只在播种那一次**起作用。
> 拿它去「改已有库的口令」是无效的 —— 那一版是给空库用的。

---

## 4. 口令这道门

口令还等于 `docker-compose.yml` 里那个占位符字面量时，**服务端拒绝启动**并直接告诉你。
这是刻意的：那个字面量写在仓库里，等于没有口令。

---

## 5. 挂在子路径下（nginx 反代到 `/knowledge/`）

前端产物里的 API 前缀是**构建时**烧进去的，服务端不会替你补：

```bash
VITE_API_BASE=/knowledge npm run build
```

不重建而直接挂子路径的症状是**全站 API 404**（服务端启动日志里也会提醒）。

### nginx 配置

> 下面这段是**真跑过**的：nginx 容器 → `/knowledge/` → 应用，真浏览器登录、
> 建库、写文档、再回后端库里查出来，11 项全过（2026-10-12 验）。
> 之前这段配置只存在于 `DEPLOY.md` 第四节，而那份文件是损坏的 ——
> 也就是说**唯一的反代说明在一份读不出来的手册里**。
> 把 `yuque:8080` 换成你的后端地址；容器部署时用 compose 里的服务名。

```nginx
server {
    listen 80;
    server_name _;

    # ① 挂载前缀。它必须与构建时的 VITE_API_BASE **完全一致**。
    location /knowledge/ {
        # ⚠️ 结尾那个 `/` 是关键：它把 /knowledge/ 前缀**剥掉**再转给后端。
        # 写成 `proxy_pass http://yuque:8080;`（不带尾斜杠）就会把
        # /knowledge/api/... 原样发过去 → 全站 API 404。
        proxy_pass http://host.docker.internal:8094/;

        proxy_set_header Host              $host;
        # 这两行不写，clientIp() 拿到的是**反代自己的地址** →
        # IP 白名单按 127.0.0.1 判，水印上的「阅读人 IP」也全是 127.0.0.1。
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ② 协作 WebSocket。少这几行，跨设备实时协作连不上。
        location /knowledge/ws {
            proxy_pass http://host.docker.internal:8094/ws;
            proxy_http_version 1.1;
            proxy_set_header Upgrade    $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            # 协作连接是长连接：默认 60s 读超时会把**正在打字的人**踢下线，
            # 症状是「明明在同一个文档里，改动过一会儿就不推了」。
            proxy_read_timeout 3600s;
        }

        # ③ 附件上传大小。nginx 默认 1m，超过 1MB 的附件会 413，
        # 而应用侧完全看不出原因（只显示「上传失败」）。
        client_max_body_size 100m;
        proxy_read_timeout 300s;
    }

    # ④ 不带斜杠的 /knowledge 要跳过去
    location = /knowledge { return 301 /knowledge/; }
}
```

三处最容易踩的地方，配置里都标了：

| 症状 | 原因 |
|---|---|
| 全站 API 404 | `proxy_pass` 结尾**少了那个 `/`**，前缀没被剥掉 |
| IP 白名单按 `127.0.0.1` 判、水印上的 IP 全是 `127.0.0.1` | 少传 `X-Forwarded-For` |
| 同一个人开两个浏览器没问题，**换台电脑就不动** | 少配 `/ws` 的 `Upgrade`/`Connection` |
| 明明在同一个文档里，改动过一会儿就不推了 | `/ws` 少了 `proxy_read_timeout`，长连接被 60s 掐断 |
| 附件上传失败（超过 1MB） | nginx 默认 `client_max_body_size 1m` |
| 点「复制内容」/「复制链接」没反应，粘出来是空的 | 走的是 **HTTP**，浏览器不给 `navigator.clipboard`（见下一节） |

### 5.1 内网 HTTPS —— 剪贴板需要它

**实测（2026-10-19，`http://192.168.1.16:8080`）：**

```
isSecureContext: false
navigator.clipboard: undefined
```

浏览器**只在安全上下文**里提供 `navigator.clipboard` —— 也就是 `https://`
或者 `http://localhost`。上面那段 nginx 配置 `listen 80`，
所以内网走 **HTTP** 时：

- 「复制内容」「复制链接」「复制标题」「复制密文」**只能复制纯文本**，
  代码块/表格/卡片这些**结构带不走**；
- 应用会**如实提示**「当前是 HTTP 访问，浏览器不给用新剪贴板接口」——
  不会静默失败（那才是最难查的：菜单照关、剪贴板是空的、什么提示都没有）。

⚠️ **最容易误判的一点**：`localhost` 是安全上下文。
所以「在我电脑上（`http://localhost:8080`）复制好好的，部署到内网就不行了」
—— 同一份代码、同一个浏览器，只是 origin 变了。

**要完整功能就给 nginx 配 TLS**（内网自签证书也行，浏览器信任后即可）：

```nginx
server {
    listen 443 ssl;
    server_name kb.corp.example;
    ssl_certificate     /etc/nginx/certs/kb.crt;
    ssl_certificate_key /etc/nginx/certs/kb.key;
    location /knowledge/ { ...同上面那段... }
}
# 80 端口只做跳转
server {
    listen 80;
    server_name kb.corp.example;
    return 301 https://$host$request_uri;
}
```

**不配 TLS 也能用**：应用会自动降级到 `execCommand('copy')`，
纯文本照样能复制，只是块结构带不走。
选择权在你，但要**知道**这个差异 —— 演示时「复制一个表格粘出来是散掉的文字」，
很容易被当成功能坏了。

---

## 6. 反向代理注意

- 开了统一认证时，**必须**用防火墙保证这个服务不能被直连 ——
  能直连就等于任何人都能伪造 `X-Forwarded-User` 登录进来。
- 配了反代还要设 `YQ_TRUSTED_PROXY_IPS`（只信这些来源 IP 发来的头）。
  **配错的后果分两种，别当成一种去查：**

  | 你开没开统一认证 | 配错的后果 |
  |---|---|
  | 没开（口令登录） | **登录照常**，但客户端 IP 全部变成**反代的地址** —— IP 白名单要按那个地址填，水印上的「阅读人 IP」也全是它 |
  | 开了 `YQ_SSO_HEADER` | **谁也登不进来**：这个头被当成没传，而登录页不会告诉你原因（只一直转圈） |

  实测（2026-10-12）：把它配成一个不包含客户端的地址之后，口令登录**照样拿到令牌** ——
  因为口令登录不看这个头，它只管 `X-Forwarded-For` 与统一认证那两个头的信任。

  配错**不会**变成绕过（那是这份清单存在的理由），只可能变成上面两种之一。

---

## 7. 备份（不停服）

```bash
node scripts/backup.mjs /backup
```

**别用 `sqlite3 ... .backup`**：容器镜像里没有 sqlite3 命令行，
而在 cron 里失败是**静默**的 —— 每日备份看起来一直在跑，其实一个文件都没有。
这个脚本用 Node 22 内置的 `node:sqlite`，零新依赖。
退出码非 0 时 cron 能看见。

### 恢复演练（2026-10-15 起已自动验）

脚本跑完会打印一行「恢复演练：把这个文件放到数据目录的 yuque.db
（**连同 -wal/-shm 一起删掉**），再起服务」。
**这一步现在每一轮全量回归都会真跑**（`npm run test:backup`）：

起一个实例 → 写一条专用数据 → 热备（不停服）→ 停服 →
拿备份文件起一个新实例 → 登录 → 那条数据还在 → **还能继续写**。

**为什么强调「连同 -wal/-shm 一起删掉」**：SQLite 会优先读同名 `-wal`，
留着它就等于没恢复 —— 而**看起来是成功的**，数据却是旧的。
这条以前只有一句叮嘱，没人真做过，所以谁也不知道它是不是真的必要；
现在它被钉住了。

> 备份做得再漂亮，恢复不出来就等于没备份。
> 上面那 6 条查的是「备份文件能用」，最后这 7 条查的是「**它救得回一个实例**」。

---

## 8. 部署验收（默认走 Docker；加 YQ_ACCEPT_NO_DOCKER=1 可只用 node 直起）

```bash
YQ_ACCEPT_NO_DOCKER=1 npm run test:deploy-accept
```

node 直起的这一套**已经并进 `npm run test:all`**（走 `SUITE_ENV` 里的
`YQ_ACCEPT_NO_DOCKER=1`，端口固定 8180，与运行器自己那个错开）。
也就是说**每次全量回归都会自动验一遍**这一条，不再需要单独跑。

只有在**要验 Docker 那条交付形态**时才单独跑：

```bash
npm run test:deploy-accept        # 默认：docker compose，37 项
YQ_ACCEPT_NO_DOCKER=1 npm run test:deploy-accept   # node 直起，29 项
```

⚠️ 那个端口是**这个套件自己起服务**占的：撞上别人的服务时它会**对着别人的实例跑**，
而「连不上」和「测试失败」在输出里长得很像 —— 换端口用 `YQ_ACCEPT_PORT`。

验的是「公司部署第一天」：干净空库、口令能登录、
**空库里普通同事能建出第一条知识库**、空库没有编造的团队动态、
**同事真写一篇文档、换个会话（≈换设备）重开还在**、静态资源发得出去、
**重建容器之后那篇文档还在**（最后这条只在 Docker 那条路上验）。

⚠️ 加粗那最后一条最容易漏，而它恰恰是最要命的：前面几步全是**只读**的
（起得来、登得进、界面不编造），而「起得来但写不进去 / 写进去存不住」
这类缺陷它们**一条都抓不到**，报告还全绿 ——
运维当天看不出任何问题，同事第二天才发现「我写的文档刷新就没了」。
所以这一步全程走**界面真打字**，最后**换一个全新会话**重开：
刷新一次只能证明没丢内存，换会话才证明真落到了服务端。

默认（不带 `YQ_ACCEPT_NO_DOCKER=1`）走 `docker compose`，验的是交付形态。

---

## 9. 升级

```bash
npm run build          # 重新构建 dist/
# 停掉旧进程 → 用同样的环境变量起新进程
```

**没有需要手动跑的迁移脚本。** 表结构在**启动时自动补齐**：
`server/db.ts` 里是一串幂等的 `ALTER TABLE … ADD COLUMN`（读 `PRAGMA table_info`，
补过就跳过），新版本第一次启动就把新列加上。所以升级只要**重启进程**。

⚠️ **必须重启，不能只 `npm run build`**：不重启就继续跑旧进程，
新代码访问新列时会在**毫不相关的操作**上炸 `no such column`，
而那个报错与「这次升级」毫无关系（这正是当初把补列做成自动的原因）。
比如不加 `blockSearch` 那一列时，症状是「升级之后一改知识库设置就 500」，
而报错出现在一个跟版本八竿子打不着的操作上。

数据在 `YQ_DB` 指向的文件里，升级**不删不改**它；只是**表结构会被扩展**
（多几列，老数据本身不动）。升级前建议先按第 7 节备一份。

---

## 10. 常见坑

| 症状 | 原因 |
|---|---|
| 起不来，提示口令是占位符 | `YQ_ADMIN_PASSWORD` 还等于 compose 里那个字面量 |
| 改环境变量口令没反应 | 库非空时口令**不重播种**，要登录后在设置里改 |
| 全站 API 404 | 挂在子路径下但没带 `VITE_API_BASE` 重建 |
| 登录页一直转圈（**且**已开统一认证） | 反代下 `YQ_TRUSTED_PROXY_IPS` 没配对 —— 没开统一认证时它不挡口令登录，症状会变成「IP 全变成反代地址」，见第 6 节 |
| 打开发现文档，标题改了、目录树没改 | **已修**（2026-10-12）。目录树现在以文档标题为准，见下方说明；若仍不一致，重跑一次同步即可 |
| **`docker build` 卡在 `npm ci` 然后失败** | **本机/内网连不上公网 npm registry** —— 见下方第 11 节 |

### 已知问题

~~`docs.title` 与 `nodes.title` 是两份数据，历史数据可能分叉且不会自愈。~~

**已消解（2026-10-12 修）。** 当时的方向是「目录树一律现取 `docs[docId].title`」，
现在服务端就是这么做的：

- **写入侧**：客户端两条写入路径（改文档标题 / 在目录树里改名）都经
  `withSyncedTitle`，把 `docs.title`、首个 h1 块、`body` **一次改齐**（`test-title-sync` 钉着）。
- **读入侧**：服务端出 `nodes` 时走 `deriveNodeTitle`，**以文档标题为准**。
  库里那份 `nodes.title` 留着不删 —— 导出与备份的形状不变 ——
  但**任何写入路径造成的分叉，下一次读就自愈**。
  `readEntity` 与 `changesSince` 是两条独立的读路，**两处都接了**；
  漏一处就会变成「全量刷新能看到、增量拉取看不到」的半截状态。

所以这一条从「已知问题」里划掉了。万一在旧数据上仍看到目录标题不对，
那是脏数据，按第 9 节重跑一次同步即可，**不是产品缺陷**。
### 库长到几千篇之后，每次打开页面要下载十几 MB

首次打开会做一次 `bootstrap`，把该用户能看到的实体一次性取回来。实测（2026-10-12，
同一台机器，30 个库 × 200 篇）：

| 文稿数 | bootstrap 服务端耗时 | 响应体 |
|---|---|---|
| 26（演示数据） | 5 ms | 0.03 MB |
| 2000 | 181 ms | 2.1 MB |
| 6000 | 561 ms | **6.5 MB**（UTF-8 实字节约 13 MB）|

**服务端不是瓶颈**（搜索始终 1–3 ms），瓶颈是浏览器每次打开页面都要吃下的体积，
而大头是 `docs` 里的**正文纯文本**：`lite` 模式砍掉了 `blocks`，但保留了 `body`。

⚠️ **不要直接在后端把 `body` 截断**来省这个带宽。客户端每次改正文都会
「写块的同时重算 `body`」再推上去，而服务端对文稿是**字段级合并** ——
一旦客户端拿着被截断的 `body` 推了任何字段，完整正文可能被**静默覆盖成截断版**。
要治得走**分页 / 按需拉**（架构级改动），不是裁一个字段。

### IP 白名单把自己锁在外面了

**症状**：某个知识库谁都读不到（列表空、单篇 403），连它的设置页也进不去。

**原因**：IP 白名单是 fail closed 的 —— 「开着 + 名单为空」等于**对所有 IP 关闭**，
管理员自己也不豁免（白名单问的是「请求从哪来」，不是「谁在请求」）。
而这一行设置数据本身也在 IP 过滤范围内，所以**进不去的人恰恰看不到开关在哪**。

正常操作下这个状态产生不了：设置页在名单为空时不让开开关，
删掉最后一个 IP 会把开关一起关掉，服务端写入侧也会直接拒掉这种组合。
所以只会在**直接改过库**或**很老的数据**里出现。恢复就是把那一条的开关关掉：

```bash
# ① 列出开着白名单的知识库（连 ipList 一起看，空的那条就是要处理的）
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/yuque.db');console.log(d.prepare('SELECT s.bookId, b.name, s.ipList FROM book_settings s JOIN books b ON b.id=s.bookId WHERE s.ipWhitelist=1').all());d.close()"

# ② 关掉那一个库的开关（xxx 换成上一步里的 bookId），关完重启服务
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/yuque.db');d.prepare('UPDATE book_settings SET ipWhitelist=0 WHERE bookId=?').run('xxx');d.close()"
```

走 Docker 部署时在前面加 `docker compose exec <服务名>`，库路径按实际挂载的卷改。

⚠️ 顺带一提：**把 admin 的 IP 放进名单再开白名单**，
否则第一个被挡在门外的通常就是你自己（设置页上也会提示这一条）。

---

## 11. 用 Docker 构建时：npm registry 必须改

**只影响走 Docker 的那条路**（第 1 节那条 node 直起的不需要，依赖已经装好了）。

`Dockerfile` 里 `npm ci` 用的源是可配的构建参数，
**默认值是公网的 `registry.npmjs.org`** —— 而公司内网机器连公网十有八九连不上，
症状是 `docker build` 卡在 `npm ci` 然后失败。

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t yuque-kb .
```

`docker-compose.yml` 接受同名环境变量，所以也可以：

```bash
NPM_REGISTRY=https://registry.npmmirror.com docker compose up -d --build
```

⚠️ **为什么平时不容易踩到**：镜像里 `npm ci` 那一层是缓存住的，
只有 `package.json` / 锁文件变了才会重跑。于是这条会在
「改了点不相干的东西」之后**突然**冒出来，而报错只说 `docker build` 失败、
一个字都没提网络 —— 这就是它难查的原因。

`test-container` 那套遇到这一条会直接把可照抄的命令打出来
（它曾经不会，只会报一句 `Command failed: docker build`）。