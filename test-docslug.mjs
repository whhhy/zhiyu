/**
 * 文档的「路径」与「摘录」
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 文档设置弹窗里有两个输入框 —— 「路径」和「摘录」——
 * 写它们的时候**两列在库里压根不存在**，writable 清单里也没有。
 * 后果是：用户改路径、改摘录，点保存，弹「文档已保存」，
 * 而服务端把这两个字段**静默丢掉**。不报错、不提示，就是改了等于没改。
 *
 * 「路径」那一栏还带着一个写死的 `yuque.com/yuque-clone/` 前缀，
 * 看起来像个能用的地址，实际上：
 *   · 填什么都不生效（服务端没这列）
 *   · 它指向**别家公司**的官网
 *
 * 这个套件钉的是：字段真的落库、真的被解析、地址真的是本机的。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.DOCSLUG_PORT || await freePort()
const DB = 'data/_docslug-test.db'
const BASE = `http://localhost:${PORT}`

async function call(path, opts = {}, token = '') {
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
const ses = (p, o = {}, t = '') => call(p, o, t)

/* ---------------- 先删旧库，再起服务 ---------------- */
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

const token = (await ses('/api/auth/login', {
  method: 'POST', body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
})).json.token || ''
ok(!!token, '管理员登录成功')

const books = (await ses('/api/entity/books', {}, token)).json.rows || []
const B = books[0]
ok(!!B, `拿一个知识库做素材：${B?.name}`)

const SFX = Math.random().toString(36).slice(2, 7)
const mk = (n) => `slugp_${n}_${SFX}`

async function pushDoc(id, extra = {}) {
  return ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id, bookId: B.id, title: `路径探针 ${id}`,
          body: '# 标题\n\n正文。', createdAt: Date.now(), updatedAt: Date.now(), wordCount: 6,
          ...extra,
        }],
      },
    }),
  }, token)
}

console.log('\n== 这两列真的存在 ==')
{
  /*
   * 破坏对照查出来的一个结论，写在这儿免得下次有人猜错方向：
   *
   *   · **slug 落库有两条路**：`docs` 实体 writable 清单里有它，
   *     所以 `toRow` 会写；`upsertRow` 里还有一次显式赋值。任一条都够。
   *     → 拆「落库」这条断言，得**两道一起拆**才拆得掉。
   *   · **归一化只有一条路**：就在 `upsertRow` 那个显式块里。
   *     → 拆「大小写折成同一个地址」，拆一处就红。
   *
   * 第一版破坏对照只拆了 writable，套件照样全绿 ——
   * 当时看起来像「这条断言没在测东西」，其实是拆错了地方。
   */
  const r = mk('a')
  await pushDoc(r, { slug: 'deploy-guide', summary: '发版流程与回滚步骤。' })
  const got = (await ses(`/api/doc/${r}`, {}, token)).json.doc
  ok(got.slug === 'deploy-guide', '**slug 真的落库了**（以前是被静默丢掉的）', String(got.slug))
  ok(got.summary === '发版流程与回滚步骤。', '**summary 真的落库了**', String(got.summary))
}

console.log('\n== slug 归一化：两边必须是同一个地址 ==')
{
  /*
   * 这里特意用**另一个**词：上一节已经占了 deploy-guide，
   * 而这一节归一化之后正好也是 deploy-guide ——
   * 于是这一篇会被「路径已被占用」拒掉，然后 `/api/doc/<id>` 返回 404，
   * 断言拿不到 doc 就炸了。
   *
   * 那是**正确行为**（同一个库里路径要唯一），是这里的测试数据撞了。
   * 一开始我把这一节也写成 deploy-guide，症状是
   * 「TypeError: Cannot read properties of undefined」——
   * 一个完全指错方向的报错：真正的原因是重名。
   */
  const r = mk('b')
  await pushDoc(r, { slug: '  Release   Notes  ' })
  const got = (await ses(`/api/doc/${r}`, {}, token)).json.doc
  ok(got.slug === 'release-notes', '空格、大小写、多余空白都折成同一个地址', String(got.slug))

  const r2 = mk('c')
  await pushDoc(r2, { slug: 'a.b/c' })
  ok((await ses(`/api/doc/${r2}`, {}, token)).json.doc.slug === 'a-b-c', '非字母数字折成连字符')

  const r3 = mk('d')
  await pushDoc(r3, { slug: '中文标题' })
  ok((await ses(`/api/doc/${r3}`, {}, token)).json.doc.slug === '', '中文归一化成空（**如实**，而不是编一个拼音出来）')
}

