/**
 * 终端 IPC 桥(服务端侧)。
 *
 * 职责:`child_process.fork` 一个持有 node-pty 的 PTY 宿主子进程(见 pty-host.ts,Web 化改造:
 * 不再使用 Electron Utility Process),在浏览器 ↔ PTY 宿主之间中继消息。服务端主进程本身不
 * 承担 PTY 输出/输入的重活,宿主崩溃也不牵连服务进程(宿主 exit 后下次 create 重新 fork)。
 *
 * 通道:
 *   页面 → 服务端:terminal:create(list-shells 同理,invoke,回 {id});
 *                 terminal:input / terminal:resize / terminal:dispose 仅经 WS 上行分发
 *                 (ws.ts 校验后调 handleTerminalMessage;HTTP invoke 不路由这三个通道)。
 *   服务端 → 页面:terminal:data / terminal:exit(经注入的 TerminalBridge 定向发到归属连接)。
 *
 * 与宿主的线缆协议(v1,与 pty-host.ts 结构化复述保持一致,不跨层 import):
 *   下行(本进程 → 宿主):create:{v,id,shellId,cwd,cols,rows} / input:{v,id,data} /
 *                          resize:{v,id,cols,rows} / dispose:{v,id}
 *   上行(宿主 → 本进程):ready:{v} / data:{v,id,chunk} / exit:{v,id,exitCode,error?}
 * ready 由宿主在真实探针 spawn 成功后发送;未就绪时下行消息在本进程排队,ready 后冲刷。
 * shellId 原样传给宿主校验(允许列表在宿主内与 shells.ts 同源)——客户端不指定 shell 路径。
 *
 * 归属(web-migration-plan.md §4.2 / §6.1):terminal:create 时从 InvokeEvent.connectionId
 * 登记归属连接(HTTP invoke 无连接 → owner=null,该终端拒绝一切实时操作、输出无处定向即丢弃);
 * WS 上行 input/resize/dispose 校验 ownerConnectionId,不符静默丢弃(对客户端不回错)+服务端日志;
 * 连接断开(TerminalBridge.onConnectionClosed)回收该连接创建的全部终端。
 * 与 WS 层的耦合用依赖注入解开(terminal.ts 不 import ws.ts):index.ts 接线时传入
 * { send, onConnectionClosed }(实现为 hub.toConnection / hub.onConnectionClosed)。
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'path'
import { ipcMain } from '../platform'
import { detectShells } from './shells'

/** 协议版本:与 pty-host.ts 的 PROTOCOL_VERSION 一致(v1)。 */
const PROTOCOL_VERSION = 1

/** 渲染层传入的建终端参数(结构化复述,与 preload 对齐)。 */
interface CreateOptions {
  cols: number
  rows: number
  cwd: string | null
  shellId?: string | null
}

/** 本进程 → 宿主 的下行消息(与 pty-host.ts 的 InboundMessage 对齐)。 */
type DownlinkMessage =
  | { v: number; type: 'create'; id: string; shellId: string | null; cwd: string | null; cols: number; rows: number }
  | { v: number; type: 'input'; id: string; data: string }
  | { v: number; type: 'resize'; id: string; cols: number; rows: number }
  | { v: number; type: 'dispose'; id: string }

/** 宿主 → 本进程 的上行消息(与 pty-host.ts 的 OutboundMessage 对齐)。 */
type HostMessage =
  | { v: number; type: 'ready' }
  | { v: number; type: 'data'; id: string; chunk: string }
  | { v: number; type: 'exit'; id: string; exitCode: number; error?: string }

/** 信封校验:v 匹配协议版本且 type 为已知上行类型。 */
function isHostMessage(m: unknown): m is HostMessage {
  if (!m || typeof m !== 'object') return false
  const msg = m as { v?: unknown; type?: unknown }
  if (msg.v !== PROTOCOL_VERSION) return false
  return msg.type === 'ready' || msg.type === 'data' || msg.type === 'exit'
}

/**
 * 终端层 ↔ 服务端传输层(ws.ts)的注入桥:terminal.ts 不 import ws.ts(避免传输层与业务层
 * 循环依赖),由 index.ts 接线时传入实现(hub.toConnection / hub.onConnectionClosed 的适配)。
 */
export interface TerminalBridge {
  /** 定向推送终端事件(terminal:data / terminal:exit)到归属连接。 */
  send(connectionId: string, channel: 'terminal:data' | 'terminal:exit', args: unknown[]): void
  /** 注册连接断开回调:回收该连接创建的全部终端(§4.2)。 */
  onConnectionClosed(cb: (connectionId: string) => void): void
}

// ---------------------------------------------------------------------------
// 运行期状态(模块级单例:ipcMain 注册表本身模块级,registerTerminalIpc 全程只可调一次,
// 重复调用会因通道重复注册抛错 —— 见 platform.ts)
// ---------------------------------------------------------------------------

let child: ChildProcess | null = null
let ready = false
let seq = 0
const activeIds = new Set<string>()
const pending: DownlinkMessage[] = []
/** 终端 id → 归属连接(WS hello 的 connectionId;HTTP invoke 创建无连接 → null)。 */
const owners = new Map<string, string | null>()
let bridge: TerminalBridge | null = null
/** 停机后置位:此后一切下行(含连接断开回收触发的 dispose)不再发往宿主。 */
let terminalLayerDown = false

