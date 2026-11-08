import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { createRequire } from 'module'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  KEY_BYTES,
  MAX_PACKAGE_BYTES,
  MIN_PASSPHRASE_LEN,
  ToolError,
  atomicWriteFile,
  decryptForEntry,
  encryptForEntry,
  isEnvelopeV1,
  openPackage,
  parseHexKey,
  parseTargetStore,
  readKeyFile,
  sealPackage,
  type ExportPayload,
  type MigrationPackage,
  type SecretEnvelopeV1
} from './crypto'

/**
 * 旧桌面版密钥一次性迁移工具(deva → web)。
 *
 * 两种模式、同一个入口(dist/main.js):
 * - 导出(必须在旧电脑、原 OS 用户、Electron 下运行):
 *     npm install && npm run export -- [--userData <旧userData目录>] [--deva-home <旧DEVA_HOME>] [--out <迁移包>]
 *   以旧应用身份('@deva/desktop',与 apps/desktop package.json name 一致,决定 Linux 钥匙环
 *   条目 application=@deva/desktop)加载 safeStorage,解密旧 userData/secrets.json 与旧
 *   DEVA_HOME/secrets.json 中的 safeStorage 密文,输出**加密迁移包**。不启动窗口/渲染层/
 *   调度器/机器人;对旧目录只读(本工具自身的 Electron userData 重定向到系统临时目录)。
 *   绝不输出明文;报告只含条目 ID、成败与失败分类(missing/corrupt/keyring-unavailable)。
 * - 导入(在 Web 服务器上运行,**纯 Node**,本文件不 import electron——electron 仅在导出
 *   模式的函数内 lazy require):
 *     node dist/main.js --import <迁移包> [--deva-home <目标DEVA_HOME>] [--dry-run]
 *   解包校验 → 备份目标 secrets.json → 按 Web 主密钥(DEVA_SECRET_KEY 或 <home>/secret.key,
 *   与 apps/web secrets.ts 同规则)重新加密写入;与目标已有条目冲突时跳过并报告,不覆盖。
 *
 * 安全注意见 README.md:原机原用户原身份运行;口令不进 argv/日志;成功后源文件保留;
 * safeStorage 对真实旧密文的解密能力**未经本仓库 CI 验证**(依赖旧机器环境),使用前先用
 * fixtures 验证(见 test/)。
 */

const LEGACY_APP_NAME = '@deva/desktop'
const STORE_FILE = 'secrets.json'
const KEY_FILE = 'secret.key'
/** Electron 自身缓存(userData)的重定向位置:保证绝不写旧目录。 */
const TOOL_SANDBOX_USERDATA = join(tmpdir(), 'deva-legacy-secrets-export-tool')

// Electron 仅用到的最小接口(结构化定义,编译期不需要 electron 包)
interface ElectronApi {
  app: {
    setName(name: string): void
    setPath(name: string, path: string): void
    whenReady(): Promise<void>
    exit(code?: number): void
    getPath(name: 'userData'): string
  }
  safeStorage: {
    isEncryptionAvailable(): boolean
    decryptString(buffer: Buffer): string
  }
}

function requireElectron(): ElectronApi {
  try {
    return createRequire(__filename)('electron') as ElectronApi
  } catch {
    throw new ToolError(
      '导出模式需要 electron 依赖:请先在本目录 npm install,再用 `npm run export -- [参数]`(Electron)运行'
    )
  }
}

// ---------------------------------------------------------------------------
// 参数解析与口令输入
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  mode: 'export' | 'import'
  userData?: string
  devaHome?: string
  out?: string
  packageFile?: string
  dryRun: boolean
  help: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: 'export', dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (!v) throw new ToolError(`参数 ${a} 缺少值`)
      return v
    }
    switch (a) {
      case '--import':
        args.mode = 'import'
        args.packageFile = next()
        break
      case '--export':
        args.mode = 'export'
        break
      case '--userData':
        args.userData = next()
        break
      case '--deva-home':
        args.devaHome = next()
        break
      case '--out':
        args.out = next()
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new ToolError(`未知参数: ${a}(见 --help)`)
    }
  }
  return args
}

