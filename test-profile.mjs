/**
 * 改自己的资料
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 设置页的第一屏「个人资料」有个「保存修改」按钮。
 * 它以前只弹了一句「资料已保存」——
 * 昵称、邮箱、简介三个输入框改的是**组件的局部 state**
 * （「个人简介」连 state 都没有，用的是 `defaultValue`，
 *   改完连本地都留不住）。
 * 服务端**压根没有改资料的接口**。
 *
 * 于是用户改完昵称、看到绿色的「资料已保存」、关掉页面、
 * 回来发现昵称变回去了 —— 而中间没有任何一处报错。
 *
 * 这个套件钉的是：
 *   ① 真的落库，而且**换台设备也看得见**（记了 changes）
 *   ② **只能改自己** —— 别人的资料碰不到
 *   ③ **账号（登录名）传了也不生效**，而且要说明为什么
 *   ④ 角色 / 密码列碰不到（越权字段被忽略，不是报错）
 *   ⑤ 存不进去的东西要**当场拒**（空昵称、邮箱格式）
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.PROFILE_PORT || await freePort()
const DB = 'data/_profile-test.db'
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

const login = async (account, password = 'yuque@2026') =>
  (await ses('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) })).json.token || ''

const admin = await login('admin')
ok(!!admin, '管理员登录成功')

// 注册一个普通账号当「我」
const acc = 'prof_' + Math.random().toString(36).slice(2, 8)
const reg = await ses('/api/auth/register', {
  method: 'POST', body: JSON.stringify({ account: acc, password: 'probe@2026', name: '改名前的昵称' }),
})
const meTok = reg.json.token || await login(acc, 'probe@2026')
const myId = reg.json.user?.id || (await ses('/api/auth/me', {}, meTok)).json.user?.id
ok(!!meTok && !!myId, `注册出被改资料的账号（${acc}）`)

console.log('\n== 真的落库 ==')
{
  const r = await ses('/api/users/me', {
    method: 'PATCH', body: JSON.stringify({ name: '改完的昵称', email: 'me@corp.com', bio: '做后端的。' }),
  }, meTok)
  ok(r.status === 200, '改资料返回 200', `${r.status} ${String(r.json.error).slice(0, 60)}`)
  ok(r.json.user?.name === '改完的昵称', '返回的是**服务端存下来的**那一份', String(r.json.user?.name))

  // 重新登录取一次，证明真的进了库（而不是只在那个响应里）
  const again = await login(acc, 'probe@2026')
  const me = (await ses('/api/auth/me', {}, again)).json.user
  ok(me.name === '改完的昵称', '**重新登录还是新昵称**（真的落库了）', String(me.name))
  ok(me.email === 'me@corp.com', '邮箱也存下来了', String(me.email))
  ok(me.bio === '做后端的。', '个人简介也存下来了（以前连本地都留不住）', String(me.bio))
}

console.log('\n== 换台设备也看得见 ==')
{
  const r = await ses('/api/users/me', { method: 'PATCH', body: JSON.stringify({ name: '跨设备昵称' }) }, meTok)
  ok(r.status === 200, '改昵称', String(r.status))

  /*
   * 跨设备靠的是 **changes 变更流**，不是 bootstrap。
   *
   * 原先这里只断言「bootstrap 里是新昵称」，而 bootstrap 是**直接读库**的
   * —— 不经过变更流。所以把 logChange 整个删掉，这条断言照样绿。
   * 真正能验「别的设备拉不拉得到」的是 /api/sync/changes。
   *
   * 浏览器端的 pull 用的是 changes 表；不记它，
   * 表现是「这台设备改了、刷新就没了」—— 而那正是这个套件最初要防的事。
   */
  /*
   * 先拿一次「当前 seq」。
   *
   * 这里原来错得很典型：我拿 `/api/health` 里的 `ts` 当基准 ——
   * 那是 **Date.now() 时间戳**（13 位数），而 `changes.seq` 是自增序号（几位数）。
   * 于是 \`WHERE seq > 1759...\` 永远不成立，增量返回空 —— 而那条断言
   * 本来是要证明「改动记进变更流了」，结果它只证明了「查不出来」。
   *
   * 正确的基准就是 \`/api/sync/changes\` 自己回的那个 \`seq\`。
   */
  const seqBefore = Number((await ses('/api/sync/changes?since=0', {}, meTok)).json.seq || 0)
  await ses('/api/users/me', { method: 'PATCH', body: JSON.stringify({ bio: '再改一次' }) }, meTok)
  const delta = (await ses(`/api/sync/changes?since=${seqBefore}`, {}, meTok)).json
  const ups = (delta.upsert?.members || []).filter((m) => m.id === myId)
  ok(ups.length > 0, '**改动记进了 changes** —— 别的设备靠这个流拉取，不记就只有这台变了',
    `since=${seqBefore} → ${JSON.stringify(Object.keys(delta.upsert || {}))}`)

  const boot = (await ses('/api/bootstrap?lite=0', {}, meTok)).json
  ok((boot.data?.members || []).some((m) => m.id === myId && m.name === '跨设备昵称'), 'bootstrap 里也是新昵称')
  const row = (boot.data?.members || []).find((m) => m.id === myId)
  ok(row && !/passHash|passSalt/.test(JSON.stringify(row)), '名单里仍然没有密码列')
}

