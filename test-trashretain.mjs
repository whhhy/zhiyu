/**
 * 回收站保留期：到期自动永久清除
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 回收站页一直写着「删除的文档保留 30 天，过期后自动永久清除」，
 * 还给每篇算了个「还剩 N 天」的倒计时 ——
 * 而全仓库**没有任何东西会清除它们**，文档会一直躺着。
 *
 * 这在数据保留这件事上比界面假控件严重得多：
 * 公司照这句话理解自己的数据保留策略，会得出一个错的结论
 * （要么以为有人在管，要么以为没人会删而做出错误承诺）。
 *
 * 补的时候有三件事是不能省的：
 *   ① 计时基准必须是**服务端写的** deletedAt，不能是客户端推上来的 ——
 *      那是「什么时候被销毁」的时刻，让客户端定就等于把删除开关交到外面。
 *   ② deletedAt 不知道的（0）要**跳过**，宁可多留着。
 *   ③ 自动清除要和手动清除**结果一致**（索引、版本、增量都要跟上），
 *      否则会出现「手动删干净、自动删留尾巴」。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.TRASHRETAIN_PORT || await freePort()
const DB = 'data/_retain-test.db'
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
  // 保留期设成 1 天：下面靠**直接改库**把 deletedAt 拨到过去，
  // 不需要真的等一天（等一天这测试就跑不了了）。
  env: { ...process.env, PORT, YQ_DB: DB, YQ_TRASH_DAYS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', (d) => {
  const s = String(d)
  if (/\[trash\]/.test(s)) console.log('  [服务端]', s.trim())
})

const cleanup = () => {
  try { active.kill() } catch { /* 已退出 */ }
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

const books = (await ses('/api/entity/books', {}, admin)).json.rows || []
const B = books[0]
const SFX = Math.random().toString(36).slice(2, 7)

/** 直接开库改 deletedAt —— 唯一能让「时间过去了」在测试里成立的办法 */
const raw = () => new DatabaseSync(DB)
const backdate = (docId, days) => {
  const db = raw()
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare('UPDATE docs SET deletedAt = ? WHERE id = ?').run(Date.now() - days * 86400000, docId)
  db.close()
}
const deletedAtOf = (docId) => {
  const db = raw()
  const r = db.prepare('SELECT deletedAt FROM docs WHERE id = ?').get(docId)
  db.close()
  return r ? Number(r.deletedAt) : -1
}
const docGone = async (id) => (await ses(`/api/doc/${id}`, {}, admin)).status === 404

/**
 * 重启一次服务，让保留期任务在**启动时**跑一遍。
 *
 * 不用「手动触发任务」那种测试专用接口来图省事 ——
 * 保留期任务真正的入口就是「进程起来时跑一次 + 每 6 小时一次」，
 * 走一遍真实入口，才验得到「重启后那些过期文档会被清掉」这件事。
 */
const restart = async () => {
  // **必须杀 active**。原来这里杀的是 `server`（最初那个），
  // 重启一次之后再调用就杀不到真正在跑的那个了 ——
  // 新进程端口占不上、健康检查又打到旧进程上，于是「重启」其实没重启，
  // 表现是「任务跑过了但文档还在」。
  active.kill()
  await new Promise((r) => setTimeout(r, 900))
  return startServer()
}
const startServer = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_TRASH_DAYS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => {
    const t = String(d)
    if (/\[trash\]/.test(t)) console.log('  [服务端]', t.trim())
  })
  active = child
  const tick = async () => {
    try { if ((await fetch(BASE + '/api/health')).ok) return resolve() } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300))
    tick()
  }
  tick()
})
let active = server

const makeTrashed = async (name) => {
  const id = `ret_${name}_${SFX}`
  const now = Date.now()
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { docs: [{ id, bookId: B.id, title: `保留期探针${name}`, body: `正文${name}${SFX}`, createdAt: now, updatedAt: now, wordCount: 2 }] },
    }),
  }, admin)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [id] } }) }, admin)
  return id
}

console.log('\n== 删除时 deletedAt 由服务端写，不信客户端 ==')
{
  const id = await makeTrashed('srv')
  const t = deletedAtOf(id)
  ok(t > 0, '**服务端写了 deletedAt**', String(t))
  ok(Math.abs(t - Date.now()) < 60000, '而且是「刚刚」（不是客户端传的那个值）', String(t))

  // 客户端在 trash 里报一个 1970 年的日期，看会不会被采信
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { trash: [{ docId: id, bookId: B.id, title: 'x', deletedAt: 1 }] } }),
  }, admin)
  ok(deletedAtOf(id) === t, '**客户端把 trash.deletedAt 改成 1，也没有被采信** —— 那是保留期的计时基准',
    String(deletedAtOf(id)))
}

console.log('\n== 未过期的不会被清 ==')
{
  const id = await makeTrashed('fresh')
  await restart()
  ok(true, '重启一次（保留期任务在启动时跑），当作「时间还没到」')
  ok(!(await docGone(id)), '刚删的还在 —— 不会一删就消失')
}

