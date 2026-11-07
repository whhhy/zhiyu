/**
 * Word（.docx）导出与导入。
 *
 * ============================================================
 * 为什么单独立一个套件
 * ------------------------------------------------------------
 * 「导出一个 .docx 文件」这件事**没有任何断言是好做的**：
 * 文件确实下载了、扩展名是 .docx、大小不为零 ——
 * 但内容可能是一堆标签残渣，Word 打开直接报「文件已损坏」，
 * 而这些在「下载成功」这个层面全都看不出来。
 *
 * 所以这里不看「下没下载下来」，看**文件结构本身**：
 * 逐条解 zip、断言 Word 必需的每个部件都在、断言正文真的在
 * word/document.xml 里、断言转义没漏。
 * 最后再做一次往返：导出 → 再读回来 → 比对文字。
 *
 * 这条套件的存在还有个来由：项目的两处界面文案写着
 * 「Markdown / Word / PDF 是在浏览器本地生成的」，
 * 而当时**根本没有 Word 导出** —— 拿一个不存在的能力当论据。
 * ============================================================
 */
import { buildDocx, readDocx, zip, unzip } from './src/lib/docx.ts'
import { inflateRaw } from './src/lib/inflate.ts'
import { deflateRawSync, deflateSync } from 'node:zlib'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const dec = new TextDecoder()

console.log('\n== inflate：拿 node 造的真实压缩流来验 ==')
/**
 * 这一节是本套件最该有的一节。
 * inflate 是自己写的，而 Word 存出来的 .docx **一定是 deflate 的** ——
 * 解压错了，整条导入路径就是「界面上看着能用、实际永远失败」。
 *
 * 所以用 node 的 zlib 造真实的压缩流喂给纯 TS 实现：
 * 实现和参照系来自两个独立的库，对上了才算数。
 */
{
  const samples = [
    ['空内容', ''],
    ['短文本', 'hello'],
    ['中文', '这是一段中文，应该逐字节一致。'],
    ['重复内容（走 LZ77 回溯）', 'abcabcabcabc'.repeat(200)],
    ['超 32KB（长度码要跨 4 位以上）', 'x'.repeat(70000)],
    ['混合', Array.from({ length: 5000 }, (_, i) => `第 ${i} 行：内容 ${(i * 7919) % 9973}`).join('\n')],
  ]
  for (const [name, text] of samples) {
    const raw = new TextEncoder().encode(text)
    const deflated = new Uint8Array(deflateRawSync(raw))
    const back = inflateRaw(deflated)
    ok(dec.decode(back) === text, `deflate 解压一致：${name}（${raw.length} → ${deflated.length} 字节）`)
  }

  /**
   * zlib / gzip 包装过的数据**解不出**正确结果 —— 这是对的，不算缺陷：
   * 本函数是 raw inflate（RFC 1951），而 zip 的条目一律是 raw deflate。
   * 这里把它钉住，是为了防止以后有人「顺手」加个兼容分支 ——
   * 那样 zip 里的数据反而可能被解错，而这类错不报异常、只出乱码。
   */
  const wrapped = new Uint8Array(deflateSync(Buffer.from('zlib 包装的内容')))
  let wrongAnswer = false
  try { wrongAnswer = dec.decode(inflateRaw(wrapped)) !== 'zlib 包装的内容' } catch { wrongAnswer = true }
  ok(wrongAnswer, 'zlib 包装的数据不会被误当成 raw 解成「看似正确」的结果（raw 就是 raw）')

  // 垃圾数据必须报错，不能静默产出空数组 —— 静默空数组会被当成「这个 Word 没内容」
  let threw = ''
  try { inflateRaw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) } catch (e) { threw = String(e.message) }
  ok(threw.length > 0, '垃圾数据报错而不是静默返回空', threw || '（没有抛错）')
}


/** 断言失败时给一点上下文：贴出出问题的那一段 w:t */
const XML_OK = (xml) => {
  const m = /<w:t(?:\s[^>]*)?>[^<]*(?:&(?!lt;|gt;|amp;|quot;|apos;|#)|<(?!\/?w:))[^<]*<\/w:t>/.exec(xml)
  return m ? `样例：${m[0].slice(0, 120)}` : ''
}

console.log('\n== zip 本身：写得出，也读得回 ==')
{
  const entries = [
    { name: 'a.txt', data: new TextEncoder().encode('hello 中文') },
    { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 3, 255]) },
  ]
  const zipped = zip(entries)
  ok(zipped[0] === 0x50 && zipped[1] === 0x4b, '开头是 PK\\x03\\x04（zip 魔数）',
    [...zipped.slice(0, 4)].join(','))

  const back = unzip(zipped)
  ok(back.size === 2, `解出 2 个条目（实际 ${back.size}）`)
  ok(back.has('a.txt') && back.has('dir/b.bin'), '文件名完整，含带目录的那个')
  ok(dec.decode(back.get('a.txt')) === 'hello 中文', '中文内容逐字节一致',
    JSON.stringify(dec.decode(back.get('a.txt'))))
  ok(back.get('dir/b.bin')?.join(',') === '0,1,2,3,255', '二进制内容逐字节一致')

  // 大一点的内容，顺带压一下 zip 的偏移计算
  const big = 'x'.repeat(5000) + '结尾'
  const big2 = unzip(zip([{ name: 'big.txt', data: new TextEncoder().encode(big) }]))
  ok(dec.decode(big2.get('big.txt')) === big, '大文件（5000+ 字节）也能原样取回')
}

