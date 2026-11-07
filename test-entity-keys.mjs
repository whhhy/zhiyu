/* ============================================================
   实体键位审计：客户端与服务端的「主键叫什么、父键是谁」必须一致
   ------------------------------------------------------------
   上一轮那串 bug 的根因全是同一类：某个实体的键位在一边写对了、
   在另一边写错了，而两边**都不报错** ——
   服务端只是把那几行判成「缺少主键」丢掉，界面照样刷新。

   这类错没法靠肉眼扫出来（实体有二十个，每处取值又分散在
   toRows / applyDelta / serverDataToAppData 三处），
   所以做成一个能跑的核对：把两边的声明摆在一起逐条对。
   ============================================================ */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const clientSync = readFileSync('src/lib/sync.ts', 'utf8')
const clientApi = readFileSync('src/lib/api.ts', 'utf8')
const serverEntities = readFileSync('server/entities.ts', 'utf8')

/* ---------- 客户端：SHAPE 声明了哪些实体 ---------- */
const shapeSrc = clientSync.slice(clientSync.indexOf('const SHAPE'), clientSync.indexOf('/** 会推给服务端的实体'))
const shape = {}
for (const m of shapeSrc.matchAll(/^\s*(\w+):\s*'(array|record|recordOfArray)'/gm)) shape[m[1]] = m[2]
ok(Object.keys(shape).length >= 15, `客户端 SHAPE 解析出 ${Object.keys(shape).length} 个实体`, String(Object.keys(shape).length))

/* ---------- 服务端：ENTITIES 声明了哪些实体、主键是什么 ---------- */
const entSrc = serverEntities.slice(serverEntities.indexOf('const ENTITIES'), serverEntities.indexOf('/** 复合主键的实体'))
const serverEnt = {}
for (const m of entSrc.matchAll(/name:\s*'(\w+)',\s*table:\s*'(\w+)',\s*pk:\s*'(\w+)'/g)) {
  serverEnt[m[1]] = { table: m[2], pk: m[3] }
}
ok(Object.keys(serverEnt).length >= 15, `服务端 ENTITIES 解析出 ${Object.keys(serverEnt).length} 个实体`, String(Object.keys(serverEnt).length))

/* ---------- 1. 客户端有的、服务端必须认识 ---------- */
console.log('\n== 客户端声明的实体，服务端都得认识 ==')
const unknown = Object.keys(shape).filter((k) => !serverEnt[k])
ok(unknown.length === 0, '没有「客户端会推、服务端却没注册」的实体', unknown.join(', '))

/* ---------- 2. 服务端有的、客户端也得能推（否则那份数据永远下不来） ---------- */
console.log('\n== 服务端有的实体，客户端也得有对应形状 ==')
const notInShape = Object.keys(serverEnt).filter((k) => !shape[k])
// members 是特例：它不走同步（用户资料有独立接口），其余都得对上
const realGaps = notInShape.filter((k) => k !== 'members')
ok(realGaps.length === 0, '服务端没有「客户端压根不认识」的实体', realGaps.join(', '))

/* ---------- 3. 主键列名：两边必须一致 ---------- */
console.log('\n== 主键列名：客户端发的与服务端要的对得上 ==')
// PK_ALIAS 是「前端对象里的 id 在服务端叫什么列」；没登记的实体一律叫 id。
// 但 rowKey 里还有两类特例：bookSettings 走 bookId、recents/trash 走 docId ——
// 它们的行里根本没有 id 字段。所以规则必须**从 rowKey 本身推导**，
// 不能在这里硬编码一份特例，否则两边各改一处、审计还在报「一致」。
const aliasSrc = clientSync.slice(clientSync.indexOf('const PK_ALIAS'), clientSync.indexOf('/** 复合主键的实体'))
const aliases = Object.fromEntries([...aliasSrc.matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]))

