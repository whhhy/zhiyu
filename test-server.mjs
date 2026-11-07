/* 服务端 API 冒烟测试
   用 node fetch 而不是 PowerShell：PowerShell 5.1 发请求体时默认按 Latin-1 编码，
   中文会被打成 ?，测出来的「乱码」其实是客户端的锅。 */

import fs from 'node:fs'   // 末节要读 server/index.ts 核对占位符检查的**位置**（源码顺序守卫）

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
// 口令可覆盖：容器部署通常会改掉默认口令，否则这套测试一定登不进去
const ADMIN = process.env.ADMIN_ACCOUNT || 'admin'
const PASS = process.env.ADMIN_PASS || 'yuque@2026'
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const post = (path, body, token) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

const get = (path, token) =>
  fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

const t = (name, body, token) => post(`/api/sync/push`, body, token).then((r) => t[name] = r)

console.log('\n== 鉴权 ==')
const badLogin = await post('/api/auth/login', { account: ADMIN, password: 'wrong' })
ok(badLogin.status === 401, '错误口令被拒')

const admin = await post('/api/auth/login', { account: ADMIN, password: PASS })
ok(admin.status === 200 && !!admin.body.token, '管理员登录', JSON.stringify(admin.body))
const AT = admin.body.token

const anon = await get('/api/bootstrap')
ok(anon.status === 401, '未登录访问被拒', String(anon.status))

console.log('\n== 中文往返（UTF-8） ==')
const TITLE = '张三的会议纪要 · 第 3 周 ✅'
const w1 = await post('/api/sync/push', { upsert: { docs: [{ id: 'd1', title: TITLE }] } }, AT)
ok(w1.body.applied?.length === 1, '写入中文标题')
const back = await get('/api/doc/d1', AT)
ok(back.body.doc.title === TITLE, '中文标题原样读回', `got=[${back.body.doc.title}]`)

console.log('\n== 权限边界 ==')
// 账号名带上随机后缀：这套用例要能反复跑，固定账号名第二次就会撞 409
const ACCOUNT = `li_${Date.now().toString(36)}`
const staff = await post('/api/auth/register', { account: ACCOUNT, password: 'test1234', name: '李四' })
ok(staff.status === 200, '注册新员工', JSON.stringify(staff.body))
const ST = staff.body.token
const staffBoot = await get('/api/bootstrap', ST)
ok(staffBoot.body.data.books.length === 0, '新员工看不到别人的知识库', String(staffBoot.body.data.books.length))
ok(staffBoot.body.data.spaces.length === 1, '新员工有自己的个人空间')

const deniedRead = await get('/api/doc/d1', ST)
ok(deniedRead.status === 403, '越权读文档被拒', String(deniedRead.status))

const deniedWrite = await post('/api/sync/push', { upsert: { docs: [{ id: 'd1', title: '篡改' }] } }, ST)
ok(deniedWrite.body.applied.length === 0 && deniedWrite.body.rejected.length === 1, '越权写文档被拒')

const afterAttack = await get('/api/doc/d1', AT)
ok(afterAttack.body.doc.title === TITLE, '越权写入没有真的生效')

console.log('\n== 授权后放行 ==')
const add = await post('/api/sync/push', {
  upsert: { bookMembers: [{ bookId: 'b1', userId: staff.body.user.id, role: 'editor', perms: { read: 1, comment: 1, edit: 1, create: 1, export: 1, share: 0 }, joinedAt: Date.now() }] },
}, AT)
ok(add.body.applied.length === 1, '管理员把员工加进知识库', JSON.stringify(add.body.rejected))

const staffBoot2 = await get('/api/bootstrap', ST)
ok(staffBoot2.body.data.books.length === 1, '员工现在能看到该知识库', String(staffBoot2.body.data.books.length))
ok(staffBoot2.body.data.docs.length > 0, '员工能看到该库的文档', String(staffBoot2.body.data.docs.length))

const staffWrite = await post('/api/sync/push', { upsert: { docs: [{ id: 'd1', title: '员工补充' }] } }, ST)
ok(staffWrite.body.applied.length === 1, 'editor 可以编辑', JSON.stringify(staffWrite.body.rejected))

const staffAdmin = await post('/api/sync/push', { upsert: { bookSettings: [{ bookId: 'b1', watermark: true }] } }, ST)
ok(staffAdmin.body.applied.length === 0, 'editor 改不了知识库设置')

