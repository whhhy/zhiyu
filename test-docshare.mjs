/**
 * 单篇文档的对外分享
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 分享弹窗里挂着「互联网上获得链接的人可查看」「允许下载 / 导出」
 * 「仅自己可见」这一组控件，写这个套件之前它们**全都不生效**：
 *
 *   · 文档设成公开后，拿到链接的人打开是**登录页** ——
 *     因为所有接口都 requireUser，而 AppGate 的逻辑就是「没令牌就送登录页」。
 *   · 「允许下载」只改了组件里的局部 state，关掉弹窗就没了，
 *     **服务端压根没有这个字段**。
 *   · 分享链接是写死的 `https://www.yuque.com/yuque-clone/<id>` ——
 *     一个「复制成功、toast 成功、点得开」的**假链接**，
 *     复制给外部合作方，对方打开的是语雀官网上一个不存在的路径。
 *
 * 这三样凑在一起是最坏的一种组合：界面给了肯定的反馈，
 * 而实际上什么都没发生。管理员会**放心地**把链接发出去。
 *
 * ============================================================
 * 这个套件钉的
 * ------------------------------------------------------------
 *  ① **两个开关都要开** —— 文档级 public + 知识库级 publicAccess。
 *     少一个都不算对外开放，而且要给出「差在哪一步」的话术。
 *  ② 访问密码：错密码不给看、给对了给看、连错限流、
 *     **密码哈希不外泄**（匿名接口的返回里不能出现它）。
 *  ③ 有效期：过了期就是打不开（用负数天数造一个已过期的，不靠等）。
 *  ④ 匿名接口**不多给一个字段** —— 不给评论、版本、空间成员、
 *     作者 id。拿到一篇文档不该顺带得到「这个空间里还有哪些库」。
 *  ⑤ 「允许下载」是真的落库，不是组件局部 state。
 *  ⑥ 管理分享设置要有「分享」权限；越权改别人的是 403。
 *  ⑦ 分享页留下的访问痕迹能进访问日志。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.DOCSHARE_PORT || await freePort()
const DB = 'data/_docshare-test.db'
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
/** 登录后的普通调用 */
const ses = (p, o = {}, t = '') => call(p, o, t)
/**
 * 匿名访客的调用 —— 刻意不带任何凭据。
 *
 * 密码走 POST 的 JSON body，而不是请求头：请求头是 ByteString，
 * 「口令2026」这种中文口令**根本发不出去**（fetch 抛 TypeError）。
 * 这条不是假设 —— 写这个套件时先试了请求头，中文口令直接把测试跑崩了。
 */
const anon = (p, o = {}, pwd = '') => call(
  pwd ? p : p,
  pwd ? { method: 'POST', body: JSON.stringify({ password: pwd }) } : o,
  '',
)

/* ---------------- 先删旧库，再起服务 ---------------- */
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
  (await ses('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ account, password }),
  })).json.token || ''

const admin = await login('admin')
ok(!!admin, '管理员登录成功')

/* 拿一篇现成的文档，建一篇自己的（保证状态干净） */
const books = (await ses('/api/entity/books', {}, admin)).json.rows || []
const B = books[0]
ok(!!B, `拿一个知识库做素材：${B?.name}`)

const DOC = 'share_probe_' + Math.random().toString(36).slice(2, 8)
const now = Date.now()
{
  const r = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id: DOC, bookId: B.id, title: '对外分享探针文档', body: '# 对外分享\n\n这段应该只有拿链接的人看得到。',
          createdAt: now, updatedAt: now, wordCount: 20,
        }],
      },
    }),
  }, admin)
  ok(r.status === 200 && !(r.json.rejected || []).length, '造一篇探针文档', `${r.status} ${JSON.stringify(r.json.rejected || [])}` + (r.status === 401 ? ' （没带令牌）' : ''))
}

const setVis = (v) => ses('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({ upsert: { docs: [{ id: DOC, visibility: v }] } }),
}, admin)
const setBookPublic = (v) => ses('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({ upsert: { bookSettings: [{ bookId: B.id, publicAccess: v ? 1 : 0 }] } }),
}, admin)

