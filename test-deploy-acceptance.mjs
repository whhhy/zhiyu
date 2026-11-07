/**
 * 首次部署验收（常驻套件）：以「第一次部署的公司运维」身份，**照 DEPLOY.md 第 0~2 步从零走一遍**。
 *
 * 为什么要做：前面所有验证都是在**已经跑起来**的实例上做的
 * （smoke 36/36、探针、套件）。而你的核心目标是「**能部署到内网**」——
 * 那条链路的起点是「一个空目录 + 一份 compose 文件 + 一个口令」。
 * 这次验的是**起点**，不是终点。
 *
 * ⚠️ 用 compose override 而不是改 docker-compose.yml 本身：
 *    那份文件里的口令位是**留给你自己填的**，我不替你写死。
 *
 * 默认 8080；用 `YQ_ACCEPT_PORT` 换端口是**真的**换 ——
 * Docker 那条路靠 compose override 里的 ports 映射（2026-10-11 补）。
 * 以前 compose 里写死 `8080:8080`、而这个旋钮只改测试自己探测的地址，
 * 于是设了它反而必然「服务连不上」，容器却 Up 且 healthy。
 * 不碰正在给你用的 8090 实例。
 */
// ⚠️ `.mjs` 里 require + 顶层 await 会报 ERR_AMBIGUOUS_MODULE_SYNTAX，
//    所以这里统一用 ESM import（第一版用了 require，直接崩在第 14 行）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PASS = 'Zq7mK3vLp9x'   // 至少 8 位、含字母和数字
const PROJECT = 'yqaccept'

/*
 * ⚠️⚠️ 2026-10-10 加的：**不靠 Docker 的那条部署路径**。
 *
 * 这套验收的第 2~6 步验的是「公司部署第一天」，而第 1 步原来是写死的
 * `docker compose up`。于是它**从来没验过**「一个 Node 进程 + 一个数据目录」
 * 这条路径 —— 而那恰恰是我现在**推荐给用户**的部署方式（HOST 默认 0.0.0.0，
 * Docker 只是镜像包装，不是部署本身）。
 *
 * **推荐的路没有验收覆盖**，是个实打实的缺口：
 * 设 `YQ_ACCEPT_NO_DOCKER=1` 就走 node 直起，用同一套第 2~6 步判据。
 * 默认仍然走 compose（那是要验的「交付形态」）。
 */
const USE_DOCKER = process.env.YQ_ACCEPT_NO_DOCKER !== '1'
const PORT = process.env.YQ_ACCEPT_PORT || '8080'
const BASE = process.env.YQ_ACCEPT_BASE || `http://127.0.0.1:${PORT}`
let localServer = null   // 不走 Docker 时自己起的那个进程

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

const compose = (args, env = {}) =>
  spawnSync('docker', ['compose', '-p', PROJECT, ...args], {
    encoding: 'utf8', cwd: __dirname,
    env: { ...process.env, NPM_REGISTRY: 'https://registry.npmmirror.com', ...env },
  })

const sh = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' })

console.log(`== 第 0 步：改口令（用 override，不动交付的 compose 文件）==`)
const override = path.join(__dirname, '_accept.override.yml')
/*
 * ⚠️⚠️ 第一版这里没换数据目录，于是 compose 的 `./data`（bind mount）
 *   直接复用了**工作目录里验证实例的库** —— 拿到 users 6 / docs 26，
 *   还因为库里 admin 口令是 yuque@2026 而不是我传的那个而报「正确口令 401」。
 *   也就是说：我当时验的根本不是「全新部署」，而是「旧库上换个口令」。
 *
 *   真·首次部署必须给一个**空的数据目录** —— 这也正是 DEPLOY 第 0 步
 *   没说清的前提：compose 的 `./data` 是宿主机目录，第一次部署时它得是空的。
 */