console.log('\n== slug 能当地址真的解析 ==')
{
  /*
   * slug 用一个**还没被占用**的：上一节刚占了 release-notes。
   * 这里要是再写同一个，第二篇会被「路径已被占用」拒掉，
   * 然后按 slug 解析到的是**上一节那一篇** ——
   * 症状是「解析到错误的文档」，而真正的原因是两节数据撞了。
   */
  const r = mk('e')
  await pushDoc(r, { slug: 'api-handbook', title: '发版记录' })
  const bySlug = await ses('/api/doc/api-handbook', {}, token)
  ok(bySlug.status === 200, '用 slug 能打开文档', String(bySlug.status))
  ok(bySlug.json.doc?.id === r, '解析到的是正确的那一篇', String(bySlug.json.doc?.id))
  ok(bySlug.json.resolvedId === r, '响应里回了 resolvedId（客户端可以据此修正地址栏）')

  const byId = await ses(`/api/doc/${r}`, {}, token)
  ok(byId.json.doc?.id === r, '用 docId 当然也能打开（内部链接不受影响）')

  const missing = await ses('/api/doc/压根没有这个路径', {}, token)
  ok(missing.status === 404, '查不到的路径是 404', String(missing.status))
  ok(!/相似|大概|你是不是想/.test(String(missing.json.error || '')), '**不猜**相近的文档 —— 猜错等于把另一篇发给以为在读这一篇的人')
}

console.log('\n== 同一个知识库里 slug 不能重 ==')
{
  const a = mk('f'), b = await mk('g')
  await pushDoc(a, { slug: 'same-path' })
  const dup = await pushDoc(b, { slug: 'same-path' })
  const rejected = dup.json.rejected || []
  ok(rejected.length === 1, '第二篇用同一个路径被拒', JSON.stringify(dup.json).slice(0, 120))
  ok(/占用|唯一/.test(String(rejected[0]?.reason || '')), '拒绝的话说得清是「这个路径被占了」', String(rejected[0]?.reason))
  ok(/《/.test(String(rejected[0]?.reason || '')), '还点名了是哪一篇占的', String(rejected[0]?.reason))

  // 自己改成自己原来的路径，不算冲突（否则每次保存都在报错）
  const same = await pushDoc(a, { slug: 'same-path', title: '改了标题' })
  ok(!(same.json.rejected || []).length, '保存时路径没变 → 不算冲突', JSON.stringify(same.json.rejected || []))
  ok((await ses(`/api/doc/${a}`, {}, token)).json.doc.title === '改了标题', '同一篇的标题确实改了')

  /*
   * 重名有**两道**拦截，两道都要在：
   *   ① 写入前自己查一遍 —— 为了说清「是哪一篇占了、你要改成什么」
   *   ② 库上一个 partial unique index —— 兜底，也是并发时的真正保证
   *
   * 只测 ① 会漏掉 ②：拆掉 ① 之后重名**照样被拒**（被 ② 拦的），
   * 只看「有没有被拒」的话会以为 ① 没用。
   * 破坏对照里拆掉 ① 之后套件仍然全绿，就是这么来的。
   */
  const idx = '这个路径已被《'
  ok(String(rejected[0]?.reason || '').includes(idx), '拦下来的是「友好提示」而不是一句 SQL 报错（提示在，索引也在）')

  // 没设路径的文档之间可以重名（它们都是空串）
  const c1 = mk('h'), c2 = await mk('i')
  const r1 = await pushDoc(c1)
  const r2 = await pushDoc(c2)
  ok(!(r1.json.rejected || []).length && !(r2.json.rejected || []).length,
    '两篇都没设路径的文档可以共存（唯一索引不会误伤）',
    JSON.stringify([...(r1.json.rejected || []), ...(r2.json.rejected || [])]))
}

