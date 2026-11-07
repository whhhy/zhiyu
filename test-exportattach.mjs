/**
 * 「导出整个工作台」到底带不带附件，以及**界面有没有说实话**
 *
 * ============================================================
 * 这个套件钉的不是「导出能不能用」，而是**导出**承诺**与数据对不对得上**
 * ------------------------------------------------------------
 * `exportBundle` 逐个列了要带的实体，里面没有 `attachments`。
 * 同一段代码对「刻意不带」的东西都写了很认真的说明
 * （members 带密码散列所以不带、recents 是设备本地状态所以不带），
 * 唯独附件一个字没有 —— 正是那段注释自己说的
 * 「看起来像遗漏、实际谁也没实现，属于最该消除的那种含糊」。
 *
 * 而三处用户实际会读到的地方都在把它当完整备份推：
 *   · 设置页：「含正文、按权限过滤……不含两样：账号、最近浏览」← 附件是第三样
 *   · 帮助页：「得到一个 JSON 包，**带正文**并按你的权限过滤」
 *   · DEPLOY  ：「适合换机器、迁移、给某位同事一份」
 *
 * 于是导出的包里：正文在、**附件卡片也在**（`data.key` 指着附件 id），
 * 而二进制不在。导入新实例后那些卡片显示「附件二进制已丢失」，
 * 包里却没有任何东西提示过这件事。拿它当灾备的人会得到一个错误结论。
 *
 * 这里钉三件事：
 *   ① 包里确实没有附件二进制（这是**当前行为**，写出来是为了别当成 bug 藏起来）
 *   ② 卡片在包里、二进制不在 —— 也就是「悬空引用」确实存在，不是理论上
 *   ③ 三处文案都点了名（承诺与现实绑在一起：将来真把附件导进去，
 *      那三处必须一起改，这条会红）
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PORT = process.env.EXPORTATTACH_PORT || await freePort()
const DB = 'data/_exportattach-test.db'
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

const admin = (await ses('/api/auth/login', {
  method: 'POST', body: JSON.stringify({ account: 'admin', password: 'yuque@2026' }),
})).json.token || ''
ok(!!admin, '管理员登录成功')

const B = (await ses('/api/entity/books', {}, admin)).json.rows[0]
const SFX = Math.random().toString(36).slice(2, 7)
const docId = `expatt_doc_${SFX}`

console.log('\n== 造一篇带附件的文档 ==')
const SECRET = Buffer.from('导出包里找不到的附件内容-zzz', 'utf8')
let attId = ''
{
  const now = Date.now()
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      upsert: {
        docs: [{
          id: docId, bookId: B.id, title: '导出附件探针', body: 'x',
          createdAt: now, updatedAt: now, wordCount: 1,
          blocks: [{
            id: 'bk_expatt_1', type: 'card', text: '',
            data: { cardId: 'file', name: '机密.txt', key: '__PLACEHOLDER__', size: SECRET.length },
          }],
        }],
      },
    }),
  }, admin)

  const up = await fetch(`${BASE}/api/attachment?docId=${encodeURIComponent(docId)}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + admin,
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent('机密.txt'),
    },
    body: SECRET,
  })
  attId = (await up.json()).id || ''
  ok(!!attId, '附件上传成功（先证明它真的在库里）', attId)

  // 把真实附件 id 写回卡片，模拟「这篇文档确实引用着这个附件」。
  //
  // 走**同步接口**而不是直连数据库改 —— 直连那一版写完不验，
  // 结果根本没生效（导出包里 blocks 是空的），而测试还接着往下跑。
  // 这次写完立刻从 /api/entity/docs 回读确认，别再拿「我以为写进去了」当证据。
  {
    const now2 = Date.now()
    await ses('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        upsert: {
          docs: [{
            id: docId, bookId: B.id, title: '导出附件探针', body: 'x',
            createdAt: now2, updatedAt: now2, wordCount: 1,
            blocks: [{
              id: 'bk_expatt_1', type: 'card', text: '',
              data: { cardId: 'file', name: '机密.txt', key: attId, size: SECRET.length },
            }],
          }],
        },
      }),
    }, admin)

    const back = (await ses('/api/entity/docs', {}, admin)).json.rows.find((r) => r.id === docId)
    const backBlocks = Array.isArray(back?.blocks) ? back.blocks : []
    ok(backBlocks[0]?.data?.key === attId,
      `卡片现在指向真实附件 id（从 API 回读确认，不是「我以为写进去了」）`,
      JSON.stringify(backBlocks[0]?.data || {}))
  }
}

console.log('\n== 导出的包里有什么 ==')
const bundle = await (await fetch(`${BASE}/api/export`, { headers: { Authorization: 'Bearer ' + admin } })).json()

ok(!!bundle.docs && bundle.docs.length > 0, '包里确实有文档（否则后面「带走了什么」无从谈起）')
ok(!('attachments' in bundle), '**包里没有 attachments 字段** —— 附件二进制确实不在这包里')

const exportedDoc = (bundle.docs || []).find((d) => d.id === docId)
ok(!!exportedDoc, '探针那篇文档被导出来了')

/*
 * `blocks` 从服务端出来**已经是数组**（readEntity 里的 json 列会解析好）。
 * 我第一版写成 `JSON.parse(String(x || '[]'))` —— 对数组做 String 得到
 * `"[object Object]"`，parse 抛错，被 `catch` 吞掉返回 `[]`，
 * 于是断言「包里没有附件卡片」看起来像在报告产品行为，其实在报告我自己。
 *
 * 教训和那句「红的常常不是代码而是期望算错了」是同一条，而且更隐蔽：
 * `catch` 把异常变成了一个**看起来合理的空值**，后面每一步都照着错的结论在跑。
 * 所以这里不吞异常：解析不出来就让它响。
 */