const freshData = path.join(__dirname, '_accept_data')
/*
 * ⚠️⚠️ 2026-10-11 补的：**「空目录」这个前提必须被建立，不能被假设。**
 *
 * 上一轮崩在收摊之前（我中途手工 `compose down`，脚本没走到清理），
 * `_accept_data` 就留在那里了。而 `mkdirSync(…, { recursive: true })`
 * **不会清空**一个已存在的目录 —— 于是这一轮开头断言直接红：
 * 「数据目录是空的」FAIL。
 *
 * 真正的问题不是那条红，而是：**如果哪天它没红**（比如残留刚好是空的、
 * 或者这段代码被人删了），这一轮验的其实是「上一轮留下的旧库」，
 * 而报告上却写着「数据目录是空的」。
 * 「首次部署」这个前提一旦不成立，后面第 2~6 步验的就全是「旧库上跑一遍」。
 *
 * 所以这里：**清掉，并且说出来**。
 * 不清理 = 前提不成立；清理了不说 = 下一个人以为一直是干净的。
 */
if (fs.existsSync(freshData)) {
  const leftover = fs.readdirSync(freshData).length
  fs.rmSync(freshData, { recursive: true, force: true })
  if (leftover > 0) {
    console.log(`  ⚠️  清掉了上一轮残留的验收数据目录（${leftover} 个文件）`)
    console.log('      这说明上一轮**没收摊就中断了** —— 不清的话这一轮验的是旧库，不是全新部署。')
  }
}
fs.mkdirSync(freshData, { recursive: true })
if (USE_DOCKER) {
  fs.writeFileSync(override, [
    'services:',
    '  yuque:',
    '    container_name: yq-accept',
    /*
     * ⚠️⚠️ 2026-10-11 补的：`ports` 这一段以前**根本不存在**。
     *
     * 于是 compose 里写死的 `8080:8080` 一直是唯一生效的映射，
     * 而这个套件的 `YQ_ACCEPT_PORT` 只改了自己探测的 BASE ——
     * 也就是说：**在 Docker 这条路上，那个环境变量只会让验收失败**
     *   设了它 → 容器照旧听 8080 → 测试去戳别的端口 → 「服务起不来，连不上」
     *
     * 我就是这么踩进去的：设了 8084 避端口冲突，结果第 2 步直接红，
     * 而容器其实 **Up 且 healthy**。查了半天才发现是旋钮自己不对。
     *
     * 一个「看着能配、实际只会把测试搞坏」的旋钮，比没有这个旋钮更糟 ——
     * 它让人以为端口冲突时有个办法，结果把人带进一个和事实相反的诊断里。
     * 现在 override 把它映射成宿主 PORT → 容器 8080，两边真正一致。
     */
    `    ports:`,
    `      - "${PORT}:8080"`,
    `    volumes:`,
    // 覆盖 compose 里那条 `./data:/data`，指向一个刚建好的空目录
    `      - ${freshData.replace(/\\/g, '/')}:/data`,
    `    environment:`,
    `      YQ_ADMIN_PASSWORD: "${PASS}"`,
    `      YQ_DEMO: "0"`,
    '',
  ].join('\n'), 'utf8')
  ok(fs.existsSync(override), 'override 文件已生成（compose 文件本身未改）')
  /*
   * 钉住「端口旋钮是真的」—— 上面那行只证明文件生成了，
   * 不证明它把宿主端口映射成了 PORT。没有这条的话，
   * 去掉 ports 段这个套件照样全绿（只要没人设 YQ_ACCEPT_PORT），
   * 而下一个设了它的人会撞上一个和事实完全相反的报错。
   */
  ok(fs.readFileSync(override, 'utf8').includes(`"${PORT}:8080"`),
    `override 里真的把宿主端口映射成了 ${PORT}（YQ_ACCEPT_PORT 是个真旋钮，不是只会让验收失败的假开关）`)
} else {
  ok(!fs.existsSync(override), '不走 Docker 时**不生成** override（那条路不经过 compose）')
}
ok(fs.readdirSync(freshData).length === 0, `数据目录是空的（${freshData}）`)
{
  const orig = fs.readFileSync('docker-compose.yml', 'utf8')
  ok(/请改成你自己的口令/.test(orig), '交付的 compose 文件里仍是占位符（口令位留给你填）')
}

