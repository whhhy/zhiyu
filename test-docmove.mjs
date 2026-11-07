/**
 * 文档的「移动到 / 复制到另一个知识库」
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 这个动作看着只是改一个 \`bookId\`，但实际有一串东西跟着变，
 * 而每一处漏掉的表现都是「界面上看着没问题，搜出来是空的」。
 * 这里逐条钉住：
 *
 *  · **两个库的检索索引都要重算。** 文档级索引里那行 bookId 变了，
 *    但**书级索引**存的是「这个库下面所有文稿的标题」——
 *    只重算 doc 的话，旧库里会留着这篇的标题（搜得到、点进去是空的），
 *    新库里则压根搜不到。
 *  · **目录节点要跟着换库。** nodes.bookId 才是目录树认的东西；
 *    只改 docs.bookId，这篇会从旧库的树上消失却不出现在新库的树上。
 *  · **权限两边都要判**：源库 edit（不然等于把别人文档搬走）、
 *    目标库 create（不然等于往别人库里塞东西）。
 *  · **复制必须换新 id** —— 同 id 会静默变成目标库里那另一篇。
 *  · **副本不带 slug** —— 同一个路径在两个库里会互相绊住。
 *  · 副本的**作者是操作的人**，不是原作者。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.DOCMOVE_PORT || await freePort()
const DB = 'data/_docmove-test.db'
const BASE = `http://localhost:${PORT}`

async function call(path, opts = {}, token = '') {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const ses = (p, o = {}, t = '') => call(p, o, t)

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
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

const login = async (account, password = 'yuque@2026') =>
  (await ses('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) })).json.token || ''
const admin = await login('admin')
ok(!!admin, '管理员登录成功')

const books = (await ses('/api/entity/books', {}, admin)).json.rows || []
const spaces = (await ses('/api/entity/spaces', {}, admin)).json.rows || []
const SFX = Math.random().toString(36).slice(2, 7)

// 找两个**同一个空间**的库
const A = books[0]
const B = books.find((b) => b.id !== A.id && b.spaceId === A.spaceId)
ok(!!B, `找到同空间的第二个库：${B?.name}（移动只在同空间内做）`)

const mkDoc = async (name, bookId, extra = {}) => {
  const id = `mv_${name}_${SFX}`
  const now = Date.now()
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        // 标题里带上 SFX —— 否则多篇探针同名，搜索命中的是哪一篇根本分不清，
        // 而书级索引存的就是「这些标题」，标题不唯一就没法验「重算过没有」
        docs: [{ id, bookId, title: `移动探针${name}${SFX}`, body: `# 移动探针${name}\n\n独特标记 ZZ${SFX}${name}。`, createdAt: now, updatedAt: now, wordCount: 5, ...extra }],
        nodes: [{ id: 'n_' + id, bookId, title: `移动探针${name}${SFX}`, type: 'doc', docId: id, ord: 99 }],
      },
    }),
  }, admin)
  return id
}

const docOf = async (id) => (await ses(`/api/doc/${id}`, {}, admin)).json.doc
const nodesOf = async (bookId) => (await ses(`/api/entity/nodes', `, {}, admin), {})
const searchIds = async (q) => ((await ses('/api/search?q=' + encodeURIComponent(q), {}, admin)).json.results || []).map((r) => r.id)
const nodeBookOf = async (docId) => {
  const rows = (await ses('/api/entity/nodes', {}, admin)).json.rows || []
  return String(rows.find((n) => n.docId === docId)?.bookId || '')
}

console.log('\n== 移动：文档与目录节点都换库 ==')
{
  const id = await mkDoc('A', A.id)
  ok(String((await docOf(id))?.bookId) === A.id, '它一开始在 A 库')

  const r = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: B.id, mode: 'move' }) }, admin)
  ok(r.status === 200, '移动成功', `${r.status} ${String(r.json.error).slice(0, 60)}`)
  ok(String((await docOf(id))?.bookId) === B.id, '**docs.bookId 变成 B 了**')
  ok(await nodeBookOf(id) === B.id, '**目录节点也换到 B 了** —— 只改 docs 的话，这篇会从树上消失', await nodeBookOf(id))
  ok(String(r.json.docId) === id, 'id 没变（移动不是重建）')
}

console.log('\n== 两个库的检索索引都要重算 ==')
{
  // 上一节那篇现在在 B 库里，标题里带探针 A
  const hitsInB = await searchIds(`移动探针A${SFX}`)
  ok(hitsInB.length > 0, '在 B 库里搜得到它')

  // 再搬回去，然后搜 A 库 —— 搬回去之后 A 库的索引里就不该再有它
  const id = `mv_A_${SFX}`
  await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: A.id, mode: 'move' }) }, admin)
  const hitsInA = await searchIds(`移动探针A${SFX}`)
  ok(hitsInA.includes(id), '搬回 A 库后搜得到', JSON.stringify(hitsInA))

  /*
   * 查书级索引要**搜这篇的标题**，而不是搜库名。
   * `searchAll` 的返回**没有 text 字段**（只有 excerpt）——
   * 早先查 `bookHit.text` 恒为 undefined，那几条断言是「恒假」而不是「真失败」。
   *
   * 而且书级索引的正文就是「这个库下所有文稿的标题」，
   * 所以搜这篇的标题时，owning book 也应该命中 —— 这正是要验的东西。
   */
  const hitsA = (await ses('/api/search?q=' + encodeURIComponent(`移动探针A${SFX}`), {}, admin)).json.results || []
  ok(hitsA.some((r) => r.kind === 'doc' && r.id === id), '搜得到这篇文档本身')
  ok(hitsA.some((r) => r.kind === 'book' && r.id === A.id),
    '**A 库也命中了** —— 书级索引存的就是「这个库下面所有文稿的标题」',
    JSON.stringify(hitsA.map((x) => x.kind + ':' + x.id)).slice(0, 140))
}

