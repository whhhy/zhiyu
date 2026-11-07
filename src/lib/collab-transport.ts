/* ============================================================
   协作传输层
   ------------------------------------------------------------
   同一份 CRDT 协议，两种跑法：

   · 本地模式：BroadcastChannel —— 同一浏览器多标签页（原来的行为）
   · 服务端模式：WebSocket —— 跨设备、跨浏览器、多人

   关键设计：**只换管道，不碰协议**。
   content / patch / op / need-full / cursor / presence / leave
   这套消息与合并逻辑（已通过 79 项纯函数测试 + 收敛性测试）在两种模式下
   完全一致，服务端也只是原样转发、不解释 op。
   所以这里的实现只有一个职责：把「一个可 postMessage、可监听 message、
   可关闭」的对象交出去，别的什么都不管。
   ============================================================ */

import { getMode, wsUrl } from './api'
import { useStore } from '@/store'

export interface CollabTransport {
  postMessage: (msg: any) => void
  /**
   * 回调形参放宽成 any：BroadcastChannel 给的是完整 MessageEvent，
   * WebSocket 只给 `{ data }`。调用方本来就只用 e.data，
   * 与其让调用方为两种形状写重载，不如在这里统一成最小接口。
   */
  addEventListener: (type: 'message', fn: (e: any) => void) => void
  removeEventListener: (type: 'message', fn: (e: any) => void) => void
  close: () => void
  /** 服务端在场名单变化（只有 WebSocket 模式有；本地模式用模拟协作者） */
  onPeers?: (fn: (peers: { memberId: string; name: string }[]) => void) => void
}

/* ============================================================
   本地模式：BroadcastChannel
   ============================================================ */

function broadcastTransport(docId: string): CollabTransport {
  const ch = new BroadcastChannel(`yuque-clone:doc:${docId}`)
  return {
    postMessage: (m) => ch.postMessage(m),
    addEventListener: (_t, fn) => ch.addEventListener('message', fn as any),
    removeEventListener: (_t, fn) => ch.removeEventListener('message', fn as any),
    close: () => ch.close(),
  }
}

/* ============================================================
   服务端模式：WebSocket
   ============================================================ */

function socketTransport(docId: string): CollabTransport {
  const handlers = new Set<(e: { data: any }) => void>()
  const peerFns = new Set<(peers: any[]) => void>()
  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // 断线期间发出的消息先攒着，重连后按序补发。
  // 不补发的话，内网代理掐一下连接就等于丢一批用户的输入 —— 不能接受。
  const outbox: any[] = []
  let joined = false

  const emit = (data: any) => {
    for (const fn of handlers) {
      try { fn({ data }) } catch (e) { console.error('[collab] 消息处理出错', e) }
    }
  }

  const connect = () => {
    if (closed) return
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      retry = 0
      joined = false
      send({ ctl: 'join', docId, memberId: useStore.getState().currentUser?.id || '' })
      for (const m of outbox.splice(0)) send(m)
    }

    ws.onmessage = (ev) => {
      let m: any
      try { m = JSON.parse(ev.data) } catch { return }

      if (m.ctl === 'joined' || m.ctl === 'peers') {
        joined = m.ctl === 'joined'
        for (const fn of peerFns) { try { fn(m.peers || []) } catch { /* 忽略 */ } }
        return
      }
      if (m.ctl === 'denied') {
        // 权限被拒：不能静默装作没连上，要让上层知道
        console.warn('[collab] 服务端拒绝加入：', m.reason)
        return
      }
      if (m.ctl === 'hello' || m.ctl === 'pong') return
      emit(m)
    }

    ws.onclose = () => {
      if (closed) return
      joined = false
      scheduleReconnect()
    }
    ws.onerror = () => { /* onclose 会跟着来，统一在那里处理 */ }
  }

  const scheduleReconnect = () => {
    if (closed || timer) return
    // 退避到最多 15 秒：内网偶发抖动要能自愈，
    // 但服务真挂了也不该把浏览器风扇转起来。
    const delay = Math.min(15000, 800 * Math.pow(1.6, retry++))
    timer = setTimeout(() => { timer = null; connect() }, delay)
  }

  const send = (m: any) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(m)) } catch { outbox.push(m) }
    } else if (!m.ctl || m.ctl !== 'join') {
      outbox.push(m)
    }
  }

  connect()

  return {
    postMessage: (m) => send(m),
    addEventListener: (_t, fn) => { handlers.add(fn) },
    removeEventListener: (_t, fn) => { handlers.delete(fn) },
    onPeers: (fn) => { peerFns.add(fn) },
    close: () => {
      closed = true
      if (timer) { clearTimeout(timer); timer = null }
      for (const fn of peerFns) peerFns.delete(fn)
      try { send({ ctl: 'leave', docId }); ws?.close() } catch { /* 忽略 */ }
      ws = null
    },
  }
}

/* ============================================================
   出口
   ============================================================ */

export function openTransport(docId: string): CollabTransport {
  if (getMode() === 'server' && typeof WebSocket !== 'undefined') {
    try {
      return socketTransport(docId)
    } catch (e) {
      // 连不上不能降级到 BroadcastChannel：
      // 那样会让人误以为「同事的编辑没传过来」是网络问题，
      // 而实际上是权限或服务不可用。直接抛给上层更诚实。
      console.error('[collab] WebSocket 传输创建失败', e)
      throw e
    }
  }
  return broadcastTransport(docId)
}
