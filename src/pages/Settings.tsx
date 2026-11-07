import { useState, useEffect , useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '@/store'
import { Avatar, Button, Input, Switch, Segmented, Tag, Modal, Dropdown, MenuItem, MenuDivider, Radio, Empty, Select } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import { downloadBundle, applyBundle } from '@/lib/io'
import { getMode, serverExport, verifyExport, offboardUser, changePassword, auditLog, accessLog, listTokens, listSessions, revokeSession, listMySecurityLog, type SessionRow, type SecurityLogRow, createToken, revokeToken, setUserRole, type ApiToken, type AccessItem, me, AUDIT_LABEL, type AuditItem } from '@/lib/api'
import { usePrefs, NOTIFY_KEYS, type Prefs, type NotifyKey } from '@/lib/prefs'
import { start as startSync, hydrate } from '@/lib/sync'
import { planImport, countDocs, treeDepth, previewBlocks, type ImportPlan, type ImportPlanNode, type ImportFile } from '@/lib/import-markdown'
import ImportDialog from '@/components/doc/ImportDialog'
import type { DocSheetData } from '@/types'
import { zipToImportFiles, readXlsx, parseCsv, decodeCsvBytes, sheetDataFromRows, isSpreadsheetName } from '@/lib/import-office'
import { parseLakebook, type LakebookParse } from '@/lib/lakebook'
import { markdownToBlocks } from '@/store'
import { uploadMyAvatar, myAvatarUrl, getToken, trashRetention } from '@/lib/api'
import '../styles/layout.css'

/* ============================================================
   账户设置
   ============================================================ */

/** 平台角色的中文说法。库里存的是 owner / admin / member */
const ROLE_CN: Record<string, string> = { owner: '超级管理员', admin: '管理员', member: '普通成员' }

export default function Settings() {
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { currentUser, members, spaces, switchUser, reset, toast, trash, updateMyProfile } = useStore()
  const [tab, setTab] = useState('profile')

  /**
   * 从**目录树的 ＋ 菜单**跳进来时（2026-10-16）。
   *
   * 语雀实测：导入在**知识库侧栏 ＋ 菜单**里，不在设置页。
   * 我们两边都留：侧栏那个入口跳到这里、带上 `?tab=data&import=1`，
   * 于是落到同一个「数据管理」页签并**自动打开格式选择器**。
   *
   * 为什么是「跳过来」而不是在树上再实现一遍：
   * 那五个导入弹窗依赖这一整套状态（预览计划、原始字节、进度），
   * 抄一份 = 同一份逻辑两处、必漏一处。
   *
   * ⚠️ 这两个参数**用完就从 URL 上抹掉** ——
   * 留着的话，用户关掉弹窗之后按一下浏览器「后退」，
   * 弹窗会自己又弹出来，看着像幽灵。
   */
  useEffect(() => {
    const t = sp.get('tab')
    if (t && t !== tab) setTab(t)
    if (sp.get('import') === '1') {
      setImpOpen(true)
      const n = new URLSearchParams(sp)
      n.delete('import'); n.delete('tab')
      setSp(n, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp])

  /* ---- 头像（2026-10-11） ---- */
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarId, setAvatarId] = useState(currentUser.avatar || '')
  const [avatarImg, setAvatarImg] = useState('')
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  // blob URL 换图 / 卸载时会失效，记下来 revoke —— 否则每换一次漏一个
  const avatarObjUrlRef = useRef('')

  /**
   * 取图：**fetch 成 blob 再转 objectURL**，而不是直接塞进 <img src>。
   *
   * ⚠️ 这条路由要登录态（个人资料），而浏览器给 <img src> 不会带
   *    Authorization 头 —— 那样做的结果是 403，界面表现为「头像一直是空的」，
   *    而看不出是鉴权问题。
   */
  useEffect(() => {
    if (!avatarId || getMode() !== 'server') { setAvatarImg(''); return }
    const token = getToken()
    let cancelled = false
    fetch(myAvatarUrl(avatarId), { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('取头像失败（' + r.status + '）'))))
      .then((b) => {
        if (cancelled) return
        if (avatarObjUrlRef.current) URL.revokeObjectURL(avatarObjUrlRef.current)
        const u = URL.createObjectURL(b)
        avatarObjUrlRef.current = u
        setAvatarImg(u)
      })
      .catch(() => { /* 取不到就回退首字母，不弹错 —— 头像不是关键功能 */ })
    return () => { cancelled = true }
  }, [avatarId])

  // 组件卸载时把 blob URL 收掉
  useEffect(() => () => { if (avatarObjUrlRef.current) URL.revokeObjectURL(avatarObjUrlRef.current) }, [])

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''      // 选同一个文件也要能再次触发 change
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { toast('头像太大，请用 2MB 以内的图片', 'error'); return }
    setUploadingAvatar(true)
    try {
      const r = await uploadMyAvatar(file)
      // 先传文件拿到 id，再引用它 —— 两步，与附件同一套机制
      await updateMyProfile({ avatar: r.avatarId })
      setAvatarId(r.avatarId)
      toast('头像已更新', 'success')
    } catch (err: any) {
      toast(err?.message || '头像上传失败', 'error')
    } finally {
      setUploadingAvatar(false)
    }
  }
  /*
   * 三个输入框原来都只改了**组件的局部 state**，点「保存修改」弹
   * 「资料已保存」—— 而服务端压根没有改资料的通路，刷新就回去了。
   * （「个人简介」连 state 都没有，用的是 defaultValue，改完连本地都留不住。）
   *
   * 现在都接上真的 `updateMyProfile`：服务端写成功后，
   * 用**服务端回来的那一行**覆盖本地，两台设备才对得上。
   */
  const [name, setName] = useState(currentUser.name)
  const [email, setEmail] = useState((currentUser as any).email || '')
  const [bio, setBio] = useState((currentUser as any).bio || '')
  const [resetOpen, setResetOpen] = useState(false)
  /**
   * 「上次修改于 X」原来是**写死的「3 个月前」**。
   *
   * 写死的数字比不显示更糟：它让人以为这个值是真的，而所有人看到的是同一个值 ——
   * 包括**今天刚改完密码**的人。所以这里从 `/api/auth/me` 取真实时间，
   * 没改过就直说「从未修改」，不编一个「3 个月前」。
   */
  const [pwdChangedAt, setPwdChangedAt] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    if (getMode() !== 'server') { setPwdChangedAt(null); return }
    me()
      .then((u) => { if (alive) setPwdChangedAt(u?.passwordChangedAt ?? null) })
      .catch(() => { if (alive) setPwdChangedAt(null) })
    return () => { alive = false }
  }, [])
  const pwdDesc = pwdChangedAt === undefined
    ? '正在读取修改时间…'
    : pwdChangedAt
      ? `上次修改于 ${timeAgo(pwdChangedAt)}`
      : '从未修改（用的是初始口令）'
  /**
   * 回收站保留期（天）。**从服务端问，不写死** ——
   * 写死的那版已经被改过：运维设 `YQ_TRASH_DAYS=60` 之后，
   * 这一页还在说 30 天，而回收站页说的是 60 天。
   * 同一件事两处说法不一致，而这件事关系到**用户的数据什么时候被删**。
   *
   * 问不到就留 null，那一行会显示「保留期正在确认…」而不是编一个数字 ——
   * 与 `Trash.tsx` 用同一个处理（没问到就不下结论）。
   */
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    if (getMode() !== 'server') return
    trashRetention()
      .then((r) => { if (alive) setRetentionDays(Number(r?.days ?? 0)) })
      .catch(() => { if (alive) setRetentionDays(null) })
    return () => { alive = false }
  }, [])
  const [pwdOpen, setPwdOpen] = useState(false)
  const [offing, setOffing] = useState<string>('')
  const [offboardMsg, setOffboardMsg] = useState<string>('')
  /** 正在改角色的成员 id（防连点） */
  const [busyRole, setBusyRole] = useState<string>('')
  const [prefs, setPrefs] = usePrefs()
  const [pwdOld, setPwdOld] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdBusy, setPwdBusy] = useState(false)
  const [pwdErr, setPwdErr] = useState('')

  const onChangePassword = async () => {
    setPwdErr('')
    if (!pwdOld || !pwdNew) { setPwdErr('请填写当前密码与新密码'); return }
    if (pwdOld === pwdNew) { setPwdErr('新密码不能与当前密码相同'); return }
    setPwdBusy(true)
    try {
      const r = await changePassword(pwdOld, pwdNew)
      setPwdOpen(false)
      setPwdOld('')
      setPwdNew('')
      // 立刻把「上次修改于」刷成刚才 —— 不刷的话用户改完密码，
      // 界面上还写着旧时间，看起来像是没生效
      setPwdChangedAt(Date.now())
      toast(
        r.otherSessionsClosed > 0
          ? `密码已修改，并已退出其他 ${r.otherSessionsClosed} 个设备`
          : '密码已修改',
        'success',
      )
    } catch (e: any) {
      setPwdErr(e?.message || '修改失败')
    } finally {
      setPwdBusy(false)
    }
  }

  /** 平台管理员才能办理离职（服务端也会再判一次，界面只是不给不该给的按钮） */
  const isAdmin = currentUser.role === 'owner' || currentUser.role === 'admin'

  const onOffboard = async (userId: string, name: string) => {
    if (!window.confirm(`确认给「${name}」办理离职？\n\n` +
      `会立刻清掉他的登录会话、移出全部空间，并按各知识库的开关收回权限。\n` +
      `这一步不会删除他写过的文档，但之后他再也进不来了。`)) return
    setOffing(userId)
    try {
      const r = await offboardUser(userId)
      // 服务端动了会话与成员表，本地这份快照已经过期 —— 重新拉一次
      await hydrate(currentUser)
      setOffboardMsg(
        `已为「${r.name}」办理离职：清掉 ${r.sessions} 个登录会话、移出 ${r.spaces} 个空间、` +
        `收回 ${r.revokedBooks} 个知识库的权限` +
        (r.keptBooks ? `；另有 ${r.keptBooks} 个知识库关了「离职权限自动回收」，仍保留他的身份，请按需手动移除` : '') +
        /*
         * 降权这件事必须**说出来**。
         * 服务端以前只做四件事（会话/令牌/空间/库权限），不碰 `role` ——
         * 于是离职的管理员重新登录回来**仍然是管理员**，还能改成员、办别人的离职。
         * 现在服务端会顺手把 role 降到 member，但界面上只弹「办理成功」的话，
         * 管理员根本不知道系统替他把权限改了；出事之后也说不清是什么时候降的
         * （所以服务端把 roleBefore 一起记进了审计）。
         *
         * 顺带把「账号没被停用」也照实说 —— 否则管理员会以为
         * 「离职 = 这个人再也登不上了」，而实际上他**还能登录**
         * （只是不再是管理员、也不再是任何空间的成员）。
         * 真正停用需要 `users.disabled`，那是新功能，见 README 已知边界。
         */
        (r.roleBefore && r.roleBefore !== 'member' ? `；并把平台角色从「${ROLE_CN[r.roleBefore] || r.roleBefore}」降为「普通成员」` : '') +
        (r.accountDisabled === false ? '。注意：账号本身**没有**被停用，他仍能登录（但已无任何权限）' : ''),
      )
      toast('离职已办理', 'success')
    } catch (e: any) {
      toast(e?.message || '办理失败', 'error')
    } finally {
      setOffing('')
    }
  }

  const [importInfo, setImportInfo] = useState<string>('')
  /** 导入对话框：设置页这一处入口，和目录树渲染的是同一个组件 */
  const [impOpen, setImpOpen] = useState(false)

  return (
    <div className="yq-dash yq-dash-narrow">
      <header className="yq-dash-header">
        <div>
          <h1 className="yq-dash-greeting">账户设置</h1>
          <p className="yq-dash-date">管理你的个人资料、偏好与数据</p>
        </div>
      </header>

      <div className="yq-settings">
        <nav className="yq-settings-nav">
          {[
            { v: 'profile', l: '个人资料' },
            { v: 'pref', l: '偏好设置' },
            { v: 'notify', l: '消息通知' },
            { v: 'security', l: '安全' },
            { v: 'data', l: '数据管理' },
            // 访问令牌是**个人级**的（谁建谁能用，别人也管不着），
            // 所以和下面两个管理员专属的日志项不一样，人人可见。
            { v: 'tokens', l: '访问令牌' },
            // 操作日志和访问日志都只有管理员能看得到。导航项也跟着隐藏 ——
            // 给普通成员摆一个点进去就 403 的入口，没有任何意义。
            ...(isAdmin ? [
              { v: 'audit', l: '操作日志' },
              { v: 'access', l: '访问日志' },
            ] : []),
          ].map((t) => (
            <button
              key={t.v}
              className={`yq-settings-nav-item ${tab === t.v ? 'is-active' : ''}`}
              onClick={() => setTab(t.v)}
            >
              {t.l}
            </button>
          ))}
        </nav>

        <div className="yq-settings-body">
          {tab === 'profile' && (
            <section className="yq-card yq-settings-card">
              <div className="yq-settings-title">个人资料</div>
              <div className="yq-settings-avatar-row">
                <Avatar name={currentUser.name} size={64} src={avatarImg} />
                <div>
                  {/*
                    2026-10-11：这个按钮从「禁用 + 标注尚未实现」变成真能用。

                    ⚠️ 两件事让它能真的工作：
                    ① 服务端把图片存成 attachments 里一条 docId 为空的记录，
                       `users.avatar` 存它的 **id** 而不是图片本身
                       （一张 200KB 的图进 users 表 → 进同步实体 → 每台设备
                       每次 bootstrap 都带着它转一圈）；
                    ② 取图要**带鉴权**（头像属于个人资料，别人拿 id 也不能下），
                       所以不能直接 <img src=".../api/users/me/avatar/xxx"> ——
                       那样浏览器不会带 Authorization 头，会拿到 403，
                       界面表现为「头像一直是空的」而看不出是鉴权问题。
                  */}
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    style={{ display: 'none' }}
                    onChange={onPickAvatar}
                  />
                  <Button
                    variant="default"
                    size="sm"
                    disabled={uploadingAvatar || getMode() !== 'server'}
                    title={getMode() !== 'server' ? '本地模式下改不了（数据只在你的浏览器里）' : ''}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {uploadingAvatar ? '上传中…' : '更换头像'}
                  </Button>
                  {avatarId && (
                    <Button
                      variant="text"
                      size="sm"
                      disabled={uploadingAvatar}
                      onClick={async () => {
                        try { await updateMyProfile({ avatar: '' })
                          setAvatarId(''); setAvatarImg('')
                          toast('已恢复首字母头像', 'success')
                        } catch (e: any) {
                          toast(e?.message || '清除失败', 'error')
                        }
                      }}
                    >
                      移除
                    </Button>
                  )}
                  <div className="yq-settings-hint">
                    {getMode() !== 'server'
                      ? '本地模式下改不了（头像存在服务端，而本地模式没有服务端）。'
                      : '支持 PNG / JPEG / GIF / WebP，不超过 2MB。头像只对本人可见。'}
                  </div>
                </div>
              </div>
              <Field label="昵称">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="账号">
                {/*
                  **不能在这里改**，而且不能留一个能改的框。
                  理由不是「还没做」：
                    · 它是登录名，全局唯一，改名要处理「已被占用」这种用户没法自己解决的冲突；
                    · 审计日志、访问日志、离职记录里到处都是它，中途改掉历史记录就对不上；
                    · 统一认证下账号由网关决定，这里改了下次登录就被覆盖 ——
                      于是「我改了名字，怎么刷新又变回去了」。
                  服务端的 PATCH /api/users/me 也不接受 account 字段，
                  所以这里如实写清楚，而不是留一个改了不生效的输入框。
                */}
                <Input value={currentUser.account} readOnly prefix={<span style={{ color: 'var(--yq-text-4)' }}>{location.host}/</span>} />
                <div className="yq-settings-hint">
                  账号是登录名，不能在这里改 —— 它在审计日志、访问日志里被引用，
                  中途改名会让历史记录对不上；接了统一认证时它由网关决定。
                  要改请联系管理员办理。
                </div>
              </Field>
              <Field label="邮箱">
                <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="选填，不参与登录" />
                <div className="yq-settings-hint">这套系统不靠邮箱做任何事（不发通知、不是登录名），填它只是为了别人找得到你。</div>
              </Field>
              <Field label="个人简介">
                <textarea className="yq-settings-textarea" value={bio} onChange={(e) => setBio(e.target.value)} placeholder="一两句话说清你是做什么的" />
              </Field>
              <div className="yq-settings-actions">
                <Button variant="primary" onClick={() => updateMyProfile({ name, email, bio })}>保存修改</Button>
              </div>
            </section>
          )}

          {tab === 'pref' && (
            <section className="yq-card yq-settings-card">
              <div className="yq-settings-title">偏好设置</div>
              <Row label="编辑器字号" desc="影响文档编辑区域的显示大小（只影响这台设备）">
                <Segmented
                  size="sm"
                  value={prefs.editorFontSize}
                  onChange={(v) => setPrefs({ editorFontSize: v as Prefs['editorFontSize'] })}
                  options={[
                    { value: 'sm', label: '小' }, { value: 'md', label: '标准' }, { value: 'lg', label: '大' },
                  ]}
                />
              </Row>
              <Row label="启动时打开大纲" desc="文档页右侧大纲默认展开">
                <Switch checked={prefs.outlineOnOpen} onChange={(v) => setPrefs({ outlineOnOpen: v })} size="sm" />
              </Row>

              {/*
                原来这里还有两行假控件，都已经去掉：
                  · 「默认目录样式：树形 / 列表」—— 目录**只有树形**一种形态，
                    选「列表」根本不存在。给一个不存在的选项，比不给更糟。
                  · 「水印」开关 —— 水印是**每个知识库各自设置**的，
                    放在这里会造成「我关了，为什么这个库还有水印」的困惑。

                「自动保存」原来是个 checked={true} onChange={() => {}} 的开关：
                自动保存**是真的**（停止输入 400ms 就落盘），只是**不能关** ——
                能关的话，稍不注意就丢稿子。写成一个静态事实，不给假开关。
              */}
              <div className="yq-settings-desc" style={{ marginTop: 10 }}>
                <b>自动保存</b>已启用：停止输入约 0.4 秒后自动落盘。这是硬性的，
                刻意不提供开关 —— 能关掉的自动保存等于没有自动保存。
              </div>
              <div className="yq-settings-desc" style={{ marginTop: 6 }}>
                目录目前只有<b>树形</b>一种形态（可折叠展开），没有列表视图。
                <b>水印</b>是每个知识库各自设置的，请到「知识库设置 → 安全」里配置。
              </div>
            </section>
          )}

          {tab === 'notify' && (
            <section className="yq-card yq-settings-card">
              <div className="yq-settings-title">消息通知</div>
              {/*
                这里是「承诺了但没兑现」的一个典型，之前两次都只修了一半。

                第一次：五个写死的开关，点一下弹「通知偏好已更新」—— 听着像存了，
                  其实什么都没存。改成本地偏好后，刷新确实还在。
                第二次（就是现在这次）：改成了本地偏好，但**提示语只说了
                  「只影响你这台设备」**。用户读到的是「通知只发到这台设备」，
                  于是仍然以为**通知是存在的**。

                可事实上 prefs.notify 全项目**只有这个页面自己读**
                （用来渲染开关的开关状态），再没有第二处读它。
                本项目没有通知服务：没有 @ 提醒、没有评论通知、没有每周精选邮件。
                把开关关掉，不会让任何通知消失 —— 因为根本没有通知会来。

                所以话说在**开关前面**：这不是「通知的开关」，是「你希望收到什么」的记录。
              */}
              <p className="yq-settings-hint" style={{ marginTop: 4, marginBottom: 10 }}>
                ⚠️ 本项目<b>没有通知服务</b>：@ 提醒、评论通知、每周精选<b>都不会真的发给你</b>。
                下面这些开关只把你的偏好存在<b>这台设备的浏览器</b>里 ——
                不同步到别的设备，也<b>不在「数据管理 → 导出数据包」里</b>。
                关掉任何一项，都不会让某条通知消失，因为根本没有通知会来。
              </p>
              {NOTIFY_KEYS.map((r) => (
                <Row key={r.key} label={r.label} desc={r.desc}>
                  <Switch
                    checked={!!prefs.notify?.[r.key]}
                    onChange={(v) => setPrefs({ notify: { [r.key]: v } as Record<NotifyKey, boolean> })}
                    size="sm"
                  />
                </Row>
              ))}
              <p className="yq-settings-hint" style={{ marginTop: 6 }}>
                这些开关留在这里，是为了将来接上通知服务时不用重新收集偏好 ——
                在那之前，它们只是记录。
              </p>
            </section>
          )}

          {tab === 'security' && (
            <section className="yq-card yq-settings-card">
              <div className="yq-settings-title">安全</div>
              <Row label="登录密码" desc={pwdDesc}>
                <Button variant="default" size="sm" onClick={() => setPwdOpen(true)}>修改密码</Button>
              </Row>

              {/* 登录设备（语雀的「帐户安全 → 登录设备」）。改密码是「全清」，
                  这里给的是「只踢掉某一台」—— 电脑丢了又不想把同事一起踢出去时用。 */}
              <div className="yq-settings-title" style={{ marginTop: 20, fontSize: 14 }}>登录过的设备</div>
              <div className="yq-settings-desc" style={{ marginBottom: 6 }}>
                下面是你目前所有还有效的登录会话。发现不认识的设备就可以直接下线。
              </div>
              <DevicePanel />

              {/* 安全记录（语雀的「帐户安全 → 安全记录」）。
                  和管理员那份「操作日志」**不是同一个接口** —— 那边能看到
                  「谁给谁开了权限」「谁导出了整个工作台」，普通成员拿到等于拿到权限地图；
                  这边只给「我自己做过的安全动作」，而且**不接受任何筛选参数**。 */}
              <div className="yq-settings-title" style={{ marginTop: 20, fontSize: 14 }}>我的安全记录</div>
              <div className="yq-settings-desc" style={{ marginBottom: 6 }}>
                你自己改密码、创建 / 撤销访问令牌的时间线。**不认识的记录就该改密码。**
              </div>
              <MySecurityLogPanel />

              {/*
                这里原来有三行「全局」的 IP 白名单 / 导出限制 / 离职权限回收。
                三个都不成立：
                  · IP 白名单 是个点了只弹「（演示）」的按钮
                  · 导出限制 是个 checked={false} onChange={() => {}} 的开关
                  · 离职回收 是个 **checked={true}** onChange={() => {}} 的开关
                最后那个最要命：它在界面上**显示成「已开启」**，点下去什么都不发生 ——
                管理员会读成「离职回收已开着」，而其实一行代码都没跑。

                这三项能力现在都在**知识库级**有真实实现，
                留一个「全局版」的假开关只会让人配错地方、或者以为已经配过了。
                所以这里不再重复一遍，直接指路。
              */}
              <div className="yq-settings-desc" style={{ marginTop: 12 }}>
                <b>IP 白名单、导出限制、离职权限回收</b>这三项是
                <b>每个知识库各自设置</b>的，请到
                <b>知识库设置 → 安全</b> 里配置，那里是真正生效的开关。
              </div>
              <div className="yq-settings-desc" style={{ marginTop: 6 }}>
                成员离职请到下面的<b>「成员管理」</b>办理「离职」：会清掉他的登录会话、
                移出全部空间，并按各知识库自己的开关收回权限。
              </div>
            </section>
          )}

          {tab === 'data' && (
            <>
              <section className="yq-card yq-settings-card">
                <div className="yq-settings-title">数据管理</div>
                <Row
                  label="回收站"
                  desc={
                    /* ⚠️ 这里原来**写死 30 天**。
                     * 而保留期是 `YQ_TRASH_DAYS` 可配的 —— 运维改成 60 天之后，
                     * 这一行还在对用户说 30 天，而回收站页早就从服务端读真值了。
                     * 同一件事两处说法不一致，**关于数据什么时候被删**的说法尤其不能有两个版本。
                     * 问不到就宁可不说数字（`Trash.tsx` 那边是同一个处理）。
                     */
                    retentionDays === null
                      ? '删除的文档按本实例的保留期自动清除（保留期正在确认…）'
                      : retentionDays > 0
                        ? `删除的文档保留 ${retentionDays} 天，到期自动清除`
                        : '本实例未开启自动清除（YQ_TRASH_DAYS=0）'
                  }
                >
                  {/*
                    原来这个按钮点了只弹一句「回收站中有 N 个文档」——
                    **不跳转**。而 `/trash` 页面就在那儿。于是它是个
                    「长得能点、点了告诉你有多少、但不带你去」的按钮：
                    正好是这页反复在修的那一类。

                    ⚠️ 这条注释原来还写着「**侧栏也有入口**」—— **不成立**。
                    2026-10-16 对照真实语雀时核过：`SideNav` 的 SECTIONS 里
                    根本没有 `/trash`，回收站入口在**顶栏头像菜单**
                    （`TopBar.tsx` 的「回收站 (N)」）。
                    语雀把回收站放在侧栏「更多」里，我们是顶栏 —— 位置不同，
                    但「侧栏也有」这句会让下一个人以为少了一个入口而去补一个，
                    或者以为侧栏坏了。
                  */}
                  <Button variant="default" size="sm" onClick={() => navigate('/trash')}>
                    查看回收站（{trash.length}）
                  </Button>
                </Row>
                <Row
                  label="导出整个工作台"
                  desc={
                    getMode() === 'server'
                      ? '从服务端打包**带正文**的内容（按你的权限过滤）：文档、知识库、目录、评论与回复、'
                        + '讨论区话题**与回复**、小记、模板、收藏、关注、回收站、设置与成员权限。'
                        + '不含三样：**附件文件**（卡片的二进制不在这包里，导入后那些卡片会显示「二进制已丢失」——'
                        + '要连附件一起备份请用 DEPLOY 里那个**文件级备份整个数据目录**的脚本）、'
                        + '**账号**（含密码散列，导出是内容备份，建账号要单独确认）和'
                        + '**最近浏览**（设备本地的临时状态）。换机器、迁移、留档都用它，但**灾备不靠它**'
                      : '打包全部文档、知识库、目录、文稿数据与卡片为单个 JSON，换设备时导入即可接着写'
                  }
                >
                  <Button variant="primary" size="sm" onClick={async () => {
                    if (getMode() !== 'server') {
                      downloadBundle()
                      toast('工作台已导出', 'success')
                      return
                    }
                    try {
                      // 先自查：宁可导一半也不要交一个空壳还提示「已导出」
                      const v = await verifyExport()
                      if (v.docs > 0 && v.withBody === 0) {
                        toast('导出内容不完整（没有正文），已中止', 'error')
                        return
                      }
                      const text = await serverExport()
                      const blob = new Blob([text], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `yuque-workspace-${new Date().toISOString().slice(0, 10)}.json`
                      document.body.appendChild(a)
                      a.click()
                      a.remove()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                      toast(`已导出 ${v.docs} 篇（${v.withBody} 篇带正文）`, 'success')
                    } catch (e: any) {
                      toast(e?.message || '导出失败', 'error')
                    }
                  }}>
                    导出数据包
                  </Button>
                </Row>
                <Row
                  label="导入"
                  desc="支持 Markdown、zip、Word、Excel/CSV、语雀知识库与本系统的数据包 —— 点右边选格式。不支持的格式在下面的说明里写着，别去猜。"
                >
                  <Button variant="default" size="sm" icon="↓" onClick={() => setImpOpen(true)}>
                    导入…
                  </Button>
                </Row>
                <Row
                  label="暂不支持的导入格式"
                  /* 把「做不到」写在界面上，而不是让用户选完文件才失败 ——
                     语雀支持而我们不支持的，这三条一次说清。 */
                  desc="语雀还支持 Word 老格式 .doc、Excel 老格式 .xls、Evernote 导出包（.html + zip）—— 这三个我们不支持：前两个是二进制私有格式，要解析就得引第三方依赖，而内网部署构建时未必能联网装；Evernote 的内嵌附件与资源结构我们没有对应的数据模型，硬转只会得到标签残渣。选到这些文件会被直接拒绝并说明原因，不会导入出半份内容。"
                />
                {importInfo && (
                  <div className="yq-settings-hint" style={{ marginTop: -6 }}>{importInfo}</div>
                )}
                {/* ⚠️ 服务端形态下**不显示**「重置演示数据」。
                    理由和「演示身份切换」是同一条，但这里的后果严重得多：

                    `reset()` 执行的是 `set({ ...createSeedData() })` ——
                    把 26 篇演示文档 + 4 个知识库 + 6 个成员灌进**本地** store。
                    而服务端形态下，同步差分会把这一整批当成「我的改动」推上去。
                    结果就是：**真实知识库里凭空多出 26 篇演示内容**，
                    而且它们写得很真（源子科技产品手册、技术文档大本营…），
                    头几天很容易有人当成真实内容引用它。

                    docker-compose.yml 里也写着同一条警告
                    （「演示数据是 seed.ts 直插，不在任何清理范围内」）。
                    这里不是加免责声明能解决的 —— 点下去就出事，直接不显示。 */}
                {getMode() !== 'server' && (
                  <Row label="重置演示数据" desc="恢复初始内容，你所有的修改会丢失">
                    <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>重置</Button>
                  </Row>
                )}
              </section>

              {isAdmin && (
                <section className="yq-card yq-settings-card">
                  <div className="yq-settings-title">成员管理</div>
                  <p className="yq-settings-desc">
                    办理离职会做三件事：清掉该同事的所有登录会话（他下次请求就掉线）、
                    移出全部空间、以及按<b>每个知识库自己的「离职权限自动回收」开关</b>收回权限。
                    关了开关的库会保留他的成员身份 —— 交接期或只做单个库的外包常用这个。
                  </p>
                  {members.filter((m) => m.id !== currentUser.id).map((m) => (
                    <div key={m.id} className="yq-list-row" style={{ cursor: 'default' }}>
                      <Avatar name={m.name} size={30} />
                      <div className="yq-flex-1">
                        <div className="yq-list-row-title">{m.name}</div>
                        <div className="yq-list-row-meta">@{m.account} · {ROLE_CN[m.role] || m.role}</div>
                      </div>
                      {/*
                        角色下拉。以前这里只有一行「· {m.role}」的文字 ——
                        角色**只能看、不能改**，于是整个实例只有 seed 出来的
                        那一个 owner 能办离职 / 看审计 / 清回收站。
                        （`members` 实体的 writable 里也没有 role，
                          所以 push 提权会被静默丢掉 —— 和当初 slug/summary 同一类。）
                        改动走服务端那个窄接口，理由写在那边。
                      */}
                      <select
                        className="yq-input"
                        style={{ width: 130 }}
                        value={m.role === 'owner' ? 'owner' : m.role === 'admin' ? 'admin' : 'member'}
                        disabled={m.role === 'owner' || busyRole === m.id}
                        title={m.role === 'owner' ? '平台超级管理员不能改角色' : ''}
                        onChange={async (e) => {
                          const el = e.currentTarget
                          const next = el.value === 'admin' ? 'admin' : 'member'
                          if (next === m.role) return
                          const yes = confirm(
                            `把「${m.name}」设为${ROLE_CN[next]}？` +
                            (next === 'admin'
                              ? '他将能看到操作日志与访问日志，并能办理离职。'
                              : '他将失去这些权限。'),
                          )
                          if (!yes) { el.value = m.role; return }
                          setBusyRole(m.id)
                          try {
                            await setUserRole(m.id, next)
                            useStore.setState((st) => ({
                              members: st.members.map((x) => (x.id === m.id ? { ...x, role: next } : x)),
                            }))
                            toast(`${m.name} 现在是${ROLE_CN[next]}`, 'success')
                          } catch (err: any) {
                            toast(err?.message || '改角色失败', 'error')
                            el.value = m.role
                          } finally {
                            setBusyRole('')
                          }
                        }}
                      >
                        <option value="member">普通成员</option>
                        <option value="admin">管理员</option>
                        {m.role === 'owner' && <option value="owner">超级管理员</option>}
                      </select>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={m.role === 'owner' || offing === m.id}
                        title={m.role === 'owner' ? '平台超级管理员不能办理离职' : ''}
                        onClick={() => onOffboard(m.id, m.name)}
                      >
                        {offing === m.id ? '处理中…' : '办理离职'}
                      </Button>
                    </div>
                  ))}
                  {offboardMsg && <div className="yq-settings-hint">{offboardMsg}</div>}
                </section>
              )}

              {/*
               * ⚠️ 整个「演示身份切换」区块只在**本地模式**渲染。
               *
               * 服务器模式下这个控件是**半真**的：界面名字会变、刷新就恢复，
               * 而权限判定完全按登录账号（token）走 —— 所以它展示不出任何
               * 「不同角色看到的差异」，只会让人以为权限乱了。
               *
               * 讲清楚的半真功能仍会诱导人去点它（用户会拿它当排查权限的手段），
               * 所以部署态**直接不显示**，而不是显示一句免责声明。
               */}
              {getMode() !== 'server' && (
              <section className="yq-card yq-settings-card">
                <div className="yq-settings-title">演示身份切换</div>
                <p className="yq-settings-desc">
                  用于体验不同角色<strong>看到的界面差异</strong>。
                  本地模式下权限就是按当前身份算的，切换是真的会切出差异的；
                  部署到服务器后这一节不再显示（那时权限一律按登录账号判定）。
                </p>
                {members.map((m) => (
                  <div key={m.id} className="yq-list-row" style={{ cursor: 'default' }}>
                    <Avatar name={m.name} size={30} />
                    <div className="yq-flex-1">
                      <div className="yq-list-row-title">{m.name}</div>
                      <div className="yq-list-row-meta">@{m.account} · {m.role}</div>
                    </div>
                    {m.id === currentUser.id ? (
                      <Tag color="primary" size="sm">当前</Tag>
                    ) : (
                      <Button variant="default" size="sm" onClick={() => switchUser(m.id)}>切换</Button>
                    )}
                  </div>
                ))}
              </section>
              )}
            </>
          )}

          {/*
            操作日志。

            在这个分区之前，「谁在什么时候把权限给了谁」**无处可查** ——
            changes 表只服务增量同步，而且不记意图：
            「把人加进知识库」和「改了知识库描述」在它眼里是同一种事。
            公司内部部署时，权限授予、导出、离职回收这三类必须有第二份记录。
          */}
          {tab === 'audit' && <AuditLogPanel />}
      {tab === 'access' && <AccessLogPanel />}
      {tab === 'tokens' && <TokenPanel />}
        </div>
      </div>

      {/* 触发点已经被门控掉了，这个弹窗在服务端形态下永远不会有入口打开它 ——
          仍然保留一份，避免哪天有人去掉门控就漏出一个能点的按钮。 */}
      {getMode() !== 'server' && (
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="重置演示数据"
        width={420}
        footer={
          <>
            <Button variant="text" onClick={() => setResetOpen(false)}>取消</Button>
            <Button variant="danger" onClick={() => { reset(); setResetOpen(false) }}>确认重置</Button>
          </>
        }
      >
        <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--yq-text-2)' }}>
          这会清空你在本地做的所有修改（新建的文档、编辑的内容、评论、收藏），恢复到初始演示数据。此操作不可撤销。
        </p>
      </Modal>
      )}

      <Modal
        open={pwdOpen}
        onClose={() => { setPwdOpen(false); setPwdOld(''); setPwdNew(''); setPwdErr('') }}
        title="修改密码"
        width={420}
        footer={
          <>
            <Button variant="text" onClick={() => { setPwdOpen(false); setPwdOld(''); setPwdNew('') }}>取消</Button>
            <Button variant="primary" disabled={pwdBusy} onClick={onChangePassword}>
              {pwdBusy ? '提交中…' : '确认修改'}
            </Button>
          </>
        }
      >
        <Field label="当前密码">
          <Input type="password" value={pwdOld} onChange={(e: any) => setPwdOld(e.target.value)} placeholder="输入当前密码" autoComplete="current-password" />
        </Field>
        <Field label="新密码">
          <Input type="password" value={pwdNew} onChange={(e: any) => setPwdNew(e.target.value)} placeholder="至少 8 位，含字母与数字" autoComplete="new-password" />
        </Field>
        {pwdErr && <div className="yq-login-err" style={{ marginTop: 4 }}>{pwdErr}</div>}
        <p className="yq-settings-hint">
          改完之后，你在<b>其他设备上</b>的登录会全部失效（这台不会）。
          这是故意的：改密码的意义就是把可能已经泄露出去的访问挡在门外。
        </p>
      </Modal>

      <ImportDialog open={impOpen} onClose={() => setImpOpen(false)} onResult={setImportInfo} />
    </div>
  )
}

