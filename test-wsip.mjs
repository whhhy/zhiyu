/**
 * IP 白名单漏了 WebSocket 协作通道
 * ============================================================
 * 白名单在服务端一共有好几条通路，7.29 补过 `/api/export`，
 * 7.31 补过 `/api/sync/changes` —— 每一次都是**那条通路压根不经过上一次的判据**。
 * 这次是第三条：**WebSocket**。
 *
 * `wss.on('connection', …)` 的 `join` 处理器以前只判文档权限
 * （`capsOfDoc(user, docId).read`），**不判 IP**；
 * 而 `/api/doc/:id` 是判的（`requireIpAllowed`）。
 *
 * 实测（探针，2026-10-06）—— 同一个人、同一个 IP、同一个知识库：
 *   `/api/doc/:id`     → 403「当前 IP 不在该知识库的白名单内」
 *   WebSocket 协作房间 → **完整收到了别人对那篇的实时编辑**
 *     {"docId":"…","kind":"op","ops":[{"type":"insert","text":"白名单外的实时内容-…"}]}
 *
 * 设置页写着「仅允许下列 IP 访问本知识库，其余请求将被拒绝」——
 * 而实时通道等于没设防：只要有人知道 docId（当过成员的人都知道），
 * 就能挂着连接收下每一次编辑。
 *
 * ------------------------------------------------------------
 * 这一节必须验**正向**那一半
 * ------------------------------------------------------------
 * 判据完全可以写成「只要开了白名单就一律拒绝协作」，
 * 那样下面所有否定断言照样全绿，而白名单把**名单内的同事**也一起挡了 ——
 * 功能本身废掉，而没有任何东西会告诉你。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'

const PORT = process.env.WSIP_PORT || await freePort()
const DB = 'data/_wsip-test.db'
const BASE = `http://localhost:${PORT}`
const ALLOW_IP = '203.0.113.9'

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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'ws@2026' },
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
  const r = await fetch(BASE + p, o); const t = await r.text()
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }
const push = (tk, upsert) => ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert, remove: {} }) }, tk)

const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'ws@2026' }) })).d?.token
const SFX = Math.random().toString(36).slice(2, 7)
const bk = (await ses('/api/entity/books', {}, admin)).d.rows[0]
const acct = 'wsi' + SFX
await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: '同事' }) })
const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d?.token
const uid = (await ses('/api/v2/user', {}, tok)).d.id
const grant = await push(admin, { bookMembers: [{ userId: uid, bookId: bk.id, role: 'editor', perms: '{}', joinedAt: Date.now() }] })

console.log('\n== 前置 ==')
ok(!!admin && !!uid && !!bk, `身份与库：${uid} / ${bk.name}`)
ok(!!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, uid),
  `他是《${bk.name}》的 editor（push ${grant.status}）—— 不成立就退出`)
if (!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, uid)) {
  console.log('\n前置不成立，不往下验。'); stop(); process.exit(fail ? 1 : 0)
}

const DOC = 'wsip_' + SFX
await push(tok, { docs: [{ id: DOC, bookId: bk.id, title: '白名单探针 ' + SFX, body: '原始内容', blocks: [{ type: 'p', text: '原始内容' }], createdAt: Date.now(), updatedAt: Date.now(), wordCount: 4 }] })

/** 握手时带 X-Forwarded-For —— 服务默认信它（关掉要显式 YQ_TRUST_PROXY=0） */
const openWs = (token, ip) => new Promise((resolve, reject) => {
  const headers = { Authorization: 'Bearer ' + token, ...(ip ? { 'X-Forwarded-For': ip } : {}) }
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers })
  ws.on('open', () => resolve(ws))
  ws.on('error', reject)
  setTimeout(() => reject(new Error('ws 连接超时')), 8000)
})
const collect = (ws, ms) => new Promise((r) => {
  const got = []
  const on = (raw) => { try { got.push(JSON.parse(String(raw))) } catch { /* 非 JSON */ } }
  ws.on('message', on)
  setTimeout(() => { ws.off('message', on); r(got) }, ms)
})
const setWl = async (on, list) => {
  await push(admin, { bookSettings: [{ bookId: bk.id, ipWhitelist: on, ipList: list }] })
  return one('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?', bk.id)
}
/**
 * 管理员发一个 op，返回同事在房间里收到的东西。
 *
 * ⚠️ 两个踩过的坑，都写在这里了：
 *
 * ① **收集器必须先挂、再 join**。`hello` / `peers` / `denied` 都是在 join
 *    那一刻就发出去的，而我第一版是 join 完、等 900ms 才挂监听器 ——
 *    于是它们全在监听之前就发完了，收集到 `[]`，
 *    看起来像「服务端什么都没回」。**先挂监听器。**
 *
 * ② **正向场景里管理员也必须用名单内的 IP**。
 *    `ipAllowed` **刻意不给 owner 豁免**（网络层判断，见 perms.ts 的注释），
 *    所以白名单只放行 203.0.113.9 时，从 127.0.0.1 连的**管理员自己**
 *    也进不了房间 —— 于是没人发 op，被测的同事当然收不到。
 *    第一版就栽在这儿，症状是「修复过头，把名单内的人也挡了」，
 *    而真相是场景本身错了。
 */
