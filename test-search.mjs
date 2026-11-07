/* 服务端全文搜索验证
   三个要点：搜得到没打开过的文档、搜得到知识库/小记、搜不到无权的内容。 */

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
  await page.waitForTimeout(1200)
}

const search = async (page, kw) => {
  // 顶栏的搜索入口是点按钮或按 ?，不是 ⌘K
  await page.locator('.yq-global-search').first().click()
  await page.waitForSelector('[data-global-search]', { timeout: 8000 })
  await page.fill('[data-global-search]', kw)
  await page.waitForTimeout(900)
  const rows = await page.locator('.yq-searchrow').allTextContents().catch(() => [])
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return rows
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}` }

  // 造一篇内容独特、且**谁都没打开过**的文档
  const marker = '紫貂排版校验码' + suffix
  const docId = 'srch_' + suffix
  await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json; charset=utf-8' },
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

  console.log('\n== 搜一篇没打开过的文档 ==')
  const A = await (await browser.newContext()).newPage()
  await login(A, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const localBodies = await A.evaluate(() => Object.values(window.__yqStore.getState().docs).filter((d) => Array.isArray(d.blocks)).length)
  const rows = await search(A, marker)
  ok(rows.some((r) => r.includes('没人打开过')), `搜索命中（本地只有 ${localBodies} 篇有正文）`, JSON.stringify(rows.slice(0, 3)))

  console.log('\n== 两字中文词（FTS5 会漏，LIKE 不会）==')
  const two = await search(A, '产品')
  ok(two.length > 0, '搜「产品」这种两字词有结果', String(two.length))

  console.log('\n== 知识库 / 小记 ==')
  const bookHit = await search(A, '团队手册')
  ok(bookHit.length > 0, '搜得到知识库本身', JSON.stringify(bookHit.slice(0, 2)))
  const noteHit = await search(A, '编辑器的手感')
  ok(noteHit.length > 0, '搜得到小记', JSON.stringify(noteHit.slice(0, 2)))

  console.log('\n== 越权者搜不到 ==')
  const acct = `srch_${suffix}`
  const reg = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: '搜索路人' } })
  const uid = (await reg.json()).user.id
  // 只给 b3（团队手册），不给 b1
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: { ...H, 'Content-Type': 'application/json; charset=utf-8' },
    data: { upsert: { bookMembers: [{ bookId: 'b3', userId: uid, role: 'reader', perms: { read: true, comment: false, edit: false, create: false, export: true, share: false }, joinedAt: Date.now() }] } },
  })
  const S = await (await browser.newContext()).newPage()
  await login(S, acct, 'test1234')
  const leak = await search(S, marker)
  ok(!leak.some((r) => r.includes('没人打开过')), '未被授权的知识库内容搜不到', JSON.stringify(leak.slice(0, 2)))
  const allowed = await search(S, '团队手册')
  ok(allowed.length > 0, '但自己有权限的搜得到', JSON.stringify(allowed.slice(0, 2)))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
