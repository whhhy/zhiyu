/* ============================================================
   全局水印
   ------------------------------------------------------------
   这个开关以前**只存不执行** —— 设置页写着「在正文上叠加成员标识水印，
   截屏外传时可追溯来源」，存进 SQLite、同步到各设备，
   但正文里从来不会叠加任何东西。

   跟导出限制、IP 白名单一起被改成「要么真执行、要么明说没做」，
   不留一个看起来像在防护、实际什么都不干的开关。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
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
  await page.waitForTimeout(1500)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p = await (await browser.newContext()).newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(String(e?.message || e)))
  await login(p, 'admin', PW)

  console.log('\n== 默认不该有水印 ==')
  // 建一个专用库并打开一篇文档
  const { bookId, docId } = await p.evaluate((sfx) => {
    const s = window.__yqStore.getState()
    const b = s.createBook('s1', '水印验证库 ' + sfx)
    const d = s.createDoc(b, null, '水印测试文档')
    const doc = window.__yqStore.getState().docs[d]
    if (doc) {
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk1', type: 'p', text: '这是正文第一段。', order: 0 }])
    }
    return { bookId: b, docId: d }
  }, suffix)
  await p.waitForTimeout(2000)
  await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(1500)
  ok((await p.locator('[data-testid="doc-watermark"]').count()) === 0, '没开开关时正文上没有水印')

  console.log('\n== 打开水印后要真的出现 ==')
  await p.evaluate((b) => {
    window.__yqStore.getState().updateBookSettings(b, { watermark: true, watermarkText: '源子科技 · 内部资料' })
  }, bookId)
  await p.waitForTimeout(2000)
  const wm = p.locator('[data-testid="doc-watermark"]')
  ok((await wm.count()) === 1, '水印层出现了')
  const text = (await wm.textContent().catch(() => '')) || ''
  ok(/源子科技 · 内部资料/.test(text), '水印里有配置的文案', text.slice(0, 60))
  ok(/管理员|admin/.test(text), '水印里有当前阅读人（可追溯到人）', text.slice(0, 60))
  const items = await p.locator('.yq-doc-watermark-item').count()
  ok(items >= 6, `水印铺了多行（${items} 条）——单条滚出视口就没了`, String(items))

  console.log('\n== 水印不能妨碍阅读与编辑 ==')
  const style = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="doc-watermark"]')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { pe: cs.pointerEvents, us: cs.userSelect }
  })
  ok(style?.pe === 'none', '不吃指针事件（不挡点击）', JSON.stringify(style))
  ok(style?.us === 'none', '不可选中（复制正文时不会带上水印）', JSON.stringify(style))
  // 还能正常编辑正文
  await p.click('.yq-block >> nth=0')
  await p.keyboard.press('End')
  await p.keyboard.type('改一笔')
  await p.waitForTimeout(1200)
  const edited = await p.evaluate((d) => {
    const doc = window.__yqStore.getState().docs[d]
    return (doc?.blocks || []).some((b) => (b.text || '').includes('改一笔'))
  }, docId)
  ok(edited, '开着水印也能正常编辑正文')
  ok(errors.length === 0, '页面没有 JS 报错（尤其不能因为选择器导致无限重渲染）', errors.slice(0, 2).join(' | '))

  console.log('\n== 关掉就没了 ==')
  await p.evaluate((b) => {
    window.__yqStore.getState().updateBookSettings(b, { watermark: false })
  }, bookId)
  await p.waitForTimeout(2000)
  ok((await p.locator('[data-testid="doc-watermark"]').count()) === 0, '关掉开关后水印消失')

  console.log('\n== 没配文案时用兜底文案，不要空白 ==')
  await p.evaluate((b) => {
    window.__yqStore.getState().updateBookSettings(b, { watermark: true, watermarkText: '' })
  }, bookId)
  await p.waitForTimeout(2000)
  const fallback = (await p.locator('[data-testid="doc-watermark"]').textContent().catch(() => '')) || ''
  ok(/内部资料/.test(fallback), '文案为空时用「内部资料」兜底，不显示成一片空白', fallback.slice(0, 40))

  /*
   * ============================================================
   * 对外分享页的水印 —— 这一段**以前完全没有**，是补上的
   * ============================================================
   * 原实现是 `watermarkText || \`${ip} · ${日期}\``：
   * 管理员**一设自定义文案，访客信息就整个没了**，
   * 分享出去的水印只剩一句「内部资料」，追不到任何人。
   *
   * 而登录态那边（`DocPage`）是 `{文案} · {姓名}（{账号}）`，
   * 一直带着人 —— **同一个开关，两处策略不一致**。
   *
   * 那条 `||` 兜底看着像「没文案时也别空着」，
   * 实际效果是「一有文案就不追人了」，恰恰把最该记的情况漏掉。
   *
   * 设置页写着「水印会附加当前阅读人的姓名与账号」——
   * 而匿名访客**原理上就没有**姓名账号，
   * 所以这条承诺在分享页上只能兑现一半：**能兑现的是 IP**。
   */
  console.log('\n== 对外分享页：水印必须带访客可识别的信息 ==')
  {
    /*
     * ⚠️ 前置条件有两个，我第一版**一个都没设**就发请求，于是拿到 403 ——
     *    那是 `publicDocGate` 在正常拦我（`perms.ts:195`），
     *    而我差点把「前置没满足」当成「实现没做」。
     *    （又一次：**红的常常不是代码，是前置没摆对**。）
     *
     * `publicDocGate` 要求（见 perms.ts:195 起的注释）：
     *   ① 知识库开了 `publicAccess`
     *   ② 文档 `visibility` 是对外
     * 少一个都不是「松了一点」，而是把单篇分享变成整库公开。
     */
    await p.evaluate(([b, d]) => {
      const s = window.__yqStore.getState()
      s.updateBookSettings(b, { publicAccess: true })
      s.updateDoc(d, { visibility: 'public' })   // 方法名查过 store/index.ts:288，别再猜
    }, [bookId, docId])
    await p.waitForTimeout(2500)

    const pub = await p.context().newPage()
    const r = await pub.request.get(`${BASE}/api/public/doc/${docId}`)
    let body = null
    try { body = await r.json() } catch { body = null }
    const wm = body?.watermark
    ok(r.status() === 200, '（前置）分享页真的能打开了', `status=${r.status()} ${JSON.stringify(body).slice(0, 90)}`)
    ok(!!wm, '分享页拿到了水印设置（说明服务端参与了，不只是前端渲染）', JSON.stringify(wm))
    ok(wm?.enabled === true, '开了开关，分享页就带水印', JSON.stringify(wm))
    ok(/\d+\.\d+\.\d+\.\d+|::1|127\.0\.0\.1/.test(String(wm?.text || '')),
      '**水印里带访客 IP**（匿名访客没有账号，能追到的就是 IP）', String(wm?.text))
    await pub.close()
  }

  // 有自定义文案时，**访客信息也必须还在** —— 这才是原实现漏掉的那一半
  await p.evaluate((b) => {
    window.__yqStore.getState().updateBookSettings(b, { watermark: true, watermarkText: '机密·勿外传' })
  }, bookId)
  await p.waitForTimeout(2200)
  {
    const pub = await p.context().newPage()
    const r = await pub.request.get(`${BASE}/api/public/doc/${docId}`)
    let body = null
    try { body = await r.json() } catch { body = null }
    const text = String(body?.watermark?.text || '')
    ok(/机密/.test(text), '自定义文案生效', text.slice(0, 40))
    ok(/\d+\.\d+\.\d+\.\d+|::1|127\.0\.0\.1/.test(text),
      '**设了文案之后，访客 IP 仍然在**（原实现在这里把它整个丢了）', text.slice(0, 60))
    await pub.close()
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser.close() } catch { /* 已关 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
