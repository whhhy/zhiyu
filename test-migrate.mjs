/* ============================================================
   引导两个最容易在部署时踩空的地方
   ------------------------------------------------------------
   一、老库补列
   建表语句全是 CREATE TABLE IF NOT EXISTS —— 这句话对**已存在**的表什么也不做，
   所以后加的列不会自动出现在老库里，于是「开发用新库一切正常、
   部署到公司老库第一次访问那一列时炸 no such column」，
   而且往往炸在很久之后某个不相关的请求上，很难往「升级」上想。

   二、YQ_DEMO=0 的全新库
   「正式部署不要演示数据」是最正常的诉求。照字面实现（一个空间都不建）
   会得到一个**不能用的系统**：管理员登录后一片空白，
   而前端没有新建空间的入口，没有任何办法往前走。
   ============================================================ */

import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.MIGRATE_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_migrate-${Date.now().toString(36)}.db`
const blankFiles = []

const cols = (p) => (new DatabaseSync(p)).prepare('PRAGMA table_info(users)').all().map((c) => c.name)
const bookSettingCols = (p) => (new DatabaseSync(p)).prepare('PRAGMA table_info(book_settings)').all().map((c) => c.name)

/** 起一次服务端，等它起来就杀掉。返回是否成功启动。 */
async function bootOnce() {
  const kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), YQ_DB: DB, YQ_ADMIN_PASSWORD: 'migrate@2026', YQ_DEMO: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  kid.stderr.on('data', (d) => { err += String(d) })
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
  }
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 800))
  return { up, err }
}

/** 同上，但把 stdout 也收下来 —— 启动自检的告警打在 stdout */
async function bootOnce2() {
  const kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), YQ_DB: DB, YQ_ADMIN_PASSWORD: 'migrate@2026', YQ_DEMO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = '', err = ''
  kid.stdout.on('data', (d) => { out += String(d) })
  kid.stderr.on('data', (d) => { err += String(d) })
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
  }
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 800))
  return { up, out, err }
}

try {
  // 造一个「跑过旧版本」的库：users 表故意没有 viaSso
  const db = new DatabaseSync(DB)
  db.exec(`CREATE TABLE users (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    account   TEXT NOT NULL UNIQUE,
    email     TEXT,
    avatar    TEXT DEFAULT '',
    passHash  TEXT NOT NULL,
    passSalt  TEXT NOT NULL,
    role      TEXT NOT NULL DEFAULT 'member',
    createdAt INTEGER NOT NULL
  )`)
  db.prepare('INSERT INTO users (id,name,account,passHash,passSalt,role,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run('u_old', '老账号', 'olduser', 'hash', 'salt', 'owner', 1)
  db.close()
  ok(!cols(DB).includes('viaSso'), '旧库造好了：users 表里确实没有 viaSso')

  const first = await bootOnce()
  ok(first.up, '服务端能在缺列的老库上正常启动', first.err.split('\n').slice(0, 3).join(' | '))
  ok(cols(DB).includes('viaSso'), '启动后 viaSso 列被补上')

  const second = await bootOnce()
  ok(second.up, '第二次启动也正常（补列是幂等的，不能第二次就炸）', second.err.split('\n').slice(0, 3).join(' | '))
  ok(cols(DB).includes('viaSso'), '重复补列没有把列搞坏')

  // 老数据不该被改动 —— 补列带了 DEFAULT 0，语义上是「不是统一认证开的户」
  const after = new DatabaseSync(DB)
  const row = after.prepare('SELECT id, account, role, viaSso FROM users WHERE id = ?').get('u_old')
  after.close()
  ok(row?.account === 'olduser' && row?.role === 'owner', '老数据原样保留', JSON.stringify(row))
  ok(Number(row?.viaSso) === 0, '老账号的 viaSso 为 0（不会被误判成统一认证开的户）', String(row?.viaSso))

  /* ---------- 后加的设置列也必须补上 ---------- */
  console.log('\n== 知识库设置：后加的列同样要补 ==')
  /**
   * 原来这里只盯 users 表，于是漏了一类：
   * **先建好表、之后才加列**的字段，一样不会出现在老库里 ——
   * `CREATE TABLE IF NOT EXISTS` 对已存在的表什么也不做。
   *
   * 实测踩到过：给 book_settings 加了搜索关键词屏蔽（blockSearch / blockTerms），
   * 没补迁移。老库升级后：
   *   · 保存知识库设置 → `no such column: blockSearch`
   *   · 搜索时读屏蔽词 → `no such column: blockSearch`
   * 报的是 500，而触发它的是「改一下设置」这种日常操作，
   * 报错里**一个字都没提升级**，基本不可能往版本问题上想。
   */
  {
    // 先把一个「早于搜索屏蔽」的 book_settings 塞进老库
    // book_settings.bookId 有外键指向 books，所以 books 也得先有 —— 否则插不进去，
    // 一看就是「造老库造错了」，不是被测代码的问题
    const pre = new DatabaseSync(DB)
    /**
     * 前面的 bootOnce 已经跑过 seed：spaces / books 早就是**真实结构**了，
     * 而 book_settings 也已经是**新结构**（带 blockSearch）。
     * 所以光 `CREATE TABLE IF NOT EXISTS` 造不出「缺列的老表」——
     * 那张表已经存在，这句是空操作，测出来永远是「新结构缺列不存在」。
     * 必须先 DROP 再按老结构重建。
     */
    pre.exec('PRAGMA foreign_keys = OFF')
    pre.exec('DROP TABLE IF EXISTS book_settings')
    pre.exec(`CREATE TABLE book_settings (
      bookId            TEXT PRIMARY KEY,
      restrictExport    INTEGER NOT NULL DEFAULT 0,
      watermark         INTEGER NOT NULL DEFAULT 0,
      watermarkText     TEXT DEFAULT '',
      ipWhitelist       INTEGER NOT NULL DEFAULT 0,
      ipList            TEXT DEFAULT '[]',
      autoRevoke        INTEGER NOT NULL DEFAULT 1,
      publicAccess      INTEGER NOT NULL DEFAULT 0,
      defaultWidth      TEXT DEFAULT 'standard',
      defaultVisibility TEXT DEFAULT 'space'
      /* ⚠️ 刻意**没有** newDocPosition —— 这就是「早于 2026-10-11」的老结构。
         下面要验的正是：老库升级时这一列会被补上，且存量行拿到正确默认值。 */
    )`)
    pre.prepare('INSERT OR REPLACE INTO book_settings (bookId) VALUES (?)').run('b_old')
    pre.close()
    const before = bookSettingCols(DB)
    ok(before.includes('autoRevoke') && !before.includes('blockSearch'),
      '老库的 book_settings 有旧列、没有 blockSearch', before.join(','))

    const third = await bootOnce()
    ok(third.up, '老库上照样能起来', third.err.split('\n').slice(0, 3).join(' | '))

    const afterCols = bookSettingCols(DB)
    ok(afterCols.includes('blockSearch'), 'blockSearch 被补上了', afterCols.join(','))
    ok(afterCols.includes('blockTerms'), 'blockTerms 被补上了')

    // 关键：光「列在」不够，得确认新列**真的能写** ——
    // 列补了但类型/约束不对，写的时候照样炸。
    const chk = new DatabaseSync(DB)
    let wrote = true, err = ''
    try { chk.prepare('UPDATE book_settings SET blockSearch = 1, blockTerms = ? WHERE bookId = ?').run('["薪酬"]', 'b_old') } catch (e) { wrote = false; err = e.message }
    const r2 = chk.prepare('SELECT blockSearch, blockTerms FROM book_settings WHERE bookId = ?').get('b_old')
    chk.close()
    ok(wrote, '补完之后真的能写这两列（光有列名不够）', err)
    ok(Number(r2?.blockSearch) === 1 && String(r2?.blockTerms || '').includes('薪酬'), '写进去的值读得回来', JSON.stringify(r2))

    // 存量行不能被「补列」顺手改掉：老库升级不该突然开始屏蔽搜索
    const def = new DatabaseSync(DB)
    def.prepare('INSERT OR REPLACE INTO book_settings (bookId) VALUES (?)').run('b_def')
    const dr = def.prepare('SELECT blockSearch FROM book_settings WHERE bookId = ?').get('b_def')
    def.close()
    ok(Number(dr?.blockSearch) === 0, '存量行的 blockSearch 默认是 0（升级不会让老实例突然开始屏蔽）', String(dr?.blockSearch))

    /* ---------- 2026-10-11：newDocPosition 与 book_invites ---------- */
    /*
     * 写法照上面那段：列补上之后**还要真的能写**，而且存量行拿到的是
     * **正确的默认值**（不是 NULL、不是空串）。
     * 拿到 NULL 的话，新文档落点那条逻辑会退化成「不是 bottom 就当 top」，
     * 看起来对，其实所有判断都没了 —— 而界面上一条红字都不会有。
     */
    ok(afterCols.includes('newDocPosition'),
      '**newDocPosition** 被补上了（2026-10-11 加的列，老库升级必须补）')

    const w = new DatabaseSync(DB)
    let werr = ''
    try { w.prepare('UPDATE book_settings SET newDocPosition = ? WHERE bookId = ?').run('bottom', 'b_old') } catch (e) { werr = e.message }
    const r3 = w.prepare('SELECT newDocPosition FROM book_settings WHERE bookId = ?').get('b_old')
    w.close()
    ok(!werr && r3?.newDocPosition === 'bottom', '补完之后真的能写这一列（光有列名不够）', werr)

    const dflt = new DatabaseSync(DB, { readOnly: true })
    const dr3 = dflt.prepare('SELECT newDocPosition FROM book_settings WHERE bookId = ?').get('b_def')
    dflt.close()
    ok(dr3?.newDocPosition === 'top',
      '**存量行的默认值是 top**（不是 NULL —— 那样所有判断都会退化成「不是 bottom 就当 top」）',
      String(dr3?.newDocPosition))

    /* ---- book_invites：表 + 部分唯一索引 ---- */
    {
      const d2 = new DatabaseSync(DB, { readOnly: true })
      ok(!!d2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='book_invites'").get(),
        '老库升级后 book_invites 表也建出来了')

      /*
       * ⚠️ 这一条最容易漏：表是 CREATE TABLE IF NOT EXISTS 建的（老库也会建），
       *    而**部分唯一索引**是单独一句。
       *    老库上漏了它，症状**不是报错** —— 是「同一个人能在待办里看到
       *    两条一样的邀请」。属于「测试全绿、产品悄悄坏掉」那一类。
       */
      const i2 = d2.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_inv_pending'").get()
      ok(!!i2 && /WHERE\s+status\s*=\s*'pending'/i.test(i2.sql || ''),
        '**部分唯一索引**在老库上也建上了（漏了它 = 同一个人看到两条一样的待办）',
        i2 ? String(i2.sql).replace(/\s+/g, ' ') : '没有')
      d2.close()

      // 索引真的在去重吗 —— 不能只看它「存在」，存在但不生效更糟
      const bk = new DatabaseSync(DB, { readOnly: true })
      const b = bk.prepare('SELECT id FROM books LIMIT 1').get()
      const who = bk.prepare("SELECT id FROM users WHERE account <> 'admin' LIMIT 1").get()
      bk.close()
      if (b && who) {
        let dupBlocked = false
        const w2 = new DatabaseSync(DB)
        try {
          w2.prepare('DELETE FROM book_invites').run()
          const i3 = w2.prepare("INSERT INTO book_invites (id,bookId,toUserId,fromUserId,role,status,createdAt) VALUES (?,?,?,?,?,?,?)")
          i3.run('mig_a', String(b.id), String(who.id), 'x', 'reader', 'pending', Date.now())
          i3.run('mig_b', String(b.id), String(who.id), 'x', 'editor', 'pending', Date.now())
        } catch { dupBlocked = true }
        w2.close()
        ok(dupBlocked, '部分唯一索引**真的在去重**（不是只存在）')
        const cl = new DatabaseSync(DB)
        cl.prepare('DELETE FROM book_invites').run()
        cl.close()
      }
    }
  }

  /* ---------- 启动自检：缺列要喊出来 ---------- */
  console.log('\n== 启动自检：缺列不能只表现为 500 ==')
  /**
   * 上面那些补列是**已经修好**的，所以自检在该沉默的时候是沉默的。
   * 这里造一个**没有迁移兜底**的缺列（删掉 docs.wordCount），
   * 看自检会不会在启动日志里点出来 ——
   * 没有迁移兜底的缺列，表现就是「某天某个不相关的请求突然 500，
   * 而且报错是 no such column，触发它的操作和版本毫无关系」。
   */
  {
    const db = new DatabaseSync(DB)
    db.exec('PRAGMA foreign_keys = OFF')
    let dropped = true
    try { db.exec('ALTER TABLE docs DROP COLUMN wordCount') } catch { dropped = false }
    db.close()
    if (dropped) {
      const boot = await bootOnce2()
      ok(boot.up, '缺列的老库照样能起来（自检只是喊，不拦启动 —— 拦了老实例直接没法用）',
        boot.err.split('\n').slice(0, 2).join(' | '))
      ok(/缺列/.test(boot.out) && /docs\.wordCount/.test(boot.out),
        '启动日志里明确点出了缺哪一列（`no such column` 不再是三个月后从 500 里倒推出来的）',
        boot.out.split('\n').filter((l) => l.includes('缺列') || l.includes('wordCount')).join(' | ') || boot.out.slice(-200))
    } else {
      ok(false, '这个 SQLite 不支持 DROP COLUMN，跳过自检用例（不影响其余断言）')
    }
  }

  /* ---------- 关掉演示数据后，必须还能起步 ---------- */
  console.log('\n== YQ_DEMO=0 的全新库：管理员得有个落笔的地方 ==')
  /**
   * 「正式部署不要演示数据」是最正常的诉求。
   * 以前 seed 里是 `if (!opts.demo) return report` —— 零个空间、零个知识库，
   * 而前端**没有新建空间的入口**（spaces 是只读的，没有任何 create action）。
   * 于是管理员登录后看到一片空白，且没有任何办法往前走：
   * 照字面实现「关掉演示数据」，结果是得到一个不能用的系统。
   */
  const blankPort = process.env.MIGRATE_BLANK_PORT || await freePort()
  const blankDB = `data/_blank-${Date.now().toString(36)}.db`
  const blankBase = `http://localhost:${blankPort}`
  const startBlank = () => {
    const k = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
      env: { ...process.env, PORT: blankPort, YQ_DB: blankDB, YQ_ADMIN_PASSWORD: 'migrate@2026', YQ_DEMO: '0' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return k
  }
  let bk = startBlank()
  for (const s of ['', '-wal', '-shm']) blankFiles.push(blankDB + s)
  let upBlank = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${blankBase}/api/health`)).ok) { upBlank = true; break } } catch { /* 等 */ }
  }
  ok(upBlank, 'YQ_DEMO=0 的服务能起来')
  if (upBlank) {
    const lr = await fetch(`${blankBase}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: 'migrate@2026' }),
    })
    const lt = (await lr.json()).token
    const boot = await (await fetch(`${blankBase}/api/bootstrap?lite=0`, { headers: { Authorization: 'Bearer ' + lt } })).json()
    const spaces = boot.data.spaces || []
    ok(spaces.length === 1, '管理员有一个个人空间（不是零）', `实际 ${spaces.length} 个`)
    ok(
      spaces[0]?.kind === 'personal' && spaces[0]?.name?.includes('管理员'),
      '这个空间是给管理员的个人空间',
      JSON.stringify(spaces[0]).slice(0, 120),
    )
    const books = boot.data.books || []
    const docs = boot.data.docs || []
    ok(books.length === 0 && docs.length === 0, '演示内容一条也没有（关掉演示数据是真关了）', `${books.length} 库 / ${docs.length} 篇`)
  }
  try { bk.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 500))
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) { try { rmSync(DB + s) } catch { /* 删不掉就算了 */ } }
  for (const f of blankFiles) if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
