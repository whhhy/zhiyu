/*
 * 文件名净化 —— **整个项目只有这一份**。
 *
 * ============================================================
 * 为什么单独立一个文件
 * ============================================================
 * 以前有两个**同名但实现不同**的 `safeName`：
 *   · `book-export.ts` —— 只替换非法字符，**保留中文**
 *   · `io.ts`           —— 把**所有非 ASCII** 换成 `_`
 *
 * 结果是：导出一篇《产品手册》，
 *   Markdown（走 book-export 那条路）→ `产品手册.md` ✅
 *   Word / HTML / 纯文本（走 io 那条） → `untitled-20261014-1006.docx` ❌
 * 也就是这个中文知识库**四种导出格式里三种丢掉文件名**，
 * 而且同一天导出的多篇会撞名（浏览器只能追加 (1)(2)）。
 *
 * `io.ts` 那份的理由写在它自己的注释里：「部分浏览器（无头 Chromium 就是）
 * 会把 download 属性里的非 ASCII 文件名整个丢成 download」。
 * 那个前提**过时**了 —— 现代浏览器都支持 `a.download` 里的 UTF-8 文件名，
 * 而代价是一个中文知识库导出的文件全叫 `untitled-…`。
 *
 * 保留的规则只有两类，都是真的：
 *   · **文件名里非法的字符**：反斜杠、斜杠、冒号、星号、问号、引号、
 *     尖括号、竖线，以及控制字符（U+0000–U+001F）
 *   · **Windows 不允许结尾是点或空格**（导出到那上面会静默失败）
 * 至于中文、空格、书名号这类标点 —— 浏览器都吃得下，保留。
 *
 * 统一之后：**一份实现，两个调用方**，
 * 下一个人再写第三个导出格式时会 import 它，而不是照抄其中一份。
 */

/** Windows / 常见文件系统里真正非法的字符（**注意：不包括非 ASCII**） */
const ILLEGAL = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', 'g')

/**
 * 把任意标题变成一个能安全落盘的文件名（**不含扩展名**）。
 *
 * @param raw      原始标题（多半是中文）
 * @param fallback 清洗后空掉时用的兜底名（**含扩展名**，由调用方拼）
 */
export function safeFileName(raw: string, fallback: string): string {
  let s = String(raw || '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim()
  // 结尾的点与空格在 Windows 上会被静默丢掉（导出到那上面文件直接消失）
  s = s.replace(/[. ]+$/, '')
  if (!s) return fallback
  // 太长的路径在 Windows 上也会炸，截断并留个可读的尾巴
  return s.length > 80 ? s.slice(0, 70) + '…' + s.slice(-8) : s
}

/** 带时间戳的兜底文件名（不含扩展名）：`untitled-20261014-1006` */
function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `untitled-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

/*
 * ⚠️ 这里原来还有一个导出的 `stampedFallback(ext, now)`，**零引用** ——
 *    是我 2026-10-14 做这次收拢时顺手加的，后来那条路走的是
 *    `safeFileNameWithExt` 内部直接调 `stamp()`（见下面第 84 行），
 *    它就再没人调了。
 *
 * 删掉的理由和删 `lib/sync.ts` 那份 `wsUrl` 一样：**它是个假的修复目标**。
 * 将来「兜底文件名不对」时，有人会来改这个函数 ——
 * 而实际生效的路径根本不走它，改了**毫无效果**，代码却看着完全正常。
 */

/**
 * 单篇导出用：**净化 + 补上扩展名**。
 *
 * ⚠️ 以前 `io.ts` 那份 `safeName(raw, fallbackExt)` **只在回退分支带扩展名**，
 *    正常分支直接返回标题 —— 于是每次成功导出都是**无扩展名文件**：
 *      导出 Word    → `产品手册`（双击打不开）
 *      导出 HTML    → `产品手册`
 *    标题是中文时它恰好走了回退分支、扩展名又有了，所以**一直没被发现** ——
 *    一个 bug 恰好被另一个 bug 挡住了。
 *
 *    而 Markdown 那条路（book-export）自己拼扩展名，所以一直是好的 ——
 *    四种格式里只有它正常，也是同一个原因。
 */
export function safeFileNameWithExt(raw: string, ext: string, now = new Date()): string {
  const s = String(raw || '').trim()
  const dotExt = new RegExp(`\\.${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  // 标题**已经**是这个名字了，补一次就成 `手册.md.md`
  if (dotExt.test(s)) return safeFileName(s, '')
  // 否则把标题自带的那个扩展名去掉再补目标的 ——「手册.md」导成 Word 该叫 `手册.docx`
  const base = safeFileName(s.replace(/\.[A-Za-z0-9]{1,8}$/, ''), '')
  return `${base || stamp(now)}.${ext}`
}
