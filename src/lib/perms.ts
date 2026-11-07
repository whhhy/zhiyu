/* ============================================================
   权限查询（前端侧）

   为什么要专门做一层：
   服务端早就判了权限（越权写入会被拒），但**前端从来没问过** ——
   `bookPerms()` / `docPerms()` 这两个接口一直没人调用。
   结果是：一个只读成员看到的是一个完全可编辑的页面，
   他打字、看起来存进去了，回车一提交就被服务端拒掉，
   而且**界面上一点提示都没有**。

   「我明明改了，怎么没了」是知识库里最难排查的一类问题，
   而它是可以从根上避免的：拿不到编辑权就别让他编辑。
   ============================================================ */

import { useEffect, useMemo, useState } from 'react'
import { docPerms, bookPerms, spacePerms, getMode } from './api'
import type { BookMember } from '@/types'

export interface Caps {
  read: boolean
  comment: boolean
  edit: boolean
  create: boolean
  export: boolean
  share: boolean
  admin: boolean
}

const NONE: Caps = { read: false, comment: false, edit: false, create: false, export: false, share: false, admin: false }
/** 本地模式没有服务端，权限一律放行（本地形态本来就是单人演示） */
const ALL: Caps = { read: true, comment: true, edit: true, create: true, export: true, share: true, admin: true }

/* ============================================================
   角色 → 能力基线
   ------------------------------------------------------------
   ⚠️ 这张表**必须**与服务端 `server/perms.ts` 的 `ROLE_CAPS` 一致。
   `test-entity-keys` 里有逐字核对，改了一边忘了另一边会直接红。

   为什么客户端也需要这张表：
   服务端算权限的顺序是「先按角色给一份基线，再用成员行上的 perms 逐项覆盖」。
   以前加成员时把 perms 直接写死成「只读 + 评论」，
   于是无论角色选的是管理员还是编辑者，服务端都会把那四项按成 false ——
   **角色退化成一个只能看的下拉框**，管理员还得逐个人手动勾 4 个复选框。
   实测：把某人设为「编辑者」，服务端判给他的是
   `{read:true, comment:true, edit:false, create:false, export:false, share:false}`。

   所以新建成员行时，perms 必须**从角色派生**，让两者天然一致；
   perms 留给「在角色之上再逐项微调」用 —— 那才是它该有的角色。
   ============================================================ */

export const ROLE_CAPS: Record<string, Caps> = {
  owner: { read: true, comment: true, edit: true, create: true, export: true, share: true, admin: true },
  admin: { read: true, comment: true, edit: true, create: true, export: true, share: true, admin: true },
  editor: { read: true, comment: true, edit: true, create: true, export: true, share: true, admin: false },
  reader: { read: true, comment: true, edit: false, create: false, export: true, share: false, admin: false },
  visitor: { read: true, comment: false, edit: false, create: false, export: false, share: false, admin: false },
}

/** 角色的能力基线，落成成员行上的 perms（不含 admin —— 那是服务端按角色再判的） */
export function permsForRole(role: BookMember['role'] | string): BookMember['perms'] {
  const c = ROLE_CAPS[role] || ROLE_CAPS.visitor
  return {
    read: c.read,
    comment: c.comment,
    edit: c.edit,
    create: c.create,
    export: c.export,
    share: c.share,
  }
}

const cache = new Map<string, Caps>()

/**
 * 把**已经问到**的一份 caps 写进这份缓存（不发请求，也不通知已挂载的 hook）。
 *
 * ⚠️ 为什么必须有这个出口：同一个事实过去有**两个地方**各存一份 ——
 *   · `useSpacePerms` 的答案 → 写**这份缓存**
 *   · store 的 `loadSpaceCaps` 的答案 → 写 **store 切片** `spaceCaps`
 * 于是 `spaceCapsSync()`（读这份缓存）永远读不到 store 学到的东西。
 *
 * 症状安静得可怕：store 层的 `spaceCommentBlocked` 读这份缓存，
 * 而 `loadSpaceCaps` 不填它 → 守卫**永远读到 null** →「问过才拦」变成
 * 「**永远不拦**」，界面上却看不出任何异常。
 * （实测：`loadSpaceCaps('s1')` 返回全 false，紧接着
 *   `createTopic` 照样成功、本地立刻多出话题。）
 *
 * 修法就是让**写方也写这份缓存** —— 两处存一份事实。
 */
export function primePermsCache(scope: 'book' | 'space', id: string, caps: Caps) {
  if (!id) return
  cache.set(`${scope}:${id}`, caps)
}

