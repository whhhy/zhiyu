/*
 * 「新建文档」入口在**没有 create 权限时**的表现（2026-10-14 补）
 *
 * ============================
 * 缺陷：被拒之后仍然报「已新建」，还跳进死链
 * ------------------------------------------------------------
 * `createDoc` 在没有 `create` 权限时返回**空串**（store 的第二道守卫
 * `bookCreateBlocked`）。有两个入口**根本没看这个返回值**：
 *
 *   · `TopBar.tsx` 的新建弹窗（工作台「开始」区的「新建文档」卡、顶栏 + 号）
 *       const id = createDoc(bookId, null, '未命名', type)
 *       toast(`已新建${label}`, 'success')      // ← 无条件报成功
 *       navigate(`/book/${bookId}/doc/${id}`)  // ← id 是空串 → 死链
 *   · `BookSettings.tsx` 文档管理里的「新建」
 *       同上两句，而且是同一个形状。
 *
 * 比「点了没反应」更糟：**它先让用户信了**。
 * 用户看到绿色「已新建文档」，被带到一个打不开的地址，
 * 而目录树上什么都没有 —— 顶栏也不会挂告警（store 压根没改本地状态）。
 *
 * 第三个调用点（`DocPage.tsx` 插画板/工作表/数据表卡片）也是同一形状，
 * 但它在编辑器的插卡片面板里，读者走不到，**那是纵深防御不是活缺陷**，
 * 所以这里不测它 —— 守卫要钉的是读者真能点到的那两个。
 *
 * ============================
 * 判据要点
 * ============================
 * · **要验的是三件事，缺一不可**：没有「成功」提示、有一条说明权限的话、
 *   地址**没有**跳到 `/doc/` 后面为空的那种。只查「没报错」会被漏过去。
 * · 提示 2600ms 自动消失，采样必须早于它。
 * · **反向必须有**：编辑者（`create: true`）点同样的入口，
 *   要照样建得出来、照样报成功 —— 否则就成了「把功能关了」。
 *   平台 owner 走早退，不能当反向样本（见 `perms.ts` 的 `bookCapsSync`）。
 * · 「建不了」和「没问过」要分开：`bookCreateBlocked` 只在「问过且没有」时拒，
 *   所以判据必须等权限真的问回来，否则读者会被当成「没问过」而放行。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.CREATE_DENIED_PORT || await freePort()
const DB = 'data/_createdeny.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着删 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑。自起服务会打错目标，结果不可信。`)
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

const login = async (page, a, pw) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.waitForSelector('.yq-login-submit:not([disabled])', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', a)
  await page.fill('.yq-login-card input[type="password"]', pw)
  await page.click('.yq-login-submit')
  let inApp = false
  for (let i = 0; i < 25 && !inApp; i++) {
    await page.waitForTimeout(1000)
    inApp = await page.evaluate(() => !!document.querySelector('.yq-app')).catch(() => false)
  }
  if (!inApp) throw new Error(`登录 ${a} 后未进入应用`)
  await page.waitForTimeout(2000)
}
const hdr = async (page) => ({
  Authorization: 'Bearer ' + await page.evaluate(() => localStorage.getItem('yq_token')),
  'Content-Type': 'application/json; charset=utf-8',
})
/** 点完立刻采：提示 2600ms 就消失，等过了读到的永远是空数组 */
const clickAndSample = async (page, clickFn) => {
  const urlBefore = await page.evaluate(() => location.hash)
  const r = await clickFn()
  const st = await page.evaluate(() => {
    const s = window.__yqStore.getState()
    return { hash: location.hash, toasts: s.toasts.map((t) => t.message || ''), docCount: Object.keys(s.docs).length }
  })
  return { ...r, ...st, hashAfter: st.hash, urlBefore, extra: r && r.extra }
}

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
    await login(p, 'admin', 'yuque@2026')
    const H = await hdr(p)
    const sfx = Date.now().toString(36)

    const made = await p.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '新建权限 ' + x)
      const d = window.__yqStore.getState().createDoc(b, null, '一篇 ' + x)
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'h1', type: 'h1', text: '一篇 ' + x }])
      // 再建一个**空的**库：设置页那个「新建」按钮是 Empty 的 action，
      // 只在**一篇文档都没有**的时候才渲染（见 BookSettings 的 DocsTab）。
      // 不建空库的话这条路径压根走不到 —— 我第一版就栽在这儿，
      // 按钮查出来是 null，还以为是产品把它藏了。
      const empty = window.__yqStore.getState().createBook('s1', '空库 ' + x)
      return { b, d, empty }
    }, sfx)
    for (let i = 0; i < 30; i++) {
      const bo = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      const ids = (bo.data.books || []).map((x) => x.id)
      if (ids.includes(made.b) && ids.includes(made.empty)) break
      await p.waitForTimeout(500)
    }

    const PERMS = {
      editor: { read: true, comment: true, edit: true, create: true, export: true, share: true },
      reader: { read: true, comment: true, edit: false, create: false, export: true, share: false },
    }
    const accounts = {}
    for (const role of ['editor', 'reader']) {
      const acct = `cd_${role}_${sfx}`
      const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `新建${role}` },
      })).json()
      const rows = []
      for (const bid of [made.b, made.empty]) {
        rows.push({ bookId: bid, userId: reg.user.id, role, perms: PERMS[role], joinedAt: Date.now() })
      }
      await p.request.post(`${BASE}/api/sync/push`, {
        headers: H,
        data: { upsert: { bookMembers: rows } },
      })
      accounts[role] = acct
    }
    /*
     * 第 ⑧ 节要用的第三种身份：**源库是编辑者、目标库是读者**。
     *
     * ⚠️ 为什么非编不可：移动/复制这个入口被 `noEditRight` 门控，
     * 而服务端 `moveDoc` 两边都判（源库要 edit、目标库要 create）。
     * 所以：
     *   · 读者（两个库都不能建）**进不到这个弹窗** —— 测他等于没测；
     *   · 编辑者（两个库都能建）**全都可选** —— 也测不出问题。
     * 唯一能把「目标库不能建」这一半单独拎出来的，就是**同一个人两种身份**。
     */
    {
      const acct = `cd_mover_${sfx}`
      const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: '搬得动但搬不进' },
      })).json()
      await p.request.post(`${BASE}/api/sync/push`, {
        headers: H,
        data: {
          upsert: { bookMembers: [
            { bookId: made.b, userId: reg.user.id, role: 'editor', perms: PERMS.editor, joinedAt: Date.now() },
            { bookId: made.empty, userId: reg.user.id, role: 'reader', perms: PERMS.reader, joinedAt: Date.now() },
          ] },
        },
      })
      accounts.mover = acct
    }
    await p.waitForTimeout(6000)

    /* ---------- ① 弹窗里那个库列表本来就该标出来 ---------- */
    console.log('\n== ① 工作台「新建文档」弹窗：列表按 create 权限标注 ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.waitForTimeout(2500)
      await pg.locator('.yq-start-card', { hasText: '新建文档' }).first().click({ timeout: 8000 })
      await pg.waitForSelector('.yq-new-doc', { timeout: 8000 })
      await pg.waitForTimeout(2500)   // 等 useBookPermsMany 把权限问回来
      const rows = await pg.evaluate(() => [...document.querySelectorAll('.yq-new-doc-book')].map((b) => ({
        name: (b.querySelector('.yq-new-doc-book-name')?.textContent || '').trim(),
        meta: (b.querySelector('.yq-new-doc-book-meta')?.textContent || '').trim(),
        disabled: b.disabled === true,
      })))
      console.log('   库列表：', JSON.stringify(rows))
      const mine = rows.find((r) => r.name.includes('新建权限'))
      ok(!!mine && mine.disabled === true, '读者在弹窗里那个库是**禁用**的（不是完全看不见 —— 他读得到这个库）')
      ok(!!mine && /无新建权限/.test(mine.meta), '并且写明了原因')
      await pg.close()
    }

    /* ---------- ② 点类型之后：不能报成功、不能跳死链 ---------- */
    console.log('\n== ② 读者点「文档」类型之后 ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.waitForTimeout(2500)
      const before = await pg.evaluate(() => ({ hash: location.hash, n: Object.keys(window.__yqStore.getState().docs).length }))
      await pg.locator('.yq-start-card', { hasText: '新建文档' }).first().click({ timeout: 8000 })
      await pg.waitForSelector('.yq-new-doc', { timeout: 8000 })
      await pg.waitForTimeout(2500)
      // 直接调 store action，等于「绕过列表、直接点类型」那条最坏路径
      const r = await pg.evaluate(async (bid) => {
        const s = window.__yqStore.getState()
        const id = s.createDocOrExplain(bid, null, '未命名', 'doc')
        const cur = window.__yqStore.getState()
        return { id, toasts: cur.toasts.map((t) => t.message || ''), hash: location.hash, n: Object.keys(cur.docs).length }
      }, made.b)
      console.log(`   返回的 id=${JSON.stringify(r.id)}；提示：${JSON.stringify(r.toasts)}；地址=${r.hash}`)
      ok(r.id === '', 'store 拒绝了（返回空串）')
      ok(!r.toasts.some((t) => /已新建/.test(t)), `**没有**报「已新建」（实际：${r.toasts.join(' / ') || '无提示'}）`)
      ok(r.toasts.some((t) => /权限/.test(t)), `并且明确说了是权限问题（实际：${r.toasts.join(' / ') || '无'}）`)
      ok(r.n === before.n, `本地一篇都没多（${before.n} → ${r.n}）`)
      ok(!/\/doc\/(\s*)$/.test(r.hash), '没有跳到「/doc/ 后面为空」那种死链（当前 ' + r.hash + '）')
      await pg.close()
    }

    /* ---------- ③ 设置页那个「新建」按钮 ---------- */
    console.log('\n== ③ 设置页「文档管理」里的「新建」 ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.empty}/settings`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(3500)
      await pg.locator('.yq-bset-nav-item', { hasText: '文档管理' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(2000)
      const btn = await pg.evaluate(() => {
        const b = [...document.querySelectorAll('.yq-bset-card button')].find((x) => (x.textContent || '').trim() === '新建')
        return b ? { disabled: b.disabled === true } : null
      })
      console.log('   「新建」按钮：', JSON.stringify(btn))
      const before = await pg.evaluate(() => ({ hash: location.hash, n: Object.keys(window.__yqStore.getState().docs).length }))
      if (btn && !btn.disabled) {
        await pg.locator('.yq-bset-card button', { hasText: '新建' }).first().click({ timeout: 8000 })
        await pg.waitForTimeout(700)
        const after = await pg.evaluate(() => {
          const s = window.__yqStore.getState()
          return { hash: location.hash, toasts: s.toasts.map((t) => t.message || ''), n: Object.keys(s.docs).length }
        })
        console.log(`   点完：提示=${JSON.stringify(after.toasts)}；地址=${after.hash}`)
        /*
         * ⚠️ 分清两件事，性质完全不同：
         *   · 服务端**拒收** → 假动作：本地多了一篇、顶栏挂一条他自己修不好的告警；
         *   · 服务端**收下** → 权限绕过（比上面那个严重一个量级）。
         * 所以先问服务端，别只看本地。
         */
        const localId = (after.hash.match(/doc\/(d_\w+)/) || [])[1]
        await pg.waitForTimeout(5000)
        const RH = await hdr(pg)
        const onServer = localId
          ? await (async () => {
              const r = await (await p.request.get(`${BASE}/api/doc/${localId}`, { headers: RH })).json()
              return !!r?.doc
            })()
          : false
        console.log(`   服务端有没有这篇（${localId || '没拿到 id'}）：${onServer ? '★ 收下了 —— 那是权限绕过' : '拒收了（本地多出来的那篇是假的）'}`)
        ok(!onServer, '**服务端拒收了** —— 没有权限绕过（这条最要紧，性质和下面两条完全不同）')
        ok(!after.toasts.some((t) => /已新建/.test(t)), '**没有**报「已新建文档」')
        ok(after.n === before.n, '本地一篇都没多')
      } else {
        ok(!!btn && btn.disabled === true, '按钮是禁用的（更好：入口直接关掉）')
      }
      await pg.close()
    }

    /* ---------- ④ 反向：编辑者必须还能建 ---------- */
    console.log('\n== ④ 反向：编辑者（create: true）照样建得出来 ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.editor, 'test1234')
      await pg.waitForTimeout(3000)
      await pg.locator('.yq-start-card', { hasText: '新建文档' }).first().click({ timeout: 8000 })
      await pg.waitForSelector('.yq-new-doc', { timeout: 8000 })
      await pg.waitForTimeout(2500)
      const row = await pg.evaluate((nm) => {
        const b = [...document.querySelectorAll('.yq-new-doc-book')].find((x) => (x.textContent || '').includes(nm))
        return b ? { disabled: b.disabled === true } : null
      }, '新建权限')
      ok(!!row && row.disabled === false, '编辑者在弹窗里那个库**可选**')
      const r = await pg.evaluate(async (bid) => {
        const before = Object.keys(window.__yqStore.getState().docs).length
        const id = window.__yqStore.getState().createDocOrExplain(bid, null, '未命名', 'doc')
        const after = Object.keys(window.__yqStore.getState().docs).length
        return { id, before, after, toasts: window.__yqStore.getState().toasts.map((t) => t.message || '') }
      }, made.b)
      console.log(`   id=${JSON.stringify(r.id)}；文档数 ${r.before} → ${r.after}`)
      ok(!!r.id && r.after === r.before + 1, '编辑者**建得出来**（不能把关全关上，那叫「功能没了」）')
      await pg.close()
    }

    /* ---------- ⑤ 模板中心：同一个病的第三个现场 ---------- */
    console.log('\n== ⑤ 模板中心「用此模板新建」（同一个病，第三个现场） ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.goto(`${BASE}/#/templates`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4000)
      const before = await pg.evaluate(() => ({ n: Object.keys(window.__yqStore.getState().docs).length }))
      // 直接打 store：等价于「在弹窗里选一个建不了的库然后点确认」
      const r = await pg.evaluate((bid) => {
        const s = window.__yqStore.getState()
        const tpl = s.templates[0]
        if (!tpl) return { noTpl: true }
        const id = s.applyTemplate(bid, null, tpl.id)
        const cur = window.__yqStore.getState()
        return { id, n: Object.keys(cur.docs).length, toasts: cur.toasts.map((t) => t.message || '') }
      }, made.b)
      console.log('   模板存在：' + (r.noTpl ? '★ 没有' : '是') + `；返回 id=${JSON.stringify(r.id)}；文档数 ${before.n} → ${r.n}`)
      if (r.noTpl) {
        ok(false, '种子数据里一篇模板都没有 —— 判据前提没造出来，不能拿它判绿')
      } else {
        ok(r.id === '', 'applyTemplate 拒绝了（返回空串）—— 这一页以前**没挂权限 hook**，守卫读到 null 就放行了')
        ok(r.n === before.n, `本地一篇都没多（${before.n} → ${r.n}）`)
        ok(!r.toasts.some((t) => /已用.*新建文档/.test(t)), `**没有**报「已用《…》新建文档」（实际：${r.toasts.join(' / ') || '无'}）`)
      }
      await pg.close()
    }

    /* ---------- ⑥ 模板中心那一页的库列表也要标出来 ---------- */
    console.log('\n== ⑥ 模板中心的「用此模板新建」弹窗：库列表按 create 权限标注 ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.goto(`${BASE}/#/templates`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4000)
      const opened = await pg.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '用此模板')
        if (!b) return false
        b.click(); return true
      })
      if (!opened) {
        ok(false, '模板卡片上找不到「用此模板」按钮 —— 前提没造出来，不能拿它判绿')
      } else {
        await pg.waitForSelector('.yq-tpl-books', { timeout: 8000 })
        await pg.waitForTimeout(2500)
        const rows = await pg.evaluate(() => [...document.querySelectorAll('.yq-tpl-book')].map((b) => ({
          name: (b.querySelector('.yq-tpl-book-name')?.textContent || '').trim(),
          meta: (b.querySelector('.yq-tpl-book-meta')?.textContent || '').trim(),
          disabled: b.disabled === true,
        })))
        console.log('   库列表：', JSON.stringify(rows))
        const mine = rows.find((r) => r.name.includes('新建权限'))
        ok(!!mine && mine.disabled === true, '读者那一行是**禁用**的')
        ok(!!mine && /无新建权限/.test(mine.meta), '并且写明了原因')
        const confirm = await pg.evaluate(() => {
          const b = [...document.querySelectorAll('.yq-tpl-foot button')].find((x) => (x.textContent || '').trim() === '确认新建')
          return b ? { disabled: b.disabled === true } : null
        })
        ok(!!confirm && confirm.disabled === true, '「确认新建」也是禁用的（fail closed：权限没问回来时不放行）')
      }
      await pg.close()
    }

    /* ---------- ⑦ 导入：建库被拒时不能造出孤儿文档、也不能报「导入完成」 ---------- */
    console.log('\n== ⑦ Markdown 导入（非空间管理员） ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(3500)
      // 导入在「数据管理」这个标签里 —— 不切过去的话，
      // 整页只有一个默认的「个人资料」，入口压根不存在（我第一版就栽在这儿，
      // 还以为「入口没渲染 = 产品藏了」）。
      await pg.locator('.yq-settings-nav-item', { hasText: '数据管理' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(1200)

      // 前提先造出来：他不是空间管理员 ⇒ createBook 会被拒
      const bookId = await pg.evaluate(() => {
        const st = window.__yqStore.getState()
        const sid = st.spaces[0]?.id
        return { sid, id: st.createBook(sid, '越权建库试试') }
      })
      console.log('   createBook 返回：', JSON.stringify(bookId))
      ok(bookId.id === '', '前提：不是空间管理员时 createBook 返回空串')

      /*
       * 导入入口现在是「导入…」→ 格式选择器（2026-10-16 照语雀的形态改的），
       * 原来那个「选择文件夹」按钮没有了 —— 但**这条断言的意图没变**：
       * 验的是「入口**没有**按管理员隐藏，所以非管理员这条路真的够得着」，
       * 而够得着之后会不会造出孤儿文档。
       */
      const entry = pg.locator('button', { hasText: '导入…' })
      ok(await entry.count() > 0, '设置里有「导入…」入口（**没有**按管理员隐藏）——所以这条路径真的够得着')
      if (await entry.count() === 0) { await pg.close(); throw new Error('导入入口没找到，后面的断言没意义') }
      await entry.first().click()
      await pg.waitForSelector('.yq-imppick-item', { state: 'visible', timeout: 8000 })
      const mdPick = pg.locator('.yq-imppick-item', { hasText: 'Markdown 文件夹' })
      ok(await mdPick.count() === 1, '格式选择器里列着「Markdown 文件夹」')

      const before = await pg.evaluate(() => Object.keys(window.__yqStore.getState().docs).length)
      await mdPick.first().click()
      await pg.waitForSelector('.yq-import-drop input[type="file"]', { state: 'attached', timeout: 10000 })
      // 文件 input 是隐藏的（靠点 label 触发），页面上有好几个 —— 必须取最后一个，
      // 否则会抓到「导入数据包」那个永远不可见的 input（见 test-import-md.mjs）。
      await pg.evaluate(() => {
        const inputs = document.querySelectorAll('.yq-import-drop input[type="file"]')
        const input = inputs[inputs.length - 1]
        const dt = new DataTransfer()
        for (const [rel, text] of Object.entries({
          '手册/a.md': '# 甲\n\n正文一。',
          '手册/b.md': '# 乙\n\n正文二。',
        })) {
          const f = new File([text], rel.split('/').pop(), { type: 'text/markdown' })
          Object.defineProperty(f, 'webkitRelativePath', { value: rel })
          dt.items.add(f)
        }
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await pg.waitForTimeout(2500)
      const confirm = pg.locator('button:has-text("确认导入")')
      if (await confirm.count()) {
        await confirm.first().click()
        await pg.waitForTimeout(2500)   // 必须早于 2600ms 的 toast 自动消失
        const r = await pg.evaluate((b) => {
          const s = window.__yqStore.getState()
          return {
            n: Object.keys(s.docs).length,
            orphan: Object.values(s.docs).filter((d) => !d.bookId).length,
            toasts: s.toasts.map((t) => t.message || ''),
            info: (document.querySelector('.yq-import-info')?.textContent || '').replace(/\s+/g, ' ').slice(0, 90),
          }
        }, before)
        console.log(`   点完：文档数 ${before} → ${r.n}（无归属 ${r.orphan}）；提示=${JSON.stringify(r.toasts)}`)
        ok(!r.toasts.some((t) => /导入完成/.test(t)), `**没有**报「导入完成」（实际：${r.toasts.join(' / ') || '无'}）`)
        ok(r.toasts.some((t) => /管理员|权限/.test(t)), `明确说了是权限问题（实际：${r.toasts.join(' / ') || '无'}）`)
        ok(r.orphan === 0, `没有造出**孤儿文档**（bookId 为空的：${r.orphan} 篇）`)
        ok(r.n === before, `本地一篇都没多（${before} → ${r.n}）`)
      } else {
        ok(false, '预览没出来 —— 前提没造出来，不能拿它判绿')
      }
      await pg.close()
    }

    /* ---------- ⑧ 移动/复制：目标库没有 create 就不该给这个选项 ---------- */
    console.log('\n== ⑧ 「移动 / 复制到…」的目标库列表 ==')
    // ⚠️ 定义在**块外面**：两段都要用它，我第一版写在里面，
    // 第二段直接 `ReferenceError: openDialog is not defined`。
    const openDialog = async (who) => {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, who, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4500)
      await pg.locator('.yq-doc-more').first().click({ timeout: 8000 })
      await pg.waitForTimeout(800)
      const item = pg.locator('text=移动 / 复制到…').first()
      const openedMenu = (await item.count()) > 0
      if (openedMenu) {
        await item.click({ timeout: 8000 })
        await pg.waitForSelector('.yq-docset', { timeout: 8000 })
        await pg.waitForTimeout(2500)
      }
      const rows = await pg.evaluate(() => [...document.querySelectorAll('.yq-docset label')].map((l) => {
        const inp = l.querySelector('input[type="radio"]')
        return {
          text: (l.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          disabled: inp ? inp.disabled === true : null,
        }
      }))
      return { pg, rows, openedMenu }
    }
    {
      const { pg, rows, openedMenu } = await openDialog(accounts.mover)
      console.log('   目标库列表：', JSON.stringify(rows))
      ok(openedMenu, '菜单里那一项是可点的（源库有编辑权，所以这个入口是开的）')
      const target = rows.find((r) => r.text.includes('空库'))
      ok(!!target, '目标列表里有那个空库（它和源库同空间）')
      ok(!!target && target.disabled === true, '**那一项是禁用的** —— 服务端会拒，不该给一个必失败的选项')
      ok(rows.some((r) => /没有新建文档的权限/.test(r.text)), '并且写明了原因')
      await pg.close()
    }
    {
      // 反向：两个库都能建的编辑者，那一项**必须可选** ——
      // 判据写成「一律禁用」的话这条会红，而它挡掉的是正常功能。
      const { pg, rows } = await openDialog(accounts.editor)
      console.log('   （编辑者）目标库列表：', JSON.stringify(rows))
      const target = rows.find((r) => r.text.includes('空库'))
      ok(!!target && target.disabled === false, '编辑者那一项**可选**（不能把门全关上）')
      await pg.close()
    }

    /* ---------- ⑨ 目录管理标签：六处写入口原本一个都没禁 ---------- */
    console.log('\n== ⑨ 知识库设置「目录管理」的写入口 ==')
    {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(3500)
      await pg.locator('.yq-bset-nav-item', { hasText: '目录管理' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(2000)
      const st = await pg.evaluate(() => {
        const head = [...document.querySelectorAll('.yq-bset-head-actions button')]
        const row = document.querySelector('.yq-bset-row')
        const rows = [...document.querySelectorAll('.yq-bset-row')]
        const acts = (n) => (n ? [...n.querySelectorAll('.yq-bset-row-act')].map((b) => ({
          t: (b.textContent || '').trim(), disabled: b.disabled === true,
        })) : [])
        return {
          headBtns: head.map((b) => ({ t: (b.textContent || '').trim(), disabled: b.disabled === true })),
          rowActs: acts(row),
          draggable: row ? row.getAttribute('draggable') : null,
          rows: rows.length,
        }
      })
      console.log('   头部按钮：', JSON.stringify(st.headBtns))
      console.log('   行内按钮：', JSON.stringify(st.rowActs), '；行 draggable=', st.draggable)
      ok(st.headBtns.length >= 2 && st.headBtns.every((b) => b.disabled),
        '头部「新建分组/新建文档」对读者是**禁用的**')
      ok(st.rowActs.some((a) => a.t === '＋' && a.disabled), '行内「＋新建子项」是禁用的')
      ok(st.rowActs.some((a) => a.t === '🗑' && a.disabled), '行内「🗑删除」是禁用的')
      ok(st.draggable === 'false', '行**不可拖拽**（拖拽也是写目录结构，读者能把整棵树拖着玩）')

      // 绕过界面直接调 store：必须被拒且**不产生任何本地改动**
      // ⚠️ `createNode` 的第一个参数是 **bookId**，不是 docId ——
      //    我第一版把文档 id 传进去了，守卫读不到 caps 就放行，
      //    于是「节点数 2→3」看起来像 store 有洞。
      //    实际是判据传错了参数（`bookCreateBlocked` 判的是 bookId）。
      const before = await pg.evaluate(() => {
        const s = window.__yqStore.getState()
        return { docs: Object.keys(s.docs).length, nodes: s.nodes.length, trash: s.trash.length }
      })
      const after = await pg.evaluate(([bid, did]) => {
        const s = window.__yqStore.getState()
        const id = s.createNode(bid, null, 'group')
        s.deleteDoc(did)
        s.renameNode(String(s.nodes[0]?.id || ''), '改名试试')
        s.togglePinDoc(did)
        const cur = window.__yqStore.getState()
        return {
          id, docs: Object.keys(cur.docs).length, nodes: cur.nodes.length, trash: cur.trash.length,
          toasts: cur.toasts.map((t) => t.message || ''),
        }
      }, [made.b, made.d])
      console.log(`   绕过界面：文档数 ${before.docs}→${after.docs}，节点数 ${before.nodes}→${after.nodes}，回收站 ${before.trash}→${after.trash}`)
      ok(after.id === '', 'createNode 被拒（返回空串）')
      ok(after.docs === before.docs && after.nodes === before.nodes && after.trash === before.trash,
        '本地一个都没变（没有乐观改动）')
      await pg.close()
    }
    {
      // 反向：编辑者在目录管理里必须照常能建/能删/能拖
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.editor, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(3500)
      await pg.locator('.yq-bset-nav-item', { hasText: '目录管理' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(2000)
      const st = await pg.evaluate(() => {
        const row = document.querySelector('.yq-bset-row')
        return {
          headDisabled: [...document.querySelectorAll('.yq-bset-head-actions button')].some((b) => b.disabled),
          rowDisabled: row ? [...row.querySelectorAll('.yq-bset-row-act')].some((b) => b.disabled) : null,
          draggable: row ? row.getAttribute('draggable') : null,
        }
      })
      console.log('   （编辑者）头部有禁用：', st.headDisabled, '；行内有禁用：', st.rowDisabled, '；draggable=', st.draggable)
      ok(!st.headDisabled, '编辑者的头部按钮**可点**')
      ok(st.rowDisabled === false, '编辑者的行内按钮**可点**')
      ok(st.draggable === 'true', '编辑者**可以拖拽**（别把正常功能一起关掉）')
      await pg.close()
    }

    /* ---------- ⑩ 目录树的「＋」入口：门禁口径 ---------- */
    console.log('\n== ⑩ 目录树的「＋」入口 ==')
    {
      /*
       * ⚠️ 这里原来断的是「底部工具栏的 ＋ 和 ⋯ 两个入口」。
       * 底部工具栏连同它的 ＋ 已经被搬走了（同一个入口不许有两处，
       * `test-catalog-row-e2e` 里有一条专门钉这个），
       * 但 `.yq-tree-add-more` 这条断言一直留在原地 ——
       * 于是它断的是一个**组件里根本不存在**的类名，红了很久没人看。
       *
       * 现在只断真实存在的那一个：hover 出来的 ＋（`.yq-tree-cat-add`），
       * 门禁口径与之前完全一致 —— 没有新建权的人看不见它，有权的人看得见。
       */
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, accounts.reader, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4500)
      const st = await pg.evaluate(() => ({ plus: !!document.querySelector('.yq-tree-cat-add') }))
      console.log('   读者看到「＋」：', JSON.stringify(st))
      ok(!st.plus, '**目录树的「＋」对读者不出现** —— 和别的入口同一口径（那一处本来就有门）')
      await pg.close()
    }
    {
      // ⚠️ 不能复用 `asUser` —— 它导航到**设置页**，那儿没有目录树，
      // `.yq-tree-cat-add` 当然找不到，正向那条就会红（我第一版就这么错的）。
      const ep = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(ep, accounts.editor, 'test1234')
      await ep.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await ep.waitForSelector('.yq-app', { timeout: 25000 })
      await ep.waitForTimeout(4500)
      const st = await ep.evaluate(() => ({ plus: !!document.querySelector('.yq-tree-cat-add') }))
      console.log('   （编辑者）「＋」：', JSON.stringify(st))
      ok(st.plus, '编辑者**看得到**这个入口（别把正常功能关掉）')
      await ep.close()
    }
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
