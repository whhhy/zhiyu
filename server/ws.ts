/* ============================================================
   WebSocket 实时中继 —— 让协同从「同一浏览器的多个标签页」变成「跨设备」

   设计要点：**服务端不懂 CRDT，也不做内容合并。**
   合并已经在每个客户端的 CRDT 层完成（79 项纯函数测试 + 收敛性测试钉着它）。
   服务端只做三件事：
     1. 鉴权（token → user）
     2. 按 docId 分房间，把消息原样转发给房间里的其他人
     3. 维护在场名单，新人进来时告诉他「房里还有谁」

   为什么坚持「不解析 ops」：
   一旦服务端也要理解并合并 op，就等于凭空多出第二套仲裁规则，
   而两套规则对同一个冲突给出不同答案时，客户端会立刻分叉。
   保持服务端无状态是这里最重要的正确性约束。

   落库走另一条路（REST 同步引擎），不在这里写 ——
   见 server/sync.ts 顶部「分工」一节。
   ============================================================ */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Server } from 'node:http'
import { userFromToken, extractToken, clientIp } from './auth.ts'
import { capsOfDoc, ipAllowed, bookIdOfDoc, lockedByOther } from './perms.ts'
import type { User } from './perms.ts'
import { db } from './db.ts'
import type { Row } from './db.ts'

interface Client {
  ws: WebSocket
  user: User
  docId: string | null
  memberId: string
  /** 连接级标识，用于在场名单里区分「同一个人的两个设备」 */
  socketId: string
}

/** docId → 房间成员 */
const rooms = new Map<string, Set<Client>>()
/** 活动 socket 集合，供广播「谁在线」用 */
const clients = new Set<Client>()

function send(c: Client, payload: any) {
  if (c.ws.readyState !== WebSocket.OPEN) return
  try { c.ws.send(JSON.stringify(payload)) } catch { /* 连接已断，交给 close 处理 */ }
}

function peersOf(docId: string, exclude?: Client): any[] {
  const room = rooms.get(docId)
  if (!room) return []
  const out: any[] = []
  for (const c of room) {
    if (c === exclude) continue
    out.push({ memberId: c.memberId, name: c.user.name, socket: c.socketId })
  }
  return out
}

function broadcastToRoom(docId: string, payload: any, exclude?: Client) {
  const room = rooms.get(docId)
  if (!room) return
  for (const c of room) {
    if (c === exclude) continue
    send(c, payload)
  }
}

function joinRoom(c: Client, docId: string) {
  if (c.docId) leaveRoom(c)
  c.docId = docId
  let room = rooms.get(docId)
  if (!room) { room = new Set(); rooms.set(docId, room) }
  room.add(c)

  // 告诉新人房里现在有谁；再告诉其他人有人来了
  send(c, { ctl: 'joined', docId, peers: peersOf(docId, c) })
  broadcastToRoom(docId, { ctl: 'peers', docId, peers: peersOf(docId) }, c)
}

function leaveRoom(c: Client) {
  const docId = c.docId
  if (!docId) return
  c.docId = null
  const room = rooms.get(docId)
  if (!room) return
  room.delete(c)
  if (room.size === 0) {
    rooms.delete(docId)
    // 最后一个订阅者走了，把还挂着的定时器停掉，别让进程空转到天荒地老
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
    dirty.clear()
    return
  }
  broadcastToRoom(docId, { ctl: 'peers', docId, peers: peersOf(docId) })
}

/* ============================================================
   快照落库
   客户端发来的 content 消息里带完整 blocks，
   服务端顺手存一份「每个作者各自的最新状态」，**只进 doc_snapshots 表**。

   这里刻意**不**回写 docs.blocks。
   docs 的唯一写入方是同步引擎（REST push），而 WebSocket 层是纯中继 ——
   一旦让它也写正文，就等于凭空多出第二个写入方，
   而两者对「什么算最新内容」的判断并不相同。

   踩过：早先这里把快照 `JSON.stringify({blocks, title})` 整个塞进 docs.blocks，
   结果每有一个订阅者退出，这篇文档的正文就被换成了一个包装对象：
   `{"blocks":[...],"title":"..."}`。客户端拿到它时 `Array.isArray` 为 false，
   整个文档页白屏。
   而且它是在「房间空了、5 秒后刷盘」时才发作 —— 平时根本复现不出来。
   ============================================================ */

let flushTimer: ReturnType<typeof setInterval> | null = null
const dirty = new Set<string>()

function markDirty(docId: string) {
  dirty.add(docId)
  if (!flushTimer) flushTimer = setInterval(flushSnapshots, 5000)
}

function flushSnapshots() {
  // 注意用的是 flushTimer，不是早先那个 FLUSH_TIMER —— 后者不存在，
  // 这行只在「没有待写内容」时才走到，平时跑不到，
  // 于是一直潜伏到某个订阅者退出、真的触发时才把整个进程带崩。
  if (!dirty.size) { clearInterval(flushTimer!); flushTimer = null; return }
  // 只做 housekeeping：这里**不写 docs**。
  // doc_snapshots 已经是按 docId+actorId 存好的，运维可以直接查；
  // 真正的正文由 REST 同步引擎落库。
  dirty.clear()
}

