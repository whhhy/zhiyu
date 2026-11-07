/*
 * 回收站的两道权限门（2026-10-14 补，四个缺陷一次挖出来）
 *
 * ============================
 * ① 「别人私有文稿的标题」泄漏
 * ------------------------------------------------------------
 * `docs` 与 `nodes` 都挂了 `filter: canSeeDocRow`（2026-07 修过
 * 「私有文档的标题照样通过目录树同步推进每个人 localStorage」那一枪），
 * 而 **`trash` 这张表没有 `filter` 钩子** ——
 * 它的 `writable` 里同样带一份 `title`（删除那一刻的快照）。
 *
 * 于是路径是：私有文稿 → 被作者删进回收站 → **标题跟着 trash 行同步到了
 * 每个能读这个库的成员的本地库里**，而正文是读不到的（正文在 docs，行被筛掉了）。
 * 症状不报错、不空白，只是回收站列表里**冒出来一个他从来没读过的标题**。
 * 探针实测：私有文稿「薪酬调整方案…」出现在普通成员的回收站里。
 *
 * 对照：普通（非私有）文档被删 —— 那个读者删除前就读得到，
 * 所以**应该**在回收站里看见它。**不能把该看的也一起筛掉**。
 *
 * ============================
 * ② 界面给了必然失败的按钮
 * ------------------------------------------------------------
 * `BookTrashTab` 与全局 `/trash` 页对**所有角色**都渲染出可点的
 * 「还原」和「永久删除」，而服务端两个都会拒：
 *   · `restoreDoc` 要 `capsInBook().edit`
 *   · `purgeDoc`   要 `capsInBook().admin`
 * 读者拿到的是两个点下去只会弹错的按钮。
 *
 * ============================
 * 判据要点
 * ============================
 * · 读判据用**按钮的 disabled 属性**，不用 innerText ——
 *   按钮写着「还原」不代表它能点（这一版就是这么写错的）。
 * · **反向样本挑「有权限但不是最高权限」那一档（编辑者）**：
 *   管理员走 `capsInBook` 的 owner 早退，压根不验证判据本身，拿它当反向样本是白测。
 *   平台超管/库 owner 同理。
 * · 泄漏那条必须有反向：**作者自己看得到私有那篇** ——
 *   否则「把回收站整个筛空」也能让断言 1 变绿。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.TRASH_PERMS_PORT || await freePort()
const DB = 'data/_trashperm.db'
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

/** 知识库设置页「回收站」里某一行的两个按钮，读的是 disabled 属性 */
const bookTrashBtns = (page, title) => page.evaluate((t) => {
  const row = [...document.querySelectorAll('.yq-bset-table tbody tr')]
    .find((r) => (r.querySelector('.yq-bset-trash-name')?.textContent || '').includes(t))
  if (!row) return null
  const bs = [...row.querySelectorAll('button')]
  const pick = (label) => {
    const b = bs.find((x) => (x.textContent || '').trim() === label)
    return b ? { disabled: b.disabled === true, title: b.getAttribute('title') || '' } : null
  }
  return { restore: pick('还原'), purge: pick('永久删除') }
}, title)

/** 全局 /trash 页某一行 */
const globalTrashBtns = (page, title) => page.evaluate((t) => {
  const row = [...document.querySelectorAll('.yq-list-row')]
    .find((r) => (r.querySelector('.yq-list-row-title')?.textContent || '').includes(t))
  if (!row) return null
  const bs = [...row.querySelectorAll('button')]
  const pick = (label) => {
    const b = bs.find((x) => (x.textContent || '').trim() === label)
    return b ? { disabled: b.disabled === true, title: b.getAttribute('title') || '' } : null
  }
  return { restore: pick('恢复'), purge: pick('永久删除') }
}, title)

