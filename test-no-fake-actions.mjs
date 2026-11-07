/* ============================================================
   「承诺了但没做」的按钮与提示
   ------------------------------------------------------------
   扫了一遍代码里所有点了只弹 toast 的控件，找到五个。其中一个特别危险：

     设置 → 安全 → 修改密码 → 「确认」
        → toast('密码已修改（演示）', 'success')

   它告诉管理员「改成功了」，实际什么都没发生。
   后果不是「发现没生效」那么轻：管理员可能据此告诉 IT
   「密码已经换过了」，而旧密码其实还在用；也可能因为以为改过而
   把旧密码写进任何地方。

   这一类的共同点是**看起来完全正常** —— 不报错、不置灰、点一下
   弹个绿色提示。所以只能靠扫代码发现，靠用户反馈太晚了。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
const SUF = Date.now().toString(36)
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()

/*
 * 这个套件会**建真实数据**：
 *   ① 建一条小记（`转文档验证_…`）
 *   ② 点「转为文档」把它转成一篇**文稿** —— 会进目录、进搜索、进导出
 *   ③ 后面几条还会新建文档、改文档属性
 *
 * ⚠️ 但要说清：**它默认打的是 `YQ_PORT || 8092`，而 `run-all-tests.mjs`
 *   会自己起一个服务并指定临时库（`YQ_DB`，run-all-tests.mjs:329）——
 *   所以正常跑 `npm run test:all` **碰不到部署实例**。
 *
 * 2026-10-08 的污染是**我用错了**：手动 `$env:YQ_PORT=8090` 把它指到部署实例上，
 * 连跑两轮，实例从 26 篇变成 29 篇，目录里躺着三篇「转文档验证_muys…」。
 * 教训是我自己的：**别把会写数据的套件指向有持久数据的地方**。
 *
 * 那为什么还留这个收尾清理？因为它是**廉价且唯一**的一道保险：
 * 万一有人（包括未来的我）再犯同样的用法错误，数据至少能被清掉一部分。
 * 清理内容：删掉本次建出来的文稿 + 彻底清空回收站。
 * **清不掉就报错**（见函数内注释：小记删不掉是产品的真实限制，如实说明）。
 */
let cleanup = null

const installCleanup = (page) => {
  cleanup = async () => {
    /*
     * 只删**文稿**。小记**不删**，因为产品没有 `deleteNote`：
     * 删了也只是本地 state 改一下，下一次 hydrate 就回来了（删不掉的谎）。
     * 所以下面只报实情：小记留几条、为什么留。
     */
    const ids = await page.evaluate(() => {
      const st = window.__yqStore.getState()
      return Object.values(st.docs || {})
        .filter((d) => /转文档验证_/.test(d.title || '')
          || /转文档验证_/.test((d.blocks || []).map((b) => b.text).join(' ')))
        .map((d) => d.id)
    })
    if (ids.length) {
      await page.evaluate((list) => {
        const st = window.__yqStore.getState()
        for (const id of list) st.deleteDoc(id)
      }, ids)
      await page.waitForTimeout(2500)
    }
    // 回收站里的也要彻底清掉 —— 进了回收站仍然算「有一篇」
    await page.evaluate(async () => {
      const t = localStorage.getItem('yq_token')
      await fetch('/api/trash/purge-all', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' },
      })
    })
    await page.waitForTimeout(1800)
    /*
     * ⚠️ 测量前必须**重新加载**，否则读到的是过期的客户端 state。
     *   实测：purge-all 已经在服务端生效（事后单打一次返回 purged:0），
     *   但客户端 `st.trash` 还是删之前那份 —— 于是一条不存在的残留被判成 FAIL。
     *   这是本项目栽过的第 N 次「拿没刷新的界面读状态」。
     */
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-app, .yq-login-card', { timeout: 25000 })
    await page.waitForTimeout(2500)
    const left = await page.evaluate(() => {
      const st = window.__yqStore.getState()
      return {
        docs: Object.values(st.docs || {}).filter((d) => /转文档验证_/.test(d.title || '')).length,
        notes: (st.notes || []).filter((n) => /转文档验证_/.test(n.text || '')).length,
        trash: (st.trash || []).length,
      }
    })
    /*
     * ⚠️ 小记**删不掉**，这不是测试的锅：`store` 里根本没有 `deleteNote`，
     *   UI 也没有删除入口（全项目搜 `notes.filter` 只有搜索与渲染）。
     *   官方语雀的小记同样不支持删除，所以这不是复刻缺口。
     *
     * 但它让「跑一次全量就往部署数据里永久留一条小记」成了事实。
     * 两条选择：
     *   ① 在部署实例上跑这个套件 → 接受每次留一条小记（并如实提示）；
     *   ② **改成不发小记** —— 但那条断言验的正是「点按钮」这条接线，
     *      直接调 store 就把「页面接线」这一环验丢了。
     * 这里选 ①：**清不掉就明说，不假装清干净**。
     * 静默成功正是「跑完一地垃圾却没人知道」的根因。
     */
    if (left.notes > 0) {
      console.log(`  NOTE  小记清不掉 ${left.notes} 条（store 无 deleteNote，官方语雀同样不支持删小记）；`
        + `部署实例每跑一次本套件会多留一条「转文档验证_…」`)
    }
    if (left.docs > 0 || left.trash > 0) {
      throw new Error(`清理后仍有 ${left.docs} 篇文稿 / ${left.trash} 条回收站残留 —— 测试数据留在了部署实例里`)
    }
    return ids.length
  }
}

