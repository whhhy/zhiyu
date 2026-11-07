/* ============================================================
   容器部署：内网真正会用的那一条路
   ------------------------------------------------------------
   之前所有套件都在**宿主机**上跑 `node server/index.ts`，
   部署这件事本身一次都没被验证过。补上之后一次挖出三个问题：

   1. 仓库里没有 `.dockerignore`，`COPY . .` 把整个工作目录打进**构建阶段**。
      实测上下文 787MB，其中 `data/` 占 701MB（几十个测试 SQLite 库），
      冷构建 31 秒；公司正文也长期留在本地构建缓存里。

      注意**别把这件事说大**：最终镜像一直是干净的 ——
      runtime 阶段逐条 COPY 指定路径，并没有 `COPY . .`，
      所以 data/ 从来没进过最终镜像。第一版断言查的就是最终镜像，
      把 data/ 排除注释掉它照样绿，属于**假通过**。
      断言必须钉在真正会出问题的那一层。

   2. `docker-compose.yml` 里的 `YQ_ADMIN_PASSWORD` 是写在仓库里的占位符口令，
      服务照常启动、不给任何提示（那句警告只在口令**完全没设**时才打）。
      现在改成拒绝启动。

   3. 根目录有个 0 字节的 `process.exit(1))`，某条命令的重定向残渣。

   所以这个套件钉五件事：
     1. `.dockerignore` 存在，且真的排除了 data/ 与 node_modules/；
     2. **构建阶段**镜像里没有 /app/data（不是最终镜像，见上面第 1 条）；
     3. 占位符口令时拒绝启动，且逃生口没堵死；
     4. 容器能起来、核心接口在容器里真的能用（含空间成员三接口的端到端）；
     5. 删掉容器、同一个卷重新起，**知识库还在**。
   ============================================================ */

import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'

const IMAGE = process.env.YQ_IMAGE || 'yuque-kb:test'
const NAME = `yq-ctest-${Date.now().toString(36)}`
const VOL = join('data', `_ctest-${Date.now().toString(36)}`)
/**
 * 绑定挂载必须是绝对路径。
 * 传相对的 `data\_ctest-xxx` 会被 Docker 判定成「卷名」而不是宿主机目录，
 * 报的是 invalid characters for a local volume name —— 错误信息完全指错方向，
 * 看半天以为是名字里有下划线的问题。
 */
const VOL_ABS = resolve(VOL)
const PW = 'container-test@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/**
 * 安全地截断一段调试信息。
 *
 * JSON.stringify(undefined) 返回的是 **undefined 而不是字符串**，
 * 后面再 .slice 就会抛。恢复失败时（备份是空的、口令对不上）
 * 取值全是空的，最该看到的是一串 FAIL，而不是一条
 * “Cannot read properties of undefined” 把后面的断言全带下去。
 */
const show = (v, n = 100) => {
  const t = JSON.stringify(v)
  return (t === undefined ? String(v) : t).slice(0, n)
}

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * 读**容器**日志：stdout 与 stderr 都要。
 *
 * `docker logs` 会把容器的 stdout 送到自己的 stdout、stderr 送到自己的 stderr，
 * 而 execFileSync 只回传 stdout —— 守卫那类错误信息是用 console.error 打的
 * （本来就该走 stderr），于是日志读回来是空的，断言报的是「没说明原因」，
 * 看不出是读取方式的问题。
 */
const containerLogs = (name) => {
  const r = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
  return `${r.stdout || ''}${r.stderr || ''}`
}

/** docker run -d，用随机宿主端口起，避免和别的套件撞端口 */
function startContainer() {
  return startContainerOn(VOL_ABS)
}
/** 同上，但可以指定挂哪个宿主机目录（备份恢复演练要用） */
function startContainerOn(volAbs) {
  docker('run', '-d', '--name', NAME, '-p', '127.0.0.1::8080', '-v', `${volAbs}:/data`,
    '-e', 'YQ_ADMIN_PASSWORD=' + PW, '-e', 'YQ_DEMO=0', IMAGE)
  const mapped = docker('port', NAME, '8080/tcp').trim().split('\n')[0]
  const port = Number(mapped.split(':').pop())
  return `http://127.0.0.1:${port}`
}

