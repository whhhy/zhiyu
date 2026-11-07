/**
 * 搜索的**独立基准**：拿 /api/search 的结果，对一份自己算出来的答案。
 *
 * ============================================================
 * 为什么要有这个套件
 * ------------------------------------------------------------
 * 现有的搜索用例都是「搜某个词，断言它在/不在结果里」——
 * 那是拿**我写的期望**去对**我写的实现**，两边一起错照样全绿。
 *
 * 而搜索是知识库最要命的一条：搜不到 = 那份文档等于不存在。
 * 真正会坏的地方也不是「LIKE 写错了」这种一眼能看出的：
 *   · 索引陈旧 —— 改了 / 恢复了 / 删了文稿，search_index 没跟着重建
 *   · 块类型漏抽 —— 某类块的内容压根没进索引
 *   · LIKE 转义 —— 查询词里有 % 或 _ 时没转义，会被当成通配符
 *   · 字段口径 —— 索引抽了卡片名，正文里没有，用户却搜不到
 *
 * 这些光靠「搜一个词看看」很难全部抓到。所以这里换一个思路：
 * **从原始数据自己算一遍正确答案**，再和接口结果对。
 * 用的字段口径照抄 reindex 的注释（写在那儿就是为了让人能照着重算），
 * 但**代码路径完全独立** —— 一条走 SQL 索引，一条走 JS 遍历。
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
const DB = 'data/_oracle-test.db'
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

/**
 * 独立算一遍「一篇文档的可搜文本」。
 *
 * 口径：title + body + 每块的 text + 卡片 data 的**深走**结果；
 * 图片 / 分割线的空壳 text 不进（那是刻意的，进了只会稀释）。
 * 这里**不复用**服务端的任何函数 —— 口径一样、代码另写，
 * 抄一份过来就失去了它存在的意义。
 *
 * ⚠️ 2026-10-06 口径变过一次。原来只抽 `data.name` 与 `data.text` 两个**平铺**字段，
 * 那个口径有个洞：`test-search-oracle` 用同一套限制去验证同一段实现，
 * 于是「投票的问题 / 看板的条目 / 日历的日期压根搜不到」这件事
 * **它永远发现不了**。实测过一份文档里七类内容，四类搜不到。
 * 现在改成深走，三道边界（跳过 blob/id 键、单串 ≤200、单块 ≤1500）
 * 在这里也照抄一份 —— 边界不同就会变成「实现和预期对不上」，
 * 那时你会去查实现，而真正错的是这里。
 */
const ORACLE_SKIP_KEYS = new Set(['dataUrl', 'html', 'svg', 'css', 'src', 'key', 'votes'])
const ORACLE_MAX_STR = 200
const ORACLE_MAX_TOTAL = 1500

function searchableText(d) {
  const parts = [String(d.title || ''), String(d.body || '')]
  for (const b of (d.blocks || [])) {
    if (!b || typeof b !== 'object') continue
    // 分割线的 text 是空壳；图片的 text 现在是**图片右边那段话**（真实正文）→ 要进索引
    if (b.type === 'divider') continue
    if (b.type === 'image') {
      if (typeof b.text === 'string' && b.text) parts.push(b.text)
      continue
    }
    if (typeof b.text === 'string' && b.text) parts.push(b.text)
    const data = b.data
    if (data && typeof data === 'object') {
      let budget = ORACLE_MAX_TOTAL
      const walk = (v, depth) => {
        if (budget <= 0 || depth > 6) return
        if (typeof v === 'string') {
          const s = v.trim()
          if (!s || s.length > ORACLE_MAX_STR) return
          parts.push(s)
          budget -= s.length
          return
        }
        if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return }
        if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (ORACLE_SKIP_KEYS.has(k)) continue
            walk(x, depth + 1)
          }
        }
      }
      walk(data, 0)
    }
  }
  return parts.join('\n')
}

const loadDocs = async () => {
  const rows = (await api('/api/entity/docs')).json.rows || []
  return rows.filter((d) => !d.trashed)
}

