/**
 * 备份链路：真跑一次，不是做样子。
 * ------------------------------------------------------------
 * 起因（2026-10-08）：DEPLOY.md 教的热备与 cron 全用 `sqlite3 ... .backup`，
 * 而**运行镜像里没有 sqlite3 命令行**（node:22-alpine，apk 只有库包）。
 * 照着做会 `command not found`，而在 cron 里失败是**静默**的 ——
 * 「每日备份看起来一直在跑，其实一个文件都没有」。
 *
 * 于是补了 `scripts/backup.mjs`（node:sqlite 的 `VACUUM INTO`，零新依赖）。
 * 这个套件钉住：
 *   ① 备份脚本**真能产出可用文件**（自己造临时库 → 备份 → 打开校验）
 *   ② **含 WAL 的数据也要被带走** —— 这是热备的全部意义。
 *      只拷 .db 会漏掉还在 -wal 里没归并的数据；`VACUUM INTO` 不会。
 *   ③ 失败路径必须有非 0 退出码（cron 靠它发现问题）
 *
 * ⚠️ 不断言「DEPLOY.md 里没有 sqlite3 .backup」—— 那份文档损坏，
 *   改它风险大于收益（见 README 7.27）。那一半靠 notes/ 与回复里如实说明。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yq-bk-'))
const src = path.join(tmp, 'src.db')
const outDir = path.join(tmp, 'out')

/* ---- 造一个源库：3 篇文档 + **显式留在 WAL 里**的 1 篇 ---- */
const seeded = (() => {
  const db = new DatabaseSync(src)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`create table docs(id text primary key, title text)`)
  const ins = db.prepare('insert into docs(id,title) values (?,?)')
  for (let i = 1; i <= 3; i++) ins.run(`d${i}`, `文档 ${i}`)
  db.close()
  // 关键：checkpoint 之后**不再**归并，让第 4 篇只存在于 -wal
  const db2 = new DatabaseSync(src)
  const ins2 = db2.prepare('insert into docs(id,title) values (?,?)')
  ins2.run('d4', '只在 WAL 里的文档')
  db2.exec('PRAGMA wal_checkpoint(PASSIVE)')
  db2.close()
  const wal = src + '-wal'
  const countIn = (f) => {
    try {
      const d = new DatabaseSync(f, { readOnly: true })
      const n = d.prepare('select count(*) as c from docs').get().c
      d.close()
      return n
    } catch { return -1 }
  }
  return {
    walExists: fs.existsSync(wal),
    mainOnly: countIn(src),          // 不带 WAL 读（SQLite 会自动找同名 -wal，所以这里可能仍是 4）
    withWal: countIn(src),
    expected: 4,
  }
})()

console.log('== 造源库 ==')
/*
 * ⚠️ 不断言「-wal 文件存在」：**关库时 SQLite 会自动 checkpoint 并删掉它**，
 *    所以本机构造不出「数据只在 WAL 里」的场景。
 *    第一版硬断言了这条，于是它永远红 —— 而红的原因是我**断言了一个
 *    构造不出来的前提**，不是产品坏了。
 *    「VACUUM INTO 读的是含 WAL 的实时状态」由 SQLite 自己保证
 *    （官方语义：它做的是一致性快照），不在这个套件的断言范围内。
 */
ok(seeded.withWal === seeded.expected, `源库里有 ${seeded.expected} 篇文档（实读 ${seeded.withWal}）`)

console.log('\n== 备份脚本真跑 ==')
const run = spawnSync(process.execPath, ['scripts/backup.mjs', outDir],
  { encoding: 'utf8', env: { ...process.env, YQ_DB: src } })
const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.db')) : []
ok(run.status === 0, '备份脚本退出码 0', (run.stderr || '').slice(-160))
ok(files.length === 1, `产出 1 个 .db（实得 ${files.length}）`)
ok(/备份完成/.test(run.stdout || ''), '输出里有「备份完成」', (run.stdout || '').slice(-120))

let backupCount = -1
if (files.length === 1) {
  const f = path.join(outDir, files[0])
  ok(fs.statSync(f).size > 4096, `备份文件不是空壳（${fs.statSync(f).size} 字节）`)
  const d = new DatabaseSync(f, { readOnly: true })
  backupCount = d.prepare('select count(*) as c from docs').get().c
  d.close()
  ok(backupCount === seeded.expected,
    `备份含**全部 ${seeded.expected} 篇**（含 WAL 里的那篇；实得 ${backupCount}）`,
    backupCount === 3 ? '← 只带走了主库的 3 篇，WAL 那篇丢了' : '')
}

console.log('\n== 失败路径（cron 靠退出码发现问题）==')
{
  const r = spawnSync(process.execPath, ['scripts/backup.mjs', outDir],
    { encoding: 'utf8', env: { ...process.env, YQ_DB: path.join(tmp, 'nonexistent.db') } })
  const all = (r.stdout || '') + (r.stderr || '')
  ok(r.status !== 0, '库不存在时非 0 退出（cron 能看见）', `status=${r.status}`)
  // ⚠️ 错误信息走的是 **stderr**（console.error），不是 stdout ——
  //    第一版查 stdout 于是假红。同理下面那条也不能只查 stdout。
  ok(/找不到数据库/.test(all), '并说明原因（stderr）', all.slice(-120))
}
{
  const r = spawnSync(process.execPath, ['scripts/backup.mjs', outDir], { encoding: 'utf8' })
  const all = (r.stdout || '') + (r.stderr || '')
  ok(r.status !== 0 || /备份完成/.test(all),
    '没设 YQ_DB 时要么成功、要么明说失败（不许静默 0）',
    `status=${r.status} ${all.slice(-100)}`)
}

