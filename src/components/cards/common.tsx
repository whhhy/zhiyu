import { useRef, useState, useEffect, useLayoutEffect, type ReactNode, type ChangeEvent, type TextareaHTMLAttributes } from 'react'
import { uid } from './types'
import {
  describeFallback, getAttachment, putAttachment,
} from '@/lib/idb'
import { storeFile, resolveFileUrl, dropFile, useServer, binaryWhere } from '@/lib/attachment-store'
import type { Block } from '@/types'

/* 卡片作者从 common 一站式取工具，uid 也在这里转出 */
export { uid }

/* ============================================================
   卡片通用件
   —— 统一外壳、字段行、文件读取、localStorage 容量判断
   ============================================================ */

export function CardShell({
  icon,
  title,
  desc,
  actions,
  children,
  tone = 'plain',
}: {
  icon: ReactNode
  title: string
  desc?: string
  actions?: ReactNode
  children: ReactNode
  tone?: 'plain' | 'flat'
}) {
  return (
    <div className={`yq-kc yq-kc-${tone}`}>
      <div className="yq-kc-head">
        <span className="yq-kc-icon">{icon}</span>
        <span className="yq-kc-title">{title}</span>
        {desc && <span className="yq-kc-desc">{desc}</span>}
        <span className="yq-kc-flex" />
        {actions}
      </div>
      <div className="yq-kc-body">{children}</div>
    </div>
  )
}

/**
 * 挂载时把缺省的初始值补写进 block.data，只写一次。
 *
 * 为什么不能靠组件里的 `data.x ?? DEFAULT` 兜底：
 * 那样文档里存的就只是一张空壳 —— 数据不完整、复制/导出拿不到内容，
 * 而且一旦组件里的默认值改了，历史文档显示的东西就跟着变。
 * 卡片的数据必须是自描述的：插进去那一刻，data 里就有完整的初始结构。
 */
export function useCardDefaults<T extends Record<string, any>>(
  data: T | undefined,
  onChange: (patch: Partial<T>) => void,
  defaults: T,
) {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    const cur = data || ({} as T)
    const missing: Record<string, any> = {}
    for (const k of Object.keys(defaults)) if (cur[k] === undefined) missing[k] = defaults[k]
    if (Object.keys(missing).length) onChange(missing as Partial<T>)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="yq-kc-field">
      <span className="yq-kc-label">{label}</span>
      {children}
      {hint && <span className="yq-kc-hint">{hint}</span>}
    </label>
  )
}

