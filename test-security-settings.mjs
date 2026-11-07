/* ============================================================
   安全设置必须真的被执行
   ------------------------------------------------------------
   知识库设置里的「安全」页给了管理员四个开关。查下来：
   **四个全都只存不执行** —— 存进 SQLite、同步到各设备、界面上
   还写着「其余请求将被拒绝」「防止资料外流」，但服务端一个都没查。

   - `ipAllowed()` 在 `server/perms.ts` 里定义了，**从来没被调用过**
   - `restrictExport` 只出现在建表语句和实体声明里，导出接口不查它
   - `watermark` 连客户端都没渲染
   - `autoRevoke` 同样没有任何执行路径

   对一个要放公司内部文档的系统，「我在放文档之前先打开了 IP 白名单
   和导出限制」是再正常不过的操作 —— 而得到的是零保护。

   这个套件钉的是**服务端真的拒**：
   改了设置之后，用另一个账号真的去请求，被拒才算通过。
   ============================================================ */

import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'

const PORT = process.env.SEC_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_sec-${Date.now().toString(36)}.db`
const PW = 'sec-test@2026'

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
  return { status: res.status, data, text }
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

  // 空间 id 必须取真实的：YQ_DEMO=0 的全新库里只有管理员的个人空间，
  // 写死 's1' 会触发外键失败，然后后面每个断言都以「权限不对」的形式挂掉 ——
  // 报错指向的东西完全不是真正的原因。
  const boot = (await json('/api/bootstrap', { headers: A })).data
  const sid = String(boot.data.spaces[0].id)
  console.log(`   （使用的空间：${sid}）`)

  const bid = 'b_sec'
  const setup = await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({
      upsert: {
        books: [{ id: bid, spaceId: sid, name: '安全验证库', desc: '', avatar: '📚', visibility: 'private', docCount: 0, wordCount: 0, createdAt: 1, updatedAt: 1 }],
        docs: [{ id: 'd_sec', bookId: bid, spaceId: sid, title: '机密文档', blocks: [{ id: 'b1', type: 'p', text: '不该外流的内容', order: 0 }], order: 0, wordCount: 7, createdAt: 1, updatedAt: 1, rev: 0 }],
        nodes: [{ id: 'n_sec', bookId: bid, parentId: null, title: '机密文档', type: 'doc', docId: 'd_sec', ord: 0, rev: 0 }],
      },
      remove: {},
    }),
  })
  // 推送被拒的行不打印出来，后面每个断言都会以「权限不对」的形式失败，
  // 报错指向的东西完全不是真正的原因。
  ok(setup.status === 200 && (setup.data.rejected || []).length === 0, '建库建文档这一步没被拒', JSON.stringify(setup.data?.rejected || setup.data).slice(0, 300))

  // 一个普通同事，角色给了 export 权限 —— 这样「能不能导出」只取决于那个开关
  const reg = (await json('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'sec_user', password: 'test1234', name: '安全同事' }),
  })).data
  const memberPush = await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({
      upsert: { bookMembers: [{ bookId: bid, userId: reg.user.id, id: reg.user.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: 1 }] },
      remove: {},
    }),
  })
  ok(memberPush.status === 200 && (memberPush.data.rejected || []).length === 0, '加成员这一步没被拒', JSON.stringify(memberPush.data?.rejected || memberPush.data).slice(0, 300))
  const user = (await json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'sec_user', password: 'test1234' }),
  })).data
  const U = auth(user.token)

  console.log('\n== 基线：没开限制时应该都放行 ==')
  ok((await json('/api/export', { headers: U })).status === 200, '没开限制时可以导出整个工作台')
  ok((await json('/api/doc/d_sec', { headers: U })).status === 200, '没开白名单时可以读正文')

  console.log('\n== 开启「禁止导出」后，服务端必须真的拒 ==')
  const setExp = await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bid, restrictExport: 1, watermark: 0, watermarkText: '', ipWhitelist: 0, ipList: [], autoRevoke: 1, publicAccess: 0, defaultWidth: 'standard', defaultVisibility: 'space' }] }, remove: {} }),
  })
  ok(setExp.status === 200 && (setExp.data.rejected || []).length === 0, '打开导出限制这一步没被拒', JSON.stringify(setExp.data?.rejected || setExp.data).slice(0, 200))
  // 回读一次：设置没存进去的话，后面每个断言都会以「没拦住」的形式失败，
  // 而真正的原因是那一步推送被拒了
  const back = (await json('/api/bootstrap?lite=0', { headers: A })).data
  const saved = (back.data.bookSettings || []).find((s) => s.bookId === bid)
  ok(saved?.restrictExport === true, '设置确实存进了服务端', JSON.stringify(saved).slice(0, 160))
  const denied = await json('/api/export', { headers: U })
  ok(denied.status === 403, '开启后导出整个工作台被 403 拒了（以前根本不查这个开关）', `${denied.status} ${String(denied.data?.error || '').slice(0, 60)}`)
  ok(/禁止导出/.test(String(denied.data?.error || '')), '拒绝时说明了原因，不是干巴巴一个 403', String(denied.data?.error).slice(0, 80))
  // 读正文不受影响 —— 导出限制不是阅读限制
  ok((await json('/api/doc/d_sec', { headers: U })).status === 200, '导出限制不影响正常阅读')

  console.log('\n== 管理员自己仍然能导出 ==')
  ok((await json('/api/export', { headers: A })).status === 200, '管理员不受导出限制（否则就没人能备份了）', String((await json('/api/export', { headers: A })).status))

  console.log('\n== 开启「IP 白名单」后，非白名单地址必须被拒 ==')
  await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bid, restrictExport: 0, watermark: 0, watermarkText: '', ipWhitelist: 1, ipList: ['203.0.113.24'], autoRevoke: 1, publicAccess: 0, defaultWidth: 'standard', defaultVisibility: 'space' }] }, remove: {} }),
  })
  const blocked = await json('/api/doc/d_sec', { headers: U })
  ok(blocked.status === 403, '非白名单 IP 读正文被 403 拒了（ipAllowed 以前从没被调用）', `${blocked.status} ${String(blocked.data?.error || '').slice(0, 60)}`)
  ok(/白名单/.test(String(blocked.data?.error || '')), '拒绝时说清了是白名单问题', String(blocked.data?.error).slice(0, 80))

  // 白名单里的地址要放行
  const allowed = await json('/api/doc/d_sec', { headers: { ...U, 'X-Forwarded-For': '203.0.113.24, 10.0.0.1' } })
  ok(allowed.status === 200, '白名单内的 IP 正常放行（取 X-Forwarded-For 第一段）', String(allowed.status))

  console.log('\n== 关掉白名单后恢复 ==')
  await json('/api/sync/push', {
    method: 'POST', headers: A,
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bid, restrictExport: 0, watermark: 0, watermarkText: '', ipWhitelist: 0, ipList: [], autoRevoke: 1, publicAccess: 0, defaultWidth: 'standard', defaultVisibility: 'space' }] }, remove: {} }),
  })
  ok((await json('/api/doc/d_sec', { headers: U })).status === 200, '关掉白名单后又能读了')
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { kid.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) { try { rmSync(DB + s) } catch { /* 删不掉就算了 */ } }
}

/* ===================================================================
   DEPLOY.md 里那个 systemd 单元：照抄就装出一个「口令公开 + 带演示数据」的实例
   -------------------------------------------------------------------
   实测（2026-10-06）：把单元原样抄成环境变量跑一遍（只设 PORT / YQ_DB）——
     · 服务**起得来**（不是「起不来」那种一眼能发现的错）
     · 用**仓库里写死的默认口令** `yuque@2026` 登录 → **拿到 token**
     · `YQ_DEMO` 没设 → 默认 1 → **4 个演示知识库被播种进正式库**
     · 日志里只有一行提示，混在 seed 输出中间
 *
 * 而同一份文档的变量表里就写着 `YQ_ADMIN_PASSWORD` 「**务必修改**」——
 * 表格说了，**它给的安装路径没做**。
 *
 * 服务端那两条**不改**（都是有意取舍）：
 *   · 「口令还是 compose 占位符」→ 拒绝启动（防的是抄了 compose 没改）
 *   · 「压根没设口令」→ 打一行警告就放行（本地试玩需要它）
 * 前者拦不住后者，所以口令必须由 env 文件提供 —— 也就是这一节要钉的东西。
 * =================================================================== */
/* ===================================================================
   DEPLOY 第二节「裸机部署」的 quick-start：同样两个必须显式设的变量
   -------------------------------------------------------------------
   2026-10-06 修完上面那个 systemd 单元之后发现的：
   **同一个缺陷，修了一处漏了一处。** systemd 单元显式写了 `YQ_DEMO=0`，
   而它上面几行的裸机 quick-start 仍然是
       npm ci / npm run build / npm run server
   —— 不带 `YQ_DEMO`、不带 `YQ_ADMIN_PASSWORD`。

   照着第二节（标题就叫「裸机部署（不用 Docker）」）抄一遍的后果，实测过：
     · `YQ_DEMO` 默认 1 → 经 seed.ts **直插** 4 个演示知识库、26 篇写得很真的
       文档，不走同步、不在任何清理脚本范围内，装到内网后和真实文档混在一起，
       **没有任何提示**；
     · `YQ_ADMIN_PASSWORD` 默认 `yuque@2026` —— 字面量写在代码里，
       服务端对「压根没设」是**放行 + 一行警告**（那是给本机试玩留的口子），
       于是拿到的是一个**公开口令的管理员账号**。

   本项目自己记过这条：「同一类根因有两个写入点时，只修顺手碰到的那一个，
   等于没修」—— 而且更糟的是你会以为已经修好了，因为主路径的症状真的消失了。
   =================================================================== */
/* ===================================================================
   免鉴权的 `/api/health`：它的暴露面是**有意决定**的
   -------------------------------------------------------------------
   这个接口是全服务唯一**刻意公开**的接口（`test-lint` 的 `PUBLIC_ROUTES`
   里登记了理由：探活不能要求先登录，否则健康检查自己把自己判死）。
   2026-10-06 实测了它不带令牌时到底返回什么：

       {"ok":true,"users":1,"docs":0,"online":[],"sso":false,"ssoOnly":false,"ts":…}

   于是有一件事必须钉住，否则下一个人会把统一认证部署搞坏：

   **`sso` / `ssoOnly` 必须留在免鉴权响应里。**
   前端 `src/lib/api.ts` 读它们来决定登录页显示「走 SSO 的按钮」还是
   「密码表单」—— 而登录页**在拿到令牌之前**就要用到。
   给这个接口「加个鉴权」看起来是安全加固，实际效果是
   **统一认证部署所有人都登不进去**。

   `test-lint` 能钉住「这个路由没鉴权」和「代码里有没有这些字段」，
   但它钉不住**前端是否真的在读** —— 那一半的耦合只能在这儿钉。
   =================================================================== */
console.log('\n== /api/health 免鉴权，但 sso/ssoOnly 必须公开 ==')
{
  const idx = readFileSync('server/index.ts', 'utf8')
  const api = readFileSync('src/lib/api.ts', 'utf8')
  const lint = readFileSync('test-lint.mjs', 'utf8')

  ok(/sso:\s*SSO_ENABLED/.test(idx) && /ssoOnly:\s*SSO_ONLY/.test(idx),
    '服务端在 /api/health 的响应里给了 sso / ssoOnly（免鉴权那段）')

  /*
   * 判「前端在读」要判**真的取值**，不能只判类型声明里有这两个字段 ——
   * `ServerInfo` 里声明了 `sso?: boolean` 而没人读的话，这三条照样绿。
   */
  ok(/info\s*\??\.\s*sso\b/.test(api) || /\bssoOn\s*=\s*!!\s*info\s*\??\.\s*sso\b/.test(api),
    '前端真的读了响应里的 sso（不只是类型声明里有）')
  ok(/\bssoOnlyOn\s*=\s*!!\s*info\s*\??\.\s*ssoOnly\b/.test(api),
    '前端真的读了响应里的 ssoOnly')
  // ⚠️ 这里**不能**写 `serverSso\w*`：`\w*` 会把兄弟导出
  // `export const serverSsoOnly = …` 也算上，于是「取消 serverSso 的导出」
  // 这个破坏照样 PASS —— 破坏对照亲自抓到的，不是推理出来的。
  ok(/export const serverSso\s*=/.test(api), '并且它们被导出、供界面使用（不是读了扔掉）')

  // 免鉴权这件事本身也要钉：有人给它加鉴权时，这里要红
  ok(/GET \/api\/health/.test(lint) && /探活/.test(lint),
    'test-lint 把它登记成「有意免鉴权」，且带着理由（探活不能要求先登录）')
  /*
   * ⚠️ 光有上面那条**不够**，而且这是个真实的洞：
   * `test-lint` 判的是「有鉴权**或**在豁免名单里」，
   * 而 `/api/health` **本来就在豁免名单里** ——
   * 所以有人给这个处理器加上 `requireUser(ctx)` 时，**test-lint 不会红**。
   * 而那恰恰是把统一认证部署弄坏的动作。
   * 所以这里直接判处理器本身：它不许要求登录。
   */
  {
    const i = idx.indexOf("on('GET', '/api/health'")
    const j = idx.indexOf('\n}))', i)
    const handler = i < 0 || j < 0 ? '' : idx.slice(i, j)
    ok(handler.length > 0, '（能取到 /api/health 的处理器）', `长度 ${handler.length}`)
    /*
     * ⚠️ 长度必须**同时**进这一条的判据，不能只报上一条。
     * 第一版写成两条，发现做破坏对照时：给处理器加上 `requireUser(ctx)`
     * 之后，我取块的 `\n}))` 找不到了 → `handler` 是**空串** →
     * `!/requireUser/.test('')` 为 true → **「不许要求登录」在
     * 一行代码都没取到的情况下通过了**。
     * 而同一节的「能取到处理器」那条是红的 —— 只是它只报长度，
     * 挡不住下一条的空集合恒真。
     */
    ok(handler.length > 0 && !/requireUser|requireAdmin|userFromToken/.test(handler),
      '**这个处理器不许要求登录** —— 加了会让统一认证部署所有人都登不进去',
      handler.length ? handler.slice(0, 80) : '（没取到处理器，按失败处理，不当成通过）')
  }

  // 免鉴权接口的暴露面要说清，不能装作没有
  ok(/绝不能被直连|不能被直连/.test(readFileSync('DEPLOY.md', 'utf8')),
    'DEPLOY 写明了对应的网络层对策（开了统一认证后服务绝不能被直连）')
}

console.log('\n== DEPLOY 第二节 裸机 quick-start ==')
{
  const d = readFileSync('DEPLOY.md', 'utf8')
  /*
   * ⚠️ 锚点必须是**第二节的标题**，不能用 `cd yuque-src/yuque`。
   * 第一版用 `d.indexOf('cd yuque-src/yuque')` —— 而这个串在 DEPLOY 里
   * **出现两次**（Docker 那一节也有），于是抓到的是 Docker 的块，
   * 拿它来断言裸机的配置。测出来是「能定位到」（长度 > 0，PASS）但内容全错。
   *
   * 这就是本项目记过的那条：**按锚点定位会静默失败**，
   * 而「长度 > 0」这种断言对「抓错了地方」完全无感 ——
   * 抓住它的是下一条「那段里确实有 `npm run server`」。
   *
   * 标题那行尾部带 7.27 的损伤，只用**行首**匹配。
   */
  const secA = d.search(/^## 二、裸机部署/m)
  ok(secA >= 0, '（能定位到「二、裸机部署」这一节）', `secA=${secA}`)
  const a = d.indexOf('cd yuque-src/yuque', secA)
  const fenceOpen = d.indexOf('```', a)
  const b = fenceOpen < 0 ? -1 : d.indexOf('```', fenceOpen + 3)
  const block = a < 0 || b < 0 ? '' : d.slice(a, b)
  ok(block.length > 0, '（能取到那一节的 quick-start 代码块）', `长度 ${block.length}`)

  const lines = block.split(/\r?\n/)
  const srvIdx = lines.findIndex((l) => l.includes('npm run server'))
  ok(srvIdx >= 0, '那段里确实有 `npm run server`（没有的话下面几条就是空断言）')

  /*
   * 判据必须看**完整调用**，不能只看 `npm run server` 那一行 ——
   * 第一版就栽在这里：文档里是
   *     YQ_DEMO=0 YQ_ADMIN_PASSWORD='…' \
   *       npm run server
   * 两个变量在**上一行**、用 `\` 续行。只看单行 → 两条断言都红，
   * 而文档其实是对的 —— 于是第一版差点让我去「修」一个没坏的东西。
   *
   * 所以取「上一行非空 + 本行」作为这一次调用的全部文本。
   */
  const inv = srvIdx > 0 ? `${lines[srvIdx - 1]}\n${lines[srvIdx]}` : (lines[srvIdx] || '')
  ok(/YQ_DEMO=0/.test(inv),
    '**启动服务那一次调用带上 `YQ_DEMO=0`** —— 不带就照默认 1 播种演示库进正式库', inv.trim().replace(/\n/g, ' ⏎ '))
  ok(/YQ_ADMIN_PASSWORD=/.test(inv),
    '并且**带上 `YQ_ADMIN_PASSWORD`** —— 不带就是代码里写死的默认口令', inv.trim().replace(/\n/g, ' ⏎ '))
  ok(!/^\s*npm run server\s*$/m.test(block),
    '**没有**一条不带变量的裸 `npm run server`（那正是照抄就会用到的那条）')

  // 只写对配置、不说清「漏了会怎样」，等于没做
  ok(/YQ_DEMO/.test(d) && /seed\.ts/.test(d), '文档写清了演示数据是 seed.ts 直插、事后清不掉')
  ok(/yuque@2026/.test(d), '并点名了那个写死的默认口令是什么')
  ok(/拒绝启动/.test(d) && /只警告/.test(d),
    '并区分了「抄了占位符口令 → 拒绝启动」与「压根没设 → 只警告」这两种情况')
}