const collab = async (peerIp) => {
  const SECRET = `实时内容-${Math.random().toString(36).slice(2, 7)}`
  // 管理员用哪个 IP？被测者被挡住时无所谓，被测者放行时必须也放行管理员
  const adminIp = peerIp
  const a = await openWs(admin, adminIp)
  const b = await openWs(tok, peerIp)
  // 先挂监听器，再 join —— 否则 join 时的 hello/peers/denied 全收不到
  const inbox = collect(b, 2200)
  b.send(JSON.stringify({ ctl: 'join', docId: DOC, memberId: uid }))
  a.send(JSON.stringify({ ctl: 'join', docId: DOC, memberId: 'admin' }))
  await new Promise((r) => setTimeout(r, 900))
  a.send(JSON.stringify({ docId: DOC, kind: 'op', ops: [{ type: 'insert', pos: 0, text: SECRET }] }))
  const got = await inbox
  a.close(); b.close()
  return { secret: SECRET, got, leaked: got.some((g) => JSON.stringify(g).includes(SECRET)) }
}

/* ============ 基准：白名单关着 ============ */
console.log('\n== 基准：白名单关着，协作照常 ==')
{
  const s = await setWl(0, [])
  ok(Number(s?.ipWhitelist) === 0, '设置落库（白名单关着）')
  const r = await collab(null)
  ok(r.got.some((g) => g.ctl === 'hello' || g.ctl === 'peers'), '同事确实进了房间', JSON.stringify(r.got).slice(0, 120))
  ok(r.leaked, `收到了实时编辑（${r.got.length} 条消息）—— 不成立后面就是空断言`)
  if (!r.leaked) { console.log('\n基准不成立，停止。'); stop(); process.exit(fail ? 1 : 0) }
}

/* ============ 白名单开着、当前 IP 不在里面 ============ */
console.log('\n== 白名单开着，当前 IP 不在里面 ==')
{
  const s = await setWl(1, [ALLOW_IP])
  ok(Number(s?.ipWhitelist) === 1, `设置落库（名单里只有 ${ALLOW_IP}，本机不在）`)

  const http = await ses(`/api/doc/${DOC}`, {}, tok)
  ok(http.status === 403, `HTTP 打开单篇 → 403（${http.status}）`)

  const r = await collab(null)
  ok(!r.leaked, '**协作通道也没收到**（修之前这里是把别人正在打的字原样收到的）',
    r.leaked ? `泄漏了：${JSON.stringify(r.got).slice(0, 140)}` : '')
  ok(r.got.some((g) => g.ctl === 'denied' && /白名单/.test(String(g.reason || ''))),
    '并且明确回了 denied 说清是白名单', JSON.stringify(r.got).slice(0, 140))
  ok(!r.got.some((g) => g.ctl === 'denied' && /阅读该文档的权限/.test(String(g.reason || ''))),
    '理由说的是「白名单」而不是「没有阅读权限」—— 前者是网络来源，后者会被误解成权限不够')
}

