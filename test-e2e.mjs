/* ============================================================
   端到端：两个真人（两个独立浏览器上下文）协同验证
   ------------------------------------------------------------
   刻意用两个 browser context 而不是两个标签页：
   标签页共享 localStorage，而这里要验证的正是
   「数据不再只活在一个浏览器里」。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 20000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 25000 })
}

const store = (page, fn) => page.evaluate(fn)

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  console.log('\n== 登录闸门 ==')
  const ctxA = await browser.newContext()
  const A = await ctxA.newPage()
  A.on('console', (m) => { if (m.type() === 'error') console.log('   [A console]', m.text().slice(0, 160)) })

  await login(A, process.env.ADMIN_ACCOUNT || 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  ok(await A.locator('.yq-app').count() > 0, '管理员登录后进入应用')

  const mode = await A.evaluate(() => (window).__yqMode?.() || 'n/a')
  console.log('   模式探测 =', mode)

  console.log('\n== 数据来自服务端而不是 localStorage ==')
  // 清掉本地存储再刷新，应当仍然有 26 篇文档 —— 说明是服务端灌的
  await A.evaluate(() => localStorage.removeItem('yuque-clone-data-v1'))
  await A.reload({ waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-app', { timeout: 25000 })
  await A.waitForTimeout(1200)
  const docCount = await A.evaluate(() => Object.keys(window.__yqStore.getState().docs).length)
  // 不写死 26：跑 test:all 时前面的套件可能已经新建过文档，
  // 精确计数会变成顺序依赖的假失败。这里要验的是「本地缓存清空后数据还在」。
  ok(docCount >= 26, `清掉本地缓存刷新后文档仍在（>=26 篇，实得 ${docCount}）`, String(docCount))

  const bookCount = await A.evaluate(() => window.__yqStore.getState().books.length)
  ok(bookCount >= 4, `知识库仍在（>=4 个，实得 ${bookCount}）`, String(bookCount))

  console.log('\n== 登录隔离 ==')
  const acct = `e2e_${suffix}`
  const reg = await A.request.post(`${BASE}/api/auth/register`, {
    data: { account: acct, password: 'test1234', name: '测试同事' },
  })
  ok(reg.ok(), '注册第二个账号', String(reg.status()))

  // 管理员把他加进 b1
  const uid = (await reg.json()).user.id
  const add = await A.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${await A.evaluate(() => localStorage.getItem('yq_token'))}` },
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } },
  })
  ok(add.ok(), '把同事加进知识库 b1')

  const ctxB = await browser.newContext()
  const B = await ctxB.newPage()
  await login(B, acct, 'test1234')
  const bDocs = await B.evaluate(() => window.__yqStore.getState().docs.length === 0 ? 0 : Object.keys(window.__yqStore.getState().docs).length)
  ok(bDocs > 0, '同事登录后能看到该知识库的文档', String(bDocs))
  const bBooks = await B.evaluate(() => window.__yqStore.getState().books.map((b) => b.id))
  ok(JSON.stringify(bBooks) === '["b1"]', '同事只看到被授权的 1 个知识库', JSON.stringify(bBooks))

  console.log('\n== 跨设备：A 改，B 收到 ==')
  await A.evaluate(() => {
    const s = window.__yqStore.getState()
    s.updateDoc('d1', { title: 'A 在另一台电脑上改的标题' })
  })
  // 等 A 推上去 + B 轮询拉到
  await A.waitForTimeout(2500)
  await B.evaluate(() => window.dispatchEvent(new Event('focus')))
  await B.waitForTimeout(2500)
  const bTitle = await B.evaluate(() => window.__yqStore.getState().docs.d1?.title)
  ok(bTitle === 'A 在另一台电脑上改的标题', 'B 收到了 A 的修改', `B看到=[${bTitle}]`)

  console.log('\n== 服务端权威：刷新后仍在 ==')
  const ctxC = await browser.newContext()
  const C = await ctxC.newPage()
  await login(C, acct, 'test1234')
  await C.waitForTimeout(1200)
  const cTitle = await C.evaluate(() => window.__yqStore.getState().docs.d1?.title)
  ok(cTitle === 'A 在另一台电脑上改的标题', '换一台「设备」登录仍能看到', `C看到=[${cTitle}]`)

  console.log('\n== 权限：只读成员不能改 ==')
  const acct2 = `e2e_ro_${suffix}`
  const reg2 = await A.request.post(`${BASE}/api/auth/register`, { data: { account: acct2, password: 'test1234', name: '只读同事' } })
  const uid2 = (await reg2.json()).user.id
  await A.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${await A.evaluate(() => localStorage.getItem('yq_token'))}` },
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid2, role: 'reader', perms: { read: true, comment: true, edit: false, create: false, export: true, share: false }, joinedAt: Date.now() }] } },
  })
  const ctxD = await browser.newContext()
  const D = await ctxD.newPage()
  await login(D, acct2, 'test1234')
  const dSees = await D.evaluate(() => Object.keys(window.__yqStore.getState().docs).length)
  ok(dSees > 0, '只读成员能看到文档', String(dSees))

  const before = await A.evaluate(() => window.__yqStore.getState().docs.d1.title)
  await D.evaluate(() => {
    const s = window.__yqStore.getState()
    s.updateDoc('d1', { title: '只读成员的越权修改' })
  })
  await D.waitForTimeout(2500)
  const after = await A.evaluate(async () => {
    const r = await fetch('/api/doc/d1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('yq_token') } })
    return (await r.json()).doc.title
  })
  ok(after === before, '只读成员的修改没有落库（服务端拒绝）', `期望=[${before}] 实际=[${after}]`)

  console.log('\n== 实时协同通道 ==')
  // A 与 B 同时打开同一篇文档，检查服务端确实建立了房间
  await A.goto(`${BASE}/#/book/b1/doc/d1`, { waitUntil: 'domcontentloaded' })
  await B.goto(`${BASE}/#/book/b1/doc/d1`, { waitUntil: 'domcontentloaded' })
  await A.waitForTimeout(3000)
  const health = await (await A.request.get(`${BASE}/api/health`)).json()
  const room = (health.online || []).find((r) => r.docId === 'd1')
  ok(!!room, '服务端为 d1 建立了协作房间', JSON.stringify(health.online))
  ok(room && room.members.length >= 2, '房间里至少两个人在线', room ? String(room.members.length) : '0')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