/**
 * 这篇文稿我有什么权限。
 * 返回的 caps 在加载完成前是 `null` —— 调用方要区分
 * 「还没问过」和「问过了、答案是不能编辑」，
 * 前者不该把编辑框锁死，后者必须锁。
 */
/**
 * 权限查询失败时的处置判据。**单独提出来是为了能直接断**，—
 * hook 里的重试循环没法在纯函数套件里跑，而「403 立刻锁、404 要重试」
 * 这条判据恰恰是最该被钉住的那条。
 */

/** 重试间隔（毫秒）。实测新建文档约 1.2 秒同步上，所以三次足够覆盖。 */
export const PERM_RETRY_DELAYS = [400, 800, 1200]

/**
 * 服务端给出的**明确**答复：立刻 fail closed，不重试。
 *
 * 401/403 是「我问到了，你的权限就是不行」—— 再问一次答案不会变，
 * 让用户对着一个不会自愈的界面干等没有意义。
 */
export const isFinalPermDenial = (status: number): boolean => status === 401 || status === 403

/**
 * 第 `attempt` 次失败之后怎么办。`attempt` 从 1 起数。
 *
 * `status` 传 0 表示「连不上服务器」（api.ts 的 `request()` 就是这么抛的）。
 */
export function permFailureAction(status: number, attempt: number): 'retry' | 'deny' {
  if (isFinalPermDenial(status)) return 'deny'
  if (attempt > PERM_RETRY_DELAYS.length) return 'deny'
  return 'retry'
}