const rowKeySrc = clientSync.slice(clientSync.indexOf('const rowKey'), clientSync.indexOf('\n}\n', clientSync.indexOf('const rowKey')))
// 形如  if (key === 'bookSettings') return String(r.bookId)
// 以及  if (key === 'recents' || key === 'trash') return String(r.docId)
// 后者一行里有两处 key === —— 所以逐个匹配，再看**同一行**后面有没有 return，
// 用一条正则跨着吞会把 trash 漏掉（正是这个坑，审计自己先红了一次）。
const rowKeyCols = {}
for (const line of rowKeySrc.split('\n')) {
  const ret = /return String\(r\.(\w+)\)/.exec(line)
  if (!ret) continue
  for (const m of line.matchAll(/key === '(\w+)'/g)) rowKeyCols[m[1]] = ret[1]
}
// 这三个是「行里没有 id 字段」的实体，rowKey 必须为它们单开特例。
// 少一个就会退化成 String(r.id) = 'undefined'，全表撞成一行。
const EXPECTED_ROWKEY = { bookSettings: 'bookId', recents: 'docId', trash: 'docId' }
const missingSpecial = Object.entries(EXPECTED_ROWKEY).filter(([k, v]) => rowKeyCols[k] !== v)
ok(
  missingSpecial.length === 0,
  `rowKey 里三个特例主键都在（${Object.entries(EXPECTED_ROWKEY).map(([k, v]) => `${k}→${v}`).join(', ')}）`,
  missingSpecial.map(([k, v]) => `${k} 应为 ${v}，实际 ${rowKeyCols[k] || '缺失'}`).join(' | '),
)

const compositeSrc2 = serverEntities.slice(serverEntities.indexOf('export const COMPOSITE_PK'))
const compositeNames = new Set([...compositeSrc2.matchAll(/(\w+):\s*\[([^\]]+)\]/g)].map((m) => m[1]))

const pkMismatches = []
let checked = 0
for (const [name, def] of Object.entries(serverEnt)) {
  if (name === 'members') continue
  // 复合主键的行同时带父键和登记过的 pk 列，单独在第 5 节验
  if (compositeNames.has(name)) continue
  const clientPk = aliases[name] || rowKeyCols[name] || 'id'
  checked++
  if (clientPk !== def.pk) pkMismatches.push(`${name}: 客户端发 ${clientPk} / 服务端要 ${def.pk}`)
}
ok(pkMismatches.length === 0, `${checked} 个单列主键实体的列名一致`, pkMismatches.join(' | '))

/* ---------- 4. 父键：record / recordOfArray 的键必须真的是那一列 ---------- */
console.log('\n== 嵌套型实体的父键列必须真实存在 ==')
const parentSrc = clientSync.slice(clientSync.indexOf('const PARENT_KEY'), clientSync.indexOf('function withServerPk'))
const parents = Object.fromEntries([...parentSrc.matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]))

// 服务端每张表的列：从 db.ts 的建表语句里抠出来
const dbSrc = readFileSync('server/db.ts', 'utf8')
const tableCols = {}
for (const t of dbSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Set()
  for (const line of t[2].split('\n')) {
    const c = /^\s*(\w+)\s+(TEXT|INTEGER|REAL|BLOB)/.exec(line)
    if (c) cols.add(c[1])
  }
  tableCols[t[1]] = cols
}
ok(Object.keys(tableCols).length >= 10, `解析出 ${Object.keys(tableCols).length} 张表的列`, String(Object.keys(tableCols).length))

const badParents = []
for (const [name, bucket] of Object.entries(shape)) {
  const def = serverEnt[name]
  if (!def) continue
  const cols = tableCols[def.table]
  if (!cols) { badParents.push(`${name}: 找不到表 ${def.table}`); continue }
  let parentCol = null
  if (bucket === 'recordOfArray') parentCol = parents[name] || 'docId'
  else if (bucket === 'record') parentCol = name === 'bookSettings' ? 'bookId' : 'id'
  else continue
  if (!cols.has(parentCol)) badParents.push(`${name}: 父键 ${parentCol} 不在表 ${def.table} 的列里（${[...cols].join(',')}）`)
}
ok(badParents.length === 0, '嵌套型实体的父键都是真实存在的列', badParents.join(' | '))

