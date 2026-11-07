/**
 * 服务端**不**替客户端重算 body / wordCount —— 这是一条**取舍**，不是正确性
 * ============================================================
 * 这个套件原来的方向是反的：它验的是「服务端在 upsertRow 里用 blocks 重算
 * body / wordCount」。那个实现我写了，又撤了，所以这个套件也得跟着换方向。
 *
 * 换完之后做过破坏对照（临时把重算加回 upsertRow 再跑）：
 * **22 项里 8 项红** —— 其中「出链记下来了」那条当场复现了 `doc_links` 为空，
 * 也就是当初 `test-doclinks` 那 9 项失败的机制。
 *
 * ------------------------------------------------------------
 * 为什么当初想加
 * ------------------------------------------------------------
 * `body` / `wordCount` 都在服务端 `docs` 实体的 `writable` 里，
 * 也就是说**任何客户端都能推一对自相矛盾的值**，服务端照单全收：
 *
 *     upsert { docs: [{ id, blocks: [新内容], body: '', wordCount: 999 }] }
 *     → 库里就是「blocks 有正文、body 是空的、字数 999」
 *
 * 谁会这么推？
 *   · **旧版本客户端**（body 压根没被维护的那些）—— 最现实的一种
 *   · 导入包（`importBundle` 原样搬 `body`）
 *   · 任何直接调 API 的人
 *
 * 结果又是同一个：导出零字节、分享页空白页、发现页摘要空（7.17）。
 * 在服务端兜一道听着很对：「派生值在写入点算，而这个写入点谁也绕不过去」。
 *
 * ------------------------------------------------------------
 * 为什么撤了
 * ------------------------------------------------------------
 * 它把 `test-doclinks` 从 42/0 弄成 33/9。反向引用全空。
 *
 * 原因是 `docLinkSources`（server/sync.ts）**明确扫 body** ——
 * 也就是**设计上 body 可以携带 blocks 表达不了的内容**。
 * 用例里的链接正是只写在 body、blocks 是空的；重算之后 body 变成 `# `，
 * 链接没了。
 *
 * 于是真正被顶到面前的是「**body 与 blocks 谁是权威**」，而这个问题没有答案：
 *   · 客户端那侧能自洽（body = f(blocks)），所以只在客户端算就够了（7.17）
 *   · 服务端这侧要重算，就得先接受「body 不能再有独立于 blocks 的内容」
 *     —— 那是**改变既有契约**，不是我该单方面做的取舍
 *
 * 留着的代价：旧客户端推上来的陈旧 body 会被照单全收（导出可能拿到旧内容）。
 * 换来的是「客户端说 A、库里就是 A」，**行为可预测**。
 *
 * 所以下面验的就是这两条现状，外加一条真防护
 * （「不带 blocks 推」不能把正文清空 —— 那是 upsertRow 里 `...existing` 的功劳，
 * 和重算与否无关，但同样会被「顺手改 upsertRow」的人弄坏）。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.BODYSERVER_PORT || await freePort()
const DB = 'data/_bodysrv-test.db'
const BASE = `http://localhost:${PORT}`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }

if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧代码上，结果不可信。`)
  process.exit(1)
}

const server = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB }, stdio: ['ignore', 'pipe', 'pipe'],
})
/* 只有 kill、**不删库** —— 所以单独跑会在 data/ 里留一个 _bodysrv-test.db。
 * 之所以一直没人发现：全量跑时 runner 的清扫会兜住，**单独跑不会**，
 * 而单独跑正是排查问题时做的事。
 * ⚠️ 这一条已登记在 test-temp-cleanup.mjs 的 KNOWN 基线里（不判红、每次列出）。 */
const cleanup = () => { try { server.kill() } catch { /* 已退出 */ } }
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})
process.on('exit', cleanup)

let up = false
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

const call = async (p, o = {}, t = '') => {
  const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) } })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const admin = (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: 'admin', password: 'yuque@2026' }) })).json.token || ''
ok(!!admin, '管理员登录成功')

const B = (await call('/api/entity/books', {}, admin)).json.rows[0]
const SFX = Math.random().toString(36).slice(2, 7)

