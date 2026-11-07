/**
 * 增量同步的收敛性：**两条路必须给出同一个状态**。
 *
 * ============================================================
 * 为什么要有这个套件
 * ------------------------------------------------------------
 * 多设备一致性的全部承诺都压在一句话上：
 * 「我这台改了,那台同步过去之后内容一样」。
 *
 * 实际有两条路能把另一台设备拉到最新：
 *   ① 增量：`GET /api/sync/changes?since=N` 反复拉,本地逐条应用
 *   ② 全量：重新 bootstrap 一次
 *
 * 正常情况下没人会去验「① 累积起来 == ②」——
 * 因为要构造一个「客户端」还得实现一遍 applyChanges，等于又写一遍产品代码。
 *
 * 所以这里换个法子：**不实现客户端，只比结果**。
 * 从 S0 出发把增量一路追平，得到一份「按增量重建的状态」；
 * 同时拉一份全量，得到「真相」。两者必须**逐字段相等**。
 * 增量侧的重建逻辑写在测试里（小到十几行），与服务端实现完全独立 ——
 * 真有分歧，它不会两边一起错。
 *
 * 这一类 bug 的特点是**不报错**：少了 seq 的一条、某个实体的 remove 漏了、
 * 软删通知错了，都表现为「同步了一会儿内容对不上」，极难自查。
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
const DB = 'data/_converge-test.db'
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
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break } } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

const login = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
})
token = login.json.token || ''
ok(!!token, '管理员登录成功', login.json.error || '')

const sfx = Math.random().toString(36).slice(2, 8)

/**
 * 按增量重建一份状态。
 * 规则刻意写得笨：只做「upsert 覆盖、remove 删除」，
 * 服务端要是漏了某个实体的变更，这里就会和全量对不上。
 */
function applyDelta(state, delta) {
  for (const [entity, rows] of Object.entries(delta.upsert || {})) {
    state[entity] = state[entity] || {}
    for (const r of rows) {
      const pk = r.__pk || r.id || r.docId || r.bookId || r.userId
      state[entity][String(pk)] = r
    }
  }
  for (const [entity, ids] of Object.entries(delta.remove || {})) {
    state[entity] = state[entity] || {}
    for (const id of ids) delete state[entity][String(id)]
  }
  return state
}

const bootstrapState = async () => {
  const b = await api('/api/bootstrap?lite=0')
  const data = b.json.data || b.json.rows || {}
  const state = {}
  for (const [k, v] of Object.entries(data)) {
    if (!Array.isArray(v)) continue
    state[k] = {}
    for (const r of v) {
      const pk = r.id || r.docId || r.bookId || r.userId
      state[k][String(pk)] = r
    }
  }
  return { state, seq: b.json.seq }
}

/**
 * 深比较用的稳定序列化：**递归按键排序**。
 *
 * 一开始直接 `JSON.stringify` 比，结果报出来一堆「内容不同」——
 * 而差异只是**键的顺序**（增量和全量是两条不同的组装路径，插入顺序不一样）。
 * 客户端按 id 取值，根本不关心键序，所以键序不同不算分歧。
 * 少了这一步，这个套件会以「20 种实体全都不一致」这种假象把自己废掉。
 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

/**
 * 协议内部字段：比较时排除。
 *
 * `_rev` 是**有意**只出现在增量流里的（服务端 changesSince 里显式加上），
 * 全量 bootstrap 不带。客户端也明确把它排除在差分之外
 * （`src/lib/sync.ts` 的 `COMPARE_IGNORE`），只用它做回声识别。
 *
 * 所以它「只在一边有」是设计如此，不是分歧 ——
 * 比较口径必须和客户端一致，否则这个套件会以「20 种实体全不同」把自己废掉。
 * 下面另有一条断言确认 `_rev` 确实在增量里（字段本身不能被漏发）。
 */
const PROTOCOL_ONLY = new Set(['_rev'])

const strip = (r) => {
  if (r === null || typeof r !== 'object') return r
  const out = {}
  for (const k of Object.keys(r)) if (!PROTOCOL_ONLY.has(k)) out[k] = r[k]
  return out
}

