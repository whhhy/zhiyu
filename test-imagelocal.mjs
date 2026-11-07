/**
 * 图片块在**本地形态**（纯静态托管）下能不能显示
 *
 * ============================================================
 * 这个套件钉的是一个「上传成功了，图却看不见」的 bug
 * ------------------------------------------------------------
 * 两种形态各有一种附件存储：服务端形态存 SQLite、key 是附件 id；
 * 本地形态存**本机 IndexedDB**、key 是内容指纹（`sha256-…`）。
 *
 * 图片块原来是这样取 URL 的：
 *
 *     const displayUrl = own ? (own.dataUrl || attachmentUrl(own.key)) : block.src
 *                                                       ^^^^^^^^^^^^^^
 *     attachmentUrl(key) 永远拼出 `/api/attachment/<key>`
 *
 * 而本地形态的 key 在**本机** IndexedDB 里，压根不在服务端。
 * 于是在**静态托管**（DEPLOY 写明支持的部署形态，没有 node 后端）
 * 那个地址必然 404，正文里就是一张**加载不出来的碎图**。
 *
 * 实测（纯静态托管，上传一张 1×1 的 PNG）：
 *     blockKey: sha256-c414cd0e…        ← 上传「成功」了，key 也写进块里了
 *     src:      /api/attachment/sha256-… ← 但拼的是服务端地址
 *     naturalWidth: 0                   ← 图根本没解码出来
 *     404:     /api/attachment/sha256-…
 *
 * 同一份代码里的 `FileCard` 一直用的是 `useAttachmentUrl`
 * （它会去 IndexedDB 取回 Blob 再造 objectURL），所以**文件卡好好的、
 * 图片块是坏的** —— 同一个概念两张卡，一张会修一张不会。
 * 而知识库里插图（截图）比拖附件常见得多。
 *
 * 为什么以前一直没被发现：
 *   · `test-image` 只在**服务端形态**下跑（它要 token），本地形态那条路从没测过
 *   · 演示数据里的图片块全是外链 `src`，走的是另一条分支
 * 这就是「**演示数据刚好没覆盖到的那条路径**」的又一个实例。
 * ============================================================
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, extname, normalize, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.IMAGELOCAL_PORT || await freePort()
const BASE = `http://localhost:${PORT}`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const cleanup = () => { try { srv.close() } catch { /* 已关 */ } }
process.on('exit', cleanup)

// 端口守卫：别人在跑的话这一轮会打在别人的服务上（这里尤其致命 —— 结果全绿，
// 而验的根本不是这份代码）
if (await fetch(`${BASE}/index.html`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧产物上，结果不可信。`)
  process.exit(1)
}

/**
 * 跑之前先确认 `dist/` 是按**当前源码**构建的。
 *
 * 这个套件验的是构建产物里的前端行为，所以产物旧了它就什么都没验 ——
 * 绿得毫无意义。`test:all` 会先构建，但单独 `npm run test:imagelocal`
 * 的人未必会，所以这里自己比一下 mtime。
 */
{
  const newest = async (dir, exts) => {
    const { readdir } = await import('node:fs/promises')
    let newestT = 0
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { newestT = Math.max(newestT, await newest(p, exts)); continue }
      if (exts && !exts.some((x) => e.name.endsWith(x))) continue
      newestT = Math.max(newestT, (await stat(p)).mtimeMs)
    }
    return newestT
  }
  const srcT = await newest('src', ['.ts', '.tsx'])
  const assets = 'dist/assets'
  const distT = existsSync(assets) ? await newest(assets, ['.js', '.css']) : 0
  if (distT < srcT) {
    console.log('   dist/ 比 src/ 旧，先重新构建（产物旧的话这个套件验的是上一版代码）…')
    const b = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { encoding: 'utf8' })
    if (b.status !== 0) { console.error('构建失败：\n' + (b.stdout || '') + (b.stderr || '')); process.exit(1) }
  }
}

const DIST = join(process.cwd(), 'dist')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

/** 只发静态文件，`/api/*` 一律 404 —— 这就是「静态托管」的真实效果 */
const srv = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0])
  if (path.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"接口不存在"}')
    return
  }
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '')
  const file = join(DIST, rel)
  try {
    const buf = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    try {
      const buf = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(buf)
    } catch { res.writeHead(404); res.end('not found') }
  }
})
await new Promise((r) => srv.listen(PORT, r))
ok(true, `静态托管已起在 ${BASE}（没有后端，/api/* 全 404）`)

