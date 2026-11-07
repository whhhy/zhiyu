/* ============================================================
   一次性跑完所有服务端套件
   ------------------------------------------------------------
   之前每个套件的默认端口各写各的，换一次端口就有一半连不上，
   而「连不上」和「测试失败」在输出里长得很像，很容易误判。
   这里统一：起一个临时服务、跑完全部、打印汇总、收摊。
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freePort } from './scripts/free-port.mjs'

/**
 * 本轮开始的时刻。收尾那次清扫靠它区分「本轮产生的」和「上一轮遗留的」——
 * 判据是 mtime 而不是「早于现在 1 小时」，理由见收尾那段注释。
 */
const RUN_STARTED = Date.now()

const PORT = process.env.YQ_PORT || '8092'
const BASE = `http://localhost:${PORT}`
const DB = `data/_testrun-${Date.now().toString(36)}.db`

/** 跑一个子进程并收它的输出。shell:false —— 见下方 healthCheck 的注释。 */
const run = (args, env = {}) => new Promise((res) => {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env } })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  p.on('close', (code) => res({ code, out }))
  p.on('error', (e) => res({ code: -1, out: String(e) }))
})

const SUITES = [
  'test-lint.mjs',
  /* 「能点却没反应」的按钮，全项目扫（209 个 <button>）。
     与 test-no-fake-actions 是同一条判据，但那个只覆盖 Settings.tsx 一页 ——
     而假按钮恰恰最爱出现在卡片 / 布局 / 边栏这些没人专门测过的地方。
     放在 test-lint 后面：两者都是不启动服务的源码静态检查。 */
  'test-fake-buttons.mjs',
  /* 「声明了但行为层一处没读」的僵尸字段。
     这个项目被它咬过四次（defaultWidth / defaultVisibility / newDocPosition /
     BookInvite.toName+fromName）。它比缺功能阴：不报错、数据照存、
     配置项照旧摆在那儿，改了不起任何作用。
     基线里的已知未接线项不判红，但每次都打印出来 —— 长期红的检查会被忽略。 */
  'test-zombie-fields.mjs',
  /* 跳向未注册路由的死链。
     路由表最后是 `<Route path="*" element={<Navigate to="/" replace />} />`，
     所以拼错的路径**不报错、不白屏**，只是把人静默送回首页 ——
     用户只会说「点了没反应」，日志里什么都看不到。 */
  'test-dead-routes.mjs',
  /* 收摊守卫：自己起服务、自己造了库、跑完却不删的套件。
     全量跑时 runner 的清扫会兜住，**单独跑不会** ——
     而单独跑正是排查问题时做的事。已知欠账列在基线里（不判红），
     只对**新增**的泄漏判红。 */
  'test-temp-cleanup.mjs',
  /* RUNBOOK.md 的环境变量表与源码**双向**一致性。
     一份「完整但过时」的部署手册比坏掉的更危险：坏的一眼看得出来，
     过时的那份你照着做然后被咬。真实踩过一次 —— `YQ_ACCEPT_PORT`
     手册上有名字，override 里压根没映射，设了它必然失败，
     而报错与事实（容器 Up 且 healthy）完全相反。 */
  'test-runbook-env.mjs',
  /* 文档 ↔ package.json 的**双向**一致性守卫（2026-10-18）。
     守卫的另外两环早就有了 —— package.json ↔ SUITES 的「注册完整性」，
     文档里的项数 ↔ 实际跑的项数。缺的正是「文档里写的脚本名真的存在」这一环。
     实测踩到：DEPLOY.md 里 `test:runbook-env`（真名 test:runbook）与
     `test:catalog-row-e2e`（真名 test:catalog-row）两行都是照着**测试文件名**
     写的。之所以能一直烂着：项数核对归一化之后找的是 `testrunbook`，
     而那行归一化出来是 `testrunbookenv`，正则要求名字后紧跟竖线 ——
     于是这一行对核对器**根本不存在**，它挂着的错项数（5 / 4）永远没人来对。
     一个能自我豁免的错误。 */
  'test-docscripts.mjs',
  /* 侧栏顶部搜索框（照 2026-10-11 实测的真实语雀 DOM 复刻，含它带 disabled 这点）。
     它自己会起服务，所以单跑和全量都能跑。 */
  'test-sidenav-e2e.mjs',
  /* 目录树顶部那行「目录」＋新建入口（2026-10-11 照真实语雀的侧栏形态搬上去的）。
     验的是**它真能建出文稿**，不是「它渲染出来了」——
     一个长得对、点了没反应的按钮正是这个项目最恨的东西。 */
  'test-catalog-row-e2e.mjs',
  /* 空间页的「空间动态」（照真实语雀：点进空间能看到这个空间的动态）。
     ⚠️ 它验的是**条目身份**而不是条数 —— 破坏对照测出：拿条目最多的空间
     比条数是**恒绿**的（过滤后的前 8 条 = 不过滤的全局前 8 条）。
     所以它挑条目**最少**的那个空间，比对两边算出的条目集合。 */
  'test-space-feed-e2e.mjs',
  /* 团队主页的「堆叠卡」（2026-10-15 登录态实测真实语雀 /yuque 的 book_stacks）。
     它钉的不只是「长得像」——旧形态那几行是纯 div，**看得见、进不去**，
     所以这里真的点一次卡面、点一次卡内文档，确认跳对了地方。 */
  'test-team-stacks.mjs',
  /* 删除空间 + 24 小时撤销（2026-10-16 照真实语雀补的，官方《如何删除空间》）。
     它挡住的是一个**会被客户端推送静默旁路**的设计错误：
     差分算出来的 remove 在协议上完全合法，不钉住就没人发现。 */
  'test-space-delete.mjs',
  /* 工具栏提示可见（2026-10-16）。它挡的是一个**代码看着完全正常**的缺陷：
     每个按钮都写了 title，但 `.yq-toolbar` 的 `overflow-x:auto` 会连带把
     `overflow-y` 算成 auto，把提示整条裁掉 —— 只读代码看不出来。 */
  'test-tooltip.mjs',
  /* 划词工具条没有被撑高（2026-10-17）。
     挡的是**类名冲突**：`.yq-selbar` 同时被划词工具条和批量操作条用，
     后者的 `bottom:16px` 泄漏过去，fixed 元素同时有 top/bottom
     → 高度被拉满（实测 189×549，而不是 187×33）。 */
  'test-selbar.mjs',
  /* 侧栏书行那个 ⋯ 必须是真菜单（2026-10-17）。
     它原来是个**假动作**：图标是「更多菜单」，onClick 直接 navigate 去设置页 ——
     用户点它被带离知识库，而书页右上角还已经有一个真·⋯ 菜单。 */
  'test-tree-menu.mjs',
  /* zip / Excel / CSV 导入（2026-10-16 照语雀官方导入清单补的）。
     它用**真实字节**（自己造的 xlsx 与 zip）跑，不是只测字符串函数 ——
     「能解析自己造的输入」和「能解析 Excel 存出来的文件」是两件事。 */
  'test-import-office.mjs',
  /* 导入的**入口形态与进度反馈**（2026-10-16 照语雀）。
     钉的是「只有一个入口」和「没有『上传中』这个不存在的态」——
     后者看起来是废话，其实是这一轮刻意不照抄的地方。 */
  'test-import-ui.mjs',
  /* 文档置顶 + 两条当场查出来的真缺陷（2026-10-12）。
     ① 点赞**从来没落过库**：本地 likes=["u_admin"]、服务端 likes=[]，不报错不提示。
        病根在 sync.ts 的 comparable() 不比 likes，而 toggleDocLike 不碰 updatedAt
        —— 「靠 updatedAt 带一把」那条路在这里根本不存在。
     ② 客户端排的目录顺序**从来没落过库**：前端叫 order、列叫 ord，
        toRow() 按列名取值 → 那一列永远是 DEFAULT 0 → 刷新即丢，且零 rejected。
     ③ 置顶本身（排到本组最前 / 取消后精确回原位 / 刷新后仍在）。
     ④ 只读成员不因 likes/pinnedAt 进了比较而产生假推送 —— 这是 ①②③ 的反向约束。
     它自起服务 + 全新库：要点赞、要点置顶、要建文档，在共享库里做这些就是污染。 */
  'test-pin-e2e.mjs',
  /* 「新建知识库」入口按服务端判据显隐（2026-10-12）。
     服务端只让**空间管理员**建库，而客户端四个入口（工作台两处 / 空间页 / 顶栏菜单）
     都不判角色 —— 普通成员点下去得到一句「知识库已创建」和一个
     **刷新也不消失**的空壳库（服务端三行全拒）。
     正反两个方向都要验：普通成员看不到入口，管理员**照样看得到、真建得出来**。
     它自起服务 + 全新库（要建库、要注册账号）。 */
  'test-createbook-gate.mjs',
  /* 讨论区能「发起话题」（2026-10-12 补）。
     `topics` 的表 / 实体 / 类型 / 同步形状 / 回复动作 / 动态流分支**一直都在**，
     唯独没有写入路径和按钮 —— 而三处文案都承诺了它
     （Space 与 Dashboard 的空状态、Help 的「去讨论区发帖」）。
     一个只有一半的功能比没有更糟：入口被三处推荐，实际上点了没用。
     它自起服务 + 全新库（会在库里留一条真实话题）。 */
  'test-topic-create.mjs',
  /* 同步字段对照（2026-10-12）—— 把「客户端推的字段服务端接不住」这一整类钉住。
     `toRow()` 按**列名**取值，而客户端推的是**它自己那个字段名**；
     对不上时服务端回 `applied` + 零 `rejected`（改了等于没改，不报错）。
     已知中过两枪：`nodes.order`（列叫 ord）、`docs.lock`（存两列、客户端推对象）。
     它最后一条断言是「采到的实体数够不够」—— 探针一旦退化（换了不存在的 action 名，
     可选调用静默跳过），它会当场红，而不是安静地少查一半。
     它把 YQ_DB 指到自己的临时库再动态 import 实体清单：
     ESM 的 import 是提升的，静态 import 会打开**部署那个库**。 */
  'test-sync-fields.mjs',
  /* 目录树对阅读者的写操作（2026-10-12 补）。
     菜单里的 重命名/置顶/移动…/复制…/删除、hover 的 ＋新建、整行的拖拽
     以前对**阅读者也全开**：他点删除 → 本地那篇真的从树上消失 →
     toast「已移入回收站」→ 服务端才拒（「没有 edit 权限」）→
     顶栏常驻「N 处修改没有保存」而他自己修不好。
     根因很具体：`useBookPerms` 的注释里早就写着「目录树的『新建』按钮要靠它」，
     而 Tree.tsx 从来没调用过它。
     正反两个方向都钉：阅读者看不到写操作；有编辑权的人必须照常用得了
     （判据在「权限未确认」时判 false，写反了就变成管理员集体失去写能力）。
     自起服务 + 全新库（要建库、加成员、试删）。 */
  'test-tree-perms.mjs',
  /* 文档级写操作的权限（2026-10-12 补）。
     目录树的删/改名/移动早就有 `bookEditBlocked`，而**文档这一层从来没接过**。
     探针实测（真服务端，reader 与 visitor 各一轮）：
       lockDoc              → 返回 true、本地锁上了、服务端 lock 仍是 null、顶栏挂 1 条
       updateDoc{published} → 本地 true、服务端仍是 false、顶栏挂 1 条
       updateDoc{slug}      → 本地改了、服务端没改、顶栏挂 1 条
       deleteDoc            → **文档从树上消失、进了本地回收站**，服务端还放着，挂 4 条
     deleteDoc 最重：用户看到「已移入回收站」而服务端根本没删 ——
     他既删不掉也恢复不了（那条告警推不动）。
     ⚠️ 三档角色都要测：只测 visitor/reader 会漏掉反向约束 ——
     加了守卫之后**有编辑权的人必须还照常用得了**，而那是「功能没了」的方向。
     分享弹窗只卡「改访问权限」（那是**作者专属**，不是编辑权），
     复制链接是读，谁都能用 —— 整条禁用分享同样是「功能没了」。 */
  'test-doc-write-perms.mjs',
  /* 知识库的「成员与设置」权限（2026-10-12 补）—— 后果最重的一处。
     服务端把 `bookSettings` 与 `bookMembers` **两个实体放一起**判 `caps.admin`
     （**editor 的 admin 是 false**，编辑者也不能改成员），而 `BookSettings` 整页
     此前**没有角色门**（路由也不挡），任何成员敲 URL 就进得来。
     实测（探针，visitor / reader / editor 各一轮）：「添加成员」「邀请」无条件渲染、
     角色下拉/移除/权限矩阵全部可点、安全那 5 个开关全部可点；调
     `addBookMember(bookId, x, 'admin')` → **界面的名单当场多出一个管理员**，
     服务端一条没改，顶栏挂 4 条修不好的告警。
     修法：store 六个 action 接 `bookAdminBlocked`（判 **admin 不是 edit**）；
     界面用 `useBookPerms`（服务端同源）；安全设置**整节早退**而不是给 5 个开关
     逐个加 `disabled` —— 逐个加必漏一个，漏掉的那个就又是一个洞。
     反向样本是**库管理员但平台角色只是 member**（平台 owner / 库 owner
     都不验证判据本身，拿它们当反向样本等于白测）。 */
  'test-book-perms.mjs',
  /* 讨论区与小记的权限（2026-10-12 补）—— **空间级**的那一片。
     服务端 `isSpaceLevel` 把 `topics`/`topicReplies`/`notes` 三张表统一按
     **`capsInSpace().comment`** 判（不是知识库的 edit、也不是空间的 admin）；
     客户端 `createTopic`/`replyToTopic`/`likeNote`/`addDocVersion`/
     `restoreDocVersion` 五个 action 此前**一个门都没有**。
     判据必须分两组：空间成员能发、空间外的人发不了；文档级（历史版本）
     空间成员**也不该**能存/回滚 —— 只测一组就分不出判据接对没有。
     ⚠️ 两条前提必须显式造出来，否则判据恒真：
       · 守卫是「问过才拦」，所以要先让 `loadSpaceCaps` / 进文档页把 caps 问回来；
       · 非空间成员压根看不见那个话题，`replyToTopic` 反查不到 spaceId 时
         **必须当没有权限**，否则 `spaceCapsSync(undefined)` 返回 null → 静默放行。
     顺带钉住一个根因：同一个事实曾存两份（store 切片 vs lib 缓存），
     只写切片的话守卫永远读到 null —— 破坏对照 H4 专门盯它。 */
  'test-space-perms.mjs',
  /* 模板的权限（2026-10-12 补）—— 重点是**别挡错**。
     服务端那一条是**四分叉**的：official 只有平台管理员 / mine 只能自己改 /
     挂 bookId 要 edit / 挂 spaceId 要 edit。
     客户端 `createTemplate`/`updateTemplate`/`deleteTemplate`/`applyTemplate`
     此前**一个守卫都没有**；最重的是 `applyTemplate` ——
     它**真的在建一篇文档**，一个阅读者点「用这个模板建一篇」，
     本地真的多出一篇、服务端拒、顶栏挂一条他自己修不好的告警。
     判据的重点在反向：简化成「一律要 edit」会把**建自己的模板**这个
     正当的个人功能堵掉 —— 那是「功能没了」，比假动作更难被发现
     （没人会去报「这个功能本来就没有」）。破坏对照 T3 专门盯这一侧。 */
  'test-template-perms.mjs',
  /* 导出 → 导入 的往返（2026-10-12 补）—— **公司迁移要走的那条路**。
     `test-export` 验「导出来对不对」、`test-import-md` 验 Markdown、
     `test-lakebook` 验**语雀**那个格式 —— 三者都没验「我们导的 → 我们导的」。
     为什么这条特别要紧：导入是**尽力而为**的，服务端逐条独立判定，
     拒掉的条目只回一个**数字**（`rejected: N`）。
     于是「丢了一半内容」**不会报错**，只会得到一个漂亮的 200 和 `ok: true`。
     判据要点：
       · 必须灌进**另一个全新实例** —— merge 进同一个实例证明不了什么，
         那些行本来就在，「没报错」和「读得回来」是两回事；
       · 基线要取**空实例导入前**的数（种子本身就有 26 篇），不能拿 0；
       · 逐项比**内容**而不只比条数（块数 / 每一块文字 / 摘录 / 路径 / 标签 /
         发布标记 / 目录层级 / 评论与划词评论正文 / 库的设置 / 历史版本）；
       · ⚠️ bootstrap 里 docs/comments/bookSettings **有时是数组、有时是 Record**，
         且主键**不一定叫 id**（bookSettings 是 bookId、bookMembers 是 userId）。
         只按 `id` 找，bookSettings 就永远「找不到」。 */
  'test-roundtrip.mjs',
  /* 置顶在两个界面上的一致性（2026-10-12 补）—— 「同一份数据两个界面不一致」。
     侧边树有 `pinFirst` + 📌 + 菜单里的「置顶」，而设置页的「目录管理」
     此前**一个 pin 字样都没有**，同时它**能拖拽排序**。组合出来的后果：
       · 在树里置顶一篇，切到设置页 —— 没有任何迹象，像是被清掉了；
       · 想取消置顶只能回侧边树（那儿的行内只有 ＋ 和 🗑）；
       · 这一屏能拖拽，而**置顶不改 order**（改的是渲染时的插队），
         拖动置顶项之后树里仍排最前，那一屏什么都不解释 → 「拖了没反应」。
     ⚠️ 判据不能断言「两处顺序一致」—— 树插队、设置页显示存储顺序，
     **不同才是对的**。该断言的是「置顶项有标记」以及「标记解释了这个差异」。
     ⚠️ 查标记要查 `.yq-bset-pin` 这个**元素**，不能查 innerText 里有没有 📌 ——
     行内那个切换按钮本身就写着 📌，按文字查会永远为真。 */
  'test-pin-consistency.mjs',
  /* 回收站的两道门（2026-10-12 补）—— 这一族一次挖出**四个**缺陷：
     ① `trash` 表没挂 `filter: canSeeDocRow`（`docs`/`nodes` 都挂了），
        于是别人**私有文稿的标题快照**跟着 trash 行同步进了每个成员的本地库 ——
        正文那层是拦住的，标题漏了，症状是回收站里冒出一个他从没读过的标题；
     ② `BookTrashTab` 与全局 `/trash` 页对**所有角色**都渲染出可点的
        「还原」/「永久删除」，而服务端分别要 `edit` / `admin`；
     ③ 还原按钮挂着 `!docs[t.docId]`，而 `readEntity` 对 `docs` 强制
        `WHERE trashed = 0` —— 软删正文**不进任何人**的本地库，
        于是这个条件恒真，「还原」对**管理员也**是禁的（全局页没这条件，两处自相矛盾）；
     ④ 软删时把目录节点**真删掉**，于是还原只翻得回 `docs.trashed`，
        树上的位置找不回来 —— 文稿回到库里却哪儿都点不着，
        而提示写着「已还原到原位置」（改成 `nodes.hidden` 才对）。
     ⚠️ 反向样本用**编辑者**（有权限但不是最高权限）：库 owner / 平台超管
     在 `capsInBook` 里早退，拿它们当反向样本等于白测。 */
  'test-trash-perms.mjs',
  /* 「新建文档」入口在**没有 create 权限**时的表现（2026-10-14 补）。
     起因是按角色盘点工作台时发现：三档角色的控件清单**完全一致**，
     而一个 visitor（`create:false`）看到的是一整套可点的「新建」入口。
     顺着 `createDoc(` 的调用点扫出**三个**同一形状的缺陷：
       const id = createDoc(...)            // 被拒时返回**空串**
       toast('已新建…', 'success')           // ← 无条件报成功
       navigate(`/book/x/doc/${id}`)        // ← 空 id = 死链
     比「点了没反应」更糟：**它先让用户信了**。
     ⚠️ 其中 DocsTab 那个更隐蔽一层：它**从来没问过权限**，
     于是 store 的 `bookCreateBlocked`（边界是「问过且没有才拦」）
     在这一页静悄悄退化成「永不拦」——
     ⚠️ 后来又找到**第三个现场**（模板中心），并因此把规则往前推了一步：
     **hook 要挂在「能触发这个写操作的那个页面」上** ——
     只挂在弹窗里就只关住了界面、关不住 store 那一道
     （弹窗没打开时这一页从来没问过 → caps 是 null → 放行）。 */
  'test-create-denied.mjs',
  /* 「标题」这一个概念的**四份副本**（2026-10-12 补）—— 已经中过三次的那一族。
     语雀的模型是「标题 = 第一个 H1 块」，我们拆成了四份，**没有一处会自动跟随**：
       · `docs.title`    · `nodes.title`（目录树读它）
       · `blocks[0]`(h1)  · `body`（**导出与对外分享页认它**）
     漏过的三次：10-10 正文 H1→title 改了、node 没跟上；12 日文档设置改标题、
     node 没跟上；12 日同一条路，**块和 body 也没跟上** ⇒
     **导出 Markdown / Word / HTML 出来还是旧标题**。
     而前两次修复都只补了 `node.title`，第三条就是从那个缝里漏过去的。
     修法统一收在写入点：`updateDoc` 与 `renameNode` 都走 `withSyncedTitle`。
     判据要点：四条入口都走一遍；每条**同时看本地和服务端**（只看本地的话，
     「本地改了服务端没改」也显示成绿）；**两种文档都测** ——
     首块是 h1 的四份都要跟上，首块不是 h1 的（表格/画板）
     **不能硬塞一个 h1 进去**，那是造数据。 */
  'test-title-sync.mjs',
  /* 跨实体的副本跟随（2026-10-12 补）——「标题」这一族的第四、第五枪。
     ① `favorites.title`：收藏时把标题**快照**了一份，文档改名之后
        收藏夹里那条**一直显示旧名字** —— 而那页手里明明已经有活的那一份。
        修法不是「让快照跟着改」（快照的价值恰恰是**目标被删后**还能认出那是什么），
        而是让**列表读活的那一份**，目标不在时才回退到快照。收藏应当引用而非复制。
     ② `books.updatedAt`：以前只有**结构变化**（新建/移动/用模板建）会动它，
        而工作台与空间页的知识库卡片显示的正是 `{timeAgo(b.updatedAt)}更新`、
        列表还按它排序 —— 于是**今天改了一篇文档，那个库还写着「3 天前更新」**。
     ⚠️ ① 要量的是**界面上显示的名字**，不是存储里那一行 —— 快照继续冻着才是对的。
        ① 的反向也要测：目标被删后列表不能变成空白。 */
  'test-copy-sync.mjs',
  /* 导出文件名（2026-10-12 补）—— **三处实现，只有两处是全的**。
     · `book-export.ts`  一份 `safeName`：替换非法字符、保留中文 ✅
     · `io.ts`            另一份 `safeName`：把**所有非 ASCII** 换成 `_`，
                           而扩展名**只在回退分支补**（正常分支返回裸标题）
     · `DocPage.tsx`      直接内联 `a.download = \`${title}.md\``，**零净化**
     实测（走真实界面点导出，截获 `<a download>`）：
       标题《产品手册》→ Markdown `产品手册.md`；Word/HTML/纯文本 `untitled-…docx`
       标题《设计/方案:v2?》→ Markdown `设计/方案:v2?.md`（`/` 是路径分隔符，落盘存不进去）
       标题《手册.md》→ `手册.md.md`；超长标题 → 路径超限、静默失败
     —— 一个中文知识库，**四种导出格式里只有一种文件名是对的**。
     现在收在 `@/lib/filename` 一份实现（`safeFileName` / `safeFileNameWithExt`）。
     ⚠️ 必须走真实界面：dist 产物里取不到 `/src/lib/io.ts`，
        而「界面点出来叫什么」本来就是用户实际拿到的东西。
     ⚠️ 边界要一起测（空标题 / 非法字符 / 超长 / 已带扩展名 / 结尾点空格）——
        只测中文那一条会漏掉一半（扩展名丢失就是靠 ASCII 标题暴露的）。 */
  'test-filename.mjs',
  /* 评论与划词评论的权限（2026-10-12 补）。
     服务端对 comments / selectionComments / 两个 replies 实体统一按 `caps.comment` 判
     （**不是** edit），而这一片界面一个门都没接。两个方向的缺陷正好互为反向：
       · visitor：划词面板里的「回复」「标记解决」照样可点 → store 照收 → 服务端拒 →
         顶栏常驻「N 处修改没有保存」而他自己修不好（假动作）
       · reader（comment=true、edit=false）：划词工具条的渲染条件是 `!editorReadOnly`
         —— 工具条**整个出不来**，而服务端明明允许他发划词评论（功能没了）
     同一个条件还把「复制」一起藏了，而复制根本不需要权限。
     所以按角色分三档测（visitor / reader / admin），少测一档就会漏掉一个方向。
     ⚠️ 拖选正文才出工具条：三击会被工具条自己那个「点到外面就收起」的监听吃掉，
     读出来永远是「没出工具条」—— 那是探针手法问题，不是产品不给。 */
  'test-comment-perms.mjs',
  /* 「一条还没有任何回复的评论，刷新之后打开评论/划词评论面板」（2026-10-12 补）。
     服务端表里**没有 replies 这一列**（回复是两张独立行表），而两个面板都直接
     `c.replies.length` / `c.replies.map` —— 于是「新建一条评论→刷新→开面板」必崩。
     为什么一直没被发现：**种子数据里每条评论都带至少一条回复**，
     判据必须自己造一条零回复的才算真的验过。
     两道防线分开钉：边界归一（store 形状，刷新那条路 + 增量那条路各一条判据）
     与渲染兜底（面板不崩）—— 后者不可观测，如实标注为纯冗余层。 */
  'test-comment-replies.mjs',
  /* 点赞的权限（2026-10-12 补）。
     `likes` 是 `docs` 的一列，`docs` 默认按 `edit` 判 —— 于是 reader 点 👍：
     界面从「👍 0」变「👍 1」→ 服务端拒 → 顶栏挂一条「1 处修改没有保存」而他修不好。
     而语雀那边 reader 是能点赞的，所以这同时是 1:1 缺口。
     服务端改成放行「**除了 likes 什么都没改**」的那种推送 ——
     所以判据必须**两头都钉**：reader 点 👍 真落库（刷新还在），
     而改标题 / 改正文 / 改可见性 / 改置顶 / 删文档**照样被拒**。
     ⚠️ 删除路径传的是空载荷 `{}`，那个分支最容易漏（漏了就等于 reader 能删文档）。
     它测服务端，套件自起服务跑源码，不需要先 build。 */
  'test-like-perm.mjs',
  /* 设置页「安全设置」里的 IP 白名单（2026-10-12）。
     服务端那半边在 test-ipwhitelist.mjs（空名单推不进来、双重编码不能被前缀绕过），
     这个管**界面上那半边**：名单为空时开关点不动、删掉最后一个 IP 自动关开关。
     ⚠️ 它测的是 dist/ 产物，所以单独跑之前必须先 `npm run build`。 */
  'test-ipwl-ui-e2e.mjs',
  'test-entity-keys.mjs',
  'test-server.mjs',
  'test-e2e.mjs',
  'test-collab-live.mjs',
  'test-attachment.mjs',
  'test-replies.mjs',
  'test-search.mjs',
  'test-search-page.mjs',
  'test-lazy-load.mjs',
  'test-versions.mjs',
  'test-image.mjs',
  'test-trash.mjs',
  'test-authoring.mjs',
  'test-export.mjs',
  'test-permissions-ui.mjs',
  'test-no-spurious-push.mjs',
  'test-paste.mjs',
  /* 应用级撤销 / 重做（2026-10-19 用户报「编辑没有回退」）。
     原来只有浏览器原生撤销：打字只退**一个字**，回车建块 / 删块 / 插卡片**一个都撤不回来**。 */
  'test-undo.mjs',
  'test-import-md.mjs',
  'test-lakebook.mjs',
  'test-sso.mjs',
  'test-firstowner.mjs',
  'test-loginlimit.mjs',
  'test-sessions.mjs',
  'test-seclog.mjs',
  'test-devices-ui.mjs',
  'test-blockrender.mjs',
  'test-privdoc.mjs',
  'test-migrate.mjs',
  'test-security-settings.mjs',
  'test-watermark.mjs',
  'test-offboard.mjs',
  'test-prefs.mjs',
  'test-no-fake-actions.mjs',
  /* 快捷键逐条真按（会改文档，但它自带「退出前正文已还原」这条断言）。
     ⚠️ 它默认打 `YQ_PORT || 8092`，而 runner 自己起服务并指定临时库
     （见下方 `env: { PORT, YQ_DB: DB }`）—— 所以正常跑 test:all **碰不到部署实例**。
     2026-10-08 那次污染部署数据，是**手动设 YQ_PORT=8090** 把它指过去造成的，
     不是「没跑还原核对」。别再把这个套件指向有持久数据的实例。 */
  'test-shortcuts.mjs',
  /* 备份链路（2026-10-08 加）。它自己造临时库再备份 → 校验 → 查失败路径，
     不依赖部署实例，所以放在哪儿都能跑。 */
  'test-backup.mjs',
  /*
   * ⚠️ 两个 smoke 脚本**故意不放进 test:all**，不是漏了。
   *
   * 它们都是自包含的（自己起服务、用 dist/、随机端口），2026-10-10 单跑过：
   *   · `smoke-cards.cjs`（27 张卡片逐张真交互）—— **36 通过 / 0 失败**
   *   · `smoke-mobile.cjs`（iPhone/iPad 竖横屏 × 11 个页面）
   *                        —— **64 通过 / 0 失败**
   *
   * 不并进来的理由：
   *   · `smoke-cards` 有真实的**外部网络依赖**（youku / bilibili / netease /
   *     amap / figma 要联外网官方播放器）。断网或内网机器上跑，它会变成一条
   *     **和代码质量无关的红** —— 而 test:all 的红是要当真的，那比不跑更糟。
   *   · 两者都会往项目根写整套截图（`.smoke-mobile` / `data/_smoke-cards`），
   *     几十 MB 起；每轮都写就是每轮都留垃圾。
   *
   * 所以留成手动套件，但**必须留在这个清单里** ——
   * 有了 `smoke:cards` / `smoke:mobile` 这两个 npm script，上面那段
   * 「注册核对」每轮都会报「有 npm script 但没进 test:all」，
   * 这个缺口就再也藏不住了。
   *
   * ⚠️ 别用 `includes('smoke-cards')` 之类的方法判断它在不在 SUITES 里 ——
   *   **这段注释本身就写着这两个名字**，会一律命中（我自己就这么误判过一次，
   *   得出「smoke-cards 在 test:all 里」的错误结论）。要判断就解析 SUITES 数组。
   */
  'test-search-scope.mjs',
  'test-search-oracle.mjs',
  'test-bookstats.mjs',
  'test-fieldsync.mjs',
  'test-team-space.mjs',
  'test-stats.mjs',
  'test-bulk-members.mjs',
  'test-sync-integrity.mjs',
  'test-sync-converge.mjs',
  'test-topic-replies.mjs',
  'test-follows.mjs',
  'test-audit.mjs',
  'test-accesslog.mjs',
  'test-apitoken.mjs',
  'test-docshare.mjs',
  'test-docslug.mjs',
  'test-profile.mjs',
  'test-trashpurge.mjs',
  'test-trashretain.mjs',
  'test-docpurge.mjs',
  /* 删除知识库（自己起服务 + 自己清临时库，不依赖部署实例） */
  'test-delbook.mjs',
  /* 知识库邀请（自己起服务；两个真实账号走完整条路） */
  'test-invite.mjs',
  /* 知识库邀请的**界面**（playwright 自己登录，不麻烦人；留截图） */
  'test-invite-e2e.mjs',
  /* 头像上传的**界面**（同上；验「真的解码出来」而不只是接口通） */
  'test-avatar-e2e.mjs',
  /* 整库导出（解开 zip 验内容；要看真代码产出的字节，所以 import 真文件） */
  'test-bookexport.mjs',
  'test-attachaith.mjs',
  'test-attachmentdel.mjs',
  'test-exportattach.mjs',
  'test-imagelocal.mjs',
  'test-bodyserver.mjs',
  'test-attachgone.mjs',
  'test-bodyfresh.mjs',
  'test-docmove.mjs',
  'test-blocksearch.mjs',
  'test-v2ip.mjs',
  'test-lock.mjs',
  'test-unzip.mjs',
  'test-confluence.mjs',
  /* Markdown 导入端到端：导入的图导入后**真的画得出来**。
     浏览器套件 —— 它要打真实的导入入口（设置 → 数据管理 → 选目录），
     而那条路上每一环（页签、隐藏的 webkitdirectory 输入、确认按钮）
     都在真实 UI 里，静态预览页替不了。不需要 strip-types：它不 import 源码。 */
  'test-mdimport-e2e.mjs',
  /* 侧栏「导入…」**原地**弹框，且落在当前那个库里（2026-10-18）。
     这条路径此前没有任何覆盖：别的导入套件都走设置页入口，
     而设置页没有库上下文，测的是「新建一个库再导进去」那条老路。
     它已经翻过两次车 —— 落点提示显示假书名、以及「关掉之后就再也开不了」。
     浏览器套件：那两次都出在真实交互里，静态扫抓不到。 */
  'test-import-inline.mjs',
  'test-auditgap.mjs',
  'test-spacewrite.mjs',
  'test-personal.mjs',
  'test-emptyfirst.mjs',
  'test-templatewrite.mjs',
  'test-tblwrite.mjs',
  'test-pushshape.mjs',
  'test-ipwhitelist.mjs',
  'test-ipwlchanges.mjs',
  'test-seqgap.mjs',
  'test-wsip.mjs',
  'test-attip.mjs',
  'test-day1.mjs',
  'test-offboardrole.mjs',
  'test-trustproxy.mjs',
  'test-sessionpurge.mjs',
  'test-trustedproxy.mjs',
  'test-cardtext.mjs',
  // 放最后：它要构建并起容器，比其余套件慢得多，
  // 也不该让前面任何一个套件的失败被它挡住视线。
  // 验的是**最终交付的镜像**（构建上下文、卷、重建后数据还在），
  // 之前这些一次都没被验证过 —— 部署这条路是空的。
  'test-offline.mjs',
  'test-converge3.mjs',
  'test-crdt-core.mjs',
  // 部署完整性：自起本地静态服务验 dist/，由 smoke-deploy.cjs 转来
  'test-deploy.mjs',
  // 导出时互动卡片去哪了（纯函数，直接 import src/lib/blocks-markdown.ts）
  'test-exportcards.mjs',
  // 文本绘图补 Flowchart（语雀官方 5 种语法里的第 2 种，本地渲染、不引依赖）
  'test-flowchart.mjs',
  // Mermaid：图种识别 + sequenceDiagram 本地渲染（第 3 种，同样零依赖）
  'test-mermaid.mjs',
  // Graphviz DOT：转成 Flowchart 结构复用布局与渲染（官方第 5 种里的第 4 块拼图）
  'test-dot.mjs',
  // Gantt：官方五种的最后一个，纯线性布局，零依赖
  'test-gantt.mjs',
  // Mermaid 状态图：复用流程图的布局与渲染（审批流/订单状态机，内网最高频）
  'test-statediagram.mjs',
  // Mermaid 脑图：缩进树，边由缩进推出来（中文内网文档常见）
  'test-mindmap.mjs',
  // Mermaid 饼图：没有专属视觉语言的那几种里，先做最不会做错的那个
  'test-pie.mjs',
  // Mermaid 类图：隔层盒子 + 六种关系（关系类型用文字标注，不画可能画错的符号）
  'test-classdiagram.mjs',
  // Markdown 里带图形语言标签的围栏 → 文本绘图卡片（导出方的 Markdown 里全是它们）
  'test-mdgraph.mjs',
  // Mermaid 实体关系图：复用类图那套隔层盒子 + 标注（不画乌鸦脚）
  'test-erdiagram.mjs',
  // Mermaid 用户旅程图：竖排脊柱 + 五格评分条（不画人脸，脸是语义本身）
  'test-journey.mjs',
  // Mermaid 时间线：间隙按时间差成比例（等距会把 2002→2004 画成和 2002→2025 一样宽）
    'test-timeline.mjs',
    'test-sankey.mjs',
  // 「第一行有内容的源码」共用判据：2026-10-07 发现同形缺陷横跨 7 个图种
    'test-firstline.mjs',
  'test-classdef.mjs',
  'test-cardsearch.mjs',
  'test-wordcount.mjs',
  'test-doclinks.mjs',
  'test-docx.mjs',
  'test-container.mjs',
  /* 部署验收（2026-10-14 并入）。
   * 走 `YQ_ACCEPT_NO_DOCKER=1` —— 一个 Node 进程 + 一个空数据目录，
   * 也就是我推荐给用户的部署形态；Docker 那条路留给 `npm run test:deploy-accept` 手动跑。
   * 它守的是本项目的**本体目标**：「能部署到内网当知识库用」，
   * 以前却因为默认依赖 Docker 而被标成「只能手动跑」，等于没人守。 */
  'test-deploy-acceptance.mjs',
  /* 完整用户旅程（2026-10-15 加）—— 别的套件各管一段，**衔接处**没人管。
     它当场抓到一条所有单点套件都漏掉的缺陷：删掉一篇文档后它同时留在
     `docs` 与 `trash` 里、且永不自愈（增量竞态 + ensureDocLoaded 回捞 两条路）。
     ⚠️ 名字别和上面那个 `test-journey.mjs`（Mermaid 用户旅程图）撞 ——
     撞名会让 `Move-Item -Force` 覆盖掉那套 31 项。 */
  'test-user-journey.mjs',
]

