/* ============================================================
   团队空间：建得出来、拉得进人，而且**真能用**
   ------------------------------------------------------------
   以前**根本没有「新建空间」这个动作**。空间只有两个来源：
   种子数据，和注册 / 统一认证时自动开的那一个个人空间。
   于是真实部署里永远建不出「研发部」这种团队空间，
   「空间 → 知识库 → 文稿」的三级在非演示场景下塌成了两级。

   还有一个更隐蔽的坑：`space_members` **不在同步实体清单里**。
   如果让客户端直接推 spaces 行，空间会建出来、成员行却永远不会存在 ——
   服务端 `capsInSpace` 判不到成员，于是「谁建的谁进不去」，
   界面上看着建好了，一点进去全是空的。

   空间建出来之后还有两个空壳：
   1. 空间头写「N 成员」，而服务端的 spaces 行里**没有 memberCount 字段** → 永远是空白；
   2. 没有任何拉人进空间的入口 → 团队空间永远只有建的人一个，
      退化成「一个只有自己能进的文件夹」。

   所以这个套件验：建得出来、建的人**真的有权限**、能把别人拉进来、
   拉进来的人**真的看得到知识库**、移除会真的收回权限、重启后还在。
   ============================================================ */

import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = process.env.SPACE_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_space-${Date.now().toString(36)}.db`
const PW = 'space-test@2026'
const SUF = Date.now().toString(36)

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
const json = async (p, opt = {}) => {
  const res = await fetch(BASE + p, opt)
  const t = await res.text()
  try { return { status: res.status, data: t ? JSON.parse(t) : null } } catch { return { status: res.status, data: null } }
}
const post = (p, body, tk) => json(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
  body: JSON.stringify(body || {}),
})

try {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* 等 */ }
  }

  console.log('\n== 接口层 ==')
  const admin = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const T = admin.token
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }

  const empty = await post('/api/spaces', { name: '' }, T)
  ok(empty.status === 400, '空名字被拒', String(empty.status))
  const noAuth = await post('/api/spaces', { name: '没登录就不该建' })
  ok(noAuth.status === 401, '没登录建不了空间', String(noAuth.status))

  const made = await post('/api/spaces', { name: `研发部 ${SUF}`, desc: '我们的团队空间' }, T)
  ok(made.status === 200 && !!made.data?.space?.id, '能建出团队空间', JSON.stringify(made.data).slice(0, 100))
  ok(made.data?.space?.kind === 'team', 'kind 是 team（不是 personal）', String(made.data?.space?.kind))
  const sid = made.data.space.id

  console.log('\n== 建的人进得去（这才是关键）==')
  // 在这个空间里建一个知识库 —— 如果 space_members 没写进去，capsInSpace 会判 NONE
  const book = (await post('/api/sync/push', {
    upsert: { books: [{ id: 'b_in_team', spaceId: sid, name: '组内库', desc: '', avatar: '📗', visibility: 'private', docCount: 0, wordCount: 0, createdAt: 1, updatedAt: 1 }] },
    remove: {},
  }, T)).status
  ok(book === 200, '在这个空间里能建知识库（说明他确实是空间成员）', String(book))
  const boot = (await json('/api/bootstrap?lite=0', { headers: H })).data
  ok((boot.data.books || []).some((b) => b.id === 'b_in_team'), '这个知识库出现在他的数据里（没被权限过滤掉）', JSON.stringify((boot.data.books || []).map((b) => b.id)))

  console.log('\n== 空间成员：拉得进人 ==')
  // 注意：admin 已经被 `.data` 解包过一次了，这里直接取 user
  const adminId = admin.user?.id
  ok(!!adminId, '拿得到自己的 userId（后面要用它验「最后一个拥有者移不走」）', String(adminId))

  // 注册一个局外人。他注册时会自带一个个人空间，但**不在**这个团队空间里。
  const outReg = await post('/api/auth/register', { account: `sp_out_${SUF}`, password: 'test1234', name: `新人${SUF}` })
  const outUid = outReg.data?.user?.id
  const outT = outReg.data?.token
  ok(!!outUid && !!outT, '注册出第二个账号', JSON.stringify(outReg.data).slice(0, 120))

  // 再注册一个「永远不进这个空间」的人：他就是「添加成员」弹窗里该出现的候选人。
  // 不建他的话，公司里所有账号都已在空间里，弹窗只会显示空态，
  // 候选人这一段就等于没测。
  const candReg = await post('/api/auth/register', { account: `sp_cand_${SUF}`, password: 'test1234', name: `候选${SUF}` })
  const candUid = candReg.data?.user?.id
  ok(!!candUid, '注册出第三个账号当候选人', JSON.stringify(candReg.data).slice(0, 100))

  const denied = await json(`/api/spaces/${sid}/members`, { headers: { Authorization: 'Bearer ' + outT } })
  ok(denied.status === 403, '不是空间成员的人看不到名册（别让人试探空间里都有谁）', String(denied.status))

  const added = await post(`/api/spaces/${sid}/members`, { userIds: [outUid], role: 'member' }, T)
  ok(added.data?.ok === true && added.data.added?.length === 1, '能把他加进空间', JSON.stringify(added.data).slice(0, 160))
  // 空间成员身份本身不给任何书的读权限，不补 book_members 的话他进来是一片空白
  ok(added.data?.added?.[0]?.grantedBooks === 1, '顺带补上了组内库的只读身份（他打开才不会是一片空白）', JSON.stringify(added.data?.added))

  const roster = (await json(`/api/spaces/${sid}/members`, { headers: H })).data
  ok(roster.members?.length === 2, '名册里是 2 个人', String(roster.members?.length))
  ok(roster.isAdmin === true, '建空间的人在名册里是管理员')
  ok(roster.members?.some((m) => m.userId === outUid && m.role === 'member'), '新成员在名册里，角色是 member')
  ok(roster.members?.every((m) => !!m.name && !!m.account), '名册带得出名字和账号（不是一列裸 id）', JSON.stringify(roster.members))

  console.log('\n== 拉进来的人真的用得上 ==')
  const outBooks = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + outT } })).data
  ok((outBooks.data.books || []).some((b) => b.id === 'b_in_team'), '他能看到组内知识库（加空间成员是真给了权限）', JSON.stringify((outBooks.data.books || []).map((b) => b.id)))
  const outSpaces = (outBooks.data.spaces || []).some((s) => s.id === sid)
  ok(outSpaces, '团队空间出现在他的空间列表里')

  const deniedAdd = await post(`/api/spaces/${sid}/members`, { userIds: [outUid] }, outT)
  ok(deniedAdd.status === 403, '普通成员不能再往空间里拉人', String(deniedAdd.status))
  const outRoster = await json(`/api/spaces/${sid}/members`, { headers: { Authorization: 'Bearer ' + outT } })
  ok(outRoster.data?.isAdmin === false, '普通成员看到自己是 isAdmin=false（前端据此不显示「添加成员」）', String(outRoster.data?.isAdmin))

  console.log('\n== 批量添加：一部分失败要如实分开报 ==')
  const mixed = await post(`/api/spaces/${sid}/members`, { userIds: [outUid, `u_不存在的_${SUF}`], role: 'member' }, T)
  ok(mixed.data?.added?.length === 1 && mixed.data?.failed?.length === 1, '成功的和失败的分开列出来', JSON.stringify(mixed.data).slice(0, 200))
  ok(mixed.data?.ok === false, '有人失败时 ok 必须是 false（不能前端弹一句「添加成功」）', String(mixed.data?.ok))

  console.log('\n== 移出会真的收回权限 ==')
  const rm = (await json(`/api/spaces/${sid}/members/${outUid}`, { method: 'DELETE', headers: H })).data
  ok(rm.removed === 1, '能把他移出空间', JSON.stringify(rm))
  ok(rm.clearedBooks >= 1, '同时收回了他在书里的身份（不然名册里没人了、书却还开着）', String(rm.clearedBooks))
  const afterRm = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + outT } })).data
  ok(!(afterRm.data.books || []).some((b) => b.id === 'b_in_team'), '移出之后他真的看不到了', JSON.stringify((afterRm.data.books || []).map((b) => b.id)))
  const gone = await json(`/api/spaces/${sid}/members`, { headers: { Authorization: 'Bearer ' + outT } })
  ok(gone.status === 403, '移出之后名册也看不到了')

  console.log('\n== 最后一个拥有者移不走 ==')
  const lastOwner = await json(`/api/spaces/${sid}/members/${adminId}`, { method: 'DELETE', headers: H })
  ok(lastOwner.status === 400, '移走最后一个拥有者被拒（不然这个空间谁都管不了了）', String(lastOwner.status))
  const stillThere = (await json(`/api/spaces/${sid}/members`, { headers: H })).data
  ok(stillThere.members?.some((m) => m.userId === adminId && m.role === 'owner'), '拥有者还在名册里')

  // 把新人加回来，留给后面的界面段用
  await post(`/api/spaces/${sid}/members`, { userIds: [outUid], role: 'member' }, T)

  console.log('\n== 重启之后还在 ==')
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 800))
  const kid2 = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* 等 */ }
  }
  const admin2 = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const boot2 = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + admin2.token } })).data
  ok((boot2.data.spaces || []).some((s) => s.id === sid), '重启后团队空间还在（真的落库了）', JSON.stringify((boot2.data.spaces || []).map((s) => s.name)))
  ok((boot2.data.books || []).some((b) => b.id === 'b_in_team'), '重启后组内知识库还在')
  // 成员名册是另一张表：空间和书都还在、但人没了的话，
  // 这个空间当场变成没人进得去的空壳 —— 所以要单独验
  const roster2 = (await json(`/api/spaces/${sid}/members`, { headers: { Authorization: 'Bearer ' + admin2.token } })).data
  ok(roster2.members?.length === 2, '重启后空间成员名册还在（2 个人）', String(roster2.members?.length))
  ok(roster2.members?.some((m) => m.userId === outUid), '重启后新成员还在（他没被踢出去）')
  try { kid2.kill() } catch { /* 已退出 */ }

  console.log('\n== 界面上有入口 ==')
  const kid3 = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* 等 */ }
  }
  const br = await chromium.launch()
  const p = await (await br.newContext()).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(2000)
  const firstSpace = (await p.evaluate(() => window.__yqStore.getState().spaces[0]?.id))
  await p.goto(`${BASE}/#/space/${firstSpace}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-space-hero-actions', { timeout: 25000 })
  await p.waitForTimeout(1200)
  ok((await p.locator('button:has-text("新建空间")').count()) === 1, '空间页上有「新建空间」按钮')

  // 真点一次（window.prompt 用原生对话框，Playwright 收得到 event）
  const name = `界面建的 ${SUF}`
  p.once('dialog', (d) => d.accept(name))
  await p.click('button:has-text("新建空间")')
  await p.waitForTimeout(2500)
  const madeByUi = await p.evaluate((n) => window.__yqStore.getState().spaces.some((s) => s.name === n), name)
  ok(madeByUi, '点一下真的建出了团队空间', name)
  const kind = await p.evaluate((n) => window.__yqStore.getState().spaces.find((s) => s.name === n)?.kind, name)
  ok(kind === 'team', '建出来的是团队空间', String(kind))

  console.log('\n== 侧栏的文档数是真数 ==')
  const docCount = await p.evaluate(() => Object.keys(window.__yqStore.getState().docs || {}).length)
  const shown = (await p.locator('.yq-sidenav-item:has-text("文档")').textContent().catch(() => '')) || ''
  ok(!/\d/.test(shown.replace(/文档/, '')), `侧栏不再写死一个数字（库里 ${docCount} 篇，显示「${shown.trim()}」）`, shown.trim())

  /*
   * 空间页的头部：成员数是真数。
   *
   * ⚠️ 这段**必须留在空间页** —— 它读的是 `.yq-space-hero-stats`，
   * 那是空间页的头部统计条；成员管理搬去设置页之后这里并不变。
   * 跟着后面那段一起搬到设置页，断言就变成「在设置页上找空间页的元素」，
   * 永远为空、也永远红。
   */
  await p.goto(`${BASE}/#/space/${sid}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-space-hero-actions', { timeout: 25000 })
  await p.waitForTimeout(900)

  // 用接口取同一个空间的名册做基准，不写死人数：
  // 套件会反复跑，人数跟着前面的动作变，断言要对得上服务端那份
  const apiRoster = await p.evaluate(async (id) => {
    const t = localStorage.getItem('yq_token') || ''
    const r = await fetch('/api/spaces/' + id + '/members', { headers: { Authorization: 'Bearer ' + t } })
    return (await r.json()).members.length
  }, sid)

  // 以前这里写的是 {space?.memberCount}，而服务端 spaces 行里根本没这个字段 → 永远空白。
  // 只取「成员」那一个 span：拿整行去匹配数字是**测不出来的** ——
  // 同一行里还有「0 文档0 总字数」，数字照样有，断言照样绿。
  const memStat = (await p.locator('.yq-space-hero-stats > span').filter({ hasText: '成员' }).first().textContent().catch(() => '')) || ''
  const memNum = memStat.replace(/成员/, '').trim()
  ok(/^\d+$/.test(memNum), `空间头「成员」前面是一个真数字（显示「${memStat.trim()}」）`, memStat.trim())
  ok(memNum === String(apiRoster), `空间头写的 ${memNum} 和名册里的 ${apiRoster} 个人一致（不是写死的数）`, `${memNum} vs ${apiRoster}`)

  console.log('\n== 空间设置「成员」标签上的是真名单 ==')
  /*
   * 2026-10-17：成员管理从**空间页正文**搬到了
   * `/space/:id/settings` 的「成员」标签（照真实语雀「空间管理 → 空间设置」的分层）。
   *
   * 搬完这里必须跟着改 —— 否则 `waitForSelector('.yq-space-members')`
   * 超时，**后面十几条断言一条都不跑**，套件却只报 1 条失败，
   * 看起来像「少测了一项」，实际上是「整段没测」。
   * （那次就出现了断言数从 49 掉到 37：12 条静默消失。）
   *
   * `?tab=members` 是从空间页那行「空间成员（N）→」链过来的，
   * 所以这里也顺带验了「URL 上的标签真的生效」。
   */
  await p.goto(`${BASE}/#/space/${sid}/settings?tab=members`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-space-members', { timeout: 15000 })
  await p.waitForTimeout(600)
  ok((await p.locator('.yq-space-members').count()) === 1,
    '带 ?tab=members 进来时停在「成员」标签（不是「基本信息」）')

  const rows = await p.locator('.yq-space-member:not(.yq-space-member-head)').count()
  ok(rows === apiRoster, `界面上列出 ${rows} 行，和接口的 ${apiRoster} 个人对得上`)

  // 空间成员身份本身不给读权限，不补只读身份的话新人进来是一片空白
  const grantText = (await p.locator('.yq-space-members-note-text').textContent().catch(() => '')) || ''
  ok(grantText.includes('只读') && grantText.includes('新建'), '把「新成员只拿到现有库的只读身份、之后新建的库不会自动带上」写在了界面上', grantText.replace(/\s+/g, ' ').trim().slice(0, 90))

  const hasAddBtn = await p.locator('button:has-text("添加成员")').count()
  ok(hasAddBtn >= 1, '空间管理员看得到「添加成员」入口')
  await p.click('button:has-text("添加成员")')
  await p.waitForSelector('.yq-space-pick-list', { timeout: 10000 })
  // 候选人里应该有那个「注册了但没进空间」的人。
  // 断言他的名字而不是「列表非空」：列表里全是已在空间的人也算非空，
  // 但那说明候选人是算错了 —— 和之前 book_members 那个坑是同一类。
  const pickText = (await p.locator('.yq-space-pick-list').textContent().catch(() => '')) || ''
  ok(pickText.includes(`候选${SUF}`), '弹窗里列得出「注册了但还没进空间」的那个人', pickText.replace(/\s+/g, ' ').trim().slice(0, 80))
  ok(!pickText.includes(`新人${SUF}`), '已经在空间里的人不会出现在候选人里（不重复加）')

  // 自己的那一行不给可点的移除 —— 上面用另一个身份验的是「最后 owner 禁用」那条分支
  ok((await p.locator('.yq-space-member:has-text("我") .yq-space-member-remove').count()) === 0,
    '自己那一行没有可点的「移除」（不能把自己踢出空间）')

  // 真的把这个候选人加进去：点得到、选得上、名单真的会变
  await p.click(`.yq-space-pick-item:has-text("候选${SUF}")`)
  await p.click('.yq-modal-footer button:has-text("确认添加")')
  await p.waitForTimeout(1800)
  const rowsAfter = await p.locator('.yq-space-member:not(.yq-space-member-head)').count()
  ok(rowsAfter === rows + 1, `确认添加后名单从 ${rows} 行变成 ${rowsAfter} 行`, `${rows} → ${rowsAfter}`)
  const afterText = (await p.locator('.yq-space-members').textContent().catch(() => '')) || ''
  ok(afterText.includes(`候选${SUF}`), '新成员真的出现在名册里')

  /**
   * 「最后一个拥有者移不走」这个禁用按钮，只有在**别人**看 owner 行时才渲染 ——
   * 自己看自己那一行，代码走的是「不能移除自己」那一条分支。
   * 造这个场景：把新人提成空间管理员，用他的身份登进来，
   * 他看到的 owner 行是别人的，而且全空间只剩那一个 owner。
   */
  await p.evaluate(async ({ sid, uid, tok }) => {
    await fetch('/api/spaces/' + sid + '/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ userIds: [uid], role: 'admin' }),
    })
  }, { sid, uid: outUid, tok: T })
  await p.waitForTimeout(800)

  const ctx2 = await br.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p2.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p2.fill('.yq-login-card input[autocomplete="username"]', `sp_out_${SUF}`)
  await p2.fill('.yq-login-card input[type="password"]', 'test1234')
  await p2.click('.yq-login-submit')
  await p2.waitForSelector('.yq-app', { timeout: 30000 })
  await p2.waitForTimeout(1500)
  await p2.goto(`${BASE}/#/space/${sid}/settings?tab=members`, { waitUntil: 'domcontentloaded' })
  await p2.waitForSelector('.yq-space-members', { timeout: 15000 })
  await p2.waitForTimeout(600)

  const ownerRow = p2.locator('.yq-space-member:has-text("拥有者")').first()
  ok((await ownerRow.count()) === 1, '以空间管理员身份进来，看得到拥有者那一行')
  ok((await ownerRow.locator('.yq-space-member-remove:disabled').count()) === 1,
    '全空间只剩一个拥有者时，那一行的「移除」是禁用的（不用等点了才报 400）')
  ok((await p2.locator('button:has-text("添加成员")').count()) >= 1, '空间管理员也看得到「添加成员」')

  await br.close()
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { kid.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) { try { rmSync(DB + s) } catch { /* 删不掉就算了 */ } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