/**
 * 用朴素子串扫描算出「应该搜到谁」。
 *
 * LIKE 的转义也一起模拟：查询词里的 % _ \ 必须当字面量，
 * 否则它们会变成通配符，把一堆无关文档带出来 —— 那正是
 * `LIKE ? ESCAPE '\'` + 转义要防的事。
 */
function bruteForce(docs, q) {
  const needle = String(q).toLowerCase()
  const set = new Set()
  for (const d of docs) {
    const hay = searchableText(d).toLowerCase()
    // LIKE 默认对 ASCII 大小写不敏感，对 CJK 本来就没有大小写
    if (hay.includes(needle)) set.add(d.id)
  }
  return set
}

const searchIds = async (q) => {
  const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=200`)
  return new Set((r.json.results || []).filter((x) => x.kind === 'doc').map((x) => x.id))
}

/** 全部三种索引条目：「种类:id」 */
const searchAll = async (q) => {
  const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=200`)
  return new Set((r.json.results || []).map((x) => `${x.kind}:${x.id}`))
}

/**
 * 独立算「整个索引里应该有什么」。
 *
 * 三种条目的可搜内容各不相同（照抄 reindex 里的三段，代码路径独立）：
 *   doc  → 标题 + body + 块 text + 卡片 data.name/text
 *   book → 库名 + 库描述 + **它下面所有未删文稿的标题**
 *   note → 小记正文
 * 回收站里的文稿一律不算。
 */
async function bruteForceAll(q) {
  const needle = String(q).toLowerCase()
  const hit = (s) => String(s || '').toLowerCase().includes(needle)
  const out = new Set()

  const docs = (await api('/api/entity/docs')).json.rows || []
  for (const d of docs) {
    if (d.trashed) continue
    if (hit(d.title) || hit(searchableText(d))) out.add(`doc:${d.id}`)
  }
  const books = (await api('/api/entity/books')).json.rows || []
  for (const b of books) {
    const titles = docs.filter((d) => d.bookId === b.id && !d.trashed).map((d) => d.title).join('\n')
    if (hit(b.name) || hit(b.desc) || hit(titles)) out.add(`book:${b.id}`)
  }
  const notes = (await api('/api/entity/notes')).json.rows || []
  for (const n of notes) {
    if (hit(n.text)) out.add(`note:${n.id}`)
  }
  return out
}

const compare = async (q, docs) => {
  const got = await searchIds(q)
  const want = bruteForce(docs, q)
  const missing = [...want].filter((x) => !got.has(x))
  const extra = [...got].filter((x) => !want.has(x))
  return { got, want, missing, extra }
}

const docs = await loadDocs()
ok(docs.length > 0, `拿到 ${docs.length} 篇文档做基准`)