/**
 * 健康检查。
 *
 * 这里**必须** shell: false —— 脚本里有 `=>`，经 cmd.exe 会被当成输出重定向
 * （`r=>` 变成 `r` 重定向到名为 `=` 的文件），于是命令永远「失败」，
 * 表现是「服务起不来」，其实服务好好地在跑。
 * 用 process.execPath 直接调 node 本体，不经过 shell。
 */
const healthCheck = () => new Promise((res) => {
  const script = `fetch(${JSON.stringify(BASE + '/api/health')}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`
  const p = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  p.on('close', (code) => res(code === 0))
  p.on('error', () => res(false))
})

// 端口被占就先提示：早先这里会静默地对着别人的服务跑测试
if (await healthCheck()) {
  console.error(`端口 ${PORT} 上已经有服务在跑。先停掉它，或换个端口：`)
  console.error(`  YQ_PORT=8095 npm run test:all`)
  process.exit(1)
}

mkdirSync('data', { recursive: true })

/**
 * 先构建前端，再跑套件。
 *
 * 浏览器套件打的是服务端托管的 `dist/`，而这里原来**从不构建** ——
 * 于是它们跑的是「碰巧存在的那份产物」。
 * 改了 `src/` 却忘了 `npm run build` 时，所有前端断言全绿，
 * 而绿的是**旧代码**：改没改、坏没坏，测试一概不知道。
 *
 * 这不是假设。写附件删除那两条端到端断言时就是这么栽的：
 * 改完代码直接跑，两条都红；`npm run build` 之后同样两条都绿 ——
 * 红的那次测的根本不是新代码。
 *
 * 和端口守卫是同一类问题：**测试跑在旧东西上却全绿**。
 * 端口那次的解法是「占着就退出」，这里的解法是「先构建」。
 *
 * 直接调 vite 的 bin，不经 npm：少一层 shell，少一类转义问题。
 */
{
  /*
   * ⚠️ 重建之前先看一眼**旧产物是拿哪个 API 前缀构建的**。
   *
   * `VITE_API_BASE` 是构建期变量（子路径部署要 `VITE_API_BASE=/knowledge npm run build`），
   * 而上面这次构建**不带它** —— 于是子路径部署的产物会被换成根路径版本，
   * 全站 API 404。而这条命令是「跑一遍完整回归」，**谁都跑**。
   *
   * 之前没有任何提示，因为：产物是构建产物，它自己不会说话；
   * 而根路径构建和子路径构建**都能跑**，都全绿。
   * 这是和 nginx `/ws` 漏转发 X-Forwarded-For 同一类的问题：
   * 两处单独看都对，凑一起才是事故。
   *
   * 所以这里只做**一件事**：在覆盖之前把它喊出来。
   * 不阻断 —— 挡住一次全量回归比坏掉一次部署更让人火大。
   */
  const prevMarker = join('dist', '.buildinfo.json')
  if (existsSync(prevMarker)) {
    try {
      const prev = JSON.parse(readFileSync(prevMarker, 'utf8'))
      const prevBase = String(prev?.apiBase || '')
      if (prevBase && prevBase !== String(process.env.VITE_API_BASE || '').replace(/\/$/, '')) {
        console.warn(
          `\n⚠️⚠️ 即将覆盖一份**子路径部署的产物**\n` +
          `    旧产物构建于 ${prev.builtAt || '未知时间'}，API 前缀 = ${prevBase}\n` +
          `    而这次构建的前缀 = ${String(process.env.VITE_API_BASE || '').replace(/\/$/, '') || '（空 = 站点根）'}\n` +
          `    如果这个 dist/ 正被挂在 ${prevBase}/ 上服务，跑完这一轮它就**全站 404**了。\n` +
          `    跑完请用同一个变量重建：VITE_API_BASE=${prevBase} npm run build\n`,
        )
      }
    } catch { /* 标记坏了就不说：宁可少一行警告，也不要在这里崩 */ }
  }
  const built = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { encoding: 'utf8' })
  if (built.status !== 0) {
    console.error('前端构建失败，后面的浏览器套件会跑到旧产物上。先修构建：')
    console.error((built.stdout || '') + (built.stderr || ''))
    process.exit(1)
  }
  if (!existsSync(join('dist', 'index.html'))) {
    console.error('构建结束了但 dist/index.html 不存在 —— 浏览器套件会全部失败，先查构建配置')
    process.exit(1)
  }
  console.log('已重新构建前端（浏览器套件跑的是这份产物）\n')
}