/* ---------- 5. 复合主键的实体必须登记在 PK_ALIAS 与行键里 ---------- */
console.log('\n== 复合主键必须两处都登记 ==')
const compSrc = serverEntities.slice(serverEntities.indexOf('export const COMPOSITE_PK'))
const composite = [...compSrc.matchAll(/(\w+):\s*\[([^\]]+)\]/g)].map((m) => m[1])
for (const name of composite) {
  ok(!!aliases[name], `${name}（复合主键）在客户端 PK_ALIAS 里有登记 —— 否则服务端判「缺少主键」，整行丢弃`)
  const rowKeySrc = clientSync.slice(clientSync.indexOf('const COMPOSITE_ENTITIES'), clientSync.indexOf('function withServerPk'))
  ok(
    new RegExp(`'${name}'`).test(rowKeySrc),
    `${name} 在行键里带上了父键 —— 否则同一个人在两个知识库里的行会撞成一行`,
  )
}

/* ---------- 6. 角色能力表：客户端与服务端必须逐项相同 ---------- */
console.log('\n== 角色能力表：两张表必须一致 ==')
// 服务端算权限是「先按角色给基线，再用成员行上的 perms 逐项覆盖」。
// 客户端新建成员行时也要按同一张表派生 perms —— 两边只要有一处漂移，
// 「设为编辑者」就会静默地不给编辑权，而且界面上完全看不出来。
const permsSrc = readFileSync('src/lib/perms.ts', 'utf8')
const clientRoleSrc = permsSrc.slice(permsSrc.indexOf('export const ROLE_CAPS'), permsSrc.indexOf('/** 角色的能力基线'))
const CAPS = ['read', 'comment', 'edit', 'create', 'export', 'share', 'admin']
const clientRoles = {}
for (const m of clientRoleSrc.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
  const on = CAPS.filter((c) => new RegExp(`${c}:\\s*true`).test(m[2]))
  clientRoles[m[1]] = on.sort().join(',')
}

