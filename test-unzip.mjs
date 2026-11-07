/**
 * test-unzip：ZIP 读取器
 *
 * 测试包**在测试里现造**（store 模式 + deflate 模式各一个），
 * 而不是找一个 zip 文件 —— 找一个 zip 来测自己写的 zip 读取器，
 * 等于用 A 验 A；而这里造包用的是**另一套完全不同的实现**
 * （Node 的 zlib + 手写的字节拼装），所以它能当基准。
 */
import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { isZip, listZip, lossyNames, readZipEntry, readZipText, unzipAll } from './src/lib/unzip.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/* ============================================================
   造 zip —— 刻意用**和被测代码完全不同**的方式拼字节
   ============================================================ */

const enc = new TextEncoder()

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** @typedef {{ name: string, data: Uint8Array, utf8Flag?: boolean, deflate?: boolean }} FileIn */

/** 只支持 store / deflate 两种 —— 测试不需要 zip64、加密、zip64 扩展 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const f of files) {
    // `nameBytes` 让你直接给原始名字字节 —— 用来造「flag 没置 + 字节真是 GBK」
    // 这种自洽的老包。走 `name` 的那条永远是 UTF-8 字节。
    const nameBytes = f.nameBytes || enc.encode(f.name)
    const crc = crc32(f.data)
    const useDeflate = !!f.deflate
    const payload = useDeflate ? new Uint8Array(deflateRawSync(f.data)) : f.data
    const method = useDeflate ? 8 : 0
    const flags = f.utf8Flag === false ? 0 : 0x0800

    const lh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)          // version needed
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true)         // time
    lv.setUint16(12, 0, true)         // date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, payload.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)         // extra len
    lh.set(nameBytes, 30)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)         // version made by
    cv.setUint16(6, 20, true)         // version needed
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, payload.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)         // extra
    cv.setUint16(32, 0, true)         // comment
    cv.setUint16(34, 0, true)         // disk
    cv.setUint16(36, 0, true)         // internal attrs
    cv.setUint32(38, 0, true)         // external attrs
    cv.setUint32(42, offset, true)
    cd.set(nameBytes, 46)

    locals.push(lh, payload)
    centrals.push(cd)
    offset += lh.length + payload.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const all = [...locals, ...centrals, eocd]
  const total = all.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of all) { out.set(c, p); p += c.length }
  return out
}

/* ============================================================ */

const txt = (s) => enc.encode(s)

console.log('\n== 认出是不是 zip ==')
{
  const z = makeZip([{ name: 'a.txt', data: txt('hi') }])
  ok(isZip(z), '认得自己造的 zip')
  ok(!isZip(txt('not a zip at all')), '普通文本不会被当成 zip')
  ok(!isZip(new Uint8Array(0)), '空文件也不会')
}

