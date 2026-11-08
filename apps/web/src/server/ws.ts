/**
 * WebSocket(v1 协议,web-migration-plan.md §6.1):
 * - Upgrade 校验:Cookie 会话有效 + Origin 精确匹配 env.origin(完整 scheme/host/port);
 *   失败以 HTTP 401/403 拒绝握手 —— 4401 仅是已建立连接的关闭码,不作升级拒绝状态。
 * - hello:{v:1,type:'hello',serverId,connectionId};事件信封 {v,type:'event',stream,seq,c,a}。
 * - 上行仅 type:'send'(c ∈ terminal:input/resize/dispose)与 ping/pong;上行 >64KiB 断开
 *   (ws maxPayload);终端输入单条 16KiB;resize 限频;未知通道/类型拒绝。
 * - 心跳:25s 协议层 ping,两周期无 pong 关闭;心跳同步校验会话有效期,失效 4401 关闭。
 * - 慢客户端:发送缓冲 >4MiB 关闭,不无限积压内存。
 * - 出口:broadcast/publish/toConnection/closeSession/lookupSender;
 *   broadcastWindow 适配器安装到 platform(setBroadcastProvider + setNoticeEmitter)。
 * - 连接断开清理该连接的资源注册(destroyed 监听触发 + onConnectionClosed 钩子,
 *   terminal.ts 经 setTerminalDispatch 接线时注入回收回调)。
 */
import { randomBytes } from 'node:crypto'
import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { AppNotice, UiEventSender } from '../main/platform'
import { setBroadcastProvider, setNoticeEmitter } from '../main/platform'
import type { ServerEnv } from './env'
import { SESSION_COOKIE, parseCookies } from './auth'
import type { SessionManager } from './auth'
import { makeNotice, shouldDeliver } from './notify'
import { StreamSequences, chatStreamSeqs, chatStreamKey } from './runtime-state'
import { debug, errMessage, error as logError, log, warn } from './log'

const MAX_INBOUND_BYTES = 64 * 1024
const TERMINAL_INPUT_MAX_BYTES = 16 * 1024
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const HEARTBEAT_MS = 25_000
const MAX_RESIZE_PER_SEC = 20
/** 协议违规容忍次数:超过即关闭。 */
const MAX_VIOLATIONS = 3

// 关闭码(4000-4999 应用段):4401 鉴权失效(§5.2.10)
const CLOSE_AUTH_EXPIRED = 4401
const CLOSE_SLOW_CONSUMER = 4402
const CLOSE_PROTOCOL_VIOLATION = 4403
const CLOSE_GOING_AWAY = 1001

/** 上行白名单:仅三种终端 send;不能成为任意 invoke 通道(§6.1)。 */
const ALLOWED_SEND_CHANNELS = new Set(['terminal:input', 'terminal:resize', 'terminal:dispose'])

/**
 * 终端上行分发器(terminal.ts 的 handleTerminalMessage;index.ts 经 setTerminalDispatch 注入)。
 * 在 hub 协议校验(白名单/形状/限频)通过后调用;返回 false = 归属不符或终端不存在,已静默丢弃。
 */
export type TerminalDispatch = (connectionId: string, channel: string, args: unknown[]) => boolean

export interface WsHub {
  /** 共享状态广播(等价旧 BrowserWindow.webContents.send 的全端语义),stream='shared'。 */
  broadcast(channel: string, args: unknown[]): void
  /** 定向 stream 广播(chat:<sid> 等共享 stream;P4 由统一事件出口调用)。 */
  publish(stream: string, channel: string, args: unknown[]): void
  /** 定向单连接(terminal:data/exit、git:commit-gen-delta、remote:scan 等归属通道)。 */
  toConnection(connectionId: string, channel: string, args: unknown[]): boolean
  /** 关闭某登录会话的全部连接(登出/会话撤销/过期),默认 4401。 */
  closeSession(sessionIdHash: string, code?: number): void
  /** invoke 用:connectionId 属于该会话时返回其定向 sender,否则 null。 */
  lookupSender(connectionId: string, sessionIdHash: string): UiEventSender | null
  onlineCount(): number
  /** 本次启动标识(hello 与 chat:snapshot 响应同源;index.ts 启动时对齐 runtime-state.setServerId)。 */
  readonly serverId: string
  /** 安装 platform.broadcastWindow 与 notify 出口(启动时调用一次)。 */
  installBroadcastWindow(): void
  /** 连接关闭回调(terminal.ts 接线时经 TerminalBridge.onConnectionClosed 注册回收钩子)。 */
  onConnectionClosed(cb: (connectionId: string, sessionIdHash: string) => void): void
  /**
   * 安装终端上行分发器(terminal.ts 接线后调用一次;P4)。未安装时三种 terminal:* 上行
   * 校验通过后仍被忽略(不违规),保证业务层加载失败时传输层不受影响。
   */
  setTerminalDispatch(dispatch: TerminalDispatch | null): void
  /** 挂到 HTTP server 的 upgrade 事件。 */
  attach(server: Server): void
  /** 停机:关闭全部连接并停心跳。 */
  closeAll(): void
}

