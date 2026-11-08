/**
 * window.deva 客户端桥(P5,web-migration-plan.md §8.1):
 * - 把 @shared/api 的白名单契约(WindowDevaApi)落到浏览器传输:
 *   invoke → POST /api/invoke/:channel({v:1,requestId,args[,connectionId]});
 *   推送   → WebSocket /ws(transport.ts)按 channel 分发;
 *   send   → WS 上行 {v:1,type:'send',c,a}(仅 terminal:input/resize/dispose)。
 * - 必须早于任何业务模块求值:main.tsx 顶部同步 installDevaBridge(),业务 Provider 树经动态 import
 *   在其之后加载(ESM 静态 import 先于导入方模块体求值,故业务树不能静态进 main.tsx)。
 * - config:get-sync 已删除:首帧读 window.__DEVA_BOOTSTRAP__.config;安装时置 {config:{}},
 *   登录成功后 startSession() 预取 config:get 回填;config:set 成功后本地同步更新缓存。
 *   (无 GET /api/config 路由 —— 预取即登录后的首次 config:get invoke。)
 * - app:get-platform / platform:浏览器 UA 推断(快捷键/文案用);服务端平台另由元信息提供(P4)。
 *   已删通道(window:* / update:* / clipboard:* / config:get-sync / fs:reveal-folder /
 *   deliverables:open|reveal)不出现在本对象上。
 * - ok=false / 非 2xx 统一 throw DevaInvokeError(code,message),业务 catch 兼容;
 *   HTTP 401 与 WS 4401 统一触发全局过期回调(ThemeProvider/AuthProvider 据此回登录页)。
 * - 附件字节约定(plan §5.3):Uint8Array 一律编码为 base64 字符串传输,不传 JSON 数字键对象。
 */
import type { WindowDevaApi } from '@shared/api'
import type {
  AskResponse,
  BotPlatform,
  BotReplyMode,
  BotReplyScope,
  BotScanEvent,
  ChatCompactRequest,
  ChatCreateSessionRequest,
  ChatEventPayload,
  ChatRenameSessionRequest,
  ChatSendRequest,
  ChatSessionMeta,
  ChatSetEffortRequest,
  ChatSetFocusRequest,
  ChatSetModelRequest,
  CreateTaskResult,
  DeliverableInfo,
  DevaNotifyEvent,
  DirBrowseResult,
  DirEntry,
  DisplayMessage,
  GitAvailable,
  GitBranch,
  GitCommit,
  GitDiffLine,
  GitGenerateResult,
  GitGenLocale,
  GitGenModel,
  GitOpResult,
  GitStatus,
  McpServerConfig,
  McpServerInput,
  McpServerView,
  MemoryIpcResult,
  MemorySnapshot,
  MountResponse,
  OpenFolderResult,
  PickedAttachment,
  PlanResponse,
  PersonaRecord,
  PersonaUpsertInput,
  PreviewScheduleResult,
  ProbeConfig,
  ProviderListModelsResult,
  ReadFileResult,
  RemoteState,
  ResolveAutotaskResult,
  RewindApplyRequest,
  RewindApplyResult,
  RewindPreview,
  RewindTurnStat,
  RewindUndoResult,
  ShellProfile,
  SkillImportResult,
  SkillRecord,
  TaskCreateInput,
  TaskRecord,
  TaskSchedule,
  TaskStatus,
  TaskUpdateInput,
  TerminalCreateOptions,
  TerminalDataPayload,
  TerminalExitPayload,
  TodoState,
  UserProfile
} from '@shared/api'
import { DevaSocket } from './transport'

/** invoke 失败错误:code 为服务端稳定错误码(INVALID_ARGUMENT/UNAUTHORIZED/NOT_FOUND/... 或 HTTP_5xx)。 */
export class DevaInvokeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'DevaInvokeError'
  }
}

/** 登出结果(P5 追加桥方法):ok=false 时 reason=network 表示撤销未确认(服务端不可达)。 */
export interface DevaLogoutResult {
  ok: boolean
  reason?: 'network' | 'server'
  message?: string
}

