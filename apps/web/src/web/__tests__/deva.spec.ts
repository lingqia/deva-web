/**
 * 客户端桥形状单测(P5 自验证):mock fetch / WebSocket,验证 ——
 * - invoke 信封:POST /api/invoke/:channel,{v:1,requestId,args[,connectionId]},X-Deva-Client 头;
 * - 错误传播:ok=false → throw 带 code/message;401 → 触发全局过期回调,后续 invoke 快速失败;
 * - config:set 成功后本地同步更新 __DEVA_BOOTSTRAP__.config(含 unsetKeys 删除);
 * - WS:hello 前事件缓冲、hello 后分发;send 上行 {v:1,type:'send',c,a};4401 → 过期回调并停止重连;
 *   25s 心跳发应用层 ping,pong 后继续;异常断开按退避重连。
 * 运行环境为 node:手工 stub window/WebSocket/fetch(deva.ts 对 DOM 的依赖均为方法内取用)。
 * 注意:startSession() 先预取 config 再建 WS,用例必须 await 之后再驱动 socket。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

interface MockWsSent {
  parsed: Record<string, unknown>
}

class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  url: string
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  sent: MockWsSent[] = []
  closedWith: number[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push({ parsed: JSON.parse(data) as Record<string, unknown> })
  }

  close(code = 1000): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.closedWith.push(code)
    this.onclose?.({ code })
  }

  // —— 测试辅助:模拟服务端 ——
  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  serverMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  lastSent(): Record<string, unknown> {
    expect(this.sent.length).toBeGreaterThan(0)
    return this.sent[this.sent.length - 1].parsed
  }
}

/** 构造 fetch 响应形状(不依赖 undici Response,行为一致即可)。 */
function jsonRes(status: number, payload: unknown): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  headers: { get: (name: string) => string | null }
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: () => null }
  }
}

type FetchMock = ReturnType<typeof vi.fn>

/** 每用例全新模块状态(vi.resetModules → 动态 import),并 stub window/WebSocket/fetch。 */
async function freshBridge(fetchImpl?: FetchMock): Promise<{
  install: typeof import('../deva')
  fetchMock: FetchMock
  ws: typeof MockWebSocket
}> {
  vi.resetModules()
  const fetchMock = fetchImpl ?? vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('window', {
    location: { protocol: 'http:', host: 'deva.test' },
    prompt: () => null
  })
  const mod = await import('../deva')
  return { install: mod, fetchMock, ws: MockWebSocket }
}

