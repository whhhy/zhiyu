/**
 * 文档之间的引用（语雀的「双向引用」）。
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 这是知识库和「一堆孤立页面」的分界线：一份规范里链出去三份文档，
 * 被链到的那三篇得知道自己被谁依赖，否则改了接口谁也不知道要去同步。
 * 官方选型文档把它列成**基本功能**，而项目里此前完全没有。
 *
 * 这里钉的是最容易悄悄坏掉的几点：
 *  ① 推导出来的表必须和正文永远一致 —— 正文删了链接，列表就得跟着空，
 *     否则「谁引用了我」会指着一篇根本不提我的文档说谎；
 *  ② 越权过滤不是可选项 —— 引用方可能在另一个知识库里，
 *     不过滤就等于发一份「谁在引用哪些敏感文档」的名单；
 *  ③ 指向已删 / 不存在的文档不能变成死链。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.YQ_PORT || '8092'
const DB = 'data/_doclinks-test.db'
const BASE = `http://localhost:${PORT}`

let token = ''
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, json: j }
}

function spawnServer() {
  const p = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.stdout.on('data', () => {})
  p.stderr.on('data', () => {})
  return p
}

/**
 * 起服务**之前**先把旧库删掉。
 *
 * 原来只在跑完时清理（`cleanup`），而服务刚被 kill、文件还被占着时
 * `rmSync` 会抛 EBUSY，被 `catch` 吞掉 —— 于是上一轮**崩掉**（工具超时、
 * 手动 Ctrl-C、断言失败）就留下一个半截的库。
 *
 * 后果不是「多占点磁盘」，是**下一次运行直接被毒化**：库还在，
 * seed 不再跑，里面可能一篇文档都没有，
 * 而套件报出来的是 `Cannot read properties of undefined (reading 'bookId')`
 * —— 一个和「上次崩了」毫无关系的报错。
 *
 * （要么用带时间戳的库名，要么像这里一样启动前先删。二选一，都行，
 *   但**不能只在跑完时清**。test-lint 里有一条检查盯着这件事。）
 */
for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
}

const cleanup = () => {
  try { server.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}
let server = spawnServer()
process.on('exit', cleanup)

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/api/health')
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

if (!(await waitUp())) {
  console.error('服务没能在 20 秒内起来')
  cleanup()
  process.exit(1)
}

const login = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
})
token = login.json.token || ''
ok(!!token, '管理员登录成功', login.json.error || '')

const allDocs = (await api('/api/entity/docs')).json.rows || []
const [A, B, C] = allDocs
ok(allDocs.length >= 3, `拿到至少 3 篇文档做实验（实际 ${allDocs.length}）`)

/** 把 A 的正文换成给定的 HTML */
async function setBody(doc, html, blocks = []) {
  const r = await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { docs: [{ id: doc.id, bookId: doc.bookId, title: doc.title, body: html, blocks }] },
    }),
  })
  return r
}

console.log('\n== 正文里链一篇 → 那一篇的「被引用」里出现它 ==')
{
  const html = `<p>参见 <a href="#/book/${B.bookId}/doc/${B.id}">${B.title}</a></p>`
  const r = await setBody(A, html)
  ok(r.status === 200 && !(r.json.rejected || []).length, '写入带链接的正文', JSON.stringify(r.json.rejected || []))

  const back = await api(`/api/doc/${B.id}/backlinks`)
  ok(back.status === 200, '被引用接口可访问', String(back.status))
  const ids = (back.json.backlinks || []).map((x) => x.id)
  ok(ids.includes(A.id), 'B 的被引用里有 A', JSON.stringify(back.json.backlinks))
  ok((back.json.backlinks || []).some((x) => x.title === A.title), '被引用项带上了真实标题（不是 id）')

  const out = await api(`/api/doc/${A.id}/links`)
  ok((out.json.links || []).some((x) => x.id === B.id), 'A 的出链里有 B', JSON.stringify(out.json.links))
}

console.log('\n== 正文删掉链接 → 引用必须立刻消失 ==')
{
  // 上一节刚建好的关系，这一节直接拆掉。
  // 「推导表」最阴险的坏法就是正文改了、表没跟着改 ——
  // 界面上看起来一切正常，只是答案开始说谎。
  await setBody(A, '<p>不再引用任何东西</p>')
  const back = await api(`/api/doc/${B.id}/backlinks`)
  ok((back.json.backlinks || []).length === 0,
    '链接删掉后 B 的被引用立刻清空', JSON.stringify(back.json.backlinks))
  const out = await api(`/api/doc/${A.id}/links`)
  ok((out.json.links || []).length === 0, 'A 的出链也清空', JSON.stringify(out.json.links))
}

