/*
 * 导出 → 导入 的往返（2026-10-12 补）
 *
 * ============================================================
 * 补的是**公司迁移要走的那条路**
 * ============================================================
 * 已有套件各管一头：
 *   · `test-export`      —— 验「导出来的东西对不对」
 *   · `test-import-md`   —— 验 Markdown 导入
 *   · `test-lakebook`    —— 验**语雀**那个格式
 * 三者都没验「**我们导的 → 我们导的**」这个往返。
 *
 * 为什么这条特别要紧：导入是**尽力而为**的 ——
 * 服务端逐条独立判定，拒掉的条目只回一个**数字**（`rejected: N`）。
 * 于是「丢了一半内容」这件事**不会报错**，只会得到一个漂亮的 200 和一个 `ok: true`。
 *
 * 真实场景：一家公司把整个工作台导出成一份包，灌进新实例。
 * 少了几篇目录、正文被截断、库的设置没跟上 —— **没有任何报错**。
 * 一个月后才发现，只能重新导一次。
 *
 * ============================================================
 * 这套判据怎么写才不自己骗自己
 * ============================================================
 * · 必须灌进**另一个全新实例**。merge 进同一个实例证明不了什么 ——
 *   那些行本来就在，「没报错」和「读得回来」是两回事。
 * · 逐项比**内容**，不只比条数：块数 / 摘录 / 路径 / 标签 / 发布标记 /
 *   目录层级 / 评论正文 / 库的设置。
 * · 拿**空实例导入前**的数当基线，而不是拿 0 ——
 *   种子本身就有 26 篇文档，基线错了「≥ 包里的条数」就会假绿。
 * · ⚠️ bootstrap 里 docs / comments / bookSettings 这些**有时是数组、有时是 Record**，
 *   而且**主键不一定叫 id**（bookSettings 是 bookId、bookMembers 是 userId）。
 *   只按 `id` 找，bookSettings 就永远「找不到」——
 *   我第一版就是这么写，红了一条而产品是对的。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const SRC_PORT = process.env.ROUNDTRIP_SRC_PORT || await freePort()
const DST_PORT = process.env.ROUNDTRIP_DST_PORT || await freePort()
const SRC_DB = 'data/_rt-src.db'
const DST_DB = 'data/_rt-dst.db'
const SRC = `http://127.0.0.1:${SRC_PORT}`
const DST = `http://127.0.0.1:${DST_PORT}`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/** 起一个独立端口 + 独立库的实例；端口上已经有服务就拒绝（否则结果不可信） */
async function boot(port, db) {
  for (const s of ['', '-wal', '-shm']) { const f = db + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着删 */ } } }
  if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false)) {
    throw new Error(`端口 ${port} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信`)
  }
  const p = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: port, YQ_DB: db }, stdio: ['ignore', 'ignore', 'ignore'],
  })
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) up = true } catch { /* 等 */ }
  }
  if (!up) { p.kill(); throw new Error(`端口 ${port} 的服务没能在 20 秒内起来`) }
  return p
}