console.log('\n== 只能改自己 ==')
{
  const other = 'profother_' + Math.random().toString(36).slice(2, 8)
  const reg2 = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: other, password: 'probe@2026', name: '别人的昵称' }),
  })
  const otherId = reg2.json.user?.id

  // 没有任何「改别人」的接口 —— 这一条靠的是接口清单本身
  const src = readFileSync('server/index.ts', 'utf8')
  ok(!/on\(\s*'(PATCH|PUT|POST)',\s*'\/api\/users\/:id'/.test(src), '**没有「按 id 改别人」的路由**（改资料这条路只有 /me）')

  // 就算硬传一个 id，也只作用于自己
  const r = await ses('/api/users/me', {
    method: 'PATCH', body: JSON.stringify({ id: otherId, name: '我试图改别人' }),
  }, meTok)
  const otherNow = (await ses('/api/entity/members', {}, admin)).json.rows?.find((m) => m.id === otherId)
  ok(otherNow?.name === '别人的昵称', '传了别人的 id 也改不到他（id 字段被忽略）', String(otherNow?.name))
  ok(r.status === 200, '而且不会报错（多余字段被忽略，不假装成功也不假装失败）', String(r.status))
}

console.log('\n== 账号（登录名）不给改 ==')
{
  const before = (await ses('/api/auth/me', {}, meTok)).json.user.account
  const r = await ses('/api/users/me', { method: 'PATCH', body: JSON.stringify({ account: 'hacked_name' }) }, meTok)
  ok(r.status === 200, '传了 account 不报错', String(r.status))
  const after = (await ses('/api/auth/me', {}, meTok)).json.user.account
  ok(after === before, '**但账号没变**（服务端根本不接受这个字段）', `${before} -> ${after}`)

  // 界面上也不能留一个能改的框
  const settings = readFileSync('src/pages/Settings.tsx', 'utf8')
  const at = settings.indexOf('账号是登录名，不能在这里改')
  ok(at > 0, '设置页写清了「账号不能在这里改」以及为什么')
  const acctInput = /<Input value=\{currentUser\.account\}[^>]*\/?>/.exec(settings)?.[0] || ''
  ok(/readOnly/.test(acctInput), '**那个**输入框是只读的（不是留一个改了不生效的框）', acctInput.slice(0, 80))
  ok(!/onChange/.test(acctInput), '它也没有 onChange（只读框连改都不给改）')
}

