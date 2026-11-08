/**
 * invoke 分发(web-migration-plan.md §5.3):
 * - 处理器来自 platform.ts 的 ipcMain 注册表 —— 注册表即白名单,未注册通道一律 404。
 * - 契约:请求 {v:1, requestId, args[], connectionId?};
 *   成功 {ok:true, result, requestId};业务处理器抛错 → {ok:false, error:{code,message}, requestId}。
 *   业务自身返回的 {ok:false,reason:...} 保留在 result 内,不与传输层 ok 混淆。
 * - HTTP 状态映射:INVALID_ARGUMENT 400 / UNAUTHORIZED 401 / FORBIDDEN 403 / NOT_FOUND 404 /
 *   CONFLICT 409 / PAYLOAD_TOO_LARGE 413 / RATE_LIMITED 429 / UNAVAILABLE 503 / INTERNAL 500;
 *   响应不泄露堆栈/密钥/进程环境(堆栈仅进服务端日志)。
 * - zod 逐通道校验(channelSchemas):P4 已覆盖 config:get/set、chat:attach-session/snapshot/send/abort、
 *   fs:browse/fs:trust-root、attachments:upload、skills:import-web、terminal:create/list-shells、
 *   secrets:*、git:*;未覆盖通道暂放行,由 HTTP 层在响应头标注(X-Deva-Args-Schema)。
 * - 通用形状守卫先于 schema:args ≤16、单参字符串 ≤1MiB(上传通道豁免,信封由 HTTP 层放宽 40MiB)、
 *   嵌套深度 ≤4。
 * - 副作用通道(chat:send、tasks:run-now)按 sessionId+channel+requestId 去重:
 *   覆盖执行中与短期已完成结果,15 分钟 TTL,有界(1000 条)。键不含业务实参 —— chat:send 的
 *   幂等锚点是调用方生成的 requestId,与 ChatSendRequest 形状无耦合(已核对)。
 */
import { getInvokeHandler } from '../main/platform'
import type { InvokeEvent, UiEventSender } from '../main/platform'
import { z, type ZodTypeAny } from 'zod'
import { errMessage, error as logError } from './log'

export const INVOKE_STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500
}

/** 业务处理器可抛的显式错误:code 必须在 INVOKE_STATUS 内。 */
export class InvokeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'InvokeError'
  }
}

/**
 * 通道参数 schema(args 数组的 zod 校验)。
 * P4 覆盖:config:get/set、chat:attach-session/chat:snapshot/chat:send/chat:abort、fs:browse/fs:trust-root、
 * attachments:upload、skills:import-web、terminal:create/list-shells、secrets:*(轻量)、git:*(路径串轻量)。
 * 未覆盖通道保持现状:HTTP 层以 X-Deva-Args-Schema 响应头标注;补齐一个即自动开启强校验。
 */
