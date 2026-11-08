/**
 * WebSocket 客户端传输(web-migration-plan.md §6.1/§6.2,与服务端 src/server/ws.ts 对偶):
 * - 连接同源 /ws;hello({serverId,connectionId})到达前收到的 event 先入缓冲,hello 后按序分发。
 * - 重连:1–10 秒带抖动指数退避;关闭码 4401 = 会话过期,停止重连并触发过期回调;
 *   1001(服务端停机)/异常断开照常重连(服务端重启后由快照机制恢复状态)。
 * - 心跳:每 25s 发应用层 {v:1,type:'ping'},上一轮未收到 pong 即判定死链,强制断开重连。
 *   (浏览器无法主动发协议层 ping/pong,与服务端 25s 协议层 ping 互补。)
 * - 事件缓冲:仅缓冲 hello 前到达的事件,上限 5,000 条 / 8 MiB;溢出丢弃缓冲、置重同步标志,
 *   hello 后触发 onResync(由 P4 快照恢复逻辑重新 attachSession),不应用残缺的旧事件。
 * - 上行仅 send 白名单三通道(terminal:input/resize/dispose)与应用层 ping;未连接时丢弃
 *   (终端输入断线不重放,服务端在连接销毁时兜底回收 PTY)。
 * - 事件按 channel(c)分发;需要 stream/seq 做快照对账的消费方走 onRaw(P4 对接点)。
 */

/** 服务端 hello 信封(src/server/ws.ts onConnection)。 */
export interface WsHelloMessage {
  v: 1
  type: 'hello'
  serverId: string
  connectionId: string
}

/** 服务端事件信封:stream = 'shared' | 'notify' | 'chat:<sid>' | '<channel>:<id>' 等。 */
export interface WsEventMessage {
  v: 1
  type: 'event'
  stream: string
  seq: number
  c: string
  a: unknown[]
}

/** 应用层 pong(src/server/ws.ts onMessage:type='ping' → 回 pong)。 */
export interface WsControlMessage {
  v: 1
  type: 'pong'
}

export type WsInboundMessage = WsHelloMessage | WsEventMessage | WsControlMessage

/** 会话过期的 WebSocket 关闭码(应用段 4000-4999,与服务端 CLOSE_AUTH_EXPIRED 对齐)。 */
export const WS_CLOSE_AUTH_EXPIRED = 4401

const HEARTBEAT_INTERVAL_MS = 25_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 10_000
/** 事件缓冲上限:条数与字节数(plan §6.2 #8:5,000 条或 8 MiB)。 */
const BUFFER_MAX_ITEMS = 5_000
const BUFFER_MAX_BYTES = 8 * 1024 * 1024

type EventListener = (args: unknown[]) => void

export class DevaSocket {
  private ws: WebSocket | null = null
  /** connecting:有未完成的连接尝试;open:hello 已到;closed:未启动/已永久关闭。 */
  private phase: 'closed' | 'connecting' | 'open' = 'closed'
  /** 是否要求保持连接(登录态)。false 时不重连。 */
  private wanted = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private awaitingPong = false

  /** hello 前的事件缓冲(有界)。 */
  private pending: WsEventMessage[] = []
  private pendingBytes = 0
  private bufferedOverflow = false

  private listeners = new Map<string, Set<EventListener>>()
  private rawCbs = new Set<(ev: WsEventMessage) => void>()
  private resyncCbs = new Set<() => void>()
  private expiredCbs = new Set<() => void>()

  /** 服务端 hello 分配的连接标识;invoke 携带它换取定向事件路由(terminal/git delta)。 */
  connectionId: string | null = null
  /** 服务端本次启动标识(快照对账用,P4)。 */
  serverId: string | null = null

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 启动连接并保持(登录成功后调用;幂等)。 */
  connect(): void {
    if (this.wanted) return
    this.wanted = true
    this.attempt = 0
    this.open()
  }