console.log('\n== 索引和「现在真实的正文」一致 ==')
{
  // 拿一篇文档里的真实词去搜。词从数据里取，不是我拍脑袋写的 ——
  // 拍脑袋的词可能压根不在数据里，那样「搜不到」也说明不了什么。
  const candidates = []
  for (const d of docs) {
    for (const w of String(d.title || '').split(/[\s，。、：；（）()\[\]"'`/]+/)) {
      const t = w.trim()
      if (t.length >= 2 && t.length <= 8) { candidates.push(t); if (candidates.length >= 40) break }
    }
    if (candidates.length >= 40) break
  }
  let checked = 0, bad = []
  for (const q of candidates) {
    const r = await compare(q, docs)
    checked++
    if (r.missing.length || r.extra.length) {
      bad.push(`「${q}」缺 ${r.missing.length} 条 / 多 ${r.extra.length} 条`
        + (r.missing.length ? ` 缺: ${r.missing.slice(0, 2).join(',')}` : '')
        + (r.extra.length ? ` 多: ${r.extra.slice(0, 2).join(',')}` : ''))
    }
  }
  ok(checked >= 20, `测了 ${checked} 个词`)
  ok(bad.length === 0, `${checked} 个词的搜索结果与独立扫描逐条一致（索引没陈旧）`, bad.slice(0, 3).join(' | '))
}

console.log('\n== 三种索引条目都要对：文稿 / 知识库 / 小记 ==')
{
  /**
   * 第一节只对了 `kind === 'doc'` —— book 和 note 两种**完全没验**。
   * 而它们的可搜内容口径各不相同（库的索引是它下面所有文稿的标题，
   * 小记的索引是正文），正是最容易陈旧的地方。
   */
  const docs = await loadDocs()
  const books = (await api('/api/entity/books')).json.rows || []
  const notes = (await api('/api/entity/notes')).json.rows || []

  // 词从**三种来源**里取：文稿标题、知识库名、小记正文
  const terms = []
  for (const d of docs.slice(0, 6)) for (const w of String(d.title || '').split(/[\s，。、：（）()\[\]"'`/]+/)) {
    const t = w.trim(); if (t.length >= 2 && t.length <= 8) terms.push(t)
  }
  for (const b of books) {
    const t = String(b.name || '').trim()
    if (t.length >= 2) terms.push(t)
  }
  for (const n of notes) {
    for (const w of String(n.text || '').split(/[\s，。、：（）()\[\]"'`/]+/)) {
      const t = w.trim(); if (t.length >= 2 && t.length <= 10) terms.push(t)
    }
  }

  const uniq = [...new Set(terms)].slice(0, 60)
  const bad = []
  let kindsSeen = new Set()
  for (const q of uniq) {
    const got = await searchAll(q)
    const want = await bruteForceAll(q)
    for (const k of got) kindsSeen.add(k.split(':')[0])
    const missing = [...want].filter((x) => !got.has(x))
    const extra = [...got].filter((x) => !want.has(x))
    if (missing.length || extra.length) {
      bad.push(`「${q}」缺[${missing.slice(0, 2)}] 多[${extra.slice(0, 2)}]`)
    }
  }
  ok(uniq.length >= 20, `测了 ${uniq.length} 个词（取自文稿标题 / 知识库名 / 小记正文）`)
  ok(bad.length === 0, `${uniq.length} 个词下三种索引都与独立扫描一致`, bad.slice(0, 3).join(' | '))
  ok(kindsSeen.has('doc'), `实际覆盖到的索引种类：${[...kindsSeen].join(', ')}`,
    kindsSeen.size < 2 ? '只覆盖到一种 —— 词取得太少，另外两种根本没被测到' : '')
  ok(kindsSeen.has('book'), '知识库级索引确实被测到了（不是只在跑一个从没被改的库）')
}

console.log('\n== 改了正文，搜索结果要立刻跟着变（索引不能陈旧）==')
{
  const now = Date.now()
  const id = 'oracle_' + Math.random().toString(36).slice(2, 8)
  const word = 'zz' + Math.random().toString(36).slice(2, 8)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id, bookId: docs[0].bookId, title: '临时 ' + word, body: word, createdAt: now, updatedAt: now, wordCount: 1 }] } }),
  })
  let got = await searchIds(word)
  ok(got.has(id), '新写的词立刻能搜到（写入后索引已重建）')

  // 改掉它 —— 旧词不该再搜到，新词要能搜到
  const word2 = 'yy' + Math.random().toString(36).slice(2, 8)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id, bookId: docs[0].bookId, title: '临时 ' + word2, body: word2, createdAt: now, updatedAt: now + 1, wordCount: 1 }] } }),
  })
  got = await searchIds(word)
  ok(!got.has(id), '改掉之后旧词搜不到这篇（索引没留着一份旧的）')
  got = await searchIds(word2)
  ok(got.has(id), '新词能搜到')
  const docs2 = await loadDocs()
  const r1 = await compare(word2, docs2)
  ok(r1.missing.length === 0 && r1.extra.length === 0, '改完之后整体结果仍与独立扫描一致',
    `缺 ${r1.missing.length} / 多 ${r1.extra.length}`)
}

