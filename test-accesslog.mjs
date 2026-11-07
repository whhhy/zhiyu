/**
 * 员工访问日志（语雀企业版的「员工访问日志」）。
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 之前项目里只有「操作日志」（谁改了配置、谁导出、谁离职被回收）。
 * 但公司做涉密文档的**访问复核**时要的是另一半：谁在什么时候看过哪些文档。
 * 等保 / ISO 27001 检查里这是常被点名的项。
 *
 * 数据其实早就在记了 —— `doc_views` 记的是「谁在哪天看过哪篇」，
 * 之前只是没有一个能看它的入口。这条套件钉的是：
 *  ① 真的能被记进去（写入前过了权限判定，刷不进来）
 *  ② **同一人同一天同一篇只记一次** —— 这是访问量不被刷新灌水的前提，
 *     也是这张表有界、几个月后还查得动的前提
 *  ③ 只有管理员看得到；普通成员是 403 而不是「给你一个空列表」
 *  ④ 粒度是**天**，时间点是当天首次 —— 界面上照实说，不假装是秒级
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.YQ_PORT || '8092'
const DB = 'data/_accesslog-test.db'
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
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

/**
 * 先删旧库，**再**起服务。
 *
 * 只在跑完时清理是不够的：上一轮如果是被杀的（工具超时、手动 Ctrl-C），
 * 清理代码根本不会执行，旧库就留在那儿。而 doc_views 的主键是
 * (docId, day, userId) + INSERT OR IGNORE，旧库里那条记录还在 ——
 * 于是「看过一次就记上」这条断言**永远不成立**，而且报出来的是
 * 「3 -> 3」这种看不出原因的数字。
 *
 * 这个坑我自己踩过：`run-all-tests` 的启动清扫当初也只挂在末尾。
 */
for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
}

const server = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

const cleanup = () => {
  try { server.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}
process.on('exit', cleanup)

let up = false
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

const login = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
})
token = login.json.token || ''
ok(!!token, '管理员登录成功', login.json.error || '')

const docs = (await api('/api/entity/docs')).json.rows || []
const [A, B, C] = docs
ok(docs.length >= 3, `拿到至少 3 篇文档（实际 ${docs.length}）`)

/**
 * 造一篇**全新**的文档，后面拿它做「第一次看」的实验。
 *
 * 原来直接拿种子里的 B 来测，结果在 `test:all` 里挂了：那个 runner 起的是
 * **一个共享服务**，所有套件都打在同一个库上，前面的套件早就把 B 的
 * (docId, day, userId) 记下了 —— 于是「第一次看必然新增」不成立，报成 `18 -> 18`。
 *
 * 教训：套件不能假设自己独占服务，也不能假设库是干净的。
 * 要测「新增」，就自己造一个**一定没被记过**的东西出来。
 */
const FRESH = 'acc_probe_' + Math.random().toString(36).slice(2, 8)
{
  const now = Date.now()
  const r = await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        // createdAt / updatedAt 是 NOT NULL 列，少一个就整条被拒（报错才看得见）
        docs: [{ id: FRESH, bookId: A.bookId, title: '访问日志探针文档', body: '探针', createdAt: now, updatedAt: now, wordCount: 2 }],
      },
    }),
  })
  ok(r.status === 200 && !(r.json.rejected || []).length, '造一篇全新文档（保证没人看过它）',
    `${r.status} ${JSON.stringify(r.json.rejected || [])}`)
}
const target = { id: FRESH, bookId: A.bookId, title: '访问日志探针文档' }

const viewCount = async () => ((await api('/api/accesslog')).json.items || []).length

console.log('\n== 看过一次就记上 ==')
{
  const n0 = await viewCount()
  const r = await api(`/api/doc/${target.id}/view`, { method: 'POST' })
  ok(r.status === 200, '记一次阅读', String(r.status))
  const n1 = await viewCount()
  ok(n1 === n0 + 1, '访问日志多了一条', `${n0} -> ${n1}`)
}

