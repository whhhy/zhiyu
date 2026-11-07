/* ============================================================
   附件二进制仓库 —— 原生 IndexedDB
   ------------------------------------------------------------
   为什么要有这层：
   文档正文（blocks）落在 localStorage，约 4MB 上限，而且是 UTF-16 存盘。
   早期附件直接把文件读成 base64 data URL 塞进 Block.data，等于把
   「二进制 + 1.34 倍 base64 膨胀 + ×2 UTF-16」全压在同一个 4MB 里 ——
   插两三张图就写盘失败，而 store 的 persist 是静默 catch 的，
   表现只有「刷新就丢」，极难排查。

   现在：二进制进 IndexedDB，Block.data 里只留几百字节的元信息
   （{ name, size, type, key, lastModified }），刷新后凭 key 取回并
   生成 objectURL 渲染。正文那 4MB 额度只管文字。

   设计要点：
   - 单 store `attachments`，keyPath = 'key'（内容指纹），不建索引：
     读取全是一次性 get（卡片渲染时同步知道自己要哪几个 key），
     没有范围查询需求，索引只会增加写放大。
   - 指纹优先用 crypto.subtle 的 SHA-256（真内容指纹，同样内容天然去重），
     但它只在安全上下文可用，且会把整个文件读进内存；
     不可用 / 文件太大时退回「三段采样 FNV-1a + size」的无依赖方案。
   - 任何一步失败（无 indexedDB / 隐私模式 / 配额超 / 老浏览器）
     都抛 AttachmentStoreError，由调用方回退到 data URL 并在 UI 上说明原因。
   ============================================================ */

const DB_NAME = 'yuque-clone-attachments'
const DB_VERSION = 1
const STORE = 'attachments'

/** SHA-256 只在这个体积内使用：再大就该走采样哈希了，别把内存吃光 */
const SHA256_MAX_BYTES = 8 * 1024 * 1024
/** 采样窗口大小（头 / 中 / 尾各取这么多） */
const SAMPLE_WINDOW = 64 * 1024

export type FingerprintAlgo = 'sha256' | 'fnv1a'

export interface AttachmentRecord {
  /** 内容指纹（= 主键） */
  key: string
  /** 文件二进制本体 */
  blob: Blob
  name: string
  type: string
  size: number
  lastModified: number
  /** 写入时间 */
  at: number
  algo: FingerprintAlgo
}

/** 不含二进制的轻量视图，给 list 用 */
export type AttachmentMeta = Omit<AttachmentRecord, 'blob'>

export type IdbState = 'unknown' | 'ok' | 'unavailable' | 'error'

export type AttachmentErrorCode = 'unavailable' | 'quota' | 'blocked' | 'unknown'

/** 附件仓库的失败都带 code，调用方据此决定要不要降级、怎么跟用户解释 */
export class AttachmentStoreError extends Error {
  code: AttachmentErrorCode
  constructor(code: AttachmentErrorCode, message: string) {
    super(message)
    this.name = 'AttachmentStoreError'
    this.code = code
  }
}

/* ============================================================
   可用性探测
   —— 必须在**真正 open 之后**才算数：
   `typeof indexedDB !== 'undefined'` 在隐私模式里也是 true，
   要等 onerror 才炸。只看全局变量的判断会把降级路径判错。
   ============================================================ */

let state: IdbState = 'unknown'
let lastError = ''
let dbPromise: Promise<IDBDatabase> | null = null

function unsupported(reason: string): AttachmentStoreError {
  state = 'unavailable'
  lastError = reason
  return new AttachmentStoreError('unavailable', reason)
}
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(unsupported('当前环境没有 IndexedDB（隐私模式 / 老旧浏览器）'))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(unsupported(`无法打开 IndexedDB：${(e as Error)?.message || '被浏览器拒绝'}`))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // 另一个标签页要升级版本时主动让位，否则它会一直 blocked
      db.onversionchange = () => {
        db.close()
        dbPromise = null
        state = 'unknown'
      }
      state = 'ok'
      resolve(db)
    }
    req.onerror = () => {
      state = 'error'
      lastError = req.error?.message || 'IndexedDB 打开失败'
      dbPromise = null
      reject(new AttachmentStoreError('unavailable', `IndexedDB 不可用：${lastError}`))
    }
    req.onblocked = () => {
      // 不直接 reject：可能被同源其它标签页占着，稍后可能成功
      lastError = 'IndexedDB 被其它标签页占用'
    }
  })
  // 挂一个空的 catch：这次 open 失败时业务侧会自己再 catch 一次，
  // 不加的话 Node/浏览器会报 unhandledrejection。
  p.catch(() => {})
  dbPromise = p
  return p
}

