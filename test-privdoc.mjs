/* ============================================================
   文档级「仅自己可见」：除了作者本人，谁都看不到 —— **平台 owner 也一样**
   ============================================================
   这个功能以前是界面上一个标着「未实现」置灰的选项。2026-10-06 真做了。

   之所以要单独写一个套件、而且**逐个读面数**，是因为这类功能最典型的失败形态是：
   **「界面看不到了」而正文还在往外发**。作者以为安全了，实际泄漏还在。
   项目里已经吃过好几次同一族的亏（IP 白名单漏了附件/版本/分享/导出四条独立通路）。

   而接的面比看起来多，**最容易漏的是目录树**：
   `nodes` 自己带一份**标题副本**，也是同步实体 ——
   只过滤 `docs` 的话，别人照样在目录里看见这篇的标题（点进去才 403）。
   等于把「仅自己可见」这五个字直接写在标题上泄露了。

   本套件逐面验（每一面都是**两半**：别人看不到 + 作者看得到）：
     ① `/api/doc/:id` 与 versions / links / backlinks / share / view
     ② `/api/search`（SQL 前置 + JS 兜底两道）
     ③ `/api/entity/docs`（bootstrap 那条路）
     ④ `/api/sync/changes`（增量拉取）
     ⑤ `nodes`（**标题**不能漏）
     ⑥ 整包导出 + `/api/v2` 的 toc / docs 列表
   外加两条：
     ⑦ **平台 owner 同样看不到**（2026-10-06 明确决定）
     ⑧ 写路径：editor 不能把**别人**的文档设成 private（否则同事一推，
        作者自己就再也看不见自己那篇了）
   =================================================================== */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.PRIVDOC_PORT || await freePort()
const DB = 'data/_privdoc-test.db'
const BASE = `http://localhost:${PORT}`
const PW = 'privdoc@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }

const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', (d) => { log += d })
srv.stderr.on('data', (d) => { log += d })
/* ---- 收摊：等子进程**真的退出**再删库 ----
 *
 * ⚠️ 原来只有 `process.on('exit', stop)`：exit 处理器是**同步**的，
 * `srv.kill()` 只是发信号，那一刻子进程还活着（Windows 文件锁），
 * 删库必然失败又被空 catch 吞掉 —— 于是每单独跑一次，data/ 里就多留一个库。
 * 全量跑时 runner 的清扫会兜住，**单独跑不会**；而单独跑正是排查时做的事。
 */
