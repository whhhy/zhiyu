/**
 * 文档锁以前能被「冒充持有者」绕过
 * ============================================================
 * 锁存在的意义很具体：A 正在编辑这篇文档时，B 不该能改它 ——
 * 因为 A 保存时收不到任何提示，改了就白改。
 *
 * ------------------------------------------------------------
 * 原来那个判断
 * ------------------------------------------------------------
 * ```ts
 * if (def.name === 'docs' && existing?.lockMemberId && String(existing.lockMemberId) !== user.id) {
 *   if (String(incoming.lockMemberId || '') !== String(existing.lockMemberId)) return '文档已被他人锁定'
 * }
 * ```
 * 第一个条件已经用 `user.id` 判过「你是不是持有者」了。
 * 第二个条件「incoming 的 lockMemberId 得和库里一样」**唯一的作用是给冒充者开门**：
 * `lock.memberId` 客户端读得到（`GET /api/doc/:id` 就返回），所以：
 *
 * ```bash
 * # B 不带 lockMemberId
 * → rejected: 文档已被他人锁定，正文没变        ✅
 * # B 带 lockMemberId = A 的 id
 * → rejected: []，**库里正文真被改了**，锁还显示是 A 的   ❌
 * ```
 *
 * 后一条最恶劣：服务端认为「就是持有者本人在编辑」，
 * 于是 A 保存时收不到冲突提示 —— 而这把锁防的正是这个。
 *
 * ------------------------------------------------------------
 * 删掉第二个条件为什么安全
 * ------------------------------------------------------------
 * 因为第一个条件里 `String(existing.lockMemberId) !== user.id` 已经够了：
 * 持有者自己**压根进不来这个分支**，怎么推都能改。
 * 换句话说第二个条件没有任何合法用途。
 * 这个方向必须单独验 —— 见下面「持有者自己照常能改」那一节，
 * 堵漏洞的改动最常见的后果是把正门也堵上了。
 * ============================================================
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.LOCK_PORT || await freePort()
const DB = 'data/_lock-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB }, stdio: ['ignore', 'pipe', 'pipe'],
})
srv.stdout.on('data', () => {})
srv.stderr.on('data', () => {})
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
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); stop(); process.exit(1) }

const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const ses = (p, o = {}, t) => call(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + t } })
const pushDocs = (docs, t) => ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs } }) }, t)

const row = (id) => {
  const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000')
  const r = d.prepare('SELECT id, title, lockMemberId, blocks FROM docs WHERE id = ?').get(id)
  d.close()
  return r
}
const blocksOf = (r) => { try { return JSON.parse(String(r?.blocks || '[]')) } catch { return [] } }
const textOf = (r) => blocksOf(r).map((b) => b.text || '').join('|')

/* ---------------------------------------------------------------- */
console.log('\n== 搭前置：admin 锁一篇，冒充者是同库 editor ==')
const admin = (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: 'admin', password: 'yuque@2026' }) })).json.token
ok(!!admin, '管理员登录成功')
const adminId = (await ses('/api/v2/user', {}, admin)).json.id
const B = (await ses('/api/entity/books', {}, admin)).json.rows[0]
const DOC = (await ses('/api/entity/docs', {}, admin)).json.rows.find((d) => d.bookId === B.id && !d.trashed)

