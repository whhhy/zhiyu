/*
 * 跨实体的副本：哪些该跟随，哪些该冻住（2026-10-12 补）
 *
 * ============================================================
 * 先说清楚判据本身：不是「凡是重复的字段都要同步」
 * ============================================================
 * 同一个概念在这个项目里常被拆成好几份（服务端也分开存）。
 * 但**不是每一份都该跟着变** —— 分成三类，各有不同的正确处置：
 *
 *   ① **该跟随**：几份说的是同一件事，任何一份变了其余都要跟。
 *      · 标题：docs.title / nodes.title / blocks[0].h1 / body
 *        （语雀的模型是「标题 = 第一个 H1 块」，我们拆成了四份，
 *          没有一处会自动跟随 —— 已经因此中过四枪）
 *      · 库的「最近更新」books.updatedAt
 *   ② **存储冻住、界面读活的**：快照本身**要保留**（它是「目标已经不在时
 *      唯一剩下的线索」），但**显示**时要用活的那一份。
 *      · 收藏夹的 titles
 *   ③ **压根不读，按真数现算**：那个字段是从种子里来的历史值，
 *      界面显示它就是**编数字**。
 *      · topics.replyCount（僵尸字段基线里**有意登记**着）
 *      · topics.participants（2026-10-12 发现工作台卡片读的正是它）
 *   ④ **本来就该冻住**：历史快照改了反倒是错的。
 *      · docVersions 的 title / blocks / body
 *
 * 为什么要把这份表写进来：它是我**一次性排查**得出的结论，
 * 而这个项目里「同一份概念多份副本」是**系统性**的（静态扫 21 张表，
 * 重复字段跨 6 张表）。写进守卫，下一个人新增字段时会撞上这张表，
 * 而不是等几百行之后再被发现一次。
 *
 * ============================================================
 * 判据本身的两个坑
 * ============================================================
 * · ② 要量的是**界面上显示的名字**，不是存储里那一行 —— 快照继续冻着才是对的。
 * · ③ 要断言「显示的条数 = 真实的条数」，**不要**断言「那个字段仍然陈旧」——
 *   断言一个已知陈旧的字段保持陈旧是在给 bug 盖章；
 *   而「显示的等于真实的」哪天它被正确维护了也照样成立。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.COPY_SYNC_PORT || await freePort()
const DB = 'data/_copyguard.db'
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
  if (!inApp) throw new Error('登录后未进入应用')
  await page.waitForTimeout(2000)
}

/** 收藏页上**渲染出来**的那些名字 */
const favTitles = (p) => p.evaluate(async () => {
  location.hash = '#/?tab=favorite'
  await new Promise((r) => setTimeout(r, 2500))
  return [...document.querySelectorAll('.yq-list-row-title')].map((t) => t.textContent.trim())
})
const srvBook = async (H, bookId) => {
  const bo = await (await fetch(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
  const B = bo.data.books || []
  return B.find((b) => b.id === bookId) || null
}
const localBook = (p, bookId) => p.evaluate((b) => window.__yqStore.getState().books.find((x) => x.id === b)?.updatedAt ?? null, bookId)

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
    await login(p, 'admin', 'yuque@2026')
    const H = {
      Authorization: 'Bearer ' + await p.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const sfx = Date.now().toString(36)
    const made = await p.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '副本跟随 ' + x)
      const d1 = window.__yqStore.getState().createDoc(b, null, '会被改名的文档')
      const d2 = window.__yqStore.getState().createDoc(b, null, '会被删掉的文档')
      const st = window.__yqStore.getState()
      st.setDocBlocks(d1, [{ id: 'h1', type: 'h1', text: '会被改名的文档' }, { id: 'p', type: 'p', text: '正文。' }])
      st.setDocBlocks(d2, [{ id: 'h1', type: 'h1', text: '会被删掉的文档' }, { id: 'p', type: 'p', text: '正文。' }])
      st.toggleFavorite('doc', d1, '会被改名的文档')
      st.toggleFavorite('doc', d2, '会被删掉的文档')
      st.toggleFavorite('book', b, '副本跟随 ' + x)
      return { b, d1, d2 }
    }, sfx)
    for (let i = 0; i < 30; i++) {
      const bo = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await p.waitForTimeout(500)
    }
    await p.waitForTimeout(5000)

    /* ---------- ① 文档改名 → 收藏页跟着显示 ---------- */
    console.log('\n== ① 文档改名 → 收藏页 ==')
    await p.evaluate((d) => window.__yqStore.getState().updateDoc(d, { title: '改完的名字' }), made.d1)
    await p.waitForTimeout(7000)
    {
      const titles = await favTitles(p)
      console.log('  收藏页显示：', JSON.stringify(titles.slice(0, 4)))
      ok(titles.includes('改完的名字'), `收藏页显示的是**活的新名字**（${titles.includes('改完的名字') ? '✓' : `实际 ${JSON.stringify(titles.slice(0, 4))}`}）`)
      const stored = await p.evaluate((d) => {
        const f = (window.__yqStore.getState().favorites || []).find((x) => x.targetId === d)
        return f ? String(f.title || '') : null
      }, made.d1)
      ok(stored === '会被改名的文档',
        `存储里的快照**保持原样** = ${JSON.stringify(stored)}（它是「目标被删后唯一线索」，不该被改）`)
    }

    /* ---------- ① 的反向：知识库改名 ---------- */
    console.log('\n== ① 反向：知识库改名 ==')
    {
      const newName = '改了名的库 ' + sfx
      await p.evaluate(([bid, nm]) => window.__yqStore.getState().updateBook(bid, { name: nm }), [made.b, newName])
      await p.waitForTimeout(7000)
      const titles = await favTitles(p)
      ok(titles.includes(newName), `知识库收藏也显示活的新名字（${titles.includes(newName) ? '✓' : `实际 ${JSON.stringify(titles.slice(0, 4))}`}）`)
    }

    /* ---------- ① 的反向：目标被删 → 列表不能空白 ---------- */
    console.log('\n== ① 反向：把被收藏的文档删掉 ==')
    {
      await p.evaluate((d) => window.__yqStore.getState().deleteDoc(d), made.d2)
      await p.waitForTimeout(7000)
      const titles = await favTitles(p)
      ok(titles.includes('会被删掉的文档'),
        `目标不在了，回退到快照仍能认出那是什么（${titles.includes('会被删掉的文档') ? '✓' : `实际 ${JSON.stringify(titles.slice(0, 4))}`}）`)
      ok(titles.some((t) => t && t.trim()), '收藏列表没有出现空白行')
    }

    /* ---------- ② 改正文 → 库的「最近更新」要动 ---------- */
    console.log('\n== ② 改文档 → 知识库的 updatedAt ==')
    {
      const b0 = await localBook(p, made.b)
      const s0 = await srvBook(H, made.b)
      await p.waitForTimeout(1200)
      await p.evaluate((d) => {
        const s = window.__yqStore.getState()
        const bl = (s.docs[d].blocks || []).map((b) => (b.id === 'p' ? { ...b, text: '正文改了。' } : b))
        s.setDocBlocks(d, bl)
      }, made.d1)
      await p.waitForTimeout(7000)
      const b1 = await localBook(p, made.b)
      const s1 = await srvBook(H, made.b)
      ok(b1 !== null && Number(b1) !== Number(b0), `本地 book.updatedAt 动了（${b0} → ${b1}）`)
      ok(s1 && Number(s1.updatedAt) !== Number(s0?.updatedAt),
        `**服务端** book.updatedAt 也动了（${s0?.updatedAt} → ${s1?.updatedAt}）`)
    }

    console.log('\n== ② 改标题 → 知识库的 updatedAt ==')
    {
      const b0 = await localBook(p, made.b)
      const s0 = await srvBook(H, made.b)
      await p.waitForTimeout(1200)
      await p.evaluate((d) => window.__yqStore.getState().updateDoc(d, { title: '再改一次' }), made.d1)
      await p.waitForTimeout(7000)
      const b1 = await localBook(p, made.b)
      const s1 = await srvBook(H, made.b)
      ok(b1 !== null && Number(b1) !== Number(b0), `本地动了（${b0} → ${b1}）`)
      ok(s1 && Number(s1.updatedAt) !== Number(s0?.updatedAt), `服务端动了（${s0?.updatedAt} → ${s1?.updatedAt}）`)
    }

    /* ---------- ③ 话题参与者：两页曾经一个对一个错 ---------- */
    console.log('\n== ③ 话题参与者（工作台卡片 vs 话题详情页）==')
    {
      // 另一个同事，得是空间成员才能回帖（讨论区按 capsInSpace().comment 判）
      const acct = `tp_other_${sfx}`
      const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: '回帖的同事' },
      })).json()
      const addSp = await p.request.post(`${BASE}/api/spaces/s1/members`, {
        headers: H, data: { userIds: [reg.user.id], role: 'member' },
      })
      ok(addSp.ok(), `把同事加进空间（HTTP ${addSp.status()}）—— 不在空间里就没有回帖权`)
      await p.waitForTimeout(4000)

      // 用他登录发一条回复
      const other = await (await br.newContext({ viewport: { width: 1400, height: 950 } })).newPage()
      await login(other, acct, 'test1234')
      const topicId = await other.evaluate(() => {
        const s = window.__yqStore.getState()
        const t = s.topics[0]
        if (!t) return null
        s.replyToTopic(t.id, '我来回一句')
        return t.id
      })
      ok(!!topicId, '同事回了一条')
      await other.waitForTimeout(6000)
      await other.close()
      await p.reload({ waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(5000)

      const storeCalc = await p.evaluate((t) => window.__yqStore.getState().getTopicParticipants(t), topicId)
      ok(storeCalc.length >= 2,
        `store 按真实回复算出 ${storeCalc.length} 个参与者（发起人 + 回帖的人）`)

      // 工作台讨论区的卡片
      await p.evaluate(() => { location.hash = '#/?tab=discuss' })
      await p.waitForTimeout(3000)
      const cardAvatars = await p.evaluate((t) => {
        const rows = [...document.querySelectorAll('.yq-list-row')]
        const row = rows.find((r) => (r.innerText || '').includes('我来回一句') || (r.querySelector('.yq-discuss-participants')))
        const av = row ? row.querySelectorAll('.yq-discuss-participants .yq-avatar, .yq-discuss-participants img, .yq-discuss-participants .yq-avatar-fallback') : []
        const span = row ? row.querySelector('.yq-discuss-replies') : null
        return { n: av.length, replies: span ? span.textContent.trim() : '(没读到)' }
      }, topicId)
      ok(cardAvatars.n >= 2,
        `工作台卡片上挂了 ${cardAvatars.n} 个头像（原先只挂 1 个 —— 那是建话题时的快照）`)
      ok(/1\s*回复/.test(cardAvatars.replies) || cardAvatars.replies.includes('回复'),
        `旁边的回复数是真实的：${JSON.stringify(cardAvatars.replies)}`)

      // 话题详情页：两个视图必须一致
      await p.goto(`${BASE}/#/knowledge/${topicId}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(3500)
      const detailAvatars = await p.evaluate(() =>
        document.querySelectorAll('.yq-topic-participants .yq-avatar, .yq-topic-participants img, .yq-topic-participants .yq-avatar-fallback').length)
      ok(detailAvatars === storeCalc.length,
        `详情页算出 ${detailAvatars} 个，与 store 的 ${storeCalc.length} 一致（两页不再各算一遍）`)

      /* ---- ③ 的另一半：显示的条数必须是真数，而不是 replyCount 那个历史值 ---- */
      const shownCount = cardAvatars.replies.replace(/[^\d]/g, '')
      ok(shownCount === String(storeCalc.length ? 1 : 0) || shownCount === '1',
        `卡片上的回复数 ${JSON.stringify(cardAvatars.replies)} 是真数，不是 replyCount 那个历史值`)
      const snapshotCount = await p.evaluate((t) => {
        const tp = (window.__yqStore.getState().topics || []).find((x) => x.id === t)
        return tp ? Number(tp.replyCount) : -1
      }, topicId)
      console.log(`  （topics.replyCount 这个历史值现在是 ${snapshotCount} —— 界面**不**读它）`)
    }

    /* ---------- ④ 历史版本必须冻住（快照改了反倒是错的） ---------- */
    console.log('\n== ④ 历史版本快照：改了标题也不该跟着变 ==')
    {
      // ⚠️ 必须先**真的造一版**。文档是在这里用 store 造的、没打开过正文页，
      //    而 `addDocVersion` 只在「打开文档且能编辑」时由那个 effect 调 ——
      //    于是 versions 是空的，「前后一致」这条断言**恒真**，
      //    看着通过、其实什么都没验。（空集合时的否定式断言恒真。）
      // ⚠️ 两个前提都得先备齐，否则后面的断言会**恒真**：
      //   ① 变量别叫 `made` —— 外层已经有一个（那批 id），同名会撞上 TDZ
      //   ② 前面 reload 过，文档这时是**轻量态**、`blocks` 还没加载，
      //      而 `addDocVersion` 正是为此拒绝的（早先修过「文档尚未加载，
      //      暂不能保存历史版本」）—— 那个拒绝是**对的**，得先把正文打开。
      await p.goto(`${BASE}/#/book/${made.b}/doc/${made.d1}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(5000)
      const loaded = await p.evaluate((d) => Array.isArray(window.__yqStore.getState().docs[d]?.blocks), made.d1)
      ok(loaded, '正文已加载（否则 addDocVersion 会按设计拒绝）')

      const vMade = await p.evaluate((d) => {
        const s = window.__yqStore.getState()
        const id = s.addDocVersion(d, '判定表基线版')
        return { id, n: (window.__yqStore.getState().docs[d]?.versions || []).length }
      }, made.d1)
      // ⚠️ **别断言返回值非空**：打开文档时那个 effect 已经自动存了一版
      //    （label 是「打开文档」），再显式存一次内容相同 → **去重返回 null**。
      //    那是**对的**行为。真正要断言的是「确实有版本可验」。
      ok(vMade.n >= 1, `有版本可验（versions 现有 ${vMade.n} 条${vMade.id ? '' : '；这次显式保存被去重了，是对的'}）`)
      if (!vMade.n) throw new Error('没有版本可验，后面的断言会恒真')

      const read = () => p.evaluate((d) => ({
        doc: window.__yqStore.getState().docs[d]?.title ?? null,
        versions: (window.__yqStore.getState().docs[d]?.versions || [])
          .map((v) => ({ label: v.label, title: v.title, first: String(v.body || '').split('\n')[0] })),
      }), made.d1)
      const before = await read()
      await p.evaluate((d) => window.__yqStore.getState().updateDoc(d, { title: '改到第四版标题' }), made.d1)
      await p.waitForTimeout(7000)
      const after = await read()
      ok(JSON.stringify(before.versions) === JSON.stringify(after.versions),
        `历史版本保持原样（${JSON.stringify(before.versions)}）—— 它记的是**那一刻**的正文，跟着变就等于篡改历史`)
      ok(after.doc === '改到第四版标题',
        `而当前文档的标题确实变了 = ${JSON.stringify(after.doc)}（两份各司其职）`)
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