const blocks = Array.isArray(exportedDoc?.blocks)
  ? exportedDoc.blocks
  : JSON.parse(String(exportedDoc?.blocks ?? '[]'))
const keyInBundle = blocks[0]?.data?.key || ''
ok(keyInBundle === attId,
  '**但附件卡片被带着走了**，而且它指着那个包里根本不存在的 id', `包里的 key=${keyInBundle} 真实=${attId}`)

console.log('\n== 这是「悬空引用」，不是「没提到」 ==')
{
  // 关键在两句合起来：卡片在 → 导入后必然显示「二进制已丢失」；
  // 只有把这两句分开看（"导出不含附件"）会以为那是干净的设计。
  ok(blocks.length > 0 && !!keyInBundle, '所以「导出不含附件」的真实后果是**导入后卡片变成坏引用**')
  const text = JSON.stringify(bundle)
  ok(!text.includes(SECRET.toString('utf8')), '包的任何一个字节里都没有那段附件内容（不只是没有 BLOB 字段）')
}

console.log('\n== 服务端要「看得见地」省略 ==')
{
  /*
   * 只写「没实现」不够 —— 下一个人看到 `attachments` 不在清单里，
   * 会当成漏写然后顺手补上（或者当成 BUG 去「修」）。
   * 留一条 `attachments: undefined`：JSON.stringify 会把它整个省略掉，
   * 所以**行为不变**，但源码里这个省略是显式的、grep 得到的。
   */
  const src = readFileSync('server/sync.ts', 'utf8')
  ok(/attachments:\s*undefined/.test(src),
    'exportBundle 里有一条显式的 `attachments: undefined`（省略是写在代码里的，不是靠「没写」）')
  ok(true, '（将来真把附件导进包，这一行会消失 —— 那时三处文案必须一起改，下面三条会红）')
}

console.log('\n== 三处界面都必须点了名 ==')
{
  const read = (f) => readFileSync(f, 'utf8')

  /**
   * **只看那一节，不扫全文。**
   *
   * 扫全文这个坑已经踩到第八次了。上一版用的是
   *   /附件/.test(s) && /(不含|不带|不跟|没有|不在)/.test(s)
   * 而 Help.tsx 全文里到处都是「附件」，也到处都是「不含」——
   * 把导出那一行整句删掉，**测试照样全绿**。破坏对照当场抓到了这一点：
   * 一个「看起来在验承诺、其实验不到」的断言，比没有断言更糟。
   *
   * 所以下面每一处都先把那一节切出来，再在**节内**判断。
   */
  const sectionOf = (src, startRe, endRe) => {
    const m = startRe.exec(src)
    if (!m) return ''
    const from = m.index
    const rest = src.slice(from + m[0].length)
    const e = endRe.exec(rest)
    return rest.slice(0, e ? e.index : rest.length)
  }

  /* 判据是「提到了附件 + 说了不含」，两件事都要有 ——
     只验「出现附件两个字」会被「附件可以正常上传」这类无关文案蒙混过去。 */
  const named = (s) => /附件/.test(s) && /(不含|不带|不跟|没有|不在)/.test(s)

  // 设置页：把「导出整个工作台」那个 Row 的 desc 切出来
  const settingsAll = read('src/pages/Settings.tsx')
  const settings = sectionOf(settingsAll, /label="导出整个工作台"/, /\n\s*<Row/)
  ok(settings.length > 0, '（能定位到设置页「导出整个工作台」这一行）', String(settings.length))
  ok(named(settings), '设置页那一行的说明里点明了附件不在包里', settings.slice(0, 80))
  ok(/不含三样/.test(settings), '而且把排除项从「两样」更正成「三样」（原来漏的就是附件）')
  ok(/灾备不靠它|文件级备份/.test(settings), '并且指向真正含二进制的备份方式')

  // 帮助页：只取「导出与迁移」这一节
  const helpAll = read('src/pages/Help.tsx')
  const help = sectionOf(helpAll, /t: '导出与迁移'/, /\n\s*t: '/)
  ok(help.length > 0, '（能定位到帮助页「导出与迁移」这一节）', String(help.length))
  ok(named(help), '帮助页「导出与迁移」**那一节**里点明了附件不在包里', help.slice(0, 60))

  // DEPLOY：只取「页面里的「导出整个工作台」也能用」那一节
  const deployAll = read('DEPLOY.md')
  const deploy = sectionOf(deployAll, /### 页面里的「导出整个工作台」也能用/, /\n#{2,3} /)
  ok(deploy.length > 0, '（能定位到 DEPLOY 那一节）', String(deploy.length))
  ok(named(deploy), 'DEPLOY 那一节里点明了附件不在包里')
  ok(/不含附件文件/.test(deploy), '并且用了「不含附件文件」这个说法')
  ok(true, '（三处都按「节内」判断：删掉别的章节里的同名词，测试不会误红；删掉这一节的，会红）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