/* ============ 白名单开着、IP 在名单里 ============ */
console.log('\n== 白名单开着，但来源 IP 在名单里（这一段不能省）==')
{
  const s = await setWl(1, [ALLOW_IP])
  ok(Number(s?.ipWhitelist) === 1, '设置落库')

  const http = await ses(`/api/doc/${DOC}`, {}, tok)
  ok(http.status === 403, `（对照）不带 XFF 的那条仍然是 403（${http.status}）`)

  const r = await collab(ALLOW_IP)
  ok(r.leaked, `名单内的 IP 协作照常（收到 ${r.got.length} 条）`,
    r.leaked ? '' : '—— 判据写成了「开了白名单就一律拒绝协作」，把名单内的同事也一起挡了')
  ok(!r.got.some((g) => g.ctl === 'denied'), '没有被 denied')
}

/* ============ 源码层 ============ */
console.log('\n== 源码层 ==')
{
  const src = readFileSync('server/ws.ts', 'utf8')
  ok(/ipAllowed\(bookIdOfDoc\(docId\), ip\)/.test(src), 'join 里真的判了 IP 白名单')
  ok(/clientIp\(req\)/.test(src), '并且**取的是这条连接自己的来源 IP**（不是全局的、也不是写死的）')
  ok(/import \{[^}]*clientIp[^}]*\} from '\.\/auth\.ts'/.test(src),
    'clientIp 是从 auth.ts import 的（口径和 HTTP 那条完全一致）—— '
    + '注意 import 语句里 clientIp 在 `from` **之前**，第一版正则写反了于是恒红')
  // 家族自检：凡是「按知识库访问」的入口，都得自己判一次
  const srvSrc = readFileSync('server/index.ts', 'utf8') + src + readFileSync('server/sync.ts', 'utf8')
  const nIpAllowed = (srvSrc.match(/ipAllowed\(/g) || []).length
  ok(nIpAllowed >= 6, `ipAllowed 在服务端的调用点有 ${nIpAllowed} 处（每条独立通路各判一次，不是靠上一条兜着）`)
}

/* ===================================================================
   WebSocket 上的第二个判据：文档锁
   -------------------------------------------------------------------
   同一个 handler 里还有一处判据以前漏了。
   锁防的是**编辑冲突**，不是权限 —— 所以它和「谁能编辑」是两件事，
   也要在每条写入路径上各判一次。

   实测（探针，2026-10-06）—— A 持有锁，B（同样是 editor）：
   · 落库路（push）：B 被 `rejected: 文档已被他人锁定`，回读标题没变   ✔
   · 协作路（WS）：B 的 content **被转发给了锁持有者 A**，
     而且服务端还把 B 的快照写进了 `doc_snapshots`（actorId 是 B）    ✘

   后果链条：A 的客户端是 CRDT 合并，会把那条 op 应用进去；
   等 A 一保存，**B 塞进来的字就落库了** —— 锁被整个绕过去，
   而界面上 A 看到的是「我自己在打字」。
   =================================================================== */
