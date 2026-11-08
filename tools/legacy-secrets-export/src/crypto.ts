import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type CipherGCM,
  type DecipherGCM
} from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * 纯 Node 共享加密层(无任何 Electron import)——导出/导入两个模式与单测共用。
 *
 * 迁移包格式 deva-secrets-export v1:
 *   { format:'deva-secrets-export', version:1, kdf:{name:'scrypt',N:32768,r:8,p:1},
 *     salt:b64(16B), iv:b64(12B), tag:b64(16B), ct:b64, createdAt }
 * - 整包 AES-256-GCM;AAD = 'deva-secrets-export:v1'(绑定格式与版本,防包体字段移植)。
 * - 密钥 = scrypt(交互口令, salt, 32, {N:2^15, r:8, p:1});口令不进 argv、不落盘、不进日志。
 * - 明文载荷(仅内存):{ format, version, exportedAt, source, entries:{[键]:明文}, failures, counts }
 *
 * Web 端 secrets.json v1 条目信封(与 apps/web/src/main/services/secrets.ts 保持一致,
 * 双方不得单方修改字段):{ v:1, alg:'aes-256-gcm', iv:b64(12B), tag:b64(16B), ct:b64 },
 * AAD = 存储键名(防条目替换/移植)。主密钥:DEVA_SECRET_KEY(64 hex,严格校验,非法即抛错)
 * > <home>/secret.key(原始 32 字节,兼容 64 hex 文本)。
 *
 * 限额:KDF 参数固定如上;迁移包文件 ≤ 16 MiB,明文载荷 ≤ 8 MiB,条目 ≤ 1000 条,
 * 单值 ≤ 64 KiB(密钥库里只有 API token 类短值,超限即视为异常并拒绝)。
 */

export const EXPORT_FORMAT = 'deva-secrets-export'
export const EXPORT_VERSION = 1
export const EXPORT_AAD = 'deva-secrets-export:v1'
export const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 } as const
export const KEY_BYTES = 32
export const SALT_BYTES = 16
export const IV_BYTES = 12
export const TAG_BYTES = 16
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
export const MAX_ENTRIES = 1000
export const MAX_VALUE_BYTES = 64 * 1024
export const MIN_PASSPHRASE_LEN = 8

export interface MigrationPackage {
  format: string
  version: number
  kdf: { name: string; N: number; r: number; p: number }
  salt: string
  iv: string
  tag: string
  ct: string
  createdAt: string
}

export interface ExportPayload {
  format: string
  version: number
  exportedAt: string
  source: Record<string, unknown>
  entries: Record<string, string>
  failures: { id: string; reason: string; detail?: string }[]
  counts: { total: number; ok: number; failed: number }
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

// ---------------------------------------------------------------------------
// 口令派生与迁移包封/拆
// ---------------------------------------------------------------------------

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new ToolError(`口令过短(至少 ${MIN_PASSPHRASE_LEN} 个字符)`)
  }
  // maxmem 默认 32 MiB,恰好卡在 128*N*r 上,放宽一倍避免 EFBIG
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 128 * KDF.N * KDF.r * 2
  })
}

/** 封包:明文载荷 → JSON → AES-256-GCM。随机 salt/iv,口令绝不出现在返回值/日志。 */
export function sealPackage(payload: ExportPayload, passphrase: string): MigrationPackage {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new ToolError(
      `明文载荷 ${plaintext.length} 字节超过限额 ${MAX_PAYLOAD_BYTES}(密钥库不应这么大,疑似异常数据)`
    )
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM
  cipher.setAAD(Buffer.from(EXPORT_AAD, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    kdf: { ...KDF },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    createdAt: new Date().toISOString()
  }
}

/** 拆包:严格校验格式/版本/KDF 参数/大小,再验 GCM 认证标签。口令错 = 抛错(不区分于损坏)。 */
export function openPackage(pkg: unknown, passphrase: string): ExportPayload {
  if (!pkg || typeof pkg !== 'object') throw new ToolError('迁移包结构异常(不是对象)')
  const p = pkg as Record<string, unknown>
  if (p['format'] !== EXPORT_FORMAT || p['version'] !== EXPORT_VERSION) {
    throw new ToolError(
      `迁移包格式/版本不符:期望 ${EXPORT_FORMAT} v${EXPORT_VERSION},实际 ${String(p['format'])} v${String(p['version'])}`
    )
  }
  const kdf = p['kdf'] as Record<string, unknown> | undefined
  if (
    !kdf ||
    kdf['name'] !== KDF.name ||
    kdf['N'] !== KDF.N ||
    kdf['r'] !== KDF.r ||
    kdf['p'] !== KDF.p
  ) {
    throw new ToolError('KDF 参数与既定规范不符,拒绝派生(防 KDF 降级)')
  }
  const salt = Buffer.from(String(p['salt'] ?? ''), 'base64')
  const iv = Buffer.from(String(p['iv'] ?? ''), 'base64')
  const tag = Buffer.from(String(p['tag'] ?? ''), 'base64')
  const ct = Buffer.from(String(p['ct'] ?? ''), 'base64')
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new ToolError('迁移包 salt/iv/tag 长度不符')
  }
  if (ct.length > MAX_PAYLOAD_BYTES) {
    throw new ToolError(`迁移包密文 ${ct.length} 字节超过限额 ${MAX_PAYLOAD_BYTES}`)
  }
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv) as DecipherGCM
  decipher.setAAD(Buffer.from(EXPORT_AAD, 'utf8'))
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new ToolError('迁移包解密失败:口令错误或包体被篡改')
  }
  const payload = JSON.parse(plaintext.toString('utf8')) as ExportPayload
  if (!payload || payload.format !== EXPORT_FORMAT || payload.version !== EXPORT_VERSION) {
    throw new ToolError('解包后载荷格式校验失败')
  }
  validatePayload(payload)
  return payload
}

