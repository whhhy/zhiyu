import { useStore } from '@/store'
import './Toaster.css'

export default function Toaster() {
  const { toasts, dismissToast } = useStore()
  if (!toasts.length) return null

  return (
    <div className="yq-toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`yq-toast yq-toast-${t.type} yq-fade-in`} onClick={() => dismissToast(t.id)}>
          <span className="yq-toast-icon">
            {t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}
          </span>
          <span className="yq-toast-text">{t.message}</span>
          {/*
            带动作的提示条（2026-10-16，为「删除空间 → 24 小时内撤销」）。

            ⚠️ 动作按钮**自己先 stopPropagation**：整个提示条是「点一下关掉」
            的，而点动作的意思是「执行撤销」，不是「关掉提示」——
            两者不区分的话，用户想反悔却只是把提示关了。
          */}
          {t.action && (
            <button
              className="yq-toast-action"
              onClick={(e) => { e.stopPropagation(); t.action!.run() }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
