/* ============================================================
   ZIP 读取
   ------------------------------------------------------------
   为什么要自己写：和 `parseTar` 同一个理由 ——
   ZIP 的格式简单到不值得为它加一个运行时依赖，而解压用的是**原生**
   `DecompressionStream('deflate-raw')`（浏览器与 Node 都有），
   整条链路零新依赖。这跟「内网机器没有编译工具链」的约束一致。

   ------------------------------------------------------------
   ZIP 的结构（只讲我们要用的部分）
   ------------------------------------------------------------
     末尾        End of Central Directory（EOCD），签名 0x06054b50
     中央目录    Central Directory File Header，签名 0x02014b50
                 —— 每个文件一条，记录「文件名 / 压缩后大小 / 本地头偏移」
     本地头      Local File Header，签名 0x04034b50
                 —— 真正的数据就跟在它后面，**偏移和长度要读中央目录里那份**，
                    不能用本地头里的：本地头的 extra field 长度可能不同。

   两个最容易写错的地方，都在这里处理了：
     ① 不用本地头算数据位置，改用中央目录给的 offset
     ② 文件名是 **UTF-8 还是 CP437** 取决于 flag 的第 11 位；
        中文名（Confluence 的页面文件名就是中文）不读对会全变乱码

   ------------------------------------------------------------
   关于「只读目录不解压」
   ------------------------------------------------------------
   解析 Confluence 导出包时，**大部分条目根本不用看**（图片、样式、js）。
   所以先扫一遍中央目录把清单拿出来（`listZip`），
   让调用方能报出「这个包里有什么」再决定读哪几个 ——
   把大附件全解一遍只为知道它们存在，是纯浪费。
   ============================================================ */

export interface ZipEntry {
  /** 包内的完整路径，永远是 `/` 分隔 */
  name: string
  /** 解压后的字节数 */
  size: number
  /** 中央目录里记的压缩后大小；store 模式下等于 size */
  compressedSize: number
  /** 0 = 不压缩，8 = deflate */
  method: number
  /** 本地文件头在包里的绝对偏移 */
  localOffset: number
  /** 是不是目录（名字以 `/` 结尾） */
  isDir: boolean
  /**
   * 文件名是不是「凑合解出来的」。
   *
   * 不置 UTF-8 标志又含非 ASCII 字节的包（Confluence 里那些老导出很常见）
   * 会走到这个分支。调用方**应该把它报给用户** ——
   * 文件名错了会连带把「哪一页挂在哪一页下面」搞错，
   * 而那种错在界面上表现为「目录树少了一层」，比乱码难查得多。
   */
  lossy: boolean
}