console.log('\n== 默认状态：一个都没开，对外就是不开放 ==')
{
  const r = await anon(`/api/public/doc/${DOC}`)
  ok(r.status === 403, '匿名访问被拒', String(r.status))
  ok(/公开访问/.test(String(r.json.error || '')), '话术点名了「知识库未开启公开访问」——管理员才知道差哪一步', String(r.json.error).slice(0, 60))
}

console.log('\n== 两个开关：缺一不可 ==')
{
  // 只开知识库，文档还是空间内可见
  await setBookPublic(true)
  let r = await anon(`/api/public/doc/${DOC}`)
  ok(r.status === 403, '只开知识库、文档没设公开 → 仍然打不开', String(r.status))
  ok(/没有设置为/.test(String(r.json.error || '')), '话术说的是「这篇没设成公开」', String(r.json.error).slice(0, 60))

  // 只开文档，知识库没开
  await setBookPublic(false)
  await setVis('public')
  r = await anon(`/api/public/doc/${DOC}`)
  ok(r.status === 403, '只开文档、知识库没开 → 仍然打不开（否则一点就变整库公开）', String(r.status))

  // 两个都开
  await setBookPublic(true)
  r = await anon(`/api/public/doc/${DOC}`)
  ok(r.status === 200, '两个都开 → 匿名可读', `${r.status} ${String(r.json.error || '').slice(0, 50)}`)
  ok(r.json.title === '对外分享探针文档', '返回了标题')
  ok(String(r.json.body || '').includes('只有拿链接的人看得到'), '返回了正文')
}

console.log('\n== 匿名接口不多给一个字段 ==')
{
  const raw = JSON.stringify((await anon(`/api/public/doc/${DOC}`)).json)
  ok(!/authorId/.test(raw), '不给作者 id')
  ok(!/spaceId|bookId/.test(raw), '不给 spaceId / bookId（不然等于告诉外部这个空间里还有哪些库）')
  ok(!/comments|versions|backlinks/.test(raw), '不给评论 / 版本 / 反向链接')
  ok(!/passwordHash|passwordSalt/.test(raw), '**密码哈希绝不出现在匿名接口的返回里**')
  ok(!/updatedBy|rev/.test(raw), '不给同步内部字段')
  const j = (await anon(`/api/public/doc/${DOC}`)).json
  ok(j.allowDownload === true, '默认允许下载（没设过分享设置时）')
}

console.log('\n== 访问密码 ==')
{
  await ses(`/api/doc/${DOC}/share`, { method: 'POST', body: JSON.stringify({ password: 'abc' }) }, admin)
  const tooShort = await ses(`/api/doc/${DOC}/share`, { method: 'POST', body: JSON.stringify({ password: 'abc' }) }, admin)
  ok(tooShort.status === 400, '太短的密码被拒（3 位 = 拿到链接就能穷举出来）', String(tooShort.status))

  const set = await ses(`/api/doc/${DOC}/share`, { method: 'POST', body: JSON.stringify({ password: '外发口令2026' }) }, admin)
  ok(set.status === 200 && set.json.share.hasPassword === true, '密码设上了', `${set.status} ${JSON.stringify(set.json).slice(0, 90)}`)

  const noPwd = await anon(`/api/public/doc/${DOC}`)
  ok(noPwd.status === 401, '不带密码读不到', String(noPwd.status))
  ok(/需要访问密码/.test(String(noPwd.json.error || '')), '话术说「需要访问密码」（区别于「密码不对」）', String(noPwd.json.error))

  const wrong = await anon(`/api/public/doc/${DOC}`, {}, '猜错了')
  ok(wrong.status === 401 && /密码不对/.test(String(wrong.json.error || '')), '密码错时说的是「密码不对」', String(wrong.json.error))

  const right = await anon(`/api/public/doc/${DOC}`, {}, '外发口令2026')
  ok(right.status === 200, '密码对了就读得到', String(right.status))

  const view = await ses(`/api/doc/${DOC}/share`, {}, admin)
  const viewRaw = JSON.stringify(view.json)
  ok(!/外发口令2026/.test(viewRaw), '设置密码的接口返回里**没有明文密码**')
  ok(!/passwordHash/.test(viewRaw), '也没有哈希')
}

