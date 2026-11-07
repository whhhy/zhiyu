/**
 * 知识库的「N 篇 · M 字」：**读取时现算**，不读存量聚合。
 *
 * ============================================================
 * 这里修的是什么
 * ------------------------------------------------------------
 * `books.docCount` / `books.wordCount` 是两个**会漂移的存量聚合**：
 *   · docCount 只在「新建文档」时 +1，**删文档不减**
 *   · wordCount 建库之后再没被更新过，**编辑文档也不动它**
 *
 * 后果不是「慢慢不准」，是**直接跟真值对不上**：服务端 seed 建出来的
 * 知识库 wordCount 全是 0（客户端 seed 里写的是 28400/45100 那些编造的数字，
 * 而服务端才是权威）—— 于是工作台上每个库都显示「0 字」，
 * 同一本书的书页（那边碰巧是现算的）却显示 2107 字。
 *
 * 这跟项目里已经修过的「阅读统计是编造的」是同一类：
 * **把派生值存起来，就一定有一处路径忘了更新它。**
 *
 * ============================================================
 * 怎么钉住
 * ------------------------------------------------------------
 * ① 纯函数层：给定 books/docs/nodes，算出来的必须等于真值。
 * ② 源码层：界面上**不允许**再出现 `b.docCount` / `b.wordCount` 这种读法 ——
 *    否则哪天有人「顺手优化一下」就又回去了，而且代码看着完全正常。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { computeBookStats, statsOf } from './src/lib/bookStats.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

console.log('\n== 纯函数：算出来的必须等于真值 ==')
{
  const books = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
  const docs = {
    d1: { bookId: 'b1', wordCount: 100 },
    d2: { bookId: 'b1', wordCount: 250 },
    d3: { bookId: 'b2', wordCount: 42 },
  }
  const nodes = [
    { bookId: 'b1', docId: 'd1' },
    { bookId: 'b1', docId: 'd2' },
    { bookId: 'b2', docId: 'd3' },
  ]
  const m = computeBookStats(books, docs, nodes)
  ok(m.get('b1').docCount === 2, 'b1 有 2 篇', String(m.get('b1').docCount))
  ok(m.get('b1').wordCount === 350, 'b1 共 350 字', String(m.get('b1').wordCount))
  ok(m.get('b2').docCount === 1 && m.get('b2').wordCount === 42, 'b2 是 1 篇 42 字')
  ok(m.get('b3').docCount === 0 && m.get('b3').wordCount === 0, '空库是 0 篇 0 字（不是 undefined）')
}

console.log('\n== 口径：篇数按目录里挂出去的算，不按 docs 里现存的 ==')
{
  // 建好还没加进目录的文档，在界面上不算这个库的篇数 ——
  // 这和用户在书页看到的口径一致
  const books = [{ id: 'b1' }]
  const docs = { d1: { bookId: 'b1', wordCount: 10 }, d2: { bookId: 'b1', wordCount: 99 } }
  const m = computeBookStats(books, docs, [{ bookId: 'b1', docId: 'd1' }])
  ok(m.get('b1').docCount === 1, '没进目录的那篇不计入', String(m.get('b1').docCount))
  ok(m.get('b1').wordCount === 10, '字数同样只算进目录的那篇', String(m.get('b1').wordCount))
}

console.log('\n== 残缺数据不能把界面带崩 ==')
{
  const books = [{ id: 'b1' }]
  const m = computeBookStats(books, {}, [
    { bookId: 'b1', docId: 'gone' },      // 指向已删文档的残留节点
    { bookId: 'b1' },                      // 分组节点，没有 docId
    null,                            // 脏数据
    { docId: 'x' },                  // 没有 bookId
  ])
  ok(m.get('b1').docCount === 0, '残留节点/分组节点/脏数据都不会被算成文档', String(m.get('b1').docCount))
  ok(statsOf(m, '不存在').docCount === 0, '查一个不存在的库返回 0，不是 undefined')
  ok(statsOf(undefined, 'x').wordCount === 0, 'map 本身是 undefined 时也安全')
}

console.log('\n== 存量聚合被改了，真值跟着变（这正是修复的意义）==')
{
  // 模拟「删了一篇文档」：nodes 少一条，books 里的 docCount 仍是旧的
  const books = [{ id: 'b1', docCount: 9, wordCount: 999 }]
  const docs = { d1: { bookId: 'b1', wordCount: 10 } }
  const nodes = [{ bookId: 'b1', docId: 'd1' }]
  const m = computeBookStats(books, docs, nodes)
  ok(m.get('b1').docCount === 1, '删完立刻是 1 篇（存量的 9 被无视）', String(m.get('b1').docCount))
  ok(m.get('b1').wordCount === 10, '字数是 10（存量的 999 被无视）', String(m.get('b1').wordCount))
}

console.log('\n== 软删的文档：节点还挂着（hidden），但不算篇数 ==')
{
  /*
   * 2026-10-14 起，软删一篇文档**不再真删目录节点**，而是把节点 `hidden` 掉
   * （真删的话，还原时树上那个位置就找不回来了 —— 见 server/sync.ts 的
   * `hideNodesOfDoc`，以及 test-trash-perms.mjs 的 ⑥）。
   *
   * 于是出现了一个**新状态**：节点在、文档不在。
   * 它必须不被算成一篇 —— 否则书页上写着「N 篇」而树上只有 N−1 项。
   *
   * ⚠️ 这条以前是靠「文档取不到就跳过」顺带排除的，而那是**巧合**：
   *   另一条数法（`book-export`）查的是 `node.hidden`。两处规则不同，
   *   今天一致纯属运气 —— 而现在的状态里，「节点存在」已经是常态了。
   *   所以统计这边也必须**显式**按 hidden 排除。
   */
  const books = [{ id: 'b1' }]
  const docs = { d1: { bookId: 'b1', wordCount: 10 }, d2: { bookId: 'b1', wordCount: 99 } }
  const soft = computeBookStats(books, docs, [
    { bookId: 'b1', docId: 'd1' },
    { bookId: 'b1', docId: 'd2', hidden: true },   // 软删的那篇：节点留着
  ])
  ok(soft.get('b1').docCount === 1, '隐藏的节点不算篇数（哪怕文档还在 docs 里）', String(soft.get('b1').docCount))
  ok(soft.get('b1').wordCount === 10, '字数同样只算可见的那篇', String(soft.get('b1').wordCount))

  // 还原之后 hidden 被清掉 → 它就该重新计入
  const restored = computeBookStats(books, docs, [
    { bookId: 'b1', docId: 'd1' },
    { bookId: 'b1', docId: 'd2', hidden: false },
  ])
  ok(restored.get('b1').docCount === 2, '还原之后（hidden 清掉）重新计入', String(restored.get('b1').docCount))
  ok(restored.get('b1').wordCount === 109, '字数也跟着回来', String(restored.get('b1').wordCount))

  // 文档根本不在（更老的那种残留节点）也照样不算 —— 两条路都得通
  const gone = computeBookStats(books, { d1: { bookId: 'b1', wordCount: 10 } }, [
    { bookId: 'b1', docId: 'd1' },
    { bookId: 'b1', docId: 'd2', hidden: true },
  ])
  ok(gone.get('b1').docCount === 1, '文档不在时的隐藏节点也不计入', String(gone.get('b1').docCount))
}