console.log('\n== 完整 URL 也要认（用户是从地址栏复制的）==')
{
  await setBody(A, `<a href="${BASE}/#/book/${B.bookId}/doc/${B.id}">${B.title}</a>`)
  const back = await api(`/api/doc/${B.id}/backlinks`)
  ok((back.json.backlinks || []).some((x) => x.id === A.id), '带域名的绝对 URL 也能认出', JSON.stringify(back.json.backlinks))
  await setBody(A, '<p>清空</p>')
}

console.log('\n== 块里的链接也算（正文分块存，链接常在块的 html 里）==')
{
  await setBody(A, '<p>正文里没有链接</p>', [
    { type: 'text', text: '参见', html: `<a href="#/book/${B.bookId}/doc/${B.id}">${B.title}</a>` },
  ])
  const back = await api(`/api/doc/${B.id}/backlinks`)
  ok((back.json.backlinks || []).some((x) => x.id === A.id),
    '只写在块的 html 里也能被认出来', JSON.stringify(back.json.backlinks))
  await setBody(A, '<p>清空</p>', [])
}

console.log('\n== 指向不存在的文档不能变成死链 ==')
{
  await setBody(A, '<a href="#/book/b1/doc/no-such-doc-at-all">幽灵</a>')
  const back = await api('/api/doc/no-such-doc-at-all/backlinks')
  // 这篇文档根本不存在 —— 不该凭空造出一条记录
  ok(back.status === 404 || back.status === 403,
    '查询一个不存在的文档的引用被拒（不是凭空造出记录）', `${back.status} ${JSON.stringify(back.json)}`)
  await setBody(A, '<p>清空</p>', [])
}

console.log('\n== 自己链自己不该出现在自己的被引用里 ==')
{
  await setBody(A, `<a href="#/book/${A.bookId}/doc/${A.id}">自己</a>`)
  const back = await api(`/api/doc/${A.id}/backlinks`)
  ok(!(back.json.backlinks || []).some((x) => x.id === A.id),
    '自引用被排除', JSON.stringify(back.json.backlinks))
  await setBody(A, '<p>清空</p>', [])
}

console.log('\n== 多篇都能链到同一篇 ==')
{
  await setBody(A, `<a href="#/book/${B.bookId}/doc/${B.id}">x</a>`)
  await setBody(C, `<a href="#/book/${B.bookId}/doc/${B.id}">y</a>`)
  const back = await api(`/api/doc/${B.id}/backlinks`)
  const ids = (back.json.backlinks || []).map((x) => x.id).sort()
  ok(ids.length === 2 && ids.includes(A.id) && ids.includes(C.id),
    'B 的被引用同时有 A 和 C', JSON.stringify(back.json.backlinks))
  await setBody(C, '<p>清空</p>', [])
  await setBody(A, '<p>清空</p>', [])
}

console.log('\n== 越权：没 token 必须被拒 ==')
{
  const saved = token
  token = ''
  const back = await api(`/api/doc/${B.id}/backlinks`)
  ok(back.status === 401, '不带 token 查被引用 → 401', String(back.status))
  const out = await api(`/api/doc/${A.id}/links`)
  ok(out.status === 401, '不带 token 查出链 → 401', String(out.status))
  token = saved
}

