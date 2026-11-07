/*
 * 「移动 / 复制文档到另一个知识库」弹窗。
 *
 * ⚠️ 为什么要抽出来：这份逻辑原本**内联在 DocPage 里**（约 100 行状态 + JSX），
 * 而 2026-10-09 对照官方语雀的目录树「···」菜单时发现，它在两个地方都需要：
 *   · DocPage 顶部的「移动 / 复制到…」
 *   · 目录树节点的「复制…」/「移动…」（语雀那份菜单里有，我们原来只有「打开」）
 *
 * 抄第二遍就是「同一份逻辑写两处、一定会漏一处」——
 * 这轮已经因为它栽了两次（回收站的 bookId 修了 `deleteDoc` 漏了 `deleteNode`；
 * 演示控件门控修了设置页漏了顶栏）。所以这里抽成组件，两处共用。
 *
 * 语义（与语雀一致，且服务端 `moveDoc(docId, bookId, mode)` 本来就支持）：
 *   · 移动 —— 原知识库里这篇消失
 *   · 复制 —— 原库保留，另建一份副本，副本署当前用户的名，且不带原路径
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store'
import { moveDoc } from '@/lib/api'
import { useBookPermsMany } from '@/lib/perms'
import { Modal, Button } from '@/components/ui'

export default function MoveDocDialog({
  docId,
  bookId,
  title,
  /** 初始模式：目录树的「移动…」传 move、「复制…」传 copy */
  mode: initialMode = 'move',
  onClose,
}: {
  docId: string
  bookId: string
  title: string
  mode?: 'move' | 'copy'
  onClose: () => void
}) {
  const { books, toast } = useStore()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'move' | 'copy'>(initialMode)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * 限同一个空间内的其它知识库。
   *
   * 跨空间搬文档等于把内容带到一个「那里的人可能不该看到」的地方 ——
   * 界面上直接不给出这个选项，而不是让服务端拒绝（点了被拒更让人困惑）。
   */
  const targets = useMemo(() => {
    const cur = books.find((b) => b.id === bookId)
    if (!cur) return []
    return books.filter((b) => b.id !== cur.id && b.spaceId === cur.spaceId)
  }, [books, bookId])

  /**
   * 目标库还要按**它自己的 `create` 权限**过一道。
   *
   * 服务端 `moveDoc` 两边都判（源库要 `edit`、目标库要 `create`），判得没问题。
   * 而这个弹窗原来只按**空间**过滤，把用户压根建不了文档的库也列进去 ——
   * 选它、点确认，然后吃一句「你在目标知识库里没有新建文档的权限」。
   *
   * 讽刺的是这个组件**自己的注释**就写着那条原则：
   * 「界面上直接不给出这个选项，而不是让服务端拒绝（点了被拒更让人困惑）」——
   * 只不过当时只用在了跨空间那一半上。**同一个函数里两半标准不一致。**
   *
   * 判据与服务端同源（`capsInBook().create`），fail closed：没问回来时按「不能」。
   */
  const capsMap = useBookPermsMany(targets.map((b) => b.id))
  const canCreateIn = (id: string) => capsMap[id] != null && capsMap[id]!.create

  const run = async () => {
    if (!target) return
    const t = targets.find((b) => b.id === target)
    if (mode === 'move' && !confirm(`把《${title}》移动到《${t?.name}》？\n移动后**原知识库里这篇会消失**。`)) return
    setBusy(true)
    try {
      const r = await moveDoc(docId, target, mode)
      onClose()
      if (mode === 'move') {
        toast(`已移动到《${t?.name}》`, 'success')
        navigate(`/book/${target}/doc/${r.docId}`)
      } else {
        toast(`已复制到《${t?.name}》（副本署你的名）`, 'success')
      }
    } catch (e: any) {
      toast(e?.message || '操作失败，什么都没变', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="移动 / 复制文档" width={470}>
      <div className="yq-docset">
        <div className="yq-docset-hint" style={{ marginTop: 0 }}>
          目标知识库（<b>限同一个空间内</b>）：跨空间搬文档等于把内容带到一个
          那里的人可能不该看到的地方 —— 真要跨空间，先建一个知识库再挪。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '10px 0 4px' }}>
          {targets.map((b) => {
            const can = canCreateIn(b.id)
            return (
              <label
                key={b.id}
                className="yq-share-opt"
                style={{ marginBottom: 0, opacity: can ? 1 : 0.55, cursor: can ? 'pointer' : 'not-allowed' }}
                title={can ? '' : '你在目标知识库里没有新建文档的权限'}
              >
                <input
                  type="radio"
                  checked={target === b.id}
                  disabled={!can}
                  onChange={() => can && setTarget(b.id)}
                />
                <span className="yq-share-radio" />
                <span className="yq-flex-1">
                  <span className="yq-share-opt-label">{b.avatar} {b.name}</span>
                  {b.desc ? <span className="yq-share-opt-desc">{b.desc}</span> : null}
                  {!can ? <span className="yq-share-opt-desc">· 你在这里没有新建文档的权限</span> : null}
                </span>
              </label>
            )
          })}
        </div>
        {!targets.length && (
          <div className="yq-docset-hint" style={{ marginTop: 10 }}>
            这个空间里只有当前这一个知识库，没地方可移 —— 先再建一个。
          </div>
        )}
        <div className="yq-docset-hint" style={{ marginTop: 10 }}>
          当前是「<b>{mode === 'move' ? '移动' : '复制'}</b>」。
          {mode === 'move'
            ? '移动后原知识库里这篇会消失 —— 只是搬到过去。'
            : '复制后原库保留，另建一份副本；副本署你的名，且不带原路径（同一个路径在两个库里会互相绊住）。'}
        </div>
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="text" onClick={onClose}>取消</Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => setMode(mode === 'move' ? 'copy' : 'move')}
        >
          改成{mode === 'move' ? '复制' : '移动'}
        </Button>
        <Button
          variant={mode === 'move' ? 'danger' : 'primary'}
          size="sm"
          disabled={!target || busy || !targets.length}
          onClick={run}
        >
          {busy ? '处理中…' : mode === 'move' ? '移动' : '复制'}
        </Button>
      </div>
    </Modal>
  )
}