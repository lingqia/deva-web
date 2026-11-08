import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { devaHome, ipcMain } from '../platform'

/**
 * 密钥安全存储(Web 服务端,主进程)。
 *
 * ## 存储格式(v1)
 * - 主密钥:`<DEVA_HOME>/secret.key`,随机 32 字节原始二进制(也兼容读取 64 hex 文本)。
 *   环境变量 `DEVA_SECRET_KEY`(64 hex)优先于文件;非法(长度/编码不对)直接抛错,**绝不回落**到文件密钥。
 * - 密文库:`<DEVA_HOME>/secrets.json`,结构 `{ version: 1, entries: { [存储键]: 信封 } }`。
 *   每条信封 `{ v:1, alg:'aes-256-gcm', iv, tag, ct }`(均 base64):独立随机 12 字节 nonce、
 *   16 字节 GCM tag、AES-256-GCM 密文;AAD = 存储键名,防止条目被整体替换/移植到别的键名下解密。
 * - 旧版(Electron safeStorage,Win DPAPI/macOS Keychain/Linux libsecret)的 secrets.json 是
 *   `{ [键]: base64字符串 }` 扁平结构。检测依据:顶层无 version 字段或条目值为字符串。
 *   **旧 safeStorage 密文与 AES-256-GCM 密文完全不同,绝不能当作本格式密文去解**——
 *   这类条目标记为 legacy:原样保留在文件中(不丢数据),不参与 list/has 计数,
 *   get 恒返回 null,并通过 secrets:status 的 legacyCount 上报;迁移用
 *   tools/legacy-secrets-export(离线导出/导入),Web 服务端绝不加载 Electron 自动迁移。
 *
 * ## 威胁模型
 * 主密钥与数据同盘,提供的是**静态文件保护**:防止拿到文件的旁观者(如误同步、误提交、
 * 别的普通用户)读取明文;**不抵御**已取得服务账户读权限、能同时读到 secret.key 与
 * secrets.json 的人(那需要外部 KMS,见迁移计划 §7.1)。密钥文件/密文库尝试 0600、目录 0700
 * (POSIX 生效);Windows 下 chmod 只近似只读位,NTFS ACL 由部署文档处理(服务账户继承),
 * 不宣称 chmod 提供同等保护。明文只在主进程内存中按需解密,绝不落盘、绝不经 IPC 回传渲染层。
 *
 * ## 启动与失败语义(不静默覆盖)
 * - 主密钥只在**首次空库**(无 secret.key 且文件中没有任何 v1 信封条目)时生成;
 *   已有 v1 密文但 secret.key 丢失/DEVA_SECRET_KEY 缺失 → 抛错拒绝启动,不生成新 key 覆盖。
 * - 有 v1 密文且取到密钥,但**全部**条目解不开 → 判定密钥不配套,抛错拒绝启动。
 * - secrets.json 解析失败 → 抛错拒绝覆盖(损坏文件留给人工处理)。
 * - secrets:available 返回真实可用状态(主密钥可用且无 legacy/不可解密条目),不恒 true;
 *   list/has 只统计可解密条目;legacy 条目数经 secrets:status 上报。
 *
 * ## 写入路径
 * 全部变更经模块级 Promise 链串行化;落盘为「临时文件 + rename」原子替换(Windows 上
 * rename 失败自动重试,防杀软短时占用)。ensureLoaded 用共享初始化 Promise,并发首调安全,
 * 初始化失败则所有调用方拿到同一个明确错误(进程重启前不重试)。
 *
 * 迁移关系见 docs/migration-web.md;格式规范与 tools/legacy-secrets-export/src/crypto.ts 保持一致。
 */

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const STORE_FILE = 'secrets.json'
const KEY_FILE = 'secret.key'
const STORE_VERSION = 1
const ALG = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** v1 信封:每条独立随机 nonce,AAD=存储键名(见文件头注释)。 */
export interface SecretEnvelopeV1 {
  v: 1
  alg: 'aes-256-gcm'
  /** base64(12 字节随机 nonce) */
  iv: string
  /** base64(16 字节 GCM auth tag) */
  tag: string
  /** base64(密文) */
  ct: string
}

