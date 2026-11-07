/*
 * 整库导出 —— 直接调真函数验，不复算
 * ============================================================
 * ⚠️ 写这个套件时踩过一个坑，值得记下来：
 *   第一版我把导出逻辑在测试里**复算了一遍**（同样的规则写一遍 js），
 *   结果「复算能跑通」被当成了「真代码能跑通」。
 *   而真函数当时其实是**坏的**：它只认 `Record<string, Doc>`，
 *   传进服务端 bootstrap 的**数组**形态时一篇都导不出来 ——
 *   13 个节点 26 篇文档，导出 0 篇，**所有安全类断言全绿**。
 *
 * 所以这个套件只做一件事：**import 真的那个文件**，然后解开 zip 验内容。
 *
 * 判据也钉在**解开后的内容**上，不是「函数没抛异常」——
 * 「打包成功」和「导出的东西能用」是两件事。
 *
 * 用法：node --import ./server/alias-hooks.mjs --experimental-strip-types test-bookexport.mjs
 * （需要 8092 上有服务，那个套件不自己起）
 */
import http from 'node:http'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')) }
}

const req = (method, path, body, token) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : null
  const r = http.request({
    host: '127.0.0.1', port: 8092, path, method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  }, (res) => {
    const c = []
    res.on('data', (x) => c.push(x))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }))
  })
  r.on('error', (e) => resolve({ error: e.message, body: '' }))
  if (data) r.write(data)
  r.end()
})

const PORT = process.env.YQ_PORT || '8092'
req('GET', '/api/health', null).catch(() => {})

console.log('\n== 整库导出：解开 zip 验内容 ==')