console.log('\n== 连错限流 ==')
{
  // 先把密码清掉，否则统计的是「带错密码」那一条路
  await ses(`/api/doc/${DOC}/share`, { method: 'POST', body: JSON.stringify({ password: '外发口令2026' }) }, admin)
  let hit429 = false
  let lastCode = 0
  for (let i = 0; i < 12; i++) {
    const r = await anon(`/api/public/doc/${DOC}`, {}, '猜错了')
    lastCode = r.status
    if (r.status === 429) { hit429 = true; break }
  }
  ok(hit429, '连着猜错若干次之后被限流（否则拿到链接就能穷举密码）', `最后一次 ${lastCode}`)
  const blocked = await anon(`/api/public/doc/${DOC}`, {}, '外发口令2026')
  ok(blocked.status === 429, '限流期间**连正确的密码也进不去**（否则限流形同虚设）', String(blocked.status))
}

console.log('\n== 有效期 ==')
{
  /**
   * 换一篇文档。
   *
   * 上面那一节把限流计数打满了，而限流是按「文档 + IP」记的、
   * 只在**密码正确**时才清零。所以继续用同一篇的话，
   * 这一节的第一条请求就会拿到 429 —— 测的就不是有效期了。
   *
   * 这也说明限流是「连正确的密码也挡」的（下面会专门钉这一条）。
   */
  const DOC2 = 'share_exp_' + Math.random().toString(36).slice(2, 8)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: DOC2, bookId: B.id, title: '有效期探针', body: 'x', createdAt: Date.now(), updatedAt: Date.now() }] } }),
  }, admin)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: [{ id: DOC2, visibility: 'public' }] } }) }, admin)

  const neg = await ses(`/api/doc/${DOC2}/share`, { method: 'POST', body: JSON.stringify({ expiresInDays: -1 }) }, admin)
  ok(neg.status === 400, '负数有效期被拒', String(neg.status))
  const bad = await ses(`/api/doc/${DOC2}/share`, { method: 'POST', body: JSON.stringify({ expiresInDays: 99999 }) }, admin)
  ok(bad.status === 400, '有效期超过 3650 天被拒（99999 天 ≈ 273 年，明显是手滑）', String(bad.status))

  /*
   * ⚠️ 上界原来写死 `30 * 86400000`，全量里偶发红过一次（单跑 69/0）。
   *
   * 原因是**两个进程、两次采样**：
   *   · `expiresAt` 是**服务端**在处理请求那一刻算的（`now + 30 天`）
   *   · `Date.now()` 是**测试进程**里的时钟
   * 两者的差本来就不该正好卡在 30 天这条线上；机器一忙、时钟有一点偏差，
   * `gap` 就会略微越过 30 天，而断言用的是 `<=`。
   *
   * 所以上界改成「请求耗时 + 1 秒」—— 这不是把判据放松到放过真缺陷：
   * **下界 29 天没动**，而服务端真的少算/多算一天照样被抓。
   */
  const before30 = Date.now()
  const set30 = await ses(`/api/doc/${DOC2}/share`, { method: 'POST', body: JSON.stringify({ expiresInDays: 30 }) }, admin)
  const gap = Number(set30.json.share.expiresAt) - before30
  const elapsed = Date.now() - before30
  ok(gap > 29 * 86400000 && gap <= 30 * 86400000 + elapsed + 1000,
    '30 天有效期确实落在 30 天后', `${(gap / 86400000).toFixed(3)} 天（本次请求耗时 ${elapsed}ms）`)
  ok((await anon(`/api/public/doc/${DOC2}`)).status === 200, '没过期的能读')

  /**
   * 造一个**已经过期**的分享。
   *
   * 不用「设 1 天然后等一天」：有效期最短就是一天，等不起。
   * 直接改服务端那个库里的 expiresAt —— 这是唯一能在测试里
   * 表达「时间过去了」的办法，而且改的正是服务端读的那一列，
   * 不是在客户端造一个假状态。
   *
   * （服务端是另一个进程，但 SQLite 本身支持多连接写入，
   *   这里只做一次 UPDATE，不会和请求撞上。）
   */
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(DB)
  raw.exec('PRAGMA busy_timeout = 5000')
  raw.prepare('UPDATE doc_share SET expiresAt = ? WHERE docId = ?').run(Date.now() - 1000, DOC2)
  raw.close()

  const r = await anon(`/api/public/doc/${DOC2}`)
  ok(r.status === 403 && /过期/.test(String(r.json.error || '')), '过期后打不开', `${r.status} ${String(r.json.error).slice(0, 40)}`)

  const view = await ses(`/api/doc/${DOC2}/share`, {}, admin)
  ok(view.json.share.expired === true, '管理界面能看出「已过期」（否则作者不知道链接为什么打不开）')

  await ses(`/api/doc/${DOC2}/share`, { method: 'POST', body: JSON.stringify({ expiresInDays: 0 }) }, admin)
  ok((await anon(`/api/public/doc/${DOC2}`)).status === 200, '改成永不过期后又能读了')
}