/** 密钥库状态(secrets:status 通道与 bootstrap 自检用;不含任何明文)。 */
export interface SecretsStatus {
  /** 主密钥可用、无 legacy/不可解密条目,即「全部密钥可正常读写」。 */
  available: boolean
  /** 库已完成初始化(否则下列计数为初始化前的临时快照)。 */
  initialized: boolean
  /** 文件中条目总数(含 legacy 与不可解密条目)。 */
  totalEntries: number
  /** 旧 Electron safeStorage 条目数(本端无法解密,需迁移工具导入后重加密)。 */
  legacyCount: number
  /** 新格式但解不开的条目数(密钥不配套/单条损坏)。 */
  undecryptableCount: number
  /** 主密钥来源。 */
  keySource: 'env' | 'file' | 'generated' | 'none'
}

/** 密钥库致命错误(主密钥丢失/不配套/文件损坏):调用方应显式失败,不得静默重置。 */
export class SecretsStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretsStoreError'
  }
}

// ---------------------------------------------------------------------------
// 模块状态与串行化
// ---------------------------------------------------------------------------

let loaded = false
let storeFile = ''
let masterKey: Buffer | null = null
let keySource: SecretsStatus['keySource'] = 'none'

/** 内存条目:v1 信封对象;legacy 条目保留原 base64 字符串(绝不当作 AES 密文解析)。 */
let entries: Record<string, SecretEnvelopeV1 | string> = {}
/** 新格式且初始化时验证可解的条目键。 */
const decryptable = new Set<string>()
/** 旧 safeStorage 条目键(原样保留,不参与 list/has)。 */
const legacyKeys = new Set<string>()
/** 新格式但解不开的条目键(密钥不配套或单条损坏)。 */
const brokenKeys = new Set<string>()
const legacyWarned = new Set<string>()

/** 共享初始化 Promise:并发首调安全;失败后保留拒绝态,重启前不再重试(明确报错不静默)。 */
let initPromise: Promise<void> | null = null
/** 写入串行化:所有「改内存 + 落盘」操作排在同一条链上,防止并发写乱序。 */
let writeChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = writeChain.then(op, op)
  writeChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ---------------------------------------------------------------------------
// 原子写与主密钥文件
// ---------------------------------------------------------------------------

/** 临时文件 + rename 原子写;0600 尽力而为(Windows 下为近似只读位,ACL 由部署文档处理)。 */
async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
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
    /* 权限收紧失败不阻断(Windows/特殊文件系统),威胁模型见文件头注释 */
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
      await new Promise((r) => setTimeout(r, 50)) // Windows:杀软/索引器短时占用,稍候重试
    }
  }
}

/** 数据目录:确保存在,POSIX 下收紧 0700(Windows NTFS ACL 由部署文档处理,见文件头)。 */
async function ensureHomeDir(home: string): Promise<void> {
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 })
  } catch {
    /* 已存在或无法创建:后续读写各自报错,不在此阻断 */
  }
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(home, 0o700)
    } catch {
      /* 尽力而为 */
    }
  }
}

/** DEVA_SECRET_KEY 严格校验:64 hex → 32 字节;非法即抛错,绝不回落(计划 §7.1)。 */
function parseHexKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new SecretsStoreError(
      'DEVA_SECRET_KEY 非法:必须为 64 个十六进制字符(32 字节)。已拒绝回退到文件密钥(防止误用别库密钥)。'
    )
  }
  return Buffer.from(hex, 'hex')
}

/**
 * 读取主密钥文件:32 字节原始二进制,或 64 hex 文本。
 * 文件存在但编码/长度不对 → 抛错(绝不删除重生成,那等于销毁全部密文)。
 */