console.log('\n== 只重算 doc 索引会漏掉什么（说明为什么必须重算 book）==')
{
  /*
   * 这条不是断言「某个 bug 存在」，而是把**为什么两个索引都要算**写死：
   * 书级索引的正文 = 该库下所有文稿的标题。所以搬走之后，
   * 旧库的书级索引里必须**不再有**这篇的标题。
   *
   * 下面直接验：把一篇从 A 搬到 B 之后，A 库的书级命中里不该再出现它的标题。
   */
  const id = await mkDoc('Idx', A.id)
  const before = (await ses('/api/search?q=' + encodeURIComponent(`移动探针Idx${SFX}`), {}, admin)).json.results || []
  ok(before.some((r) => r.kind === 'book' && r.id === A.id),
    '搬走之前，搜它的标题会命中 A 库（书级索引里有这条标题）',
    JSON.stringify(before.map((x) => x.kind + ':' + x.id)).slice(0, 140))

  await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: B.id, mode: 'move' }) }, admin)

  const after = (await ses('/api/search?q=' + encodeURIComponent(`移动探针Idx${SFX}`), {}, admin)).json.results || []
  ok(!after.some((r) => r.kind === 'book' && r.id === A.id),
    '**搬走之后旧库不再命中**（只重算 doc 索引的话，这行书级索引会永远留着它）',
    JSON.stringify(after.map((x) => x.kind + ':' + x.id)).slice(0, 140))
  ok(after.some((r) => r.kind === 'book' && r.id === B.id), '新库命中（它的书级索引被重算过了）')
}

console.log('\n== 复制：新 id、署操作人的人、不带原路径 ==')
{
  const id = await mkDoc('C', A.id, { slug: 'copy-probe-' + SFX })
  const meId = (await ses('/api/auth/me', {}, admin)).json.user?.id
  const r = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: B.id, mode: 'copy' }) }, admin)
  ok(r.status === 200, '复制成功', String(r.status))
  const nid = String(r.json.docId)
  ok(nid !== id, '**副本是新 id** —— 沿用原 id 会静默变成目标库里那另一篇')
  ok(String((await docOf(id))?.bookId) === A.id, '**原库那篇还在**（复制不是移动）')
  const copy = await docOf(nid)
  ok(String(copy?.bookId) === B.id, '副本在 B 库')
  ok(String(copy?.authorId) === String(meId), '**副本署操作的人**，不是原作者（否则新库里会冒出不存在的人）')
  ok(String(copy?.slug || '') === '', '**副本不带原路径** —— 同一个路径在两个库里会互相绊住', String(copy?.slug))
  ok(await nodeBookOf(nid) === B.id, '副本也有自己的目录节点，且在 B 库')
  ok(String(copy?.title || '').includes('副本'), '标题标了「副本」', String(copy?.title))
}

console.log('\n== 权限：两边都要判 ==')
{
  const id = await mkDoc('P', A.id)
  const acc = 'mvp_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '没权限的人' }),
  })
  const pt = reg.json.token || await login(acc, 'probe@2026')
  ok(!!pt, '注册一个什么权限都没有的人')

  const r = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: B.id, mode: 'move' }) }, pt)
  ok(r.status === 403, '没源库权限的人搬不动 → **403**（权限不足不该报 400，400 听着像「你参数填错了」）', `${r.status} ${String(r.json.error).slice(0, 50)}`)
  ok(String((await docOf(id))?.bookId) === A.id, '**没被搬走**')
  ok(String(r.json.error || '').includes('原知识库'), '错误信息说的是「原知识库」这一侧', String(r.json.error))
}

