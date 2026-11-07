/*
 * 同步字段对照（2026-10-12）
 *
 * ============================================================
 * 它防的是一整类「不报错、没人发现、却从来没落过库」的缺陷
 * ============================================================
 * 服务端的写入路径 `toRow()` 是**按 `writable` 里的列名**去 `input` 里取值的
 * （`if (!(c in input)) continue`）。而客户端推的是**它自己那个字段名**。
 * 两个名字不一致时：
 *
 *   · 服务端回的是 `applied`、**零 `rejected`** —— 改了等于没改，不报错不提示；
 *   · **读的那一侧往往早就修好了**，所以读起来完全正常。
 *
 * 已知中过这一枪的两处：
 *   · `nodes.order` → 列叫 `ord`：客户端新建的节点 `ord` 永远是 0，
 *     刷新 / 换设备后目录顺序退回数组插入顺序（修法 `writeAliases`）。
 *   · `docs.lock` → 存成 `lockMemberId` + `lockAt` 两列，而客户端推的是
 *     **一个对象** `lock: { memberId, at }`：界面上点「锁定文档」返回成功、
 *     锁条也显示，**刷新后锁条消失**，别人照样能编辑（修法 `writeObjects`）。
 *
 * 两处都**没有任何报错**。所以与其靠人记得去查，不如每次跑都量一遍。
 *
 * ============================================================
 * 为什么这条守卫自己必须有「基准」，而且是最容易漏的一处
 * ============================================================
 * 第一版这个探针只抓到了 10 个实体，另外 11 个**一条推送都没采到**，
 * 输出里写的是「这次没抓到推送样本」—— 而它照样把整份报告打成了绿色。
 *
 * 原因很朴素：探针里写了几个**不存在的 action 名**，
 * 而调用是 `st.那个名字?.(...)` —— 可选调用不报错，静默跳过，
 * 于是「造数据」这一步其实什么都没做，**报告却看起来是完整的**。
 *
 * 所以这里最后一条断言是：**采到的实体数必须够**。
 * 探针一旦退化（比如又换了不存在的 action 名），它会当场红，
 * 而不是安静地少查一半。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.SYNC_FIELDS_PORT || await freePort()
const DB = 'data/_fieldmap.db'
const BASE = `http://127.0.0.1:${PORT}`

/*
 * ⚠️ 必须**先**把 YQ_DB 指到这套件自己的临时库，再 import 实体清单。
 *
 * `server/entities.ts` 静态 import 了 `server/db.ts`，而 `db.ts` 在**导入那一刻**
 * 就按 `process.env.YQ_DB` 打开数据库、跑建表与补列迁移。
 * ESM 的 import 是**提升**的 —— 写在 import 语句之间的赋值来不及生效，
 * 于是测试进程会打开**默认那个库**（部署实例的 `data/yuque.db`）。
 *
 * 也就是说：不这么写，每次跑这个套件都会在部署库上开一个连接并执行一遍迁移检查。
 * 所以这里用 `await import()`，并且必须放在设置环境变量**之后**。
 */
process.env.YQ_DB = DB
const { ENTITIES } = await import('./server/entities.ts')

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 等 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

/** 服务端内部 / 协议字段：它们本来就不该出现在「客户端推的字段」里 */
const PROTOCOL = new Set([
  'rev', 'updatedBy', 'id', 'userId', 'bookId', 'docId', 'parentId', 'topicId',
  'commentId', 'spaceId', 'targetId', 'targetType', 'selectedCommentId', 'nodeId',
])