const { rmSync: rmDb, existsSync: exDb } = await import('node:fs')
let srvExited = false
srv.once('exit', () => { srvExited = true })
const cleanup = async () => {
  if (!srvExited) {
    srv.kill()
    for (let i = 0; i < 50 && !srvExited; i++) await new Promise((r) => setTimeout(r, 100))
  }
  const stuck = []
  for (const s of ['', '-wal', '-shm']) {
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {
      try { rmDb(DB + s, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone && exDb(DB + s)) stuck.push(DB + s)
  }
  if (stuck.length) console.log('  ⚠️  临时库删不掉（服务可能还占着）：' + stuck.join(', '))
}
/* 兜底：崩溃/早退时也收一次（那时没法 await，只能尽力） */
const stop = () => { try { srv.kill() } catch {} }
process.on('exit', stop)

try {
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { /* 等 */ }
  }
  if (!up) { console.error('服务没起来：\n' + log.slice(0, 900)); stop(); process.exit(1) }

  const call = async (p, tok, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } })
    const t = await r.text()
    let d = null
    try { d = JSON.parse(t) } catch { /* 保留原文 */ }
    return { status: r.status, d, raw: t }
  }
  const login = async (a, pw) => (await call('/api/auth/login', '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: a, password: pw }) })).d?.token
  const reg = async (a) => (await call('/api/auth/register', '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: a, password: 'test1234', name: a }) })).d?.token
  const push = (tok, upsert) => call('/api/sync/push', tok, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upsert, remove: {} }) })

  console.log('== 前置：一个库、两个普通成员（外加平台 owner）==')
  const admin = await login('admin', PW)
  const A = await reg('pd_alice')   // 作者
  const B = await reg('pd_bob')     // 同库同事
  const uidA = one('SELECT id FROM users WHERE account = ?', 'pd_alice')?.id
  const uidB = one('SELECT id FROM users WHERE account = ?', 'pd_bob')?.id
  ok(!!admin && !!A && !!B && !!uidA && !!uidB, '三个账号就绪')

  const spId = (await call('/api/spaces', admin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'PD 空间' }) })).d?.space?.id
  const bid = 'b_pd_' + Date.now().toString(36)
  const mk = await push(admin, {
    books: [{ id: bid, spaceId: spId, name: 'PD 库', desc: '', avatar: '📗', visibility: 'private', createdAt: Date.now(), updatedAt: Date.now() }],
    bookMembers: [
      { bookId: bid, userId: uidA, role: 'editor', perms: '{}', joinedAt: Date.now() },
      { bookId: bid, userId: uidB, role: 'editor', perms: '{}', joinedAt: Date.now() },
    ],
  })
  ok((mk.d?.rejected || []).length === 0, `建库 + 加两人为 editor（${JSON.stringify(mk.d?.rejected)}）`)

  const TITLE = '薪酬调整方案 2026'
  const did = 'd_priv_' + Date.now().toString(36)
  const mkdoc = await push(A, {
    docs: [{ id: did, bookId: bid, spaceId: spId, type: 'doc', title: TITLE, body: '# 薪酬\n\n机密正文', blocks: [{ type: 'h1', text: '薪酬' }], authorId: uidA, wordCount: 4, createdAt: Date.now(), updatedAt: Date.now(), visibility: 'space' }],
  })
  ok((mkdoc.d?.rejected || []).length === 0, 'A 建了一篇普通可见的文档', JSON.stringify(mkdoc.d?.rejected))
  // 目录节点
  await push(A, { nodes: [{ id: 'n_' + did, bookId: bid, parentId: '', title: TITLE, type: 'doc', icon: '📄', docId: did, ord: 1, hidden: 0 }] })

  console.log('\n== 先在「普通可见」状态下，六个面都能被 B 看到（基准）==')
  {
    // ⚠️ 这条基准**必须**在文档建出来之后判。
    // 第一版把它放在建库加完人之后、创建文档之前 ——
    // 而那时候是个**空库**（`YQ_DEMO=0`），所以它读到 0 行、红了。
    // 「前置不成立」和「功能坏了」在结果上完全一样。
    const canRead = async (tok) => ((await call('/api/entity/docs', tok)).d?.rows || []).length
    ok(await canRead(A) > 0, `前置：A 读得到文稿（${await canRead(A)} 篇）—— 否则后面的判断是「他本来就没权限」而不是「私有生效了」`)
    ok(await canRead(B) > 0, `前置：B 也读得到（${await canRead(B)} 篇）`)
    ok((await call('/api/doc/' + did, B)).status === 200, '基准① B 能打开正文')
    ok((await call('/api/search?q=' + encodeURIComponent('薪酬'), B)).d?.results?.length > 0, '基准② B 搜得到')
    ok(((await call('/api/entity/docs', B)).d?.rows || []).some((r) => r.id === did), '基准③ B 的实体列表里有')
    ok(((await call('/api/sync/changes?since=0', B)).d?.upsert?.docs || []).some((r) => r.id === did), '基准④ B 的增量里有')
    ok(((await call('/api/entity/nodes', B)).d?.rows || []).some((r) => r.docId === did), '基准⑤ B 的目录节点里有')
    const ns = (await call('/api/v2/repos/' + encodeURIComponent(spId) + '/' + bid + '/toc', B))
    ok(JSON.stringify(ns.d || {}).includes(did), '基准⑥ B 的 v2 toc 里有')
  }

  console.log('\n== A 把它设成「仅自己可见」==')
  const setPriv = await push(A, { docs: [{ id: did, visibility: 'private' }] })
  ok((setPriv.d?.rejected || []).length === 0, 'A 能设（被拒说明判据写错了）', JSON.stringify(setPriv.d?.rejected))
  ok(one('SELECT visibility FROM docs WHERE id = ?', did)?.visibility === 'private', '库里真的写成了 private')

  console.log('\n== 六个面：除了 A，全都看不到 ==')
  const who = [['B（同事）', B], ['平台 owner', admin]]
  for (const [label, tok] of who) {
    const doc = await call('/api/doc/' + did, tok)
    ok(doc.status === 403, `${label} 打开正文 → 403（实际 ${doc.status}）`, doc.raw.slice(0, 60))
    ok((await call('/api/doc/' + did + '/versions', tok)).status === 403, `${label} 读历史版本 → 403`)
    ok((await call('/api/doc/' + did + '/links', tok)).status === 403, `${label} 读正向链接 → 403`)
    ok((await call('/api/doc/' + did + '/backlinks', tok)).status === 403, `${label} 读反向链接 → 403`)
    ok((await call('/api/doc/' + did + '/share', tok)).status === 403, `${label} 读分享设置 → 403`)
    const hits = (await call('/api/search?q=' + encodeURIComponent('薪酬'), tok)).d?.results || []
    ok(!hits.some((r) => r.id === did || String(r.title || '').includes(TITLE)),
      `${label} 搜不到（命中 ${hits.length} 条）`, JSON.stringify(hits.map((h) => h.id)))
    ok(!((await call('/api/entity/docs', tok)).d?.rows || []).some((r) => r.id === did), `${label} 实体列表里没有`)
    ok(!((await call('/api/sync/changes?since=0', tok)).d?.upsert?.docs || []).some((r) => r.id === did), `${label} 增量里没有`)
    // ⑤ 目录节点 —— 这一面最容易漏（nodes 自带标题副本）
    const nodes = (await call('/api/entity/nodes', tok)).d?.rows || []
    ok(!nodes.some((r) => r.docId === did), `${label} 目录里没有这个节点`)
    ok(!JSON.stringify(nodes).includes(TITLE), `${label} **目录里连标题都搜不到**（nodes 自带标题副本，只过滤 docs 会漏这一面）`)
    // ⑥ 导出 + v2
    const ex = (await call('/api/export', tok)).d
    ok(!JSON.stringify(ex?.docs || []).includes(did), `${label} 整包导出里没有`)
    ok(!JSON.stringify(ex?.nodes || []).includes(did), `${label} 导出里的目录节点也没有`)
    const ns = (await call('/api/v2/repos/' + encodeURIComponent(spId) + '/' + bid + '/toc', tok))
    ok(!JSON.stringify(ns.d || {}).includes(did), `${label} v2 toc 里没有`)
    const dl = (await call('/api/v2/repos/' + encodeURIComponent(spId) + '/' + bid + '/docs?limit=100', tok)).d
    ok(!((dl?.data || []).some((r) => r.id === did)), `${label} v2 文档列表里没有`)
    ok(!JSON.stringify(dl).includes(TITLE), `${label} v2 列表里连标题都没有`)
  }

  console.log('\n== 作者本人：处处都在 ==')
  {
    ok((await call('/api/doc/' + did, A)).status === 200, 'A 能打开正文')
    ok((await call('/api/doc/' + did + '/versions', A)).status === 200, 'A 能读历史版本')
    ok(((await call('/api/search?q=' + encodeURIComponent('薪酬'), A)).d?.results || []).some((r) => r.id === did), 'A 搜得到')
    ok(((await call('/api/entity/docs', A)).d?.rows || []).some((r) => r.id === did), 'A 的实体列表里有')
    ok(((await call('/api/sync/changes?since=0', A)).d?.upsert?.docs || []).some((r) => r.id === did), 'A 的增量里有')
    ok(((await call('/api/entity/nodes', A)).d?.rows || []).some((r) => r.docId === did), 'A 的目录里有')
    ok(JSON.stringify((await call('/api/export', A)).d).includes(did), 'A 的导出里有')
  }

  console.log('\n== 写路径：别人改不动这篇的可见性 ==')
  {
    // private → space：那等于**替别人把私密文稿公开给全空间**，最严重的一侧
    const toSpace = await push(B, { docs: [{ id: did, visibility: 'space' }] })
    ok((toSpace.d?.rejected || []).length > 0, `B 改不成「空间可见」（rejected ${(toSpace.d?.rejected || []).length} 条）`, JSON.stringify(toSpace.d?.rejected))
    ok(one('SELECT visibility FROM docs WHERE id = ?', did)?.visibility === 'private', '库里仍然是 private')
    const toPublic = await push(B, { docs: [{ id: did, visibility: 'public' }] })
    ok((toPublic.d?.rejected || []).length > 0, 'B 也改不成「互联网上可看」')
    const rePushPriv = await push(B, { docs: [{ id: did, visibility: 'private' }] })
    ok((rePushPriv.d?.rejected || []).length === 0,
      '而 B 推**同样的值**（已经是 private）**是空操作、照常放行** —— 判据比的是「值有没有真的变」')
    /*
     * 最重要的一条反向验证：判据不能误伤**正常的共同编辑**。
     * 协作者保存文档时推的是**整行**（含当前 visibility），值没变 ——
     * 如果判据写成「只要带了 visibility 就拒」，B 根本没法和 A 一起编辑。
     */
    const coedit = await push(B, {
      docs: [{ id: did, title: '薪酬调整方案 2026（B 改的标题）', body: '# 薪酬\n\nB 补了一句', blocks: [{ type: 'h1', text: '薪酬' }], wordCount: 6, visibility: 'private' }],
    })
    ok((coedit.d?.rejected || []).length === 0, 'B 正常保存（推整行、可见性没变）**不受影响**', JSON.stringify(coedit.d?.rejected))
    ok(one('SELECT title FROM docs WHERE id = ?', did)?.title === '薪酬调整方案 2026（B 改的标题）', '而且 B 的改动真落库了')
    ok(one('SELECT visibility FROM docs WHERE id = ?', did)?.visibility === 'private', '可见性没被顺手改掉')
  }

  console.log('\n== A 能改回去 ==')
  {
    const back = await push(A, { docs: [{ id: did, visibility: 'space' }] })
    ok((back.d?.rejected || []).length === 0, 'A 把它改回普通可见', JSON.stringify(back.d?.rejected))
    ok((await call('/api/doc/' + did, B)).status === 200, 'B 又能打开了')
  }
} catch (e) {
  fail++
  console.log(`  FAIL  套件异常：${e?.message || e}`)
} finally {
  await cleanup()
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