/** 当前状态（同步读，不触发 open） */
export function idbStatus(): { state: IdbState; supported: boolean; reason: string } {
  return { state, supported: state === 'ok', reason: lastError }
}

/** 预探测：真正 open 一次，成功返回 true。卡片挂载 / 插入附件前都可以调 */
export async function ensureIdb(): Promise<boolean> {
  try {
    await openDb()
    return true
  } catch {
    return false
  }
}

/** 降级原因的中文说明（UI 如实展示，不写「未知错误」这种废话） */
export function describeFallback(e: unknown, fileName?: string): string {
  const who = fileName ? `「${fileName}」` : '附件'
  if (e instanceof AttachmentStoreError) {
    if (e.code === 'quota') return `${who}已降级为内联 data URL：浏览器分配给本站的存储配额已满。`
    if (e.code === 'blocked') return `${who}已降级为内联 data URL：IndexedDB 被其它标签页占用。`
    if (e.code === 'unavailable') return `${who}已降级为内联 data URL：${e.message}。`
    return `${who}已降级为内联 data URL：写入 IndexedDB 失败（${e.message}）。`
  }
  return `${who}已降级为内联 data URL：${(e as Error)?.message || '未知错误'}。`
}

async function withStore<T>(mode: IDBTransactionMode, run: (os: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    let t: IDBTransaction
    try {
      t = db.transaction(STORE, mode)
    } catch (e) {
      reject(new AttachmentStoreError('unknown', `事务开启失败：${(e as Error)?.message || ''}`))
      return
    }
    const req = run(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(wrapWriteError(req.error, t.error))
    t.onabort = () => reject(wrapWriteError(null, t.error))
  })
}

/** QuotaExceededError 要单独拎出来 —— 它值得让用户知道「换小文件也没用，是整站配额满了」 */
function wrapWriteError(err: DOMException | null, fallback: DOMException | null): AttachmentStoreError {
  const e = err || fallback
  const msg = e?.message || 'IndexedDB 写入失败'
  if (e?.name === 'QuotaExceededError') return new AttachmentStoreError('quota', msg)
  if (e?.name === 'InvalidStateError' || e?.name === 'NotFoundError')
    return new AttachmentStoreError('unavailable', msg)
  return new AttachmentStoreError('unknown', msg)
}

/* ============================================================
   内容指纹
   ============================================================ */

const toHex = (buf: ArrayBuffer) => {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

function hasSubtle(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    !!crypto.subtle &&
    typeof crypto.subtle.digest === 'function'
  )
}

/** FNV-1a 32bit，滚动喂字节 */
function fnv1a(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 字符串版 FNV-1a（给 data 字段做便宜的指纹用） */
export function hashString(s: string): string {
  return fnv1a(new TextEncoder().encode(s), 0x811c9dc5).toString(16).padStart(8, '0')
}

/**
 * 采样指纹：头 / 中 / 尾各 SAMPLE_WINDOW 字节 + 文件大小。
 * 不需要安全上下文、不需要把整个文件读进内存，代价是
 * 「大小相同且头中尾三段都相同」的两个不同文件会撞键
 * （概率极低，且只影响去重，不影响数据完整性）。
 */
async function sampledFingerprint(blob: Blob): Promise<string> {
  const size = blob.size
  const win = SAMPLE_WINDOW
  const parts: Uint8Array[] = []
  const take = async (start: number, len: number) => {
    if (len <= 0) return
    parts.push(new Uint8Array(await blob.slice(start, start + len).arrayBuffer()))
  }
  await take(0, Math.min(win, size))
  if (size > win * 2) await take(Math.floor((size - win) / 2), win)
  if (size > win) await take(size - win, Math.min(win, size))

  let h = 0x811c9dc5
  for (const p of parts) h = fnv1a(p, h)
  return `${h.toString(16).padStart(8, '0')}${size.toString(36)}`
}

/** 内容指纹：优先 SHA-256，不可用 / 太大则采样哈希 */
export async function fingerprint(blob: Blob): Promise<{ key: string; algo: FingerprintAlgo }> {
  if (hasSubtle() && blob.size <= SHA256_MAX_BYTES) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      return { key: `sha256-${toHex(digest).slice(0, 40)}-${blob.size.toString(36)}`, algo: 'sha256' }
    } catch {
      /* 落到采样分支 */
    }
  }
  return { key: `fnv1a-${await sampledFingerprint(blob)}`, algo: 'fnv1a' }
}