console.log('\n== DEPLOY 里的 systemd 单元 ==')
{
  const d = readFileSync('DEPLOY.md', 'utf8')
  const a = d.indexOf('[Service]')
  const b = d.indexOf('[Install]', a)
  const unit = a < 0 || b < 0 ? '' : d.slice(a, b)
  ok(unit.length > 0, '（能定位到 DEPLOY 里的 systemd 单元）', `长度 ${unit.length}`)
  ok(/Environment=YQ_DEMO=0/.test(unit),
    '**显式关了演示数据** —— 不写这一行，默认 1 会往正式库里播种 4 个演示知识库')
  ok(/EnvironmentFile=-?\/etc\/yuque\/yuque\.env/.test(unit),
    '口令走 `EnvironmentFile=`，而不是写进单元（单元默认 644，任何本机用户都读得到）')
  ok(!/Environment=YQ_ADMIN_PASSWORD=/.test(unit),
    '单元里**没有**明文口令')
  ok(/StateDirectory=yuque/.test(unit),
    '声明了数据目录（systemd 不会替你建 /var/lib/yuque，不声明就是运行时报错）')
  // 那一段说明也得在：只写对配置、不说清「不做这步会怎样」，等于没做
  ok(/会用仓库里写死的默认口令起得来/.test(d), '文档写清了「不建 env 文件会怎样」')
  ok(/StateDirectory=yuque/.test(d) && /mkdir -p \/var\/lib\/yuque/.test(d), '并给了建目录的那条命令')
}

