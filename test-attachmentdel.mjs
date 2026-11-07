/**
 * 附件到底删不删得掉 —— 以及**删一份会不会弄坏另一份**
 *
 * ============================================================
 * 这个套件钉的是两个「看起来删了，其实…」的事故
 * ------------------------------------------------------------
 * ① 服务端**从来就没有过附件删除接口**。只有 POST 上传和 GET 下载，
 *    而客户端卡片上的「删除」走的是：
 *
 *        releaseAttachment(docs, key) → deleteAttachment(key)
 *                                              └── src/lib/idb.ts，只删本机 IndexedDB
 *
 *    存储适配层里本该管这件事的 dropFile 当时两处都错：
 *      1. 服务端模式下第一行就 `if (useServer()) return` —— 什么都不做，
 *         注释还写着「服务端附件随知识库生命周期走」（附件实际随**文档**走）；
 *      2. 它**根本没有调用方**。
 *
 *    内网部署（服务端模式）下的实际后果：点「删除」→ 卡片从正文消失
 *    （用户以为删掉了）→ 二进制继续躺在库里 → 有读权限的人仍能 GET 下来
 *    → 只有**整篇文档被永久删除**时才跟着消失。
 *    误传一份客户名单 / 薪酬表进去，是真的删不掉的。
 *
 * ② 补上删除接口之后，**新放大了另一个事故**：
 *    复制一篇带附件的文档时 `moveDoc` 是**逐字照抄 blocks** 的
 *    （`String(row.blocks || '[]')`），于是副本和原件指向**同一个附件 id**，
 *    而 `attachments.docId` 只能记其中一个。
 *    结果：用户在**副本**里点删除 → 服务端无条件删掉二进制 → **原件的卡片坏了**，
 *    而用户根本没碰原件。实测就是这么走的。
 *
 *    所以「删除」其实是两件事，混在一起就会出事：
 *      ① 撤掉**这一篇**对它的引用（用户点的就是这个）
 *      ② 把**二进制**删掉（只有没有别人引用时才该做）
 *    现在服务端按真实引用数决定：有别人引用就只撤引用并如实说明。
 *
 * 写这个套件时最要紧的一条纪律：**先造基准，再写否定式断言**。
 * 「删了之后原件还能下」这种断言，如果不先把「副本和原件确实共指同一份」
 * 这个基准摆出来，删掉整个引用判定它照样会红 —— 那就证明不了任何东西。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.ATTACHMENTDEL_PORT || await freePort()
const DB = 'data/_attachmentdel-test.db'
const BASE = `http://localhost:${PORT}`

const call = async (p, o = {}, t = '') => {
  const r = await fetch(BASE + p, {
    ...o,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const ses = (p, o = {}, t = '') => call(p, o, t)

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
}

// 端口守卫：残留进程会让这一轮全跑在旧代码上（全绿，但什么都没验）
{
  const busy = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
  if (busy) {
    console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧进程上，结果不可信。`)
    process.exit(1)
  }
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
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

const login = async (account, password = 'yuque@2026') =>
  (await ses('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) })).json.token || ''
const admin = await login('admin')
ok(!!admin, '管理员登录成功')

const B = (await ses('/api/entity/books', {}, admin)).json.rows[0]
const SFX = Math.random().toString(36).slice(2, 7)

/** 直接读库，用来回答「行到底还在不在」——比只看接口返回值可靠 */
const rowExists = (id) => {
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  const n = Number(d.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id = ?').get(id).n)
  d.close()
  return n > 0
}

const newUser = async (tag, name) => {
  const acc = tag + SFX
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name }),
  })
  const token = reg.json.token || await login(acc, 'probe@2026')
  // 没有 GET /api/users/me（那个只有 PATCH），当前用户从 /api/auth/me 拿
  const me = (await ses('/api/auth/me', {}, token)).json.user || {}
  return { token, id: String(me.id || ''), acc }
}

const outsider = await newUser('out', '无权限者')
const reader = await newUser('rdr', '只读成员')
ok(!!outsider.token && !!reader.token && !!reader.id, '注册两个探针账号')

/**
 * 给只读成员补上这本书的**只读**身份。
 *
 * 不做这一步的话，「只读成员删不掉」那条断言是**空的** ——
 * 他压根没权限，403 跟 edit 还是 read 判出来的完全无关，
 * 把 `edit` 放宽成 `read` 它照样绿。破坏对照当场抓到了这一点。
 */
{
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  d.prepare('INSERT OR REPLACE INTO book_members (bookId,userId,role,perms,joinedAt) VALUES (?,?,?,?,?)')
    .run(B.id, reader.id, 'reader', '{}', Date.now())
  d.close()
}

