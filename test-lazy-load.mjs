/* ============================================================
   轻量启动 / 按需加载正文 验证
   ------------------------------------------------------------
   要证明两件事，缺一不可：
     1. 登录时的传输量真的降下来了
     2. **没打开过的文档，正文不会被抹掉** —— 这是最危险的回归，
        因为界面上完全看不出异常，只是几天后有人发现文档空了
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
  await page.waitForSelector('.yq-app', { timeout: 30000 })
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  console.log('\n== 传输量 ==')
  const fetchSize = async (url) => {
    const r = await fetch(url, { headers: H })
    const buf = await r.arrayBuffer()
    return { bytes: buf.byteLength, json: JSON.parse(Buffer.from(buf).toString('utf8')) }
  }
  const t0 = Date.now()
  const lite = await fetchSize(`${BASE}/api/bootstrap`)
  const liteMs = Date.now() - t0
  const full = await fetchSize(`${BASE}/api/bootstrap?lite=0`)

  const kb = (n) => (n / 1024).toFixed(0) + 'KB'
  const mb = (n) => (n / 1024 / 1024).toFixed(2) + 'MB'
  const fmt = (n) => (n > 1024 * 1024 ? mb(n) : kb(n))
  const ratio = lite.bytes / full.bytes
  const docCount = lite.json.data.docs.length
  console.log(`   文档数 ${docCount}   轻量 ${fmt(lite.bytes)} / ${liteMs}ms   整包 ${fmt(full.bytes)}`)
  // 阈值随规模变：文档少的时候，评论 / 目录树 / 模板 / 设置这些占了大部分，
  // 轻量化省不了多少；真正的收益要到上千篇才显现（实测 2026 篇：18.4MB → 603KB，省 97%）。
  // 无论规模如何，「轻量包不含正文」这一条都必须成立 —— 那才是这个机制的本质。
  const threshold = docCount > 500 ? 0.25 : 0.85
  ok(ratio < threshold, `轻量包省下 ${((1 - ratio) * 100).toFixed(0)}%（${fmt(lite.bytes)} vs ${fmt(full.bytes)}，阈值 ${threshold}）`, ratio.toFixed(3))

  const liteJson = lite.json
  const firstDoc = liteJson.data.docs[0]
  ok(firstDoc && firstDoc.blocks === undefined, '轻量包里没有 blocks', typeof firstDoc?.blocks)
  ok(firstDoc && firstDoc.title, '但保留了标题等元信息', firstDoc?.title)
  ok(firstDoc && firstDoc.wordCount > 0, '连字数都在（列表要显示）', String(firstDoc?.wordCount))

  console.log('\n== 打开文档才拉正文 ==')
  const A = await (await browser.newContext()).newPage()
  await login(A, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const loadedAtLogin = await A.evaluate(() => {
    const d = window.__yqStore.getState()
    const k = Object.keys(d.docs)[0]
    return { total: Object.keys(d.docs).length, loaded: Object.values(d.docs).filter((x) => Array.isArray(x.blocks)).length }
  })
  ok(loadedAtLogin.loaded === 0, '登录后没有任何正文在本地', JSON.stringify(loadedAtLogin))

  // 打开一篇
  const targetId = (await liteJson).data.docs[0].id
  await A.goto(`${BASE}/#/book/b1/doc/${targetId}`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-block', { timeout: 20000 })
  await A.waitForTimeout(1500)
  const afterOpen = await A.evaluate((id) => {
    const d = window.__yqStore.getState().docs[id]
    return { blocks: Array.isArray(d?.blocks) ? d.blocks.length : -1, loaded: d?._loaded === true }
  }, targetId)
  ok(afterOpen.loaded && afterOpen.blocks > 0, '打开后正文已加载', JSON.stringify(afterOpen))

  const blocksRendered = await A.locator('.yq-block').count()
  ok(blocksRendered > 0, '编辑器真的渲染出了块', String(blocksRendered))

  console.log('\n== 关键回归：没打开过的文档正文不能被抹掉 ==')
  // 找一个没打开过的
  const unopenedId = (await liteJson).data.docs[1].id
  const before = (await (await fetch(`${BASE}/api/doc/${unopenedId}`, { headers: H })).json()).doc
  const beforeBlocks = before.blocks.length
  ok(beforeBlocks > 0, '该文档在服务端有正文', String(beforeBlocks))

  // 在 A 上做几次别的编辑（这些编辑会触发 onLocalChange → 差分 → 推送）
  await A.evaluate((id) => {
    const s = window.__yqStore.getState()
    s.updateDoc(id, { title: '改个标题' })
    s.toast('触发一次提交', 'info')
  }, targetId)
  await A.waitForTimeout(1200)
  await A.evaluate(() => { const s = window.__yqStore.getState(); s.addNote('s1', '随手一条'); })
  await A.waitForTimeout(2500)

  const after = (await (await fetch(`${BASE}/api/doc/${unopenedId}`, { headers: H })).json()).doc
  ok(after.blocks.length === beforeBlocks, '未打开文档的正文条数没变（没被清空）', `${beforeBlocks} -> ${after.blocks.length}`)
  ok(after.blocks[0]?.text === before.blocks[0]?.text, '正文内容也一模一样')

  console.log('\n== 反过来：打开过的文档能正常改回服务端 ==')
  /*
   * 记住原始块数组：下面要**故意加一块**来验证「编辑能落库」，
   * 而这个套件从头到尾没有还原过 —— 于是每跑一次 test:all，d1 就多一块
   * （2026-10-08 实测：11 块变 12 块）。
   * 后果不只是「文档脏」：后面跑的 `test-shortcuts` 会按 seed 还原 d1，
   * 口径对不上，报「块数对不上（11 vs 原 12）」，看起来像它自己的问题。
   */
  const originBlocks = await A.evaluate((id) => {
    const d = window.__yqStore.getState().docs[id]
    return JSON.parse(JSON.stringify(d.blocks || []))
  }, targetId)
  await A.evaluate((id) => {
    const s = window.__yqStore.getState()
    const d = s.docs[id]
    s.setDocBlocks(id, [...d.blocks, { id: 'bk_new_' + Date.now(), type: 'p', text: '新加的一段' }])
  }, targetId)
  await A.waitForTimeout(2500)
  const saved = (await (await fetch(`${BASE}/api/doc/${targetId}`, { headers: H })).json()).doc
  ok(saved.blocks.some((b) => b.text === '新加的一段'), '编辑正常落库', String(saved.blocks.length))

  /* 还原：把那多出来的一块拿掉，回到原样 */
  await A.evaluate(({ id, blocks }) => {
    window.__yqStore.getState().setDocBlocks(id, blocks)
  }, { id: targetId, blocks: originBlocks })
  await A.waitForTimeout(2500)
  const restored = (await (await fetch(`${BASE}/api/doc/${targetId}`, { headers: H })).json()).doc
  const backOk = restored.blocks.length === originBlocks.length
    && !restored.blocks.some((b) => b.text === '新加的一段')
  ok(backOk, '已把多出来的那一块还原（这个套件以前不还原，d1 会逐轮变胖）',
    `${saved.blocks.length} → ${restored.blocks.length}（原 ${originBlocks.length}）`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
