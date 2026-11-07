/**
 * 模板：写路径只认 bookId，和读路径（`visible`）不是一套判据
 * ============================================================
 * `templates` 的读路径 `visible`（`server/entities.ts`）认**四种**来源：
 *
 *   ① `scope === 'official'` 官方模板 —— 不属于任何知识库，但人人可见
 *   ② `scope === 'mine'`     个人模板 —— `ownerId` 是本人
 *   ③ `r.bookId` 有值        库模板   —— 按知识库成员判
 *   ④ `r.spaceId` 有值      空间模板 —— 按空间成员判
 *
 * 而写路径 `denyReason` 原来只认一种：`bookOf: (r) => S(r.bookId)`。
 *
 * 后果实测（普通注册用户，不是平台 owner）：
 *   建一个自己的模板（`scope: 'mine'`、`bookId` 为空）
 *   → **「无法确定所属知识库」**，一件都建不出来。
 *   而他**读**模板是好的 —— 能读到 8 个（owner 读到 11 个）。
 *
 * 于是状态是「**看得见、建不了**」：模板中心列得出那 8 个，
 * 点「新建」就被服务端拒掉，而界面上没有任何地方说明为什么。
 *
 * ------------------------------------------------------------
 * 这是同一个病根的**第四次**
 * ------------------------------------------------------------
 *   ① ② `notes` / `topics` / `topicReplies`
 *        拿 bookId 去查一个**空间**（`bookOf` 返回 spaceId）
 *   ③   `books`
 *        拿 bookId 去查一个**还不存在的库**（`bookOf` 返回自己的 id）
 *   ④   `templates`（本轮）
 *        拿 bookId 去判一个**根本不属于任何知识库**的东西
 *
 * 判据统一还是那一句：**这一行不属于任何知识库时，不按 bookId 判。**
 *
 * ------------------------------------------------------------
 * 为什么 ownerId 要由服务端写死
 * ------------------------------------------------------------
 * `scope: 'mine'` 的新建**不看推上来的 ownerId**。
 * 不强制的话 B 能建出一个 `ownerId = A` 的个人模板：
 * 那份东西出现在 **A** 的模板列表里，而 B 自己按 ownerId 判反而改不了它 ——
 * 两头都别扭，而且「谁能改自己的模板」这条判据也就没有意义了。
 *
 * 所以：`upsertRow` 里 `extra.ownerId = user.id` 强制赋值，
 * `denyReason` 的 templates 分支**只按 `existing.ownerId` 判**（修改时）。
 *
 * ⚠️ 注意它不能靠 `def.personal` 顺带覆盖 —— `templates` 是张普通表
 * （官方模板不属于任何人），标成 personal 会把「官方模板人人可读」一起弄坏。
 *
 * ------------------------------------------------------------
 * 两次破坏对照都验过
 * ------------------------------------------------------------
 * ① `mine` 的 ownerId 判据加 `|| true`（等于放行所有人改别人的模板）
 *    → 26 通过 / **3 失败**，红的正是「B 改不了 A 的模板」。
 *
 * ② 去掉 `extra.ownerId = user.id`（不强制写死）
 *    → 24 通过 / **5 失败**。这一条比预期严重得多：
 *    不只是「B 能把模板塞进 A 的列表」这个越权面，
 *    **连正常流程都坏了** —— 因为客户端本来就不传 `ownerId`
 *    （真语雀的模板是自己建给自己用的，字段由服务端补），
 *    不强制就落库成 NULL，于是**连 A 自己都改不了自己建的模板**。
 *    也就是说这行不是「防越权的补丁」，是**正常流程的前提**。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.TEMPLATEWRITE_PORT || await freePort()
const DB = 'data/_tplwrite-test.db'
const BASE = `http://localhost:${PORT}`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧代码上，结果不可信。`)
  process.exit(1)
}

const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'tpl@2026' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
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
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
}
if (!up) { console.error('服务没能在 20 秒内起来'); stop(); process.exit(1) }

const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, o)
  const t = await r.text()
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }
const push = (tk, upsert) => ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert, remove: {} }) }, tk).then((r) => r.d)

const SFX = Math.random().toString(36).slice(2, 7)
const mkUser = async (tag) => {
  const acct = tag + SFX
  await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: tag }) })
  const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d.token
  return { id: (await ses('/api/v2/user', {}, tok)).d.id, tok }
}
const tplRow = (id, over = {}) => ({
  id, name: '模板', desc: '', scope: 'mine', bookId: null, spaceId: null,
  icon: '📄', body: '正文', category: 'other', createdAt: Date.now(), usedCount: 0, ...over,
})

const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'tpl@2026' }) })).d?.token
const A = await mkUser('tpa_')
const B = await mkUser('tpb_')

/* ============ 基准 ============ */
console.log('\n== 基准 ==')
ok(!!admin && !!A.id && !!B.id, `三个身份都拿到了：${A.id} / ${B.id}`)
{
  const adminTpl = (await ses('/api/entity/templates', {}, admin)).d.rows
  const aTpl = (await ses('/api/entity/templates', {}, A.tok)).d.rows
  ok(adminTpl.length > 0, `owner 读到 ${adminTpl.length} 个模板`)
  ok(aTpl.length > 0, `普通用户读到 ${aTpl.length} 个模板（读是好的）`)
}