console.log('\n== 允许下载是真的落库 ==')
{
  /**
   * 单独造一篇文档。
   * 上面那一节把 DOC 的限流计数打满了，而限流只在密码正确时清零 ——
   * 继续用同一篇的话，这一节的两条断言量到的会是 429，不是「下载开关」。
   * 每个小节自带素材，是这里唯一不会被上一个小节污染的做法。
   */
  const DOC3 = 'share_dl_' + Math.random().toString(36).slice(2, 8)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: DOC3, bookId: B.id, title: '下载开关探针', body: 'x', createdAt: Date.now(), updatedAt: Date.now() }] } }),
  }, admin)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: [{ id: DOC3, visibility: 'public' }] } }) }, admin)

  // 先设一个密码，好验证下面那次「只改下载」的局部更新不会把密码冲掉
  await ses(`/api/doc/${DOC3}/share`, { method: 'POST', body: JSON.stringify({ password: '下载开关探针' }) }, admin)
  const off = await ses(`/api/doc/${DOC3}/share`, { method: 'POST', body: JSON.stringify({ allowDownload: false }) }, admin)
  ok(off.json.share.allowDownload === false, '关掉下载：接口确认')
  /**
   * 这条是被浏览器实测逼出来的。
   *
   * 分享弹窗里「允许下载」是一个独立开关，它单独发一次
   * `{ allowDownload: false }`（不带 password）。而服务端原来把
   * 「没传 password」当成「密码置空」—— 于是**顺手把作者设好的
   * 访问密码清了**。
   *
   * 而且全程不报错：开关照样变、分享照样能打开，只是密码没了。
   * 作者要到「对方说链接打不开」才发现，而且想不通「我明明设过密码」。
   * 静默丢失比报错难查得多，所以单独钉一条。
   */
  ok(off.json.share.hasPassword === true, '**只改「允许下载」不会把访问密码清掉**（局部更新不是全量覆盖）')

  // 关键：换一个「进程」再问一次。组件局部 state 关掉弹窗就没了，
  // 所以必须验证它进了服务端 —— 这里靠重新拉一次（新的 HTTP 请求）来验。
  const reread = await ses(`/api/doc/${DOC3}/share`, {}, admin)
  ok(reread.json.share.allowDownload === false, '**重新拉一次仍然是关的** —— 不是组件局部 state')
  ok(reread.json.share.hasPassword === true, '重新拉一次密码也还在')
  ok((await anon(`/api/public/doc/${DOC3}`, {}, '下载开关探针')).status === 200, '密码仍能通过（说明确实没被清）')
  ok((await anon(`/api/public/doc/${DOC3}`)).status === 401, '不带密码仍然进不去')
  const dl = await anon(`/api/public/doc/${DOC3}`, {}, '下载开关探针')
  ok(dl.json.allowDownload === false, '匿名接口也告诉分享页「不许下载」', String(dl.json.allowDownload))

  await ses(`/api/doc/${DOC3}/share`, { method: 'POST', body: JSON.stringify({ allowDownload: true }) }, admin)
  ok((await ses(`/api/doc/${DOC3}/share`, {}, admin)).json.share.hasPassword === true, '打开下载后密码也还在')
  await ses(`/api/doc/${DOC3}/share`, { method: 'POST', body: JSON.stringify({ password: null }) }, admin)
}