/** 造一个文档，并把 blocks 写回去；写完**从 API 回读确认** */
const putDoc = async (docId, bookId, blocks) => {
  const now = Date.now()
  const r = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id: docId, bookId, title: '删除权限探针', body: 'x',
          createdAt: now, updatedAt: now, wordCount: 1, blocks,
        }],
      },
    }),
  }, admin)
  const back = (await ses('/api/entity/docs', {}, admin)).json.rows.find((x) => x.id === docId)
  const got = Array.isArray(back?.blocks) ? back.blocks : []
  // 写盘不报错 ≠ 写进去了。回读不一致就直接说出来，而不是继续往下跑
  if (JSON.stringify(got) !== JSON.stringify(blocks)) {
    console.log(`  （提示：文档 ${docId} 的 blocks 回读与写入不一致：${JSON.stringify(got).slice(0, 120)}）`)
  }
  return { applied: r.json.applied?.length || 0, got }
}
const readBlocks = async (docId) =>
  ((await ses('/api/entity/docs', {}, admin)).json.rows.find((x) => x.id === docId)?.blocks) || []

const cardFor = (key) => [{
  id: 'bk_' + key.slice(-6), type: 'card', text: '',
  data: { cardId: 'file', name: '机密.txt', key, size: 64 },
}]

const docId = `attdel_doc_${SFX}`
await putDoc(docId, B.id, [])

