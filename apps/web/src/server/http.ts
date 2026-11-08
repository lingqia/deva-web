/**
 * Express 应用工厂(web-migration-plan.md §5.1/§5.2):
 * - 所有 POST(含 login/logout):要求 JSON、头 X-Deva-Client: 1、精确 Origin === env.origin
 *   (不匹配 403;不开放通配 CORS);鉴权/来源检查先于大 body 解析。
 * - 路由:GET /api/health 公开;GET /api/ready 按 readiness;GET /api/auth/me 会话检查(no-store);
 *   POST /api/login(限流 5 失败/min/IP,429+Retry-After);POST /api/logout(撤销会话、清 Cookie、
 *   关其全部 WS);POST /api/invoke/:channel 白名单分发;GET /api/files/*;GET /ws 非升级明确失败;
 *   未知 /api 一律 JSON 404;非 GET 不走 SPA fallback。
 * - body 限额:普通 JSON 8MiB,login 单独 4KiB;附件/技能上传通道(attachments:upload /
 *   skills:import-web)放宽 40MiB(P4,按通道动态挂 express.json)。
 * - 代理:默认不信任代理头;DEVA_TRUST_PROXY=1 时仅按 '127.0.0.1' 单层设置(§5.2.8)。
 * - 静态资源仅 out/renderer 根:HTML no-cache,/assets/(Vite hash 资源)immutable;
 *   不暴露源码/数据目录/任意服务器路径。
 */
import express, { NextFunction, Request, RequestHandler, Response } from 'express'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { contentType as mimeContentType } from 'mime-types'
import type { UiEventSender } from '../main/platform'
import type { ServerEnv } from './env'
import {
  SESSION_COOKIE,
  FailureRateLimiter,
  parseCookies,
  serializeClearedCookie,
  serializeSessionCookie,
  verifyToken
} from './auth'
import type { SessionManager, SessionRecord } from './auth'
import { INVOKE_STATUS, InvokeError, dispatchInvoke, UPLOAD_CHANNELS } from './registry'
import type { WsHub } from './ws'
import type { FilesHandlers } from './files'
import { getReadyState, isShuttingDown } from './readiness'
import { errMessage, warn } from './log'

export interface AppDeps {
  auth: SessionManager
  hub: WsHub
  files: FilesHandlers
}

/** HTTP invoke 的丢弃型 sender:send 为 no-op、isDestroyed 恒 true;destroyed 监听在响应连接关闭时触发。 */
class DropSender implements UiEventSender {
  private listeners = new Set<() => void>()
  private closed = false

  constructor(res: Response) {
    res.on('close', () => this.destroy())
  }

  send(): void {
    /* HTTP invoke 无推送通道:流式更新不投递,结果经 invoke 返回值带回 */
  }

  once(_event: 'destroyed', listener: () => void): void {
    if (this.closed) listener()
    else this.listeners.add(listener)
  }

  off(_event: 'destroyed', listener?: () => void): void {
    if (listener) this.listeners.delete(listener)
  }

  isDestroyed(): boolean {
    return this.closed
  }

  private destroy(): void {
    if (this.closed) return
    this.closed = true
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch {
        /* 回调自负责 */
      }
    }
    this.listeners.clear()
  }
}

function jsonErr(res: Response, status: number, code: string, message: string): void {
  res.status(status).set({ 'Cache-Control': 'no-store' }).json({ ok: false, error: { code, message } })
}

// body 限额用数字而非 '8MiB' 字符串:bytes@3.1 不支持 MiB 单位,会把 '8MiB' 解析成 8 字节
const LOGIN_BODY_LIMIT = 4 * 1024
const JSON_BODY_LIMIT = 8 * 1024 * 1024
// 上传通道(§5.1:仅附件/技能上传放宽到 40MiB;解码后大小由业务层按类型校验)
const UPLOAD_BODY_LIMIT = 40 * 1024 * 1024

/** express 4 不捕获 async 错误:统一包装转发到错误中间件。 */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

/** 静态根:仅允许 out/renderer;不暴露 server 产物/源码/数据目录。 */
function rendererRoot(): string {
  // 产物相对本文件定位:out/server/index.cjs → ../renderer
  return path.resolve(__dirname, '..', 'renderer')
}

