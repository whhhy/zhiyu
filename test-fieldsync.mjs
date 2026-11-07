/**
 * 客户端类型声明的字段，服务端**必须真的给**。
 *
 * ============================================================
 * 这一类错的共同点：代码完全正常，注释还把意图说得很清楚
 * ------------------------------------------------------------
 * 知识库成员那行，客户端类型是 `{ id, role, perms, joinedAt }`，
 * 而表里的主键列叫 `userId`，服务端不给 `id`。于是：
 *
 *   · 「谁还没加进来」判断 `!bookMembers.some(b => b.id === m.id)`
 *     恒为真 → **已经在库里的人全部出现在候选名单里**
 *   · 批量加成员的去重 `new Set(list.map(m => m.id))` 变成 `{undefined}`
 *     → 同一个人可以被**反复添加**，权限界面显示成两行同一个人
 *
 * 而那两处的注释都写着「已经在库里的要去掉」——
 * 保护写在那里，**在服务端形态下从来没生效过**。
 *
 * 这类错最难查：没有报错、没有崩溃、界面上还像是加载了。
 * 所以这里做的是一条通用对账：客户端类型里**每个字段**，
 * 服务端都得给得出。少一个，这里就红。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.FIELDSYNC_PORT || await freePort()
/**
 * 刻意用**自己的端口**，不用 `YQ_PORT`。
 *
 * `test:all` 会在 8092 上常驻一个共享服务，所有套件都打它。
 * 端口被占时我 spawn 的服务起不来，而健康检查照样通过 —— 于是这个套件
 * 悄悄跑去打**共享服务**，读到的是被前面套件改过的数据，
 * 断言就依赖执行顺序了（实测：单跑「b1 有 6 人」全绿，
 * 全量里 b1 只剩 1 人就红了 —— 红的不是代码，是我的期望算错了）。
 *
 * `test-migrate` 早就是 `MIGRATE_PORT || 8104` 这个做法，照它来。
 */
