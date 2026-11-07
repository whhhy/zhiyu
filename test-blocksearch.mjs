/**
 * 搜索关键词屏蔽（语雀企业版的「搜索关键词屏蔽」）。
 *
 * ============================================================
 * 这个功能最容易做成「看起来有、其实没用」
 * ------------------------------------------------------------
 * 如果先搜出来、再让前端把命中的过滤掉，那等于**先把标题和片段发出去**再收回 ——
 * 抓一下响应就全看到了。屏蔽必须发生在**服务端、连 SQL 都不发**。
 *
 * 所以这里刻意**直接打 /api/search** 断言，不经过界面：
 * 界面那层再对，绕过去能拿到结果，功能就等于没做。
 *
 * 另一个坑：拿一个种子数据里**本来就不存在**的词（比如「薪酬」）来测，
 * 屏蔽前后都是 0 条，看起来对，其实什么都没验。
 * 所以先用**确实搜得到**的词量出基线数，再拿它去挡。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.YQ_PORT || '8092'
const DB = 'data/_blocksearch-test.db'
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

const books = (await api('/api/entity/books')).json.rows || []
const bk = books[0]
ok(!!bk, `拿到至少一个知识库（实际 ${books.length}）`)

const s = async (q) => ((await api(`/api/search?q=${encodeURIComponent(q)}`)).json.results || []).length
const setBlock = (on, terms) => api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bk.id, blockSearch: on ? 1 : 0, blockTerms: terms }] } }),
})

/** 找一个确实搜得到的词当屏蔽词 —— 拿不存在的词去测，两边都是 0，测不出任何东西 */
let REAL = ''
let baseCount = 0
for (const cand of ['产品', '知识库', '团队', '文档', '语雀', '使用']) {
  const n = await s(cand)
  if (n > 0) { REAL = cand; baseCount = n; break }
}
ok(baseCount > 0, `找到一个确实搜得到的词当屏蔽词：「${REAL}」${baseCount} 条`)

console.log('\n== 开了屏蔽就真的搜不到 ==')
{
  const r = await setBlock(true, [REAL])
  ok(r.status === 200 && !(r.json.rejected || []).length, '配置屏蔽词', `${r.status} ${JSON.stringify(r.json.rejected || [])}`)
  ok((await s(REAL)) === 0, `搜「${REAL}」从 ${baseCount} 条变成 0 条`)
}

console.log('\n== 含屏蔽词的长查询也挡掉 ==')
{
  // 漏这一条的话，「产品手册」这种把屏蔽词包在中间的查询就能绕过去
  const probe = REAL + '手册'
  const before = await s(probe)
  const after = await s(probe)
  ok(after === 0, `搜「${probe}」也是 0 条（屏蔽是**包含**关系，不是整词相等）`, `${before} -> ${after}`)
}

console.log('\n== 挡的是「查询词」，不是「结果」 ==')
{
  /**
   * 如果改成「结果里含屏蔽词就不给」，那整个知识库会连正常内容一起消失 ——
   * 那不是屏蔽，是自残。必须只挡查询词。
   */
  let found = ''
  for (const cand of ['使用', '团队', '文档', '帮助', '设置']) {
    if (cand.includes(REAL)) continue
    if ((await s(cand)) > 0) { found = cand; break }
  }
  ok(!!found, '找一个不含屏蔽词但确实搜得到的词（用来证明没误伤）')
  const n = await s(found)
  ok(n > 0, `搜「${found}」仍有 ${n} 条（没被连坐）`, `实际 ${n}`)
}

