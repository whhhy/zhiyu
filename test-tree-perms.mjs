/*
 * 目录树对阅读者的写操作（2026-10-12 补）
 *
 * ============================================================
 * 它防的是「界面提供了服务端不允许的动作」
 * ============================================================
 * 实测（探针，真服务端，reader 角色）：
 *
 *   他看到的菜单：编辑文档 / 复制链接 / 在新标签页打开 / **重命名** / 收藏 /
 *                 **置顶** / 复制标题 / **移动…** / **复制…** / **删除**
 *   hover 行上还挂着 **＋ 新建子项**，而且**整行可以拖**
 *
 *   他点「删除」→ confirm 过了 → toast「已移入回收站」→
 *   **本地那一篇真的从树上消失了**，而服务端三条都被拒：
 *     trash ×2 / nodes —— 「没有 edit 权限」
 *   顶栏从此常驻「N 处修改没有保存」，**而他自己修不好**。
 *
 * 一句「已删除」换来一个删不掉、也恢复不了的状态 —— 这一族里最坏的一种，
 * 因为它先让你信了。
 *
 * 根因很具体：`useBookPerms` 的注释里**早就写着**
 * 「设置页、目录树的『新建』按钮要靠它」，而 `Tree.tsx` 从来没调用过它。
 *
 * ============================================================
 * 两个方向都要钉
 * ============================================================
 * 正向：阅读者看不到写操作（菜单 / ＋ / 拖拽）
 * 反向：**有编辑权的人必须照常看得到、用得了**
 *       —— 判据在「权限还没问回来」时一律判「不能」，
 *       这条一旦写反，管理员的目录树会集体失去写能力，
 *       那是从「假动作」换成「功能没了」，一样是假的，只是方向相反。
 *
 * ★ 而 store 层那一道（`bookEditBlocked`）要单独钉：
 *   界面关掉入口只是「他不点得到」；真正的判据是
 *   **即使有人绕过界面直接调 action，本地状态也不会被乐观地改掉** ——
 *   否则那个「自己修不好的状态」照样会出现。
 *
 * 自起服务 + 全新库：它要建库、加成员、试删。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.TREE_PERMS_PORT || await freePort()
const DB = 'data/_treepm.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
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
const login = async (page, acct, password) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', acct)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1800)
}
/** 打开某一行的 `···`，返回菜单里所有项的文字 */
const openMenu = async (page) => {
  const row = page.locator('.yq-tree-item').first()
  await row.hover()
  await row.locator('.yq-tree-act:not(.yq-tree-act-add)').first().click()
  await page.waitForSelector('.yq-menu-item', { timeout: 8000 })
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.yq-menu-item .yq-menu-text')].map((e) => (e.textContent || '').trim()))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  return items
}