async function readKeyFile(keyFile: string): Promise<Buffer | null> {
  let buf: Buffer
  try {
    buf = await fs.readFile(keyFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SecretsStoreError(`主密钥文件 ${keyFile} 读取失败: ${(err as Error).message}`)
  }
  if (buf.length === KEY_BYTES) return buf
  const text = buf.toString('utf8').trim()
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  throw new SecretsStoreError(
    `主密钥文件 ${keyFile} 编码异常(${buf.length} 字节,期望原始 32 字节或 64 hex 文本)。拒绝覆盖或重新生成。`
  )
}

// ---------------------------------------------------------------------------
// 信封加解密(AAD = 存储键名)
// ---------------------------------------------------------------------------

function encryptForEntry(key: string, plaintext: string, master: Buffer): SecretEnvelopeV1 {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALG, master, iv)
  cipher.setAAD(Buffer.from(key, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
}

function decryptForEntry(key: string, env: SecretEnvelopeV1, master: Buffer): string {
  const iv = Buffer.from(env.iv, 'base64')
  const tag = Buffer.from(env.tag, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('信封字段长度不符')
  }
  const decipher = createDecipheriv(ALG, master, iv)
  decipher.setAAD(Buffer.from(key, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}

/** 识别 v1 信封;不满足形状的条目归入 broken(不抛、不覆盖)。 */
function isEnvelopeV1(value: unknown): value is SecretEnvelopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 &&
    e['alg'] === ALG &&
    typeof e['iv'] === 'string' &&
    typeof e['tag'] === 'string' &&
    typeof e['ct'] === 'string'
  )
}

// ---------------------------------------------------------------------------
// 初始化(ensureLoaded 共享 Promise)
// ---------------------------------------------------------------------------

/**
 * 解析 secrets.json 文本为内存条目。
 * - 旧格式(无 version,值为字符串)→ 全部标记 legacy;
 * - v1 → 信封 / legacy 字符串混存;
 * - 未知版本 / 结构异常 → 抛错(拒绝覆盖损坏库)。
 */
function parseStoreFile(raw: string): Record<string, SecretEnvelopeV1 | string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SecretsStoreError(
      `secrets.json 不是合法 JSON(可能已损坏): ${(err as Error).message}。拒绝自动覆盖或清空,请人工处理该文件。`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretsStoreError('secrets.json 结构异常(不是对象)。拒绝自动覆盖或清空。')
  }
  const obj = parsed as Record<string, unknown>
  const version = obj['version']
  const fileEntries = obj['entries']
  if (version === undefined) {
    // 旧版 Electron 扁平结构:{ [键]: base64(safeStorage 密文) }
    const out: Record<string, SecretEnvelopeV1 | string> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v) // 罕见手改脏数据:保留为 legacy 字符串,不解不丢
    }
    return out
  }
  if (version !== STORE_VERSION) {
    throw new SecretsStoreError(
      `secrets.json 版本 ${String(version)} 高于本程序支持的 v${STORE_VERSION},拒绝以旧代码覆盖新数据。`
    )
  }
  if (!fileEntries || typeof fileEntries !== 'object' || Array.isArray(fileEntries)) {
    throw new SecretsStoreError('secrets.json 缺少 entries 对象。拒绝自动覆盖或清空。')
  }
  const out: Record<string, SecretEnvelopeV1 | string> = {}
  for (const [k, v] of Object.entries(fileEntries as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v // v1 库中混入的 legacy 条目:原样保留
    else if (isEnvelopeV1(v)) out[k] = v
    else out[k] = JSON.stringify(v) // 形状异常:保留原始内容并按 broken 处理,不丢数据
  }
  return out
}