console.log('\n== 清单：只读中央目录，不解压 ==')
{
  const z = makeZip([
    { name: 'index.html', data: txt('<html>index</html>') },
    { name: '产品手册_12345.html', data: txt('<html>产品</html>'), deflate: true },
    { name: 'download/attachments/12345/diagram.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ])
  const list = listZip(z)
  ok(list.length === 3, `清单里有 3 个条目（实际 ${list.length}）`, JSON.stringify(list.map((e) => e.name)))
  ok(list[0].name === 'index.html', '第一个是 index.html', list[0].name)
  ok(list[1].name === '产品手册_12345.html', '**中文文件名解对了**', list[1].name)
  ok(list[1].method === 8, '认得出它是 deflate 的', String(list[1].method))
  ok(list[0].method === 0, '认得出 store 的', String(list[0].method))
  ok(list.every((e) => !e.lossy), 'UTF-8 标志置位时没有 lossy', JSON.stringify(list.map((e) => e.lossy)))
  const png = list.find((e) => e.name.endsWith('.png'))
  ok(png && png.size === 7, '记下了压缩前的真实大小', String(png && png.size))
}

console.log('\n== 读内容：store 与 deflate 都要对 ==')
{
  const body = '目录页正文。'.repeat(50)
  const z = makeZip([
    { name: 'store.txt', data: txt('A' + body + 'Z') },
    { name: 'deflate.txt', data: txt('A' + body + 'Z'), deflate: true },
  ])
  const list = listZip(z)
  const a = new TextDecoder().decode(await readZipEntry(z, list[0]))
  const b = new TextDecoder().decode(await readZipEntry(z, list[1]))
  ok(a === 'A' + body + 'Z', 'store 的读对了', a.slice(0, 20))
  ok(b === 'A' + body + 'Z', 'deflate 的读对了（解压后逐字相同）', b.slice(0, 20))
  ok(a === b, '两种压缩方式读出来的完全一致（这条最要紧：只测一种会漏）')
}

console.log('\n== 中文正文经过 deflate 也不该乱 ==')
{
  const s = '第一段：需求评审。\n第二段：技术方案，含「引号」和 & < > 符号。'
  const z = makeZip([{ name: '中文.html', data: txt(s), deflate: true }])
  const list = listZip(z)
  const got = await readZipText(z, list[0])
  ok(got === s, '逐字相同', JSON.stringify(got.slice(0, 30)))
}

console.log('\n== 目录项、空文件、多个同名不同路径 ==')
{
  const z = makeZip([
    { name: 'a/', data: new Uint8Array(0) },
    { name: 'a/b.txt', data: txt('nested') },
    { name: 'empty.txt', data: new Uint8Array(0) },
  ])
  const list = listZip(z)
  ok(list.find((e) => e.name === 'a/')?.isDir === true, '目录项被认出来了')
  const all = await unzipAll(z)
  ok(all.length === 2, `unzipAll 跳过目录项（实际 ${all.length} 个）`)
  ok(all.find((f) => f.name === 'empty.txt')?.bytes.length === 0, '空文件读出 0 字节而不是报错')
  const nested = all.find((f) => f.name === 'a/b.txt')
  ok(nested && new TextDecoder().decode(nested.bytes) === 'nested', '嵌套路径的条目能读出来', nested?.name)
}

console.log('\n== 坏包要报得清楚，不能静默给出半截数据 ==')
{
  let threw = ''
  try { listZip(txt('this is definitely not a zip')) } catch (e) { threw = String(e.message) }
  ok(/不是.*ZIP|不是.*zip/.test(threw), '不是 zip 时说清楚了', threw)

  /*
   * 截断的包，两种截法要分开看，因为**先在哪一步炸**不一样：
   *
   * ① 切掉尾部（含 EOCD）→ `listZip` 就该抛「找不到中央目录」。
   *    这条测的是**别把半个包当成完整的**。
   * ② 保留 EOCD 与中央目录、只损坏某个条目的**数据**→ 清单能读出来，
   *    读那一项时才该抛。清单能读出来是对的：中央目录本身是完好的，
   *    报「整个包坏了」反而会让人以为导出失败、连能救的条目也一起丢。
   *
   * 第一版只写了 ①，却顺手把 ② 也当成「listZip 会抛」——
   * 结果它抛的是 ① 那句话，测试过了，但我以为验的是 ②。
   * **「过了」和「验的是我想验的那件事」是两回事。**
   */
  const z = makeZip([{ name: 'x.txt', data: txt('D'.repeat(200)), deflate: true }])
  {
    const cut = z.subarray(0, z.length - 40)   // EOCD 被切掉
    let msg = ''
    try { listZip(cut) } catch (e) { msg = String(e.message) }
    ok(/中央目录/.test(msg), '① 切掉尾部 → listZip 说「找不到中央目录」', `返回了「${msg}」`)
    ok(msg !== '', '① 不会把半个包当成完整的包', '没抛错')
  }
  {
    // EOCD 与中央目录完好，但把该条目的**数据**抹成 0 字节（声明的长度不变）
    const list = listZip(z)
    const e0 = list[0]
    const corrupt = z.slice()
    // 本地头里的数据起点 = localOffset + 30 + nameLen + extraLen
    const nameLen = z[e0.localOffset + 26] | (z[e0.localOffset + 27] << 8)
    const extraLen = z[e0.localOffset + 28] | (z[e0.localOffset + 29] << 8)
    const dataStart = e0.localOffset + 30 + nameLen + extraLen
    corrupt.fill(0, dataStart, dataStart + e0.compressedSize)   // 数据全毁，声明的长度不变
    let msg = ''
    try { await readZipEntry(corrupt, e0) } catch (e) { msg = String(e.message) }
    ok(msg !== '', '② deflate 数据被毁 → 读那一项时抛错，不是返回一坨零字节', `返回了「${msg}」`)
    /*
     * 这一条单独钉，因为它是本轮实测出来的一个真问题：
     * `DecompressionStream` 的失败**不在 await 处抛**，它把 stream 标记成
     * errored，于是 `await new Response(stream).arrayBuffer()` 抛出来的是
     * `TypeError: terminated` —— **一个字的 `terminated`，不说是哪个文件**。
     * 在解析 Confluence 导出包时那意味着几百个条目里某一个坏了，
     * 用户完全不知道是哪一篇。
     */
    ok(/x\.txt/.test(msg), '② 解压失败的错误里带着**文件名**（否则用户不知道哪一篇坏了）', msg)
    ok(!/terminated$/.test(msg.trim()), '② 不是把 `terminated` 原样抛给用户', msg)
  }
  {
    /*
     * **store 模式也必须核长度** —— 这一条是我补的，第一版漏了：
     * 那时只给 deflate 加了长度核对，store 直接 `return raw.slice()`。
     * 而 store 那条路不核对的话，一个「声明的比实际的多」的包会
     * **静默返回一坨截断的内容**，调用方当成「这个文件本来就短」——
     * 表现是「导入后这篇正文缺了尾巴」，界面上完全看不出是包坏了。
     *
     * 造法：**把中央目录里声明的长度改大**。这正是「导出中途断了」的形态 ——
     * 中央目录写在最后，所以它记录的是「本来该有多少」，
     * 而文件数据实际没写完。
     *
     * ⚠️ 第一版我把数据 `fill(0)` 了一遍，指望「内容坏了」能被发现 ——
     * 但 store 模式下**长度没变**，所以读出来还是那个长度、内容全是 0，
     * 长度核对自然通过。那样测的根本不是「截断」。
     */
    const zs = makeZip([{ name: '明文.txt', data: txt('S'.repeat(50)) }])   // store，声明 50
    const eocdPos = zs.length - 22
    const cdOffset = zs[eocdPos + 16] | (zs[eocdPos + 17] << 8) | (zs[eocdPos + 18] << 16) | (zs[eocdPos + 19] << 24)

    const cs = zs.slice()
    // 中央目录里 uncompressed size 在 +24，compressed size 在 +20
    const put32 = (buf, at, v) => { buf[at] = v & 0xff; buf[at + 1] = (v >> 8) & 0xff; buf[at + 2] = (v >> 16) & 0xff; buf[at + 3] = (v >>> 24) & 0xff }
    put32(cs, cdOffset + 20, 5000)   // 声明压缩后 5000（实际只有 50）
    put32(cs, cdOffset + 24, 5000)   // 声明解压后 5000

    const es = listZip(cs)[0]
    ok(es.size === 5000, '（前置确认）中央目录里声明的长度确实被改大了', String(es.size))
    let msg = ''
    try { await readZipEntry(cs, es) } catch (e) { msg = String(e.message) }
    ok(msg !== '', '② store 声明的长度大于实际 → 抛错，不静默返回截断内容', `返回了「${msg}」`)
    ok(/明文\.txt/.test(msg), '② store 的错误里也带文件名', msg)

    /*
     * 反向：中央目录声明得**比实际小**。
     *
     * 这条我一开始觉得该红，试完发现**不该红，而且红不了**：
     * store 模式下 `compressedSize === size`，两者一起被改成 10，
     * 于是取出来的就是前 10 字节 —— 那**本来就该是**「这个文件只有 10 字节」。
     *
     * ZIP 格式里没有校验和能区分「本来就 10 字节」和「谎报了 10 字节」：
     * CRC 在中央目录里也有，而**校验 CRC 需要把内容读出来**，
     * 而内容正是被谎报的那部分。所以从包里**无法**判断。
     *
     * 于是这条改成如实记录这个边界，而不是造一条恒假的断言。
     * 这正是 7.19 那条判据：做不到就别写成保护。
     */
    const cs2 = zs.slice()
    put32(cs2, cdOffset + 20, 10)
    put32(cs2, cdOffset + 24, 10)
    const es2 = listZip(cs2)[0]
    const got = await readZipEntry(cs2, es2)
    ok(got.length === 10 && new TextDecoder().decode(got) === 'S'.repeat(10),
      '（边界）store 谎报得更小 → 读出前 10 字节，**不是错误**：ZIP 格式本身判断不出来',
      `${got.length} 字节`)
  }
}

console.log('\n== 文件名没置 UTF-8 标志时：别装作全对 ==')
/*
 * ⚠️ 造包时 `name` 走的是 `enc.encode()`，那是**总是 UTF-8** 的编码。
 * 所以「不置 UTF-8 标志 + 名字含非 ASCII」这个组合，用 makeZip 造不出来 ——
 * 第一次我以为造出来了，测出来 lossy=false 才发现：**我造的是个自相矛盾的包**。
 *
 * 真实世界确实存在这种包（Confluence 在中文 Windows 上导出的老包就是），
 * 所以这里改成直接改字节：照着中央目录里 nameLen 那几格的位置，
 * 把 UTF-8 的字节**原地换成 GBK 字节**（长度相同，不动任何偏移）。
 * 只有名字本身的编码变了，头里的 flag 仍然是「没置 UTF-8」——
 * 这才是解码器真正要面对的输入。
 */
const asciiZip = makeZip([{ name: 'legacy-page.html', data: txt('<html/>'), utf8Flag: false }])
const asciiList = listZip(asciiZip)
ok(asciiList.length === 1 && asciiList[0].name === 'legacy-page.html',
  '纯 ASCII 的包照常解对（不误报 lossy）', asciiList[0].name)
ok(asciiList[0].lossy === false, 'ASCII 不算 lossy', String(asciiList[0].lossy))
ok(lossyNames(asciiList).length === 0, '全对的包汇总出来是空的', JSON.stringify(lossyNames(asciiList)))

{
  /*
   * ⚠️ 上一版这里造不出想要的东西，而且**测试还是绿的**，差点就过去了。
   *
   * 我造包时 `name` 走 `TextEncoder.encode()`，那是**总是 UTF-8** 的编码；
   * 而 `utf8Flag: false` 只是把头里的 flag 关掉，字节本身还是 UTF-8。
   * 于是造出来的是个**自相矛盾的包**（内容 UTF-8、标志说不是 UTF-8），
   * `decodeName` 走「UTF-8 解出来没有替换字符」那条分支，直接返回 lossy=false。
   * 测试通过，但我以为验的是「GBK 名的老包」—— 差得远。
   *
   * 而这个差别在真实世界**正好相反**：老包恰恰是「字节是 GBK、标志没置」，
   * 那种情况 UTF-8 解出来**必然有替换字符**，才会走 lossy 分支。
   *
   * 造法：让 makeZip 支持直接给原始名字字节，长度自己算。
   * 这样包是**自洽**的：flag 没置 + 字节真是 GBK。
   */
  const gbkName = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x68, 0x74, 0x6d, 0x6c])  // "产品.html" 的 GBK
  const z2 = makeZip([{ nameBytes: gbkName, data: txt('<html/>'), utf8Flag: false }])
  const list2 = listZip(z2)
  ok(list2.length === 1, 'GBK 名的包能读出清单', String(list2.length))
  ok(list2[0].lossy === true,
    '**字节真是 GBK 且没置标志 → 标成 lossy**（这才是老包的真实形状）', String(list2[0].lossy))
  // U+FFFD 用 fromCharCode 构造，不写字面量 —— `test-lint` 会扫源码里的
  // 乱码替换字符，而这条检查自己带一个的话，**它自己会被那条 lint 抓**。
  // 实测就是这样（第一次跑全量时 test-lint 红了 1 项，指的就是这里）。
  const REPL = String.fromCharCode(0xfffd)
  ok(!list2[0].name.includes(REPL),
    '**即使 lossy 也不出现替换字符**（乱码比近似更难查）', JSON.stringify(list2[0].name))
  ok(/\.html$/.test(list2[0].name),
    'ASCII 后缀保住了（文件类型不能丢，否则连「这是不是页面」都判断不了）', JSON.stringify(list2[0].name))
  const lossy = lossyNames(list2)
  ok(Array.isArray(lossy) && lossy.length === 1, 'lossyNames 能汇总出来给界面提示', JSON.stringify(lossy))
}

console.log('\n== 源码层面：几个最容易写错的点 ==')
{
  const src = readFileSync('src/lib/unzip.ts', 'utf8')
  ok(/central directory/i.test(src) || /中央目录/.test(src), '注释里写清了中央目录这个结构（下一个改这里的人需要）')
  // 数据长度必须取中央目录的，本地头那份只是用来跳变长字段
  ok(/e\.compressedSize/.test(src), '读数据用的是中央目录给的压缩后长度')
  ok(/nameLen/.test(src) && /extraLen/.test(src), '本地头只用来算 nameLen/extraLen 来跳字段')
  ok(!/new DataView/.test(src), '整数读取没用 DataView（byteOffset 不为 0 时会错）')
  // 剥注释再扫 —— 这条检查的价值全在**代码**里。
  // 一开始这个正则没剥注释，结果源码注释里那句
  // 「`ibm866` 是 DOS 西里尔文，不是它」里的 `ibm866` 被匹配到了，
  // 断言恒红。而那句注释恰恰是**对的**、也是**必须留着的**。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  ok(!/ibm866/.test(code), '**代码里没有把 ibm866 当成 CP437**（那是 DOS 西里尔文）；已剥注释，别被注释里那句说明骗到')
  // catch 参数绝不能标 any，且不能和条目同名 —— 否则 e.name 取到的是错误类名
  const fnI = code.indexOf('export async function readZipEntry')
  const fnSeg = code.slice(fnI, code.indexOf('\n}\n', fnI))
  ok(!/catch\s*\(\s*\w+\s*:\s*any\s*\)/.test(fnSeg),
    '**catch 的参数没有标 any**（`any` 会让「用错了名字」静默通过类型检查）', /catch\s*\(\s*\w+\s*:\s*any\s*\)/.exec(fnSeg)?.[0] || '')
  ok(!/catch\s*\(\s*e\s*\)/.test(fnSeg),
    'catch 的参数没有叫 `e`（那会和 zip 条目重名，把 e.name 变成「错误的类名」）',
    /catch\s*\(\s*\w+\s*\)/.exec(fnSeg)?.[0] || '')
  // 解压失败必须在 readZipEntry 里被 catch 住并补上文件名
  const i2 = src.indexOf('export async function readZipEntry')
  const seg2 = src.slice(i2, src.indexOf('\n}\n', i2))
  ok(/catch/.test(seg2), '解压的失败被 catch 了（DecompressionStream 的错误是异步冒出来的）')
  ok(/e\.name/.test(seg2), 'catch 住之后把**文件名**补进错误信息里')
}

/*
 * 破坏对照：不碰实现，**改测试自己造的数据**，看「长度核对」那条还拦不拦得住。
 *
 * 为什么不用改源码做对照：这个套件的价值全在「我造出来的包是不是真的坏」，
 * 一旦去改 `unzip.ts`，对照的是「实现改了会怎样」，
 * 而不是「我这份坏包造得对不对」。后者才是这一层要验的东西。
 *
 * 而且这里有一个**很容易以为能过、实际过不了**的坑：
 * store 模式下「把数据 fill(0)」**长度没变**，长度核对当然通过。
 * 第一版就是这么写的，测试还绿了 —— 它验的根本不是「截断」。
 * 所以对照要拆成两半：坏包必须是「**声明的比实际的多**」那个形状。
 */
console.log('\n== 破坏对照：把坏包换成「自相矛盾」的那种，核对就不该拦 ==')
{
  const zs = makeZip([{ name: 'S.txt', data: txt('S'.repeat(50)) }])
  const eocdPos = zs.length - 22
  const cdOffset = zs[eocdPos + 16] | (zs[eocdPos + 17] << 8) | (zs[eocdPos + 18] << 16) | (zs[eocdPos + 19] << 24)
  const put32 = (buf, at, v) => { buf[at] = v & 0xff; buf[at + 1] = (v >> 8) & 0xff; buf[at + 2] = (v >> 16) & 0xff; buf[at + 3] = (v >>> 24) & 0xff }

  // 反例 A：数据仍是 50 字节，声明也仍是 50 —— **这是完好的包**
  {
    const e = listZip(zs)[0]
    const got = await readZipEntry(zs, e)
    ok(got.length === 50, '（对照 A）完好的包照常读出 50 字节（核对不会误伤正常的）', String(got.length))
  }
  // 反例 B：内容被 fill(0) 但长度没变 —— 长度核对**拦不住**（这是格式的边界）
  {
    const cs = zs.slice()
    const e0 = listZip(cs)[0]
    const nl = cs[e0.localOffset + 26] | (cs[e0.localOffset + 27] << 8)
    const el = cs[e0.localOffset + 28] | (cs[e0.localOffset + 29] << 8)
    const ds = e0.localOffset + 30 + nl + el
    cs.fill(0, ds, ds + e0.compressedSize)
    const e = listZip(cs)[0]
    let msg = ''
    try { await readZipEntry(cs, e) } catch (err) { msg = String(err.message) }
    ok(msg === '', '（对照 B）store 长度没变、内容全毁 → **拦不住**（要拦只能验 CRC，见 unzip.ts 里的取舍）', `抛了「${msg}」`)
    ok(msg === '', '　　（留这条是因为「怎么破坏都不红」本身就是信息：它说明这条检查的边界在哪）')
  }
  // 正例：声明的比实际多 —— 这才是「导出没写完」，必须拦
  {
    const cs = zs.slice()
    put32(cs, cdOffset + 20, 5000)
    put32(cs, cdOffset + 24, 5000)
    const e = listZip(cs)[0]
    let msg = ''
    try { await readZipEntry(cs, e) } catch (err) { msg = String(err.message) }
    ok(msg !== '', '（对照 C）声明 5000 实际 50 → 拦住了', `抛了「${msg}」`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