console.log('\n== 文档锁在协作通道上也要判 ==')
{
  /*
   * ⚠️ **先把白名单关掉** —— 这一节和 IP 无关，而上一节结束时白名单是开着的。
   * 于是 `join` 会被 IP 判定挡住（连管理员自己都在名单外），
   * **一条消息都发不出去** ——
   * 症状是：基准「没锁时能写」红、正向「持有者能写」红，
   * 而「没持有锁的被拦住」却**通过了**（因为压根没有消息）。
   * 也就是说：三条断言里唯一绿的那条，恰恰是**最没有信息量**的那条。
   *
   * 这是同一个错我今天犯的第三次（前两次是「建素材时白名单开着」），
   * 所以写成纪律贴在这里：
   * **每一节开头先把全局开关恢复到已知状态，再造素材、最后才开要验的那个开关。**
   */
  await setWl(0, [])
  const DOC2 = 'wslock_' + SFX
  const row = (extra = {}) => ({ id: DOC2, bookId: bk.id, title: '锁探针 ' + SFX, body: '原始', blocks: [{ type: 'p', text: '原始' }], createdAt: Date.now(), updatedAt: Date.now(), wordCount: 4, ...extra })
  await push(tok, { docs: [row()] })
  if (!one('SELECT 1 AS x FROM docs WHERE id = ?', DOC2)) { ok(false, '锁探针那篇没建出来，后面无效'); }
  else {
    /** 某人经协作通道发一条 content，返回持有者那边收到的东西 + 服务端有没有存快照 */
    const collab2 = async (author, text) => {
      const a = await openWs(admin)          // 管理员当「锁持有者」接收端
      const b = await openWs(author.tok)
      a.send(JSON.stringify({ ctl: 'join', docId: DOC2, memberId: 'admin' }))
      b.send(JSON.stringify({ ctl: 'join', docId: DOC2, memberId: author.id }))
      await new Promise((r) => setTimeout(r, 800))
      const inbox = collect(a, 1600)
      b.send(JSON.stringify({ docId: DOC2, kind: 'content', blocks: [{ type: 'p', text }] }))
      const got = await inbox
      a.close(); b.close()
      const snap = one('SELECT actorId, data FROM doc_snapshots WHERE docId = ?', DOC2)
      return { relayed: got.some((g) => JSON.stringify(g).includes(text)), snapHas: !!snap && String(snap.data).includes(text) }
    }

    // ① 没锁：谁都能写
    /*
     * `collab2` 收的是 `{ tok, id }` **对象**。
     * 第一版这里直接传了令牌字符串，于是 `author.tok` 是 undefined，
     * 握手头变成 `Bearer undefined` → 服务端 401 → 整个套件崩在一个栈里，
     * 而输出上只看得见「打完标题然后没了」。
     */
    const t0 = '没锁时同事能写-' + SFX
    const r0 = await collab2({ tok, id: uid }, t0)
    ok(r0.relayed, '没锁的时候同事经协作通道写东西是**转发出去的**（基准）')
    ok(r0.snapHas, '快照也存下来了（基准）')

    // ② 上锁：管理员持有
    /*
     * `lockMemberId` 必须是**持有者的真实 userId**。
     * 第一版我推了字面量 `'admin'`，而管理员的真实 id 是 `u_…` ——
     * 于是判据认为「锁在别人手上」，把**持有者自己**挡住了，
     * 正向那一半就红了。症状是「持有者不能写」，而真相是「锁的归属写错了」。
     */
    const adminId = (await ses('/api/v2/user', {}, admin)).d.id
    const lockRes = await push(admin, { docs: [row({ lockMemberId: adminId, lockAt: Date.now() })] })
    const holder = one('SELECT lockMemberId FROM docs WHERE id = ?', DOC2)
    ok(String(holder?.lockMemberId || '') === adminId, `锁落在管理员名下（lockMemberId=${holder?.lockMemberId}，push ${lockRes.status}）`,
      holder?.lockMemberId ? `推的是 ${adminId}` : '')

    // ③ 锁持有者自己写：照常（正向那一半）
    if (String(holder?.lockMemberId || '') === adminId) {
      const t1 = '持有者自己写的-' + SFX
      const r1 = await collab2({ tok: admin, id: adminId }, t1)
      ok(r1.relayed, '**锁持有者自己**经协作通道写是放行的（正向那一半）',
        r1.relayed ? '' : '—— 判据写成了「一有锁就谁都不许写」，那功能就废了')
    }

    // ④ 别人写：两条路都要拦
    const t2 = '没持有锁的人硬塞-' + SFX
    const r2 = await collab2({ tok, id: uid }, t2)
    ok(!r2.relayed, '**没持有锁的同事**经协作通道写 → 没有转发出去', r2.relayed ? '泄漏了' : '')
    ok(!r2.snapHas, '服务端**也没有**存他的快照（以前这里是存了的）')

    const viaPush = await push(tok, { docs: [row({ title: '硬改的标题' + SFX })] })
    const after = one('SELECT title FROM docs WHERE id = ?', DOC2)
    const rejected = JSON.stringify(viaPush.d?.rejected || [])
    ok(/文档已被他人锁定/.test(rejected), '落库那条路照样拒（对照：两条路口径一致）', rejected.slice(0, 120))
    ok(!String(after?.title || '').includes('硬改的标题'), '回读库里的标题没变', String(after?.title))
  }

  // 源码层
  const wsSrc = readFileSync('server/ws.ts', 'utf8')
  ok(/lockedByOther\(holder\?\.lockMemberId, user\.id\)/.test(wsSrc), 'WS 的写分支里真的判了锁')
  ok(/SELECT lockMemberId FROM docs/.test(wsSrc),
    '**逐条消息**去查当前持有者（锁可以在 join 之后才被拿走，只在 join 时判是不够的）')
  ok(/export function lockedByOther/.test(readFileSync('server/perms.ts', 'utf8')),
    '判据本身住在 perms.ts（和落库那条路同一处口径）')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