/** 上传到某篇文档下，返回附件 id */
const upload = async (dId, tok, name = 'secret.txt') => {
  const r = await fetch(`${BASE}/api/attachment?docId=${encodeURIComponent(dId)}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tok,
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
    },
    body: Buffer.from('机密内容-不应被外人拿到', 'utf8'),
  })
  return { status: r.status, id: (await r.json().catch(() => ({}))).id || '' }
}
const del = (id, tok, docIdQ = '') =>
  call(`/api/attachment/${encodeURIComponent(id)}${docIdQ ? `?docId=${encodeURIComponent(docIdQ)}` : ''}`, { method: 'DELETE' }, tok)
const get = (id, tok) => fetch(`${BASE}/api/attachment/${encodeURIComponent(id)}`, {
  headers: tok ? { Authorization: 'Bearer ' + tok } : {},
})

console.log('\n== 没有删除权的人：403，而且文件必须还在 ==')
{
  await putDoc(docId, B.id, [])
  const a = (await upload(docId, admin)).id
  const b2 = (await upload(docId, admin)).id
  ok(!!a && !!b2, '两份附件都上传成功', `${a} / ${b2}`)

  const r1 = await del(a, outsider.token, docId)
  ok(r1.status === 403, '外部人删不掉（对这篇文档毫无权限）', String(r1.status))

  // **先摆基准**：只读成员确实能下到它。没有这一步，
  // 下面那条 403 证明不了「edit 与 read 的区别」——
  // 他可能压根就没权限，那 403 跟用哪个能力判的毫无关系。
  const rCan = await get(a, reader.token)
  ok(rCan.status === 200, '（基准）只读成员**能下载**这份附件 —— 他确实有 read', String(rCan.status))

  const r2 = await del(b2, reader.token, docId)
  ok(r2.status === 403, '**只读成员也删不掉** —— 能读不等于能删（read 不放行）', String(r2.status))

  // 这一条比 403 本身更要紧：403 的实现很容易写成「先删再判权」
  ok(rowExists(a) && rowExists(b2), '两次被拒之后，两份文件在库里都还在（403 不能顺手删掉数据）')

  const still = await get(a, admin)
  ok(still.status === 200, '管理员仍能下到它（确实没被误删）', String(still.status))
}

console.log('\n== 只有一个引用时：删了就是真删了 ==')
{
  const id = (await upload(docId, admin, '要删掉的.txt')).id
  // **先让文档真的引用它**。以前这条用例是靠「文档没有 blocks」通过的 ——
  // 那意味着服务端根本没走引用判定，一旦加了判定就会露馅。
  await putDoc(docId, B.id, cardFor(id))
  const blocksNow = await readBlocks(docId)
  ok(blocksNow[0]?.data?.key === id, '文档确实引用着这份附件（基准，不是「我以为引用了」）', JSON.stringify(blocksNow).slice(0, 90))
  ok(rowExists(id), '上传后行在库里')

  const r = await del(id, admin, docId)
  ok(r.status === 200, '删除返回 200', `${r.status} ${JSON.stringify(r.json).slice(0, 80)}`)
  ok(r.json.deleted === true, '而且 `deleted: true` —— 服务端说二进制真的删了', JSON.stringify(r.json).slice(0, 80))

  // 判据不能只看返回值：接口说删了，行还在就等于没删
  ok(!rowExists(id), '**行真的从库里没了**（不是只回了个 ok）')
  ok((await get(id, admin)).status === 404, '再取就是 404 —— 二进制真的走了')
}

console.log('\n== 基准：复制一篇带附件的文档，两篇会共指同一份 ==')
{
  // 这一节是后面所有「删除不该弄坏别的文档」断言的**基准**。
  // 没有它，把整个引用判定删掉，那些断言照样会红 —— 就什么也证明不了。
  const book2Id = `attdel_bk2_${SFX}`
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: { books: [{ id: book2Id, spaceId: 's1', name: '探针库二', visibility: 'space', createdAt: Date.now(), updatedAt: Date.now() }] },
    }),
  }, admin)

  const shared = (await upload(docId, admin, '共享.txt')).id
  await putDoc(docId, B.id, cardFor(shared))
  ok((await readBlocks(docId))[0]?.data?.key === shared, '原件引用了它', shared)

  const mv = await ses(`/api/doc/${docId}/move`, {
    method: 'POST', body: JSON.stringify({ bookId: book2Id, mode: 'copy' }),
  }, admin)
  const copyId = mv.json.docId || ''
  ok(mv.status === 200 && !!copyId, '复制到另一个知识库', `${mv.status} ${JSON.stringify(mv.json).slice(0, 80)}`)

  const origKey = (await readBlocks(docId))[0]?.data?.key || ''
  const copyKey = (await readBlocks(copyId))[0]?.data?.key || ''
  ok(!!copyId && origKey === shared && copyKey === shared,
    '**原件与副本指向同一个附件 id** —— moveDoc 是逐字照抄 blocks 的',
    `原件=${origKey} 副本=${copyKey} 真实=${shared}`)

  console.log('\n-- 在副本里撤引用：原件必须毫发无伤 --')
  {
    const r = await del(shared, admin, copyId)
    ok(r.status === 200, '撤掉副本里的引用 → 200（不是失败，是正确的共享语义）', String(r.status))
    ok(r.json.deleted === false, '**`deleted: false`** —— 服务端明确说二进制没删', JSON.stringify(r.json).slice(0, 90))
    ok(Number(r.json.keptFor) >= 1, '并说清还被几篇引用着', `keptFor=${r.json.keptFor}`)
    ok(/引用/.test(String(r.json.notice || '')), '还带一句给用户看的话', String(r.json.notice))

    // **这是本套件最要紧的一条断言**
    const still = await get(shared, admin)
    ok(still.status === 200, '**原件那份还能下** —— 在副本里删一次没有连坐原件', String(still.status))
    ok(rowExists(shared), '二进制也还在库里（不是只回了个 ok）')
  }

  console.log('\n-- 不传 docId 直接删：必须明确拒掉，不能无条件删 --')
  {
    const r = await del(shared, admin, '')
    ok(r.status === 409, '**拒绝**（409 Conflict：和当前状态冲突，不是「你没权限」）', String(r.status))
    ok(/引用/.test(String(r.json.error || '')), '理由说清了「还被几篇文档引用着」', String(r.json.error).slice(0, 90))
    ok(rowExists(shared) && (await get(shared, admin)).status === 200, '文件仍在（拒掉不等于删掉一半）')
  }

  console.log('\n-- 撤掉最后一个引用之后，这次该真删 --')
  {
    /*
     * 上一轮「撤引用」只是**服务端记账**：它知道自己不再把这篇算进去，
     * 但副本 `blocks` 里那个 key 还在 —— 真实客户端点删除时会顺手
     * `onChange(emptyAttachmentPatch())` 把块删掉并存盘。
     * 这里直接调 API 跳过了那一步，所以必须自己把副本的 blocks 清空，
     * 否则 keptFor 仍然算着副本 —— 那时服务端是对的，是我漏了一步。
     */
    await putDoc(copyId, book2Id, [])
    ok((await readBlocks(copyId)).length === 0, '副本里的卡片已经删掉并存盘了（客户端那一步）')

    const r = await del(shared, admin, docId)
    ok(r.status === 200 && r.json.deleted === true,
      '**`deleted: true`** —— 最后一个引用撤掉后二进制才真被删', JSON.stringify(r.json).slice(0, 80))
    ok(!rowExists(shared), '行从库里没了')
    ok((await get(shared, admin)).status === 404, '再取是 404')
  }
}

console.log('\n== 无主附件：连管理员也删不掉，理由要说清 ==')
{
  /*
   * 直接塞一条无主附件 —— 模拟「升级前就已经存在」的那种数据。
   * 上传端现在不许再产生这种行（见 test-attachaith），但库里可能已经有。
   */
  const orphan = 'legacy_orphan_del_' + SFX
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  d.prepare('INSERT INTO attachments (id,docId,blockId,filename,mime,size,data,createdAt) VALUES (?,?,?,?,?,?,?,?)')
    .run(orphan, null, null, 'old.txt', 'text/plain', 12, Buffer.from('机密内容-不应被外人拿到'), Date.now())
  d.close()

  for (const [label, tok] of [['管理员', admin], ['外部人', outsider.token]]) {
    const r = await del(orphan, tok, '')
    ok(r.status === 403, `${label}也删不掉无主附件`, String(r.status))
    /*
     * 光验 403 不够：把归属判断整段删掉之后，capsOfDoc(u, null)
     * 判不出权限**同样**返回 403。所以这里断言**理由**。
     */
    ok(/没有关联文档/.test(String(r.json.error || '')),
      `${label}看到的理由是「数据缺归属」而不是笼统的「没有权限」`, String(r.json.error))
  }
  ok(rowExists(orphan), '无主附件仍在库里（没人有权替它做这个决定）')
}

console.log('\n== 边界 ==')
{
  const r = await del('压根不存在的附件_' + SFX, admin, docId)
  ok(r.status === 404, '删不存在的 id → 404', String(r.status))

  const noauth = await fetch(`${BASE}/api/attachment/随便什么`, { method: 'DELETE' })
  ok(noauth.status === 401, '不登录不能删', String(noauth.status))

  const id = (await upload(docId, admin)).id
  await putDoc(docId, B.id, cardFor(id))
  ok((await del(id, admin, docId)).status === 200, '第一次删成功')
  const twice = await del(id, admin, docId)
  // 客户端把 404 当成功（幂等），服务端也该给 404 而不是 500
  ok(twice.status === 404, '重复删同一个 id → 404 而不是 500（幂等）', String(twice.status))
}

console.log('\n== 审计：两种动作都要能查到 ==')
{
  const del1 = (await ses('/api/audit?action=attachment.delete', {}, admin)).json.items || []
  const det1 = (await ses('/api/audit?action=attachment.detach', {}, admin)).json.items || []
  ok(del1.length > 0, `真删有 ${del1.length} 条记录（attachment.delete）`)
  ok(det1.length > 0, `撤引用有 ${det1.length} 条记录（attachment.detach）`)
  ok(del1.some((i) => String(i.targetName || '').includes('要删掉的')),
    '真删那条能按文件名查到（detail 里留了大小和所属文档）', String(del1[0]?.targetName))
  ok(Array.isArray(det1[0]?.detail?.keptFor) && det1[0].detail.keptFor.length > 0,
    '撤引用那条记着「还留给哪几篇」—— 事后要能回答为什么没删', JSON.stringify(det1[0]?.detail || {}).slice(0, 100))
}

console.log('\n== 接线：删除动作必须跟着存储后端走 ==')
{
  const read = (f) => readFileSync(f, 'utf8')
  /** 剥掉注释再判断 —— 同一个坑第七次了：扫全文会扫到自己解释 bug 的注释 */
  const bare = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /**
   * 取某个函数的名字到函数体结束为止。
   *
   * 踩过两次的坑，都在「找函数体的 `{`」这一步：
   *   ① 参数表里就有花括号（`Record<string, { blocks?: Block[] }>`）；
   *   ② **返回类型里也有**（`Promise<{ err: string; keptFor: number }>`）。
   * 一步到位地找第一个 `{`，两种都会截成签名或类型 —— 而签名里
   * 往往恰好含有我们要找的词（`docId`、`deleted`），于是断言
   * 「有的地方是绿的、该验的地方没验到」。这比直接失败更坏。
   *
   * 所以：配平圆括号之后，还要**跳过尖括号里的类型**再找 `{`。
   */
  const fnBody = (src, name) => {
    const i = src.indexOf(name)
    if (i < 0) return ''
    const p = src.indexOf('(', i)
    if (p < 0) return ''
    let depth = 0, close = -1
    for (let k = p; k < src.length; k++) {
      if (src[k] === '(') depth++
      else if (src[k] === ')') { depth--; if (depth === 0) { close = k; break } }
    }
    if (close < 0) return ''
    // 跳过返回类型里的花括号：只在尖括号深度为 0 时才算函数体开头
    let angle = 0, start = -1
    for (let k = close + 1; k < src.length; k++) {
      const c = src[k]
      if (c === '<') angle++
      else if (c === '>') angle--
      else if (c === '{' && angle <= 0) { start = k; break }
      else if (c === '\n' && src.slice(close + 1, k).trim() === '' && angle <= 0) { start = k + 1; break }
    }
    if (start < 0) return ''
    depth = 0
    for (let k = start; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
    }
    return src.slice(i)
  }

  const store = bare('src/lib/attachment-store.ts')
  const drop = fnBody(store, 'export async function dropFile')
  // 正面断言：真的去调了远端删除
  ok(/deleteRemoteAttachment/.test(drop),
    'dropFile 在服务端模式下真的会发 DELETE（以前第一行就 return，什么也没做）', drop.slice(0, 90))
  /*
   * 判据是**调用时有没有把 docId 传下去**，不是「函数体里有没有 docId 这个词」。
   * 第一版写的是 `/docId/.test(drop)` —— 而 `docId?: string` 就在参数表里，
   * 所以把调用改成 `deleteRemoteAttachment(key)`（正是要防的那个回归）之后，
   * 断言照样绿。破坏对照当场抓到了这一点。
   */
  ok(/deleteRemoteAttachment\(\s*key\s*,\s*docId/.test(drop),
    '并且**调用时**把 docId 传下去（只查「函数体里有 docId」会被参数表蒙混过去）', drop.slice(0, 120))

  const api = bare('src/lib/api.ts')
  const dra = fnBody(api, 'export async function deleteRemoteAttachment')
  ok(/docId=/.test(dra), 'deleteRemoteAttachment 把 docId 拼进 query（这一步缺了，复制文档就会连坐）')
  ok(/deleted/.test(dra), '并且把「删了没有」如实带回界面（void 的话界面只能瞎猜）')

  const common = bare('src/components/cards/common.tsx')
  const rel = fnBody(common, 'export async function releaseAttachment')
  ok(/dropFile/.test(rel),
    'releaseAttachment 走的是适配层 dropFile，不再直接 import idb 的 deleteAttachment', rel.slice(0, 90))
  const det = fnBody(common, 'export async function detachAttachment')
  /*
   * 顺序是这条的全部意义所在，所以**必须比较位置**，光验「函数体里有两个名字」没用 ——
   * 我第一版就是这么写的，把 onCleared 挪到删除之前它照样全绿。
   */
  const dDrop = det.lastIndexOf('dropFile(')
  const dClear = det.lastIndexOf('onCleared()')
  ok(dDrop > 0 && dClear > dDrop, 'detachAttachment 先删二进制、成功后才清卡片（顺序反了就会「看起来删了其实没删」）',
    `dropFile@${dDrop} onCleared@${dClear}`)
  // 失败必须把原因带出来：吞掉错误的话，界面上一句提示都没有，等于骗用户
  ok(!/catch\s*(?:\([^)]*\))?\s*\{\s*return\s*\{\s*err:\s*''/.test(det),
    '删除失败时返回的是原因而不是空串（返回空串 = 界面什么都不说 = 用户以为删掉了）')
  ok(/keptFor/.test(det), '并且把「文件因为别人还在用所以留下了」带出去（那不是失败）')

  const editor = bare('src/components/doc/Editor.tsx')
  const rm = fnBody(editor, 'const removeBlock')
  /*
   * 只验「函数体里出现过 releaseAfterRemove」也不够：把它改成
   * `if (gone && false) void releaseAfterRemove(gone)` 文本照样在，一样全绿 ——
   * 这正是第一版栽的地方。所以额外排掉「被字面量 false 关掉」的调用。
   */
  ok(/releaseAfterRemove\(/.test(rm) && !/&&\s*false/.test(rm),
    'removeBlock 也会回收附件 —— 块菜单的「删除块」走的是这条路', rm.slice(0, 90))

  const srv = bare('server/index.ts')
  ok(/on\('DELETE', '\/api\/attachment\/:id'/.test(srv), '服务端确实注册了 DELETE /api/attachment/:id')
  ok(/AUDIT\.attachmentDelete/.test(srv), '真删走审计常量（写字面串拼错了会静默变成另一种记录）')
  ok(/AUDIT\.attachmentDetach/.test(srv), '撤引用是另一个动作 —— 混成一条审计就看不出「为什么没删」')
  ok(/docsReferencing/.test(srv), '删除前会扫真实引用（不扫就是无条件删）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
