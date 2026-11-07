/**
 * 附件的归属与下载权限
 *
 * ============================================================
 * 这个套件钉的是一个真实的外泄路径
 * ------------------------------------------------------------
 * 两端的判断原来都写成：
 *     上传：if (docId && !capsOfDoc(u, docId).edit) …
 *     下载：if (row.docId && !capsOfDoc(u, row.docId).read) …
 *
 * 也就是「**没有 docId 就不判权限**」。于是：
 *   · 任何登录用户都能传一个不挂文档的附件；
 *   · 任何登录用户都能下载它 —— 哪怕他对相关文档毫无权限。
 *
 * 而这类附件**永远不会被回收**：清理是按 docId 做的（purgeDocCore），
 * 没有 docId 就谁也带不走它。对一个内网知识库来说，
 * 这是「上传 + 任何人可下」两步凑成的一条完整链路。
 *
 * 客户端一直是带 docId 的，所以这个洞只能用构造的 API 调用踩到 ——
 * 而这恰恰说明它属于「不会被正常使用路径触发」的那类问题。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.ATTACHAUTH_PORT || await freePort()
const DB = 'data/_attachaith-test.db'
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

// 端口守卫：打死过一轮之后残留的进程会让后面每次都跑在旧代码上（全绿、但什么都没验）
{
  const busy = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
  if (busy) {
    console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧进程上，结果不可信。`)
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

const login = async (account, password = 'yuque@2026') =>
  (await ses('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) })).json.token || ''
const admin = await login('admin')
ok(!!admin, '管理员登录成功')

const B = (await ses('/api/entity/books', {}, admin)).json.rows[0]
const SFX = Math.random().toString(36).slice(2, 7)

/** 注册一个对任何知识库都没有权限的人 */
const acc = 'att_' + SFX
const reg = await ses('/api/auth/register', {
  method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '无权限者' }),
})
const outsider = reg.json.token || await login(acc, 'probe@2026')
ok(!!outsider, '注册一个什么权限都没有的人')

const SECRET = Buffer.from('机密内容-不应被外人拿到').toString('utf8')

const upload = (docId, token, body = SECRET) =>
  fetch(`${BASE}/api/attachment${docId ? `?docId=${encodeURIComponent(docId)}` : ''}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'x-filename': 'secret.txt',
    },
    body,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

console.log('\n== 不带 docId 的上传：必须拒 ==')
{
  const r = await upload('', admin)
  ok(r.status === 400, '**拒绝上传不挂文档的附件**（没有归属就没法判断谁有权看）', `${r.status} ${String(r.json.error).slice(0, 50)}`)
  ok(/归属文档/.test(String(r.json.error || '')), '错误信息说清了原因', String(r.json.error))
}

console.log('\n== docId 不存在：拒 ==')
{
  const r = await upload('doc_压根不存在_' + SFX, admin)
  ok(r.status === 404, '文档不存在 → 404（不是把附件塞进虚空）', String(r.status))
}

console.log('\n== 有 docId 时按文档权限判 ==')
{
  const docId = `att_doc_${SFX}`
  const now = Date.now()
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: docId, bookId: B.id, title: '附件权限探针', body: 'x', createdAt: now, updatedAt: now, wordCount: 1 }] } }),
  }, admin)

  const bad = await upload(docId, outsider)
  ok(bad.status === 403, '**没有编辑权的人传不上去**', String(bad.status))

  const good = await upload(docId, admin)
  ok(good.status === 200 && !!good.json.id, '有编辑权的人能传', String(good.status))
  const id = good.json.id

  const dl = await fetch(`${BASE}/api/attachment/${id}`, { headers: { Authorization: 'Bearer ' + outsider } })
  ok(dl.status === 403, '**外人下载不了这篇文档的附件**', String(dl.status))

  const own = await fetch(`${BASE}/api/attachment/${id}`, { headers: { Authorization: 'Bearer ' + admin } })
  const txt = await own.text().catch(() => '')
  ok(own.status === 200 && txt.includes('机密内容'), '有权限的人下得到，而且内容对', `${own.status} ${txt.slice(0, 30)}`)
}

console.log('\n== 历史数据里的无主附件：不能变成「谁都能下」的后门 ==')
{
  /*
   * 直接往库里塞一条无主附件 —— 模拟「升级前就已经存在」的那种数据。
   * 上传端现在不许再产生这种行，但库里可能已经有了。
   */
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  d.prepare('INSERT INTO attachments (id,docId,blockId,filename,mime,size,data,createdAt) VALUES (?,?,?,?,?,?,?,?)')
    .run('legacy_orphan_' + SFX, null, null, 'old.txt', 'text/plain', SECRET.length, Buffer.from(SECRET), Date.now())
  d.close()

  for (const [label, tok] of [['管理员', admin], ['无权限者', outsider]]) {
    const r = await fetch(`${BASE}/api/attachment/legacy_orphan_${SFX}`, { headers: { Authorization: 'Bearer ' + tok } })
    ok(r.status === 403, `${label}也下不到无主附件（宁可打不开，也不默认放行）`, String(r.status))
    const body = await r.json().catch(() => ({}))
    /*
     * 光验 403 是不够的：把显式拒绝删掉之后，
     * `capsOfDoc(u, null)` 判不出权限**也会**返回 403 ——
     * 拒绝还在，只是走了另一条路。所以这里断言**理由**。
     *
     * 这也是对管理员有用的差别：「没有关联文档，无法判断谁有权查看它」
     * 告诉他这是数据问题，而笼统的「没有权限」只会让人以为是自己账号的事。
     */
    ok(/没有关联文档/.test(String(body.error || '')),
      `${label}看到的理由是「数据缺归属」而不是笼统的「没有权限」`,
      String(body.error))
  }
  ok(true, '（这是「宁可不提供，也不要一个后门」：打不开只影响个别文件，放行则影响全部）')
}

console.log('\n== 无主附件也永远不会被回收 ==')
{
  const d = new DatabaseSync(DB)
  const n = Number(d.prepare("SELECT COUNT(*) AS n FROM attachments WHERE docId IS NULL OR docId = ''").get().n)
  d.close()
  ok(n === 1, `库里的无主附件仍是 ${n} 条 —— 它们不会被 purgeDocCore 带走，所以**上传端必须挡住**`)
  const src = (await import('node:fs')).readFileSync('server/index.ts', 'utf8')
  /*
   * 判据前**必须剥掉注释** —— 上面那两段解释 bug 的注释里，
   * 原样写着 `if (docId && !capsOfDoc(...))` 和 `if (row.docId && ...)`。
   * 扫全文会把自己的说明当成残留。**这是同一个坑第七次了。**
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/docId\s*&&\s*!capsOfDoc/.test(code), '服务端没有「docId 为空就不判权限」那个写法了')
  ok(!/row\.docId\s*&&\s*!capsOfDoc/.test(code), '下载端也没有了')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
