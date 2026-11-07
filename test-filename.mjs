/*
 * 导出文件名（2026-10-12 补）
 *
 * ============================================================
 * 两个同名但实现不同的 `safeName` 叠在一起
 * ============================================================
 *   · `book-export.ts`  只替换非法字符，**保留中文**
 *   · `io.ts`            把**所有非 ASCII** 换成 `_`
 *
 * 实测（走真实界面点「···」→ 导出，截获 `<a download>`）：
 *   标题《产品手册》
 *     Markdown（走 book-export）→ `产品手册.md`   ✅
 *     Word / HTML / 纯文本（走 io）→ `untitled-20261014-1006.docx` ❌
 *
 * 也就是**这个中文知识库，四种导出格式里三种丢掉文件名**，
 * 而且同一天导出的多篇会撞名（浏览器只能追加 (1)(2)）。
 *
 * ============================================================
 * 修的过程中又露出第二个 bug：扩展名也没了
 * ============================================================
 * `io.ts` 那份 `safeName(raw, fallbackExt)` **只在回退分支带扩展名**，
 * 正常分支直接返回标题 —— 于是每次成功导出都是**无扩展名文件**，
 * Word / HTML / 纯文本双击都打不开。
 *
 * ⚠️ 它一直没被发现，是因为**中文标题恰好走了回退分支**（那分支带扩展名），
 * 而 ASCII 标题才会暴露无扩展名 —— 一个 bug 恰好被另一个 bug 挡住了。
 * 我的第一版探针只测中文，于是「修好中文」之后才看见它。
 *
 * 现在两份收成 `@/lib/filename` 一份实现，扩展名由它统一补。
 *
 * ============================================================
 * 判据要点
 * ============================================================
 * · 必须走**真实界面**点导出：dist 产物里取不到 `/src/lib/io.ts`，
 *   而「界面点出来叫什么」本来就是用户实际拿到的东西。
 * · 边界要一起测：空标题（回退）、非法字符、超长、**标题已带扩展名**、
 *   Windows 不允许的结尾点/空格 —— 只测中文那一条会漏掉一半。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.FILENAME_PORT || await freePort()
const DB = 'data/_filename.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着删 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 等 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const login = async (page) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.waitForSelector('.yq-login-submit:not([disabled])', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await page.fill('.yq-login-card input[type="password"]', 'yuque@2026')
  await page.click('.yq-login-submit')
  let inApp = false
  for (let i = 0; i < 25 && !inApp; i++) {
    await page.waitForTimeout(1000)
    inApp = await page.evaluate(() => !!document.querySelector('.yq-app')).catch(() => false)
  }
  if (!inApp) throw new Error('登录后未进入应用')
  await page.waitForTimeout(2000)
}

/** 改一篇文档的标题（改完刷新，再点四种导出），返回四个文件名 */
const exportNames = async (p, docId, newTitle) => {
  await p.evaluate(([d, t]) => window.__yqStore.getState().updateDoc(d, { title: t }), [docId, newTitle])
  await p.waitForTimeout(5000)
  await p.goto(`${BASE}${await p.evaluate(() => location.hash)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-app', { timeout: 25000 })
  await p.waitForTimeout(3500)
  await p.evaluate(() => {
    window.__names = []
    const orig = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () { window.__names.push(this.download) }
    URL.createObjectURL = () => 'blob:fake'
  })
  for (const re of [/导出 Markdown/, /导出 Word/, /导出 HTML/, /导出纯文本/]) {
    await p.locator('.yq-doc-more').first().click({ timeout: 8000 })
    await p.waitForTimeout(700)
    const n = await p.locator('.yq-menu-item', { hasText: re }).first().count()
    if (!n) { await p.keyboard.press('Escape'); continue }
    await p.locator('.yq-menu-item', { hasText: re }).first().click({ timeout: 8000 })
    await p.waitForTimeout(1000)
  }
  return p.evaluate(() => window.__names)
}

const EXT = ['.md', '.docx', '.html', '.txt']

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
    await login(p)
    const H = { Authorization: 'Bearer ' + await p.evaluate(() => localStorage.getItem('yq_token')), 'Content-Type': 'application/json' }
    const sfx = Date.now().toString(36)
    const made = await p.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '文件名 ' + x)
      const d = window.__yqStore.getState().createDoc(b, null, '产品手册')
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'h1', type: 'h1', text: '产品手册' }, { id: 'p', type: 'p', text: '正文。' }])
      return { b, d }
    }, sfx)
    for (let i = 0; i < 30; i++) {
      const bo = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await p.waitForTimeout(500)
    }
    await p.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.waitForTimeout(4000)

    const check = async (title, want, label) => {
      const names = await exportNames(p, made.d, title)
      console.log(`  ${label}：${JSON.stringify(names)}`)
      if (names.length < 4) { ok(false, `${label}｜四种格式都点到了`, `只拿到 ${names.length} 个`); return }
      for (let i = 0; i < 4; i++) {
        const n = names[i]
        ok(want(n, EXT[i]), `${label}｜${EXT[i]} = ${JSON.stringify(n)}`,
          `期望符合「${label}」的规则`)
      }
    }

    console.log('\n== ① 中文标题要保住，四种格式都要带扩展名 ==')
    await check('产品手册', (n, e) => n === '产品手册' + e, '中文')

    console.log('\n== ② ASCII 标题：原样 + 扩展名（这一条以前是**无扩展名文件**）==')
    await check('Q3 Review', (n, e) => n === 'Q3 Review' + e, 'ASCII')

    console.log('\n== ③ 非法字符替换，中文保留 ==')
    await check('设计/方案:v2?', (n, e) => n === '设计_方案_v2_' + e, '非法字符')

    console.log('\n== ④ 标题已经带了扩展名，不补两次 ==')
    // ⚠️ 期望要**按目标格式**写：标题是「手册.md」，
    //   导 Markdown 不该变成 `手册.md.md`；
    //   导 Word 则应把标题自带的那个 `.md` 去掉再补 `.docx` → `手册.docx`。
    //   我第一版对四种格式用了同一个「以 .md 结尾」的期望，于是另外三条被误判。
    await check('手册.md', (n, e) => n === '手册' + e, '已带扩展名')

    console.log('\n== ⑤ Windows 不允许结尾是点或空格 ==')
    await check('收尾带点.', (n, e) => !/[. ]$/.test(n.replace(/\.[a-z]+$/, '')) && n.endsWith(e), '结尾点')

    console.log('\n== ⑥ 超长标题要截断 ==')
    await check('长'.repeat(120), (n) => n.length <= 90 && n.includes('…'), '超长')

    console.log('\n== ⑦ 空标题走回退 ==')
    await check('   ', (n, e) => /^untitled-\d{8}-\d{4}\.escaped$/.test(n.replace(/\./g, 'escaped')) || /^untitled-\d{8}-\d{4}/.test(n), '空标题')
  } finally { await br.close() }
} catch (e) {
  fail++
  console.error('异常：', e.stack || e.message)
} finally {
  const exited = once(srv, 'exit')
  srv.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) {
      try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)