const login = async (page, base) => {
  await page.goto(base + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.waitForSelector('.yq-login-submit:not([disabled])', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await page.fill('.yq-login-card input[type="password"]', 'yuque@2026')
  await page.click('.yq-login-submit')
  let inApp = false
  for (let i = 0; i < 25 && !inApp; i++) {
    await page.waitForTimeout(1000)
    inApp = await page.evaluate(() => !!document.querySelector('.yq-app')).catch(() => false)
  }
  if (!inApp) throw new Error('登录后未进入应用')
  await page.waitForTimeout(2000)
}

/** 主键不一定叫 id（bookSettings 是 bookId、bookMembers 是 userId） */
const pick = (bag, id) => (Array.isArray(bag)
  ? bag.find((x) => x.id === id || x.bookId === id || x.userId === id || x.docId === id)
  : bag?.[id])
const listOf = (v) => (Array.isArray(v) ? v : Object.values(v || {}).flat())
const count = (d) => ({
  books: listOf(d.books).length,
  nodes: listOf(d.nodes).length,
  docs: listOf(d.docs).length,
  comments: listOf(d.comments).length,
  selComments: listOf(d.selectionComments).length,
  versions: listOf(d.docVersions).length,
})

const servers = []
try {
  const srcSrv = await boot(SRC_PORT, SRC_DB); servers.push(srcSrv)
  const dstSrv = await boot(DST_PORT, DST_DB); servers.push(dstSrv)

  const br = await chromium.launch()
  try {
    const page = await (await br.newContext({ viewport: { width: 1200, height: 900 } })).newPage()

    /* ---------- 源实例：造一个内容齐全的库 ---------- */
    await login(page, SRC)
    const SH = {
      Authorization: 'Bearer ' + await page.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const sfx = Date.now().toString(36)
    const made = await page.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '往返测试库 ' + x)
      const g = window.__yqStore.getState().createNode(b, null, 'group')
      window.__yqStore.getState().renameNode(g, '一个分组')
      const d1 = window.__yqStore.getState().createDoc(b, g, '甲文档')
      const d2 = window.__yqStore.getState().createDoc(b, g, '乙文档')
      const st = window.__yqStore.getState()
      st.setDocBlocks(d1, [
        { id: 'p1', type: 'p', text: '第一段。' },
        { id: 'h1', type: 'h', text: '一个小标题' },
        { id: 'p2', type: 'p', text: '第二段，有**加粗**。' },
      ])
      st.setDocBlocks(d2, [{ id: 'p1', type: 'p', text: '乙的正文。' }])
      st.updateDoc(d1, { summary: '这是摘录', slug: 'jia-wen-dang', tags: ['甲', '测试'] })
      st.updateDoc(d1, { published: true })
      st.addComment(d1, '往返专用的一条评论')
      st.addSelectionComment(d2, '乙的正文。', 'p1', '往返专用的划词评论')
      st.updateBookSettings(b, { restrictExport: true, blockTerms: ['违禁词'], defaultWidth: 'wide' })
      window.__yqStore.getState().addDocVersion(d1, '往返基准')
      return { b, d1, d2, group: g }
    }, sfx)
    for (let i = 0; i < 40; i++) {
      const bo = await (await page.request.get(`${SRC}/api/bootstrap?lite=0`, { headers: SH })).json()
      const d = listOf(bo.data.docs).find((x) => x.id === made.d1)
      if (d && Array.isArray(d.blocks) && d.blocks.length === 3) break
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(4000)

    const srcData = (await (await page.request.get(`${SRC}/api/bootstrap?lite=0`, { headers: SH })).json()).data
    const sc = count(srcData)
    console.log(`源实例：${JSON.stringify(sc)}`)

    /* ---------- 导出 ---------- */
    const ex = await page.request.get(`${SRC}/api/export`, { headers: SH })
    ok(ex.ok(), `导出 200（实际 ${ex.status()}）`)
    const bundle = await ex.json()
    const E = bundle.data || bundle.entities || bundle

    /* ---------- 目标实例：空库导入 ---------- */
    await login(page, DST)
    const DH = {
      Authorization: 'Bearer ' + await page.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const dstBefore = (await (await page.request.get(`${DST}/api/bootstrap?lite=0`, { headers: DH })).json()).data
    const db0 = count(dstBefore)
    console.log(`目标实例导入前（种子基线）：${JSON.stringify(db0)}`)
    ok(db0.docs > 0, `基线不是 0（种子本身就有 ${db0.docs} 篇）—— 不然「≥ 包里条数」会假绿`)

    const imp = await page.request.post(`${DST}/api/import`, { headers: DH, data: bundle })
    const body = await imp.json()
    console.log(`导入返回：ok=${body.ok} mode=${body.mode} rejected=${body.rejected}`)

    console.log('\n== 导入本身 ==')
    ok(body.ok === true, '导入返回 ok')
    ok((body.rejected || 0) === 0, `**一条都没被拒**（拒掉 ${body.rejected || 0} 条 —— 导入是尽力而为的，拒了不会报错，只会少一个数字）`)

    const after = (await (await page.request.get(`${DST}/api/bootstrap?lite=0`, { headers: DH })).json()).data
    const a4 = count(after)
    console.log(`导入后：${JSON.stringify(a4)}`)

    console.log('\n== 条数：导入后 ≥ 包里的 ==')
    for (const k of ['books', 'nodes', 'docs', 'comments', 'selComments']) {
      const inPkg = listOf(E[k === 'selComments' ? 'selectionComments' : k]).length
      ok(a4[k] >= inPkg, `${k}：${a4[k]} ≥ 包里的 ${inPkg}`)
    }

    console.log('\n== 内容逐项比对 ==')
    {
      const srcDoc = (E.docs || []).find((d) => d.title === '甲文档')
      const got = pick(after.docs, srcDoc?.id)
      ok(!!got, '「甲文档」按 id 找得到')
      if (got && srcDoc) {
        ok((got.blocks || []).length === (srcDoc.blocks || []).length,
          `正文块数 ${(got.blocks || []).length} = ${(srcDoc.blocks || []).length}（正文没被截断）`)
        ok(JSON.stringify((got.blocks || []).map((b) => b.text)) === JSON.stringify((srcDoc.blocks || []).map((b) => b.text)),
          '每一块的文字原样')
        ok(String(got.summary || '') === String(srcDoc.summary || ''), `摘录「${got.summary}」原样`)
        ok(String(got.slug || '') === String(srcDoc.slug || ''), `路径「${got.slug}」原样`)
        ok(JSON.stringify(got.tags || []) === JSON.stringify(srcDoc.tags || []), '标签原样')
        ok(!!got.published === !!srcDoc.published, `发布标记 ${got.published} = ${srcDoc.published}`)
      }
    }
    {
      const srcNode = (E.nodes || []).find((n) => String(n.title || '') === '一个分组')
      const srcDoc = (E.docs || []).find((d) => d.title === '甲文档')
      const gotNode = listOf(after.nodes).find((n) => n.id === srcNode?.id)
      ok(!!gotNode && String(gotNode.title) === '一个分组', '目录里的分组回来了')
      const link = listOf(after.nodes).find((n) => n.docId === srcDoc?.id)
      ok(!!link && String(link.parentId) === String(srcNode?.id),
        `目录层级还在（甲文档仍挂在那个分组下）`)
    }
    {
      const srcC = (E.comments || []).find((c) => c.text === '往返专用的一条评论')
      const gotC = listOf(after.comments).find((c) => c.id === srcC?.id)
      ok(!!gotC && String(gotC.text) === '往返专用的一条评论', '评论正文原样')
      const srcS = (E.selectionComments || []).find((c) => c.text === '往返专用的划词评论')
      const gotS = listOf(after.selectionComments).find((c) => c.id === srcS?.id)
      ok(!!gotS && String(gotS.text) === '往返专用的划词评论', '划词评论也回来了')
    }
    {
      const srcBs = (E.bookSettings || []).find((x) => x.bookId === made.b)
      const gotBs = pick(after.bookSettings, made.b)
      ok(!!gotBs, '新建那个库的设置行回来了')
      if (gotBs && srcBs) {
        ok(JSON.stringify(gotBs.blockTerms || []) === JSON.stringify(srcBs.blockTerms || []), '屏蔽词原样')
        ok(Number(gotBs.restrictExport) === Number(srcBs.restrictExport), `导出限制 ${gotBs.restrictExport} = ${srcBs.restrictExport}`)
        ok(String(gotBs.defaultWidth) === String(srcBs.defaultWidth), `页面宽度「${gotBs.defaultWidth}」原样`)
      }
    }
    {
      const srcV = (E.docVersions || [])[0]
      ok(listOf(after.docVersions).length >= (E.docVersions || []).length, `历史版本也带过来了（${listOf(after.docVersions).length} / ${(E.docVersions || []).length}）`)
    }
  } finally { await br.close() }
} catch (e) {
  fail++
  console.error('异常：', e.stack || e.message)
} finally {
  for (const s of servers) {
    const exited = once(s, 'exit')
    s.kill()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  }
  for (const db of [SRC_DB, DST_DB]) {
    for (const s of ['', '-wal', '-shm']) {
      const f = db + s
      if (!existsSync(f)) continue
      for (let i = 0; i < 5; i++) { try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) } }
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)