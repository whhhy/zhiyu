/*
 * 僵尸字段守卫：types/index.ts 里声明了，但**行为层零出现**的字段。
 *
 * ------------------------------------------------------------
 * 为什么盯这个形状
 *
 * 这个项目已经被它咬过三次：`defaultWidth` / `defaultVisibility` /
 * `newDocPosition` —— 字段在类型里有、在 seed 里被写、在建表里有，
 * 唯独**没有一处代码读它来改变行为**。
 *
 * 它比缺功能更阴：
 *   · 缺功能会报错，僵尸字段**一切正常**
 *   · 数据一直在存，用户看得到配置项，改了不起任何作用
 *   · 界面上还「看起来是支持这个设置的」
 *
 * 2026-10-11 又抓到一对：`BookInvite.toName` / `fromName` ——
 *   服务端明明已经从 users 表把名字解析好一起返回了，
 *   客户端却非要去 `getMember()` 里查，查不到就显示「未知成员」。
 *   用户看着「未知成员」，他不知道对面是谁。
 *
 * ------------------------------------------------------------
 * 判据：按**层**分类出现位置
 *
 *   管道层  types / seed / io / server      —— 存进去、导出来、建表
 *   行为层  components / pages / store / lib —— 真的拿它做事情
 *
 * 只在管道层出现、行为层一处没有 = 僵尸。
 * （第一版只查「全项目零处出现」，`id`/`name`/`title` 到处都是，
 *   几乎恒真，抓不到上面这一类。）
 *
 * ------------------------------------------------------------
 * ⚠️ 基线为什么不直接判红
 *
 * 剩下的两条是**已知没接线的**，不是新缺陷：
 *   · Comment.anchorId        —— 评论锚定到块（语雀支持）本项目**没实现**
 *   · BookInvite.respondedAt  —— 服务端写了，但界面只显示 pending，没人读
 *
 * 把它们算成失败，就等于让这条检查**长期红着**——
 * 长期红的检查会训练出「忽略它」，比没有检查更糟
 *（runner 那句「永远不会跑」就是这么变成噪声的）。
 * 所以：**只对基线之外的新僵尸判红**，基线每次照常打印出来，不装作没有。
 */
import fs from 'node:fs'
import path from 'node:path'

const TYPES = 'src/types/index.ts'

/** 已知未接线。每条都要写清「为什么它现在还没接线」。 */
const KNOWN = {
  'Comment.anchorId': '**遗留字段，不是缺功能**（我原先在这里写的是「本项目没实现」，**那是错的**，2026-10-11 更正）。语雀那种「评论挂在某段文字/某一块上」**已经实现了** —— 走的是另一个类型 `SelectionComment`（带 `quote` + `blockId`），界面在 src/components/doc/Selection.tsx，增/解决/回复/删除、服务端同步、导入导出、种子数据全通。所以 `Comment.anchorId` 只是**文档级评论**上多留的一个没人用的口子，不是能力缺失',
  'BookInvite.respondedAt': '服务端在接受/拒绝/撤回时都写了，但界面只显示 pending，没有任何地方读它',
  'Topic.replyCount': '**有意不读**：它是种子里的历史值，和实际回复行对不上。界面一律用 store 的 getTopicReplyCount(id) 拿真数 —— 拿这个字段显示就是编数字（types/index.ts / Dashboard / KnowledgeDetail 三处都写了这件事）',
  'DtView.groupBy': '**有意预留**：类型里就写着「看板按状态固定分组，此处留给后续扩展」。它已登记进 crdt/core.ts 的字段名表（将来启用时冲突合并是对的），但界面上还没有分组设置',
}

function collectFiles(root, exts) {
  const out = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        walk(p)
      } else if (exts.some((x) => e.name.endsWith(x))) out.push(p.split(path.sep).join('/'))
    }
  })(root)
  return out
}

/** 从接口定义里抽出字段名（跳过注释行） */
function parseFields(src) {
  const lines = src.split('\n')
  const fields = []
  let iface = null
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!iface) {
      const m = /^export interface (\w+) \{/.exec(l.trim())
      if (m) { iface = m[1]; depth = 1 }
      continue
    }
    depth += (l.match(/\{/g) || []).length
    depth -= (l.match(/\}/g) || []).length
    if (depth <= 0) { iface = null; continue }
    const t = l.trim()
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    const m = /^(\w+)\??\s*:/.exec(t)
    if (m) fields.push({ iface, name: m[1], line: i + 1 })
  }
  return fields
}

/**
 * 剥掉注释再统计。
 *
 * ⚠️ 不剥会**把守卫自己废掉** —— 这是破坏对照当场抓到的：
 *   我在 BookSettings 里写了一段注释解释「这里要用 `inv.toName` 兜底」，
 *   而字段扫描是按字符串出现次数算的，于是那句注释里的 `toName`
 *   把「代码里真的用了 toName」这件事盖住了 ——
 *   **撤掉修复，守卫依然报绿**。
 *   也就是说：解释修复的注释，恰好让修复变成查不出来。
 *
 *   跟 `test-fake-buttons` 里同一个坑、同一份处理。
 */
function stripCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/**
 * 「这个字段被读了吗」——只认**属性访问**。
 *
 * ⚠️ 为什么不能数「这个字符串出现过」：
 *   破坏对照第二次栽在这里。我写的是
 *       const toName = getMember(inv.toUserId)?.name || inv.toName || '未知成员'
 *   把兜底撤掉之后，`inv.toName` 确实没了 —— 但**局部变量也叫 toName**，
 *   于是 `const toName = …` / `{toName}` 这三处照样命中，
 *   字段看起来「还在被用」，守卫保持沉默。
 *
 *   同一个坑连栽两次（先被注释骗、再被同名局部变量骗），根子是同一个：
 *   **文本出现 ≠ 读了字段**。
 *
 *   所以判据改成「以 `.` / 下标 / 字符串键访问它」：`.toName` / `inv?.toName`
 *   / `inv['toName']` / `useDocSection(doc.id, 'table')`。
 *   最后那种是**动态键**（doc.sheetData 的三段就是靠它取的），
 *   不认它会把真在用的字段误报成僵尸 —— 误报比漏报更烦人，
 *   因为它会让人去改本来正确的代码。
 *   解构写法（`const { toName } = inv`）不算 —— 这个项目里实体字段
 *   一律按属性访问用；而宁可多报一个让人去看一眼，也别默默放过一个真僵尸。
 *
 * ⚠️ 这条判据分不清「读」和「写」：行为层里 `d.anchorId = x` 也算「接线了」。
 *    本项目里僵尸字段的典型死法是**行为层一次都不出现**（都在 seed/db/entities），
 *    所以这个粗细度够用；真要严格区分「写了但从没读」，那是另一条判据的事。
 */
function isReadIn(code, name) {
  return new RegExp(
    `\\.\\s*${name}\\b`          // inv.toName
    + `|\\[\\s*['"]${name}['"]\\s*\\]`   // inv['toName']
    + `|['"]${name}['"]`,         // useDocSection(id, 'table') —— 动态键
  ).test(code)
}

const srcFiles = collectFiles('src', ['.ts', '.tsx'])
const serverFiles = collectFiles('server', ['.ts'])
const PLUMBING = new Set([TYPES, 'src/data/seed.ts', 'src/lib/io.ts'])
const behaviorFiles = srcFiles.filter((f) => /src\/(components|pages|store|lib|hooks)\//.test(f) && !PLUMBING.has(f))
const bodies = [...srcFiles, ...serverFiles].map((f) => ({ f, s: stripCode(fs.readFileSync(f, 'utf8')) }))

const zombies = []
let scanned = 0
for (const fd of parseFields(fs.readFileSync(TYPES, 'utf8'))) {
  const pipe = []
  let inBehavior = false
  for (const b of bodies) {
    // 管道层只关心「有没有出现过」，行为层要看「是不是真的读它」
    const hit = behaviorFiles.includes(b.f) ? isReadIn(b.s, fd.name) : new RegExp(`\\b${fd.name}\\b`).test(b.s)
    if (!hit) continue
    if (behaviorFiles.includes(b.f)) inBehavior = true
    else pipe.push(b.f)
  }
  scanned++
  if (!inBehavior) zombies.push({ key: `${fd.iface}.${fd.name}`, pipe: [...new Set(pipe)] })
}

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

console.log(`\n== 扫描（src ${srcFiles.length} 个文件，其中行为层 ${behaviorFiles.length} 个 + server ${serverFiles.length} 个 / ${scanned} 个字段）==`)

const unexpected = zombies.filter((z) => !(z.key in KNOWN))
ok(unexpected.length === 0,
  `没有新增的僵尸字段（行为层一处没出现的字段共 ${zombies.length} 个，全部在已知清单里）`,
  '\n     ' + unexpected.map((z) => `${z.key}  只在：${z.pipe.join(', ')}`).join('\n     '))

const stale = Object.keys(KNOWN).filter((k) => !zombies.some((z) => z.key === k))
if (stale.length) {
  // 不判红，但要说出来：基线里已经修好的项留着，会让人以为它还没接线
  console.log(`\n  ⚠️  已知清单里有 ${stale.length} 项已经接上线了，可以从 KNOWN 里删掉：`)
  for (const k of stale) console.log(`     · ${k}`)
}

/*
 * 自检：注释里提到一个名字，**不算**它被用了。
 * 这条守住上面那个「解释修复的注释把修复盖住」的事故 ——
 * 没有它，守卫会在最需要它的那次保持沉默。
 */
{
  const inComment = `const a = 1\n// 这里要用 probeName 兜底\nconst b = 2`
  const inCode = `const a = 1\nconst b = probeName`
  ok(!/\bprobeName\b/.test(stripCode(inComment)),
    '自检·负：注释里的字段名不算「被使用」（撤掉修复时守卫必须能发现）')
  ok(/\bprobeName\b/.test(stripCode(inCode)),
    '自检·正：代码里真的用了它，剥注释不能把它也剥掉')
  ok(isReadIn('const toName = 1; return toName', 'toName') === false,
    '自检：同名局部变量不算「读了字段」（这一条是破坏对照②逼出来的）')
  ok(isReadIn('return inv.toName', 'toName') === true, '自检·正：属性访问算读了')
  ok(isReadIn('return inv?.toName', 'toName') === true, '自检·正：可选链属性访问算读了')
  ok(isReadIn(`return inv['toName']`, 'toName') === true, '自检·正：下标访问算读了')
  ok(isReadIn(`useDocSection(doc.id, 'table')`, 'table') === true,
    '自检·正：字符串键的动态访问算读了（doc.sheetData 三段就是这么取的，漏了会误报）')
}

console.log('\n== 已知未接线（不判红，但每次都列出来）==')
for (const z of zombies) {
  const why = KNOWN[z.key]
  console.log(`  · ${z.key}\n      为什么还没接线：${why || '（清单里没写原因 —— 请补上）'}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)