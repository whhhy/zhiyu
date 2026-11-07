/*
 * 侧栏顶部搜索框 —— 真浏览器端到端。
 *
 * ------------------------------------------------------------
 * 这个框的来历（2026-10-11 实测真实语雀的 DOM）
 *
 *   <span class="ant-input-affix-wrapper ant-input-affix-wrapper-disabled …">
 *     <span class="ant-input-prefix"><svg …/></span>
 *     <input class="ant-input ant-input-disabled" disabled placeholder="搜索">
 *     <span class="ant-input-suffix">Ctrl J</span>
 *
 * ⚠️ 关键：**它带 `disabled`，在语雀里点不动** ——
 *    只是个指向快捷键的视觉提示，真搜索必须按 Ctrl J。
 *    所以照抄的时候连「禁用」一起抄，
 *    而不是接一个「点了就弹搜索」的动作 ——
 *    一个长得能点、点了没反应的框比没有更糟。
 *
 * ------------------------------------------------------------
 * 最要紧的一条不是「框在不在」
 *
 * 这个框本身是禁用的，它唯一的作用是**指路**：告诉用户该按 Ctrl J。
 * 所以「Ctrl J 真的能唤起全局搜索」才是这个功能的全部意义 ——
 * 只断言框渲染出来了，等于验了一块纯装饰。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'

const ADMIN_PASS = process.env.ADMIN_PASS || 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const tmpFiles = []
let ownSrv = null
let BASE = process.env.BASE

if (!BASE) {
  const PORT = process.env.SIDENAV_PORT || await freePort()
  const DB = 'data/_sidenav-e2e.db'
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
  }
  if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) {
    console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
    process.exit(1)
  }
  ownSrv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN_PASS, ADMIN_PASS },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
  }
  if (!up) { console.error('自起服务没能在 20 秒内起来'); try { ownSrv.kill() } catch {}; process.exit(1) }
  BASE = `http://localhost:${PORT}`
  console.log(`\n== 自起服务 ${BASE} ==`)
}

try {
  const { chromium } = await import('playwright')
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext()).newPage()
    await p.goto(BASE, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', ADMIN_PASS)
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })
    await p.waitForSelector('.yq-sidenav-search', { timeout: 15000 })
    await p.waitForTimeout(600)

    const box = p.locator('.yq-sidenav-search')
    ok(await box.count() === 1, '侧栏渲染出了顶部搜索框')
    ok(await box.locator('input').isDisabled(),
      '它是**禁用**的（真实语雀那个也带 disabled、点不动 —— 1:1 就该照抄这一点）')
    const ph = await box.locator('input').getAttribute('placeholder')
    ok(ph === '搜索', 'placeholder 是「搜索」', `实际=${ph}`)
    const kbd = (await box.locator('kbd').textContent() || '').trim()
    ok(kbd === 'Ctrl J', '框里印着 Ctrl J（与实测语雀 DOM 的 ant-input-suffix 一致）', `实际=「${kbd}」`)

    const pos = await p.evaluate(() => {
      const kids = [...document.querySelector('.yq-sidenav').children]
      return {
        search: kids.findIndex((k) => k.classList.contains('yq-sidenav-search')),
        space: kids.findIndex((k) => k.classList.contains('yq-sidenav-space')),
      }
    })
    ok(pos.search === 0 && pos.space > pos.search,
      '它在侧栏第一项（空间卡片上面），与语雀一致', `search@${pos.search} space@${pos.space}`)

    /* 框是指路的，所以它指的那个键必须真的管用 */
    await p.keyboard.press('Control+j')
    await p.waitForTimeout(800)
    ok(await p.locator('.yq-searchpanel-input').count() > 0,
      '按 Ctrl J 真的能开出全局搜索（框不是纯装饰）')
    await p.screenshot({ path: `${OUT}/sidenav-search-panel.png` })
    await p.keyboard.press('Escape')
    await p.waitForTimeout(400)
    await p.screenshot({ path: `${OUT}/sidenav-search.png` })
  } finally {
    await br.close()
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
}

for (const f of tmpFiles) { try { rmSync(f, { force: true }) } catch { /* 留着 */ } }

/*
 * 自起的服务必须**等它真的退出**再删库。
 * kill() 只是发信号，进程还在的时候删它的 SQLite 会失败（Windows 上文件锁）。
 * 而 `catch {}` 把失败吞掉的后果是「套件绿着、垃圾留一地」——
 * 所以这里等 exit，再删；删不掉就**说出来**，不装作收干净了。
 */
if (ownSrv) {
  const exited = once(ownSrv, 'exit')
  ownSrv.kill()
  const won = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!won) { try { ownSrv.kill('SIGKILL') } catch { /* 已经没了 */ } }
  const db = `data/_sidenav-e2e.db`
  for (const s of ['', '-wal', '-shm']) {
    const f = db + s
    if (!existsSync(f)) continue
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {          // 文件锁释放有延迟，重试几次
      try { rmSync(f, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone) console.log(`  ⚠️  临时库删不掉：${f}（服务可能还在占用，明早再看）`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)