const show = (b) => b == null ? '**这一行不存在**'
  : `${b.restore ? (b.restore.disabled ? '还原禁用' : '还原可点') : '没有还原按钮'} / ${b.purge ? (b.purge.disabled ? '删除禁用' : '删除可点') : '没有删除按钮'}`

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
    await login(p, 'admin', 'yuque@2026')
    const H = await hdr(p)
    const sfx = Date.now().toString(36)

    const SECRET = '薪酬调整方案' + sfx
    const NORMAL = '公开的项目周报' + sfx
    const made = await p.evaluate(([secretTitle, normalTitle, x]) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '回收站权限 ' + x)
      const secret = window.__yqStore.getState().createDoc(b, null, secretTitle)
      const normal = window.__yqStore.getState().createDoc(b, null, normalTitle)
      const st = window.__yqStore.getState()
      st.updateDoc(secret, { visibility: 'private' })
      st.setDocBlocks(secret, [{ id: 'h1', type: 'h1', text: secretTitle }, { id: 'p', type: 'p', text: '绝密正文。' }])
      st.setDocBlocks(normal, [{ id: 'h1', type: 'h1', text: normalTitle }, { id: 'p', type: 'p', text: '普通正文。' }])
      return { b, secret, normal }
    }, [SECRET, NORMAL, sfx])
    for (let i = 0; i < 30; i++) {
      const bo = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await p.waitForTimeout(500)
    }
    // 等「仅自己可见」标记真的落到服务端，否则下面测的是没生效的中间态
    for (let i = 0; i < 20; i++) {
      const r = await (await p.request.get(`${BASE}/api/doc/${made.secret}`, { headers: H })).json()
      if (String((r?.doc || r)?.visibility) === 'private') break
      await p.waitForTimeout(500)
    }

    const addMember = async (role) => {
      const acct = `tp_${role}_${sfx}`
      const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `测试${role}` },
      })).json()
      // perms 必须**从角色派生**（`permsForRole`），写死成「只读+评论」的话
      // 选什么都没区别 —— 服务端按成员行上的 perms 逐项覆盖角色基线。
      // 这里三条都要造出来：editor 是「有权限但不是最高权限」那一档（反向样本），
      // reader 是普通成员，而 **visitor 连评论和导出都没有** ——
      // 权限最低的一档恰恰是泄漏影响最大的一档，不能不测。
      const PERMS = {
        editor: { read: true, comment: true, edit: true, create: true, export: true, share: true },
        reader: { read: true, comment: true, edit: false, create: false, export: true, share: false },
        visitor: { read: true, comment: false, edit: false, create: false, export: false, share: false },
      }
      await p.request.post(`${BASE}/api/sync/push`, {
        headers: H,
        data: { upsert: { bookMembers: [{ bookId: made.b, userId: reg.user.id, role, perms: PERMS[role], joinedAt: Date.now() }] } },
      })
      return { acct, uid: reg.user.id }
    }
    const reader = await addMember('reader')
    const editor = await addMember('editor')
    const visitor = await addMember('visitor')
    await p.waitForTimeout(6000)

    // 作者把两篇都删掉（私有那篇本来也只有作者能删）
    await p.evaluate(([a, b]) => {
      const s = window.__yqStore.getState()
      s.deleteDoc(a); s.deleteDoc(b)
    }, [made.secret, made.normal])
    await p.waitForTimeout(8000)

    /* ---------- ① 私有标题会不会漏出去 ---------- */
    console.log('\n== ① 私有文稿的标题有没有漏进普通成员的回收站 ==')
    {
      const rp = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(rp, reader.acct, 'test1234')
      const RH = await hdr(rp)
      const bo = await (await rp.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: RH })).json()
      const titles = (bo.data.trash || []).map((t) => String(t.title || ''))
      console.log('   读者收到的 trash 行：', JSON.stringify(titles))
      ok(!titles.some((t) => t.includes(SECRET)),
        `**私有文稿的标题没有**同步到读者本地库（实际收到 ${titles.length} 条：${titles.join('、') || '无'}）`)
      ok(titles.some((t) => t.includes(NORMAL)),
        '**普通文稿**的标题照常同步（这条是反向：不能把该看的也一起筛掉）')

      await rp.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await rp.waitForSelector('.yq-app', { timeout: 25000 })
      await rp.waitForTimeout(3500)
      await rp.locator('.yq-bset-nav-item', { hasText: '回收站' }).first().click({ timeout: 8000 })
      await rp.waitForTimeout(1800)
      const shown = await rp.evaluate(() => document.querySelector('.yq-bset-body')?.innerText || '')
      ok(!shown.includes(SECRET), '界面上也没有冒出那个私有标题')
      await rp.close()
    }
    {
      // 访客是**权限最低**的那一档（连评论、导出、分享都没有）。
      // 别人私有文稿的标题对他同样不该出现 —— 恰恰因为权限最低，这一档最容易被漏判。
      const vp = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(vp, visitor.acct, 'test1234')
      const VH = await hdr(vp)
      const bo = await (await vp.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: VH })).json()
      const vtitles = (bo.data.trash || []).map((t) => String(t.title || ''))
      console.log('   访客收到的 trash 行：', JSON.stringify(vtitles))
      ok(!vtitles.some((t) => t.includes(SECRET)), '**访客**也收不到私有文稿的标题')
      ok(vtitles.some((t) => t.includes(NORMAL)), '访客看得到普通文稿（删除前他就读得到）')
      await vp.goto(`${BASE}/#/trash`, { waitUntil: 'domcontentloaded' })
      await vp.waitForSelector('.yq-app', { timeout: 25000 })
      await vp.waitForTimeout(3500)
      const vShown = await vp.evaluate(() => document.body.innerText || '')
      ok(!vShown.includes(SECRET), '全局回收站页上访客也看不到那个私有标题')
      const vBtns = await globalTrashBtns(vp, NORMAL)
      console.log(`   访客在全局页看到的那一行：${show(vBtns)}`)
      ok(!!vBtns && vBtns.restore?.disabled === true, '访客点不了「恢复」')
      ok(!!vBtns && vBtns.purge?.disabled === true, '访客点不了「永久删除」')
      await vp.close()
    }

    /* ---------- ② 作者自己看得到私有那篇 ---------- */
    console.log('\n== ② 反向：作者自己必须看得到（否则「全筛空」也能骗过上面那条） ==')
    {
      await p.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(3500)
      await p.locator('.yq-bset-nav-item', { hasText: '回收站' }).first().click({ timeout: 8000 })
      await p.waitForTimeout(1800)
      const shown = await p.evaluate(() => document.querySelector('.yq-bset-body')?.innerText || '')
      ok(shown.includes(SECRET), '作者在回收站里看得到自己那篇私有文稿')
      ok(shown.includes(NORMAL), '作者也看得到那篇普通文稿')

      // 反向：软删之后目录树上**不该**出现它们
      // （改法是「把节点藏起来」，藏 = 树上不渲染；要是没藏住，
      //  就等于把删掉的文档留在目录里点进去 404）
      await p.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(4000)
      const tree = await p.evaluate(() =>
        [...document.querySelectorAll('.yq-tree-row, .yq-tree-item, [class*="yq-tree"]')]
          .map((r) => (r.innerText || '')).join('|'))
      ok(!tree.includes(NORMAL) && !tree.includes(SECRET),
        '软删之后目录树上不再显示这两篇（节点是藏起来了，不是留在树上）')
    }

    /* ---------- ③ 权限第一道：界面 ---------- */
    console.log('\n== ③ 界面上那两个按钮 ==')
    const asUser = async (who) => {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg, who.acct, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(3500)
      await pg.locator('.yq-bset-nav-item', { hasText: '回收站' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(2000)
      return pg
    }
    {
      const rp = await asUser(reader)
      const btns = await bookTrashBtns(rp, NORMAL)
      console.log(`   读者看到的那一行：${show(btns)}`)
      ok(!!btns && btns.restore?.disabled === true, '读者点不了「还原」（服务端要 edit 权限）')
      ok(!!btns && btns.purge?.disabled === true, '读者点不了「永久删除」（服务端要 admin 权限）')
      await rp.close()
    }
    {
      // 编辑者 = **有权限但不是最高权限**那一档。拿管理员当反向样本是白测：
      // `capsInBook` 对 owner/admin 早退，压根不验证这条判据。
      const ep = await asUser(editor)
      const btns = await bookTrashBtns(ep, NORMAL)
      console.log(`   编辑者看到的那一行：${show(btns)}`)
      ok(!!btns && btns.restore?.disabled === false, '**编辑者照样能还原**（不能把门全关上，那叫「功能没了」）')
      ok(!!btns && btns.purge?.disabled === true, '编辑者点不了「永久删除」（那一档是 admin 专属）')
      await ep.close()
    }
    {
      const btns = await (async () => {
        // ⚠️ ② 为了验「软删后树上不显示」把管理员的页导航走了，这里必须走回来，
        //    否则读的是知识库首页，根本没有回收站表格（第一版就踩了，白报一条红）
        await p.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
        await p.waitForSelector('.yq-app', { timeout: 25000 })
        await p.waitForTimeout(3500)
        await p.locator('.yq-bset-nav-item', { hasText: '回收站' }).first().click({ timeout: 8000 })
        await p.waitForTimeout(2000)
        return bookTrashBtns(p, NORMAL)
      })()
      console.log(`   管理员看到的那一行：${show(btns)}`)
      ok(!!btns && btns.purge?.disabled === false, '管理员能永久删除')
      ok(!!btns && btns.restore?.disabled === false,
        `**管理员能还原**（实际：${show(btns)}${btns?.restore?.title ? `，title=「${btns.restore.title}」` : ''}）`)
    }

    /* ---------- ④ 全局回收站页：跨库，必须按行判 ---------- */
    console.log('\n== ④ 全局回收站页（行分属不同的库） ==')
    {
      const rp = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(rp, reader.acct, 'test1234')
      await rp.goto(`${BASE}/#/trash`, { waitUntil: 'domcontentloaded' })
      await rp.waitForSelector('.yq-app', { timeout: 25000 })
      await rp.waitForTimeout(4000)
      const btns = await globalTrashBtns(rp, NORMAL)
      console.log(`   读者在全局页看到的那一行：${show(btns)}`)
      ok(!!btns && btns.restore?.disabled === true, '全局页的「恢复」对读者也是禁用的')
      ok(!!btns && btns.purge?.disabled === true, '全局页的「永久删除」对读者也是禁用的')
      const hasClear = await rp.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('清空回收站')))
      ok(!hasClear, '读者看不到「清空回收站」（按钮承诺「全部永久删除」，做不到就不该出现）')
      await rp.close()
    }
    {
      const ep = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(ep, editor.acct, 'test1234')
      await ep.goto(`${BASE}/#/trash`, { waitUntil: 'domcontentloaded' })
      await ep.waitForSelector('.yq-app', { timeout: 25000 })
      await ep.waitForTimeout(4000)
      const btns = await globalTrashBtns(ep, NORMAL)
      console.log(`   编辑者在全局页看到的那一行：${show(btns)}`)
      ok(!!btns && btns.restore?.disabled === false, '全局页对编辑者也是按行放行的')
      await ep.close()
    }

    /* ---------- ⑤ 权限第二道：绕过界面直接调 store ---------- */
    console.log('\n== ⑤ 第二道：脚本绕过界面直接调 store action ==')
    {
      const rp = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(rp, reader.acct, 'test1234')
      await rp.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await rp.waitForSelector('.yq-app', { timeout: 25000 })
      await rp.waitForTimeout(4000)
      const before = await rp.evaluate(() => window.__yqStore.getState().trash.length)
      const after = await rp.evaluate(async (d) => {
        window.__yqStore.getState().restoreFromTrash(d)
        // ⚠️ 必须早于 2600ms：toast 那个定时器会自动把提示收掉（store/index.ts），
        //    等过了就什么都读不到 —— 我第一版等了 3000ms，判据因此恒假。
        await new Promise((r) => setTimeout(r, 1200))
        const s = window.__yqStore.getState()
        return { n: s.trash.length, toasts: s.toasts.map((t) => t.message || t.text || '') }
      }, made.normal)
      console.log(`   回收站条数 ${before} → ${after.n}；提示：${JSON.stringify(after.toasts)}`)
      ok(after.n === before, '本地回收站那一行**没被动过**（没有乐观地先删掉）')
      ok(after.toasts.some((t) => /权限/.test(t)), `并且明确说了是权限问题（实际提示：${after.toasts.join(' / ') || '无'}）`)
      await rp.close()
    }

    /* ---------- ⑥ 还原真的能用（放最后：它会改状态） ---------- */
    console.log('\n== ⑥ 编辑者点「还原」之后，文档要真回来 ==')
    {
      const ep = await asUser(editor)
      // 直接听那个接口的响应体：`restoreFromTrash` 里 `if (r?.doc)` 走不走得通，
      // 决定正文是**立刻**落地还是只能等同步。而 toast 是在 if/else **外面**的，
      // 所以「提示说已恢复」并不能证明那一步走了 —— 必须看回包。
      let restoreResp = null
      // 客户端**自己**的增量响应里到底有没有这一篇 —— 这是唯一还没量过的一环。
      // 之前只量了 `since=0`（整包），那只能证明服务端「能」发，
      // 证不了**这个客户端的游标那一段**有没有把它带上。
      // 在 → 货到了门口，是 applyDelta 丢的；不在 → 游标/跳过的问题。
      const deltaHits = []
      ep.on('response', async (res) => {
        const u = new URL(res.url())
        if (!u.pathname.endsWith('/api/sync/changes')) return
        try {
          const j = await res.json()
          deltaHits.push({
            since: u.searchParams.get('since'),
            upsert: (j?.upsert?.docs || []).some((r) => r.id === made.normal),
            remove: (j?.remove?.docs || []).includes(made.normal),
            seq: j?.seq,
          })
        } catch { /* 解析不了就当没看见 */ }
      })
      ep.on('response', async (res) => {
        if (!/\/restore$/.test(new URL(res.url()).pathname)) return
        try {
          const j = await res.json()
          restoreResp = {
            status: res.status(),
            keys: Object.keys(j || {}),
            hasDoc: !!j?.doc,
            docBlocks: Array.isArray(j?.doc?.blocks) ? j.doc.blocks.length : null,
          }
        } catch { restoreResp = { status: res.status(), parse: 'failed' } }
      })
      await ep.locator('.yq-bset-table tbody tr', { hasText: NORMAL })
        .locator('button', { hasText: '还原' }).first().click({ timeout: 8000 })
      // 分三次采样：applyRemote 是**立刻**发生的，等 6 秒再看只能分不清
      // 「没落地」和「落地了又被冲掉」。提示 2600ms 就消失，所以第一次要早。
      const samples = []
      for (const at of [800, 3000, 6000, 12000, 22000]) {
        await ep.waitForTimeout(at - (samples.length ? samples[samples.length - 1][0] : 0))
        const client = await ep.evaluate((d) => {
          const s = window.__yqStore.getState()
          return {
            stillInTrash: s.trash.some((t) => t.docId === d),
            backInDocs: !!s.docs[d],
            blocks: Array.isArray(s.docs[d]?.blocks) ? s.docs[d].blocks.length : -1,
            nodes: s.nodes.filter((n) => n.docId === d).length,
            hiddenNodes: s.nodes.filter((n) => n.docId === d && n.hidden).length,
            toasts: s.toasts.map((t) => t.message || ''),
          }
        }, NORMAL)
        // 同一时刻读服务端：分清「服务端有、客户端丢」还是「服务端也没有」。
        // ⚠️ bootstrap 的 `data.docs` 是**数组**，不是按 id 建的字典
        //    （`server/sync.ts` 的 bootstrap：`data[def.name] = readEntity(...)`）。
        //    按 id 取值恒为 undefined —— 我第一版就是这么写成「服务端没有」的，是**假象**。
        const bo = await (await ep.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: await hdr(ep) })).json()
        const row = (bo.data.docs || []).find((r) => r.id === made.normal)
        samples.push([at, { client, server: { found: !!row, blocks: Array.isArray(row?.blocks) ? row.blocks.length : -1 } }])
      }
      for (const [at, s] of samples) console.log(`   +${at}ms 客户端：`, JSON.stringify(s.client), ' 服务端：', JSON.stringify(s.server))
      console.log('   /restore 回包：', JSON.stringify(restoreResp))
      console.log('   客户端自己的增量（最近 6 次）：', JSON.stringify(deltaHits.slice(-6)))

      const lastClient = samples[samples.length - 1][1].client
      ok(!lastClient.stillInTrash, '还原之后回收站里不再有它')

      /*
       * ⚠️ 这里记过一次「假的开放缺陷」，写下来免得再犯一遍。
       *
       * 我先前量到「服务端有、客户端 22 秒仍无」，一度把它当成一条待办记进了守卫。
       * 真相是**观察窗口开短了**：轮询周期比那 22 秒长，文稿在最后一次采样**之后**
       * 才到。补一条「按标题扫全部 docs」的判据立刻就看见了它
       * （键正确、正文 2 块齐全）—— 之前一直按 id 取值，而那正是它该出现的键。
       *
       * 所以这里改成**轮询到它出现为止**，并断言它**不刷新页面**也能到：
       * 这条比原来那句「刷新后能看到」强得多，而且是真的。
       *
       * 教训（今天第 5 次同族）：**「等 N 秒还没看到」不等于「没有」**，
       * 尤其在有轮询的链路上。判据要给足窗口，或者轮询到成立为止，
       * 别拿一个固定超时当结论。
       */
      const converged = await ep.evaluate(async (t) => {
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const s = window.__yqStore.getState()
          const hit = Object.entries(s.docs).find(([, d]) => String((d && d.title) || '').includes(t))
          if (hit) {
            return {
              key: hit[0],
              blocks: Array.isArray(hit[1] && hit[1].blocks) ? hit[1].blocks.length : -1,
              waitedMs: 60000 - (deadline - Date.now()),
            }
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        return null
      }, NORMAL)
      console.log('   轮询等待落地：', JSON.stringify(converged))
      ok(!!converged, '不刷新页面，这篇文稿也**自己同步回来了**（轮询周期内收敛）')
      ok(!!converged && converged.key === made.normal,
        `而且键是对的（${converged ? converged.key : '没找到'}，期望 ${made.normal}）——` +
        '键错的话任何按 id 的入口（路由/目录树/搜索/差分）都摸不到它，比收敛慢严重得多')
      ok(!!converged && converged.blocks > 0, `正文一起回来了（${converged ? converged.blocks : '-'} 块）`)

      /*
       * ⚠️⚠️ 这里**有一条已量到、但本轮没有修完的缺口**，先写清楚它是什么、
       *    量到了什么，免得后来的人以为这条已经盖住了：
       *
       * 现象（5 个客户端同时开着的场景下量到的）：
       *   服务端从头到尾都对 —— bootstrap 有它（`found:true, blocks:2`），
       *   `/api/sync/changes?since=0` 的增量里也有它（`upsert.docs 含它=true`）；
       *   `/restore` 的回包也带着完整正文（`hasDoc:true, blocks:2`），
       *   而 `restoreFromTrash` 的快路径**确实执行了**（回包有 doc 就走 if 那支）。
       *   可是这个客户端的 store 里，22 秒之后仍然没有它。
       *
       *   也就是说：**服务端把货送到了门口，客户端把它丢了**。
       *   单客户端场景不出现（探针里 +500ms 就落地了），所以它只在
       *   「删除是别人做的、还原是我做的」这种多人同时在线时显形。
       *
       * 为什么这里**不断言**它修好了：
       *   把判据改成「22 秒后必须在 store 里」会让这条红着走，
       *   而把它悄悄放宽成「刷新后能看到」又等于把缺口藏起来。
       *   两者都不做 —— 下面改成断言**服务端真相**与**刷新后的界面**，
       *   并把会话内收敛这条如实报成待办。
       */
      const svc = samples[samples.length - 1][1].server
      ok(svc.found, `服务端确实还原了（bootstrap 查得到，blocks=${svc.blocks}）`)
      ok(svc.blocks > 0, `服务端正文完整（${svc.blocks} 块）`)

      {
        // 决定性的一刀：问增量接口，看这篇到底在不在 delta 里。
        // 在 → 服务端把货送到了门口，是客户端 applyDelta 丢了；
        // 不在 → 服务端的增量出口本身就没发（和 bootstrap 是两套过滤）。
        const EH2 = await hdr(ep)
        const ch = await (await ep.request.get(`${BASE}/api/sync/changes?since=0`, { headers: EH2 })).json()
        const inDelta = (ch.upsert?.docs || []).some((r) => r.id === made.normal)
        const inDeltaRemove = (ch.remove?.docs || []).includes(made.normal)
        console.log(`   增量里：upsert.docs 含它=${inDelta}；remove.docs 含它=${inDeltaRemove}（seq=${ch.seq}）`)
        ok(inDelta, '服务端增量**确实发出了**这篇（since=0 整包）')
      }
      {
        // 刷新一次再看：这时候断言的是**用户真正能看到的东西**。
        // 「刷新后能看到」不等于「之前也该有」—— 那条缺口在上面写着。
        await ep.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
        await ep.waitForSelector('.yq-app', { timeout: 25000 })
        await ep.waitForTimeout(4000)
        const inTree = await ep.evaluate((t) => {
          const rows = [...document.querySelectorAll('.yq-tree-row, .yq-tree-item, [class*="yq-tree"]')]
          return rows.some((r) => (r.innerText || '').includes(t))
        }, NORMAL)
        ok(inTree, '界面上目录树里真的能看到它了（位置回来了，且是可见的）')
        const afterReload = await ep.evaluate((d) => {
          const s = window.__yqStore.getState()
          return {
            inDocs: !!s.docs[d],
            blocks: Array.isArray(s.docs[d]?.blocks) ? s.docs[d].blocks.length : -1,
            nodes: s.nodes.filter((n) => n.docId === d).length,
            hiddenNodes: s.nodes.filter((n) => n.docId === d && n.hidden).length,
          }
        }, made.normal)
        console.log('   刷新后本地：', JSON.stringify(afterReload))
        ok(afterReload.inDocs && afterReload.blocks > 0,
          `刷新后正文完整回到了本地（${afterReload.blocks} 块）`)
        ok(afterReload.nodes > 0 && afterReload.hiddenNodes === 0,
          `**目录树里那个位置回来了且可见**（节点 ${afterReload.nodes} 个，其中隐藏 ${afterReload.hiddenNodes}；` +
          '0 = 文稿回来了但树上哪儿都点不着，而提示却写着「已还原到原位置」）')
      }
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