/* ============ 核心：普通用户能建自己的模板 ============ */
console.log('\n== 核心：普通用户建自己的模板 ==')
const tid1 = 't_' + SFX + '1'
{
  const p = await push(A.tok, { templates: [tplRow(tid1)] })
  ok((p?.rejected?.length || 0) === 0, '建自己的模板（bookId 为空）无拒绝', JSON.stringify(p?.rejected))
  ok(!!one('SELECT 1 AS x FROM templates WHERE id = ?', tid1), 'templates 表真落库了')
}

/* ============ ownerId 必须被服务端写死 ============ */
console.log('\n== ownerId 由服务端写死，不看推上来什么 ==')
const tid2 = 't_' + SFX + '2'
{
  // B 推一个 ownerId = A 的个人模板
  const p = await push(B.tok, { templates: [tplRow(tid2, { ownerId: A.id, name: 'B 伪装成 A 的模板' })] })
  ok((p?.rejected?.length || 0) === 0, 'B 推 ownerId=A 的模板，push 本身不报错（所以必须查库）', JSON.stringify(p?.rejected))
  const row = one('SELECT ownerId FROM templates WHERE id = ?', tid2)
  ok(row?.ownerId === B.id, `库里记的是 B 自己，不是 A（实际 ${row?.ownerId}）`)
  // 而且它不能出现在 A 的列表里
  const aSees = (await ses('/api/entity/templates', {}, A.tok)).d.rows.find((t) => t.id === tid2)
  ok(!aSees, '它没出现在 A 的模板列表里')
  const bSees = (await ses('/api/entity/templates', {}, B.tok)).d.rows.find((t) => t.id === tid2)
  ok(!!bSees, '而它出现在 B 自己的列表里')
}

/* ============ 只能改自己的 ============ */
console.log('\n== 只能改自己建的模板 ==')
{
  const p1 = await push(B.tok, { templates: [tplRow(tid1, { name: 'B 想改 A 的模板' })] })
  ok((p1?.rejected?.length || 0) === 1, 'B 改不了 A 的模板', JSON.stringify(p1?.rejected))
  ok(String(p1?.rejected?.[0]?.reason || '').includes('自己'),
    '拒绝理由说清是「自己的模板」，不是一句「没权限」', p1?.rejected?.[0]?.reason)
  ok(one('SELECT name FROM templates WHERE id = ?', tid1)?.name === '模板', '名字没被改掉')

  const p2 = await push(A.tok, { templates: [tplRow(tid1, { name: 'A 自己改的' })] })
  ok((p2?.rejected?.length || 0) === 0, 'A 改自己的没问题', JSON.stringify(p2?.rejected))
  ok(one('SELECT name FROM templates WHERE id = ?', tid1)?.name === 'A 自己改的', '真改上了')
}

/* ============ 官方模板：普通用户改不了 ============ */
console.log('\n== 官方模板 ==')
{
  const official = (await ses('/api/entity/templates', {}, admin)).d.rows.find((t) => t.scope === 'official')
  ok(!!official, `owner 能看到官方模板（${official?.name}）`)
  if (official) {
    const p = await push(A.tok, { templates: [{ ...official, name: '普通用户改的官方模板' }] })
    ok((p?.rejected?.length || 0) === 1, '普通用户改不了官方模板', JSON.stringify(p?.rejected))
    ok(one('SELECT name FROM templates WHERE id = ?', official.id)?.name === official.name, '官方模板没被改掉')
  }
}

/* ============ 库模板：按库判 ============ */
console.log('\n== 库模板：按知识库判 ==')
{
  const books = (await ses('/api/entity/books', {}, admin)).d.rows
  const bk = books[0]
  ok(!!bk, `拿一个知识库当目标：${bk?.name}`)
  // A 不是这个库的成员 → 建库模板应该被拒
  const tid3 = 't_' + SFX + '3'
  const p1 = await push(A.tok, { templates: [tplRow(tid3, { scope: 'book', bookId: bk.id })] })
  ok((p1?.rejected?.length || 0) === 1, '非成员建不了这个库的模板', JSON.stringify(p1?.rejected))
  ok(!one('SELECT 1 AS x FROM templates WHERE id = ?', tid3), '没落库')

  // 平台 owner 建得出来（owner 早退放行）
  const tid4 = 't_' + SFX + '4'
  const p2 = await push(admin, { templates: [tplRow(tid4, { scope: 'book', bookId: bk.id })] })
  ok((p2?.rejected?.length || 0) === 0, '平台 owner 建得了', JSON.stringify(p2?.rejected))
  ok(!!one('SELECT 1 AS x FROM templates WHERE id = ?', tid4), '真落库了')
}

/* ============ 四种来源都在，别只修了一种 ============ */
console.log('\n== 四种来源都判了（别只修 scope=mine 那一种）==')
{
  const src = readFileSync('server/sync.ts', 'utf8')
  const seg = /if \(def\.name === 'templates'\) \{[\s\S]{0,1400}?\n  \}/.exec(src)?.[0] || ''
  ok(seg.length > 0, 'denyReason 里有 templates 分支')
  ok(/official/.test(seg), '判了 official')
  ok(/mine/.test(seg), '判了 mine')
  ok(/row\.bookId/.test(seg), '判了 bookId')
  ok(/row\.spaceId/.test(seg), '判了 spaceId')
  // 关键：mine 的**新建**不能看 incoming.ownerId
  ok(!/scope === 'mine'[\s\S]{0,120}?incoming\.ownerId/.test(seg),
    'mine 的新建不读推上来的 ownerId（否则等于没防）')
  // 强制赋值在 upsertRow 里，不在 denyReason 里
  ok(/def\.name === 'templates'[\s\S]{0,200}?extra\.ownerId = user\.id/.test(src),
    'ownerId 由 upsertRow 强制写成本人')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