console.log('\n== 越权：换了账号也必须按**引用方**的读权限过滤 ==')
{
  /**
   * 这是最要紧的一条，也是第一版写错的一条。
   *
   * 原来只造了「对 b1 毫无权限的局外人」，结果他在**门口**就被 403 拦下了，
   * 压根走不到按引用方逐条过滤那一步 —— 拆掉那层过滤，测试依然全绿。
   * 换句话说：当时验的根本不是我想验的东西。
   *
   * 真正能打到的场景是：**能读被引用的那篇，但读不了引用它的那篇**。
   * 这时接口必须 200（他有 B 的读权限），但名单里不能出现 A ——
   * 因为「A 引用了 B」这件事本身就泄漏了 A 的存在和标题。
   *
   * 要造出这种局面，A 和 B 必须落在**不同的空间**：
   * 空间成员会拿到该空间下所有书的只读身份，同一个空间里造不出来。
   */
  const books = (await api('/api/entity/books')).json.rows || []
  const bySpace = new Map()
  for (const b of books) {
    const k = String(b.spaceId || '')
    if (!bySpace.has(k)) bySpace.set(k, [])
    bySpace.get(k).push(b)
  }
  const spaceIds = [...bySpace.keys()].filter((k) => k && bySpace.get(k).length)
  ok(spaceIds.length >= 2, `种子库里有两个以上空间（实际 ${spaceIds.length}）`, JSON.stringify([...bySpace.keys()]))

  const bkA = bySpace.get(spaceIds[0])[0]
  const bkB = bySpace.get(spaceIds[1])[0]
  const SRC = (await api('/api/entity/docs')).json.rows.find((d) => d.bookId === bkA.id)
  const TGT = (await api('/api/entity/docs')).json.rows.find((d) => d.bookId === bkB.id)
  ok(!!SRC && !!TGT, `两个空间各挑到一篇文档（${SRC?.id} / ${TGT?.id}）`)

  if (SRC && TGT) {
    const acct = 'linkprobe_' + Math.random().toString(36).slice(2, 8)
    const pw = 'Lp@2026pass'
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ account: acct, name: '半访问', password: pw }),
    })
    ok(reg.status === 200 || reg.status === 409, '造一个只进 B 那个空间的账号', `${reg.status} ${JSON.stringify(reg.json)}`)
    const uid = reg.json.userId || reg.json.user?.id || reg.json.id

    const adminToken = token
    const add = await api(`/api/spaces/${spaceIds[1]}/members`, {
      method: 'POST',
      body: JSON.stringify({ userIds: [uid], role: 'member' }),
    })
    ok(add.status === 200 && !(add.json.failed || []).length, '把他加进 B 所在的空间', `${add.status} ${JSON.stringify(add.json).slice(0, 100)}`)

    // A（另一个空间）链向 B
    await api('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        upsert: { docs: [{ id: SRC.id, bookId: SRC.bookId, title: SRC.title, body: `<a href="#/book/${TGT.bookId}/doc/${TGT.id}">见 B</a>`, blocks: [] }] },
      }),
    })

    token = ''
    const li = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: acct, password: pw }) })
    token = li.json.token
    ok(!!token, '半访问登录成功')

    // 前提校验：他能读 B，但读不了 A —— 前提不成立的话下面那条断言等于没测
    const readB = await api(`/api/doc/${TGT.id}`)
    ok(readB.status === 200, '前提：他读得了被引用的 B', String(readB.status))
    const readA = await api(`/api/doc/${SRC.id}`)
    ok(readA.status === 403, '前提：他读不了引用方的 A', String(readA.status))

    const back = await api(`/api/doc/${TGT.id}/backlinks`)
    ok(back.status === 200, '他能查 B 的被引用（接口本身不拦他）', String(back.status))
    const ids = (back.json.backlinks || []).map((x) => x.id)
    ok(!ids.includes(SRC.id),
      '名单里没有他读不到的引用方 A（真正打到了按引用方过滤那一步）',
      `实际返回 ${JSON.stringify(back.json.backlinks)}`)

    token = adminToken
    const adminView = await api(`/api/doc/${TGT.id}/backlinks`)
    ok((adminView.json.backlinks || []).some((x) => x.id === SRC.id),
      '管理员仍然看得到 A（过滤是按权限裁剪，不是一刀切删光）',
      JSON.stringify(adminView.json.backlinks))

    // 收尾：把这条链子拆掉，别留到最后影响别的用例
    await api('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ upsert: { docs: [{ id: SRC.id, bookId: SRC.bookId, title: SRC.title, body: '<p>清空</p>', blocks: [] }] } }),
    })
  }
}

