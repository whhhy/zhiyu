/*
 * 知识库邀请 —— 端到端（真起服务端 + 两个真实账号走完整条路）
 * ============================================================
 * 2026-10-11 新功能。之前本项目只有「管理员单向把人加进库」，
 * 对方没有拒绝的机会、也不知道自己被加了。
 *
 * ⚠️ 这套测试自己踩过的坑（都在下面注出来了，别再犯）：
 *   ① 账号 id **不能凭印象写死**。第一版写 `m.id !== 'u1'`，
 *      而这个库里 admin 的 id 是 `u_admin`（`u1` 是另一个人）——
 *      于是脚本把 admin 自己当邀请对象，服务端正确地回「不能邀请自己」，
 *      看着像功能坏了。**从库里查，别猜。**
 *   ② `resetInvites` **不能清空 book_members**：清空之后除了平台 owner
 *      谁都读不到这个库，「越权」那几条的判据全变了。
 *   ③ 用**被邀请人**的令牌去撤回会拿到 403 —— 那不是权限错，
 *      是场景不成立（他还没接受邀请，就还不是成员，capsInBook 返回 NONE）。
 *
 * 用法：node --import ./server/alias-hooks.mjs test-invite.mjs
 * （自己起服务端，不依赖任何外部实例）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

let pass = 0, fail = 0
const ok = (c, l, e) => {
  if (c) { pass++; console.log('  PASS  ' + l + (e ? '  ' + e : '')) }
  else { fail++; console.log('  FAIL  ' + l + (e ? '  ' + e : '')) }
}

/**
 * 自己挑一个**空闲端口**，不要写死。
 * 理由见 test-invite-e2e.mjs 里那段注释：写死的端口会被机器上
 * 碰巧占着它的进程打挂，而症状完全指不到真因。
 */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

const PORT = Number(process.env.YQ_INVITE_PORT || await freePort())
const PW = process.env.YQ_ADMIN_PASSWORD || 'Inv#2026Test'
const DB = path.join('data', '_invite-test.db')
const clean = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(path.join('data', '_invite-test.db' + s)) } catch {} } }

const req = (method, p, body, token) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : null
  const r = http.request({
    host: '127.0.0.1', port: PORT, path: p, method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  }, (res) => {
    const c = []
    res.on('data', (x) => c.push(x))
    res.on('end', () => {
      const raw = Buffer.concat(c).toString()
      let json = {}
      try { json = JSON.parse(raw) } catch {}
      resolve({ status: res.statusCode, json, raw })
    })
  })
  r.on('error', (e) => resolve({ status: 0, json: {}, raw: e.message }))
  if (data) r.write(data)
  r.end()
})

const login = async (account) =>
  JSON.parse((await req('POST', '/api/auth/login', { account, password: PW })).raw).token || ''

const reset = () => {
  const w = new DatabaseSync(DB)
  w.prepare('DELETE FROM book_invites').run()
  const b = w.prepare('SELECT id FROM books LIMIT 1').get()
  const bookId = b ? String(b.id) : ''
  // ⚠️ 只踢被邀请人，**保留 admin 自己的身份**（清空会让所有人读不到库）
  if (bookId) w.prepare('DELETE FROM book_members WHERE bookId = ? AND userId <> ?').run(bookId, 'u_admin')
  w.close()
  return bookId
}
const roleOf = (bookId, userId) => {
  const r = new DatabaseSync(DB, { readOnly: true })
  const row = r.prepare('SELECT role FROM book_members WHERE bookId = ? AND userId = ?').get(bookId, userId)
  r.close()
  return row ? String(row.role) : null
}
const countPending = (bookId, userId) => {
  const r = new DatabaseSync(DB, { readOnly: true })
  const n = r.prepare("SELECT COUNT(*) AS n FROM book_invites WHERE bookId=? AND toUserId=? AND status='pending'").get(bookId, userId)
  r.close()
  return Number(n.n)
}

const child = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', YQ_DB: DB, YQ_ADMIN_PASSWORD: PW },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let srvLog = ''
child.stdout.on('data', (b) => { srvLog += b })
child.stderr.on('data', (b) => { srvLog += b })
const stop = () => { try { child.kill() } catch {} ; clean() }
process.on('exit', stop)

// 等服务起来
let up = false
for (let i = 0; i < 60; i++) {
  const h = await req('GET', '/api/health')
  if (h.status === 200) { up = true; break }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) {
  console.error('服务没能在 30 秒内起来')
  console.error(srvLog.slice(-1200))
  stop()
  process.exit(1)
}