console.log('\n== 复合主键不误伤 ==')
// 同一个用户同时在两个知识库里，改 b1 不能碰到 b2 的那行
await post('/api/sync/push', { upsert: { bookMembers: [{ bookId: 'b2', userId: staff.body.user.id, role: 'reader', perms: {}, joinedAt: Date.now() }] } }, AT)
const bm = await get('/api/entity/bookMembers', AT)
const mine = bm.body.rows.filter((r) => r.userId === staff.body.user.id)
ok(mine.length === 2 && mine.find((r) => r.bookId === 'b1')?.role === 'editor' && mine.find((r) => r.bookId === 'b2')?.role === 'reader',
  '同一用户的两条知识库成员记录互不干扰', JSON.stringify(mine.map((r) => `${r.bookId}:${r.role}`)))

console.log('\n== 增量同步 ==')
const boot = await get('/api/bootstrap', AT)
const seq0 = boot.body.seq
await post('/api/sync/push', { upsert: { docs: [{ id: 'd1', title: '增量测试' }] } }, AT)
const delta = await get(`/api/sync/changes?since=${seq0}`, AT)
ok(delta.body.seq > seq0, 'seq 前进', `${seq0} -> ${delta.body.seq}`)
ok((delta.body.upsert.docs || []).length === 1, '增量返回被改的文档', JSON.stringify(Object.keys(delta.body.upsert)))
ok(delta.body.upsert.docs?.[0]?.title === '增量测试', '增量内容正确')

// 先真的建一条再删：删一个不存在的 id 是幂等的（不会记变更），
// 直接用假 id 测删除流，等于什么都没测到。
const NEW_NOTE = 'n_smoke_1'
await post('/api/sync/push', { upsert: { notes: [{ id: NEW_NOTE, text: '待删除的小记', authorId: admin.body.user.id, spaceId: 's1', createdAt: Date.now() }] } }, AT)
const seqAfterCreate = (await get(`/api/sync/changes?since=${delta.body.seq}`, AT)).body.seq
const del = await post('/api/sync/push', { remove: { notes: [NEW_NOTE] } }, AT)
ok(del.body.applied.length === 1, '删除一条小记')
const delta2 = await get(`/api/sync/changes?since=${seqAfterCreate}`, AT)
ok((delta2.body.remove.notes || []).includes(NEW_NOTE), '删除进入增量流', JSON.stringify(delta2.body.remove))
const goneCheck = await get('/api/entity/notes', AT)
ok(!goneCheck.body.rows.some((n) => n.id === NEW_NOTE), '删除后确实读不到')

console.log('\n== 主键完整性 ==')
// 曾经踩过的坑：writable 列表漏了 id，INSERT 不带主键，
// 而 SQLite 的 TEXT PRIMARY KEY 不会自动 NOT NULL，
// 于是真插进去一条 id=NULL 的行，changes 日志记的却是另一个 id。
// 症状是「刚创建的东西在别人眼里凭空消失」，所以这里直接查有没有空主键。
for (const name of ['notes', 'topics', 'templates', 'books', 'docs', 'nodes', 'comments']) {
  const rows = (await get(`/api/entity/${name}`, AT)).body.rows
  ok(rows.every((r) => r.id !== null && r.id !== undefined && r.id !== ''), `${name} 没有空主键`,
    JSON.stringify(rows.filter((r) => !r.id).slice(0, 3)))
}

console.log('\n== 数据规模 ==')
// 不要断言「正好 26 篇」：这套用例和别的套件共用一个库时，
// 前面的用例可能已经新建过文档，精确计数就会变成顺序依赖的假失败。
// 也不要只按 dN 匹配 —— 种子里的 id 并不都是这种形式（还有 t1/t2…），
// 那样写只会数出 10 篇，然后一脸莫名其妙。
ok(boot.body.data.docs.length >= 26, '种子文档全部落地（>=26 篇）', String(boot.body.data.docs.length))
ok(boot.body.data.nodes.length >= 32, '目录树完整（>=32 个节点）', String(boot.body.data.nodes.length))
ok(boot.body.data.templates.length === 11, '模板完整（官方模板未被权限过滤掉）', String(boot.body.data.templates.length))
ok(boot.body.data.bookSettings.length === 4, '每个知识库都有默认设置', String(boot.body.data.bookSettings.length))

