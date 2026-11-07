/**
 * 永久删除一篇文档：它带的东西都得跟着走
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 「永久删除」以前只删了 docs / trash / doc_versions 三张表。
 * 实测一篇带目录节点 + 300KB 附件 + 一条评论的文档删完之后：
 *
 *   · **目录树上那一项还在** —— 点进去是 404
 *   · **附件 BLOB 还在** —— 而且没有任何机制会回收它
 *   · 评论、划词评论、收藏、最近访问、协作快照、阅读记录、分享设置，全都还在
 *
 * attachments 没有外键，所以不会级联；而「永久删除」本该是
 * 「这篇东西在这套系统里彻底不存在了」。
 *
 * 有 14 张表按 docId（或间接）挂着一篇文档的数据。
 * 这里分两类验：
 *   · **造得出来的**（节点 / 附件 / 评论 / 回复 / 收藏）→ 真造、真删、真数
 *   · **造不出来的**（最近访问 / 阅读记录 / 协作快照 / 分享设置 / 引用关系）
 *     → 用静态检查确认清理 SQL 覆盖到了。理由写在那节里。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.DOCPURGE_PORT || await freePort()
const DB = 'data/_docpurge-test.db'
const BASE = `http://localhost:${PORT}`

const call = async (p, o = {}, t = '') => {
  const r = await fetch(BASE + p, {
    ...o,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const ses = (p, o = {}, t = '') => call(p, o, t)

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
}

/**
 * 端口守卫：**起服务之前先问一句有没有人在听。**
 *
 * 为什么必须有：上一轮跑这个套件时超时被杀，服务进程活了下来。
 * 于是后面每次跑都是「新进程绑不上端口、健康检查打到旧进程上」——
 * 测试**全部跑在旧代码上，却一份报告都绿**。
 * 更坏的是它看起来像「破坏无效」，会让人怀疑测试写得不对，
 * 而真相是压根没跑到新代码。
 *
 * 这和 `run-all-tests` 开头那道端口检查是同一件事 ——
 * 自起服务的套件都需要它。发现不了「跑在旧进程上」的测试，
 * 等于没有测试。
 */
{
  const busy = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
  if (busy) {
    console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在**旧进程**上，结果不可信。`)
    console.error(`先停掉它，或换个端口：DOCPURGE_PORT=8152 node test-docpurge.mjs`)
    process.exit(1)
  }
}

const server = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

const cleanup = () => {
  try { server.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}
process.on('exit', cleanup)

let up = false
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

const admin = (await ses('/api/auth/login', {
  method: 'POST', body: JSON.stringify({ account: 'admin', password: 'yuque@2026' }),
})).json.token || ''
ok(!!admin, '管理员登录成功')

const B = (await ses('/api/entity/books', {}, admin)).json.rows[0]
const SFX = Math.random().toString(36).slice(2, 7)

const dbq = () => new DatabaseSync(DB)
const n = (sql, ...a) => { const d = dbq(); const v = Number(d.prepare(sql).get(...a).n); d.close(); return v }
const backdate = (id, days) => {
  const d = dbq()
  d.exec('PRAGMA busy_timeout = 5000')
  d.prepare('UPDATE docs SET deletedAt = ? WHERE id = ?').run(Date.now() - days * 86400000, id)
  d.close()
}

/** 造一篇「什么挂的都齐」的文档 */
async function makeFull(name) {
  const id = `pg_${name}_${SFX}`
  const nid = `pg_n_${name}_${SFX}`
  const cid = `pg_c_${name}_${SFX}`
  const scid = `pg_sc_${name}_${SFX}`
  const rid = `pg_r_${name}_${SFX}`
  const srid = `pg_sr_${name}_${SFX}`
  const now = Date.now()

  const p1 = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{ id, bookId: B.id, title: `级联探针${name}`, body: `正文${SFX}`, createdAt: now, updatedAt: now, wordCount: 1 }],
        nodes: [{ id: nid, bookId: B.id, title: `级联探针${name}`, type: 'doc', docId: id, ord: 900 }],
        comments: [{ id: cid, docId: id, text: '一级评论', createdAt: now }],
        selectionComments: [{ id: scid, docId: id, text: '划词评论', blockId: 'b1', createdAt: now }],
        favorites: [{ id: `pg_f_${SFX}_${name}`, userId: 'u_admin', targetType: 'doc', targetId: id, title: '', createdAt: now }],
      },
    }),
  }, admin)
  ok(!(p1.json.rejected || []).length, `造文档 ${name}（第一批发）`, JSON.stringify(p1.json.rejected || []).slice(0, 140))

  // 回复要单独一批 —— 它们按父 id 关联，父不存在就会被拒（没有外键，但权限判定会挂）
  const p2 = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        commentReplies: [{ id: rid, commentId: cid, text: '回复', createdAt: now }],
        selectionCommentReplies: [{ id: srid, selectionCommentId: scid, text: '划词回复', createdAt: now }],
      },
    }),
  }, admin)
  ok(!(p2.json.rejected || []).length, `造文档 ${name}（第二批：回复）`, JSON.stringify(p2.json.rejected || []).slice(0, 140))

  const bytes = Buffer.alloc(120 * 1024, 3)
  const up = await fetch(`${BASE}/api/attachment?docId=${id}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream', 'x-filename': 'probe.bin' },
    body: bytes,
  })
  const att = await up.json().catch(() => ({}))
  ok(up.status === 200 && !!att.id, `造文档 ${name}：传附件 ${Math.round(bytes.length / 1024)}KB`, String(up.status))

  return { id, nid, cid, scid, rid, srid }
}

