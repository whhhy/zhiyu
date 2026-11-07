/* ============================================================
   删除知识库
   ------------------------------------------------------------
   这个能力**以前整个产品都没有**：store 里只有 createBook / updateBook，
   服务端没有端点，UI 没有入口。`test-mdimport-e2e` 里就写着这个缺口 ——
   而且它每跑一次就留下一个清不掉的「导入夹具」库。

   语义 = **硬删**（跟语雀一致：它的回收站只管文档、不管知识库）。
   所以这个套件要钉的**不只是「能删掉」**，还有三件更容易出事的事：

     1. **不能只删 books 那一行。** `docs.bookId` 是冗余列、**没有外键**
        （`db.ts` 里就是裸 `TEXT`），而 nodes / book_members / book_settings
        都带 ON DELETE CASCADE。所以光删库，文档会**全部留下** ——
        一堆既不在任何库里、又谁都删不掉的孤儿。
     2. **不能漏掉搜索索引和历史版本。** 只删 docs 行的话，
        搜那篇文档的标题还能搜到（旧库的书级索引也会一直显示它）。
     3. **误删要有闸门**：没打库名 / 打错库名时删除按钮必须是禁用的。
        这一条以前没人写，但它才是「不可逆操作」这四个字的实际含义。
   ============================================================ */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.DELBOOK_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_delbook-${Date.now().toString(36)}.db`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f) } catch {} } }

const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB }, stdio: ['ignore', 'pipe', 'pipe'],
})
let srvErr = ''
srv.stderr.on('data', (d) => { const s = String(d); if (/Error/.test(s) && !/ExperimentalWarning/.test(s)) srvErr += s })

/** 等服务端真的退出：kill 只是发信号，进程还在的话文件是删不掉的（Windows 上尤其） */
const waitExit = () => new Promise((res) => {
  if (srv.exitCode !== null || srv.signalCode !== null) return res()
  const t = setTimeout(() => { try { srv.kill('SIGKILL') } catch {} }, 3000)
  srv.once('exit', () => { clearTimeout(t); res() })
})

/**
 * 收摊。
 *
 * ⚠️ 原来这里是 `try { rmSync } catch {}` —— **吞掉失败**，于是每一轮
 * 都在 `data/` 里留下 `_delbook-*.db` + `-wal` + `-shm`。
 * 套件「跑完了、绿了」，而垃圾留了一地，正是这个项目最恨的那种静默失败。
 *
 * 现在：先等进程真的退出再删，删不掉就**说出来**。
 */
const cleanup = async () => {
  try { srv.kill() } catch {}
  await waitExit()
  const left = []
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    let okDel = false
    for (let i = 0; i < 5 && !okDel; i++) {
      try { rmSync(f); okDel = !existsSync(f) } catch { await sleep(300) }
    }
    if (!okDel) left.push(f)
  }
  if (left.length) console.log(`  ⚠️  临时库删不掉（文件还被占着）：${left.join('、')}`)
}

const q = (sql, ...a) => {
  const d = new DatabaseSync(DB, { readOnly: true })
  const row = d.prepare(sql).get(...a)
  d.close()
  return Number(row.n)
}

let browser
try {
  let up = false
  for (let i = 0; i < 90; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) { up = true; break }
    await sleep(500)
  }
  if (!up) throw new Error('服务端没起来：' + srvErr.slice(-400))

  browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => console.log('  !! 页面异常：', e.message))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 30000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await page.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1800)

  console.log('\n== 造一个「一个库 + 3 篇文档」的场景 ==')
  const made = await page.evaluate(() => {
    const s = window.__yqStore.getState()
    const bookId = s.createBook(s.spaces[0].id, '待删库探针')
    const docIds = [1, 2, 3].map((i) => s.createDoc(bookId, null, `探针文档${i}`))
    return { bookId, docIds }
  })
  await page.waitForTimeout(4000)
  ok(q('SELECT COUNT(*) AS n FROM books WHERE id = ?', made.bookId) === 1, '服务端 books 有这一行')
  ok(q('SELECT COUNT(*) AS n FROM docs WHERE bookId = ?', made.bookId) === 3, '服务端 docs 有 3 行',
    String(q('SELECT COUNT(*) AS n FROM docs WHERE bookId = ?', made.bookId)))
  ok(q('SELECT COUNT(*) AS n FROM nodes WHERE bookId = ?', made.bookId) >= 3, '目录节点也建出来了')

  /*
   * ⚠️ 下面这条是**前提**，不能省。
   *
   * `createDoc` **不**存历史版本 —— 版本是「打开文档」或「保存」时才记的。
   * 所以刚建出来的三篇 `doc_versions` 一条都没有，
   * 于是「删库后历史版本也没了」这条断言在 `0 → 0` 上**恒绿**：
   * 它根本没测到任何东西（头一版就是这个样子，跑出来还是绿的）。
   *
   * 所以先真的打开一篇，逼出快照，再断言它> 0，最后才谈「删干净了」。
   */
  await page.goto(`${BASE}/#/book/${made.bookId}/doc/${made.docIds[0]}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-block', { timeout: 25000 })
  await page.waitForTimeout(2500)
  const verCount = q('SELECT COUNT(*) AS n FROM doc_versions WHERE docId IN (?,?,?)', ...made.docIds)
  ok(verCount >= 1, '（前提）打开过文档，所以**真的存了历史版本**', `实际 ${verCount} 条`)

  /*
   * 搜索索引这条的**前提**，不加它就是假绿。
   *
   * 头一版只有「删完搜不到」那一条，而破坏对照（故意不逐篇清文档）时它**照样绿** ——
   * 说明 `text LIKE '%探针文档%'` 本来就匹配不到任何行，跟删没删毫无关系。
   * 判据问的是「有没有」，而缺陷是「删干净了没有」。
   */
  const idxBefore = q("SELECT COUNT(*) AS n FROM search_index WHERE title LIKE '%探针文档%' OR text LIKE '%探针文档%'")
  console.log(`  （诊断）删之前 search_index 命中 ${idxBefore} 行`)
  ok(idxBefore > 0, '（前提）删之前，这三篇在搜索索引里**真的进得去**', `实际 ${idxBefore} 行`)

  console.log('\n== 权限：非管理员不能删 ==')
  {
    /*
     * 走 `/api/auth/register` 真注册一个账号 —— `POST /api/spaces/:id/members`
     * 只接受**已存在的** userId，它不建账号（头一版拿它去建人，拿到 400，
     * 而我写成「跳过」，等于把一条没验的权限放过去了）。
     */
    const token = await page.evaluate(() => localStorage.getItem('yq_token'))
    const acct = 'delprobe_' + Date.now().toString(36)
    const reg = await page.request.post(`${BASE}/api/auth/register`, {
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      data: { account: acct, password: 'DelProbe@2026', name: '删库探针普通成员' },
    })
    ok(reg.ok(), '注册了一个普通账号', `状态 ${reg.status()} ${JSON.stringify(await reg.json().catch(() => ({}))).slice(0, 200)}`)
    if (reg.ok()) {
      const lr = await page.request.post(`${BASE}/api/auth/login`, {
        headers: { 'content-type': 'application/json' },
        data: { account: acct, password: 'DelProbe@2026' },
      })
      const lj = await lr.json().catch(() => ({}))
      const t2 = lj.token
      ok(!!t2, '那个账号能登录', `状态 ${lr.status()} ${JSON.stringify(lj).slice(0, 200)}`)
      const r = await page.request.delete(`${BASE}/api/book/${made.bookId}`, {
        headers: { Authorization: `Bearer ${t2}` },
      })
      ok(r.status() === 403, '**普通成员删知识库被拒（403）**', `实际状态 ${r.status()}`)
      ok(q('SELECT COUNT(*) AS n FROM books WHERE id = ?', made.bookId) === 1, '库还在（被拒之后没动）')
      ok(q('SELECT COUNT(*) AS n FROM docs WHERE bookId = ?', made.bookId) === 3, '文档也还在（没删一半）')
    }
  }

  console.log('\n== 界面闸门：必须手打库名才能删 ==')
  {
    await page.goto(`${BASE}/#/book/${made.bookId}/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    /*
     * ⚠️ 这里点的是「**更多设置**」，不是「安全」。
     *   2026-10-10 实测语雀（data/_fidelity-booksettings.md）：
     *   删除知识库放在「更多设置」，与「导出知识库」「转移知识库」并排，
     *   **不在安全设置页**。本地早先放在 SecurityTab，位置对不上，已搬。
     *   原来这条断言点「安全」然后找危险区 —— 现在那样找会直接崩
     *   （`page.$eval` 找不到元素），后面的用例全不跑。
     *
     *   下面顺手加一条**反向断言**，钉住「安全设置页里不再有危险区」，
     *   免得以后有人又把它搬回去而没人发现。
     */
    for (const b of await page.$$('.yq-bset-nav button')) {
      if ((await b.innerText()).includes('更多设置')) await b.click()
    }
    await page.waitForTimeout(1500)
    ok((await page.$$('.yq-bset-danger')).length === 1, '设置 → 更多设置 里有危险操作区')

    // 反向：安全设置页不该再有危险区（语雀实测如此）
    for (const b of await page.$$('.yq-bset-nav button')) {
      if ((await b.innerText()).includes('安全')) await b.click()
    }
    await page.waitForTimeout(1200)
    ok((await page.$$('.yq-bset-danger')).length === 0,
      '**安全设置页里没有危险操作区**（删库在「更多设置」——2026-10-10 实测语雀的形态）')

    // 回到更多设置，接着验删除闸门
    for (const b of await page.$$('.yq-bset-nav button')) {
      if ((await b.innerText()).includes('更多设置')) await b.click()
    }
    await page.waitForTimeout(1500)
    ok((await page.$$('.yq-bset-danger')).length === 1, '设置 → 安全 里有危险操作区')
    const body = await page.$eval('.yq-bset-danger', (e) => e.innerText)
    ok(/不可恢复/.test(body), '文案写死了「不可恢复」（不是「已移入回收站」那种含糊说法）')
    ok(/3 篇文档/.test(body), '**明示会连带删掉几篇**', JSON.stringify(body.slice(0, 120)))

    await page.click('.yq-bset-danger button')
    await page.waitForTimeout(700)
    const dis = () => page.$eval('.yq-bset-danger .yq-btn-danger', (b) => b.disabled).catch(() => 'no-button')
    ok(await dis() === true, '没打库名时删除按钮是禁用的', String(await dis()))
    await page.fill('.yq-bset-danger input', '打错的名字')
    await page.waitForTimeout(500)
    ok(await dis() === true, '打错库名时仍然禁用', String(await dis()))
    await page.fill('.yq-bset-danger input', '待删库探针')
    await page.waitForTimeout(500)
    ok(await dis() === false, '打对库名后才解禁', String(await dis()))
  }

  console.log('\n== 真删，然后逐表回查 ==')
  {
    await page.click('.yq-bset-danger .yq-btn-danger')
    await page.waitForTimeout(4000)

    ok(q('SELECT COUNT(*) AS n FROM books WHERE id = ?', made.bookId) === 0, 'books 行没了')
    ok(q('SELECT COUNT(*) AS n FROM docs WHERE bookId = ?', made.bookId) === 0,
      '**docs 全没了**（bookId 没有外键，不显式清就会留下一堆孤儿）',
      String(q('SELECT COUNT(*) AS n FROM docs WHERE bookId = ?', made.bookId)))
    ok(q('SELECT COUNT(*) AS n FROM nodes WHERE bookId = ?', made.bookId) === 0, 'nodes 全没了')
    ok(q('SELECT COUNT(*) AS n FROM book_members WHERE bookId = ?', made.bookId) === 0, 'book_members 没了（外键级联）')
    ok(q('SELECT COUNT(*) AS n FROM book_settings WHERE bookId = ?', made.bookId) === 0, 'book_settings 没了（外键级联）')
    ok(q('SELECT COUNT(*) AS n FROM doc_versions WHERE docId IN (?,?,?)', ...made.docIds) === 0,
      `**历史版本也没了**（删之前确实有 ${verCount} 条）`)
    ok(q('SELECT COUNT(*) AS n FROM trash WHERE docId IN (?,?,?)', ...made.docIds) === 0, '回收站里没有残留')
    ok(q("SELECT COUNT(*) AS n FROM search_index WHERE text LIKE '%探针文档%'") === 0,
      '**搜索索引里也搜不到了**（只删 docs 行的话标题还能搜出来）',
      String(q("SELECT COUNT(*) AS n FROM search_index WHERE text LIKE '%探针文档%'")))

    const local = await page.evaluate(() => ({
      books: Object.values(window.__yqStore.getState().books).filter((b) => b.name === '待删库探针').length,
      nodes: window.__yqStore.getState().nodes.filter((n) => String(n.title).startsWith('探针文档')).length,
    }))
    ok(local.books === 0 && local.nodes === 0, '**本地 store 也摘干净了**', JSON.stringify(local))

    const again = await page.request.delete(`${BASE}/api/book/${made.bookId}`)
    ok(!again.ok(), '再删同一个库会失败（不是静默成功）', `状态 ${again.status()}`)
  }

  console.log('\n== 端点存在本身就是这次要的产物 ==')
  {
    const { readFileSync } = await import('node:fs')
    /*
     * 判据要**切到 DangerZone 组件体内**，不能扫整个文件：
     * `BookSettings.tsx` 里还有一处 `toast('已移入回收站')` ——
     * 那是**删目录节点**用的，而那个操作确实进回收站，文案是对的。
     * 扫全文件会把那条一起判红，然后我就去「修」一个没坏的地方。
     *
     * 而且要**剥注释**：我自己的说明注释里就写着「已移入回收站」这五个字。
     */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const src = readFileSync('src/store/index.ts', 'utf8')
    ok(/deleteBook: \(bookId: string\) => Promise/.test(src), 'store 里有 deleteBook')
    ok(/function DangerZone/.test(readFileSync('src/pages/BookSettings.tsx', 'utf8')), '知识库设置里有危险操作区组件')
    const bsetRaw = readFileSync('src/pages/BookSettings.tsx', 'utf8')
    const dzAt = bsetRaw.indexOf('function DangerZone')
    ok(dzAt > 0, '（能切出 DangerZone 的位置）')
    if (dzAt > 0) {
      const dz = strip(bsetRaw.slice(dzAt, bsetRaw.indexOf('\n}\n', dzAt)))
      ok(!/已移入回收站/.test(dz),
        '**危险操作区没有把硬删说成「已移入回收站」**（那是本项目最糟的一种假承诺）')
      ok(/不可恢复/.test(dz), '危险操作区里写死了「不可恢复」')
    }

    /*
     * 服务端那条：必须**逐篇走 purgeDoc**。
     * 判据钉的是「调用结构」而不是「函数名出现过」——
     * 后者换成另一个函数名照样绿。
     */
    const sync = readFileSync('server/sync.ts', 'utf8')
    const at = sync.indexOf('export function deleteBook')
    ok(at > 0, '服务端有 deleteBook')
    if (at > 0) {
      const fn = sync.slice(at, sync.indexOf('\n}', at))
      ok(/purgeDoc\(user, docId\)/.test(fn), '删库的每一篇文档都走 purgeDoc（级联只写一份）')
      ok(/SELECT id FROM docs WHERE bookId = \?/.test(fn), '按 docs.bookId 找文档（bookId 没有外键，必须显式清）')
      ok(/SELECT docId FROM nodes WHERE bookId = \?/.test(fn),
        '**也按目录节点找**（bookId 是冗余列，历史数据可能只有节点指路，漏了就留孤儿）')
      ok(/failed\.length\) \{\s*\n\s*return \{ ok: false/.test(fn),
        '有文档删不掉时**整次中止**（库还在、文档少一半是最难收拾的中间状态）')
    }
  }
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser?.close().catch(() => {})
  await cleanup()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)