/* ============================================================
   操作日志
   ------------------------------------------------------------
   **覆盖范围要说明白**，不然会给人「全都有记录」的错觉：
   记的是服务端能权威看到的那几类 —— 空间成员增删、导出、离职回收、改密码。
   客户端本地模式（无服务端）**不经过这里，也就没有日志**。
   走 /api/sync/push 的日常改动（改标题、拖目录、评论）**不逐条记** ——
   那会让这张表变成第二份 changes，反而没人看。

   查不到记录时会直说「还没有记录」，不拿占位数据糊上去。
   ============================================================ */
function AuditLogPanel() {
  const [items, setItems] = useState<AuditItem[] | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [action, setAction] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setItems(null)
    setErr('')
    auditLog({ limit: 200, action: action || undefined })
      .then((r) => {
        if (!alive) return
        setItems(r.items || [])
        if (!actions.length) setActions(r.actions || [])
      })
      .catch((e) => { if (alive) setErr(e?.message || '日志加载失败') })
    return () => { alive = false }
    // action 变了要重新拉；actions 只在第一次拿到后用来填下拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  return (
    <section className="yq-card yq-settings-card">
      <div className="yq-settings-title">操作日志</div>
      <p className="yq-settings-desc">
        记录权限授予与收回、数据导出、离职回收、密码修改这些**能追溯后果**的动作。
        日常内容改动不在此列 —— 那是同步日志的职责。
      </p>

      <div className="yq-audit-bar">
        <span style={{ fontSize: 12, color: 'var(--yq-text-3)' }}>动作</span>
        <Select
          size="sm"
          value={action}
          onChange={(v) => setAction(String(v))}
          options={[{ value: '', label: '全部' }, ...actions.map((a) => ({ value: a, label: AUDIT_LABEL[a] || a }))]}
        />
        <span className="yq-flex-1" />
        <Button variant="text" size="sm" onClick={() => setAction((v) => v)}>刷新</Button>
      </div>

      {err ? (
        <div className="yq-settings-hint">加载失败：{err}</div>
      ) : !items ? (
        <div className="yq-settings-hint">正在加载…</div>
      ) : items.length === 0 ? (
        <Empty icon="🗒" text="还没有记录。授予权限、导出数据、办理离职之后会出现在这里" />
      ) : (
        <div className="yq-audit-list">
          {items.map((it) => (
            <div key={it.id} className="yq-audit-row">
              <span className="yq-audit-when">{timeAgo(it.at)}</span>
              <span className="yq-audit-action">{AUDIT_LABEL[it.action] || it.action}</span>
              <span className="yq-audit-who">{it.actorName || it.actorId || '系统'}</span>
              <span className="yq-audit-target">
                {it.targetName || it.targetId}
                {it.detail?.account ? `（${it.detail.account}）` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

  /**
   * 访问日志：谁在什么时候看过哪些文档。
   *
   * 和「操作日志」是**两回事**，界面上也说清楚：
   * 操作日志答「谁改了什么」，访问日志答「谁翻过什么」。
   * 涉密文档的访问复核要的是后者 —— 等保 / ISO 27001 检查里常被点名。
   *
   * 粒度是**天**：同一人同一天看同一篇只记一次（这是浏览量不被刷新页面灌水的前提），
   * 所以时间点是当天首次阅读的时刻。面板上照实写出来，
   * 不让人对着一个「14:23」以为那是精确的打开时刻。
   */
  function AccessLogPanel() {
    const [items, setItems] = useState<AccessItem[] | null>(null)
    const [err, setErr] = useState('')
    const [q, setQ] = useState('')
    const [days, setDays] = useState('30')

    useEffect(() => {
      let alive = true
      setItems(null)
      setErr('')
      accessLog({ limit: 300, days: Number(days) || 30 })
        .then((r) => { if (alive) setItems(r.items || []) })
        .catch((e) => { if (alive) setErr(e?.message || '日志加载失败') })
      return () => { alive = false }
    }, [days])

    const kw = q.trim().toLowerCase()
    const shown = (items || []).filter((it) =>
      !kw
      || it.docTitle.toLowerCase().includes(kw)
      || it.userName.toLowerCase().includes(kw)
      || it.userAccount.toLowerCase().includes(kw)
      || it.bookName.toLowerCase().includes(kw),
    )

    return (
      <section className="yq-card yq-settings-card">
        <div className="yq-settings-title">访问日志</div>
        <p className="yq-settings-desc">
          谁在什么时候看过哪些文档 —— 和「操作日志」是两回事：那边答「谁改了什么」，
          这边答「谁翻过什么」。涉密文档的访问复核要的是这一份。
          <br />
          <b>按天记录</b>：同一人同一天看同一篇只记一次（否则刷新页面就能把访问量灌水），
          时间是当天首次阅读的时刻。
        </p>

        <div className="yq-audit-bar">
          <Select
            size="sm"
            value={days}
            onChange={(v) => setDays(String(v))}
            options={[
              { value: '7', label: '近 7 天' },
              { value: '30', label: '近 30 天' },
              { value: '90', label: '近 90 天' },
            ]}
          />
          <input
            className="yq-input"
            style={{ maxWidth: 220 }}
            placeholder="搜文档 / 人 / 知识库"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="yq-flex-1" />
          <span style={{ fontSize: 12, color: 'var(--yq-text-3)' }}>{shown.length} 条</span>
        </div>

        {err ? (
          <div className="yq-settings-hint">加载失败：{err}</div>
        ) : !items ? (
          <div className="yq-settings-hint">正在加载…</div>
        ) : items.length === 0 ? (
          <Empty icon="👀" text="这段时间还没有阅读记录。别人打开文档之后会出现在这里" />
        ) : shown.length === 0 ? (
          <Empty icon="🔍" text={`没有匹配「${q}」的记录（当前共 ${items.length} 条）`} />
        ) : (
          <div className="yq-audit-list">
            {shown.map((it, i) => (
              <div key={`${it.docId}-${it.userId}-${it.day}-${i}`} className="yq-audit-row">
                <span className="yq-audit-when">{it.day}</span>
                <span className="yq-audit-who">
                  {it.userName || it.userId}
                  {it.userAccount ? `（${it.userAccount}）` : ''}
                </span>
                <span className="yq-audit-target">
                  {it.docTitle}
                  {it.bookName ? <span style={{ color: 'var(--yq-text-4)' }}> · {it.bookName}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    )
  }

  /**
   * 访问令牌：给 CI 和外部程序用的凭据。
   *
   * 三件必须在这页上说清楚的事，缺一件都会让人做出错误决定：
   *
   * ① **明文只显示一次。** 服务端只存 sha256，之后谁也拿不回来。
   *    所以创建成功弹一次「复制并保存」，而不是给个「查看」按钮 ——
   *    没有那个按钮的话，用户事后发现找不回来，第一反应是「功能坏了」。
   * ② **令牌只对 /api/v2 生效。** 网页、整包导出、审计日志、同步接口都不认它。
   *    不写清楚的话，很多人会以为「有了令牌就能代替登录」。
   * ③ **令牌不绕过权限矩阵。** 令牌能读哪些库，最终还是按这个人
   *    在知识库里的权限算。给一个 reader 发 write 令牌，他也写不了别人没给他的库。
   *
   * 个人级：别人既看不到你的令牌，也撤不掉（服务端按 userId 过滤）。
   */
  /**
   * 登录过的设备（语雀的「帐户安全 → 登录设备」）。
   *
   * 之前清会话只有三条路：登出（只清当前）、改密码（清其他全部）、办离职（清该用户全部）。
   * 于是「这台电脑丢了，但不想改密码把同事的设备一起踢掉」没有出口。
   *
   * ⚠️ 列表里的 `ref` 是**不透明标识**（服务端 `sha256(token)` 的前 16 位），
   * **不是令牌** —— `sessions` 的主键就是 token 本身，发出去了等于把别的设备的
   * 凭据交出去。所以前端只**原样传回**，不解析、不拼接。
   *
   * 「当前这台」不能在这里下线（语雀也不让，列表里那台是绿点）——
   * 想下线当前设备就用「退出登录」，按钮直接不给，免得点了就掉线。
   */
  function DevicePanel() {
    const { toast } = useStore()
    const [rows, setRows] = useState<SessionRow[] | null>(null)
    const [err, setErr] = useState('')
    const [busy, setBusy] = useState('')

    const load = () => {
      setRows(null)
      setErr('')
      listSessions()
        .then((r) => setRows(r))
        .catch((e) => setErr(e?.message || '设备列表加载失败'))
    }
    useEffect(load, [])

    const drop = async (ref: string) => {
      setBusy(ref)
      try {
        await revokeSession(ref)
        toast('已下线该设备', 'success')
        load()
      } catch (e: any) {
        toast(e?.message || '下线失败', 'error')
      } finally {
        setBusy('')
      }
    }

    if (err) return <div className="yq-settings-hint">设备列表加载失败：{err}</div>
    if (!rows) return <div className="yq-settings-hint">正在读设备列表…</div>
    if (!rows.length) return <div className="yq-settings-hint">没有别的设备登录过（当前这台不算）。</div>

    return (
      <div>
        {rows.map((r) => (
          <div key={r.ref} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid var(--yq-border)' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>
                {r.ua ? r.ua.slice(0, 60) : '（没带 User-Agent）'}
                {r.current && <b style={{ color: 'var(--yq-primary)', marginLeft: 6 }}>· 当前设备</b>}
                {r.expired && <span style={{ color: 'var(--yq-text-3)', marginLeft: 6 }}>· 已过期</span>}
              </div>
              <div className="yq-settings-hint" style={{ marginTop: 2 }}>
                {r.ip || '未知 IP'} · 登录于 {timeAgo(r.createdAt)}
                {r.expiresAt ? ` · ${new Date(r.expiresAt).toLocaleString('zh-CN')} 过期` : ''}
              </div>
            </span>
            {r.current
              ? <span className="yq-settings-hint">要下线这台请用「退出登录」</span>
              : <Button variant="default" size="sm" disabled={busy === r.ref} onClick={() => drop(r.ref)}>
                  {busy === r.ref ? '处理中…' : '下线这台'}
                </Button>}
          </div>
        ))}
        <p className="yq-settings-hint" style={{ marginTop: 8 }}>
          下线之后那台设备会被立刻踢出登录（它的下一次请求就 401 了）。
          只想收掉**全部**其他设备的话，用上面的「修改密码」——它会一起清掉。
        </p>
      </div>
    )
  }

  /**
   * 我的安全记录（语雀的「帐户安全 → 安全记录」）。
   *
   * 和管理员那份「操作日志」的区别只有一处，但那一处是全部：
   * **这里只给「我自己做过的安全动作」**，而且**不接受任何筛选参数**。
   * 少了第二条，一个成员就能传 `?actorId=别人` 读到别人的日志 ——
   * 而 `/api/audit` 那道管理员闸门正是为了防这个。
   */
  function MySecurityLogPanel() {
    const [rows, setRows] = useState<SecurityLogRow[] | null>(null)
    const [err, setErr] = useState('')

    useEffect(() => {
      listMySecurityLog()
        .then((r) => setRows(r))
        .catch((e) => setErr(e?.message || '安全记录加载失败'))
    }, [])

    if (err) return <div className="yq-settings-hint">安全记录加载失败：{err}</div>
    if (!rows) return <div className="yq-settings-hint">正在读…</div>
    if (!rows.length) return <div className="yq-settings-hint">还没有记录（改密码或创建令牌后会出现在这里）。</div>

    return (
      <div>
        {rows.map((r, i) => (
          <div key={`${r.at}-${i}`} style={{ display: 'flex', gap: 10, padding: '5px 0', borderTop: '1px solid var(--yq-border)' }}>
            <span style={{ flex: 1 }}>
              <b style={{ fontSize: 13 }}>{r.label}</b>
              {r.targetName && <span style={{ marginLeft: 6, fontSize: 13 }}>· {r.targetName}</span>}
              <span className="yq-settings-hint" style={{ marginTop: 2 }}>{new Date(r.at).toLocaleString('zh-CN')}</span>
            </span>
          </div>
        ))}
        <p className="yq-settings-hint" style={{ marginTop: 8 }}>
          完整的操作日志（含谁给谁开了权限、谁导出了整个工作台）**只有管理员能看** ——
          那是另一页，那里的东西对普通成员等于一份权限地图。
        </p>
      </div>
    )
  }

  function TokenPanel() {
    const { toast } = useStore()
    const [items, setItems] = useState<ApiToken[] | null>(null)
    const [err, setErr] = useState('')
    const [name, setName] = useState('')
    const [scopes, setScopes] = useState<('read' | 'write')[]>(['read'])
    const [days, setDays] = useState('0')
    const [making, setMaking] = useState(false)
    /** 新建成功、还没关掉的那一次明文 */
    const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null)
    const [copied, setCopied] = useState(false)

    const load = () => {
      setItems(null)
      setErr('')
      listTokens()
        .then((r) => setItems(r.tokens || []))
        .catch((e) => setErr(e?.message || '令牌加载失败'))
    }
    useEffect(load, [])

    const toggleScope = (s: 'read' | 'write') => {
      setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
    }

    const make = async () => {
      if (!name.trim()) { toast('给令牌起个名字，方便以后认出是哪一把', 'info'); return }
      if (!scopes.length) { toast('至少选一项权限', 'info'); return }
      setMaking(true)
      try {
        const r = await createToken({ name: name.trim(), scopes, days: Number(days) || 0 })
        setFresh({ name: r.name, token: r.token })
        setCopied(false)
        setName('')
        load()
      } catch (e: any) {
        toast(e?.message || '创建失败', 'error')
      } finally {
        setMaking(false)
      }
    }

    const revoke = async (t: ApiToken) => {
      if (!confirm(`撤销「${t.name}」？\n撤销后用它的脚本会立刻收到 401，这个动作不可撤销。`)) return
      try {
        await revokeToken(t.id)
        toast('已撤销', 'success')
        load()
      } catch (e: any) {
        toast(e?.message || '撤销失败', 'error')
      }
    }

    const copy = async () => {
      if (!fresh) return
      try {
        await navigator.clipboard.writeText(fresh.token)
        setCopied(true)
        toast('已复制到剪贴板', 'success')
      } catch {
        setCopied(false)
        toast('复制失败，请手动选中下面的文本复制', 'error')
      }
    }

    const curlSample = fresh
      ? `curl -H "Authorization: Bearer ${fresh.token}" \\\n  "${location.origin}/api/v2/user"`
      : ''

    return (
      <section className="yq-card yq-settings-card">
        <div className="yq-settings-title">访问令牌</div>
        <p className="yq-settings-desc">
          给脚本用的凭据：CI 每次发版把变更记录写进知识库、外部系统把文档读走，都靠它。
          <br />
          <b>三件事请先知道</b>：① 明文只在创建时显示一次，服务端只存哈希，丢了只能重建；
          ② 令牌只对 <code>/api/v2</code> 生效，网页、导出、审计、同步接口都不认它；
          ③ 令牌<b>不绕过</b>知识库权限 —— 给只读成员发写令牌，他也写不了别人没给他的库。
        </p>

        {fresh && (
          <div className="yq-card" style={{ padding: 14, marginBottom: 14, borderColor: 'var(--yq-success)', borderLeftWidth: 3 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>「{fresh.name}」已创建 —— 这是唯一一次显示完整令牌</div>
            <div className="yq-settings-hint" style={{ marginBottom: 8 }}>
              关闭这个提示之后再也看不到它（服务端只留哈希）。如果丢了，撤销重建一把即可。
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="yq-input" readOnly value={fresh.token} style={{ fontFamily: 'ui-monospace,Menlo,Consolas,monospace' }} />
              <Button variant="primary" size="sm" onClick={copy}>{copied ? '已复制' : '复制'}</Button>
              <Button variant="default" size="sm" onClick={() => setFresh(null)}>我已保存</Button>
            </div>
            <div className="yq-settings-hint" style={{ marginTop: 8 }}>
              <div>可以直接这么试：</div>
              <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{curlSample}</pre>
            </div>
          </div>
        )}

        <div className="yq-audit-bar" style={{ flexWrap: 'wrap' }}>
          <input
            className="yq-input"
            style={{ maxWidth: 200 }}
            placeholder="名字，例如「发版流水线」"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={scopes.includes('read')} onChange={() => toggleScope('read')} /> 读
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={scopes.includes('write')} onChange={() => toggleScope('write')} /> 写
          </label>
          <Select
            size="sm"
            value={days}
            onChange={(v) => setDays(String(v))}
            options={[
              { value: '0', label: '永不过期' },
              { value: '30', label: '30 天' },
              { value: '90', label: '90 天' },
              { value: '365', label: '一年' },
            ]}
          />
          <Button variant="primary" size="sm" onClick={make} disabled={making}>
            {making ? '创建中…' : '新建令牌'}
          </Button>
          <span className="yq-flex-1" />
          <span style={{ fontSize: 12, color: 'var(--yq-text-3)' }}>{items?.length ?? 0} 把</span>
        </div>

        {err ? (
          <div className="yq-settings-hint">加载失败：{err}</div>
        ) : !items ? (
          <div className="yq-settings-hint">正在加载…</div>
        ) : items.length === 0 ? (
          <Empty icon="🔑" text="还没有令牌。CI 要发文档、外部系统要读文档时在这里建一把" />
        ) : (
          <div className="yq-audit-list">
            {items.map((t) => {
              const dead = t.status !== 'active'
              return (
                <div key={t.id} className="yq-audit-row" style={dead ? { opacity: 0.55 } : undefined}>
                  <span className="yq-audit-action">{t.name}</span>
                  <span className="yq-audit-target" style={{ fontFamily: 'ui-monospace,Menlo,Consolas,monospace' }}>
                    {t.prefix}…
                  </span>
                  <span className="yq-audit-who">
                    {t.scopes.includes('write') ? '读 + 写' : '只读'}
                  </span>
                  <span className="yq-audit-when">
                    {dead
                      ? (t.status === 'revoked' ? '已撤销' : '已过期')
                      : `最近使用 ${t.lastUsedAt ? timeAgo(t.lastUsedAt) : '从未'}`}
                    {t.expiresAt ? ` · ${new Date(t.expiresAt).toLocaleDateString('zh-CN')} 到期` : ''}
                  </span>
                  <span className="yq-flex-1" />
                  {!dead && (
                    <Button variant="text" size="sm" onClick={() => revoke(t)}>撤销</Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    )
  }

function Field({ label, children }: { label: string; children: React.ReactNode }) {  return (
    <div className="yq-settings-field">
      <label>{label}</label>
      <div>{children}</div>
    </div>
  )
}

/* children 可选：「暂不支持的导入格式」那一行只有说明、没有右侧控件，
   非把它写成必填就是一条恒红的类型错误。 */
function Row({ label, desc, children }: { label: string; desc: string; children?: React.ReactNode }) {  return (
    <div className="yq-settings-row">
      <div className="yq-flex-1">
        <div className="yq-settings-row-label">{label}</div>
        <div className="yq-settings-row-desc">{desc}</div>
      </div>
      {children}
    </div>
  )
}
