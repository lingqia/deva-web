/**
 * 启动环境校验(自 P1 index.ts 平移,语义不变):缺配置拒绝启动,不为方便绕过鉴权。
 * web-migration-plan.md §5.2:token 所有模式必填(含回环上游)且拒绝占位值;
 * origin 为完整 scheme://host[:port] 精确来源;DEVA_HOME 必须存在。
 */
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { devaHome } from '../main/platform'
import { errMessage } from './log'

const PLACEHOLDER_TOKENS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'your-token-here',
  'deva-web-token',
  'token',
  'secret',
  'please-change'
])

export interface ServerEnv {
  host: string
  port: number
  origin: string
  tokenSha256: string
  devaHome: string
  trustProxy: boolean
  autostart: boolean
  /** NODE_ENV === 'production';开发判定 = !isProduction(Cookie 允许非 Secure 等)。 */
  isProduction: boolean
}

export function fail(message: string): never {
  console.error(`[startup] ${message}`)
  process.exit(1)
}

/** token 摘要(timingSafeEqual 用;摘要长度固定,不落日志)。 */
export function sha256hex(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex')
}

export function validateEnv(): ServerEnv {
  const host = process.env['DEVA_WEB_HOST'] ?? '127.0.0.1'
  const portRaw = process.env['DEVA_WEB_PORT'] ?? '7421'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`DEVA_WEB_PORT 非法: ${portRaw}`)

  // token:所有环境必填(含 127.0.0.1 回环上游);示例占位值拒绝启动。
  const token = process.env['DEVA_WEB_TOKEN'] ?? ''
  if (!token || token.trim().length === 0) {
    fail('缺少 DEVA_WEB_TOKEN(必填,建议 openssl rand -hex 32 生成;回环地址也不允许无鉴权运行)')
  }
  if (PLACEHOLDER_TOKENS.has(token.trim().toLowerCase())) {
    fail('DEVA_WEB_TOKEN 为示例占位值,拒绝启动')
  }

  // origin:精确允许来源(生产 https://域名,开发 http://127.0.0.1:5173);无路径/查询串。
  const origin = process.env['DEVA_WEB_ORIGIN'] ?? ''
  if (!origin) fail('缺少 DEVA_WEB_ORIGIN(必填,如 https://deva.example.com)')
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)) {
    fail(`DEVA_WEB_ORIGIN 非法(须为完整 scheme://host[:port],无路径/查询串): ${origin}`)
  }

  const home = devaHome()
  if (!existsSync(home)) {
    fail(`数据目录不存在: ${home}(请先创建并授权,或设置 DEVA_HOME)`)
  }
  try {
    statSync(home)
  } catch (err) {
    fail(`数据目录不可访问: ${home}(${errMessage(err)})`)
  }

  const trustProxy = process.env['DEVA_TRUST_PROXY'] === '1'
  const autostart = process.env['DEVA_AUTOSTART'] !== '0'
  const isProduction = process.env['NODE_ENV'] === 'production'

  return { host, port, origin, tokenSha256: sha256hex(token), devaHome: home, trustProxy, autostart, isProduction }
}
