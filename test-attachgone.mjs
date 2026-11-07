/**
 * 附件真的不在了，两张卡都要**说出来**
 *
 * ============================================================
 * 7.15 那个 bug 的另一半
 * ------------------------------------------------------------
 * 7.15 查的是本地形态下图片块显示不出来（一张碎图，零解释）。
 * 顺着查下去发现另一半，而且这一半**在服务端形态下**：
 *
 * `resolveFileUrl` 原来是
 *     if (useServer()) return { url: attachmentUrl(key), revoke: false }
 * —— 它**只拼地址，不检查文件在不在**。于是 `useAttachmentUrl` 的
 * `state` 在服务端形态下**恒为 'ready'**，`FileCard` 那个
 * 「state === 'missing' → 说二进制已丢失」的分支**永远进不去**。
 *
 * 也就是说：
 *   本地形态  FileCard 会说「已丢失」✓（取不回 Blob 天然就是没了）
 *   服务端形态 FileCard 不说 ✗（一直给一个「⬇ 下载」，点了才 404）
 *
 * 同一个概念两张卡，一张会解释一张不会 —— 和 7.15 一模一样，
 * 只是发生在另一边、而且**早就在那儿**。7.15 只修了一半。
 *
 * 修法做在 `useAttachmentUrl` 一处（不是两张卡各补一次）：
 * 服务端形态下多发一个 **HEAD** 探测。HEAD 是必须的 ——
 * 附件动辄几百 MB，用 GET 探测等于为了看一眼把整个文件下一遍。
 *
 * ============================================================
 * 什么时候会真的撞上
 * ------------------------------------------------------------
 * 最直接的一条是**回滚到旧版本**。版本快照存的是一整份 blocks
 * （含 `data.key`），而 7.13/7.14 让附件**真的**删得掉了：
 * 删掉卡片 → 二进制没了 → 回滚 → 那个 key 被带回来 → 卡片指着空气。
 * 界面必须说出来，否则用户看到的是一个「⬇ 下载」，点了才发现是 404。
 * ============================================================
 */
import { chromium } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')

/**
 * 这个套件要**直接查库、还要直接删一行**（模拟「文件真没了」），
 * 所以库名必须明确。
 *
 * 原来写的是 `process.env.YQ_DB || '<某个固定库名>'` —— test-lint 当场抓了：
 * 「固定库名但没有启动前强制清理」。那个兜底值是真的危险：
 * 拿不到库名时去猜一个，而那个名字很可能是**上一轮崩掉留下的半截库**，
 * 于是这一轮在对着旧数据下结论。
 *
 * 猜一个「大概对」的库，比直接说「我不知道这是哪个库」危险得多。
 * （顺带一提：lint 是按**字面量**扫的，所以连注释里写出那个库名都会被报 ——
 *   改掉之后要重新跑 lint 确认，别凭「代码里已经没有它了」就以为过了。）
 */
const DB = process.env.YQ_DB
if (!DB) {
  console.error('需要 YQ_DB：这个套件要直接查库，不能靠猜。')
  console.error('请用 `npm run test:all` 跑（它会把库名传给套件）。')
  process.exit(1)
}

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1500)
}