/** 桥内部句柄:启动/终止会话与过期、快照对账回调(P4 对接点)。 */
export interface DevaBridge {
  api: WindowDevaApi
  /** 登录成功后调用:预取 config 回填 __DEVA_BOOTSTRAP__ 缓存并建立 WS(幂等)。 */
  startSession(): Promise<void>
  /** 登出/过期:停 WS 重连、置过期位(后续 invoke 快速失败),等待页面 reload。 */
  endSession(): void
  /** 全局过期回调(HTTP 401 / WS 4401 统一入口),返回取消订阅函数。 */
  onAuthExpired(cb: () => void): () => void
  /** 原始事件信封(含 stream/seq,P4 快照对账用),返回取消订阅函数。 */
  onRawEvent(cb: Parameters<DevaSocket['onRaw']>[0]): () => void
  /** 快照重取回调(事件缓冲溢出时触发),返回取消订阅函数。 */
  onResync(cb: () => void): () => void
  /** WS 传输(连接状态展示等)。 */
  socket: DevaSocket
}

let bridge: DevaBridge | null = null

/** 取已安装的桥;未安装则同步安装(main.tsx 已装,此处兜底动态加载路径)。 */
export function getDevaBridge(): DevaBridge {
  if (!bridge) return installDevaBridge()
  return bridge
}

/** 同步安装 window.deva 与启动快照缓存。重复安装返回既有桥(幂等)。 */
export function installDevaBridge(): DevaBridge {
  if (bridge) return bridge
  bridge = buildBridge()
  ;(window as unknown as { deva: WindowDevaApi }).deva = bridge.api
  // 启动快照:登录前 config 置空对象(登录前无私有请求;ThemeContext/i18n 已有 ?. 兜底),
  // 登录成功后 startSession() 预取 config:get 回填。
  if (!window.__DEVA_BOOTSTRAP__) window.__DEVA_BOOTSTRAP__ = { config: {} }
  return bridge
}

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function uuid(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* 非安全上下文回退 */
  }
  // 回退:crypto.getRandomValues + 模板(仅用于 requestId 唯一性,非安全标识)
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 浏览器客户端平台推断(快捷键/文案分支;与 process.platform 取值对齐)。 */
function detectClientPlatform(): string {
  const ua = navigator.userAgent
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'darwin'
  if (/Win/i.test(ua)) return 'win32'
  return 'linux'
}