const serverPerms = readFileSync('server/perms.ts', 'utf8')
const srvRoleSrc = serverPerms.slice(serverPerms.indexOf('const ROLE_CAPS'), serverPerms.indexOf('export interface User'))
const serverRoles = {}
for (const m of srvRoleSrc.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
  serverRoles[m[1]] = m[2].split(',').map((s) => s.trim().replace(/['`]/g, '')).filter(Boolean).sort().join(',')
}

ok(Object.keys(clientRoles).length >= 5, `解析出客户端 ${Object.keys(clientRoles).length} 个角色`, String(Object.keys(clientRoles).length))
ok(Object.keys(serverRoles).length >= 5, `解析出服务端 ${Object.keys(serverRoles).length} 个角色`, String(Object.keys(serverRoles).length))

const roleDiffs = []
for (const role of new Set([...Object.keys(clientRoles), ...Object.keys(serverRoles)])) {
  if (clientRoles[role] !== serverRoles[role]) {
    roleDiffs.push(`${role}: 客户端 [${clientRoles[role] || '缺失'}] / 服务端 [${serverRoles[role] || '缺失'}]`)
  }
}
ok(
  roleDiffs.length === 0,
  `${Object.keys(serverRoles).length} 个角色的能力集合逐项相同`,
  roleDiffs.join(' | '),
)

// 加成员时必须从这张表派生，而不是写死一份 —— 写死的那份曾让角色形同虚设
const storeSrc = readFileSync('src/store/index.ts', 'utf8')
const hardcodedPerms = [...storeSrc.matchAll(/perms:\s*\{\s*read:\s*true[^}]*\}/g)]
ok(
  hardcodedPerms.length === 0,
  'store 里没有再写死一份 perms（全部走 permsForRole）',
  `发现 ${hardcodedPerms.length} 处写死：${hardcodedPerms.map((m) => m[0].slice(0, 60)).join(' | ')}`,
)
ok(storeSrc.includes('permsForRole'), 'store 确实用了 permsForRole 派生成员权限')
// 改角色必须重算 perms：不重算的话，把 reader 提升为 editor 完全无效
ok(
  /updateMemberRole[\s\S]{0,400}permsForRole\(role\)/.test(storeSrc),
  '改角色时会按新角色重算 perms（否则提升成员是静默无效的）',
)

/* ---------- 7. 种子成员行：perms 不得超过其角色基线 ---------- */
console.log('\n== 种子成员行的 perms 不得超过角色基线 ==')
// 语义是「角色给上限，perms 在上限之内再收紧」。反过来的行
// （role 写着 reader、perms 却给了 edit）就是一条等着被用的提权路径 ——
// 界面上显示「阅读者」，实际能编辑。
const settingsSrc = readFileSync('src/data/settings.ts', 'utf8')
const seedSrc = settingsSrc.slice(settingsSrc.indexOf('export const seedBookMembers'))
// perms(a,b,c,d,e,f) 的参数顺序：read, comment, edit, create, export, share
const PERM_ORDER = ['read', 'comment', 'edit', 'create', 'export', 'share']
const seedRows = [...seedSrc.matchAll(/role:\s*'(\w+)'[^}]*?perms\(([^)]*)\)/g)]
ok(seedRows.length >= 10, `解析出 ${seedRows.length} 条种子成员行`, String(seedRows.length))

const overGrants = []
for (const m of seedRows) {
  const role = m[1]
  const flags = m[2].split(',').map((s) => s.trim() === 'true')
  const baseline = PERM_ORDER.map((c) => new Set(serverRoles[role]?.split(',') || []).has(c))
  PERM_ORDER.forEach((cap, i) => {
    if (flags[i] && !baseline[i]) overGrants.push(`role=${role} 却给了 ${cap}`)
  })
}
ok(overGrants.length === 0, '没有任何一条种子成员行把权限开到了角色之上', overGrants.join(' | '))

/* ===================================================================
   每个实体都得说清楚「它这一行属于哪个知识库/空间」
   -------------------------------------------------------------------
   `readEntity` 和 `changesSince` 里都有一句
       if (!bookId) { if (spaces) … ; continue }
   —— **解析不出归属的行会被静默丢掉**：写得进去、列表里看不到、增量里也不发。
 *
   2026-10-05 就在这里栽过：`notes` / `topics` 的 `bookOf` 返回的其实是
 * **spaceId**，而判权那一步拿它去 `capsInBook`（查知识库）→ 查不到 → 落回
 * `capsInSpace(null)` → 零能力 → 普通同事**一个都发不出来**。
 * 修的时候才发现「解析归属」和「用归属判权限」是**两件事**。
 *
 * ------------------------------------------------------------
   这一节的作用是防复发：以后**新增实体**时忘了声明归属办法，
   就会重演同一个坑，而症状（列表空、增量不发）在界面上像「还没同步」，
   极难定位。
 *
 * 解析方式：**按 `name: '...'` 切段**，而不是找 `{`。
 * 第一版找 `{` + 可选空白，而 `follows` 前面有一段 doc 注释，
 * 于是它**整个被漏掉**、只切出 19 个（实际 20）——
 * 探针少切一个实体，输出上看起来完全正常。
 * 所以下面同时断言「切出来的数量 = ENTITIES 的数量」，少一个就报出来。
 * =================================================================== */
