/**
 * 登录设备管理：真起一次服务，把两条新路由跑通
 * （`npx tsc --noEmit` **只编译 src/**，服务端不在它的检查范围里 ——
 *  所以改完 server/*.ts 必须真跑一次，这次就是为此存在的。）
 * =================================================================== */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const PORT = process.env.SESS_PORT || await freePort()
const DB = 'data/_sess-test.db'
const BASE = `http://localhost:${PORT}`
const PW = 'sess-test@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }

const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', (d) => { log += d })
srv.stderr.on('data', (d) => { log += d })
/* ---- 收摊：等子进程**真的退出**再删库 ----
 *
 * ⚠️ 原来只有 `process.on('exit', stop)`：exit 处理器是**同步**的，
 * `srv.kill()` 只是发信号，那一刻子进程还活着（Windows 文件锁），
 * 删库必然失败又被空 catch 吞掉 —— 于是每单独跑一次，data/ 里就多留一个库。
 * 全量跑时 runner 的清扫会兜住，**单独跑不会**；而单独跑正是排查时做的事。
 */
const { rmSync: rmDb, existsSync: exDb } = await import('node:fs')
let srvExited = false
srv.once('exit', () => { srvExited = true })
const cleanup = async () => {
  if (!srvExited) {
    srv.kill()
    for (let i = 0; i < 50 && !srvExited; i++) await new Promise((r) => setTimeout(r, 100))
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
/* 兜底：崩溃/早退时也收一次（那时没法 await，只能尽力） */
const stop = () => { try { srv.kill() } catch {} }
process.on('exit', stop)

try {
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { /* 等 */ }
  }
  if (!up) { console.error('服务没起来：\n' + log.slice(0, 900)); stop(); process.exit(1) }

  const call = async (p, tok, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } })
    const t = await r.text()
    let d = null
    try { d = JSON.parse(t) } catch { /* 保留原文 */ }
    return { status: r.status, d, raw: t }
  }
  const login = async (account, password) => (await call('/api/auth/login', '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }),
  })).d?.token

  console.log('== 准备：三个「设备」 ==')
  const A = await login('admin', PW)
  ok(!!A, '设备 A 登录成功')
  const B = await login('admin', PW)          // 同一账号、第二台设备
  const C = await login('admin', PW)          // 第三台
  ok(!!B && !!C, '设备 B / C 登录成功', `${!!B}/${!!C}`)
  ok(new Set([A, B, C]).size === 3, '三个令牌互不相同（真的是三台设备）')

  console.log('\n== 列表 ==')
  const list = await call('/api/auth/sessions', A)
  ok(list.status === 200, `GET /api/auth/sessions → 200（实际 ${list.status}）`, list.raw.slice(0, 100))
  const listB = await call('/api/auth/sessions', B)
  const rows = list.d?.sessions || []
  ok(rows.length === 3, `列出 3 条（实际 ${rows.length}）`)
  ok(rows.every((r) => r.current === false || r.ref), '每条都带 ref')
  ok(rows.filter((r) => r.current).length === 1, '**恰好一条**标为 current（当前设备）')
  ok(rows.find((r) => r.current)?.createdAt > 0, '当前设备那条也带时间')

  // ⚠️ 最要紧的一条：响应里绝不能出现 token
  const leaked = [A, B, C].filter((t) => list.raw.includes(t))
  ok(leaked.length === 0, '**响应里没有任何令牌**（主键就是 token，发出去了等于交出别的设备的凭据）', leaked.length ? '泄漏 ' + leaked.length + ' 个' : '')
  ok(!/"token"/.test(list.raw), '连 token 这个字段名都没有')

  console.log('\n== 下线设备 B ==')
  const refB = rows.find((r) => !r.current && listB.d.sessions.find((x) => x.ref === r.ref))
  // 用 B 自己那份列表找到 B 的 ref（current 那条就是 B）
  const refOfB = listB.d.sessions.find((r) => r.current)?.ref
  ok(!!refOfB, `找到 B 的 ref（${refOfB}）`)
  const del = await call('/api/auth/sessions/' + encodeURIComponent(refOfB), A, { method: 'DELETE' })
  ok(del.status === 200, `A 下线 B → 200（实际 ${del.status}）`, del.raw.slice(0, 100))
  const afterB = await call('/api/auth/me', B)
  ok(afterB.status === 401, `**B 的令牌立刻失效** → 401（实际 ${afterB.status}）`)
  const stillA = await call('/api/auth/me', A)
  ok(stillA.status === 200, 'A 自己不受影响')

  console.log('\n== 边界 ==')
  const refA = list.d.sessions.find((r) => r.current)?.ref
  const delSelf = await call('/api/auth/sessions/' + encodeURIComponent(refA), A, { method: 'DELETE' })
  ok(delSelf.status === 400, `删**当前**设备被拒 → 400（实际 ${delSelf.status}）`, delSelf.raw.slice(0, 80))
  ok(/退出登录/.test(delSelf.raw), '并说清了要改用「退出登录」', delSelf.raw.slice(0, 100))

  const bogus = await call('/api/auth/sessions/AAAAAAAAAAAAAAAAAAAAAA', A, { method: 'DELETE' })
  ok(bogus.status === 404, `不存在的 ref → 404（实际 ${bogus.status}）`)

  const other = await call('/api/auth/register', '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'sess_other', password: 'test1234', name: '别人' }),
  })
  const otherTok = other.d?.token
  const refC = rows.find((r) => !r.current && r.ref !== refOfB)?.ref
  const cross = await call('/api/auth/sessions/' + encodeURIComponent(refC), otherTok, { method: 'DELETE' })
  ok(cross.status === 404, `拿**别人的** ref 去删 → 404（实际 ${cross.status}）`)
  const stillC = await call('/api/auth/me', C)
  ok(stillC.status === 200, '而且 C 的会话**没被删掉**（不是「报错但真删了」）')

  const otherList = await call('/api/auth/sessions', otherTok)
  ok((otherList.d?.sessions || []).every((r) => r.ref !== refC), '别人的列表里看不到你的 ref（不是共用一份列表）')

  console.log('\n== 改动没有把既有行为带坏 ==')
  const out = await call('/api/auth/logout', A, { method: 'POST' })
  ok(out.status === 200, '登出仍然正常')
  ok((await call('/api/auth/me', A)).status === 401, '登出后 A 失效')
} finally {
  await cleanup()
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