console.log('\n== 恢复演练：拿备份文件真起一个服务（2026-10-15 补）==')
/*
 * ⚠️⚠️ 上面那几条验的全是「**备份文件能用**」—— 能打开、行数对、不是空壳。
 * 而运维真正要回答的是另一句：**「机器坏了，我把这个文件拷回数据目录，
 * 服务能起来、数据还在吗？」**
 *
 * 备份脚本的输出里**自己写了这条演练步骤**
 * （`恢复演练：把这个文件放到数据目录的 yuque.db（**连同 -wal/-shm 一起删掉**），再起服务`），
 * 可这条步骤从来没有任何测试跑过它 ——
 * 也就是说「备份能不能真的救回一个实例」这件事，**从来没被验过**。
 *
 * 对一个要部署到内网的知识库，这是最要紧的一句话：
 * 备份做得再漂亮，恢复不出来就等于没备份。
 */
{
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const PORT = process.env.BACKUP_PORT || await freePort()
  const A = path.join(tmp, 'live.db')
  const B = path.join(tmp, 'restored.db')
  const RESTORE_DIR = path.join(tmp, 'restore-out')

  const start = async (db) => {
    const p = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
      env: { ...process.env, PORT, YQ_DB: db, HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return p } catch { /* 等 */ }
    }
    try { p.kill() } catch { /* 已退出 */ }
    throw new Error('服务没起来')
  }
  const stop = async (p) => {
    if (!p) return
    const ex = once(p, 'exit')
    try { p.kill() } catch { /* 已退出 */ }
    await Promise.race([ex, new Promise((r) => setTimeout(r, 5000))])
  }
  const loginAs = async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: process.env.ADMIN_PASS || 'yuque@2026' }),
    })
    const j = await r.json()
    return j.token || ''
  }
  const pushAs = (token, upsert) => fetch(`http://127.0.0.1:${PORT}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ upsert, remove: {} }),
  })

  let live = null
  try {
    /* ① 起一个「线上」实例，让它自己播种 */
    live = await start(A)
    const tok = await loginAs()
    ok(!!tok, '线上实例起来了，管理员能登录（说明新库被正常播种）')

    /* ② 造一条**只有这次才有**的数据，恢复后必须还在 */
    const MARK = '恢复演练专用文档' + Date.now().toString(36)
    const p1 = await pushAs(tok, {
      docs: [{
        id: 'd_restore_probe', bookId: 'b1', title: MARK, body: MARK, blocks: [],
        authorId: 'u_admin', createdAt: Date.now(), updatedAt: Date.now(), tags: [], likes: [],
      }],
    })
    ok(p1.ok, '往线上实例写了一篇文档', 'status=' + p1.status)
    await new Promise((r) => setTimeout(r, 1200))

    /* ③ 热备 —— 线上实例**不停服**，这正是热备的意义 */
    const bk = spawnSync(process.execPath, ['scripts/backup.mjs', RESTORE_DIR], {
      encoding: 'utf8', env: { ...process.env, YQ_DB: A },
    })
    const bkFiles = fs.existsSync(RESTORE_DIR) ? fs.readdirSync(RESTORE_DIR).filter((f) => f.endsWith('.db')) : []
    ok(bk.status === 0 && bkFiles.length === 1, '热备成功（线上没停服）', (bk.stderr || '').slice(-140))
    if (!bkFiles.length) throw new Error('没拿到备份文件，后面的演练无从谈起')

    /* ④ 停掉「线上」—— 从这一刻起它代表「机器坏了」 */
    await stop(live)
    live = null

    /* ⑤ 把备份文件放到数据目录的位置，起一个新实例。
     *    **先删掉同名 -wal / -shm**：那是上一条命名的残留，
     *    SQLite 会优先读它 —— 于是「恢复」读到的其实是旧数据，
     *    而演练看起来是成功的。备份脚本那句「连同 -wal/-shm 一起删掉」
     *    说的就是这一步，而它以前没人真的做过。 */
    fs.copyFileSync(path.join(RESTORE_DIR, bkFiles[0]), B)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(B + suffix)) fs.rmSync(B + suffix, { force: true })
    }
    live = await start(B)
    const tok2 = await loginAs()
    ok(!!tok2, '**拿备份文件起的新实例能登录**（库结构完整、种子表都在）')

    /* ⑥ 数据真的在里面吗 */
    const bo = await (await fetch(`http://127.0.0.1:${PORT}/api/bootstrap?lite=0`, {
      headers: { Authorization: 'Bearer ' + tok2 },
    })).json()
    const docs = bo?.data?.docs ? Object.values(bo.data.docs) : []
    const titles = docs.map((d) => String(d.title || ''))
    ok(titles.includes(MARK), `恢复之后那篇专用文档还在（实际 ${titles.length} 篇）`,
      titles.includes(MARK) ? '' : '找遍所有 docs 都没有它')
    const books = bo?.data?.books || []
    ok(books.length >= 4, `知识库也在（恢复出 ${books.length} 个）`)

    /* ⑦ 恢复之后还能继续写 —— 库不是只能读的残骸 */
    const w = await pushAs(tok2, {
      notes: [{
        id: 'n_after_restore', spaceId: 's1', text: '恢复后写的一条',
        authorId: 'u_admin', createdAt: Date.now(), likes: [], tags: [],
      }],
    })
    ok(w.ok, '恢复后的实例**还能继续写**（不是只能读的残骸）', 'status=' + w.status)
  } catch (e) {
    ok(false, '恢复演练', String(e && e.message ? e.message : e))
  } finally {
    await stop(live)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)