/** 无回显读口令。TTY:逐字符 raw 模式;管道:从 stdin 读行(两行 = 口令 + 确认)。 */
export function promptHidden(prompt: string): Promise<string> {
  return new Promise((res, rej) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      // 管道输入:整段读完按行取。注意调用方用 readPassphrases 控制行数,不在日志回显。
      rej(new ToolError('stdin 不是终端;请用 TTY 运行,或通过管道按行提供口令'))
      return
    }
    process.stdout.write(prompt)
    let value = ''
    const onData = (ch: Buffer): void => {
      const s = ch.toString('utf8')
      if (s === '\r' || s === '\n') {
        cleanup()
        process.stdout.write('\n')
        res(value)
      } else if (s === '\x03') {
        cleanup()
        process.stdout.write('\n')
        rej(new ToolError('已取消'))
      } else if (s === '\x7f' || s === '\x08') {
        value = value.slice(0, -1)
      } else if (ch.length === 1 && ch[0] < 0x20) {
        /* 忽略其它控制字符 */
      } else {
        value += s
      }
    }
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

/** 读整段 stdin 并按行拆分(非 TTY 场景:第一行口令,第二行确认)。 */
function readStdinLines(): Promise<string[]> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () =>
      res(
        Buffer.concat(chunks)
          .toString('utf8')
          .split(/\r?\n/)
          .filter((l, idx, arr) => idx < arr.length - 1 || l.length > 0)
      )
    )
    process.stdin.on('error', rej)
  })
}

/** 导出用:口令 + 确认(两次一致才通过);长度下限校验。 */
export async function readPassphrases(): Promise<string> {
  let pass1: string
  let pass2: string
  if (process.stdin.isTTY) {
    pass1 = await promptHidden('设置迁移口令(至少 8 个字符,勿与其它口令复用): ')
    pass2 = await promptHidden('再次输入确认: ')
  } else {
    const lines = await readStdinLines()
    if (lines.length < 2) throw new ToolError('非终端输入需两行:第一行口令,第二行确认')
    ;[pass1, pass2] = lines
  }
  if (pass1 !== pass2) throw new ToolError('两次输入的口令不一致')
  if (pass1.length < MIN_PASSPHRASE_LEN) {
    throw new ToolError(`口令过短(至少 ${MIN_PASSPHRASE_LEN} 个字符)`)
  }
  return pass1
}

// ---------------------------------------------------------------------------
// 旧 safeStorage 密文的定位与分类
// ---------------------------------------------------------------------------

/**
 * 旧 userData 候选目录(按可能性排序,取第一个含 secrets.json 的)。
 * 依据:apps/desktop/package.json name=@deva/desktop(Electron 的 app.name/userData 由此
 * 派生;desktop 在 ready 后才 setName('deva') 只改 WM_CLASS,不改 userData/钥匙环条目,
 * 见 apps/desktop/src/main/index.ts 注释)。platform.ts 的 legacyDesktopUserData() 用的
 * 'deva' 也列入候选兜底;发现不一致时以实际命中的为准并在报告中注明。
 */
export function discoverUserDataCandidates(): string[] {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    return [join(appData, '@deva', 'desktop'), join(appData, 'deva'), join(appData, 'Deva'), join(appData, 'Electron')]
  }
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support')
    return [
      join(base, '@deva', 'desktop'),
      join(base, 'deva'),
      join(base, 'Deva'),
      join(base, 'Electron')
    ]
  }
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return [join(base, '@deva', 'desktop'), join(base, 'deva'), join(base, 'Deva'), join(base, 'Electron')]
}

export type FailureReason = 'missing' | 'corrupt' | 'keyring-unavailable'

export interface DecryptOutcome {
  ok: boolean
  plaintext?: string
  reason?: FailureReason
  detail?: string
}