const staticHandler: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return jsonErr(res, 404, 'NOT_FOUND', '未找到')
  }
  const root = rendererRoot()
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://deva.internal').pathname)
  } catch {
    return jsonErr(res, 400, 'INVALID_ARGUMENT', 'URL 非法')
  }
  if (pathname.includes('\0')) return jsonErr(res, 400, 'INVALID_ARGUMENT', 'URL 非法')

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = path.normalize(path.join(root, rel))
  const withinRoot = file === path.join(root, 'index.html') || file.startsWith(root + path.sep)
  if (!withinRoot) return jsonErr(res, 404, 'NOT_FOUND', '未找到')

  let target = file
  let exists = false
  try {
    exists = existsSync(target) && statSync(target).isFile()
  } catch {
    exists = false
  }
  if (!exists) {
    // SPA fallback 仅 GET;非静态路径回 index.html(首版根路径部署,无子路径)
    if (req.method !== 'GET') return jsonErr(res, 404, 'NOT_FOUND', '未找到')
    target = path.join(root, 'index.html')
    if (!existsSync(target)) {
      return jsonErr(res, 503, 'UNAVAILABLE', '前端资源未构建:请先运行 pnpm build')
    }
  }

  const isHtml = target.endsWith('.html')
  // hash 资源 immutable,HTML no-cache;其余未知缓存策略一律 no-cache 保守处理
  const cache = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  const type = mimeContentType(path.basename(target)) || 'application/octet-stream'
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', cache)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(target)
  stream.on('error', () => {
    if (!res.headersSent) jsonErr(res, 500, 'INTERNAL', '读取失败')
    else res.destroy()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

export function createApp(env: ServerEnv, deps: AppDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  // 代理头:默认不信任;仅明确配置时信任本机 nginx 单层(§5.2.8),限流/日志按真实 IP
  app.set('trust proxy', env.trustProxy ? '127.0.0.1' : false)

  // 全局安全头;API 一律 no-store
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  const loginLimiter = new FailureRateLimiter()

  // ---- 公开探针(不含配置与内部状态)----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.get('/api/ready', (_req, res) => {
    const state = getReadyState()
    if (state === 'ready' && !isShuttingDown()) res.json({ ok: true })
    else res.status(503).json({ ok: false, state })
  })

  // ---- 变更方法守卫:精确 Origin + 客户端标识 + JSON(先于 body 解析)----
  app.use((req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH' && req.method !== 'DELETE') {
      return next()
    }
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0 || origin.toLowerCase() !== env.origin.toLowerCase()) {
      return jsonErr(res, 403, 'FORBIDDEN', 'Origin 不被允许')
    }
    if (req.headers['x-deva-client'] !== '1') {
      return jsonErr(res, 403, 'FORBIDDEN', '缺少 X-Deva-Client 头')
    }
    const ct = req.headers['content-type']
    if (typeof ct !== 'string' || !/^\s*application\/[\w.+-]*json\b/i.test(ct)) {
      return jsonErr(res, 400, 'INVALID_ARGUMENT', 'POST 请求需要 application/json')
    }
    next()
  })

  function clientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown'
  }

  function requireSession(req: Request, res: Response, next: NextFunction): void {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    const rec = deps.auth.resolveSession(sid)
    if (!rec) return jsonErr(res, 401, 'UNAUTHORIZED', '未登录或会话已过期')
    ;(res.locals as { session?: SessionRecord }).session = rec
    next()
  }

  // ---- 登录:限流检查先于 body 解析;失败限流 5 次/min/IP ----
  app.post(
    '/api/login',
    (req, res, next) => {
      const verdict = loginLimiter.check(clientIp(req))
      if (verdict.limited) {
        res.setHeader('Retry-After', String(verdict.retryAfterSec))
        return jsonErr(res, 429, 'RATE_LIMITED', '尝试过于频繁,请稍后再试')
      }
      next()
    },
    express.json({ limit: LOGIN_BODY_LIMIT }),
    (req, res) => {
      const body = req.body as unknown
      const token =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)['token']
          : undefined
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
        return jsonErr(res, 400, 'INVALID_ARGUMENT', '缺少 token')
      }
      if (!verifyToken(token, env.tokenSha256)) {
        loginLimiter.recordFailure(clientIp(req))
        return jsonErr(res, 401, 'UNAUTHORIZED', 'token 不正确')
      }
      const { id } = deps.auth.createSession()
      res.setHeader('Set-Cookie', serializeSessionCookie(id, env.isProduction))
      res.json({ ok: true })
    }
  )

  // ---- 登出:撤销会话、清 Cookie、关闭其全部 WS(后台聊天/任务不受影响,§5.2.5)----
  app.post(
    '/api/logout',
    requireSession,
    express.json({ limit: LOGIN_BODY_LIMIT }),
    (req, res) => {
      void req
      const rec = (res.locals as { session?: SessionRecord }).session
      if (rec) {
        deps.auth.revoke(rec.idHash)
        deps.hub.closeSession(rec.idHash)
      }
      res.setHeader('Set-Cookie', serializeClearedCookie(env.isProduction))
      res.json({ ok: true })
    }
  )

  // ---- 会话探针:no-store(由 /api 中间件统一设置)----
  app.get('/api/auth/me', (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    const rec = deps.auth.resolveSession(sid)
    if (!rec) return jsonErr(res, 401, 'UNAUTHORIZED', '未登录或会话已过期')
    res.json({ ok: true })
  })

  // ---- invoke 分发:仅注册表白名单通道;8MiB 普通 JSON 限额,附件/技能上传通道放宽 40MiB(§5.1) ----
  app.post(
    '/api/invoke/:channel',
    requireSession,
    (req, res, next) => {
      const channel = req.params['channel']
      const limit =
        typeof channel === 'string' && UPLOAD_CHANNELS.has(channel) ? UPLOAD_BODY_LIMIT : JSON_BODY_LIMIT
      express.json({ limit })(req, res, next)
    },
    asyncHandler(async (req, res) => {
      const rec = (res.locals as { session?: SessionRecord }).session
      if (!rec) return jsonErr(res, 401, 'UNAUTHORIZED', '未登录或会话已过期')
      const outcome = await dispatchInvoke({
        channel: typeof req.params['channel'] === 'string' ? req.params['channel'] : '',
        body: req.body,
        sessionId: rec.idHash,
        fallbackSender: new DropSender(res),
        resolveSender: (connectionId, sessionId) => deps.hub.lookupSender(connectionId, sessionId)
      })
      if (!outcome.schemaValidated) {
        // P4 已覆盖核心通道;其余通道保持响应头标注,逐通道补齐(见 registry.ts channelSchemas)
        res.setHeader('X-Deva-Args-Schema', 'unvalidated; TODO add per-channel schema')
      }
      res.status(outcome.status).json(outcome.payload)
    })
  )

  // ---- 文件协议(登录态由路由链保证)----
  app.get('/api/files/raw', requireSession, asyncHandler(deps.files.raw))
  app.get('/api/files/deliverable', requireSession, asyncHandler(deps.files.deliverable))

  // ---- /ws 非升级请求明确失败(不走 SPA fallback)----
  app.get('/ws', (_req, res) => {
    jsonErr(res, 426, 'UPGRADE_REQUIRED', '/ws 需要 WebSocket 升级请求')
  })

  // ---- 未知 /api:一律 JSON 404 ----
  app.use('/api', (_req, res) => {
    jsonErr(res, 404, 'NOT_FOUND', '未知 API')
  })

  // ---- 静态资源(仅 out/renderer;GET/HEAD)----
  app.use(staticHandler)

  // ---- 兜底 404 ----
  app.use((_req, res) => {
    jsonErr(res, 404, 'NOT_FOUND', '未找到')
  })

  // ---- 错误中间件(body-parser 与 asyncHandler 转发的错误;不泄露堆栈)----
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const type = (err as { type?: string } | null)?.type
    if (type === 'entity.too.large') return jsonErr(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大')
    if (
      type === 'entity.parse.failed' ||
      type === 'encoding.unsupported' ||
      type === 'charset.unsupported' ||
      type === 'request.aborted'
    ) {
      return jsonErr(res, 400, 'INVALID_ARGUMENT', 'JSON 请求体无法解析')
    }
    if (err instanceof InvokeError) {
      return jsonErr(res, INVOKE_STATUS[err.code] ?? 500, err.code, err.message)
    }
    warn('http', `请求处理异常: ${errMessage(err)}`)
    jsonErr(res, 500, 'INTERNAL', '内部错误')
  })

  return app
}
