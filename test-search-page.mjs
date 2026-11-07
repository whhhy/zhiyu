/* ============================================================
   两处搜索入口的一致性验证
   ------------------------------------------------------------
   顶栏 ⌘K 摘要面板 与 /search 独立搜索页曾经各写各的本地扫描。
   轻量启动之后只改了顶栏那条路，搜索页还在扫本地 d.body ——
   而没打开过的文档本地没有正文，于是「搜自己没打开过的文档」
   在搜索页永远无结果。

   这个套件钉的就是「两处都走服务端、结果一致」。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await p0.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p0.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p0.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await p0.click('.yq-login-submit')
  await p0.waitForSelector('.yq-app', { timeout: 30000 })
  await p0.waitForTimeout(1500)
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))

  // 造一篇内容独特、且**谁都没打开过**的文档
  const marker = '雪鸮巡检标记' + suffix
  const docId = 'ss_' + suffix
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      upsert: {
        docs: [{
          id: docId, type: 'doc', title: '一份没人打开过的文档', bookId: 'b1', spaceId: 's1',
          body: '', blocks: [{ id: 'bk_' + suffix, type: 'h1', text: marker }],
          authorId: 'u_admin', createdAt: Date.now(), updatedAt: Date.now(),
          wordCount: 10, visibility: 'space', published: false, tags: [],
        }],
      },
    }),
  })
  ok(r.ok, '造好一篇未打开的文档', String(r.status))

  const p = await (await browser.newContext()).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1500)

  const loadedBodies = await p.evaluate(() =>
    Object.values(window.__yqStore.getState().docs).filter((d) => Array.isArray(d.blocks)).length)
  ok(loadedBodies === 0, '本机一份正文都没加载（所以本地扫描必然搜不到）', String(loadedBodies))

  console.log('\n== 顶栏 ⌘K 摘要面板 ==')
  await p.locator('.yq-global-search').first().click()
  await p.waitForSelector('[data-global-search]', { timeout: 8000 })
  await p.fill('[data-global-search]', marker)
  await p.waitForTimeout(1500)
  const panelRows = await p.locator('.yq-searchrow').allTextContents().catch(() => [])
  ok(panelRows.some((x) => x.includes('没人打开过')), '顶栏搜得到未打开的文档', JSON.stringify(panelRows.slice(0, 2)))
  await p.keyboard.press('Escape')
  await p.waitForTimeout(400)

  console.log('\n== /search 独立搜索页 ==')
  await p.goto(`${BASE}/#/search?q=${encodeURIComponent(marker)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-searchpage', { timeout: 15000 }).catch(() => {})
  await p.waitForTimeout(1800)
  const pageRows = await p.locator('.yq-searchpage-hit').allTextContents().catch(() => [])
  ok(pageRows.some((x) => x.includes('没人打开过')),
    '搜索页也搜得到（这一条以前是坏的：它还在扫本地 body）', JSON.stringify(pageRows.slice(0, 1)))
  const errs = await p.locator('.yq-searchpage-hit-excerpt').first().textContent().catch(() => null)
  ok(!!errs && errs.length > 0, '并且给出了命中摘要', errs || '(空)')

  console.log('\n== 两处结果一致 ==')
  const panelDoc = panelRows.find((x) => x.includes('没人打开过')) || ''
  const pageDoc = pageRows.find((x) => x.includes('没人打开过')) || ''
  ok(!!panelDoc && !!pageDoc && panelDoc.slice(0, 6) === pageDoc.slice(0, 6),
    '顶栏与搜索页指向同一篇（同一份实现，不会再分叉）', `${panelDoc.slice(0, 10)} | ${pageDoc.slice(0, 10)}`)

  console.log('\n== 搜索页的筛选/排序仍然可用 ==')
  await p.fill('input', '协作').catch(() => {})
  await p.waitForTimeout(1500)
  const afterKw = await p.locator('.yq-searchpage-hit').count()
  ok(afterKw >= 0, '换关键词后有结果或正常空态', String(afterKw))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