try {
  const br = await chromium.launch()
  try {
    const suffix = Date.now().toString(36)
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const aTok = await admin.evaluate(() => localStorage.getItem('yq_token'))
    const AH = { Authorization: 'Bearer ' + aTok, 'Content-Type': 'application/json' }

    const made = await admin.evaluate((sfx) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '树权限测试 ' + sfx)
      const d1 = window.__yqStore.getState().createDoc(b, null, '甲' + sfx)
      const d2 = window.__yqStore.getState().createDoc(b, null, '乙' + sfx)
      return { b, d1, d2 }
    }, suffix)

    /*
     * ⚠️ 必须等服务端**真的有这个库**再推成员行。
     * `createBook` 只写本地、同步是异步的，那一刻服务端还没有这个库，
     * `book_members.bookId` 的外键自然对不上，报出来的是
     * `FOREIGN KEY constraint failed` —— 看着像「加成员这条路坏了」。
     */
    for (let i = 0; i < 30; i++) {
      const b = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((b.data.books || []).some((x) => x.id === made.b)) break
      await admin.waitForTimeout(500)
    }
    const acct = `ro_tree_${suffix}`
    const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
      data: { account: acct, password: 'test1234', name: '只读同事' },
    })).json()
    const addRes = await admin.request.post(`${BASE}/api/sync/push`, {
      headers: AH,
      data: {
        upsert: {
          bookMembers: [{
            bookId: made.b, userId: reg.user.id, role: 'reader',
            perms: { read: true, comment: true, edit: false, create: false, export: false, share: false },
            joinedAt: Date.now(),
          }],
        },
      },
    })
    const addBody = await addRes.json()
    ok((addBody.applied || []).length === 1 && !(addBody.rejected || []).length,
      '前置：只读同事确实进了这个库', JSON.stringify(addBody).slice(0, 140))
    await admin.waitForTimeout(2500)

    /* ================= 阅读者 ================= */
    console.log('\n== 阅读者：写操作一个都不该出现 ==')
    const reader = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    const rejected = []
    reader.on('response', async (r) => {
      if (!r.url().includes('/api/sync/push')) return
      try { const b = await r.json(); if ((b.rejected || []).length) rejected.push(...b.rejected) } catch { }
    })
    await login(reader, acct, 'test1234')
    await reader.goto(`${BASE}/#/book/${made.b}/doc/${made.d1}`, { waitUntil: 'domcontentloaded' })
    await reader.waitForSelector('.yq-tree-item', { timeout: 25000 })
    await reader.waitForTimeout(3000)

    ok((await reader.locator('.yq-tree-item').count()) >= 2, `他能看到这棵树（${await reader.locator('.yq-tree-item').count()} 行）`)

    const menu = await openMenu(reader)
    console.log(`       他点得着的：${menu.join(' / ')}`)
    const WRITE_ITEMS = ['重命名', '置顶', '取消置顶', '移动…', '复制…', '删除', '移出目录', '在此新建文档', '在此新建分组']
    const leaked = menu.filter((m) => WRITE_ITEMS.includes(m))
    ok(leaked.length === 0, '★ 菜单里一个写操作都没有', leaked.length ? '还在：' + leaked.join(', ') : '')
    /* 反向：不能把能做的事也一起关掉 */
    ok(menu.includes('复制链接') && menu.includes('收藏'),
      '而复制链接 / 收藏**仍然在**（收藏是个人数据，阅读者也该能收藏）', JSON.stringify(menu))
    /*
     * 「＋」是**hover 才显形**的，所以必须先把鼠标放到那一行上再查 ——
     * 上一版在 `openMenu()` 里按过 Escape 才来查，hover 早掉了，
     * 于是「没找到」被当成了「按钮没了」，红得莫名其妙。
     */
    await reader.locator('.yq-tree-item').first().hover()
    await reader.waitForTimeout(400)
    ok(!(await reader.evaluate(() => !!document.querySelector('.yq-tree-act-add'))),
      '★ hover 行的「＋ 新建子项」不见了')
    const draggable = await reader.evaluate(() => {
      const r = document.querySelector('.yq-tree-item')
      return r ? r.getAttribute('draggable') : null
    })
    ok(draggable !== 'true', '★ 行也不能拖了（拖拽同样是写操作）', `draggable=${draggable}`)

    /* ---------- store 层那一道 ---------- */
    console.log('\n== 绕过界面直接调 store：本地状态也不能被乐观地改掉 ==')
    {
      const before = await reader.evaluate((b) =>
        window.__yqStore.getState().nodes.filter((n) => n.bookId === b).length, made.b)
      await reader.evaluate((b) => {
        const s = window.__yqStore.getState()
        const n = s.nodes.find((x) => x.bookId === b)
        s.deleteNode(n.id)
      }, made.b)
      await reader.waitForTimeout(1500)
      const after = await reader.evaluate((b) =>
        window.__yqStore.getState().nodes.filter((n) => n.bookId === b).length, made.b)
      ok(after === before, '★ deleteNode 被拒，本地一个节点都没少（原来会少一个）', `${before} → ${after}`)
      await reader.waitForTimeout(3500)
      ok(rejected.length === 0,
        '而且没有产生任何被拒的写入（原来顶栏会常驻「N 处修改没有保存」）',
        JSON.stringify(rejected).slice(0, 160))
      const bar = await reader.evaluate(() => (document.querySelector('.yq-syncstatus-text')?.textContent || '').trim())
      ok(!bar || !/没有保存/.test(bar), '顶栏没有「N 处修改没有保存」', bar || '(无)')
    }

    /* ================= 反向：管理员必须照常用 ================= */
    console.log('\n== 反向：管理员必须照常看到并用得了 ==')
    {
      await admin.goto(`${BASE}/#/book/${made.b}/doc/${made.d1}`, { waitUntil: 'domcontentloaded' })
      await admin.waitForSelector('.yq-tree-item', { timeout: 25000 })
      await admin.waitForTimeout(3000)
      const am = await openMenu(admin)
      console.log(`       管理员点得着的：${am.join(' / ')}`)
      ok(['重命名', '删除'].every((x) => am.includes(x)) && am.includes('置顶'),
        '管理员的菜单里写操作齐全（判据在「未确认」时判 false，写反了就全没了）',
        JSON.stringify(am))
      await admin.locator('.yq-tree-item').first().hover()
      await admin.waitForTimeout(400)
      ok(await admin.evaluate(() => !!document.querySelector('.yq-tree-act-add')),
        '管理员 hover 行上有「＋ 新建子项」')
      const ad = await admin.evaluate(() => document.querySelector('.yq-tree-item')?.getAttribute('draggable'))
      ok(ad === 'true', '管理员的行可以拖', `draggable=${ad}`)

      // 真的改名一次，确认这条路没被我关死
      const before2 = await admin.evaluate((b) =>
        window.__yqStore.getState().nodes.filter((n) => n.bookId === b).length, made.b)
      await admin.evaluate((b) => {
        const s = window.__yqStore.getState()
        const n = s.nodes.find((x) => x.bookId === b)
        s.renameNode(n.id, '改过名' + Date.now().toString(36))
      }, made.b)
      await admin.waitForTimeout(4000)
      const srvTitles = await (async () => {
        const b = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
        return (b.data.nodes || []).filter((n) => n.bookId === made.b).map((n) => n.title)
      })()
      ok(srvTitles.some((t) => t.startsWith('改过名')),
        '★ 而且管理员改名真的落库了（不是只过界面这一关）', JSON.stringify(srvTitles).slice(0, 120))
      ok(before2 === srvTitles.length, '节点数没变', `${before2} vs ${srvTitles.length}`)
    }

    /* ================= 知识库主页（BookIndex） ================= */
    console.log('\n== 知识库主页：写操作同样不该对阅读者敞开 ==')
    {
      /*
       * 这一页比侧边那棵树**更常用**（所有人一进来就在），
       * 而它以前连 `useBookPerms` 都没调：实测阅读者点「＋新建文档」→
       * 本地真的多出一篇（节点 1 → 2）→ 服务端拒 12 条 →
       * 顶栏常驻「12 处修改没有保存」。
       */
      await reader.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await reader.waitForSelector('.yq-app', { timeout: 25000 })
      await reader.waitForTimeout(3000)
      const btns = await reader.evaluate(() =>
        [...document.querySelectorAll('button')].map((e) => (e.textContent || '').trim()))
      ok(!btns.some((t) => t.includes('新建文档')),
        '★ 主页上没有「新建文档」按钮', JSON.stringify(btns.filter((t) => t.includes('新建'))))

      // 就算绕过界面，store 也要挡（createNode 走的是 bookEditBlocked 那条）
      const n0 = await reader.evaluate((b) => window.__yqStore.getState().nodes.filter((x) => x.bookId === b).length, made.b)
      await reader.evaluate((b) => {
        const s = window.__yqStore.getState()
        s.createNode(b, null, 'group')
      }, made.b)
      await reader.waitForTimeout(1500)
      const n1 = await reader.evaluate((b) => window.__yqStore.getState().nodes.filter((x) => x.bookId === b).length, made.b)
      ok(n1 === n0, '★ 绕过界面调 createNode 也建不出分组（本地没多出节点）', `${n0} → ${n1}`)

      // 管理员这一侧必须照常
      await admin.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await admin.waitForSelector('.yq-app', { timeout: 25000 })
      await admin.waitForTimeout(3000)
      const abtns = await admin.evaluate(() =>
        [...document.querySelectorAll('button')].map((e) => (e.textContent || '').trim()))
      ok(abtns.some((t) => t.includes('新建文档')),
        '而管理员在主页上照样有「新建文档」（判据写反就变成「功能没了」）',
        JSON.stringify(abtns.filter((t) => t.includes('新建'))))
    }

    /* ================= 权限变了，缓存要失效 ================= */
    console.log('\n== 权限刚被改动：不用刷新，界面就跟着变 ==')
    {
      /*
       * 权限缓存以前**整个会话不过期** —— `clearPermsCache()` 导出了却
       * 一次都没被调用。于是「管理员刚把某人升成编辑者」在他那边要刷新才看得见，
       * 而「刚被降权」的人会继续看着已经失效的按钮。
       *
       * 现在 `sync.poll()` 在成员名单变化时会清缓存并通知已挂载的 hook。
       * 这里验的就是**不用刷新**这件事：升权之后按钮自己冒出来。
       */
      const beforeRole = await admin.evaluate(([bid, uid]) =>
        window.__yqStore.getState().getBookMembers(bid).find((m) => m.id === uid)?.role, [made.b, reg.user.id])
      ok(beforeRole === 'reader', `前置：他现在是 ${beforeRole}`)

      // 管理员把他提成 editor（走真实接口，reader 那边靠轮询收到）
      const up = await admin.request.post(`${BASE}/api/sync/push`, {
        headers: AH,
        data: {
          upsert: {
            bookMembers: [{
              bookId: made.b, userId: reg.user.id, role: 'editor',
              perms: { read: true, comment: true, edit: true, create: true, export: true, share: true },
              joinedAt: Date.now(),
            }],
          },
        },
      })
      ok((await up.json()).rejected?.length === 0, '管理员把他升成 editor 成功')

      // reader 那边等轮询（8 秒一次）把变更拉回来
      await reader.waitForTimeout(14000)
      const afterBtns = await reader.evaluate(() =>
        [...document.querySelectorAll('button')].map((e) => (e.textContent || '').trim()))
      ok(afterBtns.some((t) => t.includes('新建文档')),
        '★ 升权之后「新建文档」自己出现了（不用刷新 —— 缓存失效了）',
        JSON.stringify(afterBtns.filter((t) => t.includes('新建'))))
    }
    console.log('\n== 权限还没问回来时：先不给入口（fail closed）==')
    {
      /*
       * 这一条在第一版里**根本没被覆盖到**，破坏对照直接报「没咬」。
       *
       * 原因：管理员的权限请求几十毫秒就回来了，测试从头到尾都观察不到
       * `caps === null` 那个窗口 —— 于是「未确认时判 true」这个写反了的版本
       * 跑出来照样全绿。**判据不覆盖那条路，就等于那条路没有守卫。**
       *
       * 所以这里主动把权限接口拦住、拖 6 秒，把那个窗口**撑开**再看。
       */
      const slow = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
      let held = true
      await slow.route('**/api/perms/book/**', async (route) => {
        // 只拖**第一次**；后面放行，否则页面永远停在未确认状态
        if (held) { held = false; await new Promise((r) => setTimeout(r, 6000)) }
        await route.continue()
      })
      await login(slow, 'admin', 'yuque@2026')
      await slow.goto(`${BASE}/#/book/${made.b}/doc/${made.d1}`, { waitUntil: 'domcontentloaded' })
      await slow.waitForSelector('.yq-tree-item', { timeout: 25000 })
      // 权限请求还在飞着 —— 这就是「未确认」那个窗口
      await slow.waitForTimeout(1200)
      const during = await openMenu(slow)
      console.log(`       权限未确认时的菜单：${during.join(' / ') || '(空)'}`)
      ok(!during.some((m) => WRITE_ITEMS.includes(m)),
        '★ 权限还没问回来时，写操作一个都不出现',
        during.filter((m) => WRITE_ITEMS.includes(m)).join(', '))
      // 等它回来之后必须恢复 —— 只钉前半截会把管理员永久挡在门外
      await slow.waitForTimeout(7000)
      await slow.reload({ waitUntil: 'domcontentloaded' })
      await slow.waitForSelector('.yq-tree-item', { timeout: 25000 })
      await slow.waitForTimeout(3000)
      const after2 = await openMenu(slow)
      ok(['重命名', '删除'].every((x) => after2.includes(x)),
        '而权限一旦问回来，管理员的入口立刻回来（否则就是「功能没了」）',
        JSON.stringify(after2))
      await slow.close()
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