console.log('\n== 摘录真的会被显示 ==')
{
  const r = mk('j')
  await pushDoc(r, { slug: 'summary-demo', title: '发布检查单', summary: '发版前逐条对照，含回滚。' })
  const hits = (await ses('/api/search?q=' + encodeURIComponent('发布检查单'), {}, token)).json.results || []
  const hit = hits.find((h) => h.id === r)
  ok(!!hit, '搜得到这篇')
  ok(hit?.summary === '发版前逐条对照，含回滚。', '搜索结果里带回了作者写的摘录', String(hit?.summary))

  const bySlug = await ses('/api/doc/summary-demo', {}, token)
  ok(bySlug.json.doc?.summary === '发版前逐条对照，含回滚。', '文档详情里也有摘录')
}

console.log('\n== 对外分享链接用 slug，且 slug 也能匿名打开 ==')
{
  const r = mk('k')
  await pushDoc(r, { slug: 'external-spec-v2', summary: '对外的接口说明。' })
  // 开两个开关
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { bookSettings: [{ bookId: B.id, publicAccess: 1 }] } }) }, token)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { docs: [{ id: r, visibility: 'public' }] } }) }, token)

  const bySlugPub = await fetch(`${BASE}/api/public/doc/external-spec-v2`)
  const j1 = await bySlugPub.json().catch(() => ({}))
  ok(bySlugPub.status === 200, '**对外链接用 slug 也能打开**（访客拿到的地址是短路径）', String(bySlugPub.status))
  ok(j1.title === `路径探针 ${r}`, '打开的是正确的那一篇', j1.title)
  ok(j1.summary === '对外的接口说明。', '分享页能拿到摘录')

  const byIdPub = await fetch(`${BASE}/api/public/doc/${r}`)
  ok(byIdPub.status === 200, '用 docId 也照样能打开（内部习惯不用改）')

  const missPub = await fetch(`${BASE}/api/public/doc/没有这个路径`)
  ok(missPub.status === 404, '查不到的路径匿名访问也是 404', String(missPub.status))
}