/** 放进回收站。注意：sync push 的 remove **不会**写 trash 行，
 *  得自己补 —— 不补的话它压根不在回收站里，后面的用例全是空跑。 */
async function intoTrash(f) {
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [f.id] } }) }, admin)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { trash: [{ docId: f.id, bookId: B.id, title: `级联探针`, deletedAt: Date.now() }] } }),
  }, admin)
  ok(n('SELECT COUNT(*) AS n FROM trash WHERE docId = ?', f.id) === 1, '确实在回收站里了')
}

function residueOf(f) {
  return {
    docs: n('SELECT COUNT(*) AS n FROM docs WHERE id = ?', f.id),
    nodes: n('SELECT COUNT(*) AS n FROM nodes WHERE docId = ?', f.id),
    trash: n('SELECT COUNT(*) AS n FROM trash WHERE docId = ?', f.id),
    versions: n('SELECT COUNT(*) AS n FROM doc_versions WHERE docId = ?', f.id),
    attachments: n('SELECT COUNT(*) AS n FROM attachments WHERE docId = ?', f.id),
    attachmentBytes: n('SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE docId = ?', f.id),
    comments: n('SELECT COUNT(*) AS n FROM comments WHERE docId = ?', f.id),
    commentReplies: n('SELECT COUNT(*) AS n FROM comment_replies WHERE commentId = ?', f.cid),
    selComments: n('SELECT COUNT(*) AS n FROM selection_comments WHERE docId = ?', f.id),
    selReplies: n('SELECT COUNT(*) AS n FROM selection_comment_replies WHERE selectionCommentId = ?', f.scid),
    favorites: n("SELECT COUNT(*) AS n FROM favorites WHERE targetType = 'doc' AND targetId = ?", f.id),
    recents: n('SELECT COUNT(*) AS n FROM recents WHERE docId = ?', f.id),
    snapshots: n('SELECT COUNT(*) AS n FROM doc_snapshots WHERE docId = ?', f.id),
    views: n('SELECT COUNT(*) AS n FROM doc_views WHERE docId = ?', f.id),
    share: n('SELECT COUNT(*) AS n FROM doc_share WHERE docId = ?', f.id),
    links: n('SELECT COUNT(*) AS n FROM doc_links WHERE targetDocId = ? OR sourceDocId = ?', f.id, f.id),
  }
}

console.log('\n== 删之前：这篇确实挂着这些东西 ==')
const f = await makeFull('a')
{
  const r = residueOf(f)
  const seeded = ['docs', 'nodes', 'attachments', 'comments', 'commentReplies', 'selComments', 'selReplies', 'favorites']
  for (const k of seeded) ok(r[k] > 0, `删之前：${k} 有 ${r[k]} 条`)
  ok(r.attachmentBytes > 0, `删之前：附件 ${Math.round(r.attachmentBytes / 1024)}KB`)
}