/**
 * 清扫上一轮遗留的测试临时产物。
 *
 * 为什么需要：绝大多数套件都会 kill 掉自己的服务再删 `data/_xxx.db`，
 * 但**服务刚被杀、文件还被系统占着**，`rmSync` 会抛 EBUSY，
 * 而套件里的 `catch {}` 把它吞了 —— 于是每次跑都漏一批。
 * 实测积到 **514 个库 / 774MB**，而且「测试全绿」，没有任何地方会报。
 *
 * 时间保护只清 1 小时前的：正在跑、或你正在翻的库不会被误删。
 * 清了什么会打印出来 —— 静默删东西比留着更让人不放心。
 *
 * ============================================================
 * **目录也必须清**（这一条是被实测逼出来的）
 * ------------------------------------------------------------
 * 原来这里只认 `.db / .db-wal / .db-shm / .err` 四种**文件**后缀。
 * 而 `test-container` 起的是 `data/_ctest-<时间戳>/` **目录** ——
 * 一旦这个套件中途被杀（我撞过一次工具超时被杀），目录整个留下。
 * 容器套件只在**跑完时**清理，中途挂掉就一个都不剩不下。
 *
 * 实测残留：`data/` 下十几个 `dk*` / `dockerdata` 目录、两个 475 文件
 * 17.5MB 的 `packtest*`（含一整份 src 拷贝），合计约 76MB ——
 * 而测试全绿，没有任何地方会报。
 *
 * 所以这里改成：`_` 开头的**文件或目录**都算临时产物，
 * 目录用 recursive 删，并统计整棵子树的大小。
 */
{
  const cutoff = Date.now() - 60 * 60 * 1000
  const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

  const junk = readdirSync('data').filter((f) => {
    if (!/^_/.test(f)) return false
    // 目录一律算；文件沿用原来的后缀白名单，免得把正经的 _something 误删
    if (isDir(join('data', f))) return true
    return /\.(db|db-wal|db-shm|err|mjs|log)$/.test(f)
  })

  const stale = junk.filter((f) => {
    try { return statSync(join('data', f)).mtimeMs < cutoff } catch { return false }
  })

  if (stale.length) {
    let freed = 0
    const countSize = (p) => {
      let n = 0
      let st
      try { st = statSync(p) } catch { return 0 }
      if (!st.isDirectory()) return st.size
      for (const e of readdirSync(p)) n += countSize(join(p, e))
      return n
    }
    const failed = []
    for (const f of stale) {
      const p = join('data', f)
      try {
        freed += countSize(p)
        rmSync(p, { recursive: true, force: true })
      } catch (e) {
        // 漏掉的清理失败必须报出来：静默留着等于谎称「清干净了」
        failed.push(`${f}（${String(e?.code || e?.message || e)}）`)
      }
    }
    console.log(`已清扫 ${stale.length} 个上次遗留的测试临时产物（约 ${(freed / 1024 / 1024).toFixed(1)}MB）`)
    if (failed.length) {
      console.log(`⚠️  有 ${failed.length} 个删不掉（多半还被进程占着）：${failed.join('、')}`)
    }
  }
}
const server = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', (d) => {
  const s = String(d)
  if (/Error|error:/.test(s) && !/ExperimentalWarning/.test(s)) process.stderr.write('[server] ' + s)
})