{
  const { exportBookZip } = await import('./src/lib/book-export.ts')
  const { unzipAll } = await import('./src/lib/unzip.ts')

  const li = await req('POST', '/api/auth/login', { account: 'admin', password: process.env.YQ_ADMIN_PASSWORD || 'yuque@2026' })
  const token = JSON.parse(li.body).token || ''
  const boot = await req('GET', '/api/bootstrap?lite=0', null, token)
  const d = JSON.parse(boot.body).data || {}

  const book = (d.books || [])[0]
  const nodes = (d.nodes || []).filter((n) => n.bookId === book.id)
  const docs = d.docs || {}
  const all = () => true

  // ---- 1. 形态兼容：数组也要认 ----
  /*
   * 这一条是被真 bug 逼出来的：服务端 bootstrap 的 `docs` 是**数组**，
   * 客户端 store 里是 `Record<string, Doc>`。只认后者的话，
   * 导出「成功」但一篇都没有，而安全类断言全绿。
   */
  const rArr = exportBookZip(book, nodes, docs, all)
  const rRec = exportBookZip(book, nodes, Object.fromEntries(docs.map((x) => [x.id, x])), all)
  ok(rArr.docCount === rRec.docCount && rArr.docCount > 0,
    '**两种 docs 形态都能导出**（服务端是数组、客户端是对象 —— 只认一种会导出 0 篇却全绿）',
    `数组形态=${rArr.docCount} 对象形态=${rRec.docCount}`)

  const files = await unzipAll(rArr.zipBytes)
  const names = files.map((f) => f.name)

  // ---- 2. 结构 ----
  ok(names.includes('manifest.json'), '包里有 manifest.json（将来导入靠它认格式）')
  ok(names.includes('_目录.md'), '包里有 _目录.md（不解析 zip 的编辑器也能看懂结构）')

  const mf = JSON.parse(Buffer.from(files.find((f) => f.name === 'manifest.json').bytes).toString('utf8'))
  ok(mf.kind === 'yuque-clone-book-export', 'manifest 声明了自己的 kind')
  ok(mf.docCount === rArr.docCount, 'manifest 的篇数与实际一致', `${mf.docCount} vs ${rArr.docCount}`)
  /*
   * 清单**不含 manifest 自己** —— 它是在自己写完才 unshift 进包的，
   * 把自己列进自己的清单没有意义（也没法在写入时知道自己的文件名）。
   * 所以判据是「清单 == 包内条目 - manifest 自己」。
   */
  ok(mf.files.length === files.length - 1
     && mf.files.every((n) => names.includes(n)),
    'manifest 的文件清单与包内条目一致（**不含 manifest 自己**）',
    `清单 ${mf.files.length} 条 / 包内 ${files.length} 条`)
  ok(mf.files.includes('_目录.md') && mf.files.every((n) => n.endsWith('.md')),
    '清单里列的就是实际那些文档（不是写死的字符串）')

  // ---- 3. 目录层级 → 文件夹 ----
  ok(names.some((n) => n.includes('/')),
    '目录层级变成了文件夹（包内路径含 "/"）',
    names.filter((n) => n.includes('/')).slice(0, 2).join('、'))

  // ---- 4. 正文非空 ----
  /*
   * 正文必须从 `blocks` 生成而不是直接用 `d.body`：
   * `body` 是冗余缓存，轻量启动下 blocks 已到而 body 还是空串，
   * 实测过一篇 11 块的文档导出成 0 字节。
   */
  const docFiles = files.filter((f) => f.name.endsWith('.md') && f.name !== '_目录.md')
  ok(docFiles.length > 0, '包里有文档 .md', `${docFiles.length} 个`)
  const nonEmpty = docFiles.filter((f) => Buffer.from(f.bytes).length > 0)
  ok(nonEmpty.length === docFiles.length,
    '每篇文档正文都**非空**（从 blocks 生成，不吃 body 那个可能没同步的冗余值）',
    `${nonEmpty.length}/${docFiles.length} 非空`)

  // ---- 5. 权限过滤真的生效 ----
  /*
   * 这一组是**反向**的：前面全绿不代表这里对。
   * 「一个人都看不到」时必须导出 0 篇，而且要**报数**（不静默少东西）。
   */
  const none = () => false
  const r2 = exportBookZip(book, nodes, docs, none)
  ok(r2.docCount === 0, '一个人都看不到时，包里 **0 篇文档**（不是「能点就全给」）')
  ok(r2.skipped > 0, '并且**报出**跳过了几篇（不静默少东西）', `skipped=${r2.skipped}`)
  const files2 = await unzipAll(r2.zipBytes)
  ok(!files2.some((f) => f.name.endsWith('.md') && f.name !== '_目录.md'),
    '解开验证：包内确实没有文档文件（不是只看计数）')

  // ---- 6. 恶意标题不能打穿路径 ----
  const evil = [
    { id: 'x1', bookId: book.id, parentId: null, title: '../../../etc/passwd', type: 'group', order: 0 },
    { id: 'x2', bookId: book.id, parentId: 'x1', title: 'a/b\\c:d*e?f"g<h>i|j', type: 'doc', docId: 'nope', order: 0 },
  ]
  const files3 = await unzipAll(exportBookZip(book, evil, {}, all).zipBytes)
  ok(!files3.some((f) => f.name.includes('..') || f.name.startsWith('/')),
    '**没有** `..` 或绝对路径（标题里带路径分隔符也打不穿）',
    files3.map((f) => f.name).join(', '))

  // ---- 7. 同级同名不覆盖 ----
  const dup = [
    { id: 'p1', bookId: book.id, parentId: null, title: '手册', type: 'doc', docId: docs[0]?.id, order: 1 },
    { id: 'p2', bookId: book.id, parentId: null, title: '手册', type: 'doc', docId: docs[1]?.id, order: 2 },
  ]
  const files4 = await unzipAll(exportBookZip(book, dup, docs, all).zipBytes)
  const dupNames = files4.filter((f) => f.name.endsWith('.md') && f.name !== '_目录.md').map((f) => f.name)
  ok(new Set(dupNames).size === dupNames.length,
    '同级同名**不会互相覆盖**（导出后少一篇是最难发现的坏）', dupNames.join('、'))

  // ---- 8. 循环引用不爆栈 ----
  const cyc = [
    { id: 'c1', bookId: book.id, parentId: 'c2', title: 'A', type: 'group', order: 0 },
    { id: 'c2', bookId: book.id, parentId: 'c1', title: 'B', type: 'group', order: 0 },
  ]
  let threw = ''
  try { exportBookZip(book, cyc, {}, all) } catch (e) { threw = e.message }
  ok(!threw, '目录 parentId 互指时**不会爆栈**（显式 visited 兜住）', threw)
}

// ---- 9. UI 接线：按钮真的调它，不是占位 ----
{
  const fs = await import('node:fs')
  const code = fs.readFileSync('src/pages/BookSettings.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  console.log('\n== 导出按钮真的接线了 ==')
  ok(/exportBookZip\(/.test(code), 'BookSettings 真的调了 exportBookZip')
  ok(/downloadBytes\(/.test(code), '打完包真的触发下载')
  ok(!/navigate\(['"]\/export/.test(code), '不再跳那个不存在的导出页')
  ok(/没有生成文件/.test(code), '打包失败时明说「没有生成文件」（不能弹「已导出」）')
  ok(/exporting/.test(code), '打包期间按钮进忙碌态（防重复点击）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