async function initStore(): Promise<void> {
  const home = devaHome()
  await ensureHomeDir(home)
  storeFile = join(home, STORE_FILE)

  let raw: string | null = null
  try {
    raw = await fs.readFile(storeFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SecretsStoreError(`secrets.json 读取失败: ${(err as Error).message}`)
    }
  }

  entries = raw === null ? {} : parseStoreFile(raw)
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v === 'string') legacyKeys.add(k)
    else if (!isEnvelopeV1(v)) brokenKeys.add(k)
  }
  const envelopeKeys = Object.keys(entries).filter((k) => !legacyKeys.has(k) && !brokenKeys.has(k))

  // ---- 主密钥(env 严格优先;文件次之;仅首启空库生成) ----
  const envHex = process.env['DEVA_SECRET_KEY']?.trim()
  if (envHex) {
    const key = parseHexKey(envHex) // 非法即抛错,不回落
    masterKey = key
    keySource = 'env'
  } else {
    const keyFile = join(home, KEY_FILE)
    const fromFile = await readKeyFile(keyFile)
    if (fromFile) {
      masterKey = fromFile
      keySource = 'file'
    } else if (envelopeKeys.length > 0) {
      throw new SecretsStoreError(
        `主密钥丢失:${storeFile} 中已有 ${envelopeKeys.length} 条 v1 加密条目,但 ${join(home, KEY_FILE)} 不存在且未设置 DEVA_SECRET_KEY。` +
          '为避免生成新密钥导致全部密文永久不可解,拒绝启动;请找回配套主密钥(备份含 secret.key 或 DEVA_SECRET_KEY)。'
      )
    } else {
      // 首次空库(或仅剩旧格式条目,尚无任何 v1 密文):生成主密钥并写 0600。
      try {
        masterKey = randomBytes(KEY_BYTES)
        await atomicWriteFile(keyFile, masterKey)
        keySource = 'generated'
      } catch (err) {
        masterKey = null
        keySource = 'none'
        console.error(`[secrets] 主密钥创建失败,密钥写入将被拒绝: ${(err as Error).message}`)
      }
    }
  }

  // ---- 用主密钥逐条验证 v1 信封(只验可用性,明文按需再解) ----
  if (masterKey && envelopeKeys.length > 0) {
    for (const k of envelopeKeys) {
      const env = entries[k] as SecretEnvelopeV1
      try {
        decryptForEntry(k, env, masterKey)
        decryptable.add(k)
      } catch {
        brokenKeys.add(k)
      }
    }
    if (decryptable.size === 0) {
      throw new SecretsStoreError(
        `主密钥不配套:${storeFile} 中全部 ${envelopeKeys.length} 条 v1 加密条目均无法解密` +
          (keySource === 'env'
            ? '(当前使用 DEVA_SECRET_KEY)。'
            : `(当前使用 ${join(home, KEY_FILE)})。`) +
          '拒绝启动,也不会生成新密钥覆盖;请恢复写入该库时使用的主密钥。'
      )
    }
    if (brokenKeys.size > 0) {
      console.error(
        `[secrets] ${brokenKeys.size} 条条目无法解密(单条损坏/跨库移植),已排除出 list/has: ${[...brokenKeys].join(', ')}`
      )
    }
  }

  if (legacyKeys.size > 0) {
    console.error(
      `[secrets] 检测到 ${legacyKeys.size} 条旧版 Electron safeStorage 密文条目(不可解密,已原样保留):` +
        '请用 tools/legacy-secrets-export 迁移,或在设置中逐项重新配置。'
    )
  }
  loaded = true
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  if (!initPromise) {
    initPromise = initStore()
    // 失败后保留拒绝态:所有调用方看到同一个明确错误,进程重启前不静默重试/重生成
    initPromise.catch(() => undefined)
  }
  await initPromise
}

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

function currentAvailable(): boolean {
  return loaded && masterKey !== null && legacyKeys.size === 0 && brokenKeys.size === 0
}

/** 库状态快照(不含明文):available / 条目计数 / legacy 数 / 密钥来源。 */
export async function getSecretsStatus(): Promise<SecretsStatus> {
  try {
    await ensureLoaded()
  } catch {
    return {
      available: false,
      initialized: false,
      totalEntries: 0,
      legacyCount: 0,
      undecryptableCount: 0,
      keySource: 'none'
    }
  }
  return {
    available: currentAvailable(),
    initialized: loaded,
    totalEntries: Object.keys(entries).length,
    legacyCount: legacyKeys.size,
    undecryptableCount: brokenKeys.size,
    keySource
  }
}

// ---------------------------------------------------------------------------
// 对上层导出面(与桌面版逐一同形:getSecret/setSecret/hasSecret/deleteSecret/
// deleteSecretsByPrefix/registerSecretsIpc;明文绝不经 IPC 回传渲染层)
// ---------------------------------------------------------------------------

/**
 * 主进程内部使用:取解密后的密钥。返回 null 表示未配置/legacy/无法解密。
 * 仅供 provider 适配层 / MCP 连接层在发起请求时调用。
 * 键约定:provider 用 providerId;MCP 用 `mcp:<serverId>:<field>`;机器人用 `remote:<botId>:<field>`。
 */
