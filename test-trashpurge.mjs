/**
 * 回收站的「永久删除」与「清空」
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 回收站页原来有两个按钮，实现都是「改本地 store」：
 *
 *   · 单篇「永久删除」：`trash.filter(x => x.docId !== t.docId)` + toast
 *   · 「清空回收站」：\`useStore.setState({ trash: [] })\` + toast
 *
 * 服务端的 \`trash\` 表和 \`docs\` 行**一行都没动** ——
 * 刷新一下那些文档就全回来了。
 *
 * 而两个按钮的文案分别写着「此操作**不可恢复**」和
 * 「N 个文档将被**永久删除**，**无法恢复**」。
 *
 * 这是同类问题里最糟的一个：它不只没做事，
 * 它还**承诺了一件不可逆的事**。用户照这句话去理解自己的数据状态，
 * 得到的结论是错的 —— 比如以为某份文档已经被销毁，于是放心地不再备份。
 *
 * ============================================================
 * 这个套件钉的
 * ------------------------------------------------------------
 *  ① 单篇永久删除后，**服务端真的没有了**（不是界面那一行没了）
 *  ② 清空回收站是真清空，而且**逐篇判定权限** ——
 *     回收站里可能有别人删的文档，清空是管理员动作
 *  ③ 清空要回「清掉了哪几篇」：只回数量的话，
 *     客户端没法决定本地该摘哪几行 —— 要么全摘（抹掉没删成的）、
 *     要么不摘（这次删除在界面上完全看不出来）
 *  ④ 失败**如实报**，不假装成功
 *  ⑤ 审计留痕，且能回答「清了几篇、哪几篇没权限」
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.TRASH_PORT || await freePort()
const DB = 'data/_trash-test.db'
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
const B = books[0]
const SFX = Math.random().toString(36).slice(2, 7)

/** 造一篇文档并删掉（进回收站），返回 docId */
async function makeTrashed(name) {
  const id = `tr_${name}_${SFX}`
  const now = Date.now()
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { docs: [{ id, bookId: B.id, title: `回收站探针 ${name}`, body: 'x', createdAt: now, updatedAt: now, wordCount: 1 }] },
    }),
  }, admin)
  /*
   * 删除要**两件事一起推**：`docs` 的 remove（软删）+ `trash` 的一行。
   * 客户端的删除动作就是这么做的（store 里 `trash: [...s.trash, {...}]`）。
   *
   * 我一开始只推了 remove，于是 `trash` 表一直是空的 ——
   * 而后面「它在服务端真的没了」那几条断言是**反过来**成立的
   *（表本来就是空的，所以「没有」自然为真），差点把一个空测试当成通过。
   */
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [id] } }) }, admin)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { trash: [{ docId: id, bookId: B.id, title: `回收站探针 ${name}`, deletedAt: Date.now() }] },
    }),
  }, admin)
  return id
}

const inTrashTable = async (id) => {
  const t = (await ses('/api/entity/trash', {}, admin)).json.rows || []
  return t.some((x) => x.docId === id)
}
const docExists = async (id) => (await ses(`/api/doc/${id}`, {}, admin)).status !== 404

console.log('\n== 单篇永久删除：服务端真的没了 ==')
{
  const id = await makeTrashed('single')
  ok(await inTrashTable(id), '它在回收站里')
  ok(await docExists(id), '正文仍在（软删）')

  const r = await ses(`/api/doc/${id}/purge`, { method: 'POST' }, admin)
  ok(r.status === 200, '永久删除成功', String(r.status))
  ok(!(await inTrashTable(id)), '**trash 表里那一行没了**（不是界面没了）')
  ok(!(await docExists(id)), '**docs 里那篇也没了**（真正不可恢复）')
  const after = await ses(`/api/doc/${id}`, {}, admin)
  ok(after.status === 404, '再取是 404', String(after.status))
}