const okConfig = (): FetchMock => vi.fn().mockResolvedValue(jsonRes(200, { ok: true, result: {}, requestId: 'r' }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('window.deva invoke', () => {
  it('信封:POST /api/invoke/:channel + {v:1,requestId,args} + X-Deva-Client;成功回传 result 并回填启动缓存', async () => {
    const { install, fetchMock } = await freshBridge()
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true, result: { theme: 'dark' }, requestId: 'srv-rid' }))
    const b = install.installDevaBridge()
    const result = await b.api.config.get()
    expect(result).toEqual({ theme: 'dark' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/invoke/config:get')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Deva-Client']).toBe('1')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(String(init.body)) as { v: number; requestId: string; args: unknown[] }
    expect(body.v).toBe(1)
    expect(typeof body.requestId).toBe('string')
    expect(body.requestId.length).toBeGreaterThan(0)
    expect(body.args).toEqual([])
    // 成功的 config:get 回填启动快照缓存(config:get-sync 替代)
    expect((window as unknown as { __DEVA_BOOTSTRAP__: { config: unknown } }).__DEVA_BOOTSTRAP__.config).toEqual({
      theme: 'dark'
    })
  })

  it('ok=false → throw 带 code/message(业务 catch 兼容)', async () => {
    const { install, fetchMock } = await freshBridge()
    fetchMock.mockResolvedValue(
      jsonRes(400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '参数不合法' }, requestId: 'r' })
    )
    const b = install.installDevaBridge()
    await expect(b.api.config.get()).rejects.toMatchObject({
      name: 'DevaInvokeError',
      code: 'INVALID_ARGUMENT',
      message: '参数不合法'
    })
  })

  it('HTTP 401 → 触发全局过期回调;此后 invoke 快速失败且不再发请求', async () => {
    const { install, fetchMock } = await freshBridge()
    fetchMock.mockResolvedValue(
      jsonRes(401, { ok: false, error: { code: 'UNAUTHORIZED', message: '未登录或会话已过期' } })
    )
    const b = install.installDevaBridge()
    const onExpired = vi.fn()
    b.onAuthExpired(onExpired)
    await expect(b.api.config.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(onExpired).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    await expect(b.api.skills.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('连接就绪时信封携带 connectionId(定向事件路由)', async () => {
    const { install, fetchMock, ws } = await freshBridge(okConfig())
    const b = install.installDevaBridge()
    await b.startSession()
    const sock = ws.instances[0]
    sock.serverOpen()
    sock.serverMessage({ v: 1, type: 'hello', serverId: 's1', connectionId: 'conn-1' })

    await b.api.config.get()
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { connectionId?: string }
    expect(body.connectionId).toBe('conn-1')
  })

  it('config:set 成功后本地同步更新缓存(合并 patch、删除 unsetKeys)', async () => {
    const { install, fetchMock } = await freshBridge()
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true, result: null, requestId: 'r' }))
    const b = install.installDevaBridge()
    await b.api.config.set({ theme: 'dark', locale: 'en' })
    await b.api.config.set({ theme: 'light' }, ['locale'])
    const cfg = (window as unknown as { __DEVA_BOOTSTRAP__: { config: Record<string, unknown> } })
      .__DEVA_BOOTSTRAP__.config
    expect(cfg).toEqual({ theme: 'light' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    const body2 = JSON.parse(String(init2.body)) as { args: unknown[] }
    // Web 契约:cleanPatch + unsetKeys 显式删除(plan §5.3)
    expect(body2.args).toEqual([{ theme: 'light' }, ['locale']])
  })
})

describe('window.deva WS 推送与上行', () => {
  it('hello 前事件缓冲、hello 后按序分发;按 channel 订阅与退订', async () => {
    const { install, ws } = await freshBridge(okConfig())
    const b = install.installDevaBridge()
    await b.startSession()
    const sock = ws.instances[0]
    expect(sock.url).toBe('ws://deva.test/ws')

    const seen: unknown[] = []
    const off = b.api.skills.onChanged((list) => seen.push(list))

    // hello 前到达的事件:先缓冲
    sock.serverOpen()
    sock.serverMessage({ v: 1, type: 'event', stream: 'shared', seq: 1, c: 'skills:changed', a: [[{ id: 'a' }]] })
    expect(seen).toEqual([])

    sock.serverMessage({ v: 1, type: 'hello', serverId: 'srv', connectionId: 'c-1' })
    expect(b.socket.isReady()).toBe(true)
    // hello 后缓冲按序 flush
    expect(seen).toEqual([[{ id: 'a' }]])

    // 直发
    sock.serverMessage({ v: 1, type: 'event', stream: 'shared', seq: 2, c: 'skills:changed', a: [[{ id: 'b' }]] })
    expect(seen).toEqual([[{ id: 'a' }], [{ id: 'b' }]])

    off()
    sock.serverMessage({ v: 1, type: 'event', stream: 'shared', seq: 3, c: 'skills:changed', a: [[{ id: 'c' }]] })
    expect(seen).toEqual([[{ id: 'a' }], [{ id: 'b' }]])
  })

  it('terminal send 上行 {v:1,type:"send",c,a};未就绪时丢弃', async () => {
    const { install, ws } = await freshBridge(okConfig())
    const b = install.installDevaBridge()
    await b.startSession()
    const sock = ws.instances[0]

    // hello 未到(未就绪):丢弃不抛
    expect(() => b.api.terminal.write('t1', 'ls')).not.toThrow()
    expect(sock.sent).toEqual([])

    sock.serverOpen()
    sock.serverMessage({ v: 1, type: 'hello', serverId: 'srv', connectionId: 'c-1' })
    b.api.terminal.write('t1', 'ls\r')
    b.api.terminal.resize('t1', 120, 40)
    b.api.terminal.dispose('t1')
    expect(sock.sent.map((s) => s.parsed)).toEqual([
      { v: 1, type: 'send', c: 'terminal:input', a: ['t1', 'ls\r'] },
      { v: 1, type: 'send', c: 'terminal:resize', a: ['t1', 120, 40] },
      { v: 1, type: 'send', c: 'terminal:dispose', a: ['t1'] }
    ])
  })

  it('WS 4401 → 过期回调、不再重连', async () => {
    vi.useFakeTimers()
    try {
      const { install, ws } = await freshBridge(okConfig())
      const b = install.installDevaBridge()
      const onExpired = vi.fn()
      b.onAuthExpired(onExpired)
      await b.startSession()
      const sock = ws.instances[0]
      sock.serverOpen()
      sock.serverMessage({ v: 1, type: 'hello', serverId: 'srv', connectionId: 'c-1' })

      sock.close(4401)
      expect(onExpired).toHaveBeenCalledTimes(1)

      // 不重连:推进退避时长后无新连接
      await vi.advanceTimersByTimeAsync(30_000)
      expect(ws.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('心跳:25s 发应用层 ping;pong 后继续;异常断开按退避重连', async () => {
    vi.useFakeTimers()
    try {
      const { install, ws } = await freshBridge(okConfig())
      const b = install.installDevaBridge()
      await b.startSession()
      const sock = ws.instances[0]
      sock.serverOpen()
      sock.serverMessage({ v: 1, type: 'hello', serverId: 'srv', connectionId: 'c-1' })

      await vi.advanceTimersByTimeAsync(25_000)
      expect(sock.lastSent()).toMatchObject({ v: 1, type: 'ping' })

      sock.serverMessage({ v: 1, type: 'pong' })
      await vi.advanceTimersByTimeAsync(25_000)
      const pings = sock.sent.filter((s) => s.parsed['type'] === 'ping')
      expect(pings.length).toBe(2)

      // 异常断开 → 1–10s 抖动退避内重连
      sock.close(1006)
      await vi.advanceTimersByTimeAsync(12_000)
      expect(ws.instances.length).toBe(2)
      expect(ws.instances[1].url).toBe('ws://deva.test/ws')
    } finally {
      vi.useRealTimers()
    }
  })
})