/* ===================================================================
   DEPLOY 第四节那段 nginx：`/ws` 必须转发 X-Forwarded-For
   -------------------------------------------------------------------
   2026-10-06 加 WS 的 IP 白名单判定时发现的：**两处都单独是对的，凑一起是事故。**
   · 服务端在握手那一下也要 `clientIp(req)`，而**浏览器不允许给 WebSocket
     自定义 header**（令牌只能走 query，DEPLOY 早就写明了），
     所以来源只有 nginx 转发的这个头。
   · 而文档给的 `/ws` 段只转发了 Upgrade / Connection / Host ——
     少了它，服务端看到的是**反代自己的 IP**：知识库一开白名单，
     **所有正常同事的实时协同都被静默拒掉**，而页面/文档/导出全都正常。
   · `location /` 那一段是转发了 XFF 的，所以「网页能用、只有协同坏了」，
     症状极具迷惑性。
   =================================================================== */
console.log('\n== DEPLOY 的 nginx /ws 段 ==')
{
  const d = readFileSync('DEPLOY.md', 'utf8')
  const a = d.indexOf('location /ws {')
  const b = a < 0 ? -1 : d.indexOf('\n    }', a)
  const ws = a < 0 || b < 0 ? '' : d.slice(a, b)
  ok(ws.length > 0, '（能定位到 DEPLOY 第四节那段 nginx 的 /ws 段）', `长度 ${ws.length}`)
  ok(ws.includes('proxy_set_header Upgrade'), '转发 Upgrade（漏了它协同光标直接失效）')
  ok(/proxy_set_header X-Forwarded-For/.test(ws), '**转发 X-Forwarded-For** —— 服务端在握手那一下靠它判白名单')
  ok(/proxy_set_header X-Real-IP/.test(ws), '转发 X-Real-IP')
  ok(/浏览器不允许给 WebSocket 自定义 header|浏览器不允许给 WebSocket/.test(ws),
    '并写清了「浏览器不能自定义 header，所以这个头是唯一来源」')
  ok(/反代自己的 IP/.test(ws), '并写清了漏掉的后果是「所有正常同事都被白名单挡在协作房间外」')
  ok(/开.*实时协同静默失效|实时协同静默失效/.test(d), '排障表里有这一行的症状（「协同不动，别的都正常」）')
}