console.log('\n== 越权：没有「分享」权限的人改不了 ==')
{
  const probeAccount = 'shareprobe_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: probeAccount, password: 'probe@2026', name: '分享探针' }),
  })
  const pt = reg.json.token || await login(probeAccount, 'probe@2026')
  ok(!!pt, '注册一个什么权限都没有的账号')

  const before = (await ses(`/api/doc/${DOC}/share`, {}, admin)).json.share
  const r = await ses(`/api/doc/${DOC}/share`, { method: 'POST', body: JSON.stringify({ password: '偷改一下' }) }, pt)
  ok(r.status === 403, '他改不了别人的分享设置', `${r.status} ${String(r.json.error).slice(0, 50)}`)
  const g = await ses(`/api/doc/${DOC}/share`, {}, pt)
  ok(g.status === 403, '他也读不到别人的分享设置', String(g.status))

  /*
   * 「密码有没有被偷改」直接比前后两次读到的状态。
   *
   * 这里特意**不**写成「拿原密码试一下能不能进」——
   * 上面那一节把限流打满了，正确口令此时也会返回 429，
   * 那种断言会变成「不等于 200 就算过」的析取式，看起来有内容、
   * 实际上恒真 —— 而恰恰是这种恒真断言最会骗人。
   */
  const after = (await ses(`/api/doc/${DOC}/share`, {}, admin)).json.share
  ok(after.hasPassword === before.hasPassword, '**密码状态没被他动过**', `${before.hasPassword} -> ${after.hasPassword}`)
  ok(after.allowDownload === before.allowDownload && after.expiresAt === before.expiresAt, '有效期和下载开关也没被顺手动过')
}

console.log('\n== 分享页留下访问痕迹 ==')
{
  await anon(`/api/public/doc/${DOC}`)
  const log = (await ses('/api/accesslog?days=1&limit=300', {}, admin)).json.items || []
  const hit = log.find((x) => x.docId === DOC)
  ok(!!hit, '匿名访问进了访问日志 —— 「这份对外文档被谁看过」正是复核要答的')
  ok(hit?.userId === 'public', '记成 public（访客没有账号，记 IP 那一侧）', String(hit?.userId))
}

console.log('\n== 回收站里的文档不对外 ==')
{
  await setVis('public')
  await setBookPublic(true)
  const trashDoc = 'share_trash_' + Math.random().toString(36).slice(2, 8)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: trashDoc, bookId: B.id, title: '删掉的对外文档', body: 'x', createdAt: Date.now(), updatedAt: Date.now() }] } }),
  }, admin)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: [{ id: trashDoc, visibility: 'public' }] } }) }, admin)
  const before = await anon(`/api/public/doc/${trashDoc}`)
  ok(before.status === 200, '删之前可以读')
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [trashDoc] } }) }, admin)
  const after = await anon(`/api/public/doc/${trashDoc}`)
  ok(after.status === 404, '删掉之后是 404（不是 403 —— 那等于确认它曾经存在过）', String(after.status))
  await ses(`/api/doc/${trashDoc}/restore`, { method: 'POST' }, admin)
}

console.log('\n== 审计留痕，且不含密码 ==')
{
  await ses(`/api/doc/${DOC}/share`, { method: 'POST', body: JSON.stringify({ password: '审计探针口令' }) }, admin)
  const items = (await ses('/api/audit?action=doc.share&limit=50', {}, admin)).json.items || []
  ok(items.length > 0, `改了分享设置就记审计（${items.length} 条）`)
  const raw = JSON.stringify(items)
  ok(!/审计探针口令/.test(raw), '**审计里没有明文密码**')
  const one = items[0]
  ok(one?.detail?.passwordSet === true, '记了「设了密码」这个状态变化', JSON.stringify(one?.detail))
  ok(one?.actorId && String(one.actorId).length > 0, '记了是谁改的')
}

