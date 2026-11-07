# 测试索引（自动生成，勿手改）

> 由 `node scripts/gen-test-index.mjs` 从 **`_all.log` 的真实运行结果**生成。
> 套件名与项数来自实跑，不是手写 —— 所以它不会漂。
> 手改这里没有意义，改完会被下次生成覆盖。

本轮实跑：**153 个套件 / 5163 项**。

| 命令 | 项数 | 说明 |
| --- | --- | --- |
| `npm run test:accesslog` | 39 | 员工访问日志（语雀企业版的「员工访问日志」）。 |
| `npm run test:apitoken` | 130 | 个人访问令牌 + OpenAPI v2 |
| `npm run test:attachaith` | 17 | 附件的归属与下载权限 |
| `npm run test:attachgone` | 32 | 附件真的不在了，两张卡都要**说出来** |
| `npm run test:attach` | 15 | 附件跨设备验证（服务端形态） 关键不是「能不能上传」，而是**换个人、换台设备还能不能打开** —— 存进自己浏览器的 IndexedDB 是做不到这一点的，那正是本项目要修的。 |
| `npm run test:attachmentdel` | 56 | 附件到底删不删得掉 —— 以及**删一份会不会弄坏另一份** |
| `npm run test:attip` | 48 | **IP 白名单漏了附件通道**（同一个家族的第四处，也是最要命的）。 |
| `npm run test:audit` | 27 | 操作日志：权限与外流动作能追溯 在这个功能之前，「谁在什么时候把权限给了谁」**无处可查**。 |
| `npm run test:auditgap` | 59 | 两条「定义了却没人调用」的审计动作 `server/audit.ts` 的 `AUDIT` 常量里一直有两条： |
| `npm run test:authoring` | 14 | 写作全链路：建库→建目录→建文档→写→改名→拖动→换设备 |
| `npm run test:avatar` | 16 | 头像上传 —— 真实浏览器端到端 自己起服务、自己登录、自己选文件、自己断言渲染结果 |
| `npm run test:backup` | 16 | 备份链路：真跑一次，不是做样子。 起因（2026-10-08）：DEPLOY.md 教的热备与 cron 全用 `sqlite3 ... .backup`， |
| `npm run test:blockrender` | 38 | **h3 / h4 / callout / quote：这四种块真的被画出来了吗**。 |
| `npm run test:blocksearch` | 30 | 搜索关键词屏蔽（语雀企业版的「搜索关键词屏蔽」）。 |
| `npm run test:bodyfresh` | 40 | `docs.body` 不能是旧的 |
| `npm run test:bodyserver` | 22 | 服务端**不**替客户端重算 body / wordCount —— 这是一条**取舍**，不是正确性 这个套件原来的方向是反的：它验的是「服务端在 upsertRow 里用 blocks 重算 |
| `npm run test:book-perms` | 59 | 知识库的「成员与设置」权限（2026-10-12 补） |
| `npm run test:bookexport` | 21 | 整库导出：解开 zip 验内容（层级/正文/权限过滤） |
| `npm run test:bookstats` | 33 | 知识库的「N 篇 · M 字」：**读取时现算**，不读存量聚合。 |
| `npm run test:bulk` | 26 | 批量添加知识库成员 |
| `npm run test:cardsearch` | 29 | **可搜文本：服务端索引与前端本地搜索同一口径**；斜杠菜单的搜索。 |
| `npm run test:cardtext` | 27 | 附件卡的文案不许在服务端形态下说假话 这一类的「假」不产生任何报错： 服务端照常存取附件、UI 照常渲染，只有一行小字在骗人 —— |
| `npm run test:catalog-row` | 7 | 侧栏「目录」行的 ＋ 真能建出文稿（不是装饰按钮） |
| `npm run test:classdef` | 69 | **classDef 节点样式：流程图 / 状态图 / 类图 / 实体关系图**。 |
| `npm run test:classdiagram` | 58 | **Mermaid 类图：隔层盒子 + 六种关系**。 |
| `npm run test:live` | 10 | 跨设备实时协同验证 这一项是语雀最核心的价值主张，也是原版 README 明确说「做不到」的地方。 所以单独用**两个独立浏览器上下文**验证： |
| `npm run test:comment-perms` | 31 | 评论与划词评论的权限（2026-10-12 补） |
| `npm run test:comment-replies` | 22 | 「一条还没有任何回复的评论，刷新之后打开评论/划词评论面板」（2026-10-12 补） |
| `npm run test:confluence` | 36 | test-confluence：Confluence XML 导出解析 |
| `npm run test:container` | 12 | 容器部署：内网真正会用的那一条路 之前所有套件都在**宿主机**上跑 `node server/index.ts`， 部署这件事本身一次都没被验证过。补上之后一次挖出三个问题： |
| `npm run test:converge` | 17 | 三端及以上、同一块、并发改动的收敛性。 |
| `npm run test:copy-sync` | 20 | 跨实体的副本：哪些该跟随，哪些该冻住（2026-10-12 补） |
| `npm run test:crdt` | 79 | **CRDT 核心算法：因果投递层 + 对象级合并层**。 |
| `npm run test:create-denied` | 38 | 「新建文档」入口在**没有 create 权限时**的表现（2026-10-14 补） |
| `npm run test:mkbook` | 19 | 「新建知识库」入口按服务端判据显隐（2026-10-12） |
| `npm run test:day1` | 34 | **开着 IP 白名单的「第一天」，每一步都不该被 403 打断** |
| `npm run test:dead-routes` | 6 | 站内跳转不许指向未注册路由 —— 撞上兜底重定向 = 点了被静默送回首页 |
| `npm run test:delbook` | 38 | 删除知识库 这个能力**以前整个产品都没有**：store 里只有 createBook / updateBook， 服务端没有端点，UI 没有入口。`test-mdimport-e2e` 里就写着这个缺口 —— |
| `npm run test:deploy-accept` | 29 | 首次部署验收（常驻套件）：以「第一次部署的公司运维」身份，**照 DEPLOY.md 第 0~2 步从零走一遍**。 |
| `npm run test:deploy` | 4 | **部署完整性：资源真的取得到、CSS 真的生效**。 |
| `npm run test:devicesui` | 13 | **设备列表 / 安全记录在设置页上真的画出来了**。 |
| `npm run test:doc-write-perms` | 50 | 文档级写操作的权限（2026-10-12 补） |
| `npm run test:doclinks` | 42 | 文档之间的双向引用：正文删了链接引用必须立刻消失 / |
| `npm run test:docmove` | 47 | 文档的「移动到 / 复制到另一个知识库」 |
| `npm run test:docpurge` | 91 | 永久删除一篇文档：它带的东西都得跟着走 |
| `npm run test:docshare` | 69 | 单篇文档的对外分享 |
| `npm run test:docslug` | 46 | 文档的「路径」与「摘录」。这两个输入框以前是**静默丢弃**的： |
| `npm run test:docx` | 59 | Word（.docx）导出与导入。 |
| `npm run test:dot` | 71 | **Graphviz DOT：本地出 SVG**。 |
| `npm run test:e2e` | 13 | 端到端：两个真人（两个独立浏览器上下文）协同验证 刻意用两个 browser context 而不是两个标签页： 标签页共享 localStorage，而这里要验证的正是 |
| `npm run test:emptyfirst` | 42 | 空库（YQ_DEMO=0）时，普通用户建不出第一条知识库 演示模式永远带种子数据（`seed.ts` 直插，**不走同步**）， |
| `npm run test:keys` | 26 | 实体键位审计：客户端与服务端的「主键叫什么、父键是谁」必须一致 上一轮那串 bug 的根因全是同一类：某个实体的键位在一边写对了、 |
| `npm run test:erdiagram` | 46 | **Mermaid 实体关系图（erDiagram）：本地出 SVG**。 |
| `npm run test:export` | 32 | 导出 / 导入 验证 |
| `npm run test:exportattach` | 21 | 「导出整个工作台」到底带不带附件，以及**界面有没有说实话** |
| `npm run test:exportcards` | 29 | **导出时互动卡片去哪了：不再静默消失**。 |
| `npm run test:fake-buttons` | 14 | 全项目 209 个 <button> 扫「能点却没反应」（63 个 tsx） |
| `npm run test:fieldsync` | 24 | 客户端类型声明的字段，服务端**必须真的给**。 |
| `npm run test:filename` | 28 | 导出文件名（2026-10-12 补） |
| `npm run test:firstline` | 51 | **「第一行有内容的源码」7 个图种判据同源**。 |
| `npm run test:firstowner` | 8 | **「第一个进门的人」只能有一个 owner**。 |
| `npm run test:flowchart` | 66 | **文本绘图的 Flowchart：本地出 SVG**。 |
| `npm run test:follows` | 14 | 关注：真的能关注，也能取消 这个模块以前整个是假的，而且骗法有两层： |
| `npm run test:gantt` | 96 | **Gantt 甘特图：本地出 SVG**。 |
| `npm run test:image` | 11 | 图片上传：跨设备可见 / 越权 403 / cookie 鉴权 |
| `npm run test:imagelocal` | 19 | 图片块在**本地形态**（纯静态托管）下能不能显示 |
| `npm run test:import` | 23 | Markdown 文件夹导入验证 |
| `npm run test:invite-e2e` | 22 | 协作邀请 —— 真实浏览器端到端（两个真实账号走完整条路） ⚠️ 为什么这个套件存在： 2026-10-11 那几轮里，我反复请用户手动登录去看界面 —— |
| `npm run test:invite` | 34 | 知识库邀请 —— 端到端（真起服务端 + 两个真实账号走完整条路） 2026-10-11 新功能。之前本项目只有「管理员单向把人加进库」， |
| `npm run test:ipwhitelist` | 52 | **「本资料不出内网」这句话，除了打不开 |
| `npm run test:ipwl-ui` | 18 | 知识库设置 → 安全设置 → IP 白名单：真浏览器端到端 服务端那一半在 `test-ipwhitelist.mjs` 里（空名单推不进来、双重编码不能被前缀绕过）。 |
| `npm run test:ipwlchanges` | 24 | **IP 白名单漏了「增量同步」这条出口**。 |
| `npm run test:journey` | 51 | **Mermaid 用户旅程图：本地出 SVG**。 |
| `npm run test:lakebook` | 48 | 语雀 Lakebook 导入验证 「无语雀格式互导」那个缺口的实现。语雀的 `.lakebook` 是**整知识库** 的原生导出格式 —— 如果一家公司现在正用着语雀，这是唯一能把 |
| `npm run test:lazy` | 12 | 轻量启动 / 按需加载 / 正文不被误删 |
| `npm run test:like-perm` | 14 | 点赞的权限（2026-10-12 补） |
| `npm run test:lint` | 59 | 源码体检：落单反引号 / BOM / **乱码替换字符** / TODO / |
| `npm run test:lock` | 45 | 文档锁以前能被「冒充持有者」绕过 锁存在的意义很具体：A 正在编辑这篇文档时，B 不该能改它 —— 因为 A 保存时收不到任何提示，改了就白改。 |
| `npm run test:loginlimit` | 14 | **密码登录必须限流**。同一「账号 + IP」连错 8 次锁 10 分钟， |
| `npm run test:mdgraph` | 32 | **Markdown 图形围栏 → 文本绘图卡片**。 |
| `npm run test:mdimport` | 17 | **导入的图，导入后真的画得出来**（端到端 12 种图种）。 |
| `npm run test:mermaid` | 169 | **Mermaid：图种识别 + sequenceDiagram 本地出 SVG**。 |
| `npm run test:migrate` | 25 | 引导两个最容易在部署时踩空的地方 一、老库补列 建表语句全是 CREATE TABLE IF NOT EXISTS —— 这句话对**已存在**的表什么也不做， |
| `npm run test:mindmap` | 64 | Mermaid `mindmap`（脑图）解析与 SVG 渲染 为什么单独成一套件：纯函数，Node 里直接 import 跑，秒级完成。 |
| `npm run test:no-fake` | 338 | 「承诺了但没做」的按钮与提示 扫了一遍代码里所有点了只弹 toast 的控件，找到五个。其中一个特别危险： |
| `npm run test:nospurious` | 14 | 只读成员不该产生任何推送（回归锁） |
| `npm run test:offboard` | 22 | 离职办理与权限回收 「离职权限自动回收」以前是**只存不执行**的开关：设置页写着 「成员离开空间时，自动收回其在本知识库的全部权限」， |
| `npm run test:offboardrole` | 35 | 办完离职的管理员，重新登录回来还能不能当管理员 —— 原来能 `POST /api/users/:id/offboard` 原来只有四步： |
| `npm run test:offline` | 15 | 服务不可达：宁可停下来，也不能拿本地数据顶上 之前 probe() 一失败就静默回落本地模式，后果链条是： |
| `npm run test:paste` | 20 | 粘贴 Markdown 自动转块（语雀招牌交互）+ 粘贴不丢内容 |
| `npm run test:permissions` | 23 | 权限感知（前端侧） |
| `npm run test:personal` | 23 | personal 实体的行定位以前不带归属：任何登录用户能删掉/覆盖别人的收藏、 关注、最近浏览，而服务端回的是 `applied` + **零拒绝**。 |
| `npm run test:pie` | 49 | **Mermaid 饼图：本地出 SVG**。 |
| `npm run test:pin-consistency` | 12 | 置顶在两个界面上的一致性（2026-10-12 补） |
| `npm run test:pin` | 29 | 文档置顶 + 点赞同步（2026-10-12） |
| `npm run test:prefs` | 21 | 本地偏好真的生效；设置页里的假控件已清掉 |
| `npm run test:privdoc` | 59 | **文档级「仅自己可见」：除了作者本人谁都看不到，平台 owner 也一样**。     # 59 项 **文档级「仅自己可见」：除了作者本人谁都看不到，平台 owner 也一样**。 |
| `npm run test:profile` | 42 | 改自己的资料 |
| `npm run test:pushshape` | 29 | **同步推送的 payload 形状不对时，整个事务回滚**。 |
| `npm run test:replies` | 14 | 曾经有个静默的数据丢失：回复嵌套在父评论里，服务端按行同步时 replies 不在评论的可写列里，于是「回复发出去了，刷新就没了」。 |
| `npm run test:roundtrip` | 25 | 导出 → 导入 的往返（2026-10-12 补） |
| `npm run test:runbook` | 13 | RUNBOOK.md 的环境变量表与源码**双向**一致 |
| `npm run test:sankey` | 43 | **Mermaid 桑基图（sankey-beta）：本地出 SVG**。 |
| `npm run test:searchoracle` | 49 | 搜索的**独立基准**：拿 /api/search 的结果，对一份自己算出来的答案。 |
| `npm run test:searchpage` | 7 | 顶栏与搜索页结果一致（两处共用一份实现） |
| `npm run test:searchscope` | 6 | 搜索的权限过滤必须发生在 LIMIT 之前 原来的写法是：SQL 先 `LIMIT 400`，再在 JS 里逐条判权限。 |
| `npm run test:search` | 6 | 服务端搜索（含越权与两字中文词） |
| `npm run test:seclog` | 20 | **我的安全记录**（语雀的「帐户安全 → 安全记录」）。 |
| `npm run test:security` | 53 | 安全设置必须真的被执行 知识库设置里的「安全」页给了管理员四个开关。查下来： 四个全都只存不执行** —— 存进 SQLite、同步到各设备、界面上 |
| `npm run test:selbar` | 5 | ⚠️ 这里**不能**判 `bottom === 'auto'`。 fixed 元素只设了 `top` 时，`bottom` 的计算值会被解成一个具体数字 |
| `npm run test:seqgap` | 22 | **待拉取超过 2000 条时，客户端会永久丢掉一段变更**。 |
| `npm run test:server` | 54 | 用 node fetch 而不是 PowerShell：PowerShell 5.1 发请求体时默认按 Latin-1 编码， |
| `npm run test:sessionpurge` | 18 | **过期会话从不被清理**。`sessions` 表原来只有四个出口：登出、某次用到时顺手删、 |
| `npm run test:sessions` | 22 | **登录过的设备看得见、也踢得掉**（语雀的「帐户安全 → 登录设备」）。 |
| `npm run test:shortcuts` | 32 | 快捷键：界面上写着的，**逐条真按一遍** 为什么静态判据不够（本项目实测栽了三次）： |
| `npm run test:sidenav` | 6 | 侧栏顶部搜索框：形态对齐语雀（含它带 disabled 这点），且 Ctrl J 真的能唤起搜索 |
| `npm run test:space-delete` | 26 | 删除空间 + 24 小时撤销 —— 真浏览器端到端（2026-10-16） |
| `npm run test:space-feed` | 3 | 实测：空间页的「空间动态」真的按空间过滤，且显示的是真实数据。 |
| `npm run test:space-perms` | 31 | 讨论区与小记的权限 —— 含「没有发言权时**用户输入不能被无声吞掉**」（2026-10-14 补） |
| `npm run test:spacewrite` | 39 | 小记与讨论区的发言权以前绑错了对象 `notes`（小记）、`topics`（讨论区话题）、`topicReplies`（回复） |
| `npm run test:sso` | 35 | 统一认证（自己起三个实例，不需要先起服务） |
| `npm run test:statediagram` | 104 | **Mermaid 状态图：本地出 SVG**（复用流程图引擎）。 |
| `npm run test:stats` | 15 | 知识库统计必须是真数据 以前「统计」页展示的是编造的数字： · 访问者 / 浏览量写死在 `seedBookStats`（1843 / 12760……） |
| `npm run test:syncconv` | 17 | 增量同步的收敛性：**两条路必须给出同一个状态**。 |
| `npm run test:sync-fields` | 15 | 同步字段对照（2026-10-12） |
| `npm run test:sync` | 12 | 同步完整性：客户端不能删掉服务端有的东西 |
| `npm run test:tblwrite` | 25 | **把上一轮那个盲区剩下的几张表也走一遍**： |
| `npm run test:space` | 50 | 团队空间建得出来、拉得进人：名册/添加/移除真生效， |
| `npm run test:team-stacks` | 15 | 团队主页「堆叠卡」（book_stacks）—— 真浏览器端到端 + 源码层守卫。 |
| `npm run test:temp-cleanup` | 3 | 自建服务的套件跑完不把自己的库留在 data/ |
| `npm run test:template-perms` | 16 | 模板的权限（2026-10-12 补） |
| `npm run test:templatewrite` | 29 | 模板：写路径只认 bookId，和读路径（`visible`）不是一套判据 `templates` 的读路径 `visible`（`server/entities.ts`）认**四种**来源： |
| `npm run test:timeline` | 50 | **Mermaid 时间线：本地出 SVG**。 |
| `npm run test:title-sync` | 38 | 「标题」这一个概念的四份副本（2026-10-12 补） |
| `npm run test:tooltip` | 4 | 工具栏提示（tooltip）—— 真浏览器端到端（2026-10-16） |
| `npm run test:topic-create` | 14 | 讨论区能「发起话题」（2026-10-12 补） |
| `npm run test:topics` | 21 | 讨论区：回复是真存的 这一页以前是**整个假的**，而且四处都假得不一样： |
| `npm run test:trash-perms` | 33 | 回收站的两道权限门（2026-10-14 补，四个缺陷一次挖出来） |
| `npm run test:trash` | 19 | 回收站「真能恢复」验证 |
| `npm run test:trashpurge` | 61 | 回收站的「永久删除」与「清空」。这两个按钮以前 |
| `npm run test:trashretain` | 28 | 回收站保留期：到期自动永久清除 |
| `npm run test:tree-menu` | 9 | 侧栏书行那个 ⋯：必须是**真菜单**，不是跳转（2026-10-17） |
| `npm run test:tree-perms` | 22 | 目录树对阅读者的写操作（2026-10-12 补） |
| `npm run test:trustedproxy` | 27 | **`YQ_TRUSTED_PROXY_IPS`：只信来自指定 IP 的请求头** |
| `npm run test:trustproxy` | 16 | `YQ_TRUST_PROXY`：关掉之后不再信 `X-Forwarded-For` `clientIp()` 原来**无条件**取 `X-Forwarded-For` 的第一段， |
| `npm run test:unzip` | 49 | test-unzip：ZIP 读取器 |
| `npm run test:user-journey` | 18 | 完整用户旅程（2026-10-15 加）：一条线走完 建库 → 编排目录 → 写文档 → 评论 → 删除 → 回收站 → 还原 → 篇数复原 |
| `npm run test:v2ip` | 37 | IP 白名单在 `/api/v2` 上以前是**完全没生效的** 知识库设置里有一项「仅允许下列 IP 访问本知识库，其余请求将被拒绝」， |
| `npm run test:versions` | 12 | 和评论回复是同一类问题：嵌套数据如果不同步推上去就只活在本地。 |
| `npm run test:watermark` | 17 | 全局水印 这个开关以前**只存不执行** —— 设置页写着「在正文上叠加成员标识水印， 截屏外传时可追溯来源」，存进 SQLite、同步到各设备， |
| `npm run test:wordcount` | 16 | **字数：前端与服务端同一个数**。 |
| `npm run test:wsip` | 29 | **IP 白名单漏了 WebSocket 协作通道**（同一个家族的第三处）。 |
| `npm run test:zombie-fields` | 8 | 声明了但**行为层一处没读**的字段（管道层存着，界面不用） |
