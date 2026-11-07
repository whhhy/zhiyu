/**
 * `docs.body` 不能是旧的
 *
 * ============================================================
 * 这个套件钉的是一个**全绿但功能失效**的问题
 * ------------------------------------------------------------
 * `docs.body` 和 `docs.blocks` 是同一份内容的两种表示（markdown / 结构化块），
 * 而编辑路径**只更新 blocks**。于是 `body` 对用户写的内容永远是
 * 「建文档时」的那一份 —— 新建文档甚至是**空的**。
 *
 * 而 `body` 有三个真实的用户可见消费方：
 *   ① 单篇导出 Markdown / Word / HTML / 纯文本（DocPage 的「···」菜单）
 *   ② 对外分享页（PublicDoc 渲染的就是 body）
 *   ③ 发现页的卡片摘要
 *
 * 实测（真实流程：建文档 → 在正文段落里敲一句 → 导出 / 分享 / 看发现页）：
 *     导出文件名 未命名.md，**内容长度 0**
 *     分享页访客只看到一个标题，正文一个字都没有
 *     发现页摘要空
 *
 * **而这一切没有任何报错**：文件能正常下载、分享页能正常打开、
 * toast 还会说「已导出」。用户拿到一个**零字节的 .md**，
 * 只会以为自己写错了，或者以为软件有 bug。
 *
 * 最扎眼的是：**搜索早就撞见过同一个根因**。
 * useSearch.ts 的注释写着「没打开过的文档 body 是空的」，
 * 当时的解法是 `d.body || blocks.map(b => b.text)` —— **绕过**，不是根治。
 * 于是同一根因在另外三处一直在流血，而它们连提示都没有。
 * 这也是「同一个概念三份实现」出过一次事的那个模式。
 * ============================================================
 */