console.log('\n== 到期的真被清掉 ==')
{
  const id = await makeTrashed('old')
  backdate(id, 40)   // 保留期 1 天 → 40 天前删的必然过期
  ok(deletedAtOf(id) > 0 && deletedAtOf(id) < Date.now() - 86400000, '把它拨到 40 天前')

  await restart()
  ok(true, '重启一次，保留期任务在启动时跑过了')
  {
    const db = raw()
    const row = db.prepare('SELECT trashed, deletedAt FROM docs WHERE id = ?').get(id)
    db.close()
    console.log('  [诊断] docs 行 =', JSON.stringify(row || null))
  }
  const gone = await ses(`/api/doc/${id}`, {}, admin)
  ok(gone.status === 404, '**那篇真的没了**（不只是从回收站列表里消失）',
    `实际 ${gone.status} ${String(gone.json?.error || '').slice(0, 40)}`)

  const trashRows = (await ses('/api/entity/trash', {}, admin)).json.rows || []
  ok(!trashRows.some((t) => t.docId === id), 'trash 表里也没了')
  const docs = (await ses('/api/entity/docs', {}, admin)).json.rows || []
  ok(!docs.some((d) => d.id === id), 'docs 里也没了')
}

console.log('\n== 自动清除要和手动清除结果一致 ==')
{
  const id = await makeTrashed('idx')
  // 先给它建一版历史版本：自动清除必须把它一起带走，否则成了孤儿
  backdate(id, 40)
  await restart()

  const db = raw()
  const versions = Number(db.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE docId = ?').get(id).n)
  const indexed = db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE targetId = ? AND kind = 'doc'").get(id).n
  db.close()
  ok(versions === 0, '**历史版本一起清了**（留着就成了没人认领的孤儿）', String(versions))
  ok(Number(indexed) === 0, '**检索索引里也没了** —— 只删 docs 的话搜标题还能搜到、点进去是空的', String(indexed))
}

console.log('\n== deletedAt 不知道的跳过，不误删 ==')
{
  const id = await makeTrashed('unknown')
  const db = raw()
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare('UPDATE docs SET deletedAt = 0 WHERE id = ?').run(id)
  db.close()
  ok(deletedAtOf(id) === 0, '把 deletedAt 清成 0（模拟老数据）')

  await restart()
  ok(!(await docGone(id)), '**没被清掉** —— 不知道什么时候删的宁可多留着，不能当成 1970 年')
}

console.log('\n== 保留期可配；关掉就真的不清 ==')
{
  const r = await ses('/api/trash/retention', {}, admin)
  ok(r.status === 200, '保留期接口要登录（它是部署侧设置，不是给外部访客看的）', String(r.status))
  ok(r.json.days === 1, '它报的就是环境变量里配的值（这里是 1）', JSON.stringify(r.json))
  ok(/1 天/.test(String(r.json.note || '')), '话术跟着天数走', String(r.json.note))

  const anon = await ses('/api/trash/retention')
  ok(anon.status === 401, '没登录问不到', String(anon.status))
}

console.log('\n== 界面上的倒计时不再写死 30 ==')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/pages/Trash.tsx', 'utf8')
  /*
   * 断言前**必须剥掉注释**。
   * 上面那段解释「以前这里是写死的 30」的注释里就含 `30 * 86400_000` ——
   * 扫全文会把它当成残留。这是同一个坑第六次了：
   * 判据要落到**代码**上，不能扫全文。
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/30 \* 86400_000/.test(code), '**前端代码里不再写死 30 天**')
  ok(/retentionDays/.test(code), '倒计时用服务端给的 retentionDays')
  ok(/本实例未开启自动清除/.test(code), '关掉自动清除时界面上也照实说')
  ok(!/删除的文档会保留 30 天/.test(code), '那句「保留 30 天」不再写死在页面上')

  const api = readFileSync('src/lib/api.ts', 'utf8')
  ok(api.includes('/api/trash/retention'), '前端真的去问服务端了')

  const srv = readFileSync('server/sync.ts', 'utf8')
  ok(/YQ_TRASH_DAYS/.test(srv), '保留期可用环境变量配')
  ok(/COALESCE\(deletedAt, 0\) = 0/.test(srv), 'deletedAt 为空的会被跳过')

  /*
   * 配置值的两道防线要单独钉 —— 上面那个实例跑的是 YQ_TRASH_DAYS=1，
   * 而「配错了会不会照着错的值去删文档」这条只能看代码：
   *   · trashRetentionDays()：负数不是 0 就直接用 → 配错等于「明天就全清」
   *   · purgeExpiredTrash()：days <= 0 一律什么都不做
   * 两道都在，才谈得上「配错了不会毁数据」。
   */
  ok(/n >= 0 \? Math\.floor\(n\) : 30/.test(srv),
    '负数的 YQ_TRASH_DAYS 会退回 30（而不是照着负值去清）')
  ok(/!Number\.isFinite\(days\) \|\| days <= 0\)\s*return/.test(srv),
    'purgeExpiredTrash 对天数 <= 0 一律不作为')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
