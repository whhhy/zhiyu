/*
 * 侧栏书行那个 ⋯：必须是**真菜单**，不是跳转（2026-10-17）
 *
 * 起因：它原来是 `<button title="知识库设置" onClick={navigate('/book/.../settings')}>⋯</button>`
 * —— 图标是「更多菜单」，实际把人带离知识库。而书页右上角**已经**有一个真·⋯ 菜单，
 * 同一个图标两种行为。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'

const ADMIN = 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })
const PORT = process.env.TREE_MENU_PORT || await freePort()
const DB = 'data/_e2e-tree-menu.db'
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
  const p = await (await br.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', ADMIN)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  const li = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: ADMIN }) })).json()
  const boot = await (await fetch(BASE + '/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + li.token } })).json()
  const books = Array.isArray(boot.data.books) ? boot.data.books : Object.values(boot.data.books || {})
  const book = books[0]
  // 进文档页 —— 侧栏在那儿，而且文档页是「树上没有设置入口」的那种页面
  const docs = Array.isArray(boot.data.docs) ? boot.data.docs : Object.values(boot.data.docs || {})
  const doc = docs.find((d) => d.id)
  await p.goto(`${BASE}/#/book/${book.id}/doc/${doc.id}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-tree-more', { timeout: 25000 })
  await p.waitForTimeout(1000)

  const before = await p.evaluate(() => location.hash)
  const dots = p.locator('.yq-tree-more')
  ok(await dots.count() === 1, '侧栏书行上有一个 ⋯', String(await dots.count()))

  const title = await dots.first().getAttribute('title')
  ok(title && title.includes('菜单'), '它的 title 说「知识库菜单」（不是「设置」——那个名字在说谎）', String(title))

  await dots.first().click()
  await p.waitForTimeout(1000)
  const after = await p.evaluate(() => location.hash)
  ok(after === before, `点它**不跳转**（${before} → ${after}）`)
  ok(!after.includes('/settings'), '没有被带去设置页', after)

  const menu = p.locator('.yq-menu, .yq-popover').last()
  await menu.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  const items = await p.locator('.yq-menu-item, .yq-menu .yq-menu-item').allTextContents().catch(() => [])
  const txt = items.join(' | ') || (await menu.innerText().catch(() => ''))
  console.log('  [记录] 菜单项 =', JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 120)))
  ok(/知识库设置/.test(txt), '菜单里有「知识库设置」')
  ok(/重命名/.test(txt), '菜单里有「重命名知识库」')
  ok(/收藏/.test(txt), '菜单里有收藏项')
  ok(!/新建文档|新建分组/.test(txt),
    '菜单里**没有**新建项（目录行下面已经有那一处新建入口，重复会让「点哪儿都没反应」）')

  await p.screenshot({ path: `${OUT}/tree-book-menu.png` })

  // 真的走一遍：点「知识库设置」应该到设置页
  await p.locator('.yq-menu-item', { hasText: '知识库设置' }).first().click()
  await p.waitForTimeout(1200)
  ok(/\/book\/[^/]+\/settings/.test(await p.evaluate(() => location.hash)),
    '点「知识库设置」才真的进设置页', await p.evaluate(() => location.hash))
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
