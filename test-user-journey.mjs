/*
 * 完整用户旅程（2026-10-15 加）：一条线走完
 *   建库 → 编排目录 → 写文档 → 评论 → 删除 → 回收站 → 还原 → 篇数复原
 *
 * ============================
 * 为什么单套件不够
 * ============================
 * 别的套件各管一段（同步、权限、回收站、导出……），而**衔接处**没人管。
 * 本套件就是在衔接处找出问题的那一个 ——
 *
 * 它当场抓到一条**别的套件全都漏掉**的缺陷：
 * 删掉一篇文档后，它同时出现在 `docs` 和 `trash` 里，**而且永不自愈**。
 * 原因是两条不同的路都会把正文放回 `docs`，而它们都不知道回收站：
 *   · 增量同步：删除时正在飞行的那次轮询带着旧数据回来，游标又越过了
 *     那条「移除」，于是移除**永远不再送达**；
 *   · `ensureDocLoaded`：删除后 `docs[docId]` 变 undefined，
 *     文档页里那个 effect 重跑，又去 `GET /api/doc/:id` 把正文拉了回来
 *     —— 而那一刻服务端还没收到删除请求，于是「删除」被原地撤销。
 *
 * 用户看不到任何异常（树上那个节点是 hidden 的），
 * 但一篇他以为删掉的文稿，**正文一直留在本地存储里**，客户端搜索也会搜出来。
 * 对内网知识库来说，「删除」必须真的把本地副本也带走。
 *
 * ============================
 * 判据纪律（这个项目栽过好几次，写在这儿免得重蹈）
 * ============================
 *   1. 服务端原始载荷里 `data[实体名]` 是**数组**，不是 `{id: 行}`。
 *      按 docId 去取数组恒为 undefined —— 第一版就这么写的，假红一条。
 *   2. 等界面/状态到位要**轮询到成立**，不用固定超时当结论。
 *   3. 结论要**同时看客户端与服务端**：只读一端分不清是谁的问题。
 *      「客户端有 ≠ 服务端有」，这条在第 ③ 步就用到。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.USER_JOURNEY_PORT || await freePort()
const DB = 'data/_journey.db'
const BASE = `http://127.0.0.1:${PORT}`
for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { } } }
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_DEMO: '0' }, stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { } }
if (!up) { console.error('服务没起来'); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const br = await chromium.launch()
try {
  const page = await (await br.newContext({ viewport: { width: 1440, height: 950 } })).newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)))
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-submit:not([disabled])', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await page.fill('.yq-login-card input[type="password"]', 'yuque@2026')
  await page.click('.yq-login-submit')
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => !!document.querySelector('.yq-app')).catch(() => false)) break }
  await page.waitForTimeout(2500)
  const H = { Authorization: 'Bearer ' + await page.evaluate(() => localStorage.getItem('yq_token')), 'Content-Type': 'application/json' }

  /* ① 建库 */
  console.log('\n== ① 建库 ==')
  const BOOK = '旅程手册' + Date.now().toString(36).slice(-4)
  const bid = await page.evaluate((n) => window.__yqStore.getState().createBook('s1', n, '旅程用'), BOOK)
  ok(!!bid, '建出了知识库', `id=${bid}`)
  await page.waitForTimeout(2500)

  /* ② 编排目录 + 写文档 */
  console.log('\n== ② 目录与文档 ==')
  const made = await page.evaluate((b) => {
    const st = window.__yqStore.getState()
    const g = st.createNode(b, null, 'group')
    st.renameNode(g, '第一章')
    const d1 = window.__yqStore.getState().createDoc(b, g, '第一节')
    const d2 = window.__yqStore.getState().createDoc(b, g, '第二节')
    const s = window.__yqStore.getState()
    s.setDocBlocks(d1, [{ id: 'h1', type: 'h1', text: '第一节' }, { id: 'p1', type: 'p', text: '第一节的正文。' }])
    window.__yqStore.getState().setDocBlocks(d2, [{ id: 'h1', type: 'h1', text: '第二节' }, { id: 'p2', type: 'p', text: '第二节的正文。' }])
    return { g, d1, d2 }
  }, bid)
  ok(!!made.g && !!made.d1 && !!made.d2, '建了分组与两篇文稿')
  await page.waitForTimeout(3500)

  /* ③ 服务端真的收到了吗（客户端有 ≠ 服务端有） */
  console.log('\n== ③ 服务端落库 ==')
  await page.waitForTimeout(4000)
  const boot1 = await (await page.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
  const sTitles = Object.values(boot1.data.docs || {}).map((d) => String(d.title || ''))
  ok(sTitles.includes('第一节') && sTitles.includes('第二节'), '服务端也有这两篇（客户端有 ≠ 服务端有）', JSON.stringify(sTitles))
  const sGroup = (boot1.data.nodes || []).some((n) => n.bookId === bid && n.title === '第一章')
  ok(sGroup, '分组标题「第一章」同步上去了')

  /* ④ 篇数（这是我今天动过口径的地方） */
  console.log('\n== ④ 篇数 ==')
  const counts = await page.evaluate((b) => {
    const s = window.__yqStore.getState()
    const nodes = s.nodes.filter((n) => n.bookId === b && n.docId)
    const hidden = nodes.filter((n) => n.hidden).length
    const stats = s.books.find((x) => x.id === b)
    return { nodes: nodes.length, hidden, bookDocCount: stats ? stats.docCount : null }
  }, bid)
  console.log('   ', JSON.stringify(counts))
  ok(counts.nodes === 2 && counts.hidden === 0, '两个文档节点都在、都可见')

  /* ⑤ 评论 */
  console.log('\n== ⑤ 评论 ==')
  const cmt = await page.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.addComment(d, '旅程里写的一条评论')
    return window.__yqStore.getState().comments[d] || []
  }, made.d1)
  ok(cmt.length === 1, '本地多了一条评论', JSON.stringify(cmt.map((c) => c.text)))
  await page.waitForTimeout(3500)
  const cmt2 = await (await page.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
  /* ⚠️ 服务端原始载荷里 `comments` 是**数组**（`data[实体名] = readEntity(...)`），
     不是我以为的 `{docId: [...]}`。按 docId 去取数组恒为 undefined ——
     第一版就是这么写的，假红一条（当天第 18 次「容器形状」错）。 */
  const srvCmts = (cmt2.data.comments || []).filter((c) => String(c.docId || '') === made.d1)
  ok(srvCmts.some((c) => String(c.text || '').includes('旅程里写的一条评论')),
    '评论同步到服务端了', `服务端 comments 数组 ${(cmt2.data.comments || []).length} 条，本篇匹配 ${srvCmts.length} 条`)

  /* ⑥ 删除 → 回收站 → 还原（走真实界面那条路） */
  console.log('\n== ⑥ 删除 → 回收站 → 还原 ==')
  await page.goto(`${BASE}/#/book/${bid}/doc/${made.d2}`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-app', { timeout: 25000 })
  await page.waitForTimeout(4000)
  await page.locator('.yq-doc-more').first().click({ timeout: 8000 })
  await page.waitForTimeout(700)
  const del = page.locator('text=移到回收站').first()
  if (await del.count()) { await del.click({ timeout: 8000 }); await page.waitForTimeout(1200) }
  else { console.log('   （菜单里没有「移到回收站」，走 store 直接删）'); await page.evaluate((d) => window.__yqStore.getState().deleteDoc(d), made.d2) }
  await page.waitForTimeout(4000)

  /* 什么时候被加回来的？立刻采样，别等 ——
   * 分不清「同步就被加回」和「某次轮询加回」，就没法知道该修哪条路。 */
  const timing = await page.evaluate(async (d) => {
    const s0 = window.__yqStore.getState()
    const log = [{ at: 0, inDocs: !!s0.docs[d] }]
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const s = window.__yqStore.getState()
      const cur = !!s.docs[d]
      const last = log[log.length - 1]
      if (cur !== last.inDocs) log.push({ at: 30000 - (deadline - Date.now()), inDocs: cur })
      if (!cur) return { log, clearedAfterMs: 30000 - (deadline - Date.now()) }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { log, clearedAfterMs: null }
  }, made.d2)
  console.log('   删除后 docs 的变化（含立刻那次采样）：', JSON.stringify(timing.log))
  const afterDel = await page.evaluate(([b, d]) => {
    const s = window.__yqStore.getState()
    const n = s.nodes.filter((x) => x.bookId === b && x.docId === d)
    return { inDocs: !!s.docs[d], inTrash: s.trash.some((t) => t.docId === d), nodes: n.length, hidden: n.filter((x) => x.hidden).length }
  }, [bid, made.d2])
  console.log('   删后：', JSON.stringify(afterDel))
  ok(afterDel.inTrash, '进了回收站')
  ok(!afterDel.inDocs,
    timing.clearedAfterMs != null
      ? `正文里不再留着它（${timing.clearedAfterMs}ms 后清掉）`
      : '正文里清掉了，且**没有被旧数据复活**（立刻就干净了）',
    JSON.stringify(timing.log))
  ok(afterDel.nodes === 1 && afterDel.hidden === 1, '目录节点**留在原地但藏起来了**（还原时位置才找得回来）')

  const boot2 = await (await page.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
  const t2 = Object.values(boot2.data.docs || {}).map((d) => String(d.title || ''))
  ok(!t2.includes('第二节'), '服务端也不再有这篇（软删不是只删本地）', JSON.stringify(t2))
  ok((boot2.data.trash || []).some((x) => x.docId === made.d2), '服务端回收站里有它')

  /* ⑦ 还原：位置与正文都要回来 */
  console.log('\n== ⑦ 还原 ==')
  await page.goto(`${BASE}/#/book/${bid}/settings`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-app', { timeout: 25000 })
  await page.waitForTimeout(3500)
  await page.locator('.yq-bset-nav-item', { hasText: '回收站' }).first().click({ timeout: 8000 })
  await page.waitForTimeout(1500)
  const tr = page.locator('.yq-bset-table tbody tr', { hasText: '第二节' }).first()
  ok(await tr.count() > 0, '回收站页能看到它')
  await tr.locator('button', { hasText: '还原' }).first().click({ timeout: 8000 })
  // 轮询到它回来为止（不给固定超时）
  const back = await page.evaluate(async ([d, g]) => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const s = window.__yqStore.getState()
      const node = s.nodes.find((n) => n.docId === d)
      if (s.docs[d] && node && !node.hidden) {
        return { inDocs: true, inTrash: s.trash.some((t) => t.docId === d), parent: node.parentId, expect: g, blocks: (s.docs[d].blocks || []).length }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  }, [made.d2, made.g])
  console.log('   还原后：', JSON.stringify(back))
  ok(!!back, '**不刷新页面**它自己就回来了（轮询周期内收敛）')
  if (back) {
    ok(!back.inTrash, '回收站里没有了')
    ok(back.parent === back.expect, '**回到原来的位置上**（不是落到根目录）')
    ok(back.blocks > 0, '正文一起回来了', `blocks=${back.blocks}`)
  }

  /* ⑧ 篇数复原 */
  console.log('\n== ⑧ 篇数复原 ==')
  const counts2 = await page.evaluate((b) => {
    const s = window.__yqStore.getState()
    const nodes = s.nodes.filter((n) => n.bookId === b && n.docId)
    return { nodes: nodes.length, hidden: nodes.filter((n) => n.hidden).length }
  }, bid)
  ok(counts2.nodes === 2 && counts2.hidden === 0, '两个文档节点都回到可见', JSON.stringify(counts2))

  console.log('\n== 页面异常 ==')
  console.log(errs.length ? errs.join('\n') : '  无')
} finally {
  await br.close()
  const exited = once(srv, 'exit'); srv.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { } } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)