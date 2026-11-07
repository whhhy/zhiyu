/**
 * 附件卡的文案不许在服务端形态下说假话
 * ============================================================
 * 这一类的「假」不产生任何报错：
 * 服务端照常存取附件、UI 照常渲染，只有一行小字在骗人 ——
 *
 *   「二进制存 IndexedDB，文档里只留元信息」
 *   「⚡ 二进制在 IndexedDB（xxxx…）」
 *   「附件二进制已丢失。可能清过浏览器数据，请重新选择文件。」
 *
 * 而**本项目主推的就是内网服务端部署**：部署之后二进制其实在
 * `attachments.data`（SQLite BLOB）里，每张附件卡下面却在说
 * 「你的附件在浏览器里」。
 *
 * 第三句更糟：它不只是过时，而是**把排查方向指错** ——
 * 服务端形态下**清浏览器数据并不会让附件丢**（它在库里），
 * 而真丢了通常是数据库被换过、或数据是从别处迁来的。
 * 照那句话去清浏览器数据，损失时间且修不好。
 *
 * ------------------------------------------------------------
 * 为什么之前没有任何套件拦住
 * ------------------------------------------------------------
 * 查过了：卡片那几个套件（test-attachment / test-attachmentdel /
 * test-lint）验的是**二进制有没有真存取、删除有没有真回收**，
 * 没有人查**这些字**。
 *
 * 而「没报错」「数据都对」和「界面在说假话」在测试里长得一模一样 ——
 * 这正是本项目记过十几次的那条：**否定式断言证明不了任何事**。
 *
 * 测法：真起一个服务端，把「服务端确实把二进制存 BLOB」这件事
 * 与「文案按形态分叉」这两件事**并排验** ——
 * 前者是真的，后者在代码里出现，前者就不能靠这句话搪塞过去。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CARD = 'src/components/cards'

/* ═══════════ 1. 服务端确实把二进制存 BLOB（这是「真话」那一半） ═══════════ */
console.log('\n== 服务端真的把二进制存 BLOB（文案不能凭空说）==')
const DB = 'data/_cardtext-test.db'
let serverUp = false
{
  const db = readFileSync('server/db.ts', 'utf8')
  const i = db.indexOf('CREATE TABLE IF NOT EXISTS attachments')
  ok(i >= 0, '有 attachments 表')
  ok(/data\s+BLOB/.test(db.slice(i, i + 400)), '二进制列确实是 BLOB')

  // 真起一个服务，上传一个附件，看它是不是真的进了 BLOB
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
  const PORT = process.env.CARDTEXT_PORT || await freePort()
  const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'ct@2026' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  process.on('exit', () => { try { srv.kill() } catch { /* ignore */ } })
  for (let i = 0; i < 50; i++) {
    await sleep(400)
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { serverUp = true; break } } catch { /* 等 */ }
  }
  ok(serverUp, '服务端起来了')

  if (serverUp) {
    const call = async (p, o = {}) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, o)
      const t = await r.text()
      try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
    }
    const ses = (p, o = {}, tk) => call(p, {
      ...o,
      headers: { 'Content-Type': 'application/json', ...(o.headers || {}), ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
    })
    const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'ct@2026' }) })).d?.token
    const bk = (await ses('/api/entity/books', {}, tok)).d.rows[0]
    const doc = (await ses('/api/entity/docs', {}, tok)).d.rows[0]

    // 上传：multipart 太麻烦，直接用 base64 字段（看接口收什么）
    const up = await call(`/api/attachment?docId=${doc.id}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ name: '说明.txt', type: 'text/plain', data: Buffer.from('二进制在这里面').toString('base64') }),
    })
    if (up.status === 200 && up.d?.id) {
      const d = new DatabaseSync(DB)
      const row = d.prepare('SELECT LENGTH(data) AS n FROM attachments WHERE id = ?').get(up.d.id)
      d.close()
      ok(Number(row?.n) > 0, `上传后库里真的有 ${row?.n} 字节 BLOB —— 「在服务端数据库」是事实，不是文案`)
    } else {
      // 接口形状和我猜的不一样也别硬编：把实际返回打出来，如实记录
      ok(false, '上传接口形状与预期不同，如实记录', `HTTP ${up.status} ${JSON.stringify(up.d).slice(0, 90)}`)
    }
  }
  srv.kill()
}

/* ═══════════ 2. 文案必须按形态分叉（这是「不能撒谎」那一半） ═══════════ */
console.log('\n== 文案按形态分叉 ==')
{
  for (const f of ['FileCard.tsx', 'LocalMedia.tsx']) {
    const src = readFileSync(`${CARD}/${f}`, 'utf8')
    // 判据搬进 attachment-store 之后，这里**不该**再出现 getMode 模式
    ok(/serverMode\s*=\s*useServer\(\)/.test(src), `${f} 的 serverMode 来自 useServer()`)
    ok(!/getMode\(\) === 'server'/.test(src), `${f} 没有自己再抄一遍判据`)

    // 写死的「在 IndexedDB」——注释、判据、以及**三元里的本地分支**都允许
    // （`useServer() ? '服务端数据库' : ' IndexedDB'` 里的 IndexedDB 是对的）
    const bad = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => {
        const t = l.trim()
        if (!/IndexedDB/.test(t)) return false
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/**')) return false
        if (/^\{\s*\/\*/.test(t) || /^\/\*\*/.test(t)) return false
        if (/useServer\(\)\s*\?/.test(l)) return false      // 三元分叉（含本地分支）
        if (/serverMode\s*\?/.test(l)) return false          // 同上，只是变量名不同
        if (/getMode\(\)/.test(l)) return false
        if (/\*\//.test(t) && t.length > 60) return false  // 行尾注释里提到
        return true
      })
    ok(bad.length === 0, `${f} 没有硬写的「在 IndexedDB」`, bad.map(([i, l]) => `行${i}: ${l.trim().slice(0, 50)}`).join(' | '))
  }

  const common = readFileSync(`${CARD}/common.tsx`, 'utf8')
  ok(/export const ATTACHMENT_HINT/.test(common), 'common.tsx 仍导出 ATTACHMENT_HINT')
  const hintSeg = /export const ATTACHMENT_HINT[\s\S]{0,320}/.exec(common)?.[0] || ''
  ok(/useServer\(\)/.test(hintSeg), 'ATTACHMENT_HINT 自己也按形态分叉')
  ok(/随文件级备份一起迁移/.test(hintSeg), '服务端形态下说明了「随备份走」—— 这正是内网迁移最关心的一句')
  ok(/IndexedDB，容量取决于浏览器配额/.test(hintSeg), '本地形态仍保留原来的说法')

  // 「可能清过浏览器数据」在服务端形态下是把排查方向指错
  for (const f of ['FileCard.tsx', 'LocalMedia.tsx']) {
    const src = readFileSync(`${CARD}/${f}`, 'utf8')
    const lost = /附件二进制已丢失[\s\S]{0,300}/.exec(src)?.[0] || ''
    ok(/serverMode/.test(lost), `${f}「二进制已丢失」那段按形态分了原因`)
    ok(/数据库被换过|从别处迁来/.test(lost), `${f} 服务端形态下说了真实原因（库被换过 / 从别处迁来）`)
  }
}

/* ═══════════ 3. 判据必须统一，不能各处抄一遍 ═══════════ */
console.log('\n== 判据统一从 attachment-store 取 ==')
{
  // 这一条是这轮新加的防线：上一轮我在三个文件里各写了一遍
  // `getMode() === 'server' && isAuthed()`，**当场就漏了两处**
  // （DocPage 的复制摘要、common 的选择器提示）。
  // 散着写的判据就是这样：漏一处不会有人告诉你。
  const store = readFileSync('src/lib/attachment-store.ts', 'utf8')
  ok(/export function useServer\(\)/.test(store), 'attachment-store 导出了 useServer')
  ok(/export function binaryWhere\(\)/.test(store), '还导出了 binaryWhere（纯文案用）')

  // 界面各处**不许**自己再抄一遍判据
  for (const f of [`${CARD}/FileCard.tsx`, `${CARD}/LocalMedia.tsx`, `${CARD}/common.tsx`, 'src/pages/DocPage.tsx']) {
    const src = readFileSync(f, 'utf8')
    const copies = src.split('\n').filter((l) =>
      !l.trim().startsWith('*') && !l.trim().startsWith('//') &&
      /getMode\(\)\s*===\s*'server'/.test(l) && !/attachment-store/.test(l),
    )
    ok(copies.length === 0, `${f} 没有自己抄一遍判据`, copies.join(' | ').slice(0, 90))
  }

  // DocPage 的复制摘要也不能漏 —— 那行会被复制出去给同事看
  const dp = readFileSync('src/pages/DocPage.tsx', 'utf8')
  const bt = /const where = d\.key[\s\S]{0,160}/.exec(dp)?.[0] || ''
  ok(/binaryWhere\(\)/.test(bt), 'DocPage 的复制摘要用了 binaryWhere()', bt.slice(0, 80))
  ok(!/· IndexedDB/.test(bt.replace(/\/\*[\s\S]*?\*\//g, '')), '那一行里没有写死的「IndexedDB」')

  // common 的文件选择器提示
  const cm = readFileSync(`${CARD}/common.tsx`, 'utf8')
  const picker = /仅存于本机浏览器[\s\S]{0,200}/.exec(cm)?.[0] || ''
  ok(/useServer\(\)/.test(picker), '文件选择器那句按形态分叉了')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
/*

/*
 * ⚠️ 这里原来写的是 `process.exit(fail ? 1 : 0)`，而单独跑这个套件时
 *    它会以 **Windows 原生崩溃码 -1073740791** 退出 —— 尽管上面刚打印「27 通过 / 0 失败」。
 *
 *    也就是说：**报告说成功，退出码说失败**。谁单独排查它都会被误导
 *    （我第一次跑就以为是自己刚改坏的）。
 *
 *    成因是 `process.exit()` **立即**终止：自起的那个服务端进程的管道
 *    与原生句柄还在收尾就被打断，于是 Node 在退出路径上崩掉。
 *    实测把 `process.exit(...)` 换成只设 `exitCode`（让它自然退出），
 *    退出码就正常了，而且不会挂住 —— 子进程在那之前已经被 kill。
 *
 *    全量跑时看不出问题：那时 BASE 由 runner 传、不走自起服务那条路。
 */
process.exitCode = fail ? 1 : 0
/*
 * 收摊：删掉自起服务时那个库。
 *
 * 不用等 —— `srv.kill()` 早在第 100 行就调用过了，这里它早该退出。
 * 上一版我在这里加了个「等子进程退出」的循环，反而把
 * -1073740791 那个原生崩溃引了回来（`await import('node:fs')` 在
 * 文件最末尾做顶层 await，配合 exit 处理器会踩到那条路径）。
 * 静态引入 + 直接删就够。
 *
 * ⚠️ 只 kill 不删库的后果：单独跑一次就在 data/ 里留一个 ~2MB 的库。
 * 全量跑时 runner 的清扫会兜住，**单独跑不会** —— 而单独跑正是排查时做的事。
 */
{
  const stuck = []
  for (const s of ['', '-wal', '-shm']) {
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {
      try { rmSync(DB + s, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone && existsSync(DB + s)) stuck.push(DB + s)
  }
  if (stuck.length) console.log('  ⚠️  临时库删不掉（服务可能还占着）：' + stuck.join(', '))
}