console.log('\n== 每个实体都声明了归属办法 ==')
{
  const src = readFileSync('server/entities.ts', 'utf8')
  // ① 切成「从 name: 到下一个 name:」的段（对前置注释免疫）
  const marks = [...src.matchAll(/name:\s*'([a-zA-Z]+)'/g)]
  const segs = marks.map((m, i) => ({
    name: m[1],
    code: src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
  }))
  // ② 独立数一遍：db.ts 建的表 vs entities.ts 声明的实体，交叉核对
  const declared = new Set(segs.map((s) => s.name))
  const entCount = /export const ENTITIES[^=]*=\s*\[/.test(src) ? segs.length : 0
  ok(entCount >= 20, `切出 ${entCount} 个实体（少于 20 说明切分漏了 —— 探针自己的错，不是代码的错）`)

  const missing = segs.filter((s) =>
    !/bookOf\s*:/.test(s.code) && !/bookViaDoc\s*:/.test(s.code)
    && !/bookViaNode\s*:/.test(s.code) && !/bookViaComment\s*:/.test(s.code)
    && !/personal\s*:\s*true/.test(s.code) && !/visible\s*:/.test(s.code))
  ok(missing.length === 0,
    '每个实体都至少有一种归属办法（bookOf / bookVia* / personal / visible）',
    '缺办法的：' + missing.map((s) => s.name).join(' '))

  // personal 实体必须同时声明 userCol —— 否则行归属靠谁过滤就没了
  const noUserCol = segs.filter((s) => /personal\s*:\s*true/.test(s.code) && !/userCol\s*:/.test(s.code))
  ok(noUserCol.length === 0, 'personal 实体都声明了 userCol（没有它就没人知道该按哪一列过滤）',
    noUserCol.map((s) => s.name).join(' '))

  // 「bookOf 返回 null」的，必须还能靠别的路解析出归属。
  // ⚠️ 第一版这里只判了「不是 personal、没 visible」，漏了 `bookVia*` ——
  //    于是 comments / docVersions 这些（bookOf 返回 null、靠 bookViaDoc 反查）
  //    全被误报。**这正是本节要防的那类错误的镜像：我自己写了一条会误报的断言。**
  const viaAnything = (c) => /bookViaDoc\s*:/.test(c) || /bookViaNode\s*:/.test(c) || /bookViaComment\s*:/.test(c)
  const nullScope = segs.filter((s) => /bookOf:\s*\(\)\s*=>\s*null/.test(s.code)
    && !viaAnything(s.code) && !/personal\s*:\s*true/.test(s.code) && !/visible\s*:/.test(s.code))
  ok(nullScope.every((s) => s.name === 'spaces'),
    'bookOf 返回 null 又没有其它归属办法的，只剩 spaces（它在 readEntity / changesSince 里被显式特判）',
    '多出来的：' + nullScope.map((s) => s.name).join(' '))

  // spaces 那个「特判」是真的存在吗？—— 特判哪天被删了，这条就该红。
  // ⚠️ `readEntity` / `changesSince` 在 **sync.ts**，不在 entities.ts；
  //    第一版在 entities.ts 里找，结果恒红（又一次「探针坏了长得像代码有问题」）。
  const syncSrc = readFileSync('server/sync.ts', 'utf8')
  const readAt = syncSrc.indexOf('export function readEntity')
  ok(readAt > 0, '（探针自己：sync.ts 里找得到 readEntity）')
  ok(readAt > 0 && /if \(def\.name === 'spaces'\)/.test(syncSrc.slice(readAt, readAt + 3000)),
    'readEntity 里对 spaces 的显式特判确实还在')
  const csAt = syncSrc.indexOf('export function changesSince')
  ok(csAt > 0 && /def\.name === 'spaces' && canSeeSpace/.test(syncSrc.slice(csAt, csAt + 6000)),
    'changesSince 里对 spaces 的显式特判也还在')

  ok(declared.has('follows') && declared.has('favorites') && declared.has('recents'),
    '三个个人实体都在清单里（follows / favorites / recents）—— 少一个就说明切分本身坏了')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