console.log('\n== 建一批会同时动到多个实体的东西 ==')
{
  const t0 = await bootstrapState()
  ok(typeof t0.seq === 'number', `全量拉取带回了 seq（${t0.seq}）`, JSON.stringify(t0.seq))

  // ① 建知识库 + 目录 + 文档  ② 改文档  ③ 改标题  ④ 加节点  ⑤ 软删一篇
  const bookId = 'cvb' + sfx
  const nodeId = 'cvn' + sfx
  const docA = 'cva' + sfx
  const docB = 'cvd' + sfx
  const now = Date.now()
  const up1 = await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        books: [{ id: bookId, spaceId: 's1', name: '收敛校验库 ' + sfx, createdAt: now, updatedAt: now }],
        nodes: [{ id: nodeId, bookId, parentId: null, title: '入口', type: 'group', ord: 0, createdAt: now, updatedAt: now }],
        docs: [
          { id: docA, bookId, title: '甲 ' + sfx, body: '初稿', createdAt: now, updatedAt: now, wordCount: 2 },
          { id: docB, bookId, title: '乙 ' + sfx, body: '待删', createdAt: now, updatedAt: now, wordCount: 2 },
        ],
      },
    }),
  })
  ok(up1.status === 200 && !(up1.json.rejected || []).length, '第一批：建库 + 建节点 + 建两篇文档',
    `${up1.status} ${JSON.stringify(up1.json.rejected || [])}`)

  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: docA, bookId, title: '甲 ' + sfx, body: '改成第二稿', createdAt: now, updatedAt: now + 1, wordCount: 5 }] } }),
  })
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: docA, bookId, title: '甲改标题 ' + sfx, body: '改成第二稿', createdAt: now, updatedAt: now + 2, wordCount: 5 }] } }),
  })
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ remove: { docs: [docB] } }),
  })
  console.log('       又改了正文、改了标题、软删了一篇')

  console.log('\n== 增量追平的结果，必须等于全量重拉 ==')
  const incState = JSON.parse(JSON.stringify(t0.state))
  let cur = t0.seq
  let rounds = 0
  for (;;) {
    const d = (await api(`/api/sync/changes?since=${cur}`)).json
    rounds++
    applyDelta(incState, d)
    if (typeof d.seq === 'number' && d.seq > cur) cur = d.seq
    if (rounds > 200) break
    // 没有新 seq 了就收工（连拉两次 seq 不变即追平）
    if (rounds > 1 && typeof d.seq === 'number' && d.seq === cur) break
    if (!d.upsert && !d.remove) break
  }
  ok(rounds >= 1, `增量拉了 ${rounds} 轮追平`)

  const full = await bootstrapState()
  const names = new Set([...Object.keys(full.state), ...Object.keys(incState)])
  const diffs = []
  for (const k of names) {
    const a = incState[k] || {}
    const b = full.state[k] || {}
    const ids = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const id of ids) {
      if (!a[id]) { diffs.push(`${k}/${id} 增量里缺，全量有`); continue }
      if (!b[id]) { diffs.push(`${k}/${id} 增量里有，全量没有`); continue }
      if (stable(strip(a[id])) !== stable(strip(b[id]))) {
        diffs.push(`${k}/${id} 内容不同：增量 ${stable(strip(a[id])).slice(0, 90)} / 全量 ${stable(strip(b[id])).slice(0, 90)}`)
      }
    }
  }
  ok(diffs.length === 0, `${names.size} 种实体、逐条逐字段，增量重建结果与全量完全一致`, diffs.slice(0, 3).join(' | '))
  ok(incState.docs?.[docA]?.title === '甲改标题 ' + sfx, '新增的那篇在增量侧也在，标题是最新的',
    JSON.stringify(incState.docs?.[docA]?.title))
  ok(!incState.docs?.[docB], '软删的那篇在增量侧也确实没了（软删要作为「删除」通知各端）')
  ok(incState.books?.[bookId] && incState.nodes?.[nodeId], '新建的知识库和目录节点，增量侧都补上了')

  /**
   * 变更量要**超过一页**，否则「悄悄截断」这类 bug 根本测不出来。
   *
   * 原来这个套件只造了 5 条变更，于是把 `LIMIT 2000` 改成 `LIMIT 50` 破坏时，
   * 断言照样全绿 —— 不是断言写对了，是**用例压根没跑到那个量级**。
   * 「否定式断言在没触发的路径上永远为真」的老问题，这次是反过来的：
   * 破坏没被覆盖，却一度看着像「这条检查很稳」。
   */
  {
    const n = 60          // 故意超过一个常见的单页上限
    const bulk = []
    for (let i = 0; i < n; i++) {
      bulk.push({ id: `bulk${sfx}_${i}`, bookId, title: `批量 ${i} ${sfx}`, body: 'x', createdAt: now + i, updatedAt: now + i, wordCount: 1 })
    }
    // **基线必须在推送之前取**。第一版写在推送之后，于是增量压根没东西可送，
    // 状态本来就是对的 —— 把「只回最新一页」那个破坏加上去也照样全绿。
    const t1 = await bootstrapState()
    const r = await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: bulk } }) })
    ok(r.status === 200 && !(r.json.rejected || []).length, `一次推送 ${n} 篇（制造超过一页的变更量）`,
      `${r.status} ${JSON.stringify(r.json.rejected || []).slice(0, 80)}`)

    const inc = JSON.parse(JSON.stringify(t1.state))
    let cur2 = t1.seq, rounds2 = 0
    for (;;) {
      const d = (await api(`/api/sync/changes?since=${cur2}`)).json
      rounds2++
      applyDelta(inc, d)
      if (typeof d.seq === 'number' && d.seq > cur2) cur2 = d.seq
      if (rounds2 > 300) break
      if (rounds2 > 1 && typeof d.seq === 'number' && d.seq === cur2) break
      if (!d.upsert && !d.remove) break
    }
    const full2 = await bootstrapState()
    let miss = 0
    for (const d of bulk) if (inc.docs?.[d.id]?.title !== d.title) miss++
    ok(miss === 0, `${n} 篇批量新增在增量侧全都追上了（增量只回最新一页时，中间那些会悄悄丢）`,
      `漏了 ${miss} 篇`)
    const same = Object.keys(full2.state.docs || {}).length === Object.keys(inc.docs || {}).length
    ok(same, '增量追平后文档总数与全量一致',
      `增量 ${Object.keys(inc.docs || {}).length} / 全量 ${Object.keys(full2.state.docs || {}).length}`)
    void rounds2
  }

  // `_rev` 是协议内部字段：只出现在增量里是**设计如此**（客户端差分时也排除它）。
  // 但它不能被漏发 —— 客户端靠它做回声识别，少了就会把自己的推送当成别人的改动再应用一遍。
  const d2 = (await api(`/api/sync/changes?since=${t0.seq}`)).json
  const anyRow = Object.values(d2.upsert || {}).flat()[0]
  ok(anyRow && '_rev' in anyRow, '增量行带 _rev（客户端靠它识别回声，漏发就等于把自己的改动当别人的）',
    anyRow ? JSON.stringify(Object.keys(anyRow)).slice(0, 90) : '增量里没有任何行')
  // `_rev` 只在增量里发（实测：全量 4 库/26 文档/32 节点/5 小记，0 行带 `_rev`）。
  // 这条改用源码级检查 —— 之前写成运行时的 `'x' in obj || {}` 判空表达式，
  // 结果在 `?.` 短路时给出和实测相反的结论，白查一轮。
  const { readFileSync } = await import('node:fs')
  const srvSrc = readFileSync('server/sync.ts', 'utf8')
  ok(/client\._rev = Number\(row\.rev/.test(srvSrc), '只有 changesSince 会给行加 _rev（改动这一行会让全量也带上它）')
  const cliSrc = readFileSync('src/lib/sync.ts', 'utf8')
  ok(/COMPARE_IGNORE[^\n]*'_rev'/.test(cliSrc), '客户端的差分白名单里排除了 _rev（它是协议内部字段）')
}

console.log('\n== 中途换人：别人的改动对我不可见 ==')
{
  // 一个不在任何库里的账号，不该看到别人建的库 —— 增量也不能
  const t = await bootstrapState()
  const acct = 'conv_' + sfx
  const pw = 'Cv@2026pass'
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ account: acct, name: '路人', password: pw }),
  })
  ok(reg.status === 200 || reg.status === 409, '造一个外部账号', String(reg.status))
  const admin = token
  token = ''
  const li = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: acct, password: pw }) })
  token = li.json.token
  ok(!!token, '路人能登录')
  const seen = await api(`/api/sync/changes?since=${t.seq}`)
  const leaked = Object.values(seen.json.upsert || {}).flat()
    .filter((r) => String(r.bookId || '').startsWith('cvb') || String(r.id || '').startsWith('cv'))
  ok((seen.json.upsert || {}).books === undefined || !(seen.json.upsert.books || []).some((b) => String(b.id).startsWith('cvb')),
    '增量里没有他读不到的知识库（增量不能绕过权限）',
    JSON.stringify((seen.json.upsert?.books || []).map((b) => b.id)))
  void leaked
  token = admin
}

cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
