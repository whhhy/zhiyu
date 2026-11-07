/* ============================================================
   知识库统计必须是真数据
   ------------------------------------------------------------
   以前「统计」页展示的是编造的数字：
     · 访问者 / 浏览量写死在 `seedBookStats`（1843 / 12760……）
     · 近 14 天趋势用一个种子 LCG **随机生成**
     · 「今天 N 次访问」也是随机数

   公司里真会拿这个数写报告，所以必须换成真数据。

   这个套件钉三件事：
     1. 没有阅读记录时，统计就是 0（不是某个占位数字）
     2. 有人真读了，数字会跟着变 —— 变的是**去重后**的人数
     3. 刷上报接口灌不进水（同一人同一天同一篇只算一次）
   ============================================================ */

import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const PORT = process.env.STATS_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_stats-${Date.now().toString(36)}.db`
const PW = 'stats-test@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
})

const json = async (p, opt = {}) => {
  const res = await fetch(BASE + p, opt)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { status: res.status, data }
}
const auth = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' })

try {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* 等 */ }
  }

  const admin = (await json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: PW }),
  })).data
  const A = auth(admin.token)

  const boot = (await json('/api/bootstrap', { headers: A })).data
  const sid = String(boot.data.spaces[0].id)
  const bid = 'b_stats'
  await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({
      upsert: {
        books: [{ id: bid, spaceId: sid, name: '统计验证库', desc: '', avatar: '📚', visibility: 'private', docCount: 0, wordCount: 0, createdAt: 1, updatedAt: 1 }],
        docs: [{ id: 'd_stats', bookId: bid, spaceId: sid, title: '被阅读的文档', blocks: [{ id: 'b1', type: 'p', text: '正文', order: 0 }], order: 0, wordCount: 2, createdAt: 1, updatedAt: 1, rev: 0 }],
        nodes: [{ id: 'n_stats', bookId: bid, parentId: null, title: '被阅读的文档', type: 'doc', docId: 'd_stats', ord: 0, rev: 0 }],
      },
      remove: {},
    }),
  })

  console.log('\n== 没有任何阅读记录时，统计必须是 0 ==')
  const s0 = (await json(`/api/book/${bid}/stats`, { headers: A })).data
  ok(s0.visitors === 0, '访问者是 0（不是某个占位数字）', String(s0.visitors))
  ok(s0.views === 0, '阅读人次是 0', String(s0.views))
  ok(Array.isArray(s0.days) && s0.days.length === 14, '近 14 天的序列在（前端要画图）', String(s0.days?.length))
  ok(s0.days.every((d) => d.value === 0), '每一天都是 0 —— 没有记录就不编', JSON.stringify(s0.days?.map((d) => d.value)))

  console.log('\n== 读一次之后，数字要跟着变 ==')
  await json('/api/doc/d_stats/view', { method: 'POST', headers: A })
  const s1 = (await json(`/api/book/${bid}/stats`, { headers: A })).data
  ok(s1.views === 1, '阅读人次变成 1', String(s1.views))
  ok(s1.visitors === 1, '访问者变成 1', String(s1.visitors))
  const todayVal = s1.days[s1.days.length - 1].value
  ok(todayVal === 1, '「今天」那根柱子是 1（不是随机数）', String(todayVal))

  console.log('\n== 刷上报接口灌不进水 ==')
  for (let i = 0; i < 9; i++) await json('/api/doc/d_stats/view', { method: 'POST', headers: A })
  const s2 = (await json(`/api/book/${bid}/stats`, { headers: A })).data
  ok(s2.views === 1, '同一人同一天同一篇刷 10 次，阅读人次仍是 1', String(s2.views))
  ok(s2.visitors === 1, '访问者仍是 1', String(s2.visitors))

  console.log('\n== 第二个人读了，访问者要变成 2 ==')
  const reg = (await json('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'stats_reader', password: 'test1234', name: '阅读同事' }),
  })).data
  await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({
      upsert: { bookMembers: [{ bookId: bid, userId: reg.user.id, id: reg.user.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: 1 }] },
      remove: {},
    }),
  })
  const reader = (await json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'stats_reader', password: 'test1234' }),
  })).data
  await json('/api/doc/d_stats/view', { method: 'POST', headers: auth(reader.token) })
  const s3 = (await json(`/api/book/${bid}/stats`, { headers: A })).data
  ok(s3.visitors === 2, '访问者变成 2（按人去重）', String(s3.visitors))
  ok(s3.views === 2, '阅读人次变成 2', String(s3.views))

  console.log('\n== 无权访问的人不能刷统计，也不能看统计 ==')
  const denied = await json('/api/doc/d_stats/view', { method: 'POST', headers: auth(admin.token) })
  ok(denied.status === 200, '（管理员自己当然能读）', String(denied.status))
  const stranger = (await json('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'stats_stranger', password: 'test1234', name: '无关同事' }),
  })).data
  const st = (await json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'stats_stranger', password: 'test1234' }),
  })).data
  const S = auth(st.token)
  ok((await json('/api/doc/d_stats/view', { method: 'POST', headers: S })).status === 403, '无权的人上报阅读被拒', '没被拒')
  ok((await json(`/api/book/${bid}/stats`, { headers: S })).status === 403, '无权的人看统计被拒', '没被拒')
  const s4 = (await json(`/api/book/${bid}/stats`, { headers: A })).data
  ok(s4.visitors === 2, '越权上报没有把数字顶上去', String(s4.visitors))
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { kid.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) { try { rmSync(DB + s) } catch { /* 删不掉就算了 */ } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