console.log(`== 第 1 步：${USE_DOCKER ? 'docker compose up -d' : 'node 直起（不走 Docker）'} ==`)
{
  if (!USE_DOCKER) {
    /*
     * 一个 Node 进程 + 一个空数据目录 —— 这就是「不靠 Docker 也能部署」的全部。
     * 端口、数据目录、口令、YQ_DEMO=0 全靠环境变量，和 compose 里那份一一对应，
     * 所以第 2~6 步的判据两边是同一套。
     */
    const { spawn } = await import('node:child_process')
    localServer = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT,
        HOST: '127.0.0.1',
        YQ_DB: path.join(freshData, 'yuque.db'),
        YQ_ADMIN_PASSWORD: PASS,
        YQ_DEMO: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    localServer.stdout.on('data', () => {})
    localServer.stderr.on('data', () => {})
    ok(!!localServer.pid, `node 服务已起（pid=${localServer.pid}，端口 ${PORT}）`)
  } else {
    /*
     * ⚠️ NPM_REGISTRY 是**必需**的（这机器不通公网）。
     *    第一版没传 → `npm ci --registry=https://registry.npmjs.org` exit code 1
     *    → 镜像构建直接失败。而 DEPLOY.md 明明教了这个参数，
     *    但 compose 里**没有 args**，所以那个参数**传不进来**（2026-10-08 已修）。
     *    这一条现在顺带验证「参数真能传到构建阶段」。
     */
    const r = compose(['-f', 'docker-compose.yml', '-f', '_accept.override.yml', 'up', '-d', '--build'])
    const out = (r.stdout || '') + (r.stderr || '')
    ok(r.status === 0, 'compose up 成功（传了 NPM_REGISTRY）', out.slice(-240))
  }
}

console.log('\n== 第 2 步：起得来 + 播种的是干净库 ==')
let health = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  try {
    const res = await fetch(BASE + '/api/health')
    if (res.ok) { health = await res.json(); break }
  } catch { /* 还没起来 */ }
}
ok(!!health, '服务起得来，/api/health 返回 ok', health ? '' : '连不上')
if (health) {
  ok(health.users === 1, `恰好 1 个用户（真口令人播种的）：实得 ${health.users}`)
  ok(health.docs === 0, `0 篇文档（YQ_DEMO=0 不导演示数据）：实得 ${health.docs}`)
}

console.log('\n== 第 3 步：能用口令登录 ==')
{
  const bad = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'wrong-password-1' }),
  })
  ok(bad.status === 401, '错误口令被拒（401）', String(bad.status))

  const good = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: PASS }),
  })
  const j = await good.json().catch(() => null)
  ok(good.status === 200 && !!j?.token, '正确口令能登录并拿到令牌', String(good.status))

  if (j?.token) {
    const me = await fetch(BASE + '/api/auth/me', { headers: { authorization: 'Bearer ' + j.token } })
    const mj = await me.json().catch(() => null)
    ok(me.status === 200 && mj?.user?.account === 'admin', '拿令牌能取到自己的信息')
  }
}