const cleanup = () => {
  try { server.kill() } catch { /* 已退出 */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB + suffix
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}
process.on('exit', cleanup)

// 等服务起来
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if (await healthCheck()) { up = true; break }
}
if (!up) {
  console.error('服务没能在 20 秒内起来')
  cleanup()
  process.exit(1)
}

/**
 * 某些套件需要额外的 node 参数。
 * lakebook 那个要直接 import `src/lib/lakebook.ts` —— 它是纯解析器，
 * 刻意不依赖 store，就是为了能在 Node 里跑；不传 strip-types 就只能靠
 * 起浏览器绕一圈，那样测的就不是解析器本身了。
 * converge3 同理：要 import `src/lib/crdt/core.ts`，把合并代数从浏览器里搬出来
 * 穷举到达顺序 —— 否则「三端并发是否收敛」这件事根本无法证伪。
 */
const SUITE_ARGS = {
  'test-lakebook.mjs': ['--experimental-strip-types'],
  // 要 import server/auth.ts 验 purgeExpiredSessions 的真实行为
  'test-sessionpurge.mjs': ['--experimental-strip-types'],
  'test-ipwlchanges.mjs': ['--experimental-strip-types'],
  'test-converge3.mjs': ['--experimental-strip-types'],
  // 从 smoke-crdt.test.cjs 转来的：core.ts 的因果投递层与对象级合并层
  'test-crdt-core.mjs': ['--experimental-strip-types'],
  // 导出/卡片那条要直接 import src/lib/blocks-markdown.ts
  'test-exportcards.mjs': ['--experimental-strip-types'],
  // 整库导出：要 import src/lib/book-export.ts 与 unzip.ts，
  // 验的是「**解开的 zip 内容**」而不是「函数没抛异常」——
  // 所以必须跑真代码，不能在测试里复算一遍逻辑（复算能过而真代码是坏的，
  // 实测踩过：docs 传数组形态时导出 0 篇，所有安全断言全绿）。
  'test-bookexport.mjs': ['--experimental-strip-types', '--import', './server/alias-hooks.mjs'],
  // 文本绘图的 Flowchart 解析与 SVG 渲染（纯函数，直接 import src/lib/flowchart.ts）
  'test-flowchart.mjs': ['--experimental-strip-types'],
  'test-mermaid.mjs': ['--experimental-strip-types'],
  'test-dot.mjs': ['--experimental-strip-types'],
  'test-gantt.mjs': ['--experimental-strip-types'],
  'test-statediagram.mjs': ['--experimental-strip-types'],
  'test-mindmap.mjs': ['--experimental-strip-types'],
  'test-pie.mjs': ['--experimental-strip-types'],
  'test-classdiagram.mjs': ['--experimental-strip-types'],
  'test-mdgraph.mjs': ['--experimental-strip-types'],
  'test-erdiagram.mjs': ['--experimental-strip-types'],
  'test-journey.mjs': ['--experimental-strip-types'],
    'test-timeline.mjs': ['--experimental-strip-types'],
    'test:sankey': ['--experimental-strip-types'],
    'test-firstline.mjs': ['--experimental-strip-types'],
  'test:classdef.mjs': ['--experimental-strip-types'],
  'test-docx.mjs': ['--experimental-strip-types'],
  'test-bookstats.mjs': ['--experimental-strip-types'],
  // zip / xlsx 导入：import-office.ts 是 TS，不传 strip-types 就只能从浏览器绕一圈，
  // 而绕一圈验的就不是「解析读得对不对」，是「界面点得动吗」。
  'test-import-office.mjs': ['--experimental-strip-types'],
  // Confluence 导入要读 zip，所以 unzip 也得能直接 import 源码 ——
  // 那个文件是 TS，不传 strip-types 就只能从浏览器绕一圈，
  // 而绕一圈验的就不是「解压读得对不对」，是「界面点得动吗」。
  'test-unzip.mjs': ['--experimental-strip-types'],
  'test-confluence.mjs': ['--experimental-strip-types'],
}

/**
 * 某些套件需要额外的**环境变量**（与 `SUITE_ARGS` 同形，但给的是 env 而不是参数）。
 *
 * 起因：部署验收 `test-deploy-acceptance.mjs` 一直**不在**全量里 ——
 * 它默认走 `docker compose up`，而 CI/本机常常没有出网，跑一次红一次，
 * 于是它被标成「只能手动跑」，**从此再没被自动验过**。
 *
 * 而它是整个项目里最贴目标的一个套件：以「公司运维第一天」的身份，
 * 验「空目录 + 一个进程 → 同事能注册、能建库、能写文档、换设备还在」。
 * 也就是说，它守的正是「能部署到内网」这条本体。
 *
 * 它本来就有一条不依赖 Docker 的路径（`YQ_ACCEPT_NO_DOCKER=1`，一个 Node 进程 +
 * 一个空数据目录），而那恰恰是我推荐给用户的部署形态 ——
 * 所以这里显式走那条路。
 *
 * ⚠️ 端口**必须**和运行器自己那个（8092）以及任何别的套件都错开：
 * 这个套件自己会起服务，撞上别人的服务时它会**对着别人的实例跑**，
 * 而「连不上」和「测试失败」在输出里长得很像。
 */
