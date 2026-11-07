/*
 * 工具栏提示（tooltip）—— 真浏览器端到端（2026-10-16）
 *
 * ------------------------------------------------------------
 * 起因：用户报「编辑器工具栏上的小图标（加粗那些）鼠标放上去不显示名称」。
 *
 * 而代码里 **title 一个都没漏** —— 每个按钮都写了 `title="加粗 Ctrl+B"`。
 * 真正的原因是它从来没显示过：
 *
 *   `.yq-toolbar` 写着 `overflow-x: auto; overflow-y: visible;`
 *   而按 CSS 规范，只要 overflow-x 不是 visible，
 *   **overflow-y 就会一并算成 auto** —— 工具栏成了纵向也裁剪的容器。
 *   提示条 `top: calc(100% + 6px)` 正好渲染在它**下面**，整条被裁光。
 *
 *   症状与「没写 title」**完全一样**（鼠标放上去什么都没发生），
 *   所以只读代码永远看不出来 —— 本地 DOM 里明明有那个元素、文字也对。
 *
 * ------------------------------------------------------------
 * 这里钉两条：
 * ① 每个工具栏按钮悬停都要出**非空的名字**（用户真正在意的）
 * ② 提示条必须挂在 body 上且是 fixed（结构判据，专门挡「被祖先裁掉」这一类）
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'

const ADMIN = 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })
const PORT = process.env.TOOLTIP_PORT || await freePort()
const DB = 'data/_e2e-tooltip.db'
const BASE = `http://localhost:${PORT}`

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { } } }
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN, ADMIN_PASS: ADMIN },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { }
}
if (!up) { console.log('服务起不来'); try { srv.kill() } catch { }; process.exit(1) }

let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { fail++; console.log(`  FAIL  ${l} ${e}`) } }

const { chromium } = await import('playwright')
const br = await chromium.launch()
try {
  const p = await (await br.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', ADMIN)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })

  // 工具栏在**文档页**才有，工作台没有
  const li = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: ADMIN }),
  })).json()
  const boot = await (await fetch(BASE + '/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + li.token } })).json()
  const docs = Array.isArray(boot.data.docs) ? boot.data.docs : Object.values(boot.data.docs || {})
  const doc = docs[0]
  await p.goto(`${BASE}/#/book/${doc.bookId || 'b1'}/doc/${doc.id}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-toolbar .yq-tb-btn, .yq-toolbar .yq-tb-icon', { timeout: 25000 })
  await p.waitForTimeout(800)

  console.log('\n== 诊断本身：工具栏的 overflow ==')
  const ov = await p.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.yq-toolbar'))
    return { x: cs.overflowX, y: cs.overflowY }
  })
  console.log(`  [记录] .yq-toolbar overflow-x=${ov.x} overflow-y=${ov.y}`)
  ok(ov.y !== 'hidden', '工具栏没有把提示纵向裁掉（overflow-y 不是 hidden/clip）', JSON.stringify(ov))

  console.log('\n== 每个图标按钮悬停都要出名字 ==')
  const n = await p.locator('.yq-toolbar .yq-tb-btn, .yq-toolbar .yq-tb-icon').count()
  ok(n >= 10, `工具栏上有 ${n} 个图标按钮`)
  const missing = []
  const seen = []
  for (let i = 0; i < n; i++) {
    const b = p.locator('.yq-toolbar .yq-tb-btn, .yq-toolbar .yq-tb-icon').nth(i)
    const glyph = ((await b.textContent()) || '').trim().slice(0, 4) || `#${i}`
    await b.hover()
    await p.waitForTimeout(180)
    const t = await p.evaluate(() => {
      const el = document.querySelector('.yq-tooltip')
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        text: (el.textContent || '').trim(),
        pos: cs.position,
        onBody: el.parentElement === document.body,
        display: cs.display,
        opacity: cs.opacity,
      }
    })
    if (!t || !t.text || t.display === 'none') { missing.push(`${glyph}:${t ? JSON.stringify(t) : '无提示条'}`); continue }
    if (t.pos !== 'fixed' || !t.onBody) { missing.push(`${glyph}:未 portal（pos=${t.pos} onBody=${t.onBody}）`); continue }
    seen.push(`${glyph}=${t.text}`)
  }
  ok(missing.length === 0, `全部 ${n} 个按钮悬停都出非空提示`, missing.join(' | '))
  console.log('  [记录] 逐个：' + seen.join(' / '))

  console.log('\n== 提示条不会被祖先裁掉（portal 结构）==')
  const portal = await p.evaluate(() => {
    const el = document.querySelector('.yq-tooltip')
    return el ? { pos: getComputedStyle(el).position, parent: el.parentElement.tagName } : null
  })
  ok(portal && portal.pos === 'fixed' && portal.parent === 'BODY',
    '提示条挂在 body 上、用 fixed 定位（滚动容器裁不到它）', JSON.stringify(portal))

  await p.screenshot({ path: `${OUT}/tooltip-visible.png` })
} catch (e) {
  fail++; console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  await br.close()
  try { srv.kill() } catch { }
  await Promise.race([once(srv, 'exit'), new Promise((r) => setTimeout(r, 4000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) { try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) } }
  }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