console.log('\n== 索引抽的字段，一个都不能少 ==')
{
  /**
   * 上面那一节取的词全来自 **title**，所以「索引漏抽了卡片名」它根本发现不了 ——
   * 破坏对照里断掉 `d.name` 那一行，测试依然全绿。
   * 这里补一条：往块里塞一张带独特名字的卡片，搜那个名字。
   */
  const name = '附件：' + Math.random().toString(36).slice(2, 8) + '.pdf'
  const now = Date.now()
  const id = 'oracle_card_' + Math.random().toString(36).slice(2, 8)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id, bookId: docs[0].bookId, title: '带卡片的文档', body: '', createdAt: now, updatedAt: now, wordCount: 0,
          blocks: [{ id: 'b1', type: 'file', text: '', data: { name, type: 'application/pdf' } }],
        }],
      },
    }),
  })
  const got = await searchIds(name)
  ok(got.has(id), '卡片的文件名能被搜到（索引抽了 data.name —— 少了它就搜不到）', `实际 ${got.size} 条`)

  // 块里的纯文字也该进
  const bt = '正文块里的' + Math.random().toString(36).slice(2, 8) + '字样'
  const id2 = 'oracle_blocktext_' + Math.random().toString(36).slice(2, 8)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id: id2, bookId: docs[0].bookId, title: '只有块正文', body: '', createdAt: now, updatedAt: now, wordCount: 0,
          blocks: [{ id: 'b1', type: 'text', text: bt }],
        }],
      },
    }),
  })
  ok((await searchIds(bt)).has(id2), '块里的文字能被搜到（body 为空时也要靠 blocks）')
}

console.log('\n== 卡片里**嵌套**的内容也要能搜到 ==')
{
  /**
   * 2026-10-06 实测的洞。上一节只验了 `data.name` 这个**平铺**字段，
   * 而同一份文档里七类内容有四类当时搜不到：
   *   搜不到  投票的问题 data.q、选项 options[].label、
   *          看板条目 lists[].cards[].text（三层）、日历 picked[]
   * 为什么一直没被发现：本套件的口径**照抄 reindex**，
   * 用同一套限制去验证同一段实现 —— 两边一起漏，谁也不报警。
   * 这一节把嵌套的四种单独钉住。
   */
  const SFX = Math.random().toString(36).slice(2, 8)
  const now = Date.now()
  const id = 'oracle_nest_' + SFX
  const deep = (n, leaf) => (n === 0 ? leaf : { child: deep(n - 1, leaf) })
  const Q = '投票问题' + SFX
  const OPT = '投票选项' + SFX
  const KAN = '看板条目' + SFX
  const CAL = '2026-11-05' + SFX
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id, bookId: docs[0].bookId, title: '嵌套卡片 ' + SFX, body: '', createdAt: now, updatedAt: now, wordCount: 0,
          blocks: [
            { id: 'n1', type: 'card', text: '', data: { cardId: 'vote', q: Q, options: [{ id: 'o1', label: OPT, votes: ['u1'] }] } },
            { id: 'n2', type: 'card', text: '', data: { cardId: 'kanban', lists: [{ id: 'l1', name: '进行中', cards: [{ id: 'c1', text: KAN }] }] } },
            { id: 'n3', type: 'card', text: '', data: { cardId: 'calendar', picked: [CAL], view: 'month' } },
          ],
        }],
      },
    }),
  })
  ok((await searchIds(Q)).has(id), '投票的问题（data.q）能被搜到', `实际 ${(await searchIds(Q)).size} 条`)
  ok((await searchIds(OPT)).has(id), '投票的选项（options[].label）能被搜到')
  ok((await searchIds(KAN)).has(id), '看板的条目（三层嵌套 lists[].cards[].text）能被搜到')
  ok((await searchIds(CAL)).has(id), '日历的日期（picked[]）能被搜到')
  ok(deep(0, 'x'), '（构造深结构的辅助函数本身可用）')
}