console.log('\n== 界面里不许再出现读存量聚合的写法 ==')
{
  /**
   * 这条是防止**回退**，比前面那些都重要。
   * 有人（比如后来的我）看到 books 上有现成的数字，觉得「直接读不是更快」，
   * 就把 `bs(b)` 改回 `b` —— 代码完全能编译、界面也不报错，
   * 只是又变回「同一个知识库两个页面两个数」。
   */
  const files = readdirSync('src')
    .flatMap((d) => {
      try { return readdirSync(`src/${d}`).map((f) => `src/${d}/${f}`) } catch { return [] }
    })
    .concat(readdirSync('src').filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `src/${f}`))
    .filter((f) => /\.(ts|tsx)$/.test(f))

  const bad = []
  for (const f of files) {
    const s = readFileSync(f, 'utf8')
    s.split('\n').forEach((l, i) => {
      // 排除注释行和 doc 自身的说明
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (/\bb\.docCount\b|\bb\.wordCount\b|\bbook\.docCount\b|\bbook\.wordCount\b/.test(code)) {
        bad.push(`${f}:${i + 1}`)
      }
    })
  }
  ok(bad.length === 0, `界面上没有读 books.docCount / books.wordCount 的地方（扫了 ${files.length} 个文件）`,
    bad.join(' '))
}

