/**
 * PTY 宿主：由 terminal.ts 用 `child_process.fork` 启动的**纯 Node 子进程**
 * （Web 化改造：不再使用 Electron Utility Process / process.parentPort / MessageEvent）。
 *
 * 为什么隔离：node-pty 是原生模块，且真实 shell 可能崩溃/卡死。放在独立子进程里，崩溃只波及
 * 它自己 —— 宿主进程任何未捕获异常都打印日志并 `process.exit(1)`，父进程（terminal.ts）感知
 * exit 后给所有活跃终端补发 exit 并在下次 create 时重新 fork；已存在的会话按丢失处理，不迁移。
 *
 * 线缆协议（v1，字段见下方类型定义；按项目约定在本文件内结构化复述，不跨层 import）：
 *   父进程 → 宿主（下行）：
 *     { v:1, type:'create',  id, shellId, cwd, cols, rows }   建 PTY（shellId 必须在允许列表内）
 *     { v:1, type:'input',   id, data }                        写入（≤16KiB/次）
 *     { v:1, type:'resize',  id, cols, rows }                  调整行列（正整数）
 *     { v:1, type:'dispose', id }                              关闭并移除会话
 *   宿主 → 父进程（上行）：
 *     { v:1, type:'ready' }                                    探针 spawn 成功后真实发送（仅一次）
 *     { v:1, type:'data',   id, chunk }                        终端输出
 *     { v:1, type:'exit',   id, exitCode, error? }             会话退出（spawn 失败也补发，error 说明原因）
 *
 * 就绪语义：ready 不是「进程起来了」就发，而是先做一次**真实探针 spawn**（默认 shell，即起即杀），
 * node-pty 原生模块可用、spawn 真正成功后才发送。ready 之前收到的 create 有界排队（上限
 * MAX_PENDING_CREATES，超出直接回 exit 拒绝），flush 保持到达顺序。
 *
 * 安全校验（客户端不可信，计划 §4.2）：shellId 必须命中本机探测清单（与 services/shells.ts 同源，
 * 直接复用其探测结果，客户端不能指定任意 shell 可执行路径）；cwd 必须为绝对路径（不存在时回落
 * 用户主目录）；cols/rows 必须是有限正整数且有界；input 单条 ≤16KiB（超出丢弃并告警）。
 */
import * as pty from '@lydell/node-pty'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { detectShells, resolveShell } from './services/shells'

/** 协议版本：收到不匹配的信封一律忽略（父/宿主版本错配时不互相炸）。 */
const PROTOCOL_VERSION = 1

/** ready 之前可排队的 create 上限：超出直接拒绝（防父进程异常时无界积压）。 */
const MAX_PENDING_CREATES = 32

/** 单条输入字节上限（16KiB；WS 上行同额，双端一致）。 */
const MAX_INPUT_BYTES = 16 * 1024

/** 行列的有界正整数范围（xterm.js 实际可渲染范围远大于此，取宽松上限即可）。 */
const MIN_COLS_ROWS = 2
const MAX_COLS_ROWS = 1000

/** 终端 id 形态：父进程生成（t<seq>），这里只做形态防呆。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 父进程 → 宿主 的入站消息。 */
type InboundMessage =
  | { v: number; type: 'create'; id: string; shellId: string | null; cwd: string | null; cols: number; rows: number }
  | { v: number; type: 'input'; id: string; data: string }
  | { v: number; type: 'resize'; id: string; cols: number; rows: number }
  | { v: number; type: 'dispose'; id: string }

/** 宿主 → 父进程 的出站消息。 */
type OutboundMessage =
  | { v: number; type: 'ready' }
  | { v: number; type: 'data'; id: string; chunk: string }
  | { v: number; type: 'exit'; id: string; exitCode: number; error?: string }

const sessions = new Map<string, pty.IPty>()
let isReady = false
const pendingCreates: Extract<InboundMessage, { type: 'create' }>[] = []

/** 宿主 → 父进程 发送：通道可能已关（父进程退出），判空 + 吞 EPIPE。 */
function send(msg: OutboundMessage): void {
  if (typeof process.send !== 'function') return // 无 IPC 通道（如被直接 node 启动）：静默
  try {
    process.send(msg)
  } catch (err) {
    // 通道关闭/写失败 = 父进程已不在：按崩溃语义退出，父端重启后终端按丢失处理。
    console.error('[pty-host] 发送失败（父进程通道已关闭），宿主退出：', err)
    process.exit(1)
  }
}

/** 默认 shell：Windows 用 Windows PowerShell（5.1 恒随系统预装，零配置）；其余用登录 shell。 */
function defaultShell(): { path: string; args: string[] } {
  return resolveShell(null)
}

/** cwd 兜底：目录不存在（或未开项目）时回退到用户主目录，避免 spawn 失败。调用前已验绝对路径。 */
function safeCwd(cwd: string | null): string {
  if (cwd && existsSync(cwd)) return cwd
  return homedir()
}

/** 行列校验：有限正整数且有界。 */
function isValidSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_COLS_ROWS && n <= MAX_COLS_ROWS
}

/** shellId → {path,args}：只允许本机探测清单内的 id（与 terminal:list-shells 同源），命不中返回 null。 */
function resolveAllowedShell(shellId: unknown): { path: string; args: string[] } | null {
  if (shellId == null) return defaultShell()
  if (typeof shellId !== 'string') return null
  if (!detectShells().some((s) => s.id === shellId)) return null // 不在允许列表：拒绝
  return resolveShell(shellId)
}

