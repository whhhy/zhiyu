/* ============================================================
   个人访问令牌（API Token）
   ------------------------------------------------------------
   语雀企业版给每个账号发「个人访问令牌」，用它调 OpenAPI。
   自建知识库缺这一块的实际后果很具体：
   运维想「CI 每次发版把变更记录写进知识库」，只能让人去网页上粘贴；
   别的系统想「把文档标题读出来做门户」，只能整包导出整个库。
   两者都不成立。

   ============================================================
   只存哈希，为什么不是 scrypt
   ------------------------------------------------------------
   密码用 scrypt，是因为人选的口令**熵很低**，
   慢哈希是为了拖慢离线穷举（字典 / 彩虹表）。
   这里的令牌是 30 字节随机数（240 bit），字典攻击在物理上不成立，
   而 scrypt 每次校验要几十毫秒 —— 用在这里等于给**每一次 API 调用**
   都加一次人工延迟。所以用 sha256：随机数不需要慢。

   这条不能反着来。如果哪天有人把令牌改成「用户自己起的口令」，
   sha256 立刻变成一个真正的洞（`hashToken` 那一行会安静地继续工作）。
   所以下面刻意写死 30 字节随机源，而不是接受外部传入。

   ============================================================
   权限是两件事的交集
   ------------------------------------------------------------
   scope 说的是「这把令牌**想**干什么」（read / write）；
   知识库权限矩阵说的是「这个人**能**干什么」。
   两边都必须过。理由很直白：一个 reader 的令牌如果能写，
   那 scope 就变成了绕过权限矩阵的后门 —— 而权限矩阵是内网部署里
   唯一那层「A 部门的看不到 B 部门」的东西。
   ============================================================ */

import { createHash, randomBytes } from 'node:crypto'
import { db } from './db.ts'
import type { Row } from './db.ts'
import type { User } from './perms.ts'

/** 令牌明文的前缀。只为两件事：界面上一眼认出它不是会话令牌，以及自查时好筛 */
export const TOKEN_MARK = 'yq_'

/** scope 只有两档，都真的被用到 —— 不做「预留的第三档」 */
export const SCOPES = ['read', 'write'] as const
export type Scope = typeof SCOPES[number]

/** 明文里露出多少：够认出是哪一把，又短到猜不出来（剩下 28 字节仍然随机） */
const PREFIX_LEN = 12

/** 最近使用时间最多每 5 分钟写一次 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

/** 有效期上限：一年。不设上限的令牌迟早会有人忘了它还在（离职时已撤销，但仍有风险） */
const MAX_DAYS = 365

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function newSecret(): string {
  // 30 字节随机 —— 见文件头「只存哈希」那段，不要改成接受外部输入
  return TOKEN_MARK + randomBytes(30).toString('base64url')
}

/** 把外部传来的 scope 收敛成合法集合；一个都不认识就退化成只读
 *
 * ⚠️ **write 蕴含 read**，这里补上，别让「写令牌读不了东西」。
 *
 * 原来的问题：界面上「读」「写」是两个**互相独立**的勾选框，
 * 而令牌列表那一栏写的是 `scopes.includes('write') ? '读 + 写' : '只读'`。
 * 于是「取消读、勾写」会建出一把显示为**「读 + 写」**的令牌，
 * 而 `requireScope` 是 `scopes.includes(need)` 的严格成员判断 ——
 * 那把令牌读**任何**接口都是 403：
 *   「这把令牌只有 write 权限，做不了 read」
 * 两个界面文本都没说错，合起来却把用户带进一个死胡同。
 *
 * 为什么修在这里：`parseScopes()` 读库里存的值时**也调它** ——
 * 所以已经发出去的写令牌同样被补上 read，不用等用户重建。
 */
export function normalizeScopes(input: unknown): Scope[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(/[,\s]+/) : []
  const list = SCOPES.filter((s) => raw.includes(s))
  if (!list.length) return ['read']
  return list.includes('write') ? ['read', 'write'] : ['read']
}

function parseScopes(raw: unknown): Scope[] {
  try {
    const v = JSON.parse(String(raw || ''))
    return Array.isArray(v) ? normalizeScopes(v) : ['read']
  } catch {
    return ['read']
  }
}

/** 有效期天数：0 / 不给 = 永不过期。超上限截断。 */
function expiresAtOf(days: number, now: number): number | null {
  const d = Math.floor(Number(days) || 0)
  if (d <= 0) return null
  return now + Math.min(d, MAX_DAYS) * 86400000
}

/**
 * 建一把新令牌。
 *
 * 明文**只在返回值里出现这一次**，之后任何接口都拿不到 ——
 * 库里只有 sha256。丢了就撤销重建，这是令牌该有的性质，
 * 不该做成「找回我的令牌」。
 */
