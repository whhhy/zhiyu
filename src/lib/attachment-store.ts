/* ============================================================
   附件存储适配层
   ------------------------------------------------------------
   附件卡片（附件 / 本地音频 / 本地视频 / 图片）都经由
   `components/cards/common.tsx` 的 attachFileToDoc / useAttachmentUrl，
   那是唯一的两处收口。本层负责在不同运行形态下换存储后端：

   · 服务端模式：二进制进 SQLite，key 就是附件 id，
     URL 直接是 `/api/attachment/<id>` —— 浏览器直接拉流，
     不占 JS 堆，也不用管 objectURL 的生命周期。
   · 本地模式：仍然是 IndexedDB（原有行为，一字未改）

   和协作传输层同一个思路：**只换管道，卡片组件不感知后端差异**。
   ============================================================ */

import { getMode, isAuthed, getToken, uploadAttachment, attachmentUrl, deleteRemoteAttachment } from './api'
import { putAttachment, getAttachment } from './idb'
import { useStore } from '@/store'

/** 探测用：与服务端形态的鉴权头保持一致 */
const tokenHeader = (): Record<string, string> =>
  getToken() ? { Authorization: `Bearer ${getToken()}` } : {}

/** 当前正在编辑的文稿 —— 上传时用来做鉴权与归类 */
function currentDocId(): string {
  try {
    return useStore.getState().activeDocId || ''
  } catch {
    return ''
  }
}

/**
 * 服务端形态下才走网络。token 没了就退回本地，别让用户卡在上传按钮上。
 *
 * ⚠️ 这个判据是**导出**的，而且卡片、提示文案、复制摘要几处都该用它 ——
 * 同一个「二进制到底在哪儿」的问题，不该在四个文件里各写一遍
 * `getMode() === 'server' && isAuthed()`：
 * 上一轮修附件卡文案时就漏了两处（DocPage 的复制摘要、common 的选择器提示），
 * 部署之后它们还在说「仅存于本机浏览器」。
 * 散着写的判据就是这样：漏一处不会有人告诉你。
 */
export function useServer(): boolean {
  return getMode() === 'server' && isAuthed()
}

/** 二进制的存放位置，**只给界面文案用**（本地形态下才说 IndexedDB） */
export function binaryWhere(): string {
  return useServer() ? '服务端数据库' : 'IndexedDB'
}

export interface StoredFile {
  key: string
  name: string
  size: number
  mime: string
}

/**
 * 存一个文件，返回一个 key。
 * key 的含义随模式变化：服务端是附件 id，本地是 IndexedDB 指纹。
 * 卡片只把它当作不透明字符串存进 Block.data，两种模式都能用。
 */
export async function storeFile(file: File): Promise<StoredFile> {
  if (useServer()) {
    const docId = currentDocId()
    if (!docId) {
      throw new Error('未确定所属文档，无法上传附件')
    }
    const r = await uploadAttachment(file, docId)
    return { key: r.id, name: r.name, size: r.size, mime: r.mime }
  }
  const { key } = await putAttachment(file, {
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
  })
  return { key, name: file.name, size: file.size, mime: file.type || '' }
}

/**
 * 取一个 key 对应的可访问 URL。
 * 服务端模式直接返回 HTTP 地址；本地模式取回 Blob 再造 objectURL。
 *
 * `probe` 用来回答「这个地址还活着吗」——
 * 服务端模式下光有地址**说明不了任何事**：文件被删掉之后，
 * `attachmentUrl(key)` 照样拼得出来，卡片照样显示「⬇ 下载」，
 * 点了才 404。而本地模式取不回 Blob 天然就是「没了」，
 * 两边的诚实程度原本不一样。
 *
 * 只发 **HEAD**（不取正文）：附件可能有几百 MB，
 * 用 GET 探测等于为了看一眼把整个文件下一遍。
 *
 * 返回空 url 就表示「没了」，调用方据此显示提示。**没有第三个状态** ——
 * 头一版这里多一个 `gone` 标志，是多余的：404 那条分支本来就返回空 url，
 * `!r.url` 已经覆盖了它。多一个标志就多一处能自相矛盾的地方
 * （而它确实矛盾过 —— 注释说 403 当没了，代码让 403 当还在）。
 */
