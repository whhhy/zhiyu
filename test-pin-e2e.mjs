/*
 * 文档置顶 + 点赞同步（2026-10-12）
 *
 * 这套件钉的是三件**互相独立**的事，其中两件是当场查出来的真缺陷：
 *
 * ① 点赞**从来没有落过库**（本轮修掉的）
 *    现象：点完赞，本地 `likes=["u_admin"]`，服务端 `likes=[]`，
 *    而且**不报错、不提示**，刷新就没。
 *    病根在 `src/lib/sync.ts` 的 `comparable()`：它只保留
 *    DOC_COMPARE_FIELDS，而 `likes` 从来不在里面 ——
 *    而 `toggleDocLike` **不碰 updatedAt**（点赞不是一次编辑），
 *    于是「靠 updatedAt 带一把」那条路在这里根本不存在。
 *    没有任何一条路径能把这次改动推上去。
 *
 * ② 置顶的列如果声明成 NOT NULL，会把**整行推送**一起拒掉
 *    （本轮我自己踩的，当场抓到）
 *    线上协议里「没置顶」是 `null`，客户端新建的文档压根没有这个键，
 *    推上来的就是 null；服务端 INSERT 撞上 NOT NULL 直接拒：
 *      rejected: docs/d1「NOT NULL constraint failed: docs.pinnedAt」
 *    后果是**点赞被连累**（同一行推送被一起拒），现象又回到 ①。
 *    这条之所以要有守卫：它是一个「加了约束、反过来把别的功能打死」
 *    的形状，而且报错信息（NOT NULL）与病因（协议用 null）完全无关。
 *
 * ③ 只读成员**不能**因为 likes / pinnedAt 进了比较就开始假推送。
 *    把字段加进差分是有代价的：本地比基准多出的字段会造成写放大，
 *    而只读成员推不动 → 顶栏常驻「N 处修改没有保存」。
 *    ③ 是这条改动的**反向**约束 —— 没它的话，这次修复随时可能被
 *    下一个人「顺手统一一下字段」改回去。
 *
 * 自起服务 + 全新库（和 test-catalog-row-e2e 同一条理由）：
 * 这套件要点赞、要点置顶、要建三个文档，在 runner 的共享库里做这些
 * 就是往共享库里塞没人认领的数据。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.PIN_E2E_PORT || await freePort()
const DB = 'data/_pin.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
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
    const login = async () => {
      await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-login-card', { timeout: 25000 })
      await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
      await p.fill('.yq-login-card input[type="password"]', 'yuque@2026')
      await p.click('.yq-login-submit')
      await p.waitForSelector('.yq-app', { timeout: 30000 })
      await p.waitForTimeout(1500)
    }
    await login()
    const token = await p.evaluate(() => localStorage.getItem('yq_token'))
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
    const remoteDoc = async (id) =>
      (await (await fetch(`${BASE}/api/doc/${id}`, { headers: H })).json()).doc

    /* ---------- 自建一个库 + 三篇根级文档 ---------- */
    const sfx = Date.now().toString(36)
    const made = await p.evaluate((sfx) => {
      const s = window.__yqStore.getState()
      const bookId = s.createBook('s1', '置顶测试 ' + sfx)
      const ids = ['甲', '乙', '丙'].map((t) => window.__yqStore.getState().createDoc(bookId, null, t + sfx))
      return { bookId, ids }
    }, sfx)
    const { bookId, ids } = made
    ok(!!bookId && ids.length === 3 && ids.every(Boolean), '自建知识库与三篇根级文档', JSON.stringify(made))
    await p.waitForTimeout(2500)

    /*
     * ⚠️ `sfx` 必须当**参数**传进去。
     * page.evaluate 把函数体序列化到浏览器里执行，闭包捕获的 Node 变量
     * 一律取不到 —— 表现是 `ReferenceError: sfx is not defined`，
     * 栈顶指向 evaluate，看着像页面炸了，其实是这个套件写错了。
     */
    /*
     * 菜单项的文本要从 `.yq-menu-text` 里读。
     *
     * `MenuItem` 把图标也放在同一个 <button> 里（`index.tsx:417`），
     * 所以 textContent 是「📌置顶」而不是「置顶」——
     * 拿 `=== '置顶'` 去比会永远为假，而菜单其实好好地在那儿。
     */
    const menuTexts = () => p.evaluate(() =>
      [...document.querySelectorAll('.yq-menu-item')]
        .map((e) => (e.querySelector('.yq-menu-text')?.textContent || '').trim()))

    const titles = () => p.evaluate(([b, sx]) =>
      [...document.querySelectorAll('.yq-tree-item')]
        .map((r) => r.getAttribute('data-node-title'))
        .filter((t) => t && t.endsWith(sx)), [bookId, sfx])

    /* ================= ① 点赞真的落库 ================= */
    console.log('\n== ① 点赞会落库（以前从不落库，而且不报错）==')
    {
      const likeTarget = ids[0]
      await p.goto(`${BASE}/#/book/${bookId}/doc/${likeTarget}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-block', { timeout: 25000 })
      await p.waitForTimeout(2000)

      const before = await remoteDoc(likeTarget)
      ok(!(before.likes || []).length, '基准：服务端这一篇还没有赞', JSON.stringify(before.likes))

      await p.evaluate((d) => window.__yqStore.getState().toggleDocLike(d), likeTarget)
      await p.waitForTimeout(3500)
      const localLikes = await p.evaluate((d) => window.__yqStore.getState().docs[d].likes, likeTarget)
      const srvLikes = (await remoteDoc(likeTarget)).likes
      ok(localLikes.length === 1, '本地记下了这次赞', JSON.stringify(localLikes))
      ok(srvLikes.length === 1, '★ 服务端也记下了（这一步以前永远是空）', JSON.stringify(srvLikes))

      /* 反向：取消赞也要能推上去，否则「赞上去却取消不掉」 */
      await p.evaluate((d) => window.__yqStore.getState().toggleDocLike(d), likeTarget)
      await p.waitForTimeout(3500)
      const srvLikes2 = (await remoteDoc(likeTarget)).likes
      ok(srvLikes2.length === 0, '取消赞也同步过去了（不是只能加不能减）', JSON.stringify(srvLikes2))
    }

    /* ================= ② NOT NULL 陷阱 ================= */
    console.log('\n== ② pinnedAt 为 null 的行不许被拒（否则整行推送一起挂）==')
    {
      const doc = await remoteDoc(ids[0])
      ok(doc.pinnedAt === null, `基准：服务端把「没置顶」发成 null 而不是 0（实际=${JSON.stringify(doc.pinnedAt)}）`)
      const res = await p.request.post(`${BASE}/api/sync/push`, {
        headers: H,
        data: { upsert: { docs: [{ id: doc.id, pinnedAt: null }] }, remove: {} },
      })
      const body = await res.json()
      const rej = (body.rejected || []).filter((x) => x.entity === 'docs' && x.id === doc.id)
      ok(rej.length === 0,
        '★ 推一个 pinnedAt:null 的行不会被拒（NOT NULL 会把点赞一起打死）',
        JSON.stringify(body.rejected))
    }

    /* ================= ③ 置顶：排序 / 标记 / 取消回原位 ================= */
    console.log('\n== ③ 置顶排到本组最前，取消后精确回原位 ==')
    {
      await p.goto(`${BASE}/#/book/${bookId}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-tree-item', { timeout: 25000 })
      await p.waitForTimeout(1200)

      const t0 = await titles()
      ok(t0.length === 3, `基准：三篇都在树里（实际 ${t0.length}）`, JSON.stringify(t0))
      console.log(`       原顺序：${t0.map((t) => t[0]).join(' → ')}`)

      // 置顶最后一篇（丙），走**真实菜单点击**，证明入口不是一个摆设
      const targetTitle = t0[t0.length - 1]
      const targetDocId = await p.evaluate((b) => {
        const s = window.__yqStore.getState()
        const node = Object.values(s.nodes).find((n) => n.bookId === b && !n.parentId)
        return node ? node.docId : null
      }, bookId)
      // 找到标题对应的那一篇（树里可能还有别的库节点，按顺序对齐不可靠）
      const pinDocId = await p.evaluate(([b, t]) => {
        const s = window.__yqStore.getState()
        const node = Object.values(s.nodes).find((n) => n.bookId === b && n.title === t)
        return node ? node.docId : null
      }, [bookId, targetTitle])
      ok(!!pinDocId, `找到要置顶的那一项（${targetTitle}）`, String(pinDocId))
      void targetDocId

      // 悬停 → `···` → 「置顶」
      // ⚠️ 必须挑**非「＋」**的那个按钮：hover 区里有 `.yq-tree-act`（＋）
      //    和 `.yq-tree-act`（···）两个同名的，`.first()` 点到的是「＋」——
      //    于是它建了个子项并跳走，菜单根本没弹出来。
      const row = p.locator('.yq-tree-item', { hasText: targetTitle }).first()
      await row.hover()
      await row.locator('.yq-tree-act:not(.yq-tree-act-add)').first().click()
      await p.waitForSelector('.yq-menu-item', { timeout: 5000 })
      const mt = await menuTexts()
      ok(mt.includes('置顶'), '菜单里有「置顶」这一项', JSON.stringify(mt))
      await p.locator('.yq-menu-item', { has: p.locator('.yq-menu-text', { hasText: /^置顶$/ }) }).first().click()
      await p.waitForTimeout(1200)

      const t1 = await titles()
      console.log(`       置顶后：${t1.map((t) => t[0]).join(' → ')}`)
      ok(t1.length === 3, '置顶没有让任何一项消失（数量对得上）', JSON.stringify(t1))
      ok(t1[0] === targetTitle, '★ 被置顶的那篇排到了本组最前', JSON.stringify(t1))
      ok([...t1].sort().join('|') === [...t0].sort().join('|'), '三篇都还在，一个都没丢', JSON.stringify(t1))

      const pinnedMark = await p.evaluate((t) => {
        const r = [...document.querySelectorAll('.yq-tree-item')].find((x) => x.getAttribute('data-node-title') === t)
        return r ? !!r.querySelector('.yq-tree-pin') : null
      }, targetTitle)
      ok(pinnedMark === true, '被置顶的那一项有 📌 标记', String(pinnedMark))
      const othersMarked = await p.evaluate((t) =>
        [...document.querySelectorAll('.yq-tree-item')]
          .filter((x) => x.getAttribute('data-node-title') !== t)
          .map((x) => !!x.querySelector('.yq-tree-pin')), targetTitle)
      ok(othersMarked.length > 0 && othersMarked.every((v) => v === false),
        '没被置顶的项没有标记（否定式断言前面已经验过集合非空）', JSON.stringify(othersMarked))

      await p.waitForTimeout(3500)
      const srvPin = await remoteDoc(pinDocId)
      ok(Number(srvPin.pinnedAt) > 0, '★ 置顶落库了（服务端 pinnedAt 有值）', JSON.stringify(srvPin.pinnedAt))

      /* 刷新后仍在 —— 证明它不是内存 state */
      await p.reload({ waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-tree-item', { timeout: 25000 })
      await p.waitForTimeout(2500)
      const t2 = await titles()
      ok(t2[0] === targetTitle, '刷新后仍在最前（不是内存里的临时状态）', JSON.stringify(t2))
      const stillMarked = await p.evaluate((t) => {
        const r = [...document.querySelectorAll('.yq-tree-item')].find((x) => x.getAttribute('data-node-title') === t)
        return r ? !!r.querySelector('.yq-tree-pin') : null
      }, targetTitle)
      ok(stillMarked === true, '刷新后 📌 还在', String(stillMarked))

      /* 取消置顶 → 必须精确回到原位（order 从没被动过） */
      const row2 = p.locator('.yq-tree-item', { hasText: targetTitle }).first()
      await row2.hover()
      await row2.locator('.yq-tree-act:not(.yq-tree-act-add)').first().click()
      await p.waitForSelector('.yq-menu-item', { timeout: 5000 })
      const mt2 = await menuTexts()
      ok(mt2.includes('取消置顶'), '菜单项按当前状态改成了「取消置顶」', JSON.stringify(mt2))
      await p.locator('.yq-menu-item', { has: p.locator('.yq-menu-text', { hasText: /^取消置顶$/ }) }).first().click()
      await p.waitForTimeout(1200)

      const t3 = await titles()
      console.log(`       取消后：${t3.map((t) => t[0]).join(' → ')}`)
      ok(t3.join('|') === t0.join('|'), '★ 取消后精确回到原来的顺序', `期望 ${JSON.stringify(t0)} 实际 ${JSON.stringify(t3)}`)
      const markGone = await p.evaluate((t) => {
        const r = [...document.querySelectorAll('.yq-tree-item')].find((x) => x.getAttribute('data-node-title') === t)
        return r ? !!r.querySelector('.yq-tree-pin') : null
      }, targetTitle)
      ok(markGone === false, '📌 标记消失', String(markGone))
      await p.waitForTimeout(3500)
      const srvPin2 = await remoteDoc(pinDocId)
      ok(!(Number(srvPin2.pinnedAt) > 0), '取消置顶也落库了', JSON.stringify(srvPin2.pinnedAt))
    }

    /* ================= ④ 只读成员不许假推送 ================= */
    console.log('\n== ④ 只读成员不因为这两个字段产生假推送 ==')
    {
      const acct = `ro_pin_${sfx}`
      const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: '只读同事' },
      })).json()
      await p.request.post(`${BASE}/api/sync/push`, {
        headers: H,
        data: {
          upsert: {
            bookMembers: [{
              bookId, userId: reg.user.id, role: 'visitor',
              perms: { read: true, comment: true, edit: false, create: false, export: true, share: false },
              joinedAt: Date.now(),
            }],
          },
        },
      })

      const p2 = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
      const pushed = []
      const rejected = []
      p2.on('request', (r) => {
        if (!r.url().includes('/api/sync/push')) return
        try {
          const jb = JSON.parse(r.postData() || '{}')
          for (const [k, v] of Object.entries(jb.upsert || {})) {
            if (k === 'recents') continue // 他确实访问过，最近访问是合法写入
            pushed.push(`${k}×${v.length}`)
          }
        } catch { /* */ }
      })
      p2.on('response', async (r) => {
        if (!r.url().includes('/api/sync/push')) return
        try {
          const b = await r.json()
          for (const x of b.rejected || []) rejected.push(`${x.entity}/${x.id}: ${x.reason}`)
        } catch { /* */ }
      })
      await p2.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
      await p2.waitForSelector('.yq-login-card', { timeout: 25000 })
      await p2.fill('.yq-login-card input[autocomplete="username"]', acct)
      await p2.fill('.yq-login-card input[type="password"]', 'test1234')
      await p2.click('.yq-login-submit')
      await p2.waitForSelector('.yq-app', { timeout: 30000 })
      await p2.waitForTimeout(1200)
      await p2.goto(`${BASE}/#/book/${bookId}/doc/${ids[0]}`, { waitUntil: 'domcontentloaded' })
      await p2.waitForSelector('.yq-block', { timeout: 25000 })
      await p2.waitForTimeout(5000)

      ok(pushed.length === 0,
        '★ 只读成员打开文档没有推送任何东西（把 likes/pinnedAt 加进比较的代价）',
        JSON.stringify(pushed))
      ok(rejected.length === 0, '没有任何被拒的写入', JSON.stringify(rejected))
      const bar = await p2.locator('.yq-syncstatus-text').textContent().catch(() => '')
      ok(bar === null || !/没有保存/.test(bar), '顶栏没有「N 处修改没有保存」', bar || '(无)')
      await p2.close()
    }

    /* ================= ⑤ 客户端排的目录顺序必须落库 ================= */
    console.log('\n== ⑤ 刷新之后目录顺序还在（客户端的 order 必须真落库）==')
    {
      const ord = await p.evaluate((b) =>
        Object.values(window.__yqStore.getState().nodes)
          .filter((n) => n.bookId === b && !n.parentId)
          .map((n) => `${n.title}:${n.order}`), bookId)
      const domBefore = await titles()
      ok(ord.length === 3, `基准：三个根节点（${JSON.stringify(ord)}）`)

      await p.reload({ waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-tree-item', { timeout: 25000 })
      await p.waitForTimeout(3000)
      const ord2 = await p.evaluate((b) =>
        Object.values(window.__yqStore.getState().nodes)
          .filter((n) => n.bookId === b && !n.parentId)
          .map((n) => `${n.title}:${n.order}`), bookId)
      const domAfter = await titles()

      /*
       * ⚠️ 这一条是本轮查出来的**第二个真缺陷**，而且比置顶本身重要：
       *   前端的 `TreeNode` 叫 `order`，表里的列叫 `ord`，
       *   而服务端 `toRow()` 是**按列名去取值的** —— 客户端推的 `order`
       *   从来没被读过，那一列永远是 `DEFAULT 0`。
       *
       *   实测（修复前）：客户端 order 是 3 / 2 / 1，**刷新一次全变 0**，
       *   目录顺序退回「数组插入顺序」。拖拽调好的顺序同样存不住，
       *   而且**服务端不报任何错**：回的是 `applied`，零 `rejected`。
       *
       * 为什么一直没人发现：读的那一侧早就修好了（NODE_SHAPE 补 `order`），
       * 而种子数据本来就是按正确 ord 插进去的 ——
       * 「顺序没存住」和「顺序存住了」在演示数据上**长得一模一样**。
       */
      ok(ord2.join('|') === ord.join('|'),
        '★ 刷新后每个节点的 order 一字不差（拖过的顺序不会被悄悄丢掉）',
        `刷新前 ${JSON.stringify(ord)} 刷新后 ${JSON.stringify(ord2)}`)
      ok(ord2.some((x) => !/:0$/.test(x)),
        '而且确实不是全 0（全 0 等于「这一列压根没存住」的那一种坏法）',
        JSON.stringify(ord2))
      ok(domAfter.join('|') === domBefore.join('|'),
        '目录的显示顺序也没变', `刷新前 ${JSON.stringify(domBefore)} 刷新后 ${JSON.stringify(domAfter)}`)
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
