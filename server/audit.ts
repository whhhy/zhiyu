/* ============================================================
   操作日志（审计）
   ------------------------------------------------------------
   为什么不用 `changes` 表顶替：那张表只服务增量同步，记的是「哪一行变了」，
   不记意图。「把人加进知识库」和「改了知识库描述」在它眼里是同一种事，
   而且它会随增量窗口被裁掉 —— 一条三个月前的权限授予记录可能已经没了。
   权限这种事要能一直查，就得有独立的、不随同步窗口滚动的表。

   **诚实说明覆盖面**：这里只记服务端**能权威看到**的动作。
   客户端本地模式（无服务端）不经过这里，也就**不会有日志**。
   凡是走 `/api/sync/push` 的变更（改标题、拖目录等）也不逐条记 ——
   那会让这张表变成第二份 `changes`，反而没人看。
   记的是「权限 / 数据外流 / 账号生命周期」这几类真正需要追溯的动作。

   **这张表不自动清理，也没有上限。** 这是刻意的：审计记录被静默裁掉，
   比没有审计更糟 —— 真出事时你会以为有记录，翻过去却是空的，
   而且你不知道它是什么时候没的。真嫌大，运维可以自己定期 DELETE 旧行，
   那是有人负责的决定，不该由程序悄悄做。
   读取端有上限（单次最多 500 条），所以「拉一张巨大的表」这种用法也不成立。
   ============================================================ */

import { randomBytes } from 'node:crypto'
import { db } from './db.ts'
import type { Row } from './db.ts'

/** 动作名。用常量而不是到处写字面串，拼错了会静默变成另一种记录。 */
export const AUDIT = {
  spaceMemberAdd: 'space.member.add',
  spaceMemberRemove: 'space.member.remove',
  /* 删空间 / 撤销删除（2026-10-16，照语雀「删除空间 + 24 小时撤销」补） */
  spaceDelete: 'space.delete',
  spaceRestore: 'space.restore',
  bookMemberAdd: 'book.member.add',
  bookMemberRemove: 'book.member.remove',
  export: 'data.export',
  offboard: 'user.offboard',
  passwordChange: 'user.password.change',
  trashPurge: 'doc.purge',
  settingsChange: 'book.settings.change',
  tokenCreate: 'token.create',
  tokenRevoke: 'token.revoke',
  docShare: 'doc.share',
  trashPurgeAll: 'trash.purge-all',
  roleChange: 'user.role.change',
  attachmentDelete: 'attachment.delete',
  attachmentDetach: 'attachment.detach',
  /** 删除知识库（连带它下面所有文档，不可恢复）—— 同一批不可逆操作里**影响最大**的一个 */
  bookDelete: 'book.delete',
  /**
   * 知识库邀请（2026-10-11）。
   * 四个动作都留痕：出事时第一句要问的是
   * 「谁把他拉进来的 / 他什么时候同意的 / 谁撤回了」。
   */
  bookInviteSend: 'book.invite.send',
  bookInviteAccept: 'book.invite.accept',
  bookInviteDecline: 'book.invite.decline',
  bookInviteRevoke: 'book.invite.revoke',
} as const

/** 界面上要显示的中文说法。服务端不认识的中文名只在前端兜底显示原值。 */
export const AUDIT_LABEL: Record<string, string> = {
  [AUDIT.spaceMemberAdd]: '加入空间成员',
  [AUDIT.spaceMemberRemove]: '移出空间成员',
  [AUDIT.spaceDelete]: '删除空间',
  [AUDIT.spaceRestore]: '撤销删除空间',
  [AUDIT.bookMemberAdd]: '添加知识库成员',
  [AUDIT.bookMemberRemove]: '移除知识库成员',
  [AUDIT.export]: '导出数据',
  [AUDIT.offboard]: '办理离职',
  [AUDIT.passwordChange]: '修改密码',
  [AUDIT.trashPurge]: '彻底删除',
  [AUDIT.settingsChange]: '修改知识库设置',
  [AUDIT.tokenCreate]: '创建访问令牌',
  [AUDIT.tokenRevoke]: '撤销访问令牌',
  [AUDIT.docShare]: '修改对外分享设置',
  [AUDIT.trashPurgeAll]: '清空回收站',
  [AUDIT.roleChange]: '修改成员角色',
  [AUDIT.attachmentDelete]: '删除附件',
  [AUDIT.attachmentDetach]: '从文档撤下附件引用',
  [AUDIT.bookDelete]: '删除知识库',
  /*
   * 知识库邀请（2026-10-11）。
   *
   * ⚠️ 这四条必须有中文名 —— 审计页显示的是 AUDIT_LABEL，
   *    缺了就直接显示 `book.invite.send` 这种标识符，
   *    而审计页是给「出事了查是谁动的」的人看的，
   *    给不认识的开发者看等于没做。
   *    （是 test-auditgap 的「每个动作都有中文名」那条抓到的。）
   */
  [AUDIT.bookInviteSend]: '发出知识库邀请',
  [AUDIT.bookInviteAccept]: '接受知识库邀请',
  [AUDIT.bookInviteDecline]: '拒绝知识库邀请',
  [AUDIT.bookInviteRevoke]: '撤回知识库邀请',
}