  /** 永久关闭(登出/过期):停止重连、清订阅与缓冲。 */
  close(): void {
    this.wanted = false
    this.clearTimers()
    this.phase = 'closed'
    const ws = this.ws
    this.ws = null
    if (ws) {
      // 4401 之外的常规关闭,避免触发 onclose 的重连逻辑(wanted 已 false,双保险)
      try {
        ws.onclose = null
        ws.close(1000, 'client logout')
      } catch {
        /* 已关闭 */
      }
    }
    this.resetBuffer()
    this.connectionId = null
    this.serverId = null
    this.listeners.clear()
    this.rawCbs.clear()
    this.resyncCbs.clear()
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private resetBuffer(): void {
    this.pending = []
    this.pendingBytes = 0
    this.bufferedOverflow = false
  }

  private open(): void {
    if (!this.wanted || this.ws) return
    this.phase = 'connecting'
    let ws: WebSocket
    try {
      // 同源 /ws(vite dev 经 proxy 转发;生产同源部署)
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${window.location.host}/ws`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onmessage = (ev: MessageEvent) => {
      this.onMessage(String(ev.data))
    }
    ws.onopen = () => {
      // hello 未到不算就绪;心跳从 hello 后开始(hello 超时由 onclose 兜底重连)
    }
    ws.onclose = (ev: CloseEvent) => {
      const wasAuth = ev.code === WS_CLOSE_AUTH_EXPIRED
      this.ws = null
      this.phase = 'closed'
      this.clearTimers()
      this.resetBuffer()
      this.connectionId = null
      this.serverId = null
      if (wasAuth) {
        // 会话过期/撤销:停止重连,交给过期回调统一处理(停请求、回登录页)
        this.wanted = false
        for (const cb of [...this.expiredCbs]) {
          try {
            cb()
          } catch (err) {
            console.error('[deva] 过期回调异常', err)
          }
        }
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose 随后触发,统一走重连 */
    }
  }

  /** 1–10 秒带抖动退避重连。 */
  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer !== null) return
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempt)
    const jittered = Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, base * (0.75 + Math.random() * 0.5)))
    this.attempt = Math.min(this.attempt + 1, 30)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, jittered)
  }

  private onMessage(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    if (m['v'] !== 1) return
    if (m['type'] === 'pong') {
      this.awaitingPong = false
      return
    }
    if (m['type'] === 'hello') {
      this.phase = 'open'
      this.attempt = 0
      this.awaitingPong = false
      this.connectionId = typeof m['connectionId'] === 'string' ? m['connectionId'] : null
      this.serverId = typeof m['serverId'] === 'string' ? m['serverId'] : null
      this.startHeartbeat()
      this.flushPending()
      return
    }
    if (m['type'] === 'event') {
      const ev: WsEventMessage = {
        v: 1,
        type: 'event',
        stream: typeof m['stream'] === 'string' ? m['stream'] : '',
        seq: typeof m['seq'] === 'number' ? m['seq'] : 0,
        c: typeof m['c'] === 'string' ? m['c'] : '',
        a: Array.isArray(m['a']) ? m['a'] : []
      }
      this.acceptEvent(ev)
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingPong) {
        // 上一轮 ping 未获 pong:判定死链,强制断开走重连
        try {
          this.ws?.close()
        } catch {
          /* 忽略 */
        }
        return
      }
      this.awaitingPong = true
      this.rawSend({ v: 1, type: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  // -------------------------------------------------------------------------
  // 事件缓冲与分发
  // -------------------------------------------------------------------------

  private acceptEvent(ev: WsEventMessage): void {
    if (this.phase !== 'open') {
      // hello 前:入有界缓冲;溢出丢弃全部缓冲并置重同步(残缺序列不应用)
      if (this.pending.length >= BUFFER_MAX_ITEMS || this.pendingBytes + approxBytes(ev) > BUFFER_MAX_BYTES) {
        this.bufferedOverflow = true
        this.resetBuffer()
        return
      }
      this.pending.push(ev)
      this.pendingBytes += approxBytes(ev)
      return
    }
    this.dispatch(ev)
  }

  private flushPending(): void {
    if (this.bufferedOverflow) {
      // 溢出过:不应用可能残缺的缓冲,交快照逻辑整体重取
      this.resetBuffer()
      for (const cb of [...this.resyncCbs]) {
        try {
          cb()
        } catch (err) {
          console.error('[deva] 重同步回调异常', err)
        }
      }
      return
    }
    const queued = this.pending
    this.resetBuffer()
    for (const ev of queued) this.dispatch(ev)
  }

  private dispatch(ev: WsEventMessage): void {
    if (!ev.c) return
    for (const cb of [...this.rawCbs]) {
      try {
        cb(ev)
      } catch (err) {
        console.error(`[deva] 原始事件监听异常(${ev.c})`, err)
      }
    }
    const set = this.listeners.get(ev.c)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(ev.a)
      } catch (err) {
        console.error(`[deva] 事件监听异常(${ev.c})`, err)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 订阅与上行
  // -------------------------------------------------------------------------

  /** 按 channel 订阅推送,返回取消订阅函数。 */
  on(channel: string, cb: EventListener): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) this.listeners.delete(channel)
    }
  }

  /** 原始信封订阅(含 stream/seq,P4 快照对账用),返回取消订阅函数。 */
  onRaw(cb: (ev: WsEventMessage) => void): () => void {
    this.rawCbs.add(cb)
    return () => this.rawCbs.delete(cb)
  }

  /** 快照重取回调(事件缓冲溢出时触发),返回取消订阅函数。 */
  onResync(cb: () => void): () => void {
    this.resyncCbs.add(cb)
    return () => this.resyncCbs.delete(cb)
  }

  /** 会话过期回调(WS 4401),返回取消订阅函数。 */
  onExpired(cb: () => void): () => void {
    this.expiredCbs.add(cb)
    return () => this.expiredCbs.delete(cb)
  }

  /** 连接是否就绪(hello 已到)。 */
  isReady(): boolean {
    return this.phase === 'open'
  }

  /**
   * WS 上行 send({v:1,type:'send',c,a})。仅供 terminal:input/resize/dispose 三通道;
   * 未连接时丢弃(返回 false)——终端输入断线不重放,重连后由服务端状态兜底。
   */
  send(channel: string, args: unknown[]): boolean {
    if (this.phase !== 'open' || !this.ws) return false
    return this.rawSend({ v: 1, type: 'send', c: channel, a: args })
  }

  private rawSend(obj: unknown): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }
}

/** 粗略估算事件字节数(缓冲限额用,精确值无必要)。 */
function approxBytes(ev: WsEventMessage): number {
  try {
    return JSON.stringify(ev).length
  } catch {
    return 1024
  }
}