console.log('\n== 深走的三道边界：该不进的一个都不能进 ==')
{
  /**
   * 深走是「一视同仁」，但一视同仁地把 base64 和几千行文本也收进去，
   * 就是把索引写成几 MB、而且用户搜 base64 片段毫无意义。
   * 这三条是深走的刹车，不是「额外功能」。
   */
  const SFX = Math.random().toString(36).slice(2, 8)
  const now = Date.now()
  const id = 'oracle_bounds_' + SFX
  const deep = (n, leaf) => (n === 0 ? leaf : { child: deep(n - 1, leaf) })
  const BLOB = 'blobmark' + SFX
  const LONG = 'longmark' + SFX
  const DEEP = 'deepmark' + SFX
  const VOTEID = 'votemark' + SFX
  const KEEP = 'keepmark' + SFX
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id, bookId: docs[0].bookId, title: '边界 ' + SFX, body: '正文 ' + KEEP, createdAt: now, updatedAt: now, wordCount: 0,
          blocks: [
            { id: 'x1', type: 'card', text: '', data: { cardId: 'album', name: KEEP, dataUrl: 'data:image/png;base64,' + BLOB + 'AAAA' } },
            { id: 'x2', type: 'card', text: '', data: { cardId: 'file', longText: LONG + 'x'.repeat(260) } },
            { id: 'x3', type: 'card', text: '', data: { cardId: 'mindmap', tree: deep(9, DEEP) } },
            { id: 'x4', type: 'card', text: '', data: { cardId: 'vote', q: '问题' + SFX, options: [{ id: 'o', label: '选项', votes: [VOTEID] }] } },
          ],
        }],
      },
    }),
  })
  ok((await searchIds(KEEP)).has(id), '正常内容照常进索引（边界不是「跳过过头」）')
  ok(!(await searchIds(BLOB)).has(id), 'dataUrl 里的 base64 不进索引')
  ok(!(await searchIds(LONG)).has(id), '超过 200 字符的长串不进索引')
  ok(!(await searchIds(DEEP)).has(id), '埋得太深（第 9 层）不进索引')
  ok(!(await searchIds(VOTEID)).has(id), 'votes 里的用户 id 列表不进索引')
}

console.log('\n== LIKE 的 % 和 _ 必须当字面量 ==')
{
  /**
   * 不转义的话，`%` 会变成通配符：`%%%` 匹配**任何**长度 ≥2 的字符串 → 一搜全库。
   *
   * 这里不写「≤ 某个数」这种阈值 —— 第一版写的是「≤ 另一个词的结果数 + 5」，
   * 而全库恰好比那个词多几条，于是**没转义的实现也蒙混过关**。
   * 正确做法是跟独立扫描逐条比：语料里字面 `%` / `_` 出现几次，
   * 搜出来就该是那几篇，多一条都是被当通配符了。
   */
  const cur = await loadDocs()
  for (const ch of ['%', '_', '%%', 'a_b']) {
    const r = await compare(ch, cur)
    ok(r.missing.length === 0 && r.extra.length === 0,
      `搜「${ch}」与独立扫描一致（${r.got.size} 条，多出来 ${r.extra.length} 条就是被当通配符了）`,
      `多: ${r.extra.slice(0, 3).join(',')}`)
  }
  // 正常词不能被这些查询误伤
  ok((await searchIds('产品')).size > 0, '查过特殊字符之后，正常词的搜索照常')
}

console.log('\n== 回收站里的文稿不进搜索 ==')
{
  const now = Date.now()
  const id = 'oracle_trash_' + Math.random().toString(36).slice(2, 8)
  const word = 'tr' + Math.random().toString(36).slice(2, 8)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id, bookId: docs[0].bookId, title: '待删 ' + word, body: word, createdAt: now, updatedAt: now, wordCount: 1 }] } }),
  })
  ok((await searchIds(word)).has(id), '没删之前搜得到')
  await api(`/api/doc/${id}/purge`, { method: 'POST' })
  ok(!(await searchIds(word)).has(id), '彻底删除之后搜不到了（用户删掉了就不该再被搜出来）')
}

console.log('\n== 搜索不绕开屏蔽词 ==')
{
  // 上一轮加的关键词屏蔽必须**同时**管住 /api/search
  // —— 只在前端藏的话，绕开界面就拿到了
  const books = (await api('/api/entity/books')).json.rows || []
  const bk = books[0]
  // 造一篇标题里带独特词的文档，用那个词当屏蔽词
  const word = 'bk' + Math.random().toString(36).slice(2, 8)
  const now = Date.now()
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id: 'oracle_bk_' + word, bookId: bk.id, title: '屏蔽验证 ' + word, body: word, createdAt: now, updatedAt: now, wordCount: 1 }] } }),
  })
  ok((await searchIds(word)).size === 1, '先确认这个词本来搜得到（前提不成立的话后面都白测）')

  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bk.id, blockSearch: 1, blockTerms: [word] }] } }),
  })
  const blocked = await searchIds(word)
  ok(blocked.size === 0, '开了屏蔽之后同一个接口也搜不到（不是只有前端界面藏了）', `实际 ${blocked.size} 条`)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bk.id, blockSearch: 0, blockTerms: [] }] } }),
  })
  ok((await searchIds(word)).size === 1, '关掉之后恢复')
}