const DB = 'data/_fieldsrv-test.db'
const BASE = `http://localhost:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), YQ_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
srv.stdout.on('data', () => {})
srv.stderr.on('data', () => {})
const cleanup = () => {
  try { srv.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}
process.on('exit', cleanup)

let up = false
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

const li = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
})).json()
ok(!!li.token, '管理员登录成功')

const bk = await (await fetch(`${BASE}/api/bootstrap?lite=0`, { headers: { Authorization: `Bearer ${li.token}` } })).json()
const data = bk.data || bk.rows || {}

/** 实体 → 客户端类型名 */
const MAP = {
  spaces: 'Space', books: 'Book', nodes: 'TreeNode', docs: 'Doc',
  comments: 'Comment', notes: 'Note', topics: 'Topic',
  templates: 'DocTemplate', favorites: 'Favorite', follows: 'Follow',
  members: 'Member', bookSettings: 'BookSettings', bookMembers: 'BookMember',
  docVersions: 'DocVersion', topicReplies: 'TopicReply',
  selectionComments: 'SelectionComment',
}

/**
 * 只比**界面真的会读**的字段。
 *
 * 不是所有字段都该由服务端给：
 *   · `Doc.versions` / `Comment.replies` / `SelectionComment.replies`
 *     是**客户端自己拼**的嵌套（服务端刻意不拼，见 sync.ts 里的说明），
 *     硬要服务端也给就等于把一条路径改成两条 —— 迟早只改一处。
 * 所以这里显式列出「客户端负责组装」的字段，不算缺。
 */
const CLIENT_ASSEMBLED = new Set(['versions', 'replies', 'children'])

const types = readFileSync('src/types/index.ts', 'utf8')
function fieldsOf(name) {
  const m = new RegExp('export interface ' + name + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(types)
  if (!m) return null
  return [...m[1].matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((x) => x[1])
}

console.log('\n== 客户端类型里读的字段，服务端实体都得支持 ==')
{
  /**
   * 静态对账，**不需要样本数据**。
   *
   * 第一版是「起服务、读 bootstrap、比字段」—— 结果种子数据为 0 行的
   * 那一批实体（docVersions / topicReplies / recents / trash …）全被跳过，
   * 而它们恰恰是最容易字段名对不上的地方（客户端要自己嵌套回去）。
   *
   * 其实不需要数据：服务端实体声明里的 `pk` + `writable` + `json` + `bools`
   * **就是**「客户端能往返的字段全集」—— 写不进、读不出的字段根本不会出现在这里。
   * 于是这一条对 100% 的实体都成立。
   */
  const ent = readFileSync('server/entities.ts', 'utf8')
  const quoted = (s) => [...(s || '').matchAll(/'([^']+)'/g)].map((x) => x[1])
  const serverFields = new Map()
  for (const m of ent.matchAll(/name: '(\w+)', table: '\w+'([\s\S]*?)(?=\n  \},\n|\n\])/g)) {
    const body = m[2]
    serverFields.set(m[1], new Set([
      /pk: '(\w+)'/.exec(body)?.[1],
      ...quoted(/json: \[([^\]]*)\]/.exec(body)?.[1]),
      ...quoted(/bools: \[([^\]]*)\]/.exec(body)?.[1]),
      ...quoted(/writable: \[([\s\S]*?)\]/.exec(body)?.[1]),
    ].filter(Boolean)))
  }

  // recents / trash 在 AppData 里是内联类型，没有独立 interface
  const recentsFields = ['docId', 'viewedAt']
  const trashFields = ['docId', 'title', 'deletedAt']

  /**
   * 服务端在 `shape` / 特判里**额外补**的字段。
   * 它们不在实体的 `writable` 里（那是「能存什么列」），
   * 但确实会出现在给客户端的行里 —— 所以这里必须显式列出并写明出处，
   * 否则这条检查会因为「不认识这些字段」而一直红，或者更糟：
   * 有人为了让它变绿，随手把这些字段从实体声明里删掉。
   */
  const SERVER_ADDED = {
    'spaces.memberCount': 'withSpaceMemberCount：表里没这列，按 space_members 现算',
    'nodes.order': 'NODE_SHAPE：表里叫 ord',
    'bookMembers.id': 'BOOK_MEMBER_SHAPE：表里叫 userId',
    'docs.lock': 'DOC_SHAPE：lockMemberId/lockAt 合成一个 lock',
    'members.role': 'bootstrap 里 users 显式列出公开字段',
  }

  const problems = []
  const unlisted = []
  const targets = Object.entries(MAP).concat([['recents', null], ['trash', null]])
  for (const [entName, typeName] of targets) {
    const got = serverFields.get(entName)
    if (!got) { problems.push(`${entName}：找不到服务端实体声明`); continue }
    const want = entName === 'recents' ? recentsFields
      : entName === 'trash' ? trashFields
        : fieldsOf(typeName)
    if (!want) { problems.push(`${entName}：找不到客户端类型 ${typeName}`); continue }
    for (const f of want) {
      if (got.has(f) || CLIENT_ASSEMBLED.has(f)) continue
      // 界面上已经没人读的存量字段不算（books.docCount / wordCount 已改为现算）
      if (entName === 'books' && (f === 'docCount' || f === 'wordCount')) continue
      const key = `${entName}.${f}`
      if (SERVER_ADDED[key]) unlisted.push(key)
      else problems.push(key)
    }
  }
  ok(serverFields.size >= 20, `解析出服务端 ${serverFields.size} 个实体声明`)
  ok(targets.length >= 18, `${targets.length} 类实体全部比对了（静态对账，不需要样本）`)
  ok(problems.length === 0, '客户端类型里读的字段，服务端实体都支持（或已显式登记为服务端补的）',
    problems.join('  |  '))
  // 反过来查**过期登记**：SERVER_ADDED 里写了、但其实已经不缺的条目，
  // 说明当初的说明已经不准了 —— 留着会让人以为那里还有特殊处理
  const stale = Object.keys(SERVER_ADDED).filter((k) => !unlisted.includes(k))
  ok(stale.length === 0, '登记里没有过期的条目（每条都还对得上一个真实的缺）', stale.join(' '))
}

console.log('\n== 客户端 SHAPE 表必须和服务端实体清单对齐 ==')
{
  /**
   * `src/lib/sync.ts` 里有一张硬编码的「每个实体怎么存」表（SHAPE）。
   * 它和服务端的实体清单是**各自维护**的 —— 这正是会漂移的形状。
   *
   * 服务端加了一个实体、客户端忘了加进 SHAPE 的后果不是报错：
   * 查不到形状的实体会被当成「不处理」，于是**整个实体静默不同步** ——
   * 写上去没反应、别的设备也看不见，界面上什么提示都没有。
   *
   * 现在两边是对齐的（实测无缺无多），所以这条是防将来。
   */
  const syncSrc = readFileSync('src/lib/sync.ts', 'utf8')
  const i = syncSrc.indexOf('const SHAPE')
  const seg = syncSrc.slice(i, syncSrc.indexOf('}', i) + 1)
  const shapeKeys = new Set([...seg.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]))

  const ent2 = readFileSync('server/entities.ts', 'utf8')
  const serverEnts = [...ent2.matchAll(/^    name: '(\w+)', table: '\w+'/gm)].map((m) => m[1])

  const missing = serverEnts.filter((k) => !shapeKeys.has(k))
  const extra = [...shapeKeys].filter((k) => !serverEnts.includes(k))
  ok(shapeKeys.size >= 20, `客户端 SHAPE 覆盖 ${shapeKeys.size} 个实体`)
  ok(missing.length === 0,
    '服务端每个实体，客户端 SHAPE 里都有（缺一个 = 那个实体静默不同步）',
    missing.join(' '))
  ok(extra.length === 0,
    '客户端 SHAPE 里没有服务端不存在的实体（写进去了也推不动）',
    extra.join(' '))
}

console.log('\n== 内部列不能漏进客户端（漏一个 = 那一行永远比不相等）==')
{
  /**
   * 这里换过一次方向。原先查的是「服务端多给了、客户端类型没声明」，
   * 报出来 8 条 —— 但**没有一条是真 bug**：docs 的差分走
   * `DOC_COMPARE_FIELDS` **白名单**，多出来的字段压根不参与比较。
   * 方向选错了：真正会出事的是**客户端本地创建的字段服务端不给**，
   * 那种靠类型声明静态查不出来。
   *
   * 有价值的是另一条，而且它真的坏过：
   * `NODE_SHAPE` 原来只给节点**加**了 order、没**删** ord。
   * 客户端本地新建的节点只有 order 没有 ord，服务端回来的行却带 ord，
   * 于是那一行永远不相等 → 每次打开都重推 → 只读成员顶栏常驻
   * 「N 处修改没有保存」，而他一个字都没改。
   *
   * 所以这里查的是**行里不该再出现的服务端内部列**，且是拿真实数据查。
   */
  const INTERNAL_MUST_NOT_LEAK = ['ord', 'rev', 'updatedBy', 'trashed', '_lite', 'lockMemberId', 'lockAt']
  const nodes = Object.values(data.nodes || {})
  ok(nodes.length > 0, `有 ${nodes.length} 个目录节点可验`)

  const leaked = []
  for (const n of nodes) {
    for (const c of INTERNAL_MUST_NOT_LEAK) {
      // ord 只在 nodes 上查；rev/trashed 等由 toClient 统一摘掉
      if (c === 'ord' && n.__notNodes) continue
      if (c in n) leaked.push(`${c}`)
    }
  }
  ok(leaked.length === 0,
    '节点行里没有服务端内部列（漏了它，本地新建的节点就会永远「变了」）',
    [...new Set(leaked)].join(' '))

  // 同一件事从客户端的角度再看一遍：类型里有的字段，行里都得有
  const types2 = readFileSync('src/types/index.ts', 'utf8')
  const m = new RegExp('export interface TreeNode\\s*\\{([\\s\\S]*?)\\n\\}').exec(types2)
  const nodeTypeFields = [...m[1].matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((x) => x[1])
  const missing = [...new Set(nodes.flatMap((n) => nodeTypeFields))]
    .filter((f) => f !== 'children' && !nodes.some((n) => f in n))
  ok(missing.length === 0, `TreeNode 声明的字段，节点行里都真的有（缺: ${missing.join(',') || '无'}）`)

  // docs 走白名单，所以多出来的字段不参与比较 —— 这条把「白名单兜住了」变成可验证的
  const syncSrc = readFileSync('src/lib/sync.ts', 'utf8')
  ok(/const DOC_COMPARE_FIELDS = \[/.test(syncSrc), 'docs 的差分用白名单（COMPARE_FIELDS），不是黑名单')
  ok(/bookId.*spaceId/s.test(syncSrc.slice(syncSrc.indexOf('const DOC_COMPARE_FIELDS'), syncSrc.indexOf('const DOC_COMPARE_FIELDS') + 500)),
    '白名单里明确列了 bookId / spaceId（服务端给、类型没声明的那些字段因此不参与比较）')
}

console.log('\n== 知识库成员：id 必须在，否则「已在库里的人」会被当成没加过 ==')
{
  const bm = data.bookMembers || {}
  const rows = Array.isArray(bm) ? bm : Object.values(bm)
  ok(rows.length > 0, `有 ${rows.length} 行知识库成员可验`)
  const withId = rows.filter((r) => r.id !== undefined).length
  ok(withId === rows.length, `每一行都带 id（实际 ${withId}/${rows.length}）`)

  /**
   * 照界面上的判断重演一遍：b.id === m.id。
   *
   * 注意界面的 `candidates` 是拿**所有库的成员行**一起比的（`bookMembers` 来自
   * `getBookMembers(bookId)`，但这里模拟的是全量数据）——
   * 我一开始只按**第一个库**算期望，于是：
   * 全量环境里前面的套件改过共享数据，b1 只剩 1 人、别的库里还有别人，
   * 候选算出来 0、期望算出来 5，两边对不上。
   *
   * 期望必须是「不在**任何**库里的成员数」，跟判断口径一致。
   */
  const members = Object.values(data.members || {})
  const inAnyBook = new Set(rows.map((r) => String(r.id)))
  const candidates = members.filter((m) => !rows.some((b) => b.id === m.id))
  const expected = members.length - [...inAnyBook].filter((id) => members.some((m) => m.id === id)).length
  ok(candidates.length === expected,
    `「谁还没加进来」判对：全公司 ${members.length} 人，已在任一库里的 ${expected}，候选 ${candidates.length}`,
    `判成了 ${candidates.length}（应该是 ${expected}）`)

  /**
   * 去重必须**按库**算。
   * 一开始我把所有库的 15 行合在一起比大小，得到「集合 6 ≠ 行数 15」——
   * 那不是 bug，是同一个人在 3 个库里各有一行。界面上的
   * `getBookMembers(bookId)` 本来就是按库取的。
   */
  const perBook = new Map()
  for (const r of rows) {
    const k = String(r.bookId)
    if (!perBook.has(k)) perBook.set(k, new Set())
    perBook.get(k).add(r.id)
  }
  const anyDup = [...perBook.values()].some((s) => s.has(undefined))
  ok(!anyDup, '每个库内按 id 去重后都没有 undefined（否则同一个人能被反复添加）',
    [...perBook.keys()].join(','))
  const totalDistinct = [...perBook.values()].reduce((n, s) => n + s.size, 0)
  ok(totalDistinct === rows.length, `各库内的去重集合大小之和等于行数（${totalDistinct}/${rows.length}）`)
}

console.log('\n== 目录排序：order 必须在，否则拖拽调好的顺序一刷新就乱 ==')
{
  /**
   * 光比「有没有 order 这个键」不够 —— 键在但值是 `undefined` 一样排不了。
   * 所以这里照 BookIndex 的写法真排一次，并**把顺序打乱再排回去**：
   * 如果排序器根本不工作（比较结果全是 NaN），打乱之后它会原样返回。
   */
  const nodes = Object.values(data.nodes || {})
  ok(nodes.length > 0, `有 ${nodes.length} 个目录节点可验`)

  /**
   * 只在**同一父节点下的兄弟**里排。
   * 一开始我把整个库的节点（各层级混在一起）拿来排，ord 出现大量并列
   * （1,1,1,1,2,2,...）—— 而并列元素之间的相对次序本来就没定义，
   * 于是「打乱后再排」得到不同结果是**正常的**，不是排序坏了。
   */
  const groups = new Map()
  for (const n of nodes) {
    const k = String(n.bookId) + '/' + String(n.parentId ?? '')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(n)
  }
  const gk = [...groups.keys()].find((k) => groups.get(k).length >= 3)
  const list = groups.get(gk) || []
  ok(list.length >= 3, `挑到一组 ${list.length} 个兄弟节点（${gk}）`)

  const sorted = [...list].sort((a, b) => a.order - b.order)
  const ords = sorted.map((n) => Number(n.order))
  const isAscending = ords.every((v, i) => i === 0 || v >= ords[i - 1])
  ok(isAscending, `按 order 排出来是升序（${ords.join(',')}）`, JSON.stringify(ords))
  const distinct = new Set(ords).size === ords.length
  ok(distinct, '这组兄弟的 order 互不相同（否则下面的「打乱再排」验不了）', JSON.stringify(ords))

  const reshuffled = [...list].reverse().sort((a, b) => a.order - b.order)
  ok(reshuffled.map((n) => n.id).join(',') === sorted.map((n) => n.id).join(','),
    '把输入顺序反过来再排，结果仍然一样（说明排序真的在干活，不是恰好原序）',
    `${sorted.map((n) => n.id).join(',')} vs ${reshuffled.map((n) => n.id).join(',')}`)

  const allHaveOrder = nodes.every((n) => typeof n.order === 'number')
  ok(allHaveOrder, '每个节点都有数字类型的 order（`undefined - undefined` = NaN，sort 会静默失效）',
    `${nodes.filter((n) => typeof n.order !== 'number').length} 个没有`)
}

cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