export const channelSchemas = new Map<string, ZodTypeAny>()
{
  const configKey = z.string().min(1).max(128)
  // config:set 的 args 有三种合法形态：
  //   [cleanPatch]               —— 渲染层 config.set(patch)（unsetKeys 为 undefined，JSON 序列化后可能是缺省）
  //   [cleanPatch, null]         —— JSON.stringify([patch, undefined]) 的产物（数组里的 undefined 变 null）
  //   [cleanPatch, unsetKeys]    —— 显式删键
  // 早期只写了 z.tuple([patch, array.optional()])，对 null 与缺省形态都判 400（历史 bug，曾被
  // 参数深度校验挡在前面未暴露）。此处统一放行三种形态。
  {
    const patchSchema = z
      .record(configKey, z.unknown())
      .refine((p) => Object.keys(p).length <= 256, 'config patch 键数量超限(≤256)')
    const unsetSchema = z.array(configKey).max(64)
    channelSchemas.set(
      'config:set',
      z.union([
        z.tuple([patchSchema, unsetSchema]),
        z.tuple([patchSchema, z.null()]),
        z.tuple([patchSchema])
      ])
    )
  }
  channelSchemas.set('config:get', z.tuple([]))

  // ── 通用形 ──
  const id128 = z.string().min(1).max(128)
  const pathStr = z.string().min(1).max(4096)

  // ── chat(快照与副作用核心通道;其余 chat:* 交互通道由业务先到者生效语义自守,后续补)──
  channelSchemas.set('chat:attach-session', z.tuple([id128]))
  channelSchemas.set('chat:snapshot', z.tuple([id128]))
  channelSchemas.set('chat:abort', z.tuple([id128]))
  channelSchemas.set(
    'chat:send',
    z.tuple([
      z.object({
        sessionId: id128,
        text: z.string().max(262_144), // 256KiB 正文
        // ChatModelConfig 结构由 model-resolve/runTurn 业务校验(解析不了回落默认),schema 不深检
        model: z.unknown().optional(),
        workspaceRoot: z.string().max(4096).nullable().optional(),
        attachments: z.array(z.string().max(4096)).max(64).optional(),
        personaId: z.string().max(128).optional(),
        focusRoot: z.string().max(4096).nullable().optional(),
        modelRef: z.string().max(256).optional(),
        effort: z.string().max(32).optional()
      })
    ])
  )

  // ── Web 目录选择(§5.4)──
  channelSchemas.set(
    'fs:browse',
    z.tuple([z.object({ path: z.string().max(4096).optional(), cursor: z.string().max(16).optional() }).optional()])
  )
  channelSchemas.set('fs:trust-root', z.tuple([z.object({ path: z.string().max(4096) }).optional()]))

  // ── 上传通道(信封放宽 40MiB;字符串限额豁免,内容校验在业务层)──
  channelSchemas.set(
    'attachments:upload',
    z.tuple([
      z.object({
        name: z.string().min(1).max(512),
        dataBase64: z.string().min(1),
        kind: z.enum(['image', 'document', 'text']).optional() // 仅提示;类型/限额以扩展名 classify 为准
      })
    ])
  )
  channelSchemas.set(
    'skills:import-web',
    z.tuple([
      z.object({ name: z.string().min(1).max(512), dataBase64: z.string().min(1) })
    ])
  )

  // ── terminal(H 在迁移 pty 宿主,签名按 terminal.ts 现状;后续由 H 对齐)──
  channelSchemas.set('terminal:list-shells', z.tuple([]))
  channelSchemas.set(
    'terminal:create',
    z.tuple([
      z.object({
        cols: z.number().int().min(2).max(1_000),
        rows: z.number().int().min(2).max(1_000),
        cwd: z.string().max(4096).nullable().optional(),
        shellId: z.string().max(128).nullable().optional()
      })
    ])
  )

  // ── secrets(轻量:标识与空参通道)──
  channelSchemas.set('secrets:has', z.tuple([id128]))
  channelSchemas.set('secrets:delete', z.tuple([id128]))
  channelSchemas.set('secrets:list', z.tuple([]))
  channelSchemas.set('secrets:available', z.tuple([]))
  channelSchemas.set('secrets:status', z.tuple([]))

  // ── git(路径串轻量:model/locale 等结构参数业务自校验)──
  channelSchemas.set('git:available', z.tuple([]))
  channelSchemas.set('git:status', z.tuple([pathStr]))
  channelSchemas.set('git:stage', z.tuple([pathStr, z.array(z.string().max(4096)).max(10_000)]))
  channelSchemas.set('git:unstage', z.tuple([pathStr, z.array(z.string().max(4096)).max(10_000)]))
  channelSchemas.set('git:commit', z.tuple([pathStr, z.string().min(1).max(65_536)]))
  channelSchemas.set('git:branches', z.tuple([pathStr]))
  channelSchemas.set('git:checkout', z.tuple([pathStr, z.string().max(4096)]))
  channelSchemas.set('git:create-branch', z.tuple([pathStr, z.string().max(4096), z.boolean()]))
  channelSchemas.set('git:checkout-remote', z.tuple([pathStr, z.string().max(4096)]))
  channelSchemas.set('git:merge', z.tuple([pathStr, z.string().max(4096)]))
  channelSchemas.set('git:merge-abort', z.tuple([pathStr]))
  channelSchemas.set('git:delete-branch', z.tuple([pathStr, z.string().max(4096), z.boolean()]))
  channelSchemas.set('git:rename-branch', z.tuple([pathStr, z.string().max(4096), z.string().max(4096)]))
  channelSchemas.set('git:delete-remote-branch', z.tuple([pathStr, z.string().max(4096), z.string().max(4096)]))
  channelSchemas.set('git:log', z.tuple([pathStr, z.number().int().min(1).max(1_000).optional()]))
  channelSchemas.set('git:init', z.tuple([pathStr]))
  channelSchemas.set('git:fetch', z.tuple([pathStr]))
  channelSchemas.set('git:pull', z.tuple([pathStr]))
  channelSchemas.set('git:push', z.tuple([pathStr, z.string().max(4096).nullable().optional()]))
  channelSchemas.set(
    'git:generate-commit-message',
    z.tuple([pathStr, z.record(z.string(), z.unknown()), z.unknown().optional(), z.string().max(128).optional()])
  )
  channelSchemas.set('git:cancel-commit-message', z.tuple([id128]))
}