const SUITE_ENV = {
  'test-deploy-acceptance.mjs': {
    YQ_ACCEPT_NO_DOCKER: '1',
    /*
     * 端口**现挑一个空闲的**，不要写死 8180。
     * 理由：写死的端口会被机器上碰巧占着它的进程打挂，
     * 而症状是「没找到汇总行、连逐项 PASS/FAIL 都没有」——
     * **完全指不到真因**（2026-10-19 实测：8111 被一个 python 程序占了，
     * test-invite-e2e 就那样崩在了全量里）。
     */
    YQ_ACCEPT_PORT: process.env.YQ_ACCEPT_PORT || String(await freePort()),
  },
}

let totalPass = 0
let totalFail = 0
const failed = []
/** 每个套件实际跑出多少项 —— 供文档逐套件核对用 */
const actualItems = new Map()

/* ============================================================
   注册完整性：npm script 里有的套件，是不是都在 SUITES 里
   ------------------------------------------------------------
   为什么要有这道：写完一个套件，加了 \`npm run test:xxx\`，
   但**忘了加进 SUITES** —— 套件一次都不会跑，而全套绿。
   上一轮就栽在这里：`test-docmove` 写了、跑通了、破坏对照全红了，
   然后我看着 \`node -e\` 打的「已注册」就以为完事了；
   是靠人眼扫「套件总数怎么没变多」才发现的。

   文档核对那一节抓不到这种：它只比**数字**，
   而少一个套件时「实际跑的项数」和「文档写的项数」只要都按旧的写，
   两边就自洽了 —— 绿得毫无破绽。
   ============================================================ */
{
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const scripted = new Map()   // file -> npm script 名
  /*
   * ⚠️ 原来用的是 `/\b(test-[a-z0-9-]+\.mjs)\b/`，它会把
   * `node scripts/gen-test-index.mjs` 里的**子串** `test-index.mjs` 认成套件 ——
   * 因为 `-` 是非单词字符，`-t` 之间就成立一个 `\b`。
   * 于是每轮全量都报一条「test-index.mjs 有 npm script 但没进 test:all」，
   * 而**那个文件根本不存在**。
   *
   * 假阳性比漏报更坏：它会让人去「修」一个不存在的东西。
   * 所以要求文件名前面**不能是字母数字或连字符**（路径分隔符和空格可以）。
   */
  const SCRIPT_FILE_RE = /(?:^|[^a-z0-9-])(test-[a-z0-9-]+\.mjs)\b/
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (!name.startsWith('test:')) continue
    const file = SCRIPT_FILE_RE.exec(cmd)?.[1]
    if (file) scripted.set(file, name)
  }
  const missing = [...scripted.keys()].filter((f) => !SUITES.includes(f)).sort()
  const orphans = SUITES.filter((f) => f !== 'test-lint.mjs' && !scripted.has(f)).sort()
  if (missing.length) {
    console.log(`\n⚠️  这些套件有 npm script，但**没进 test:all** —— 全量回归不覆盖它们：`)
    for (const f of missing) console.log(`   · ${f}   （只能手动跑：npm run ${scripted.get(f)}）`)
  }
  if (orphans.length) {
    console.log(`\n⚠️  test:all 里有这些套件，但没有对应的 npm script（单独跑不了）：`)
    for (const f of orphans) console.log('   · ' + f)
  }
  if (!missing.length && !orphans.length) {
    console.log(`注册核对通过：${scripted.size} 个 test: script 与 test:all 列表一致`)
  }
}

/**
 * 每个套件跑完立刻收拾它自己的临时产物 —— **跑绿的就删，跑红的留下**。
 *
 * 为什么要按套件清，而不是只在整轮结束时清：
 *
 *   · 整轮清只清「上一轮」的（见文末那段清扫），于是 `data/` 里**永远躺着
 *     一整轮的残留** —— 实测 140 多个文件、111MB。跑得越勤，看着越像泄漏。
 *   · 而**一次都不能删**：套件失败时那些产物是唯一的取证材料。
 *     截图、临时库、被改到一半的夹具，全靠它。
 *
 * 所以按套件归因：跑之前拍一张 `data/_*` 的快照，跑完差集就是它留下的。
 * 绿了 → 删掉，并**说出来**（它自己没收摊，这事不该被悄悄吞掉）；
 * 红了 → 原样留着，那一行就是给你排查用的线索。
 */
const snapshotTemps = () => {
  try {
    const m = new Map()
    for (const f of readdirSync('data')) {
      if (!/^_/.test(f)) continue
      try { m.set(f, statSync(join('data', f)).mtimeMs) } catch { /* 刚被别人删了 */ }
    }
    return m
  } catch { return new Map() }
}
/**
 * ⚠️ 判据必须是「**新出现的** ∪ 「**mtime 变了的**」，只看名字不够。
 *
 * 第一版只比名字，结果是：上一轮就存在的 `_doclinks-test.db` 被本轮的套件
 * **改写**（而不是新建）—— 名字在快照里就有，于是差集为空，压根不删；
 * 而末尾那个清扫又按「mtime >= RUN_STARTED = 本轮产生的，留着」把它跳过。
 * 两边一夹，它**每轮都被改活、永远清不掉** —— 实测 147 个文件 / 100MB
 * 就是这么攒下来的，而且每一轮的报告都说「已清掉 N 个上一轮遗留的」。
 */
const diffTemps = (before) => {
  const out = []
  try {
    for (const f of readdirSync('data')) {
      if (!/^_/.test(f)) continue
      let mt = 0
      try { mt = statSync(join('data', f)).mtimeMs } catch { continue }
      const old = before.get(f)
      if (old === undefined || old !== mt) out.push(f)
    }
  } catch { /* data 目录读不了就算了，别把 runner 自己搞崩 */ }
  return out
}
const sweepSuiteTemps = (suite, files, suitePassed) => {
  /*
   * ⚠️⚠️ **绝不能碰 runner 自己的库**。
   *
   * `DB = data/_testrun-<ts>.db` 就是**整轮测试全部套件共用的那一个库**，
   * 它也以 `_` 开头，于是会落进上面的差集里。现在只是因为服务端一直开着
   * 才「碰巧」删不掉 —— 那是运气，不是保护。哪一轮它可删了（比如服务端
   * 提前退出），这一行就会把整轮测试的库删掉，后面每个套件全炸。
   *
   * 所以按**名字**硬排除，不是靠「删不掉」。靠失败来保护关键文件，
   * 等于把一次偶发当成了防线。
   */
  /*
   * ⚠️ 比较的必须是**裸文件名**。
   *
   * `DB` 常量带的是 `data/` 前缀（`data/_testrun-<ts>.db`），
   * 而差集 `files` 里是 `readdirSync('data')` 的结果 —— 裸名字。
   * 头一版直接 `mine.includes(f)`，两边字符串形态不一样，
   * 于是排除**静默失效**，日志里照样刷「`_testrun-*.db` 删不掉」。
   * 排除写成这样而没验证，等于没写。
   */
  const dbName = DB.split('/').pop()
  const mine = ['', '-wal', '-shm'].map((s) => dbName + s)
  files = files.filter((f) => !mine.includes(f))

  /*
   * ⚠️ **只删「像临时产物」的文件**（2026-10-10 加）。
   *
   * 这一节原先把差集里的文件**无差别删掉**。撞上的实例：
   * 我把实测记录 `data/_fidelity-booksettings.md` 放进 data/，
   * 跑一次全量之后**文件没了** —— 而它不是临时产物，
   * 是「改这块代码时对着它做」的依据，删了等于把证据扔了。
   *
   * 判据与同文件里那段「上一轮遗留清扫」用**同一套后缀白名单**
   * （那边本来就是白名单，这边却不是 —— 两处口径不一致，缝就在缝里）。
   *
   * 目录一律删（`test-container` 起的就是目录）。
   * 白名单之外的文件**留着并在日志里说出来** ——
   * 静默删掉等于「我以为清干净了」。
   */
  const TEMP_EXT = /\.(db|db-wal|db-shm|err|mjs|log|json|png|tmp)$/
  const isDirF = (q) => { try { return statSync(q).isDirectory() } catch { return false } }
  const allNew = files
  const realTemps = allNew.filter((f) => isDirF(join('data', f)) || TEMP_EXT.test(f))
  const kept = allNew.filter((f) => !realTemps.includes(f))
  if (kept.length) {
    console.log(`       跳过 ${kept.length} 个不像临时产物的文件：${kept.slice(0, 4).join('、')}`)
  }
  files = realTemps

  if (!files.length) return
  if (!suitePassed) {
    console.log(`       留下 ${files.length} 个临时产物供排查：${files.slice(0, 4).join('、')}`)
    return
  }
  let n = 0
  const stuck = []
  for (const f of files) {
    // 删不掉的最常见原因是套件自己起的服务/浏览器还没退干净 —— 重试几次
    let okDel = false
    for (let i = 0; i < 3 && !okDel; i++) {
      try { rmSync(join('data', f), { recursive: true, force: true }); okDel = true } catch { /* 稍后重试 */ }
    }
    if (okDel) n++
    else stuck.push(f)
  }
  console.log(`       （套件自己没收摊，已代为清理 ${n} 个临时产物${stuck.length ? `；${stuck.length} 个删不掉：${stuck.join('、')}` : ''}）`)
}

for (const suite of SUITES) {
  /**
   * 跑之前先做语法预检。
   *
   * 不加这道的时候，一个套件里少个右括号，报出来的是一整段
   * `#getOrCreateModuleJobAfterResolve … ERR_MODULE_NOT_FOUND` 的栈，
   * 看起来像「文件丢了」，实际上是少了一个 `)`。
   * 一行 `node --check` 就能把这类问题变成一句人话。
   */
  const chk = spawnSync(process.execPath, ['--check', suite], { encoding: 'utf8' })
  if (chk.status !== 0) {
    totalFail++
    failed.push(suite)
    console.log(`FAIL ${suite.padEnd(24)} 套件本身有语法错误`)
    const line = (chk.stderr || '').split('\n').find((l) => /Error|error/.test(l)) || ''
    console.log('       ' + (line.trim() || (chk.stderr || '').split('\n').slice(0, 3).join(' ')).slice(0, 160))
    continue
  }
  // YQ_DB 也要传：需要**直接查库**才能验的套件（而不是只看接口返回值）
  // 以前拿不到这个路径，只能自己另起一个服务 —— 那样验的就不是同一个库了。
  const before = snapshotTemps()
  const r = await run(
    [...(SUITE_ARGS[suite] || []), suite],
    { BASE, YQ_PORT: PORT, YQ_DB: DB, ...(SUITE_ENV[suite] || {}) },
  )
  const leftovers = diffTemps(before)
  const m = /结果：(\d+) 通过 \/ (\d+) 失败/.exec(r.out)
  if (m) {
    totalPass += Number(m[1])
    totalFail += Number(m[2])
    actualItems.set(suite, Number(m[1]) + Number(m[2]))
    const mark = Number(m[2]) === 0 ? 'OK  ' : 'FAIL'
    console.log(`${mark} ${suite.padEnd(24)} ${m[1]} 通过 / ${m[2]} 失败`)
    if (leftovers.length) sweepSuiteTemps(suite, leftovers, Number(m[2]) === 0)
    if (Number(m[2])) {
      failed.push(suite)
      r.out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 5).forEach((l) => console.log('       ' + l.trim()))
    }
  } else {
    totalFail++
    failed.push(suite)
    /* 汇总行都没写出来 = 没跑完 —— 产物一律留着，取证全靠它 */
    if (leftovers.length) {
      console.log(`       留下 ${leftovers.length} 个临时产物供排查：${leftovers.slice(0, 4).join('、')}`)
    }
    /*
     * 这里原来一律说「套件本身异常」—— 而**最常见的原因根本不是异常**，
     * 是汇总行没写成约定的 `结果：N 通过 / M 失败`，于是上面那条正则没匹配上。
     *
     * 2026-10-05 真踩到过：`test-ipwlchanges` 15 项**全过**，
     * 汇总行写成「通过 15 / 失败 0」（语序不对），结果被判成「套件本身异常」，
     * 而且那 15 项**一项都没进总数** —— 套件全绿，统计里查无此项。
     *
     * 报「异常」会把人引去查代码，而代码一点问题都没有；
     * 更糟的是它同时**掩盖了真正的事实**：这个套件其实通过了。
     * 所以这里先说清「没找到汇总行」，再按「有没有逐项结果」分两种说法。
     */
    const hasItemLines = /\n\s*(PASS|FAIL)\s/.test(r.out)
    console.log(`FAIL ${suite.padEnd(24)} 没找到汇总行「结果：N 通过 / M 失败」，项数没计进总数`)
    if (hasItemLines) {
      console.log('       这一行是约定用语序，套件很可能**全过**了 —— 改汇总行即可，别去改逻辑。')
    } else {
      console.log('       而且输出里连逐项 PASS/FAIL 都没有，看起来是真的没跑起来。')
    }
    /*
     * 退出码要一并打出来，因为它常常是**唯一**的线索。
     *
     * 2026-10-08 实测：`test-exportattach` 在 Windows 上**每次**都以
     * 3221226505 (0xC0000409，栈缓冲区溢出) 退出 —— 那是 Playwright
     * 关闭时的清理崩溃，发生在汇总行打印**之后**。也就是说
     * 「退出码异常」与「测试失败」是两回事。
     *
     * 更麻烦的是：这种崩溃偶尔会**连 stdout 的尾部一起吞掉**，
     * 于是汇总行没收到 → 落到上面那个分支 → 被报成「没跑起来」。
     * 本机连跑 8 次复现不出（汇总行每次都在），所以只能靠退出码提示，
     * 而不是断言「一定是崩溃」。
     */
    console.log(`       退出码 ${r.code}` + (
      r.code === 3221226505 ? '（0xC0000409：进程退出时崩溃，常见于 Playwright 清理；测试结果本身可能是好的）'
        : r.code === 0 ? '' : '（非 0 退出码，值得单独查）'
    ))
    r.out.split('\n').filter((l) => l.trim()).slice(-6).forEach((l) => console.log('       ' + l.slice(0, 140)))
  }
}

