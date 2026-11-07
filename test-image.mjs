/* ============================================================
   图片块上传验证
   ------------------------------------------------------------
   关键不是「A 能看到自己刚传的图」，而是：
     · 换一台设备（另一个浏览器上下文）也能看到
     · 未授权的人看不到（图片 URL 要鉴权）
   `<img src>` 不会带 Authorization 头，所以这条路靠 cookie 走 ——
   测的就是这一点。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
const DOC = 'd2'
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

const openDoc = async (page) => {
  await page.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-block', { timeout: 25000 })
  await page.waitForTimeout(1500)
}

/** 1x1 的 PNG，够验通链路 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))

  // 造两个账号
  const mk = async (n) => {
    const a = `img_${n}_${suffix}`
    const r = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: a, password: 'test1234', name: n } })
    const uid = (await r.json()).user.id
    await p0.request.post(`${BASE}/api/sync/push`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid, role: 'editor', perms: { read: 1, comment: 1, edit: 1, create: 1, export: 1, share: 1 }, joinedAt: Date.now() }] } },
    })
    return a
  }
  const acctA = await mk('图片甲')

  const A = await (await browser.newContext()).newPage()
  await login(A, acctA, 'test1234')
  await openDoc(A)

  console.log('\n== 插入一个图片块并上传 ==')
  // 造一个图片块
  await A.evaluate((d) => {
    const s = window.__yqStore.getState()
    const doc = s.docs[d]
    s.setDocBlocks(d, [...doc.blocks, { id: 'bk_img_' + Date.now(), type: 'image', text: '' }])
  }, DOC)
  await A.waitForTimeout(1200)
  ok(await A.locator('.yq-img-block-empty').count() > 0, '出现了上传占位区')

  const hasDropHint = await A.locator('.yq-img-block-hint').count()
  ok(hasDropHint > 0, '拖拽提示是真实存在的（以前是句空话）')
  const dropBound = await A.evaluate(() => {
    const el = document.querySelector('.yq-img-block-empty')
    return !!el
  })
  ok(dropBound, '拖拽容器在 DOM 里')

  // 走真实的 file input
  await A.setInputFiles('.yq-img-block-empty input[type="file"]', {
    name: '架构图.png', mimeType: 'image/png', buffer: PNG,
  })
  await A.waitForTimeout(3000)

  const keyA = await A.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.type === 'image' && x.data?.key)
    return b?.data?.key || ''
  }, DOC)
  ok(!!keyA, '图片已上传并写进块里', keyA)

  const imgShown = await A.locator('.yq-img-block img').count()
  ok(imgShown > 0, '本机能看到这张图')
  const naturalW = await A.evaluate(() => {
    const i = document.querySelector('.yq-img-block img')
    return i ? i.naturalWidth : -1
  })
  ok(naturalW > 0, '图片真的解码出来了（不是 404 的破图）', `naturalWidth=${naturalW}`)

  console.log('\n== 换一台设备也能看到 ==')
  const B = await (await browser.newContext()).newPage()
  await login(B, acctA, 'test1234')
  await openDoc(B)
  const keyB = await B.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.type === 'image' && x.data?.key)
    return b?.data?.key || ''
  }, DOC)
  ok(keyB === keyA, 'B 拿到同一个 key（存的是服务端附件，不是本地临时地址）', `A=${keyA} B=${keyB}`)
  const bImg = await B.locator('.yq-img-block img').count()
  ok(bImg > 0, 'B 画面上真的渲染出了图片')
  const bNatural = await B.evaluate(() => {
    const i = document.querySelector('.yq-img-block img')
    return i ? i.naturalWidth : -1
  })
  ok(bNatural > 0, 'B 这边的图片也解码成功（cookie 鉴权生效）', `naturalWidth=${bNatural}`)

  console.log('\n== 未授权的人拿不到 ==')
  // 必须是一个**完全没被加进任何知识库**的账号。
  // 拿「也是 b1 编辑」的人来断言「他下载不到」是自欺欺人 —— 他本来就该下载到。
  const outReg = await p0.request.post(`${BASE}/api/auth/register`, {
    data: { account: `img_out_${suffix}`, password: 'test1234', name: '无关路人' },
  })
  const outToken = (await outReg.json()).token
  const C = await (await browser.newContext()).newPage()
  await login(C, `img_out_${suffix}`, 'test1234')
  const url = `/api/attachment/${keyA}`
  const denied = await C.request.get(BASE + url, { headers: { Authorization: `Bearer ${outToken}` } })
  ok(denied.status() === 403, '无权账号下载图片被拒', String(denied.status()))

  // 完全没有会话的裸请求：应当 401
  const anonCtx = await browser.newContext()
  const noCookie = await anonCtx.request.get(BASE + url)
  ok(noCookie.status() === 401, '完全没登录也拿不到', String(noCookie.status()))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
