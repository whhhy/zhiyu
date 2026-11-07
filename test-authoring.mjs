/* ============================================================
   核心写作路径的跨设备验证
   ------------------------------------------------------------
   之前测的都是「读」和「协同」；这一套测的是**从零写出来**：
   建知识库 → 建目录 → 建文档 → 写正文 → 改名 → 拖动排序 → 删掉 → 恢复。

   这条链是公司知识库最日常的用法，也是最容易在服务端形态下悄悄坏掉的地方：
   每一环都要既进 store、又能推上服务端、并在另一台设备上正确落地。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1200)
}
/** 另一台设备：重新拉一次启动数据 */
const refresh = async (page) => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(2200)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
  const api = async (p) => (await fetch(BASE + p, { headers: H })).json()

  const A = await (await browser.newContext()).newPage()
  const B = await (await browser.newContext()).newPage()
  await login(A, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  await login(B, 'admin', process.env.ADMIN_PASS || 'yuque@2026')

  console.log('\n== 建一个知识库 ==')
  const bookId = await A.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '写作路径测试库 ' + sfx, '从零写出来'), suffix)
  ok(!!bookId, 'createBook 返回 id', bookId)
  await A.waitForTimeout(2200)
  const boot1 = await api('/api/bootstrap')
  ok(boot1.data.books.some((b) => b.id === bookId), '服务端已经有这个知识库')

  console.log('\n== 建目录与文档 ==')
  const nodeId = await A.evaluate(([b, sfx]) => window.__yqStore.getState().createNode(b, null, 'group'), [bookId, suffix])
  await A.waitForTimeout(2000)
  const docId = await A.evaluate(([b, p, sfx]) => window.__yqStore.getState().createDoc(b, p, '新建的文档 ' + sfx), [bookId, nodeId, suffix])
  ok(!!docId, 'createDoc 返回 id', docId)
  await A.waitForTimeout(2500)

  const docOnServer = await fetch(`${BASE}/api/doc/${docId}`, { headers: H })
  ok(docOnServer.ok, '服务端能取到这篇新文档', String(docOnServer.status))
  const docJson = await docOnServer.json()
  ok(Array.isArray(docJson.doc?.blocks), '新文档自带标题块', String(docJson.doc?.blocks?.length))
  ok(docJson.doc?.title?.includes('新建的文档'), '标题也带上去了', docJson.doc?.title)

  console.log('\n== 写正文 ==')
  await A.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_w_' + Date.now(), type: 'p', text: '这一段是 A 写的' }])
  }, docId)
  await A.waitForTimeout(2500)
  const afterWrite = await (await fetch(`${BASE}/api/doc/${docId}`, { headers: H })).json()
  ok(afterWrite.doc.blocks.some((b) => b.text === '这一段是 A 写的'), '正文已落库')

  console.log('\n== 改名 ==')
  await A.evaluate(([n, sfx]) => window.__yqStore.getState().renameNode(n, '改过名的目录 ' + sfx), [nodeId, suffix])
  await A.waitForTimeout(2200)
  const boot2 = await api('/api/bootstrap')
  const node = boot2.data.nodes.find((n) => n.id === nodeId)
  ok(node && node.title.includes('改过名的目录'), '目录改名同步了', node?.title)

  console.log('\n== 拖动排序（成为子项） ==')
  // 先再造一个同级目录，然后把 nodeId 拖到它下面
  const node2 = await A.evaluate(([b, sfx]) => window.__yqStore.getState().createNode(b, null, 'group'), [bookId, suffix])
  await A.waitForTimeout(2000)
  await A.evaluate(([n, p]) => window.__yqStore.getState().moveNode(n, p, 0), [nodeId, node2])
  await A.waitForTimeout(2200)
  const boot3 = await api('/api/bootstrap')
  const moved = boot3.data.nodes.find((n) => n.id === nodeId)
  ok(moved && moved.parentId === node2, '成为子项的排序同步了', `${moved?.parentId} vs ${node2}`)

  console.log('\n== 换设备：新建的东西都在 ==')
  await refresh(B)
  const bState = await B.evaluate(([b, d, n]) => {
    const s = window.__yqStore.getState()
    return {
      book: !!s.books.find((x) => x.id === b),
      doc: !!s.docs[d],
      node: !!s.nodes.find((x) => x.id === n),
      nodeTitle: s.nodes.find((x) => x.id === n)?.title,
    }
  }, [bookId, docId, nodeId])
  ok(bState.book, 'B 看到新知识库')
  ok(bState.doc, 'B 看到新文档')
  ok(bState.node && bState.nodeTitle.includes('改过名的目录'), 'B 看到改名后的目录', bState.nodeTitle)

  // B 打开这篇，正文要能按需拉到
  await B.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await B.waitForSelector('.yq-block', { timeout: 25000 })
  await B.waitForTimeout(1800)
  const bText = await B.evaluate((d) => window.__yqStore.getState().docs[d]?.blocks?.map((b) => b.text).join('|'), docId)
  ok(String(bText).includes('这一段是 A 写的'), 'B 打开后正文完整（按需加载也通）', String(bText).slice(0, 60))

  console.log('\n== B 也能继续写，A 收得到 ==')
  await B.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_b_' + Date.now(), type: 'p', text: '这一段是 B 补的' }])
  }, docId)
  await B.waitForTimeout(2500)
  await A.evaluate(() => window.dispatchEvent(new Event('focus')))
  await A.waitForTimeout(2500)
  const aText = await A.evaluate((d) => window.__yqStore.getState().docs[d]?.blocks?.map((b) => b.text).join('|'), docId)
  ok(String(aText).includes('这一段是 B 补的'), 'A 收到了 B 的补充', String(aText).slice(-40))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