console.log('\n== 大小写不敏感（换个写法不该绕过去）==')
{
  /**
   * 这里踩了两次坑才写成现在这样：
   *
   * ① 屏蔽中文「产品」测大小写 —— 中文压根没有大小写，等于没测；
   * ② 换成 ASCII 词 `SECRETKEY` 去搜 `secretkey` —— 这个词**数据里本来就不存在**，
   *    屏蔽前后都是 0 条，分不清是「被挡」还是「压根搜不到」。
   *
   * 所以先造一篇**确实搜得到**的文档，再拿它的标题做大小写实验。
   * 只有「先搜得到 → 屏蔽后搜不到」这个对照成立，结论才算数。
   */
  const marker = 'Zqmarker' + Math.random().toString(36).slice(2, 7)
  const now = Date.now()
  const mk = await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { docs: [{ id: 'blk_' + marker, bookId: bk.id, title: '大写词 ' + marker.toUpperCase(), body: marker, createdAt: now, updatedAt: now, wordCount: 1 }] },
    }),
  })
  ok(mk.status === 200 && !(mk.json.rejected || []).length, '造一篇带 ASCII 标记的文档',
    `${mk.status} ${JSON.stringify(mk.json.rejected || [])}`)

  const lower = marker.toLowerCase()
  const upper = marker.toUpperCase()
  const before = await s(lower)
  ok(before > 0, `前提：小写「${lower}」本来就搜得到（${before} 条）—— 不成立的话后面全都不算数`, `实际 ${before}`)

  await setBlock(true, [upper])
  const afterLower = await s(lower)
  const afterUpper = await s(upper)
  ok(afterLower === 0, `屏蔽了大写「${upper}」，小写「${lower}」照样被挡（${before} -> ${afterLower}）`)
  ok(afterUpper === 0, `大写「${upper}」自己也挡掉了`)

  await setBlock(false, [])
  const back = await s(lower)
  ok(back === before, `关掉后小写恢复到 ${before} 条`, `实际 ${back}`)
}

console.log('\n== 关掉立刻恢复（改完要立刻生效）==')
{
  await setBlock(false, [])
  ok((await s(REAL)) === baseCount, `关闭后搜「${REAL}」恢复到 ${baseCount} 条`, `实际 ${await s(REAL)}`)
}

console.log('\n== 词表坏了不能把搜索整个搞挂 ==')
{
  // 直接把列写成非法 JSON，模拟配置写坏
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bk.id, blockSearch: 1 }] } }),
  })
  const raw = await fetch(BASE + '/api/search?q=' + encodeURIComponent('知识库'), { headers: { Authorization: 'Bearer ' + token } })
  ok(raw.status === 200, '词表为空 / 缺失时搜索照常 200', String(raw.status))
  await setBlock(false, [])
}

console.log('\n== 绕开界面直接打 API 一样挡 ==')
{
  await setBlock(true, [REAL])
  const r = await fetch(BASE + '/api/search?q=' + encodeURIComponent(REAL), { headers: { Authorization: 'Bearer ' + token } })
  const j = await r.json().catch(() => ({}))
  ok(r.status === 200 && (j.results || []).length === 0,
    '不经界面直接请求，结果也是空（不是前端藏的）',
    `${r.status} ${JSON.stringify(j).slice(0, 80)}`)
  await setBlock(false, [])
}

