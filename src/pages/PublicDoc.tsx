/* ============================================================
   对外分享的文档阅读页
   ------------------------------------------------------------
   这一页**刻意不经过 AppGate、不碰 store**。

   为什么不用现成的 DocPage：DocPage 的数据全部来自 store，
   而 store 是登录后 hydrate 出来的。为了让一个外部访客读到一篇文档
   而把整个应用（连同演示种子数据）灌进他的浏览器，
   既不必要、也不安全 —— 分享页只需要「标题 + 正文」。

   所以这里只渲染服务端给的那两样，一个字段都不多拿。
   代价是：卡片类内容（投票 / 画板 / 工作表 / 表格卡片）在这里
   **只按文本显示**，不还原成可交互组件 —— 分享页不加载内部组件。
   这条限制写在这里，也写在 README 里，不假装它是完整的。
   ============================================================ */

import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { renderMarkdown } from '@/utils/markdown'
import { withCardNotices } from '@/lib/blocks-markdown'
import type { Block } from '@/types'
import '../styles/layout.css'
/* ⚠️ 之前漏了这一行：分享页调了 `renderMarkdown`，却**没有** markdown 的排版规则
 *   （它们住在 Templates.css 里）。结果是分享出去的文档**渲染成了但没有排版** ——
 *   浏览器默认样式勉强能看，可字号、粗细、间距全都不对。
 *   2026-10-07 把那套规则抽到共享的 markdown.css，三个页面各自导入。 */
import '../styles/markdown.css'
import './PublicDoc.css'

type Doc = {
  title: string
  summary?: string
  slug?: string
  body: string
  /**
   * 服务端**已经发了** blocks（`server/index.ts` 的 `/api/public/doc/:id` 里
   * 有一行注释专门说明「blocks 是正文真正的来源」），而这一页原来只收 body、
   * 只渲染 body —— 于是卡片在分享页上变成一片**空缺**，
   * 而页面上没有任何说明。`blocks-markdown.ts` 里写的「分享页有写」指的是
   * 写在代码注释和 README 里，**不是页面上**；对外发链接的人看不到那段注释。
   *
   * 不改成「渲染 blocks」是有意的：分享页不加载内部组件（见文件头注释）。
   * 所以这里只**数一下**有几张卡片，好让 `withCardNotices` 能在页面上说清楚。
   */
  blocks?: Block[]
  updatedAt: number
  allowDownload: boolean
  watermark: { enabled: boolean; text: string }
}

type State =
  | { phase: 'loading' }
  | { phase: 'need-pwd'; message: string }
  | { phase: 'denied'; message: string; code: number }
  | { phase: 'ready'; doc: Doc }

/** 分享链接长什么样。必须指向**真实部署地址**，不能是写死的假域名 */
export function shareUrlOf(docId: string): string {
  return `${location.origin}/#/public/doc/${docId}`
}