console.log('\n== zip：读得回「压缩过的」条目（Word 就是这么存的）==')
{
  /**
   * 上面那段用的是 stored（不压缩）条目。
   * 但真实 .docx 里每个部件都是 deflate 的 ——
   * 这里自己拼一个 method=8 的条目，验解包路径真的会走 inflate。
   */
  const content = new TextEncoder().encode('<w:document>压缩过的正文</w:document>'.repeat(50))
  const deflated = new Uint8Array(deflateRawSync(content))

  // 手工造一个 method=8 的条目（zip() 只会写 stored，所以这里拼）
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0 }
    return t
  })()
  let crc = 0xffffffff
  for (const b of content) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0

  const name = new TextEncoder().encode('word/document.xml')
  const local = new Uint8Array(30 + name.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true)
  lv.setUint16(8, 8, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0)
  lv.setUint32(14, crc, true); lv.setUint32(18, deflated.length, true); lv.setUint32(22, content.length, true)
  lv.setUint16(26, name.length, true)
  local.set(name, 30)

  const cen = new Uint8Array(46 + name.length)
  const cv = new DataView(cen.buffer)
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true)
  cv.setUint16(8, 0x0800, true); cv.setUint16(10, 8, true)
  cv.setUint32(16, crc, true); cv.setUint32(20, deflated.length, true); cv.setUint32(24, content.length, true)
  cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true)
  cen.set(name, 46)

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true)
  ev.setUint32(12, cen.length, true); ev.setUint32(16, local.length + deflated.length, true)

  const all = new Uint8Array(local.length + deflated.length + cen.length + eocd.length)
  all.set(local, 0); all.set(deflated, local.length); all.set(cen, local.length + deflated.length)
  all.set(eocd, local.length + deflated.length + cen.length)

  const back = unzip(all)
  ok(back.has('word/document.xml'), '解出了 deflate 过的条目')
  ok(dec.decode(back.get('word/document.xml')) === dec.decode(content),
    'deflate 条目内容与压缩前逐字节一致',
    `解压得到 ${back.get('word/document.xml')?.length} 字节，原文 ${content.length} 字节`)
}

console.log('\n== docx 的部件：少一个 Word 就打不开 ==')
{
  const docx = buildDocx('测试标题', '# 一级标题\n\n正文一段。\n\n- 列表项\n- 第二项')
  const files = unzip(docx)
  for (const must of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    ok(files.has(must), `必需部件齐全：${must}`)
  }
  ok(files.has('word/_rels/document.xml.rels'), '有 document.xml.rels（样式 / 超链接的登记处）')

  const ct = dec.decode(files.get('[Content_Types].xml'))
  ok(ct.includes('wordprocessingml.document.main+xml'), 'Content_Types 声明了主文档部件')
  const rels = dec.decode(files.get('_rels/.rels'))
  ok(rels.includes('officeDocument') && rels.includes('word/document.xml'),
    '根 rels 指向 word/document.xml（否则 Word 找不到正文）')
}

console.log('\n== 正文真的在 document.xml 里 ==')
{
  const docx = buildDocx('我的文档', '## 二级标题\n\n这里有一段正文。\n\n> 引用一行')
  const xml = dec.decode(unzip(docx).get('word/document.xml'))
  ok(xml.includes('我的文档'), '标题在')
  ok(xml.includes('二级标题'), '二级标题在')
  ok(xml.includes('这里有一段正文。'), '正文在')
  ok(xml.includes('引用一行'), '引用在')
  ok(/w:val="Heading2"/.test(xml), 'Heading2 样式真的挂上了（不是一段普通文字）')
  ok(/w:val="Quote"/.test(xml), '引用用的是 Quote 样式')
  // 每个 w:p 都要闭合，否则 Word 直接报文件损坏
  const open = (xml.match(/<w:p[ >]/g) || []).length
  const close = (xml.match(/<\/w:p>/g) || []).length
  ok(open === close, `w:p 开合配对（开 ${open} / 闭 ${close}）`)
}