console.log('\n== 章节锚点：链到某一节，也要算「引用了这一篇」 ==')
{
  /**
   * 语雀那个功能字面就叫「**章节**链接」，形式是
   * `#/book/x/doc/y#<块id>`。服务端抽的是 docId，锚点不能被一起吃进去 ——
   * 吃进去的话 `/doc/d5#blk-9` 会被当成一个不存在的文档 id，
   * 于是既不报错、也永远查不到引用，是最难查的那种错。
   */
  const A0 = A, B0 = B
  const anchor = 'blk-abc123'
  await setBody(A0, `<a href="#/book/${B0.bookId}/doc/${B0.id}#${anchor}">链到第二节</a>`)
  const back = await api(`/api/doc/${B0.id}/backlinks`)
  const ids = (back.json.backlinks || []).map((x) => x.id)
  ok(ids.includes(A0.id), '带锚点的链接同样被认出来（锚点没被吃进 docId）', JSON.stringify(back.json.backlinks))
  ok(!ids.includes(anchor) && !ids.some((x) => String(x).includes('#')),
    '名单里没有多出一条「锚点」这种伪文档', JSON.stringify(ids))

  // 顺带钉一条：整段 href 一个字都不能丢
  const out = await api(`/api/doc/${A0.id}/links`)
  ok((out.json.links || []).some((x) => x.id === B0.id), '出链里也是 B 而不是 B#锚点')

  // 锚点里带特殊字符也不能被 URL 编码的 # 拆错
  await setBody(A0, `<a href="${BASE}/#/book/${B0.bookId}/doc/${B0.id}#a%20b">空格锚点</a>`)
  const back2 = await api(`/api/doc/${B0.id}/backlinks`)
  ok((back2.json.backlinks || []).some((x) => x.id === A0.id),
    '锚点里带百分号编码也不会拆错', JSON.stringify(back2.json.backlinks))
  await setBody(A0, '<p>清空</p>', [])
}

console.log('\n== 前端：章节锚点跳转是真的接上了 ==')
{
  /**
   * 静态核对：这些几行是**用户能看见的行为**，
   * 不接上就是「链接点进去停在文档顶部，而且页面看起来没动」。
   * 这里只保证接线在；真的跳不跳得对，由 smoke 套件在浏览器里验。
   */
  const page = readFileSync('src/pages/DocPage.tsx', 'utf8')
  ok(/data-block-id="\$\{CSS\.escape\(anchor\)\}"/.test(page), 'DocPage 按块 id 定位锚点目标（不是按标题文字猜）')
  ok(/scrollIntoView/.test(page.slice(page.indexOf('readAnchor'), page.indexOf('readAnchor') + 1400)), '锚点会滚过去')
  ok(/yq-collab-flash/.test(page), '会闪一下（复用协同高亮那套 class，没另造一套）')
  ok(/hashchange/.test(page), '同页内再点一次同一锚点也会重新定位')

  const bar = readFileSync('src/components/doc/Toolbar.tsx', 'utf8')
  ok(bar.includes('#${b.id}'), '链接选择器能插出带锚点的链接（章节级）')
  ok(bar.includes('/doc/${d.id}`'), '也能插文档级链接（没有章节时）')
  // 轻量启动下没打开过的文档没有 blocks —— 不能假装有章节
  ok(/heads\.length > 0/.test(bar) && /\(d\.blocks \|\| \[\]\)/.test(bar),
    '没加载正文的文档不显示章节入口（如实降级，不偷跑一次全量请求）')

  const srv = readFileSync('server/sync.ts', 'utf8')
  ok(/const DOC_ROUTE = \/#\\\/book\\\/\[\^\/\]\*\\\/doc\\\/\(\[A-Za-z0-9_-\]\+\)\/g/.test(srv),
    '服务端的 docId 正则在锚点之前就收住了（不会把 #锚点 吃进 id）')
}

console.log('\n== 源码层面：引用表是推导的，不能被客户端直接写 ==')
{
  const ent = readFileSync('server/entities.ts', 'utf8')
  ok(!/name: 'docLinks'|name: 'doc_links'/.test(ent),
    'doc_links 没有注册成可写实体（否则正文删了链接、表里还留着）')
  const dbSrc = readFileSync('server/db.ts', 'utf8')
  ok(/CREATE TABLE IF NOT EXISTS doc_links/.test(dbSrc), 'doc_links 表建了')
  const syncSrc = readFileSync('server/sync.ts', 'utf8')
  ok(/relink\(/.test(syncSrc), '有重算逻辑')
  /**
   * 这里原来写的是 `if (def.name === 'docs') relink\(` —— 一行写死了代码形状。
   * 后来为了顺带刷新所属知识库的索引，那行变成了块结构，断言就红了，
   * 而**行为其实一点没变**。
   *
   * 所以这里改成：截出「文稿写入」那一段，看它里面有没有调 relink，
   * 而不是去匹配某一行长什么样 —— 断言要钉的是行为，不是排版。
   */
  const writePath = syncSrc.slice(syncSrc.indexOf("logChange(def.name, id, 'upsert'"), syncSrc.indexOf('function deleteRow'))
  ok(/def\.name === 'docs'/.test(writePath) && /relink\(id\)/.test(writePath),
    '文稿写入时确实会调 relink（看的是这一段代码，不是某一行长什么样）')
}

cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