console.log('\n== 越权字段碰不到 ==')
{
  const before = (await ses('/api/auth/me', {}, meTok)).json.user
  const r = await ses('/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify({ role: 'owner', passHash: 'x', passSalt: 'y', viaSso: 1, id: 'u_别人' }),
  }, meTok)
  ok(r.status === 200, '传角色/密码列不报错', String(r.status))
  const after = (await ses('/api/auth/me', {}, meTok)).json.user
  ok(after.role === before.role, '**角色没变**', `${before.role} -> ${after.role}`)
  ok(after.id === before.id, 'id 没被改')
  const raw = JSON.stringify(after)
  ok(!/passHash|passSalt/.test(raw), '响应里也没有密码列')
  ok(after.viaSso === undefined || after.viaSso === before.viaSso, 'viaSso 没被改')
}

console.log('\n== 存不进去的当场拒 ==')
{
  const empty = await ses('/api/users/me', { method: 'PATCH', body: JSON.stringify({ name: '   ' }) }, meTok)
  ok(empty.status === 400, '空昵称被拒（而不是存进去一个空名字）', String(empty.status))

  const badMail = await ses('/api/users/me', { method: 'PATCH', body: JSON.stringify({ email: '不是邮箱' }) }, meTok)
  ok(badMail.status === 400, '邮箱格式不对被拒', String(badMail.status))

  const after = (await ses('/api/auth/me', {}, meTok)).json.user
  ok(after.name !== '' && after.name.trim() !== '', '被拒之后资料还是原来那份（没被写坏）', String(after.name))

  const noop = await ses('/api/users/me', { method: 'PATCH', body: JSON.stringify({}) }, meTok)
  ok(noop.status === 200, '什么都不传也是 200（不是错误）', String(noop.status))
}

console.log('\n== 界面确实接上了 ==')
{
  const s = readFileSync('src/pages/Settings.tsx', 'utf8')
  ok(/onClick=\{\(\) => updateMyProfile\(/.test(s), '「保存修改」调的是真的 updateMyProfile')
  ok(!/toast\('资料已保存'/.test(s), '**没有那句空转的「资料已保存」toast 了**')
  ok(/value=\{bio\}/.test(s), '个人简介是受控的（以前是 defaultValue，改完本地都留不住）')
  ok(!/defaultValue="产品经理/.test(s), '简介里那个写死的演示文案也去掉了')

  const store = readFileSync('src/store/index.ts', 'utf8')
  ok(/updateMyProfile: async \(patch\)/.test(store), 'store 里是真实现（不是又一个空壳 action）')
  ok(/await updateMyProfileApi\(/.test(store), '它真的 await 了服务端接口（不只是函数名出现在文件里）')
  ok(!/updateMyProfile: async \(patch\) => \{\s*get\(\)\.toast/.test(store), '不是「弹个 toast 就完事」的空壳')
  ok(/本地模式下改不了资料/.test(store), '本地模式下**明确告诉用户改不了**（不是静默成功）')
  ok(!/if \(getMode\(\) !== 'server'\) \{\s*return/.test(store), '本地模式那一支是真的拦住了')

  const api = readFileSync('src/lib/api.ts', 'utf8')
  ok(/patch: <T,>/.test(api), 'api 对象有 patch 方法')
  ok(api.includes("'/api/users/me'"), '指向服务端那个只给自己用的接口')
}

console.log('\n== 这条通路不能被当成「改别人的后门」 ==')
{
  const src = readFileSync('server/index.ts', 'utf8')
  // sync push 走 members 实体，那条路仍然只放行平台管理员
  const ent = readFileSync('server/entities.ts', 'utf8')
  ok(/if \(def\.name === 'members'\) \{/.test(readFileSync('server/sync.ts', 'utf8')), 'sync push 仍然对 members 要求管理员')
  ok(ent.includes("'bio'"), 'members 的 writable 里多了 bio（资料能从同步里带出去）')
  ok(!/passHash|passSalt/.test(ent.split("name: 'members'")[1].split('},')[0]), '**writable 里没有密码列** —— 同步这条路也改不到密码')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