console.log('\n== 同一天看同一篇，只记一次 ==')
{
  /**
   * 这条是整张表的地基。
   * 主键是 (docId, day, userId)，写入用 INSERT OR IGNORE ——
   * 不去重的话，刷新页面就能把「访问量」灌到任意大，
   * 而访问日志自己也跟着被灌满，几个月后就查不动了。
   */
  const before = await viewCount()
  for (let i = 0; i < 5; i++) await api(`/api/doc/${target.id}/view`, { method: 'POST' })
  const after = await viewCount()
  ok(after === before, `连看 5 次仍是 ${before} 条（没被刷页面灌水）`, `${before} -> ${after}`)

  const other = await api(`/api/doc/${A.id}/view`, { method: 'POST' })
  // A 前面可能已被别的套件看过，所以这条只要求「不多不少」——
  // 断言真正要防的是「多出一条」，不是「一定多一条」
  ok(other.status === 200, '换一篇记一次也不报错', String(other.status))
  const after2 = await viewCount()
  ok(after2 - after <= 1, '换一篇最多 +1（不是每次都新开一行）', `${after} -> ${after2}`)
}

console.log('\n== 记录的内容够回答「谁看过什么」==')
{
  const r = await api('/api/accesslog')
  const items = r.json.items || []
  const mine = items.find((x) => x.docId === target.id)
  ok(!!mine, '能找到刚才那篇的记录')
  ok(mine && mine.userName && mine.userAccount, '带着人的名字和账号（不是只有一个 userId）', JSON.stringify(mine))
  ok(mine && mine.docTitle === target.title, '带着文档标题', JSON.stringify(mine && mine.docTitle))
  ok(mine && mine.bookName, '带着知识库名字（复核时要按库筛）', JSON.stringify(mine && mine.bookName))
  ok(mine && /^\d{4}-\d{2}-\d{2}$/.test(mine.day), '带着日期', JSON.stringify(mine && mine.day))
  ok(mine && mine.firstAt > 0, '带着当天首次阅读的时刻')
}

console.log('\n== 粒度要照实说，不能假装是秒级 ==')
{
  const r = await api('/api/accesslog')
  ok(r.json.granularity === 'day', '接口明说粒度是「天」', JSON.stringify(r.json.granularity))
  ok(/同一人同一天/.test(String(r.json.note || '')), '接口把「同一人同一天只记一次」这句话一起给出来，界面照着说', r.json.note)
}