console.log('\n== 空间成员（2026-10-17）==')
{
  /**
   * 成员头像**必须跟着一个明确的名册**。
   *
   * 删掉的那一处在 `Dashboard.tsx` 的工作台头部：
   * `AvatarGroup members={members.map(m => m.name)}` —— 取的是 **members 全表**。
   * 三条独立的理由让它该删：
   * ① 实测语雀 `/dashboard` 头部右上角是**空的**，没有这个东西；
   * ② 它不受空间限制 —— 一个只在 1 人空间里的新账号，头部也会看见
   *    这台机器上另外 6 个人，而他对那些人没有任何权限（内网部署即信息泄露）；
   * ③ 侧栏写「1 位成员」、头部摆 7 个头像，自己跟自己打架，
   *    而且没有标题/tooltip/点击，读者无从知道那是什么意思。
   *
   * ⚠️ 这条**不是**「工作台不许有头像」——
   * 文档页的协作条（`AvatarGroup members={rows...}` + 「N 人正在协作」）和
   * 空间页的成员概览都**必须留着**：那两处限定在真实名册旁边并带人数，
   * 是有信息量的。把它们一起删掉就是「为了让守卫变绿而删功能」。
   */
  const dash = readFileSync('src/pages/Dashboard.tsx', 'utf8')
  /*
   * ⚠️ 必须**整块剥掉注释**再判。
   * 上面那段说明里**故意引着被删掉的那行原文**（`AvatarGroup members={members.map...}`），
   * 不剥注释的话这条判据会命中自己的说明文字 —— 于是每次有人补充这段注释都会红，
   * 而判据真正要防的东西（代码里那一行）反而没被检查到。
   *
   * 而且不能只按行剥 `^\s*\*` 那种 JSDoc 写法：JSX 里写的是 `{/* … *\/}`，
   * 续行是**缩进的普通文本**、不以 `*` 开头，按行剥会漏掉它们。
   * → 直接把 `/* … *\/` 整块正则掉，最稳。
   */
  const dashCode = dash.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  ok(!/AvatarGroup[^>]*members=\{members/.test(dashCode),
    '工作台头部不再渲染「全实例成员」头像排（不受空间限制 + 语雀没有）')

  const doc = readFileSync('src/pages/DocPage.tsx', 'utf8')
  ok(/AvatarGroup[^>]*members=\{rows\.map/.test(doc),
    '文档页的协作条头像仍在（它限定在真实协作者旁边并带人数，不是同一个问题）')

  const space = readFileSync('src/pages/Space.tsx', 'utf8')
  ok(/AvatarGroup/.test(space),
    '空间页的成员头像仍在（同上：跟着名册走）')
}

console.log('\n== 空间的 memberCount 必须由服务端现算（表里根本没这一列）==')
{
  /**
   * `spaces` 表**没有** memberCount 列（客户端 seed 里有，服务端才是权威），
   * 而顶栏的空间切换器、侧栏、工作台三处都在读它 ——
   * 于是服务端模式下那三处显示的是空白：`undefined 位成员` 被 React 渲染成空，
   * 看起来像「加载失败」而不是「没数据」。
   *
   * 而且**只能在服务端算**：客户端拿不到 `space_members`（不在同步实体清单里）。
   */
  const { spawn } = await import('node:child_process')
  const { existsSync, rmSync } = await import('node:fs')
  const net = await import('node:net')
  const DB = 'data/_bookstats-srv.db'
  // 启动前先清：上一轮崩掉留下的半截库会让「起不来 / 读不到」的报错
  // 完全指错方向（test-lint 有一条检查专门盯这个）
  for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) { try { rmSync(DB + s, { force: true }) } catch { /* 还被占着就算了 */ } }
  /*
   * ⚠️ 端口**必须向系统要**（2026-10-20 实测踩到）。
   *
   * 原来这里写死 8124，而 8124 会被**别的项目**占着 ——
   * 实测：`H:\tmp\d\_scratch\serve.mjs ... forest-cabin-web 8124` 那个服务
   * 一直挂在 8124 上，于是本套件自己的服务**绑不上端口**，
   * 症状是「服务端起不来（这条用例跳过其余部分）」——
   * **完全指不到真因**（看着像本套件坏了，其实是别人的进程占着）。
   *
   * 同族：`test-avatar-e2e` 早就改成了 `YQ_AV_PORT || await freePort()`，
   * 本套件是**最后一个**还写死的（写死的端口 8124 与 avatar-e2e 重号，
   * 谁先跑完、谁没收干净，后一个就挂）。
   * 环境变量仍然保留 —— 排查时能指定端口。
   */
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
  const PORT = Number(process.env.BOOKSTATS_PORT || await freePort())
  const BASE = `http://localhost:${PORT}`
  const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), YQ_DB: DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {})
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { /* 等 */ }
  }
  if (!up) {
    ok(false, '服务端起不来（这条用例跳过其余部分）')
  } else {
    const li = await (await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
    })).json()
    const H = { Authorization: 'Bearer ' + li.token }
    const j = async (p) => (await (await fetch(BASE + p, { headers: H })).json())
    const bk = await j('/api/bootstrap?lite=0')
    const spaces = Object.values(bk.data.spaces || {})
    const team = spaces.find((s) => s.kind === 'team') || spaces[0]
    const m0 = await j(`/api/spaces/${team.id}/members`)
    const real = (m0.members || []).length
    ok(typeof team.memberCount === 'number', '空间行里 memberCount 是个数字（不是 undefined）',
      JSON.stringify(team.memberCount))
    ok(team.memberCount === real, `memberCount 和成员名册对得上（${team.memberCount} vs ${real}）`)

    // 没人加入的空间也要是 0，而不是 undefined
    const personal = spaces.find((s) => s.kind === 'personal')
    if (personal) {
      const pm = await j(`/api/spaces/${personal.id}/members`)
      ok(personal.memberCount === (pm.members || []).length,
        '个人空间的成员数也对得上', `${personal.memberCount} vs ${(pm.members || []).length}`)
    }

    // 加一个人之后：全量要变，增量也要带上（否则别的端永远停在旧数字）
    const acct = 'bs_' + Math.random().toString(36).slice(2, 8)
    const reg = await (await fetch(`${BASE}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: acct, name: '新同学', password: 'Bs@2026pass' }),
    })).json()
    const uid = reg.userId || reg.user?.id || reg.id
    const seqBefore = bk.seq
    const add = await (await fetch(`${BASE}/api/spaces/${team.id}/members`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...H },
      body: JSON.stringify({ userIds: [uid], role: 'member' }),
    })).json()

    const bk2 = await j('/api/bootstrap?lite=0')
    const team2 = Object.values(bk2.data.spaces || {}).find((s) => s.id === team.id)
    ok(team2 && team2.memberCount === real + 1, `加一个人后全量的 memberCount 变成 ${real + 1}`,
      String(team2 && team2.memberCount))

    const d = await j(`/api/sync/changes?since=${seqBefore}`)
    const spaceRow = (d.upsert?.spaces || []).find((r) => r.id === team.id)
    ok(spaceRow && spaceRow.memberCount === real + 1,
      '增量流里也带上了刷新的 memberCount（`space_members` 不在同步清单里，必须手动记一笔）',
      JSON.stringify(spaceRow))
    void add
  }
  try { srv.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) { try { rmSync(DB + s) } catch { /* 删不掉就算了 */ } }
}

console.log('\n== 堆叠卡：每库最近 N 篇（团队主页 book_stacks）==')
{
  const { computeBookRecentDocs } = await import('./src/lib/bookStats.ts')
  const books = [{ id: 'b1' }, { id: 'b2' }]
  const docs = {
    old: { title: '旧文档', updatedAt: 100 },
    mid: { title: '中文档', updatedAt: 200 },
    new: { title: '新文档', updatedAt: 300 },
    hidden: { title: '软删掉的那篇', updatedAt: 999 },
    ghost: { title: '他读不到的那篇', updatedAt: 999 },
  }
  const nodes = [
    { bookId: 'b1', docId: 'old' },
    { bookId: 'b1', docId: 'mid' },
    { bookId: 'b1', docId: 'new' },
    { bookId: 'b1', docId: 'hidden', hidden: true },   // 软删：节点藏起来
    { bookId: 'b2', docId: 'ghost' },
  ]
  const m = computeBookRecentDocs(books, docs, nodes, 3)

  ok(m.get('b1').length === 3, 'b1 取够 3 篇', String(m.get('b1').length))
  ok(JSON.stringify(m.get('b1').map((d) => d.id)) === JSON.stringify(['new', 'mid', 'old']),
    '按 updatedAt 倒序（新→旧）', JSON.stringify(m.get('b1').map((d) => d.id)))

  ok(!m.get('b1').some((d) => d.id === 'hidden'),
    '软删的节点不进堆叠卡（与 computeBookStats 同源，篇数与树上对得上）')

  ok(m.get('b2').length === 1 && m.get('b2')[0].id === 'ghost',
    'docs 里取不到的节点照常出现（客户端 store 里它本来就在）')

  /* 真正要守的是这一条：服务端 `docs` 行按 canSeeDocRow 过滤过，
     读不到的文档**根本不在** store 的 docs 里。取不到 ⇒ 不该出现在堆叠卡上。
     哪天有人改成「直接遍历 docs」，私有文档的标题就会顺着这张卡漏出去。 */
  const privateDocs = { vis: { title: '看得到的', updatedAt: 500 } }
  const m2 = computeBookRecentDocs(books, privateDocs,
    [{ bookId: 'b1', docId: 'vis' }, { bookId: 'b1', docId: 'secret' }], 3)
  ok(m2.get('b1').length === 1 && m2.get('b1')[0].id === 'vis',
    'store 里没有的文档不出现在堆叠卡上 —— 私有文档标题不会顺着卡泄漏',
    JSON.stringify(m2.get('b1')))

  ok(computeBookRecentDocs(books, {}, [], 3).get('b2') instanceof Array &&
    computeBookRecentDocs(books, {}, [], 3).get('b2').length === 0,
    '空库返回空数组（不是 undefined，界面 .map 不会炸）')

  const tied = computeBookRecentDocs([{ id: 'b1' }],
    { a: { title: 'B 篇', updatedAt: 7 }, b: { title: 'A 篇', updatedAt: 7 } },
    [{ bookId: 'b1', docId: 'a' }, { bookId: 'b1', docId: 'b' }], 3)
  ok(JSON.stringify(tied.get('b1').map((d) => d.title)) === JSON.stringify(['A 篇', 'B 篇']),
    '同毫秒更新时按标题定序，两次跑结果一致（不会每次渲染都跳）',
    JSON.stringify(tied.get('b1').map((d) => d.title)))

  const asArray = computeBookRecentDocs(
    [{ id: 'b1' }],
    [{ id: 'x1', title: '数组形状', updatedAt: 9 }],
    [{ bookId: 'b1', docId: 'x1' }], 3)
  ok(asArray.get('b1').length === 1 && asArray.get('b1')[0].title === '数组形状',
    'docs 传数组也能算（服务端载荷就是数组，按 id 建索引这一步不能反）',
    JSON.stringify(asArray.get('b1')))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