export function createApiToken(userId: string, opts: { name?: unknown; scopes?: unknown; days?: unknown }) {
  const name = String(opts.name ?? '').trim().slice(0, 60) || '未命名令牌'
  const scopes = normalizeScopes(opts.scopes)
  const token = newSecret()
  const id = 'tk_' + randomBytes(6).toString('hex')
  const now = Date.now()
  const expiresAt = expiresAtOf(Number(opts.days), now)
  db.prepare(
    `INSERT INTO api_tokens (id,userId,name,prefix,tokenHash,scopes,createdAt,lastUsedAt,expiresAt,revokedAt)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(id, userId, name, token.slice(0, PREFIX_LEN), hashToken(token), JSON.stringify(scopes), now, null, expiresAt)
  return { id, name, scopes, expiresAt, prefix: token.slice(0, PREFIX_LEN), token }
}

export interface TokenAuth {
  user: User
  tokenId: string
  scopes: Scope[]
}

/**
 * 校验一把令牌。
 *
 * 三种失效都必须在这里判掉：撤销、过期、用户已不存在。
 * 顺序也重要：**先查撤销和过期，再查用户**。
 * 反过来的话，一个已撤销的令牌会先返回用户对象，
 * 后面某次重构若忘了再判撤销，那就是一把还能用的令牌 ——
 * 「撤销没生效」和「撤销功能不存在」在界面上长得一模一样。
 */
export function verifyApiToken(raw: string | null | undefined): TokenAuth | null {
  if (!raw || typeof raw !== 'string' || !raw.startsWith(TOKEN_MARK)) return null
  const row = db.prepare('SELECT id,userId,scopes,lastUsedAt,expiresAt,revokedAt FROM api_tokens WHERE tokenHash = ?')
    .get(hashToken(raw)) as Row | undefined
  if (!row) return null
  if (Number(row.revokedAt) > 0) return null
  if (Number(row.expiresAt) > 0 && Number(row.expiresAt) < Date.now()) return null

  const u = db.prepare('SELECT id, name, account, role, avatar FROM users WHERE id = ?')
    .get(String(row.userId)) as Row | undefined
  // 用户已被删（ON DELETE CASCADE 一般会连带删掉令牌，但库被外部动过时不能靠这个）
  if (!u) return null

  touch(String(row.id), Number(row.lastUsedAt) || 0)
  return {
    user: { id: String(u.id), name: String(u.name), account: String(u.account), role: String(u.role), avatar: String(u.avatar || '') },
    tokenId: String(row.id),
    scopes: parseScopes(row.scopes),
  }
}

/**
 * 「最近使用」不能每次调用都写一次库。
 *
 * 一个每分钟调 60 次的定时任务会把 tokens 表写 60 次 ——
 * 而且这些写在同一个 SQLite 上，会和用户的正常编辑抢写锁。
 * 所以离上次记录不到 5 分钟就跳过；界面上「最近使用」本来也是分钟级精度。
 */
function touch(id: string, lastUsedAt: number) {
  const now = Date.now()
  if (lastUsedAt > 0 && now - lastUsedAt < TOUCH_INTERVAL_MS) return
  try {
    db.prepare('UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?').run(now, id)
  } catch {
    // 记「最近使用」失败不该让一次正常的 API 调用变成 500：
    // 令牌本身已经验过了，这只是个展示字段
  }
}

/** 状态由三个时间戳现算，不另存一列 —— 存了就会出现「已撤销但状态是 active」 */
function statusOf(r: Row): 'active' | 'expired' | 'revoked' {
  if (Number(r.revokedAt) > 0) return 'revoked'
  if (Number(r.expiresAt) > 0 && Number(r.expiresAt) < Date.now()) return 'expired'
  return 'active'
}

/**
 * 列出一把令牌时**永远不给哈希**。
 *
 * 哈希不是明文，但也没必要外泄：拿到它的人就能离线验证
 * 「我猜的这个令牌对不对」，而这个接口是每个登录用户都能调的。
 */
export function listApiTokens(userId: string) {
  const rows = db.prepare(
    `SELECT id, name, prefix, scopes, createdAt, lastUsedAt, expiresAt, revokedAt
       FROM api_tokens WHERE userId = ? ORDER BY createdAt DESC`,
  ).all(userId) as Row[]
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name || ''),
    prefix: String(r.prefix || ''),
    scopes: parseScopes(r.scopes),
    createdAt: Number(r.createdAt) || 0,
    lastUsedAt: Number(r.lastUsedAt) || 0,
    expiresAt: Number(r.expiresAt) || 0,
    revokedAt: Number(r.revokedAt) || 0,
    status: statusOf(r),
  }))
}

/** 撤销一把令牌。**只能撤销自己的** —— 少了 userId 就能撤别人的 */
export function revokeApiToken(userId: string, id: string): boolean {
  const r = db.prepare('UPDATE api_tokens SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL')
    .run(Date.now(), id, userId)
  return Number(r.changes) > 0
}

/**
 * 撤销这个人的**全部**令牌。办理离职时必须调。
 *
 * 会话会被清、空间成员会被移、知识库权限会被收 ——
 * 而令牌是第四条路，只堵前三条的话，那把令牌还能继续读文档，
 * 而且从外部看过去完全正常（它不需要会话）。
 */
export function revokeAllApiTokens(userId: string): number {
  return Number(db.prepare('UPDATE api_tokens SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL')
    .run(Date.now(), userId).changes)
}