/**
 * 单条旧密文解密尝试。前置硬校验:safeStorage 密文必带 'v10'/'v11' 前缀,
 * 不是该前缀的 base64 一律判 corrupt——**绝不把任意 base64 当 safeStorage 密文喂给解密**,
 * 也绝不把旧密文当 AES 密文处理(与本仓库 secrets.ts 的约定一致)。
 */
export function tryDecryptLegacy(value: unknown, electron: ElectronApi | null): DecryptOutcome {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'corrupt', detail: '条目值不是非空字符串' }
  }
  if (electron && !electron.safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: 'keyring-unavailable', detail: 'safeStorage.isEncryptionAvailable()=false(钥匙环/DPAPI 不可用)' }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return { ok: false, reason: 'corrupt', detail: '不是合法 base64' }
  }
  const buf = Buffer.from(value, 'base64')
  if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    return { ok: false, reason: 'corrupt', detail: 'base64 规范化不一致' }
  }
  const prefix = buf.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') {
    return { ok: false, reason: 'corrupt', detail: `缺少 safeStorage v10/v11 前缀(实际 "${prefix}")` }
  }
  if (!electron) return { ok: false, reason: 'corrupt', detail: '无 safeStorage 可用(仅用于离线分类测试)' }
  try {
    const plaintext = electron.safeStorage.decryptString(buf)
    if (plaintext.length === 0) return { ok: false, reason: 'corrupt', detail: '解密结果为空' }
    return { ok: true, plaintext }
  } catch (err) {
    return {
      ok: false,
      reason: 'corrupt',
      detail: `safeStorage.decryptString 抛错(可能原用户/原钥匙环不匹配或密文损坏): ${(err as Error).message}`
    }
  }
}

interface StoreScanResult {
  found: boolean
  path: string
  format: 'legacy' | 'v1' | 'malformed'
  total: number
  ok: number
  failures: { id: string; reason: FailureReason; detail: string }[]
  entries: Record<string, string>
  duplicateKeys: string[]
}