console.log('\n== 界面：开关、词表、以及「挡查询词不是挡结果」这句话 ==')
{
  const ui = readFileSync('src/pages/BookSettings.tsx', 'utf8')
  const sec = ui.slice(ui.indexOf('function SecurityTab'))
  ok(/搜索关键词屏蔽/.test(sec), '安全页有这一项')
  /*
   * ⚠️ 这三条原来是**逐字匹配**（2026-10-18 放宽到不变式）。
   *
   * 起因：`BookSettings` 里 `blockSearch` / `blockTerms` 被改成**可选**
   * （`blockSearch?: boolean`），而 `defaultBookSettings()` **故意不给它们默认值**
   * —— 走数据库列的默认值（`db.ts` 里 `blockSearch INTEGER NOT NULL DEFAULT 0`）。
   * 这不是漏，是 `server/sync.ts` 里写明的刻意留白：
   * 「前端不给默认值，用表默认的『不屏蔽』」，而且
   * 「`book_settings` 的列清单在项目里有五份、各自独立维护，
   *   『五处应当一致』这个不变量**本来就不成立**」。
   *
   * 于是代码侧改成了 `checked={!!s.blockSearch}`，而原来的
   * `/checked=\{s\.blockSearch\}/` 和 `/blockSearch: boolean/`
   * 立刻红 —— 它们钉的是**写法**，不是**要验的那件事**。
   *
   * 「守卫按原文措辞匹配，改一个字就全红」和它的反面是同一个坑：
   * 早先那条「按原文措辞匹配」的守卫，被人把「`@` 选卡片」改成「`@` 选。」
   * 就全绿了 —— 等于没有守卫。这里反过来：**该绿的东西也会红**，
   * 同样等于没有守卫（它把「写法变了」报成「功能坏了」，
   * 报告会把人引向错误的排查方向）。
   *
   * 所以这三条改成断言**不变式**：
   *   · 开关绑在 `s.blockSearch` 上（允许 `!!` / `Boolean()` 这类等价写法）
   *   · 类型里**声明了**这两列（必填或可选都算 —— 要验的是「有类型」，
   *     不是「必填」；而**为什么是可选**写在了类型定义旁边的注释里）
   */
  ok(/checked=\{[^}]*\bs\.blockSearch\b[^}]*\}/.test(sec),
    '开关真的绑在 blockSearch 上（`!!` / `Boolean()` 这类等价写法都算）')
  ok(/blockTerms/.test(sec), '词表可增删')
  ok(/服务端直接拒绝|服务端/.test(sec), '界面上说清是服务端拦的')
  ok(/挡的是.*查询词/.test(sec.replace(/\n\s*/g, ' ')), '界面上说清「挡的是查询词，不是结果」（否则用户会以为整个库被藏了）')

  const types = readFileSync('src/types/index.ts', 'utf8')
  ok(/blockSearch\??: boolean/.test(types), '类型里有 blockSearch（可选也算 —— 见上面那段）')
  ok(/blockTerms\??: string\[\]/.test(types), '类型里有 blockTerms（可选也算 —— 见上面那段）')
  /* 反过来钉一下**为什么**是可选的：类型注释里必须写清那个刻意留白，
     否则下一个人看到 `?` 会以为「补上默认值」才是修复。
     ⚠️ 必须在 **BookSettings 接口内部**找 —— 直接 `types.indexOf('blockSearch')`
     会命中文件里更早的另一处出现（别处的实体清单），窗口根本到不了这段注释，
     于是这条断言恒假。第一版就栽在这儿。 */
  const bsIface = types.indexOf('interface BookSettings')
  const bsSeg = bsIface >= 0 ? types.slice(bsIface, types.indexOf('\n}', bsIface)) : ''
  ok(/默认值|走数据库列|不屏蔽/.test(bsSeg),
    '类型注释里写明了「为什么这两列是可选的」（否则会被后人「补全」成必填）',
    bsIface >= 0 ? '' : '没找到 interface BookSettings')
}

console.log('\n== 源码层面：屏蔽必须在服务端、进 SQL 之前 ==')
{
  const sync = readFileSync('server/sync.ts', 'utf8')
  const fn = sync.slice(sync.indexOf('export function searchAll'))
  const guard = fn.indexOf('isBlockedSearchTerm')
  const sqlAt = fn.indexOf('db.prepare')
  ok(guard >= 0, 'searchAll 里调用了屏蔽判定')
  ok(guard >= 0 && sqlAt >= 0 && guard < sqlAt,
    '判定发生在发 SQL **之前**（先搜出来再过滤 = 把片段先发出去）',
    `guard@${guard} sql@${sqlAt}`)
  ok(/export function isBlockedSearchTerm/.test(sync), '判定本身是导出的（可单独测）')
  // 现读不缓存：管理员改完要立刻生效
  const fn2 = sync.slice(sync.indexOf('export function isBlockedSearchTerm'), sync.indexOf('export function searchAll'))
  ok(!/let cached|cachedTerms/.test(fn2), '词表是现读不缓存（撤下的词要立刻不挡）')
  const ent = readFileSync('server/entities.ts', 'utf8')
  ok(/json: \['ipList', 'blockTerms'\]/.test(ent), 'blockTerms 登记为 JSON 列（不会被当字符串塞进去）')
  ok(/'blockSearch'/.test(ent), 'blockSearch 登记为布尔列')
  const db = readFileSync('server/db.ts', 'utf8')
  ok(/blockSearch\s+INTEGER NOT NULL DEFAULT 0/.test(db), '旧库补列后默认关闭（不给存量实例意外开启）')
}

cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