export async function resolveFileUrl(
  key: string,
  probe = false,
): Promise<{ url: string; revoke: boolean }> {
  if (useServer()) {
    const url = attachmentUrl(key)
    if (!probe) return { url, revoke: false }
    try {
      const r = await fetch(url, { method: 'HEAD', headers: tokenHeader() })
      if (r.ok) return { url, revoke: false }
      // **403 不算「文件没了」**：那是权限问题，不是数据问题，
      // 说成「已丢失」是**错的诊断** —— 而用户会去检查自己的权限，
      // 检查半天发现权限没问题。
      // 只有 404 / 410 才说明这份文件真的不在了。
      if (r.status === 404 || r.status === 410) return { url: '', revoke: false }
      // 别的状态码（403 / 5xx / 429）说不准，保持现状。
      // 宁可偶尔多说一次「在」，也不要谎报「已删除」。
      return { url, revoke: false }
    } catch {
      // 网络断了不等于文件没了 —— 这时候保持现状，别把「取不到」说成「已删除」
      return { url, revoke: false }
    }
  }
  const blob = await getAttachment(key)
  if (!blob) return { url: '', revoke: false }
  return { url: URL.createObjectURL(blob), revoke: true }
}

/** 服务端附件 id 的前缀。本地 key 是 `sha256-…` / `fnv1a-…`，不会撞上 */
const isServerKey = (key: string): boolean => key.startsWith('att_')

/**
 * 删一个 key 对应的二进制，结果要**如实带回去**。
 *
 * `deleted: false` 意味着文件还在 —— 因为还有别的文档在引用它。
 * 这不是失败：用户点的「删除」确实发生了（他自己那篇文档里的卡片没了），
 * 只是共享的文件不能连坐删掉。把这个结果吞掉、只留一个 void，
 * 界面就只能把两种情况都当成「删干净了」，或者都当成失败。
 */
export interface DropResult {
  deleted: boolean
  keptFor: number
}

/**
 * 删除一个 key 对应的二进制。
 *
 * ============================================================
 * 这里原来直接 `if (useServer()) return` —— 也就是**服务端模式下什么都不做**，
 * 注释还写着「服务端附件随知识库生命周期走」。
 *
 * 那句注释是错的：附件真正的生命周期是**文档**（purgeDocCore 才按 docId 清它），
 * 不是知识库。于是一条误传的敏感文件在用户点「删除」之后，
 * 会一直躺在库里直到**整篇文档被永久删除**为止。
 *
 * 而且这个函数当时**根本没有调用方**（卡片走的是 common.tsx 的
 * releaseAttachment，里面直接 import 了 idb 的 deleteAttachment）。
 * 两处都不删，才是「点了删除但没删掉」的完整成因。
 *
 * 分支不能只看 useServer()：用户可能先在本地模式传了图（本地 key），
 * 之后才登录上服务端。这种 key 照样要从 IndexedDB 里清掉，
 * 否则本地那一份会永远留着。所以按 key 自身长相判断。
 *
 * `docId` 传「正在操作的那篇文档」：服务端靠它判权、也靠它区分
 * 「撤我这篇的引用」和「删掉二进制」。不传会退回到无条件删除那条老路。
 */
export async function dropFile(key: string, docId?: string): Promise<DropResult> {
  if (!key) return { deleted: true, keptFor: 0 }
  if (useServer() && isServerKey(key)) {
    return deleteRemoteAttachment(key, docId || currentDocId())
  }
  const { deleteAttachment } = await import('./idb')
  await deleteAttachment(key)
  return { deleted: true, keptFor: 0 }
}