function buildBridge(): DevaBridge {
  const socket = new DevaSocket()
  let expired = false
  const expiredCbs = new Set<() => void>()

  const fireExpired = (): void => {
    if (expired) return
    expired = true
    socket.close()
    for (const cb of [...expiredCbs]) {
      try {
        cb()
      } catch (err) {
        console.error('[deva] 过期回调异常', err)
      }
    }
  }

  // WS 4401(会话过期/撤销)并入全局过期处理:停重连(socket.close 内已做)+ 通知 AuthProvider
  socket.onExpired(fireExpired)

  /** invoke:POST /api/invoke/:channel;ok=false throw;401 触发全局过期回调。 */
  const invoke = async (channel: string, args: unknown[]): Promise<unknown> => {
    if (expired) throw new DevaInvokeError('UNAUTHORIZED', '登录会话已失效,请重新登录')
    const requestId = uuid()
    const body: Record<string, unknown> = { v: 1, requestId, args }
    // 实时相关请求携带 WS hello 的 connectionId:服务端据此换定向 sender(terminal/git delta)
    if (socket.connectionId && socket.isReady()) body['connectionId'] = socket.connectionId
    let res: Response
    try {
      // channel 形如 config:get(冒号是合法 path 字符);服务端路由 /api/invoke/:channel 解码一致
      res = await fetch(`/api/invoke/${channel}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Deva-Client': '1' },
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new DevaInvokeError('NETWORK', `网络请求失败(${err instanceof Error ? err.message : 'unknown'})`)
    }
    if (res.status === 401) {
      fireExpired()
      throw new DevaInvokeError('UNAUTHORIZED', '未登录或会话已过期')
    }
    let payload: unknown = null
    try {
      payload = await res.json()
    } catch {
      /* 非 JSON 响应按传输错误处理 */
    }
    const p = payload as { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } } | null
    if (!res.ok || !p || p.ok !== true) {
      const code = typeof p?.error?.code === 'string' ? p.error.code : `HTTP_${res.status}`
      const message = typeof p?.error?.message === 'string' ? p.error.message : `请求失败(HTTP ${res.status})`
      throw new DevaInvokeError(code, message)
    }
    return p.result
  }

  const inv = <T>(channel: string, ...args: unknown[]): Promise<T> => invoke(channel, args) as Promise<T>

  /** 订阅单负载推送事件(args[0])。 */
  const onPayload = <P>(channel: string, cb: (payload: P) => void): (() => void) =>
    socket.on(channel, (args) => cb(args[0] as P))

  // ---- 启动快照缓存(config:get-sync 的替代) -------------------------------

  const readCache = (): Record<string, unknown> => {
    try {
      return window.__DEVA_BOOTSTRAP__?.config ?? {}
    } catch {
      return {}
    }
  }
  const writeCache = (cfg: Record<string, unknown>): void => {
    try {
      window.__DEVA_BOOTSTRAP__ = { ...(window.__DEVA_BOOTSTRAP__ ?? {}), config: cfg }
    } catch {
      /* 缓存写失败不阻塞业务 */
    }
  }

  // ---- WS send 三通道(terminal) ---------------------------------------------

  const wsSend = (channel: string, args: unknown[]): void => {
    const ok = socket.send(channel, args)
    if (!ok) console.debug(`[deva] WS 未就绪,丢弃上行 ${channel}`)
  }

  // ---- base64(附件字节约定,plan §5.3) ---------------------------------------

  const bytesToBase64 = (bytes: Uint8Array): string => {
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }

  const fileToBase64 = async (file: File): Promise<string> => bytesToBase64(new Uint8Array(await file.arrayBuffer()))

  /** 通用文件选择器(替代已删除的原生对话框通道;cancel/change 空均按取消)。 */
  const pickFiles = (accept: string, multiple: boolean): Promise<File[]> =>
    new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.multiple = multiple
      input.style.display = 'none'
      let settled = false
      const finish = (files: File[]): void => {
        if (settled) return
        settled = true
        input.remove()
        resolve(files)
      }
      input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
      input.addEventListener('cancel', () => finish([]))
      document.body.appendChild(input)
      input.click()
    })

  // ---- 平台 -------------------------------------------------------------------

  const clientPlatform = detectClientPlatform()

  // ---- API 对象(通道名与 src/main 服务注册表一致;删除通道不出现) -----------

  const api: WindowDevaApi = {
    platform: clientPlatform,
    app: {
      // 契约:与 platform 同值 —— 浏览器语义即客户端平台,不 invoke 服务端(服务端平台另由元信息提供)
      getPlatform: () => Promise.resolve(clientPlatform)
    },
    fs: {
      // TODO(P6): 换 WebFolderPicker(fs:browse + fs:trust-root 两步 UI)。
      // 过渡实现:提示输入服务器绝对路径 → fs:trust-root 校验登记;取消/空 = null(原有取消语义)。
      openFolder: async () => {
        const path = window.prompt('选择服务器目录:输入服务器上的绝对路径\nPick a server folder: enter an absolute path on the server')
        if (path === null) return null
        const trimmed = path.trim()
        if (!trimmed) return null
        return inv<OpenFolderResult>('fs:trust-root', { path: trimmed })
      },
      readDir: (path) => inv<DirEntry[]>('fs:read-dir', path),
      readFile: (path) => inv<ReadFileResult>('fs:read-file', path),
      writeFile: (path, content) => inv<{ ok: true }>('fs:write-file', path, content),
      // TODO(P6): 与粘贴/拖放共用上传实现;此为浏览器多选 + fs:pick-attachments-web 上传链路
      pickAttachments: async () => {
        const files = await pickFiles('', true)
        if (files.length === 0) return []
        const payload = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            mime: f.type || 'application/octet-stream',
            size: f.size,
            dataBase64: await fileToBase64(f)
          }))
        )
        return inv<PickedAttachment[]>('fs:pick-attachments-web', payload)
      },
      // 字节约定:data Uint8Array → base64 字符串(null 保留 = 过大不读,仅报体积);服务端解码待 P4/E 收尾
      pasteAttachment: (file) =>
        inv<PickedAttachment>('fs:paste-attachment', {
          name: file.name,
          mime: file.mime,
          size: file.size,
          data: file.data === null ? null : bytesToBase64(file.data)
        }),
      pickAttachmentsWeb: (files) => inv<PickedAttachment[]>('fs:pick-attachments-web', files),
      browse: (args) => inv<DirBrowseResult>('fs:browse', args ?? {}),
      // 服务端 channelSchemas/handler 收 {path} 对象；此前这里直传字符串，
      // 被参数校验判「0: Expected object, received string」，「选择当前目录」永远失败。
      trustRoot: (path) => inv<OpenFolderResult>('fs:trust-root', { path })
    },
    config: {
      get: async () => {
        const cfg = await inv<Record<string, unknown>>('config:get')
        writeCache(cfg)
        return cfg
      },
      set: async (cleanPatch, unsetKeys) => {
        await invoke('config:set', [cleanPatch, unsetKeys])
        // 写成功后本地同步更新预取缓存(plan §5.3:写成功更新启动缓存)
        const cfg = { ...readCache() }
        Object.assign(cfg, cleanPatch)
        for (const k of unsetKeys ?? []) delete cfg[k]
        writeCache(cfg)
        return { ok: true }
      }
    },
    skills: {
      list: () => inv<SkillRecord[]>('skills:list'),
      get: (id) => inv<SkillRecord | null>('skills:get', id),
      // 浏览器文件选择 + skills:import-web 上传;取消保持原 cancelled 语义(plan §8.2)
      import: async () => {
        const files = await pickFiles('.md,.zip', false)
        const file = files[0]
        if (!file) return { ok: false, error: 'cancelled' }
        return inv<SkillImportResult>('skills:import-web', file.name, await fileToBase64(file))
      },
      importWeb: (name, dataBase64) => inv<SkillImportResult>('skills:import-web', name, dataBase64),
      remove: (id) => inv<{ ok: boolean }>('skills:remove', id),
      setEnabled: (id, enabled) => inv<{ ok: true }>('skills:set-enabled', id, enabled),
      setRoles: (id, roles) => inv<{ ok: boolean }>('skills:set-roles', id, roles),
      onChanged: (cb) => onPayload<SkillRecord[]>('skills:changed', cb)
    },
    profile: {
      get: () => inv<UserProfile>('profile:get'),
      setAvatar: (spec) => inv<{ ok: true }>('profile:set-avatar', spec),
      setAvatarImage: (dataUri) => inv<string>('profile:set-avatar-image', dataUri)
    },
    memory: {
      list: (root) => inv<MemorySnapshot>('memory:list', root ?? null),
      write: (content, id, root) => inv<MemoryIpcResult>('memory:write', content, id ?? null, root ?? null),
      remove: (id, root) => inv<MemoryIpcResult>('memory:remove', id, root ?? null),
      clear: (root) => inv<MemoryIpcResult>('memory:clear', root ?? null)
    },
    personas: {
      list: () => inv<PersonaRecord[]>('personas:list'),
      get: (id) => inv<PersonaRecord | null>('personas:get', id),
      upsert: (input) => inv<PersonaRecord>('personas:upsert', input),
      remove: (id) => inv<{ ok: true }>('personas:remove', id),
      setEnabled: (id, enabled) => inv<{ ok: true }>('personas:set-enabled', id, enabled),
      reorder: (ids) => inv<{ ok: true }>('personas:reorder', ids),
      setAvatarImage: (id, dataUri) => inv<string>('personas:set-avatar-image', id, dataUri),
      clearAvatarImage: (id) => inv<{ ok: true }>('personas:clear-avatar-image', id)
    },
    mcp: {
      list: () => inv<McpServerView[]>('mcp:list'),
      get: (id) => inv<McpServerConfig | null>('mcp:get', id),
      upsert: (input) => inv<McpServerConfig>('mcp:upsert', input),
      remove: (id) => inv<{ ok: true }>('mcp:remove', id),
      setEnabled: (id, enabled) => inv<{ ok: true }>('mcp:set-enabled', id, enabled),
      setRoles: (id, roles) => inv<{ ok: boolean }>('mcp:set-roles', id, roles),
      retry: (id) => inv<McpServerView | null>('mcp:retry', id),
      setSecret: (id, field, value) => inv<{ ok: boolean; available: boolean }>('mcp:set-secret', id, field, value),
      hasSecret: (id, field) => inv<boolean>('mcp:has-secret', id, field),
      onStatus: (cb) => onPayload<McpServerView>('mcp:status', cb)
    },
    secrets: {
      set: (providerId, key) => inv<{ ok: boolean; available: boolean }>('secrets:set', providerId, key),
      has: (providerId) => inv<boolean>('secrets:has', providerId),
      delete: (providerId) => inv<{ ok: true }>('secrets:delete', providerId),
      list: () => inv<string[]>('secrets:list'),
      available: () => inv<boolean>('secrets:available')
    },
    provider: {
      listModels: (cfg: ProbeConfig) => inv<ProviderListModelsResult>('provider:list-models', cfg)
    },
    chat: {
      send: (req: ChatSendRequest) => inv<{ turnId: string }>('chat:send', req),
      compact: (req: ChatCompactRequest) => inv<{ turnId: string }>('chat:compact', req),
      createSession: (req: ChatCreateSessionRequest) => inv<{ ok: true }>('chat:create-session', req),
      setModel: (req: ChatSetModelRequest) => inv<{ ok: true }>('chat:set-model', req),
      setEffort: (req: ChatSetEffortRequest) => inv<{ ok: true }>('chat:set-effort', req),
      setFocus: (req: ChatSetFocusRequest) => inv<{ ok: true }>('chat:set-focus', req),
      renameSession: (req: ChatRenameSessionRequest) => inv<{ title: string } | null>('chat:rename-session', req),
      setArchived: (req) => inv<{ ok: boolean }>('chat:set-archived', req),
      abort: (turnId) => inv<{ ok: true }>('chat:abort', turnId),
      stopSubagent: (sessionId, toolUseId) => inv<{ ok: boolean }>('chat:stop-subagent', sessionId, toolUseId),
      reset: (sessionId, workspaceRoot) => inv<{ ok: true }>('chat:reset', sessionId, workspaceRoot),
      listSessions: (workspaceRoot) => inv<ChatSessionMeta[]>('chat:list-sessions', workspaceRoot),
      loadSession: (sessionId, workspaceRoot) => inv<DisplayMessage[]>('chat:load-session', sessionId, workspaceRoot),
      attachSession: (sessionId) => inv<{ messages: DisplayMessage[]; turnId: string | null }>('chat:attach-session', sessionId),
      deleteSession: (sessionId, workspaceRoot) => inv<{ ok: true }>('chat:delete-session', sessionId, workspaceRoot),
      deleteTurns: (sessionId, workspaceRoot, turnIndices) =>
        inv<DisplayMessage[]>('chat:delete-turns', sessionId, workspaceRoot, turnIndices),
      todos: (sessionId) => inv<TodoState>('chat:todos', sessionId),
      cancelTodoList: (sessionId) => inv<TodoState>('chat:todo-cancel', sessionId),
      rewindList: (sessionId) => inv<{ turns: RewindTurnStat[]; canUndo: boolean }>('chat:rewind-list', sessionId),
      rewindPreview: (sessionId, turn) => inv<RewindPreview | null>('chat:rewind-preview', sessionId, turn),
      rewindApply: (req: RewindApplyRequest) => inv<RewindApplyResult>('chat:rewind-apply', req),
      rewindUndo: (sessionId) => inv<RewindUndoResult>('chat:rewind-undo', sessionId),
      resolveProposal: (sessionId, toolUseId, status) =>
        inv<{ ok: boolean }>('chat:resolve-proposal', sessionId, toolUseId, status),
      resolveAutotask: (sessionId, toolUseId, action, taskInput) =>
        inv<ResolveAutotaskResult>('chat:resolve-autotask', sessionId, toolUseId, action, taskInput ?? null),
      respondAsk: (payload: AskResponse) => inv<{ ok: boolean }>('chat:ask-response', payload),
      respondPlan: (payload: PlanResponse) => inv<{ ok: boolean }>('chat:plan-response', payload),
      respondMount: (payload: MountResponse) => inv<{ ok: boolean }>('chat:mount-response', payload),
      onEvent: (cb) => onPayload<ChatEventPayload>('chat:event', cb),
      onSessionsChanged: (cb) => socket.on('chat:sessions-changed', () => cb())
    },
    terminal: {
      listShells: () => inv<ShellProfile[]>('terminal:list-shells'),
      create: (opts: TerminalCreateOptions) => inv<{ id: string }>('terminal:create', opts),
      // WS 上行 send(服务端校验归属与长度;断线不重放,连接销毁时服务端兜底回收 PTY)
      write: (id, data) => wsSend('terminal:input', [id, data]),
      resize: (id, cols, rows) => wsSend('terminal:resize', [id, cols, rows]),
      dispose: (id) => wsSend('terminal:dispose', [id]),
      onData: (cb) => onPayload<TerminalDataPayload>('terminal:data', cb),
      onExit: (cb) => onPayload<TerminalExitPayload>('terminal:exit', cb)
    },
    git: {
      available: () => inv<GitAvailable>('git:available'),
      status: (dir) => inv<GitStatus>('git:status', dir),
      diff: (dir, path, opts) => inv<GitDiffLine[]>('git:diff', dir, path, opts ?? {}),
      stage: (dir, paths) => inv<GitOpResult>('git:stage', dir, paths),
      unstage: (dir, paths) => inv<GitOpResult>('git:unstage', dir, paths),
      discard: (dir, tracked, untracked) => inv<GitOpResult>('git:discard', dir, tracked, untracked),
      commit: (dir, message) => inv<GitOpResult>('git:commit', dir, message),
      setConfig: (dir, name, email, global) => inv<GitOpResult>('git:set-config', dir, name, email, global),
      branches: (dir) => inv<GitBranch[]>('git:branches', dir),
      checkout: (dir, ref) => inv<GitOpResult>('git:checkout', dir, ref),
      createBranch: (dir, name, checkout) => inv<GitOpResult>('git:create-branch', dir, name, checkout),
      checkoutRemote: (dir, remoteRef) => inv<GitOpResult>('git:checkout-remote', dir, remoteRef),
      merge: (dir, ref) => inv<GitOpResult>('git:merge', dir, ref),
      mergeAbort: (dir) => inv<GitOpResult>('git:merge-abort', dir),
      deleteBranch: (dir, name, force) => inv<GitOpResult>('git:delete-branch', dir, name, force),
      renameBranch: (dir, oldName, newName) => inv<GitOpResult>('git:rename-branch', dir, oldName, newName),
      deleteRemoteBranch: (dir, remote, branch) => inv<GitOpResult>('git:delete-remote-branch', dir, remote, branch),
      log: (dir, depth) => inv<GitCommit[]>('git:log', dir, depth ?? null),
      init: (dir) => inv<GitOpResult>('git:init', dir),
      fetch: (dir) => inv<GitOpResult>('git:fetch', dir),
      pull: (dir) => inv<GitOpResult>('git:pull', dir),
      push: (dir, setUpstreamBranch) => inv<GitOpResult>('git:push', dir, setUpstreamBranch),
      generateCommitMessage: (dir, model: GitGenModel, locale: GitGenLocale, reqId?) =>
        inv<GitGenerateResult>('git:generate-commit-message', dir, model, locale, reqId ?? null),
      cancelCommitMessage: (reqId) => inv<boolean>('git:cancel-commit-message', reqId),
      // 定向推送 args = [reqId, text]
      onCommitMessageDelta: (cb) =>
        socket.on('git:commit-gen-delta', (args) => cb(args[0] as string, args[1] as string))
    },
    tasks: {
      list: () => inv<TaskRecord[]>('tasks:list'),
      get: (id) => inv<TaskRecord | null>('tasks:get', id),
      create: (input: TaskCreateInput) => inv<CreateTaskResult>('tasks:create', input),
      update: (input: TaskUpdateInput) => inv<TaskRecord | null>('tasks:update', input),
      remove: (id) => inv<{ ok: true }>('tasks:delete', id),
      setStatus: (id, status: TaskStatus) => inv<TaskRecord | null>('tasks:set-status', id, status),
      runNow: (id) => inv<{ ok: boolean; reason?: string; already?: 'running' | 'queued' }>('tasks:run-now', id),
      preview: (schedule: TaskSchedule, locale, allowPast) =>
        inv<PreviewScheduleResult>('tasks:preview', schedule, locale, allowPast ?? null),
      onChanged: (cb) => onPayload<TaskRecord[]>('tasks:changed', cb),
      onNavigate: (cb) => onPayload<{ sessionId?: string; pane?: 'tasks' }>('tasks:navigate', cb)
    },
    deliverables: {
      inspect: (sessionId, toolUseId) => inv<DeliverableInfo[]>('deliverables:inspect', sessionId, toolUseId),
      thumbnail: (sessionId, toolUseId, index) =>
        inv<string | null>('deliverables:thumbnail', sessionId, toolUseId, index)
    },
    remote: {
      getState: () => inv<RemoteState>('remote:get-state'),
      scanStart: (platform: BotPlatform, opts) =>
        inv<{ ok: true; scanId: string; qr: string; link?: string; userCode?: string; expiresAt: number } | { ok: false; error: string }>(
          'remote:scan-start',
          platform,
          opts ?? {}
        ),
      scanCancel: (scanId) => inv<{ ok: true }>('remote:scan-cancel', scanId),
      setEnabled: (id, enabled) => inv<{ ok: boolean; error?: string }>('remote:set-enabled', id, enabled),
      setReplyMode: (id, mode: BotReplyMode) => inv<{ ok: true }>('remote:set-reply-mode', id, mode),
      setScope: (id, scope: BotReplyScope) => inv<{ ok: true }>('remote:set-scope', id, scope),
      deleteBot: (id) => inv<{ ok: true }>('remote:delete-bot', id),
      pairCode: (id) => inv<{ code: string; expiresAt: number }>('remote:pair-code', id),
      pairCancel: (id) => inv<{ ok: true }>('remote:pair-cancel', id),
      removeUser: (id, userId) => inv<{ ok: true }>('remote:remove-user', id, userId),
      onChanged: (cb) => onPayload<RemoteState>('remote:changed', cb),
      onScan: (cb) => onPayload<BotScanEvent>('remote:scan', cb)
    },
    onNotify: (cb) => onPayload<DevaNotifyEvent>('notify', cb),
    // P5 追加桥方法(见 shared/api.ts 追加段):POST /api/logout;成功后整页 reload
    authLogout: async (): Promise<DevaLogoutResult> => {
      try {
        const res = await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Deva-Client': '1' },
          body: '{}'
        })
        if (res.ok) {
          endSession()
          location.reload()
          return { ok: true }
        }
        // 401=会话本已无效(等价已登出);其它状态=撤销未确认
        if (res.status === 401) {
          endSession()
          return { ok: true }
        }
        return { ok: false, reason: 'server', message: `服务端拒绝(HTTP ${res.status}),撤销未确认` }
      } catch {
        // 网络不可达:不能仅清 UI 就宣称服务端已退出(plan §8.1)
        return { ok: false, reason: 'network', message: '服务端不可达,撤销未确认' }
      }
    }
  }

  async function startSession(): Promise<void> {
    expired = false
    // 预取 config 回填启动缓存(getSync 替代);失败不阻塞启动,缓存保持空对象兜底
    try {
      const cfg = await inv<Record<string, unknown>>('config:get')
      writeCache(cfg)
    } catch (err) {
      console.warn('[deva] config 预取失败,首帧用空配置/本地偏好', err)
    }
    socket.connect()
  }

  function endSession(): void {
    expired = true
    socket.close()
  }

  return {
    api,
    startSession,
    endSession,
    onAuthExpired: (cb) => {
      expiredCbs.add(cb)
      return () => expiredCbs.delete(cb)
    },
    onRawEvent: (cb) => socket.onRaw(cb),
    onResync: (cb) => socket.onResync(cb),
    socket
  }
}