const q = (sql, ...a) => {
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  const rows = d.prepare(sql).all(...a)
  d.close()
  return rows
}
const push = (doc) => call('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: [doc] } }) }, admin)

const blocks = [
  { id: 'b1', type: 'h1', text: '服务端重算探针' },
  { id: 'b2', type: 'p', text: '这一段是正文，共十个字符左右' },
  { id: 'b3', type: 'ul', text: '要点一' },
]
const derivedBody = '# 服务端重算探针\n\n这一段是正文，共十个字符左右\n\n- 要点一'
const derivedWords = '服务端重算探针'.length + '这一段是正文，共十个字符左右'.length + '要点一'.length

/* ---------------------------------------------------------------- */
console.log('\n== 取舍一：客户端推什么 body，库里就是什么 body ==')
{
  /*
   * 注意这条断言验的是**「不重算」**，不是「body 是对的」。
   * 推的 body 是 'x'、wordCount 是 1，库里就应该是 'x' 和 1。
   * 这看着像在守一个 bug —— 它守的是**可预测性**：
   * 任何时候「客户端说 A、库里就是 A」，出了问题能顺着查到源头。
   * 反过来（服务端偷偷改写）才是最难的查法。
   *
   * 对照在这里：`test-bodyfresh.mjs` 守的是客户端侧「推出去的 body 是对的」。
   * 两侧合起来才是完整契约 —— 中间这层刻意是空的。
   */
  const docId = `bodysrv_${SFX}`
  const r = await push({
    id: docId, bookId: B.id, title: '服务端重算探针', body: 'x',
    createdAt: Date.now(), updatedAt: Date.now(), wordCount: 1,
    blocks,                    // ← 正文是对的（derivedBody / derivedWords）
    visibility: 'space', published: false, tags: [],
  })
  ok(r.status === 200 && !(r.json.rejected || []).length, '这行被收下了（否则下面验的就不是真实路径）',
    JSON.stringify(r.json).slice(0, 90))

  const row = q('SELECT blocks, body, wordCount FROM docs WHERE id = ?', docId)[0]
  ok(String(row?.body) === 'x',
    '**body 原样落库**（客户端说 x，库里就是 x，服务端没替它按 blocks 算）',
    `库里是 ${JSON.stringify(String(row?.body).slice(0, 50))}`)
  ok(Number(row?.wordCount) === 1,
    '**wordCount 也原样落库**', `库里是 ${row?.wordCount}，客户端推的是 1`)
  ok(String(row?.body) !== derivedBody,
    '（对照：按 blocks 算出来本该是另一个值，说明这里确实验的是「没重算」而不是「碰巧相等」）',
    '两边一模一样，这条断言就失去鉴别力了')
}

/* ---------------------------------------------------------------- */
console.log('\n== 取舍二：客户端压根不带 body，服务端也不替它补 ==')
{
  /*
   * 这条是**上面那个取舍的代价**，如实记下来，不粉饰：
   * 老版本客户端（body 压根没被维护的那些）推上来的行，服务端不会替它算。
   * 那篇文稿导出时拿到的就是空。
   *
   * 之所以敢留：客户端侧已经补齐了（7.17，store 的三个写入点都算），
   * 推空 body 的前提是**客户端比 7.17 还旧** —— 而内网部署里那意味着要升级，
   * 是个能被看见的动作，不是悄悄发生的。
   *
   * 断言验的是**机制**（「服务端没有兜底这一步」），不是后果。
   * 后果写在上面，因为它是这段代码存在的理由。
   */
  const docId = `bodysrv2_${SFX}`
  const r = await push({
    id: docId, bookId: B.id, title: '老客户端', createdAt: Date.now(), updatedAt: Date.now(),
    blocks, visibility: 'space', published: false, tags: [],   // 有正文，但没推 body
  })
  ok(r.status === 200, '推成功', String(r.status))
  const row = q('SELECT body, wordCount FROM docs WHERE id = ?', docId)[0]
  ok(!row?.body, 'body 是空的（服务端没替它按 blocks 算）', JSON.stringify(String(row?.body).slice(0, 50)))
  ok(!Number(row?.wordCount), 'wordCount 是空的', String(row?.wordCount))
  ok(String(row?.body) !== derivedBody && Number(row?.wordCount) !== derivedWords,
    '（对照：按 blocks 算出来本该是另一对值）')
}

/* ---------------------------------------------------------------- */
console.log('\n== 真防护：只带标题推一次，正文绝不能被清空 ==')
{
  /*
   * 这条**不是**取舍，是实打实的防护。
   *
   * 轻量 bootstrap 之后，没打开过的文稿**不带 blocks**。
   * 那种行必须**只带元信息**推上去，服务端原样保留正文 ——
   * 要是这里顺手把 body 清空，就正好复现了 7.17 那个「正文被清空」的事故，
   * 而且它只会在「客户端没加载正文」时发生，非常难认。
   *
   * 它靠的是两件事的合起来，**不是** upsertRow 里那句 `...existing`：
   *   · `toRow` 遇到 push 里没有的列直接 `continue`（不带它进 SQL）
   *   · 于是 UPDATE 的 SET 子句里压根不出现 body —— SQLite 不写的列保持原值
   *
   * 这两句我当时写反了。原注释说「靠 `{ ...existing, ...incoming }` 把旧行带回来」，
   * 于是我去破坏对照里把 `...existing` 删掉 —— **22 项照样全绿**。
   * 保护根本不来自那里。（这跟本轮另外两次「以为的机制不是真实机制」是同一条：
   *  改防护之前得先证伪它到底在防什么，不然拆的只是个摆设。）
   *
   * 真正能让它红的只有一类改动：**显式把没带的列写成 null**。
   * 也就是「有人为了防陈旧 body，顺手加一句 body = null」—— 已实测会红（1 项）。
   *
   * 造前置状态这里可以直接走 push —— 因为服务端不再重算，推什么就是什么。
   * （原版套件里那段「造前置状态必须直接改库」的注释，是写在服务端还重算的时候的，
   *  那个约束已经跟着一起没了。留着它会误导下一个读的人。）
   */
  const docId = `bodysrv3_${SFX}`
  const SENTINEL = '# 历史正文哨兵\n\n这几行不该被动'
  const r0 = await push({
    id: docId, bookId: B.id, title: '只改标题那一行', createdAt: Date.now(), updatedAt: Date.now(),
    body: SENTINEL, wordCount: 4242, blocks,
    visibility: 'space', published: false, tags: [],
  })
  ok(r0.status === 200, '先推一行带正文和 4242 字数的文稿', String(r0.status))

  const r = await push({ id: docId, title: '只改标题那一行（正文没加载）' })
  ok(r.status === 200, '只带标题推一次（不带 blocks，模拟轻量客户端）', String(r.status))

  const row = q('SELECT title, body, wordCount FROM docs WHERE id = ?', docId)[0]
  ok(row?.title === '只改标题那一行（正文没加载）', '标题改成了', String(row?.title))
  ok(row?.body === SENTINEL,
    '**正文没被清空**（不带 blocks ≠ 正文为空）', JSON.stringify(String(row?.body).slice(0, 40)))
  ok(Number(row?.wordCount) === 4242,
    '**字数也没被清空**（4242 是我推进去的哨兵，没被动过）', String(row?.wordCount))
}

/* ---------------------------------------------------------------- */
console.log('\n== 撤掉重算的真正理由：body 确实能独立承载链接 ==')
{
  /*
   * 上面那个取舍不是拍脑袋。`docLinkSources` 扫的是 **body + 每块的
   * html/text/title/data.url** —— 它两边都认，而这两边**不等价**。
   *
   * 下面这篇的链接**只写在 body 里，blocks 是空数组**。
   * 它照样得进 doc_links。
   *
   * 也就是说：服务端一旦按 blocks 重算 body，这篇的出链当场消失，
   * 「谁引用了我」变成空列表 —— 正是 test-doclinks 33/9 那 9 项失败。
   * 这条断言就是**那个失败的最小复现**，钉在这里，以后谁再想加回重算，
   * 改完跑一遍就知道自己在动什么。
   */
  const target = `bodysrv_t_${SFX}`
  const source = `bodysrv_s_${SFX}`
  await push({
    id: target, bookId: B.id, title: '被引用的那篇', createdAt: Date.now(), updatedAt: Date.now(),
    body: '# 被引用的那篇', wordCount: 6, blocks: [{ id: 't1', type: 'h1', text: '被引用的那篇' }],
    visibility: 'space', published: false, tags: [],
  })

  const route = `#/book/${B.id}/doc/${target}`
  const r = await push({
    id: source, bookId: B.id, title: '链接只写在 body 里', createdAt: Date.now(), updatedAt: Date.now(),
    body: `看看这篇：${route}\n\n`, wordCount: 8,
    blocks: [],                      // ← 空的！链接不在 blocks 里
    visibility: 'space', published: false, tags: [],
  })
  ok(r.status === 200, '推出那篇「链接只在 body、blocks 为空」的文稿', String(r.status))

  const links = q('SELECT targetDocId FROM doc_links WHERE sourceDocId = ?', source)
  ok(links.length === 1 && links[0]?.targetDocId === target,
    '**出链记下来了**（blocks 是空的，链接只在 body 里也认）',
    `doc_links 里是 ${JSON.stringify(links)}`)

  const blocksNow = q('SELECT blocks FROM docs WHERE id = ?', source)[0]
  const asArr = JSON.parse(String(blocksNow?.blocks || '[]'))
  ok(asArr.length === 0,
    '（确认前置状态：blocks 真的是空的，不是「也有一份链接」把问题糊过去了）',
    `blocks 是 ${JSON.stringify(asArr)}`)
}

/* ---------------------------------------------------------------- */
console.log('\n== 源码层面：upsertRow 里没有重算，别加回来 ==')
{
  const src = readFileSync('server/sync.ts', 'utf8')
  const idx = src.indexOf('function upsertRow')
  const seg = src.slice(idx, src.indexOf('\n}\n', idx))
  ok(!/blocksToMarkdown/.test(seg),
    'upsertRow 里没有 blocksToMarkdown（撤干净了，没留半截）',
    /blocksToMarkdown/.test(seg) ? '还有引用' : '')
  ok(!/void blocksToMarkdown/.test(src), '没有为了「让 import 不被当成未使用」而留的占位引用')

  const n = (src.match(/blocksToMarkdown\(/g) || []).length
  ok(n === 0, `server/sync.ts 里 0 处引用（实际 ${n} 处）`)

  const md = readFileSync('src/lib/blocks-markdown.ts', 'utf8')
  ok(/export function blocksToMarkdown/.test(md), '口径那份仍然只有一份，还在 lib 里')
  ok(!/blocks-markdown/.test(src.split('*/')[0]),
    'server/sync.ts 顶部也没有把它 import 回来（注释里说明为什么）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
/*
 * 收摊：**先 kill、等真的退出，再删库**。顺序反了就删不掉。
 *
 * ⚠️ 这里先后踩了两个坑，都写下来：
 *   ① 上一版把 `cleanup` 的**定义**删了，而早退分支仍在调用它 →
 *      ReferenceError，整套连结果都不打印。
 *   ② 改对之后仍然删不掉 —— 因为我把删库放在了 `cleanup()` **之前**，
 *      那一刻服务端还活着，文件当然锁着。
 *      而且 `server.killed` 只是「信号已发出」不是「已退出」，别拿它当退出标志。
 *
 * 只 kill 不删库的后果：单独跑一次就在 data/ 里留一个库。
 * 全量跑时 runner 的清扫会兜住，**单独跑不会** —— 而单独跑正是排查时做的事。
 */
cleanup()                                   // 先停服务
{
  const { rmSync: rmDb, existsSync: exDb } = await import('node:fs')
  for (let i = 0; i < 30 && server.exitCode === null && server.signalCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const stuck = []
  for (const s of ['', '-wal', '-shm']) {
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {
      try { rmDb(DB + s, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone && exDb(DB + s)) stuck.push(DB + s)
  }
  if (stuck.length) console.log('  ⚠️  临时库删不掉（服务可能还占着）：' + stuck.join(', '))
}
process.exit(fail ? 1 : 0)