export function validatePayload(payload: ExportPayload): void {
  if (!payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries)) {
    throw new ToolError('载荷缺少 entries 对象')
  }
  const keys = Object.keys(payload.entries)
  if (keys.length > MAX_ENTRIES) {
    throw new ToolError(`条目数 ${keys.length} 超过限额 ${MAX_ENTRIES}`)
  }
  for (const [k, v] of Object.entries(payload.entries)) {
    if (typeof v !== 'string') throw new ToolError(`条目 "${k}" 的值不是字符串`)
    if (Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES) {
      throw new ToolError(`条目 "${k}" 的值超过 ${MAX_VALUE_BYTES} 字节限额`)
    }
  }
  if (!Array.isArray(payload.failures)) payload.failures = []
}

// ---------------------------------------------------------------------------
// Web 端 secrets.json v1 信封(与 apps/web secrets.ts 对齐)
// ---------------------------------------------------------------------------

export interface SecretEnvelopeV1 {
  v: 1
  alg: 'aes-256-gcm'
  iv: string
  tag: string
  ct: string
}

export function encryptForEntry(key: string, plaintext: string, master: Buffer): SecretEnvelopeV1 {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', master, iv) as CipherGCM
  cipher.setAAD(Buffer.from(key, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
}

export function decryptForEntry(key: string, env: SecretEnvelopeV1, master: Buffer): string {
  const iv = Buffer.from(env.iv, 'base64')
  const tag = Buffer.from(env.tag, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new ToolError('信封字段长度不符')
  const decipher = createDecipheriv('aes-256-gcm', master, iv) as DecipherGCM
  decipher.setAAD(Buffer.from(key, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}

export function isEnvelopeV1(value: unknown): value is SecretEnvelopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 &&
    e['alg'] === 'aes-256-gcm' &&
    typeof e['iv'] === 'string' &&
    typeof e['tag'] === 'string' &&
    typeof e['ct'] === 'string'
  )
}

// ---------------------------------------------------------------------------
// 主密钥装载(导入端;与 apps/web secrets.ts 同规则)
// ---------------------------------------------------------------------------

/** DEVA_SECRET_KEY 严格校验:64 hex → 32 字节;非法即抛错,绝不回落。 */
export function parseHexKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ToolError('DEVA_SECRET_KEY 非法:必须为 64 个十六进制字符(32 字节)')
  }
  return Buffer.from(hex, 'hex')
}

/** 读 secret.key:原始 32 字节,或 64 hex 文本;存在但异常 → 抛错(绝不重生成覆盖)。 */
export async function readKeyFile(keyFile: string): Promise<Buffer | null> {
  let buf: Buffer
  try {
    buf = await fs.readFile(keyFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ToolError(`主密钥文件 ${keyFile} 读取失败: ${(err as Error).message}`)
  }
  if (buf.length === KEY_BYTES) return buf
  const text = buf.toString('utf8').trim()
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  throw new ToolError(
    `主密钥文件 ${keyFile} 编码异常(${buf.length} 字节,期望原始 32 字节或 64 hex 文本),拒绝覆盖`
  )
}

/** 临时文件 + rename 原子写,0600 尽力而为。 */
export async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  const fh = await fs.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(data)
  } finally {
    await fh.close().catch(() => undefined)
  }
  try {
    await fs.chmod(tmp, 0o600)
  } catch {
    /* Windows 下 chmod 近似只读位;NTFS ACL 由部署文档处理 */
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, path)
      return
    } catch (err) {
      if (attempt >= 2) {
        await fs.unlink(tmp).catch(() => undefined)
        throw err
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

// ---------------------------------------------------------------------------
// 目标库解析(导入端;与 apps/web secrets.ts 同规则:字符串条目 = 旧 safeStorage,原样保留)
// ---------------------------------------------------------------------------

export interface TargetStore {
  version: 1
  entries: Record<string, SecretEnvelopeV1 | string>
}

export function parseTargetStore(raw: string): { entries: Record<string, SecretEnvelopeV1 | string> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ToolError(`目标 secrets.json 解析失败(拒绝覆盖损坏文件): ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolError('目标 secrets.json 结构异常,拒绝覆盖')
  }
  const obj = parsed as Record<string, unknown>
  if (obj['version'] === undefined) {
    // 旧扁平库:全部按 legacy 字符串保留
    const out: Record<string, SecretEnvelopeV1 | string> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return { entries: out }
  }
  if (obj['version'] !== 1 || !obj['entries'] || typeof obj['entries'] !== 'object') {
    throw new ToolError(`目标 secrets.json 版本/结构不支持(v${String(obj['version'])}),拒绝覆盖`)
  }
  const out: Record<string, SecretEnvelopeV1 | string> = {}
  for (const [k, v] of Object.entries(obj['entries'] as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    else if (isEnvelopeV1(v)) out[k] = v
    else out[k] = JSON.stringify(v)
  }
  return { entries: out }
}
