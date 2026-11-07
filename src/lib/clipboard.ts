/* ============================================================
   剪贴板（2026-10-19 重写）
   ============================================================
   为什么要重写：原来只有块菜单里的「复制内容 / 粘贴」两个旁门，
   而**编辑器根本没有接管 Ctrl+C / Ctrl+X**。于是：

   · 用户按 Ctrl+C（最常用的路径）走的是浏览器原生行为 —— 只写纯文本，
     `blockClipboard` 纹丝不动；
   · 接着他打开某个块的菜单点「粘贴」，粘出来的是**上一次点菜单复制的那个块**，
     跟刚才那次 Ctrl+C 毫无关系；
   · 他要是从没点过那个菜单，菜单里的「粘贴」还是置灰的 ——
     「我刚按了 Ctrl+C 啊」。

   更糟的是那一半（写系统剪贴板）在**内网部署下根本不存在**：

   `navigator.clipboard` 只在**安全上下文**里提供，而内网是
   `http://192.168.1.16:8080`（实测 `isSecureContext === false`、
   `typeof navigator.clipboard === 'undefined'`）。
   而代码写的是 `navigator.clipboard?.writeText(...)` ——
   那个 `?.` 让「API 不存在」和「写入成功」在界面上**完全一样**：
   菜单照关、不报错、不提示。**localhost 上测不出来，只有内网会中招。**
   （同一行写法全项目有 5 处，其中「复制链接」还会弹**绿色的「链接已复制」**。）

   --------------------------------------------------------
   做法：和语雀 / Notion 一样，往系统剪贴板里写**自定义 MIME**
   --------------------------------------------------------
   · `application/x-yuque-block` = 块结构（JSON），连 `type` 和 `data` 一起
   · `text/html`             = 给 Word / 飞书 / 表格这类富文本目标
   · `text/plain`            = 给记事本、跨应用粘贴（这个**必须有**）

   paste 事件的优先级：图片 > 自定义块 > Markdown > 纯文本。

   ⚠️ 降级必须**如实说**。非安全上下文下只剩 `execCommand('copy')`，
   它只能带纯文本 —— 那时候界面必须告诉用户「结构没带走」，
   而不是让人以为复制了一个完整的块。
   ============================================================ */

/** 自定义 MIME：块结构 */
export const BLOCK_MIME = 'application/x-yuque-block'

export type CopiedBlock = {
  type: string
  text: string
  data?: Record<string, any>
}

export type CopyResult =
  /** 写成功，`rich` 为真表示自定义 MIME 也写进去了（结构能原样粘回来） */
  | { ok: true; rich: boolean }
  /** 写失败或只能降级，调用方**必须把 message 如实告诉用户** */
  | { ok: false; rich: false; reason: 'no-api' | 'denied'; message: string }

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 一个块 → HTML（跨富文本目标用）。认得的类型才转，认不出来的原样进 <p>。 */
export function blockToHtml(b: CopiedBlock): string {
  const t = b.type
  const text = b.text || ''
  const lines = text.split('\n')
  if (t === 'table' && lines.length >= 2 && /^\s*\|/.test(text)) {
    const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const head = cells(lines[0])
    const body = lines.slice(2).map(cells)
    return '<table><thead><tr>' + head.map((c) => `<th>${esc(c)}</th>`).join('') +
      '</tr></thead><tbody>' +
      body.map((r) => '<tr>' + r.map((c) => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table>'
  }
  if (/^h[1-6]$/.test(t)) return `<${t}>${esc(text)}</${t}>`
  if (t === 'quote') return `<blockquote>${esc(text)}</blockquote>`
  if (t === 'code') return `<pre><code>${esc(text)}</code></pre>`
  if (t === 'ul' || t === 'ol') {
    const tag = t
    return `<${tag}>` + lines.map((l) => `<li>${esc(l.replace(/^\s*([-*\d.]+)\s+/, ''))}</li>`).join('') + `</${tag}>`
  }
  return `<p>${esc(text).replace(/\n/g, '<br>')}</p>`
}

export function blocksToHtml(bs: CopiedBlock[]): string {
  return bs.map(blockToHtml).join('')
}

/**
 * 写剪贴板。
 *
 * 优先 `navigator.clipboard.write`（能带自定义类型）；
 * 没有它就退到 `execCommand('copy')` —— 那条路**只能带纯文本**，
 * 所以返回 `ok:false` 并带一句人话，让调用方告诉用户结构没带走。
 */
export async function writeClipboard(plain: string, blocks?: CopiedBlock[]): Promise<CopyResult> {
  const richTypes: Record<string, string> = {}
  if (blocks && blocks.length) {
    richTypes[BLOCK_MIME] = JSON.stringify(blocks)
    richTypes['text/html'] = blocksToHtml(blocks)
  }

  // —— 路 1：现代剪贴板 API（只在安全上下文里有）
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    const payload: Record<string, string> = { 'text/plain': plain, ...richTypes }
    const supported = Object.keys(payload).every((t) => {
      try { return ClipboardItem.supports(t) } catch { return false }
    })
    if (supported) {
      try {
        await navigator.clipboard.write([new ClipboardItem(payload)])
        return { ok: true, rich: Object.keys(richTypes).length > 0 }
      } catch (e) {
        // 权限被拒 / 浏览器拒绝 → 落到路 2，而不是假装成功
        void e
      }
    }
  }

  // —— 路 2：execCommand 降级，只能带纯文本
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    const ta = document.createElement('textarea')
    ta.value = plain
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    const sel = document.getSelection()
    const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    try {
      ta.select()
      ta.setSelectionRange(0, ta.value.length)
      const okCopy = document.execCommand('copy')
      if (okCopy) {
        return {
          ok: false,
          rich: false,
          reason: 'no-api',
          message: '当前是 HTTP 访问，浏览器不给用新剪贴板接口 —— 这条路只能复制**纯文本**，块的结构/表格/卡片都带不走（加 HTTPS 后才能原样复制）。',
        }
      }
    } catch {
      /* 落到下面统一处理 */
    } finally {
      document.body.removeChild(ta)
      if (saved) { sel?.removeAllRanges(); sel?.addRange(saved) }
    }
  }

  return {
    ok: false,
    rich: false,
    reason: 'denied',
    message: '复制失败：浏览器不让写剪贴板。请手动选中内容按 Ctrl+C。',
  }
}

/**
 * 复制一段纯文本（链接、标题、密文…）。
 *
 * 为什么不让调用方直接写 `navigator.clipboard?.writeText(...)`：
 * 那个 `?.` 在**内网 HTTP**（非安全上下文）下让整句变成空操作 ——
 * 而实测 `http://192.168.1.16:8080` 上 `typeof navigator.clipboard === 'undefined'`。
 * 于是「复制链接」会**弹一个绿色的「链接已复制」而剪贴板里什么都没有** ——
 * 全项目有 5 处这个写法，其中 3 处连提示都没有。
 *
 * 这条是它们的唯一出口：要么真写进去，要么**如实说没写进去**。
 */
export async function copyText(plain: string): Promise<CopyResult> {
  return writeClipboard(plain)
}

/** 从 paste 事件里读块结构；不是自家的内容就返回 null。 */
export function readCopiedBlocks(dt: DataTransfer | null): CopiedBlock[] | null {
  if (!dt) return null
  const raw = dt.getData(BLOCK_MIME)
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v) && v.length && v.every((b) => b && typeof b.type === 'string')) return v
  } catch {
    /* 不是我们的 JSON，交给别的分支 */
  }
  return null
}