/** 探针 spawn：真实起一个默认 shell 并立即关闭 —— node-pty 原生模块不可用时这里抛错 → 宿主退出。 */
function probeSpawn(): void {
  const { path, args } = defaultShell()
  const probe = pty.spawn(path, args, {
    name: 'xterm-256color',
    cols: MIN_COLS_ROWS,
    rows: MIN_COLS_ROWS,
    cwd: homedir(),
    env: { ...process.env }
  })
  try {
    probe.kill() // 探针即用即弃：只验证 spawn 能成功，不留常驻 shell
  } catch {
    /* 已自行退出：不影响探针结论 */
  }
}

/** 处理 create：校验通过才 spawn；spawn 失败补发 exit（带原因），渲染层据此反馈而非空等。 */
function handleCreate(msg: Extract<InboundMessage, { type: 'create' }>): void {
  if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) {
    console.warn('[pty-host] create 拒绝：非法 id')
    return
  }
  if (sessions.has(msg.id)) return // 重复 id：忽略（父进程侧每个终端只 create 一次）
  if (!isValidSize(msg.cols) || !isValidSize(msg.rows)) {
    send({ v: PROTOCOL_VERSION, type: 'exit', id: msg.id, exitCode: -1, error: 'invalid-size' })
    return
  }
  if (msg.cwd != null && (typeof msg.cwd !== 'string' || !isAbsolute(msg.cwd))) {
    send({ v: PROTOCOL_VERSION, type: 'exit', id: msg.id, exitCode: -1, error: 'invalid-cwd' })
    return
  }
  const shell = resolveAllowedShell(msg.shellId)
  if (!shell) {
    send({ v: PROTOCOL_VERSION, type: 'exit', id: msg.id, exitCode: -1, error: 'shell-not-allowed' })
    return
  }

  let proc: pty.IPty
  try {
    proc = pty.spawn(shell.path, shell.args, {
      name: 'xterm-256color',
      cols: msg.cols,
      rows: msg.rows,
      cwd: safeCwd(msg.cwd),
      env: { ...process.env }
    })
  } catch (err) {
    // 起不来（如 shell 缺失）：补发一个 exit，让渲染层给出反馈而非空等。
    send({
      v: PROTOCOL_VERSION,
      type: 'exit',
      id: msg.id,
      exitCode: -1,
      error: err instanceof Error ? err.message : String(err)
    })
    return
  }
  sessions.set(msg.id, proc)
  proc.onData((chunk) => send({ v: PROTOCOL_VERSION, type: 'data', id: msg.id, chunk }))
  proc.onExit(({ exitCode }) => {
    send({ v: PROTOCOL_VERSION, type: 'exit', id: msg.id, exitCode })
    sessions.delete(msg.id)
  })
}

/** 处理一条下行消息（已验信封版本）：未就绪时 create 有界排队，其余类型无会话即自然空操作。 */
function handleMessage(msg: InboundMessage): void {
  switch (msg.type) {
    case 'create':
      if (isReady) {
        handleCreate(msg)
      } else if (pendingCreates.length >= MAX_PENDING_CREATES) {
        send({ v: PROTOCOL_VERSION, type: 'exit', id: msg.id, exitCode: -1, error: 'host-not-ready' })
      } else {
        pendingCreates.push(msg)
      }
      break
    case 'input': {
      // 输入长度上限 16KiB（字节）：超出整条丢弃并告警（WS 层同额，此处双保险）。
      if (typeof msg.data !== 'string' || Buffer.byteLength(msg.data, 'utf8') > MAX_INPUT_BYTES) {
        console.warn('[pty-host] input 丢弃：缺数据或超过 16KiB 上限')
        return
      }
      sessions.get(msg.id)?.write(msg.data)
      break
    }
    case 'resize':
      if (!isValidSize(msg.cols) || !isValidSize(msg.rows)) return
      try {
        sessions.get(msg.id)?.resize(msg.cols, msg.rows)
      } catch {
        /* 窗口尺寸过小或会话已结束时 resize 可能抛错，忽略 */
      }
      break
    case 'dispose':
      try {
        sessions.get(msg.id)?.kill()
      } catch {
        /* 已退出的会话再 kill 会抛错，忽略 */
      }
      sessions.delete(msg.id)
      break
    default:
      console.warn('[pty-host] 未知消息类型，忽略')
  }
}

/** 信封校验：v 必须匹配协议版本，type 必须是已知下行类型。 */
function isInboundMessage(m: unknown): m is InboundMessage {
  if (!m || typeof m !== 'object') return false
  const msg = m as { v?: unknown; type?: unknown }
  if (msg.v !== PROTOCOL_VERSION) return false
  return (
    msg.type === 'create' || msg.type === 'input' || msg.type === 'resize' || msg.type === 'dispose'
  )
}

// ── 崩溃语义：宿主任何未捕获异常都打印日志并退出(码 1)，父进程重启后终端按丢失处理 ──────────
process.on('uncaughtException', (err) => {
  console.error('[pty-host] 未捕获异常，宿主退出：', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[pty-host] 未处理的 Promise 拒绝，宿主退出：', reason)
  process.exit(1)
})
// 父进程 IPC 通道关闭（父进程退出/被杀）：宿主使命结束，退出并带走全部 PTY 会话。
process.on('disconnect', () => process.exit(0))

// 先挂消息监听再探针：探针期间到达的下行消息不丢（create 有界排队，见 handleMessage）。
process.on('message', (raw) => {
  if (!isInboundMessage(raw)) {
    console.warn('[pty-host] 忽略不合规消息（版本/形态不符）')
    return
  }
  handleMessage(raw)
})

// 启动：真实探针 spawn 成功 → 才发送 ready（仅一次），随后按到达顺序冲刷排队中的 create。
probeSpawn()
isReady = true
send({ v: PROTOCOL_VERSION, type: 'ready' })
while (pendingCreates.length) handleCreate(pendingCreates.shift()!)