/** 只读扫描一个旧 secrets.json(扁平 legacy 格式),逐条实际尝试解密。 */
async function scanLegacyStore(
  path: string,
  electron: ElectronApi,
  prefer: Record<string, string> = {}
): Promise<StoreScanResult> {
  const result: StoreScanResult = {
    found: false,
    path,
    format: 'legacy',
    total: 0,
    ok: 0,
    failures: [],
    entries: {},
    duplicateKeys: []
  }
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result
    result.format = 'malformed'
    result.failures.push({ id: '(文件)', reason: 'corrupt', detail: `读取失败: ${(err as Error).message}` })
    return result
  }
  result.found = true
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    result.format = 'malformed'
    result.failures.push({ id: '(文件)', reason: 'corrupt', detail: `JSON 解析失败: ${(err as Error).message}` })
    return result
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.format = 'malformed'
    result.failures.push({ id: '(文件)', reason: 'corrupt', detail: '顶层不是对象' })
    return result
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj['version'] === 'number') {
    // 已是 Web v1 库(说明 Web 端已在该 home 写过):无需也不得经 safeStorage 处理
    result.format = 'v1'
    result.total = Object.keys((obj['entries'] as Record<string, unknown>) ?? {}).length
    return result
  }
  for (const [id, value] of Object.entries(obj)) {
    result.total++
    const outcome = tryDecryptLegacy(value, electron)
    if (outcome.ok && outcome.plaintext !== undefined) {
      result.ok++
      if (id in prefer && prefer[id] !== outcome.plaintext) result.duplicateKeys.push(id)
      result.entries[id] = outcome.plaintext
    } else {
      result.failures.push({ id, reason: outcome.reason ?? 'corrupt', detail: outcome.detail ?? '' })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 导出模式(Electron)
// ---------------------------------------------------------------------------

function printScan(title: string, scan: StoreScanResult): void {
  console.log(`${title}: ${scan.path}`)
  if (!scan.found) {
    console.log('  (不存在,跳过)')
    return
  }
  console.log(`  格式: ${scan.format === 'legacy' ? '旧 safeStorage 扁平库' : scan.format === 'v1' ? '已是 Web v1 库(跳过,不经 safeStorage 处理)' : '无法解析'}`)
  console.log(`  条目: ${scan.total},成功解密: ${scan.ok},失败: ${scan.failures.length}`)
  for (const f of scan.failures) {
    const reasonLabel = f.reason === 'missing' ? 'missing(缺失)' : f.reason === 'keyring-unavailable' ? 'keyring-unavailable(钥匙环不可用)' : 'corrupt(损坏/不匹配)'
    console.log(`    - ${f.id} [${reasonLabel}] ${f.detail}`)
  }
  if (scan.duplicateKeys.length > 0) {
    console.log(`  与另一来源同键不同值(合并时按优先级取舍,只报键名): ${scan.duplicateKeys.join(', ')}`)
  }
}

export async function runExport(args: ParsedArgs): Promise<number> {
  const electron = requireElectron()
  // 身份对齐:与旧桌面版同 app.name(钥匙环条目/DPAPI 数据以它为标识)。
  // 工具自身 userData 重定向到临时目录:对旧 userData 目录**只读**。
  electron.app.setName(LEGACY_APP_NAME)
  electron.app.setPath('userData', TOOL_SANDBOX_USERDATA)
  await electron.app.whenReady()

  console.log('== Deva 旧密钥导出(只读;不输出明文)==')
  console.log(`应用身份: ${LEGACY_APP_NAME}`)

  // 1) 定位旧 userData
  let userDataPath: string | null = null
  const candidates = args.userData ? [resolve(args.userData), ...discoverUserDataCandidates()] : discoverUserDataCandidates()
  const tried: string[] = []
  for (const cand of candidates) {
    const p = isAbsolute(cand) ? cand : resolve(cand)
    tried.push(p)
    const legacyFile = join(p, STORE_FILE)
    try {
      await fs.access(legacyFile)
      userDataPath = p
      break
    } catch {
      /* 下一候选 */
    }
  }
  if (!userDataPath) {
    console.error('\n[missing] 未找到旧 secrets.json,尝试过:')
    for (const t of tried) console.error(`  - ${join(t, STORE_FILE)}`)
    console.error('请用 --userData 指定旧应用 userData 目录(含 secrets.json 的目录)。')
    await delay(300) // 先让 stdout 落盘(app.exit 立即终止)
    electron.app.exit(1)
    return 1
  }

  // 2) 扫描 + 实际解密(userData 优先,DEVA_HOME 侧覆盖同键)
  const userDataScan = await scanLegacyStore(join(userDataPath, STORE_FILE), electron)
  printScan('旧 userData 库', userDataScan)

  const home = args.devaHome ? resolve(args.devaHome) : process.env['DEVA_HOME']?.trim() || join(homedir(), '.deva')
  const homeScan = await scanLegacyStore(join(home, STORE_FILE), electron, userDataScan.entries)
  printScan('旧 DEVA_HOME 库', homeScan)

  const merged: Record<string, string> = { ...userDataScan.entries, ...homeScan.entries }
  const failures = [...userDataScan.failures, ...homeScan.failures]
  const totalScanned = userDataScan.total + homeScan.total
  const alreadyWeb =
    (userDataScan.format === 'v1' ? userDataScan.total : 0) + (homeScan.format === 'v1' ? homeScan.total : 0)

  if (alreadyWeb > 0) {
    console.log(`(另有 ${alreadyWeb} 条已是 Web v1 格式,无需迁移,Web 端可直接使用)`)
  }
  const okCount = Object.keys(merged).length
  console.log(`\n汇总: 扫描 ${totalScanned} 条,可导出 ${okCount} 条,失败 ${failures.length} 条`)
  if (totalScanned === 0) {
    console.error('[missing] 两处来源都没有任何条目;若确认旧应用配置过密钥,请核对手动指定的路径。')
    await delay(300) // 先让 stdout 落盘(app.exit 立即终止)
    electron.app.exit(1)
    return 1
  }
  if (okCount === 0) {
    console.error('[fail] 没有任何条目解密成功(全部 missing/corrupt/keyring-unavailable);不生成迁移包。')
    console.error('降级流程:保留旧库备份,在 Web 端逐项重新配置(见 docs/migration-web.md)。')
    await delay(300) // 先让 stdout 落盘(app.exit 立即终止)
    electron.app.exit(1)
    return 1
  }

  // 3) 口令(交互,不进 argv/日志)→ 封包
  console.log('\n将生成加密迁移包(整个载荷以 scrypt 派生密钥 + AES-256-GCM 加密)。')
  const passphrase = await readPassphrases()
  const payload: ExportPayload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      platform: process.platform,
      electron: process.versions.electron,
      legacyAppName: LEGACY_APP_NAME,
      userData: userDataPath,
      devaHome: home
    },
    entries: merged,
    failures,
    counts: { total: totalScanned, ok: okCount, failed: failures.length }
  }
  const pkg = sealPackage(payload, passphrase)
  const outPath = args.out ? resolve(args.out) : join(process.cwd(), 'deva-secrets-export.json')
  await atomicWriteFile(outPath, `${JSON.stringify(pkg, null, 2)}\n`)
  const size = (await fs.stat(outPath)).size
  console.log(`\n迁移包已写入: ${outPath}(${size} 字节,含 ${okCount} 条)`)
  console.log('安全交接:')
  console.log('  - 口令不要与本包同通道传递(另用口头/独立消息);口令未落盘、未进日志。')
  console.log('  - 旧源文件(userData/secrets.json、DEVA_HOME/secrets.json)原样保留,本次未做任何修改。')
  console.log('  - 本工具未验证真实旧密文的解密(见 README「未验证声明」);导入前请先 --dry-run。')
  await delay(300) // 先让 stdout 落盘(app.exit 立即终止)
  electron.app.exit(0)
  return 0
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// 导入模式(纯 Node,无 electron;在 Web 服务器上运行)
// ---------------------------------------------------------------------------

export interface ImportReport {
  dryRun: boolean
  targetHome: string
  targetStore: string
  keySource: 'env' | 'file' | 'generated' | 'none'
  existingTotal: number
  existingBroken: number
  imported: string[]
  skippedConflicts: string[]
  backupPath?: string
  packageFailures: { id: string; reason: string; detail?: string }[]
}

/** 纯函数:把载荷条目合并进目标库(冲突跳过)。供导入与单测共用。 */
export function applyImport(
  targetEntries: Record<string, SecretEnvelopeV1 | string>,
  payloadEntries: Record<string, string>,
  master: Buffer
): { imported: string[]; skippedConflicts: string[] } {
  const imported: string[] = []
  const skippedConflicts: string[] = []
  for (const [key, plaintext] of Object.entries(payloadEntries)) {
    if (key in targetEntries) {
      // 冲突策略:跳过并报告,不覆盖(目标已有条目——含 legacy/损坏——一律保留)
      skippedConflicts.push(key)
      continue
    }
    targetEntries[key] = encryptForEntry(key, plaintext, master)
    imported.push(key)
  }
  return { imported, skippedConflicts }
}

export async function runImport(args: ParsedArgs, io: { passphrase?: string; log?: (s: string) => void } = {}): Promise<ImportReport> {
  const log = io.log ?? ((s: string) => console.log(s))
  if (!args.packageFile) throw new ToolError('缺少迁移包路径:--import <文件>')
  const pkgPath = resolve(args.packageFile)
  const targetHome = args.devaHome
    ? resolve(args.devaHome)
    : process.env['DEVA_HOME']?.trim() || join(homedir(), '.deva')
  const storeFile = join(targetHome, STORE_FILE)
  const keyFile = join(targetHome, KEY_FILE)

  // 1) 读包(先卡文件大小)
  const stat = await fs.stat(pkgPath).catch(() => null)
  if (!stat) throw new ToolError(`迁移包不存在: ${pkgPath}`)
  if (stat.size > MAX_PACKAGE_BYTES) {
    throw new ToolError(`迁移包 ${stat.size} 字节超过限额 ${MAX_PACKAGE_BYTES}`)
  }
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as MigrationPackage

  // 2) 口令 + 解包校验
  const passphrase = io.passphrase ?? (process.stdin.isTTY ? await promptHidden('迁移口令: ') : (await readStdinLines())[0] ?? '')
  const payload = openPackage(pkg, passphrase)
  log(`迁移包校验通过: ${Object.keys(payload.entries).length} 条(导出于 ${payload.exportedAt},来源 ${JSON.stringify(payload.source.platform)})`)

  // 3) 目标库与主密钥(与 apps/web secrets.ts 同规则)
  await fs.mkdir(targetHome, { recursive: true, mode: 0o700 }).catch(() => undefined)
  let targetEntries: Record<string, SecretEnvelopeV1 | string> = {}
  let storeExisted = false
  try {
    targetEntries = parseTargetStore(await fs.readFile(storeFile, 'utf8')).entries
    storeExisted = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const envelopeKeys = Object.keys(targetEntries).filter((k) => isEnvelopeV1(targetEntries[k]))

  const envHex = process.env['DEVA_SECRET_KEY']?.trim()
  let master: Buffer | null = null
  let keySource: ImportReport['keySource'] = 'none'
  if (envHex) {
    master = parseHexKey(envHex) // 非法即抛错,不回落
    keySource = 'env'
    if (await readKeyFile(keyFile)) {
      log('注意:目标同时存在 secret.key 与 DEVA_SECRET_KEY,以环境变量为准(与 Web 端规则一致)。')
    }
  } else {
    const fromFile = await readKeyFile(keyFile)
    if (fromFile) {
      master = fromFile
      keySource = 'file'
    } else if (envelopeKeys.length > 0) {
      throw new ToolError(
        `目标已有 ${envelopeKeys.length} 条 v1 加密条目但主密钥缺失(${keyFile} 不存在且未设 DEVA_SECRET_KEY);拒绝导入,请先恢复配套主密钥`
      )
    } else if (Object.keys(payload.entries).length > 0 && !args.dryRun) {
      // 首次空库(与 Web 端同规则):生成主密钥并写文件(0600),导入后 Web 端可直接使用
      master = randomBytes(KEY_BYTES)
      await atomicWriteFile(keyFile, master)
      keySource = 'generated'
      log(`已生成 Web 主密钥: ${keyFile}(请与 secrets.json 一同纳入备份)`)
    }
  }
  if (!master && !args.dryRun) throw new ToolError('无法确定 Web 主密钥(且本次非 dry-run)')

  // 4) 校验目标主密钥确实能解开已有 v1 条目(全败 = 密钥不配套,拒绝写入)
  let existingBroken = 0
  if (master) {
    let existingOk = 0
    for (const k of envelopeKeys) {
      try {
        // 只验可用性,不取明文
        decryptForEntry(k, targetEntries[k] as SecretEnvelopeV1, master)
        existingOk++
      } catch {
        existingBroken++
      }
    }
    if (envelopeKeys.length > 0 && existingOk === 0) {
      throw new ToolError(`目标主密钥与已有 ${envelopeKeys.length} 条 v1 条目全部不配套;拒绝导入(防止写入无法解密的数据)`)
    }
  }

  // 5) 冲突探测 + dry-run 报告(探测时只需键集合,不落盘)
  const dryRun = args.dryRun
  const probeKey = master ?? Buffer.alloc(KEY_BYTES, 0x42)
  const probe = applyImport({ ...targetEntries }, payload.entries, probeKey)
  const report: ImportReport = {
    dryRun,
    targetHome,
    targetStore: storeFile,
    keySource: master ? keySource : 'none',
    existingTotal: Object.keys(targetEntries).length,
    existingBroken,
    imported: probe.imported,
    skippedConflicts: probe.skippedConflicts,
    packageFailures: payload.failures
  }

  log(`\n== 导入${dryRun ? '(dry-run,不写盘)' : ''} ==`)
  log(`目标库: ${storeFile}${storeExisted ? '' : '(新建)'};主密钥来源: ${report.keySource}`)
  log(`将导入 ${report.imported.length} 条:`)
  for (const id of report.imported) log(`  + ${id}`)
  if (report.skippedConflicts.length > 0) {
    log(`跳过(目标已存在,不覆盖)${report.skippedConflicts.length} 条:`)
    for (const id of report.skippedConflicts) log(`  = ${id}`)
  }
  if (payload.failures.length > 0) {
    log(`导出时已失败的 ${payload.failures.length} 条(不在包内,需在 Web 端重新配置):`)
    for (const f of payload.failures) log(`  ! ${f.id} [${f.reason}] ${f.detail ?? ''}`)
  }
  if (existingBroken > 0) log(`目标库原有 ${existingBroken} 条无法解密条目,原样保留。`)

  // 6) 备份 + 写入(dry-run 到此为止)
  if (!dryRun) {
    if (!master) throw new ToolError('主密钥不可用,拒绝写入')
    if (storeExisted) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const backupPath = `${storeFile}.bak-${stamp}`
      await fs.copyFile(storeFile, backupPath)
      await fs.chmod(backupPath, 0o600).catch(() => undefined)
      report.backupPath = backupPath
      log(`已备份目标库: ${backupPath}`)
    }
    applyImport(targetEntries, payload.entries, master)
    await atomicWriteFile(storeFile, `${JSON.stringify({ version: 1, entries: targetEntries }, null, 2)}\n`)
    log(`已写入 ${report.imported.length} 条到 ${storeFile}(0600 尽力而为)。`)
    log('后续:重启 Web 服务使其重新加载;建议导入测试期间 DEVA_AUTOSTART=0(见 docs/migration-web.md)。')
  } else {
    log('dry-run 完成,未做任何写入;去掉 --dry-run 执行实际导入。')
  }
  return report
}

// ---------------------------------------------------------------------------
// 入口分发
// ---------------------------------------------------------------------------

const HELP = `用法:
  导出(旧电脑,Electron,原 OS 用户):
    npm run export -- [--userData <旧userData目录>] [--deva-home <旧DEVA_HOME>] [--out <迁移包.json>]
  导入(Web 服务器,纯 Node):
    node dist/main.js --import <迁移包.json> [--deva-home <目标DEVA_HOME>] [--dry-run]
选项:
  --userData <dir>   旧应用 userData 目录(含 secrets.json);默认按候选列表自动探测
  --deva-home <dir>  旧/新 DEVA_HOME(默认环境变量 DEVA_HOME 或 ~/.deva)
  --out <file>       迁移包输出路径(默认 ./deva-secrets-export.json)
  --dry-run          导入只演练:校验+冲突报告,不写盘、不备份
  -h, --help         本帮助
`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.mode === 'import') {
    const report = await runImport(args)
    return report.dryRun ? 0 : report.imported.length > 0 || report.skippedConflicts.length > 0 ? 0 : 1
  }
  if (!process.versions.electron) {
    process.stderr.write(
      '导出模式必须在 Electron 下运行:本目录 `npm install` 后用 `npm run export -- [参数]`。\n' +
        '导入模式用纯 Node:node dist/main.js --import <迁移包> [--dry-run]\n'
    )
    return 2
  }
  return runExport(args)
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      const msg = err instanceof ToolError ? err.message : ((err as Error)?.stack ?? String(err))
      process.stderr.write(`错误: ${msg}\n`)
      process.exitCode = 1
    })
}