const browser = await chromium.launch()
try {
  const p = await (await browser.newContext()).newPage()
  const notFound = []
  p.on('response', (r) => { if (r.status() >= 400) notFound.push(`${r.status()} ${r.url().slice(0, 90)}`) })

  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(2500)
  ok(true, '本地形态下能进应用（不需要登录，也没有后端）')

  const doc = await p.evaluate(() => Object.keys(window.__yqStore.getState().docs)[0])
  const book = await p.evaluate(() => window.__yqStore.getState().books?.[0]?.id)
  ok(!!doc, '有文档可编辑', String(doc))
  await p.goto(`${BASE}/#/book/${book}/doc/${doc}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(1500)

  console.log('\n== 上传一张图片（本地形态，落在 IndexedDB）==')
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await p.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_local_img', type: 'image', text: '', src: '', data: {} }])
  }, doc)
  await p.waitForTimeout(1200)
  ok(await p.locator('.yq-img-block-empty input[type="file"]').count() > 0, '出现了上传控件')

  await p.setInputFiles('.yq-img-block-empty input[type="file"]', {
    name: '本地图片.png', mimeType: 'image/png', buffer: PNG_1x1,
  })
  await p.waitForTimeout(3000)

  const info = await p.evaluate(() => {
    const img = document.querySelector('.yq-img-block img')
    const b = [...Object.values(window.__yqStore.getState().docs).flatMap((x) => x.blocks)]
      .find((y) => y.id === 'bk_local_img')
    return {
      hasImg: !!img,
      src: (img?.getAttribute('src') || '').slice(0, 80),
      naturalWidth: img?.naturalWidth ?? -1,
      alt: img?.getAttribute('alt') || '(空)',
      key: b?.data?.key || '',
      name: b?.data?.name || '',
    }
  })

  // 基准：上传确实成功了，二进制确实进了 IndexedDB
  ok(/^sha256-/.test(info.key) || /^fnv1a-/.test(info.key),
    '（基准）二进制进了**本机** IndexedDB，key 是内容指纹', info.key.slice(0, 50))
  ok(info.name === '本地图片.png', '（基准）文件名也写进块里了', info.name)

  ok(info.hasImg, '图片元素渲染出来了')
  ok(!/\/api\/attachment\//.test(info.src),
    '**src 不是服务端地址**（本地形态的 key 压根不在服务端）', info.src)
  ok(info.naturalWidth > 0,
    '**图片真的解码出来了**（naturalWidth > 0）—— 以前这里是 0：上传成功而图看不见',
    `naturalWidth=${info.naturalWidth}`)
  ok(info.alt === '本地图片.png',
    'alt 用文件名而不是空串（空串的话读屏软件什么都读不到）', info.alt)

  console.log('\n== 别把「图片没了」说成「一切正常」==')
  {
    const attNotFound = notFound.filter((x) => x.includes('/api/attachment/'))
    ok(attNotFound.length === 0, '整个过程没有一次 /api/attachment/ 404', JSON.stringify(attNotFound.slice(0, 2)))
  }
  {
    /*
     * 源码层面的保证：图片块不许再自己拼 `attachmentUrl(key)`。
     * 拼出来的一定是 `/api/attachment/…`，而本地形态的 key 在 IndexedDB 里。
     * 这条是「为什么会坏」的直接判据，比断言运行结果更早失败。
     */
    const src = (await import('node:fs')).readFileSync('src/components/doc/Editor.tsx', 'utf8')
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok(!/attachmentUrl\(/.test(bare),
      'ImageBlock 不再自己拼 attachmentUrl（拼出来的一定是服务端地址）')
    ok(/useAttachmentUrl\(/.test(bare), '改成了 useAttachmentUrl（和 FileCard 同一个入口）')
    ok(/onError=/.test(bare), '图片有 onError：加载失败会说明原因，而不是画一张碎图')
  }

  console.log('\n== 服务端形态没被改坏 ==')
  {
    // 断言它还在被引用（FileCard 那一侧），确保两边走的是同一个入口
    const card = (await import('node:fs')).readFileSync('src/components/cards/FileCard.tsx', 'utf8')
    ok(/useAttachmentUrl/.test(card), 'FileCard 仍然用 useAttachmentUrl（两边同源，不会再一张好一张坏）')
  }

  console.log('\n== 二进制真没了要说出来，不能画一张碎图 ==')
  {
    /*
     * 这一段是有端到端断言的，所以破坏对照才敢拆它。
     * 触发方式很直接：把 IndexedDB 里那条记录删掉，等于「清过浏览器数据」。
     * FileCard 早就为这种情况写了提示，图片块以前没有 ——
     * 同一个概念两张卡，一张会解释一张不会。
     */
    const deleted = await p.evaluate((key) => new Promise((res) => {
      const req = indexedDB.open('yuque-clone-attachments', 1)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('attachments', 'readwrite')
        const d = tx.objectStore('attachments').delete(key)
        d.onsuccess = () => res(true)
        d.onerror = () => res(false)
      }
      req.onerror = () => res(false)
    }), info.key)
    ok(deleted, '把 IndexedDB 里那条二进制删掉（模拟清过浏览器数据）', String(deleted))

    // 换源触发重新取：改一下 data 里的 key 之外的东西不行，
    // 所以直接刷新页面 —— 那样最接近「用户关掉浏览器重开」
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 25000 })
    await p.waitForTimeout(2500)

    const state = await p.evaluate(() => {
      const txt = document.body.innerText
      const img = document.querySelector('.yq-img-block img')
      return {
        saysMissing: /图片已丢失/.test(txt),
        saysWhy: /附件被删|另一个实例/.test(txt),
        stillRendersImg: !!img,
      }
    })
    ok(state.saysMissing, '界面上明说「图片已丢失」，而不是画一张碎图', JSON.stringify(state))
    ok(state.saysWhy, '并说清可能的原因（附件被删 / 来自另一个实例）', JSON.stringify(state))
    ok(!state.stillRendersImg, '没有再渲染一个必然失败的 <img>')
  }
} finally {
  await browser.close()
  cleanup()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