cleanup()
console.log(`\n合计：${totalPass} 通过 / ${totalFail} 失败${failed.length ? '   失败套件：' + failed.join(', ') : ''}`)

/**
 * data/ 里现在有多少测试残留。
 *
 * 上一轮就栽在这上面：19 个测试目录、约 76MB（含两个各 475 文件、
 * 17.5MB 的包，里面还有一整份 src 拷贝）长期躺在盘上，
 * 而**测试全绿**，没有任何地方会报。
 *
 * 启动清扫只救「下一次运行」—— 攒下来的那些是历史遗留，清扫也认不出来
 * （它们不带 `_` 前缀）。所以这里在跑完之后**把真实体积摆出来**：
 * 超过阈值就明确说「有东西漏了」，而不是让人自己哪天发现 C 盘满了才发现。
 */
function reportDataSize() {
  const sizeOf = (p) => {
    let n = 0
    let st
    try { st = statSync(p) } catch { return 0 }
    if (!st.isDirectory()) return st.size
    for (const e of readdirSync(p)) n += sizeOf(join(p, e))
    return n
  }
  let total = 0
  const byEntry = []
  for (const e of readdirSync('data')) {
    const s = sizeOf(join('data', e))
    total += s
    byEntry.push([e, s])
  }
  const mb = total / 1024 / 1024
  const LIMIT = 200
  if (mb > LIMIT) {
    const top = byEntry.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, s]) => `${n} ${(s / 1024 / 1024).toFixed(1)}MB`).join('、')
    console.log(`⚠️  data/ 已经涨到 ${mb.toFixed(1)}MB（阈值 ${LIMIT}MB）——有测试产物在泄漏。占用最大的：${top}`)
    console.log(`   下次运行会清掉带 _ 前缀的临时产物；不带前缀的那些是历史遗留，要手工删。`)
  } else {
    console.log(`data/ 占用 ${mb.toFixed(1)}MB（阈值 ${LIMIT}MB）`)
  }
}

