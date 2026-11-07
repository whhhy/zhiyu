/* ============================================================
   语雀 Lakebook 导入验证
   ------------------------------------------------------------
   「无语雀格式互导」那个缺口的实现。语雀的 `.lakebook` 是**整知识库**
   的原生导出格式 —— 如果一家公司现在正用着语雀，这是唯一能把
   全部文档搬进来的通路（Markdown 文件夹导出不保留画板/数据表/表格）。

   fixture 的字段名与样例值来自语雀官方《lakebook 格式说明》
   （https://www.yuque.com/yuque/developer/lt69uo），不是照着我的
   实现反推的 —— 否则测试和实现会一起错、一起绿。

   这里自己写 tar 打包器来造包，而不是读一个真的 .lakebook：
   官方样例里那些 slug 是他们文档的，拿不到也不该拿。
   打包器与解析器是两份独立代码，能对上才算数。
   ============================================================ */

import { gzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
/* 收摊那一段要 `once(srv,'exit')`。⚠️ 这段**本身就是失败路径**才跑到的，
   而漏 import 的 ReferenceError 也只在那条路径上才暴露 ——
   绿的时候谁也看不见。（`node --check` 查不出未声明的标识符。） */
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'
import {
  parseTar, parseTocYml, htmlToMarkdown, parseLakeMeta, parseLakebook,
} from './src/lib/lakebook.ts'

let pass = 0, fail = 0
/** 这一轮造出来的临时 .lakebook 路径。正常路径用完即删；
 *  这里留一份是为了**中途崩了也能收干净** —— 崩了就只能走下面那段兜底。 */
const tmpFiles = []
/** 自起的服务（没传 BASE 时才有）。收尾必须关掉 ——
 *  不关的话它会一直占着端口，下一轮跑起来会撞端口而查不出原因。 */
let ownSrv = null
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/* ---------- 造 tar（独立于解析器实现） ---------- */
const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'

function tarPack(entries) {
  const blocks = []
  for (const e of entries) {
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 100, 'utf8')
    h.write(octal(0o644, 8), 100, 8, 'ascii')  // mode
    h.write(octal(0, 8), 108, 8, 'ascii')       // uid
    h.write(octal(0, 8), 116, 8, 'ascii')       // gid
    h.write(octal(e.data.length, 12), 124, 12, 'ascii')
    h.write(octal(0, 12), 136, 12, 'ascii')     // mtime
    h.write('        ', 148, 8, 'ascii')        // checksum 占位
    h.write('0', 156, 1, 'ascii')                // 普通文件
    h.write('ustar\0', 257, 6, 'ascii')
    let sum = 0
    for (const b of h) sum += b
    h.write(octal(sum, 8), 148, 8, 'ascii')
    blocks.push(h, e.data)
    const pad = (512 - (e.data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024)) // 结束标记
  return Buffer.concat(blocks)
}

/* ---------- 语雀官方文档里的 tocYml 形状 ---------- */
const TOC_YML = [
  'display_level: 1', 'tail_type: UPDATED_AT', 'base_version_id: 37', 'published: true',
  'max_level: 1', 'last_updated_at: 2022-08-05T08:45:08.074Z', 'version_id: 38',
  '- type: DOC', ' title: 父文档', ' uuid: YkPvoCdaSic2BWKp', ' url: sv7ht7',
  " prev_uuid: ''", ' sibling_uuid: V0DDKrEhEONljJ0u', ' child_uuid: ub8ceD8qSFl6CwpM',
  " parent_uuid: ''", ' doc_id: 9', ' level: 0', ' id: 9', ' open_window: 1', ' visible: 1',
  '- type: DOC', ' title: 语雀文档 Sample', ' uuid: ub8ceD8qSFl6CwpM', ' url: yuuex6',
  ' prev_uuid: YkPvoCdaSic2BWKp', " sibling_uuid: ''", ' child_uuid: lk0juyf9ieoo0',
  ' parent_uuid: YkPvoCdaSic2BWKp', ' doc_id: 9', ' level: 1', ' id: 9', ' open_window: 1', ' visible: 1',
  '- type: DOC', ' title: 子文档', ' uuid: lk0juyf9ieoo0', ' url: fqnsz7',
  " prev_uuid: ''", " sibling_uuid: ''", " child_uuid: ''", ' parent_uuid: ub8ceD8qSFl6CwpM',
  ' doc_id: 9', ' level: 2', ' id: 9', ' open_window: 1', ' visible: 0',
].join('\n')

const META_JSON = JSON.stringify({
  meta: {
    book: {
      public: 0, type: 'Book', path: 'https://www.yuque.com/foo/bar',
      name: '从语雀搬来的库', description: '语雀导出的知识库',
      tocYml: TOC_YML,
    },
  },
})

/* 语雀的 format 取值来自官方《lakebook 格式说明》：
   普通文档是 **lake**，画板/数据表/表格分别是 lakeboard / laketable / lakesheet。

   ⚠️ 这个夹具出过两次错，两次都是「夹具和解析器一致地错」，所以测试一直是绿的：
     1. 最早把普通文档写成 `lakeboard`（那是画板的值）。解析器当时压根不读
        format 字段，所以没人发现；等加上类型判断，夹具自己先露馅了 ——
        父文档被判成 BOARD，正文被换成「无法还原」的提示块。
     2. 改成了 `lakebook` —— 还是错的：**lakebook 是包的后缀名（.lakebook）**，
        文档的 format 是 `lake`。于是解析器也跟着认 `lakebook`，
        拿真包一进来，普通文档**一篇都保不住**，全被降级成一句提示。
        现在按官方的 `lake` 写，解析器也认 `lake`（`lakebook` 仍兼容）。 */
const doc = (slug, title, body) =>
  Buffer.from(JSON.stringify({
    id: 9, slug, type: 'ASL', book_id: 4, user_id: 2, title, description: '',
    format: 'lake', status: 1, body, body_asl: '', body_draft: '',
    word_count: 0, created_at: '2022-08-05T08:44:31.124Z',
    updated_at: '2022-08-05T08:44:42.830Z', published_at: '2022-08-05T08:44:41.000Z',
  }), 'utf8')

const PARENT_HTML = '<h1>父文档</h1><p>这是<strong>加粗</strong>与<code>行内代码</code>。</p><ul><li>第一项</li><li>第二项</li></ul><img src="https://cdn.example.com/a.png" alt="示意图">'
const CHILD_HTML = '<h2>第二级</h2><p>正文一段。</p><pre><code>const a = 1</code></pre><blockquote>引用一句</blockquote>'
const GRAND_HTML = '<p>第三级内容</p><table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>'

const mkBook = () => tarPack([
  { name: '$meta.json', data: Buffer.from(META_JSON, 'utf8') },
  { name: 'sv7ht7.json', data: doc('sv7ht7', '父文档', PARENT_HTML) },
  { name: 'yuuex6.json', data: doc('yuuex6', '语雀文档 Sample', CHILD_HTML) },
  { name: 'fqnsz7.json', data: doc('fqnsz7', '子文档', GRAND_HTML) },
])

/** 极简 Markdown → 块，够用来验「HTML 真的被转成了块」 */
const mdToBlocks = (md) =>
  md.split(/\n{2,}/).filter((s) => s.trim()).map((s, i) => {
    const t = s.trim()
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) return { id: 'b' + i, type: 'h' + h[1].length, text: h[2], order: i }
    if (t.startsWith('- ')) return { id: 'b' + i, type: 'ul', text: t.slice(2), order: i }
    if (t.startsWith('> ')) return { id: 'b' + i, type: 'quote', text: t.slice(2), order: i }
    if (t.startsWith('![')) return { id: 'b' + i, type: 'image', text: '', src: /!\[[^\]]*\]\(([^)]+)\)/.exec(t)?.[1] || '', order: i }
    if (t.startsWith('|')) return { id: 'b' + i, type: 'table', text: t, order: i }
    if (t.startsWith('```')) return { id: 'b' + i, type: 'code', text: t.replace(/```/g, ''), order: i }
    return { id: 'b' + i, type: 'p', text: t, order: i }
  })

/*
 * 端到端段的计数器 —— **必须放在 try 之外**。
 *
 * 整个套件体都在下面那个 `try {` 里，而 `catch` 是与它**并列**的兄弟块：
 * 声明写在 try 内部的话，绿的时候没事（catch 不执行），
 * 一旦真出事，catch 里引用它就是 ReferenceError ——
 * 守卫恰好在最需要它的那一次自己先崩。node --check 和 tsc 都发现不了。
 *
 * 为什么要单独数：端到端段有 6 个断言，中途抛异常时外面只 `fail++` 一次，
 * 于是「6 项全塌」会被报成「1 个失败」。那个 1 读起来像「有一项坏了」，
 * 实际是**整段没跑**，顺着它去查单项会查错方向。
 *
 * `okE` 保证段内每一项都经过它；`E2E_ITEMS` 是「段跑完该产出几项」——
 * 往那段加/删断言时**必须同步改它**，否则塌缩时会拿一个过时的数字去判断。
 * 两个数放在一起，就是为了让它们一起被看见。
 */
let e2eItems = 0
const okE = (...a) => { e2eItems++; return ok(...a) }
const E2E_ITEMS = 6   // ← 端到端段里 okE( 的个数

try {
  console.log('\n== tar 读取 ==')
  const entries = parseTar(new Uint8Array(mkBook()))
  ok(entries.length === 4, '读出 4 个文件（$meta + 3 篇）', String(entries.length))
  ok(entries.some((e) => e.name === '$meta.json'), '$meta.json 在里面')
  ok(entries.every((e) => e.size === e.bytes.length), '每个文件的 size 与实际字节数一致')

  console.log('\n== tocYml 解析（官方样例的形状）==')
  const nodes = parseTocYml(TOC_YML)
  ok(nodes.length === 3, '解析出 3 个目录节点', String(nodes.length))
  ok(nodes[0].title === '父文档' && nodes[0].slug === 'sv7ht7' && nodes[0].level === 0, '第 1 个节点的 title/slug/level 对', JSON.stringify(nodes[0]))
  ok(nodes[1].level === 1 && nodes[1].uuid === 'ub8ceD8qSFl6CwpM', '第 2 个节点层级是 1，uuid 正确', JSON.stringify(nodes[1]))
  ok(nodes[2].level === 2 && nodes[2].visible === 0, '第 3 个节点层级是 2，visible=0（隐藏目录）', JSON.stringify(nodes[2]))
  ok(nodes.every((n) => n.uuid && n.title), '每个节点都有 uuid 与标题')

  console.log('\n== HTML → Markdown ==')
  {
    const md = htmlToMarkdown(PARENT_HTML)
    ok(/# 父文档/.test(md), 'h1 变成 Markdown 标题', md.split('\n')[0])
    ok(/\*\*加粗\*\*/.test(md), 'strong 变成 **', '')
    ok(/- 第一项/.test(md), 'li 变成列表项', '')
    ok(/!\[示意图\]\(https:\/\/cdn\.example\.com\/a\.png\)/.test(md), 'img 变成图片语法', '')
    const md2 = htmlToMarkdown(CHILD_HTML)
    ok(/```/.test(md2) && /const a = 1/.test(md2), 'pre>code 变成代码块', '')
    ok(/> 引用一句/.test(md2), 'blockquote 变成引用', '')
    const md3 = htmlToMarkdown(GRAND_HTML)
    ok(/\| 列A \| 列B \|/.test(md3), '表格变成 Markdown 表格', '')
    ok(/^\| 1 \| 2 \|$/m.test(md3), '表格的数据行也在', JSON.stringify(md3))
  }

  console.log('\n== 整包解析（未压缩 tar）==')
  {
    const r = await parseLakebook(mkBook(), mdToBlocks)
    ok(r.title === '从语雀搬来的库', '知识库名取自 $meta.json', r.title)
    ok(r.docs.length === 3, '读出 3 篇文档', String(r.docs.length))
    ok(r.tree.length === 3, '目录树有 3 项', String(r.tree.length))
    ok(r.tree.map((t) => t.depth).join(',') === '0,1,2', '层级还原为 0,1,2', r.tree.map((t) => t.depth).join(','))
    ok(r.tree.map((t) => t.title).join(' → ') === '父文档 → 语雀文档 Sample → 子文档', '目录顺序与标题对', r.tree.map((t) => t.title).join(' → '))
    const first = r.tree[0].doc
    ok(first.kind === '文档', '第一篇被认成普通文档（不是画板/表格）', String(first.kind))
    ok(first.blocks.length >= 3, '第一篇转出了多个块', String(first.blocks.length))
    ok(first.blocks.some((b) => b.type === 'h1'), '有 H1 块')
    ok(first.blocks.some((b) => b.type === 'image' && String(b.src).includes('a.png')), '图片块带上了 src')
  }

  console.log('\n== 整包解析（gzip 压缩）==')
  {
    const gz = new Uint8Array(gzipSync(mkBook()))
    ok(gz[0] === 0x1f && gz[1] === 0x8b, '造出来的是 gzip 魔数')
    const r = await parseLakebook(gz, mdToBlocks)
    ok(r.docs.length === 3, 'gzip 包同样读出 3 篇', String(r.docs.length))
    ok(r.title === '从语雀搬来的库', 'gzip 包的知识库名也对')
  }

  console.log('\n== 坏包要说人话，不能静默 ==')
  {
    let msg = ''
    try { await parseLakebook(Buffer.alloc(1024), mdToBlocks) } catch (e) { msg = e?.message || '' }
    ok(/Lakebook|有效/.test(msg), '全零的包给出明确错误', msg || '(没报错)')
  }
  {
    // 有 JSON 但没有 $meta.json：文档要保住，警告要写清楚
    const noMeta = tarPack([{ name: 'abc12.json', data: doc('abc12', '没有目录的文档', '<p>x</p>') }])
    const r = await parseLakebook(noMeta, mdToBlocks)
    ok(r.docs.length === 1, '没有 $meta.json 时文档仍然被读出来', String(r.docs.length))
    ok(r.warnings.some((w) => /meta/.test(w)), '并且说明了原因', JSON.stringify(r.warnings))
  }
  {
    // 目录里提到、包里却没有的文档（包里至少得有一篇真实的，否则是「空包」）
    const missingOne = tarPack([
      { name: '$meta.json', data: Buffer.from(META_JSON, 'utf8') },
      { name: 'sv7ht7.json', data: doc('sv7ht7', '父文档', '<p>在</p>') },
    ])
    const r = await parseLakebook(missingOne, mdToBlocks)
    ok(r.docs.length === 1, '包里有的那篇被读出来了', String(r.docs.length))
    ok(r.warnings.some((w) => /找不到对应文档/.test(w)), '目录提到但包里没有的文档被警告出来', JSON.stringify(r.warnings))
  }
  {
    // 一篇坏 JSON，不该让整包失败
    const oneBad = tarPack([
      { name: '$meta.json', data: Buffer.from(META_JSON, 'utf8') },
      { name: 'sv7ht7.json', data: doc('sv7ht7', '好的那篇', '<p>好</p>') },
      { name: 'yuuex6.json', data: Buffer.from('{ 这不是 JSON', 'utf8') },
      { name: 'fqnsz7.json', data: doc('fqnsz7', '子文档', '<p>也还在</p>') },
    ])
    const r = await parseLakebook(oneBad, mdToBlocks)
    ok(r.docs.length === 2, '一篇坏 JSON 不影响另外两篇', String(r.docs.length))
  }

  console.log('\n== 画板 / 数据表 / 表格：降级要明说 ==')
  {
    /* 语雀的 format 取值：普通文档 lakebook，画板/数据表/表格分别是
       lakeboard / laketable / lakesheet，它们的 body 不是 HTML。
       拿 HTML 转换器硬转只会得到标签残渣。 */
    const sheet = (slug, title, format) => Buffer.from(JSON.stringify({
      id: 9, slug, type: 'ASL', book_id: 4, user_id: 2, title, format,
      body: '[[1,2],[3,4]]', body_asl: '', body_draft: '',
    }), 'utf8')
    const mixed = tarPack([
      { name: '$meta.json', data: Buffer.from(META_JSON, 'utf8') },
      { name: 'sv7ht7.json', data: doc('sv7ht7', '父文档', '<p>正常文档</p>') },
      { name: 'yuuex6.json', data: doc('yuuex6', '语雀文档 Sample', '<p>也是正常文档</p>') },
      { name: 'fqnsz7.json', data: sheet('fqnsz7', '季度数据表', 'laketable') },
    ])
    const r = await parseLakebook(mixed, mdToBlocks)
    ok(r.docs.length === 3, '三个文件都被读出（降级不等于丢弃）', String(r.docs.length))
    const bad = r.docs.find((d) => d.slug === 'fqnsz7')
    ok(bad?.kind === 'TABLE', '数据表被标成 TABLE 类型', String(bad?.kind))
    ok(
      bad?.blocks.some((b) => /暂不还原|无法还原/.test(b.text || '')),
      '降级后的正文里写明了「暂不还原」而不是留一堆标签残渣',
      JSON.stringify(bad?.blocks?.map((b) => b.text)).slice(0, 120),
    )
    ok(
      r.warnings.some((w) => /结构化内容|画板|数据表|表格/.test(w) && /降级|无法还原|普通文档/.test(w)),
      '导入预览会警告：有 N 个结构化内容被降级',
      JSON.stringify(r.warnings).slice(0, 160),
    )

    /**
     * 真实导出包里普通文档的 format 是 **`lake`**，不是 `lakebook`。
     *
     * 依据：语雀官方《lakebook 格式说明》($meta.json 示例) 里，
     * 普通文档 yuuex6 写的是 `"format": "lake"`，画板是 `"lakeboard"` ——
     * `lakebook` 是**包**的后缀名，不是文档的 format。
     *
     * 之前这里把普通文档的夹具写成 `lakebook`，而解析器也认 `lakebook`，
     * **两边一致地错**，所以测试一直是绿的。
     * 后果是：拿一个真的语雀导出包进来，每一篇普通文档都会被判成
     * 「结构化内容、暂不还原」，正文被换成一句提示 ——
     * 也就是整库内容全被清空，而导入预览还会说「有 N 个内容被降级」，
     * 用户看 warning 也不容易联想到「连正常文档都没了」。
     */
    const r2 = await parseLakebook(
      tarPack([
        { name: '$meta.json', data: Buffer.from(META_JSON, 'utf8') },
        {
          name: 'ykqxxxx.json',
          data: Buffer.from(JSON.stringify({
            id: 8, slug: 'ykqxxxx', type: 'Doc', book_id: 4, user_id: 2,
            title: '真包里的普通文档', format: 'lake', status: 1,
            body: '<h1>标题</h1><p>正文</p>', body_asl: '', body_draft: '',
          }), 'utf8'),
        },
        { name: 'boardxxx.json', data: sheet('boardxxx', '画板', 'lakeboard') },
      ]),
      mdToBlocks,
    )
    const plain = r2.docs.find((d) => d.slug === 'ykqxxxx')
    ok(
      plain && !plain.blocks.some((b) => /暂不还原|无法还原/.test(b.text || '')),
      'format 是 lake 的普通文档**不会**被当成结构化内容降级',
      JSON.stringify(plain?.blocks?.map((b) => b.text)).slice(0, 160),
    )
    ok(
      plain?.blocks.some((b) => (b.text || '').includes('正文')),
      'format 是 lake 的普通文档正文被正常解析（不是一句提示）',
      JSON.stringify(plain?.blocks?.map((b) => b.text)).slice(0, 160),
    )
    ok(
      // 只看「降级」那一条：这份 META_JSON 里没有 ykqxxxx，
      // 所以还会有「不在目录树里」之类的警告，笼统地全文匹配会误判
      !r2.warnings.some((w) => /结构化内容/.test(w) && /真包里的普通文档/.test(w)),
      '普通文档不会被算进「结构化内容被降级」那条警告里',
      JSON.stringify(r2.warnings.filter((w) => /结构化内容/.test(w))).slice(0, 160),
    )
    ok(
      r.docs.filter((d) => d.kind === '文档').length === 2,
      '正常文档的类型仍是「文档」，不受影响',
    )
  }

  /* ---------- 端到端：造一个真的 .lakebook 走界面导入 ---------- */
  /*
   * ⚠️ 这里原来是 `if (process.env.BASE) { … }` 整段包着，而 BASE **只有
   * run-all-tests.mjs 会传**。也就是说：
   *
   *   `npm run test:all`  → 48 项（解析 42 + 端到端 6）
   *   `npm run test:lakebook` → **42 项**，端到端那 6 项**静默不跑**，
   *                          而最后照样打印「结果：42 通过 / 0 失败」。
   *
   * 而单独跑一个套件正是 README 教人做的事 —— 于是「本地跑一遍全绿」
   * 和「全量跑一遍全绿」验的根本不是同一件事，而**没有任何提示说它们不一样**。
   * 这正是本项目记过最多次的那条：**否定面（这里没跑的）不会有人告诉你**。
   *
   * 改法是自己起服务（和其他自起服务的套件同一套做法：独立端口 + 独立库），
   * 而不是「打一行日志说这段跳过了」—— 那只是把一个静默的缺口变成一句提示，
   * 缺口本身还在。
   */
  const ADMIN_PASS = process.env.ADMIN_PASS || 'yuque@2026'
  let BASE = process.env.BASE
  if (!BASE) {
    const PORT = process.env.LAKEBOOK_PORT || await freePort()
    const DB = 'data/_lakebook-e2e.db'
    for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
    if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) {
      console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
      process.exit(1)
    }
    ownSrv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
      env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN_PASS, ADMIN_PASS },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let up = false
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
    }
    if (!up) { console.error('自起服务没能在 20 秒内起来'); try { ownSrv.kill() } catch {}; process.exit(1) }
    BASE = `http://localhost:${PORT}`
    console.log(`\n== 端到端（自起服务 ${BASE}）==`)
  }
  {
    const { chromium } = await import('playwright')
    const B = BASE
    const br = await chromium.launch()
    try {
      const p = await (await br.newContext()).newPage()
      await p.goto(B, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-login-card', { timeout: 25000 })
      await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
      await p.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
      /*
       * ⚠️ 登录这一步以前是「点一下就等 60 秒」，而它在**满负载下会挂**：
       * 三次全量里红了两次（都是 `waitForSelector('.yq-app')` 超时），
       * 单独跑三次全绿 —— 竞态的典型特征。
       *
       * 猜不准根因（页面还没 hydrate 就点，handler 压根没挂上？表单还没提交完？）。
       * 但**「点一次就死等」本身就是个测试缺陷**：它把「点了没生效」和
       * 「功能坏了」混成同一个症状。
       *
       * 所以改成：等按钮**真的可点**再点；点完若没进去，**再点一次**继续等。
       * 断言该失败时照样失败，只是不再把「第一次没点上」当成「坏了」。
       */
      await p.waitForSelector('.yq-login-submit:not([disabled])', { timeout: 25000 })
      await p.click('.yq-login-submit')
      let inApp = false
      for (let i = 0; i < 24 && !inApp; i++) {
        await p.waitForTimeout(1000)
        inApp = await p.evaluate(() => !!document.querySelector('.yq-app')).catch(() => false)
        if (inApp) break
        // 第二次点击：表单还在就再试一次（此时页面多半已经 hydrate 完）
        const stillOnLogin = await p.evaluate(() => !!document.querySelector('.yq-login-card')).catch(() => false)
        if (stillOnLogin && i > 5 && i % 6 === 0) {
          await p.click('.yq-login-submit').catch(() => {})
        }
      }
      if (!inApp) throw new Error('登录后 24 秒仍未进入应用（.yq-app）')
      await p.waitForTimeout(1500)

      const suffix = Date.now().toString(36)
      await p.goto(`${B}/#/settings`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
      // 导入入口在「数据管理」tab 下，默认停在「账号信息」
      await p.click('.yq-settings-nav-item:has-text("数据管理")')
      // ⚠️ 入口 2026-10-16 收成了「导入…」→ 格式选择器（照语雀的形态），
      //    原来的「选择 .lakebook 文件」按钮没有了。
      //    上一轮全量它**绿着**，纯属侥幸 —— 那条断言根本没被执行到。
      await p.waitForSelector('button:has-text("导入…")', { timeout: 15000 })
      await p.click('button:has-text("导入…")')
      await p.waitForSelector('.yq-imppick-item:has-text("语雀知识库")', { timeout: 10000 })
      await p.click('.yq-imppick-item:has-text("语雀知识库")')
      await p.waitForSelector('input[accept*="lakebook"]', { state: 'attached', timeout: 15000 })
      const tmp = `data/_lake-e2e-${suffix}.lakebook`
      writeFileSync(tmp, mkBook())
      tmpFiles.push(tmp)
      await p.locator('input[accept*="lakebook"]').setInputFiles(tmp)
      /*
       * ⚠️⚠️ 这里原来**紧接着就 `rmSync(tmp)`**，理由写的是
       * 「`setInputFiles` 之后浏览器已经拿走了内容」——
       * 而这正是满负载下会失效的假设：
       *
       *   文件还在往浏览器进程传，就被删掉了 → 浏览器拿到**截断的** `.lakebook`
       *   → 解析失败 → 预览 `.yq-mdplan` 永远不出现
       *   → 下面那个 60 秒 `waitForSelector` 超时
       *   → 整段端到端中断，只跑出 42 项，报告上写着「1 个失败」。
       *
       * 症状极具误导性：**不是某一项坏了，是整段没跑**。
       * 而且它把「功能坏了」和「机器慢」混成了一件事 ——
       * 上一轮为此把超时从 25s 放宽到 60s，那只治了排队，没治这个竞态。
       *
       * 改成：文件**留在 `tmpFiles` 里**，由末尾那个兜底循环统一删。
       * 既不积压（那是这个循环的职责），也不会提前把文件抽走。
       */
      // 原来紧跟其后的是：`try { rmSync(tmp, { force: true }) } catch {}` + `tmpFiles.pop()`

      // 先预览，确认篇数与层级
      /* 超时给到 60s：全量里 130+ 个套件连跑，机器是共享的。
         放宽的是**等待**，不是判据：断言该失败时照样失败，
         只是不再把「排队」当成「坏了」。
         （真正的根因在上面的 rmSync —— 见那段注释。） */
      await p.waitForSelector('.yq-mdplan', { timeout: 60000 })
      const head = (await p.locator('.yq-mdplan-head').textContent()) || ''
      okE(/3<\/b> 篇文档/.test(head) || /3 篇文档/.test(head.replace(/<[^>]+>/g, '')), '预览里篇数是 3', head.trim().slice(0, 80))
      const previewText = (await p.locator('.yq-mdplan-tree').textContent()) || ''
      okE(/父文档/.test(previewText) && /语雀文档 Sample/.test(previewText) && /子文档/.test(previewText), '预览列出了三篇的标题', previewText.replace(/\s+/g, ' ').slice(0, 100))

      await p.click('.yq-modal-footer button:has-text("确认导入")')
      await p.waitForTimeout(4000)
      const info = (await p.locator('.yq-settings-hint').first().textContent().catch(() => '')) || ''
      okE(/已导入/.test(info) && /3 篇/.test(info), '提示说导入了 3 篇', info.trim().slice(0, 100))

      // 真的落库了吗：按标题找那三篇
      const found = await p.evaluate((sfx) => {
        const s = window.__yqStore.getState()
        const book = s.books.find((b) => b.name === '从语雀搬来的库')
        if (!book) return { book: false }
        const titles = (s.nodes.filter((n) => n.bookId === book.id).map((n) => n.title))
        return { book: true, id: book.id, titles, count: titles.length }
      }, suffix)
      okE(found.book, '知识库建出来了', JSON.stringify(found).slice(0, 120))
      okE(found.count >= 3, '目录树里至少 3 项', JSON.stringify(found.titles))

      // 正文真的进去了吗
      const bodyOk = await p.evaluate((bid) => {
        const s = window.__yqStore.getState()
        const docNode = s.nodes.find((n) => n.bookId === bid && n.docId)
        if (!docNode) return { ok: false, why: '没有文稿节点' }
        const d = s.docs[docNode.docId]
        return { ok: !!d && (d.blocks || []).length > 1, blocks: d?.blocks?.length, types: (d?.blocks || []).map((b) => b.type) }
      }, found.id)
      okE(bodyOk.ok, '文档正文有内容（不止标题那一个块）', JSON.stringify(bodyOk).slice(0, 160))
    } finally {
      await br.close()
    }
  }
} catch (e) {
  const collapsed = e2eItems
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e) + '\n' + (e?.stack || '').split('\n').slice(1, 4).join('\n'))
  /*
   * ⚠️ 这行是整条链路上最要紧的一句：上一轮它报的是「42 通过 / 1 失败」，
   * 看着像**有一项坏了**，实际是**端到端整段没跑**。
   * 不把这件事说出来，下一个读报告的人会按单项去查 —— 我就是这么查错的。
   */
  if (collapsed < E2E_ITEMS) {
    console.log(`  ⚠️  端到端段只跑出 ${collapsed}/${E2E_ITEMS} 项就中断了 —— 「1 个失败」不代表只有 1 处坏了`)
  }
}