/* ============================================================
   子路径部署：产物必须自述它是拿哪个 API 前缀构建的
   ------------------------------------------------------------
   事故形态（两处单独看都对，凑一起才出事 ——
   和上面那个 nginx `/ws` 漏转发 X-Forwarded-For 同一类）：

     ① 运维按 DEPLOY 第四节 `VITE_API_BASE=/knowledge npm run build`，
        部署在 `https://wiki.内网/knowledge/` —— 正常；
     ② 之后**任何人**跑一次 `npm run build`，或者跑 `npm run test:all`
        （它在跑套件前必定重新构建，而且**不带那个变量**）；
     ③ 产物被换成根路径版本 → 前端把 API 请求打回 `/api/...` →
        **全站 API 404**。而界面能打开（资源路径是相对的，`base: './'`），
        症状是「登录一直转圈 / 数据加载不出来」，
        没有任何一处会说「你的产物被重建过了」。

   根因是 `VITE_API_BASE` 是**构建期**变量：
   `apiBase()` 拿不到它就返回 `''`，也就是**照常构建**完全正常。
   所以防不住「有人重建了」，只能让它**看得见**：
   构建时把前缀写进产物 → 启动时打出来 → 覆盖前喊一声。
   ============================================================ */
console.log('\n== 子路径部署：产物自述 API 前缀 ==')
{
  const vite = readFileSync('vite.config.ts', 'utf8')
  const idx = readFileSync('server/index.ts', 'utf8')
  const runner = readFileSync('run-all-tests.mjs', 'utf8')
  const api = readFileSync('src/lib/api.ts', 'utf8')
  const deploy = readFileSync('DEPLOY.md', 'utf8')

  /*
   * 下面几条必须判**机制本身**，不能判「出现过某个词」。
   *
   * 破坏对照教过一次：把 `closeBundle()` 改成 `closeBundleX()`、
   * 把日志里的「API 前缀」改成「API 前缀X」——
   * 原来那两条断言（`/closeBundle/` 和 `/API 前缀/`）**照样是绿的**，
   * 因为被改坏的东西仍是原来那个词的子串。
   * 「源码里提到过 X」和「X 真的被调用了」不是一回事。
   */
  ok(/closeBundle\s*\(\s*\)\s*\{/.test(vite) && /writeFileSync\s*\(/.test(vite) && /\.buildinfo\.json/.test(vite),
    '构建时会把 API 前缀写进产物（vite 的 closeBundle 钩子 → dist/.buildinfo.json）')
  ok(/readFileSync\s*\(\s*infoPath/.test(idx) && /\.buildinfo\.json/.test(idx),
    '服务端启动时**读**那个标记文件（不是只在源码里提一句）')
  ok(/如果你把服务挂在子路径/.test(idx), '并且前缀为空时提醒「子路径部署下这份产物是错的」')
  ok(/\.buildinfo\.json/.test(runner) && /VITE_API_BASE/.test(runner),
    '`test:all` 覆盖前会喊出「即将覆盖一份子路径部署的产物」')

  // 三处必须指向**同一个**变量名，否则守卫是绿的而行为仍然错位
  const names = new Set([
    /VITE_API_BASE/.test(vite) ? 'VITE_API_BASE' : '别的',
    /VITE_API_BASE/.test(api) ? 'VITE_API_BASE' : '别的',
    /VITE_API_BASE/.test(runner) ? 'VITE_API_BASE' : '别的',
  ])
  ok(names.size === 1, '三处认的是同一个变量名', [...names].join(' / '))

  // 空集合恒真的防线：真的产物必须存在、且能解析出这两个字段
  let mark = null
  try { mark = JSON.parse(readFileSync('dist/.buildinfo.json', 'utf8')) } catch { /* 下面判 */ }
  ok(!!mark && typeof mark.apiBase === 'string' && typeof mark.builtAt === 'string',
    '当前 dist 里的标记文件存在、含 apiBase 与 builtAt（为 0 说明写入那步坏了）',
    JSON.stringify(mark))

  ok(/VITE_API_BASE=\/knowledge npm run build/.test(deploy), 'DEPLOY 教子路径怎么构建')
  ok(/test:all|npm run build/.test(deploy) && /重建/.test(deploy),
    '并写清了「之后任何一次重建都会覆盖它」这个坑')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