console.log('\n== 源库能编辑、目标库不能建 ==')
{
  /*
   * 上一节那个用户**什么权限都没有**，所以「原知识库没有编辑权」先一步挡住了，
   * 目标库那一判压根走不到 ——
   * 破坏对照里拆掉「判目标库权限」，套件照样全绿，就是这么来的。
   *
   * 要走到那一判，得造一个「源库能编辑、目标库没身份」的人：
   * 给他在 A 库一个 editor 身份（editor 能力含 edit、但没有 create），
   * B 库则完全不在。
   */
  const acc = 'mved_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '只有源库编辑权' }),
  })
  const uid = reg.json.user?.id
  const et = reg.json.token || await login(acc, 'probe@2026')
  ok(!!et, '注册一个账号')

  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookMembers: [{ bookId: A.id, userId: uid, role: 'editor', perms: {}, joinedAt: Date.now() }] } }),
  }, admin)

  const caps = (await ses(`/api/perms/book/${A.id}`, {}, et)).json.caps
  ok(caps?.edit === true, '他在 A 库**能编辑**', JSON.stringify(caps))
  ok(caps?.create === true, '（editor 的能力表里含 create —— 所以下面那一条要另找人来测）', JSON.stringify(caps))

  const id = await mkDoc('E2', A.id)
  const r = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: B.id, mode: 'move' }) }, et)
  ok(r.status === 403, '但搬不到 B 库（他不是 B 库的成员）→ 403', `${r.status} ${String(r.json.error).slice(0, 50)}`)
  ok(String(r.json.error || '').includes('目标知识库'), '错误信息说的是**目标**那一侧', String(r.json.error))
  ok(String((await docOf(id))?.bookId) === A.id, '**没被搬走**')
}

console.log('\n== 边界 ==')
{
  const id = await mkDoc('E', A.id)
  const same = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: A.id, mode: 'move' }) }, admin)
  ok(same.status === 400, '移到它自己所在的库 → 400', String(same.status))

  const ghost = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ bookId: 'bk_不存在', mode: 'move' }) }, admin)
  ok(ghost.status === 400, '目标库不存在 → 400', String(ghost.status))

  const none = await ses(`/api/doc/${id}/move`, { method: 'POST', body: JSON.stringify({ mode: 'move' }) }, admin)
  ok(none.status === 400, '不给 bookId → 400（不是默默移动到别处）', String(none.status))

  const miss = await ses('/api/doc/压根不存在/move', { method: 'POST', body: JSON.stringify({ bookId: B.id }) }, admin)
  ok(miss.status === 400, '文档不存在 → 400 且说清了', String(miss.status))

  // 回收站里的不能搬
  const tr = await mkDoc('T', A.id)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [tr] } }) }, admin)
  const inTrash = await ses(`/api/doc/${tr}/move`, { method: 'POST', body: JSON.stringify({ bookId: B.id, mode: 'move' }) }, admin)
  ok(inTrash.status === 400, '回收站里的不能搬', String(inTrash.status))
  ok(/回收站/.test(String(inTrash.json.error || '')), '错误信息点名了「回收站」', String(inTrash.json.error))
  void spaces
}

console.log('\n== 前端：菜单与弹窗确实在 ==')
{
  const src = readFileSync('src/pages/DocPage.tsx', 'utf8')
  /*
   * ⚠️ 弹窗本体搬到了 `@/components/doc/MoveDocDialog`（2026-10-10）。
   *    原来它内联在 DocPage 里，这一组断言全盯着 DocPage。
   *    抽组件之后「菜单」还在 DocPage、「弹窗」在新组件里 ——
   *    判据没跟着搬，于是三条一起红，而**功能其实是对的**。
   *
   *    教训和 store 那几处一样：**断言要跟着代码去**，不能留在原地。
   *    所以这里两边都读：菜单查 DocPage，弹窗查共享组件。
   */
  const dlg = readFileSync('src/components/doc/MoveDocDialog.tsx', 'utf8')
  ok(src.includes('移动 / 复制到…'), '文档「...」菜单里有这一项')
  ok(/import MoveDocDialog from/.test(src) && /<MoveDocDialog/.test(src),
    'DocPage 用的是共享弹窗组件（不是自己内联一份）')
  ok(dlg.includes('moveDoc(docId, target, mode)'), '弹窗真的调服务端')
  ok(/targets = useMemo/.test(dlg), '目标知识库是算出来的，不是写死一个')
  ok(dlg.includes('限同一个空间内'), '界面上写明了只限同空间')
  ok(/复制/.test(dlg) && /移动后原知识库里这篇会消失/.test(dlg), '移动/复制的后果在界面上说清楚了')

  /*
   * 禁用条件必须是「**没有**编辑权 或 没有目标库」。
   * 这里原来是 \`!noEditRight\` —— 而 noEditRight 的意思是「没有编辑权」，
   * 取反之后变成「**有**编辑权时禁用」，于是菜单项永远是灰的。
   * 成因是一次批量改名（canEditDoc → noEditRight）只换了标识符、没换前面的 \`!\`。
   *
   * 这条断言语义而不是拼写：写错了就红，而不是等下一次浏览器实跑才发现。
   */
  ok(/disabled=\{noEditRight \|\| !moveTargets\.length\}/.test(src),
    '禁用条件是「没有编辑权 或 没有目标库」（不是反过来）',
    (src.match(/disabled=\{[^}]*moveTargets[^}]*\}/) || ['(没找到)'])[0])

  const api = readFileSync('src/lib/api.ts', 'utf8')
  ok(api.includes("'/api/doc/${encodeURIComponent(docId)}/move'") || api.includes('/move'), 'api 客户端指向那个接口')
  ok(/mode: 'move' \| 'copy'/.test(api), '两种模式都在类型里')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