export function useDocPerms(docId: string | null | undefined): Caps | null {
  const [caps, setCaps] = useState<Caps | null>(() => {
    if (!docId) return null
    if (getMode() !== 'server') return ALL
    return cache.get(`doc:${docId}`) ?? null
  })

  useEffect(() => {
    if (!docId) { setCaps(null); return }
    if (getMode() !== 'server') { setCaps(ALL); return }
    const key = `doc:${docId}`
    const hit = cache.get(key)
    if (hit) { setCaps(hit); return }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    /**
     * ⚠️ 失败**不等于**「你没权限」，原来在这里栽了个很严重的坑。
     *
     * 新建文档是**本地先落、同步是防抖的**，所以刚建完那一瞬问
     * `/api/perms/doc/<id>` 必然 404「文档不存在」（实测 1.2 秒后才 200 edit:true）。
     * 而原来的 `.catch` 一律 `setCaps({ ...NONE, read: true })`，于是：
     *   · 自己刚创建、自己拥有的文档被判成「只有阅读权限」；
     *   · 编辑器**永久只读**（`noEditRight`）；
     *   · 还弹一句「你对这篇文档只有阅读权限，编辑已关闭」；
     *   · 这个 effect 只依赖 `[docId]`，**再也不会重问** —— 不刷新就好不了。
     * 界面上表现为「新建文档后打不了字」「点块没反应」「斜杠菜单不弹」，
     * 没有一条报错，看起来像编辑器坏了。
     *
     * 改法：**404 / 网络错误重试**（同步通常一秒内就好），重试用尽才 fail closed。
     * 「宁可少给权限」那条原则没有放松 —— 只是不再把「还没同步好」
     * 误判成「没有权限」。而 401/403 是服务端的**明确**答复，立刻锁，不浪费用户时间。
     */
    const attempt = (n: number) => {
      docPerms(docId)
        .then((c) => {
          if (!alive) return
          const v = { ...NONE, ...(c as any) }
          cache.set(key, v)
          setCaps(v)
        })
        .catch((e: any) => {
          if (!alive) return
          const status = typeof e?.status === 'number' ? e.status : 0
          if (permFailureAction(status, n) === 'deny') {
            // 问不到就先按「可读不可写」处理：宁可少给权限，也不要
            // 让用户以为能存、结果服务端拒了
            setCaps({ ...NONE, read: true })
            return
          }
          timer = setTimeout(() => attempt(n + 1), PERM_RETRY_DELAYS[n - 1])
        })
    }
    attempt(1)
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [docId])

  return caps
}

/** 这个知识库我有什么权限（设置页、目录树的「新建」按钮要靠它） */
export function useBookPerms(bookId: string | null | undefined): Caps | null {
  const [caps, setCaps] = useState<Caps | null>(() => {
    if (!bookId) return null
    if (getMode() !== 'server') return ALL
    return cache.get(`book:${bookId}`) ?? null
  })
  /*
   * 缓存被清空时把本 hook 标脏，让下面的 effect **重跑并重新问服务端**。
   * 没有这一步，清缓存只会让**下一次挂载**的人看到新答案，
   * 已经开着页面的人会一直按旧判据显隐（见 clearPermsCache 上面那段）。
   *
   * ⚠️ 这个 `ver` 必须进**下面那个取数 effect 的依赖** ——
   *   只用它触发重渲染是不够的：effect 的依赖没变就不会重跑，
   *   于是「清了缓存但没人去问」，界面照样是旧的。
   *   （第一版就写成只 `bump`，结果守卫那条直接红了。）
   */
  const [ver, setVer] = useState(0)

  useEffect(() => {
    if (!bookId) { setCaps(null); return }
    if (getMode() !== 'server') { setCaps(ALL); return }
    const key = `book:${bookId}`
    const hit = cache.get(key)
    if (hit) { setCaps(hit); return }
    let alive = true
    bookPerms(bookId)
      .then((c) => {
        if (!alive) return
        const v = { ...NONE, ...(c as any) }
        cache.set(key, v)
        setCaps(v)
      })
      .catch(() => { if (alive) setCaps({ ...NONE, read: true }) })
    return () => { alive = false }
  }, [bookId, ver])

  useEffect(() => onPermsCacheCleared(() => setVer((n) => n + 1)), [bookId])

  return caps
}

/** 权限变了就清缓存（切换账号、导入数据后要调） */
const cacheListeners = new Set<() => void>()
export function clearPermsCache() {
  cache.clear()
  /*
   * 只清缓存**不够**：`useBookPerms` 的 effect 依赖只有 `bookId`，
   * 而缓存命中时它会直接 return 不发请求 —— 于是
   * 「管理员刚把某人升成编辑者」这件事，在被改动的那个人那边
   * 要**刷新页面**才看得见（按钮还是按旧判据显隐）。
   *
   * 所以清缓存必须**通知**一遍：让已经挂载的 hook 重跑一次 effect，
   * 重新问服务端。`sync.ts` 在成员名单变化时会调它 ——
   * 那是唯一能知道「权限可能变了」的地方。
   */
  for (const fn of cacheListeners) { try { fn() } catch { /* 单个订阅者出错不影响别人 */ } }
}

/** 订阅「缓存被清空」，返回一个退订函数（给 hook 用） */
export function onPermsCacheCleared(fn: () => void): () => void {
  cacheListeners.add(fn)
  return () => { cacheListeners.delete(fn) }
}

/**
 * 这个**空间**我有什么权限。
 *
 * ⚠️ 它和 `useBookPerms` 是**两件事**，不能互相顶替（2026-10-12 踩过）：
 *   「能不能在这个空间里建知识库」判的是 `capsInSpace(sid).admin`；
 *   而拿空间 id 去问 `/api/perms/book/:id` 会得到**全 false** ——
 *   界面上读成「你没权限」，真相是「我问错了对象」。
 *   于是空间管理员（非平台管理员）的「新建知识库」按钮整个消失，
 *   而服务端 `denyReason` 明明放他过。**这是「功能没了」而不是「假动作」，
 *   一样是假的，只是方向相反。**
 */
export function useSpacePerms(spaceId: string | null | undefined): Caps | null {
  const [caps, setCaps] = useState<Caps | null>(() => {
    if (!spaceId) return null
    if (getMode() !== 'server') return ALL
    return cache.get(`space:${spaceId}`) ?? null
  })
  const [ver, setVer] = useState(0)

  useEffect(() => {
    if (!spaceId) { setCaps(null); return }
    if (getMode() !== 'server') { setCaps(ALL); return }
    const key = `space:${spaceId}`
    const hit = cache.get(key)
    if (hit) { setCaps(hit); return }
    let alive = true
    spacePerms(spaceId)
      .then((c) => {
        if (!alive) return
        const v = { ...NONE, ...(c as any) }
        cache.set(key, v)
        setCaps(v)
      })
      .catch(() => { if (alive) setCaps({ ...NONE, read: true }) })
    return () => { alive = false }
  }, [spaceId, ver])

  useEffect(() => onPermsCacheCleared(() => setVer((n) => n + 1)), [spaceId])

  return caps
}

/**
 * 一次问**多个**知识库的权限，返回 `{ [bookId]: Caps | null }`。
 *
 * ============================
 * 为什么不能直接用 `useBookPerms`
 * ------------------------------------------------------------
 * 只有**全局回收站页**需要它：那上面的行**分属不同的知识库**，
 * 而「能不能还原 / 永久删除」是**按行**判的。
 *
 * 两条走不通的路都踩过：
 *   · 整页早退（`if (!admin) return`）—— 在只读用户那里就把整页清空了，
 *     而他在**自己管的那个库**里本来是有权操作的，那叫「功能没了」，
 *     比假动作更难被发现（没人会来报「这功能还没做」）；
 *   · 取「某一个」的 caps 给整页用 —— 同上，只是隐蔽一些。
 *
 * 判据仍然是服务端那份 `bookPerms`，**不在前端按角色重算一遍** ——
 * 前端算的和服务端算的迟早会漂（`ROLE_CAPS` 那段注释记的就是这件事）。
 *
 * 语义与另两个 hook 一致：值为 `null` = **还没问过**，不是「没有权限」。
 * 调用方按 fail closed 处理（拿不到就别给按钮），与 `BookSettings` 同一口径。
 */
export function useBookPermsMany(bookIds: (string | null | undefined)[]): Record<string, Caps | null> {
  const ids = useMemo(
    () => [...new Set(bookIds.filter((x): x is string => !!x))].sort(),
    // 依赖用拼接后的字符串：数组字面量每次渲染都是新的，
    // 直接进依赖会让这个 effect 每渲染一次就跑一轮请求。
    [bookIds.join('|')],
  )
  const [map, setMap] = useState<Record<string, Caps | null>>({})
  const [ver, setVer] = useState(0)

  useEffect(() => {
    if (!ids.length) { setMap({}); return }
    if (getMode() !== 'server') {
      const all: Record<string, Caps | null> = {}
      for (const id of ids) all[id] = ALL
      setMap(all)
      return
    }
    let alive = true
    // 先把**已经问到过的**从缓存里取出来，只对剩下的发请求
    const seed: Record<string, Caps | null> = {}
    const pending: string[] = []
    for (const id of ids) {
      const hit = cache.get(`book:${id}`)
      if (hit) seed[id] = hit
      else { seed[id] = null; pending.push(id) }
    }
    setMap(seed)
    if (!pending.length) return
    Promise.all(pending.map((id) =>
      bookPerms(id)
        .then((c) => { const v = { ...NONE, ...(c as any) }; cache.set(`book:${id}`, v); return [id, v] as const })
        // 问不到就按「可读不可写」处理，和另两个 hook 同一个失败策略
        .catch(() => [id, { ...NONE, read: true } as Caps] as const),
    )).then((pairs) => {
      if (!alive) return
      setMap((prev) => {
        const next = { ...prev }
        for (const [id, v] of pairs) next[id] = v
        return next
      })
    })
    return () => { alive = false }
  }, [ids, ver])

  useEffect(() => onPermsCacheCleared(() => setVer((n) => n + 1)), [])

  return map
}

/**
 * **同步**读一个知识库的权限（没问过就返回 null）。
 *
 * 给 store 用：store 的 action 是同步的，没法等一次异步查询。
 *
 * 语义要分清：
 *   · 返回 `null` = **还没问过**（不是「没有权限」）；
 *   · 调用方要自己决定 null 时怎么办。
 *
 * 目录树的写操作（删/改名/移动/置顶）选的是「**问过才拦**」：
 * 那几个入口全都在目录树/文档页上，权限那时**一定已经问过了**
 * （树一挂载 `useBookPerms` 就发请求），所以阅读者仍然会被挡住；
 * 而 `createDoc` 那种到处都会调的热路径不能这么判 ——
 * 有些页面（导入流程）压根没挂树，caps 会一直是 null，
 * 那样会把管理员正常建文档也一起拒掉。
 *
 * 「问过才拦」真正的缺口是：在**任何页面都还没挂树**之前，
 * 由脚本直接调 store 的那条路。界面上的入口已经关上了，
 * 剩下的只是脚本绕过 —— 拿这个换掉「建文档被误拒」不划算。
 */
export function bookCapsSync(bookId: string | null | undefined): Caps | null {
  if (!bookId) return null
  if (getMode() !== 'server') return ALL
  return cache.get(`book:${bookId}`) ?? null
}

/**
 * 空间的权限同步读法（给 store 用）。语义与 `bookCapsSync` 一致：
 * 返回 `null` = **还没问过**，不是「没有权限」。
 */
export function spaceCapsSync(spaceId: string | null | undefined): Caps | null {
  if (!spaceId) return null
  if (getMode() !== 'server') return ALL
  return cache.get(`space:${spaceId}`) ?? null
}