interface WsConn {
  id: string
  ws: WebSocket
  sessionIdHash: string
  alive: boolean
  violations: number
  resizeAt: number[]
  sender: UiEventSender
  destroyed: boolean
  destroyedListeners: Set<() => void>
}

export function createWsHub(opts: { env: ServerEnv; auth: SessionManager }): WsHub {
  const { env, auth } = opts
  const serverId = randomBytes(8).toString('hex')
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES, perMessageDeflate: false })
  const conns = new Map<string, WsConn>()
  const bySession = new Map<string, Set<string>>()
  const streams = new StreamSequences()
  const closedHooks = new Set<(connectionId: string, sessionIdHash: string) => void>()
  /** 终端上行分发器(terminal.ts 接线;未安装时 terminal:* 上行校验后忽略)。 */
  let terminalDispatch: TerminalDispatch | null = null
  let heartbeat: NodeJS.Timeout | null = null

  // ---------------------------------------------------------------------------
  // 发送
  // ---------------------------------------------------------------------------

  function sendEvent(conn: WsConn, stream: string, channel: string, args: unknown[]): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      closeConn(conn, CLOSE_SLOW_CONSUMER, '发送缓冲超限')
      return
    }
    // chat:<sid> 流的序号必须与 chat:snapshot 同源(runtime-state.chatStreamSeqs),
    // 客户端才能按「seq 大于快照」去重(§6.2);其余流用 hub 本地序号。
    const seq = stream.startsWith('chat:') ? chatStreamSeqs.next(stream) : streams.next(stream)
    let text: string
    try {
      text = JSON.stringify({ v: 1, type: 'event', stream, seq, c: channel, a: args })
    } catch (err) {
      logError('ws', `事件序列化失败(${channel}),已跳过`, err)
      return
    }
    try {
      conn.ws.send(text)
    } catch (err) {
      warn('ws', `事件发送失败: ${errMessage(err)}`)
    }
  }

  function sendRaw(conn: WsConn, obj: unknown): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      closeConn(conn, CLOSE_SLOW_CONSUMER, '发送缓冲超限')
      return
    }
    try {
      conn.ws.send(JSON.stringify(obj))
    } catch (err) {
      warn('ws', `控制消息发送失败: ${errMessage(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // 连接生命周期
  // ---------------------------------------------------------------------------

  function closeConn(conn: WsConn, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason)
    } catch {
      /* 已关闭 */
    }
  }

  function terminate(conn: WsConn, why: string): void {
    debug('ws', `连接 ${conn.id} 强制关闭: ${why}`)
    try {
      conn.ws.terminate()
    } catch {
      /* 已关闭 */
    }
  }

  /** 触发 sender 'destroyed' 监听(业务据此取消后台工作,如 git.ts)。 */
  function fireDestroyed(conn: WsConn): void {
    if (conn.destroyed) return
    conn.destroyed = true
    const listeners = [...conn.destroyedListeners]
    conn.destroyedListeners.clear()
    for (const l of listeners) {
      try {
        l()
      } catch (err) {
        logError('ws', 'destroyed 回调异常', err)
      }
    }
  }

  function removeConn(conn: WsConn): void {
    fireDestroyed(conn)
    if (conns.get(conn.id) !== conn) return
    conns.delete(conn.id)
    const set = bySession.get(conn.sessionIdHash)
    if (set) {
      set.delete(conn.id)
      if (set.size === 0) bySession.delete(conn.sessionIdHash)
    }
    for (const hook of closedHooks) {
      try {
        hook(conn.id, conn.sessionIdHash)
      } catch (err) {
        logError('ws', '连接关闭钩子异常', err)
      }
    }
    debug('ws', `连接 ${conn.id} 已断开(在线 ${conns.size})`)
    if (conns.size === 0 && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function makeConnSender(conn: WsConn): UiEventSender {
    return {
      send(channel: string, ...args: unknown[]): void {
        // 定向归属通道:stream 取「channel:首个 id 参数」(terminal:<termId>、git:<reqId>),
        // 其余用 channel 本身。TODO(P4): 业务接入后按通道显式声明 stream 规则,替代该启发式。
        const first = args[0]
        const stream =
          typeof first === 'string' && first.length > 0 && first.length <= 128 ? `${channel}:${first}` : channel
        sendEvent(conn, stream, channel, args)
      },
      once(_event: 'destroyed', listener: () => void): void {
        if (conn.destroyed) listener()
        else conn.destroyedListeners.add(listener)
      },
      off(_event: 'destroyed', listener?: () => void): void {
        if (listener) conn.destroyedListeners.delete(listener)
        else conn.destroyedListeners.clear()
      },
      isDestroyed(): boolean {
        return conn.destroyed
      }
    }
  }

  function onConnection(ws: WebSocket, sessionIdHash: string): void {
    const conn: WsConn = {
      id: randomBytes(16).toString('hex'),
      ws,
      sessionIdHash,
      alive: true,
      violations: 0,
      resizeAt: [],
      sender: null as unknown as UiEventSender,
      destroyed: false,
      destroyedListeners: new Set()
    }
    conn.sender = makeConnSender(conn)
    conns.set(conn.id, conn)
    const set = bySession.get(sessionIdHash) ?? new Set<string>()
    set.add(conn.id)
    bySession.set(sessionIdHash, set)
    startHeartbeat()

    ws.on('message', (data) => onMessage(conn, data))
    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('close', () => removeConn(conn))
    ws.on('error', (err) => {
      warn('ws', `连接 ${conn.id} 错误: ${errMessage(err)}`)
    })

    sendRaw(conn, { v: 1, type: 'hello', serverId, connectionId: conn.id })
    log('ws', `新连接 ${conn.id}(在线 ${conns.size})`)
  }

  // ---------------------------------------------------------------------------
  // 心跳:每 25s ping,两周期无 pong 关闭;同步校验会话有效期
  // ---------------------------------------------------------------------------

  function startHeartbeat(): void {
    if (heartbeat) return
    heartbeat = setInterval(() => {
      for (const conn of [...conns.values()]) {
        if (!conn.alive) {
          terminate(conn, '心跳超时')
          continue
        }
        conn.alive = false
        // 心跳同步检查会话有效期(§5.2.10):撤销/过期 → 4401
        if (!auth.sessionAlive(conn.sessionIdHash)) {
          closeConn(conn, CLOSE_AUTH_EXPIRED, '登录会话已失效')
          continue
        }
        try {
          conn.ws.ping()
        } catch {
          /* 下轮按超时处理 */
        }
      }
    }, HEARTBEAT_MS)
    heartbeat.unref()
  }

  // ---------------------------------------------------------------------------
  // 上行消息
  // ---------------------------------------------------------------------------

  function violation(conn: WsConn, why: string): void {
    conn.violations += 1
    warn('ws', `连接 ${conn.id} 协议违规(${conn.violations}/${MAX_VIOLATIONS}): ${why}`)
    if (conn.violations > MAX_VIOLATIONS) closeConn(conn, CLOSE_PROTOCOL_VIOLATION, '协议违规')
  }

  function onMessage(conn: WsConn, data: unknown): void {
    let msg: unknown
    try {
      msg = JSON.parse(String(data))
    } catch {
      return violation(conn, '非 JSON 消息')
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return violation(conn, '消息不是对象')
    const m = msg as Record<string, unknown>
    if (m['v'] !== 1) return violation(conn, '协议版本不支持')
    switch (m['type']) {
      case 'ping':
        sendRaw(conn, { v: 1, type: 'pong' })
        return
      case 'pong':
        conn.alive = true
        return
      case 'send':
        onSend(conn, m)
        return
      default:
        violation(conn, `未知消息类型: ${String(m['type'])}`)
    }
  }

  function onSend(conn: WsConn, m: Record<string, unknown>): void {
    const channel = m['c']
    const a = m['a']
    if (typeof channel !== 'string' || !ALLOWED_SEND_CHANNELS.has(channel)) {
      return violation(conn, '上行通道不在白名单')
    }
    if (!Array.isArray(a)) return violation(conn, 'send.a 不是数组')

    if (channel === 'terminal:input') {
      const [id, payload] = a as unknown[]
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) return violation(conn, 'terminal:input 参数不合法')
      if (typeof payload !== 'string') return violation(conn, 'terminal:input 数据须为字符串')
      if (Buffer.byteLength(payload, 'utf8') > TERMINAL_INPUT_MAX_BYTES) return violation(conn, '终端输入超过 16KiB')
    } else if (channel === 'terminal:resize') {
      const [id, cols, rows] = a as unknown[]
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) return violation(conn, 'terminal:resize 参数不合法')
      if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isInteger(cols) || !Number.isInteger(rows)) {
        return violation(conn, 'resize 尺寸须为整数')
      }
      // resize 限频:超频直接丢弃(不算协议违规)
      const now = Date.now()
      conn.resizeAt = conn.resizeAt.filter((t) => now - t < 1000)
      if (conn.resizeAt.length >= MAX_RESIZE_PER_SEC) {
        debug('ws', 'resize 限频,丢弃本次')
        return
      }
      conn.resizeAt.push(now)
    } else {
      const [id] = a as unknown[]
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) return violation(conn, 'terminal:dispose 参数不合法')
    }

    // 协议校验通过 → 分发 terminal.ts(归属校验 + 转发宿主;P4 接线)。
    if (!terminalDispatch) {
      debug('ws', `上行 ${channel}(终端分发未接线,忽略)`)
      return
    }
    let accepted = false
    try {
      accepted = terminalDispatch(conn.id, channel, a)
    } catch (err) {
      logError('ws', `终端上行分发异常(${channel})`, err)
      return
    }
    if (!accepted) debug('ws', `上行 ${channel} 被丢弃(终端不存在或归属不符,连接 ${conn.id})`)
  }

  // ---------------------------------------------------------------------------
  // Upgrade 握手:HTTP 401/403 拒绝(4401 只用于已建立连接)
  // ---------------------------------------------------------------------------

  function reject(socket: Duplex, status: number, statusText: string, code: string, message: string): void {
    const body = JSON.stringify({ ok: false, error: { code, message } })
    try {
      socket.end(
        `HTTP/1.1 ${status} ${statusText}\r\n` +
          'Connection: close\r\n' +
          'Content-Type: application/json; charset=utf-8\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          '\r\n' +
          body
      )
    } catch {
      /* 对端已断开 */
    }
    setTimeout(() => {
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
    }, 1000).unref()
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Origin:完整 HTTP(S) scheme/host/port 精确比较;缺失、null、不匹配一律拒绝(§5.2.7)
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0 || origin.toLowerCase() !== env.origin.toLowerCase()) {
      return reject(socket, 403, 'Forbidden', 'FORBIDDEN', 'Origin 不被允许')
    }
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    const record = sid ? auth.resolveSession(sid) : null
    if (!record) return reject(socket, 401, 'Unauthorized', 'UNAUTHORIZED', '登录会话无效或已过期')
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, record.idHash))
  }

  // ---------------------------------------------------------------------------
  // Hub 出口
  // ---------------------------------------------------------------------------

  const hub: WsHub = {
    broadcast(channel, args) {
      hub.publish('shared', channel, args)
    },
    publish(stream, channel, args) {
      for (const conn of [...conns.values()]) sendEvent(conn, stream, channel, args)
    },
    toConnection(connectionId, channel, args) {
      const conn = conns.get(connectionId)
      if (!conn) return false
      sendEvent(conn, channel, channel, args)
      return true
    },
    closeSession(sessionIdHash, code = CLOSE_AUTH_EXPIRED) {
      const ids = bySession.get(sessionIdHash)
      if (!ids) return
      for (const id of [...ids]) {
        const conn = conns.get(id)
        if (conn) closeConn(conn, code, '登录会话已撤销')
      }
    },
    lookupSender(connectionId, sessionIdHash) {
      const conn = conns.get(connectionId)
      if (!conn || conn.sessionIdHash !== sessionIdHash) return null
      return conn.sender
    },
    onlineCount() {
      return conns.size
    },
    serverId,
    installBroadcastWindow() {
      const broadcastSender: UiEventSender = {
        send(channel, ...args) {
          // chat:event 按会话定向到 chat:<sid> 流(序号与快照同源,§6.2);
          // 客户端 transport 按 c(通道)分发,流只承载 seq/恢复语义。
          if (channel === 'chat:event') {
            const p = args[0] as { sessionId?: unknown } | undefined
            if (p && typeof p.sessionId === 'string' && p.sessionId.length > 0) {
              hub.publish(chatStreamKey(p.sessionId), channel, args)
              return
            }
          }
          hub.broadcast(channel, args)
        },
        once(_event, _listener) {
          /* 广播窗口常驻,不销毁 */
        },
        off() {
          /* 常驻 */
        },
        isDestroyed() {
          return false
        }
      }
      // 在线连接数 > 0 才提供广播窗体;无连接返回 null,业务按旧「窗口不存在则丢弃」语义处理
      setBroadcastProvider(() => (conns.size > 0 ? { webContents: broadcastSender, isDestroyed: () => false } : null))
      // notify:noticeId 去重后按 stream='notify' 广播
      setNoticeEmitter((notice: AppNotice) => {
        const n = makeNotice(notice)
        if (!shouldDeliver(n)) return
        hub.publish('notify', 'notify', [n])
      })
    },
    onConnectionClosed(cb) {
      closedHooks.add(cb)
    },
    setTerminalDispatch(dispatch) {
      terminalDispatch = dispatch
    },
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        try {
          handleUpgrade(req, socket, head)
        } catch (err) {
          logError('ws', 'upgrade 处理异常', err)
          try {
            socket.destroy()
          } catch {
            /* 忽略 */
          }
        }
      })
    },
    closeAll() {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      for (const conn of [...conns.values()]) closeConn(conn, CLOSE_GOING_AWAY, '服务器停机')
    }
  }

  return hub
}