export function logAudit(opts: {
  actorId: string
  action: string
  targetType?: string
  targetId?: string
  targetName?: string
  detail?: unknown
}) {
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(opts.actorId) as Row | undefined
  db.prepare(
    'INSERT INTO audit_log (id,at,actorId,actorName,action,targetType,targetId,targetName,detail) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(
    'al_' + randomBytes(8).toString('hex'),
    Date.now(),
    opts.actorId || '',
    String(row?.name || ''),
    opts.action,
    opts.targetType || '',
    opts.targetId || '',
    opts.targetName || '',
    opts.detail == null ? '' : JSON.stringify(opts.detail),
  )
}

/**
 * 读日志。**只给平台管理员**。
 *
 * 日志里能看到「谁给谁开了权限」「谁导出了整个工作台」——
 * 这本身就是敏感信息，普通成员拿到等于拿到了一份权限地图。
 */
/**
 * 「我的安全记录」（语雀的「帐户安全 → 安全记录」）。
 *
 * 语雀那边和安全记录并排的是「登录设备」，原文是「系统会记录下你的帐户相关的操作，
 * 比如修改了密码，绑定了邮箱」。而本项目的 `/api/audit` **只给管理员** ——
 * 理由很正当：日志里能看到「谁给谁开了权限」「谁导出了整个工作台」，
 * 普通成员拿到它等于拿到一份权限地图。
 *
 * 于是缺的那一半是：**普通成员看不到自己做过什么**。
 * 这一条补的正是这一半，而且刻意做得很窄。
 *
 * 三条不能省的约束：
 *  ① **只认「我就是当事人」的那几类动作**（改密码 / 建令牌 / 撤令牌），
 *     不是「我的全部操作历史」—— 后者会顺带把「我删过哪些文档」也发出去。
 *  ② `actorId` **永远取 me.id，不从 query 读**。
 *     这条是全部安全性的所在：只要它接受 `?actorId=别人`，
 *     一个普通成员就能读到任意人的日志，管理员那道闸门等于白设。
 *  ③ `detail` 只在上面那三类里下发，且每一类的 detail 都已逐个核过是安全的
 *     （改密码只记清掉几个会话；建令牌的**明文绝不入审计**，只留 scopes/expiresAt/prefix，
 *     而 prefix 本来就在令牌列表里给用户看）。
 *     加新动作到白名单时，**必须重新核它的 detail** —— `test-security-settings` 里那条
 *     「白名单每一项的 detail 都核过」的断言会盯着。
 */
const MY_SECURITY_ACTIONS: string[] = [AUDIT.passwordChange, AUDIT.tokenCreate, AUDIT.tokenRevoke]
export const MY_SECURITY_ACTION_LIST = MY_SECURITY_ACTIONS

export function readMySecurityLog(userId: string, limit = 50) {
  const rows = db.prepare(
    `SELECT id, at, action, targetType, targetId, targetName, detail
     FROM audit_log
     WHERE actorId = ? AND action IN (${MY_SECURITY_ACTIONS.map(() => '?').join(',')})
     ORDER BY at DESC LIMIT ?`,
  ).all(userId, ...MY_SECURITY_ACTIONS, Math.min(Math.max(Number(limit) || 50, 1), 100)) as Row[]
  return rows.map((r) => ({
    at: Number(r.at),
    action: String(r.action),
    label: AUDIT_LABEL[String(r.action)] || String(r.action),
    targetType: String(r.targetType || ''),
    targetName: String(r.targetName || ''),
    detail: r.detail ? safeParse(String(r.detail)) : null,
  }))
}

export function readAudit(opts: { limit?: number; action?: string; actorId?: string }) {
  const where: string[] = []
  const args: any[] = []
  if (opts.action) { where.push('action = ?'); args.push(opts.action) }
  if (opts.actorId) { where.push('actorId = ?'); args.push(opts.actorId) }
  const sql =
    `SELECT id, at, actorId, actorName, action, targetType, targetId, targetName, detail
     FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY at DESC LIMIT ?`
  // 上限写死：这是审计不是业务查询，没有「给我全部一万条」这种用法，
  // 而一个能拉走全部日志的接口迟早被人拿去导数据。
  args.push(Math.min(Math.max(Number(opts.limit) || 100, 1), 500))
  const rows = db.prepare(sql).all(...args) as Row[]
  return rows.map((r) => ({
    id: String(r.id),
    at: Number(r.at),
    actorId: String(r.actorId || ''),
    actorName: String(r.actorName || ''),
    action: String(r.action),
    targetType: String(r.targetType || ''),
    targetId: String(r.targetId || ''),
    targetName: String(r.targetName || ''),
    detail: r.detail ? safeParse(String(r.detail)) : null,
  }))
}

function safeParse(s: string) {
  try { return JSON.parse(s) } catch { return null }
}