/** 列名 / 主键 / 复合主键 */
function acceptedKeys(ent) {
  const s = new Set([...ent.writable, ...Object.keys(ent.writeAliases || {})])
  /*
   * ⚠️ `writeObjects` 要加**两层**键：
   *   · 外层是客户端推的字段名（`lock`）
   *   · 内层是对象里那几把钥匙对应的列名（`lockMemberId` / `lockAt`）
   * 第一版只加了内层，于是 `lock` 自己被判成「丢弃」——
   * 而它恰恰是**刚刚修好的那个**。审计报出一个自己造成的假警，
   * 比不报还费时间：人会开始怀疑那个映射到底有没有生效。
   */
  for (const [field, map] of Object.entries(ent.writeObjects || {})) {
    s.add(field)
    for (const col of Object.values(map)) s.add(col)
  }
  return s
}

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    const keys = {}
    p.on('request', (r) => {
      if (!r.url().includes('/api/sync/push')) return
      let b
      try { b = JSON.parse(r.postData() || '{}') } catch { return }
      for (const [ent, rows] of Object.entries(b.upsert || {})) {
        for (const row of rows) {
          keys[ent] ||= new Set()
          for (const k of Object.keys(row)) keys[ent].add(k)
        }
      }
    })

    await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', 'yuque@2026')
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })
    await p.waitForTimeout(2000)
    const token = await p.evaluate(() => localStorage.getItem('yq_token'))
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    const boot = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
    const sid = (boot.data.spaces || [])[0]?.id

    /*
     * ⚠️ 这里的 action 名是照 store 里**真实**的名字写的。
     *   写错一个就是可选调用静默跳过 → 少查一个实体 → 而报告照样是绿的。
     *   所以下面那条「采到的实体数」断言是这个探针的**命根子**。
     */
    await p.evaluate((s) => {
      const st = window.__yqStore.getState()
      const bookId = st.createBook(s, '字段对照库 ' + Date.now().toString(36))
      const docId = window.__yqStore.getState().createDoc(bookId, null, '对照文档')
      const s2 = window.__yqStore.getState()
      s2.setDocBlocks(docId, [...s2.docs[docId].blocks, { id: 'bk_f1', type: 'p', text: '正文' }])
      window.__b = bookId; window.__d = docId
      s2.addComment(docId, '一条评论')
      s2.addReply(docId, (s2.comments[docId] || [])[0]?.id, '评论回复')
      s2.addNote(bookId, '一条小记')
      s2.replyToTopic((s2.topics[0] || {}).id, '话题回复')
      s2.updateBookSettings(bookId, { watermarkText: '对照水印' })
      s2.toggleFavorite('book', bookId)
      s2.createTopic(bookId, '对照话题', '对照正文')
      s2.updateDoc(docId, { slug: 'dui-biao', summary: '对照摘录' })
      s2.lockDoc(docId)
      s2.touchDoc(docId)
    }, sid)
    await p.waitForTimeout(4000)
    await p.evaluate(() => {
      const st = window.__yqStore.getState()
      st.togglePinDoc(window.__d)
      st.toggleFollow('space', st.spaces[0].id)
      st.toggleFollow('space', st.spaces[0].id)   // 取消 → 于是「新增」那条也走过了
      st.createTemplate({ name: '对照模板', body: '# T', icon: '📄', category: '研发', scope: 'official' })
    })
    await p.waitForTimeout(4000)
    await p.evaluate(() => {
      const st = window.__yqStore.getState()
      const spare = st.createDoc(window.__b, null, '待删文档')
      window.__yqStore.getState().setDocBlocks(spare, [{ id: 'bk_del', type: 'p', text: 'x' }])
      window.__del = spare
    })
    await p.waitForTimeout(3000)
    await p.evaluate(() => { window.__yqStore.getState().deleteDoc(window.__del) })
    await p.waitForTimeout(4000)

    /* ---------- 逐个实体对照 ---------- */
    console.log('\n== 客户端推的字段，服务端一个都不能接不住 ==')
    let sampled = 0
    const noSample = []
    for (const ent of ENTITIES) {
      const clientKeys = [...(keys[ent.name] || [])].sort()
      if (!clientKeys.length) { noSample.push(ent.name); continue }
      sampled++
      const accept = acceptedKeys(ent)
      const dropped = clientKeys.filter((k) => !PROTOCOL.has(k) && !accept.has(k))
      ok(dropped.length === 0,
        `${ent.name.padEnd(24)} ${String(clientKeys.length).padStart(2)} 个字段都接得住`,
        dropped.length ? '★ 丢弃：' + dropped.join(', ') : '')
    }

    /*
     * 命根子这一条：**采到的实体太少就是探针坏了**，
     * 不是「其它实体没问题」。少查一半的报告和没查的报告，
     * 看起来一模一样 —— 上面那两个洞就是这么溜过去的。
     */
    ok(sampled >= 14, `采到 ${sampled} 个实体的推送样本（少于 14 说明探针自己退化了）`,
      `没采到的：${noSample.join(', ') || '(无)'}`)
    console.log(`       没采到样本的实体：${noSample.join(', ') || '(无)'}`)
  } finally { await br.close() }
} catch (e) {
  fail++
  console.error('异常：', e.stack || e.message)
} finally {
  const exited = once(srv, 'exit')
  srv.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) {
      try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)