/**
 * 文档里的套件数 / 项数，**当场核对**。
 *
 * 这两个数字是纯手写同步的，注定会漂 —— 我接手时 README 写着 508，
 * 实际已经是别的数；这几轮又改了四五次，每改一次就多一次写错的可能。
 * 交付文档里的数字错了比没有更糟：读的人会拿它当基准。
 *
 * 跑完就知道真值，所以**在这一刻对**，而不是靠谁记得去改。
 */
{
  const docStale = []
const docCorrupt = []
/**
 * 「命令名对不上」单独一个桶，不混进 docStale。
 *
 * 原因不是分类癖，是因为**两者的可信度不一样**：
 * 数字类在文档损坏时可能有假象（粘连的长行把两处数字接在一起），
 * 而命令名这条**完全不受损坏影响** —— 判据的正则只收 `[A-Za-z0-9_-]`，
 * 连字符被替换符吃掉时那个名字根本取不出来，所以结果只会是**漏报**。
 *
 * 混在一起的后果很具体：第一版把它们放在同一段、挂同一句免责语，
 * 而免责语写的是「这一段仍可能有假象」—— 于是**一条百分之百可信的真发现
 * 被标成了可疑**。读者要么被引去查损坏（查不出东西），要么干脆忽略整段。
 *
 * 报告把人引向错误的排查方向，比报告太长严重得多。
 */
/*
 * ⚠️ 这个常量必须在 `for (const f of [...])` **循环外面**声明。
 *
 * 实测（2026-10-18 23:19→00:02 的一轮全量）：`ReferenceError: FFFD is not defined`
 * 打在下面报告段的 `console.log` 上 —— 因为它原来声明在**循环体内部**，
 * 而报告段在循环外面。
 *
 * 后果比「一句提示打不出来」严重得多，而且是**静默**的：
 * 那个异常发生在异步回调里 → 变成未捕获异常**直接把进程打死**，
 * 于是后面三段**根本没跑**：
 *   · 套件项数稳定性对比（一行输出都没有）
 *   · `data/_last-counts.json` 基线写入（所以它一直停在 18:11，
 *     而我一直以为那是「写失败被吞掉」—— 真因是压根没执行到这里）
 *   · 末尾的 `process.exit(总失败 ? 1 : 0)`
 * 而输出停在**半句话**上，看着像「跑完了，只是后面没内容」。
 *
 * ⚠️ 也不能直接写那个字符的字面量 —— `test-lint` 有一条「源码里没有乱码替换字符」，
 * 写了它自己就会判失败。同款理由见 test-lint 里那段注释。
 */
const FFFD = String.fromCharCode(0xfffd)

const docNameStale = []
  for (const f of ['README.md', 'DEPLOY.md']) {
    let s = ''
    try { s = readFileSync(f, 'utf8') } catch { continue }
    const suites = s.match(/覆盖\s*(\d+)\s*个套件/)
    const items = s.match(/合计\s*\*\*(\d+)\s*项\*\*|覆盖\s*\d+\s*个套件\s*(\d+)\s*项/)
    const nSuites = suites ? Number(suites[1]) : null
    const nItems = items ? Number(items[1] || items[2]) : null
    if (nSuites != null && nSuites !== SUITES.length) {
      docStale.push(`${f}：写的是 ${nSuites} 个套件，实际 ${SUITES.length} 个`)
    }
    if (nItems != null && nItems !== totalPass + totalFail) {
      docStale.push(`${f}：写的是 ${nItems} 项，实际 ${totalPass + totalFail} 项`)
    }

    /**
     * 逐套件的项数也要核 —— 只核总数是不够的。
     *
     * 清单里每一行的 N 都是手写的。总数对了不代表每行都对：加一个套件、
     * 某个套件多写两条断言，总数立刻跟着变，而**清单里那一行不会自己变**。
     * 实测就是这样：`test:lint` 写着 7 项（实际已 21）、
     * `test:lakebook` 写 39（实际 48）、`test:no-fake` 写 19（实际 46），
     * 三处都藏在「总数对得上」底下。
     *
     * 两种排版都要认：README 用 `npm run test:x   #  N 项`，
     * DEPLOY 用表格 `| test:x | N |`。名字也写法不一
     * （DEPLOY 写 `test:search-page`，package.json 是 `test:searchpage`），
     * 所以比对前把连字符去掉再比 —— 少写一张映射表，那张表自己就会开始漂。
     */
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const scriptOf = new Map()
    for (const [script, cmd] of Object.entries(pkg.scripts || {})) {
      const file = /\b(test-[a-z0-9-]+\.mjs)\b/.exec(cmd)?.[1]
      if (file && script.startsWith('test:')) scriptOf.set(file, script)
    }
    const norm = (s) => s.replace(/[-_]/g, '')
    const hasList = /npm run test:|^\s*\|\s*`?test:/m.test(s)
    if (hasList) {
      // 文档里也要归一化 —— 只归一化模式的话，`test:no-fake` 永远匹配不上 `test:nofake`
      const ns = norm(s)
      for (const [file, actual] of actualItems) {
        const script = scriptOf.get(file)
        const names = [script, 'test:' + file.replace(/^test-/, '').replace(/\.mjs$/, '')].filter(Boolean).map(norm)
        /*
         * 收集**全部**出现过的写法，而不是取第一个。
         *
         * 原来只取第一个匹配（`if (m2) { claimed = …; break }`），于是
         * 「同一个项数在文档里写在好几处、只改了一处」这个错会表现成：
         * 报错说「写的是 51」，你找到那一处改掉，重跑，**同一句话再来一次** ——
         * 而它从来没说是哪一处。
         * 2026-10-06 为此白跑了一次全量：`test:container` 的项数在 DEPLOY 里
         * 出现在表格和「跑一遍容器套件」那段，我只改了表格。
         *
         * 多个不同值本身就是一条**独立的问题**，必须先说出来：
         * 「这一项在文档里有 51 和 55 两个值」比「写的是 51」有用得多。
         */
        const found = []
        for (const n of names) {
          const e = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          for (const re of [
            new RegExp('npm run ' + e + '\\s*#\\s*(\\d+)\\s*项', 'g'),
            new RegExp('`?' + e + '`?\\s*\\|\\s*(\\d+)\\s*\\|', 'g'),
          ]) {
            for (const m of ns.matchAll(re)) found.push(Number(m[1]))
          }
        }
        const uniq = [...new Set(found)]
        const label = script || file
        if (uniq.length > 1) {
          docStale.push(`${f}：${label} 的项数在文档里有 ${uniq.length} 个不同值（${uniq.join(' / ')}）—— 实际 ${actual} 项，先让它们一致`)
        } else if (uniq.length === 0) {
          docStale.push(`${f}：清单里没有列出 ${label} 的项数（实际 ${actual} 项）`)
        } else if (uniq[0] !== actual) {
          docStale.push(`${f}：${label} 写的是 ${uniq[0]} 项，实际 ${actual} 项`)
        }
      }

      /*
       * 命令名逐字符核对 —— 上面那个比对是**归一化之后**做的（去掉 `-` 和 `_`），
       * 那是故意的，为的是少维护一张「文档别名 → 真名」映射表
       * （那张表自己就会开始漂，这条写在上面那段注释里）。
       *
       * 代价是：**命令名里连字符写错，上面那条查不出来**。
       * 归一化之后 `test:search-page` 和 `test:searchpage` 是同一个字符串。
       *
       * 而部署文档里的命令是给人**照抄**的：照抄一个不存在的 script 名，
       * 回车就是一句 `Missing script`，然后读的人以为部署文档坏了。
       *
       * DEPLOY 里真的有过这么一处：表格写 `test:search-page`，
       * package.json 里是 `test:searchpage`（文件叫 test-search-page.mjs，
       * 但 script 名没有那个连字符）。**所有既有检查全绿** ——
       * 是手工核对时看见的，不是工具报的。已修，但没工具就会再犯。
       *
       * 为什么这条不会被文档损坏**误报**：
       * 损伤是标点被替换成 U+FFFD，而这里的正则只收 `[A-Za-z0-9_-]`；
       * 连字符被吃掉时根本取不出这个名字，于是结果是**漏报**而不是误报。
       * 漏报可以接受 —— 误报会把一条真检查变成噪声，代价大得多。
       */
      const realScripts = new Set(Object.keys(pkg.scripts || {}).filter((k) => k.startsWith('test:')))
      const realByNorm = new Map([...realScripts].map((k) => [norm(k), k]))
      const wrongNames = new Map()
      for (const m of s.matchAll(/^[ \t]*(?:npm run |\|\s*`)(test:[A-Za-z0-9_-]+)/gm)) {
        const name = m[1]
        if (realScripts.has(name)) continue
        const real = realByNorm.get(norm(name))
        if (!real) continue // 不是命令写法（正文里的 `test:xxx` 占位符之类）
        if (!wrongNames.has(name)) wrongNames.set(name, real)
      }
      for (const [name, real] of wrongNames) {
        docNameStale.push(`${f}：命令名写的是 ${name}，package.json 里是 ${real} —— 照抄会报 Missing script`)
      }

      /*
       * ⚠️ 上面那条「清单里没有列出 X」有两种完全不同的原因，而它**分不开**：
       *   · 清单里真的没写这个套件；
       *   · 清单里写了，但**文档内容被损坏到正则读不出来**。
       *
       * 2026-10-05 真踩到过第二种：我用 `Set-Content` 改文档里的数字，
       * PowerShell 按 GBK 读了 UTF-8 文件 → 整套文档乱码 + 大段换行被吃掉。
       * 于是 `npm run test:server     # 47 项` 里的「项」字变成了替换符，
       * **70 个套件全部报「没有列出」** —— 而这条报错的措辞
       * 会把人引向「去清单里补条目」，而真正的问题是**文件被写坏了**。
       *
       * 所以这里把两种情况分开报，别让「文件坏了」显示成「缺条目」。
       * ⚠️ 但**这个检查现在长期红着** —— 因为那份文档已经被写坏过一次，
       * 往返恢复了约 91%，剩下约 6000 处标点损坏、20 余处段落粘连没能还原
       * （无 git、无备份、无卷影副本，见 README 7.27）。
       * 它长期红着的**代价是这条自检会被当成噪声忽略**，而那正是它本该防的事。
       * 根治要么重写受损段落，要么拿一份完好的 README/DEPLOY 覆盖回来 ——
       * 后者更省事，见 README 7.27 记的处置办法。
       */
      /*
       * FFFD 声明在**循环外面**（见上面那段「这个常量必须在循环外面声明」）。
       * 它原来声明在这里 —— 于是循环外的报告段引用不到，
       * ReferenceError 在异步回调里把整个 runner 打死了，后面三段检查全部没跑。
       * ⚠️ 别把它「清理」回这个循环体里。
       */
      const reBad = s.split(FFFD).length - 1
      /*
       * 「粘连超长行」原来只报 **>400 字符的行数**，并把它整个叫成「粘连」。
       *
       * 实测（2026-10-06）：DEPLOY 47 行超长行里，**只有 32 行含替换符**，
       * 另外 15 行是**干净的长表格行** —— 那张表本来就每行都超 400 字符
       * （`test:emptyfirst` 单行 1085 字符、`test:lint` 1371 字符）。
       * 而 README 那 21 行**全部**含替换符，是真粘连。
       *
       * 为什么不修就有害，而不只是「不准」：
       *  1. 报「粘连超长行 47 行」会让人以为有 47 行粘连，实际受损 32 行；
       *  2. **而这个数正是用户判断「要不要拿一份完好文档覆盖回来」的依据** ——
       *     虚高的损伤数会推动一个不必要的决定；
       *  3. 它已经被实测污染过一次：当天往 DEPLOY 插入一个 **444 字符的健康表格行**
       *     （test:day1 的登记行，邻居是 811 / 441 字符），
       *     这个数就从 46 变成 47 —— **一个健康行被算成了损伤**。
       *
       * 所以分开报：受损的（长**且**含替换符）与健康的（长但干净）各多少。
       * 注意 `reBad || longDamaged` 这个条件**没变松**：只要文件里有过替换符
       * 就仍然报「内容已损坏」，不存在「因为一行都没被判成粘连就说不损坏」。
       */
      const longLines = s.split('\n').filter((l) => l.length > 400)
      const longDamaged = longLines.filter((l) => l.includes(FFFD)).length
      const longClean = longLines.length - longDamaged

      /*
       * 总数核对 —— 原来只逐个核套件，**总数没人管**。
       *
       * 于是踩到了：DEPLOY 写着「73 个套件 2182 项」，实际已经是 75 / 2231
       * （中间加了 `test:offboardrole` 和 `test:trustproxy`），
       * 而**每一条套件的项数都是对的** —— 因为「总数」是另一句话，
       * 上面的循环根本不读它。
       *
       * 更难堪的是我改数字时改的是 README，DEPLOY 那次「没匹配到」，
       * 我**当成了已经对了**（这是 7.27 那条「没报错 ≠ 成功」的老坑，
       * 只是这次的形态是「替换没生效」而不是「读不到」）。
       *
       * 认两种写法：``覆盖 N 个套件 M 项`` 和 `合计 **M 项**（N 个套件）`。
       */
      const totalItems = totalPass + totalFail
      for (const m of s.matchAll(/(\d+)\s*个套件[^0-9]{0,12}(\d+)\s*项/g)) {
        if (Number(m[1]) !== SUITES.length) docStale.push(`${f}：写的是「${m[0]}」，实际 ${SUITES.length} 个套件`)
        if (Number(m[2]) !== totalItems) docStale.push(`${f}：写的是「${m[0]}」，实际 ${totalItems} 项`)
      }
      for (const m of s.matchAll(/合计\s*\*\*(\d+)\s*项\*\*\s*（(\d+)\s*个套件/g)) {
        if (Number(m[1]) !== totalItems) docStale.push(`${f}：合计写的是 ${m[1]} 项，实际 ${totalItems} 项`)
        if (Number(m[2]) !== SUITES.length) docStale.push(`${f}：套件数写的是 ${m[2]}，实际 ${SUITES.length}`)
      }
      /*
       * ⚠️ 这里**试过**再加一条「表格缺列定位」，自己试完撤掉了。
       *
       * 想法是好的：只报「粘连超长行 N 行」，修的人得自己去找；
       * 而 Markdown 表格少一列会整行渲染错位。
       * 实测也确实找到了 README 差距表里 3 行只剩 2 段的。
       *
       * 但第一版是**错的**，而且错得很难看：
       * 它拿「全文里出现最多的段数」当基准，而这份文档里
       * **2 列的表和 4 列的表都很多**（能力表 2 列、对比表 4 列），
       * 于是它把**正常的 2 列表**全判成「缺列」—— 报出 290 行。
       *
       * 正确的做法得**按表分组**（用分隔行 `| --- | --- |` 定位每张表的
       * 起始行，往下数到空行为止，然后在每张表内部比段数），
       * 那就不是十几行的事，而且**表结构本来就允许列数不一样**。
       *
       * 留一个恒红、还天天误报的检查，比没有更糟 ——
       * 这正是本项目记过好几次的那条：**长期红着的自检会被当成噪声**。
       * 受损的三行连同成因记在 README 7.27，真要修就按那份记录手工处理。
       */
      if (reBad || longDamaged) {
        docCorrupt.push(`${f}：内容已损坏（U+FFFD ${reBad} 处；>400 字符的长行 ${longLines.length} 行 —— 含替换符的 ${longDamaged} 行是受损，干净的 ${longClean} 行是正常的长表格行，不用管）—— 见 README 7.27`)
      }
    }
  }
  /*
   * ⚠️ 这段**曾经**是 `if (docCorrupt) … else if (docStale) …`，
   * 而 `docCorrupt` 长期非空 → `docStale` 算出来存进数组就永远走不到输出，
   * 「数字对账」和「清单漏登记」两条检查**静默失效**。
   * 那次真代价：`test:sessionpurge` 全流程做完了（npm script 加了、SUITES 加了、
   * 跑通 18 项），两份文档里都没有它，而全量输出**一个字都没提**。
   *
   * ✅ **已经修好了**（2026-10-16 前后）：下面 `docCorrupt` / `docNameStale` /
   *    `missingItems` / `numericStale` 是**各自独立的 if**，互不吞。
   *
   * ⚠️ 留这段注释是因为它描述的 bug **看起来还在** ——
   *    2026-10-18 我照着它又去「修」了一遍那个 `else if`，
   *    而那个分支早就不存在了。**注释也会过期**，
   *    判断某个缺陷在不在，看代码，别看注释。
   *
   * 与「长期红着的自检会被当成噪声」同族，但更糟一层：
   *   · 被噪声淹没的检查 = 没人看；
   *   · **永远走不到的检查 = 连噪声都不产生**，让人以为一直有人在看。
   */
  if (docCorrupt.length) {
    console.log('\n🛑 文档内容已损坏（这一条是**已知项**，不是新问题）：')
    for (const d of docCorrupt) console.log('   · ' + d)
    console.log('   成因：2026-10-05 在 PowerShell 里用 `Set-Content` 改文档数字，')
    console.log('   它按系统 ANSI（简体中文机器上是 GBK）读 UTF-8 文件，')
    console.log('   中文整片乱码，约 8% 的标点与部分汉字不可逆丢失。')
    console.log('')
    console.log('   ⚠️ 不要再去找「一份完好的 README/DEPLOY 覆盖回来」——')
    console.log('   2026-10-18 已确认**不存在**：工作区副本、桌面/下载/文档、')
    console.log('   卷影副本（要管理员权限）、data/_damaged_*.bak 全部找过；')
    console.log('   最后那个对 GBK↔UTF-8 做往返能把乱码变回中文，')
    /*
     * ⚠️ 这里**不能直接写那个替换符的字面量** ——
     * `test-lint` 有一条「源码里没有乱码替换字符」，写了它自己就会判失败。
     * 同款理由见上面 `const FFFD = String.fromCharCode(0xfffd)` 那段注释。
     */
    console.log(`   但 ${FFFD} 一个也没少，`)
    console.log('   说明洞在快照之前就丢了。**逐处猜补 = 编内容，不做。**')
    console.log('')
    console.log('   已定的处置口径（见 README.md 顶部那一段）：')
    console.log('   · 可验证的数字照常维护 —— 清单项数、合计、套件数按真实回归对齐')
    console.log(`   · 其余一个字不动，空着的 ${FFFD} 就空着，它至少是诚实的`)
    console.log('   · **改文档一律用编辑工具**；必须走命令行就用 node 的')
    console.log('     readFileSync/writeFileSync（显式 utf8），别用 Set-Content。')
    console.log('   · 日常部署照 **RUNBOOK.md** 做（完好无损，有 `test:runbook` 守着）。')
  }

  /*
   * 三类分开报，因为它们的**可信度在文档损坏时不一样**：
   *
   *   · 「命令名对不上」—— **完全不受损坏影响**。判据正则只收
   *     `[A-Za-z0-9_-]`，连字符被替换符吃掉时那个名字根本取不出来，
   *     所以损坏只可能造成**漏报**，不可能造出假象。照报，且不挂免责语。
   *   · 「写的是 N 项，实际 M 项」—— 数字是 ASCII，乱码不吃它；
   *     但粘连的长行会把两处数字接在一起，看着像对不上。所以损坏时加一句提醒。
   *   · 「清单里没有列出 X」—— 判据是 `npm run test:xxx    # N 项`，
   *     而清单里的**「项」字正是被替换符吃掉的那个**（见上面那段注释）。
   *     损坏期间会混进假象，所以先列 5 条样本，剩下的报数量。
   *
   * ⚠️ 分桶不是为了好看。第一版把「命令名不符」塞进 docStale，
   * 于是它和「数字不符」共用一句话免责语「这一段仍可能有假象」——
   * **一条百分之百可信的真发现被标成了可疑**。
   * 报告把人引向错误的排查方向，比报告太长严重得多。
   */
  if (docNameStale.length) {
    console.log('\n⚠️  文档里的命令名和 package.json 对不上（照抄会报 Missing script）：')
    for (const d of docNameStale) console.log('   · ' + d)
    console.log('   这条不受文档损坏影响 —— 连字符被吃掉时名字取不出来，只可能漏报，不会误报。')
  }

  const isMissingItem = (d) => d.includes('清单里没有列出')
  const missingItems = docStale.filter(isMissingItem)
  const numericStale = docStale.filter((d) => !isMissingItem(d))

  if (numericStale.length) {
    console.log('\n⚠️  文档里的测试数字已经和实际对不上了：')
    for (const d of numericStale) console.log('   · ' + d)
    if (docCorrupt.length) {
      console.log('   （文档损坏期间这一段仍可能有假象：粘连的长行会把两处的数字接在一起，')
      console.log('    看着像对不上。修好文档后重跑一次再下结论。）')
    } else {
      console.log('   请同步 README.md / DEPLOY.md 后再提交。')
    }
  }
  if (missingItems.length) {
    if (docCorrupt.length) {
      /*
       * 列出前 5 条而不是只报数量 —— 第一版只给数量，是想避免 70 行假象。
       * 但那样写出了「多半是假象」这句话，而这句话**会训练人忽略整条检查**：
       * 2026-10-05 那次删掉 DEPLOY 一行登记，输出就是「另有 1 处」。
       * 那一处是真缺陷（不是损坏的假象），而读者拿到的提示是「多半是假的」。
       *
       * 「报告会把人引向错误的排查方向」比「报告太长」严重得多 ——
       * 这和 7.27 那条「坏文件的症状被显示成缺条目」是同一个错的两个方向：
       * 那次是**假象当成真问题**，这次是**真问题当成假象**。
       *
       * 所以折中：给 5 条样本，剩下的报数量。70 行噪声挡不住，5 行不会。
       */
      const SHOW = 5
      console.log(`\n⚠️  清单里没有列出这些套件（共 ${missingItems.length} 处，先列前 ${Math.min(SHOW, missingItems.length)} 条）：`)
      for (const d of missingItems.slice(0, SHOW)) console.log('   · ' + d)
      if (missingItems.length > SHOW) {
        console.log(`   · …… 还有 ${missingItems.length - SHOW} 处（文档损坏期间确实可能混进假象：`)
        console.log('     清单里的「项」字被替换符吃掉时整行匹配不上。逐条看时先确认那行的「项」字还在，')
        console.log('     在的话就是真缺陷，别当成损坏的症状放过。）')
      }
      console.log('   修法：在 README.md 的 `npm run test:` 清单与 DEPLOY.md 的表格里补上对应一行。')
    } else {
      console.log('\n⚠️  这些套件跑了，但文档清单里没有列出：')
      for (const d of missingItems) console.log('   · ' + d)
      console.log('   请在 README.md 的 `npm run test:` 清单与 DEPLOY.md 的表格里补上。')
    }
  }
  // 三个桶都要算进去 —— 漏掉 docNameStale 的话，
  // 「命令名对不上」时会先报一段 ⚠️、再紧跟一句「文档里的数字对得上」。
  /*
   * ⚠️ 这句话原来要求 `docCorrupt` 也为空，而它**永远非空**（字符损伤不可逆），
   * 于是「文档里的数字对得上」**一次都没打印过**。
   *
   * 后果很具体：输出里只剩一个吓人的 🛑 块，后面一片安静 ——
   * 读者没法判断「数字到底对不对」，很可能去查一个并不存在的问题
   * （这正是 7.27 那条「没报错 ≠ 成功」的反面：**没提示 ≠ 有问题**）。
   *
   * 所以把「字符损伤」和「数字对不对」**分成两件事说**：
   * 前者是永久已知项，后者是每轮可验的真检查。
   */
  if (!docStale.length && !docNameStale.length) {
    console.log(docCorrupt.length
      ? `文档里的数字对得上（${SUITES.length} 个套件 / ${totalPass + totalFail} 项）`
        + ' —— 上面那条「内容已损坏」说的是字符损伤，和数字对不对没关系。'
      : `文档里的数字对得上（${SUITES.length} 个套件 / ${totalPass + totalFail} 项）`)
  }
}