/** 小按钮：卡片内部所有操作都用它，保证风格一致 */
export function MiniBtn({
  children,
  onClick,
  title,
  active,
  danger,
  disabled,
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`yq-kc-btn ${active ? 'is-on' : ''} ${danger ? 'is-danger' : ''}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

/** 文件 → data URL（存进文档，刷新后还在） */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error || new Error('读取文件失败'))
    fr.readAsDataURL(file)
  })
}

export function formatBytes(n: number): string {
  if (!n && n !== 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * localStorage 容量守卫（只管**正文**）。
 *
 * 浏览器给 origin 的 localStorage 通常是 5MB，存的是 UTF-16（一个字符 2 字节），
 * 再加上 JSON.stringify 的转义膨胀，很容易一存就写盘失败 ——
 * 而 store 的 persist 是静默 catch 的，失败后表现是「刷新就丢」，极难排查。
 * 所以在写进去之前就自己算一遍，给用户明确提示。
 *
 * 附件（附件卡 / 本地文件·音频·视频）的**二进制已经搬去 IndexedDB**，
 * 不再占这块额度；这里只算真正会进 localStorage 的那部分
 * （正文文字 + 几百字节的附件元信息 + 其余文档结构）。
 */
export const LS_TOTAL_BUDGET = 4 * 1024 * 1024

/** 附件元信息在 Block.data 里大概的字节数（几百字节，够用来做额度判断） */
export const ATTACHMENT_META_BYTES = 512

/**
 * 附件存放位置的统一说明。
 *
 * ⚠️ 这一句原来写死了「附件二进制走 IndexedDB」—— **在服务端形态下那是假话**：
 * 二进制存在 `attachments.data`（SQLite BLOB）里，走 `POST /api/attachment` 上传。
 * 而本项目**主推的就是内网服务端部署**，所以部署之后每张附件卡下面
 * 都在告诉用户「你的附件在浏览器里」—— 而它其实躺在数据库里。
 *
 * 两种形态的差别不只是「存在哪」，还连着**丢了会怎样**：
 *   · 本地：清浏览器数据 → 二进制没了，提示「可能清过浏览器数据」
 *   · 服务端：清浏览器数据**不影响**附件；真丢了通常是数据库被换了
 * 所以下面按形态分开说，而不是一句话盖过去。
 */
export const attachmentWhere = binaryWhere

export const ATTACHMENT_HINT =
  useServer()
    ? '正文上限约 4MB；附件二进制存服务端数据库，随文件级备份一起迁移，不受浏览器配额限制。'
    : '正文上限约 4MB（localStorage）；附件二进制走 IndexedDB，容量取决于浏览器配额。'

export function storageUsedBytes(): number {
  let n = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k == null) continue
      n += (k.length + (localStorage.getItem(k)?.length || 0)) * 2
    }
  } catch {
    return 0
  }
  return n
}

/** 一段 data URL 真正占的 localStorage 字节数（UTF-16） */
export const dataUrlBytes = (s: string) => s.length * 2

export interface CapacityCheck {
  ok: boolean
  used: number
  need: number
  message: string
}

/** 判断「再往文档里塞 need 字节会不会撑爆 localStorage」 */
export function checkDocCapacity(need: number): CapacityCheck {
  const used = storageUsedBytes()
  const ok = used + need <= LS_TOTAL_BUDGET
  return {
    ok,
    used,
    need,
    message: ok
      ? `正文当前占用 ${formatBytes(used)}，写入后约 ${formatBytes(used + need)}（正文上限约 4MB，附件二进制不计入）`
      : `正文写入后会到 ${formatBytes(used + need)}，超过正文约 4MB 上限，写盘会失败、刷新后丢失。请先删掉部分旧内容或历史版本。`,
  }
}

/**
 * 判断「再塞这个 data URL 进去会不会撑爆 localStorage」。
 * 只剩**仍在用 data URL 的卡片**（如画册的本地图片、以及降级后的附件）会走这条。
 */
export function checkCapacity(dataUrl: string): CapacityCheck {
  return checkDocCapacity(dataUrlBytes(dataUrl))
}

/* ============================================================
   附件：写入（主路径 IndexedDB，失败降级 data URL）与读取（objectURL）
   —— FileCard 与 LocalMedia 三张卡共用，保证两条路径的语义完全一致
   ============================================================ */

/** 附件在 Block.data 里的完整形状（JSON 可序列化，进 localStorage） */
export interface AttachmentPatch {
  name: string
  size: number
  type: string
  /** IndexedDB 内容指纹：二进制本体在这里面，Block.data 只留元信息 */
  key: string
  /** 仅降级路径 / 旧存档里有：二进制被内联成 data URL */
  dataUrl: string
  lastModified: number
  at: number
  /** 二进制是否真的进了 IndexedDB */
  stored: boolean
  /** 降级原因（IDB 不可用时如实写进文档，UI 直接显示） */
  degraded: string
  /** 正文额度吃紧 */
  risky: boolean
  error: string
}

export const emptyAttachmentPatch = (): AttachmentPatch => ({
  name: '', size: 0, type: '', key: '', dataUrl: '', lastModified: 0, at: 0,
  stored: false, degraded: '', risky: false, error: '',
})

/**
 * 选进来的文件怎么存：
 * 1) 主路径：二进制出 `attachment-store`（服务端形态进 SQLite，本地形态进 IndexedDB），
 *    Block.data 只留 { name, size, type, key, lastModified }
 * 2) 降级：存储不可用（隐私模式 / 老浏览器 / 配额写满）→ 退回 data URL，
 *    并把**原因**如实写进 degraded，UI 上必须显示出来（不能让用户以为文件存好了）。
 *
 * 具体走后端还是 IndexedDB 由 attachment-store 自己判断，卡片这边无感知。
 */
export async function attachFileToDoc(file: File, force = false): Promise<AttachmentPatch> {
  const base = {
    name: file.name,
    size: file.size,
    type: file.type || '',
    lastModified: file.lastModified || 0,
    at: Date.now(),
  }
  // 正文只多几百字节的元信息，额度几乎不可能因此被撑爆；
  // 但文档已经贴着 4MB 时还是得提示（否则 persist 静默失败）
  const metaCap = checkDocCapacity(ATTACHMENT_META_BYTES)
  if (!metaCap.ok && !force) {
    return { ...base, key: '', dataUrl: '', stored: false, degraded: '', risky: false, error: metaCap.message }
  }
  try {
    const { key } = await storeFile(file)
    return {
      ...base, key, dataUrl: '', stored: true, degraded: '',
      risky: !metaCap.ok, error: metaCap.ok ? '' : metaCap.message,
    }
  } catch (e) {
    const degraded = describeFallback(e, file.name)
    let url = ''
    try {
      url = await readFileAsDataUrl(file)
    } catch {
      url = ''
    }
    if (!url) {
      return { ...base, key: '', dataUrl: '', stored: false, degraded, risky: true, error: '读取文件失败，可能是文件被占用或权限不足' }
    }
    const cap = checkCapacity(url)
    return {
      ...base, key: '', dataUrl: url, stored: false, degraded,
      risky: !cap.ok, error: cap.ok ? '' : cap.message,
    }
  }
}

export type AttachmentUrlState = 'none' | 'loading' | 'ready' | 'missing'

/**
 * 附件的可用 URL。
 * - 降级 / 旧存档：直接就是 data URL，不用管生命周期
 * - 服务端形态：key 就是附件 id，URL 是 `/api/attachment/<id>`，
 *   浏览器直接拉流，既不占 JS 堆也没有 objectURL 要 revoke
 * - 本地形态：按 key 从 IndexedDB 取回 Blob，生成 objectURL
 *
 * objectURL 会一直占着 Blob 不放，所以**换源和卸载都必须 revoke**：
 * 组件卸载、或同一张卡片换了另一个附件时，cleanup 里把旧 URL 收掉。
 * （取回过程中组件已卸载的情况由 alive 挡住，不会生成一个没人用的 URL。）
 * 服务端形态返回的是 HTTP 地址，revoke 是 false —— 对着 http:// 调 revokeObjectURL
 * 不会报错，但属于对不存在的资源做清理，写明比含糊地跳过更好。
 */
export function useAttachmentUrl(key?: string, dataUrl?: string): { url: string; state: AttachmentUrlState } {
  const [res, setRes] = useState<{ url: string; state: AttachmentUrlState }>(() =>
    dataUrl ? { url: dataUrl, state: 'ready' } : key ? { url: '', state: 'loading' } : { url: '', state: 'none' },
  )
  useEffect(() => {
    if (dataUrl) {
      setRes({ url: dataUrl, state: 'ready' })
      return
    }
    if (!key) {
      setRes({ url: '', state: 'none' })
      return
    }
    let alive = true
    let created = ''
    let shouldRevoke = false
    setRes({ url: '', state: 'loading' })
    resolveFileUrl(key, true)
      .then((r) => {
        if (!alive) {
          if (r.revoke) URL.revokeObjectURL(r.url)
          return
        }
        if (!r.url) {
          setRes({ url: '', state: 'missing' })
          return
        }
        created = r.url
        shouldRevoke = r.revoke
        setRes({ url: r.url, state: 'ready' })
      })
      .catch(() => {
        if (alive) setRes({ url: '', state: 'missing' })
      })
    return () => {
      alive = false
      if (created && shouldRevoke) URL.revokeObjectURL(created)
    }
  }, [key, dataUrl])
  return res
}

/** 统计一份 key 被多少个块引用（同一文件插在两张卡片上是 2） */
function countAttachmentRefs(docs: Record<string, { blocks?: Block[] }> | undefined, key: string): number {
  if (!key || !docs) return 0
  let n = 0
  for (const doc of Object.values(docs)) {
    for (const b of doc?.blocks || []) {
      if (b?.data?.key === key) n++
    }
  }
  return n
}

/** 同上，但**不算上正在被删掉的那一个块** */
function countAttachmentRefsExcept(
  docs: Record<string, { blocks?: Block[] }> | undefined, key: string, skipId: string,
): number {
  if (!key || !docs) return 0
  let n = 0
  for (const doc of Object.values(docs)) {
    for (const b of doc?.blocks || []) {
      if (b.id === skipId) continue
      if (b?.data?.key === key) n++
    }
  }
  return n
}

/**
 * 卡片删除 / 替换附件时回收二进制。
 * 还有别的块在用同一个 key（同内容去重导致）就不删 —— 删了会把别人的附件也弄坏。
 * 用 getState().docs 现场取，不订阅：卡片没必要为了一次删除重渲染。
 *
 * 走的是 `dropFile`（存储适配层）而不是直接 import idb 的 deleteAttachment。
 * 以前写的是后者：**只删本机 IndexedDB**，而服务端模式下二进制在 SQLite 里 ——
 * 于是「删除」按钮在服务端部署下等于没删（二进制要等整篇文档被永久删除才消失）。
 * 删除动作必须跟着存储后端走，不能写死一个后端。
 */
export async function releaseAttachment(
  docs: Record<string, { blocks?: Block[] }> | undefined,
  key: string,
): Promise<void> {
  if (!key) return
  if (countAttachmentRefs(docs, key) > 1) return
  await dropFile(key)
}

/**
 * 卡片上的「删除 / 清空」：**先把二进制删掉，成功了才清正文**。
 *
 * 原来两个卡片都是 `onChange(empty)` 在前、`releaseAttachment` 在后。
 * 服务端模式下删附件要走网络、会失败（没权限、没网、服务在重启），
 * 一旦失败：卡片已经从正文里消失了（用户以为删掉了），
 * 二进制却还在库里 —— 和「根本没接删除接口」是同一个后果，
 * 只是换了个触发方式。所以顺序反过来：
 * 删不掉就**保持卡片原样**并把原因还给用户，让「卡片不见了」永远等价于「二进制没了」。
 *
 * 顺序反过来之后最坏情况是留下一个指向空 key 的块，
 * 而这个 UI 早就处理得了（`state === 'missing'` 会如实显示二进制丢失）。
 *
 * 唯一该当「失败」的是真失败（403 / 网络）。
 * **`deleted: false` 不是失败**：文件还被别的文档引用着，只撤掉了这一篇里的引用 ——
 * 那是正确的共享语义。弹红色错误会让用户以为卡片没删掉，于是反复点，
 * 而文件其实谁也删不了（服务端会一直说「还有 N 篇在用」）。
 *
 * 返回 `{ err, keptFor }`：err 空串 = 成功；非空是给用户看的原因。
 * keptFor 把「文件因为别人还在用所以留下了」这句话带出去。
 */
export async function detachAttachment(
  docs: Record<string, { blocks?: Block[] }> | undefined,
  key: string | undefined,
  onCleared: () => void,
): Promise<{ err: string; keptFor: number }> {
  // 还有别的块在用同一个 key：二进制得留着，只清这个块
  if (!key || countAttachmentRefs(docs, key) > 1) {
    onCleared()
    return { err: '', keptFor: 0 }
  }
  let keptFor = 0
  try {
    const r = await dropFile(key)
    keptFor = r.keptFor
  } catch (e) {
    return { err: String((e as { message?: string })?.message || '附件删除失败'), keptFor: 0 }
  }
  onCleared()
  return { err: '', keptFor }
}

/**
 * 删掉一个块时回收它引用的附件（Editor 的 removeBlock 用）。
 *
 * 与 `releaseAttachment` 的区别只有一个，但很要紧：
 * 引用计数时**必须排除正在被删的这个块**。
 * 文档写盘是异步的，`onChange(next)` 之后立刻去读 store 快照，
 * 那个块多半还在里面 —— 算出来是 1，`> 1` 不成立倒还好，
 * 可一旦同一个 key 还被**别的块**引用，它就会被误判成「还有人用」而永远不删。
 * 直接按块 id 排除最稳，不依赖任何时序。
 *
 * 返回 `{ err, keptFor }`，含义同 `detachAttachment`。
 * 这里的本地引用计数只是**省一次往返**的优化 ——
 * 真正的判断在服务端（它扫的是全部文档，本地 store 可能是轻量的、
 * 也可能是另一台设备还没同步到的旧快照）。
 */
export async function releaseBlockAttachment(
  docs: Record<string, { blocks?: Block[] }> | undefined,
  block: { id: string; data?: { key?: string } } | undefined,
): Promise<{ err: string; keptFor: number }> {
  const key = block?.data?.key
  if (!key) return { err: '', keptFor: 0 }
  if (countAttachmentRefsExcept(docs, key, block!.id) > 0) return { err: '', keptFor: 0 }
  try {
    const r = await dropFile(key)
    return { err: '', keptFor: r.keptFor }
  } catch (e) {
    return { err: String((e as { message?: string })?.message || '附件删除失败'), keptFor: 0 }
  }
}

/**
 * 外部改了值（按钮「重置」「解码回填」「填入示例」）时，把新值同步进未受控的 DOM。
 * 用户正在这个框里打字时绝不动 DOM —— 否则光标会被弹到末尾，中文输入法直接散掉。
 */
export function useExternalValue<T extends HTMLInputElement | HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || el.value === value) return
    if (document.activeElement === el) {
      const onBlur = () => {
        el.value = value
        el.removeEventListener('blur', onBlur)
      }
      el.addEventListener('blur', onBlur)
      return () => el.removeEventListener('blur', onBlur)
    }
    el.value = value
  }, [value])
  return ref
}

/** 受控 React 但非受控 DOM 的多行文本：自己打字不抖，外部回填也看得见 */
export function SyncTextarea({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'defaultValue' | 'onChange'
>) {
  const ref = useExternalValue<HTMLTextAreaElement>(value)
  return <textarea ref={ref} defaultValue={value} onChange={(e) => onCommit(e.target.value)} {...rest} />
}

/** SyncTextarea 的单行版 */
export function SyncInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange'
>) {
  const ref = useExternalValue<HTMLInputElement>(value)
  return <input ref={ref} defaultValue={value} onChange={(e) => onCommit(e.target.value)} {...rest} />
}

/** 一个可复用的真实 <input type="file">：样式是按钮，但本体是原生文件框 */
export function FilePicker({
  accept,
  onFile,
  label = '选择文件',
  readOnly,
  capture,
}: {
  accept?: string
  onFile: (f: File) => void
  label?: string
  readOnly?: boolean
  capture?: boolean
}) {
  return (
    <span className="yq-kc-picker">
      <input
        type="file"
        className="yq-kc-file-input"
        accept={accept}
        disabled={readOnly}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          // 允许连续选同一个文件
          e.target.value = ''
        }}
      />
      <span className="yq-kc-picker-label">{label}</span>
      {/* 「仅存于本机浏览器」在服务端形态下是假的 —— 二进制其实传到了数据库。
          而这个提示就挂在**选文件的输入框旁边**，用户正准备决定要不要传。 */}
      {capture && (
        <span className="yq-kc-picker-hint">
          {useServer() ? '随文档存到服务端数据库' : '仅存于本机浏览器'}
        </span>
      )}
    </span>
  )
}

/** 选中的日期 → YYYY-MM-DD（本地时区，不用 toISOString 以免时区偏移） */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const todayYmd = () => ymd(new Date())

/** 把 YYYY-MM-DD 变成「3 天前 / 今天」这种中文 */
export function humanDate(s: string): string {
  if (!s) return '未选择'
  const [y, m, d] = s.split('-').map(Number)
  if (!y) return s
  const t = new Date(y, m - 1, d)
  const now = new Date()
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - t.getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === 2) return '前天'
  if (diff > 0 && diff < 30) return `${diff} 天前`
  return s
}