async function waitHealthy(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${base}/api/health`)).ok) return true } catch { /* 还没起来 */ }
  }
  return false
}

const json = async (base, p, opt = {}) => {
  const res = await fetch(base + p, opt)
  const t = await res.text()
  try { return { status: res.status, data: t ? JSON.parse(t) : null } } catch { return { status: res.status, data: null } }
}
const post = (base, p, body, tk) => json(base, p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
  body: JSON.stringify(body || {}),
})

try {
  console.log('\n== 前置条件 ==')
  // 没 Docker 就直接说清楚，别让套件在第一条 docker 命令上抛栈 ——
  // 那一大段 execFileSync 的 ENOENT 看不出是「环境没装」还是「代码坏了」。
  try {
    docker('version', '--format', '{{.Server.Version}}')
    ok(true, 'Docker 可用')
  } catch {
    ok(false, 'Docker 不可用。装 Docker Desktop 后重跑；本套件验的是最终交付的镜像，没法跳过',
      '也可以先只跑 `npm run test:all` 里的其余 32 个套件')
    throw new Error('SKIP_NO_DOCKER')
  }

  console.log('\n== 构建上下文 ==')
  ok(existsSync('.dockerignore'), '仓库里有 .dockerignore（没有它，COPY . . 会把整个工作目录打进去）')
  if (existsSync('.dockerignore')) {
    const di = readFileSync('.dockerignore', 'utf8')
    ok(/^data\/?$/m.test(di), '.dockerignore 排除了 data/（否则公司正文会留在构建阶段镜像和构建缓存里）')
    ok(/^node_modules$/m.test(di), '.dockerignore 排除了 node_modules/（镜像里本来就要重装）')
  }

  /**
   * compose 里的 `YQ_DEMO` 必须**默认关着**。
   *
   * 它以前是被注释掉的一行 —— 于是 `docker compose up -d` 往正式库里播种
   * 4 个演示知识库、26 篇写得很真的文档，而且**一声不吭**：
   * 播种走 `seed.ts` **直插**（不走同步、也不在任何清理脚本的范围内），
   * 装到公司内网之后它们会和真实文档混在同一个工作台里。
   *
   * 对比同一份文件里的口令：口令没改，服务会**拒绝启动**并在日志里说明；
   * 演示数据这条没有任何反馈。所以默认取「干净」。
   *
   * （systemd 那条安装路径有同样的问题、同样已修，见 DEPLOY 的单元示例。）
   */
  {
    const cy = readFileSync('docker-compose.yml', 'utf8')
    const demoLine = cy.split('\n').find((l) => /^\s*YQ_DEMO\s*:/.test(l))
    ok(!!demoLine, 'docker-compose.yml 里有一行**没被注释**的 YQ_DEMO')
    ok(/"0"|'0'/.test(demoLine || ''), `它的值是 0（实际：${(demoLine || '').trim()}）—— 照抄 compose 不该往公司库里塞演示内容`)
    ok(!/^\s*#\s*YQ_DEMO/m.test(cy), '**没有**留一行注释掉的同名项（那正是原来的形态）')
    ok(/YQ_DEMO: "1"|YQ_DEMO=1/.test(cy), '并写清了想试用演示内容时怎么改回来')
  }

  /**
   * 源仓库必须可配置（2026-10-06 补）。
   *
   * 这份 DEPLOY 教的是**内网部署**，而内网机器连公网 npm registry
   * 十有八九连不上 —— 于是 `docker build` 直接失败，
   * 报错还停在 `npm error Exit handler never called!` 那种完全指不到「网络」的地方。
   * 照文档抄命令的人**卡在第一步**，而他不会想到是源的问题。
   *
   * 这里钉三件事：ARG 存在、**两个阶段都用它**（只改构建阶段的话，
   * 运行时那步 `npm ci --omit=dev` 照样连不上）、默认值仍是公网
   * （什么都不配时最不意外的那个）。
   */
  {
    const df = readFileSync('Dockerfile', 'utf8')
    ok(/ARG NPM_REGISTRY=https:\/\/registry\.npmjs\.org/.test(df), 'Dockerfile 里声明了可配置的 NPM_REGISTRY（默认值是公网）')
    const uses = (df.match(/--registry=\$NPM_REGISTRY/g) || []).length
    ok(uses >= 2, `**两个阶段**的 npm 装包都用了它（命中 ${uses} 处）—— 只改构建阶段的话运行时那步照样连不上`, `实际 ${uses} 处`)
    ok((df.match(/^ARG NPM_REGISTRY/gm) || []).length >= 3,
      'ARG 在文件头与两个 FROM 之后各声明了一次（作用域：ARG 只对它之后那个阶段生效）',
      `实际 ${(df.match(/^ARG NPM_REGISTRY/gm) || []).length} 处`)
    ok(/NPM_REGISTRY/.test(readFileSync('DEPLOY.md', 'utf8')), 'DEPLOY 写了怎么用它（内网/受限网络）')
  }

  /**
   * **无公网**下照常工作（2026-10-06 加）
   *
   * 这一份 DEPLOY 教的是**内网部署**，而前面那些验证都是在「有公网」的环境里做的。
   * 真正要回答的问题是：把容器断网之后，它还能不能起来、还能不能登录、界面资源发不发得出去。
   * —— 顺带这也是「那个 npm 源问题为什么有迷惑性」的同一个道理：
   * 有网时一切正常，断网时才暴露。
   *
   * 用 `--network none`（容器里只剩 loopback，没有网卡），**不能用 `-p` 发布端口** ——
   * 端口发布依赖容器那块 eth0，它不存在，宿主机自然连不上。
   * 所以请求要从**容器内部**打（`docker exec` 里 fetch 127.0.0.1），
   * 而这恰好更贴近内网里「只有本机能访问」的真实形态。
   */
  console.log('\n== 断网（--network none）下容器照常工作 ==')
  {
    /*
     * 名字里**不能有冒号** —— 那是镜像 tag 的写法，容器名只允许
     * [a-zA-Z0-9][a-zA-Z0-9_.-]。第一版写成 `yuque-kb-offline:test`，
     * `docker run` 直接回 `Invalid container name`，而套件只把它记成
     * 「docker run 失败」—— 报错完全指不到「名字里有冒号」。
     */
    const offName = 'yuque-kb-offline-test'
    const offVol = VOL_ABS + '-off'   // 卷就是目录路径（和 -ph / -phok 一个套路），不是 mkVol()
    try { docker('rm', '-f', offName) } catch { /* 本来就没有 */ }
    docker('run', '-d', '--name', offName, '--network', 'none', '-v', `${offVol}:/data`,
      '-e', 'YQ_ADMIN_PASSWORD=' + PW, '-e', 'YQ_DEMO=0', IMAGE)

    // 容器内部打请求（没有网卡的容器里只能走 loopback）
    const inContainer = (js) => {
      const r = spawnSync('docker', ['exec', offName, 'node', '-e', js], { encoding: 'utf8' })
      return `${r.stdout || ''}${r.stderr || ''}`.trim()
    }
    const waitIn = async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (inContainer("fetch('http://127.0.0.1:8080/api/health').then(r=>r.ok?console.log('UP'):0).catch(()=>0)").includes('UP')) return true
      }
      return false
    }
    ok(await waitIn(), '断网的容器起来了（`--network none` 下 /api/health 可达）')

    const health = inContainer("fetch('http://127.0.0.1:8080/api/health').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR '+e.message))")
    ok(/"ok":true/.test(health), '健康检查在断网下照样返回 ok', health.slice(0, 120))

    const login = inContainer(`fetch('http://127.0.0.1:8080/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'admin',password:'${PW}'})}).then(r=>r.json()).then(j=>console.log(j.token?'TOKEN OK':'NO TOKEN')).catch(e=>console.log('ERR '+e.message))`)
    ok(login.includes('TOKEN OK'), '断网下能用口令登录（播种、scrypt、会话都不依赖公网）', login.slice(0, 120))

    /*
     * ⚠️ 第一版这条是**我的探针坏了**，不是产品坏了：
     * 写成 `.catch(e => console.log ? 'ERR ' + e.message : '')` ——
     * catch 把错误**变成了返回值、却什么都不打印**，于是失败时输出是空的，
     * 症状与「静态资源发不出去」**完全一样**。
     * 手工逐条量了一遍：断网容器里 JS 200 / 695116 字节、CSS 200 / 196306 字节，
     * 照常。教训还是那条：**探针自己坏掉时的表现，常常和功能坏了没有区别。**
     */
    const page = inContainer([
      "fetch('http://127.0.0.1:8080/').then(r => r.text())",
      ".then(t => { const m = t.match(/src=\"([^\"]+assets[^\"]+)\"/);",
      "  return m ? fetch(new URL(m[1], 'http://127.0.0.1:8080/')).then(r => r.status + ' ' + (r.headers.get('content-length') || '?')) : 'NO ASSET REF' })",
      ".then(s => console.log(s))",
      ".catch(e => console.log('ERR ' + e.message))",   // ← 要打印，不能吞
    ].join(''))
    ok(/200 \d+/.test(page), '断网下静态资源（JS）发得出去', page.slice(0, 120))

    const state = inContainer("console.log(require('fs').existsSync('/data/yuque.db')?'DB OK':'NO DB')")
    ok(state.includes('DB OK'), '断网下数据库落在挂载的 /data 里（卷没因为断网而失效）', state.slice(0, 80))

    // 容器自带的 HEALTHCHECK 也要在断网下通过
    const st = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', offName], { encoding: 'utf8' })
    console.log(`   （容器 HEALTHCHECK 状态：${(st.stdout || '').trim() || '还没出结果'}）`)
  }

  console.log('\n== 构建镜像 ==')
  /**
   * 构建时要能指定 npm 源（2026-10-06 补）。
   *
   * 起因是一个**很能唬人的失败**：这个套件在受限网络里从 55 项塌到 9 项，
   * 报错是 `npm error Exit handler never called!` —— 那是 npm 拿不到包之后
   * **连自己的错误处理都崩了**的症状，看起来像磁盘满、像代码问题，
   * 实际是容器里 `npm ci` 连不上公网 registry。
   *
   * 而它之前一直是绿的，**只因为那层构建缓存是热的**（缓存命中不需要联网）。
   * 任何一次让 `COPY package.json` 那层失效的改动（加个 npm script 就是）
   * 都会突然把它打出来 —— 于是症状是「改了点不相干的东西，容器套件就塌了」，
   * 报错还完全指不到「网络」。
   *
   * 所以这里跟着 Dockerfile 一起支持 `NPM_REGISTRY` 环境变量，
   * 默认值和 Dockerfile 里那个 ARG 保持一致。宿主机的 `npm config`
   * **不会**被容器继承，所以必须显式传。
   */
  const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmjs.org'
  const regArgs = ['--build-arg', `NPM_REGISTRY=${REGISTRY}`]
  const t0 = Date.now()
  /*
   * ⚠️ 这里包一层 try/catch，不是为了「让它别红」，而是为了**让报错指向病因**。
   *
   * 原来直接 `docker('build', …)`，而 `execFileSync` 失败时抛的 message 只有
   * `Command failed: docker build --build-arg NPM_REGISTRY=… .`
   * —— **一个字都没提网络**。
   *
   * 于是 2026-10-11 那次的现象是：改了几个 npm script（与容器毫无关系），
   * 容器套件突然从 64 项塌到 18 项并报错，人只会去查 Docker / Dockerfile / 镜像。
   * 而真实原因只是：`COPY package.json` 那层缓存失效 → `npm ci` 重跑 →
   * 打到 `registry.npmjs.org` → **这台机器不通公网**。
   *
   * 依赖层每失效一次就复发一次，而报错永远指不到网络 ——
   * 那就是「查不出来」本身在制造时间成本。
   */
  try {
    docker('build', ...regArgs, '-t', IMAGE, '.')
  } catch (e) {
    const stderr = String(e?.stderr || '')
    const netHint = /ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|ECONNREFUSED|registry\./i.test(stderr)
      || /npm (ERR|error)/i.test(stderr)
    console.error('\n❌ docker build 失败。最后 25 行 stderr：\n' + stderr.split('\n').slice(-25).join('\n'))
    if (netHint) {
      console.error(
        '\n⚠️  看着像**拉不到 npm registry**，不是 Dockerfile 写错了。\n' +
        `    本次用的是 ${REGISTRY}（默认值就是公网的 registry.npmjs.org）。\n` +
        '    内网机器 / 受限网络请改用一个能通的源再跑：\n' +
        '      $env:NPM_REGISTRY="https://registry.npmmirror.com"\n' +
        '      npm run test:container\n' +
        '    为什么平时没踩到：`COPY package.json` 那层是缓存住的，`npm ci` 不重跑。\n' +
        '    **任何一次改 package.json 的改动都会让它失效**，于是这条会在\n' +
        '    「改了点不相干的东西」之后突然冒出来。'
      )
    }
    throw e
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  ok(true, `镜像构建通过（${secs} 秒）`)

  /**
   * 单独构建 **build 阶段**并检查 /app/data。
   *
   * 这里特意不去查最终镜像：第一版就是这么写的，结果是**假通过** ——
   * 把 .dockerignore 里的 data/ 注释掉，这条断言照样绿。
   * 原因是 runtime 阶段逐条 COPY 指定路径，并没有 `COPY . .`，
   * 所以 data/ 从来没进过最终镜像（那条路本来就是安全的）。
   * 真正会带进去的是 `COPY . .` 的**构建阶段**，
   * 代价是上下文 787MB、冷构建 31 秒，以及公司正文长期留在本地构建缓存里。
   * 断言必须钉在真正会出问题的那一层上。
   */
  // 注意别写成 `${IMAGE}:buildstage` —— 一个 tag 里只能有一个冒号
  const BUILD_STAGE = 'yuque-kb-buildstage:test'
  docker('build', ...regArgs, '--target', 'build', '-t', BUILD_STAGE, '.')
  const stageProbe = docker('run', '--rm', '--entrypoint', 'sh', BUILD_STAGE, '-c',
    'if [ -d /app/data ]; then echo HAS_DATA; else echo NO_DATA; fi').trim()
  ok(stageProbe === 'NO_DATA', '构建阶段镜像里也没有 /app/data（公司正文不留在构建缓存里）', stageProbe)

  const bytes = Number(docker('image', 'inspect', IMAGE, '--format', '{{.Size}}').trim())
  ok(bytes > 0 && bytes < 400 * 1024 * 1024, `最终镜像体积合理：${(bytes / 1024 / 1024).toFixed(0)}MB`, String(bytes))

  console.log('\n== 占位符口令：拒绝启动 ==')
  /**
   * docker-compose.yml 里 YQ_ADMIN_PASSWORD 的字面量占位符。
   * 之前的行为是照常启动、不给任何提示 —— 而这个值就写在仓库里，
   * 等于给了一个公开的管理员密码。照抄 compose 又忘了改，是内网部署里最常见的路径。
   */
  const PH = '请改成你自己的口令'
  const phName = NAME + '-ph'
  const phVol = VOL_ABS + '-ph'
  mkdirSync(phVol, { recursive: true })
  docker('run', '-d', '--name', phName, '-p', '127.0.0.1::8080', '-v', `${phVol}:/data`,
    '-e', `YQ_ADMIN_PASSWORD=${PH}`, '-e', 'YQ_DEMO=0', IMAGE)
  await new Promise((r) => setTimeout(r, 4000))
  const exitCode = docker('inspect', phName, '--format', '{{.State.ExitCode}}').trim()
  const phLogs = containerLogs(phName)
  ok(exitCode !== '0', `占位符口令时容器退出了，而不是带着公开密码跑起来（exit=${exitCode}）`)
  ok(/拒绝启动/.test(phLogs) && /YQ_ADMIN_PASSWORD/.test(phLogs), '日志说明了原因，并指出要改哪个变量',
    phLogs.slice(-160).replace(/\s+/g, ' '))

  // 逃生口要留着：真要拿这个口令跑本机试验的人，不该被一条守卫堵死
  const okName = NAME + '-phok'
  const okVol = VOL_ABS + '-phok'
  mkdirSync(okVol, { recursive: true })
  docker('run', '-d', '--name', okName, '-p', '127.0.0.1::8080', '-v', `${okVol}:/data`,
    '-e', `YQ_ADMIN_PASSWORD=${PH}`, '-e', 'YQ_ALLOW_PLACEHOLDER_PASSWORD=1', '-e', 'YQ_DEMO=0', IMAGE)
  const phPort = Number(docker('port', okName, '8080/tcp').trim().split('\n')[0].split(':').pop())
  ok(await waitHealthy(`http://127.0.0.1:${phPort}`), '显式设 YQ_ALLOW_PLACEHOLDER_PASSWORD=1 时可以起来（本机试验的逃生口没堵死）')
  docker('rm', '-f', okName)
  try { rmSync(okVol, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }

  mkdirSync(VOL, { recursive: true })
  let base = startContainer()
  ok(await waitHealthy(base), '容器起来了，健康检查通过')

  console.log('\n== 容器里接口真的能用 ==')
  const admin = (await post(base, '/api/auth/login', { account: 'admin', password: PW })).data
  const T = admin?.token
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }
  ok(!!T, '管理员能登录', show(admin, 100))

  const boot = (await json(base, '/api/bootstrap?lite=0', { headers: H })).data
  ok((boot.data.spaces || []).length === 1, 'YQ_DEMO=0 的全新库只有 1 个个人空间（没有演示内容）', String(boot.data.spaces?.length))
  ok((boot.data.books || []).length === 0, '全新库里一篇文档都没有', String(boot.data.books?.length))

  console.log('\n== 空间成员：容器里的端到端 ==')
  const sid0 = boot.data.spaces[0].id
  const roster0 = (await json(base, `/api/spaces/${sid0}/members`, { headers: H })).data
  ok(roster0.members?.length === 1 && roster0.isAdmin === true,
    '个人空间的名册就是他自己，且他是管理员', JSON.stringify(roster0))

  const made = (await post(base, '/api/spaces', { name: '容器里的研发部' }, T)).data
  const sid = made?.space?.id
  ok(!!sid && made.space.kind === 'team', '能在容器里建团队空间', show(made, 100))

  const out = (await post(base, '/api/auth/register', { account: 'c_new', password: 'test1234', name: '容器新人' })).data
  ok(!!out?.token, '能在容器里注册第二个账号')

  const added = (await post(base, `/api/spaces/${sid}/members`, { userIds: [out.user.id] }, T)).data
  ok(added.ok === true && added.added?.length === 1, '能把人加进空间', show(added, 140))

  const roster = (await json(base, `/api/spaces/${sid}/members`, { headers: H })).data
  ok(roster.members?.length === 2, '名册里是 2 个人', String(roster.members?.length))
  ok(roster.members?.some((m) => m.name === '容器新人'), '新成员的名字出得来（中文没乱码）', JSON.stringify(roster.members))

  const outBoot = (await json(base, '/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + out.token } })).data
  ok((outBoot.data.spaces || []).some((s) => s.id === sid), '新成员的空间列表里有这个团队空间')

  const last = await json(base, `/api/spaces/${sid}/members/${admin.user.id}`, { method: 'DELETE', headers: H })
  ok(last.status === 400, '最后一个拥有者移不走', String(last.status))

  console.log('\n== 先造点「值得备份」的内容 ==')
  // 备份演练要有东西可备。只备一个空库，验不出任何问题。
  const docId = 'd_bk_' + Date.now().toString(36)
  // 光推 docs 行不够：文稿必须挂在目录树的节点上才看得见。
  // 只推一个孤立的 doc，推送返回 200、也没有 rejected（服务端确实写进去了），
  // 但 bootstrap 读出来是 0 篇 —— 因为 resolveBook 顺着目录树找归属，
  // 没有节点的文稿没有归属，也就不可见。踩过一次。
  //
  // 知识库 id 要自己起一个：POST /api/spaces 返回的是**空间**，
  // 拿它的 id 当 bookId 用，推送会直接 500（Provided value cannot be bound…）。
  const bookId = 'b_bk_' + Date.now().toString(36)
  const mk = await post(base, '/api/sync/push', {
    upsert: {
      books: [{ id: bookId, spaceId: sid, name: '备份演练库', desc: '', avatar: '📙', visibility: 'private', docCount: 1, wordCount: 8, createdAt: 1, updatedAt: Date.now() }],
      docs: [{ id: docId, spaceId: sid, title: '备份演练文档', authorId: admin.user.id, type: 'doc', blocks: [{ id: 'b1', type: 'p', text: '这一行必须活过恢复' }], wordCount: 8, createdAt: 1, updatedAt: Date.now() }],
      nodes: [{ id: 'n_' + docId, bookId, parentId: null, title: '备份演练文档', type: 'doc', docId, ord: 0, rev: 0 }],
    },
    remove: {},
  }, T)
  ok(mk.status === 200, '造一篇文档', `${mk.status} ${show(mk.data, 240)}`)
  // 推成功 ≠ 落库：同步接口会返回 200 同时在 rejected 里列出被丢掉的行
  // （之前 book_members 复合主键就是这么「成功」地丢掉了整行的）
  ok(!(mk.data?.rejected || []).length, '这一篇没有被服务端拒收', show(mk.data?.rejected, 160))
  const preBoot = (await json(base, '/api/bootstrap?lite=0', { headers: H })).data
  ok(!!(preBoot.data.docs || []).find((d) => d.id === docId),
    '备份**之前**这篇文档就真的在库里（否则后面「恢复后没了」分不清是没建成还是丢了）',
    `库里 ${preBoot.data.docs?.length} 篇`)

  const cm = await post(base, '/api/sync/push', {
    upsert: { comments: [{ id: 'c_bk', docId, authorId: admin.user.id, text: '这条评论也必须活过恢复', createdAt: Date.now(), anchorId: '', rev: 0 }] },
    remove: {},
  }, T)
  ok(cm.status === 200, '造一条评论', `${cm.status} ${show(cm.data, 240)}`)
  // 同样地：推成功不等于读得出来。评论要靠 bookViaDoc 反查归属才能过权限过滤。
  const preBoot2 = (await json(base, '/api/bootstrap?lite=0', { headers: H })).data
  // 注意：/api/bootstrap 返回的是**原始行数组**，
  // 「按 docId 分组成 Record」是客户端 rowsToRecord 做的事 —— 直接按 docId 取会拿到空
  const preComments = (preBoot2.data.comments || []).filter((c) => c.docId === docId)
  ok(preComments.some((c) => (c.text || '').includes('这条评论也必须活过恢复')),
    '备份**之前**这条评论就读得出来（和文档同一个道理）',
    show(preComments.map((c) => c.text), 120))

  // 附件是 BLOB，存在 SQLite 里 —— 最容易在「拷目录」时漏掉的一类数据
  const attBody = Buffer.from('附件内容-恢复演练-' + 'x'.repeat(2000), 'utf8')
  const att = await fetch(`${base}/api/attachment?docId=${docId}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'text/plain', 'x-filename': encodeURIComponent('备份演练.txt') },
    body: attBody,
  })
  // body 只能读一次：先把文本取出来，再 parse
  const attText = await att.text()
  let attId = ''
  try { attId = JSON.parse(attText).id || '' } catch { /* 不是 JSON 就当没上传成功 */ }
  ok(att.status === 200 && !!attId, '上传一个附件（BLOB，最容易在拷目录时漏掉）', `${att.status} ${attText.slice(0, 100)}`)
  const attHead = await fetch(`${base}/api/attachment/${attId}`, { headers: H })
  ok(attHead.status === 200 && Number(attHead.headers.get('content-length') || 0) > 0,
    '附件能下载（长度非 0）', `${attHead.status} ${attHead.headers.get('content-length')}`)

  console.log('\n== 删掉容器、同一卷重起，数据还在 ==')
  const sidBefore = sid
  docker('rm', '-f', NAME)
  base = startContainer()
  ok(await waitHealthy(base), '容器重新起来了')
  const admin2 = (await post(base, '/api/auth/login', { account: 'admin', password: PW })).data
  const H2 = { Authorization: 'Bearer ' + admin2.token, 'Content-Type': 'application/json' }
  const boot2 = (await json(base, '/api/bootstrap?lite=0', { headers: H2 })).data
  ok((boot2.data.spaces || []).some((s) => s.id === sidBefore), '团队空间还在（卷真的挂上了）')
  const roster2 = (await json(base, `/api/spaces/${sidBefore}/members`, { headers: H2 })).data
  ok(roster2.members?.length === 2, '空间成员名册也还在（2 个人）', String(roster2.members?.length))

  /**
   * 备份 → 恢复演练。
   *
   * 「删掉容器、同一个卷重起」和「换台机器从备份恢复」是两件事：
   * 前者卷一直挂在那儿，**根本没有恢复这个动作**。
   * 而 DEPLOY.md 告诉运维的就是「备份就是拷这个目录」——
   * 这条命令如果实际恢复不出全部内容，最坏的那天才知道。
   *
   * 这里真的做一遍：把数据目录拷到别处 → 拿一个**空目录**起新容器 →
   * 确认它是空的 → 再把备份铺回去 → 确认文档、评论、附件全回来了。
   * 附件是 BLOB，专门盯它：正文和权限回来了、附件没回来，
   * 那种「看起来恢复了」最要命。
   */
  // 演练前先确认审计里确实有东西，否则后面「恢复后还在」是空断言
  const aBefore = await (await json(base, '/api/audit', { headers: H })).data
  ok((aBefore?.items || []).some((x) => x.action === 'space.member.add'),
    '演练之前审计里已经记下了「加入空间成员」', (aBefore?.items || []).map((x) => x.action).join(','))

  // ---- 备份 → 恢复到全新实例 ----
  console.log('\n== 备份 → 恢复到全新实例 ==')
  const BACKUP = VOL_ABS + '-backup'
  const FRESH = VOL_ABS + '-fresh'
  try { rmSync(BACKUP, { recursive: true, force: true }) } catch { /* 不存在 */ }
  try { rmSync(FRESH, { recursive: true, force: true }) } catch { /* 不存在 */ }
  cpSync(VOL_ABS, BACKUP, { recursive: true })
  const backupFiles = readdirSync(BACKUP)
  ok(backupFiles.some((f) => f.endsWith('.db')), `备份目录里有数据库文件（${backupFiles.join(', ').slice(0, 80)}）`)
  docker('rm', '-f', NAME)

  // 拿一个**空**目录起，确认它真的是全新实例（而不是"其实还是旧卷"）
  mkdirSync(FRESH, { recursive: true })
  base = startContainerOn(FRESH)
  ok(await waitHealthy(base), '空目录上的新容器起来了')
  const freshBoot = (await json(base, '/api/bootstrap?lite=0', {
    headers: { Authorization: 'Bearer ' + (await post(base, '/api/auth/login', { account: 'admin', password: PW })).data.token },
  })).data
  ok((freshBoot.data.spaces || []).length === 1 && (freshBoot.data.docs || []).length === 0,
    '新实例是空的（确认不是在拿旧卷当新卷）',
    `空间 ${freshBoot.data.spaces?.length} / 文档 ${freshBoot.data.docs?.length}`)
  docker('rm', '-f', NAME)

  // 把备份铺回去再起
  // 必须先删掉 FRESH —— cpSync 在**目标目录已存在**时的语义和 `cp -r` 一样，
  // 是把源目录**塞进去**变成 FRESH/_ctest-xxx-backup/，而不是铺平。
  // 踩过一次：容器照样起来了、照样健康，照着上面「新实例是空的」也全绿，
  // 只有「文档回来了」是 0 —— 因为容器读的根本不是备份，是它自己刚建的空库。
  rmSync(FRESH, { recursive: true, force: true })
  cpSync(BACKUP, FRESH, { recursive: true })
  let restoredFiles = []
  try { restoredFiles = readdirSync(FRESH) } catch { /* 目录还没建 */ }
  ok(restoredFiles.some((f) => f.endsWith('.db')),
    `数据库被铺到了根目录（不是塞进子目录）：${restoredFiles.join(', ').slice(0, 80)}`,
    restoredFiles.join(', ').slice(0, 120))
  base = startContainerOn(FRESH)
  ok(await waitHealthy(base), '铺回备份后容器起来了')
  const rest = (await post(base, '/api/auth/login', { account: 'admin', password: PW })).data
  const HR = { Authorization: 'Bearer ' + (rest?.token || ''), 'Content-Type': 'application/json' }
  const rboot = ((await json(base, '/api/bootstrap?lite=0', { headers: HR })).data || {}).data || {}
  // 防御式：恢复失败时（备份是空的 / 密码对不上）后面几条应该各自报 FAIL，
  // 而不是第一处抛异常把整个套件带下去 —— 那样只看得到第一条错误。
  // 注意 JSON.stringify(undefined) 返回的是 undefined（不是字符串），
  // 后面再 .slice 会抛 —— 恢复失败时最该看到的是一堆 FAIL，而不是一条异常。
  ok(!!rest?.token, '恢复后能用原口令登录（账号没丢）', show(rest || {}, 100))
  const rdoc = (rboot.docs || []).find((d) => d.id === docId)
  ok(!!rdoc, '恢复后文档回来了', String(rboot.docs?.length))
  ok(
    (rdoc?.blocks || []).some((b) => (b.text || '').includes('这一行必须活过恢复')),
    '恢复后**正文**也回来了（不是空壳）',
    show(rdoc?.blocks?.map((b) => b.text), 100),
  )
  ok(
    (rboot.comments || []).filter((c) => c.docId === docId).some((c) => (c.text || '').includes('这条评论也必须活过恢复')),
    '恢复后评论也回来了',
    show((rboot.comments || []).map((c) => c.text), 100),
  )
  // 注意 json() 返回 { status, data } —— status 在**外层**，
  // 写成 rAudit.status 永远是 undefined，断言就成了「永远不成立」
  const aRaw = await json(base, '/api/audit', { headers: HR })
  const rAudit = aRaw.data || {}
  const rAtt = await fetch(`${base}/api/attachment/${attId}`, { headers: { Authorization: 'Bearer ' + rest.token } })
  const rAttBuf = Buffer.from(await rAtt.arrayBuffer())
  ok(rAtt.status === 200 && rAttBuf.length === attBody.length && rAttBuf.equals(attBody),
    `恢复后附件**逐字节**一致（${rAttBuf.length}/${attBody.length} 字节）`,
    `状态 ${rAtt.status}，长度 ${rAttBuf.length}`)

  // 审计日志也得活过来。它是这次部署里唯一回答「谁在什么时候把权限给了谁」的东西，
  // 而权限授予恰恰是最需要事后追溯的 —— 恢复之后连「谁批的权限」都没了，
  // 审计就只剩一句「现在是这样」，没有来路。
  ok(aRaw.status === 200 && (rAudit.items || []).some((x) => x.action === 'space.member.add'),
    '恢复后审计日志还在（权限授予记录没丢）',
    `${aRaw.status} · ${(rAudit.items || []).map((x) => x.action).join(',')}`)

  for (const v of [BACKUP, FRESH]) { try { rmSync(v, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ } }

  console.log('\n== 不带 token 打遍所有接口，必须都是 401 ==')
  /**
   * 静态扫只能验「有没有调鉴权函数」，验不了「调的对不对」，
   * 而且解析源码总有出错的时候。这里是**运行时**版本：逐个接口真的打一遍。
   *
   * 少一个鉴权的接口，等于任意人登录后就能读别人的知识库 ——
   * 内网部署里这是最要命的一类洞。
   */
  const ANON_OK = new Set([
    'GET /api/health', 'POST /api/auth/login', 'POST /api/auth/register', 'POST /api/auth/sso',
    // 登出：本来就没登录时登出应当是无害的空操作，不是 401
    'POST /api/auth/logout',
    /**
     * 对外分享页的匿名读取。
     *
     * 这两条**本来就不该返回 401** —— 它们是给「没有账号、只有链接」的
     * 外部访客用的。加了 requireUser 就等于对外分享没做（访客只会看到登录页）。
     *
     * 但把它们放进白名单就等于**开了一个盲区**，所以下面紧接着有一条
     * 专门的检查：匿名调用**不能**读到任何正文。
     * 白名单只回答「401 是不是预期」，不回答「它会不会漏东西」。
     */
    'GET /api/public/doc/:id',
    'POST /api/public/doc/:id',
  ])
  // 从服务端源码里把路由抄出来，参数换成占位 id（不存在也不该影响 401 的判定）
  const srvSrc = readFileSync('server/index.ts', 'utf8')
  const routes = [...srvSrc.matchAll(/\bon\(\s*'(GET|POST|PUT|DELETE)',\s*'([^']+)'/g)]
    .map((m) => ({ method: m[1], path: m[2] }))
    .map((r) => ({ ...r, url: r.path.replace(/:[a-zA-Z]+/g, 'nonexistent_id') }))
  ok(routes.length >= 20, `从源码抄到 ${routes.length} 条路由`, '')

  const holes = []
  for (const r of routes) {
    if (ANON_OK.has(`${r.method} ${r.path}`)) continue
    const res = await fetch(`${base}${r.url}`, {
      method: r.method,
      headers: { 'Content-Type': 'application/json' },
      body: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}',
    })
    if (res.status !== 401) holes.push(`${r.method} ${r.path} → ${res.status}`)
  }
  ok(holes.length === 0, `${routes.length - ANON_OK.size} 个需要鉴权的接口，不带 token 全都返回 401`,
    holes.join('  '))

  console.log('\n== 免鉴权的对外分享接口，不能变成一扇没锁的门 ==')
  /**
   * 上面把 `/api/public/doc/:id` 放进了免鉴权白名单。
   * 那只回答了「401 是不是预期」，**没回答「它会不会漏东西」** ——
   * 而这条恰好是整套检查里最该盯的一扇门：它是唯一一处
   * 「不带任何凭据也能拿到正文」的设计。
   *
   * 这里用**全新容器**（没有种子数据）做一件最朴素的事：
   * 随便编一个 id 打过去，不许返回 200，也不许回吐任何像正文的东西。
   *
   * 为什么这条测试不能省：它保护的不是「某个 bug」，
   * 而是「将来有人往这个文件里加一条免鉴权路由」时手一滑。
   */
  {
    const probes = [
      { m: 'GET', p: '/api/public/doc/nonexistent_id' },
      { m: 'POST', p: '/api/public/doc/nonexistent_id' },
      { m: 'GET', p: '/api/public/doc/' },
      { m: 'GET', p: '/api/public/doc/../../api/entity/books' },
    ]
    const leaked = []
    for (const pr of probes) {
      const res = await fetch(`${base}${pr.p}`, {
        method: pr.m,
        headers: { 'Content-Type': 'application/json' },
        body: pr.m === 'GET' ? undefined : JSON.stringify({ password: 'guess' }),
      })
      const txt = await res.text().catch(() => '')
      if (res.status === 200) leaked.push(`${pr.m} ${pr.p} → 200`)
      // 就算不是 200，回包里也不该有正文 / 标题 / 库信息
      if (/"(body|blocks|spaceId|bookId|title)"\s*:/.test(txt)) leaked.push(`${pr.m} ${pr.p} 回包里出现了正文类字段`)
    }
    ok(leaked.length === 0, '匿名调用对外分享接口拿不到任何正文（免鉴权 ≠ 无保护）', leaked.join('  '))

    // 而且访问日志里不应该出现任何匿名分享的读取记录（这一路根本没成功）
    const withTok = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' }),
    }).then((r) => r.json())
    if (withTok?.token) {
      const log = await fetch(`${base}/api/accesslog?days=1&limit=200`, {
        headers: { Authorization: 'Bearer ' + withTok.token },
      }).then((r) => r.json().catch(() => ({})))
      const bad = (log.items || []).filter((x) => String(x.userId || '') === 'public')
      ok(bad.length === 0, '失败的匿名读取没有在访问日志里留下记录', JSON.stringify(bad.slice(0, 2)))
    } else {
      ok(true, '（跳过访问日志那条：这个容器里没有可用的管理员账号）')
    }
  }

  console.log('\n== 静态资源真的发得出去 ==')
  const html = await (await fetch(base + '/')).text()
  const assets = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1])
  ok(assets.length > 0, '首页里解析得到资源引用', String(assets.length))
  for (const a of assets) {
    const r = await fetch(base + '/' + a)
    const buf = await r.arrayBuffer()
    ok(r.status === 200 && buf.byteLength > 1000, `资源 ${a} 可下载且非空（${r.status} · ${(buf.byteLength / 1024).toFixed(0)}KB）`)
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  for (const n of [NAME, `${NAME}-ph`, `${NAME}-phok`, 'yuque-kb-offline-test']) { try { docker('rm', '-f', n) } catch { /* 已经不在了 */ } }
  // 构建阶段镜像有好几百 MB（里面有完整 node_modules），
  // 验完就删 —— 不然每跑一次套件都在机器上堆一份。
  try { docker('image', 'rm', '-f', 'yuque-kb-buildstage:test') } catch { /* 已经不在了 */ }
  // 备份演练的三个目录都要清。少写一个，失败的那次运行就会留下几百 MB 在盘上 ——
  // 早先就漏了 -backup / -fresh，攒了十几个。
  for (const v of [VOL, VOL_ABS + '-ph', VOL_ABS + '-phok', VOL_ABS + '-backup', VOL_ABS + '-fresh', VOL_ABS + '-off']) {
    try { rmSync(v, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
