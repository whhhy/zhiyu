# 交接文档 · 知语（语雀 1:1 复刻）

> 这份是**给接手的人看的**：项目是什么、怎么跑起来、怎么部署、代码在哪、测试怎么信、还缺什么。
> 细节（环境变量逐条、反代配置、nginx 样例）以 [`RUNBOOK.md`](./RUNBOOK.md) 为准 —— 那份没被损坏。
> ⚠️ `README.md` / `DEPLOY.md` 在 2026-10-05 被 `Set-Content` 按系统 ANSI（GBK）读坏过，
> 至今仍有乱码残留（README 6236 处、DEPLOY 1308 处 U+FFFD）。**能读的部分照用，
> 乱码处不要猜** —— 本文件就是它们的替代品。

---

## 1. 这是什么

一个**语雀（yuque.com）的 1:1 复刻**：文档、知识库、团队空间、评论、小记、讨论区、
实时协作、导入导出、权限体系、卡片（40+ 种，含文本绘图），目标是**部署到公司内网当知识库用**。

- 前端：React 18 + Vite 5 + Zustand + react-router（HashRouter）
- 后端：Node（**零原生依赖**，用内置 `node:sqlite`）+ `ws`
- 依赖只有 5 个运行时包（react / react-dom / react-router-dom / ws / zustand），其余全是标准库
- Node 要求 `>=22.6.0`（用到内置 `node:sqlite` 与 `--experimental-strip-types`）

**不是**静态页面克隆：数据、服务端鉴权、协作 WebSocket、附件二进制全都在库里。

---

## 2. 跑起来

```bash
npm install

# 开发（前端热更新）
npm run dev                # vite，默认 5173

# 构建 + 起服务（生产形态，最接近部署）
npm run build              # tsc -b && vite build  → dist/
npm start                  # = build && server
```

单独起服务端：

```bash
node --import ./server/alias-hooks.mjs server/index.ts
```

默认监听 `0.0.0.0:8080`，数据落在 `data/yuque.db`（不存在会自动播种）。

**公司首次部署**按 `RUNBOOK.md` 第 1 节设环境变量，**其中 `YQ_DEMO=0` 是必须的** ——
不设的话空库会自带 4 个演示库、26 篇文档和 5 个**你没创建过的账号**。

---

## 3. 代码在哪

| 路径 | 内容 |
|---|---|
| `src/components/doc/Editor.tsx` | **编辑器核心**（最大的一块）：块渲染、选区、粘贴、撤销、键盘、拖拽 |
| `src/components/doc/Editor.css` | 块样式（图片/表格/卡片/列表/分割线…） |
| `src/store/index.ts` | 全局状态（Zustand）：文稿/空间/知识库/同步/撤销栈都在这 |
| `src/lib/` | 纯逻辑：markdown 互转、卡片目录、协作、剪贴板、撤销、附件 URL 解析 |
| `src/components/cards/` | 40+ 张卡片的实现（表格、投票、看板、日历、文本绘图…） |
| `src/pages/` | 页面：工作台、空间、知识库、文稿、设置、帮助 |
| `server/index.ts` | HTTP 路由（`on('GET', '/api/...')` 风格）+ 鉴权 + 限流 |
| `server/sync.ts` | 同步协议：实体登记、权限判定、冲突合并、搜索索引 |
| `server/db.ts` | SQLite 建表与索引（`node:sqlite`） |
| `src/types/index.ts` | 核心类型：`Block` / `Doc` / `Book` / `Space` …（**改模型先看这里**） |
| `test-*.mjs` | 158 个测试套件，**全部在项目根目录**（不是 `tests/`） |
| `run-all-tests.mjs` | 测试 runner：起服务 → 逐个跑 → 核对文档项数 → 收摊 |
| `docs/` | 设计文档（`yuque-fidelity.md` 是「与语雀的差距清单」，**前 24 节已丢失**） |
| `data/` | 运行期数据（SQLite + 附件二进制）。**已在 .gitignore 里，绝不能提交** |

---

## 4. 测试（怎么信它）

```bash
npm run test:all           # 全量：158 个套件，约 25 分钟
node test-paste.mjs        # 单跑一个套件（需先起服务，见下）
```

单跑某个套件：

```bash
YQ_DB=data/_x.tmp.db PORT=8096 \
  node --import ./server/alias-hooks.mjs server/index.ts &
BASE=http://localhost:8096 node test-paste.mjs
```

**项数口径**（runner 的汇总行 `合计：N 通过 / M 失败` 是唯一权威）：

- Docker 可用时：**158 套件 / 5433 项**
- Docker 不可用时：容器套件只报 2 项 → 总数变成 **5371**（少 62）
  ⇒ **跑完记得看汇总行，别拿「套件数」当「项数」**。
