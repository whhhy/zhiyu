/**
 * 知识库设置 → 安全设置 → IP 白名单：真浏览器端到端
 * ============================================================
 * 服务端那一半在 `test-ipwhitelist.mjs` 里（空名单推不进来、双重编码不能被前缀绕过）。
 * 这个套件管的是**界面上那半边** —— 服务端跑得对，界面照样可能骗人：
 *
 *   · 改之前那行文案写着「白名单为空，开启后将没有人能访问」，
 *     而服务端对空名单是**放行所有人** —— 一句关于安全的假承诺；
 *   · 所以现在：名单为空时开关**点不动**，删掉最后一个 IP 会**自动把开关关掉**。
 *
 * ⚠️ 最要紧的一条是最后那个「自动关掉」：
 * 「开着 + 空名单」在服务端是 fail closed（对所有 IP 关闭，管理员也不豁免），
 * 而这一行设置数据**本身**也在 IP 过滤范围内 ——
 * 真产生了这个状态，管理员连设置页都进不去、开关还显示为「关」。
 * 界面这一侧不把它堵住，那个状态就迟早会出现。
 *
 * 验的是**行为**：点得动吗？点了库里变没变？刷新还在吗？
 * 不是「这段文案渲染出来了」。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const ADMIN_PASS = process.env.ADMIN_PASS || 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.IPWLUI_PORT || await freePort()
const DB = 'data/_ipwl-ui-e2e.db'
for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧代码上，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN_PASS, ADMIN_PASS },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
}
if (!up) { console.error('自起服务没能在 20 秒内起来'); try { srv.kill() } catch { /* ignore */ }; process.exit(1) }
const BASE = `http://localhost:${PORT}`

/*
 * ⚠️ **必须按 bookId 过滤**。第一版写的是 `LIMIT 1` 不带 where ——
 * 而演示种子里有**别的库带着白名单**（里面是 203.0.113.55），
 * 于是整套断言读的都是那一行：明明开关可点，却报「被硬点打开了」，
 * 明明是自己加了 4 个地址，却报「进了 5 个」。
 * **判据读错了对象，比判据写错更难查** —— 它不会报错，只会给你一个
 * 看起来「差一点就对」的结论。
 */
const row = (bookId) => {
  const d = new DatabaseSync(DB)
  try {
    d.exec('PRAGMA busy_timeout = 5000')
    return d.prepare('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?').get(bookId)
  } finally { d.close() }
}
const allRows = () => {
  const d = new DatabaseSync(DB)
  try {
    d.exec('PRAGMA busy_timeout = 5000')
    return d.prepare('SELECT s.bookId, b.name, s.ipWhitelist, s.ipList FROM book_settings s JOIN books b ON b.id = s.bookId').all()
  } finally { d.close() }
}
/** 同步是防抖推送的 —— 等它落库，别用固定 sleep 撞运气 */
const waitRow = async (bookId, want, tries = 24) => {
  for (let i = 0; i < tries; i++) {
    const r = row(bookId)
    const list = (() => { try { const a = JSON.parse(String(r?.ipList ?? '[]')); return Array.isArray(a) ? a : [] } catch { return [] } })()
    if (Number(r?.ipWhitelist) === want.wl && (want.list === undefined || JSON.stringify(list) === JSON.stringify(want.list))) return { r, list, waited: i }
    await new Promise((x) => setTimeout(x, 250))
  }
  return { r: row(bookId), list: null, waited: -1 }
}