console.log('\n== 知识库邀请：端到端 ==')
{
  const admin = await login('admin')
  ok(!!admin, '管理员登录成功')

  const boot = JSON.parse((await req('GET', '/api/bootstrap?lite=0', null, admin)).raw)
  const d = boot.data || {}
  const book = (d.books || [])[0]
  // ⚠️ 被邀请人从库里查，并**排除 admin 自己**（见文件头的坑 ①）
  const meId = (d.members || []).find((m) => m.account === 'admin')?.id
  const others = (d.members || []).filter((m) => m.id !== meId && m.account !== 'admin')
  console.log('  知识库「' + book.name + '」，可邀请对象 ' + others.length + ' 人')
  ok(others.length >= 2, '有足够的可邀请对象可跑完整流程')

  const bookId = reset()

  /* ---- 表结构 ---- */
  {
    const r = new DatabaseSync(DB, { readOnly: true })
    const cols = r.prepare('PRAGMA table_info(book_invites)').all().map((c) => c.name)
    ok(cols.length > 0, 'book_invites 表建出来了', cols.join(','))
    ok(['bookId', 'toUserId', 'fromUserId', 'role', 'status', 'createdAt', 'respondedAt'].every((c) => cols.includes(c)),
      '列齐全（含 respondedAt，状态机需要它）')
    const idx = r.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='book_invites'").all()
    const partial = idx.find((i) => /WHERE\s+status\s*=\s*'pending'/i.test(i.sql || ''))
    ok(!!partial, '**部分唯一索引建成了**（只对 pending 去重 —— 拒绝之后还能再邀请）')
    r.close()
  }

  /* ---- 发起 ---- */
  const u2 = others[0]
  const r1 = await req('POST', `/api/books/${bookId}/invites`, { userId: u2.id, role: 'reader', message: '一起维护这份手册' }, admin)
  ok(r1.status === 200 && r1.json.ok, '管理员发起邀请成功', 'status=' + r1.status)
  ok(!!r1.json.inviteId, '返回了邀请 id')
  const invId = r1.json.inviteId

  /* ---- 幂等 ---- */
  const r2 = await req('POST', `/api/books/${bookId}/invites`, { userId: u2.id, role: 'editor' }, admin)
  ok(r2.status === 200 && r2.json.alreadySent === true,
    '重复邀请**幂等返回**（不报错、也不插第二条 —— 报错会让人以为出错）', JSON.stringify(r2.json))
  ok(countPending(bookId, u2.id) === 1,
    '库里只有**一条** pending（不会在对方待办里出现两条一样的）')

  /* ---- 越权：别人不能接受 ---- */
  const u3 = others[1]
  const tok3 = await login(u3.account)
  if (tok3) {
    const r = await req('POST', `/api/invites/${invId}/respond`, { accept: true }, tok3)
    ok(r.status === 404,
      '**别人接受这条邀请 → 404「不存在」**（说 403 等于告诉外人这条邀请存在，泄露了谁邀谁）',
      'status=' + r.status)
  }

  /* ---- 待办 ---- */
  const tok2 = await login(u2.account)
  ok(!!tok2, '被邀请人能登录', u2.account)
  const inbox = await req('GET', '/api/invites', null, tok2)
  ok(inbox.status === 200 && (inbox.json.invites || []).some((i) => i.id === invId),
    '待办列表里有这条邀请', JSON.stringify((inbox.json.invites || []).map((i) => i.bookName)))
  const mine = (inbox.json.invites || []).find((i) => i.id === invId)
  ok(mine && mine.fromName && mine.bookName && mine.role,
    '邀请里带上了**知识库名 / 邀请人名 / 角色**（不然对方不知道谁邀的、进哪个库、能干什么）',
    mine ? `${mine.fromName} → ${mine.bookName}（${mine.role}）` : '')

  /*
   * 发方视角 —— 这一段以前**一条断言都没有**。
   *
   * 「等待对方处理」那个列表要显示「在等谁」，靠的是 `toName`；
   * 而界面原来是拿 `getMember(toUserId)?.name` 去成员表里查的，
   * 查不到就写死「未知成员」—— 用户看着「未知成员」，
   * **根本不知道自己在等谁**，只能退回成员表一个个找。
   *
   * 服务端其实早就把名字解析好一起返回了，只是没人断言它在，
   * 于是客户端一改就静默退化成「未知成员」，没有任何东西变红。
   */
  const sentBox = await req('GET', '/api/invites', null, admin)
  const sent = (sentBox.json.invites || []).find((i) => i.id === invId)
  ok(!!sent, '邀请人自己也看得到这条（不然「等待对方处理」永远是空的）')
  ok(sent && sent.asReceiver === false,
    '它被标成**发方**视角（不标的话管理员会对着自己发出去的邀请看到「接受 / 拒绝」）')
  ok(sent && typeof sent.toName === 'string' && sent.toName.length > 0,
    '发方视角带上了**被邀请人名字**（界面上「等待对方处理」显示的就是它，没有它就退化成「未知成员」）',
    sent ? `toName=「${sent.toName}」` : '')

  /* ---- 接受 → 真的进成员表 ---- */
  const r5 = await req('POST', `/api/invites/${invId}/respond`, { accept: true }, tok2)
  ok(r5.status === 200 && r5.json.status === 'accepted', '接受成功', JSON.stringify(r5.json))
  ok(roleOf(bookId, u2.id) === 'reader',
    '接受后**真的进了 book_members**（不是只把邀请标成已处理 —— 否则用户看到邀请消失、点进库却没有权限，两边都不报错）')
  const r6 = await req('POST', `/api/invites/${invId}/respond`, { accept: true }, tok2)
  ok(r6.status === 400, '同一条邀请不能处理第二次', 'status=' + r6.status)

  /* ---- 拒绝 ---- */
  const u4 = others[2]
  if (u4) {
    const t4 = await login(u4.account)
    if (t4) {
      const ri = await req('POST', `/api/books/${bookId}/invites`, { userId: u4.id }, admin)
      const rr = await req('POST', `/api/invites/${ri.json.inviteId}/respond`, { accept: false }, t4)
      ok(rr.status === 200 && rr.json.status === 'declined', '拒绝成功')
      ok(roleOf(bookId, u4.id) === null, '拒绝后**没有**变成成员（否则「拒绝」就是个假动作）')
      const again = await req('POST', `/api/books/${bookId}/invites`, { userId: u4.id }, admin)
      ok(again.status === 200 && again.json.alreadySent === false,
        '**拒绝之后还能再邀请**（整表唯一索引会让这条正常路径直接失败）')
    }
  }

  /* ---- 撤回 ---- */
  const u5 = others[3] || others[others.length - 1]
  if (u5) {
    const ri1 = await req('POST', `/api/books/${bookId}/invites`, { userId: u5.id }, admin)
    const rv1 = await req('DELETE', `/api/invites/${ri1.json.inviteId}`, null, admin)
    ok(rv1.status === 200 && rv1.json.status === 'revoked', '**邀请人本人**可以撤回', JSON.stringify(rv1.json))

    // ⚠️ 第三方（非邀请人、非本库管理员）撤不了 —— 403 才是对的。
    //    别用「还没接受邀请的被邀请人」来测这条：他还不是成员，
    //    capsInBook 返回 NONE，403 并不说明任何东西。
    const u6 = others.find((x) => x.id !== u5.id)
    if (u6) {
      const t6 = await login(u6.account)
      const ri2 = await req('POST', `/api/books/${bookId}/invites`, { userId: u5.id }, admin)
      const rv2 = await req('DELETE', `/api/invites/${ri2.json.inviteId}`, null, t6)
      ok(rv2.status === 403,
        '**无关的第三方撤不了**（他既不是邀请人也不是本库管理员）', 'status=' + rv2.status)
      await req('DELETE', `/api/invites/${ri2.json.inviteId}`, null, admin)
    }
  }

  /* ---- 边界 ---- */
  const rSelf = await req('POST', `/api/books/${bookId}/invites`, { userId: meId }, admin)
  ok(rSelf.status === 400 && /自己/.test(rSelf.raw), '不能邀请自己', rSelf.raw.slice(0, 50))
  const rRole = await req('POST', `/api/books/${bookId}/invites`, { userId: u2.id, role: 'admin' }, admin)
  ok(rRole.status === 400, '角色只能是阅读者/编辑者（不能直接发管理员）', 'status=' + rRole.status)
  const rNoAuth = await req('POST', `/api/books/${bookId}/invites`, { userId: u2.id })
  ok(rNoAuth.status === 401, '未登录不能发邀请', 'status=' + rNoAuth.status)
  const rNoBook = await req('POST', '/api/books/__nope__/invites', { userId: u2.id }, admin)
  ok(rNoBook.status !== 200, '不存在的知识库发不出邀请', 'status=' + rNoBook.status)
}

/* ---- 送达边界：不做邮件，就别声称发了邮件 ---- */
{
  const fs2 = await import('node:fs')
  const code = fs2.readFileSync('server/index.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  console.log('\n== 送达方式：不吹牛 ==')
  ok(!/smtp|sendmail|nodemailer|邮件已发送|已发送邮件/i.test(code),
    '服务端**没有**「已发邮件」这类声称（本项目没有 SMTP —— 假通知比没通知更糟）')
  ok(/GET.*\/api\/invites/.test(code.replace(/\n/g, ' ')) || /'\/api\/invites'/.test(code),
    '有待办列表接口（站内送达是真的）')
  const audit = fs2.readFileSync('server/audit.ts', 'utf8')
  for (const k of ['bookInviteSend', 'bookInviteAccept', 'bookInviteDecline', 'bookInviteRevoke']) {
    ok(audit.includes(k), `审计里有 ${k}（出事时第一句要问的是「谁把他拉进来的 / 他什么时候同意的」）`)
  }
}

stop()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