/** 上传通道:HTTP 信封放宽 40MiB、通用字符串限额豁免(内容限额在业务层以解码后字节为准)。 */
export const UPLOAD_CHANNELS = new Set(['attachments:upload', 'skills:import-web'])

/** 副作用通道:同一登录会话内按 requestId 去重(§5.3)。TODO(P4) 补充其余副作用通道。 */
const SIDE_EFFECT_CHANNELS = new Set(['chat:send', 'tasks:run-now'])

const DEDUP_TTL_MS = 15 * 60_000
const DEDUP_MAX_ENTRIES = 1000

/** 请求信封校验(args 内容校验交给 channelSchemas)。 */
const envelopeSchema = z.object({
  v: z.literal(1),
  requestId: z.string().min(1).max(128),
  args: z.array(z.unknown()).max(64).optional(),
  // 实时相关请求携带 WS hello 分配的连接标识;服务端验证它属于当前 Cookie 会话(标识本身不是授权)
  connectionId: z.string().min(1).max(128).optional()
})

export interface InvokeOutcome {
  status: number
  payload: unknown
  /** false = 该通道尚未配置 zod schema(HTTP 层据此加响应头标注)。 */
  schemaValidated: boolean
}

export interface DispatchOptions {
  channel: string
  body: unknown
  /** 登录会话标识(服务端注入,业务一般不需要)。 */
  sessionId: string
  /** HTTP 请求的丢弃型 sender(响应连接关闭即 destroyed)。 */
  fallbackSender: UiEventSender
  /** connectionId 属于该会话时返回其 WS 定向 sender;无效/不属于该会话返回 null。
   *  仅在信封携带非空 connectionId 时被调用。 */
  resolveSender: (connectionId: string, sessionId: string) => UiEventSender | null
}

interface DedupEntry {
  state: 'pending' | 'settled'
  promise: Promise<void> | null
  outcome: InvokeOutcome | null
  expiresAt: number
}

/** 副作用去重表:同 key 并发共享同一执行,结算结果短 TTL 内复用;5xx 不缓存(允许重试)。 */
class SideEffectDedup {
  private entries = new Map<string, DedupEntry>()

  async run(key: string, fn: () => Promise<InvokeOutcome>): Promise<InvokeOutcome> {
    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing && existing.expiresAt > now) {
      if (existing.state === 'pending' && existing.promise) {
        await existing.promise
        return existing.outcome as InvokeOutcome
      }
      if (existing.state === 'settled' && existing.outcome) return existing.outcome
    }
    const entry: DedupEntry = { state: 'pending', promise: null, outcome: null, expiresAt: now + DEDUP_TTL_MS }
    entry.promise = (async () => {
      try {
        entry.outcome = await fn()
      } finally {
        entry.state = 'settled'
        entry.expiresAt = Date.now() + DEDUP_TTL_MS
        // 服务端错误不进入结果缓存:结果待确认,由 UI 引导用户核实而非 15 分钟内钉死失败
        if (entry.outcome && entry.outcome.status >= 500) this.entries.delete(key)
      }
    })()
    this.entries.set(key, entry)
    this.bound()
    await entry.promise
    return entry.outcome as InvokeOutcome
  }

  private bound(): void {
    if (this.entries.size <= DEDUP_MAX_ENTRIES) return
    const now = Date.now()
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k)
    if (this.entries.size <= DEDUP_MAX_ENTRIES) return
    for (const [k, e] of this.entries) {
      if (this.entries.size <= DEDUP_MAX_ENTRIES) break
      if (e.state === 'settled') this.entries.delete(k)
    }
  }
}

const sideEffectDedup = new SideEffectDedup()

// ── 通用参数守卫(P4,先于逐通道 schema):形状上限对所有通道一致 ──
const MAX_ARGS_COUNT = 16
const MAX_ARG_STRING_BYTES = 1024 * 1024
const MAX_ARG_DEPTH = 8

/**
 * 形状守卫:args 数量 ≤16;单参字符串(含嵌套)≤1MiB —— 上传通道(attachments:upload /
 * skills:import-web)豁免字符串限额,其内容上限由 body 40MiB + 业务层解码后字节判定;
 * 对象/数组嵌套深度 ≤8(数组算一层)。JSON 已解析(无环),逐节点行走线性成本。
 * 返回错误文案或 null。
 */
