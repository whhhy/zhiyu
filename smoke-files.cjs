/**
 * 附件存储 / 历史版本 diff / 文档锁定 —— 冒烟测试
 *
 * 三段：
 *  1) 附件二进制存 IndexedDB（Block.data 里没有 base64）→ 刷新后仍能渲染
 *  2) 降级路径：mock 掉 indexedDB（隐私模式 / 老浏览器）→ 回退 data URL + 如实说明原因
 *  3) 历史版本 diff（快照 → 改内容 → 看差异 → 恢复）与文档锁定（A 锁 → B 只读 → A 解锁）
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

const PORT = 5100 + Math.floor(Math.random() * 300)
const BASE = `http://localhost:${PORT}`
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke-files')
fs.mkdirSync(OUT, { recursive: true })

/** 与 src/lib/idb.ts 的 DB_NAME / STORE 一致：这里就是要验「真在 IndexedDB 里」 */
const IDB_NAME = 'yuque-clone-attachments'
const IDB_STORE = 'attachments'

const errors = []
const steps = []

/* 1×1 透明 PNG：插进附件卡后能直接验 <img> 真的解码出来了 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  const check = async (label, fn) => {
    const before = errors.length
    try {
      await fn()
      const newErrs = errors.slice(before)
      steps.push({ label, ok: newErrs.length === 0, errs: newErrs })
      console.log(`${newErrs.length === 0 ? '✅' : '❌'} ${label}${newErrs.length ? '\n   ' + newErrs.join('\n   ') : ''}`)
    } catch (e) {
      steps.push({ label, ok: false, errs: [e.message] })
      console.log(`❌ ${label}\n   ${e.message}`)
      // 失败收尾：别把弹窗留在页面上挡住后面的点击
      // （成功时不动 —— 有几项检查是故意跨检查保持弹窗打开的）
      await closeModals(page)
    }
  }

  const closeModals = async (p) => {
    for (let i = 0; i < 3 && (await p.locator('.yq-modal-mask').count()); i++) {
      await p.locator('.yq-modal-close').first().click().catch(() => {})
      await p.waitForTimeout(150)
    }
  }

  /** store 挂到 window 上才算 app 起好了（main.tsx 里挂的） */
  const waitApp = async (p = page) => {
    await p.waitForFunction(() => !!window.__yqStore, null, { timeout: 15000 })
  }

  /** 新建一篇干净文档，避免把种子文档搞乱 */
  const freshDoc = async (title) => {
    await page.goto(`${BASE}/#/book/b1`, { waitUntil: 'domcontentloaded' })
    await waitApp()
    const id = await page.evaluate(
      ([t]) => window.__yqStore.getState().createDoc('b1', null, t, 'doc'),
      [title],
    )
    await page.goto(`${BASE}/#/book/b1/doc/${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    return id
  }

  /** 往文档尾部插一张卡片（不依赖斜杠菜单，那是 smoke-cards 的活） */
  const insertCard = (docId, cardId) =>
    page.evaluate(
      ([d, c]) => {
        const s = window.__yqStore.getState()
        const cur = s.docs[d]
        s.setDocBlocks(d, [...cur.blocks, {
          id: 'bk_' + c + '_' + Math.random().toString(36).slice(2, 7),
          type: 'card', text: '', data: { cardId: c },
        }])
      },
      [docId, cardId],
    )

  const readData = (docId, cardId) =>
    page.evaluate(
      ([d, c]) => {
        const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.data?.cardId === c)
        return b ? b.data : null
      },
      [docId, cardId],
    )

  /** 直接读 IndexedDB：这个 key 底下到底有没有 blob */
  const readIdb = (key) =>
    page.evaluate(
      ([dbName, store, k]) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open(dbName)
          req.onerror = () => reject(req.error || new Error('open 失败'))
          req.onsuccess = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(store)) { db.close(); return resolve(null) }
            const g = db.transaction(store, 'readonly').objectStore(store).get(k)
            g.onerror = () => reject(g.error)
            g.onsuccess = () => {
              const r = g.result
              db.close()
              resolve(
                r
                  ? {
                      isBlob: r.blob instanceof Blob,
                      size: r.blob.size,
                      type: r.blob.type,
                      name: r.name,
                      algo: r.algo,
                      key: r.key,
                    }
                  : null,
              )
            }
          }
        }),
      [IDB_NAME, IDB_STORE, key],
    )

  const idbCount = () =>
    page.evaluate(
      ([dbName, store]) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open(dbName)
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(store)) { db.close(); return resolve(0) }
            const c = db.transaction(store, 'readonly').objectStore(store).count()
            c.onerror = () => reject(c.error)
            c.onsuccess = () => { const n = c.result; db.close(); resolve(n) }
          }
        }),
      [IDB_NAME, IDB_STORE],
    )

  const cardSel = (cardId) => `.yq-kc-host[data-card-id="${cardId}"]`

  /**
   * 等图片真的解码出来（naturalWidth > 0）。
   * blob: URL 的解码是异步的：src 属性已经在了，像素未必到，
   * 直接读一次会偶发拿到 naturalWidth=0。
   */
  const imgDecoded = (p, sel) =>
    p.waitForFunction(
      (s) => {
        const el = document.querySelector(s)
        return !!el && el.complete && el.naturalWidth > 0
      },
      sel,
      { timeout: 8000 },
    )

  /* ==========================================================
     1. 附件 → IndexedDB
     ========================================================== */
  const DOC = await freshDoc('附件存储测试')
  await insertCard(DOC, 'file')
  await page.waitForSelector(`${cardSel('file')} .yq-kc-file-empty`)
  await page.setInputFiles(`${cardSel('file')} input[type=file]`, {
    name: '截图.png', mimeType: 'image/png', buffer: PNG,
  })
  await page.waitForSelector(`${cardSel('file')} .yq-kc-file-name`, { timeout: 5000 })

  await check('插入附件：Block.data 里没有 base64，只有元信息 + 指纹', async () => {
    const d = await readData(DOC, 'file')
    if (!d) throw new Error('卡片数据不见了')
    if (!d.key) throw new Error('没有 IndexedDB 指纹 key')
    if (d.stored !== true) throw new Error('stored 不是 true：' + JSON.stringify(d))
    const json = JSON.stringify(d)
    if (json.includes('base64')) throw new Error('Block.data 里还有 base64：' + json.slice(0, 200))
    if (d.dataUrl) throw new Error('不该有 dataUrl')
    if (d.name !== '截图.png' || !d.size) throw new Error('元信息不对：' + JSON.stringify(d))
  })

  await check('附件二进制真的在 IndexedDB 里（blob）', async () => {
    const d = await readData(DOC, 'file')
    const rec = await readIdb(d.key)
    if (!rec) throw new Error('IndexedDB 里没有这个 key：' + d.key)
    if (!rec.isBlob) throw new Error('存进去的不是 Blob')
    if (rec.size !== d.size) throw new Error(`字节数对不上：IDB ${rec.size} vs 文档 ${d.size}`)
    if (rec.type !== 'image/png' || rec.name !== '截图.png') throw new Error('元信息没存全：' + JSON.stringify(rec))
    if (!/^(sha256|fnv1a)-/.test(rec.key)) throw new Error('key 不是内容指纹：' + rec.key)
  })

  await check('渲染走 objectURL（blob:），不是内联 data URL', async () => {
    const src = await page.getAttribute(`${cardSel('file')} img.yq-kc-media`, 'src')
    if (!src || !src.startsWith('blob:')) throw new Error('img src 不是 blob URL: ' + src)
    await imgDecoded(page, `${cardSel('file')} img.yq-kc-media`)
    const href = await page.getAttribute(`${cardSel('file')} a.yq-kc-btn`, 'href')
    if (!href || !href.startsWith('blob:')) throw new Error('下载链接不是 blob URL')
  })

  await check('localStorage 存档里同样没有 base64', async () => {
    // store 的落盘是 400ms 防抖，先等它写完盘
    await page.waitForFunction(() => !!localStorage.getItem('yuque-clone-data-v1'), null, { timeout: 5000 })
    const has = await page.evaluate(
      ([d]) => {
        const raw = localStorage.getItem('yuque-clone-data-v1') || ''
        return JSON.stringify(JSON.parse(raw).docs[d] || {}).includes('base64')
      },
      [DOC],
    )
    if (has !== false) throw new Error('localStorage 里有 base64: ' + has)
  })

  await check('刷新后仍能渲染（二进制按 key 从 IndexedDB 取回）', async () => {
    await page.waitForTimeout(600) // 等 400ms 落盘防抖
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`${cardSel('file')} .yq-kc-file-name`, { timeout: 6000 })
    const name = (await page.textContent(`${cardSel('file')} .yq-kc-file-name`)).trim()
    if (name !== '截图.png') throw new Error('刷新后文件名不对: ' + name)
    await page.waitForSelector(`${cardSel('file')} img.yq-kc-media`, { timeout: 6000 })
    const src = await page.getAttribute(`${cardSel('file')} img.yq-kc-media`, 'src')
    if (!src.startsWith('blob:')) throw new Error('刷新后 src 不是 blob URL: ' + src)
    await imgDecoded(page, `${cardSel('file')} img.yq-kc-media`)
    await shot('01-attach-after-reload')
  })

  await check('本地音频 / 视频也走 IndexedDB', async () => {
    for (const c of ['localaudio', 'localvideo']) {
      await insertCard(DOC, c)
      await page.waitForSelector(`${cardSel(c)} .yq-kc-file-empty`)
      await page.setInputFiles(`${cardSel(c)} input[type=file]`, {
        name: c === 'localaudio' ? 'ding.wav' : 'clip.mp4',
        mimeType: c === 'localaudio' ? 'audio/wav' : 'video/mp4',
        buffer: Buffer.alloc(c === 'localaudio' ? 2048 : 4096, c === 'localaudio' ? 7 : 9),
      })
      await page.waitForSelector(`${cardSel(c)} .yq-kc-file-name`, { timeout: 6000 })
      const d = await readData(DOC, c)
      if (!d.key || d.stored !== true) throw new Error(`${c} 没进 IndexedDB: ${JSON.stringify(d)}`)
      if (JSON.stringify(d).includes('base64')) throw new Error(`${c} 的 Block.data 里有 base64`)
      const rec = await readIdb(d.key)
      if (!rec || !rec.isBlob) throw new Error(`${c} 在 IndexedDB 里找不到 blob`)
      const sel = c === 'localaudio' ? 'audio' : 'video'
      const src = await page.getAttribute(`${cardSel(c)} ${sel}.yq-kc-media`, 'src')
      if (!src.startsWith('blob:')) throw new Error(`${c} 的 src 不是 blob URL: ${src}`)
    }
  })

  await check('换源后旧的 objectURL 被 revoke（不泄漏 Blob）', async () => {
    const oldSrc = await page.getAttribute(`${cardSel('file')} img.yq-kc-media`, 'src')
    // 换一个内容不同的文件 → key 变了 → 旧 URL 必须被回收
    await page.setInputFiles(`${cardSel('file')} input[type=file]`, {
      name: '截图2.png', mimeType: 'image/png',
      buffer: Buffer.concat([PNG, Buffer.from([0, 1, 2, 3])]),
    })
    await page.waitForFunction(
      (s, old) => {
        const el = document.querySelector(s)
        return !!el && el.complete && el.naturalWidth > 0 && el.getAttribute('src') !== old
      },
      `${cardSel('file')} img.yq-kc-media`,
      oldSrc,
      { timeout: 8000 },
    )
    const d = await readData(DOC, 'file')
    if (d.name !== '截图2.png') throw new Error('没换成新文件: ' + JSON.stringify(d))
    if ((await readIdb(d.key)) === null) throw new Error('新文件没进 IndexedDB')
    // 旧 URL 已 revoke：再取它应该失败
    const still = await page.evaluate(
      (u) => fetch(u).then(() => 'still-alive').catch(() => 'revoked'),
      oldSrc,
    )
    if (still !== 'revoked') throw new Error('旧 objectURL 没被 revoke：' + still)
    // 旧 URL 被回收后再 fetch 会失败，浏览器会打一条资源加载错误的 console 报错 ——
    // 这正是「确实被 revoke 了」的证据，属于预期内，从错误清单里剔除
    for (let i = errors.length - 1; i >= 0; i--) {
      if (/ERR_FILE_NOT_FOUND/.test(errors[i])) errors.splice(i, 1)
    }
  })

  await check('删除附件会回收 IndexedDB 里的二进制', async () => {
    const d = await readData(DOC, 'file')
    await page.click(`${cardSel('file')} .yq-kc-btn.is-danger`)
    await page.waitForSelector(`${cardSel('file')} .yq-kc-file-empty`, { timeout: 5000 })
    const rec = await readIdb(d.key)
    if (rec) throw new Error('附件删了，IndexedDB 里还留着孤儿 blob')
    const left = await idbCount()
    if (left !== 2) throw new Error('IndexedDB 里应只剩音频/视频两份，实际 ' + left)
  })

  /* ==========================================================
     2. 降级路径：IndexedDB 不可用
     ========================================================== */
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  // 模拟隐私模式 / 老浏览器：全局 indexedDB 直接没有
  await ctx2.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true })
  })
  const p2 = await ctx2.newPage()
  const errs2 = []
  p2.on('pageerror', (e) => errs2.push(e.message))
  const check2 = async (label, fn) => {
    const before = errs2.length
    try {
      await fn()
      steps.push({ label, ok: errs2.length === before, errs: errs2.slice(before) })
      console.log(`${errs2.length === before ? '✅' : '❌'} ${label}`)
    } catch (e) {
      steps.push({ label, ok: false, errs: [e.message] })
      console.log(`❌ ${label}\n   ${e.message}`)
    }
  }

  await check2('IndexedDB 不可用 → 降级成 data URL，并在卡片上说明原因', async () => {
    await p2.goto(`${BASE}/#/book/b1`, { waitUntil: 'domcontentloaded' })
    await waitApp(p2)
    const doc2 = await p2.evaluate(() => window.__yqStore.getState().createDoc('b1', null, '降级测试', 'doc'))
    await p2.goto(`${BASE}/#/book/b1/doc/${doc2}`, { waitUntil: 'domcontentloaded' })
    await p2.waitForSelector('.yq-block-text')
    await p2.evaluate(([d]) => {
      const s = window.__yqStore.getState()
      s.setDocBlocks(d, [...s.docs[d].blocks, {
        id: 'bk_file_' + Math.random().toString(36).slice(2, 7),
        type: 'card', text: '', data: { cardId: 'file' },
      }])
    }, [doc2])
    await p2.waitForSelector('.yq-kc-host[data-card-id="file"] .yq-kc-file-empty')
    await p2.setInputFiles('.yq-kc-host[data-card-id="file"] input[type=file]', {
      name: '兜底.txt', mimeType: 'text/plain', buffer: Buffer.from('fallback path'),
    })
    await p2.waitForSelector('.yq-kc-host[data-card-id="file"] .yq-kc-file-name', { timeout: 5000 })
    const d = await p2.evaluate(([x]) => {
      const b = window.__yqStore.getState().docs[x].blocks.find((y) => y.data?.cardId === 'file')
      return b.data
    }, [doc2])
    if (!d.dataUrl || !d.dataUrl.startsWith('data:text/plain;base64,')) {
      throw new Error('没有降级到 data URL: ' + JSON.stringify(d).slice(0, 160))
    }
    if (d.stored !== false) throw new Error('stored 应为 false')
    if (!d.degraded) throw new Error('没有写下降级原因')
    const note = await p2.textContent('.yq-kc-host[data-card-id="file"] .yq-kc-note.is-warn')
    if (!note || !note.includes('降级')) throw new Error('UI 上没有如实说明降级：' + note)
    if (!note.includes('IndexedDB')) throw new Error('降级原因里没提 IndexedDB：' + note)
    await p2.screenshot({ path: `${OUT}/02-degraded.png` })
    // 降级路径刷新后也还得能渲染
    await p2.waitForTimeout(600)
    await p2.reload({ waitUntil: 'domcontentloaded' })
    await p2.waitForSelector('.yq-kc-host[data-card-id="file"] .yq-kc-file-name', { timeout: 6000 })
    const href = await p2.getAttribute('.yq-kc-host[data-card-id="file"] a.yq-kc-btn', 'href')
    if (!href.startsWith('data:')) throw new Error('刷新后降级附件的下载链接不对: ' + href)
  })
  await ctx2.close()

  /* ==========================================================
     3. 历史版本 diff
     ========================================================== */
  const H = await freshDoc('历史版本测试')
  await page.evaluate(([d]) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [
      { id: 'bk_h1', type: 'h1', text: '版本测试' },
      { id: 'bk_p1', type: 'p', text: '第一段：这一行后面会被改掉。' },
      { id: 'bk_p2', type: 'p', text: '第二段保持不变。' },
    ])
  }, [H])
  // 刷新一次：挂载时的「打开文档」快照就拍到了这 3 个块
  await page.waitForFunction(() => !!localStorage.getItem('yuque-clone-data-v1'), null, { timeout: 5000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-block-text')

  /** 从 store 里按 id 定位某一版快照（不靠列表下标，避免顺序假设） */
  const versionsOf = (docId) =>
    page.evaluate(
      ([d]) => (window.__yqStore.getState().docs[d].versions || []).map((v) => ({
        id: v.id, at: v.at, label: v.label, by: v.editorName, n: (v.blocks || []).length,
        text: (v.blocks || []).map((b) => b.text).join('|'),
      })),
      [docId],
    )

  await check('打开文档即产生快照（含 blocks / at / editorName）', async () => {
    await page.waitForTimeout(500)
    const vs = await versionsOf(H)
    if (vs.length < 1) throw new Error('没有快照')
    const v = vs[0]
    if (v.n !== 3) throw new Error('快照块数不对: ' + v.n)
    if (!v.at || !v.by) throw new Error('快照缺 at / editorName')
    if (!v.text.includes('第一段')) throw new Error('快照内容不对: ' + v.text)
  })

  await check('连续输入的自动保存按时间合并（不刷满版本列表）', async () => {
    const before = (await versionsOf(H)).length
    const last = page.locator('.yq-block-text').last()
    await last.click()
    await page.keyboard.press('End')
    await page.keyboard.type('（新增一句）')
    await page.waitForTimeout(1000)
    if (!(await page.textContent('.yq-doc-content')).includes('（新增一句）')) throw new Error('字没打进去')
    // 第一处改动总要留下快照（上一版是「打开文档」，不是自动保存）
    const after = (await versionsOf(H)).length
    if (after - before !== 1) throw new Error(`首次改动应存 1 版，实际 ${before} → ${after}`)

    // 合并窗口内再改一次：不该再涨（否则 8 个位置很快就被同一段内容占满）
    await page.keyboard.type('（再来一句）')
    await page.waitForTimeout(1000)
    if (!(await page.textContent('.yq-doc-content')).includes('（再来一句）')) throw new Error('第二段字没打进去')
    const after2 = (await versionsOf(H)).length
    if (after2 !== after) throw new Error(`合并窗口没生效：${after} → ${after2}`)
  })

  await check('「立即存一版快照」显式存版（不受合并窗口限制）', async () => {
    const before = (await versionsOf(H)).length
    const id = await page.evaluate(
      ([d]) => window.__yqStore.getState().addDocVersion(d, '快照'),
      [H],
    )
    if (!id) throw new Error('显式快照没存成')
    const after = await versionsOf(H)
    if (after.length !== before + 1) throw new Error(`版本数没涨：${before} → ${after.length}`)
    if (after[0].label !== '快照') throw new Error('label 不对: ' + after[0].label)
    if (!after[0].text.includes('（新增一句）')) throw new Error('快照里没有刚写的内容')
    if (after[0].n !== 3) throw new Error('快照块数不对: ' + after[0].n)
  })

  /** 打开历史版本弹窗 */
  const openHistory = async () => {
    await page.click('.yq-doc-more')
    await page.waitForSelector('.yq-menu-item:has-text("历史版本")', { timeout: 5000 })
    await page.click('.yq-menu-item:has-text("历史版本")')
    await page.waitForSelector('.yq-history-split', { timeout: 5000 })
  }

  // 基准版 = 3 个块、还没有那句新增文字的那一版（待恢复的目标）。
  // 不能简单取「最旧一版」：新建文档时还有一个只有 1 个块的空壳快照。
  const BASE_V = (await versionsOf(H)).find((v) => v.n === 3 && !v.text.includes('（新增一句）'))
  if (!BASE_V) throw new Error('找不到基准版本')
  const OLDEST = BASE_V

  await check('历史版本：块级 diff 能看出修改 / 新增 / 未变', async () => {
    await openHistory()
    const n = await page.locator('.yq-history-item').count()
    if (n < 2) throw new Error('版本列表项太少: ' + n)
    if ((await page.locator(`.yq-history-item[data-version-id="${OLDEST.id}"]`).count()) !== 1)
      throw new Error('版本列表里找不到 store 里那一版')
    // 选最旧的一版 → 与「当前内容」比（最新的那版等于当前内容，比不出东西）
    await page.click(`.yq-history-item[data-version-id="${OLDEST.id}"] .yq-history-pick`)
    await page.waitForSelector('.yq-diff-row', { timeout: 5000 })
    const mod = page.locator('.yq-diff-row[data-status="mod"]')
    if ((await mod.count()) < 1) throw new Error('没有「修改」行')
    if ((await page.locator('.yq-diff-ins').count()) < 1) throw new Error('没有标出新增的文字')
    if ((await page.locator('.yq-diff-del').count()) < 1) throw new Error('没有标出被改掉的文字')
    const row = await mod.first().innerText()
    if (!row.includes('（新增一句）')) throw new Error('修改行里看不到新内容: ' + row)
    if ((await page.locator('.yq-diff-row[data-status="same"]').count()) < 1)
      throw new Error('未变的块没标出来')
    // 统计栏与行数对得上
    const stat = (await page.textContent('.yq-diff-stat')).replace(/\s/g, '')
    const rows = await page.locator('.yq-diff-row').count()
    const sum = stat.match(/\+(\d+)/)[1] * 1 + stat.match(/−(\d+)/)[1] * 1 + stat.match(/~(\d+)/)[1] * 1
    const same = await page.locator('.yq-diff-row[data-status="same"]').count()
    if (sum + same !== rows) throw new Error(`统计与行数对不上: ${stat} same=${same} rows=${rows}`)
    await page.screenshot({ path: `${OUT}/03-diff.png` })
  })

  await check('两个版本互相比（不再是「当前」当对比项）', async () => {
    const newest = (await versionsOf(H)).find((v) => v.n === 3 && v.text.includes('（新增一句）'))
    await page.click(`.yq-history-item[data-version-id="${newest.id}"] .yq-history-pick`)
    await page.waitForTimeout(300)
    const head = (await page.textContent('.yq-diff-head')).replace(/\s/g, '')
    if (head.includes('当前内容')) throw new Error('选满两个版本后还拿「当前」当对比项: ' + head)
    if ((await page.locator('.yq-diff-row[data-status="mod"]').count()) < 1)
      throw new Error('两版之间应能看出修改')
    // 只看差异：未变的行要消失
    const before = await page.locator('.yq-diff-row').count()
    await page.click('.yq-diff-only input')
    await page.waitForTimeout(200)
    const after = await page.locator('.yq-diff-row').count()
    if (after >= before) throw new Error(`「只看差异」没过滤: ${before} → ${after}`)
  })

  await check('恢复到该版本：正文真的回去了，且这一步可回退', async () => {
    await page.click(`.yq-history-item[data-version-id="${OLDEST.id}"] .yq-history-restore`)
    await page.waitForSelector('.yq-history-split', { state: 'detached', timeout: 5000 })
    await page.waitForTimeout(500)
    const text = await page.textContent('.yq-doc-content')
    if (text.includes('（新增一句）')) throw new Error('恢复后新增的内容还在')
    if (!text.includes('第一段')) throw new Error('恢复后原有内容丢了')
    const blocks = await page.evaluate(([d]) => window.__yqStore.getState().docs[d].blocks, [H])
    if (blocks.length !== 3) throw new Error('恢复后块数不对: ' + blocks.length)
    if (blocks[1].text !== '第一段：这一行后面会被改掉。') throw new Error('恢复的不是那一版的块: ' + blocks[1].text)
    // 恢复前的状态仍留在版本列表里（要么新存了「恢复前」，要么早已被自动保存记下）
    const vs = await versionsOf(H)
    if (!vs.some((v) => v.text.includes('（新增一句）'))) throw new Error('恢复前的内容没有被记下来，退不回去')
  })

  await check('块级 diff 能标出「新增 / 删除」的块', async () => {
    const prevId = (await versionsOf(H))[0].id
    // 改结构：砍掉第三段，换成一段全新的
    await page.evaluate(([d]) => {
      const s = window.__yqStore.getState()
      const blocks = s.docs[d].blocks
      s.setDocBlocks(d, [blocks[0], blocks[1], { id: 'bk_new_1', type: 'p', text: '全新的一段。' }])
      s.addDocVersion(d, '快照')
    }, [H])
    await openHistory()
    await page.click(`.yq-history-item[data-version-id="${prevId}"] .yq-history-pick`)
    await page.waitForSelector('.yq-diff-row', { timeout: 5000 })
    const add = await page.locator('.yq-diff-row[data-status="add"]').count()
    const del = await page.locator('.yq-diff-row[data-status="del"]').count()
    if (add < 1) throw new Error('新增的块没标出来')
    if (del < 1) throw new Error('删掉的块没标出来')
    const added = await page.locator('.yq-diff-row[data-status="add"]').first().innerText()
    if (!added.includes('全新的一段')) throw new Error('新增行内容不对: ' + added)
    const removed = await page.locator('.yq-diff-row[data-status="del"]').first().innerText()
    if (!removed.includes('第二段')) throw new Error('删除行内容不对: ' + removed)
    // 左侧空、右侧有 = 新增；左侧有、右侧空 = 删除
    const row = page.locator('.yq-diff-row[data-status="add"]').first()
    if ((await row.locator('.yq-diff-cell[data-side="old"].is-void').count()) !== 1)
      throw new Error('新增行左侧应为空')
    await page.click('.yq-modal-close')
    await page.waitForSelector('.yq-history-split', { state: 'detached', timeout: 5000 })
  })

  /* ==========================================================
     4. 文档锁定
     ========================================================== */
  await check('A 锁定文档', async () => {
    await page.evaluate(() => window.__yqStore.getState().switchUser('u1'))
    await page.waitForTimeout(300)
    const lock = await page.evaluate(([d]) => {
      window.__yqStore.getState().lockDoc(d)
      return window.__yqStore.getState().docs[d].lock
    }, [H])
    if (!lock || lock.memberId !== 'u1' || !lock.at) throw new Error('lock 字段不对: ' + JSON.stringify(lock))
    await page.waitForSelector('.yq-doc-lockbar.is-mine', { timeout: 5000 })
    const bar = (await page.textContent('.yq-doc-lockbar')).replace(/\s/g, '')
    if (!bar.includes('你锁定了此文档')) throw new Error('持有者看到的提示不对: ' + bar)
  })

  await check('自己锁自己也能正常编辑（不会被锁在外面）', async () => {
    const editable = await page.locator('[contenteditable="true"]').count()
    if (editable < 1) throw new Error('锁的持有者被锁成只读了（contenteditable 块数 ' + editable + '）')
    const last = page.locator('.yq-block-text').last()
    await last.click()
    await page.keyboard.type('（持锁者写的）')
    await page.waitForTimeout(700)
    const text = await page.textContent('.yq-doc-content')
    if (!text.includes('（持锁者写的）')) throw new Error('持锁者写不进去')
  })

  await check('B 打开：只读 + 顶部提示条「XX 锁定了此文档」', async () => {
    await page.evaluate(() => window.__yqStore.getState().switchUser('u2'))
    await page.waitForSelector('.yq-doc-lockbar', { timeout: 5000 })
    const bar = (await page.textContent('.yq-doc-lockbar')).replace(/\s/g, '')
    if (!bar.includes('林知远锁定了此文档')) throw new Error('提示条文案不对: ' + bar)
    if (!bar.includes('只读')) throw new Error('提示条没说明只读: ' + bar)
    if ((await page.locator('.yq-doc-lockbar-btn').count()) !== 0) throw new Error('B 不该看到解锁按钮')
    const editable = await page.locator('[contenteditable="true"]').count()
    if (editable !== 0) throw new Error(`B 还能编辑（还有 ${editable} 个可编辑块）`)
    // 菜单里的「解锁」对 B 是禁用的
    // （注意：菜单里那组「窄屏专属」在桌面端是 display:none，
    //   所以只能等具体的锁定项，不能等通用的 .yq-menu-item）
    await page.click('.yq-doc-more')
    const item = page.locator('.yq-menu-item:has-text("已锁定")')
    await item.waitFor({ state: 'visible', timeout: 5000 })
    const txt = await item.innerText()
    if (!txt.includes('林知远')) throw new Error('菜单项没写清谁锁的: ' + txt)
    const disabled = await item.getAttribute('disabled')
    if (disabled === null) throw new Error('B 看到的是可点的解锁项')
    await page.click('.yq-doc-more') // 收起菜单，别挡住下面的横幅
    await page.screenshot({ path: `${OUT}/04-locked-readonly.png` })
  })

  await check('A 解锁 → B 恢复可编辑', async () => {
    await page.evaluate(() => window.__yqStore.getState().switchUser('u1'))
    await page.waitForSelector('.yq-doc-lockbar.is-mine', { timeout: 5000 })
    await page.click('.yq-doc-lockbar-btn')
    await page.waitForSelector('.yq-doc-lockbar', { state: 'detached', timeout: 5000 })
    const lock = await page.evaluate(([d]) => window.__yqStore.getState().docs[d].lock, [H])
    if (lock !== null) throw new Error('lock 没被清掉: ' + JSON.stringify(lock))
    await page.evaluate(() => window.__yqStore.getState().switchUser('u2'))
    await page.waitForTimeout(400)
    const editable = await page.locator('[contenteditable="true"]').count()
    if (editable < 1) throw new Error('解锁后 B 仍然只读')
  })

  await browser.close()
  server.close()

  const failed = steps.filter((s) => !s.ok)
  console.log('\n' + '='.repeat(52))
  console.log(`通过 ${steps.length - failed.length}/${steps.length}`)
  if (failed.length) {
    console.log('\n失败项：')
    failed.forEach((f) => console.log(`  ✗ ${f.label}\n    ${f.errs.join('\n    ')}`))
  }
  console.log(`\n截图目录: ${OUT}`)
  process.exit(failed.length ? 1 : 0)
})()
