/* ============================================================
   搜索（顶栏 ⌘K 摘要面板 与 /search 独立搜索页 共用）

   为什么要抽出来：
   这两处一开始各写各的本地扫描。后来轻量启动改成「客户端不再持有全部正文」，
   顶栏那条路我改成了服务端检索，**却忘了 /search 那一页** ——
   结果它还在扫 `d.body`，而没打开过的文档 body 是空的。
   两份实现的差异就是这么悄悄变成一个 bug 的。

   所以现在只有这一份实现，两处共用。改动只需要改这里。
   ============================================================ */

import { docSearchText } from '@/lib/card-search'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store'
import { api, getMode } from './api'
import type { Book, Doc, Note } from '@/types'

export interface DocHit {
  doc: Doc
  /** 命中在标题上（排在正文命中之前） */
  inTitle: boolean
  /** 命中在正文里的位置，-1 表示只在标题命中 */
  bodyIdx: number
  /** 出现次数，用于「相关度」排序 */
  count: number
  /** 命中片段（服务端形态由服务端给，本地形态现截） */
  excerpt?: string
  /**
   * 作者在文档设置里写的**摘录**。
   * 命中在标题上时优先显示它 —— 那是作者专门为「一眼看清这篇讲什么」
   * 写的一句话，比正文里截出来的一小段更有用。
   * 没有摘录就退回正文片段，不留空白。
   */
  summary?: string
}

export interface SearchResult {
  docs: DocHit[]
  books: Book[]
  notes: Note[]
  total: number
  loading: boolean
  /** true 表示结果来自服务端（本地没有正文也能搜到） */
  remote: boolean
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param q        查询词
 * @param scope    'all' | 'mine'（只看我创建的）
 * @param sort     'relevance' | 'time'
 * @param limit    服务端形态的取回条数
 */
export function useSearch(q: string, scope = 'all', sort = 'relevance', limit = 20): SearchResult {
  const docs = useStore((s) => s.docs)
  const books = useStore((s) => s.books)
  const notes = useStore((s) => s.notes)
  const currentUser = useStore((s) => s.currentUser)

  const [remote, setRemote] = useState<any[] | null>(null)
  const [loading, setLoading] = useState(false)

  const kw = q.trim()
  const useRemote = getMode() === 'server' && kw.length > 0

  useEffect(() => {
    if (!useRemote) { setRemote(null); return }
    let alive = true
    setLoading(true)
    // 250ms 防抖：中文输入法一次吐好几个字符，逐字发请求纯属浪费
    const t = setTimeout(() => {
      api.get<{ results: any[] }>(`/api/search?q=${encodeURIComponent(kw)}&limit=${limit}`)
        .then((r) => { if (alive) setRemote(r.results || []) })
        .catch(() => { if (alive) setRemote([]) })
        .finally(() => { if (alive) setLoading(false) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [kw, limit, useRemote])

  const docHits = useMemo<DocHit[]>(() => {
    if (!kw) return []
    const kwl = kw.toLowerCase()

    if (remote) {
      const hits: DocHit[] = []
      for (const h of remote) {
        if (h.kind === 'doc') {
          const doc = docs[h.id]
          if (!doc) continue
          if (scope === 'mine' && doc.authorId !== currentUser.id) continue
          hits.push({
            doc,
            inTitle: h.at < 0,
            bodyIdx: h.at,
            count: h.count ?? 1,
            excerpt: h.excerpt,
            summary: h.summary,
          })
        }
      }
      return hits
    }

    // 本地形态：扫本地数据。
    // 注意服务端形态下这条路不会被走到 —— 没打开过的文档本地没有正文，
    // 在这里扫等于「搜不到自己没打开过的东西」。
    const hits: DocHit[] = []
    for (const d of Object.values(docs)) {
      if (scope === 'mine' && d.authorId !== currentUser.id) continue
      const body = docSearchText(d)
      const inTitle = (d.title || '').toLowerCase().includes(kwl)
      const bodyIdx = body.toLowerCase().indexOf(kwl)
      if (!inTitle && bodyIdx < 0) continue
      const re = new RegExp(esc(kw), 'gi')
      const count = ((d.title || '').match(re)?.length || 0) + (body.match(re)?.length || 0)
      hits.push({ doc: d, inTitle, bodyIdx, count })
    }
    return hits
  }, [kw, docs, remote, scope, currentUser.id])

  const sorted = useMemo(() => {
    const list = [...docHits]
    list.sort((a, b) => {
      if (sort === 'time') return (b.doc.updatedAt || 0) - (a.doc.updatedAt || 0)
      if (a.inTitle !== b.inTitle) return a.inTitle ? -1 : 1
      return b.count - a.count
    })
    return list
  }, [docHits, sort])

  const bookResults = useMemo(() => {
    if (!kw) return []
    const kwl = kw.toLowerCase()
    if (remote) {
      return remote
        .filter((h) => h.kind === 'book')
        .map((h) => books.find((b) => b.id === h.id))
        .filter((b): b is Book => !!b)
    }
    return books.filter((b) => (b.name || '').toLowerCase().includes(kwl) || (b.desc || '').toLowerCase().includes(kwl))
  }, [kw, books, remote])

  const noteResults = useMemo(() => {
    if (!kw) return []
    const kwl = kw.toLowerCase()
    if (remote) {
      return remote
        .filter((h) => h.kind === 'note')
        .map((h) => notes.find((n) => n.id === h.id))
        .filter((n): n is Note => !!n)
    }
    return notes.filter((n) => n.text.toLowerCase().includes(kwl))
  }, [kw, notes, remote])

  return {
    docs: sorted,
    books: bookResults,
    notes: noteResults,
    total: sorted.length + bookResults.length + noteResults.length,
    loading,
    remote: !!remote,
  }
}

/**
 * 截取命中上下文。
 *
 * 三层，**从作者写的内容往外退**：
 *   ① 命中在标题上 → 用作者写的**摘录**（他就是为「一眼看清这篇讲什么」写的）
 *   ② 服务端给的正文片段
 *   ③ 本地现截（本地形态没有服务端片段）
 *
 * 以前只有 ②③，所以「摘录」那个输入框即使能存也从不显示 ——
 * 用户写了大半年，发现它什么也没做。
 */
export function excerptOf(hit: DocHit, kw: string): string {
  if (hit.inTitle && hit.summary) return hit.summary
  if (hit.excerpt) return hit.excerpt
  const body = docSearchText(hit.doc)
  const idx = body.toLowerCase().indexOf(kw.trim().toLowerCase())
  if (idx < 0) return body.slice(0, 90)
  const start = Math.max(0, idx - 40)
  const end = Math.min(body.length, idx + kw.length + 60)
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\n/g, ' ') + (end < body.length ? '…' : '')
}