export async function getSecret(key: string): Promise<string | null> {
  await ensureLoaded()
  if (!masterKey) return null
  if (legacyKeys.has(key)) {
    if (!legacyWarned.has(key)) {
      legacyWarned.add(key)
      console.error(
        `[secrets] "${key}" 是旧版 safeStorage 条目,Web 端无法解密;请用 tools/legacy-secrets-export 迁移或重新配置。`
      )
    }
    return null
  }
  if (brokenKeys.has(key)) return null
  const env = entries[key]
  if (!env || typeof env === 'string') return null
  try {
    return decryptForEntry(key, env, masterKey)
  } catch {
    return null
  }
}

/**
 * 主进程内部使用:写入/更新密钥(空串视为删除)。无法加密时拒绝写入(绝不静默存明文)。
 * 返回 available = 库整体可用状态(存在 legacy/不可解密条目时为 false,但本次写入本身可成功)。
 */
export async function setSecret(
  key: string,
  value: string
): Promise<{ ok: boolean; available: boolean }> {
  await ensureLoaded()
  if (!value) {
    await deleteSecret(key)
    return { ok: true, available: currentAvailable() }
  }
  if (!masterKey) return { ok: false, available: currentAvailable() }
  const env = encryptForEntry(key, value, masterKey)
  await enqueue(async () => {
    entries[key] = env
    legacyKeys.delete(key)
    brokenKeys.delete(key)
    decryptable.add(key)
    await persist()
  })
  return { ok: true, available: currentAvailable() }
}

/** 是否已配置某密钥(布尔,不回显明文;legacy/不可解密条目不计入)。 */
export async function hasSecret(key: string): Promise<boolean> {
  await ensureLoaded()
  return decryptable.has(key)
}

/** 删除某密钥(幂等;legacy 条目同样可删——那是用户的显式操作)。 */
export async function deleteSecret(key: string): Promise<void> {
  await ensureLoaded()
  await enqueue(async () => {
    if (key in entries) {
      delete entries[key]
      decryptable.delete(key)
      legacyKeys.delete(key)
      brokenKeys.delete(key)
      await persist()
    }
  })
}

/** 删除某前缀下的所有密钥(如删除 MCP 服务时清 `mcp:<id>:` 全部字段)。 */
export async function deleteSecretsByPrefix(prefix: string): Promise<void> {
  await ensureLoaded()
  await enqueue(async () => {
    const hit = Object.keys(entries).filter((k) => k.startsWith(prefix))
    if (hit.length === 0) return
    for (const k of hit) {
      delete entries[k]
      decryptable.delete(k)
      legacyKeys.delete(k)
      brokenKeys.delete(k)
    }
    await persist()
  })
}

async function persist(): Promise<void> {
  // legacy 条目原样写回(不丢数据、绝不改写旧密文);旧文件本体仍在原位置保留。
  const data = `${JSON.stringify({ version: STORE_VERSION, entries }, null, 2)}\n`
  await atomicWriteFile(storeFile, data)
}

export function registerSecretsIpc(): void {
  // 写入 / 更新密钥;空串视为删除。无法加密时拒绝写入(绝不静默存明文)。
  ipcMain.handle(
    'secrets:set',
    async (_e, providerId: string, key: string): Promise<{ ok: boolean; available: boolean }> =>
      setSecret(providerId, key)
  )

  // 是否已配置密钥(布尔,不回显明文;只统计可解密条目)
  ipcMain.handle('secrets:has', async (_e, providerId: string): Promise<boolean> =>
    hasSecret(providerId)
  )

  ipcMain.handle('secrets:delete', async (_e, providerId: string): Promise<{ ok: true }> => {
    await deleteSecret(providerId)
    return { ok: true }
  })

  // 已配置(可解密)密钥的键名列表;legacy 条目不在其中,数量经 secrets:status 查询
  ipcMain.handle('secrets:list', async (): Promise<string[]> => {
    await ensureLoaded()
    return [...decryptable].sort()
  })

  // 真实可写状态(用于 UI 降级提示):初始化失败/有 legacy/有不可解密条目均返回 false
  ipcMain.handle('secrets:available', async (): Promise<boolean> => {
    try {
      await ensureLoaded()
    } catch {
      return false
    }
    return currentAvailable()
  })

  // 新增(向前兼容):库状态明细,含 legacy 条目数与密钥来源
  ipcMain.handle('secrets:status', async () => getSecretsStatus())
}