console.log('\n== 越权：只有管理员看得到 ==')
{
  const acct = 'acc_' + Math.random().toString(36).slice(2, 8)
  const pw = 'Ac@2026pass'
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ account: acct, name: '普通成员', password: pw }),
  })
  ok(reg.status === 200 || reg.status === 409, '造一个普通成员', String(reg.status))
  const uid = reg.json.userId || reg.json.user?.id || reg.json.id

  const adminToken = token

  /**
   * 关键：得先把他**加进这篇文档所在的空间**，他才读得了这篇。
   * 不加的话他读这篇本身就是 403，那么「访问日志 403」就分不清
   * 是访问日志的守卫在起作用，还是他压根没权限 ——
   * 这种前提不成立的断言，等于什么都没验。
   */
  const book = (await api(`/api/entity/books`)).json.rows.find((b) => b.id === B.bookId)
  const add = await api(`/api/spaces/${book.spaceId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds: [uid], role: 'member' }),
  })
  ok(add.status === 200 && !(add.json.failed || []).length,
    '把他加进这篇文档所在的空间', `${add.status} ${JSON.stringify(add.json).slice(0, 90)}`)

  token = ''
  const li = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: acct, password: pw }) })
  token = li.json.token
  ok(!!token, '普通成员能登录')

  // 前提校验：他**能**读这篇文档 —— 不然 403 可能只是「他没权限」
  const canRead = await api(`/api/doc/${target.id}`)
  ok(canRead.status === 200, '前提：普通成员读得了这篇文档（读不到的话，403 就证明不了任何东西）', String(canRead.status))

  // 他读得了，看一眼也会被记上 —— 证明这条记录真在收
  await api(`/api/doc/${target.id}/view`, { method: 'POST' })
  const r = await api('/api/accesslog')
  ok(r.status === 403, '普通成员查访问日志 → 403（不是给他一个空列表）', `${r.status} ${JSON.stringify(r.json)}`)

  token = adminToken
  const adm = await api('/api/accesslog')
  ok((adm.json.items || []).some((x) => x.userAccount === acct),
    '管理员能看到刚才这位成员的阅读记录（守卫按角色放行，不是按「有记录就藏起来」）',
    JSON.stringify((adm.json.items || []).map((x) => x.userAccount)))
}

console.log('\n== 不带 token 一律 401 ==')
{
  const saved = token
  token = ''
  ok((await api('/api/accesslog')).status === 401, '访问日志 → 401')
  token = saved
}

console.log('\n== 筛选参数不能把接口变成提权口子 ==')
{
  const r = await api('/api/accesslog?bookId=不存在&days=99999&limit=99999')
  ok(r.status === 200, '参数不给也不报错', String(r.status))
  ok((r.json.items || []).length === 0, '查一个不存在的库返回空，不返回别人的东西')
  const r2 = await api('/api/accesslog?days=-5&limit=-1')
  ok(r2.status === 200 && (r2.json.items || []).length <= 500, '负数 / 超大参数被夹住，不会把整表吐出来', String((r2.json.items || []).length))
}

console.log('\n== 界面：入口、筛选、以及「按天」这句话真的摆在页面上 ==')
{
  const { readFileSync } = await import('node:fs')
  const s = readFileSync('src/pages/Settings.tsx', 'utf8')
  const api2 = readFileSync('src/lib/api.ts', 'utf8')

  // 入口跟操作日志一起挂在 isAdmin 下 —— 给普通成员摆一个点进去就 403 的 tab 没意义
  ok(/isAdmin \? \[\s*\{ v: 'audit'/.test(s.replace(/\n\s+/g, ' ')) ||
     /isAdmin \? \[/.test(s) && /v: 'access', l: '访问日志'/.test(s),
    '访问日志 tab 在管理员分组里')
  ok(/tab === 'access' && <AccessLogPanel \/>/.test(s), 'tab 真的渲染面板（不是只挂了个空 tab）')
  ok(/function AccessLogPanel/.test(s), '面板组件存在')

  // 粒度必须写在页面上，不能只在接口注释里
  const panel = s.slice(s.indexOf('function AccessLogPanel'), s.indexOf('function AccessLogPanel') + 2600)
  ok(/按天记录/.test(panel), '面板上明说「按天记录」')
  ok(/当天首次阅读的时刻/.test(panel), '面板上明说时间是「当天首次阅读的时刻」')
  ok(/refresher|刷新/.test(s), '有刷新入口')

  // 面板不能把两件事混成一件
  ok(/不是「?操作日志|两回事/.test(panel) || /两回事/.test(panel), '面板上说清它和「操作日志」不是一回事')

  ok(/export const accessLog/.test(api2), 'api 里有访问日志的调用')
  ok(/粒度是天/.test(api2), '客户端注释也写明粒度是天')
}

console.log('\n== 源码层面：访问日志必须复用 doc_views，不要另开一张无界的表 ==')
{
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync('server/index.ts', 'utf8')
  const seg = idx.slice(idx.indexOf('/api/accesslog') - 200, idx.indexOf('/api/accesslog') + 1800)
  ok(/FROM doc_views/.test(seg), '读的是 doc_views（本来就有的、按天去重的那张表）')
  ok(!/CREATE TABLE/.test(seg), '没有为访问日志新建表（逐次记录会几个月就涨到不可用）')
  ok(/role !== 'owner' && .*role !== 'admin'/.test(seg), '入口有管理员判定')
  ok(/capsInBook\(me, String\(r\.bookId\)\)\.read/.test(seg), '按管理员自己能读的范围过滤（他打不开的库不列）')
}

cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
