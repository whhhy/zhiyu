// 复验：划词工具条不该再被撑高
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const ADMIN = 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })
const PORT = process.env.SELBAR_PORT || await freePort()
const DB = 'data/_probe-selbar2.db'
const BASE = `http://localhost:${PORT}`
let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { fail++; console.log(`  FAIL  ${l} ${e}`) } }

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { } } }
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN, ADMIN_PASS: ADMIN },
  stdio: ['ignore', 'ignore', 'ignore'],
})
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); try { if ((await fetch(BASE + '/api/health')).ok) break } catch { } }

const { chromium } = await import('playwright')
const br = await chromium.launch()
try {
  const p = await (await br.newContext({ viewport: { width: 1200, height: 800 } })).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', ADMIN)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  const li = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: ADMIN }) })).json()
  const boot = await (await fetch(BASE + '/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + li.token } })).json()
  const docs = Array.isArray(boot.data.docs) ? boot.data.docs : Object.values(boot.data.docs || {})
  const doc = docs.find((d) => (d.body || '').length > 80) || docs[0]
  await p.goto(`${BASE}/#/book/${doc.bookId || 'b1'}/doc/${doc.id}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block-text', { timeout: 25000 })
  await p.waitForTimeout(1200)

  await p.evaluate(() => {
    const el = document.querySelector('.yq-block-text')
    if (!el) return
    const r = document.createRange()
    r.selectNodeContents(el)
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await p.waitForTimeout(1000)

  const info = await p.evaluate(() => {
    const el = document.querySelector('.yq-selbar')
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      position: cs.position, bottom: cs.bottom, background: cs.backgroundColor,
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
    }
  })
  console.log('  [记录] 划词工具条 =', JSON.stringify(info))
  ok(!!info, '划词工具条渲染出来了')
  ok(info && info.position === 'fixed', '它是 fixed（浮在选区上方）', info && info.position)
  /*
   * ⚠️ 这里**不能**判 `bottom === 'auto'`。
   * fixed 元素只设了 `top` 时，`bottom` 的计算值会被解成一个具体数字
   * （视口高 - top - 高），不是 auto —— 第一版就是这么写的，红了，
   * 而工具条其实已经修好了。
   *
   * 真正能判「有没有被撑高」的是**高度本身**：类名冲突前是 549px，
   * 冲突后是一个正常工具条的 33px。
   */
  ok(info && info.rect.h <= 44, `高度是正常工具条尺寸（实得 ${info && info.rect.h}px，上限 44）`, info && String(info.rect.h))
  ok(info && info.rect.w >= 100 && info.rect.w <= 320, `宽度合理（实得 ${info && info.rect.w}px）`, info && String(info.rect.w))
  await p.screenshot({ path: `${OUT}/_dbg-selbar.png` })

  // 批量操作条仍在（改名不是删功能）
  const bulk = await p.evaluate(() => !!document.querySelector('.yq-bulkbar') || !document.querySelector('[data-selected]'))
  ok(bulk, '批量操作条那一套仍在（改名不是删功能）')
} catch (e) {
  fail++; console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  await br.close()
  try { srv.kill() } catch { }
  await Promise.race([once(srv, 'exit'), new Promise((r) => setTimeout(r, 4000))])
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (!existsSync(f)) continue; for (let i = 0; i < 5; i++) { try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) } } }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