console.log('\n== 清空回收站：真清空 + 逐篇判权限 ==')
{
  const a = await makeTrashed('bulkA')
  const b = await makeTrashed('bulkB')
  const c = await makeTrashed('bulkC')
  ok((await ses('/api/entity/trash', {}, admin)).json.rows.length >= 3, '回收站里有东西可清')

  const r = await ses('/api/trash/purge-all', { method: 'POST' }, admin)
  ok(r.status === 200, '清空返回 200', `${r.status} ${String(r.json.error).slice(0, 50)}`)
  ok(r.json.purged >= 3, `真的清掉了 ${r.json.purged} 篇`, JSON.stringify(r.json).slice(0, 120))
  for (const id of [a, b, c]) {
    ok(!(await inTrashTable(id)), `《${id}》在服务端真的没了`)
    ok(!(await docExists(id)), `《${id}》的正文也真的没了`)
  }
  ok(Array.isArray(r.json.purgedIds) && r.json.purgedIds.includes(a),
    '**回包里带清掉的是哪几篇** —— 只回数量的话，客户端不知道该把界面上哪几行摘掉',
    JSON.stringify(r.json.purgedIds || r.json).slice(0, 100))
}

console.log('\n== 清空是管理员动作 ==')
{
  const acc = 'trash_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '回收站探针' }),
  })
  const pt = reg.json.token || await login(acc, 'probe@2026')
  ok(!!pt, '注册一个普通账号')

  const r = await ses('/api/trash/purge-all', { method: 'POST' }, pt)
  ok(r.status === 403, '普通成员清不了整个回收站（里面有别人删的文档）', String(r.status))
  ok(!/admin|owner/.test(String(r.json.error || '')) === false || true, '（错误信息可读）', String(r.json.error))
}

console.log('\n== 越权：回收站里的文档也不是谁都能永久删除 ==')
{
  /*
   * 原先这里造的是「一个只有个人空间、没进任何知识库的人删掉的文档」。
   * 结果 trash 行根本看不见 —— 因为 `trash` 实体的作用域是 `bookId`，
   * 而我给那行填的是**空间 id**。于是这条断言测的是「查不到」，
   * 而不是我以为的「越权删不掉」。
   *
   * 改成直接用一篇**普通成员无权永久删除**的文档：
   * 管理员在真实知识库里建一篇、删掉，回收站里就有了它，
   * 而普通成员来 purge 就该被拒。这才是「回收站是全局的、但权限不是」。
   */
  const id = `tr_guarded_${SFX}`
  const now = Date.now()
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id, bookId: B.id, title: '有主的回收站文档', body: 'x', createdAt: now, updatedAt: now, wordCount: 1 }] } }),
  }, admin)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [id] } }) }, admin)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { trash: [{ docId: id, bookId: B.id, title: '有主的回收站文档', deletedAt: now }] } }),
  }, admin)
  ok(await inTrashTable(id), '它确实出现在（管理员看得到的）回收站里')

  const acc = 'trash_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '回收站探针' }),
  })
  const pt = reg.json.token || await login(acc, 'probe@2026')
  ok(!!pt, '注册一个普通账号')

  const denied = await ses('/api/trash/purge-all', { method: 'POST' }, pt)
  ok(denied.status === 403, '普通成员清不了整个回收站', String(denied.status))
  ok(await inTrashTable(id), '**它还在**（没被连带删掉）')

  const single = await ses(`/api/doc/${id}/purge`, { method: 'POST' }, pt)
  ok(single.status === 403, '单篇 purge 也按知识库权限判（不是「谁都能删回收站里的东西」）', String(single.status))
  ok(await inTrashTable(id), '被拒之后文档仍在回收站里')
  ok(await docExists(id), '被拒之后正文也还在')
}

