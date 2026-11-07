import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store'
import { purgeDoc, purgeAllTrash, trashRetention } from '@/lib/api'
import { useBookPermsMany } from '@/lib/perms'
import { Button, Empty, Tag } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import '../styles/layout.css'

/* ============================================================
   回收站
   ============================================================ */

export default function Trash() {
  const { trash, restoreFromTrash, toast } = useStore()
  /** 清空回收站进行中：按钮要禁掉，否则连点两次就是两个并发批次 */
  const [purging, setPurging] = useState(false)
  /**
   * 保留期**从服务端问**，不再写死 30。
   *
   * 以前这里是前端写死的 `30 * 86400_000`，
   * 而服务端根本没有清除任务 —— 也就是说那句「还剩 N 天」倒计时
   * 从来没有对应的实现，文档会一直躺着。
   * 现在服务端真会清（见 server/sync.ts 的 purgeExpiredTrash），
   * 保留天数还能用 YQ_TRASH_DAYS 改，界面上这句话就得跟着变。
   */
  const [retention, setRetention] = useState<{ days: number; note: string; known: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    trashRetention()
      .then((r) => { if (alive) setRetention({ ...r, known: true }) })
      /*
       * ⚠️ 这里**必须区分「没查到」和「确实是 0」**，下面那行文案全靠它。
       *
       * 原来 `days` 缺省就是 0，于是「接口失败」和「实例真的没开清除」落到同一条分支，
       * 每篇文档后面都写着「· 本实例未开启自动清除」——
       * 而同屏上方的副标题还写着「无法确认保留期」，**两句自相矛盾**，
       * 而且那句假话是**逐条重复**的、最像事实的那句。
       *
       * 后果是关于**数据保留**的假承诺：管理员据此以为「删掉的文档会一直留着」，
       * 而服务端可能 30 天后就清掉了。公司照这句话定数据保留策略会得出错的结论
       * （`server/index.ts` 里记着这条为什么严重）。
       */
      .catch(() => { if (alive) setRetention({ days: 0, note: '无法确认保留期，请到服务端查看', known: false }) })
    return () => { alive = false }
  }, [])
  const retentionDays = retention?.days ?? 0

  /**
   * 权限第一道（见 `server/sync.ts` 的 `restoreDoc` / `purgeDoc`）：
   * 服务端判的是「**这一行属于哪个库**」，而这一页的行**分属不同的知识库** ——
   * 所以必须**按行**判，不能整页一刀切（详见 `useBookPermsMany` 的注释）。
   *
   * 实测（reader，探针 2026-10-12）：改之前这一页对所有角色都渲染出
   * 「恢复」和「永久删除」，而读者点下去两个都被服务端拒
   * （`restoreDoc` 要 `edit`、`purgeDoc` 要 `admin`）。
   * 界面给了必然失败的操作，用户只会当成产品坏了。
   *
   * fail closed：caps 还是 `null`（还没问回来）时按「不能」处理，
   * 与 `BookSettings` 同一口径 —— 宁可晚半秒出现按钮。
   */
  const capsMap = useBookPermsMany(useMemo(() => trash.map((t) => t.bookId), [trash]))
  const canRestore = (bookId: string) => capsMap[bookId] != null && capsMap[bookId]!.edit
  const canPurge = (bookId: string) => capsMap[bookId] != null && capsMap[bookId]!.admin

  /**
   * 「清空回收站」只在**每一行都归我管**时才给。
   *
   * 按钮上写的是「将被永久删除」—— 给了却做不到的话，
   * 那不只是一个失败的操作，还是一句**关于数据被清掉的假承诺**
   *（和这一页最早那版「只删本地列表」是同一类毛病，方向相反）。
   * 处理方式差别很大：那种是假说做了，这一个是压根不该出现。
   *
   * 所以判据是「全部」，不是「任意一个」。
   */
  const allPurgeable = trash.length > 0 && trash.every((t) => canPurge(t.bookId))

  return (
    <div className="yq-dash yq-dash-narrow">
      <header className="yq-dash-header">
        <div>
          <h1 className="yq-dash-greeting">回收站</h1>
          <p className="yq-dash-date">
            {retention ? retention.note : '正在确认保留期…'}
          </p>
        </div>
        {allPurgeable && (
          <Button
            variant="danger"
            size="sm"
            disabled={purging}
            onClick={async () => {
              /**
               * 原来是 `useStore.setState({ trash: [] })` 加一句 toast ——
               * 服务端的 `trash` 表和 `docs` 行**一行都没动**，
               * 刷新一下那些文档就全回来了。
               * 而确认框上写着「将被**永久删除**，**无法恢复**」。
               *
               * 这是同类问题里最糟的一个：它不只没做事，
               * 还**承诺了一件不可逆的事**。用户照这句话去理解
               * 自己的数据状态，得到的结论是错的。
               *
               * 所以现在真的调服务端，并且**失败就说失败** ——
               * 清不掉的（别人的文档、没权限的）要逐条报出来。
               */
              if (!confirm(`确定清空回收站？${trash.length} 个文档将被永久删除，无法恢复。`)) return
              setPurging(true)
              try {
                const r = await purgeAllTrash()
                const removed = new Set(r.purgedIds || [])
                useStore.setState((s) => ({ trash: s.trash.filter((x) => !removed.has(x.docId)) }))
                useStore.getState().dropPurgedDocs?.([...removed])
                if (r.failed?.length) {
                  toast(`清掉了 ${r.purged} 篇，${r.failed.length} 篇没权限（已留在回收站里）`, 'error')
                } else {
                  toast(`回收站已清空（${r.purged} 篇）`, 'success')
                }
              } catch (e: any) {
                toast(e?.message || '清空失败，什么都没删', 'error')
              } finally {
                setPurging(false)
              }
            }}
          >
            {purging ? '正在永久删除…' : '清空回收站'}
          </Button>
        )}
      </header>

      {trash.length === 0 ? (
        <Empty icon="🗑" text="回收站是空的" action={<span style={{ fontSize: 12, color: 'var(--yq-text-4)' }}>删除的文档会出现在这里</span>} />
      ) : (
        <div className="yq-card">
          {trash.map((t) => (
            <div key={t.docId} className="yq-list-row" style={{ cursor: 'default' }}>
              <span className="yq-list-icon">📄</span>
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-list-row-title yq-ellipsis">{t.title}</div>
                <div className="yq-list-row-meta">
                  <span>删除于 {timeAgo(t.deletedAt)}</span>
                  {retention?.known ? (
                    retentionDays > 0 ? (
                      <>
                        <span>·</span>
                        <span>{Math.max(0, Math.ceil((retentionDays * 86400_000 - (Date.now() - t.deletedAt)) / 86400_000))} 天后自动清除</span>
                      </>
                    ) : (
                      <span>· 本实例未开启自动清除</span>
                    )
                  ) : (
                    /*
                     * 没问到就不下结论。写「本实例未开启自动清除」是**编造**：
                     * 真实原因可能是接口失败，而保留期大概率仍是 30 天。
                     * 宁可少说一句，也不要在数据保留这件事上给管理员一个假事实。
                     */
                    <span>· 保留期未能确认</span>
                  )}
                </div>
              </div>
              <div className="yq-flex yq-gap-8">
                <Button
                  variant="default"
                  size="sm"
                  disabled={!canRestore(t.bookId)}
                  title={canRestore(t.bookId) ? '' : '没有恢复该文档的权限（服务端要求编辑权）'}
                  onClick={() => { restoreFromTrash(t.docId); }}
                >
                  恢复
                </Button>
                <Button
                  variant="text"
                  size="sm"
                  disabled={!canPurge(t.bookId)}
                  title={canPurge(t.bookId) ? '' : '只有知识库管理员可以彻底删除'}
                  onClick={async () => {
                    /* 同样：原来只把这一行从本地列表里去掉，
                       服务端那篇还在 —— 而文案写着「此操作不可恢复」。 */
                    if (!confirm(`永久删除「${t.title}」？此操作不可恢复。`)) return
                    try {
                      await purgeDoc(t.docId)
                      useStore.setState((s) => ({ trash: s.trash.filter((x) => x.docId !== t.docId) }))
                      useStore.getState().dropPurgedDocs?.([t.docId])
                      toast('已永久删除', 'success')
                    } catch (e: any) {
                      toast(e?.message || '删除失败，文档仍在回收站里', 'error')
                    }
                  }}
                >
                  永久删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