console.log('\n== 轻量启动：正文按需取 ==')
// 启动包不带正文（几千篇时整包会到 18MB），正文走 /api/doc/:id
// 注意要在上面那些改标题的用例之后再取，否则比的是旧元信息
const freshBoot = (await get('/api/bootstrap', AT)).body
const liteD1 = freshBoot.data.docs.find((d) => d.id === 'd1')
ok(liteD1 && liteD1.blocks === undefined, '启动包里没有正文', typeof liteD1?.blocks)
ok(liteD1 && liteD1.title && liteD1.wordCount > 0, '但有元信息（列表要显示）')
const fullD1 = (await get('/api/doc/d1', AT)).body.doc
ok(Array.isArray(fullD1.blocks) && fullD1.blocks.length > 0, '单篇接口能取到正文', String(fullD1.blocks?.length))
ok(typeof fullD1.blocks[0]?.text === 'string' && fullD1.blocks[0].text.length > 0, '块内容非空')
ok(liteD1 && liteD1.title === fullD1.title, '两处的元信息一致', `${liteD1?.title} vs ${fullD1.title}`)

console.log('\n== 搜索 ==')
const hit = (await get('/api/search?q=' + encodeURIComponent('产品手册'), AT)).body.results
ok(Array.isArray(hit) && hit.length > 0, '搜得到内容', String(hit?.length))
const twoChar = (await get('/api/search?q=' + encodeURIComponent('产品'), AT)).body.results
ok(twoChar.length > 0, '两字中文词也搜得到（FTS5 会漏）', String(twoChar.length))
const bookHit = (await get('/api/search?q=' + encodeURIComponent('团队手册'), AT)).body.results
ok(bookHit.some((h) => h.kind === 'book'), '搜得到知识库本身', JSON.stringify(bookHit.map((h) => h.kind)))
// 必须用一个**真正没有任何知识库权限**的账号；
// 上面那个 ST 是 b1 的 editor，他本来就该搜得到，用他断言「搜不到」是自欺欺人。
const nobody = await post('/api/auth/register', { account: `nobody_${Date.now().toString(36)}`, password: 'test1234', name: '无关路人' })
const nb = (await get('/api/search?q=' + encodeURIComponent('产品手册'), nobody.body.token)).body.results
ok(nb.length === 0, '完全无权的人搜不到别人的内容', String(nb.length))
const nbDenied = await get('/api/doc/d1', nobody.body.token)
ok(nbDenied.status === 403, '他连文档都打不开', String(nbDenied.status))

console.log('\n== 附件 ==')
const buf = Buffer.from('内网知识库附件测试')
const up = await fetch(`${BASE}/api/attachment?docId=d1`, {
  method: 'POST', headers: { Authorization: `Bearer ${AT}`, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('测试文档.txt') }, body: buf,
})
const upBody = await up.json()
ok(up.status === 200 && upBody.name === '测试文档.txt', '上传中文名附件', JSON.stringify(upBody))
const dl = await fetch(`${BASE}/api/attachment/${upBody.id}`, { headers: { Authorization: `Bearer ${AT}` } })
const dlBuf = Buffer.from(await dl.arrayBuffer())
ok(dlBuf.equals(buf), '附件字节原样取回')
const dlDenied = await fetch(`${BASE}/api/attachment/${upBody.id}`, { headers: { Authorization: `Bearer ${ST}` } })
ok(dlDenied.status === 200, '已授权成员可读附件', String(dlDenied.status))

/* ===================================================================
   请求体上限
   -------------------------------------------------------------------
   `readBody` 里那个 64MB 的上限是**唯一**挡「有人硬塞超大 JSON」的东西，
   而它从来没有被任何测试碰过 —— 也就是说这个防护罩**没人替它站岗**：
   哪天下次有人重构 `readBody` 顺手把它删了，全套照样绿。

   顺带钉住状态码：它必须回 **413**。
   原来抛的是个没有 `status` 的 Error，dispatcher 一律当 500 ——
   而「你的包太大了」是**客户端**的问题。返回 500 的代价有两个：
   对方以为服务端挂了去查健康状况；`status >= 500` 还会把它记成服务端错误，
   一次误用就能把错误日志刷满，真故障反而被淹掉。
   =================================================================== */
