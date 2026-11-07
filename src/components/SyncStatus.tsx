import { useEffect, useState } from 'react'
import { onSyncState, state as syncState, type SyncState } from '@/lib/sync'
import { getMode } from '@/lib/api'
import { IconButton, Tooltip } from '@/components/ui'
import './SyncStatus.css'

/* ============================================================
   同步状态条

   解决的问题：
   服务端拒掉的写入（没权限、文档被锁、数据不合法）以前**完全没人提示**。
   用户看到的是「我明明改了、内容当时也在」，过一会儿就没了 ——
   没有任何地方告诉他「这一条没存上」。

   「我明明改了，怎么没了」是知识库里最难排查的一类问题。
   把「没存上」和「存上了」都变成看得见的状态，成本很低。
   ============================================================ */

export default function SyncStatus() {
  const [s, setS] = useState<SyncState>(syncState)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    // onSyncState 返回的是退订函数，这里必须返回 void，不能直接透传
    const off = onSyncState(setS)
    return () => { off() }
  }, [])

  // 本地模式没有服务端，显示它只会让人困惑
  if (getMode() !== 'server') return null

  const rejected = s.rejected || []
  const bad = rejected.length > 0
  const offline = !s.online
  const busy = s.pushing

  // 一切正常时不占地方（顶栏右侧多一个图标就够了）
  if (!bad && !offline && !busy && !s.error) return null

  const tone = bad || s.error ? 'error' : offline ? 'warn' : 'idle'
  const text = bad
    ? `${rejected.length} 处修改没有保存`
    : s.error
      ? `同步异常：${s.error}`
      : offline
        ? '已离线，改动会保留，恢复连接后自动同步'
        : '正在同步…'

  return (
    <div className={`yq-syncstatus yq-syncstatus-${tone}`}>
      <button
        type="button"
        className="yq-syncstatus-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-label={text}
      >
        <span className="yq-syncstatus-dot" />
        <span className="yq-syncstatus-text">{text}</span>
      </button>

      {expanded && rejected.length > 0 && (
        <div className="yq-syncstatus-panel">
          <div className="yq-syncstatus-title">以下是没能保存的改动</div>
          <ul>
            {rejected.slice(0, 12).map((r, i) => (
              <li key={`${r.entity}:${r.id}:${i}`}>
                <span className="yq-syncstatus-entity">{r.entity}</span>
                <span className="yq-syncstatus-id">{r.id}</span>
                <span className="yq-syncstatus-reason">{r.reason}</span>
              </li>
            ))}
          </ul>
          {rejected.length > 12 && <div className="yq-syncstatus-more">…另有 {rejected.length - 12} 条</div>}
          <div className="yq-syncstatus-hint">
            这些改动仍在你的页面上，但服务端没有收。常见原因：**你没有编辑权限**、
            **文档被别人锁了**、或者**它依赖的对象已经不存在了**（比如所属知识库被删了）。
            把内容复制出来再找有权限的人处理。
            {/*
             * ⚠️ 这里原来写的第三个原因是「内容超限」—— **它不存在**。
             * 同步推送路径上没有任何内容大小限制（全项目唯一的体积上限是头像上传的
             * 2MB，而那条走的是另一个接口，根本不会进 `rejected` 列表）。
             * 写一个做不到的原因，会让人去找一个不存在的限制 —— 和今天修的
             * 那些「界面承诺了实现做不到的事」是同一类。
             */}
          </div>
        </div>
      )}
    </div>
  )
}