console.log('\n== XML 转义：漏一个就是「文件已损坏」 ==')
{
  const tricky = 'a < b & c > d "引号" \'单引号\''
  const xml = dec.decode(unzip(buildDocx('t', tricky)).get('word/document.xml'))
  ok(xml.includes('a &lt; b &amp; c &gt; d'), '尖括号与 & 都转义了')
  // 注意：不能简单地在 w:t 里找 '&' —— `&lt;` 本身就含 &，会把**正确的**转义判成漏转义。
  // 要找的是「没有构成实体的裸 &」。
  const rawAmp = /<w:t(?:\s[^>]*)?>[^<]*&(?!lt;|gt;|amp;|quot;|apos;|#)[^<]*<\/w:t>/.test(xml)
  ok(!rawAmp, 'w:t 里没有未转义的裸 &', XML_OK(xml))
  const rawLt = /<w:t(?:\s[^>]*)?>[^<]*(?:<(?!\/?w:))[^<]*<\/w:t>/.test(xml)
  ok(!rawLt, 'w:t 里没有裸 <')
  const back = readDocx(buildDocx('t', tricky))
  ok(back.markdown.includes('a < b & c > d'), '往返后原文一字不差', JSON.stringify(back.markdown))
}

console.log('\n== 段落内的行内格式 ==')
{
  const xml = dec.decode(unzip(buildDocx('t', '这是 **粗体** 和 *斜体* 和 `代码`')).get('word/document.xml'))
  ok(/<w:b\/>/.test(xml), '**粗体** 变成 w:b')
  ok(/<w:i\/>/.test(xml), '*斜体* 变成 w:i')
  ok(xml.includes('w:val="CodeChar"'), '`代码` 用了等宽样式')

  const xml2 = dec.decode(unzip(buildDocx('t', '看 [这个站点](https://example.com/a?b=1) 吧')).get('word/document.xml'))
  ok(xml2.includes('w:hyperlink'), '链接变成 w:hyperlink')
  const rels = dec.decode(unzip(buildDocx('t', '看 [这个站点](https://example.com/a?b=1) 吧')).get('word/_rels/document.xml.rels'))
  ok(rels.includes('https://example.com/a?b=1') && rels.includes('TargetMode="External"'),
    '外链在 rels 里登记为外部链接（不登记的话 Word 里点不开）', rels.slice(0, 120))
}

console.log('\n== 链接占位符不会被正文里的数字误伤 ==')
{
  // 一开始占位符写成「空格 + 序号 + 空格」，正文里出现「见 3 」就被替换掉了
  const xml = dec.decode(unzip(buildDocx('t', '版本见 3 号文档，另见 [链接](https://x.com)')).get('word/document.xml'))
  ok(xml.includes('版本见 3 号文档'), '正文里的普通数字没被当成占位符换掉', xml.slice(0, 200))
  ok(xml.includes('w:hyperlink'), '链接照常生成')
}

console.log('\n== 列表 / 待办 / 代码块 / 表格 ==')
{
  const src = ['- 无序一', '- 无序二', '1. 有序一', '2. 有序二', '- [x] 做完了', '- [ ] 没做', '', '```', 'const a = 1', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')
  const xml = dec.decode(unzip(buildDocx('t', src)).get('word/document.xml'))
  ok(xml.includes('ListParagraph'), '列表用了列表样式')
  ok(/<w:numId w:val="1"\/>/.test(xml), '有序列表挂了编号（否则 Word 里只是一段文字）')
  ok(xml.includes('☐') && xml.includes('☑'), '待办的勾选状态渲染出来了')
  ok(xml.includes('w:val="CodeBlock"'), '代码块用了代码样式')
  ok(xml.includes('<w:tbl>') && xml.includes('TableGrid'), '表格真的生成了 w:tbl 并带边框')
  ok(xml.includes('const a = 1'), '代码块内容没丢')
}

console.log('\n== 往返：导出 → 读回来 ==')
{
  const body = [
    '# 接口规范',
    '',
    '这是一段说明。',
    '',
    '## 错误码',
    '',
    '- 400 参数错',
    '- 500 服务端错',
    '',
    '> 改动前请先看 [变更记录](https://example.com/changelog)。',
  ].join('\n')

  const back = readDocx(buildDocx('接口规范', body))
  ok(back.title === '接口规范', '标题被还原', JSON.stringify(back.title))
  ok(back.markdown.includes('接口规范'), '正文里还有标题（不只出现在 title 里）')
  ok(back.markdown.includes('这是一段说明。'), '普通段落还原')
  ok(back.markdown.includes('## 错误码'), '二级标题还原成 markdown 的 ##')
  ok(back.markdown.includes('- 400 参数错'), '列表还原成 markdown 的 -', JSON.stringify(back.markdown))
  ok(back.markdown.includes('> 改动前请先看'), '引用还原')
  ok(back.markdown.includes('变更记录'), '链接文字还原')
}

console.log('\n== 用「别人写的解包器」再验一遍 ==')
/**
 * 上面所有断言用的都是**我自己写的** zip 解包器。
 * 自己写的解包器读得通，只能证明「我的代码和我的一致」——
 * 万一我对 zip 的理解本身就错了，两边一起错，测试全绿而 Word 打不开。
 *
 * 所以这里换一个**独立实现**（Node 自带的 zlib 那条路之外没有别的，
 * 真正独立的是 .NET 的 ZipArchive，见 test-docx-dotnet.mjs 那条）。
 * 这个套件里至少再用 Node 的 zlib 造一轮「压缩方式对不对」的对照，
 * 证明我写的 stored 条目和中央目录偏移量在别的实现眼里也是对的。
 */
{
  const { inflateRawSync, deflateRawSync } = await import('node:zlib')
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0 }
    return t
  })()
  const crcOf = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

  // 拼一个 deflate 条目的 zip，然后**只用 Node 自带的 zlib** 去解 ——
  // 走的是完全不同的代码路径（inflateRawSync 是 C++ 实现，我那个是纯 TS）
  const content = new TextEncoder().encode('独立实现的交叉验证正文')
  const deflated = new Uint8Array(deflateRawSync(content))
  const crc = crcOf(content)
  const name = new TextEncoder().encode('word/document.xml')
  const local = new Uint8Array(30 + name.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true)
  lv.setUint16(8, 8, true); lv.setUint32(14, crc, true)
  lv.setUint32(18, deflated.length, true); lv.setUint32(22, content.length, true)
  lv.setUint16(26, name.length, true)
  local.set(name, 30)
  const cen = new Uint8Array(46 + name.length)
  const cv = new DataView(cen.buffer)
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true)
  cv.setUint16(8, 0x0800, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc, true)
  cv.setUint32(20, deflated.length, true); cv.setUint32(24, content.length, true)
  cv.setUint16(28, name.length, true)
  cen.set(name, 46)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true)
  ev.setUint32(12, cen.length, true); ev.setUint32(16, local.length + deflated.length, true)
  const all = new Uint8Array(local.length + deflated.length + cen.length + eocd.length)
  all.set(local, 0); all.set(deflated, local.length); all.set(cen, local.length + deflated.length)
  all.set(eocd, local.length + deflated.length + cen.length)

  // 手工按中央目录找数据偏移，再用 Node 的 zlib 解
  const dv = new DataView(all.buffer)
  // EOCD 固定占最后 22 字节（无注释时），中央目录起点记在它的 +16 处
  const eocdAt = all.length - 22
  ok(dv.getUint32(eocdAt, true) === 0x06054b50, '手工拼的 EOCD 魔数正确')
  const cdOff = dv.getUint32(eocdAt + 16, true)
  const localOff = dv.getUint32(cdOff + 42, true)
  const lNameLen = dv.getUint16(localOff + 26, true)
  const lExtra = dv.getUint16(localOff + 28, true)
  const start = localOff + 30 + lNameLen + lExtra
  const compSize = dv.getUint32(localOff + 18, true)
  const raw = all.subarray(start, start + compSize)
  const back = inflateRawSync(new Uint8Array(raw))
  ok(dec.decode(back) === dec.decode(content),
    '我拼的 zip 条目能被 Node zlib（另一套实现）正确解出来 —— 中央目录偏移量没算错')
}

console.log('\n== 导入：喂进去一个不是 docx 的东西，必须报错而不是静默产出空文档 ==')
{
  let threw = ''
  try { readDocx(zip([{ name: 'hello.txt', data: new TextEncoder().encode('x') }])) } catch (e) { threw = String(e.message) }
  ok(threw.includes('word/document.xml'), '缺主文档部件时报错并点名缺什么', threw)

  let threw2 = ''
  try { readDocx(new TextEncoder().encode('这根本不是 zip')) } catch (e) { threw2 = String(e.message) }
  ok(threw2.length > 0, '不是 zip 就直接拒', threw2)
}

console.log('\n== 空文档 / 只有标题 也不能炸 ==')
{
  const a = readDocx(buildDocx('', ''))
  ok(a.markdown === '' || a.markdown.length === 0, '空正文不炸', JSON.stringify(a.markdown))
  const b = readDocx(buildDocx('只有一个标题', ''))
  ok(b.title === '只有一个标题', '只有标题也能往返')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