console.log('\n== 请求体上限（这层防护以前从没被测过）==')
{
  // 64MB 上限 + 1MB 余量。走 stream，避免先在测试进程里拼一个 65MB 的字符串。
  const big = new ReadableStream({
    start(c) {
      const piece = new TextEncoder().encode('x'.repeat(1024 * 1024))
      let sent = 0
      const total = 65
      const pump = () => {
        while (sent < total) { c.enqueue(piece); sent++ }
        c.close()
      }
      pump()
    },
  })
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AT}` },
    body: big,
    // duplex 在 Node 的 fetch 上是必须的（流式 body）
    duplex: 'half',
  }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch((e) => ({ status: 0, body: { error: String(e) } }))

  ok(r.status === 413, `65MB 的请求体被拒且状态码是 413（实际 ${r.status}）`,
    r.status === 500 ? '—— 500 等于告诉对方「服务端挂了」，而这是客户端把包撑大了'
      : r.status === 0 ? `连接被掐断：${r.body?.error}` : '')
  ok(r.status !== 500 && r.status !== 0, '**没有**被记成服务端故障')

  // 正常大小的请求体不受影响 —— 上限不能把正常推送也挡住
  const small = await post('/api/sync/push', { upsert: {}, remove: {} }, AT)
  ok(small.status === 200, `正常大小的请求体照常受理（${small.status}）`)
}

/* ============================================================
   占位符口令的拒绝启动：必须**与库里有没有数据无关**
   ------------------------------------------------------------
   2026-10-08 实测到的真缺陷：
     `bootstrapFirstRun` 里那句 `if (!isEmpty()) return` 写在占位符检查**之前**，
     而 `./data` 是宿主机目录、跨重建持久 —— 于是只要库里已有数据，
     这条检查就**永远被跳过**。实测：先建库、再 `docker compose up -d`
     （口令仍是占位符），容器照常 healthy，日志里也没有那条拒绝信息。
     而 compose 文件与源码注释都承诺「抄了没改 → 拒绝启动」。

   这不是可利用的漏洞（库里已有真实用户，口令早已定死），
   但它是**防呆机制本身的失效** —— 而它存在的理由就是拦「抄 compose 忘了改」。

   这里用**源码顺序**来钉住（而不是起容器测）：起容器要 10 秒 + 一个卷，
   而顺序回归极快；真正的端到端验证另在部署时做。
   ============================================================ */
{
  const raw = fs.readFileSync('server/index.ts', 'utf8')
  /*
   * ⚠️ 必须**剥注释**再找位置：`indexOf` 会被注释里引用的代码片段命中。
   *    第一版没剥，于是我自己在解释性注释里写的那句 `if (!isEmpty()) return`
   *    抢先匹配，守卫报「检查被早退跳过了」—— 而代码里明明是修好的。
   *    这跟本项目反复吃的那个坑是同一族：**判据命中的不是你以为的那一处**。
   */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const guardAt = src.indexOf('YQ_ADMIN_PASSWORD === PLACEHOLDER_PASSWORD')
  const skipAt = src.indexOf('if (!isEmpty()) return')
  ok(guardAt > 0, '源码里有占位符检查（剥注释后）')
  ok(skipAt > 0, '源码里有 isEmpty 早退（剥注释后）')
  ok(guardAt < skipAt,
    '占位符检查排在 `if (!isEmpty()) return` **之前** —— 否则非空库会绕过它',
    guardAt > skipAt ? '检查被早退跳过了（2026-10-08 的原缺陷）' : '')

  /*
   * 破坏对照：把 `if (!isEmpty()) return` **真的挪到检查之前**。
   * ⚠️ 第一版只是给它后面加了一行 —— 位置根本没变，判据当然不会红。
   *    那种「破坏对照」是自欺欺人：看起来验了，其实没动过被测的东西。
   *    这里用成对抽取 + 换位，做真正的调换。
   */
  const g = src.match(/if \(process\.env\.YQ_ADMIN_PASSWORD === PLACEHOLDER_PASSWORD[\s\S]*?\n  \}\n/)
  const sk = src.match(/if \(!isEmpty\(\)\) return\n/)
  let brokenSwapped = src
  if (g && sk && g.index < sk.index) {
    brokenSwapped = src.slice(0, g.index) + sk[0] + g[0] + src.slice(sk.index + sk[0].length)
  }
  const g2 = brokenSwapped.indexOf('YQ_ADMIN_PASSWORD === PLACEHOLDER_PASSWORD')
  const s2 = brokenSwapped.indexOf('if (!isEmpty()) return')
  ok(g2 > s2 && g2 > 0 && s2 > 0,
    '破坏对照：把早退真的换到检查之前，这条就会红（说明判据真的会咬）',
    g2 === 0 || s2 === 0 ? '抽取失败，破坏对照无效' : '')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