/** 把待发消息冲刷给宿主;未就绪时留在 pending,收到 ready 后再发。 */
function flush(): void {
  if (!child || !ready) return
  for (const m of pending) {
    try {
      child.send(m)
    } catch {
      /* 通道已关:宿主 exit 处理器会复位状态,停止冲刷 */
      return
    }
  }
  pending.length = 0
}

function sendToHost(msg: DownlinkMessage): void {
  if (terminalLayerDown) return
  pending.push(msg)
  flush()
}

/** 登记终端归属连接(HTTP invoke 创建无 WS 连接 → null)。 */
function attachOwner(id: string, connectionId: string | null): void {
  owners.set(id, connectionId)
}

/** 解除终端归属登记。 */
function detachOwner(id: string): void {
  owners.delete(id)
}

/**
 * 终端事件定向转发:发归属连接(注入桥);归属缺失(HTTP 创建/已回收)直接丢弃 ——
 * §4.2:输出定向发送,不做广播兜底(P2 之前的广播兜底已按计划移除)。
 */
function forwardTerminalEvent(
  channel: 'terminal:data' | 'terminal:exit',
  payload: Record<string, unknown>,
  id: string
): void {
  const owner = owners.get(id)
  if (!owner) {
    console.warn(`[terminal] 终端 ${id} 无归属连接,丢弃 ${channel}`)
    return
  }
  bridge?.send(owner, channel, [payload])
}

/** 连接断开:回收该连接创建的全部终端(dispose 发宿主;§4.2)。 */
function reclaimConnectionTerminals(connectionId: string): void {
  if (terminalLayerDown) return
  let reclaimed = 0
  for (const [id, owner] of [...owners]) {
    if (owner !== null && owner === connectionId) {
      activeIds.delete(id)
      owners.delete(id)
      sendToHost({ v: PROTOCOL_VERSION, type: 'dispose', id })
      reclaimed++
    }
  }
  if (reclaimed > 0) console.log(`[terminal] 连接 ${connectionId} 断开,已回收 ${reclaimed} 个终端`)
}

// ---------------------------------------------------------------------------
// WS 上行分发入口(由 ws.ts 在协议校验通过后调用;见 index.ts 的 setTerminalDispatch 接线)
// ---------------------------------------------------------------------------

/**
 * WS 上行终端消息分发:校验终端归属,通过后转发宿主。
 * @param connectionId 上行消息所属的 WS 连接(hello 分配)
 * @param channel      terminal:input / terminal:resize / terminal:dispose(hub 白名单已限)
 * @param args         [id, ...] 形态参数(ws.ts 已按通道校验形状;此处再防御一次)
 * @returns 是否已接受并转发宿主;false = 静默丢弃(对客户端不回错,§4.2)
 */
export function handleTerminalMessage(connectionId: string, channel: string, args: unknown[]): boolean {
  if (terminalLayerDown) return false
  const id = args[0]
  if (typeof id !== 'string' || id.length === 0) return false
  if (!owners.has(id)) {
    // 终端不存在/已退出:刚 exit 的竞态或过期客户端,静默丢弃
    console.warn(`[terminal] 终端 ${id} 不存在,丢弃 ${channel}`)
    return false
  }
  const owner = owners.get(id) ?? null
  if (owner === null || owner !== connectionId) {
    // 归属不符(§4.2):静默丢弃,不断连接(协议层已校验参数合法,这里只做归属闸)
    console.warn(`[terminal] 终端 ${id} 归属不符(owner=${owner ?? 'none'}),丢弃来自 ${connectionId} 的 ${channel}`)
    return false
  }
  if (channel === 'terminal:input') {
    const data = args[1]
    if (typeof data !== 'string') return false
    sendToHost({ v: PROTOCOL_VERSION, type: 'input', id, data })
  } else if (channel === 'terminal:resize') {
    const cols = args[1]
    const rows = args[2]
    if (typeof cols !== 'number' || typeof rows !== 'number') return false
    sendToHost({ v: PROTOCOL_VERSION, type: 'resize', id, cols, rows })
  } else if (channel === 'terminal:dispose') {
    activeIds.delete(id)
    detachOwner(id)
    sendToHost({ v: PROTOCOL_VERSION, type: 'dispose', id })
  } else {
    return false
  }
  return true
}

/**
 * 停机回收(§4.1):先按宿主协议逐个 dispose(宿主侧 pty.kill 回收 shell),再杀宿主进程兜底
 * —— dispose 是异步的,不等回执,宿主收不到就随 kill 一起消亡。幂等:重复调用为空操作,
 * 未 fork 过(child=null)同样安全。
 */
