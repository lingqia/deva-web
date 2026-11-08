/**
 * 登录会话与限流(web-migration-plan.md §5.2):
 * - token 以固定长度 sha256 摘要 timingSafeEqual 比较;token/Cookie 值不落日志、不进 URL/localStorage。
 * - Cookie 存独立生成的 32 字节 hex sessionId;服务端只存其 sha256、创建时间、token 版本指纹。
 * - 持久化 DEVA_HOME/web-sessions.json(0600,临时文件 + rename 原子写),正常重启保持登录;
 *   换 token(指纹不符)→ 旧会话全部失效。
 * - Cookie:HttpOnly、SameSite=Lax、Path=/、不设 Domain、30 天;生产 Secure;
 *   开发(NODE_ENV!=='production')localhost HTTP 允许非 Secure,不依据 X-Forwarded-Proto 降级。
 * - 登录限流:每 IP 每分钟 5 次失败,超限 429 + Retry-After;有界内存表 + 过期清理。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ServerEnv } from './env'
import { errMessage, warn } from './log'

export const SESSION_COOKIE = 'deva_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000)
/** 有界:最多保留的会话数(超出丢最旧)。 */
const MAX_SESSIONS = 100
const SESSIONS_VERSION = 1

export interface SessionRecord {
  /** sha256(sessionId) —— 服务端不存明文 sessionId。 */
  idHash: string
  createdAt: number
  /** 当前 token 摘要;换 token 后不匹配即失效。 */
  tokenFingerprint: string
}

interface SessionsFile {
  version: number
  sessions: SessionRecord[]
}

function sha256buf(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest()
}

/**
 * token 校验:两侧都先归一为 32 字节 sha256 摘要再 timingSafeEqual,
 * 比较长度恒定,与攻击输入长度无关。
 */
export function verifyToken(token: string, expectedSha256Hex: string): boolean {
  const a = sha256buf(token)
  const b = Buffer.from(expectedSha256Hex, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 极简 Cookie 解析(不引入 cookie-parser)。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && !(k in out)) out[k] = v
  }
  return out
}

function cookieAttrs(secure: boolean): string {
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}${secure ? '; Secure' : ''}`
}

export function serializeSessionCookie(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionId}; ${cookieAttrs(secure)}`
}

export function serializeClearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(secure)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>()
  private readonly file: string

  constructor(private env: ServerEnv) {
    this.file = path.join(env.devaHome, 'web-sessions.json')
    this.load()
  }

  /** 启动加载:丢弃过期会话与 token 指纹不符的会话(换 token 即全部失效)。 */
  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return // 首次运行 / 不存在:空库
    }
    let parsed: SessionsFile | null = null
    try {
      parsed = JSON.parse(raw) as SessionsFile
    } catch {
      warn('auth', 'web-sessions.json 无法解析,按空会话库处理')
    }
    if (!parsed || parsed.version !== SESSIONS_VERSION || !Array.isArray(parsed.sessions)) {
      warn('auth', 'web-sessions.json 格式不符,按空会话库处理')
      return
    }
    const now = Date.now()
    for (const s of parsed.sessions) {
      if (!s || typeof s.idHash !== 'string' || typeof s.createdAt !== 'number' || typeof s.tokenFingerprint !== 'string') continue
      if (s.tokenFingerprint !== this.env.tokenSha256) continue // 换 token:失效
      if (now - s.createdAt > SESSION_TTL_MS) continue // 过期:失效
      this.sessions.set(s.idHash, s)
    }
    if (this.sessions.size > 0) this.persist()
  }

  /**
   * 原子持久化:同目录临时文件(0600)+ rename 覆盖。
   * Windows 上 mode 参数不生效(采用当前用户 ACL),不宣称与 chmod 同等保护。
   */
  private persist(): void {
    const data: SessionsFile = { version: SESSIONS_VERSION, sessions: [...this.sessions.values()] }
    const tmp = `${this.file}.tmp.${randomBytes(6).toString('hex')}`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      warn('auth', `会话持久化失败(重启后需重新登录): ${errMessage(err)}`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 临时文件清理失败可忽略 */
      }
    }
  }

  /** 创建会话:32 字节随机 hex sessionId;服务端只留摘要。 */
  createSession(): { id: string; record: SessionRecord } {
    const id = randomBytes(32).toString('hex')
    const record: SessionRecord = {
      idHash: sha256buf(id).toString('hex'),
      createdAt: Date.now(),
      tokenFingerprint: this.env.tokenSha256
    }
    this.sessions.set(record.idHash, record)
    if (this.sessions.size > MAX_SESSIONS) {
      let oldest: SessionRecord | null = null
      for (const s of this.sessions.values()) if (!oldest || s.createdAt < oldest.createdAt) oldest = s
      if (oldest) this.sessions.delete(oldest.idHash)
    }
    this.persist()
    return { id, record }
  }

  /** Cookie 中的 sessionId → 会话记录;不存在/过期一律 null(不暴露差异)。 */
  resolveSession(sessionId: string | undefined): SessionRecord | null {
    if (!sessionId || sessionId.length !== 64) return null
    const idHash = sha256buf(sessionId).toString('hex')
    const rec = this.sessions.get(idHash)
    if (!rec) return null
    if (Date.now() - rec.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(idHash)
      this.persist()
      return null
    }
    return rec
  }

  /** 心跳/上行同步校验(WS 用):按 idHash 判断会话仍有效。 */
  sessionAlive(idHash: string): boolean {
    const rec = this.sessions.get(idHash)
    if (!rec) return false
    if (Date.now() - rec.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(idHash)
      return false
    }
    return true
  }

  /** 撤销会话(登出/管理性撤销);WS 连接由调用方经 hub.closeSession 关闭。 */
  revoke(idHash: string): void {
    if (!this.sessions.delete(idHash)) return
    this.persist()
  }

  get count(): number {
    return this.sessions.size
  }
}

export interface RateVerdict {
  limited: boolean
  retryAfterSec: number
}

/** 登录失败限流:固定窗口计数,key=IP;有界 + 过期清理。 */
export class FailureRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()
  private lastSweep = 0

  constructor(
    private maxFailures = 5,
    private windowMs = 60_000,
    private maxEntries = 10_000
  ) {}

  check(key: string): RateVerdict {
    this.sweepIfNeeded()
    const e = this.hits.get(key)
    const now = Date.now()
    if (!e || now >= e.resetAt) return { limited: false, retryAfterSec: 0 }
    if (e.count >= this.maxFailures) {
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) }
    }
    return { limited: false, retryAfterSec: 0 }
  }

  recordFailure(key: string): void {
    const e = this.hits.get(key)
    const now = Date.now()
    if (!e || now >= e.resetAt) this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
    else e.count += 1
    this.sweepIfNeeded(true)
  }

  private sweepIfNeeded(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastSweep < 30_000) return
    this.lastSweep = now
    for (const [k, e] of this.hits) if (now >= e.resetAt) this.hits.delete(k)
    if (this.hits.size > this.maxEntries) {
      // 有界:按到期时间丢弃最早条目
      const entries = [...this.hits.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
      for (let i = 0; i < entries.length - this.maxEntries; i++) this.hits.delete(entries[i][0])
    }
  }
}