function storeSnapshot(docId: string, actorId: string, payload: any) {
  try {
    // 只存 blocks 本身。早先这里连 title 一起包成 {blocks,title} 再写进 docs.blocks，
    // 直接把正文换成了一个包装对象。现在写进的是 doc_snapshots.data，
    // 没有任何别的代码会把它当成正文用。
    db.prepare(`INSERT INTO doc_snapshots (docId, actorId, data, clock, at) VALUES (?,?,?,?,?)
                ON CONFLICT(docId, actorId) DO UPDATE SET data = excluded.data, clock = excluded.clock, at = excluded.at`)
      .run(docId, actorId, JSON.stringify(payload.blocks ?? []), Number(payload.rev) || 0, Date.now())
    markDirty(docId)
  } catch {
    /* 存快照失败不影响转发 */
  }
}

/* ============================================================
   连接处理
   ============================================================ */

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/ws') { socket.destroy(); return }
    // token 走 query：浏览器 WebSocket API 不能自定义 header
    const token = url.searchParams.get('token') || extractToken(req)
    const user = userFromToken(token)
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user)
    })
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, user: User) => {
    const c: Client = {
      ws, user, docId: null, memberId: user.id,
      socketId: Math.random().toString(36).slice(2, 10),
    }
    /*
     * 这次连接**从哪来**。
     *
     * IP 白名单问的是「请求从哪来」，它是网络层的判断 ——
     * 而 WS 是与 HTTP **完全独立的一条通路**，以前这里只判了文档权限。
     * 后果实测（探针，2026-10-06）：同一个人、同一个 IP，
     *   `/api/doc/:id`      → 403「当前 IP 不在该知识库的白名单内」
     *   WebSocket 协作房间  → **完整收到了别人对那篇的实时编辑**
     * 白名单写着「本资料不出内网」，而实时通道等于没设防。
     *
     * 这是同一个家族的第三处：7.29 补过 `/api/export`，7.31 补过
     * `/api/sync/changes` —— 每一次都是「那条通路压根不经过上一次的判据」。
     * 凡是「按知识库访问」的入口都得自己判一次，包括这条。
     *
     * 在**连接建立时**取一次就够，和文档读权限同一个时机：
     * 连接是短的，权限中途变化本来也要靠下一次 join 才会生效。
     */
    const ip = clientIp(req)
    clients.add(c)

    send(c, { ctl: 'hello', user: { id: user.id, name: user.name }, socketId: c.socketId })

    ws.on('message', (raw) => {
      let m: any
      try { m = JSON.parse(String(raw)) } catch { return }

      if (m.ctl === 'join') {
        const docId = String(m.docId || '')
        if (!docId) return
        // 每次加入都要重新判权限：文档可能被移出你的知识库
        const caps = capsOfDoc(user, docId)
        if (!caps.read) { send(c, { ctl: 'denied', docId, reason: '没有阅读该文档的权限' }); return }
        if (!ipAllowed(bookIdOfDoc(docId), ip)) {
          send(c, { ctl: 'denied', docId, reason: `当前 IP（${ip}）不在该知识库的白名单内` })
          return
        }
        c.memberId = String(m.memberId || user.id)
        joinRoom(c, docId)
        return
      }

      if (m.ctl === 'leave') { leaveRoom(c); return }
      if (m.ctl === 'ping') { send(c, { ctl: 'pong', ts: Date.now() }); return }

      // 其余一律当作协作消息原样转发
      const docId = c.docId
      if (!docId) return
      // 房间是按 docId 建的，消息里的 docId 必须与之一致，防止串房
      if (m.docId && m.docId !== docId) return

      // 写权限：只读的人不能靠伪造 op 改内容。
      // 转发本身拦不住恶意客户端，服务端至少要把「写」的资格卡住。
      const isWrite = m.kind === 'op' || m.kind === 'content' || m.kind === 'patch'
      if (isWrite) {
        const caps = capsOfDoc(user, docId)
        if (!caps.edit) return
        /*
         * 文档锁 —— 和上面那条 `edit` 是**两件事**。
         *
         * 落库那条路（`denyReason`）一直判着，而这里以前只判 `edit` ——
         * 于是「没持有锁但有编辑权」的人可以经协作通道往房间里塞内容：
         * 持有者的客户端是 CRDT 合并，会把它应用进去；等他一保存，
         * **塞进来的字就落库了**，而界面上他看到的是「我自己在打字」。
         * 消息还会被 `storeSnapshot` 写进 `doc_snapshots`，落一个持久化的脚。
         *
         * 实测（探针，2026-10-06）见 perms.ts `lockedByOther` 那段注释。
         *
         * 逐条消息判（而不是 join 时判一次）—— 锁是可以在 join **之后**
         * 才被拿走的；而 `edit` 也是逐条判的，两边口径一致。
         */
        const holder = db.prepare('SELECT lockMemberId FROM docs WHERE id = ?').get(docId) as Row | undefined
        if (lockedByOther(holder?.lockMemberId, user.id)) return
        if (m.kind === 'content') storeSnapshot(docId, user.id, m)
      }
      broadcastToRoom(docId, m, c)
    })

    ws.on('close', () => { leaveRoom(c); clients.delete(c) })
    ws.on('error', () => { leaveRoom(c); clients.delete(c) })
  })

  // 心跳：内网可能有 NAT / 代理会掐掉空闲连接
  setInterval(() => {
    for (const c of clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.ping() } catch { /* 忽略 */ }
      }
    }
  }, 30000).unref?.()

  return wss
}

/** 运维接口：当前在线的人与房间 */
export function presence() {
  const out: any[] = []
  for (const [docId, room] of rooms) {
    out.push({ docId, members: [...room].map((c) => ({ id: c.user.id, name: c.user.name })) })
  }
  return out
}