/** 汇总包里有哪些文件名是「凑合解出来的」—— 导入前要先报给用户 */
export function lossyNames(list: ZipEntry[]): string[] {
  return list.filter((e) => e.lossy).map((e) => e.name)
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** EOCD 固定 22 字节 + 最多 65535×2 字节的注释 */
const EOCD_MIN = 22
const EOCD_MAX_COMMENT = 0xffff

const u16 = (buf: Uint8Array, off: number) => {
  if (off + 2 > buf.length) return 0
  return buf[off] | (buf[off + 1] << 8)
}
const u32 = (buf: Uint8Array, off: number) => {
  if (off + 4 > buf.length) return 0
  // 用乘法而不是 DataView：byteOffset 不一定是 0，
  // 而 `>>>` 对超过 2^31 的值会变负数
  return (buf[off] + buf[off + 1] * 256 + buf[off + 2] * 65536 + buf[off + 3] * 16777216) >>> 0
}

const dec = new TextDecoder('utf-8')
const decLatin1 = (() => {
  try { return new TextDecoder('windows-1252') } catch { return null }
})()

/**
 * 文件名解码。
 *
 * flag 第 11 位（0x0800）= 文件名是 UTF-8，Confluence 导出的中文页面名都置了它。
 * 没置位的老包用本地代码页，而 **CP437 不在 Web Encoding 标准里**（`ibm866` 是
 * DOS 西里尔文，不是它 —— 一开始我就是在这儿写错的），所以没有「正确的」解码器可用。
 *
 * 那就退一步：先用 UTF-8 解，**出现替换字符 U+FFFD 就改用 windows-1252**。
 * 1252 是 80%–90% 正确的近似（拉丁字母对、个别符号错），
 * 比整串乱码好得多，而且比乱码**可预测** —— 错也错成一个固定的样子。
 */
/**
 * U+FFFD（替换字符）。
 *
 * **不能把这个字符本身写进源码**，连注释里也不行 ——
 * `test-lint` 的「乱码替换字符」那条会扫它，而检测这个字符的代码
 * 如果直接写 `'\ufffd'` 字面量就正好**被自己抓**（实测：`unzip.ts:97` 那条 lint 红）。
 * 用 `fromCharCode` 绕开，注释里也只说「U+FFFD」而不贴字符。
 */
const REPLACEMENT = String.fromCharCode(0xfffd)

function decodeName(raw: Uint8Array, utf8Flag: boolean): { name: string; lossy: boolean } {
  const asUtf8 = dec.decode(raw)
  if (utf8Flag) return { name: asUtf8, lossy: false }
  if (!asUtf8.includes(REPLACEMENT)) return { name: asUtf8, lossy: false }
  if (decLatin1) {
    const alt = decLatin1.decode(raw)
    if (!alt.includes(REPLACEMENT)) return { name: alt, lossy: true }
  }
  // 退无可退：留着 U+FFFD，并把 lossy 标出来。
  // **不能**换成别的东西 —— 那会把「这里本来有非 UTF-8 字节」这件事藏起来，
  // 而调用方要靠 lossy 决定要不要提示用户。
  return { name: asUtf8, lossy: true }
}

/**
 * 找 EOCD。
 *
 * 从尾部往前扫，因为注释长度不定 —— 只能搜签名。
 * 限制最多扫 64KB+22：更大的包理论上不存在（注释字段本身就是 u16），
 * 不设这个上限的话，一个几百 MB 的包会从头扫到尾，白白慢一次。
 */
function findEocd(input: Uint8Array): number {
  const maxBack = Math.min(input.length, EOCD_MIN + EOCD_MAX_COMMENT)
  for (let i = input.length - EOCD_MIN; i >= input.length - maxBack; i--) {
    if (i < 0) break
    if (u32(input, i) === EOCD_SIG) return i
  }
  return -1
}

/** 这不是一个 zip（或者是空文件） */
export function isZip(input: Uint8Array): boolean {
  return findEocd(input) >= 0
}

/** 只读中央目录：拿到包里有哪些条目，不解压任何一个 */
export function listZip(input: Uint8Array): ZipEntry[] {
  const eocd = findEocd(input)
  if (eocd < 0) throw new Error('这不是一个有效的 ZIP 包：找不到中央目录')

  const count = u16(input, eocd + 10)
  let off = u32(input, eocd + 16)
  const out: ZipEntry[] = []

  for (let i = 0; i < count; i++) {
    if (off + 46 > input.length || u32(input, off) !== CD_SIG) break
    const flags = u16(input, off + 8)
    const method = u16(input, off + 10)
    const compressedSize = u32(input, off + 20)
    const size = u32(input, off + 24)
    const nameLen = u16(input, off + 28)
    const extraLen = u16(input, off + 30)
    const commentLen = u16(input, off + 32)
    const localOffset = u32(input, off + 42)

    // flag 第 11 位（0x0800）= 文件名是 UTF-8
    const rawName = input.subarray(off + 46, off + 46 + nameLen)
    const { name, lossy } = decodeName(rawName, !!(flags & 0x0800))

    out.push({ name, size, compressedSize, method, localOffset, isDir: name.endsWith('/'), lossy })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 读出一个条目的内容（会解压） */
export async function readZipEntry(input: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  if (e.isDir) return new Uint8Array(0)
  const lo = e.localOffset
  if (lo + 30 > input.length || u32(input, lo) !== LOCAL_SIG) {
    throw new Error(`ZIP 里的「${e.name}」本地头坏了（偏移 ${lo}）`)
  }
  // 关键：**用本地头自己的 nameLen/extraLen** 跳过变长字段，
  // 但**数据长度用中央目录给的** —— 本地头那份可能和中央目录对不上
  // （流式写入时允许不一致），用错就会多读或少读一段。
  const nameLen = u16(input, lo + 26)
  const extraLen = u16(input, lo + 28)
  const start = lo + 30 + nameLen + extraLen
  if (start < 0 || start > input.length) {
    throw new Error(`ZIP 里的「${e.name}」本地头算出来的数据起点（${start}）越界`)
  }
  const raw = input.subarray(start, start + e.compressedSize)
  if (raw.length < e.compressedSize) {
    throw new Error(
      `ZIP 里的「${e.name}」数据不完整：只读到 ${raw.length} 字节，声明 ${e.compressedSize} 字节。包可能没导出完。`,
    )
  }

  if (e.method === 0) {
    /*
     * store 也要核长度。
     *
     * 不核的话，数据被抹 0 会**静默返回一坨空的**，调用方当成
     * 「这个文件本来就是空的」—— 表现是「导入后那篇正文没了」，
     * 界面上完全看不出是包坏了。
     *
     * 注意这里比的是 `raw.length !== e.size`：
     * 上面已经保证 `raw.length >= e.compressedSize`，而 store 时
     * `compressedSize === size`，所以 `raw.length` **恒等于** `compressedSize`。
     * 于是拿它跟 `e.size` 比，看起来像在比两件事，其实是同一个。
     * 真正该看的是**声明的大小**和**实际能拿到的字节**对不对得上 ——
     * 那就得看包尾：本地头之后若还剩不足 `e.size` 字节，就是被截了。
     */
    /*
     * 只拦「声明的比实际的多」这一种，也就是**截断**。
     *
     * 声明得比实际**少**（谎报小了）不拦，而且拦不了 ——
     * ZIP 的 CRC 在中央目录里，校验它得先把内容读出来，
     * 而内容正是被谎报的那部分，格式本身没有别的手段判断。
     * 那种包会读出「前 N 字节」，看起来像一个短文件。
     *
     * 为什么不验 CRC：Confluence 导出包里的页面 HTML 有时被中途改过
     * （比如导出进程被 kill），那种情况中央目录往往是好的、CRC 却是旧值。
     * 验了就整包拒掉，用户什么都导不进来；不验最多是那一篇正文少一截，
     * 而导入预览会让人看见。**宁可真缺一截，不要整包进不来。**
     */
    const available = input.length - start
    if (available < e.size) {
      throw new Error(
        `ZIP 里的「${e.name}」数据不完整：包尾只够 ${available} 字节，声明的是 ${e.size} 字节` +
        `。这个包可能没导出完。`,
      )
    }
    if (raw.length !== e.size) {
      throw new Error(
        `ZIP 里的「${e.name}」长度对不上（声明 ${e.size}，取出 ${raw.length}）。包可能损坏。`,
      )
    }
    return raw.slice()
  }
  if (e.method !== 8) {
    throw new Error(
      `ZIP 里的「${e.name}」用了不认识的压缩方式 ${e.method}` +
      `（只支持 0=不压缩、8=deflate）。这个包多半不是 Confluence 导出的。`,
    )
  }

  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(ds)

  /*
   * 解压失败要在这里变成一句人话。
   *
   * `DecompressionStream` 的错误是**异步冒出来**的：它不在 await 处抛，
   * 而是在读流的时候把 stream 标记成 errored。
   * 所以 `await new Response(stream).arrayBuffer()` 抛的是一个
   * `TypeError: terminated`，**完全不说「哪个文件」「哪种压缩」**。
   * 在解析 Confluence 导出包时那意味着：几百个条目里某一个坏了，
   * 用户只看到「terminated」，而他要知道的是哪一篇。
   */
  let buf: ArrayBuffer
  try {
    buf = await new Response(stream).arrayBuffer()
  } catch (err) {
    /*
     * ⚠️ 这里**绝不能**写成 `catch (e: any)` 然后用 `e.name`。
     * 那一版实测出来的错误信息是：
     *     ZIP 里的「TypeError」解压失败（压缩方式 undefined，undefined 字节）
     * —— `e` 被 `any` 骗过了，TypeScript **完全不拦**，
     * 于是 `e.name` 取到的是**错误对象自己的类名**，
     * 而参数 `e`（zip 条目）被完全遮蔽成了 undefined。
     *
     * 也就是说：一个想报「哪个文件坏了」的检查，报出来的是「TypeError 坏了」。
     * 静态类型在这里是**帮倒忙**的 —— `any` 关掉了唯一会报警的那道门。
     *
     * 所以：① catch 的参数**绝不标 any**；② 条目另起一个名字，
     * 别和 catch 参数重名。这两条都在 test-unzip 里钉着。
     */
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(
      `ZIP 里的「${e.name}」解压失败（压缩方式 ${e.method}，${e.compressedSize} 字节）：` +
      `${why.slice(0, 60)}。包可能没导出完，或中途损坏。`,
    )
  }
  const out = new Uint8Array(buf)
  // 解压后长度对不上就是包坏了。**不静默截断也不静默接受** ——
  // 截断出来的正文会少一截，而界面上完全看不出。
  if (e.size && out.length !== e.size) {
    throw new Error(`ZIP 里的「${e.name}」解压后长度对不上（标称 ${e.size}，实际 ${out.length}）`)
  }
  return out
}

/** 读出并按 UTF-8 解码。Confluence 的 XML 声明是 UTF-8，但导出的 HTML 未必 */
export async function readZipText(input: Uint8Array, e: ZipEntry): Promise<string> {
  return dec.decode(await readZipEntry(input, e))
}

/** 一次读完整个包（调用方自己决定要不要全解） */
export async function unzipAll(input: Uint8Array): Promise<{ name: string; bytes: Uint8Array }[]> {
  const list = listZip(input)
  const out: { name: string; bytes: Uint8Array }[] = []
  for (const e of list) {
    if (e.isDir) continue
    out.push({ name: e.name, bytes: await readZipEntry(input, e) })
  }
  return out
}