console.log('\n== 前端：链接必须是真的 ==')
{
  const src = readFileSync('src/pages/DocPage.tsx', 'utf8')
  // 精确盯旧代码那一行，别去扫全文：
  // 文档里必须留着「原来是假链接」的说明，而别处（文档设置里的 slug 输入框）
  // 还有一个写死的 yuque.com 前缀，那是另一个控件，不归这条断言管。
  ok(!/setLink\(`https:\/\/www\.yuque\.com/.test(src), '分享链接不再指向写死的 yuque.com')
  ok(!/useState\(`https:\/\/www\.yuque\.com/.test(src), '也没有在别处偷偷留一个写死链接')
  ok(src.includes('/#/public/doc/'), '指向本机的分享页地址')

  const pub = readFileSync('src/pages/PublicDoc.tsx', 'utf8')
  ok(pub.includes('location.origin'), '分享页自己也按 origin 生成链接（部署在子路径下也对）')
  ok(pub.includes("method: 'POST'") && /JSON\.stringify\(\{\s*password:/.test(pub), '密码走 POST 的 JSON body')
  ok(!pub.includes('X-YQ-Share-Password'), '**不用请求头** —— 头是 ByteString，中文口令根本发不出去')
  ok(!/[?&]pwd=/.test(pub), '也不用 query —— 会进浏览器历史和 Referer')

  /**
   * 卡片缺失这件事，分享页上**必须看得见**（2026-10-06 加）。
   *
   * 之前 `blocks-markdown.ts` 的注释写着「分享页有写」——
   * 指的是写在**代码注释和 README** 里，页面上其实一句都没有。
   * 服务端明明已经把 `blocks` 发过来了（`/api/public/doc/:id` 里有一行
   * 「blocks 是正文真正的来源」），而这一页只收 body、只渲染 body，
   * 于是卡片在分享页上变成一片空缺，**访客看不到任何解释**。
   *
   * 这些是源码级断言（这一节本来就是源码级的）：
   * 真正跑浏览器验「页面上确实出现那句话」的是一次探针，结论是
   * 「正文两段都在 + 说明出现 + 点名卡片名 + 用访客能懂的下一步」，7/7。
   * 浏览器验不放在这个套件里，是因为它要动 b1 的 publicAccess，
   * 而这个套件本身就在切那个开关 —— 两者一起跑会把顺序耦合进来。
   */
  ok(/withCardNotices\(\s*state\.doc\.body,\s*state\.doc\.blocks/.test(pub.replace(/\s+/g, ' ')),
    '分享页把 body 和 blocks 一起交给 withCardNotices（不是只渲染 body）')
  ok(pub.includes('blocks?: Block[]'), 'Doc 类型里补上了 blocks —— 服务端早就发了，前端原来没接')
  ok(/索取站内链接/.test(pub), '用的是访客能懂的下一步（「到站内查看 / 整包导出」对外人做不到）')
  const md = readFileSync('src/lib/blocks-markdown.ts', 'utf8')
  ok(/withCardNotices\([\s\S]*?hint\s*=/.test(md), 'withCardNotices 的最后一句是可传入的（分享页那一档与导出不同）')
  ok(/不随纯文本一起走/.test(md), '共用那句不再提「Markdown 导出」—— 分享页上那句话是错的')
}

console.log('\n== 分享页路由确实绕开了登录闸门 ==')
{
  const app = readFileSync('src/App.tsx', 'utf8')
  ok(/pathname\.startsWith\('\/public\/'\)/.test(app), 'App 对 /public/ 路径直接渲染分享页')
  const i = app.indexOf("startsWith('/public/')")
  const tail = app.slice(i, i + 400)
  ok(!/AppGate/.test(tail.split('function AppShell')[0]), '这条分支上**没有** AppGate（否则访客只会看到登录页）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
