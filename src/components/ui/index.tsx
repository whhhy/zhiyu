import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './index.css'

/* ============================================================
   基础 UI 组件库 —— 语雀风格：白底、小圆角、细边框、hover 才出边框
   ============================================================ */

/* ---------------- Button ---------------- */

type ButtonVariant = 'primary' | 'default' | 'text' | 'green' | 'danger' | 'ghost'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  block?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`yq-btn yq-btn-${variant} yq-btn-${size} ${block ? 'yq-btn-block' : ''} ${className}`}
      {...rest}
    >
      {icon && <span className="yq-btn-icon">{icon}</span>}
      {children && <span className="yq-btn-text">{children}</span>}
    </button>
  )
}

/* ---------------- IconButton ---------------- */

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  size?: number
}

export function IconButton({ active, size = 16, className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      className={`yq-iconbtn ${active ? 'is-active' : ''} ${className}`}
      style={{ fontSize: size }}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ---------------- Input ---------------- */

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  prefix?: ReactNode
  suffix?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  clearable?: boolean
}

export function Input({ prefix, suffix, size = 'md', clearable, className = '', value, ...rest }: InputProps) {
  const [focused, setFocused] = useState(false)
  return (
    <div
      className={`yq-input yq-input-${size} ${focused ? 'is-focused' : ''} ${className}`}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      {prefix && <span className="yq-input-affix">{prefix}</span>}
      <input className="yq-input-el" value={value} {...rest} />
      {clearable && String(value || '').length > 0 && suffix !== undefined ? null : null}
      {suffix && <span className="yq-input-affix">{suffix}</span>}
    </div>
  )
}

/* ---------------- Select ---------------- */

interface SelectProps {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  size?: 'sm' | 'md'
  className?: string
  /**
   * 真禁用。
   *
   * ⚠️ 这一列原来**根本不存在**，而 `BookSettings` 的成员角色下拉传了
   * `disabled={!canAdmin}` —— 属性被**静默丢掉**，`<select>` 照样可点。
   * 于是没有管理权的人看到一个活生生的下拉，点下去服务端拒绝，
   * 界面上什么都不发生 —— 正是这个项目最恨的那一类：
   * **长得像能点、点了没反应**。
   *
   * 加进来之后还要配一个看得出来的禁用态：
   * 真禁用但外观和能点时一模一样，用户只会以为「点了没反应」。
   */
  disabled?: boolean
}

export function Select({ value, onChange, options, size = 'md', className = '', disabled }: SelectProps) {
  return (
    <div className={`yq-select yq-select-${size} ${disabled ? 'is-disabled' : ''} ${className}`}>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="yq-select-arrow">▾</span>
    </div>
  )
}

/* ---------------- Switch ---------------- */

export function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <button
      className={`yq-switch yq-switch-${size} ${checked ? 'is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="yq-switch-knob" />
    </button>
  )
}

/* ---------------- Checkbox ---------------- */

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`yq-checkbox ${checked ? 'is-checked' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="yq-checkbox-box">
        {checked && (
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path d="M2 6.2 4.6 8.8 10 3.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {children && <span className="yq-checkbox-label">{children}</span>}
    </label>
  )
}

/* ---------------- Radio ---------------- */

export function Radio({
  checked,
  onChange,
  name,
  children,
}: {
  checked: boolean
  onChange: () => void
  name?: string
  children?: ReactNode
}) {
  return (
    <label className={`yq-radio ${checked ? 'is-checked' : ''}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className="yq-radio-dot" />
      {children && <span className="yq-radio-label">{children}</span>}
    </label>
  )
}

/* ---------------- Modal ---------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="yq-modal-mask" onMouseDown={onClose}>
      {/* 宽度取 min(原宽, 视口 - 24px)：窄屏下自动收成满宽，不会溢出屏幕 */}
      <div className="yq-modal yq-fade-in" style={{ width: `min(${width}px, calc(100vw - 24px))` }} onMouseDown={(e) => e.stopPropagation()}>
        {title && (
          <div className="yq-modal-header">
            <h3 className="yq-modal-title">{title}</h3>
            <IconButton className="yq-modal-close" onClick={onClose}>✕</IconButton>
          </div>
        )}
        <div className="yq-modal-body">{children}</div>
        {footer && <div className="yq-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ---------------- Drawer ---------------- */

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 420,
  placement = 'right',
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  width?: number
  placement?: 'left' | 'right'
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="yq-drawer-mask" onMouseDown={onClose}>
      {/* 手机上 --yq-drawer-w = 100vw（见 responsive.css），抽屉满宽并从底部升起 */}
      <div
        className={`yq-drawer yq-drawer-${placement}`}
        style={{ width: `min(${width}px, var(--yq-drawer-w, calc(100vw - 24px)))` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="yq-drawer-header">
            <h3>{title}</h3>
            <IconButton onClick={onClose}>✕</IconButton>
          </div>
        )}
        <div className="yq-drawer-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/* ---------------- Popover ---------------- */

export function Popover({
  trigger,
  children,
  align = 'left',
  width,
  offset = 6,
  anchor,
  open: openProp,
  onOpenChange,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right' | 'center'
  width?: number
  offset?: number
  /**
   * 外部锚点（视口坐标），给了就按它定位，不再按 trigger 元素。
   * 右键菜单要用：触发源不是按钮，而是鼠标按下的位置。
   */
  anchor?: { x: number; y: number } | null
  /** 受控打开。给了就用它，否则走内部 state（按钮触发的老用法不用改） */
  open?: boolean
  onOpenChange?: (v: boolean) => void
}) {
  const [openInner, setOpenInner] = useState(false)
  const open = openProp ?? openInner
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setOpenInner(v)
    onOpenChange?.(v)
  }
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (!open || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    // 面板宽度要用面板自己的，不能用 trigger 的，否则右对齐/居中会算偏
    const w = panelRef.current?.offsetWidth || width || rect.width
    const h = panelRef.current?.offsetHeight || 0
    let left: number
    let top: number
    if (anchor) {
      left = anchor.x
      top = anchor.y
    } else {
      left = align === 'right' ? rect.right - w : align === 'center' ? rect.left + rect.width / 2 - w / 2 : rect.left
      top = rect.bottom + offset
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    // 右键菜单多半在视口下半屏：放不下就**往上翻**，别让菜单掉出屏幕
    if (h && top + h > window.innerHeight - 8) {
      top = Math.max(8, anchor ? anchor.y - h : window.innerHeight - h - 8)
    }
    setPos({ top, left })
    const close = (e: MouseEvent) => {
      // 面板已经 portal 到 body，点在面板内部也要算「没点到外部」，
      // 否则点菜单项会先触发这里把面板卸载，onClick 永远收不到
      const t = e.target as Node
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('resize', () => setOpen(false), { once: true })
    return () => document.removeEventListener('mousedown', close)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align, offset, width, anchor?.x, anchor?.y])

  return (
    <div className="yq-popover-wrap" ref={ref}>
      {trigger(open, () => setOpen(!open))}
      {open &&
        /* 必须 portal 到 body：文档页的 .yq-doc-main 是 overflow:hidden，
           不脱离文档流的定位会被祖先裁掉，面板就点不到了 */
        createPortal(
          <div
            ref={panelRef}
            className="yq-popover yq-fade-in"
            /* 同 Modal / Drawer：宽度取 min(原宽, 视口 - 24px)，
               面板定位在下面量 offsetWidth，量到的就是收窄后的真实宽度 */
            style={{ top: pos.top, left: pos.left, width: width ? `min(${width}px, calc(100vw - 24px))` : undefined }}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ---------------- Dropdown (Popover 的菜单形态) ---------------- */

export function Dropdown({
  trigger,
  children,
  align = 'left',
  width = 180,
  anchor,
  open,
  onOpenChange,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right' | 'center'
  width?: number
  anchor?: { x: number; y: number } | null
  open?: boolean
  onOpenChange?: (v: boolean) => void
}) {
  return (
    <Popover
      trigger={trigger}
      align={align}
      width={width}
      anchor={anchor}
      open={open}
      onOpenChange={onOpenChange}
    >
      {children}
    </Popover>
  )
}

/* ---------------- MenuItem ---------------- */

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  trailing,
}: {
  icon?: ReactNode
  children: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  trailing?: ReactNode
}) {
  return (
    <button
      className={`yq-menu-item ${danger ? 'is-danger' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <span className="yq-menu-icon">{icon}</span>}
      <span className="yq-menu-text">{children}</span>
      {trailing && <span className="yq-menu-trailing">{trailing}</span>}
    </button>
  )
}

export function MenuDivider() {
  return <div className="yq-menu-divider" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="yq-menu-label">{children}</div>
}

/* ---------------- Tooltip ---------------- */

export function Tooltip({
  title,
  children,
  placement = 'top',
}: {
  title: ReactNode
  children: ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
}) {
  const [pos, setPos] = useState<{ left: number; top: number; transform: string } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

  /**
   * ⚠️ 这里用 **portal + position:fixed**，不是就地渲染（2026-10-16 改）。
   *
   * 原来提示条是触发元素的绝对定位子节点。问题在于**它所在的祖先里
   * 只要有一个是滚动容器，就一定会被裁掉**。踩到的地方：
   * `.yq-toolbar` 写着
   *   `overflow-x: auto; overflow-y: visible;`
   * 而按 CSS 规范，只要 overflow-x 不是 visible，**overflow-y 就会一并
   * 算成 auto** —— 于是工具栏变成纵向也裁剪的容器，
   * 而提示条 `top: calc(100% + 6px)` 正好渲染在它**下面**，
   * 整条被裁光：DOM 里有、文字也对（实测「标题块本身已加粗」），
   * 屏幕上**一个像素都看不到**。
   *
   * 症状是「鼠标放上去什么都没发生」，而代码里 title 一个都没漏 ——
   * 只看代码永远看不出来。
   *
   * 挂到 body 上用 fixed 定位，一劳永逸：
   * 任何滚动容器、overflow:hidden、transform 都裁不到它。
   */
  const show = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const GAP = 6
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (placement === 'bottom') setPos({ left: cx, top: r.bottom + GAP, transform: 'translate(-50%, 0)' })
    else if (placement === 'left') setPos({ left: r.left - GAP, top: cy, transform: 'translate(-100%, -50%)' })
    else if (placement === 'right') setPos({ left: r.right + GAP, top: cy, transform: 'translate(0, -50%)' })
    else setPos({ left: cx, top: r.top - GAP, transform: 'translate(-50%, -100%)' })
  }
  const hide = () => setPos(null)

  return (
    <>
      <span ref={ref} className="yq-tooltip-wrap" onMouseEnter={show} onMouseLeave={hide}>
        {children}
      </span>
      {pos && title && createPortal(
        <div className="yq-tooltip yq-tooltip-fixed" style={pos}>{title}</div>,
        document.body,
      )}
    </>
  )
}

/* ---------------- Avatar ---------------- */

/**
 * 头像。
 *
 * `src` 是可选的**图片地址**（2026-10-11 加，配合头像上传）。
 * 没有 src、或者图加载失败（onError）时，**自动回退到首字母** ——
 * 头像链接失效不该让人变成一个没有头像的人。
 *
 * ⚠️ 图片用 background-image 而不是 <img>：这样不会在 alt 缺失时
 *    触发读屏软件念出文件名（头像的 alt 本来也就是空的）。
 */
export function Avatar({
  name,
  size = 28,
  className = '',
  style,
  src,
}: {
  name: string
  size?: number
  className?: string
  style?: React.CSSProperties
  /** 图片地址；有则显示图，无或加载失败则回退首字母 */
  src?: string
}) {
  const [broken, setBroken] = useState(false)
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(name)
  // 换一个 src（换了头像）要把「上一次失败」清掉，否则新图也显示不出来
  useEffect(() => { setBroken(false) }, [src])
  const useImg = !!src && !broken

  if (!useImg) {
    return (
      <span
        className={`yq-avatar ${className}`}
        style={{ width: size, height: size, fontSize: size * 0.55, ...style }}
      >
        {emoji ? name : name.slice(0, 1)}
      </span>
    )
  }

  /*
   * 有图时用**真正的 <img>** 而不是 background-image。
   *
   * ⚠️ 第一版用 `background-image` + 把 onError 挂在 span 上 ——
   *    那**行不通**：background-image 加载失败不会在 span 上派发 error 事件，
   *    于是 broken 永远不置 true，头像变成一个空白方块。
   *    「加载失败要回退」这件事，只有 <img> 真的能感知。
   *
   *    alt 留空：头像的 alt 写出来也是空的（"管理员的头像"），
   *    读屏软件会念一句没有信息量的话。
   */
  return (
    <span className={`yq-avatar ${className}`} style={{ width: size, height: size, overflow: 'hidden', ...style }}>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={() => setBroken(true)}
      />
    </span>
  )
}

export function AvatarGroup({ members, max = 5, size = 24 }: { members: string[]; max?: number; size?: number }) {
  const shown = members.slice(0, max)
  const rest = members.length - shown.length
  return (
    <div className="yq-avatar-group">
      {shown.map((m, i) => (
        <Avatar key={i} name={m} size={size} />
      ))}
      {rest > 0 && (
        <span className="yq-avatar yq-avatar-rest" style={{ width: size, height: size, fontSize: size * 0.4 }}>
          +{rest}
        </span>
      )}
    </div>
  )
}

/* ---------------- Tag ---------------- */

export function Tag({
  children,
  color = 'default',
  size = 'md',
  onClose,
}: {
  children: ReactNode
  color?: 'default' | 'primary' | 'green' | 'warning' | 'danger'
  size?: 'sm' | 'md'
  onClose?: () => void
}) {
  return (
    <span className={`yq-tag yq-tag-${color} yq-tag-${size}`}>
      {children}
      {onClose && (
        <span className="yq-tag-close" onClick={onClose}>
          ✕
        </span>
      )}
    </span>
  )
}

/* ---------------- Empty ---------------- */

export function Empty({ icon = '📭', text, action }: { icon?: ReactNode; text?: string; action?: ReactNode }) {
  return (
    <div className="yq-empty">
      <div className="yq-empty-icon">{icon}</div>
      {text && <div className="yq-empty-text">{text}</div>}
      {action && <div className="yq-empty-action">{action}</div>}
    </div>
  )
}

/* ---------------- Tabs ---------------- */

export function Tabs({
  value,
  onChange,
  items,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  items: { value: string; label: ReactNode; count?: number }[]
  className?: string
}) {
  return (
    <div className={`yq-tabs ${className}`}>
      {items.map((it) => (
        <button
          key={it.value}
          className={`yq-tab ${value === it.value ? 'is-active' : ''}`}
          onClick={() => onChange(it.value)}
        >
          {it.label}
          {it.count !== undefined && <span className="yq-tab-count">{it.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------------- Progress ---------------- */

export function Progress({ percent, color = 'var(--yq-primary)' }: { percent: number; color?: string }) {
  return (
    <div className="yq-progress">
      <div className="yq-progress-bar" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: color }} />
    </div>
  )
}

/* ---------------- Skeleton ---------------- */

export function Skeleton({ width = '100%', height = 14, radius = 4 }: { width?: string | number; height?: number; radius?: number }) {
  return <div className="yq-skeleton" style={{ width, height, borderRadius: radius }} />
}

/* ---------------- Segmented ---------------- */

export function Segmented({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: ReactNode; icon?: ReactNode }[]
  size?: 'sm' | 'md'
}) {
  return (
    <div className={`yq-segmented yq-segmented-${size}`}>
      {options.map((o) => (
        <button
          key={o.value}
          className={`yq-seg ${value === o.value ? 'is-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <span className="yq-seg-icon">{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  )
}