let br = null
try {
  const { chromium } = await import('playwright')
  br = await chromium.launch()
  const p = await (await br.newContext()).newPage()
  /* 从一开始就挂上取证钩子 —— 等超时了才挂，事件早过去了（收不到任何东西）。 */
  p.on('pageerror', (e) => console.log(`  取证：页面错误 = ${String(e.message).slice(0, 140)}`))
  p.on('console', (m) => { if (m.type() === 'error') console.log(`  取证：console.error = ${m.text().slice(0, 140)}`) })

  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', ADMIN_PASS)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })

  const books = await p.evaluate(async () => {
    const t = localStorage.getItem('yq_token')
    const r = await fetch('/api/entity/books', { headers: { Authorization: 'Bearer ' + t } })
    const j = await r.json()
    return (j.rows || []).map((b) => ({ id: b.id, name: b.name }))
  })
  ok(books.length > 0, `前置：有知识库可进设置（${books.length} 个）`)
  if (!books.length) throw new Error('没有知识库，前置不成立')
  const book = books[0]

  /*
   * ⚠️ 演示种子里**有别的库带着白名单**（实测到 203.0.113.55）。
   * 所以这里显式把被测的库重置成「关 + 空名单」——
   * 让前置成立，而不是指望种子里恰好没有。
   * （不这么做的话，断言读到的是别的库，套件会给出「差一点就对」的假结论。）
   */
  {
    const d = new DatabaseSync(DB)
    try {
      d.exec('PRAGMA busy_timeout = 5000')
      d.prepare('UPDATE book_settings SET ipWhitelist = 0, ipList = ? WHERE bookId = ?').run('[]', book.id)
    } finally { d.close() }
  }

  /*
   * ⚠️ 必须带 `#` —— 本项目是 **HashRouter**（src/main.tsx），
   * 应用里的地址一律是 `/#/book/...`。不带 `#` 的 `/book/...` 里**没有路由信息**，
   * 而相对 base 的资源会被解析成 `/book/b1/assets/…` → 服务端回 index.html
   * → 模块脚本 MIME 不对 → 白屏。成因与复核记录见 vite.config.ts 的 base 注释。
   */
  await p.goto(`${BASE}/#/book/${book.id}/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-bset-nav-item', { timeout: 20000 }).catch(async () => {
    /* 超时时把页面到底渲染成了什么留下来 ——
     * 只报「timeout」的话，套件红着但没人知道是路由没匹配、
     * 还是书没找到、还是数据没加载完。 */
    const body = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '(取不到)')
    await p.screenshot({ path: `${OUT}/ipwl-debug.png` }).catch(() => {})
    console.log(`  取证：地址=${p.url()}`)
    console.log(`  取证：正文=${body}`)
  })
  await p.locator('.yq-bset-nav-item', { hasText: '安全设置' }).click()
  await p.waitForSelector('.yq-bset-line', { timeout: 15000 })
  await p.waitForTimeout(500)

  /** IP 白名单那一行里的开关 */
  const wlLine = p.locator('.yq-bset-line').filter({ hasText: 'IP 白名单' })
  const wlSwitch = wlLine.locator('button.yq-switch')
  ok(await wlSwitch.count() === 1, '「IP 白名单」那一行渲染出了开关')
  const ipInput = p.locator('input[placeholder^="输入 IP 地址后回车添加"]')

  /* ---------- 1. 名单为空：开关点不动 ---------- */
  console.log('\n== 1. 名单为空 ==')
  ok(await ipInput.count() === 1, '输入框在（文案提示回车添加）')
  ok((await row(book.id)?.ipWhitelist) === 0 || Number(row(book.id)?.ipWhitelist) === 0, `前置：库里白名单是关的（${row(book.id)?.ipWhitelist}）`)

  ok(await wlSwitch.isDisabled(), '★ 名单为空时开关是**禁用**的 —— 空名单开启等于没锁门')
  // 真去点它（Playwright 对 disabled 按钮会直接抛，所以用 force 绕过保护）
  await wlSwitch.click({ force: true, timeout: 3000 }).catch(() => {})
  await p.waitForTimeout(900)
  ok(Number(row(book.id)?.ipWhitelist) === 0, '硬点也没有把开关打开（库里仍是关的）', `ipWhitelist=${row(book.id)?.ipWhitelist}`)

  const desc = (await wlLine.textContent()) || ''
  ok(desc.includes('至少要有一个地址'), '那一行把「名单至少要有一个地址」写出来了（不承诺做不到的锁门）', `实际文案=${desc.replace(/\s+/g, ' ').slice(0, 60)}`)

  /* ---------- 2. 加了 IP 才开得了 ---------- */
  console.log('\n== 2. 名单里加地址 ==')
  /* 把三种回环写法都加上：服务端到底看到 ::1 还是 127.0.0.1 不确定，
   * 少加一种就会在下面「刷新」那一步把自己锁在外面（而这正是本套件要验的状态）。 */
  const IPS = ['203.0.113.24', '127.0.0.1', '::1', '::ffff:127.0.0.1']
  for (const ip of IPS) {
    await ipInput.fill(ip)
    await ipInput.press('Enter')
    await p.waitForTimeout(350)
  }
  /* ⚠️ 必须把 list 也写进等待条件。第一版只等 `wl: 0` —— 而开关本来就是 0，
 * 于是 `waitRow` **立刻**返回了推送前的空名单，断言拿 `[]` 去比 4 个地址。
 * 「等 A 却断言 B」是这类假红的常见来源：它不报错，只是一直差一点。 */
const added = await waitRow(book.id, { wl: 0, list: IPS })
  ok(added.waited >= 0 && JSON.stringify(added.list) === JSON.stringify(IPS),
    `4 个地址都进了名单（${JSON.stringify(added.list)}）`)
  ok(!(await wlSwitch.isDisabled()), '有了地址，开关就解禁了（不是永远点不动）')
  ok((await p.locator('.yq-bset-ip-list .yq-tag').count()) === IPS.length, `界面上 ${IPS.length} 个标签都渲染出来了`)

  /* ---------- 3. 开启，并确认真的落库 ---------- */
  console.log('\n== 3. 开启白名单 ==')
  await wlSwitch.click()
  const on = await waitRow(book.id, { wl: 1 })
  ok(on.waited >= 0, `开关推到服务端了（ipWhitelist=${on.r?.ipWhitelist}，ipList=${on.r?.ipList}）`)
  ok(await p.locator('.yq-bset-ip-list .yq-tag-close').count() === IPS.length, '关闭按钮在每条上')
  const note = (await p.locator('.yq-bset-ip-list').textContent()) || ''
  ok(note.includes('管理员也不豁免'), '开着的时候提醒「管理员也不豁免」（这是刻意取舍，写出来才不会有人踩）')

  /* ---------- 4. 刷新还在（≈ 换设备 / 重登） ---------- */
  console.log('\n== 4. 刷新页面 ==')
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-bset-nav-item', { timeout: 20000 })
  await p.locator('.yq-bset-nav-item', { hasText: '安全设置' }).click()
  await p.waitForSelector('.yq-bset-line', { timeout: 15000 })
  await p.waitForTimeout(600)
  const sw2 = p.locator('.yq-bset-line').filter({ hasText: 'IP 白名单' }).locator('button.yq-switch')
  ok((await sw2.getAttribute('class') || '').includes('is-on'), '刷新后开关仍然是开的（不是只在本地内存里亮着）')
  ok((await p.locator('.yq-bset-ip-list .yq-tag').count()) === IPS.length, `刷新后 ${IPS.length} 个地址还在`)
  await p.screenshot({ path: `${OUT}/ipwl-on.png` })

  /* ---------- 5. 删掉最后一个：开关要自己关掉 ---------- */
  console.log('\n== 5. 逐条删到空 ==')
  for (let i = 0; i < IPS.length; i++) {
    await p.locator('.yq-bset-ip-list .yq-tag-close').first().click()
    await p.waitForTimeout(400)
  }
  const sw3 = p.locator('.yq-bset-line').filter({ hasText: 'IP 白名单' }).locator('button.yq-switch')
  ok(await p.locator('.yq-bset-ip-list .yq-tag').count() === 0, '地址删光了')
  ok(!(await sw3.getAttribute('class') || '').includes('is-on'), '★ 名单空了，开关**自己关掉了**')
  const cleared = await waitRow(book.id, { wl: 0, list: [] })
  ok(cleared.waited >= 0, `库里回到「关 + 空名单」（ipWhitelist=${cleared.r?.ipWhitelist} ipList=${cleared.r?.ipList}）`)
  await p.screenshot({ path: `${OUT}/ipwl-off.png` })
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  if (br) { try { await br.close() } catch { /* ignore */ } }
}

/*
 * 收摊：先 kill、**等它真的退出**，再删库。
 * kill() 只是发信号，进程还在时删它的 SQLite 会失败（Windows 文件锁），
 * 而空 catch 把失败吞掉的后果是「套件绿着、垃圾留一地」。
 * 删不掉就**说出来**，不装作收干净了。
 */
{
  const exited = once(srv, 'exit')
  srv.kill()
  const won = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!won) { try { srv.kill('SIGKILL') } catch { /* 已经没了 */ } }
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {          // 文件锁释放有延迟，重试几次
      try { rmSync(f, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone) console.log(`  ⚠️  临时库删不掉：${f}（服务可能还在占用）`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)