console.log('\n== 第 4 步：空库里「普通同事」能不能建出第一条知识库 ==')
console.log('   （README 里说这是真实部署最容易撞的坑：演示数据是 seed.ts 直插、不在清理范围内，')
console.log('     而空库里普通成员建不出知识库 —— 那就是「部署完发现同事用不了」）')
{
  // 注册一个普通成员
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'colleague1', password: 'Hw5nQ8tZb2x', name: '新同事' }),
  })
  const rj = await reg.json().catch(() => null)
  ok(reg.status === 200 && !!rj?.token, '新同事能注册', String(reg.status))

  if (rj?.token) {
    // 建空间 → 建知识库 → 建一篇文档
    const H = { authorization: 'Bearer ' + rj.token, 'content-type': 'application/json' }
    const sp = await fetch(BASE + '/api/spaces', { method: 'POST', headers: H, body: JSON.stringify({ name: '新同事的空间' }) })
    const sj = await sp.json().catch(() => null)
    ok(sp.status < 400, '能建个人空间', String(sp.status))
    const spaceId = sj?.space?.id || sj?.id
    if (spaceId) {
      /*
       * ⚠️ 建知识库**没有独立路由**，走的是 `/api/sync/push` 推 books 行
       *    （server/sync.ts:557 `def.name === 'books'`）。
       *    第一版打 `/api/books` → 404「接口不存在」，那是我把接口名想当然了。
       */
      const push = await fetch(BASE + '/api/sync/push', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          upsert: {
            /*
             * ⚠️ `updatedAt` 是必填的（NOT NULL）。第一版漏了它，
             *    服务端把这条**拒了**并回了明确原因 —— 报错信息是好的，
             *    是我的探针数据不合法。别把这个记成产品缺陷。
             */
            books: [{
              id: 'acceptbook1', name: '我的知识库', spaceId,
              description: '验收用', avatar: '📚',
              createdAt: Date.now(), updatedAt: Date.now(),
            }],
          },
          remove: {},
        }),
      })
      /*
       * ⚠️⚠️ `push` 是**逐条判定**的：HTTP 200 **不代表每条都被接受**，
       *    被拒的条目在 `rejected` 里带回原因（sync.ts:1567-1572）。
       *    第一版只看 `status === 200` 就报「能建出知识库」——
       *    实际上它被拒了、库里 books=[]，而我把「报了 200」当成了「建成了」。
       *    这跟本项目反复栽的「只看表象不看实质」是同一族。
       */
      const pj = await push.json().catch(() => null)
      const rejected = pj?.rejected || []
      const applied = pj?.applied || []
      ok(push.status === 200 && rejected.length === 0 && applied.length > 0,
        '**空库里普通成员能建出第一条知识库**（且 push 没有静默拒绝任何条目）',
        `status=${push.status} applied=${JSON.stringify(applied).slice(0, 60)} ` +
        `rejected=${JSON.stringify(rejected).slice(0, 160)}`)
      if (rejected.length) {
        console.log('       被拒原因：', JSON.stringify(rejected).slice(0, 300))
      }

      // 建完应当能在 bootstrap 里看见。
      // ⚠️ 不猜字段路径 —— 第一版写 `bj?.data?.books` 拿到 0，还以为知识库没建成；
      //    实际上 push 返回 200 且本地能看到。先把结构打出来再断言。
      const bs = await fetch(BASE + '/api/bootstrap', { headers: H })
      const bj = await bs.json().catch(() => null)
      const topKeys = bj && typeof bj === 'object' ? Object.keys(bj) : []
      const dataKeys = bj?.data && typeof bj.data === 'object' ? Object.keys(bj.data) : []
      // 在整个返回里找 id 命中的地方（不管它挂在哪层）
      const found = JSON.stringify(bj).includes('acceptbook1')
      ok(found, '建出来的知识库出现在 bootstrap 返回里（换个设备刷新也还在）',
        `顶层键=${topKeys.join(',')} | data 键=${dataKeys.join(',')} | 命中=${found}`)
      if (!found) console.log('       bootstrap 返回：', JSON.stringify(bj).slice(0, 400))
    }
  }
}

