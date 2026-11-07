import { useEffect, useState } from 'react'
import { getMode, isAuthed, login, register, me, probe, reprobe, serverUnreachable, onSessionExpired, ssoLogin, serverSso, serverSsoOnly, type AuthUser } from '@/lib/api'
import { hydrate, start, stop } from '@/lib/sync'
import { useStore } from '@/store'

/* ============================================================
   启动闸门
   ------------------------------------------------------------
   三种状态：
     探测中   —— 问一次 /api/health，最长 2.5 秒
     需要登录 —— 有服务端但没令牌
     就绪     —— 有令牌并已把数据灌进 store；或压根没服务端（本地模式）

   为什么不直接在 main.tsx 里 await：
   探测是一次网络请求，卡住会让首屏白屏。而 React 挂载后切状态更安全，
   期间可以先渲染一个骨架，用户看到的是「加载中」而不是白屏。
   ============================================================ */

export function AppGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<'probing' | 'login' | 'ready' | 'offline'>('probing')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const mode = await probe()
      if (!alive) return

      /**
       * 探测失败，但**这台机器本来是有服务端的**（手里有令牌 / 上次探测确认过）。
       *
       * 这时候绝不能回落成本地模式顶上。之前就是那么做的，后果是：
       * 服务重启的 2 秒空窗 → 用户看到本地那份数据（甚至演示种子）
       * → SyncStatus 因「本地模式」不显示任何离线提示
       * → 用户以为在编辑真实知识库，照常写了一通
       * → 服务恢复后重进，下面第 33 行的 clearLocalSnapshot()
       * → **他这期间的修改被直接删掉**。
       *
       * 停下来、说清楚、给一个「重试」按钮，比给他一份错的数据安全得多。
       */
      if (mode === 'local' && serverUnreachable()) {
        setPhase('offline')
        return
      }

      if (mode === 'local') { setPhase('ready'); return }

      // 服务端形态下，localStorage 里那份是**陈旧**的（可能来自上一个版本、
      // 上一次会话）。必须在 hydrate 之前清掉，否则它会被当成「我的改动」推上去。
      useStore.getState().clearLocalSnapshot()

      if (!isAuthed()) {
        // 开着统一认证时先试一次：大多数情况下用户已经被网关认证过了，
        // 这一步直接就进去了，压根不该让人看到密码表单。
        if (serverSso()) {
          try {
            const su = await ssoLogin()
            await hydrate(su)
            if (!alive) return
            setUser(su)
            start()
            setPhase('ready')
            void useStore.getState().refreshBookInvites()
            return
          } catch (e: any) {
            if (!alive) return
            // 网关没放行（常见于有人直接访问了后端端口而不是公司门户）
            setBootError(serverSsoOnly()
              ? '本知识库只接受公司统一认证，请从公司门户进入'
              : '统一认证未通过，请从公司门户进入；也可以用账号密码登录')
          }
        }
        setPhase('login')
        return
      }
      try {
        const u = await me()
        await hydrate(u)
        if (!alive) return
        setUser(u)
        start()
        setPhase('ready')
        void useStore.getState().refreshBookInvites()
      } catch (e: any) {
        if (!alive) return
        // 令牌失效 / 网络不通，都退到登录页并说明原因
        setBootError(e?.message || '无法连接服务器')
        setPhase('login')
      }
    })()
    return () => { alive = false }
  }, [])

  /**
   * 会话中途失效（401）时把界面送回登录页。
   *
   * 之前 401 只清了令牌，界面**纹丝不动**：应用照常渲染、写入被静默拒绝、
   * 同步提示栏是空的。用户拿到的反馈是零，他继续编辑，
   * 改动堆在本地，等下次登录被 clearLocalSnapshot() 删掉。
   *
   * 这条在「办理离职」之后尤其容易撞上 ——
   * 那个动作本来就会清空该同事的全部会话。
   */
  useEffect(() => onSessionExpired(() => {
    stop()
    setBootError('登录状态已过期，请重新登录。刚才没保存上的内容不会自动补传，请先复制出来。')
    setPhase('login')
  }), [])

  if (phase === 'probing') return <BootScreen />
  if (phase === 'offline') {
    return (
      <OfflineScreen
        busy={retrying}
        onRetry={async () => {
          setRetrying(true)
          try {
            // 重新探测必须清掉缓存，否则拿到的还是刚才那个失败结果
            const m = await reprobe()
            if (m === 'server' && !serverUnreachable()) {
              setPhase('probing')
              setBootError(null)
              // 回到探测态，用同一个 effect 再走一遍登录/hydrate
              window.location.reload()
              return
            }
          } catch { /* 仍然连不上，留在这一页 */ }
          setRetrying(false)
        }}
      />
    )
  }
  if (phase === 'login') {
    return (
      <LoginScreen
        notice={bootError}
        onDone={async (u) => {
          await hydrate(u)
          start()
          setUser(u)
          /*
           * ⚠️ 这里原来**漏了**拉待办 ——
           *    而这条恰恰是「用账号密码登录」那条路径，
           *    也就是内网部署下**最常走**的一条
           *    （上面两行分别是 SSO 与令牌已有，我一开始只改了那两个）。
           *
           *    症状极像「功能没做完」：邀请发得出去、服务端数据也对，
           *    但收邀请的那个人登录后顶栏没有红点、待办页是空的 ——
           *    而发起方那侧一切正常，于是很容易被判断成「他那边的问题」。
           *
           *    「同一个动作有几个入口」时，**每个入口都要挂**，
           *    漏掉的那一个不会报错，只会安静地少做事。
           */
          void useStore.getState().refreshBookInvites()
          setPhase('ready')
        }}
      />
    )
  }
  return <>{children}</>
}