/* ============================================================
   CRUD
   ============================================================ */

export interface PutResult {
  key: string
  algo: FingerprintAlgo
  /** 二进制是否真的进了 IndexedDB（false = 已降级） */
  stored: boolean
  degraded?: string
}

/**
 * 写一个附件。
 * 主键是内容指纹 —— 同一个文件插两次只会存一份（后写覆盖先写，字节一样）。
 * 失败一律抛 AttachmentStoreError，调用方负责降级。
 */
export async function putAttachment(
  blob: Blob,
  meta: { name?: string; type?: string; lastModified?: number },
): Promise<PutResult> {
  const { key, algo } = await fingerprint(blob)
  const rec: AttachmentRecord = {
    key,
    blob,
    name: meta.name || (blob as File).name || '未命名',
    type: meta.type || blob.type || '',
    size: blob.size,
    lastModified: meta.lastModified ?? (blob as File).lastModified ?? 0,
    at: Date.now(),
    algo,
  }
  await withStore('readwrite', (os) => os.put(rec))
  return { key, algo, stored: true }
}

/** 按 key 取回二进制（卡片渲染用） */
export async function getAttachment(key: string): Promise<Blob | null> {
  if (!key) return null
  try {
    const rec = await withStore<AttachmentRecord | undefined>('readonly', (os) => os.get(key))
    return rec?.blob || null
  } catch {
    // 读失败一律按「没有」处理：卡片要能降级显示，而不是整页崩
    return null
  }
}

/** 按 key 取回完整记录（要元信息时用） */
export async function getAttachmentRecord(key: string): Promise<AttachmentRecord | null> {
  if (!key) return null
  try {
    return (await withStore<AttachmentRecord | undefined>('readonly', (os) => os.get(key))) || null
  } catch {
    return null
  }
}

/** 删除一份二进制。调用方要先确认没有别的卡片在用同一个 key */
export async function deleteAttachment(key: string): Promise<void> {
  if (!key) return
  try {
    await withStore('readwrite', (os) => os.delete(key))
  } catch {
    /* 删不掉就留着：孤儿数据的代价远小于删掉别人还在用的附件 */
  }
}

/** 列出全部附件元信息（不取二进制，避免把内存吃满） */
export async function listAttachments(): Promise<AttachmentMeta[]> {
  const all = await withStore<AttachmentRecord[]>('readonly', (os) => os.getAll())
  return all.map(({ blob: _blob, ...meta }) => meta)
}

/** 汇总：份数 + 字节数（UI 上给用户看「附件仓库占了多少」） */
export async function attachmentUsage(): Promise<{ count: number; bytes: number }> {
  const list = await listAttachments()
  return { count: list.length, bytes: list.reduce((n, m) => n + (m.size || 0), 0) }
}

/** 清空（测试 / 「清空浏览器数据」用） */
export async function clearAttachments(): Promise<void> {
  await withStore('readwrite', (os) => os.clear())
}

/** 浏览器给的存储配额（拿不到就返回 null，UI 不显示） */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const e = await navigator.storage.estimate()
    if (typeof e.usage !== 'number' || typeof e.quota !== 'number') return null
    return { usage: e.usage, quota: e.quota }
  } catch {
    return null
  }
}

/** 测试钩子：忘掉探测结果（mock 掉 indexedDB 后要能重新判定） */
export function __resetIdbCache(): void {
  dbPromise = null
  state = 'unknown'
  lastError = ''
}
