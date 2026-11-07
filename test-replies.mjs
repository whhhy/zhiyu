/* 评论回复跨设备验证
   曾经有个静默的数据丢失：回复嵌套在父评论里，服务端按行同步时
   replies 不在评论的可写列里，于是「回复发出去了，刷新就没了」。 */

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
  await page.waitForTimeout(1200)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const adminToken = await p0.evaluate(() => localStorage.getItem('yq_token'))

  const acct = `rep_${suffix}`
  const r = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: '回复同事' } })
  const uid = (await r.json()).user.id
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } },
  })

  const A = await (await browser.newContext()).newPage()
  const B = await (await browser.newContext()).newPage()
  await login(A, acct, 'test1234')
  await login(B, acct, 'test1234')

  console.log('\n== A 发一条评论 + 两条回复 ==')
  await A.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.addComment(d, '这是父评论 ' + Date.now())
  }, DOC)
  await A.waitForTimeout(1500)

  const parentId = await A.evaluate((d) => {
    const list = window.__yqStore.getState().comments[d] || []
    return list.length ? list[list.length - 1].id : ''
  }, DOC)
  ok(!!parentId, '评论已创建', parentId)

  await A.evaluate(([d, pid]) => {
    const s = window.__yqStore.getState()
    s.addReply(d, pid, '第一条回复')
    s.addReply(d, pid, '第二条回复')
  }, [DOC, parentId])
  await A.waitForTimeout(2500)

  const localReplies = await A.evaluate(([d, pid]) => {
    const list = window.__yqStore.getState().comments[d] || []
    const c = list.find((x) => x.id === pid)
    return (c?.replies || []).map((r) => r.text)
  }, [DOC, parentId])
  ok(localReplies.length === 2, 'A 本地有 2 条回复', JSON.stringify(localReplies))

  console.log('\n== 服务端真的存下了回复 ==')
  const boot = await (await fetch(`${BASE}/api/bootstrap`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()
  const replyRows = boot.data.commentReplies || []
  const mine = replyRows.filter((x) => x.commentId === parentId)
  ok(mine.length === 2, '服务端 comment_replies 有 2 行（不再是 0）', String(mine.length))
  ok(mine.every((x) => x.text && x.authorId), '回复内容与作者齐全', JSON.stringify(mine.map((x) => x.text)))

  console.log('\n== 换设备能看到回复 ==')
  await B.reload({ waitUntil: 'domcontentloaded' })
  await B.waitForSelector('.yq-app', { timeout: 25000 })
  await B.waitForTimeout(2500)
  const bReplies = await B.evaluate(([d, pid]) => {
    const list = window.__yqStore.getState().comments[d] || []
    const c = list.find((x) => x.id === pid)
    return { replies: (c?.replies || []).map((r) => r.text), commentFound: !!c }
  }, [DOC, parentId])
  ok(bReplies.commentFound, 'B 看得到这条评论')
  ok(bReplies.replies.length === 2, 'B 看得到 2 条回复（关键回归点）', JSON.stringify(bReplies.replies))

  console.log('\n== B 追加一条回复，A 收得到 ==')
  await B.evaluate(([d, pid]) => {
    window.__yqStore.getState().addReply(d, pid, 'B 补的一条')
  }, [DOC, parentId])
  await B.waitForTimeout(2500)
  await A.evaluate(() => window.dispatchEvent(new Event('focus')))
  await A.waitForTimeout(2500)
  const aReplies = await A.evaluate(([d, pid]) => {
    const list = window.__yqStore.getState().comments[d] || []
    const c = list.find((x) => x.id === pid)
    return (c?.replies || []).map((r) => r.text)
  }, [DOC, parentId])
  ok(aReplies.length === 3 && aReplies.includes('B 补的一条'), 'A 收到了 B 的回复', JSON.stringify(aReplies))

  console.log('\n== 删除父评论不留下孤儿回复 ==')
  const beforeOrphans = replyRows.length
  // 这里原来挂着 .catch(() => {})，而 deleteComment 当时**根本不存在** ——
  // 抛的 TypeError 被吞掉，后面照样打印「删除前回复总数 3」，
  // 看起来像在核对，其实什么都没发生。一节永远绿的测试比没有测试更糟。
  await A.evaluate(([d, pid]) => {
    window.__yqStore.getState().deleteComment(d, pid)
  }, [DOC, parentId])
  await A.waitForTimeout(2500)
  const after = await (await fetch(`${BASE}/api/bootstrap`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()
  const leftComment = (after.data.comments || []).filter((x) => x.id === parentId)
  const left = (after.data.commentReplies || []).filter((x) => x.commentId === parentId)
  console.log(`   删除前回复总数 ${beforeOrphans}，父评论剩余 ${leftComment.length}，其回复剩余 ${left.length}`)
  ok(leftComment.length === 0, '父评论确实被删掉了（不是只删了本地）', `还剩 ${leftComment.length} 条`)
  // 回复的 remove 是靠 comments 分支里 extractReplies 摊平后算出来的，
  // 那条通路曾经被顺手废掉过，而废掉之后只是界面上多几条没人看的回复 —— 不会报错。
  ok(left.length === 0, `它的 ${beforeOrphans} 条回复也一并清掉（不留孤儿）`, `还剩 ${left.length} 条`)

  console.log('\n== 别人的评论不能删 ==')
  // 发言权不等于删除权。讨论记录在知识库里的价值恰恰在于它不会被随手抹掉。
  const acct2 = `rep2_${suffix}`
  const r2 = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct2, password: 'test1234', name: '围观同事' } })
  const uid2 = (await r2.json()).user.id
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid2, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: false }, joinedAt: Date.now() }] } },
  })
  const C = await (await browser.newContext()).newPage()
  await login(C, acct2, 'test1234')

  // 视口要够宽：1280 落在移动版断点里，桌面工具栏上的评论按钮
  // 存在于 DOM 但不可见，click 会一直等到超时。
  await C.setViewportSize({ width: 1600, height: 900 })
  await C.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
  await C.waitForSelector('.yq-block', { timeout: 25000 })
  await C.waitForTimeout(2500)

  // C 先在文档页上等着，A 再发评论，靠增量收到。
  // 不用 reload 取数据：reload 之后应用会短暂重定向，
  // 工具栏随之消失，click 就再也等不到那个按钮了 ——
  // 测的是「重载后能否自愈」，不是「别人的评论有没有删除按钮」。
  const ownId = await A.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.addComment(d, '这条只有作者能删 ' + Date.now())
    const list = window.__yqStore.getState().comments[d] || []
    return list[list.length - 1].id
  }, DOC)
  await A.waitForTimeout(2500)
  await C.evaluate(() => window.dispatchEvent(new Event('focus')))
  await C.waitForTimeout(3000)

  const cSees = await C.evaluate(([d, cid]) => !!(window.__yqStore.getState().comments[d] || []).find((c) => c.id === cid), [DOC, ownId])
  ok(cSees, 'C 通过增量收到了这条评论')

  // 面板是个开关：点一次开、再点一次关。确认没开就再点一次。
  let panelOpen = false
  for (let i = 0; i < 3 && !panelOpen; i++) {
    await C.click('.yq-doc-comment-btn', { timeout: 8000 }).catch(() => {})
    panelOpen = await C.waitForSelector('.yq-comment', { timeout: 4000 }).then(() => true).catch(() => false)
  }
  ok(panelOpen, 'C 能打开评论面板')
  await C.waitForTimeout(1000)
  const delBtns = await C.locator('.yq-comment-del').count()
  ok(delBtns === 0, 'C 的界面上没有「删除」按钮（不是自己的评论）', `出现 ${delBtns} 个`)

  // 反过来：作者本人是看得到删除入口的，否则「这条我都不能删」就无从谈起
  await A.setViewportSize({ width: 1600, height: 900 })
  await A.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-block', { timeout: 25000 })
  await A.waitForTimeout(2500)
  await A.waitForSelector('.yq-doc-comment-btn', { timeout: 15000 })
  let aOpen = false
  for (let i = 0; i < 3 && !aOpen; i++) {
    await A.click('.yq-doc-comment-btn')
    aOpen = await A.waitForSelector('.yq-comment-del', { timeout: 4000 }).then(() => true).catch(() => false)
  }
  const aDelBtns = await A.locator('.yq-comment-del').count()
  ok(aDelBtns > 0, '作者自己的评论上是有「删除」入口的', `出现 ${aDelBtns} 个`)

  // 光有界面不算数：直接调 store 绕过去，服务端必须拒
  await C.evaluate(([d, cid]) => {
    window.__yqStore.getState().deleteComment(d, cid)
  }, [DOC, ownId])
  await C.waitForTimeout(2500)
  const after2 = await (await fetch(`${BASE}/api/bootstrap`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()
  const survived = (after2.data.comments || []).some((x) => x.id === ownId)
  ok(survived, '服务端挡住了越权删除：评论还在（不能只靠界面藏按钮）')
} catch (e) {
  fail++
  /*
   * ⚠️ 汇总行原来**写在 try 里**（早于本行），所以这里一抛异常它就不会执行 ——
   * runner 只看得到「没找到汇总行」，真正的报错留在 stderr 被丢掉，
   * 套件于是从基线里**整条消失**，总数少一截，看着像「计数漂移」。
   * 2026-10-10 就这么丢过一次真错误（服务端 schema 改动引发的异常）。
   *
   * 教训：汇总行必须在 finally 之后无条件打印，
   * 且异常要把栈一起打出来 —— 否则「套件崩了」和「断言红了」分不开。
   */
  console.error('异常：', e && e.stack ? e.stack : e)
} finally {
  await browser.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