function BootScreen() {
  return (
    <div className="yq-boot">
      <div className="yq-boot-logo">知语</div>
      <div className="yq-boot-text">正在连接知识库…</div>
    </div>
  )
}

/**
 * 服务连不上。
 *
 * 这里**必须挡住整个应用**，不能放行。放行的话用户看到的是本地那份数据，
 * 而他以为自己在编辑真实知识库 —— 界面上没有任何提示能让他察觉这件事。
 */
function OfflineScreen({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return (
    <div className="yq-boot">
      <div className="yq-boot-logo">知语</div>
      <div className="yq-boot-text">连不上知识库服务</div>
      <div className="yq-offline-why">
        服务暂时不可达（可能正在重启、或者网络不通）。
        <br />
        这里<b>不会</b>退回本地数据 —— 那会让你以为改动存上了，其实并没有写进知识库。
      </div>
      <button className="yq-boot-retry" onClick={onRetry} disabled={busy}>
        {busy ? '重试中…' : '重试'}
      </button>
    </div>
  )
}

/* ============================================================
   登录 / 注册
   ============================================================ */

function LoginScreen({ onDone, notice }: { onDone: (u: AuthUser) => void; notice: string | null }) {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [err, setErr] = useState<string | null>(notice)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setErr(null)
    if (!account.trim() || !password) { setErr('请填写账号与密码'); return }
    if (isRegister && password.length < 6) { setErr('密码至少 6 位'); return }
    setBusy(true)
    try {
      const u = isRegister
        ? await register(account.trim(), password, name.trim() || account.trim())
        : await login(account.trim(), password)
      onDone(u)
    } catch (e2: any) {
      setErr(e2?.message || '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="yq-login">
      <form className="yq-login-card" onSubmit={submit}>
        <div className="yq-login-logo">知语</div>
        <div className="yq-login-sub">公司内部知识库</div>

        {isRegister && (
          <label className="yq-login-field">
            <span>姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="你的姓名" autoComplete="name" />
          </label>
        )}
        <label className="yq-login-field">
          <span>账号</span>
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="登录名" autoComplete="username" autoFocus />
        </label>
        <label className="yq-login-field">
          <span>密码</span>
          {/* ⚠️ 占位符原来是 `••••••`，改成文字提示了（2026-10-08）。

              实测踩坑经过：部署后拿浏览器试登录，把口令填进了「账号」框、
              密码框留空，结果看到的是一排和真密码**一模一样**的点，
              于是以为密码已经填好，报「请填写账号与密码」。

              问题不在校验（它是对的：空密码就该拒），而在这个占位符
              **看起来像已填内容**。另外两个占位符（「你的姓名」/「登录名」）
              都是文字，只有它是点 —— 唯一容易误认的那个偏偏是它。 */}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isRegister ? '至少 6 位' : '输入密码'} autoComplete={isRegister ? 'new-password' : 'current-password'} />
        </label>

        {err && <div className="yq-login-err">{err}</div>}

        <button className="yq-login-submit" type="submit" disabled={busy}>
          {busy ? '处理中…' : isRegister ? '注册并进入' : '登录'}
        </button>

        <button
          type="button"
          className="yq-login-switch"
          onClick={() => { setIsRegister(!isRegister); setErr(null) }}
          style={serverSsoOnly() ? { display: 'none' } : undefined}
        >
          {isRegister ? '已有账号，去登录' : '没有账号？注册一个'}
        </button>

        <div className="yq-login-hint">
          {serverSsoOnly()
            ? '本知识库已接入公司统一认证，请关闭本页、从公司门户的知识库入口进入。'
            : '首次注册的账号会成为知识库管理员；之后注册的同事需要管理员加入对应的知识库才能看到内容。'}
        </div>
      </form>
    </div>
  )
}

export { getMode, stop }
