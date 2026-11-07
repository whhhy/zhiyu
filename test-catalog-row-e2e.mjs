/*
 * 验「目录」行上那个 ＋ 是**真能用**的，不只是渲染出来。
 *
 * ⚠️ 只验 DOM 形态是不够的 —— 一个渲染得对、点了没反应的按钮
 *    是这个项目最恨的东西（侧栏搜索框那次的教训：框是指路的，
 *    指的那个键必须真的管用）。
 *
 * 走真实路径：登录 → 进知识库 → 点「目录」行的 ＋ → 断言真的多了一篇文稿。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.CATALOG_ROW_E2E_PORT || await freePort()
const DB = 'data/_catbtn.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
/*
 * ⚠️ 为什么**不用** runner 传进来的 BASE：
 *   它要点「＋」新建一篇文稿 —— 而 runner 的库是**整轮 120 多个套件共用的**，
 *   在那里建一篇就等于往共享库里塞一条没人认领的数据（测试污染自己环境，
 *   本项目已经栽过好几次）。所以自起服务 + 全新库。
 *   代价是要自己占端口，因此**必须先查端口空不空** ——
 *   撞上别的进程时，自起服务会启动失败，而健康检查会打到那个进程上，
 *   于是「测的是别人」这件事完全看不出来。
 */
if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
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

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
    await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', 'yuque@2026')
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })
    await p.waitForTimeout(1200)

    const book = await p.evaluate(() => (window.__yqStore.getState().books || [])[0] || null)
    ok(!!book, '有知识库可进')
    await p.goto(`${BASE}/#/book/${book.id}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-tree-cat', { timeout: 25000 })
    await p.waitForTimeout(800)

    const before = await p.evaluate((b) =>
      Object.values(window.__yqStore.getState().nodes || {}).filter((n) => n.bookId === b).length, book.id)
    console.log(`       树里原有 ${before} 个节点`)

    await p.click('.yq-tree-cat-add')
    /*
     * ⚠️ ＋ 现在开的是一个**菜单**，不是直接建一篇文稿（2026-10-16 照实测语雀改的：
     *   文档 / 表格 / 画板 / 数据表 ── 从模板新建… / 导入… ── 新建分组）。
     *
     * 这条套件原来断言「点 ＋ 就多一篇文稿」—— 那是**旧形态**。
     * 它在那次改动之后一直没跟着更新，而恰好那轮全量回归被中止了，
     * 于是这条红项**从没被人看见**（不是新坏的，是旧伤没人验）。
     *
     * 要验的东西没变：「＋ 是真能用的，不是装饰按钮」——
     * 所以要点菜单里那一项，而不是断言点 ＋ 本身会建文稿。
     */
    await p.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
    const menuItems = await p.evaluate(() =>
      [...document.querySelectorAll('.yq-menu-item')].map((e) => (e.textContent || '').trim()))
    console.log(`       ＋ 菜单：${JSON.stringify(menuItems)}`)
    ok(menuItems.length > 0, `＋ 打开的是新建菜单（${menuItems.length} 项），不是直接建一篇`)
    ok(menuItems.some((t) => t.includes('文档')) && menuItems.some((t) => t.includes('导入')),
      '菜单里有「文档」也有「导入…」（照语雀的项序）')

    await p.locator('.yq-menu-item', { hasText: '文档' }).first().click()
    await p.waitForTimeout(2000)

    const after = await p.evaluate((b) =>
      Object.values(window.__yqStore.getState().nodes || {}).filter((n) => n.bookId === b).length, book.id)
    ok(after === before + 1,
      '在 ＋ 菜单里点「文档」真的建出了一篇新文稿（不是装饰按钮）',
      `before=${before} after=${after}`)

    const opened = await p.evaluate(() => location.hash)
    ok(/\/doc\//.test(opened), `建完直接跳到那篇新文稿（${opened.slice(0, 60)}）`)

    // 旧的底部入口不该再存在 —— 否则就是两个功能相同的按钮
    const old = await p.evaluate(() => !!document.querySelector('.yq-tree-foot'))
    ok(!old, '底部那个「新建文档」已经搬走了（不留下两个功能一样的入口）')

    /*
     * 书籍页右侧那块「目录」：提示文案必须和它**真有**的能力对得上。
     *
     * 这里原来写着「支持拖拽调整顺序，拖到条目中间可成为子项」，
     * 而那一列是**纯只读**的 —— 零个拖拽处理器。
     * 拖拽其实有，但在**侧边目录树**（`.yq-tree-row`，Tree.tsx）上，
     * 提示挂在另一块界面上 = 在只读列表旁边承诺一个它做不到的动作。
     *
     * 钉的是**不变式**而不是当前长相：
     *   「要么这块真的有拖拽，要么别这么写」
     * —— 所以哪天这里真接上拖拽了，把提示加回来，这条照样绿。
     * 写成「这里永远不许有 draggable」就变成给未来设障了。
     */
    console.log('\n== 书籍页目录：提示不许承诺它做不到的动作 ==')
    {
      /* ⚠️ 必须先回到书籍页：上面点「＋」之后已经跳到文档页了，
       * 那边根本没有目录区 —— 第一版忘了这步，
       * 于是 `.yq-toc-row` 匹配到 0 个、`draggable` 自然为 null，
       * ★ 那条断言**恒真**（空集合上的否定式判断），差一点又白写。 */
      await p.goto(`${BASE}/#/book/${book.id}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-bookpage-toc', { timeout: 25000 })
      await p.waitForTimeout(800)
      const toc = await p.evaluate(() => {
        const hint = document.querySelector('.yq-toc-hint')
        const row = document.querySelector('.yq-toc-row')
        return {
          hint: hint ? (hint.textContent || '').trim() : null,
          draggable: row ? row.getAttribute('draggable') : null,
          rowCount: document.querySelectorAll('.yq-toc-row').length,
        }
      })
      console.log(`       目录行 ${toc.rowCount} 个 · draggable=${toc.draggable} · 提示=「${toc.hint || '(无)'}」`)
      /* 基准：没有行的话下面那条也是恒真的 */
      ok(toc.rowCount > 0, `基准：目录真的渲染出了 ${toc.rowCount} 行（否则下一条恒真）`)
      /*
       * ⚠️ 只认 `draggable` 属性，**不能**用 `'ondrop' in row` 之类的方法：
       * React 的 `onDrop`/`onDragStart` 是挂在根容器上的委托，**不会**作为
       * 元素属性出现 —— 那样写即便拖拽好着也永远是 false。
       */
      ok(!(toc.hint || '').includes('拖拽') || toc.draggable !== null,
        '★ 写着「支持拖拽」的地方必须真的有拖拽，否则就是假承诺',
        `提示=「${toc.hint}」 draggable=${toc.draggable}`)
      /* 侧边目录树那一列拖拽是真的 —— 反过来钉住它，别把真能力也一起删了 */
      const tree = await p.evaluate(() => {
        const r = document.querySelector('.yq-tree-item')
        return r ? { draggable: r.getAttribute('draggable') } : null
      })
      ok(tree && tree.draggable !== null,
        '而侧边目录树是真的能拖（别把真能力也一起删了）', JSON.stringify(tree))
    }
  } finally { await br.close() }
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