export default function PublicDoc() {
  const location = useLocation()
  /**
   * 文档 id **从 pathname 自己解析**，不用 `useParams`。
   *
   * 因为这一页是在 `<Routes>` **外面**渲染的（App 里提前 return 了），
   * 而 `useParams` 读的是「当前匹配的路由」的参数表 ——
   * 外面没有匹配，`docId` 恒为空。
   *
   * 症状特别难认：页面不是报错，而是**一直显示「正在打开…」**，
   * 因为 effect 里 `if (!docId) return` 直接短路了，连一次请求都没发。
   * 看起来像服务端不响应，而问题在前端一个 hook 上。
   */
  const docId = decodeURIComponent(location.pathname.replace(/^\/public\/doc\//, ''))
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [pwd, setPwd] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * `pwd` 刻意**不是**取数的依赖，只有点「打开」才带上它。
   *
   * 原来把 pwd 放进依赖数组，结果是**每敲一个字符就发一次请求**：
   * 访客在输 6 位密码时就已经发了 6 次，其中大部分密码还是错的 ——
   * 服务端的限流（10 分钟 8 次）会在他输完之前就把他锁在外面。
   *
   * 而且界面上看不出异常：没有报错、没有转圈，
   * 只是「怎么输了半天都不进去」。
   */
  const [submittedPwd, setSubmittedPwd] = useState('')

  useEffect(() => {
    if (!docId) return
    let alive = true
    setState({ phase: 'loading' })
    /**
     * 密码走 POST + JSON body，不走请求头。
     * 请求头是 ByteString，「口令2026」这种中文口令**根本发不出去** ——
     * fetch 会直接抛 TypeError，而这个错发生在浏览器里，
     * 看起来完全不像知识库的问题。query 更糟：会进浏览器历史和 Referer。
     */
    const req = submittedPwd
      ? fetch(`/api/public/doc/${encodeURIComponent(docId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: submittedPwd }),
        })
      : fetch(`/api/public/doc/${encodeURIComponent(docId)}`)
    req
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!alive) return
        if (r.ok) { setState({ phase: 'ready', doc: j as Doc }); return }
        // 401 分两种：没带密码（要提示输入）和带错了（要提示重输）。
        // 服务端给的是不同的话术，这里照原样显示，不自己编。
        if (r.status === 401) setState({ phase: 'need-pwd', message: String(j.error || '需要访问密码') })
        else if (r.status === 429) setState({ phase: 'denied', message: String(j.error || '尝试次数过多'), code: 429 })
        else setState({ phase: 'denied', message: String(j.error || '无法访问这份文档'), code: r.status })
      })
      .catch(() => { if (alive) setState({ phase: 'denied', message: '连不上知识库服务，请稍后重试', code: 0 }) })
    return () => { alive = false }
  }, [docId, submittedPwd])

  useEffect(() => {
    if (state.phase === 'need-pwd') inputRef.current?.focus()
  }, [state.phase])

  return (
    <div className="yq-public">
      {/* 水印：知识库开了全局水印就带一份，外部拿到的东西也要能追到人 */}
      {state.phase === 'ready' && state.doc.watermark.enabled && (
        <div className="yq-doc-watermark" aria-hidden="true" data-testid="public-watermark">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className="yq-doc-watermark-item">{state.doc.watermark.text}</span>
          ))}
        </div>
      )}

      <header className="yq-public-bar">
        <span className="yq-public-brand">知语 · 对外分享</span>
        <Link className="yq-public-login" to="/">登录</Link>
      </header>

      <main className="yq-public-main">
        {state.phase === 'loading' && <div className="yq-public-hint">正在打开…</div>}

        {state.phase === 'need-pwd' && (
          <form
            className="yq-public-card"
            onSubmit={(e) => { e.preventDefault(); if (pwd) setSubmittedPwd(pwd) }}
          >
            <div className="yq-public-card-title">这份文档需要访问密码</div>
            <div className="yq-public-card-desc">{state.message}</div>
            <input
              ref={inputRef}
              className="yq-public-input"
              type="password"
              placeholder="访问密码"
              value={pwd}
              autoComplete="off"
              onChange={(e) => setPwd(e.target.value)}
            />
            <button className="yq-public-btn" type="submit" disabled={!pwd}>
              打开
            </button>
          </form>
        )}

        {state.phase === 'denied' && (
          <div className="yq-public-card">
            <div className="yq-public-card-title">
              {state.code === 404 ? '文档不存在或已被删除' : '无法访问这份文档'}
            </div>
            <div className="yq-public-card-desc">{state.message}</div>
            {state.code === 403 && (
              <div className="yq-public-card-desc" style={{ opacity: 0.7 }}>
                如果你是内部同事，请<Link to="/" className="yq-public-link">登录</Link>后从知识库里打开。
              </div>
            )}
          </div>
        )}

        {state.phase === 'ready' && (
          <article className="yq-public-doc" data-testid="public-doc">
            <h1 className="yq-public-title">{state.doc.title}</h1>
            {state.doc.summary && <p className="yq-public-summary">{state.doc.summary}</p>}
            <div className="yq-public-meta">
              更新于 {new Date(state.doc.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
            {/*
               * `withCardNotices` 与四个导出入口用的是**同一个函数** ——
               * 「这份文档里有几张卡片、内容没跟过来」这句话只写一处，
               * 免得改了导出忘了分享页（这类漏改本项目栽过）。
               * 但最后一句「下一步」要换：访客没有账号，
               * 「到站内查看」对他毫无意义，所以这里传分享页自己的说法。
               */}
            <div className="yq-md">
              {renderMarkdown(
                withCardNotices(
                  state.doc.body,
                  state.doc.blocks || [],
                  '这一页按纯文本显示，交互部分需要向分享者索取站内链接。',
                ),
              )}
            </div>
            {!state.doc.allowDownload && (
              <div className="yq-public-nodownload">分享者已关闭这份文档的下载与复制。</div>
            )}
          </article>
        )}
      </main>
    </div>
  )
}
