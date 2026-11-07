import { useEffect, useRef } from 'react'
import { Modal } from '@/components/ui'
import './index.css'

/* ============================================================
   快捷键面板 —— 语雀在文档编辑态右下角常驻的入口
   ============================================================ */

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: '通用',
    items: [
      ['⌘ S', '保存文档'],
      /*
       * ⚠️ 这里原来写的是「⌘ K 全局搜索」，而**⌘K 从来没实现过**：
       *   TopBar.tsx:75 唯一的搜索快捷键是 `e.key === '?'`，
       *   全 src 里 `metaKey === 'k'` / `toLowerCase() === 'k'` 零匹配。
       *   实测（2026-10-08 部署端）：按 Control+K → 搜索类元素 0 → 0，
       *   按 `?` → 8 个元素、输入框自动聚焦。
       *
       * 同一个错在 Help.tsx:20-21 **早就被记下来了**（「这两个根本不存在」），
       * 也就是说上一轮只改了帮助页、漏了本面板 —— 两份文案必然过期。
       * 现在这里如实写 `?`。
       */
      ['?', '全局搜索'],
      ['/', '唤起插入面板'],
      ['⌘ /', '唤起插入面板'],
      ['@', '提及成员或内容'],
      ['⌘ B', '加粗'],
      ['⌘ I', '斜体'],
      ['⌘ U', '下划线'],
      ['Esc', '关闭弹窗'],
    ],
  },
  {
    title: '编辑',
    items: [
      ['Enter', '新建块'],
      ['⇧ Enter', '块内换行'],
      ['Backspace', '合并 / 降级块'],
      ['Tab', '缩进或转列表'],
      ['↑ ↓', '在块间移动'],
      /*
       * ⚠️ 这条原来写的是「撤销上一次输入（仅块内，不含块级操作）」——
       *   那是**应用级撤销还不存在时**的实话：当时只有浏览器原生撤销，
       *   打字只退**一个字**，回车建块 / 删块 / 插卡片**一个都撤不回来**。
       *
       * ✅ 2026-10-19 补上了应用级撤销（`src/lib/undo.ts`），
       *   边界变了，所以文案也得跟着变 —— 留着旧文案就是在骗人。
       *   现在的边界：
       *     · 打字 → 一次 ⌘Z 撤掉**整串**（连续输入合并成一条）
       *     · 回车建块 → 第一次 ⌘Z 撤掉刚输入的字，第二次撤掉那个块
       *       （**一次撤一个动作**，和 Word / Notion 一样）
       *     · 删块 / 插卡片 / 转块类型 → 一次 ⌘Z 撤回来
       *     · ⌘⇧Z 重做
       *   仍然**不覆盖**的：跨文档的撤销，以及协作场景下「撤的是谁的改动」。
       */
      ['⌘ Z', '撤销（一次撤一个动作；连续打字算一次）'],
      ['⌘ ⇧ Z', '重做'],
    ],
  },
  {
    title: '视图',
    items: [
      ['⌘ ⇧ F', '隐藏 / 显示目录'],
      ['⌘ ⇧ O', '钉住 / 隐藏大纲'],
      ['⌘ ⇧ P', '标准页宽 / 超宽'],
      ['⌘ ⇧ R', '进入阅读模式'],
    ],
  },
]

export default function ShortcutPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="快捷键" width={620}>
      <div className="yq-shortcuts">
        {GROUPS.map((g) => (
          <div key={g.title} className="yq-shortcuts-group">
            <div className="yq-shortcuts-title">{g.title}</div>
            {g.items.map(([k, v]) => (
              <div key={k + v} className="yq-shortcuts-row">
                <kbd>{k}</kbd>
                <span>{v}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