console.log('\n== 第 5 步：公司部署第一天，同事打开看到什么 ==')
console.log('   （前面几步验的是「接口能不能用」；这一步验的是**界面** ——')
console.log('     空库打开来是不是一片白、有没有编造的团队活动、有没有可用的创建入口）')
{
  /*
   * ⚠️⚠️ 这一步是为了钉住 2026-10-08 修掉的那个缺陷：
   *
   *   工作台右侧的「团队动态」原来是一个**写死的 7 条数组**，对所有人、
   *   所有部署形态无条件渲染。全新空实例（users=1 / docs=0）上实测：
   *
   *     周砚 更新了文档《线上事故复盘集》· 12 分钟前
   *     陈小满 评论了《五分钟上手语雀》· 1 小时前
   *     苏晚 新建了知识库《团队手册》· 3 小时前
   *     林知远 发布了《2025-10 更新日志》· 昨天
   *     何舟 补充了《性能优化实战》· 昨天
   *
   *   **这五个人和这五篇文档在这个实例里一个都不存在**，
   *   而时间是写死的字符串（「12 分钟前」永远 12 分钟前）。
   *
   *   公司部署内网知识库的第一天，同事看到的第一个页面就是虚构的团队活动
   *   —— 这比缺功能严重得多，它直接摧毁对整个产品的信任。
   *
   * 为什么前几轮没抓到（值得记）：
   *   · AppData 字段普查 —— 它不是 store 字段，是字面量数组；
   *   · 接口审计 —— 它不发任何请求；
   *   · 硬编码数字普查 —— 我只扫了「\d+ 篇/个/条」，而这里全是人名+文档名。
   * 所以只能靠**真跑一个空实例去看**。静态判据覆盖不到这一类。
   */
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  try {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('.yq-login').count()) {
      await page.fill('.yq-login-card input[autocomplete="username"]', 'admin')
      await page.fill('.yq-login-card input[type="password"]', PASS)
      await page.click('.yq-login-submit')
      await page.waitForSelector('.yq-login', { state: 'detached', timeout: 30000 })
    }
    await page.waitForTimeout(1800)
    ok(!(await page.locator('.yq-login').count()), '管理员能登录并进入工作台')

    // 侧栏角标
    /*
     * ⚠️ **不能断言「一个非零角标都没有」** —— 第 4 步刚让新同事
     * 建了 acceptbook1，所以「知识库 1」是**真实的**。
     * 第一版写成 `badges.length === 0`，报出一条假红。
     *
     * 真正要拦的是「**本来该为 0 的那一类**报了非零」：
     * 这一轮实例里 docs=0 / 无评论 / 无关注 / 无收藏，
     * 所以文档、讨论、关注、收藏四个 tab 的角标都必须是 0。
     */
    const badges = await page.evaluate(() =>
      [...document.querySelectorAll('.yq-sidenav-item')]
        .map((e) => ({
          label: (e.querySelector('.yq-sidenav-text')?.textContent || '').trim(),
          badge: (e.querySelector('.yq-sidenav-count')?.textContent || '').trim(),
        }))
        .filter((x) => x.badge && x.badge !== '0'))
    console.log(`       实际角标：${JSON.stringify(badges)}`)
    const MUST_BE_ZERO = ['文档', '讨论', '关注', '收藏']
    const lying = badges.filter((b) => MUST_BE_ZERO.includes(b.label))
    ok(lying.length === 0,
      '空库上「文档/讨论/关注/收藏」四个 tab 都没有非零角标', JSON.stringify(lying))

    /*
     * ⚠️ 必须**先回到文档 tab**再断言 —— 第一版把这段放在 tab 循环之后，
     * 页面停在 `favorite` tab，那里根本没有 `.yq-feed`，
     * 于是量到「0 条、空态缺失」，看起来像修复没生效。
     * 「探针停错页」和「功能没修好」在输出里长得一模一样。
     */
    await page.goto(BASE + '/#/?tab=doc', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const feed = await page.evaluate(() => {
      const card = document.querySelector('.yq-feed')
      return {
        text: (card?.innerText || '').replace(/\s+/g, ' ').trim(),
        items: card ? card.querySelectorAll('.yq-feed-item:not(.yq-feed-empty)').length : -1,
        hasEmpty: !!card?.querySelector('.yq-feed-empty'),
      }
    })
    ok(feed.items === 0,
      '空库上「团队动态」一条真实动态都没有', `items=${feed.items} text=${feed.text.slice(0, 80)}`)

    // 那五个人在**这个实例里压根不存在**（users=1），出现即为编造
    ok(!/周砚|陈小满|苏晚|林知远|何舟/.test(feed.text),
      '「团队动态」里没有任何虚构人名', feed.text.slice(0, 120))

    ok(feed.hasEmpty || feed.items > 0,
      '动态区要么是真实数据，要么是写明原因的空态（不是空白）', feed.text.slice(0, 120))

    // 全局创建入口：存在，且有可访问名称（读屏用户不能只听到「按钮」）
    const entry = await page.evaluate(() => {
      const b = document.querySelector('.yq-new-btn')
      if (!b) return { exists: false, name: '' }
      return {
        exists: true,
        name: [b.textContent || '', b.getAttribute('aria-label') || '', b.getAttribute('title') || '']
          .join(' ').trim(),
      }
    })
    ok(entry.exists, '全局创建入口存在')
    ok(entry.exists && entry.name.length > 0,
      '全局创建入口有可访问名称（原来它只有一个 svg，读屏只报「按钮」）',
      entry.name || '(空)')
  } finally {
    await ctx.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

console.log('\n== 第 6 步：同事写一篇文档，换个会话重开还在 ==')
/*
 * ⚠️ 这一步与前面最大的不同：**它会写数据**。
 * 验收到第 5 步为止全是只读 —— 起得来、登得进、界面不编造。
 * 而同事部署完第一天做的第一件事是写一篇文档。
 * 「起得来但写不进去 / 写进去存不住」这类缺陷，前六步**一条都抓不到**，而且它全绿。
 * 部署当天运维看到「一切正常」，第二天同事反馈「我写的文档刷新就没了」——
 * 那种最要命的缺陷，恰恰是只读验收的结构性盲区。
 *
 * 验三件事：
 *   ① 界面里真打得出字（不是「接口能写、界面写不了」）
 *   ② 顶栏出现「已保存」（不是一直转圈，也不是压根没存）
 *   ③ 换一个**全新会话**（本地缓存是空的，≈ 换一台设备）重开，那串字还在
 *
 * ③ 才是「存住了」的真正判据：刷新一次只能证明没丢内存，
 * 换会话才能证明真的落到了服务端。
 */
/*
 * 第 8 步（重建容器后数据还在吗）要用到第 6 步建出来的 docId 与 MARK，
 * 而它们声明在下面那个 `{ }` 块里 —— **出了块就看不见**
 * （和下面 `chromium` 那条同一个家族：块作用域不会外泄，
 *  而这种错 `node --check` 查不出来）。
 * 所以先把两个外层变量挂出来，块内再赋值。
 */
let accDocId = '', accMark = ''
{
  const MARK = '部署验收标记-' + Date.now().toString(36)
  accMark = MARK

  /* --- 第一次会话：登录 → 建库 → 建文档 → 真打字 --- */
  /*
   * ⚠️ 必须**自己 import**：第 5 步那句 `const { chromium } = await import('playwright')`
   *    声明在它自己那个 `{}` 块里，出了块就没了。
   *    第一版直接用 chromium → 第 6 步一进来就 ReferenceError。
   *    （和「声明写在 try 内、catch 是兄弟作用域」是同一个家族：
   *      **块作用域不会外泄**，而这种错 `node --check` 查不出来。）
   */
  const { chromium } = await import('playwright')
  const b1 = await chromium.launch()
  const c1 = await b1.newContext({ viewport: { width: 1440, height: 900 } })
  const p1 = await c1.newPage()
  let docId = '', bookId = ''
  try {
    await p1.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p1.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p1.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p1.fill('.yq-login-card input[type="password"]', PASS)
    await p1.click('.yq-login-submit')
    await p1.waitForSelector('.yq-app', { timeout: 30000 })
    await p1.waitForTimeout(1200)

    // 用 store 建库建稿 —— 走的是同事点「+」时**同一条**代码路径
    const made = await p1.evaluate((mark) => {
      const s = window.__yqStore.getState()
      let book = (s.books || [])[0]
      if (!book) {
        const spaceId = (s.spaces || [])[0]?.id
        if (!spaceId) return { why: '没有空间' }
        book = s.createBook(spaceId, '验收知识库-' + mark, '部署验收建的')
      }
      const docId = s.createDoc(book.id, null, '验收文档-' + mark)
      return { bookId: book.id, docId }
    }, MARK)
    ok(!made.why && !!made.docId, '同事能建出知识库和文档（空部署第一天就能开工）', made.why || '')
  bookId = made.bookId || ''
  docId = made.docId || ''
  accDocId = docId
  if (!docId) throw new Error('建文档失败，后面的断言没有意义')

    await p1.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
    await p1.waitForSelector('.yq-block', { timeout: 25000 })
    await p1.waitForTimeout(1000)

    // 真打字：点进正文块，敲进去
    await p1.click('.yq-block').catch(() => {})
    await p1.waitForTimeout(300)
    await p1.keyboard.type(MARK, { delay: 8 })
    await p1.waitForTimeout(1800)
    const typed = (await p1.locator('.yq-editor').textContent().catch(() => '')) || ''
    ok(typed.includes(MARK), '界面上真打得出这串字（不是「接口能写、界面写不了」）',
      typed.replace(/\s+/g, ' ').slice(0, 90))

    const saved = await p1.waitForFunction(
      // ⚠️ 类名是 `.yq-tb-save`（Toolbar.tsx:452），第一版写的 `.yq-doc-save` 是**猜的**，
      //    于是这条恒假。判据红先去看真代码 —— 那一瞬间其实已经有旁证：
      //    「换个会话重开那串字还在」已经 PASS，说明保存**本来就是好的**，
      //    红的只是我找错了元素。
      () => (document.querySelector('.yq-tb-save')?.textContent || '').includes('已保存'),
      null, { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok(saved, '顶栏出现「已保存」（写完不是一直转圈，也不是压根没存）')
  } finally {
    await c1.close().catch(() => {})
    await b1.close().catch(() => {})
  }

  /* --- 换一个全新会话：没有本地缓存，≈ 换一台设备 --- */
  const b2 = await chromium.launch()
  const c2 = await b2.newContext({ viewport: { width: 1440, height: 900 } })
  const p2 = await c2.newPage()
  try {
    await p2.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p2.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p2.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p2.fill('.yq-login-card input[type="password"]', PASS)
    await p2.click('.yq-login-submit')
    await p2.waitForSelector('.yq-app', { timeout: 30000 })
    await p2.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
    await p2.waitForSelector('.yq-block', { timeout: 25000 })
    await p2.waitForTimeout(1800)
    const text2 = (await p2.locator('.yq-editor').textContent().catch(() => '')) || ''
    ok(text2.includes(MARK),
      '**换个会话（≈换设备）重开，那串字还在** —— 这才是「存住了」',
      text2.replace(/\s+/g, ' ').slice(0, 90))
  } finally {
    await c2.close().catch(() => {})
    await b2.close().catch(() => {})
  }
}


/*
 * ⚠️ 原来这里也是「第 6 步」—— 加上我新插入的那一步之后，报告里出现了**两个第 6 步**。
 *    一份验收报告里有两个「第 6 步」，读的人根本不知道自己在看哪一段。
 *    这类「编号重了但没人报错」的问题，恰恰是这个项目最在意的那一类：
 *    **一切看起来都正常，只是报告不再可信了。** 所以这里顺位成第 7 步。
 */
console.log('\n== 第 7 步：静态资源发得出去 ==')
{
  const html = await fetch(BASE + '/')
  const t = await html.text()
  ok(html.status === 200 && /<div id="root"|<script/i.test(t), '首页发得出去且是前端产物')
  const m = /src="([^"]*\.js)"/.exec(t)
  if (m) {
    // vite base 是 './'，所以 src 是 **相对路径**（./assets/…）——
    // 直接 BASE + m[1] 会拼成 `…:8080./assets/…`（少个斜杠）而报 Invalid URL。
    const jsUrl = new URL(m[1], BASE + '/').href
    const js = await fetch(jsUrl)
    const body = await js.text()
    ok(js.status === 200 && body.length > 1000, `JS 资源发得出去（${body.length} 字节）`, jsUrl)
  } else ok(false, '首页里找不到 JS 引用')
}

/*
 * 第 8 步：**重建容器之后数据还在吗**
 * ------------------------------------------------------------
 * 这条承诺写在 `docker-compose.yml` 的开头注释里（数据落在 ./data，
 * 重建容器不会丢知识库内容），但**从来没有被任何测试覆盖过**：
 * 原来这套验收只做 `up -d --build` → 干活 → `down`，
 * 重建之后**从没回头查过那篇文档还在不在**。
 *
 * 而「例行升级把公司整个知识库搞没了」是这个产品最不能出的事故 ——
 * 前 7 步全绿也救不了它，因为它们验的全是「这次启动」，
 * 没人验「上一次启动攒下来的东西」。
 *
 * 2026-10-12 先用探针真跑过一遍（11/11，标题与正文逐字都在），
 * 才把它收进这里。只在 Docker 那条路上验 —— node 直起没有容器可重建，
 * 而它验的正是「容器重建」这件事本身。
 */
console.log('\n== 第 8 步：重建容器后，知识库里的东西还在 ==')
if (USE_DOCKER) {
  const down = compose(['-f', 'docker-compose.yml', '-f', '_accept.override.yml', 'down'])
  ok(down.status === 0, '容器销毁（down）', ((down.stdout || '') + (down.stderr || '')).slice(-160))
  ok(fs.existsSync(freshData), '宿主数据目录还在 —— down 只删容器与网络，不删挂载目录')

  const up = compose(['-f', 'docker-compose.yml', '-f', '_accept.override.yml', 'up', '-d'])
  ok(up.status === 0, '容器重建（up -d）', ((up.stdout || '') + (up.stderr || '')).slice(-160))

  let back = false
  for (let i = 0; i < 60 && !back; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try { back = (await fetch(`${BASE}/api/health`)).ok } catch { /* 等 */ }
  }
  ok(back, '重建后服务又起来了')
  ok(!!accDocId, `（前置）记得住那篇文档的 id（${accDocId || '空' }）—— 取不到就没法验数据还在不在`)
  if (back && accDocId) {
    const tok2 = (await (await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: PASS }),
    })).json()).token
    const again = await (await fetch(`${BASE}/api/doc/${accDocId}`, {
      headers: { Authorization: `Bearer ${tok2}` },
    })).json()
    ok(!!again.doc, '★ 重建之前写的那篇文档还在', again.error || '')
    ok(JSON.stringify(again.doc?.blocks || []).includes(accMark),
      '正文也不是空壳 —— 验收标记那串字逐字还在')
  }
} else {
  ok(true, 'node 直起没有容器可重建（这一条只在 Docker 那条路上验）')
}

console.log('\n== 收尾：停掉验收实例 ==')
if (USE_DOCKER) {
  compose(['-f', 'docker-compose.yml', '-f', '_accept.override.yml', 'down'])
} else if (localServer) {
  /*
   * ⚠️ 必须**等进程真的退出**再删数据目录。
   * `kill()` 只是发信号；Windows 上进程还在时删它的库文件会失败，
   * 而 `rmSync(..., { force: true })` 把失败吞掉 —— 于是验收「通过了」，
   * `_accept_data` 却留在项目根，下一轮又拿它当「空目录」用。
   */
  try { localServer.kill() } catch {}
  await new Promise((res) => {
    if (localServer.exitCode !== null) return res()
    const t = setTimeout(() => { try { localServer.kill('SIGKILL') } catch {} }, 3000)
    localServer.once('exit', () => { clearTimeout(t); res() })
  })
}
if (USE_DOCKER && fs.existsSync(override)) fs.unlinkSync(override)
fs.rmSync(freshData, { recursive: true, force: true })
if (USE_DOCKER) ok(!fs.existsSync(override), 'override 文件已清掉，交付文件未被污染')
ok(!fs.existsSync(freshData), '验收用的数据目录已清掉')

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)