/* 兜底：异常路径（上面的 catch）走不到正常那句删除，这里再收一次 */
for (const f of tmpFiles) { try { rmSync(f, { force: true }) } catch { /* 留着 */ } }

/*
 * 自起的服务 + 它那个库，必须一起收干净。
 *
 * ⚠️ 原来只有 `ownSrv.kill()`，而**库从来没被删过** ——
 *    `tmpFiles` 里只有 .lakebook 临时文件，不含 `data/_lakebook-e2e.db`。
 *    于是每单独跑一次这个套件，data/ 里就多留一个 ~2.2MB 的库（+wal+shm）。
 *
 *    全量跑时看不出来：BASE 是 runner 传的，不自建服务；
 *    而 runner 的 `sweepSuiteTemps` 会把 `data/_*` 的差集清掉。
 *    ——**只有单独跑（也就是我排查问题时跑的方式）才会暴露**。
 *
 * ⚠️ 两个顺序上的坑，都踩过：
 *   ① `kill()` 只是发信号。进程还在时删它的 SQLite 会失败（Windows 文件锁），
 *      而 `catch {}` 把失败吞掉 → 「套件绿着、垃圾留一地」。
 *      ⇒ 必须等 `exit`，再删。
 *   ② 删不掉就必须**说出来**。不吭声的残留，下一轮会被当成「上轮本来就有的」。
 */
if (ownSrv) {
  const exited = once(ownSrv, 'exit')
  ownSrv.kill()
  const won = await Promise.race([
    exited.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ])
  if (!won) { try { ownSrv.kill('SIGKILL') } catch { /* 已经没了 */ } }
}
{
  const DB = 'data/_lakebook-e2e.db'
  let stuck = []
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {          // 文件锁释放有延迟，重试几次
      try { rmSync(f, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone) stuck.push(f)
  }
  if (stuck.length) {
    console.log(`  ⚠️  临时库删不掉（服务可能还占着）：${stuck.join(', ')}`)
    console.log('      不吭声的残留会被下一轮当成「本来就有的」，所以这里说出来。')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