import { chromium } from 'playwright'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blocksToMarkdown } from './src/lib/blocks-markdown.ts'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const MARK = 'BODY-FRESH-MARK-9137'
const TITLE_MARK = '新鲜度探针标题'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ acceptDownloads: true })
  const p = await ctx.newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(2000)
  const token = await p.evaluate(() => localStorage.getItem('yq_token'))

  /*
   * **用自己的知识库，不要动 `books[0]`。**
   *
   * 头一版用 `books[0].id`，而那是**共享的种子库 b1** ——
   * 于是这个套件把 b1 的 `publicAccess` 打开就再没关过，
   * 后面每一个套件都在「一个被人动过的库」上跑。
   * 表现是别的套件莫名其妙红一条，而错误信息指的地方跟这里毫无关系
   * （实测 `test-doclinks` 的「前提：他读不了引用方的 A」拿到 200）。
   *
   * **一个套件对共享状态的副作用，比它自己的断言失败更难查。**
   * 单独跑 `node test-doclinks.mjs` 是 42/0 —— 顺序依赖的典型样子。
   */
  const bookId = await p.evaluate((sfx) => window.__yqStore.getState().createBook('s1', 'body 新鲜度探针库 ' + sfx), String(Date.now().toString(36)))
  await p.waitForTimeout(2200)
  const docId = await p.evaluate((b) => window.__yqStore.getState().createDoc(b, null, 'body 新鲜度探针'), bookId)
  await p.waitForTimeout(2200)
  // **先把这篇文档打开**再点块 —— createDoc 只往 store 里放数据，
  // 页面还停在工作台上，`.yq-block` 压根不存在（头一版就栽在这儿）
  await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(1800)

  console.log('\n== 先看清楚这篇文档长什么样（**在敲任何字之前**）==')
  {
    const shape = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.map((b) => b.type), docId)
    ok(shape.length === 1 && shape[0] === 'h1',
      '**新建的文档只有一个 h1 块，没有任何正文段落** —— 所以必须先敲回车才有「正文」可写',
      JSON.stringify(shape))
    const baseline = await p.evaluate(([d, m]) => String(window.__yqStore.getState().docs[d].body || ''), [docId, MARK])
    // 判据是「body 里**还没有**那句话」，不是「body 是空串」——
    // `createDoc` 改成从 blocks 算 body 之后，新文档的 body 是 `'# '`
    // （空 h1 的 markdown），不是 `''`。那是个**更正确**的行为，
    // 而基线要确立的是「还没有正文」，不是「一个字符都没有」。
    ok(!baseline.includes(MARK), '（基准）此刻 body 里还没有那句话 —— 下面那条才是真的多出来了', `长度 ${baseline.length}`)
  }

  /*
   * 敲标题 → 回车 → 敲正文。
   *
   * 头一版直接 `p.click('.yq-block-text')`，结果点到了标题块，
   * 那句话进了标题 —— 而「文字在标题里、body 为空」是**正常**的。
   * 更绕的是：只给 `createDoc` 传了 title 却留着**空 h1**，
   * 于是编辑器按「标题就是第一个 H1 块」把它「纠正」回空，
   * 标题一路显示「未命名」，一度看着像「createDoc 不给标题」。
   * **那是我造了个自相矛盾的状态**，不是产品把它改坏了。
   */
  await p.locator('.yq-block').first().locator('.yq-block-text').first().click()
  await p.keyboard.type(TITLE_MARK)
  await p.waitForTimeout(1500)
  const t1 = await p.evaluate((d) => window.__yqStore.getState().docs[d]?.title ?? '(没有这篇)', docId)
  ok(t1.includes(TITLE_MARK.replace(/-/g, '')) || t1 === TITLE_MARK,
    '**标题敲进 h1 之后，doc.title 跟着它变**（标题就是第一个 H1 块）', String(t1))

  console.log('\n== 回滚到一个「老版本」：body 必须由 blocks 重算 ==')
  {
    /*
     * 同一根因在**第三个写入点**上又漏了一次。
     *
     * `restoreDocVersion` 原来写的是 `{ title: v0.title, body: v0.body }` ——
     * 而那两个字段是**存版本那一刻的派生结果**，不是权威数据。
     *
     * 实测（把某一版的 body 清空，模拟「在 body 开始被维护之前存的历史版本」）：
     *     回滚后 blocks 正确（内容都在）
     *     但 body 变成空串，**服务端也跟着空了**
     *     → 又回到「导出零字节、分享页空白页」
     *
     * 而且这不是假设：这个版本库跑了很久，**每一个在 body 被维护之前
     * 存下的版本，它的 body 都是空的或陈旧的**。
     *
     * 只有「快照里压根没有 blocks」那种老版本才该用 `v0.body` ——
     * 那时它是**唯一**来源，不是「一个陈旧的派生值」。
     */
    /*
     * **整段用独立文档。** 回滚会把 blocks[0] 的 h1 一起恢复 ——
     * 也就是**会改这篇文档的标题**。拿主探针文档来做，
     * 后面「按标题找发现页卡片」那条就落空了，
     * 而红的是另一条、看起来毫不相干（实测过一次）。
     * 测试之间互相污染比断言写错更难认。
     */
    const rbDoc = await p.evaluate((b) => {
      const s = window.__yqStore.getState()
      return s.createDoc(b, null, '回滚探针文档', 'doc', [
        { id: 'bk_rb_h', type: 'h1', text: '回滚探针' },
        { id: 'bk_rb_p', type: 'p', text: '这一段是有内容的' },
      ])
    }, bookId)
    await p.waitForTimeout(1200)

    const vid = await p.evaluate((d) => window.__yqStore.getState().addDocVersion(d, '老版本'), rbDoc)
    ok(!!vid, '存一版快照', String(vid))

    // 把这一版的 body 清空、title 改错 —— 模拟历史上那些「派生值压根没被维护」的版本
    await p.evaluate(([d, v]) => {
      const s = window.__yqStore.getState()
      const vs = (s.docs[d].versions || []).map((x) => (x.id === v ? { ...x, body: '', title: '快照里那个过时的标题' } : x))
      s.updateDoc(d, { versions: vs })
    }, [rbDoc, vid])

    // 改点正文，制造「当前内容 ≠ 那版内容」
    await p.evaluate((d) => {
      const s = window.__yqStore.getState()
      s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_rb_p2', type: 'p', text: '后来又加了一段' }])
    }, rbDoc)
    await p.waitForTimeout(1200)

    const restored = await p.evaluate(([d, v]) => {
      const okv = window.__yqStore.getState().restoreDocVersion(d, v)
      const doc = window.__yqStore.getState().docs[d]
      return { okv, body: String(doc.body || ''), title: doc.title, blocks: (doc.blocks || []).length }
    }, [rbDoc, vid])

    ok(restored.okv, '回滚成功', String(restored.okv))
    ok(restored.blocks >= 2, '（基准）blocks 恢复了（原来就对）', String(restored.blocks))
    ok(/这一段是有内容的/.test(restored.body),
      '**body 由 blocks 重算，不吃快照里那个空 body**', JSON.stringify(restored.body.slice(0, 60)))
    ok(!/后来又加了一段/.test(restored.body), '（顺带）回滚后的 body 就是那一版的内容，不含后来加的', JSON.stringify(restored.body.slice(0, 60)))
    // title 和 body 是**同一类东西**（都是从 blocks 派生），所以判据也该对称。
    // 破坏对照里「回滚时又用快照里的 title」拆掉之后不红，就是因为缺这一条。
    ok(restored.title === '回滚探针',
      '**title 同样由 blocks 重算**，不吃快照里那个过时标题', `拿到「${restored.title}」`)

    // 老版本（只有 body 没有 blocks）那条路还得能用。
    // **必须用另一篇文档** —— 回滚会把标题换成「老标题」，
    // 拿主探针文档来做，后面按标题找卡片的断言就落空了
    //（测试之间互相污染，比断言写错更难认）。
    const legacy = await p.evaluate((b) => {
      const s = window.__yqStore.getState()
      const d = s.createDoc(b, null, '老版本兼容探针', 'doc', [{ id: 'bk_lg_h', type: 'h1', text: '' }])
      const s2 = window.__yqStore.getState()
      s2.updateDoc(d, { versions: [{ id: 'v_legacy_rb', title: '老版', body: '# 老标题\n\n老正文', createdAt: Date.now(), at: Date.now(), editorName: 'x' }] })
      const okv = window.__yqStore.getState().restoreDocVersion(d, 'v_legacy_rb')
      const now = window.__yqStore.getState().docs[d]
      return { okv, body: String(now.body || ''), title: now.title }
    }, bookId)
    ok(legacy.okv && /老正文/.test(legacy.body),
      '**只有 body 没有 blocks 的老版本仍然能用**（那时 body 是唯一来源，不是陈旧的派生值）',
      JSON.stringify(legacy.body.slice(0, 50)))
  }

  console.log('\n== 字数只有一种口径 ==')
  {
    /*
     * `wordCount` 一共**四个**写入点，前三个（createDoc / setDocBlocks /
     * setDocBlocksRemote / restoreDocVersion）都调 `recomputeWordCount`。
     * 第四个是「用模板建文档」，它写的是 `wordCount: t.body.length` ——
     * 那是**含 markdown 符号的原文长度**（`# ` 两个、`- ` 两个、`- [ ] ` 六个…），
     * 而 `recomputeWordCount` 算的是**块的文字长度**，不含符号。
     *
     * 于是同一篇文档，用模板建出来的字数**明显偏大**，手动敲的才是准的 ——
     * 而两处都叫「字数」。模板 body 里 `##`、`- [ ]` 越多，偏得越多。
     */
    const tpl = await p.evaluate((b) => {
      const s = window.__yqStore.getState()
      const t = (s.templates || [])[0]
      if (!t) return null
      const id = s.applyTemplate(b, null, t.id)
      const doc = window.__yqStore.getState().docs[id]
      if (!doc) return null
      /* 口径与 `src/lib/word-count.ts` 一致（2026-10-06 改）：
       * 原来这里是 `x.text.length`，把**空白也算成字**；而服务端数的是 markdown，
       * 又把 `# - [ ]` 这些标记符号算成字 —— 两边一篇 11 块的文档差 9 字。
       * 现在口径收在一处：块 text 去空白后按字符数。
       * 这里的算式必须跟着改，否则它测的是**已经不存在的那个口径**；
       * 一致性由 test-wordcount 守住（它同时钉住前后端源码里不许再各写一遍）。 */
      const byBlocks = (doc.blocks || []).reduce(
        (n, x) => n + String(x.text || '').replace(/\s+/g, '').length, 0)
      return { id, bodyLen: String(doc.body || '').length, wordCount: doc.wordCount, byBlocks }
    }, bookId)
    ok(!!tpl, '用模板建一篇文档', JSON.stringify(tpl || {}).slice(0, 80))
    if (tpl) {
      ok(tpl.wordCount === tpl.byBlocks,
        '**模板建文档的字数 = 块的文字长度**（不是 markdown 原文长度）',
        `wordCount=${tpl.wordCount} 块文字=${tpl.byBlocks} 原文=${tpl.bodyLen}`)
      ok(tpl.wordCount < tpl.bodyLen,
        '（顺带）确实比原文短 —— 说明 markdown 符号以前被算进了字数',
        `wordCount=${tpl.wordCount} 原文=${tpl.bodyLen}`)
    }
  }

  console.log('\n== `createDoc` 带 initBlocks 时，body 也得有内容 ==')
  {
    /*
     * 同一个根因在**第二个写入点**上又漏了一次。
     *
     * 「小记 → 转为文档」（`Notes.tsx`）把**整条小记**作为 `initBlocks` 传进来
     * ——那里甚至有一段注释专门写「以前只拿前 18 个字当标题，正文一个字没留」。
     * 而 `createDoc` 里 `body: ''` 是**硬编码**的，于是转出来的那篇文档
     * 导出是零字节、分享页是空白页、摘要也是空的。
     *
     * 而它**不经过 `setDocBlocks`** —— 7.17 那个「在写入点算 body」的修复
     * 对这条路径**一点用没有**。教训：同一类根因有两个写入点时，
     * 只修顺手碰到的那一个，等于没修。
     */
    const fromNote = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const id = st.createDoc(b, null, '来自小记的标题', 'doc', [
        { id: 'bk_n_h1', type: 'h1', text: '' },
        { id: 'bk_n_p', type: 'p', text: '这是小记里的正文，转成文档之后应该还在。' },
      ])
      return window.__yqStore.getState().docs[id]
    }, bookId)
    ok(/这是小记里的正文/.test(fromNote?.body || ''),
      '**用 initBlocks 建出来的文档，body 里就有正文**（以前这里是空串 → 导出零字节）',
      JSON.stringify(String(fromNote?.body || '').slice(0, 60)))
    ok(/这是小记里的正文/.test(JSON.stringify(fromNote?.blocks || [])), '（基准）blocks 里确实有那段正文')
  }

  console.log('\n== 标题的派生只在 store 里，不在 UI 层 ==')
  {
    /*
     * `title` 和 `body` 是同一类东西：**从 blocks 派生出来的值**。
     * `body` 原来有 0 个写入点（7.17），`title` 原来有**三个**：
     *   · `DocPage.handleBlockChange`（本地编辑）
     *   · `restoreDocVersion`（回滚）
     *   · 协作层「记得把 title 传进来」（一个隐式契约）
     *
     * 三份实现意味着总有一条路径会漏，而漏掉的表现是
     * 「目录树里一个标题、正文第一行另一个标题」—— 而且不报错。
     * 回滚和导入那两条路**根本走不到 UI 那个 handler**。
     */
    const bare = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*/g, '')
    const store = bare('src/store/index.ts')
    ok(/applyDerivedTitle/.test(store), 'store 里有统一的 title 派生（applyDerivedTitle）')
    const n = (store.match(/applyDerivedTitle\(next,\s*d\)/g) || []).length
    ok(n >= 2, `两条写 blocks 的路径都调用它，而且**都传了上一版**（实际 ${n} 处）`,
      '漏一条就会「某些路径下标题和正文第一行对不上」；不传 prev 就分不清两种「空」')

    const doc = bare('src/pages/DocPage.tsx')
    // UI 层那一份已经删掉：它是最容易漏的一份 ——
    // 任何**绕过编辑器**直接改 blocks 的路径（协作合并、导入、模板）都不会经过它
    const hbc = doc.slice(doc.indexOf('const handleBlockChange'), doc.indexOf('const handleBlockChange') + 400)
    ok(!/updateDoc\([^)]*title/.test(hbc),
      'UI 层不再单独派生 title（留着它就是「同一份数据两处实现」）', hbc.slice(0, 100).replace(/\s+/g, ' '))
  }

  console.log('\n== 「h1 是空的」有两种，只有一种该抹掉标题 ==')
  {
    /*
     * 第一版 `applyDerivedTitle` 一看到空 h1 就把 title 覆盖成「未命名」，
     * 结果**新建一篇文档、往里加一个段落，标题就没了** ——
     * `test-no-spurious-push` 立刻抓到（它 createDoc 传了标题，
     * 紧接着 setDocBlocks 加一段正文）。
     *
     * 两种空必须分开：
     *   · **本来就没写**（新建文档的空 h1 占位）→ 保留 createDoc 传进来的标题
     *     这是产品自己造出来的状态：Markdown 导入、小记转文档、各个「新建」按钮
     *     都用 `createDoc(…, title)` 配一个空 h1
     *   · **写了又被删空** → 才回到「未命名」
     */
    const titled = await p.evaluate(([d, t]) => {
      const st = window.__yqStore.getState()
      st.createDoc(st.books[0].id, null, t)
      return window.__yqStore.getState()
    }, [docId, '导入进来的标题 ' + Math.random().toString(36).slice(2, 6)])

    // 新建一篇（title 有值、blocks[0] 是空 h1），然后加一个段落
    const probeId = await p.evaluate((t) => {
      const st = window.__yqStore.getState()
      const id = st.createDoc(st.books[0].id, null, t)
      const s = window.__yqStore.getState()
      s.setDocBlocks(id, [...s.docs[id].blocks, { id: 'bk_probe_p', type: 'p', text: '只是加了一段正文' }])
      return id
    }, '导入进来的标题 ' + Math.random().toString(36).slice(2, 6))
    await p.waitForTimeout(1500)

    const after = await p.evaluate((d) => {
      const doc = window.__yqStore.getState().docs[d]
      return { title: doc?.title, firstType: doc?.blocks?.[0]?.type, firstText: doc?.blocks?.[0]?.text }
    }, probeId)
    void titled
    ok(after.firstType === 'h1' && after.firstText === '', '（基准）这篇的首块是**空的** h1（新建文档的占位）', JSON.stringify(after))
    ok(/导入进来的标题/.test(after.title || ''),
      '**加了一段正文之后，标题没有被抹掉**（`createDoc` 传进来的那个要留着）', String(after.title))

    // 反过来：**先让 h1 有内容，再删空** → 这时才该回到「未命名」。
    //
    // 头一版直接把这个「本来就空」的 h1「删空」，判据当然不成立 ——
    // 它从来没有内容，属于「本来就没写」，保留 title 才是对的。
    // 场景得先建立起来再破坏它。
    await p.evaluate((d) => {
      const s = window.__yqStore.getState()
      const doc = s.docs[d]
      s.setDocBlocks(d, [{ ...doc.blocks[0], text: '我写过的标题' }, ...doc.blocks.slice(1)])
    }, probeId)
    const filled = await p.evaluate((d) => window.__yqStore.getState().docs[d]?.title, probeId)
    ok(filled === '我写过的标题', '（基准）h1 有内容时，标题就是它', String(filled))

    const cleared = await p.evaluate((d) => {
      const s = window.__yqStore.getState()
      const doc = s.docs[d]
      s.setDocBlocks(d, [{ ...doc.blocks[0], text: '' }, ...doc.blocks.slice(1)])
      return window.__yqStore.getState().docs[d].title
    }, probeId)
    ok(cleared === '未命名', '**把写好的标题删空之后**，标题确实回到「未命名」', String(cleared))
  }

  // 从标题回车 → 生成一个正文段落
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(1200)

  /*
   * **先把分享开关都打开，再敲字。**
   * 顺序反了的话，中间那步 upsert 会顺手把 body 覆盖掉 ——
   * 头一版就这么把自己造出来的「发现页摘要空」当成了产品问题。
   * 现在这个顺序还顺带验了一件事：客户端有没有把新的 body **推给服务端**
   * （分享页是从服务端读的，不是从本地 store）。
   */
  await p.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { upsert: { bookSettings: [{ bookId, publicAccess: true, exportAllowed: true, updatedAt: Date.now() }] } },
  })
  /*
   * visibility 要**走客户端的 updateDoc**（分享弹窗也是这么设的）。
   * 头一版用 `p.request` 直接 upsert 服务端，于是客户端的自动保存
   * 拿着本地那份 `visibility: 'space'` 又推回去，把刚设的 public 覆盖掉了 ——
   * 看起来像「分享开关不生效」，其实是探针走了另一条路。
   */
  await p.evaluate((d) => window.__yqStore.getState().updateDoc(d, { visibility: 'public' }), docId)
  await p.waitForTimeout(2500)

  // 从标题回车 → 生成一个正文段落
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(1200)
  const shape2 = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.map((b) => b.type), docId)
  const paraIdx = shape2.findIndex((t) => t === 'p')
  ok(paraIdx >= 0, '回车之后有了正文段落', JSON.stringify(shape2))

  // **在正文段落里真的敲进去**（DOM 事件，等于用户打字）
  await p.locator('.yq-block').nth(paraIdx).locator('.yq-block-text').first().click()
  await p.keyboard.type(MARK)
  // 等自动保存（400ms 防抖）+ 推送到服务端都走完
  await p.waitForTimeout(6000)

  const st = await p.evaluate(([d, m]) => {
    const doc = window.__yqStore.getState().docs[d]
    return {
      inBlocks: doc.blocks.some((b) => (b.text || '').includes(m)),
      inBody: String(doc.body || '').includes(m),
      bodyLen: String(doc.body || '').length,
    }
  }, [docId, MARK])
  ok(st.inBlocks, '（基准）这句话在 blocks 里', JSON.stringify(st))
  ok(st.inBody, '**而且也在 body 里** —— 以前这里是 false', `body 长度 ${st.bodyLen}`)

  console.log('\n== ① 导出 Markdown：真的点菜单、真的读下载下来的文件 ==')
  {
    // 「导出 Markdown」在 `···` 菜单里，得先点开菜单
    await p.locator('.yq-doc-more').first().click()
    await p.waitForTimeout(800)
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 20000 }),
      p.locator('.yq-menu-item', { hasText: '导出 Markdown' }).first().click(),
    ])
    const path = join(mkdtempSync(join(tmpdir(), 'yqbody-')), 'out.md')
    await dl.saveAs(path)
    const text = readFileSync(path, 'utf8')
    ok(text.length > 0, '导出的文件**不是零字节**', `长度 ${text.length}`)
    ok(text.includes(MARK), '**导出内容里有刚敲的那句**', JSON.stringify(text.slice(0, 80)))
  }

  console.log('\n== ② 对外分享页：匿名访客（顺带验同步把 body 推上去了）==')
  {
    const srv = await (await p.request.get(`${BASE}/api/public/doc/${docId}`)).json().catch(() => ({}))
    ok(String(srv.body || '').includes(MARK),
      '**服务端那条的 body 也更新了** —— 不只是本地，别的设备/访客看到的也是新的',
      JSON.stringify(String(srv.body || '').slice(0, 70)))

    const anon = await (await browser.newContext()).newPage()
    await anon.goto(`${BASE}/#/public/doc/${docId}`, { waitUntil: 'domcontentloaded' })
    await anon.waitForTimeout(3500)
    const t = await anon.evaluate(() => (document.querySelector('.yq-md')?.innerText || document.body.innerText).slice(0, 300))
    ok(t.includes(MARK), '**访客看到刚敲的那句**（以前只有一个标题）', JSON.stringify(t.slice(0, 80)))
  }

  console.log('\n== ③ 发现页卡片摘要 ==')
  {
    // 路由是 **`/find`** 不是 `/discover` —— 头一版写错了，
    // 于是组件压根没渲染，「没有摘要元素」看着像产品问题，其实是探针没打开页面
    await p.goto(`${BASE}/#/find`, { waitUntil: 'domcontentloaded' })
    await p.waitForTimeout(4000)
    const info = await p.evaluate((d) => {
      const cards = [...document.querySelectorAll('.yq-discover-card')]
      const doc = window.__yqStore.getState().docs[d]
      return {
        titles: cards.map((c) => c.querySelector('.yq-discover-card-title')?.textContent || '(无标题)'),
        descs: cards.map((c) => c.querySelector('.yq-discover-card-desc')?.textContent ?? null),
        mine: { found: !!doc, title: doc?.title, blocks: (doc?.blocks || []).map((b) => `${b.type}:${(b.text || '').slice(0, 18)}`) },
      }
    // ↑ 这里漏了第二个参数 `docId`，于是 `d` 是 undefined、查到的 doc 也是 undefined，
    //   诊断行打出来是 `{"blocks":[]}` —— 看着像「store 里没有这篇文档」，
    //   其实是**根本没传参数**。
    }, docId)
    console.log('   （诊断）我这篇在 store 里:', JSON.stringify(info.mine))
    const at = info.titles.findIndex((t) => t.includes('新鲜度探针标题') || t.includes(MARK))
    ok(at >= 0, '找得到这篇文档的卡片（页面确实渲染了）',
      `实际有 ${info.titles.length} 张：${JSON.stringify(info.titles.slice(0, 8))}`)
    const desc = at >= 0 ? info.descs[at] : null
    // 摘要会过滤掉 # - * > ` | 这些 markdown 符号，所以按去掉连字符的片段比
    ok(String(desc).includes(MARK.replace(/-/g, '')), '**摘要里有内容**（以前是空的）', String(desc).slice(0, 80))
  }

  console.log('\n== ④ 点正文空白处：应该进**正文**，不是跳回标题 ==')
  /*
   * ⚠️ 2026-10-10 用户在页面上实测报上来的一条：「新建文档后输入 SSSSSS，
   *    上面的标题也修改了」。
   *
   * 机制不是玄学，是三条规则叠在一起：
   *   · 新建一篇文档**只有一个**块 —— 空的 h1，而它就是文档标题
   *     （store 的 `applyDerivedTitle`：标题 = 第一个 h1）；
   *   · 编辑器末尾有个「继续输入区」，规则是「末尾是空块就把光标送过去」；
   *   · 那一大片还顶着 **「输入 '/' 插入卡片」** 的占位符，看着就是正文编辑区。
   * 三条一叠加，就成了「点正文空白 → 光标跳回标题 → 敲什么什么变标题」。
   *
   * 语雀那边标题下面**本来就有正文行**，点空白处进的是正文。
   *
   * ⚠️ 用**独立文档**：这条会往正文里加段落，
   *   拿主探针文档做会污染后面「按标题找发现页卡片」那条（这个文件已经吃过一次亏，
   *   见上面回滚那一段 —— 测试之间互相污染比断言写错更难认）。
   */
  {
    const tDoc = await p.evaluate((b) => window.__yqStore.getState().createDoc(b, null, '正文落点探针'), bookId)
    await p.waitForTimeout(1200)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${tDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 25000 })
    await p.waitForTimeout(1200)

    const ph = await p.$eval('.yq-editor .yq-block-text', (e) => e.getAttribute('data-placeholder'))
    ok(ph === '未命名',
      '**标题块的占位符是「未命名」**，不是「输入 / 插入卡片」—— 后者会让人以为那是正文',
      JSON.stringify(ph))

    const before = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, tDoc)
    await p.click('.yq-editor-tail', { timeout: 8000 })
    await p.waitForTimeout(800)
    const after = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.map((b) => b.type), tDoc)
    ok(after.length === before + 1,
      '点正文空白处会**补出一个正文段落**（而不是把光标塞回标题块）',
      JSON.stringify(after))

    const MARK2 = '正文落点标记'
    await p.keyboard.type(MARK2)
    await p.waitForTimeout(1000)
    const st = await p.evaluate((d) => {
      const doc = window.__yqStore.getState().docs[d]
      return { title: doc.title, types: doc.blocks.map((b) => b.type), texts: doc.blocks.map((b) => b.text) }
    }, tDoc)
    ok(st.types[1] !== 'h1' && st.texts[1] === MARK2,
      '敲进去的字落在**正文块**里，不在标题块里', JSON.stringify(st.types) + ' / ' + JSON.stringify(st.texts))
    /*
     * ⚠️ 这一条是**前一条的前提**，不能省。
     *
     * 头一版只写「标题没被正文内容改掉」，破坏对照时它是**绿的** ——
     * 因为那时候点末尾空白处**压根放不下光标**（老代码把焦点给了块的包装 div，
     * 而不是里面那个 contentEditable 的 .yq-block-text），字一个都没打进去。
     * 没打进去，自然改不了标题。**断言在，但没有测到它声称测的东西。**
     */
    ok(st.texts.some((t) => String(t).includes(MARK2)),
      '（前提）那串字**确实写进文档了** —— 否则下面那条是假绿',
      JSON.stringify(st.texts))
    ok(!String(st.title).includes(MARK2),
      '**标题没有被正文内容改掉**（用户报的就是这一条）', JSON.stringify(st.title))
  }

  console.log('\n== ⑤ 末尾本来就有空段落时，点空白处也得能真的把光标放进去 ==')
  /*
   * 上一段修的是「只有一个空标题块」那条路；这条验的是**另一条**：
   * 末尾已经有一个空段落时，点空白处要把光标送进那个段落。
   *
   * 同样来自破坏对照 —— 老代码对块的**包装 div** 调 focus，
   * 那不是 contentEditable，光标压根落不下去，敲什么都没反应。
   * 这条路径在「新建文档」上碰不到（那里走的是补段落的分支），
   * 所以必须**另造一篇**有正文末段落的文档来测，否则修没修都测不出来。
   */
  {
    const fDoc = await p.evaluate((b) => window.__yqStore.getState().createDoc(b, null, '末尾聚焦探针', 'doc', [
      { id: 'bk_f_h', type: 'h1', text: '末尾聚焦探针' },
      { id: 'bk_f_p', type: 'p', text: '' },
    ]), bookId)
    await p.waitForTimeout(1200)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${fDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 25000 })
    await p.waitForTimeout(1200)

    const MARK3 = '末尾聚焦标记'
    await p.click('.yq-editor-tail', { timeout: 8000 })
    await p.waitForTimeout(600)
    await p.keyboard.type(MARK3)
    await p.waitForTimeout(1000)
    const texts = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.map((b) => b.text), fDoc)
    ok(texts.some((t) => String(t).includes(MARK3)),
      '点末尾空白处**光标真的落进了末尾那个空段落**（对包装 div focus 是空操作，敲了没反应）',
      JSON.stringify(texts))
  }

  console.log('\n== 接线：body 必须在写入点就算出来 ==')
  {
    const bare = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*/g, '')
    const store = bare('src/store/index.ts')
    // 三条写 blocks 的路径（本地编辑 / 跨标签页合并 / 远端 apply）都要跟上
    const n = (store.match(/body:\s*blocksToMarkdown\(/g) || []).length
    ok(n >= 2, `store 里至少两处写 body（本地 + 跨标签页），实际 ${n} 处`,
      '漏了任何一条都会让「某些路径下 body 又是旧的」')

    const md = bare('src/lib/blocks-markdown.ts')
    ok(/export function blocksToMarkdown/.test(md), 'blocksToMarkdown 搬到了 lib（它现在是 store 的依赖，不是种子的私事）')

    // 空 src 的图片不产出 `![]()` —— 少一张坏图好过一张坏图
    ok(/case 'image':\s*if \(b\.src\)/.test(md.replace(/\s+/g, ' ')),
      '空 src 的图片不输出 `![]()`（那会在分享页和导出的 markdown 里各留一张坏图）')

    /*
     * ⚠️ 上面那条只认**源码形状** —— 形状一改它就红，而**行为**没变。
     * ⇒ 这里补一条**行为断言**：图片右边那段话要跟着图片一起导出（同一行），
     *   空 src 时那段话也不能丢。
     */
    const mdImg = blocksToMarkdown([
      { id: 'b1', type: 'image', text: '紧跟在图片右边的话', src: 'https://x/a.png' },
    ])
    ok(mdImg.includes('![](https://x/a.png)紧跟在图片右边的话'),
      '★ 图片右边那段话**跟着图片一起导出**（同一行）', JSON.stringify(mdImg))
    const mdNoSrc = blocksToMarkdown([
      { id: 'b2', type: 'image', text: '没有 src 也要留住', src: '' },
    ])
    ok(!mdNoSrc.includes('![]()') && mdNoSrc.includes('没有 src 也要留住'),
      '★ 空 src 时不产出坏图，但**那段话不能丢**', JSON.stringify(mdNoSrc))
  }
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