console.log('\n== 永久删除：一张表都不许留 ==')
{
  const r = await ses(`/api/doc/${f.id}/purge`, { method: 'POST' }, admin)
  ok(r.status === 200, '删除成功', String(r.status))
  const left = residueOf(f)
  for (const [k, v] of Object.entries(left)) {
    ok(v === 0, `删之后：${k} 归零（实际 ${v}）`)
  }
}

console.log('\n== 别的设备上也得消失 ==')
{
  /*
   * 这里的 since 必须取**删除之前**的 seq，不能用 0。
   *
   * `changesSince` 的语义是「拿 since 之后的日志，重新算一遍当前状态」：
   * 日志里有、但行已经没了的，它会翻译成一条删除。
   * 所以用 since=0 时，创建那会儿的 nodes 日志也会被重算一遍，
   * 于是 `remove.nodes` 里**本来就有**那个 id ——
   * 哪怕服务端压根没记过 nodes 的删除。
   *
   * 而真实场景是：一台设备早就同步过创建时间了，它的 since 在创建之后。
   * 这时服务端不补一条 nodes 的删除日志，它就永远不知道树上那一项没了 ——
   * 表现是「这篇文档在我这儿的目录树里点进去 404」。
   */
  const seqBeforePurge = Number((await ses('/api/sync/changes?since=0', {}, admin)).json.seq || 0)
  const f2 = await makeFull('c')
  const seqAfterCreate = Number((await ses('/api/sync/changes?since=0', {}, admin)).json.seq || 0)
  ok(seqAfterCreate > seqBeforePurge, '造这篇文档产生了新的变更（基准点有效）')

  await ses(`/api/doc/${f2.id}/purge`, { method: 'POST' }, admin)

  const delta = (await ses(`/api/sync/changes?since=${seqAfterCreate}`, {}, admin)).json
  ok((delta.remove?.docs || []).includes(f2.id), '增量里有 docs 的删除')
  ok((delta.remove?.nodes || []).includes(f2.nid),
    '**增量里有 nodes 的删除** —— 一台早就同步过的设备只能靠这条知道树上那一项没了')
}

console.log('\n== 保留期自动清除走的是同一条路 ==')
{
  /*
   * 上一节验的是「手动清空回收站」（/api/trash/purge-all → purgeDoc → purgeDocCore）。
   * 这一节验**保留期任务**（purgeExpiredTrash）也走同一套清理。
   *
   * 一开始我以为两节验的是同一件事，用 purge-all 去触发保留期任务 ——
   * 结果破坏对照里「保留期不清附件」那条怎么拆都不红，
   * 因为 purge-all 压根不经过 purgeExpiredTrash。
   * **破坏点和断言压根不在同一条路上。**
   *
   * 这一节直接改库把 deletedAt 拨到过去，然后跑 purge-all：
   * 保留期任务在这里没法直接触发（它在服务启动时跑），所以
   * 「保留期任务本身清得干不干净」由 test-trashretain 的重启来验，
   * 这里只保证「清空回收站」这条路上不会留尾巴。
   */
  const g = await makeFull('b')
  await intoTrash(g)
  backdate(g.id, 40)
  const r = await ses('/api/trash/purge-all', { method: 'POST' }, admin)
  ok(r.status === 200, '清空回收站成功', String(r.status))
  const left = residueOf(g)
  ok(left.docs === 0, '文档没了')
  ok(left.attachments === 0, '**附件也没了**', String(left.attachments))
  ok(left.nodes === 0, '目录节点也没了', String(left.nodes))
  ok(left.comments === 0, '评论也没了', String(left.comments))
  ok(left.selReplies === 0, '划词回复也没了', String(left.selReplies))
  ok(left.commentReplies === 0, '评论回复也没了', String(left.commentReplies))
}

console.log('\n== 别把别的文档误删 ==')
{
  const keep = await makeFull('keep')
  const gone = await makeFull('gone')
  await intoTrash(gone)
  backdate(gone.id, 40)
  await ses('/api/trash/purge-all', { method: 'POST' }, admin)
  ok(n('SELECT COUNT(*) AS n FROM docs WHERE id = ?', gone.id) === 0, '要删的那篇确实删了')
  const r = residueOf(keep)
  ok(r.docs === 1, '**别的文档还在**', String(r.docs))
  ok(r.nodes === 1, '别的文档的目录节点还在', String(r.nodes))
  ok(r.attachments === 1, '别的文档的附件还在', String(r.attachments))
  ok(r.comments === 1, '别的文档的评论还在', String(r.comments))
}