console.log('\n== 知识库级索引：文稿改了，它也得跟着改 ==')
{
  /**
   * 知识库的索引正文 = 它下面**所有文稿的标题**（reindex 的 'book' 分支）。
   * 所以文稿一改，书级索引就陈旧 —— 而原来只在**书自己**被写的时候才重建它。
   *
   * 实测两头都错：
   *   改标题后搜**新**标题 → 只命中文档，命不中知识库（书级还是旧标题）
   *   改标题后搜**旧**标题 → 只剩知识库命中，**库里留着改名之前的内容**
   * 删文档更糟：标题会永远留在书级索引里，删了还能搜到。
   */
  const books = (await api('/api/entity/books')).json.rows || []
  const bk = books[0]
  const now = Date.now()
  const OLD = '旧标题' + Math.random().toString(36).slice(2, 6)
  const NEW = '新标题' + Math.random().toString(36).slice(2, 6)
  const id = 'oracle_book_' + Math.random().toString(36).slice(2, 6)

  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id, bookId: bk.id, title: OLD, body: '', createdAt: now, updatedAt: now, wordCount: 0 }] } }),
  })
  // **必须**先让书重建一次：否则书级索引里压根没有这篇的标题，
  // 也就谈不上「陈旧」—— 第一版探针就栽在这儿（两边都搜不到，看着还挺干净）
  const bkFresh = (await api('/api/entity/books')).json.rows.find((b) => b.id === bk.id)
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { books: [{ ...bkFresh, updatedAt: now }] } }),
  })
  const kindsOf = async (q) => (await api(`/api/search?q=${encodeURIComponent(q)}&limit=200`)).json.results
    .filter((x) => x.id === id || x.kind === 'book')
    .map((x) => x.kind)
  ok((await kindsOf(OLD)).includes('book'), '先确认旧标题能搜到知识库（前提不成立的话后面都白测）',
    JSON.stringify(await kindsOf(OLD)))

  // 改标题
  await api('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { docs: [{ id, bookId: bk.id, title: NEW, body: '', createdAt: now, updatedAt: now + 1, wordCount: 0 }] } }),
  })
  ok((await kindsOf(NEW)).includes('book'),
    '改名后搜新标题，知识库也命中（书级索引跟着更新了）', JSON.stringify(await kindsOf(NEW)))
  const stale = await kindsOf(OLD)
  ok(!stale.includes('book'),
    '改名后搜旧标题，知识库不再命中（库级索引不留着改名前的内容）', JSON.stringify(stale))

  // 软删 → 恢复 → 彻底删。
  // 删除走的是 sync/push 的 remove —— 服务端**没有** DELETE /api/doc/:id 这条路由，
  // 第一版我写成 fetch(..., {method:'DELETE'})，拿到 404 却没检查，
  // 结果「删不掉」被当成了「索引没更新」，白查一轮。
  const del = await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { docs: [id] } }) })
  ok(del.status === 200 && !(del.json.rejected || []).length, '软删真的执行了（走 sync/push 的 remove，不是 DELETE 路由）',
    `${del.status} ${JSON.stringify(del.json)}`)
  const gone = (await api(`/api/doc/${id}`)).status
  ok(gone === 410, '软删之后 GET 文档返回 410（软删已生效，不是我请求写错了）', String(gone))
  ok(!(await kindsOf(NEW)).includes('book'), '删掉之后知识库不再命中', JSON.stringify(await kindsOf(NEW)))
  await api(`/api/doc/${id}/restore`, { method: 'POST' })
  ok((await kindsOf(NEW)).includes('book'), '从回收站恢复之后知识库重新命中', JSON.stringify(await kindsOf(NEW)))
  await api(`/api/doc/${id}/purge`, { method: 'POST' })
  ok(!(await kindsOf(NEW)).includes('book'), '彻底删除之后知识库也不再命中（标题不会永远留着）',
    JSON.stringify(await kindsOf(NEW)))
}