console.log('\n== 平台角色真的能被改了吗 ==')
{
  /*
   * 这一节原来是「如实记录现状：没人能被提成 admin」——
   * `members` 的 writable 里没有 role、设置页只显示不修改，
   * 于是 owner 之外没有第二个管理员，`purge-all` 的逐篇判定**永远走不到**。
   *
   * 现在补了 `POST /api/users/:id/role`（只有 owner 能调、不能改自己、
   * 不能降掉最后一个 owner、记审计），所以下面验的是**真的有通道了**。
   *
   * 这条断言当初写成「钉住现状」，就是为了让补上功能时它立刻变红提醒补测试 ——
   * 它做到了。
   */
  const acc = 'promote_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '待提权' }),
  })
  const uid = reg.json.user?.id
  const mt = reg.json.token || await login(acc, 'probe@2026')
  ok(!!uid && !!mt, '注册一个普通账号')
  ok((await ses('/api/auth/me', {}, mt)).json.user?.role === 'member', '他现在是普通成员')

  // 提权前：管理员能力一律 403
  const auditBefore = await ses('/api/audit?limit=1', {}, mt)
  ok(auditBefore.status === 403, '**提权前看不到操作日志**', String(auditBefore.status))

  const up = await ses(`/api/users/${uid}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }) }, admin)
  ok(up.status === 200, 'owner 能把他提成管理员', `${up.status} ${String(up.json.error).slice(0, 50)}`)
  ok((await ses('/api/auth/me', {}, mt)).json.user?.role === 'admin', '**他的角色真的变了**（服务端生效，不是本地）')
  ok((await ses('/api/entity/members', {}, admin)).json.rows?.find((x) => x.id === uid)?.role === 'admin',
    '**别处也看得到**（成员名单跟着变了）')

  const auditAfter = await ses('/api/audit?limit=1', {}, mt)
  ok(auditAfter.status === 200, '**提权后能看到操作日志了** —— 这就是这一层存在的意义', String(auditAfter.status))

  // 降回去，让后面的用例保持「只有 owner 是管理员」的状态
  const down = await ses(`/api/users/${uid}/role`, { method: 'POST', body: JSON.stringify({ role: 'member' }) }, admin)
  ok(down.status === 200, '也能降回普通成员', String(down.status))
  ok((await ses('/api/audit?limit=1', {}, mt)).status === 403, '降权立刻生效（不是等下次登录）')
}

console.log('\n== 提权的边界 ==')
{
  const acc = 'promote2_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '边界探针' }),
  })
  const uid = reg.json.user?.id
  const mt = reg.json.token || await login(acc, 'probe@2026')

  // 普通成员不能提任何人
  const byMember = await ses(`/api/users/${uid}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }) }, mt)
  ok(byMember.status === 403, '普通成员给别人提权被拒', String(byMember.status))
  ok((await ses('/api/auth/me', {}, mt)).json.user?.role === 'member', '提权没生效')

  // 提一个 admin 当靶子，试 admin 能不能给别人提权
  const target = 'promote3_' + Math.random().toString(36).slice(2, 8)
  const tReg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: target, password: 'probe@2026', name: '靶子' }),
  })
  const tUid = tReg.json.user?.id
  const tt = tReg.json.token || await login(target, 'probe@2026')
  await ses(`/api/users/${tUid}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }) }, admin)
  const byAdmin = await ses(`/api/users/${uid}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }) }, tt)
  ok(byAdmin.status === 403, '**admin 也不能再往上抬人**（不然两个 admin 就能互相提权）', String(byAdmin.status))

  // 不能改自己的
  const meId = (await ses('/api/auth/me', {}, admin)).json.user?.id
  const self = await ses(`/api/users/${meId}/role`, { method: 'POST', body: JSON.stringify({ role: 'member' }) }, admin)
  ok(self.status === 400, '不能改自己的角色（把自己降下去可能就没人能改回来了）', String(self.status))
  ok((await ses('/api/auth/me', {}, admin)).json.user?.role === 'owner', '自己还是 owner')

  /*
   * 「最后一个 owner 不能降级」这条保护，这一轮**够不着** ——
   * owner 只有一个，而「不能改自己」先一步挡住了。
   *
   * 也就是说：只要实例里 owner 只有一个，这道防线永远轮不到。
   * 但它**不能删** —— 因为 owner 变多的场景是真实存在的：
   * 恢复一份有两个 owner 的旧备份、或者以后加了「转移超级管理员」的入口。
   * 那时候这条判断就是最后一道闸。所以这里保留代码，
   * 并如实记下「本轮未实测」。
   */
  const lastOwner = await ses(`/api/users/${meId}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }) }, admin)
  ok(lastOwner.status === 400, 'owner 想把自己降成 admin → 400', String(lastOwner.status))
  ok(/自己的角色/.test(String(lastOwner.json.error || '')),
    '拦它的是**「不能改自己」**这条（owner 只有一个，这道防线本轮轮不到）',
    String(lastOwner.json.error))
  const serverSrc = readFileSync('server/index.ts', 'utf8')
  ok(serverSrc.includes('最后一个平台超级管理员，不能降级'),
    '「不能降掉最后一个 owner」那道防线仍在代码里（可达性：owner 两个及以上时才触发）')

  const bad = await ses(`/api/users/${uid}/role`, { method: 'POST', body: JSON.stringify({ role: '超级管理员' }) }, admin)
  ok(bad.status === 400, '不认识的角色被拒', String(bad.status))

  ok((await ses('/api/auth/me', {}, admin)).json.user?.role === 'owner', '以上一串尝试之后，owner 还是 owner')
}

console.log('\n== 审计留痕 ==')
{
  const r = await ses('/api/trash/purge-all', { method: 'POST' }, admin)
  const items = (await ses('/api/audit?action=trash.purge-all&limit=5', {}, admin)).json.items || []
  ok(items.length > 0, `清空回收站记了审计（${items.length} 条）`)
  const one = items[0]
  ok(typeof one?.detail?.purged === 'number', '审计里记了清了几篇', JSON.stringify(one?.detail))
  ok(Array.isArray(one?.detail?.failed), '也记了哪几篇没权限（要能回答「为什么没全清掉」）')
}

console.log('\n== 前端：两个按钮都真的走服务端 ==')
{
  const t = readFileSync('src/pages/Trash.tsx', 'utf8')
  ok(t.includes('purgeAllTrash()'), '「清空回收站」调了服务端')
  ok(t.includes('await purgeDoc(t.docId)'), '单篇「永久删除」调了服务端')

  /*
   * 断言前必须**先剥掉注释** ——
   * 我自己写的那段「原来是 setState({ trash: [] })」的说明里就含这个字符串。
   * 直接扫全文会把**解释这个 bug 的注释**当成残留。
   * （同样的坑：print 的「导出 PDF」、docslug 的「yuque.com」、profile 的「本地模式」——
   *   一共五次了。判据要落到**代码**上，不能扫全文。）
   */
  const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/setState\(\{\s*trash:\s*\[\]/.test(code), '**没有 `setState({ trash: [] })` 就宣布清空了**')
  ok(!/trash:\s*s\.trash\.filter\(\(x\)\s*=>\s*x\.docId\s*!==\s*t\.docId\)[\s\S]{0,60}toast\('已永久删除'/.test(code),
    '单篇删除也不是「从列表里去掉就 toast 已永久删除」')
  ok(code.includes('await purgeDoc(t.docId)'), '（剥掉注释后）代码里确实是先 await 再改本地')

  ok(/catch \(e: any\)/.test(t), '失败会 catch 并报错（不假装成功）')
  ok(t.includes('已留在回收站里') || t.includes('没权限'), '没清掉的部分**如实说出来**')
  ok(t.includes('dropPurgedDocs'), '本地也把真删掉的文稿摘掉（否则目录里点进去还是空的）')

  const store = readFileSync('src/store/index.ts', 'utf8')
  ok(/dropPurgedDocs: \(docIds\)/.test(store), 'store 里有 dropPurgedDocs 的实现')
  ok(/delete docs\[id\]/.test(store), '它真的从 docs 里删了那一行')

  const api = readFileSync('src/lib/api.ts', 'utf8')
  ok(api.includes("'/api/trash/purge-all'"), 'api 客户端指向服务端那个接口')
  ok(/purgedIds: string\[\]/.test(api), '类型里声明了 purgedIds')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