console.log('\n== 永久删除不能弄坏「复制出来的那一份」 ==')
{
  /*
   * 与 7.13 同一个根因的两处表现之一（另一处是附件删除接口）。
   *
   * `moveDoc` 复制文档时是**逐字照抄 blocks** 的，于是副本和原件
   * 指向同一个附件 id，而 `attachments` 表只记了「谁传的」那一份。
   * 原来 purgeDocCore 一行 `DELETE FROM attachments WHERE docId = ?`
   * 就把整篇的附件全带走 —— 副本自己好端端的，卡片却成了死的。
   *
   * 永久删除是最破坏性的操作：用户要的「那一篇没了」，
   * 绝不该变成「旁边那篇坏了」。
   *
   * 这里**先摆基准**：先断言副本确实共指同一份附件。
   * 不摆的话，把引用判定整个删掉，下面那些断言照样会红。
   */
  const book2 = `pg_bk2_${SFX}`
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { books: [{ id: book2, spaceId: 's1', name: '级联探针库二', visibility: 'space', createdAt: Date.now(), updatedAt: Date.now() }] } }),
  }, admin)

  const src = await makeFull('shared')
  // 要的是**附件 id 本身**，不是行数。写成 `SELECT id` 再去取 `.n`
  // 会拿到 undefined → NaN → 后面所有拿 attId 做的比较都成了
  // `undefined === undefined`，**基准断言于是空过**（下面那句就是证据）。
  const attId = (() => {
    const d = dbq()
    d.exec('PRAGMA busy_timeout = 5000')
    const r = d.prepare('SELECT id FROM attachments WHERE docId = ? ORDER BY createdAt DESC').get(src.id)
    d.close()
    return String(r?.id || '')
  })()
  ok(!!attId, '原件有一份附件（拿到的是 id 本身）', attId)

  // 让正文真的引用它（和真实上传路径一样）
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { docs: [{ id: src.id, bookId: B.id, title: '级联探针shared', body: 'x', createdAt: Date.now(), updatedAt: Date.now(), wordCount: 1, blocks: [{ id: 'bk_att', type: 'card', text: '', data: { cardId: 'file', key: attId, name: 'probe.bin', size: 1 } }] }] },
    }),
  }, admin)
  const srcBlocks = (await ses('/api/entity/docs', {}, admin)).json.rows.find((x) => x.id === src.id)?.blocks || []
  /*
   * 基准确认里刻意**先要求 attId 非空**：写成 `key === attId` 的话，
   * 两边都是空串时它会「通过」—— 那不是确认场景成立，
   * 那是确认不了任何事。空值相等是最容易伪装成绿灯的一种相等。
   */
  ok(!!attId && srcBlocks[0]?.data?.key === attId, '原件引用了它（基准，且 attId 本身非空）', JSON.stringify(srcBlocks).slice(0, 90))

  const mv = await ses(`/api/doc/${src.id}/move`, {
    method: 'POST', body: JSON.stringify({ bookId: book2, mode: 'copy' }),
  }, admin)
  const copyId = mv.json.docId || ''
  ok(mv.status === 200 && !!copyId, '复制一份到另一个知识库', `${mv.status} ${JSON.stringify(mv.json).slice(0, 80)}`)

  const copyBlocks = (await ses('/api/entity/docs', {}, admin)).json.rows.find((x) => x.id === copyId)?.blocks || []
  ok(!!attId && copyBlocks[0]?.data?.key === attId,
    '**副本与原件共指同一份附件**（moveDoc 逐字照抄 blocks）', `副本=${copyBlocks[0]?.data?.key} 真实=${attId}`)

  console.log('-- 永久删除【原件】--')
  {
    const r = await ses(`/api/doc/${src.id}/purge`, { method: 'POST' }, admin)
    ok(r.status === 200, '永久删除原件成功', String(r.status))
    ok(n('SELECT COUNT(*) AS n FROM docs WHERE id = ?', src.id) === 0, '原件确实没了')

    ok(n('SELECT COUNT(*) AS n FROM docs WHERE id = ?', copyId) === 1, '**副本还在**（它跟这次删除无关）')
    ok(n('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attId) === 1,
      '**副本还在用的附件也还在** —— 原来这里会跟着原件一起被删掉')

    // 关键：附件**在库里还不够**，还得下得到。
    // 只保留二进制而把 attachments.docId 留在已删文档上的话，
    // 鉴权 capsOfDoc(u, row.docId) 会落在一个不存在的文档上 → 403，
    // 卡片还是死的（第一版就栽在这里，二进制保住了却谁都下不到）。
    const dl = await fetch(`${BASE}/api/attachment/${attId}`, { headers: { Authorization: 'Bearer ' + admin } })
    ok(dl.status === 200, '**而且副本下得到**（归属已迁到副本，不是留在已删的原件上）', String(dl.status))
  }

  console.log('-- 再把副本也删掉：这次该真删 --')
  {
    await ses(`/api/doc/${copyId}/purge`, { method: 'POST' }, admin)
    ok(n('SELECT COUNT(*) AS n FROM docs WHERE id = ?', copyId) === 0, '副本也没了')
    ok(n('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attId) === 0,
      '**最后一个引用者删掉后，附件才真被删掉** —— 保留期是有终点的，不是不删')
  }
}

console.log('\n== 造不出来的那几张表：确认清理 SQL 覆盖到了 ==')
{
  /*
   * recents / doc_views / doc_snapshots / doc_share / doc_links
   * 这些要么由服务端在别的时机写、要么要另一篇文档来引用，
   * 硬造反而把测试搞复杂。所以这里改成**静态确认清理语句覆盖到** ——
   *
   * 明确说一句：这是**较弱**的一种验法，它只能证明「代码里写了那条 DELETE」，
   * 证明不了「跑起来真的删干净了」。前面那些能真造出来的表才是强证据。
   * 宁可承认弱，也不要把静态检查说成端到端验证。
   */
  const src = readFileSync('server/sync.ts', 'utf8')
  /*
   * 切到**函数的结尾**，不是「往后 3000 个字符」。
   *
   * 原来写死 3000：函数体一旦变长，后面几条 DELETE 就被切到窗口外，
   * 断言会**假红**。这次给附件那段加了引用判定，函数体超过 3000，
   * recents / doc_views / doc_share / favorites / trash 全被切出去了 ——
   * 五个断言同时变红，而产品其实一行都没错。
   *
   * 写死长度是那种「安静地错着」的检查：窗口够大时看不出问题，
   * 直到有人加了十几行代码才突然冒红，然后被误当成真 bug 去查。
   * 改成按函数边界切，函数体怎么变都不影响。
   */
  const start = src.indexOf('function purgeDocCore')
  const rest = src.slice(start)
  const end = rest.indexOf('\n}\n')
  const core = end > 0 ? rest.slice(0, end + 3) : rest
  ok(start >= 0 && end > 0, '（能切出 purgeDocCore 的完整函数体）', `start=${start} end=${end}`)

  for (const t of ['recents', 'doc_snapshots', 'doc_views', 'doc_share', 'doc_links', 'attachments', 'nodes', 'comments', 'comment_replies', 'selection_comments', 'selection_comment_replies', 'favorites', 'doc_versions', 'trash']) {
    ok(new RegExp(`DELETE FROM ${t}\\b`).test(core), `清理语句里有 ${t}`)
  }
  /*
   * 附件这条的判据变了：原来是「按 docId 删」，而那正是会弄坏
   * 「复制出来的那一份」的写法。现在必须**按真实引用**删 ——
   * 共享给别的文档的附件要留下，而且归属要迁走（否则副本下不到）。
   */
  ok(!/DELETE FROM attachments WHERE docId = \?/.test(core),
    '**没有「按 docId 一把梭删附件」**（那会连带删掉复制出来的那一份正在用的）')
  ok(/DELETE FROM attachments WHERE id = \?/.test(core), '附件是逐个判引用之后删的')
  ok(/docsReferencing\(/.test(core) && /UPDATE attachments SET docId/.test(core),
    '保留共享附件时还会把**归属迁到还活着的引用者**（不迁的话副本会拿到 403，卡片还是死的）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