console.log('\n== 前端：假地址已经没有了 ==')
{
  const doc = readFileSync('src/pages/DocPage.tsx', 'utf8')
  /*
   * 只查**代码里的** yuque.com，不查注释 ——
   * 修这个 bug 的那段说明里就写着那个假地址，它是文档，要留着。
   * 判据要落到具体的写法上：`setLink(\`https://www.yuque.com` 和 `<span>...yuque.com`。
   */
  ok(!/setLink\(`https:\/\/www\.yuque\.com/.test(doc), '分享弹窗里没有写死的 yuque.com 地址')
  // 文档设置弹窗那一段
  const settingsAt = doc.indexOf('yq-docset-slug')
  const seg = doc.slice(settingsAt - 400, settingsAt + 900)
  ok(!/<span>[^<]*yuque\.com/.test(seg), '**文档设置的路径前缀也不是 yuque.com 了**（只查 span 里的字面量，注释不算）')
  ok(/location\.host/.test(seg), '前缀用本机真实 host')
  ok(seg.includes('docShareUrl'), '界面上直接把解析后的完整地址显示出来')

  // 初值不再编造
  ok(/useState\(doc\.slug \|\| ''\)/.test(doc), '路径初值取真实值（以前默认填 doc.id，看着像已经设好了）')
  ok(/useState\(doc\.summary \|\| ''\)/.test(doc), '摘录初值取真实值（以前默认截正文前 60 字，像用户自己写的）')

  // 归一化只有一份
  const slugMod = readFileSync('src/lib/slug.ts', 'utf8')
  const srv = readFileSync('server/sync.ts', 'utf8')
  ok(slugMod.includes('export const normalizeSlug'), '归一化住在 src/lib/slug.ts')
  ok(srv.includes("import { normalizeSlug } from '@/lib/slug'"), '**服务端引的是同一份** —— 两份实现迟早分叉成「看到的地址 ≠ 存的地址」')
  ok(!/export function normalizeSlug/.test(srv), '服务端没有自己再写一份')
}

/* ===================================================================
   同一个 slug 出现在两个知识库里
   -------------------------------------------------------------------
   slug 的唯一索引是 `ON docs(bookId, slug)` —— **按知识库唯一**，
   所以「A 库和 B 库各有一篇叫 deploy」是完全合法的状态，写入时也拦不住。

   而解析路径原来是 `SELECT id FROM docs WHERE slug = ? ORDER BY id LIMIT 1` ——
   全局只取一篇，挑的是**字典序最小**的那篇，跟「谁在访问」「访问哪个库」毫无关系。

   实测（2026-10-06）：一个只属于 A 库的同事访问 A 库那篇的路径，
   拿到的是 **403「没有阅读该文档的权限」** —— 而那篇就在他能读的库里、
   路径也是他自己的。他会去找管理员要一个自己本来就有的权限。
   admin 那边则是**静默拿到 B 库那篇**，而他以为自己在读 A 库那篇。

   上面那句「查不到就 404，绝不猜」一直写在注释里 —— **规则写对了，实现没做到**。
   =================================================================== */
console.log('\n== 同一个 slug 出现在两个知识库里 ==')
{
  const B2 = books[1]
  if (!B2) {
    ok(false, '需要第二个知识库做素材，本轮跳过')
  } else {
    const DUP = 'dup-' + SFX
    // 故意让 B2 那篇的 id 字典序**更小** —— 修之前 `ORDER BY id` 就会挑中它
    const inA = mk('za_inA')
    const inB = 'ab_inB_' + SFX

    const pushInto = (id, bookId, title) => ses('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        upsert: {
          docs: [{ id, bookId, title, slug: DUP, body: `# ${title}\n\n正文。`, createdAt: Date.now(), updatedAt: Date.now(), wordCount: 6 }],
        },
        remove: {},
      }),
    }, token)

    const rA = await pushInto(inA, B.id, `A 库那篇 ${DUP}`)
    const rB = await pushInto(inB, B2.id, `B 库那篇 ${DUP}`)
    ok(rA.status === 200 && rB.status === 200, `两个库各写了一篇同名路径（${rA.status} / ${rB.status}）`)

    const rows = (await ses('/api/entity/docs', {}, token)).json.rows || []
    const n = rows.filter((d) => d.slug === DUP).length
    ok(n === 2, `库里确实有两篇用这个路径（${n}）—— 不成立后面就是空断言`)

    // 造一个只属于 A 库的普通同事
    const acct = 'dsa' + SFX
    await ses('/api/auth/register', { method: 'POST', body: JSON.stringify({ account: acct, password: 'test1234', name: '只读A库的同事' }) })
    const tk = (await ses('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: acct, password: 'test1234' }) })).json.token || ''
    const uid = (await ses('/api/v2/user', {}, tk)).json.id
    await ses('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ upsert: { bookMembers: [{ userId: uid, bookId: B.id, role: 'editor', perms: '{}', joinedAt: Date.now() }] }, remove: {} }),
    }, token)
    ok(!!uid && !!tk, `造了一个只属于 A 库的同事（${uid}）`)

    // ① 同事：他只看得到 A 库那一篇，路径不该对他有歧义
    const rU = await ses(`/api/doc/${DUP}`, {}, tk)
    ok(rU.status === 200 && rU.json?.doc?.id === inA,
      `只读 A 库的同事访问这个路径 → 拿到 A 库那篇（${rU.status} / ${rU.json?.doc?.id || rU.json?.error}）`,
      rU.status === 403 ? '修之前是 403「没有阅读该文档的权限」，而那篇就在他能读的库里' : '')

    // ② admin：两个都读得到 → 有歧义，**不许挑一篇**，要说清为什么
    const rAd = await ses(`/api/doc/${DUP}`, {}, token)
    ok(rAd.status === 409, `admin 访问同一路径 → 409 明说有歧义（实际 ${rAd.status}）`,
      rAd.status === 200 ? `它静默返回了 ${rAd.json?.doc?.id}，那是**另一篇**` : '')
    ok(/歧义/.test(String(rAd.json?.error || '')), '理由说清是「路径有歧义」', rAd.json?.error)
    ok(/个知识库/.test(String(rAd.json?.error || '')), '并说清有几篇候选')

    // ③ docId 永远不受影响 —— 路径有歧义不该让「用 id 打开」也坏掉
    const rId = await ses(`/api/doc/${inA}`, {}, token)
    ok(rId.status === 200 && rId.json?.doc?.id === inA, '用 docId 打开仍然正常（歧义只影响路径解析）')

    // ④ 源码层：不能再有 ORDER BY id LIMIT 1
    const srvSrc = readFileSync('server/sync.ts', 'utf8')
    ok(!/ORDER BY id LIMIT 1"\)\.get\(idOrSlug\)/.test(srvSrc) && !/slug = \? AND slug <> '' ORDER BY id LIMIT/.test(srvSrc),
      '**解析路径时不再有「挑字典序最小的那篇」**')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