try {
  const p = await (await browser.newContext()).newPage()
  installCleanup(p)
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1500)
  const token = await p.evaluate(() => localStorage.getItem('yq_token'))
  let H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }

  /* ---------- 改密码 ---------- */
  console.log('\n== 修改密码必须真的改 ==')
  // 先在**第二个设备**上登录，制造一个「其他会话」
  const other = await (await browser.newContext()).newPage()
  await other.goto(BASE, { waitUntil: 'domcontentloaded' })
  await other.waitForSelector('.yq-login-card', { timeout: 25000 })
  await other.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await other.fill('.yq-login-card input[type="password"]', PW)
  await other.click('.yq-login-submit')
  await other.waitForSelector('.yq-app', { timeout: 30000 })
  await other.waitForTimeout(1200)
  const otherToken = await other.evaluate(() => localStorage.getItem('yq_token'))

  const newPwd = `Yq${SUF}9x`
  // 参数别叫 p：外面已经有一个叫 p 的 page 了，遮蔽之后
  // p.request 就是 undefined，报错还指向一个看起来无关的地方
  const api = async (path, body) => {
    const r = await p.request.post(`${BASE}${path}`, { headers: H, data: body })
    return { status: r.status(), data: await r.json().catch(() => null) }
  }

  const wrongOld = await api('/api/auth/password', { oldPassword: 'definitely-not-it', newPassword: newPwd })
  ok(wrongOld.status === 400, '旧密码不对时拒绝（否则任何人都能改别人的密码），且**不是 401**（401 会把人踢回登录页）', String(wrongOld.status))

  /*
   * ⚠️ 原来这条断言写的是 **401**（2026-10-16 改掉）。
   *
   * `src/lib/api.ts` 的契约是「401 = 会话失效」→ 清 token + 跳登录页。
   * 所以返 401 的实际后果是：**用户只是把旧密码输错一次就被踢回登录页**，
   * 未保存的内容全丢 —— 而他做的唯一错事是敲错一位密码。
   *
   * 拒绝「能不能改别人密码」靠的是那句 verify，不是状态码，
   * 所以改成 400 一点保护都没少，还顺手修掉了「输错密码丢工作」。
   */
  {
    const { readFileSync: rf } = await import('node:fs')
    const srv = rf('server/index.ts', 'utf8')
    /*
     * ⚠️ 这条源码守卫**只盯两个带会话的接口**，不是全文件扫。
     * 第一版写的是「全文件里凡是出现『口令|密码』且 160 字内有 status = 401 就报」，
     * 结果误伤了两处**本来就该是 401** 的：
     *   · `POST /api/auth/login` 的「账号或密码不正确」—— 登录请求本身没有会话，
     *     401 是它的标准语义；而且那个调用走的是登录页自己的逻辑，不经过 api 层。
     *   · 公开分享页的「访问密码不对」—— `PublicDoc.tsx` 用的是**裸 fetch**，
     *     不走 `src/lib/api.ts`，所以输错访问密码**不会**把登录用户踢下线。
     * 扫全文件的写法看起来更严格，实际是给自己制造假红 —— 而假红多了，
     * 真红也就没人信了。
     */
    const ROUTES = ["on('POST', '/api/auth/password'", "on('DELETE', '/api/spaces/:id'"]
    const bad = []
    for (const marker of ROUTES) {
      const i = srv.indexOf(marker)
      if (i < 0) { bad.push(`${marker} → 路由不见了`); continue }
      const seg = srv.slice(i, i + 2600)
      if (seg.includes('status = 401')) bad.push(`${marker} 之后仍有 status = 401`)
    }
    ok(bad.length === 0, `带会话的接口不用 401 表达「口令不对」（401 的语义被会话独占）：${bad.join(' | ') || '无'}`)
  }

  const weak = await api('/api/auth/password', { oldPassword: PW, newPassword: '123' })
  ok(weak.status === 400, '弱密码被挡下', String(weak.status))
  const noDigit = await api('/api/auth/password', { oldPassword: PW, newPassword: 'abcdefghij' })
  ok(noDigit.status === 400, '纯字母口令被挡下（要求字母 + 数字）', String(noDigit.status))
  const same = await api('/api/auth/password', { oldPassword: PW, newPassword: PW })
  ok(same.status === 400, '新密码与旧密码相同被挡下', String(same.status))

  const good = await api('/api/auth/password', { oldPassword: PW, newPassword: newPwd })
  ok(good.status === 200 && good.data?.ok === true, '正确的旧密码 + 达标的新密码 → 改成功', JSON.stringify(good.data))
  ok((good.data?.otherSessionsClosed || 0) >= 1, `并清掉了其他会话（${good.data?.otherSessionsClosed} 个）—— 改密码的意义就是把泄露的访问挡在门外`, String(good.data?.otherSessionsClosed))

  console.log('\n== 改完之后…')
  const oldStill = await api('/api/auth/login', { account: 'admin', password: PW })
  ok(oldStill.status === 401, '旧密码不能再登录了', String(oldStill.status))
  const newWorks = await api('/api/auth/login', { account: 'admin', password: newPwd })
  ok(newWorks.status === 200, '新密码能登录', String(newWorks.status))
  const otherKicked = await other.request.get(`${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer ' + otherToken } })
  ok(otherKicked.status() === 401, '另一台设备的令牌失效了', String(otherKicked.status()))
  const selfAlive = await p.request.get(`${BASE}/api/auth/me`, { headers: H })
  ok(selfAlive.status() === 200, '发起修改的这台不会被踢出去（否则用户当场被登出）', String(selfAlive.status()))

  /*
   * 改回原口令，免得影响后面的套件（这个服务是临时的，但保持干净）。
   *
   * ⚠️⚠️ 这里有个**真实的连带伤害**，2026-10-08 查了半天：
   *   「改密码」的语义是**清掉发起者之外的所有会话**（server/index.ts:1792）
   *   —— 这是对的，它正是「改密码 = 把泄露的访问挡在门外」的意义。
   *   但套件共用 admin！所以「改回去」这一次会把**后面所有套件刚建的
   *   会话全部作废**，它们随后一律 401。
   *   症状：紧接着跑的套件报「d1 → HTTP 401」，看起来像文档被删了，
   *   其实是**令牌失效**。
   *
   * 所以改回之后必须**重新登录拿新 token**，把 H 换掉 ——
   * 令牌换代之后，后续套件再登录就是干净的。
   */
  await api('/api/auth/password', { oldPassword: newPwd, newPassword: PW })
  const restored = await api('/api/auth/login', { account: 'admin', password: PW })
  ok(restored.status === 200, '已把口令改回原值（顺手验证改回去也行）', String(restored.status))
  if (restored.data?.token) {
    H.Authorization = 'Bearer ' + restored.data.token
    ok(true, '改回后重新登录换了新令牌（改密码会作废其他会话，不换的话后面套件全 401）')
  } else {
    ok(false, '改回密码后拿不到新令牌 —— 后面套件会全部 401')
  }

  /* ---------- 界面上不再有假控件 ---------- */
  console.log('\n== 界面上不再出现「演示」承诺 ==')
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
  const texts = []
  for (const tab of ['个人资料', '安全', '数据管理', '消息通知', '偏好设置']) {
    await p.click(`.yq-settings-nav-item:has-text("${tab}")`)
    await p.waitForTimeout(700)
    texts.push((await p.locator('.yq-settings-body').textContent()) || '')
  }
  const all = texts.join('\n')
  ok(!/（演示）/.test(all), '设置页里没有「（演示）」这类假承诺了')

  /*
   * 头像这一段 2026-10-11 改了：原来是「禁用 + 标注尚未实现」，
   * 现在**真的能用了**（test-avatar-e2e.mjs 会真的传一张图、真的看它显示出来）。
   *
   * ⚠️ 所以断言从「它是禁用的」翻成了「它是**能点**的」。
   *    而「按钮还在」那条必须留着 —— 它防的是「有人嫌它碍事直接删掉」，
   *    而删掉一个按钮和留一个假按钮，用户感受是一样的。
   */
  const avatarBtn = p.locator('button:has-text("更换头像")')
  await p.click('.yq-settings-nav-item:has-text("个人资料")')   // 头像在这一页
  await p.waitForTimeout(800)
  ok((await avatarBtn.count()) === 1, '头像按钮还在（没被悄悄删掉）')
  ok(!(await avatarBtn.isDisabled()),
    '它现在**是可用的**，不是「禁用 + 标注尚未实现」那种占位')
  ok(!(await p.locator('.yq-settings-body').textContent()).includes('头像上传尚未实现'),
    '界面上不再有「头像上传尚未实现」那句（真做了就别留旧说明）')

  /**
   * 「承诺了但只兑现了一半」的两种典型。
   *
   * 1. 消息通知：提示语写的是「只影响你这台设备」，
   *    用户读到的是「通知只发到这台设备」—— 仍然以为通知是存在的。
   *    可 prefs.notify 全项目只有那个页面自己读（渲染开关状态），本项目没有通知服务。
   * 2. 登录密码那一行写死「上次修改于 3 个月前」——
   *    系统里根本没有这个时间，所有人看到的都是 3 个月前，**包括今天刚改完密码的人**。
   *    写死的数字比不显示更糟：它让人以为这个值是真的。
   */
  console.log('\n== 只兑现一半的承诺 ==')

  /**
   * 3.（2026-10-11 加）搜索页空态那段「能力说明」——
   *
   *    原来写的是「覆盖文档标题、正文、**评论**与小记，
   *    并支持按**空间**与作者过滤」。两个词都是假的：
   *      · 评论**根本没进搜索索引**（服务端 reindex 只有 doc/book/note 三种；
   *        前端本地那条 docSearchText 也只取 blocks/body）
   *      · 也**没有空间筛选器**（scope 的类型就是 `'all' | 'mine'`）
   *
   *    页面上写着一句自己做不到的话，比不写更糟：用户会以为
   *    「搜不到 = 这条评论不存在」，而那条评论就在那篇文档底下。
   *
   *    这条判据是**对着实现查**，不是对着文案查 —— 文案改了它就绿，
   *    实现改了它会红。
   */
  {
    /*
     * ⚠️ 这个文件里每个块**各自** import fs，块之间不共享 ——
     *   我第一版直接用了裸的 `readFileSync`，跑起来是
     *   `ReferenceError: readFileSync is not defined`，
     *   而且它把**整个后半段套件**都带下去了（331 项塌成 285）。
     *   —— 一个断言里的错误，会让后面几十条看起来像「没跑到」。
     */
    const { readFileSync: rf } = await import('node:fs')
    const searchSrc = rf('src/pages/Search.tsx', 'utf8')
    const claim = (searchSrc.match(/知语的搜索[^<]*/) || [''])[0]
    const idxSrc = rf('server/sync.ts', 'utf8')
    const localSrc = rf('src/lib/card-search.ts', 'utf8')

    // 索引里到底有没有「评论」
    const idxHasComments = /kind\s*[:=]\s*['"]comment['"]|reindex\([^)]*comment/i.test(idxSrc)
    const at = localSrc.indexOf('docSearchText')
    const localHasComments = /comments/.test(localSrc.slice(at, at + 600))
    ok(!(idxHasComments || localHasComments) ? !claim.includes('评论') : true,
      '搜索页没有承诺「能搜评论」——除非索引里真的有评论',
      claim)

    /*
     * 筛选器到底支持哪些取值 —— **从比较点反推**，不猜类型声明。
     *
     * 第一版写的是 `scope: 'all' | 'mine'` 那条正则，结果它在源码里
     * **一处都没匹配上**（scope 是默认参数 `scope = 'all'`，
     * 真正决定行为的是 `scope === 'mine'` 那些比较）。
     * 于是「除非真支持空间」那个正向分支**永远走不到** ——
     * 半条恒真的守卫：红不了，也证明不了自己会红。
     *
     * 现在改成收集所有 `scope === '…'` 的取值 + 默认值，
     * 空间那一维如果有人加了，这里就会认出来。
     */
    const useSearchSrc = rf('src/lib/useSearch.ts', 'utf8')
    const scopeVals = new Set([...useSearchSrc.matchAll(/scope\s*===\s*'([^']+)'/g)].map((m) => m[1]))
    const def = /scope\s*=\s*'([^']+)'/.exec(useSearchSrc)
    if (def) scopeVals.add(def[1])
    const hasSpaceScope = [...scopeVals].some((v) => /space/i.test(v))
    ok(scopeVals.size > 0, '（前置）确实从 useSearch 里取出了 scope 的取值集合', [...scopeVals].join(','))
    ok(hasSpaceScope ? true : !claim.includes('空间'),
      '搜索页没有承诺「能按空间过滤」——除非 scope 里真有空间这一维',
      `scope=[${[...scopeVals].join(',')}] | ${claim}`)
  }

  await p.click('.yq-settings-nav-item:has-text("消息通知")')
  await p.waitForTimeout(700)
  const notifyText = (await p.locator('.yq-settings-body').textContent()) || ''
  ok(/没有通知服务|不会真的发给你/.test(notifyText),
    '消息通知区直说「本项目没有通知服务」，而不是让人以为通知只发到本机', notifyText.replace(/\s+/g, ' ').slice(0, 110))
  ok(!/只影响你这台设备/.test(notifyText),
    '原来那句「只影响你这台设备」拿掉了 —— 它反而暗示通知是存在的')

  await p.click('.yq-settings-nav-item:has-text("安全")')
  await p.waitForTimeout(900)
  const secText = (await p.locator('.yq-settings-body').textContent()) || ''
  ok(!/3 个月前/.test(secText), '「上次修改于 3 个月前」这个写死的值没有了', secText.replace(/\s+/g, ' ').slice(0, 110))
  ok(/上次修改于|从未修改/.test(secText), '显示的是真实值（或明说「从未修改」）', secText.replace(/\s+/g, ' ').slice(0, 110))

  /**
   * 帮助中心：这一页以前**每一项承诺都是假的**。
   *
   * 「FAQ：…计费」（项目没有计费）、「导出与迁移：Markdown / Word / PDF」
   * （实际只有 md/html/txt/json）、「⌘K 全局搜索」「/ 聚焦搜索框」
   * （真实的键是 `?`，这两个不存在）、「直接联系我们」（没有任何联系方式）。
   * 而且每条帮助**可点**，实际是拿标题去目录树里找同名节点 ——
   * 真实部署里永远匹配不上，点了什么都不发生。
   */
  console.log('\n== 帮助中心不能承诺不存在的功能 ==')
  await p.goto(`${BASE}/#/help`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-help-grid', { timeout: 25000 })
  await p.waitForTimeout(600)
  const helpText = (await p.locator('.yq-dash-narrow').textContent()) || ''

  ok(!/计费/.test(helpText), '帮助里没有「计费」（本项目是内网自建，没有计费）', helpText.replace(/\s+/g, ' ').slice(0, 110))
  ok(!/Word|PDF/.test(helpText), '帮助里没有承诺 Word / PDF 导出（实际只有 md / html / txt / json）', helpText.replace(/\s+/g, ' ').slice(0, 110))

  /**
   * 下面两条要**按区域**查，不能拿全页文本去匹配。
   *
   * 踩过一次：新写的诚实说明里本身就出现了这两个词 ——
   * 「内网部署没有「联系我们」这个入口」「别的编辑器有、这里没有的（比如 ⌘K、/）不列」。
   * 断言要抓的是「把它当成真功能提供」，而不是「页面上出现过这几个字符」。
   * 全页正则会把否认本身也当成肯定。
   */
  const heroSub = (await p.locator('.yq-help-sub').textContent().catch(() => '')) || ''
  const contactCard = (await p.locator('.yq-help-contact-card').textContent().catch(() => '')) || ''
  ok(!/联系我们/.test(heroSub), '页头不再说「直接联系我们」（内网部署没有任何联系方式）', heroSub)
  ok(/没有「联系我们」这个入口|没有.{0,4}联系我们/.test(contactCard),
    '联系区直说没有这个入口，而不是给一个点不动的按钮', contactCard.replace(/\s+/g, ' ').slice(0, 110))
  const mailto = await p.locator('.yq-dash-narrow a[href^="mailto:"]').count()
  ok(mailto === 0, '没有编出来的邮件链接', String(mailto))

  // 快捷键表单独看：那一块里出现 ⌘K 才说明「把它当成真快捷键列出来了」
  const kbd = (await p.locator('.yq-help-kbd-grid').textContent().catch(() => '')) || ''
  ok(!/⌘\s*K/.test(kbd), '快捷键表里没有编出来的 ⌘K', kbd.replace(/\s+/g, ' ').slice(0, 110))
  ok(kbd.includes('?'), '真实的搜索快捷键 `?` 列出来了', kbd.replace(/\s+/g, ' ').slice(0, 110))
  ok(kbd.includes('G 然后 F'), '存在却没列过的 `G 然后 F` 补上了')
  ok(kbd.includes('⌘ S'), '存在却没列过的 `⌘ S`（手动保存）补上了')

  /* ⚠️ 2026-10-07 补：帮助页原本写「**卡片**：在文本里输入 `@` 选卡片」——
     这是**会真的把人带偏**的假说法：`@` 唤起的是提及面板（成员 / 文档），
     卡片在 `/` 里。照着帮助页做的人打 `@` 会得到一个「@谁」的搜索框。
     而且它和上一行「`/` 弹出块类型菜单」互相矛盾 —— 同一个入口被写成了两个。
     判据：帮助页提到卡片时必须说 `/`，并且必须把 `@` 说成「提及」。 */
  /* ⚠️ 判据**先剥注释**再扫。原因：我修 Help.tsx 时在注释里写了
     「这里原来写的是『在文本里输入 `@` 选卡片』」这句话本身 —— 而它
     **正好命中下面那条正则**，于是修复之后套件反而红了。
     这就是本项目反复吃的「描述缺陷的文字，本身会命中描述缺陷的检查」。
     扫描源码类判据，一律先剥注释。 */
  const stripC = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const helpRaw = await import('node:fs').then((fs) =>
    fs.readFileSync('src/pages/Help.tsx', 'utf8'))
  const helpSrc = stripC(helpRaw)
  ok(!/输入\s*`@`[^`]*选卡片/.test(helpSrc),
    '帮助页不再叫用户按 `@` 选卡片（那是提及面板）')
  ok(/`@`[^。]*提及/.test(helpSrc), '帮助页把 `@` 说成「提及」而不是卡片入口')
  ok(/`\/`[^。]*卡片/.test(helpSrc), '帮助页说清卡片是从 `/` 菜单里选的')

  /* ⚠️ 上面那三条是**按原文措辞**匹配的，破坏对照时发现：
     把「卡片：在文本里输入 `@` 选」改成「卡片：在文本里输入 `@` 选。」
     （只差两个字）三条全绿 —— **等于没有守卫**。
     所以补一条**正向不变式**：凡是同一行里同时出现 `@` 和「卡片」，
     那句话就必须在讲「@ 是提及」。措辞随便改，它都拦得住。 */
  const bothLines = helpSrc.split('\n').filter((l) => l.includes('@') && l.includes('卡片'))
  ok(bothLines.length > 0, `帮助页里有 ${bothLines.length} 行同时提到 @ 和卡片`)
  ok(bothLines.every((l) => l.includes('提及')),
    '凡是同一行提到 @ 和「卡片」，都必须是在说「@ 是提及」',
    JSON.stringify(bothLines.filter((l) => !l.includes('提及')).slice(0, 2)))

  /* ⚠️ 另一条**方向相反**的过期声明：帮助页曾说「『仅自己可见』这个选项还不能用
     …别用它来挡人」。而它 2026-10-06 就已经真判了（`off: false`，有 `test-privdoc`）。
     这条比普通过期更坏 —— 它劝用户**别**用一个真能用的安全功能。
     判据：帮助页提到「仅自己可见」时，不能说它「还没做 / 不能用 / 别用」。 */
  const privLines = helpSrc.split('\n').filter((l) => l.includes('仅自己可见'))
  ok(privLines.length > 0, `帮助页里有 ${privLines.length} 行提到「仅自己可见」`)
  const stale = privLines.filter((l) => /还没做|不能用|不可用|未实现|别用|暂不/.test(l))
  ok(stale.length === 0,
    '帮助页不再说「仅自己可见」不能用（它是真生效的安全功能，劝人别用等于教错）',
    JSON.stringify(stale.slice(0, 2)))

  /* ⚠️ 同一类问题的第三处，而且**用户真的会读到**：文本绘图卡片里那段
     「支持什么」的说明，原先写着「不支持 classDef 样式」——
     而 classDef 早就接上了（`diagram-style.ts` 被五个图种共用，flowchart 在内），
     `test-classdef` 有 69 项断言。卡片等于在告诉用户一个能用的功能不能用。
     判据：凡是提到 classDef 的说明行，都不许把它说成不支持。 */
  const pc = await import('node:fs').then((fs) => stripC(fs.readFileSync('src/components/cards/PlantumlCard.tsx', 'utf8')))
  const defLines = pc.split('\n').filter((l) => l.includes('classDef'))
  ok(defLines.length > 0, `卡片里共 ${defLines.length} 处提到 classDef`)
  /* ⚠️ 正则必须**以「；」和「。」为界**：第一版写成 `不支持[^。]*classDef`，
     结果把「支持 classDef 样式；**不支持**组内单独换方向」这句也误报了 ——
     那里的「不支持」说的是**另一件事**（方向）。守卫误报一次，
     下一次就会有人直接把整条断言删掉。 */
  const wrongDef = defLines.filter((l) => /不支持[^；。]{0,24}classDef|classDef[^；。]{0,24}不支持/.test(l))
  ok(wrongDef.length === 0,
    '卡片不再说 classDef「不支持」（它已经接上了，五个图种共用）',
    JSON.stringify(wrongDef.slice(0, 2)))
  const fc = await import('node:fs').then((fs) => stripC(fs.readFileSync('src/lib/flowchart.ts', 'utf8')))
  ok(!/不支持 subgraph/.test(fc), 'flowchart.ts 头注释也不再说 subgraph 不支持（分组框早就有了）')

  /* ⚠️ 上面几条是**逐个案例**加的 —— 挖出一条补一条，很容易漏掉下一个页面。
     这里补一条**通用判据**，把三个面（帮助页 / 快捷键面板 / 卡片说明）
     之外的用户界面也纳入：「凡是标着『未实现』的控件，必须是真禁用」。
     一个能点、点了没反应、却长得像能用的按钮，比没有更糟 ——
     而 `test-no-fake-actions` 这个套件的最初动机正是这一类。
     （空间页 Space.tsx 不在此列：它一处「未实现」都没有，守卫会恒真。） */
  const setLines = stripC(await import('node:fs').then((fs) => fs.readFileSync('src/pages/Settings.tsx', 'utf8'))).split('\n')
  /*
   * 「未实现声明」的定位逻辑**单独提成函数**，因为下面要拿它做自检 ——
   * 自检必须走**同一条代码路径**，不能另写一份正则：
   * 复制一份正则的自检有个致命处 —— 下一个人改了扫描规则，
   * 自检里那份不会跟着改，于是「扫描器坏了」它照样绿。
   */
  const findClaims = (lines) => lines
    .map((l, i) => ({ l, i }))
    .filter((x) => /尚未实现|未实现|还没做|暂不支持/.test(x.l))
  const claims = findClaims(setLines)

  /*
   * ⚠️ 「这处声明挂在控件上吗」**不能**按 ±几行取邻域判断 ——
   *   那样会串到隔壁元素里去。
   *
   * 真实踩到的那一处：设置页里
   *   <Row label="导入" …><Button …>导入…</Button></Row>     ← 591 行，真控件
   *   <Row label="暂不支持的导入格式" desc="…" />            ← 596 行，纯说明
   * 第二行**自闭合**、没有任何子节点，一个可点的东西都没有，
   * 而它 ±6 行里正好有上面那个 `<Button` —— 于是纯说明文字被判成「假按钮」。
   *
   * 真正要问的是：**承载这行字的那个元素有没有子节点**。
   * 自闭合（`/>`）→ 它只渲染 label + desc，不构成
   * 「长得像能点、点了没反应」的假控件。
   */
  const claimOnControl = (lines, i) => {
    let start = i
    while (start >= 0 && !/<[A-Z]/.test(lines[start])) start--
    if (start < 0) return true // 找不到宿主标签：保守当成控件，宁可多查
    let buf = ''
    for (let k = start; k < lines.length; k++) {
      buf += lines[k] + '\n'
      /*
       * 找的是**标签的收尾 `>`**，不是箭头函数的 `=>`。
       * 第一版直接用 indexOf('>')，结果 `onClick={() => {}}` 里的箭头
       * 被当成了标签结尾 —— 而切片又**包含了**那个 `>`，
       * 于是 `/\/$/` 永远不成立，自闭合判断恒假、整条判据恒真。
       * （一个恒真的判据比没有判据更坏：它看起来在守着，实际什么都没守。）
       */
      const m = buf.match(/(?<![=>])>(?![=>])/)
      if (m) return !/\/\s*$/.test(buf.slice(0, m.index))
    }
    return true // 没闭合完：同样保守
  }

  const fakes = claims.filter((x) => {
    const near = setLines.slice(Math.max(0, x.i - 6), x.i + 3).join('\n')
    return claimOnControl(setLines, x.i) && !/\bdisabled\b/.test(near)
  })
  ok(fakes.length === 0,
    `每一处「未实现」的控件都真被禁用（不是能点却没反应的假按钮）；当前扫描到 ${claims.length} 处声明、${claims.filter((x) => claimOnControl(setLines, x.i)).length} 处在控件上`,
    JSON.stringify(fakes.slice(0, 2).map((x) => x.l.trim().slice(0, 70))))

  /*
   * 反恒真：原来这条是 `claims.length > 0`（「确认这种声明确实存在，免得判据扫空气」）。
   * 2026-10-11 头像上传做出来了，Settings.tsx 里的「未实现」声明**归零**，
   * 于是它自己变成恒假 —— 一条专门用来「防止假绿」的断言，
   * 因为**问题被修好了**而把整个块判红。它变红的含义恰恰是好事。
   *
   * 真要判的判据是「凡是标着『未实现』的控件都必须是真禁用」，
   * 这条**与有没有这种声明无关**：没有声明时它自然通过（vacuous truth）。
   * 反恒真不该靠「必须存在」表达，而该靠**另一条**独立检查 ——
   * 确认扫描器本身还扫得到东西。
   */
  {
    /* 正样本：造一句该被扫到的 */
    const pos = findClaims(['<Button>尚未实现</Button>'])
    ok(pos.length === 1, '扫描器自检·正：该扫到的「未实现」扫到了（否则上面那条是恒真的）')

    /* 负样本：造一句**不该**被扫到的 —— 只验正样本的话，
       「扫到一切」的扫描器也能过，那它是坏的而不是好的 */
    const neg = findClaims(['<Button>已完成</Button>', '<Button>可用</Button>'])
    ok(neg.length === 0, '扫描器自检·负：不该扫到的没被扫到（防止「见字就抓」）')

    /*
     * 「这处声明挂在控件上吗」这个新分支也要自检 ——
     * 不然它可能**恒真**（什么都当控件，于是判据等于没改）
     * 或者**恒假**（什么都不当控件，于是真假按钮全部放过）。
     * 两个方向都会让上面那条变成空转。
     */
    const noChild = ['<Row', '  label="暂不支持的导入格式"', '  desc="我们不支持 .doc"', '/>']
    ok(claimOnControl(noChild, 1) === false,
      '扫描器自检·控件判定·负：自闭合的 <Row /> 判成「不是控件」（它一个可点的东西都没有）')

    const withChild = ['<Row', '  label="暂不支持"', '>', '  <Button>导入</Button>', '</Row>']
    ok(claimOnControl(withChild, 1) === true,
      '扫描器自检·控件判定·正：有子节点的 <Row> 判成「控件」（那一支不能漏）')

    const btn = ['<Button onClick={() => {}}>未实现</Button>']
    ok(claimOnControl(btn, 0) === true,
      '扫描器自检·控件判定·正：<Button> 判成「控件」')
  }

  // 帮助条目必须真的能打开内容，不能是「按了没反应」
  await p.locator('.yq-help-item').first().click()
  await p.waitForSelector('.yq-modal-body', { timeout: 10000 })
  await p.waitForTimeout(500)
  const modalText = (await p.locator('.yq-modal-body').textContent().catch(() => '')) || ''
  ok(modalText.length > 40, '点帮助条目真的打开了正文（以前是「按标题找同名节点」，永远找不到）',
    `正文长度 ${modalText.length}`)
  await p.keyboard.press('Escape')
  await p.waitForTimeout(400)

  /**
   * 发现页的两个 tab 名以前和内容对不上：
   * · 「热门内容」其实**没有热度** —— 代码是「已发布的 + 前 6 篇」，既不热门也不最近。
   * · 「公开知识库」列的是**全部**知识库；而演示数据里一个 public 的都没有，
   *   按标签过滤的话这页永远是空的。
   */
  console.log('\n== tab 名要和内容对得上 ==')
  await p.goto(`${BASE}/#/find`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-dash-greeting', { timeout: 25000 })
  await p.waitForTimeout(900)
  const findTabs = (await p.locator('.yq-dash .yq-seg-item, .yq-dash [class*="seg"] button').allTextContents()).join('|')
  const findText = (await p.locator('.yq-dash').textContent()) || ''
  ok(!/热门内容/.test(findTabs) && !/热门内容/.test(findText),
    '发现页没有「热门内容」这个 tab（项目里没有热度排行）', findTabs)
  ok(!/公开知识库/.test(findTabs) && !/公开知识库/.test(findText),
    '发现页没有「公开知识库」这个 tab（它列的是全部知识库，标签在骗人）', findTabs)
  ok(/最近更新/.test(findText), '改成了实话「最近更新」')
  ok(/全部知识库/.test(findText), '改成了实话「全部知识库」')

  /**
   * 「小记 → 转为文档」以前**只带走了标题、丢掉了正文**：
   * createDoc 建出来的是 `body: ''` + 一个空 H1 占位。
   * 于是「把这条想法整理成文档」变成了「把想法标题整理成一篇空文档」。
   */
  console.log('\n== 「转为文档」要真的带上正文 ==')
  const noteText = `转文档验证_${SUF} 这段正文必须跟着进文档`
  await p.goto(`${BASE}/#/notes`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-notes-input', { timeout: 25000 })
  await p.fill('.yq-notes-input', noteText)
  await p.waitForTimeout(300)
  await p.click('button:has-text("发布")')
  await p.waitForTimeout(1200)
  const noteExists = await p.evaluate((t) =>
    (window.__yqStore.getState().notes || []).some((n) => (n.text || '').includes(t)), noteText)
  ok(noteExists, '小记发出去了')

  // **点真的那个按钮**，不直接调 store —— 否则验的是 API，
  // 而「转为文档丢正文」的 bug 恰恰出在页面那段接线里
  await p.locator(`.yq-note:has-text("转文档验证") button:has-text("转为文档")`).first().click()
  await p.waitForTimeout(1800)
  const converted = await p.evaluate((t) => {
    const docs = Object.values(window.__yqStore.getState().docs || {})
    const d = docs.find((x) => (x.blocks || []).some((b) => (b.text || '').includes(t)))
    return d
      ? { title: d.title, blocks: (d.blocks || []).map((b) => b.text || '') }
      : { title: null, blocks: [] }
  }, noteText)
  ok(!!converted.title, '点「转为文档」真的建出了文稿', String(converted.title))
  ok((converted.blocks || []).some((x) => x.includes('这段正文必须跟着进文档')),
    '**正文**跟着进了文档（以前只留标题，正文一个字没带走）', (converted.blocks || []).join(' | ').slice(0, 110))

  /**
   * 文档页「更多」菜单里两个骗人的项：
   * · 「发布到互联网」只置 `published: true`，而这个字段在界面上只驱动
   *   **三处「已发布」标签**。有没有公网开放是**知识库级**开关，与它无关。
   *   「已发布到互联网」这句 toast 会让管理员以为任何拿到链接的人都能看了。
   * · 「设为只读」只是 `useState` 的本地状态，不落库、不同步、不影响别人 ——
   *   真正让别人只读的是文档 visibility 和 `book_members` 的 `perms.edit`。
   */
  console.log('\n== 文档菜单里的两个骗人项 ==')
  const firstBook = await p.evaluate(() => window.__yqStore.getState().books[0]?.id)
  const firstDoc = await p.evaluate(() => {
    const st = window.__yqStore.getState()
    const n = st.nodes.find((x) => x.docId)
    return n ? { bookId: n.bookId, docId: n.docId } : null
  })
  ok(!!(firstBook && firstDoc), '找得到一篇文档来做验证', JSON.stringify(firstDoc))
  if (firstDoc) {
    await p.goto(`${BASE}/#/book/${firstDoc.bookId}/doc/${firstDoc.docId}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-docpage', { timeout: 25000 })
    await p.waitForTimeout(1200)
    await p.locator('.yq-doc-more').first().click()
    // 菜单是 Popover 渲染的（Dropdown 内部就是 Popover），类名是 .yq-popover
    await p.waitForSelector('.yq-popover', { timeout: 10000 })
    await p.waitForTimeout(500)
    const menuText = (await p.locator('.yq-popover').textContent().catch(() => '')) || ''
    ok(menuText.length > 20, '菜单真的打开了（取到内容才谈后面的断言）', `长度 ${menuText.length}`)
    ok(!/发布到互联网/.test(menuText), '菜单里没有「发布到互联网」（本项目没有互联网发布这回事）',
      menuText.replace(/\s+/g, ' ').slice(0, 110))
    ok(/「已发布」/.test(menuText),
      '发布项改成了实话（「标记为「已发布」」或「取消「已发布」标记」，取决于当前状态）',
      menuText.replace(/\s+/g, ' ').slice(0, 110))
    ok(!/设为只读|解除只读/.test(menuText), '菜单里没有「设为只读」（那只是本地预览开关）',
      menuText.replace(/\s+/g, ' ').slice(0, 110))
    ok(/只读预览/.test(menuText), '改成了实话「只读预览」', menuText.replace(/\s+/g, ' ').slice(0, 110))
    await p.keyboard.press('Escape')
    await p.waitForTimeout(400)
  }

  console.log('\n== 重命名是真的改名（行内编辑）==')
  await p.goto(`${BASE}/#/book/b1`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-bookpage-title', { timeout: 25000 })
  await p.waitForTimeout(1500)
  const before = await p.evaluate(() => window.__yqStore.getState().books.find((b) => b.id === 'b1')?.name)
  const newName = `改名验证 ${SUF}`

  // 双击标题直接进编辑（语雀的做法）
  await p.locator('.yq-bookpage-title').dblclick()
  const input = p.locator('.yq-bookpage-title-input')
  ok((await input.count()) === 1, '双击标题进入行内编辑（不是弹一个 prompt）')
  await input.fill(newName)
  await input.press('Enter')
  await p.waitForTimeout(1200)
  const after = await p.evaluate(() => window.__yqStore.getState().books.find((b) => b.id === 'b1')?.name)
  ok(after === newName, `名字真的变成了「${newName}」`, `${before} → ${after}`)
  ok(!/✎/.test(String(after)), '没有再往名字后面追加「✎」这种假改名的痕迹', String(after))

  // 空名字不该把库名清空
  await p.locator('.yq-bookpage-title').dblclick()
  await input.fill('   ')
  await input.press('Enter')
  await p.waitForTimeout(1000)
  const afterEmpty = await p.evaluate(() => window.__yqStore.getState().books.find((b) => b.id === 'b1')?.name)
  ok(afterEmpty === newName, '清空后回车不会把名字改成空白', String(afterEmpty))

  // Esc 取消
  await p.locator('.yq-bookpage-title').dblclick()
  await input.fill('不该生效')
  await input.press('Escape')
  await p.waitForTimeout(900)
  const afterEsc = await p.evaluate(() => window.__yqStore.getState().books.find((b) => b.id === 'b1')?.name)
  ok(afterEsc === newName, '按 Esc 放弃编辑，不改名', String(afterEsc))

  /*
   * ⚠️ 把库名**改回去**（2026-10-10 加）。
   *
   * 这一节验证完之后没还原，于是 b1 的名字就永久停在「改名验证 mv27hbxj」。
   * 症状在两轮之后才显形：拿这个实例开浏览器看首页，
   * 「产品手册」变成了「改名验证 mv27hbxj」，而**没有任何一条断言报红**。
   *
   * ⚠️⚠️ 第一版这里写错了，**断言是假绿**：
   *   它改完之后立刻读 store，而 store 本来就被改过 —— 于是「改回去了」永远成立。
   *   实测那次它报 PASS，而查库发现服务端仍然是「改名验证 …」。
   *
   *   两处都要修：
   *     ① **等推送落地**再断言（`commit` → `persist` 有防抖窗口，
   *        立刻读读到的是本地值，不是服务端值）；
   *     ② 断言的判据必须是「改完之后名字确实不再是改名验证」，
   *        而不是「等于 before」—— 万一 before 本身就是脏的，
   *        后者会把脏值当成正确答案（这里 before 在第二轮跑时
   *        已经是「改名验证 mv27hbxj」了，正是这种情况）。
   */
  {
    await p.evaluate((orig) => { window.__yqStore.getState().updateBook('b1', { name: orig }) }, before)
    // 给同步留出落地时间（commit → persist 有防抖）
    await p.waitForTimeout(2500)
    const restored = await p.evaluate(() => window.__yqStore.getState().books.find((b) => b.id === 'b1')?.name)
    ok(restored === before && !/改名验证/.test(String(restored)),
      '**测试结束后把库名改回去了**（不还原会污染实例，症状是几百行之外的断言突然变红）',
      `before=${before} → 现在=${restored}`)
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  /*
   * 收尾清理（2026-10-08 事故后加的）：这个套件会往部署实例里建小记和文稿，
   * 而它不在自己的清理范围里 —— 连跑两轮全量就把 26 篇变成 29 篇。
   * **清不掉必须报错**，否则它会一直静默地堆垃圾。
   */
  if (cleanup) {
    try {
      const n = await cleanup()
      console.log(`  PASS  测试数据已清理（${n} 条）`)
    } catch (e) {
      fail++
      console.log(`  FAIL  清理失败：${e.message}`)
    }
  }
  try { await browser.close() } catch { /* 已关 */ }
}

console.log('\n== 应用内快捷键面板：承诺的要么真实现，要么写明边界 ==')
/* ⚠️ 补这一节的原因：这个套件本来就在盯「界面说了、其实没有」，
 *   但它只查了**帮助页**那张表（`.yq-help-kbd-grid`），没管右下角那个
 *   **应用内面板**（`Shortcuts.tsx`）。于是面板里笼统写着「⌘Z 撤销」，
 *   而全项目**根本没有应用级 undo**（实测：块内打字能靠原生撤销回退，
 *   回车新建块按 ⌘Z 完全没反应）—— 用户只会以为是自己电脑的问题。

   ⚠️ 第一版想写「面板里每一条组合键都必须 case 到」，**做不出来**：
 *   ⌘B/⌘I/⌘U/⌘Z 走的是 **contentEditable 的浏览器原生行为**，源码里根本没有 case；
 *   ⌘S 是 `e.key.toLowerCase() === 's'`；Esc/Enter/Backspace/Tab 是具名键、不该抽字母。
 *   要写成通用判据，就得手工维护一张「哪些是原生的」的分类表 —— 而那张表自己会漂，
 *   漂了之后这个守卫就成了恒真的摆设（本项目反复吃过这个亏）。
 *   所以只断**有把握的那部分**：应用级视图快捷键（⌘⇧X）必须真 case，
 *   而撤销那条必须写明它只管块内输入。 */
{
  const fs = await import('node:fs')
  const sc = fs.readFileSync('src/components/doc/Shortcuts.tsx', 'utf8')
  const entries = [...sc.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)]
    .map((m) => ({ key: m[1], label: m[2] }))
  ok(entries.length >= 10, `面板里共 ${entries.length} 条`, String(entries.length))

  /* ① 应用级视图快捷键（⌘⇧X）：这类是明确的、全部在 DocPage 的 switch 里。
        ⚠️ 必须**同时**要求 ⌘ 和 ⇧ —— 只看 ⇧ 会把「⇧ Enter」捞进来，
        而那是从 "Enter" 抽出字母 e 去比 `case 'e'`，必假红。 */
  const doc = fs.readFileSync('src/pages/DocPage.tsx', 'utf8')
  const shiftCombos = entries.filter((e) => e.key.includes('⌘') && e.key.includes('⇧') && /[A-Za-z]/.test(e.key))
  ok(shiftCombos.length >= 4, `面板里有 ${shiftCombos.length} 条 ⌘⇧ 组合键`)
  for (const c of shiftCombos) {
    const letter = c.key.replace(/[^A-Za-z]/g, '').toLowerCase()
    /*
     * ⚠️ 必须认**两种绑定形状**（2026-10-19 补的）：
     *   ① switch 的 `case 'f'`（视图类快捷键：⌘⇧F / ⌘⇧O / ⌘⇧P / ⌘⇧R）
     *   ② `const k = e.key.toLowerCase(); if (k === 'z' || k === 'y')` **并且**
     *      同一个处理里看了 `e.shiftKey`（⌘⇧Z 重做走的是这条）
     * 只认 ① 的话，⌘⇧Z 会假红 —— 而它恰恰是**真实现了**的那条，
     * 于是「判据红 → 以为功能坏 → 去改已经正确的实现」，
     * 这正是本项目反复吃过的亏（过期的判据比没有判据更贵）。
     */
    const viaCase = new RegExp(`case\\s*'${letter}'`).test(doc)
    const viaShift = new RegExp(`k\\s*===\\s*'${letter}'`).test(doc) && /e\.shiftKey/.test(doc)
    ok(viaCase || viaShift,
      `面板里的「${c.key}」在 DocPage 里真的被处理（switch 的 case 或 ⌘⇧ 组合判定）`, c.label)
  }

  /* ①b 顶层 ⌘X（不带 ⇧）也必须真存在 —— 这条是**补上一轮的缝**。
        上一版守卫只筛 ⌘⇧X，于是面板里那条 `['⌘ K', '全局搜索']` 从旁边溜过去了：
        TopBar.tsx:75 只实现了 `e.key === '?'`，全 src 里
        `metaKey === 'k'` / `toLowerCase() === 'k'` 零匹配（实测 Control+K 毫无反应）。
        而 Help.tsx:20-21 **早就把这个错记下来了** —— 两份文案，一个改了另一个没改。

        已知例外（这些不走 case，是原生行为，必须显式排除，否则必假红）：
          ⌘B / ⌘I / ⌘U —— contentEditable 的浏览器原生加粗/斜体/下划线
          ⌘Z —— 原生撤销（上面第 ② 条已单独用文案守它的边界）
          ⌘S —— DocPage 里写的是 `e.key.toLowerCase() === 's'`，不是 case */
  const NATIVE = /^(⌘\s*[BIUZ]|⌘\s*S)$/
  const plainCmd = entries.filter((e) => /⌘/.test(e.key) && !/⇧/.test(e.key)
    && /[A-Za-z]/.test(e.key) && !NATIVE.test(e.key.replace(/\s+/g, '')))
  const topbar = fs.readFileSync('src/components/layout/TopBar.tsx', 'utf8')
  for (const c of plainCmd) {
    const letter = c.key.replace(/[^A-Za-z]/g, '').toLowerCase()
    // 面板声明的键，必须能在源码里找到真的绑定（case 或 addEventListener 里的 key 判断）
    const bound = new RegExp(`case\\s*'${letter}'`).test(doc + topbar)
      || new RegExp(`toLowerCase\\(\\)\\s*===\\s*'${letter}'`).test(doc + topbar)
      || new RegExp(`key\\s*===?\\s*'\\?${letter}'`).test(doc + topbar)
    ok(bound, `面板里的「${c.key}」在源码里真的绑定了（不是只写在面板上）`, c.label)
  }
  /*
   * ⚠️ 必须**剥注释后**再扫 —— 否则这条会把自己上方那段「这里原来写的是 ⌘ K」
   * 也算成宣称，永远红。（上一条守卫已经吃过这个亏：注释里引用了被禁的词。）
   * 判据刻意只认**出现在条目里的** ⌘K：条目是 `['…', '…']` 的第一个字符串。
   */
  const scNoComment = sc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const cmdKEntries = entries.filter((e) => /⌘\s*K/i.test(e.key))
  ok(cmdKEntries.length === 0,
    '面板不再宣称不存在的「⌘ K」（真实快捷键是问号，TopBar.tsx:75）',
    cmdKEntries.length ? JSON.stringify(cmdKEntries) : '')
  ok(/e\.key\s*===\s*'\?'/.test(topbar), 'TopBar 确实用问号开搜索 —— 面板写的那一条是真的')
  // 反向锚点：条目里必须真的有一个 '?' 搜
  ok(entries.some((e) => e.key === '?'),
    "面板里有一条 '?' 全局搜索（不能只是把错的删了、好的也没补上）")

  /* ①c 同一个错在**三处**各有一份拷贝，只改一处等于没改：
        ① 搜索按钮上的 <kbd>   ② 快捷键面板条目   ③ 搜索面板内部的提示表
        这一条就是上一轮的教训 —— 我先改了 ②，实测部署端面板里 `⌘K` 还在，
        才顺出来 ① 和 ③。判据：剥注释后，TopBar 里不该再有 ⌘K。
        （这条与 ①b 的 TopBar 判据是同一份文件，但角度不同：①b 管「声明的键
        得有绑定」，这里管「别再有编的键留在任何角落」。） */
  const topbarNoComment = topbar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  ok(!/⌘\s*K/.test(topbarNoComment),
    'TopBar 剥注释后不再出现 ⌘K（搜索按钮 kbd 与面板提示表都已改成 ?）',
    (topbarNoComment.match(/.*⌘\s*K.*/) || [''])[0].trim())
  // ⚠️ 2026-10-10 改判据：对照真实语雀，它的搜索键是 **⌘J**（搜索框右侧印的就是 `Ctrl J`），
  //   `?` 从来不是它的搜索键 —— `?` 是**快捷键面板**的键。
  //   所以面板展示改成 ⌘J，但 `?` 作为别名**保留**（帮助页教过、test-shortcuts 按行为测它）。
  //   真正要守的不变量是「**面板上写的键，按下去真的有反应**」，
  //   而不是「这个键必须字面上是问号」。
  ok(/'\⌘ J',\s*'全局搜索/.test(topbarNoComment),
    "TopBar 的搜索面板提示表里那条是 '⌘ J' 全局搜索（语雀真实键位）")
  ok(/k === 'j' && \(e\.metaKey \|\| e\.ctrlKey\)/.test(topbarNoComment),
    '⌘J / Ctrl+J 真的绑定了（mac 与 Windows 两种形态都认）')
  ok(/e\.key === '\?'/.test(topbar),
    '`?` 作为别名仍然保留 —— 教给过用户的键不能悄悄拿掉')
  ok(!/"'\/',\s*'聚焦搜索'"/.test(topbarNoComment),
    'TopBar 不再宣称「/ 聚焦搜索」（面板一挂载输入框就自动聚焦，源码里没绑过 /）')

  /* ①d 界面上一个 ⌘K 都不能剩。
     这一条是被部署端实测逼出来的：`⌘K` 一共藏在**四处** ——
     搜索按钮的 kbd、快捷键面板条目、搜索面板内提示表、帮助页那段说明。
     我前两次分别只改了一处，部署端一跑就还剩下一处。
     教训：**一个错误键位不只写在一处**，grep 到一处不代表 grep 完了，
     判据必须覆盖「界面上任何角落」。 */
  const helpNoComment = fs.readFileSync('src/pages/Help.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  ok(!/<kbd>\s*⌘\s*K\s*<\/kbd>/.test(helpNoComment),
    '帮助页不再把 ⌘K 画成 kbd（那段说明里提过它，但不该渲染成键位）')
  const allSrc = [topbarNoComment, scNoComment, helpNoComment].join('\n')
  ok(!/<kbd>\s*⌘\s*K\s*<\/kbd>/.test(allSrc),
    '三处界面（顶栏 / 快捷键面板 / 帮助页）都没有把 ⌘K 渲染成键位')
  ok(/e\.key\s*===\s*'\?'/.test(topbar), 'TopBar 确实用问号开搜索 —— 面板写的那一条是真的')

  /* ② 撤销：**应用级**撤销（2026-10-19 补上 `src/lib/undo.ts`）
   * ------------------------------------------------------------
   * ⚠️ 这两条判据**原来是反着写的**，而且它们自己写明了反过来的日子：
   *   「哪天真加了应用级撤销，把这条和上一条一起反过来」——
   *   那天就是 2026-10-19（`src/lib/undo.ts` 落地）。
   *
   * 原来守的是「撤销只能靠浏览器原生，所以文案必须写明只管块内」：
   *   · 原生撤销只在一个 contenteditable 里、只退**一个字**；
   *   · 回车建块 / 删块 / 插卡片**一个都撤不回来**。
   * 现在是应用级撤销（存块数组快照、连续打字合并成一条），
   * 于是这两条一起反过来：
   *   · 文案必须写明**新**的边界（一次撤一个动作；连续打字算一次），
   *     留着旧文案就是在骗人；
   *   · 实现里必须**真的有**应用级撤销（undoDoc / redoDoc 被调用），
   *     而不是继续靠原生。
   *
   * ⚠️ 断言条数保持不变（2 条），所以套件项数不变、文档里的登记不用改。
   */
  const undo = entries.find((e) => e.key.replace(/\s+/g, '') === '⌘Z')
  ok(!!undo && /一次撤一个动作|连续打字算一次/.test(undo.label),
    '撤销那条写明它的**新**边界（一次撤一个动作；连续打字算一次）', JSON.stringify(undo))
  const editor = fs.readFileSync('src/components/doc/Editor.tsx', 'utf8')
  const appUndo = /undoDoc\s*\(/.test(doc) && /redoDoc\s*\(/.test(doc)
    && /from\s+'@\/lib\/undo'/.test(doc)
  ok(appUndo,
    '实现里真的有应用级撤销（undoDoc / redoDoc 被 DocPage 调用），不是浏览器原生',
    (doc.match(/undoDoc\([^)]*\)/) || [''])[0])
}

/* ============================================================
   store 里「声明了但没有任何人调用」的成员
   ------------------------------------------------------------
   这类和上面那些按钮是同一个病：**看起来有能力，实际不生效**，
   但它连界面都没有 —— 所以更隐蔽，扫界面永远扫不到。

   实例（本轮清掉的 14 个）：
     · outlineVisible / toggleOutline —— 声明成「大纲显隐」，而 DocPage
       真正用的是自己的 useState。这个 toggle 调了不会有任何反应。
     · purgeFromTrash —— 回收站界面走的是 api.purgeDoc，这个 action
       谁也没调；哪天有人接上它，两条删除路径就分叉了。
     · useTemplate —— 模板页走 applyTemplate（它自己会 +1 usedCount），
       所以「已用 N 次」本来是对的；这个 action 是另一个没接上的实现。
     · getDoc / getBook / getNode 等 9 个查询器 —— 界面各自写了
       `docs[id]` / `books.find(...)`，这些便捷封装从未被调用。

   ⚠️ 判据的三条硬规矩（前两条是我自己踩出来的）：
   ① **必须排除守卫自己**。本文件里写着这些成员名，它自己就是消费方；
      不排除的话，守卫会把自己的引用算成「有人用」，于是永远绿。
   ② **必须排除 store/index.ts 自身**（它当然引用了每个成员）。
   ③ **必须先自检会咬人**：断言判据本身能跑、且这次清掉的 14 个确实
      已经不在 store 里。若哪天有人把它们加回来又忘了接线，这里立刻红。
   ============================================================ */
{
  const fs = await import('node:fs')
  const path = await import('node:path')

  // ① 消费方文件：src 下的 ts/tsx（排除 store/index.ts）+ 根目录 mjs/cjs，
  //    并排除本文件（否则第 ① 条规矩就破了）
  const consumers = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (/\.(ts|tsx)$/.test(e.name) && !f.endsWith(path.join('store', 'index.ts'))) consumers.push(f)
    }
  }
  walk('src')
  for (const f of fs.readdirSync('.')) {
    if (/\.(mjs|cjs)$/.test(f) && !/^test-no-fake-actions\./.test(f)) consumers.push(f)
  }
  const blob = consumers.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

  // ② 取 store interface 的成员名（按缩进闭合，不按花括号深度 ——
  //    注释里的 `{` 会让深度计数提前归零，接口被截断，守卫就变成永远绿）
  const store = fs.readFileSync('src/store/index.ts', 'utf8')
  const lines = store.split('\n')
  const start = lines.findIndex((l) => /^interface Store extends AppData/.test(l))
  ok(start >= 0, '找得到 store 的 interface 声明')
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) { end = i; break }
    if (/^(export |interface |type |const |function )/.test(lines[i]) && i > start + 1) { end = i - 1; break }
  }
  const names = new Set()
  for (const m of lines.slice(start, end + 1).join('\n')
    .matchAll(/^\s{2,}(?:\/\*\*?[^]*?\*\/\s*)?([a-zA-Z_$][\w$]*)\s*[?:]/gm)) names.add(m[1])
  ok(names.size >= 40, `扫到 store 的 ${names.size} 个成员`)

  // ③ 零消费者清单
  const dead = [...names].filter((n) => !new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(blob)).sort()
  ok(dead.length === 0, `store 里没有「声明了但没人调用」的成员（当前 ${dead.length} 个）`,
    dead.length ? JSON.stringify(dead) : '')

  // ④ 破坏对照的反向锚点：这 14 个是本轮**实际清掉**的，
  //    若哪天被加回来又没接线，第 ③ 条会红
  const removed = ['outlineVisible', 'toggleOutline', 'purgeFromTrash', 'useTemplate',
    'getDoc', 'getBook', 'getSpace', 'getNode', 'getBookTree', 'getNodeChildren',
    'getNodeByDocId', 'getBookOfDoc', 'getSpaceOfDoc']
  const back = removed.filter((n) => names.has(n))
  ok(back.length === 0, `${removed.length} 个死成员没有回到 store 里`, back.length ? JSON.stringify(back) : '')

  /* ⑤ 破坏对照：把一个已知零引用的名字塞回「store 里」，第 ③ 条必须变红。
        守卫没验证过自己会咬人，就等于没有守卫（本项目反复吃过这个亏）。 */
  {
    const probe = '__probe_dead__'
    const lines2 = lines.slice()
    // 插一行「声明」，位置就在 interface 首行之后 —— 模拟有人加了个没人用的 action
    lines2.splice(start + 1, 0, `  ${probe}: (id: string) => void`)
    // ⚠️ 闭合位置要**在插行后的 lines2 上重新找**。第一版直接拿 `lines` 的索引去切，
    //    插行后所有下标错位，切出的区间不含新声明 → 判据漏报 → 破坏对照自己红了。
    let end2 = start
    for (let i = start + 1; i < lines2.length; i++) {
      if (/^\}/.test(lines2[i])) { end2 = i; break }
      if (/^(export |interface |type |const |function )/.test(lines2[i]) && i > start + 1) { end2 = i - 1; break }
    }
    const names2 = new Set()
    for (const m of lines2.slice(start, end2 + 1)
      .join('\n').matchAll(/^\s{2,}(?:\/\*\*?[^]*?\*\/\s*)?([a-zA-Z_$][\w$]*)\s*[?:]/gm)) names2.add(m[1])
    const dead2 = [...names2].filter((n) => !new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(blob))
    ok(dead2.includes(probe), '破坏对照：塞一个没人用的成员进去，第 ③ 条的判据会把它抓出来')
  }
}

/* ============================================================
   「文档/注释里写了『右键菜单』，实现里就必须真的有」
   ------------------------------------------------------------
   本条来自一次实测失真：`Tree.tsx:11`、`Editor.tsx` 删块注释、
   `README.md:1646` 三处都写着「右键菜单」，而全 src 里
   `onContextMenu` / `contextmenu` **0 匹配** —— 两个菜单都只挂在
   `···` 按钮上。注释承诺的能力越具体（写清是哪一个菜单），
   读代码的人越不会去核实，于是它能一直假着。

   判据只做「能咬人的那一半」：
     · src 里必须有真的 onContextMenu（不含注释）
     · Editor 的块级菜单与 Tree 的节点菜单都要能由右键触发
     · 两处都必须把右键坐标传下去（只有 onContextMenu 而不定位，
       菜单会弹在按钮位置 —— 这正是本条第一版的实现状态，
       实测右键能用但位置全错）

   ⚠️ 断言里引用了「右键菜单」这个词，所以扫源码时**必须先剥注释** ——
     否则这条守卫会把自己和三处注释当成「实现」，永远绿。
   ============================================================ */
{
  const fs = await import('node:fs')

  /** 剥掉行注释与块注释后再扫，避免拿注释当实现 */
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  const editorSrc = stripComments(fs.readFileSync('src/components/doc/Editor.tsx', 'utf8'))
  const treeSrc = stripComments(fs.readFileSync('src/components/doc/Tree.tsx', 'utf8'))
  const popoverSrc = stripComments(fs.readFileSync('src/components/ui/index.tsx', 'utf8'))

  ok(/onContextMenu\s*=/.test(editorSrc), 'Editor.tsx 真的有 onContextMenu（剥注释后扫）')
  ok(/onContextMenu\s*=/.test(treeSrc), 'Tree.tsx 真的有 onContextMenu（剥注释后扫）')

  /* Popover 必须支持按外部坐标定位，否则右键菜单只会弹在 ··· 按钮旁边 */
  ok(/anchor\?:\s*\{\s*x:\s*number;\s*y:\s*number\s*\}\s*\|\s*null/.test(popoverSrc),
    'Popover 接受 anchor（右键菜单要按鼠标位置定位）')
  ok(/anchor\.y\s*-\s*h/.test(popoverSrc),
    'Popover 在下方放不下时会把菜单往上翻（否则视口底部右键弹出的菜单会掉出屏幕）')

  /* 两处都必须把坐标传下去 */
  ok(/anchor=\{ctxAt\}/.test(editorSrc), 'Editor 的块级菜单把右键坐标传给了 Dropdown')
  ok(/anchor=\{ctxAt\}/.test(treeSrc), 'Tree 的节点菜单把右键坐标传给了 Dropdown')

  /* 只读态不许劫持右键：原生菜单（复制/检查）要留给浏览器 */
  const roGuard = /onContextMenu=\{\(e\)\s*=>\s*\{[\s\S]{0,400}?if\s*\(p\.readOnly\)\s*return/
  ok(roGuard.test(editorSrc),
    'Editor 的 onContextMenu 在只读态直接 return，不劫持浏览器原生菜单')

  /* 破坏对照：把 Editor 的 onContextMenu 换掉，这条必须红 */
  {
    const broken = editorSrc.replace(/onContextMenu=\{\(e\)\s*=>\s*\{/, 'onMouseDown={(e) => {')
    ok(!/onContextMenu\s*=/.test(broken) && roGuard.test(broken) === false,
      '破坏对照：撤掉 onContextMenu 后，前两条与只读守卫都会变红')
  }
}

/* ============================================================
   「提示点」必须由数据驱动，不能无条件渲染
   ------------------------------------------------------------
   实例：顶栏铃铛上的红点 `<span className="yq-bell-dot" />` 是**无条件**渲染的，
   而设置页明写「本项目**没有通知服务**：@ 提醒、评论通知、每周精选都不会真的发给你」。
   于是它是个恒真的「你有未读」：点开若没有待处理项，红点还在 ——
   用户只会以为「漏了」，不会想到它根本不是数据。

   判据：红点必须被某个条件包住，而那个条件里要有真实数据源
   （这里 `collaborations` 的 `unread`）。只看「有没有条件」不够 ——
   `collaborations.length >= 0` 之类也是恒真的。
   ============================================================ */
{
  const fs = await import('node:fs')
  const topbar = fs.readFileSync('src/components/layout/TopBar.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  /*
   * ⚠️ 别用一条大正则去跨着匹配整个 JSX 表达式 —— 我第一版写了
   *    `/\{([^{}]*unreadCount[^{}]*)\}\s*&&\s*<span/`，
   *    而 JSX 里的 `{...}` 嵌套让 `[^{}]*` 必然匹配失败（第一次跑就红）。
   *    改成三条独立断言：① 那一行存在且带条件 ② 条件里有 unreadCount
   *    ③ unreadCount 本身来自真实数据。**逐条比一条更省事，也更好归因。**
   */
  const dotLine = topbar.split('\n').find((l) => l.includes('yq-bell-dot'))
  ok(!!dotLine, '找得到铃铛红点那一行')
  ok(!!dotLine && /\{\s*unreadCount\s*>\s*0\s*&&/.test(dotLine),
    '红点被「未读数 > 0」条件包住，不再无条件渲染', dotLine ? dotLine.trim() : '')

  const src = /const unreadCount = ([^\n]+)/.exec(topbar)
  /*
   * ⚠️ 这里原来判的是「未读数来自 collaborations 的 unread 字段」。
   *    那是**纯客户端种子**（无服务端表、不在同步清单），
   *    服务端形态下永远是那几条假数据 —— 红点要么常亮要么永灭，
   *    而点进去看到的是空列表。
   *    2026-10-11 有了真的 bookInvites 之后改用它。
   */
  ok(!!src && /bookInvites/.test(src[1]),
    '未读数来自**真数据** bookInvites（原来数的是假种子的 unread 字段）',
    src ? src[1].trim() : '未找到')
  ok(!!src && !/collaborations/.test(src[1]),
    '未读数不再读那套假数据 collaborations')
}

/* ============================================================
   服务器模式下不该出现「只在本地成立」的控件
   ------------------------------------------------------------
   实例：设置页的「演示身份切换」。实测（2026-10-08 部署端）：
     切到「林知远（member）」→ 顶栏名字变了，
     可编辑块数一个没少（权限按 token 判，不走 currentUser）；刷新又恢复。

   也就是说它**换的只是名字、不是权限视角**，展示不出任何「角色差异」。
   原文案还写着「用于体验不同角色看到的界面差异」—— 在部署实例上那是假话。

   判据：这一区块必须被 `getMode() !== 'server'` 包住。
   **不是**「加一句免责声明就算过」—— 讲清楚的半真功能仍会诱导人去点
   （用户会拿它当排查权限的手段），所以部署态要**直接不显示**。
   ============================================================ */
{
  const fs = await import('node:fs')
  const settings = fs.readFileSync('src/pages/Settings.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  ok(!/用于体验不同角色/.test(settings.replace(/<[^>]*>/g, '')) ||
     /getMode\(\)\s*!==\s*'server'/.test(settings),
    '「演示身份切换」要么不存在，要么被 getMode() 门控')

  // 更直接的一条：标题所在的那个 section 必须落在 mode 判断里
  const titleAt = settings.indexOf('演示身份切换')
  ok(titleAt > 0, '找得到「演示身份切换」这一节')
  if (titleAt > 0) {
    const before = settings.slice(Math.max(0, titleAt - 2600), titleAt)
    ok(/getMode\(\)\s*!==\s*'server'/.test(before),
      '这一节被 `getMode() !== "server"` 包住 —— 部署态不显示半真的控件')
  }
}

/* ============================================================
   「协作」tab 在部署实例里是一个恒空的空壳，还带两个假按钮
   ------------------------------------------------------------
   查实（2026-10-08）：`collaborations` 是**纯客户端种子数据** ——
     · 只在 src/data/seed.ts:507 造出来
     · 没有服务端表、没有 API
     · 不在 server/entities.ts 的同步实体清单里
   服务端模式下 `clearLocalSnapshot()`（store/index.ts:1604）把它清成 `[]`，
   而 `hydrate()` 只覆盖服务端真送来的字段 —— 于是它永远是 `[]`。

   后果：侧栏「协作 🤝」点进去是空列表 + 「全部 / 待处理(0)」，
   外加**接受 / 拒绝**两个按钮 —— 那两个只改本地 `collaborations`，
   既不落库也不走同步，刷新就没。和上面那些按钮同一类假动作。

   ⚠️ 容易误判的地方：服务端**有** space_members / book_members，
   BookSettings 里也确实能加成员。那是**管理员加人**，
   和「邀请你协作一篇文档」是两回事 —— 本项目**没有邀请流程**，
   谁也发不出邀请，所以那两条永远不会有数据。

   判据分四层，缺一层就漏（第四层是被真 bug 逼出来的）：
     ① 侧栏入口必须过 `visibleSections()`（否则还显示）
     ② Dashboard 必须拦 `?tab=collab`（否则手敲 URL 还是进得去）
     ③ 前提自检：collaborations 真的没有服务端来源
        —— 这条最容易被忘。哪天服务端真加了这个实体，
        这里就该反过来，那时**必须**连着这几段门控一起改。
     ④ **SideNav 的高亮口径必须和 Dashboard 同一份**（`resolveTab`）
        —— ⚠️ 第一版漏了这条，守卫全绿、功能却是半截的。
          部署实测：手敲 `/?tab=collab`，内容区回到了文档页，
          但侧栏 `active==='collab'` 而那一项刚被过滤掉
          → **一个导航项都没高亮**，看着像「点哪儿都没反应」。

   ⚠️ 按第 ③ 条的规矩，本块不按中文措辞匹配，而是钉代码结构。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const sidenav = strip(fs.readFileSync('src/components/layout/SideNav.tsx', 'utf8'))
  const dash = strip(fs.readFileSync('src/pages/Dashboard.tsx', 'utf8'))
  const tabSrc = strip(fs.readFileSync('src/lib/dashboard-tab.ts', 'utf8'))

  // ③ 前提自检：服务端既没有这张表，collaborations 也不在同步实体清单里
  const db = fs.readFileSync('server/db.ts', 'utf8')
  const ents = fs.readFileSync('server/entities.ts', 'utf8')
  ok(!/CREATE TABLE[^;]*\bcollaborations\b/i.test(db),
    '前提自检：server/db.ts 里没有 collaborations 表（所以它只能靠种子）')
  ok(!/\btable:\s*['"]collaborations['"]/.test(ents),
    '前提自检：collaborations 不在同步实体清单里（所以 hydrate 不会灌它）')
  ok(!/on\(\s*'(GET|POST|PUT|PATCH|DELETE)'[^\n]*collaborations/i.test(
      fs.readFileSync('server/index.ts', 'utf8')),
    '前提自检：服务端没有 collaborations 的接口')

  /*
   * ⚠️⚠️ 这一段原来判的是「口径按 getMode() 把 collab 改写成 doc、
   *    并且 tabVisible 把它藏起来」。
   *
   *    那在 2026-10-11 之前是**对的**：collab 读的是纯客户端种子数据，
   *    服务端形态下恒空且带两个假按钮，所以部署态直接不显示。
   *
   *    补了真的知识库邀请之后，那条前提**不成立了** ——
   *    继续按旧口径隐藏 = 把已经能用的功能继续藏着，
   *    而注释还写得很确信，看起来像一条有意的产品决策，没人会去查。
   *
   *    所以现在判的是**反过来**的那件事：口径仍在同一份文件里，
   *    但**不再**按 getMode() 屏蔽 collab。
   */
  ok(/function resolveTab/.test(tabSrc) && /function tabVisible/.test(tabSrc),
    '口径模块仍导出 resolveTab（渲染/高亮）与 tabVisible（能不能看见）两个函数')
  ok(!/getMode\(\)\s*===\s*['"]server['"][^\n]*collab|collab[^\n]*getMode\(\)\s*===\s*['"]server['"]/.test(tabSrc),
    '**不再**按 getMode() 把 collab 判成不可达（它现在有真数据了）')

  /*
   * ⚠️ 光验「文件里有这两个函数」不够 —— 破坏对照 ⑫⑬ 直接测出：
   *   把 resolveTab 的函数体掏空（改成原样返回 `t`），
   *   而 `getMode()` / `'collab'` 字样还在文件里的别处（tabVisible），
   *   于是上面那条形状检查**照样绿**，而门控已经静默失效。
   * 所以必须按花括号配平把**函数体**切出来，逐个验它自己真的在判。
   */
  const bodyOf = (src, name) => {
    const at = src.indexOf(`function ${name}`)
    if (at < 0) return ''
    let i = src.indexOf('{', at)
    if (i < 0) return ''
    let d = 0
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') d++
      else if (src[j] === '}' && --d === 0) return src.slice(i + 1, j)
    }
    return ''
  }
  const rBody = bodyOf(tabSrc, 'resolveTab')
  const vBody = bodyOf(tabSrc, 'tabVisible')
  ok(rBody.length > 0, '能切出 resolveTab 的函数体')
  /*
   * ⚠️ 判据必须**按函数体**判，不能只验「文件里有这两个名字」——
   *    破坏对照 ⑫⑬ 已经测出：把函数体掏空，上面那条照样绿。
   *    （bodyOf 那段工具留下，继续复用。）
   *
   *    现在判的是**反转**真的落地在函数体里：两个函数都不再提 collab/getMode。
   */
  ok(!/['"]collab['"]/.test(rBody), 'resolveTab 的函数体**不再**特判 collab（恒返回原值）')
  ok(!/getMode\(\)/.test(rBody), 'resolveTab 的函数体不再问 getMode（口径不再随形态变）')
  ok(!/['"]collab['"]/.test(vBody) && !/getMode\(\)/.test(vBody),
    'tabVisible 的函数体不再按形态过滤（协作项始终可见）')

  // ① 侧栏入口
  ok(/tabVisible\(/.test(sidenav), 'SideNav 用 tabVisible 过滤侧栏项')
  ok(/\{visibleSections\(\)\.map\(/.test(sidenav),
    '侧栏渲染走的是 visibleSections()，不是原始 SECTIONS')
  ok(!/\{SECTIONS\.map\(/.test(sidenav),
    '侧栏渲染没有绕过 visibleSections() 直接遍历 SECTIONS')

  // ② 深链：collab 现在**可达**了（它不再是恒空的假页）
  ok(!/rawTabs*===s*['"]collab['"]/.test(dash),
    'Dashboard 里不再自己手写 collab 判断（口径不在两处各算各的）')
  // 用改写后的 tab 选内容 —— 不能改写完又拿 rawTab 去渲染
  ok(/\{tab === 'collab' && <BookInviteList \/>\}/.test(dash),
    '协作那一项用的是改写后的 tab 变量，而且渲染的是真的 BookInviteList')
  ok(!/\{rawTab === 'collab'/.test(dash),
    '没有哪个分支还在拿 rawTab 渲染')

  // ④ 高亮口径（这条是被部署实测的红逼出来的，见文件头注释）
  ok(/const active = resolveTab\(/.test(sidenav),
    'SideNav 的高亮也走 resolveTab —— 与 Dashboard 同一份口径')
  ok(!/const active = params\.get\(['"]tab['"]\)/.test(sidenav),
    'SideNav 不再拿原始 URL 参数算高亮（否则深链会「内容对了、侧栏全灭」）')
  ok(!/resolveTab\(\s*\)\s*\|\|\s*['"]doc['"]/.test(sidenav),
    'SideNav 没有在 resolveTab 之外再加一层自己的兜底')

  // ── 门控反过来了：collab **不再**被隐藏 ──────────────────────
  /*
   * ⚠️ 原来的判据是「collab 在服务端形态下**不可达**」——
   *    理由是 collaborations 是纯客户端种子、服务端永远 []。
   *    2026-10-11 有了真邀请之后，那条理由**不成立了**，
   *    继续按旧口径隐藏 = 把已经能用的功能继续藏着。
   *    而这类过期口径看起来像一条有意的决策，没人会去查。
   */
  ok(!/t === 'collab' && getMode\(\) === 'server'/.test(strip(fs.readFileSync('src/lib/dashboard-tab.ts', 'utf8'))),
    '**不再**因为「服务端形态」把 collab 改写掉（它现在有真数据了）')
  ok(!/key !== 'collab'/.test(strip(fs.readFileSync('src/lib/dashboard-tab.ts', 'utf8'))),
    '**不再**因为「服务端形态」把 collab 那一项从侧栏过滤掉')

  // ── 真数据取代假数据 ─────────────────────────────────────────
  const store2 = strip(fs.readFileSync('src/store/index.ts', 'utf8'))
  for (const [act, api] of [
    ['acceptBookInvite', 'respondBookInvite'],
    ['rejectBookInvite', 'respondBookInvite'],
  ]) {
    /*
     * 判「这个动作真的调了 api」，而不是「这个动作存在」。
     * 旧断言只判了「走 commit」，而那两条假动作**确实**走了 commit ——
     * 照样是假功能，因为它们只改本地。**存在 ≠ 真的做对事。**
     *
     * ⚠️ 正则必须容忍 `async`：这些动作是 `act: async (id) => {` 的形状。
     *    第一版写成 `act:\s*\([^)]*\)\s*=>`，匹配不上 ——
     *    **判据红不等于代码错**，先看真代码再动判据。
     */
    const re = new RegExp(act + ':\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?:=>|=\\s*\\()', 'g')
    const ms = [...store2.matchAll(re)]
    const m = ms[ms.length - 1]
    const body = m ? store2.slice(m.index, m.index + 700) : ''
    ok(m && body.includes(api),
      `store.${act} 真的调了服务端 ${api}（而不是只改本地）`,
      m ? '' : '（连声明都没找到 —— 那多半是判据的形状写错了，先看代码）')
    ok(m && /commit\(/.test(body),
      `store.${act} 走 commit()（裸 setState 不落盘，刷新就没）`)
  }
  // 接受之后要把人真的补进 bookMembers —— 否则用户看到邀请消失、
  // 点进库却没有权限，而两边都不报错
  {
    const ms = [...store2.matchAll(/acceptBookInvite:\s*(?:async\s*)?\([^)]*\)\s*(?:=>|=\s*\()/g)]
    const m = ms[ms.length - 1]
    const body = m ? store2.slice(m.index, m.index + 1200) : ''
    ok(m && /bookMembers/.test(body),
      '接受成功后**本地补一份 bookMembers**（不然点完「接受」左侧还没这个库，像没生效）')
  }
  /*
   * ⚠️ 这两条原来判的是「侧栏入口仍被过滤」+「深链仍被改写」。
   *    那在有真邀请之前是对的（collab 是恒空的假页），
   *    现在那两条都**反过来了** —— 而留着旧断言等于逼着下一个人把门控加回去。
   *
   *    改成守「入口确实渲染、且侧栏那一份确实调 tabVisible（口径没散开）」：
   *    前者是「不再过滤」，后者保证口径机制本身还在 ——
   *    两边各算各的就会出现「内容对了、导航错了」的半截状态。
   */
  ok(/sec\.items\.filter\(\(it\)\s*=>\s*tabVisible\(it\.key\)\)/.test(sidenav),
    '侧栏仍走 tabVisible 过滤（口径机制本身在，只是它现在恒真）')
  ok(/const active = resolveTab\(/.test(sidenav) && /const tab = resolveTab\(/.test(dash),
    'SideNav 高亮与 Dashboard 渲染走同一份 resolveTab（口径没散开）')
}

/* ============================================================
   前端每个 API 调用，都要有服务端真的注册的那条路由
   ------------------------------------------------------------
   一条调不存在的接口 = 一个「点了没反应」的功能，比假按钮更难发现
   （假按钮至少长在界面上；死接口连报错都可能被 .catch 吞掉）。

   ⚠️ 这套提取器调准了三次才可信，每次都是**假结论**（记忆里有同族条目）：
     ① 没剥注释 → `/api/attachment/<id>` 等 5 条全来自**散文注释**，误报 5 个死接口；
     ② 没带方法 → 拿 GET 去打 POST-only 的路由，`/api/auth/login` 等 10 条
        全部 404，误报 10 个；
     ③ 不会处理字符串拼接 → `api.post('/api/doc/' + docId + '/view')`
        被截成 `/api/doc`，误报 1 个（真路由在 server/index.ts:1465）。

   所以下面三条口径一个都不能省：**剥注释 / 带方法 / 拼接还原**。
   ============================================================ */
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  /*
   * 归一化，**顺序不能反**：先处理 `${...}`，再抽字面量。
   *
   * ⚠️ 反过来会切错 `/api/audit${qs ? '?' + qs : ''}` ——
   *   `${}` 里面带着嵌套引号，先抽字面量就会把 `'/api/audit${qs ? '`
   *   和 `'?'` 和 `''` 当三段拼起来，得出 `/api/audit:p`，
   *   而真路由是 `/api/audit` → 误报一个「调不存在的接口」。
   *   （这类误报是审计脚本里最容易发生的一种：它长得和真缺陷一模一样。）
   *
   * `${...}` 含 `?` 的按**查询串**处理整段丢掉（`?limit=…` 那类），
   * 不含 `?` 的当路径参数 → `:p`。
   */
  const normOf = (raw) => {
    const t = raw.replace(/\$\{([^{}]*)\}/g, (_, inner) => (inner.includes('?') ? '' : ':p'))
    const parts = [...t.matchAll(/['"`]([^'"`]*)['"`]/g)].map((m) => m[1])
    if (!parts.length) return ''
    return parts.join(':p').replace(/\?.*$/, '').replace(/\/+$/, '')
  }

  const front = new Map() // 'METHOD PATH' -> 首个来源
  let callSites = 0
  for (const f of walk('src')) {
    const t = strip(fs.readFileSync(f, 'utf8'))
    const grab = (method, at) => {
      // 取参数表达式：从左括号起，按括号配平
      let i = t.indexOf('(', at), d = 0, j = i
      for (; j < t.length; j++) {
        if (t[j] === '(') d++
        else if (t[j] === ')' && --d === 0) break
      }
      const arg = t.slice(i + 1, j)
      const norm = normOf(arg)
      if (!norm.startsWith('/api/')) return
      callSites++
      const key = method + ' ' + norm
      if (!front.has(key)) front.set(key, f)
    }
    for (const m of t.matchAll(/\bapi\.(get|post|del|patch|delete|put)\s*(?:<[^>]*>)?\s*\(/g)) {
      grab({ get: 'GET', post: 'POST', del: 'DELETE', delete: 'DELETE', patch: 'PATCH', put: 'PUT' }[m[1]], m.index)
    }
    for (const m of t.matchAll(/\brequest\s*(?:<[^>]*>)?\s*\(/g)) {
      const mm = /method:\s*['"]([A-Z]+)['"]/.exec(t.slice(m.index, m.index + 220))
      grab(mm ? mm[1] : 'GET', m.index)
    }
  }
  ok(callSites >= 25, `解析出 ${callSites} 处前端 API 调用点（太少说明提取口径坏了）`)
  ok(front.size >= 25, `去重后 ${front.size} 条 (METHOD, PATH)`)

  const back = new Set()
  for (const f of walk('server')) {
    const t = fs.readFileSync(f, 'utf8')
    for (const m of t.matchAll(/\bon\(\s*['"]([A-Z]+)['"]\s*,\s*['"](\/api\/[^'"]*)['"]/g)) {
      back.add(m[1] + ' ' + m[2].replace(/\/+$/, ''))
    }
  }
  ok(back.size >= 50, `解析出服务端 ${back.size} 条已注册路由`)

  const matches = (pat, bPath) => {
    const a = pat.split('/'), b = bPath.split('/')
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] === ':p' || b[i].startsWith(':')) continue
      if (a[i] !== b[i]) return false
    }
    return true
  }
  const orphans = []
  for (const [key, file] of front) {
    const sp = key.indexOf(' ')
    const method = key.slice(0, sp), path = key.slice(sp + 1)
    const hit = [...back].some((b) => {
      const bs = b.indexOf(' ')
      return b.slice(0, bs) === method && matches(path, b.slice(bs + 1))
    })
    if (!hit) orphans.push(`${key}（${file}）`)
  }
  ok(orphans.length === 0,
    `前端没有调用未注册的接口（调不存在的接口 = 一个点了没反应的功能）。对不上：${orphans.join('、') || '无'}`,
    orphans.length ? `${orphans.length} 条` : '')
}

/* ============================================================
   工作台「团队动态」不许是写死的数组
   ------------------------------------------------------------
   2026-10-08 在一个**全新空实例**（users=1 / docs=0）上实测抓到：

     周砚 更新了文档《线上事故复盘集》· 12 分钟前
     陈小满 评论了《五分钟上手语雀》· 1 小时前
     苏晚 新建了知识库《团队手册》· 3 小时前
     林知远 发布了《2025-10 更新日志》· 昨天
     何舟 补充了《性能优化实战》· 昨天

   根因是 Dashboard.tsx 里一个 `feedItems()` **返回字面量数组**，
   对所有人、所有部署形态无条件渲染。

   为什么前几轮审计全漏了（这一条最值得记）：
     · AppData 字段普查 —— 它不是 store 字段，是字面量数组；
     · 接口审计 —— 它不发任何请求；
     · 硬编码数字普查 —— 我只扫「\d+ 篇/个/条」这种形状，
       而这里全是**人名 + 文档名，一个数字都没有**。
   ⇒ 这一类**静态普查覆盖不到**，只能靠真跑一个空实例去看。
      部署验收 test-deploy-acceptance.mjs 第 5 步就是为此加的。

   所以下面这几条不是「防它再犯」的完全网，而是**让回归能被快速看见**：
   真要加演示数据，也得走 seed（本地形态），不能写在组件里。
   ============================================================ */
{
  const fs = await import('node:fs')
  const dash = fs.readFileSync('src/pages/Dashboard.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  ok(!/\bfeedItems\b/.test(dash), '写死的 feedItems() 已经没了')
  ok(/\bbuildFeed\b/.test(dash), '动态流改由 buildFeed() 从真实数据推导')
  /*
   * ⚠️ 光验「buildFeed 存在」不够 —— 破坏对照 2 直接测出：
   *   把它的 `return` 换成写死的数组，守卫照样绿（没有相对时间字面量、
   *   函数名也在），而动态又变回假的了。
   * 所以要钉**它真的在读传进来的数据**：按花括号切出函数体，
   * 断言它遍历了 docs / comments / topics 三类真实来源，并按时间排序。
   */
  /*
   * ⚠️ 按花括号配平切函数体，但**不能**用「函数名之后第一个 `{`」当起点 ——
   * `function buildFeed(src: { docs: … }): FeedItem[] {` 的第一个 `{`
   * 是**参数类型**，不是函数体。第一版就这么写，基准直接是红的。
   * 正确做法：先把**参数列表**的括号配平过去，再找 `{`。
   */
  const bodyOf = (src, name) => {
    const at = src.indexOf(`function ${name}`)
    if (at < 0) return ''
    let p = src.indexOf('(', at), pd = 0, pe = -1
    for (let j = p; j < src.length; j++) {
      if (src[j] === '(') pd++
      else if (src[j] === ')' && --pd === 0) { pe = j; break }
    }
    if (pe < 0) return ''
    const i = src.indexOf('{', pe)
    if (i < 0) return ''
    let d = 0
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') d++
      else if (src[j] === '}' && --d === 0) return src.slice(i + 1, j)
    }
    return ''
  }
  const fb = bodyOf(dash, 'buildFeed')
  ok(fb.length > 0, '能切出 buildFeed 的函数体')
  ok(/Object\.values\(\s*docs/.test(fb) && /Object\.entries\(\s*comments/.test(fb) &&
     /of\s+topics\b/.test(fb),
    'buildFeed 真的遍历了 docs / comments / topics 三类真实数据')
  ok(/\.sort\(/.test(fb) && /b\.at\s*-\s*a\.at/.test(fb),
    'buildFeed 按真实时间戳排序（不是靠写死的顺序）')
  // 字面量相对时间是这条缺陷最强的指纹：真实数据算出来的必须走 timeAgo(ts)
  const fakeTimes = [...dash.matchAll(/['"](?:\d+\s*(?:分钟|小时|天|周|个?月)前|昨天|前天)['"]/g)]
    .map((m) => m[0])
  ok(fakeTimes.length === 0,
    `动态流里没有写死的相对时间（原来有 '12 分钟前' 这类，改完永远是 12 分钟前）：${fakeTimes.join('、') || '无'}`,
    fakeTimes.length ? `${fakeTimes.length} 处` : '')
  // 空态必须写明原因，不能是空白
  ok(/yq-feed-empty/.test(dash), '动态流没有数据时显示写明原因的空态')
}

/* ============================================================
   输入框占位符不许是「一串点」
   ------------------------------------------------------------
   实测踩坑（2026-10-08 部署后用户试登录）：密码框的占位符写着 `••••••`，
   渲染出来和**真填了密码**一模一样。于是把口令填进了「账号」框、
   密码框留空，看到一排点以为已经填好，报「请填写账号与密码」。

   校验本身是对的（空密码就该拒），问题在这个占位符**看起来像已填内容**。
   另外两个占位符（「你的姓名」/「登录名」）都是文字，只有它是点 ——
   唯一容易误认的那个偏偏是它。

   判据：任何 `placeholder` 都不能只由点号组成。
   ============================================================ */
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx$/.test(e.name)) out.push(p)
    }
    return out
  }
  const dotPlaceholders = []
  let total = 0
  for (const f of walk('src')) {
    const t = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of t.matchAll(/placeholder=\{?["'`]([^"'`]*)["'`]\}?/g)) {
      total++
      if (/^[•·\u2022\s]+$/.test(m[1])) dotPlaceholders.push(`${f}: ${m[1]}`)
    }
  }
  ok(total >= 5, `扫到 ${total} 个 placeholder（太少说明扫描口径坏了）`)
  ok(dotPlaceholders.length === 0,
    `没有「一串点」形态的占位符（它看起来和真填了密码一模一样）：${dotPlaceholders.join('、') || '无'}`,
    dotPlaceholders.length ? `${dotPlaceholders.length} 处` : '')
}

/* ============================================================
   品牌：用户可见的地方一律叫「知语」
   ------------------------------------------------------------
   2026-10-09 产品改名 语雀 → 知语。

   ⚠️ **不能全局替换** —— 全项目 365 处「语雀」里，绝大多数是
   **开发者注释里对原产品的事实引用**（「语雀是三板块七 tab」、
   「路径形状照着语雀官方 OpenAPI 写的」）。改掉那些会让注释变成错的。
   本项目本来就是 1:1 复刻语雀，注释里的「语雀」指的是**被复刻的那个**，
   和「我们自己叫什么」是两件事。

   所以判据是：**剥掉注释之后**，代码里剩下的「语雀」必须正好等于
   下面那份白名单 —— 每一条都是「从真实语雀导入 .lakebook」这类
   对**源格式**的说明，是必须保留的。

   白名单空了 → 有该保留的被误删；白名单外的多出来 → 又漏改了一处
   用户可见文案。两个方向都会红。
   ============================================================ */
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  // 剥块注释 + 行注释（行注释的正则要避开 URL 里的 `//`）
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  /*
   * 允许保留的两类，都不是「我们自己叫什么」的问题：
   *   ① 「从真实语雀导入 .lakebook」这类**源格式**说明
   *      （lakebook.ts 的降级提示、Help/Settings 的导入说明）
   *   ② `src/data/seed.ts` —— 演示**数据**（文档标题《五分钟上手语雀》、
   *      正文里对原产品的介绍）。那是内容不是品牌，而且部署实例的
   *      库里已经是这份数据了，改 seed 不会改到已有库。
   *
   * ⚠️ 只排 `seed.ts` 这**一个文件**，不要排整个 `src/data/` ——
   *    破坏对照第 6 条直接测出：把 `src/data/cards.ts` 里的卡片名
   *    （斜杠菜单里**用户可见**）改回「语雀内容」，守卫**不咬** ——
   *    因为 cards.ts 被连坐排除了。
   *    「为了躲开一类误报而顺手放宽扫描范围」很容易把真问题一起放过去。
   */
  const SKIP_FILES = new Set(['src/data/seed.ts'])
  const ALLOW = [
    '这是语雀的', '语雀导出包的', '个语雀结构化内容',
    '从**语雀导入**', '语雀 .lakebook 导入', '层级与语雀一致',
    '语雀的 Lakesheet', '语雀官方 OpenAPI', '导入语雀知识库（.lakebook）',
    '语雀「知识库设置 → 导出」',
    /*
     * 2026-10-18 补的三条。导入整套搬进 ImportDialog.tsx 时一起搬过来的，
     * 都是**第 ① 类**（源格式说明），不是「我们自己叫什么」：
     *   · 选择器里那一项：格式名本身（.lakebook 就是语雀的知识库导出格式）
     *   · 设置页那行：列出支持导入的格式，其中一种叫「语雀知识库」
     *   · 设置页那行：告诉用户**原产品**还支持哪些我们不支持的格式
     *
     * ⚠️ 加白名单必须逐条对准一个具体句子，不能为了过而放宽成「含语雀即放行」。
     * 下面那条「白名单没有陈旧条目」的断言就是防这个的：
     * 加了没人匹配的条目它会红，而把整个文件排掉它会红（破坏对照第 6 条测过）。
     */
    "name: '语雀知识库'", '语雀知识库与本系统的数据包', '语雀还支持 Word 老格式',
  ]

  const stray = []
  let scanned = 0
  for (const f of walk('src')) {
    const rel = path.relative('.', f).replace(/\\/g, '/')
    if (SKIP_FILES.has(rel)) continue
    const t = strip(fs.readFileSync(f, 'utf8'))
    for (const m of t.matchAll(/[^\n]{0,60}语雀[^\n]{0,60}/g)) {
      scanned++
      const line = m[0]
      if (!ALLOW.some((a) => line.includes(a))) {
        stray.push(`${rel}: …${line.trim()}…`)
      }
    }
  }
  ok(scanned > 0, `剥注释后（仅排 seed.ts）在 src 里扫到 ${scanned} 处「语雀」（全 0 说明剥离口径坏了）`)
  ok(stray.length === 0,
    `用户可见的地方没有残留的旧品牌「语雀」（应只剩「从语雀导入」这类对源格式的说明）：${stray.slice(0, 4).join(' / ') || '无'}`,
    stray.length ? `${stray.length} 处` : '')

  // 白名单本身也不能有陈旧条目（那条说明被删了却还留着豁免）
  const corpus = walk('src').map((f) => strip(fs.readFileSync(f, 'utf8'))).join('\n')
  const stale = ALLOW.filter((a) => !corpus.includes(a))
  ok(stale.length === 0, `白名单没有陈旧条目：${stale.join('、') || '无'}`)

  /* 品牌本体：这几处必须叫「知语」 */
  const html = fs.readFileSync('index.html', 'utf8')
  ok(/<title>[^<]*知语/.test(html) && !/<title>[^<]*语雀/.test(html),
    '浏览器标签页标题是「知语」')
  const appGate = fs.readFileSync('src/components/AppGate.tsx', 'utf8')
  const logos = [...appGate.matchAll(/className="yq-(?:login|boot)-logo">([^<]*)</g)].map((m) => m[1])
  ok(logos.length === 3 && logos.every((t) => t === '知语'),
    `启动页 / 断线页 / 登录页三处 logo 都是「知语」（实得 ${JSON.stringify(logos)}）`)
  const topbar = fs.readFileSync('src/components/layout/TopBar.tsx', 'utf8')
  ok(/className="yq-logo-text">知语</.test(topbar), '顶栏 logo 文字是「知语」')
  const pub = fs.readFileSync('src/pages/PublicDoc.tsx', 'utf8')
  ok(/yq-public-brand">知语 · 对外分享</.test(pub), '对外分享页的页脚品牌是「知语」')
  const srv = fs.readFileSync('server/index.ts', 'utf8')
  ok(/\[server\] 知语知识库已启动/.test(srv), '服务端启动日志是「知语知识库已启动」')
}

/* ============================================================
   新建文稿必须挂在「明确的父节点」上，不能挂「第一个根节点」
   ------------------------------------------------------------
   实例（2026-10-09 部署实例上用户发现）：

     知识库「新知识库」
       └ 未命名
           └ 未命名
               └ 未命名

   根因是 `BookIndex` 和 `TopBar` 的新建入口都这么写：

     const first = roots[0]                       // 或 nodes.find(...parentId===null)
     createDoc(bookId, first?.id ?? null, '未命名', 'doc')

   那一页的目录是**扁平列表 + 拖拽排序**，根本没有「当前选中目录」的概念，
   所以 `roots[0]` 是凭空抓的：点一次挂到 roots[0] 下，再点一次 roots[0] 还是
   同一个 —— 于是每点一次就多套一层。
   在**有分组目录**的库里更隐蔽：新建的不是出现在根，而是被塞进第一个分组。

   正确做法挂根（`null`）。同一产品里本来就有对的实现：
   `Tree.tsx` 底部「新建文档」= `createNode(bookId, null, 'doc')`，
   hover/右键「在此新建文档」= `createNode(bookId, node.id, …)`。

   判据：剥注释后，任何 `createDoc(` 的实参里都不能出现 `[0]` 或 `.find(`
   —— 父节点要么是 `null`，要么是明确的当前节点变量。
   ============================================================ */
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const bad = []
  let sites = 0
  for (const f of walk('src')) {
    const t = strip(fs.readFileSync(f, 'utf8'))
    for (const m of t.matchAll(/createDoc\s*\(/g)) {
      const arg = t.slice(m.index, m.index + 160)
      sites++
      // 第二个实参才是 parentId；整段里出现「取第一个」就是问题
      if (/\[0\]|\.find\s*\(/.test(arg)) {
        bad.push(`${path.relative('.', f)}: ${arg.slice(0, 90).replace(/\s+/g, ' ')}`)
      }
    }
  }
  ok(sites >= 5, `扫到 ${sites} 处 createDoc 调用点（太少说明扫描口径坏了）`)
  ok(bad.length === 0,
    `新建文稿没有挂在「第一个根节点」上（那会点一次套一层）：${bad.join(' / ') || '无'}`,
    bad.length ? `${bad.length} 处` : '')
}

/* ============================================================
   目录树：任何「有子项」的节点都必须能展开
   ------------------------------------------------------------
   实例（2026-10-09 部署实例，用户直接发现「看不到新建的文件」）：

     「源子科技产品手册」下面被建了 6 篇「未命名」，目录树里一篇都看不到。

   根因是三处各自为政：
     · 子项渲染条件是 `isOpen && children.length > 0`；
     · `isOpen` 只能靠 `toggle(node.id)` 变成 true；
     · 而 `toggle` 只挂在 **`node.type === 'group'`** 的那个箭头上 ——
       文档节点给的是 `.yq-tree-caret-ph` 占位，不可点；
       onClick 里对非 group 是「导航到文档」。

   而造子项的路有三条，对**文档节点也生效**：
     · hover 的 ＋「新建子项」= `createNode(bookId, node.id, 'doc')`（不判 type）
     · 拖拽 `pos === 'inside'`
     · （右键菜单那两项只对 group 开放，不算）
   建完还 `setExpanded` 了，所以**只有刷新前那一瞬间看得见** ——
   `expanded` 是内存 useState，刷新就清空，之后永久不可见。

   这不是「显示不好看」，是**数据在、界面不可达**。

   判据：展开箭头的条件必须是「分组 **或** 有子项」，不能只看 type。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const tree = strip(fs.readFileSync('src/components/doc/Tree.tsx', 'utf8'))

  ok(/const canExpand = node\.type === 'group' \|\| children\.length > 0/.test(tree),
    '目录树算出了 canExpand（分组或有子项都能展开）')
  // 箭头必须由 canExpand 决定，而不是只看 type
  ok(/\{canExpand \? \(/.test(tree), '展开箭头由 canExpand 决定（不再只给分组）')
  // 占位箭头只能是「不能展开」时的兜底
  ok(/canExpand[\s\S]{0,600}yq-tree-caret-ph/.test(tree),
    '不可展开时才渲染占位箭头')
  // 点击展开的那份箭头必须真的 toggle
  ok(/canExpand[\s\S]{0,600}onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggle\(node\.id\) \}\}/.test(tree),
    '箭头点击真的调用 toggle（否则箭头画出来也点不动）')
  // 建完子项要展开（右键菜单那份 NodeMenu 以前拿不到树的 state）
  ok(/onCreate\?\.\(node\.id\)/.test(tree) && (tree.match(/onCreate=\{\(id\) => setExpanded/g) || []).length === 2,
    '两处 NodeMenu 都接了 onCreate，建完子项会展开那一支')
}

/* ============================================================
   activeSpaceId 不能指向不存在的空间 —— 全新部署里建库会静默失败
   ------------------------------------------------------------
   实例（2026-10-09，一次性空实例 users=1 / docs=0 实测）：

   工作台「＋ 新建知识库」→ 界面上出现了 → **刷新后消失**。

   根因：store 里 `activeSpaceId` 的默认值是**种子里的 `'s1'`**
   （index.ts 的初始 state 和 clearLocalSnapshot 各写了一次）。
   服务端形态下那个空间通常不存在 —— 全新部署只有注册时自动建的
   个人空间 `sp_<userId>`。于是：

     createBook('s1', …) → book.spaceId 是**悬空外键**
       → 服务端逐条判定：rejected: [{ entity:'books',
                                    reason:'FOREIGN KEY constraint failed' }]
       → 而 push 返回 **HTTP 200**，客户端**不看 rejected**
       → 「建好了」但什么都没存下来。

   显示层有兜底（`spaces.find(s => s.id === activeSpaceId) || spaces[0]`），
   所以界面看着完全正常 —— 只有写操作会把坏 id 递出去，最难查。

   ⚠️ `test-deploy-acceptance.mjs` 第 4 步「空库里普通成员能建出第一条知识库」
   之所以没抓到：它走的是 **API 路径**（先 `POST /api/spaces` 建空间，
   再拿返回的真 id 去 push），绕开了界面这条默认悬空 id 的路。

   判据：hydrate 时必须校正 activeSpaceId；createBook 也必须兜底。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const store = strip(fs.readFileSync('src/store/index.ts', 'utf8'))

  ok(!/activeSpaceId:\s*'s1'/.test(store) ||
     /hydrate[\s\S]{0,2000}spaces\.some\(\(s\) => s\.id === cur\)/.test(store),
    'hydrate 会校正 activeSpaceId（不让它停在种子的 s1 上）')
  ok(/const realSpaceId = spaces\.some\(\(sp\) => sp\.id === spaceId\)/.test(store),
    'createBook 对不存在的 spaceId 有兜底（改用第一个真实空间）')
  ok(/return get\(\)\.books\.some\(\(b\) => b\.id === id\) \? id : ''/.test(store),
    '一个空间都没有时 createBook 返回空串，而不是返回一个根本没建出来的 id')

  /*
   * 这里**不**要求界面代码去自己解析空间 —— 那会把同一套逻辑抄成三份。
   * 真正的约束是：所有建库都必须**过 store.createBook** 这一个关口，
   * 由它统一兜底（上面两条判据钉的就是它）。
   * 所以判据改成「没有界面文件绕过 createBook 直接推 books 行」。
   */
  const uiPush = []
  for (const f of ['src/pages/Dashboard.tsx', 'src/components/layout/TopBar.tsx',
                   'src/pages/BookIndex.tsx', 'src/pages/Space.tsx']) {
    const t = strip(fs.readFileSync(f, 'utf8'))
    if (/pushChanges\([^)]*books/.test(t) || /books:\s*\[/.test(t)) uiPush.push(f)
  }
  ok(uiPush.length === 0,
    `界面建库都走 store.createBook 这个统一关口（绕过它的：${uiPush.join('、') || '无'}）`)
}

/* ============================================================
   回收站记录必须带 bookId —— 少了就是「删了但找不回来」
   ------------------------------------------------------------
   实例（2026-10-09 部署实例实测）：
     库里 `trash` 有 17 行，`bookId` **全是 NULL**；
     `/api/bootstrap` 返回 0 条；
     而 `docs.trashed = 1` 的正好也是这 17 行 —— **正文还在库里**。

   也就是说：这些文档「删掉了、界面上看不见、也恢复不了」，
   卡在一个谁都没法收拾的中间态。查起来极像「数据丢了」。

   同一个文件里 `deleteDoc` 早就写了这句注释
   （「服务端靠它判权限，缺了这条回收站记录对非管理员就是不可见的」），
   说明这个问题被发现过、修了一条路径，**漏了另一条**：
   `deleteNode`（目录树删除）生成的记录里没有 bookId。

   判据：两条删除路径生成的 trash 行都必须带 bookId，
   而且必须走**同一个**解析函数 —— 同一份逻辑抄两遍就是这个 bug 的成因。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const store = strip(fs.readFileSync('src/store/index.ts', 'utf8'))

  ok(/function bookIdOfDoc\(s: Store, docId: string\)/.test(store),
    '有一个统一的 bookId 解析函数（不把同一份逻辑抄两遍）')

  // deleteDoc 那条
  ok(/trash:\s*\[\.\.\.s\.trash,\s*\{\s*docId,\s*title:\s*d\.title,\s*bookId,\s*deletedAt/.test(store),
    'deleteDoc 生成的回收站记录带 bookId')
  // deleteNode 那条
  ok(/bookId:\s*bookIdOf\(d\.id\)/.test(store),
    'deleteNode 生成的回收站记录也带 bookId ← 这条以前漏了')

  // 反向：任何 trash 行都不能是「只有 docId/title/deletedAt」的形状
  const trashShapes = [...store.matchAll(/(\{\s*docId:[^}]*deletedAt[^}]*\})/g)].map((m) => m[1])
  const noBook = trashShapes.filter((s) => !/bookId/.test(s))
  ok(noBook.length === 0,
    `没有「缺 bookId」的回收站行（缺了服务端就按权限滤掉，等于删了找不回）：${noBook.join(' / ') || '无'}`,
    noBook.length ? `${noBook.length} 处` : '')

  ok((store.match(/bookIdOfDoc\(/g) || []).length >= 3,
    'bookIdOfDoc 确实被两条删除路径共用')
}

/* ============================================================
   登出：要么有按钮，要么就别承诺
   ------------------------------------------------------------
   实例（2026-10-09 用户直接问「怎么退出登录」才暴露出来）：

     · `logout()`（lib/api.ts）**从写下来那天起就没被任何地方引用过** ——
       一个只有实现、没有入口的函数；
     · 头像下拉里只有 账户设置 / 回收站 / 重置演示数据 / 切换身份（演示），
       **没有任何地方能登出**；
     · 而设置页「登录设备」里当前设备那一行白纸黑字写着
       「要下线这台请用『退出登录』」—— 指向一个不存在的按钮。

   后果不只是少个按钮：用户只能手动清 localStorage，
   而服务端那条会话还活着（令牌没销毁）——
   在内网部署里，「下班了登出」做不到是很实际的问题。

   判据：① logout 必须真的被 TopBar 用上；② 菜单里必须有「退出登录」；
        ③ 它必须调服务端接口销毁会话，而不是只清本地。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const topbar = strip(fs.readFileSync('src/components/layout/TopBar.tsx', 'utf8'))

  ok(/import\s*\{[^}]*\blogout\b[^}]*\}\s*from\s*['"]@\/lib\/api['"]/.test(topbar),
    'TopBar 真的引入了 logout（以前这个函数从写下来起就没被引用过）')
  ok(/退出登录/.test(topbar), '头像菜单里有「退出登录」')
  ok(/onClick=\{async \(\) =>[\s\S]{0,400}await logout\(\)/.test(topbar),
    '点「退出登录」会调 logout() —— 服务端会话被销毁，不是只清本地')
  ok(/await logout\(\)[\s\S]{0,200}window\.location\.reload\(\)/.test(topbar),
    '登出后重载页面（让 AppGate 走完整启动流程回到登录页）')

  // 设置页承诺的那句话，现在指向的是真按钮
  const settings = fs.readFileSync('src/pages/Settings.tsx', 'utf8')
  ok(!/要下线这台请用「退出登录」/.test(settings) || /退出登录/.test(topbar),
    '设置页说的「退出登录」现在真的存在（它以前指向一个不存在的按钮）')

  /*
   * 演示专属控件必须**在每一个出现的地方**都门控。
   *
   * 这一轮栽的就是它：「演示身份切换」上一轮只在设置页门控了，
   * 而**顶栏头像菜单里还有自己的一份**，没动。
   * 同一个演示功能写了两遍、修了一遍 —— 和 `deleteDoc` / `deleteNode`
   * （一条修好一条漏）是同一个形状：**同一份逻辑抄两处，就会漏一处。**
   *
   * 所以下面按「出现位置」逐个钉，而不是钉「有没有 getMode 字样」。
   */
  const gateCount = (src, needle) => {
    const at = src.indexOf(needle)
    if (at < 0) return { found: false, gated: false }
    const before = src.slice(Math.max(0, at - 320), at)
    return { found: true, gated: /getMode\(\)\s*!==\s*'server'/.test(before) }
  }
  const cases = [
    ['顶栏·重置演示数据', topbar, '重置演示数据'],
    ['设置页·重置演示数据', strip(settings), '重置演示数据'],
    ['顶栏·切换身份（演示）', topbar, '切换身份（演示）'],
    ['设置页·演示身份切换', strip(settings), '演示身份切换'],
  ]
  for (const [label, src, needle] of cases) {
    const g = gateCount(src, needle)
    ok(g.found && g.gated,
      `${label}：要么不存在，要么被 getMode() 门控（演示专属控件不能出现在部署实例上）`,
      g.found && !g.gated ? '出现了但没门控' : '')
  }
}

/* ============================================================
   目录树「···」菜单要覆盖语雀的那几项（2026-10-09 用户给了官方截图）
   ------------------------------------------------------------
   官方语雀的目录树节点菜单（对照截图）：
     重命名 / 编辑文档 / 复制链接 / 在新标签页打开 / 移出目录 /
     复制… / 移动… / 导出… / 置顶文档 / 删除

   我们原来只有：打开 / 重命名 / 在此新建文档 / 在此新建分组 /
                  收藏 / 复制标题 / 删除
   —— 也就是「复制链接」「在新标签页打开」「移出目录」「复制…」「移动…」
   这 5 项**一个都没有**，其中「复制…/移动…」的**能力其实早就有**
   （服务端 `moveDoc(docId, bookId, mode)` 支持 move|copy，
     DocPage 里也有完整弹窗），只是没接到目录树上。

   已补齐前 5 项。剩下两项的处理：
     · 导出… —— 能力在 DocPage 的导出菜单（整包 / 单篇导出），
       目录树上不重复放一个入口，避免同一功能两个地方口径分叉；
     · 置顶文档 —— 本项目**连字段都没有**（nodes 表没有 pinned），
       属于要改表的新功能，不在这次「对齐菜单」范围内，如实记下来。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const tree = strip(fs.readFileSync('src/components/doc/Tree.tsx', 'utf8'))

  // 菜单里这一段（NodeMenu 的 children）
  const menuAt = tree.indexOf('function NodeMenu')
  ok(menuAt > 0, '找得到 NodeMenu')
  const menu = menuAt > 0 ? tree.slice(menuAt, menuAt + 6000) : ''

  const MUST = ['编辑文档', '复制链接', '在新标签页打开', '移出目录', '复制…', '移动…', '重命名', '删除']
  const missing = MUST.filter((m) => !menu.includes(m))
  ok(missing.length === 0,
    `目录树「···」覆盖了语雀的那几项（缺：${missing.join('、') || '无'}）`)

  // 「移出目录」必须真的调用 moveNode 到根，不能是个摆设
  ok(/moveNode\(node\.id, null,/.test(tree), '「移出目录」真的把节点提到根（moveNode(node.id, null, …)）')
  /*
   * 而且只在有父节点时才出现。
   *
   * ⚠️ 这条原来写的是 `/\{node\.parentId && \(/` —— 死盯住
   * 「`{node.parentId && (`」这**一串字面量**。2026-10-12 给菜单接上权限判据，
   * 条件变成 `{node.parentId && canEdit && (`，判据当场红了，而**代码是对的**。
   *
   * 教训和 `test-lint` 那次一样：判据盯的是「写法」而不是「这件事」。
   * 所以这里放宽成「`node.parentId` 后面跟什么都行，中间那层条件不许出现花括号」——
   * 仍然钉住「有父节点才出现」这件事，但不再因为多一个 `&&` 就误报。
   */
  ok(/\{node\.parentId &&[^{}]*\{[\s\S]{0,400}移出目录/.test(tree), '「移出目录」只在确实有父节点时出现')
  // 而 2026-10-12 起它还必须**同时**看编辑权：阅读者点了同样会被服务端拒
  ok(/\{node\.parentId && canEdit &&/.test(tree),
    '「移出目录」也要看编辑权（阅读者点了会被服务端拒，而本地已经改了）')

  // 「复制…」/「移动…」必须走共享弹窗，不能各自实现一遍
  ok(/<MoveDocDialog/.test(tree), '目录树的移动/复制复用 @/components/doc/MoveDocDialog')
  const dlg = fs.readFileSync('src/components/doc/MoveDocDialog.tsx', 'utf8')
  const dp = fs.readFileSync('src/pages/DocPage.tsx', 'utf8')
  ok((dlg.match(/<Modal/g) || []).length === 1, '共享弹窗里只有一份 Modal（不是抄了两遍）')
  ok(/import MoveDocDialog from/.test(dp) && /<MoveDocDialog/.test(dp),
    'DocPage 也换成同一个组件了（两处同源，不会分叉）')
  ok(!/title="移动 \/ 复制文档"/.test(strip(dp)),
    'DocPage 里不再内联那份弹窗（避免同一份逻辑两处）')
}

/* ============================================================
   目录树标题必须跟着 doc.title 走 —— 三个写入点一个都不能少
   ------------------------------------------------------------
   2026-10-10 实测（部署实例，用户报「输入 SSSSSS 上面的标题也改了」时顺带发现）：
     文档栏 = "aBcDeF ssssss SSSSSS"   ✅
     正文  = "aBcDeF ssssss SSSSSS"   ✅
     目录树 = "未命名"                  ❌
   也就是同事在目录里看到的标题永远是「未命名」，除非双击手动改一次。

   根因：语雀的「标题 = 第一个 H1 块」是**一份数据**，我们把它拆成了
   `docs.title` 和 `nodes.title` 两个字段。以前只有**非文档型**文稿那条路径
   会两边都改（DocPage.handleTitle → updateDoc + renameNode），
   文档型走 setDocBlocks → applyDerivedTitle，只改 docs 一边。
   和这个项目反复栽的「三份实现」是同一族。

   三个写入点：本地编辑 / 协作合并 / 版本回滚。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const store = strip(fs.readFileSync('src/store/index.ts', 'utf8'))

  ok(/const syncNodeTitle = \(s: Store, docId: string, title: string\)/.test(store),
    '有一个统一的「节点标题跟着 doc.title 走」函数（不把同一份逻辑抄三遍）')

  for (const w of ['setDocBlocks:', 'setDocBlocksRemote:', 'restoreDocVersion:']) {
    /*
     * ⚠️ 必须取**最后一次**匹配：这些名字在 Store 的 interface 里也声明了一次
     * （`setDocBlocks: (docId, blocks) => void`），`indexOf` 会命中**声明**，
     * 而实现里那句 syncNodeTitle 根本不在那一段里 —— 于是断言恒红，
     * 看起来像「修复没生效」，其实是判据抓错了位置。
     * 和之前那条 `exec` 只返回第一个匹配是同一个坑。
     */
    const ats = [...store.matchAll(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    ok(ats.length >= 2, `「${w.replace(':', '')}」至少有声明+实现两处（实得 ${ats.length}）`)
    const at = ats.length ? ats[ats.length - 1].index : -1
    ok(at > 0, `找得到写入点 ${w.replace(':', '')}`)
    if (at < 0) continue
    const body = store.slice(at, at + 1800)
    ok(/syncNodeTitle\(s, docId, next\.title\)/.test(body),
      `${w.replace(':', '')} 会同步目录节点标题（漏一个就有一条路径留下旧标题）`)
  }
}

/* ============================================================
   db.exec 的模板字符串里，注释中不能出现反引号
   ------------------------------------------------------------
   2026-10-10 实际踩了两次：注释里写了带反引号的两处代码，
   反引号把模板字符串提前结束 → **服务端直接起不来**，
   报 ERR_INVALID_TYPESCRIPT_SYNTAX，而**报错位置在一条注释行上**、
   满屏乱码 —— 极难联想到是反引号。而且 **tsc 完全没抓到**。

   db.ts 第 175 行本来写着这条规矩，我看了还是踩了。
   所以判据直接扫模板字符串体内有没有反引号。
   ============================================================ */
{
  const fs = await import('node:fs')
  const db = fs.readFileSync('server/db.ts', 'utf8')
  const bodies = [...db.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)].map((m) => m[1])
  ok(bodies.length > 0, `扫到 ${bodies.length} 处 db.exec 模板字符串`)
  const bad = bodies.map((b, i) => ({ i, has: b.includes('`') })).filter((x) => x.has)
  ok(bad.length === 0,
    'db.exec 的模板字符串里没有反引号（注释里写一个就服务端起不来，报错还指向注释行）',
    bad.length ? `第 ${bad.map((x) => x.i + 1).join('、')} 处含反引号` : '')
}

/* ============================================================
   工作台文档区：四视图 + 三维筛选（对照官方语雀工作台补齐，2026-10-10）
   ------------------------------------------------------------
   语雀那一块是：编辑过 / 浏览过 / 我点赞的 / 我评论过
              + 筛选：类型 / 归属 / 创建者
   我们原来只有「最近编辑 + 今天/本周/本月」——后者语雀没有。

   ⚠️ 这里最要紧的一条是**空态文案必须每个视图各不相同**：
   「没人评论过」如果显示成「你还没有编辑过文档」，
   那就是拿别的视图的数据冒充 —— 和之前那些「假数字」同一个病。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const dash = strip(fs.readFileSync('src/pages/Dashboard.tsx', 'utf8'))

  // 四个视图的标签一个都不能少（与语雀逐字对齐）
  for (const v of ['编辑过', '浏览过', '我点赞的', '我评论过']) {
    ok(dash.includes(`'${v}'`), `视图「${v}」在`)
  }
  // 每个视图都必须有**自己的数据判据**，不是都落到同一个集合
  ok(/if \(v === 'edited'\) return allDocs\.filter\(\(d\) => d\.authorId ===/.test(dash),
    '「编辑过」按 doc.authorId === 我 过滤')
  ok(/if \(v === 'viewed'\) return \(recents \|\| \[\]\)/.test(dash),
    '「浏览过」取的是 recents（真实最近访问）')
  ok(/if \(v === 'liked'\) return allDocs\.filter\(\(d\) => Array\.isArray\(d\.likes\)/.test(dash),
    '「我点赞的」按 doc.likes 过滤（不是拿点赞数假数据）')
  ok(/for \(const \[docId, list\] of Object\.entries\(comments \|\| \{\}\)\)/.test(dash),
    '「我评论过」扫的是 comments 里 authorId === 我')

  // 三个筛选
  for (const [key, label] of [['fType', '类型'], ['fBook', '归属'], ['fAuthor', '创建者']]) {
    ok(dash.includes(`const [${key}, set${key[0].toUpperCase() + key.slice(1)}]`),
      `有「${label}」筛选维度`)
  }
  // 筛选的候选集必须来自**当前视图**，不能来自全库
  ok(/const candidates = baseOf\(view\)/.test(dash),
    '筛选项取自当前视图的候选集（用全库的话会出现「筛完必为空」）')

  // 空态文案：四条，且互不相同
  const em = /EMPTY_TEXT: Record<DocView, string> = \{([\s\S]*?)\n  \}/.exec(dash)
  ok(!!em, '有按视图区分的空态文案表')
  if (em) {
    const texts = [...em[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    ok(texts.length === 4, `四个视图各有空态文案（实得 ${texts.length} 条）`)
    ok(new Set(texts).size === texts.length,
      `四条空态文案互不相同（都在拿同一句话顶替 = 编造）：${texts.join(' / ')}`)
  }

  // 每行是「作者 · 归属库 · 时间」三段（语雀形态）
  ok(/<span>\{author\?\.name \|\| '未知'\}<\/span>[\s\S]{0,200}\{book\?\.name \|\| '未归档'\}[\s\S]{0,200}\{timeAgo\(stampOf/.test(dash),
    '文档行显示「作者 / 归属库 / 时间」三段')
}

/* ============================================================
   「新建文档后随手写点东西，结果全写进了标题」
   ------------------------------------------------------------
   2026-10-10 用户在页面上实测报上来的一条。根因是**三条规则叠在一起**，
   每一条单独看都合理：

     · 新建一篇文档**只有一个**块 —— 空的 h1，而它就是文档标题
       （store 的 `applyDerivedTitle`：标题 = 第一个 h1）；
     · 编辑器末尾的「继续输入区」规则是「末尾是空块就把光标送过去」；
     · 那一大片还顶着 **「输入 '/' 插入卡片」**，看着就是正文编辑区。

   叠起来就成了「点正文空白 → 光标跳回标题 → 敲什么什么变标题」。
   语雀那边标题下面本来就有正文行，点空白进的是正文。

   行为由 `test-bodyfresh` 的第 ④ 组在真浏览器里验（建独立文档、
   点空白 → 断言多出一个段落 → 打字 → 断言标题没被改）。
   这里钉的是**结构**：判据要钉「按 index 和 type 分支」，
   而不是钉「文件里出现过未命名」—— 那是存在性断言，改个注释就绿。
   ============================================================ */
{
  const fs = await import('node:fs')
  /* 判据必须剥注释：这几条里有几条是「**没有**某种写法」的反向断言，
     而我自己的说明注释里就写着那个词（`[data-block-id]`）—— 不剥就恒红。 */
  const ed = fs.readFileSync('src/components/doc/Editor.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  ok(/data-placeholder=\{p\.index === 0 && block\.type === 'h1' \? '未命名' : "输入 '\/' 插入卡片"\}/.test(ed),
    '标题块（index 0 的 h1）的占位符与正文块分开')

  ok(!/data-placeholder="输入 '\/' 插入卡片"/.test(ed),
    '没有「所有块共用一句正文占位符」的写法（那正是标题被当成正文的入口）')

  const tailAt = ed.indexOf('className="yq-editor-tail"')
  ok(tailAt > 0, '找得到末尾继续输入区')
  if (tailAt > 0) {
    const body = ed.slice(tailAt, tailAt + 1600)
    ok(/const titleOnly = blocks\.length === 1 && last\?\.type === 'h1' && !last\.text/.test(body),
      '末尾继续输入区认得「整篇只有一个空标题块」这种状态')
    ok(/!last\.text && !titleOnly/.test(body),
      '空标题块**不**走「把光标送回空块」那条路（那正是标题被改的机制）')
    ok(/blocks\.length === 1/.test(body),
      '条件里钉死了 `blocks.length === 1`（放宽成「首个块是空 h1」会给已有正文的文档硬塞一个段落）')

    /*
     * 破坏对照实测出来的第二个缺陷：老代码对 `[data-block-id]` 那个**包装 div**
     * 调 focus —— 它不是 contentEditable，光标压根落不下去，
     * 于是「点末尾空白处」**一点反应都没有**（测试里那条「标题没被改」当时是假绿）。
     * 正确做法是走共用的 `focusBlock`，它会找里面那个 `.yq-block-text`。
     */
    ok(/focusBlock\(last\.id\)/.test(body),
      '末尾继续输入区用共用的 `focusBlock` 聚焦（对包装 div focus 是空操作）')
    ok(!/querySelector<[^>]*>\(`\[data-block-id=/.test(body),
      '这里没有自己再查一遍块包装层（自己查就容易查成包装 div 而不是可编辑的那个）')
  }
}

/* ============================================================
   模板中心的「已用 N 次」是从别处抄来的常量
   ------------------------------------------------------------
   2026-10-10 走查模板中心时看到的：官方模板写着
   **已用 18420 次 / 12360 / 9870 / 4230 / 7650 / 2140 / 3380 / 5610**
   ——而这个部署是**公司内网、刚部署、没人用过任何一个模板**。

   和之前修过的几处是同一族：
     · 工作台「团队动态」写死 7 条虚构的人 + 4 篇不存在的文档
     · 侧栏「文档 8」写死
     · 统计页的近 14 天趋势用 lcg() 伪随机
   共同点是：**界面在展示一个它并不掌握的数据**，
   而且长得完全正常 —— 不报错、不置灰、点进去也是真的。

   为什么这个比「数字不好看」严重：它是**社会认同**。
   同事看到「18420 次」会以为「大家都用这个」，
   于是选模板时优先挑「热度高」的 —— 选错的依据是编出来的。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /*
   * 判据必须扫**服务端那份种子**也要扫 —— 前端清零了、
   * 服务端 `server/seed.ts` 照样插 18420 的话，部署实例上照样显示 18420。
   * 两份种子是这个项目的常态（「同一份概念两份副本」的老形状）。
   */
  for (const f of ['src/data/settings.ts', 'server/seed.ts']) {
    const raw = fs.readFileSync(f, 'utf8')
    // 只认模板构造函数的实参位置：'official' / 'team' / 'book' 后面跟的数字
    const hits = [...strip(raw).matchAll(/'(official|team|book)',\s*(\d+)\s*,/g)]
      .filter((m) => Number(m[2]) !== 0)
      .map((m) => m[0])
    ok(hits.length === 0, `${f} 里没有写死的模板使用次数`,
      hits.length ? `还剩 ${hits.length} 处：${hits.join('、')}` : '')
  }

  const tpl = fs.readFileSync('src/pages/Templates.tsx', 'utf8')
  ok(/\{t\.usedCount > 0 && <span className="yq-tpl-item-used">/.test(tpl),
    '列表里 0 次不显示（没东西可说的时候干脆不说，而不是摆一个「已用 0 次」）')
  ok(/\{selected\.usedCount > 0 && \(/.test(tpl), '预览面板里同样 0 次不显示')

  /*
   * 反向钉：不能把功能一起删掉。
   * 「真实使用次数」是从 0 长出来的，所以**必须有人 +1**，
   * 否则改完就变成「永远 0 次」，一样是界面在讲假话（只不过方向相反）。
   */
  const store = strip(fs.readFileSync('src/store/index.ts', 'utf8'))
  /*
   * ⚠️⚠️ 必须取**最后一次**匹配：`applyTemplate:` 在 Store 的 interface 里
   *   也声明了一次，`indexOf` 会命中那条声明 —— 而实现里那句 `usedCount` 根本
   *   不在那段里，于是断言恒红，看起来像「修复没生效」，其实是判据抓错了位置。
   *   和这个项目里 `setDocBlocks:` / `exec` 那两次同一个坑。
   */
  const ats = [...store.matchAll(/applyTemplate:/g)]
  const at = ats.length ? ats[ats.length - 1].index : -1
  ok(at > 0, `store 里有 applyTemplate 的实现（共 ${ats.length} 处同名，取最后一次）`)
  if (at > 0) {
    const fn = store.slice(at, at + 1600)
    ok(/usedCount:\s*\w+\.usedCount \+ 1/.test(fn),
      '**真的用一次就 +1**（否则清零之后永远是 0，又成了另一种假话）',
      JSON.stringify((fn.match(/usedCount[^\n]*/g) || []).slice(0, 2)))
  }
}

/* ============================================================
   同步：`flush()` 撞上「推送还在飞」时静默丢数据
   ------------------------------------------------------------
   2026-10-10 在真实部署实例上撞到的：把标题敲成「部署第一天」，
   重启后**文档标题对、目录树标题停在「部署第一」**。查下来服务端两行分叉，
   原因不是 diff、不是权限、不是 rev 冲突，而是客户端这一行：

   ```js
   export async function flush() {
     if (pushing) return        // ← 撞上在飞的推送，直接返回
     ...
   } finally {
     pushing = false            // ← 没有「pending 还非空就再排一次」
   }
   ```

   于是：连着打字时，防抖到点的 `flush()` 撞上上一轮推送 → 返回 →
   `pending` 里那批行**没有排下一次** → 它们要等**下一次本地改动**才被推走 →
   而用户改完就停手了。**「最后那一改」在服务端就是没有的。**

   而 `pagehide` 的兜底 `flush()` **恰恰在最需要它的时刻失效** ——
   页面正在关闭，上一次推送几乎必然还在飞。

   ⚠️ 这里是**结构断言**不是行为断言：行为依赖真实网络时序，
   写出来必然是偶发红（那种红比没有守卫更糟）。
   判据钉的是「**真的会补排**」这两处代码形状。
   ============================================================ */
{
  const fs = await import('node:fs')
  const sync = fs.readFileSync('src/lib/sync.ts', 'utf8')
  const at = sync.indexOf('export async function flush(')
  ok(at > 0, '找得到 flush()')
  if (at > 0) {
    const end = sync.indexOf('\n}\n', at)
    const fn = sync.slice(at, end > 0 ? end : at + 4000)

    ok(!/^\s*if \(pushing\) return\s*$/m.test(fn),
      '**`if (pushing) return` 那句裸返回已经没有了**（它就是静默丢数据的那一行）')

    ok(/if \(pushing\) \{[\s\S]{0,200}setTimeout\(/.test(fn),
      '撞上「推送还在飞」时**排一次补推**，而不是丢掉')

    const fin = /finally \{([\s\S]*?)\n  \}/.exec(fn)
    ok(!!fin, 'flush() 里有 finally 块')
    if (fin) {
      ok(/pushing = false/.test(fin[1]), 'finally 里把 pushing 放回 false')
      ok(/setTimeout\(/.test(fin[1]) && /pending\.upsert/.test(fin[1]),
        '**finally 里若 pending 还非空就续推一次**（飞行期间攒下的增量不能靠下一次本地改动带出去）')
    }
  }
}

/* ============================================================
   `nodes.title` 是文档标题的**冗余副本**，历史数据已经分叉过
   ------------------------------------------------------------
   2026-10-10 在真实部署实例上实测：文档标题「部署第一天」、
   目录树「部署第一」—— 两张表真的分叉了，而且**不会自愈**，
   因为库里错的那一行为 nobody 会再去写它。

   修法是在**读**的时候以文档为准（不去改库）：分组节点没有 docId，
   标题只能存在 nodes 里，原样保留；而任何写入路径造成的分叉，
   **下一次读就自愈**。

   ⚠️⚠️ 判据的重点是**两条读路都要接**：
   `readEntity`（全量 / 轻量启动）和 `changesSince`（增量，客户端平时就走它）
   是**两条独立**的读路 —— 后者自己 `SELECT` 一行，不经过前者。
   漏掉任何一条，结果就是「刷新能看到、增量拉取看不到」的半截状态。
   这个项目已经因为「只修了自己改过的那两处」栽过第三次（见 sync.ts 里
   `changesSince` 那段关于空间级实体的注释）。
   ============================================================ */
{
  const fs = await import('node:fs')
  const sync = fs.readFileSync('server/sync.ts', 'utf8')

  ok(/function deriveNodeTitle\(/.test(sync), '服务端有一个「按文档派生节点标题」的函数')
  ok(/def\.name === 'nodes' \? out2\.map\(deriveNodeTitle\) : out2/.test(sync),
    '**readEntity 那条路接上了**（全量 / 轻量启动都走它）')

  const chAt = sync.indexOf('export function changesSince')
  ok(chAt > 0, '找得到 changesSince')
  if (chAt > 0) {
    const ch = sync.slice(chAt, sync.indexOf('\n}\n', chAt))
    ok(/deriveNodeTitle/.test(ch),
      '**changesSince 那条路也接上了**（它自己 SELECT，不经过 readEntity —— 漏一处就是半截状态）')
  }
}

/* ============================================================
   文档态顶栏 / 目录树头 / 工作台「开始」区（照真实语雀改的）
   ------------------------------------------------------------
   2026-10-10 **直接开真实语雀量的**，不是照记忆改的。结论和原来的打算相反：

   · 语雀文档页顶栏那一格**不是**「知识库 / 目录 / 文档名」三级面包屑 ——
     它只有一个链接「› 个人知识库」指向**知识库列表**；
     **知识库名在左侧目录树的顶部**（带锁图标）。
     ⇒ `crumbDoc` / `crumbGroup` 是设计变更前的残留，**该删而不是补渲染**。
   · 工作台顶部有一个叫「**开始**」的区，里面是入口卡。
   · 左栏那个「开始」**不是分组标题**，它自己就是一个导航项。

   行为我用探针验过（顶栏=空间名、树头=书名+锁+⋯、三张卡文案逐字对上），
   这里钉的是**结构**：改了源码而没改这几条，下一轮就悄悄退回去了。
   ============================================================ */
{
  const fs = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const top = strip(fs.readFileSync('src/components/layout/TopBar.tsx', 'utf8'))
  ok(/yq-topbar-crumb-caret">›</.test(top), '语雀那个前导箭头 ›')
  ok(/yq-ellipsis">\{activeSpace\.name\}/.test(top),
    '**文档态顶栏显示的是空间名**（语雀那一格是「个人知识库」= 空间，不是知识库名）')
  ok(!/crumbBook\.name/.test(top), '**不再显示知识库名**（那一格归空间名所有，知识库名在目录树头上）')
  ok(!/const crumbDoc\b/.test(top) && !/const crumbGroup\b/.test(top),
    '`crumbDoc` / `crumbGroup` 两个死变量已删（语雀压根没有目录级、文档级面包屑）——留着它们，下一个人又会以为「补上渲染」是对的')

  const css = fs.readFileSync('src/components/layout/TopBar.css', 'utf8')
  ok(!/\.yq-topbar-crumb-group\b/.test(css) && !/\.yq-topbar-crumb-doc\b/.test(css),
    '两个从没有 JSX 用过的 CSS 类也一并删了（留着它们就是在邀请下一个人去「接上」）')

  const tree = strip(fs.readFileSync('src/components/doc/Tree.tsx', 'utf8'))
  /*
   * ⚠️ 这里原来用**写死的 1400 字符窗口**截 `yq-tree-head`：
   *   `/<div className="yq-tree-head">([\s\S]{0,1400}?)<\/div>/`
   * 于是 2026-10-17 把书行那个 `⋯` 改成真菜单之后，菜单的 JSX（约 50 行）
   * 把 `book?.name`、锁图标、`yq-tree-more` **全顶出了窗口** ——
   * 三条断言一起红，而**产品一行没坏**。
   *
   * 判据的窗口是写死的，代码一变长就被截断 ——
   * 「加一段实现就让守卫变红」的守卫，保护不了任何东西。
   *
   * 现在改成按**结构锚点**取：从 `yq-tree-head` 到目录标题行那一段为止，
   * 与这一段有多长无关。
   */
  const headFrom = tree.indexOf('<div className="yq-tree-head">')
  const headTo = tree.indexOf('<div className="yq-tree-cat', headFrom)
  const treeHead = headFrom >= 0 && headTo > headFrom ? tree.slice(headFrom, headTo) : ''
  ok(treeHead.length > 0, '取到了侧栏头那一段（结构锚点没失效）', `${headFrom}→${headTo}`)
  ok(/book\?\.name/.test(treeHead), '**知识库名在目录树头上**（语雀就是这么放的）')
  ok(/book && book\.visibility !== 'space'/.test(treeHead) && /🔒/.test(treeHead),
    '书名后有锁图标，且**只在非「空间内公开」时显示**（全空间可见的库挂锁是在说假话）')
  ok(/yq-tree-more/.test(treeHead), '知识库头有「⋯」入口（2026-10-17 起是**真菜单**，不再是跳转）')
  ok(!/yq-tree-more[^>]*onClick=\{\(\) => navigate/.test(treeHead),
    '那个「⋯」不再直接跳走 —— `⋯` 是「更多菜单」的图标，点下去却跳走属于**图标说谎**')

  const dash = strip(fs.readFileSync('src/pages/Dashboard.tsx', 'utf8'))
  const start = /function StartSection\(\)([\s\S]{0,2600}?)\n\}/.exec(dash)?.[1] || ''
  ok(/<h2 className="yq-section-title">开始<\/h2>/.test(dash), '工作台顶部那个区标题就是「开始」（语雀原文，不是「工作台」）')
  ok(/新建文档/.test(start) && /文档、表格、画板、数据表/.test(start), '卡片一：新建文档（含四种类型说明）')
  ok(/新建知识库/.test(start) && /使用知识库整理知识/.test(start), '卡片二：新建知识库')
  ok(/模板中心/.test(start) && /从模板中获取灵感/.test(start),
    '卡片三：模板中心（**「获取」灵感**——我之前凭记忆写成「取得」，是对着真实页面改回来的）')
  ok(!/AI 帮你写/.test(start),
    '**没有摆「AI 帮你写」那张卡**——我们没有 AI 能力，一张点下去什么都不发生的卡片比缺一张更糟')
  ok(/NewDocModal/.test(start),
    '「新建文档」复用顶栏那个新建弹窗（同一个语义不写第二遍，否则迟早有一边少判一个权限）')
}

/* ============================================================
   左栏按真实语雀重排（2026-10-10 实测）
   ------------------------------------------------------------
   实测到的事实：语雀左栏是 `ul[role=menu]` + 一层类名
   `personalSubMenuWrapper`（个人子菜单，**没有组名**），第一项是
   **「开始」**（`data-testid="sidebar:sidebar-menu-first-item"`）——
   它**不是分组标题，是导航项本身**。然后才是可折叠的「知识库」组。

   我们原来七 tab 平铺、并且把「协作 / 我的」当成组名。
   重排后：**前四项与语雀一一对应**，我们多出来的单独成组。
   ============================================================ */
{
  const fs = await import('node:fs')
  /*
   * ⚠️ 这个文件里**每个 `{}` 块各自声明** fs / strip，块之间不共享 ——
   * 直接用上一块的 strip 会 ReferenceError，套件连汇总行都打不出来，
   * 只表现为「没找到汇总行」。这里踩过两次了，别省。
   */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const nav = strip(fs.readFileSync('src/components/layout/SideNav.tsx', 'utf8'))
  const secs = /const SECTIONS = \[([\s\S]*?)\n\]/.exec(nav)?.[1] || ''

  ok(/label: null/.test(secs.split("label: '知识库'")[0]),
    '**第一组无标题**（语雀那边的个人子菜单就没有组名）')
  const firstGroup = secs.split("label: '知识库'")[0]
  ok(/label: '开始'/.test(firstGroup),
    '「**开始**」是菜单第一项，而不是分组标题 —— 我一直以为那是组名')
  ok(/label: '小记'/.test(firstGroup) && /label: '收藏'/.test(firstGroup) && /label: '逛逛'/.test(firstGroup),
    '第一组与语雀一一对应：开始 / 小记 / 收藏 / 逛逛')

  ok(/label: '知识库'/.test(secs), '有「知识库」分组（语雀里是可折叠的组）')
  ok(/label: '团队'/.test(secs),
    '我们多出来的（团队 / 讨论 / 关注…）**单独成组**——删掉是减功能，混进语雀那一组等于宣称「语雀长这样」')

  /*
   * 高亮必须**一律过 resolveTab**。
   * 而「小记 / 逛逛」根本不在工作台上、没有 `?tab=` 可言 ——
   * 所以是「先把路径折成 tab，再交给 resolveTab 收口」，
   * **不是**在外面自己判一遍（那正是这个文件当初被逼出来的那个 bug）。
   */
  ok(/const active = resolveTab\(/.test(nav), '**SideNav 的高亮走 resolveTab**（与 Dashboard 同一份口径）')
  ok(/pathTab/.test(nav) && /'\/notes'/.test(nav) && /'\/find'/.test(nav),
    '路径先折成 tab（小记 / 逛逛是独立页面，没有 ?tab= 参数）')
  ok(!/const active = location\.pathname/.test(nav),
    '**没有把路径判断留在 active 这一层**——那会让高亮绕开 resolveTab，两处又各算各的')
}

/* ============================================================
   响应式：全项目**一个套件都没改过视口宽度**
   ------------------------------------------------------------
   114 个套件、4144 项断言，没有一条在看「手机上长什么样」。
   而这是个要部署到**内网**给同事用的知识库 —— 手机打开是最常见的
   场景之一，「页面横向撑爆、只能左右拖着看」是那种没人会报的坏。

   2026-10-10 手工跑过一轮探针：三档宽度 × 四个关键页都是 0px 溢出，
   侧栏在窄屏正确收成抽屉、文档树有个只在窄屏出现的「☰ 目录」入口。
   **但探针用完就删了** —— 不钉成守卫，下一轮 CSS 一改就没人知道。

   判据用 `scrollWidth - clientWidth`（要具体数字，不要布尔）：
   布尔只能回答「有没有」，回答不了「是谁撑的」。
   ============================================================ */
{
  /*
   * ⚠️ **不能复用套件里那个 `browser` / `p`**：
   *   · `p` 声明在 `try { }` 内部，而这一段在块外面 → `ReferenceError`；
   *   · `browser` 已经被主 try 的 `finally` 关掉了 → `Target closed`；
   *   · 就算都能用，那个 p 的视口也被前面的用例改过，量出来的不是「打开就是那样」。
   * 所以整段自起一个浏览器，跑完自己关。
   */
  const rb = await chromium.launch()
  const rctx = await rb.newContext()
  const rp = await rctx.newPage()
  try {
    await rp.goto(BASE, { waitUntil: 'domcontentloaded' })
    await rp.waitForSelector('.yq-login-card', { timeout: 25000 })
    await rp.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await rp.fill('.yq-login-card input[type="password"]', PW)
    await rp.click('.yq-login-submit')
    await rp.waitForSelector('.yq-app', { timeout: 30000 })
    await rp.waitForTimeout(1500)

    const probeDoc = await rp.evaluate(() => {
      const s = window.__yqStore.getState()
      const n = s.nodes.find((x) => x.bookId === 'b1' && x.docId)
      return n ? { bookId: 'b1', docId: n.docId } : null
    })
    ok(!!probeDoc, '（前提）找得到一篇能打开的文档（下面要用它量文档页）')

  if (probeDoc) {
    const PAGES = [
      ['工作台', '/'],
      ['文档页', `/book/${probeDoc.bookId}/doc/${probeDoc.docId}`],
      ['知识库设置', `/book/${probeDoc.bookId}/settings`],
    ]
    for (const [w, height] of [[375, 720], [1280, 900]]) {
      await rp.setViewportSize({ width: w, height })
      for (const [label, path] of PAGES) {
        await rp.goto(`${BASE}/#${path}`, { waitUntil: 'domcontentloaded' })
        await rp.waitForTimeout(1400)
        const r = await rp.evaluate(() => {
          const de = document.documentElement
          const over = de.scrollWidth - de.clientWidth
          let worst = ''
          if (over > 0) {
            for (const el of document.querySelectorAll('body *')) {
              const rc = el.getBoundingClientRect()
              if (rc.right > de.clientWidth + 2 && rc.width > 0) {
                    const by = Math.round(rc.right - de.clientWidth)
                    if (by > worst.length) worst = `${el.className || el.tagName}(+${by}px)`
                  }
                }
          }
          const treeBtn = document.querySelector('.yq-doc-mbtn')
          const nav = document.querySelector('.yq-sidenav')
          const vis = (e) => {
            if (!e) return false
            const b = e.getBoundingClientRect()
            const st = getComputedStyle(e)
            return b.width > 0 && st.display !== 'none' && st.visibility !== 'hidden' && b.left < innerWidth && b.right > 0
          }
          return { over: Math.round(over), worst, treeBtnVisible: vis(document.querySelector('.yq-doc-mbtn')), navVisible: vis(nav) }
        })
        ok(r.over <= 2, `${w}px 下「${label}」没有横向溢出`, `溢出 ${r.over}px，撑宽的是 ${r.worst}`)
        if (label === '文档页') {
          /*
           * 判据是**可见**不是**存在**。
           * 头一版用 `document.querySelector(...)` 判存在，1280px 下直接红了 ——
           * 而那个按钮在宽屏只是被 CSS 藏起来、并没有消失。
           * 「元素在 DOM 里」和「用户看得见它」是两件事，这里要验的显然是后者。
           */
          ok(w <= 768 ? r.treeBtnVisible : !r.treeBtnVisible,
            w <= 768
              ? '**窄屏文档页看得见「☰ 目录」入口**（手机上打不开目录树 = 整个知识库没法导航）'
              : '宽屏看不见「☰ 目录」（那是窄屏专用入口，摆上来是多余的）',
            `treeBtnVisible=${r.treeBtnVisible}`)
        }
        if (label === '工作台') {
          ok(w <= 768 ? !r.navVisible : r.navVisible,
            w <= 768 ? '窄屏侧栏收成抽屉（不可见）' : '宽屏侧栏常驻可见', `navVisible=${r.navVisible}`)
        }
      }
    }
    }
  } finally {
    await rb.close().catch(() => {})
  }
}

/*
 * 知识库设置中心：结构必须对着**实测过的语雀**
 * ============================================================
 * 实测记录在 data/_fidelity-booksettings.md（2026-10-10 对着
 * yuque.com/u33412935/mwink0 逐页点的）。
 *
 * ⚠️ 这个块存在的理由不是「防止有人改错 tab 名字」，而是防止
 *    **又一次凭记忆改**。实测已经推翻过我的三处想当然：
 *      ① 左栏是**分两组**的，不是平铺一列；
 *      ② 「知识库信息」在最前、「统计」在「目录管理」之前；
 *      ③ **删除知识库在「更多设置」里**，不在安全设置页。
 *
 * 每条都写成「形状」判据而不是「出现过某个词」——
 * 否则我把标签改掉一点，断言照样绿。
 */
{
  const fs = await import('node:fs')
  const readFileSync = fs.readFileSync
  /** 剥掉注释再判断 —— 否则下面那些解释 bug 的注释会被自己命中 */
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

  const bset = readFileSync('src/pages/BookSettings.tsx', 'utf8')
  const bsetCode = strip(bset)
  const vite = strip(readFileSync('vite.config.ts', 'utf8'))
  const main = strip(readFileSync('src/main.tsx', 'utf8'))
  const store = strip(readFileSync('src/store/index.ts', 'utf8'))

  console.log('\n== 知识库设置：对着实测过的语雀 ==')

  // ---- 1. 左栏的两组与顺序 ----
  ok(/TAB_GROUPS/.test(bsetCode), '左栏是分组结构 TAB_GROUPS（不是平铺一列）')

  const groupTitles = [...bsetCode.matchAll(/title:\s*'(设置|高级功能)'/g)].map((m) => m[1])
  ok(groupTitles.join(',') === '设置,高级功能',
    `左栏恰好两组且顺序是「设置 → 高级功能」（实测得到：${groupTitles.join(',') || '没有' }）`)

  const keyOrder = [...bsetCode.matchAll(/key:\s*'(basic|perm|security|advanced|stats|catalog|docs|trash)'/g)].map((m) => m[1])
  const EXPECT = ['basic', 'perm', 'security', 'advanced', 'stats', 'catalog', 'docs', 'trash']
  ok(keyOrder.join(',') === EXPECT.join(','),
    `八个 tab 的顺序与语雀实测一致（${keyOrder.join(',') || '没解析出'}）`)

  // 「统计」在「目录管理」之前 —— 这条单独钉一下：它是实测推翻我直觉的地方
  const iStats = keyOrder.indexOf('stats')
  const iCatalog = keyOrder.indexOf('catalog')
  ok(iStats > -1 && iCatalog > -1 && iStats < iCatalog,
    '「统计」排在「目录管理」之前（实测如此，和「按重要性排」的直觉相反）')

  ok(/label:\s*'知识库信息'/.test(bsetCode), '第一个 tab 叫「知识库信息」（不是「目录管理」）')

  // ---- 2. 删库必须在「更多设置」，不在安全设置页 ----
  const advancedBody = bsetCode.slice(bsetCode.indexOf('function AdvancedTab'))
  const securityBody = bsetCode.slice(bsetCode.indexOf('function SecurityTab'))
  ok(/DangerZone/.test(advancedBody), '删除知识库在「更多设置」里（语雀实测如此）')
  ok(!/DangerZone\s*\/>/.test(securityBody), '安全设置页不再直接挂 DangerZone')

  // ---- 3. 四个新页都真的存在（不是只有导航项） ----
  for (const fn of ['BasicTab', 'AdvancedTab', 'DocsTab', 'BookTrashTab']) {
    ok(new RegExp('function\\s+' + fn + '\\s*\\(').test(bsetCode), `${fn} 有真实实现（不是只有菜单项点不动）`)
  }

  // ---- 4. 文档管理 / 回收站 是表格，且列名对着实测 ----
  const docsBody = bsetCode.slice(bsetCode.indexOf('function DocsTab'))
  for (const col of ['标题', '作者', '状态', '更新时间']) {
    ok(docsBody.includes(`>${col}<`) || docsBody.includes(`${col}</th>`),
      `文档管理有「${col}」这一列（语雀实测的表头）`)
  }
  const trashBody = bsetCode.slice(bsetCode.indexOf('function BookTrashTab'))
  for (const col of ['名称', '删除时间', '操作']) {
    ok(trashBody.includes(`${col}</th>`), `知识库内回收站有「${col}」这一列（语雀实测的表头）`)
  }

  // ---- 5. 「状态」列必须真按字段算，不是硬编码 ----
  ok(/d\.published\s*\?/.test(docsBody), '文档「状态」是按 published 真字段算的（不是写死「已发布」）')
  ok(!/已发布<\/Tag>\s*<Tag/.test(docsBody), '状态不是写死的一个标签')

  // ---- 6. 开关必须接真字段，不能是摆着好看的 ----
  //     defaultWidth 从定义起就零处读取过，是本项目最典型的僵尸字段
  ok(/defaultWidth/.test(bsetCode), '「更多设置」真的在读 defaultWidth')
  const docPage = strip(readFileSync('src/pages/DocPage.tsx', 'utf8'))
  ok(/rawBookSettings\?\.defaultWidth/.test(docPage),
    '文档页真的用知识库的 defaultWidth 当初始页宽（这个字段以前是僵尸）')

  // createDoc 必须读设置，否则「改了设置新建的文档还是老样子」
  ok(/s\.bookSettings\[bookId\]\?\.defaultVisibility/.test(store),
    'createDoc 读知识库的 defaultVisibility（原来写死 space，管理员改了没用）')
  ok(/s\.bookSettings\[bookId\]\?\.newDocPosition/.test(store),
    'createDoc 读知识库的 newDocPosition（原来永远追加到末尾）')

  // ---- 7. 路由机制：HashRouter + base 必须配对 ----
  /*
   * ⚠️⚠️ 这几条是 2026-10-10 那次误改留下的。
   *   我看到「直接打开 /book/b1/settings 白屏」，就把 vite 的 base
   *   从 './' 改成 '/' —— **结论是错的**：本项目用 HashRouter，
   *   路由在 '#' 之后，/book/b1/settings 里根本没有路由信息。
   *   那次白屏是 dist 正在被重建、index.html 指向了旧 hash 文件。
   *   改 base 反而会弄坏「整站挂子路径」这个能力。
   *   所以：**base 与路由机制一起钉死**，别再单独动其中一个。
   */
  ok(/HashRouter/.test(main), '项目用的是 HashRouter（路由在 # 之后 —— 这是判 base 的前提）')
  ok(/base:\s*'\.\/'/.test(vite),
    "vite base 保持 './'：HashRouter 下路径永远停在 /，相对路径才对；改绝对会弄坏子路径部署")
  ok(!/base:\s*['"]\/['"]/.test(vite),
    "没有把 base 写成 '/' —— 那是 2026-10-10 误改的形态（凭推理下结论的产物）")

  // ---- 8. 会员角标不抄、但功能在 ----
  ok(!/会员/.test(bsetCode), '没抄语雀的「会员」角标（那是付费分层，内网自用无意义）')
  // 消息推送是会员功能且本项目没有推送服务 —— 不做入口比摆个死菜单好
  ok(!/消息推送/.test(bsetCode), '「消息推送」是语雀会员功能且本项目无推送服务，故意不做这个入口')
}

/*
 * 知识库首页：对着 2026-10-10 实测的语雀
 * ============================================================
 * 实测：`yuque.com/u33412935/mwink0`（未点开任何文档时）
 * 那一页的第一句话是「👋 欢迎来到知识库 / 知识库就像书一样，让多篇文档结构化，
 * 方便知识的创作与沉淀」。本地早先从统计条直接跳到目录编排，中间是空的。
 *
 * 这条的判据要真能咬：只判「出现过欢迎两个字」的话，
 * 注释里写一句就能骗过去 —— 所以判的是**真实 JSX 结构**，
 * 并且反向断言「统计条后面紧接着就是欢迎区」（顺序也是保真度的一部分）。
 */
{
  const fs = await import('node:fs')
  const readFileSync = fs.readFileSync
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

  const bi = strip(readFileSync('src/pages/BookIndex.tsx', 'utf8'))

  console.log('\n== 知识库首页：对着实测过的语雀 ==')

  ok(/className="yq-bookpage-welcome"/.test(bi), '首页有独立的欢迎区（语雀第一眼就能看到的那块）')
  ok(/欢迎来到知识库/.test(bi), '欢迎语文案与语雀一致')
  ok(/知识库就像书一样/.test(bi), '欢迎语下面那句说明也在（不是只留个标题）')

  /*
   * 顺序：统计条 → 欢迎区 → 目录编排。
   * 语雀就是「头 → 统计 → 欢迎 → 目录」，
   * 而把欢迎区塞到最末尾虽然也「有」，但读起来是补丁而不是还原。
   */
  const iStats = bi.indexOf('yq-bookpage-stats')
  const iWelcome = bi.indexOf('yq-bookpage-welcome"')
  const iToc = bi.indexOf('yq-bookpage-toc')
  ok(iStats > -1 && iWelcome > iStats && iToc > iWelcome,
    '顺序是「统计 → 欢迎区 → 目录编排」（和语雀一致，欢迎区不是塞在末尾的补丁）')

  // 统计数字必须是真数据，不能是欢迎区里写死的
  ok(/bs\(book\)\.docCount/.test(bi), '「N 篇文档」取的是真统计，不是写死的数字')
  ok(!/欢迎[\s\S]{0,200}?\d+\s*篇文档[\s\S]{0,200}?>/.test(
    bi.slice(iWelcome, iWelcome + 800).replace(/\/\*[\s\S]*?\*\//g, ''),
  ), '欢迎区里不掺编造的统计数字')

  // 语雀那句下面有个空头像占位（表示「还没有成员」），本地不该画假头像
  const welcomeChunk = bi.slice(iWelcome, iWelcome + 900)
  ok(!/<img|Avatar/.test(welcomeChunk),
    '欢迎区**不画**成员头像占位（语雀那个是「还没有成员」，画假头像等于编造）')
}

/*
 * 测试的自动清扫不许无差别删
 * ============================================================
 * 2026-10-10 撞上的实例：我把实测记录 `data/_fidelity-booksettings.md`
 * 放进 data/，跑一次全量之后**文件没了** ——
 * 「代为清理临时产物」那一节按差集**全删**，不看文件类型。
 *
 * 这类规则的危险在于：**它平时是对的**（解决了临时库堆到 514 个 / 774MB），
 * 所以没人怀疑它，只在某天你往那个目录里放了个「不是临时产物」的东西。
 *
 * 判据钉的是**机制**：必须存在后缀白名单，且必须对
 * 「白名单之外的文件」有明确处理（跳过并说出来，而不是删掉）。
 */
{
  const fs = await import('node:fs')
  const readFileSync = fs.readFileSync
  // ⚠️ 每个顶层块各自声明依赖 —— 块之间**不共享** fs。
  //    这里沿用块外的 existsSync 的话，运行时会 ReferenceError，
  //    而症状不是报错，是套件「连汇总行都打不出来」。
  const existsSync = fs.existsSync
  const runner = readFileSync('run-all-tests.mjs', 'utf8')

  console.log('\n== 测试清扫：无差别删是危险的 ==')

  const fn = runner.slice(runner.indexOf('const sweepSuiteTemps'))
  ok(fn.length > 0, '读得到 sweepSuiteTemps 那一节')

  ok(/TEMP_EXT|\\.db\|db-wal\|db-shm/.test(fn),
    '**存在后缀白名单**（不靠「差集里的一切都是临时产物」这个假设）')
  ok(/kept/.test(fn),
    '白名单之外的文件有明确去处（kept），不是顺手删掉')
  ok(/跳过/.test(fn),
    '跳过的文件**在日志里说出来** —— 静默跳过等于「我以为清干净了」')

  // 反向：不能再出现「无差别删」—— 删之前不做任何筛选
  ok(!/for \(const f of files\) \{\s*\n\s*\/\/ 删不掉的/.test(fn)
     || /realTemps|allNew/.test(fn),
    '删除循环遍历的是**筛选后**的列表，不是原始差集')

  // 证据文件不该再放 data/ —— **直接查文件系统**，而不是查源码里有没有那个字符串
  // ⚠️ 上一版查的是 run-all-tests.mjs 里有没有 `data/_fidelity`，
  //    而我自己在注释里写了那串字，于是它一直红 ——
  //    判据扫全文 = 扫到自己解释 bug 的注释（同一个坑）。
  //    而且它压根没验「文件在哪」，只验了「源码里有没有提」。
  ok(!existsSync('data/_fidelity-booksettings.md'),
    '实测记录**不再放在 data/ 下**（实测文件系统：那里是被测试清扫的运行时目录）')
  ok(existsSync('docs/yuque-fidelity.md'),
    '证据落在 docs/ 下（改代码时对着它做，不放会被自动清理的地方）')
}

/*
 * 协作邀请：假数据必须已经换成真数据
 * ============================================================
 * 2026-10-11。
 *
 * 原来项目里那套 `collaborations` 是**纯客户端种子数据**：
 * 无服务端表、无 API、不在同步实体清单里，UI 已门控隐藏。
 * 现在知识库邀请是真的（有表、有路由、接受后真的进 book_members），
 * 于是那套假数据就成了「同名的另一套协作」——
 * 留着最大的风险是**有人顺手把它接回去**，功能又变成「刷新就没」。
 *
 * 所以这几条钉的是「**假的那套不许复活**」，不只是「真的那套存在」。
 */
{
  const fs = await import('node:fs')
  const readFileSync = fs.readFileSync
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

  console.log('\n== 协作邀请：假数据不许复活 ==')

  const dash = readFileSync('src/pages/Dashboard.tsx', 'utf8')
  const top = readFileSync('src/components/layout/TopBar.tsx', 'utf8')
  const bset = readFileSync('src/pages/BookSettings.tsx', 'utf8')
  const ui = readFileSync('src/components/collab/BookInvite.tsx', 'utf8')
  const store = readFileSync('src/store/index.ts', 'utf8')
  const srv = readFileSync('server/index.ts', 'utf8')

  // ---- 1. 界面上不再读那套假数据 ----
  ok(!/function CollabTab/.test(dash),
    '旧的 CollabTab 已删（它读的是 collaborations 种子数据）')

  /*
   * SideNav 也有一个协作未读数，而**它原先读的是那套假数据**。
   *
   * ⚠️ 这条是破坏对照逼出来的：我把 SideNav 改回读 collaborations 之后，
   *    守卫**全绿 321/0** —— 因为原有那条只查 TopBar，
   *    SideNav 同样在算这个数却没人管。
   *    「基准永远是绿的」在这里的含义就是这么具体：
   *    **不验这一下，就会以为守卫有效。**
   *
   * 后果不只是「数字不对」：侧栏红点会**常亮**（数字来自假种子的 unread），
   * 而点进去是空的 —— 用户看到的是一个骗人的红点。
   */
  {
    const sn = strip(readFileSync('src/components/layout/SideNav.tsx', 'utf8'))
    const m = /const unreadCollab = ([^\n]+)/.exec(sn)
    ok(!!m && /bookInvites/.test(m[1]),
      '侧栏的协作未读数也来自 bookInvites（TopBar 与 SideNav 两处都要对）',
      m ? m[1].trim() : '没找到 unreadCollab')
    ok(!!m && !/collaborations/.test(m[1]),
      '**侧栏也不读**那套假数据 collaborations（它会让红点常亮而点进去是空的）')
  }
  ok(!/collaborations/.test(strip(dash).replace(/\n/g, ' ')) || !/collaborations\s*\.\s*filter/.test(strip(dash)),
    'Dashboard 不再按 collaborations 渲染')
  ok(!/collaborations\.filter/.test(strip(top).replace(/\n/g, ' ')),
    '顶栏通知面板不再按 collaborations 算未读')

  // ---- 2. 界面读的是真数据 ----
  ok(/BookInviteList/.test(dash), '工作台的协作项用的是真的 BookInviteList')
  ok(/bookInvites/.test(strip(top)), '顶栏红点按 bookInvites 数（原来数的是假数据的 unread）')
  ok(/InviteToBookDialog/.test(bset), '权限页挂了发起邀请的入口')

  // ---- 3. 关键动作真的调服务端（不是 setState 改本地） ----
  const storeCode = strip(store).replace(/\n/g, ' ')
  ok(/inviteToBook\s*\(/.test(storeCode) && /respondBookInvite\s*\(/.test(storeCode),
    'store 的邀请动作真的调了 api（不是裸 setState 改本地）')
  ok(/refreshBookInvites/.test(strip(readFileSync('src/components/AppGate.tsx', 'utf8')).replace(/\n/g, ' ')),
    '登录完成后会拉一次待办（不然铃铛红点永远是 0）')

  // ---- 4. 本地模式不假装有这功能 ----
  ok(/getMode\(\)\s*!==\s*'server'/.test(strip(ui).replace(/\n/g, ' ')),
    '本地模式下**明说**邀请不可用（摆一个恒空的待办等于骗人说「都处理完了」）')

  // ---- 5. 服务端在位 ----
  ok(/'\/api\/books\/:id\/invites'/.test(srv), '服务端有发起邀请的路由')
  ok(/'\/api\/invites\/:id\/respond'/.test(srv), '服务端有接受/拒绝的路由')
  ok(/bookInvites/.test(readFileSync('server/entities.ts', 'utf8')),
    'book_invites 登记进同步实体（邀请人自己也要看得到，才能撤回）')

  // ---- 6. 送达不吹牛 ----
  /*
   * ⚠️ 只认 import/require：那才是真的「装了邮件客户端」。
   *   第一版扫全文，命中的是我在 server/index.ts 里写的那句
   *   「本项目没有 SMTP —— 声称「已发邮件」是假的」——
   *   于是一条讲「别吹牛」的断言，自己判成了「在吹牛」。
   *   （同一个坑：本项目反复踩「扫全文会扫到自己解释 bug 的注释」。）
   */
  const srvImports = (srv.match(/(?:from\s+|require\s*\(\s*)['"][^'"]+['"]/g) || []).join(' ')
  ok(!/smtp|sendmail|nodemailer|mailer/i.test(srvImports),
    '服务端**没有真的引**邮件客户端（本项目没配 SMTP —— 假通知比没通知更糟）')
}

/*
 * 钉住「导出 / 导入两侧都要有 bookInvites」
 *
 * ⚠️ 这一条是被真 bug 逼出来的：
 *   我把 `bookInvites?: BookInvite[]` 加进了 AppData（它确实该持久化 ——
 *   别人的待办，刷新后应该还在），却**忘了导入侧**。
 *   后果：从一个包恢复之后待办全没了。
 *   而「导入后待办没了」这种症状，没人会去怀疑 io.ts ——
 *   更像「导出功能坏了」或「服务端的问题」。
 *
 * 两侧的形状不一样，所以也要分别判：
 *   · 导出侧是整个 store 展开（`...data`），**自动带上**，不用显式列；
 *   · 导入侧是**逐字段列举**，漏一个就丢一个。
 *   ⇒ 只判导出侧会漏掉真正会出问题的那一半。
 */
{
  const fs = await import('node:fs')
  const readFileSync = fs.readFileSync
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

  console.log('\n== 导出 / 导入：bookInvites 两侧都要在 ==')

  const io = strip(readFileSync('src/lib/io.ts', 'utf8'))
  const types = readFileSync('src/types/index.ts', 'utf8')

  // ---- 类型：它属于持久数据 ----
  const appData = types.slice(types.indexOf('export interface AppData'))
  ok(/bookInvites\??\s*:\s*BookInvite\[\]/.test(appData),
    'AppData 里有 bookInvites（它是持久数据，不是 UI 态）')

  // ---- 导入侧：必须显式列出来 ----
  const applyBody = io.slice(io.indexOf('export function applyBundle'))
  ok(/bookInvites\s*:/.test(applyBody),
    '**导入侧**显式带了 bookInvites（漏了它 = 导入后待办全没了）')

  // ---- 导入侧不该再带那套假数据 ----
  ok(!/collaborations\s*:/.test(applyBody),
    '导入侧**不再**带 collaborations（那是纯客户端种子，服务端形态下会被清空，导入了也是假象）')

  /*
   * ---- 导出侧 ----
   *
   * ⚠️ 区间要**掐在 applyBundle 之前**：
   *   第一版我写 `io.slice(io.indexOf('buildBundle'))`，把后面的导入侧
   *   也切进来了，于是拿「导入侧该有的 cursors: []」去判导出侧 —— 判反了。
   *   **判据红不等于代码错**，先确认区间取的是不是要看的那一段。
   */
  const bStart = io.indexOf('export function buildBundle')
  const bEnd = io.indexOf('export function applyBundle')
  const buildBody = io.slice(bStart, bEnd > bStart ? bEnd : undefined)
  ok(/\.\.\.data/.test(buildBody),
    '导出侧是整个 store 展开（所以 bookInvites 自动带上，不靠手写字段表）')
  // 剔掉的只有 toasts；待办是别人的事，不能当 UI 态剔掉
  ok(/toasts:\s*_t/.test(buildBody) && !/bookInvites:\s*_/.test(buildBody),
    '导出侧只剔 toasts（待办是别人的事，不能当 UI 态剔掉）')
  // cursors: [] 是**导入侧**该有的（实时态不进包），别在导出侧判它
  const aBody = io.slice(bEnd)
  ok(/cursors:\s*\[\]/.test(aBody),
    '导入侧把 cursors 清空（实时态不进包）—— 这一条判的是导入侧，不是导出侧')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