const SFX = Math.random().toString(36).slice(2, 7)
const acct = 'lockb_' + SFX
const reg = (await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ account: acct, password: 'test1234', name: '冒充者' }) })).json
ok(!!reg?.user?.id, '注册出一个新同事', JSON.stringify(reg).slice(0, 80))
const bTok = (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: acct, password: 'test1234' }) })).json.token
const bId = (await ses('/api/v2/user', {}, bTok)).json.id
await ses('/api/sync/push', {
  method: 'POST', body: JSON.stringify({ upsert: { bookMembers: [{ bookId: B.id, userId: bId, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } }),
}, admin)
ok(await ses(`/api/doc/${DOC.id}`, {}, bTok).then((r) => r.status === 200), '前提：冒充者确实读得了这一篇（他不是没权限，是有权限但被锁挡住）')

const lockRes = await pushDocs([{ id: DOC.id, lockMemberId: adminId, lockAt: Date.now() }], admin)
ok(!(lockRes.json.rejected || []).length && row(DOC.id)?.lockMemberId === adminId, 'admin 把这篇锁上了', JSON.stringify(lockRes.json).slice(0, 90))

// 锁持有者的 id 客户端读得到 —— 这正是冒充的前提
const seen = (await ses(`/api/doc/${DOC.id}`, {}, bTok)).json?.doc
ok(seen && JSON.stringify(seen).includes(adminId),
  '**前提：lock.memberId 客户端读得到**（没有这条，冒充就无从谈起）', String(adminId))

// admin 是不是平台 owner —— 下面「owner 豁免」那节要用，这里量出来而不是假设
const memberRows = (await ses('/api/entity/members', {}, admin)).json.rows || []
const adminRole = String(memberRows.find((m) => m.id === adminId)?.role || '')

const evil = [{ id: 'x1', type: 'p', text: '冒充持有者写进去的正文' }]

/* ---------------------------------------------------------------- */
console.log('\n== 基准：不带 lockMemberId 推（这个一直是拦得住的）==')
{
  const before = textOf(row(DOC.id))
  const r = await pushDocs([{ id: DOC.id, blocks: evil, updatedAt: Date.now() }], bTok)
  const rej = r.json.rejected || []
  ok(rej.length === 1 && /锁定/.test(String(rej[0].reason)), '被拒，理由说的是锁定', JSON.stringify(rej).slice(0, 90))
  ok(textOf(row(DOC.id)) === before, '**查库确认正文真没变**（不只看状态码）')
}

/* ---------------------------------------------------------------- */
console.log('\n== 核心：冒充 lockMemberId == 锁定者的 id ==')
{
  const before = textOf(row(DOC.id))
  const r = await pushDocs([{ id: DOC.id, blocks: evil, lockMemberId: adminId, updatedAt: Date.now() }], bTok)
  const rej = r.json.rejected || []
  ok(rej.length === 1 && /锁定/.test(String(rej[0].reason)),
    '**冒充也被拒了**（这条以前是被收下的，库里正文真会被改）', JSON.stringify(rej).slice(0, 90) || 'rejected 为空')
  ok(textOf(row(DOC.id)) === before,
    '**查库确认正文真没变**（这条最要紧：以前这里是真被改了的）',
    `现在是「${textOf(row(DOC.id)).slice(0, 30)}」`)
  ok(row(DOC.id)?.lockMemberId === adminId, '锁还挂在原持有者名下（没被抢走，也没被清掉）', String(row(DOC.id)?.lockMemberId))
}

console.log('\n== 也不能把锁抢过来 ==')
{
  const r = await pushDocs([{ id: DOC.id, lockMemberId: bId, updatedAt: Date.now() }], bTok)
  ok((r.json.rejected || []).length === 1, '非持有者推自己的 lockMemberId → 被拒', JSON.stringify(r.json.rejected).slice(0, 80))
  ok(row(DOC.id)?.lockMemberId === adminId, '锁没被换成人家的', String(row(DOC.id)?.lockMemberId))
}

/* ---------------------------------------------------------------- */
console.log('\n== 持有者自己：照常能改（堵漏洞不能把正门也堵上）==')
{
  const own = [{ id: 'a1', type: 'p', text: '持有者自己写的' }]
  const r1 = await pushDocs([{ id: DOC.id, blocks: own, updatedAt: Date.now() }], admin)
  ok(!(r1.json.rejected || []).length, '持有者不带 lockMemberId 直接推 → 收下了', JSON.stringify(r1.json.rejected).slice(0, 80))
  ok(textOf(row(DOC.id)) === '持有者自己写的', '**库里正文确实是持有者写的**', textOf(row(DOC.id)).slice(0, 30))

  const own2 = [{ id: 'a2', type: 'p', text: '持有者带着自己的 lockMemberId 写的' }]
  const r2 = await pushDocs([{ id: DOC.id, blocks: own2, lockMemberId: adminId, updatedAt: Date.now() }], admin)
  ok(!(r2.json.rejected || []).length, '持有者带着 lockMemberId 推 → 也收下了', JSON.stringify(r2.json.rejected).slice(0, 80))
  ok(textOf(row(DOC.id)) === '持有者带着自己的 lockMemberId 写的', '库里也是这一份', textOf(row(DOC.id)).slice(0, 30))
}

console.log('\n== 释放锁：持有者能放，放完谁都能改 ==')
{
  const r = await pushDocs([{ id: DOC.id, lockMemberId: null, lockAt: null, updatedAt: Date.now() }], admin)
  ok(!(r.json.rejected || []).length, '持有者释放锁 → 收下了', JSON.stringify(r.json.rejected).slice(0, 80))
  ok(!row(DOC.id)?.lockMemberId, '库里锁真的没了', JSON.stringify(row(DOC.id)?.lockMemberId))

  const free = [{ id: 'f1', type: 'p', text: '没锁的时候 B 写的' }]
  const r2 = await pushDocs([{ id: DOC.id, blocks: free, updatedAt: Date.now() }], bTok)
  ok(!(r2.json.rejected || []).length, '**没锁的时候 B 能改**（锁一撤就恢复正常，不是把编辑器锁死了）', JSON.stringify(r2.json.rejected).slice(0, 80))
  ok(textOf(row(DOC.id)) === '没锁的时候 B 写的', '库里也是这一份', textOf(row(DOC.id)).slice(0, 30))
}

console.log('\n== 平台 owner 也被这把锁挡住（2026-10-05 定的）==')
{
  /*
   * 决策记录：服务端以前放行 owner（`denyReason` 开头就 `if (user.role === 'owner') return null`），
   * 而界面 `DocPage` 的 `lockedByOther` 只看 memberId、不看权限，
   * 于是 owner 看到「已锁定，你只能读」却实际改得动 —— **两边不一致**。
   *
   * 决定：**服务端也挡 owner**，让两边一致。理由是锁防的是**编辑冲突**，
   * 不是权限；「管理员什么都能管」是另一件事（`exportAllowed` 那边的 owner 豁免没动）。
   *
   * 风险方向说清：owner 在界面上本来就是只读的，**不会误改**；
   * 真正出事的是他改用脚本 / 另一个客户端去改 —— 那时刻意静默成功，
   * 而持有者收不到任何冲突提示。
   *
   * **代价（已知并接受）：没有「强制解锁」这个动作。**
   * owner 被别人锁着的文档挡在门外时，只能等持有者解锁。
   * 要加强制解锁是**新功能**，不属于这个修复。
   */
  await pushDocs([{ id: DOC.id, lockMemberId: bId, lockAt: Date.now() }], bTok)
  ok(row(DOC.id)?.lockMemberId === bId, '前提：B 重新上了锁（锁在 B 名下，owner 不是持有者）', String(row(DOC.id)?.lockMemberId))

  const before = textOf(row(DOC.id))
  const r = await pushDocs([{ id: DOC.id, blocks: [{ id: 'z', type: 'p', text: 'owner 改的' }], updatedAt: Date.now() }], admin)
  const rej = r.json.rejected || []
  ok(rej.length === 1 && /锁定/.test(String(rej[0].reason)),
    '**平台 owner 的写入也被拒了**（以前是放行的）', JSON.stringify(rej).slice(0, 80) || 'rejected 为空')
  ok(textOf(row(DOC.id)) === before,
    '**查库确认正文真没变**（owner 早退在锁的判断之前，删掉/挪动过位置都会让这条红）',
    `现在是「${textOf(row(DOC.id)).slice(0, 30)}」`)

  // 删除也走 denyReason（deleteRow 第 549 行），所以 owner 同样删不掉
  const rm = await ses(`/api/v2/repos/${B.spaceId}/${B.id}/docs/${DOC.id}`, { method: 'DELETE' }, admin)
  ok(rm.status === 403 || (rm.json?.error || '').includes('锁定'),
    '**owner 也删不掉**（v2 DELETE 走 push 的 remove，同样过 denyReason）',
    `${rm.status} ${String(rm.json?.error || '').slice(0, 40)}`)

  // 但 owner 对**没锁的**文档一切照旧 —— 不能连正门也一起堵上
  await pushDocs([{ id: DOC.id, lockMemberId: null, lockAt: null }], bTok)
  const free = await pushDocs([{ id: DOC.id, blocks: [{ id: 'y', type: 'p', text: 'owner 在无锁文档上写的' }], updatedAt: Date.now() }], admin)
  ok(!(free.json.rejected || []).length, '**无锁时 owner 照常能写**（挪位置不是把 owner 变普通成员）', JSON.stringify(free.json.rejected).slice(0, 80))
  ok(textOf(row(DOC.id)) === 'owner 在无锁文档上写的', '库里也是这一份', textOf(row(DOC.id)).slice(0, 30))
}

console.log('\n== owner 早退仍然对其他实体有效 ==')
{
  // 挪锁的时候**不能**顺手把 owner 的整体豁免也删掉：
  // 成员名册那条 `if (user.role !== 'admin')` 就依赖这个早退。
  const src0 = readFileSync('server/sync.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  const i0 = src0.indexOf('function denyReason')
  const seg0 = src0.slice(i0, src0.indexOf('\n}\n', i0))
  ok(/if \(user\.role === 'owner'\) return null/.test(seg0), 'owner 早退还在（它对其他实体仍然需要）')
  const lockAt0 = seg0.indexOf("def.name === 'docs' && existing")
  const ownerAt0 = seg0.indexOf("user.role === 'owner'")
  ok(lockAt0 >= 0 && ownerAt0 >= 0 && lockAt0 < ownerAt0,
    '**锁的判断排在 owner 早退之前**（挪回去这条就红）', `锁在 ${lockAt0}，owner 早退在 ${ownerAt0}`)
}

/* ---------------------------------------------------------------- */
console.log('\n== 没锁的时候也能上锁 ==')
{
  await pushDocs([{ id: DOC.id, lockMemberId: null, lockAt: null }], admin)
  const r = await pushDocs([{ id: DOC.id, lockMemberId: bId, lockAt: Date.now() }], bTok)
  ok(!(r.json.rejected || []).length && row(DOC.id)?.lockMemberId === bId, 'B 在无锁文档上上了锁', String(row(DOC.id)?.lockMemberId))
  const r2 = await pushDocs([{ id: DOC.id, blocks: [{ id: 'y', type: 'p', text: '持有者自己写的' }], updatedAt: Date.now() }], bTok)
  ok(!(r2.json.rejected || []).length, '持有者自己照常能改', JSON.stringify(r2.json.rejected).slice(0, 80))
  await pushDocs([{ id: DOC.id, lockMemberId: null, lockAt: null }], bTok)
}

/* ----------------------------------------------------------------
 * 客户端推的其实是 `lock: { memberId, at }`（2026-10-12 补）
 * ============================================================
 * 上面所有用例都推的是 `lockMemberId` / `lockAt` —— **那是列名**。
 * 而界面上点「锁定文档」走的是 `lockDoc`，它写进 store 的是
 * **一个对象** `lock: { memberId, at }`，同步时原样推上去。
 *
 * 服务端原来**不认识**这个形状（`toRow` 只认列名），于是：
 * 界面上点一下返回成功、锁条也显示，**服务端那一列却是空的**，
 * 刷新后锁条消失，别人照样能编辑 —— 而**不报任何错**。
 *
 * 所以这一节钉的是**客户端那条真实形状**：
 *   · 认得它（能落库）
 *   · 释放锁也认得它
 *   · **而且服务端那道闸照样拦得住冒充者**（这条最要紧 ——
 *     新开一条写入形状，闸门可不能跟着漏）
 * ---------------------------------------------------------------- */
console.log('\n== 客户端推的那个对象形状（lock: {memberId, at}）==')
{
  await pushDocs([{ id: DOC.id, lockMemberId: null, lockAt: null }], admin)
  ok(!row(DOC.id)?.lockMemberId, '基准：先确保这一篇没锁')

  // ① 正向：持有者用**对象**形状上锁
  const up = await pushDocs([{ id: DOC.id, lock: { memberId: adminId, at: Date.now() } }], admin)
  ok(!(up.json.rejected || []).length, '用对象形状上锁被收下了', JSON.stringify(up.json.rejected).slice(0, 80))
  ok(row(DOC.id)?.lockMemberId === adminId, '★ 真的落库了（以前这一列一直是空的）', String(row(DOC.id)?.lockMemberId))

  // ② 反向：冒充者用同一个形状抢锁 —— 必须被拒
  const steal = await pushDocs([{ id: DOC.id, lock: { memberId: bId, at: Date.now() } }], bTok)
  const stealRej = (steal.json.rejected || []).filter((x) => x.entity === 'docs' && x.id === DOC.id)
  ok(stealRej.length === 1 && /锁定/.test(String(stealRej[0].reason)),
    '★ 冒充者用**同一个形状**抢锁照样被拒（新开的写入形状没有绕过闸门）',
    JSON.stringify(steal.json.rejected).slice(0, 120))
  ok(row(DOC.id)?.lockMemberId === adminId, '锁没被换成人家的', String(row(DOC.id)?.lockMemberId))

  // ③ 释放：也要认这个形状，否则「解锁」在界面上也是空动作
  const off = await pushDocs([{ id: DOC.id, lock: null }], admin)
  ok(!(off.json.rejected || []).length && !row(DOC.id)?.lockMemberId,
    '用同一个形状释放锁也生效', `lockMemberId=${String(row(DOC.id)?.lockMemberId)}`)

  /*
   * ④ ⚠️ 上面那条把「`lock: null` 会被写进去」变成了**真的**，
   *    所以必须钉住它的安全边界：**非持有者不能靠推 `lock: null`
   *    把别人的锁清掉**。
   *    这不是假想：客户端的每一篇文稿都带 `lock` 键，
   *    别人锁着的文档在 B 那边也是 `lock: {memberId: A}`。
   *    真正的风险是 B 那边**陈旧**（没拉到）时推上来一个 null。
   */
  await pushDocs([{ id: DOC.id, lock: { memberId: adminId, at: Date.now() } }], admin)
  ok(row(DOC.id)?.lockMemberId === adminId, '基准：A 又锁上了')
  const steal2 = await pushDocs([{ id: DOC.id, lock: null, blocks: [{ id: 'y', type: 'p', text: 'B 偷偷写的' }], updatedAt: Date.now() }], bTok)
  const rej2 = (steal2.json.rejected || []).filter((x) => x.entity === 'docs' && x.id === DOC.id)
  ok(rej2.length === 1 && /锁定/.test(String(rej2[0].reason)),
    '★ 非持有者推 lock:null 清不掉别人的锁（否则「认 null」就是一个后门）',
    JSON.stringify(steal2.json.rejected).slice(0, 120))
  ok(row(DOC.id)?.lockMemberId === adminId && textOf(row(DOC.id)) !== 'B 偷偷写的',
    '锁还在、B 的正文也没进去', `lockMemberId=${String(row(DOC.id)?.lockMemberId)}`)
  await pushDocs([{ id: DOC.id, lock: null }], admin)

  /*
   * 破坏对照：把 `writeObjects` 去掉，这一节必须红。
   * （不验这个，「认得对象形状」这几条就是恒真的 —— 因为
   *  库里那一列本来就是空的，而 `!undefined` 恰好为真。）
   */
  const ent = readFileSync('server/entities.ts', 'utf8')
  const mutated = ent.replace(/writeObjects:\s*\{\s*lock:[\s\S]*?\}\s*,/, '')
  ok(mutated !== ent, '破坏对照的样本确实和现在不同（否则下面那条是恒真）')
  ok(/writeObjects/.test(ent) && /lock:\s*\{\s*memberId:\s*'lockMemberId'/.test(ent),
    '★ docs 实体声明了 lock 对象 → 两列的映射（去掉就红）')
}

/* ---------------------------------------------------------------- */
console.log('\n== 源码层面：别把那个比较加回来 ==')
{
  const src = readFileSync('server/sync.ts', 'utf8')
  const i = src.indexOf('function denyReason')
  // 剥注释再扫 —— 注释里写着「incoming.lockMemberId」曾经骗过这条检查
  const seg = src.slice(i, src.indexOf('\n}\n', i))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  /*
   * 锚点用**代码特征**，不能用注释里的字。
   * 第一版写的是 `seg.indexOf('文档锁')` —— 而注释刚刚被剥掉了，
   * indexOf 返回 -1，`slice(-1)` 静默取到了**最后一个字符**，
   * 断言于是恒假。红的不是代码，是锚点选错了地方。
   */
  const at = seg.indexOf("def.name === 'docs' && existing")
  ok(at >= 0, '找得到锁的那段代码（锚点用代码特征，不用注释里的字）')
  const lockSeg = at >= 0 ? seg.slice(at, at + 300) : ''
  /*
   * 正则写成 `incoming[^;\n]*lockMemberId` 而不是 `incoming\.lockMemberId`。
   *
   * 第二版栽在这：破坏对照里我写的是 `incoming as Row).lockMemberId`，
   * 中间隔了字符，`\.` 匹配不上 —— **那两节于是全绿**。
   * 两次都是同一类错（源码断言抓不住），但错法不同：
   * 第一次是**注释**骗过了它，第二次是**正则太窄**放过了。
   *
   * 所以这类断言的写法原则是「宁可宽到有点噪音」：
   * 这里要找的是「有没有拿 incoming 的锁字段做比较」，
   * 同一行里 incoming 后面出现 lockMemberId 就算。
   */
  const reaches = /incoming[^;\n]*lockMemberId/i
  ok(!reaches.test(lockSeg),
    '**判断里不再拿 incoming.lockMemberId 做比较**（那是冒充者的门）',
    reaches.test(lockSeg) ? '又加回来了' : '')
  ok(/existing\.lockMemberId/.test(lockSeg) && /user\.id/.test(lockSeg),
    '判断依据是「库里锁着谁」和「我是谁」，不看我推了什么', lockSeg.slice(0, 90))

  // 顺手证明这个正则确实能抓到 —— 不然「没红」和「抓不住」分不开
  ok(reaches.test(`String((incoming as Row).lockMemberId || '') !== String(existing.lockMemberId)`),
    '（自检）这条正则对破坏对照里那种写法确实会命中')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await cleanup()
process.exit(fail ? 1 : 0)