const browser = await chromium.launch()
try {
  const p = await (await browser.newContext()).newPage()
  await login(p, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  const bookId = await p.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '附件丢失探针 ' + sfx), Date.now().toString(36))
  await p.waitForTimeout(1800)
  const suffix = Math.random().toString(36).slice(2, 7)
  /*
   * 文档用**客户端自己的** createDoc 建，不要用 sync/push 硬塞一个。
   * 硬塞出来的文档不在本地目录树里，路由过去根本渲染不出正文 ——
   * 报错是 `waitForSelector: .yq-block 超时`，指向 UI，
   * 真实原因却是「这篇文档客户端不知道它存在」。
   */
  const docId = await p.evaluate((sfx) => {
    const s = window.__yqStore.getState()
    return s.createDoc(s.books[0].id, null, '附件丢失探针 ' + sfx)
  }, suffix)
  ok(!!docId, '在客户端建一篇文档（这样目录树里天然有它）', String(docId))
  await p.waitForTimeout(2500)

  const up = await p.request.post(`${BASE}/api/attachment?docId=${docId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'x-filename': 'probe.txt' },
    data: Buffer.from('ATTACHGONE-BODY'),
  })
  const att = await up.json()
  ok(!!att.id, '传一份附件', JSON.stringify(att).slice(0, 80))

  await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(2200)
  const inStore = await p.evaluate((d) => !!window.__yqStore.getState().docs[d], docId)
  ok(inStore, '文档已经在客户端 store 里了（先把文档打开）')

  /** 把块插进正文（走真实的卡片组件上传逻辑） */
  const attachCard = async () => {
    await p.evaluate(async ([d]) => {
      const s = window.__yqStore.getState()
      const file = new File(['占位'], 'probe.txt', { type: 'text/plain' })
      const patch = await window.__yqAttach.attachFileToDoc(file, true)
      s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_gone_1', type: 'card', text: '', data: { cardId: 'file', ...patch } }])
    }, [docId])
    await p.waitForTimeout(2500)
  }
  await attachCard()

  const keyOf = () => p.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.id === 'bk_gone_1')
    return b?.data?.key || ''
  }, docId)

  console.log('\n== 基准：文件在的时候，卡片要正常 ==')
  const realKey = await keyOf()
  ok(!!realKey, '卡片里的 key 是服务端附件 id', realKey)
  ok(await p.locator('.yq-kc-file a[download]').count() > 0, '给的是「⬇ 下载」链接')
  ok(!(await p.locator('.yq-app').innerText()).includes('二进制已丢失'), '没有误报「已丢失」')

  console.log('\n== 文件真没了：卡片必须说出来 ==')
  {
    /*
     * 直接把那一行从库里删掉 ——
     * 这正是「回滚到旧版本」之后的样子：块还指着那个 key，文件已经没了。
     * 走真实的删除接口也可以，但那样连块一起清了，就看不到卡片说什么了。
     */
    const d = new DatabaseSync(DB)
    d.exec('PRAGMA busy_timeout = 5000')
    const gone = d.prepare('DELETE FROM attachments WHERE id = ?').run(realKey)
    d.close()
    ok(Number(gone.changes) === 1, '（基准）那一行确实从库里没了（模拟回滚带回的旧 key）', String(gone.changes))

    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 25000 })
    await p.waitForTimeout(2500)

    const txt = await p.locator('.yq-app').innerText()
    ok(/二进制已丢失/.test(txt), '**FileCard 明说「二进制已丢失」**，而不是给一个点了就 404 的下载链接', txt.slice(0, 120))
    ok(/附件|重新选择|浏览器数据/.test(txt), '并说清可能的原因', txt.slice(0, 160))
    ok(await p.locator('.yq-kc-file a[download]').count() === 0, '也不再给一个必然失败的下载链接')
  }

  console.log('\n== 探测本身不能是个后门 ==')
  {
    const H2 = { Authorization: `Bearer ${token}` }
    const live = await p.request.post(`${BASE}/api/attachment?docId=${docId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'x-filename': 'probe2.txt' },
      data: Buffer.from('LIVE-BODY'),
    })
    const liveId = (await live.json()).id

    const head = await p.request.fetch(`${BASE}/api/attachment/${liveId}`, { method: 'HEAD', headers: H2 })
    ok(head.status() === 200, 'HEAD 在文件存在时返回 200', String(head.status()))
    ok(Number(head.headers()['content-length']) > 0, '并带上 Content-Length（前端据此知道大小）', head.headers()['content-length'])
    ok((await head.text()).length === 0, '**HEAD 不取正文**（附件可能几百 MB，用 GET 探测等于下一遍）')

    /*
     * 匿名 HEAD 必须被拒。
     *
     * 这里**不能**用 `p.request` —— 那个请求带着浏览器 context 的 cookie，
     * 而登录时 app 会顺手落一份 cookie（见 api.ts 的 setToken），
     * 于是「不带 Authorization 头」根本不代表「未登录」。
     * 头一版就是这么写的，它拿到 200，报的是「不登录也能下附件」——
     * 而服务端其实是对的（裸 fetch 探针验过是 401）。
     * 测「没登录」时必须真的没登录。
     */
    const noAuth = await fetch(`${BASE}/api/attachment/${liveId}`, { method: 'HEAD' })
    ok(noAuth.status === 401, '不登录不能 HEAD（探测不绕过鉴权）', String(noAuth.status))

    const missing = await p.request.fetch(`${BASE}/api/attachment/压根不存在`, { method: 'HEAD', headers: H2 })
    ok(missing.status() === 404, '不存在的 HEAD → 404（卡片据此判「已丢失」）', String(missing.status()))
  }

  console.log('\n== 无主附件：探测也不能绕过归属判断 ==')
  {
    /*
     * 这一段是补上的 —— 破坏对照里拆掉 HEAD 的归属检查时**没有变红**，
     * 因为当时根本没有用例覆盖它。没有覆盖就不该假装有保护。
     */
    const orphan = 'orphan_head_' + suffix
    const d = new DatabaseSync(DB)
    d.exec('PRAGMA busy_timeout = 5000')
    const ins = d.prepare('INSERT INTO attachments (id,docId,blockId,filename,mime,size,data,createdAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(orphan, null, null, 'old.txt', 'text/plain', 3, Buffer.from('孤儿'), Date.now())
    d.close()
    // 头一版这里写的是 `ok(true, '（基准）往库里塞了一条无主附件…')` ——
    // **恒为真**，等于没验。现在数它自己写进去几行。
    ok(Number(ins.changes) === 1, '（基准）无主附件确实写进库了', String(ins.changes))

    const head = await fetch(`${BASE}/api/attachment/${orphan}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } })
    ok(head.status === 403, '无主附件 HEAD → 403（判不出归属就判不出权限）', String(head.status))
    /*
     * 理由文案只能靠 **GET** 验：HEAD 响应按 HTTP 定义就没有正文，
     * `await head.json()` 永远是空的。头一版就是在这儿读到 undefined 的 ——
     * 而 403 是对的，看起来像「理由没写」。
     */
    const getOrphan = await fetch(`${BASE}/api/attachment/${orphan}`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await getOrphan.json().catch(() => ({}))
    ok(getOrphan.status === 403 && /没有关联文档/.test(String(body.error || '')),
      'GET 拿到 403，且理由说清是「数据缺归属」而不是笼统的「没有权限」',
      `${getOrphan.status} ${String(body.error).slice(0, 60)}`)

    const left = new DatabaseSync(DB)
    left.exec('PRAGMA busy_timeout = 5000')
    const still = Number(left.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id = ?').get(orphan).n)
    left.close()
    ok(still === 1, '而且它还在库里（403 不是「顺手删掉」）', String(still))
  }

  console.log('\n== 图片块加载失败也要说，不能是一张碎图 ==')
  {
    /*
     * 同样是被破坏对照逼出来的：摘掉图片块的 onError 时**没变红**，
     * 因为服务端形态下从没测过它。7.15 那个套件测的是本地形态，
     * 而本地形态的图走 blob:，本来就不会加载失败。
     *
     * 这里造的就是「图片块指向一个不存在的附件」—— 回滚带回旧 key、
     * 或者从另一个实例导入，都会长这样。
     */
    const deadKey = 'att_压根不存在_' + suffix
    await p.evaluate(([d, k]) => {
      const s = window.__yqStore.getState()
      s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_dead_img', type: 'image', text: '', src: '', data: { key: k, name: '没了的图.png' } }])
    }, [docId, deadKey])
    await p.waitForTimeout(3500)

    const txt = await p.locator('.yq-app').innerText()
    ok(/加载不出来|图片已丢失/.test(txt), '**图片块明说加载不出来**，而不是画一张碎图', txt.slice(0, 140))
    ok(/没了的图\.png/.test(txt), '并带上文件名（否则用户不知道是哪一张）', txt.slice(0, 200))
    /*
     * 头一版这条写反了：我假设「先渲染一个 <img>，然后它加载失败」，
     * 于是去数 img 元素 —— 结果数到 0，红了。
     *
     * 实际行为比那更好：有了 HEAD 探测，**渲染之前就知道它没了**，
     * 所以根本不去渲染一个必然失败的 `<img>`（省掉一次注定 404 的请求，
     * 也不会闪一下碎图）。所以断言要反过来写。
     */
    ok(await p.locator('.yq-img-block img').count() === 0,
      '**没有去渲染那个必然失败的 <img>** —— 提前就知道没了，不用先去撞一次 404')
  }

  console.log('\n== 403 不能被说成「文件没了」 ==')
  {
    /*
     * 这一段是补上的。破坏对照把「403 也当没了」拆掉之后**没有变红**，
     * 因为套件里从来没出现过 403 —— admin 对所有文档都有权限，
     * 而唯一的 403（无主附件）在状态码判断**之前**就抛了。
     * 没有覆盖就不该假装有保护。
     *
     * 要造一个 403：造一个对这篇文档**没有读权限**的用户，
     * 让他去探测一份属于这篇文档的附件。
     */
    const noRead = 'nr_' + suffix
    const reg = await p.request.post(`${BASE}/api/auth/register`, {
      data: { account: noRead, password: 'test1234', name: '无读权限者' },
    })
    const regJson = await reg.json().catch(() => ({}))
    const nrToken = regJson.token
    ok(!!nrToken, '注册一个对这篇文档没有读权限的人', JSON.stringify(regJson).slice(0, 70))

    const live2 = (await (await p.request.post(`${BASE}/api/attachment?docId=${docId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'x-filename': 'probe3.txt' },
      data: Buffer.from('FORBIDDEN-BODY'),
    })).json())
    ok(!!live2.id, '再造一份附件（挂在 admin 有权限的那篇上）', live2.id)

    const nrHead = await fetch(`${BASE}/api/attachment/${live2.id}`, { method: 'HEAD', headers: { Authorization: `Bearer ${nrToken}` } })
    ok(nrHead.status === 403, '他对这篇文档的附件 HEAD → 403', String(nrHead.status))

    /*
     * 客户端那一半：**必须用那个人的 token 去探测**。
     * 头一版写成在 admin 的页面里 evaluate —— 那里 `getToken()` 拿到的是
     * admin 的令牌，探测返回 200，压根走不到 403 那条分支，
     * 断言于是「通过」了而什么都没验。
     * 所以另开一个浏览器上下文，用那个人的身份登录后再探测。
     */
    const ctxNR = await browser.newContext()
    const pNR = await ctxNR.newPage()
    await login(pNR, noRead, 'test1234')

    const probe = await pNR.evaluate(async (k) => {
      const r = await window.__yqAttach.resolveFileUrl(k, true)
      return { url: String(r.url || ''), revoke: !!r.revoke }
    }, live2.id)
    ok(probe.url !== '' && !probe.revoke,
      '**403 不会被说成「没了」** —— 地址照旧给出去，不谎报文件已删除', JSON.stringify(probe))
    await ctxNR.close()

    // 而真正 404 的那个，探测必须给空地址（对照组：同一段代码，两种结局）
    const gone2 = await p.evaluate(async (k) => {
      const r = await window.__yqAttach.resolveFileUrl(k, true)
      return { url: String(r.url || '') }
    }, 'att_压根不存在_probe')
    ok(gone2.url === '', '（对照）真 404 的那个探测给的是空地址 —— 403 和 404 是两种结局', JSON.stringify(gone2))
  }

  console.log('\n== 两张卡走同一个入口 ==')
  {
    const bare = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const store = bare('src/lib/attachment-store.ts')
    ok(/method:\s*'HEAD'/.test(store), '探测走 HEAD（而不是 GET）')
    const hook = bare('src/components/cards/common.tsx')
    ok(/resolveFileUrl\(key, true\)/.test(hook), 'useAttachmentUrl 带上了 probe 参数 —— 判断做在一处，不是两张卡各补一次')
    const srv = bare('server/index.ts')
    ok(/on\('HEAD', '\/api\/attachment\/:id'/.test(srv), '服务端注册了 HEAD 路由')
    ok(/Number\(row\.size \|\| 0\)/.test(srv), 'HEAD 用 size 列算 Content-Length，不去把 BLOB 读出来')
    ok(/!capsOfDoc\(u, String\(row\.docId\)\)\.read/.test(srv), 'HEAD 的权限判定与 GET 一致（探测不是后门）')
  }
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