export function shutdownAllTerminals(): void {
  if (terminalLayerDown) return
  terminalLayerDown = true
  const ids = [...activeIds]
  activeIds.clear()
  owners.clear()
  const proc = child
  child = null
  ready = false
  pending.length = 0
  if (!proc) return
  for (const id of ids) {
    try {
      proc.send({ v: PROTOCOL_VERSION, type: 'dispose', id })
    } catch {
      break
    }
  }
  try {
    proc.kill()
  } catch {
    /* 已退出 */
  }
  console.log(`[terminal] 停机:已回收 ${ids.length} 个终端并终止 PTY 宿主`)
}

// ---------------------------------------------------------------------------
// IPC 注册与宿主管理
// ---------------------------------------------------------------------------

export function registerTerminalIpc(terminalBridge: TerminalBridge): void {
  bridge = terminalBridge
  terminalBridge.onConnectionClosed(reclaimConnectionTerminals)

  function ensureChild(): ChildProcess {
    if (child) return child
    // PTY 宿主脚本定位:dev 与 build 的服务端产物同目录(esbuild 双入口,见 scripts/dev.mjs 与
    // scripts/build.mjs:out/server/index.cjs + out/server/pty-host.cjs),__dirname 两种模式都
    // 指向 out/server,直接按文件名取。找不到说明产物不完整,明确报错而非静默失败。
    const ptyHostPath = join(__dirname, 'pty-host.cjs')
    if (!existsSync(ptyHostPath)) {
      throw new Error(
        `未找到 PTY 宿主脚本 ${ptyHostPath}(服务端产物不完整,请重新构建:dev 用 pnpm dev,生产用 pnpm build)`
      )
    }
    ready = false
    pending.length = 0
    // stdin 不用(宿主不读标准输入);stdout/stderr 并入服务端日志;IPC 通道传协议消息。
    // fork 子进程随父进程无新窗口(Windows 下仅 detached+shell 才会另开控制台)。
    const proc = fork(ptyHostPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child = proc

    proc.on('message', (raw) => {
      if (!isHostMessage(raw)) return
      if (raw.type === 'ready') {
        // 宿主真实探针 spawn 成功后才发 ready:此刻起才冲刷排队消息(早发会丢在 IPC 通道上)。
        ready = true
        flush()
        return
      }
      if (raw.type === 'data') {
        forwardTerminalEvent('terminal:data', { id: raw.id, data: raw.chunk }, raw.id)
        return
      }
      // exit:先按归属转发,再解除登记(顺序反了会丢转发目标)。
      activeIds.delete(raw.id)
      forwardTerminalEvent('terminal:exit', { id: raw.id, exitCode: raw.exitCode }, raw.id)
      detachOwner(raw.id)
    })

    proc.on('error', (err) => {
      // fork/spawn 失败(如脚本损坏):不抛到未捕获,按宿主退出处理,下次 create 重试。
      console.error('[terminal] PTY 宿主进程错误:', err)
    })

    // 宿主整体退出(崩溃/被杀):给所有活跃会话按归属补发 exit,复位状态以便下次重启(refork)。
    proc.on('exit', () => {
      ready = false
      pending.length = 0
      for (const id of activeIds) {
        const owner = owners.get(id)
        if (owner) bridge?.send(owner, 'terminal:exit', [{ id, exitCode: -1 }])
      }
      activeIds.clear()
      owners.clear()
      if (child === proc) child = null
    })

    return proc
  }

  // 已装 shell 清单:只回 id/label/isDefault,绝对路径与 args 留在服务端(宿主侧同样只认 id)。
  ipcMain.handle('terminal:list-shells', () =>
    detectShells().map(({ id, label, isDefault }) => ({ id, label, isDefault }))
  )

  ipcMain.handle('terminal:create', (evt, opts: CreateOptions): { id: string } => {
    ensureChild()
    const id = `t${++seq}`
    activeIds.add(id)
    // 归属 = 发起请求的 WS 连接;HTTP invoke(无连接)→ null,该终端拒绝一切实时操作(§4.2)。
    attachOwner(id, evt.connectionId)
    sendToHost({
      v: PROTOCOL_VERSION,
      type: 'create',
      id,
      shellId: typeof opts?.shellId === 'string' ? opts.shellId : null,
      cwd: typeof opts?.cwd === 'string' ? opts.cwd : null,
      cols: typeof opts?.cols === 'number' ? opts.cols : 80,
      rows: typeof opts?.rows === 'number' ? opts.rows : 24
    })
    return { id }
  })

  // 实时上行(input/resize/dispose)在 Web 端只经 WS 分发(handleTerminalMessage,带连接归属
  // 校验,§4.2)。这三个 ipcMain.on 注册仅为通道表与桌面版对齐:HTTP invoke 不路由 sync 通道,
  // 无连接上下文无法校验归属 —— 一律显式拒绝,不直通宿主(避免绕过归属校验的旁路)。
  ipcMain.on('terminal:input', () => {
    console.warn('[terminal] terminal:input 须经 WS 上行分发(无连接路径已拒绝)')
  })
  ipcMain.on('terminal:resize', () => {
    console.warn('[terminal] terminal:resize 须经 WS 上行分发(无连接路径已拒绝)')
  })
  ipcMain.on('terminal:dispose', () => {
    console.warn('[terminal] terminal:dispose 须经 WS 上行分发(无连接路径已拒绝)')
  })
}