/* ===================================================================
   知识库超过 300 篇之后，书级索引留哪 300 条
   -------------------------------------------------------------------
   书级索引的正文 = 该库下所有文稿的标题（不建它的话，搜某篇的标题
   只命中文档、搜不到库本身）。而这个上限原来是
   `... trashed = 0 LIMIT 300` —— **不带 ORDER BY**。

   不带 ORDER BY 意味着「留哪 300 条」由 SQLite 的扫描顺序决定，
   实测就是行 id 顺序，也就是**最老的 300 篇**。
   于是在一个 320+ 篇的库里：搜「最老的一篇」能命中知识库，
   搜「最新的一篇」只命中文档 —— 而公司知识库里真正会被搜的
   恰恰是最近更新的那些（新人手册、新政策、刚改完的文档）。

   修：按更新时间倒序取。上限还在，但取的是**最该被搜的那批**，而且可预期。
   =================================================================== */
console.log('\n== 超过 300 篇时，书级索引留的是最近更新的那些 ==')
{
  const SFX = Math.random().toString(36).slice(2, 7)
  const books = (await api('/api/entity/books')).json.rows || []
  const BK = books[0]
  const N = 320
  const base = Date.now() - 1000 * 60 * 60 * 24 * 30 // 30 天前
  const OLD = `最老的一篇${SFX}`
  const NEW = `最新的一篇${SFX}`
  const rows = []
  for (let i = 0; i < N; i++) {
    rows.push({
      id: `or_${i}_${SFX}`, bookId: BK.id,
      title: i === 0 ? OLD : i === N - 1 ? NEW : `批量篇${i}${SFX}`,
      body: 'x', createdAt: base + i * 1000, updatedAt: base + i * 1000, wordCount: 1,
    })
  }
  let pushed = 0
  for (let i = 0; i < rows.length; i += 80) {
    const r = await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: rows.slice(i, i + 80) }, remove: {} }) })
    if (r.status === 200) pushed += Math.min(80, rows.length - i)
  }
  ok(pushed === N, `往《${BK.name}》里写了 ${pushed}/${N} 篇 —— 不成立后面就是空断言`)

  const hits = async (q) => (await api('/api/search?q=' + encodeURIComponent(q))).json.results || []
  const oldHits = await hits(OLD)
  const newHits = await hits(NEW)
  ok(newHits.some((h) => h.kind === 'book' && h.id === BK.id),
    '搜「最近更新的那篇」→ **知识库也命中**',
    JSON.stringify(newHits.map((h) => h.kind + ':' + h.id)).slice(0, 120))
  ok(newHits.some((h) => h.kind === 'doc'), '而且文档本身也命中')
  ok(oldHits.some((h) => h.kind === 'doc'),
    '搜「最老的那篇」→ 文档仍然命中（doc 索引逐篇建，不受这个上限影响）')
  ok(!oldHits.some((h) => h.kind === 'book'),
    '但它**不再**命中知识库 —— 上限取的是最近更新的 300 条，这是取舍不是遗漏',
    JSON.stringify(oldHits.map((h) => h.kind + ':' + h.id)).slice(0, 120))

  // 源码层：上限必须带 ORDER BY，否则「留哪 300 条」又变回碰运气
  const srvSrc = readFileSync('server/sync.ts', 'utf8')
  const at = srvSrc.indexOf('FROM docs WHERE bookId = ? AND COALESCE(trashed,0) = 0')
  const seg = at < 0 ? '' : srvSrc.slice(at, at + 220)
  ok(/ORDER BY COALESCE\(updatedAt,0\) DESC/.test(seg), '**上限是「按更新时间倒序的 300 条」**，不是碰运气')
  ok(!/= 0 LIMIT 300'\)/.test(seg), '不再是裸的 `LIMIT 300`')
}

cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