- 文档（README/DEPLOY）里的项数由 runner 核对；**改了套件就要同步文档里的数字**，
  否则 runner 会报「文档写的是 X，实际 Y」。

---

## 5. 已知缺口（接手先知道这些）

| # | 缺口 | 影响 / 备注 |
|---|---|---|
| 1 | `README.md` / `DEPLOY.md` **字符损坏**（U+FFFD 6236 / 1308 处） | 2026-10-05 的 `Set-Content` GBK 事故，**不可逆**。本文件与 `RUNBOOK.md` 是替代品 |
| 2 | `docs/yuque-fidelity.md` **前 24 节丢失**（约 1788 行） | 那份是「与语雀的差距清单」，缺了它就不知道还差哪些 |
| 3 | **没有一个真实的 `.lakebook` 样本** | `.lakebook` 导入只对着构造出来的样本验过；真实语雀导出文件还没喂进来 |
| 4 | 容器验收依赖 **Docker Desktop** | Docker 不可用时那 64 项整块跳过（不是失败，但等于没验） |
| 5 | 图片下面那行的**形态取舍** | 语雀那张参考图里文字与图片**同行**；本项目把文字放在图片**下面一行**（用户 2026-10-20 明确要求）。两者不同，**以用户的要求为准** |
| 6 | 用户库里有一个 `colleague1` 账号 | 非本项目创建，删了会留悬挂引用，**等用户决定** |

---

## 6. 交接时最容易踩的坑

这一节是**血的教训**，比代码本身更值钱：

1. **改文档绝不能用 `Set-Content`**（PS 5.1 按 GBK 读 UTF-8 → 整份文档烂掉）。
   用编辑工具，或 `node` 写文件（显式 UTF-8）。已经因此丢过两份主文档。
2. **判据要钉行为，不要绑实现形状**。`/case 'image':\s*if \(b\.src\)/` 这种源码形状检查，
   改个代码结构就假红 —— 而行为可能根本没变。
3. **「keydown 里有可打印字符」这个判据，对中文用户永远不成立**：
   中文走 IME，组字过程**没有 keydown**，落地的是 `insertText`/`input`。
   凡是靠 keydown 判断「用户在打字」的逻辑，中文路径全是漏的
   （本项目栽过一次：打英文时字符被文档级处理器吃掉）。
4. **拦截按键前先问「这个键在别的上下文里有没有主人」**。
   Enter 在文字块里归块自己管；把可打印字符 fall through 到「跳到相邻块」就会吃掉字符。
5. **套件端口不要写死**。写死 = 回归结果取决于「机器上碰巧跑了什么」
   （本项目被别的项目占过 8124，症状是「服务端起不来」，完全指不到真因）。
   一律 `scripts/free-port.mjs`（`listen(0)`）或环境变量。
6. **新加一层容器先问「它父级是不是 flex 行」**。是就必须给 `flex: 1`，
   否则那层只有内容那么宽 → 里面的编辑区宽度 0 → 占位提示竖排、光标画不出来。
7. **不可见的覆盖层照样吃点击**。`opacity: 0` 的工具条仍然接收指针事件，
   会盖住相邻块的文字（点下去触发的是看不见的那个按钮）。
8. **改完跑一遍全量再报数字**。套件项数会变，文档里的数字要跟着变。
9. **`elementFromPoint` 返回 `null` = 点在视口外**，不是「被遮挡」。
10. **判据红了先怀疑判据**。但也别放过真 bug —— 这两条不矛盾：
    先确认判据在测**这次改动**，再确认实现对不对。

---

## 7. 环境变量

逐条对照源码核过的完整表格在 [`RUNBOOK.md` 第 2 节](./RUNBOOK.md)。最常用的三条：

| 变量 | 用途 |
|---|---|
| `PORT` / `HOST` | 监听端口 / 地址（默认 `8080` / `0.0.0.0`） |
| `YQ_DB` | SQLite 文件路径（默认 `data/yuque.db`） |
| `YQ_DEMO=0` | **公司首次部署必须设**：播一个干净的空库 |

---

## 8. 给下一位接手的人

- **改模型前先看 `src/types/index.ts`**，块的语义（`Block.text` / `Block.data` / `Block.html`）
  在那儿定义；`src/lib/blocks-markdown.ts` 是它与 markdown 的唯一互转口。
- **加功能先加守卫**（本项目每个 bug 都配了断言，含破坏对照），
  再按 `run-all-tests.mjs` 的口径同步文档数字。
- **不确定语雀怎么做的**，别猜：找真实语雀文档/导出文件比对，或者让用户给一张截图
  （2026-10-20 那张「图片后面接文字」的截图就是决定形态的关键证据）。
- 想做「1:1」时，**以用户的实操反馈为准**，以语雀的公开行为为参照 —— 两者冲突时听用户的。
