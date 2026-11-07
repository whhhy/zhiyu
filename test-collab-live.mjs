/* ============================================================
   跨设备实时协同验证
   ------------------------------------------------------------
   这一项是语雀最核心的价值主张，也是原版 README 明确说「做不到」的地方。
   所以单独用**两个独立浏览器上下文**验证：
     · A 的光标要出现在 B 的画面里（带名字标签）
     · 协作条人数要是 2（真实在场，不是模拟协作者）
     · A 打字 B 立刻看到（走 WebSocket，不等轮询）
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const DOC = 'd1'
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

const openDoc = async (page) => {
  await page.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-block', { timeout: 20000 })
  await page.waitForTimeout(1500)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)
let adminToken = null

try {
  // 准备两个账号
  const ctx0 = await browser.newContext()
  const p0 = await ctx0.newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  adminToken = await p0.evaluate(() => localStorage.getItem('yq_token'))

  const mk = async (role) => {
    const acct = `collab_${role}_${suffix}`
    const r = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: role === 'A' ? '甲同事' : '乙同事' } })
    const uid = (await r.json()).user.id
    await p0.request.post(`${BASE}/api/sync/push`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } },
    })
    return acct
  }
  const acctA = await mk('A')
  const acctB = await mk('B')

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const A = await ctxA.newPage()
  const B = await ctxB.newPage()
  A.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) console.log('   [A err]', m.text().slice(0, 100)) })
  B.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) console.log('   [B err]', m.text().slice(0, 100)) })

  await login(A, acctA, 'test1234')
  await login(B, acctB, 'test1234')

  console.log('\n== 两端同时打开同一篇文档 ==')
  await Promise.all([openDoc(A), openDoc(B)])
  await A.waitForTimeout(2500)

  const wsOf = (p) => p.evaluate(() => (window).__yqWsState?.() || 'n/a')

  // 服务端在场名单
  const health = await (await A.request.get(`${BASE}/api/health`)).json()
  const room = (health.online || []).find((r) => r.docId === DOC)
  ok(!!room && room.members.length >= 2, '服务端房间里有 2 个真人', room ? JSON.stringify(room.members.map((m) => m.name)) : '无房间')

  const countA = await A.locator('.yq-doc-collab-count').textContent().catch(() => '')
  const countB = await B.locator('.yq-doc-collab-count').textContent().catch(() => '')
  console.log(`   A 协作条: ${countA}   B 协作条: ${countB}`)
  ok(/2\s*人/.test(countA || ''), 'A 看到「2 人正在协作」', countA || '')
  ok(/2\s*人/.test(countB || ''), 'B 看到「2 人正在协作」', countB || '')

  console.log('\n== A 打字，B 实时看到（不等轮询） ==')
  const beforeB = await B.evaluate((d) => window.__yqStore.getState().docs[d]?.blocks.map((b) => b.text).join('|'), DOC)
  await A.evaluate((d) => {
    const s = window.__yqStore.getState()
    const doc = s.docs[d]
    s.setDocBlocks(d, doc.blocks.map((b, i) => (i === 1 ? { ...b, text: b.text + '【A补的一句】' } : b)))
  }, DOC)
  // 故意只等 1.2 秒：轮询是 8 秒一次，所以只要能看到就一定是 WebSocket 送的
  await B.waitForTimeout(1200)
  const afterB = await B.evaluate((d) => window.__yqStore.getState().docs[d]?.blocks.map((b) => b.text).join('|'), DOC)
  ok(afterB !== beforeB && String(afterB).includes('【A补的一句】'),
    'B 在 1.2 秒内收到 A 的编辑（WebSocket，不是轮询）', String(afterB).slice(0, 120))

  console.log('\n== 协作光标（跨设备 overlay） ==')
  // 必须走**真实选中**：光标广播是挂在 selectionchange 上的，
  // 直接调 store.setCursor 只会改本地状态，不会发消息 —— 那样测的是假东西。
  const target = A.locator('.yq-block').nth(2)
  await target.click()
  await A.waitForTimeout(400)
  // 用 Range 选中块内前几个字，等价于用户拖选
  await A.evaluate(() => {
    const el = document.querySelectorAll('.yq-block')[2]
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const tn = walker.nextNode()
    if (!tn || !tn.textContent || tn.textContent.length < 2) return
    const r = document.createRange()
    r.setStart(tn, 0)
    r.setEnd(tn, Math.min(4, tn.textContent.length))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await A.waitForTimeout(500)
  const aLocal = await A.evaluate((d) => window.__yqStore.getState().cursors.filter((c) => c.docId === d).length, DOC)
  console.log(`   A 本地已记录的远端光标数: ${aLocal}`)

  await A.waitForTimeout(4000)
  const cursorB = await B.evaluate((d) => {
    const cs = window.__yqStore.getState().cursors.filter((c) => c.docId === d)
    return cs.map((c) => ({ memberId: c.memberId, blockId: c.blockId, range: c.range }))
  }, DOC)
  ok(Array.isArray(cursorB) && cursorB.length > 0, 'B 收到了 A 的协作光标', JSON.stringify(cursorB))

  const cursorEls = await B.locator('.yq-collab-cursor').count()
  const cursorLabels = await B.locator('.yq-collab-cursor-label').allTextContents().catch(() => [])
  console.log(`   B 画面上的光标元素数: ${cursorEls}  标签: ${JSON.stringify(cursorLabels)}`)
  ok(cursorEls > 0, 'B 画面上真的画出了光标', String(cursorEls))

  console.log('\n== 演示模式不应在服务端形态下自动开启 ==')
  const demoOn = await A.evaluate(() => window.__yqStore.getState().cursors.filter((c) => c.memberId === 'demo' || String(c.memberId).startsWith('sim')).length)
  ok(demoOn === 0, '没有混入模拟协作者', String(demoOn))

  console.log('\n== 协作退出后正文不能被改坏 ==')
  // 曾经服务端把快照 {blocks,title} 整个写进 docs.blocks，
  // 触发时机是「房间空了 + 5 秒后刷盘」，平时根本复现不出来。
  // 这里主动关掉页面等它刷完，再验正文仍然是数组。
  const blocksBefore = await (await A.request.get(`${BASE}/api/doc/${DOC}`, {
    headers: { Authorization: `Bearer ${await A.evaluate(() => localStorage.getItem('yq_token'))}` },
  })).json()
  ok(Array.isArray(blocksBefore.doc.blocks), '退出前正文是数组', typeof blocksBefore.doc.blocks)

  await Promise.all([A.close(), B.close()])
  await new Promise((r) => setTimeout(r, 7000))
  const afterLeave = await (await ctxA.request.get(`${BASE}/api/doc/${DOC}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json()
  ok(Array.isArray(afterLeave.doc.blocks), '两人退出、正文仍然完好（没被快照覆盖）',
    typeof afterLeave.doc.blocks === 'object' ? JSON.stringify(afterLeave.doc.blocks).slice(0, 80) : String(afterLeave.doc.blocks))
  ok(afterLeave.doc.blocks.length > 0, '块数没有变空', String(afterLeave.doc.blocks?.length))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  try { await browser.close() } catch { /* 已关闭 */ }
}

process.exit(fail ? 1 : 0)