function checkArgsShape(channel: string, args: unknown[]): string | null {
  if (args.length > MAX_ARGS_COUNT) return `args 数量超限(≤${MAX_ARGS_COUNT})`
  const exemptString = UPLOAD_CHANNELS.has(channel)
  const walk = (v: unknown, depth: number): string | null => {
    if (typeof v === 'string') {
      if (!exemptString && Buffer.byteLength(v, 'utf8') > MAX_ARG_STRING_BYTES) return '字符串参数超过 1MiB 上限'
      return null
    }
    if (v === null || typeof v !== 'object') return null
    if (depth >= MAX_ARG_DEPTH) return '参数嵌套深度超限(≤8 层)'
    if (Array.isArray(v)) {
      for (const item of v) {
        const e = walk(item, depth + 1)
        if (e) return e
      }
      return null
    }
    for (const key of Object.keys(v as Record<string, unknown>)) {
      const e = walk((v as Record<string, unknown>)[key], depth + 1)
      if (e) return e
    }
    return null
  }
  for (const arg of args) {
    const e = walk(arg, 1)
    if (e) return e
  }
  return null
}

function errorPayload(code: string, message: string, requestId: string | null): unknown {
  return { ok: false, error: { code, message }, requestId }
}

function zodMessage(err: z.ZodError): string {
  const first = err.issues[0]
  if (!first) return '参数不合法'
  const where = first.path.length > 0 ? first.path.join('.') : '(root)'
  return `${where}: ${first.message}`
}

function toInvokeError(err: unknown): { code: string; message: string } {
  if (err instanceof InvokeError) return { code: err.code, message: err.message }
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && INVOKE_STATUS[code] !== undefined) {
    return { code, message: errMessage(err) || code }
  }
  // 普通 Error:message 可展示(业务语义),堆栈仅进服务端日志,响应不泄露
  return { code: 'INTERNAL', message: err instanceof Error ? err.message.slice(0, 500) : '内部错误' }
}

/** 分发一次 invoke:解析信封 → 通道 schema 校验 → 解析 sender →(副作用去重)→ 调处理器。 */
export async function dispatchInvoke(opts: DispatchOptions): Promise<InvokeOutcome> {
  const { channel, body, sessionId, fallbackSender, resolveSender } = opts

  const handler = getInvokeHandler(channel)
  if (!handler) {
    // 注册表即白名单:未注册通道 404
    return { status: 404, payload: errorPayload('NOT_FOUND', '未知通道', null), schemaValidated: false }
  }

  const parsedEnvelope = envelopeSchema.safeParse(body)
  if (!parsedEnvelope.success) {
    return {
      status: 400,
      payload: errorPayload('INVALID_ARGUMENT', `请求信封不合法: ${zodMessage(parsedEnvelope.error)}`, null),
      schemaValidated: false
    }
  }
  const envelope = parsedEnvelope.data
  const requestId = envelope.requestId
  const rawArgs = envelope.args ?? []

  // 通用形状守卫(≤16 参 / 单参字符串 ≤1MiB(上传通道除外) / 深度 ≤4),先于逐通道 schema
  const shapeErr = checkArgsShape(channel, rawArgs)
  if (shapeErr) {
    return {
      status: 400,
      payload: errorPayload('INVALID_ARGUMENT', shapeErr, requestId),
      schemaValidated: false
    }
  }

  let args: unknown[] = rawArgs
  let schemaValidated = false
  const schema = channelSchemas.get(channel)
  if (schema) {
    schemaValidated = true
    const parsed = schema.safeParse(rawArgs)
    if (!parsed.success) {
      return {
        status: 400,
        payload: errorPayload('INVALID_ARGUMENT', `参数校验失败: ${zodMessage(parsed.error)}`, requestId),
        schemaValidated: true
      }
    }
    args = parsed.data as unknown[]
  }

  // HTTP invoke 无 WS 连接 → 丢弃型 sender;带了 connectionId 且属于本会话 → 定向 sender
  const sender = (envelope.connectionId ? resolveSender(envelope.connectionId, sessionId) : null) ?? fallbackSender
  const evt: InvokeEvent = {
    sender,
    requestId,
    connectionId: envelope.connectionId ?? null,
    sessionId
  }

  const exec = async (): Promise<InvokeOutcome> => {
    try {
      const result = await handler(evt, ...args)
      return {
        status: 200,
        payload: { ok: true, result: result === undefined ? null : result, requestId },
        schemaValidated
      }
    } catch (err) {
      logError('invoke', `通道 ${channel} 处理失败(requestId=${requestId})`, err)
      const e = toInvokeError(err)
      return {
        status: INVOKE_STATUS[e.code] ?? 500,
        payload: errorPayload(e.code, e.message, requestId),
        schemaValidated
      }
    }
  }

  if (SIDE_EFFECT_CHANNELS.has(channel)) {
    return sideEffectDedup.run(`${sessionId}|${channel}|${requestId}`, exec)
  }
  return exec()
}