/* ============================================================
   套件项数稳定性
   ------------------------------------------------------------
   **一个套件的项数不该变。** 项数变了，通常只有两种可能：
   套件被改了（正常），或者**有断言没跑到**（危险）。

   为什么必须单独盯：
   文档核对那一节只在「文档写的数 ≠ 实际跑的数」时报。
   而文档是**手写**的 —— 如果某次少跑了 16 条，文档没跟着改，
   那一节会报；如果有人「顺手把文档改成实际数」，它就不报了，
   于是一个**只跑了一半的套件**从此变成「符合文档」——
   这正是最坏的结果：绿灯盖住了漏测。

   实测中确实撞到过一次：`test-team-space` 某一轮只出 33 项（正常 49），
   而那一轮的总账是「0 失败」。三次重跑都复现不出来，
   所以**根因至今不明** —— 这里只做「发生了要说出来」，
   不假装已经知道原因。

   基准写在 `data/_last-counts.json`：上一次跑出来的每套件项数。
   `data/` 是临时目录，跑完会被清；所以这个基准本来也只是「上一轮」。
   ============================================================ */
{
  const file = 'data/_last-counts.json'
  let prev = {}
  try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 第一次跑，没有基准 */ }

  const drifted = []
  for (const [suite, n] of actualItems) {
    if (prev[suite] !== undefined && prev[suite] !== n) {
      drifted.push(`${suite}：${prev[suite]} → ${n}`)
    }
  }

  /*
   * 写失败**必须说出来**，不能 `catch {}` 吞掉。
   *
   * 实测（2026-10-18）：日志跑完 22:06，而这份基准还停在 18:11 ——
   * 也就是**有一轮没能更新它**，而那次输出里一个字都没提。
   * 后果不是「少一个文件」，是**下面那条项数稳定性检查在拿一份
   * 不知道是哪一轮的基准比**，于是：
   *   · 真漂移报不出来（基准太旧，差异被当成常态）；
   *   · 或者报一堆假漂移（基准来自一个套件提前中止的那轮）。
   * 拿它同步文档数字时更直接：文档里 test-container 被写成了 13，
   * 而那一轮日志里它明明是 64。
   *
   * 写不进去不该让整轮测试**失败**（那是对的），
   * 但一定要**喊一声**，否则它就是在悄悄说谎。
   */
  try {
    mkdirSync('data', { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(actualItems), null, 0), 'utf8')
    const back = readFileSync(file, 'utf8')
    const n = Object.keys(JSON.parse(back)).length
    if (n !== actualItems.size) {
      console.warn(`⚠️  项数基准写下去又读回来对不上（写了 ${actualItems.size}，读回 ${n}）—— ${file}`)
    }
  } catch (e) {
    console.warn(`⚠️  **项数基准没写进去**：${file}（${String(e?.code || e?.message || e)}）。`)
    console.warn('   不影响本轮结论，但下一轮的「项数与上一次对比」会拿旧基准比 —— 别把那次结果当真。')
  }

  if (drifted.length) {
    console.log('\n⚠️  有套件的项数跟上一次不一样：')
    for (const d of drifted) console.log('   · ' + d)
    console.log('   改过套件的话正常；没改过的话，说明**有断言没跑到**，得查。')
    console.log('   （这一条比文档核对更要紧：文档被改成实际数之后，文档核对就不会再报了。）')
  } else if (Object.keys(prev).length) {
    console.log(`项数与上一次一致（对比 ${Object.keys(prev).length} 个套件）`)
  }
}

/**
 * 轮次**结束时**再扫一次临时产物 —— 收的是「本轮开始之前就存在的」。
 *
 * 为什么开头那次扫不够：它只清 **1 小时前**的（见上面那段），
 * 而一轮全量约 15 分钟。于是**连着跑**时，上一轮留下的文件在开头那次扫里
 * 只有 15~30 分钟大，达不到门槛 → 永远清不掉 → `data/` 单调增长。
 *
 * 实测（2026-10-06）：`data/` 263 个文件里 255 个都在 1.5 小时内，
 * 而「已清扫 24 个」只清掉了其中一类。整个会话从 118MB 涨到 148MB。
 * 再跑几轮就会撞上那个 200MB 的体积检查，而**那时没人知道是为什么**。
 *
 * 判据用「早于本轮开始的 mtime」而不是「早于现在 1 小时」：
 * 上一轮既然已经结束（开跑时端口检查就拦住了并发的两轮），
 * 它的产物就是**确定可以删**的 —— 不需要再猜它是不是还被谁占着。
 */
{
  const sizeOf = (p) => {
    try {
      const st = statSync(p)
      if (!st.isDirectory()) return st.size
      let n = 0
      for (const e of readdirSync(p)) n += sizeOf(join(p, e))
      return n
    } catch { return 0 }
  }
  let freed = 0, n = 0
  const failed = []
  for (const f of readdirSync('data')) {
    if (!/^_/.test(f)) continue
    const p = join('data', f)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isDirectory() && !/\.(db|db-wal|db-shm|err|mjs|log)$/.test(f)) continue
    // 本轮产生的（mtime >= RUN_STARTED）一律留下
    if (st.mtimeMs >= RUN_STARTED) continue
    n++
    try { freed += sizeOf(p); rmSync(p, { recursive: true, force: true }) } catch (e) {
      failed.push(`${f}（${String(e?.code || e?.message || e)}）`)
    }
  }
  if (n) console.log(`\n本轮结束后清掉 ${n} 个上一轮遗留的临时产物（约 ${(freed / 1048576).toFixed(1)}MB）`)
  if (failed.length) console.log(`⚠️  有 ${failed.length} 个删不掉（多半还被进程占着）：${failed.join('、')}`)
}

/*
 * 体积报告放在**清扫之后**。
 *
 * 原来它在轮次中间，于是收尾那次清扫还没跑，报出来的数字里
 * **包含了马上就要被删掉的 41MB** —— 实测同一轮里报 147.0MB、实际 100.5MB。
 * 一个虚高 46MB 的数字会让人以为泄漏没修好，而它其实正是「刚清完」的状态。
 * 报真实数字才有意义。
 */
reportDataSize()

/**
 * 本轮有没有把浏览器漏在后台。
 *
 * **实测代价**：2026-10-18 发现 9 个 chrome 进程从**当天 04:00** 一直活到 17:00，
 * 其中两个各空转了 150+ 秒 CPU —— 把后续几轮回归拖慢了约 3 倍，
 * 而**全程没有任何一条输出提到它**（跑完那轮的 `test:all` 是绿的）。
 *
 * 为什么会漏：套件里 `process.exit()` 是**立即终止**的，
 * 它挂起中的 `finally { await browser.close() }` 不会跑完；
 * 浏览器就成了孤儿，继续吃 CPU 直到有人手动收。
 *
 * ⚠️ **只看 `chrome` / `chromium`，刻意不包含 `msedge`** ——
 *   那是你自己正在用的 Edge（本机实测有 60+ 个进程，从几天前一直开着）。
 *   把它们算进来，这条检查就会天天报，而且**会诱导人去杀自己的浏览器**。
 *   Playwright 的 `chromium.launch()` 起的是 `chrome.exe`，够用了。
 *
 * ⚠️ 这里**只报不杀**。杀进程不该由一个测试 runner 顺手做 ——
 *   万一有人正在用同一个浏览器跑别的东西，替人做决定比留一个孤儿更糟。
 *
 * ⚠️ `[DateTime]::秒数` 是**错的**：它把秒数当 ticks，
 *   实测 `1759000000` 得出来的是 `0001年1月1日 0:02:55` ——
 *   于是「比本轮开始还老」这个条件恒成立，**每次都会把别人的浏览器报出来**。
 *   要用 `DateTimeOffset::FromUnixTimeSeconds()`。
 */
{
  let orphans = []
  let scanned = 0
  if (process.platform === 'win32') {
    const psCmd =
      "$ErrorActionPreference='SilentlyContinue'; " +
      "$cut=[DateTimeOffset]::FromUnixTimeSeconds(" + Math.floor(RUN_STARTED / 1000) + ").LocalDateTime; " +
      /* 两步走：`@(Get-Process ...)` 先落成数组。
         单行管道在「有一个名字查不到」时会把退出码变成 1（Get-Process 的
         非终止错误让 $? 变假），读 stdout 虽不受影响，但退出码非零会让人
         以为这段查询坏了 —— 而它其实工作正常。 */
      "$p=@(Get-Process chrome,chromium -ErrorAction SilentlyContinue); " +
      "'TOTAL=' + $p.Count; " +
      "$p | Where-Object { try { $_.StartTime -lt $cut } catch { $false } } | " +
      "ForEach-Object { '{0}  起于 {1:yyyy-MM-dd HH:mm}' -f $_.ProcessName, $_.StartTime }"
    try {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8' })
      const lines = String(ps.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      const t = lines.find((l) => l.startsWith('TOTAL='))
      scanned = t ? Number(t.slice(6)) || 0 : 0
      orphans = lines.filter((l) => !l.startsWith('TOTAL='))
    } catch { /* 查不了就算了，不该因为查不到就让整轮失败 */ }
  }

  if (orphans.length) {
    console.log(`\n⚠️  扫到 ${scanned} 个 Playwright 浏览器，其中 ${orphans.length} 个比本轮开始还老 —— 上一轮漏下的：`)
    for (const o of orphans.slice(0, 10)) console.log('   · ' + o)
    if (orphans.length > 10) console.log(`   …还有 ${orphans.length - 10} 个`)
    console.log('   它们在空转 CPU，会把后面的回归拖慢几倍（本项目实测拖到 3 倍）。')
    console.log('   **只报不杀**：确认那些不是你自己在用的，然后手动收掉。')
  }
}

/*
 * 收尾标记 —— 最后一行，也是**唯一**能证明本轮跑到过这里的东西。
 *
 * 2026-10-18 23:19→00:02 那轮实测的教训：一个 ReferenceError 打死进程之后，
 * 日志停在**半句话**上：
 *     `…最后那个对 GBK↔UTF-8 做往返能把乱码变回中文，`
 * 后面什么都没有。而那一刻屏幕上已经有「合计：5342 通过 / 0 失败」，
 * 整体看着像**正常跑完了** —— 于是我先怀疑基线写入被吞，
 * 又怀疑权限、去查 stderr，整整两轮。
 *
 * 有这一行，「日志停在哪」就变成「日志停在哪」而不是「跑完了但没内容」；
 * 而且它同时标出了**基线那类产物的可信度**：没有这行 = 进程中途死的 = 
 * 后面几段检查（含基线写入）压根没跑。
 */
console.log(`\n✅ runner 正常收尾（${SUITES.length} 个套件 / ${totalPass} 通过 / ${totalFail} 失败）—— 没有这一行就说明进程中途死了`)

process.exit(totalFail ? 1 : 0)
