/* ============================================================
   首次启动播种
   把前端的演示数据（src/data/seed.ts）导入 SQLite，
   而不是在这里另抄一份 —— 改了前端种子，这里的内容自动跟着变。

   同时建立第一个管理员账号。账号信息可用环境变量覆盖，
   避免出现「所有内网部署的默认密码都一样」这种常见事故。
   ============================================================ */

import { db } from './db.ts'
import { hashPassword } from './auth.ts'
import { reindex } from './sync.ts'
import type { Row } from './db.ts'

export interface SeedReport {
  users: number
  spaces: number
  books: number
  nodes: number
  docs: number
  adminAccount: string
  adminPassword: string
}

export function isEmpty(): boolean {
  const r = db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row
  return Number(r.n) === 0
}

/**
 * 播种。
 * demo=true 时导入演示内容（2 空间 / 4 知识库 / 26 文档 / 32 目录节点）；
 * 正式部署可传 demo=false，只建管理员账号与一个空的空间。
 */
export async function seed(opts: { demo: boolean; adminAccount: string; adminPassword: string; adminName: string }): Promise<SeedReport> {
  const now = Date.now()

  /* ---- 1. 管理员 ---- */
  const { hash, salt } = hashPassword(opts.adminPassword)
  const adminId = 'u_admin'
  db.prepare(`INSERT INTO users (id, name, account, email, avatar, passHash, passSalt, role, createdAt)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(adminId, opts.adminName, opts.adminAccount, '', '', hash, salt, 'owner', now)

  const report: SeedReport = {
    users: 1, spaces: 0, books: 0, nodes: 0, docs: 0,
    adminAccount: opts.adminAccount, adminPassword: opts.adminPassword,
  }
  if (!opts.demo) {
    /**
     * 关闭演示内容时，仍然给管理员建一个**空的个人空间**。
     *
     * 以前这里是直接 `return report`，于是 YQ_DEMO=0 的全新部署：
     * 零个空间、零个知识库 —— 而前端**没有新建空间的入口**
     * （spaces 是只读的，没有任何 create action）。
     * 结果就是管理员登录后看到一片空白，且没有任何办法往前走。
     *
     * 「正式部署不要演示数据」是最正常的诉求，
     * 而按字面实现会得到一个不能用的系统 —— 这比留着演示数据更糟。
     * 有了这个个人空间，管理员进去就能建知识库；演示内容一条也没有。
     */
    const sid = `sp_${adminId}`
    db.prepare('INSERT INTO spaces (id,name,desc,avatar,kind,createdAt,rev,updatedBy) VALUES (?,?,?,?,?,?,0,?)')
      .run(sid, `${opts.adminName} 的空间`, '', '', 'personal', now, adminId)
    db.prepare('INSERT INTO space_members (spaceId,userId,role,joinedAt) VALUES (?,?,?,?)')
      .run(sid, adminId, 'owner', now)
    report.spaces = 1
    return report
  }

  /* ---- 2. 演示内容 ---- */
  const { createSeedData } = await import('../src/data/seed.ts')
  const data = createSeedData()

  // 种子里的成员变成真实账号：口令统一为 adminPassword 的哈希派生值，
  // 这样切到「切换演示身份」也能用密码登录，方便多人联调。
  const memberToUser = new Map<string, string>()
  for (const m of data.members) {
    const uid = `u_${m.id}`
    memberToUser.set(m.id, uid)
    const pw = hashPassword(opts.adminPassword, salt)
    db.prepare(`INSERT INTO users (id, name, account, email, avatar, passHash, passSalt, role, createdAt)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(uid, m.name, m.id, '', m.avatar || '', pw.hash, salt, 'member', now)
  }
  report.users = data.members.length + 1

  // 当前登录身份换成管理员，种子里的 id 原样保留
  data.currentUser = { ...data.currentUser, id: adminId, name: opts.adminName, account: opts.adminAccount, role: 'owner' }

  const ins = {
    space: db.prepare('INSERT INTO spaces (id,name,desc,avatar,kind,createdAt,rev,updatedBy) VALUES (?,?,?,?,?,?,0,?)'),
    spaceMember: db.prepare('INSERT OR IGNORE INTO space_members (spaceId,userId,role,joinedAt) VALUES (?,?,?,?)'),
    book: db.prepare('INSERT INTO books (id,spaceId,name,desc,avatar,visibility,createdAt,updatedAt,rev,updatedBy) VALUES (?,?,?,?,?,?,?,?,0,?)'),
    bookMember: db.prepare('INSERT OR IGNORE INTO book_members (bookId,userId,role,perms,joinedAt) VALUES (?,?,?,?,?)'),
    settings: db.prepare(`INSERT OR IGNORE INTO book_settings (bookId,restrictExport,watermark,watermarkText,ipWhitelist,ipList,autoRevoke,publicAccess,defaultWidth,defaultVisibility,newDocPosition)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    node: db.prepare('INSERT INTO nodes (id,bookId,parentId,title,type,icon,docId,ord,hidden,rev,updatedBy) VALUES (?,?,?,?,?,?,?,?,?,0,?)'),
    doc: db.prepare(`INSERT INTO docs (id,type,title,body,blocks,authorId,createdAt,updatedAt,wordCount,visibility,published,tags,sheetData,lockMemberId,lockAt,spaceId,bookId,rev,updatedBy)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,0,?)`),
    comment: db.prepare('INSERT INTO comments (id,docId,authorId,text,createdAt,anchorId,rev) VALUES (?,?,?,?,?,?,0)'),
    note: db.prepare('INSERT INTO notes (id,spaceId,text,authorId,createdAt,likes,tags,image,rev) VALUES (?,?,?,?,?,?,?,?,0)'),
    topic: db.prepare('INSERT INTO topics (id,spaceId,title,authorId,createdAt,replyCount,participants,hot,rev) VALUES (?,?,?,?,?,?,?,?,0)'),
    template: db.prepare('INSERT INTO templates (id,name,desc,scope,bookId,spaceId,icon,body,category,createdAt,usedCount,ownerId,rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)'),
    fav: db.prepare('INSERT OR IGNORE INTO favorites (id,userId,targetType,targetId,title,createdAt) VALUES (?,?,?,?,?,?)'),
  follow: db.prepare('INSERT OR IGNORE INTO follows (id,userId,targetType,targetId,createdAt) VALUES (?,?,?,?,?)'),
    sel: db.prepare('INSERT INTO selection_comments (id,docId,authorId,quote,blockId,text,createdAt,resolved,rev) VALUES (?,?,?,?,?,?,?,?,0)'),
  }

  const uid = (m: string | undefined) => (m ? memberToUser.get(m) || adminId : adminId)
  const mapSpace = new Map<string, string>()

  db.exec('BEGIN')
  try {
    /* 空间 */
    for (const s of data.spaces) {
      ins.space.run(s.id, s.name, s.desc || '', s.avatar || '', s.kind, s.createdAt || now, adminId)
      report.spaces++
      mapSpace.set(s.id, s.id)
      if (s.id === 's1') {
        // 管理员是第一个空间的主人，这样默认能看到全部演示内容
        ins.spaceMember.run(s.id, adminId, 'owner', now)
        for (const m of data.members) {
          ins.spaceMember.run(s.id, uid(m.id), 'member', now)
        }
      }
    }
    // 个人空间归属到管理员本人
    for (const s of data.spaces) {
      if (s.kind === 'personal') ins.spaceMember.run(s.id, adminId, 'owner', now)
    }

    /* 知识库 */
    const bookToSpace = new Map<string, string>()
    for (const b of data.books) {
      const sid = mapSpace.get(b.spaceId) || b.spaceId
      bookToSpace.set(b.id, sid)
      ins.book.run(b.id, sid, b.name, b.desc || '', b.avatar || '', b.visibility || 'space', b.createdAt || now, b.updatedAt || now, adminId)
      report.books++
      ins.bookMember.run(b.id, adminId, 'owner', JSON.stringify({ read: 1, comment: 1, edit: 1, create: 1, export: 1, share: 1 }), now)
    }

    /* 知识库设置 + 成员 */
    // 前端是「用到才生成」默认设置，库里一开始是空的。
    // 但服务端要用 book_settings.publicAccess 判公开访问、
    // 用 ipWhitelist/ipList 判 IP 白名单 —— 缺行会被当成「没配置」，
    // 所以这里必须给每个知识库补一条默认行。
    const { defaultBookSettings } = await import('../src/data/settings.ts')
    for (const b of data.books) {
      const s = (data.bookSettings as any)?.[b.id] || defaultBookSettings()
      ins.settings.run(b.id, s.restrictExport ? 1 : 0, s.watermark ? 1 : 0, s.watermarkText || '',
        s.ipWhitelist ? 1 : 0, JSON.stringify(s.ipList || []), s.autoRevoke === false ? 0 : 1,
        s.publicAccess ? 1 : 0, s.defaultWidth || 'standard', s.defaultVisibility || 'space',
        s.newDocPosition === 'bottom' ? 'bottom' : 'top')
    }
    // 种子里显式带了的设置覆盖默认值
    for (const [bookId, s] of Object.entries(data.bookSettings || {})) {
      ins.settings.run(bookId, s.restrictExport ? 1 : 0, s.watermark ? 1 : 0, s.watermarkText || '',
        s.ipWhitelist ? 1 : 0, JSON.stringify(s.ipList || []), s.autoRevoke === false ? 0 : 1,
        s.publicAccess ? 1 : 0, s.defaultWidth || 'standard', s.defaultVisibility || 'space',
        s.newDocPosition === 'bottom' ? 'bottom' : 'top')
    }
    for (const [bookId, list] of Object.entries(data.bookMembers || {})) {
      for (const bm of list) {
        const perm = { read: !!bm.perms?.read, comment: !!bm.perms?.comment, edit: !!bm.perms?.edit, create: !!bm.perms?.create, export: !!bm.perms?.export, share: !!bm.perms?.share }
        ins.bookMember.run(bookId, uid(bm.id), bm.role, JSON.stringify(perm), bm.joinedAt || now)
      }
    }

    /* 目录节点 */
    for (const n of data.nodes) {
      ins.node.run(n.id, n.bookId, n.parentId, n.title, n.type, n.icon || '', n.docId || null, n.order ?? 0, n.hidden ? 1 : 0, adminId)
      report.nodes++
    }

    /* 文稿 */
    const nodeBook = new Map<string, string>()
    for (const n of data.nodes) if (n.docId) nodeBook.set(n.docId, n.bookId)
    for (const [id, d] of Object.entries(data.docs)) {
      const bookId = nodeBook.get(id) || null
      ins.doc.run(id, d.type || 'doc', d.title || '', d.body || '', JSON.stringify(d.blocks || []),
        uid(d.authorId), d.createdAt || now, d.updatedAt || now, d.wordCount || 0,
        d.visibility || 'space', d.published ? 1 : 0, JSON.stringify(d.tags || []),
        d.sheetData ? JSON.stringify(d.sheetData) : null, bookId ? bookToSpace.get(bookId) : null, bookId, adminId)
      report.docs++
    }

    /* 评论 / 小记 / 话题 / 模板 / 收藏 / 划词评论 */
    for (const list of Object.values(data.comments || {})) {
      for (const c of list as any[]) {
        ins.comment.run(c.id, c.docId, uid(c.authorId), c.text || '', c.createdAt || now, c.anchorId || null)
        for (const rp of c.replies || []) {
          db.prepare('INSERT INTO comment_replies (id,commentId,authorId,text,createdAt) VALUES (?,?,?,?,?)')
            .run(rp.id, c.id, uid(rp.authorId), rp.text || '', rp.createdAt || now)
        }
      }
    }
    for (const n of data.notes || []) {
      ins.note.run(n.id, n.spaceId, n.text || '', uid(n.authorId), n.createdAt || now, JSON.stringify(n.likes || []), JSON.stringify(n.tags || []), n.image || null)
    }
    for (const t of data.topics || []) {
      ins.topic.run(t.id, t.spaceId, t.title || '', uid(t.authorId), t.createdAt || now, t.replyCount || 0, JSON.stringify(t.participants || []), t.hot ? 1 : 0)
    }
    for (const t of data.templates || []) {
      ins.template.run(t.id, t.name || '', t.desc || '', t.scope || 'official', t.bookId || null, t.spaceId || null, t.icon || '', t.body || '', t.category || '', t.createdAt || now, t.usedCount || 0, uid(t.ownerId))
    }
    for (const f of data.favorites || []) {
      ins.fav.run(f.id, adminId, f.targetType, f.targetId, f.title || '', f.createdAt || now)
    }
    for (const f of data.follows || []) {
      ins.follow.run(f.id, adminId, f.targetType, f.targetId, f.createdAt || now)
    }
    for (const list of Object.values(data.selectionComments || {})) {
      for (const c of list as any[]) {
        ins.sel.run(c.id, c.docId, uid(c.authorId), c.quote || '', c.blockId || '', c.text || '', c.createdAt || now, c.resolved ? 1 : 0)
        for (const rp of c.replies || []) {
          db.prepare('INSERT INTO selection_comment_replies (id,selectionCommentId,authorId,text,createdAt) VALUES (?,?,?,?,?)')
            .run(rp.id, c.id, uid(rp.authorId), rp.text || '', rp.createdAt || now)
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  // 建检索索引：播种走的是批量 INSERT，没经过 upsertRow
  for (const id of Object.keys(data.docs)) reindex('doc', id)
  for (const b of data.books) reindex('book', b.id)
  for (const n of data.notes || []) reindex('note', n.id)

  return report
}
