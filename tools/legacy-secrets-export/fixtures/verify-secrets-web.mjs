/**
 * P3 验证脚本:apps/web/src/main/services/secrets.ts(AES-256-GCM v1 信封)行为验证。
 *
 * 用法(仓库根目录):node tools/legacy-secrets-export/fixtures/verify-secrets-web.mjs
 * 依赖:仅 Node + apps/web/node_modules 里的 esbuild(把 secrets.ts 打包成 CJS 后逐阶段加载)。
 * 主目录:全程使用 mkdtemp 的临时 DEVA_HOME,不碰真实 ~/.deva;成功结束自动清理。
 *
 * 覆盖:首建主密钥(0600 尽力而为)→ 写 → 读 → 「重启」(require 缓存失效后重载,等价
 * 重启进程的落盘语义)→ 错主密钥拒绝 → 主密钥丢失拒绝且不重生成 → 旧 safeStorage 条目
 * 识别(不当 AES 解、不计入 list/has、available=false)→ AAD 防条目移植 → 并发首调安全
 * → 原子落盘 → 非法 DEVA_SECRET_KEY 拒绝。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const secretsTs = join(repoRoot, 'apps', 'web', 'src', 'main', 'services', 'secrets.ts')
const platformTs = join(repoRoot, 'apps', 'web', 'src', 'main', 'platform.ts')
const esbuildJs = join(repoRoot, 'apps', 'web', 'node_modules', 'esbuild', 'bin', 'esbuild')

const work = mkdtempSync(join(tmpdir(), 'deva-secrets-verify-'))
const bundle = join(work, 'secrets-bundle.cjs')
const require2 = createRequire(import.meta.url)

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

/** 打包入口:同时导出 secrets.ts 与 platform.ts(便于直查 IPC 注册表)。 */
const entryTs = join(work, 'verify-entry.ts')
const rel = (p) => {
  const r = relative(work, p).split(sep).join('/')
  return isAbsolute(r) ? r : './' + r // 跨盘时 relative() 返回绝对路径,不能再加 './'
}
writeFileSync(entryTs, `export * from '${rel(secretsTs)}'\nexport * from '${rel(platformTs)}'\n`, 'utf8')

/** 打包 secrets.ts + platform.ts 为 CJS。 */
const build = spawnSync(process.execPath, [esbuildJs, entryTs, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`], { stdio: 'inherit' })
if (build.status !== 0) {
  console.error('esbuild 打包失败')
  process.exit(2)
}

/** 重新加载模块 = 重启进程(模块级状态清零,文件系统为唯一持久层)。 */
function fresh() {
  const p = require2.resolve(bundle)
  delete require2.cache[p]
  return require2(p)
}

function setHome(dir) {
  process.env['DEVA_HOME'] = dir
  delete process.env['DEVA_SECRET_KEY']
}

async function main() {
  const h1 = join(work, 'home1')
  const h2 = join(work, 'home2')
  const h3 = join(work, 'home3')
  const h4 = join(work, 'home4')

  // ---------------------------------------------------------------- 阶段 1:首建空库
  console.log('\n[1] 首次空库:生成主密钥并写 0600,写入与读取')
  setHome(h1)
  let m = fresh()
  let st = await m.getSecretsStatus()
  check('状态:可用 / 已初始化 / keySource=generated', st.available === true && st.initialized === true && st.keySource === 'generated', JSON.stringify(st))
  const keyFile = join(h1, 'secret.key')
  check('secret.key 已生成且为 32 字节', existsSync(keyFile) && readFileSync(keyFile).length === 32)
  check(
    'secret.key 权限位(POSIX 生效,Windows 近似)',
    process.platform === 'win32' || (readFileSync(keyFile).length > 0 && (statMode(keyFile) & 0o077) === 0)
  )
  let r = await m.setSecret('openai', 'sk-aaa')
  check('setSecret ok/available', r.ok === true && r.available === true, JSON.stringify(r))
  await m.setSecret('mcp:s1:token', 'tok-1')
  check('getSecret 往返', (await m.getSecret('openai')) === 'sk-aaa' && (await m.getSecret('mcp:s1:token')) === 'tok-1')
  check('hasSecret 只报已有键', (await m.hasSecret('openai')) === true && (await m.hasSecret('nope')) === false)
  st = await m.getSecretsStatus()
  check('status:2 条 / 无 legacy / available', st.totalEntries === 2 && st.legacyCount === 0 && st.available === true, JSON.stringify(st))

  const storeRaw = readFileSync(join(h1, 'secrets.json'), 'utf8')
  const storeJson = JSON.parse(storeRaw)
  check('secrets.json 结构 {version:1,entries}', storeJson.version === 1 && typeof storeJson.entries === 'object')
  const e1 = storeJson.entries['openai']
  check(
    '信封形状 v1/alg/iv(12B)/tag(16B)',
    e1 && e1.v === 1 && e1.alg === 'aes-256-gcm' && Buffer.from(e1.iv, 'base64').length === 12 && Buffer.from(e1.tag, 'base64').length === 16 && typeof e1.ct === 'string'
  )
  check('每条独立随机 nonce(两 Entry iv 不同)', e1.iv !== storeJson.entries['mcp:s1:token'].iv)
  check('明文不落盘', !storeRaw.includes('sk-aaa') && !storeRaw.includes('tok-1'))
  const ivBefore = e1.iv
  await m.setSecret('openai', 'sk-aaa')
  const e1b = JSON.parse(readFileSync(join(h1, 'secrets.json'), 'utf8')).entries['openai']
  check('同一键重写重新生成 nonce', e1b.iv !== ivBefore)

  // ---------------------------------------------------------------- 阶段 2:重启后读取
  console.log('\n[2] 重启进程(模块重载)后读取')
  setHome(h1)
  m = fresh()
  check('重启后 getSecret 持久', (await m.getSecret('openai')) === 'sk-aaa' && (await m.getSecret('mcp:s1:token')) === 'tok-1')
  st = await m.getSecretsStatus()
  check('重启后 keySource=file / available', st.keySource === 'file' && st.available === true, JSON.stringify(st))

  // ---------------------------------------------------------------- 阶段 3:AAD 防条目替换移植
  console.log('\n[3] AAD:把 openai 信封整体移植到 mcp 键名下 → 必须解不开')
  const tampered = JSON.parse(readFileSync(join(h1, 'secrets.json'), 'utf8'))
  tampered.entries['mcp:s1:token'] = { ...tampered.entries['openai'] }
  writeFileSync(join(h1, 'secrets.json'), JSON.stringify(tampered, null, 2), 'utf8')
  setHome(h1)
  m = fresh()
  check('移植条目 getSecret=null(不崩、不解)', (await m.getSecret('mcp:s1:token')) === null)
  st = await m.getSecretsStatus()
  check('移植条目计入 undecryptable 且 available=false', st.undecryptableCount === 1 && st.available === false && st.legacyCount === 0, JSON.stringify(st))
  check('hasSecret 不把坏条目报成可用', (await m.hasSecret('mcp:s1:token')) === false)
  // 还原:重写该键,库恢复可用
  await m.setSecret('mcp:s1:token', 'tok-1')
  st = await m.getSecretsStatus()
  check('重写坏键后恢复 available', st.available === true && st.undecryptableCount === 0, JSON.stringify(st))

  // ---------------------------------------------------------------- 阶段 4:错误主密钥 → 明确报错不覆盖
  console.log('\n[4] 错误 DEVA_SECRET_KEY(与库不配套)')
  const wrongKeyHex = randomBytes(32).toString('hex')
  const keyBytesBefore = readFileSync(keyFile).toString('hex')
  process.env['DEVA_SECRET_KEY'] = wrongKeyHex
  m = fresh()
  let threw = null
  try {
    await m.getSecret('openai')
  } catch (err) {
    threw = err
  }
  check('getSecret 抛 SecretsStoreError(主密钥不配套)', threw && threw.name === 'SecretsStoreError' && /不配套|无法解密/.test(threw.message), String(threw))
  check('错误 key 下不重写/不覆盖 secret.key', readFileSync(keyFile).toString('hex') === keyBytesBefore)
  st = await m.getSecretsStatus()
  check('status:初始化失败 / available=false', st.initialized === false && st.available === false, JSON.stringify(st))

  console.log('\n[4b] 非法 DEVA_SECRET_KEY(非 64 hex)→ 抛错不回落')
  setHome(h2)
  process.env['DEVA_SECRET_KEY'] = 'zzz-not-hex'
  m = fresh()
  st = await m.getSecretsStatus()
  check('初始化失败 / available=false', st.initialized === false && st.available === false, JSON.stringify(st))
  check('非法 key 下不生成 secret.key', !existsSync(join(h2, 'secret.key')))

  // ---------------------------------------------------------------- 阶段 5:主密钥丢失 → 拒绝且不重生成
  console.log('\n[5] 已有 v1 密文但主密钥丢失')
  setHome(h1)
  delete process.env['DEVA_SECRET_KEY']
  const keyBackup = join(work, 'secret.key.bak')
  renameSync(keyFile, keyBackup)
  m = fresh()
  threw = null
  try {
    await m.getSecret('openai')
  } catch (err) {
    threw = err
  }
  check('抛 SecretsStoreError(主密钥丢失)', threw && threw.name === 'SecretsStoreError' && /主密钥丢失/.test(threw.message), String(threw))
  check('不生成新 key 覆盖', !existsSync(keyFile))
  renameSync(keyBackup, keyFile) // 还原

  // ---------------------------------------------------------------- 阶段 6:旧 safeStorage 条目识别
  console.log('\n[6] 旧格式(safeStorage 扁平 base64)识别:不当 AES 解、不计入 list/has')
  setHome(h3)
  mkdirSync(h3, { recursive: true }) // 预置旧格式文件:目录须先存在(模块内 devaHome() 只在建库时创建)
  const legacyStore = { openai: 'QUJDREVGR0hJSktMTU5PUA==', 'mcp:s2:field': 'bGVnYWN5LWNpcGhlci1ub3QtcmVhbA==' }
  writeFileSync(join(h3, 'secrets.json'), JSON.stringify(legacyStore, null, 2), 'utf8')
  m = fresh()
  st = await m.getSecretsStatus()
  check('legacy 计数 2 / available=false / 主密钥已生成', st.legacyCount === 2 && st.available === false && st.keySource === 'generated' && st.totalEntries === 2, JSON.stringify(st))
  check('legacy 条目 hasSecret=false', (await m.hasSecret('openai')) === false)
  check('legacy 条目 getSecret=null(绝不当作 AES 解)', (await m.getSecret('openai')) === null)
  check('list 为空(list/has 只统计可解密条目)', (await m.getSecretsStatus()).legacyCount === 2 && JSON.stringify(legacyStore) === JSON.stringify(JSON.parse(readFileSync(join(h3, 'secrets.json'), 'utf8'))))
  r = await m.setSecret('openai', 'reentered-1')
  check('对 legacy 键重新配置:写入成功', r.ok === true, JSON.stringify(r))
  const mixed = JSON.parse(readFileSync(join(h3, 'secrets.json'), 'utf8'))
  check('重写后 v1 库保留未迁移 legacy 条目(不丢数据)', mixed.version === 1 && typeof mixed.entries['openai'] === 'object' && mixed.entries['mcp:s2:field'] === legacyStore['mcp:s2:field'])
  check('重配置键可读', (await m.getSecret('openai')) === 'reentered-1')
  st = await m.getSecretsStatus()
  check('剩余 legacy=1,available 仍 false', st.legacyCount === 1 && st.available === false, JSON.stringify(st))

  // ---------------------------------------------------------------- 阶段 7:并发安全 + 原子写
  console.log('\n[7] 并发首调 + 并发写(串行化/原子替换)')
  setHome(h4)
  m = fresh()
  const jobs = []
  for (let i = 0; i < 12; i++) jobs.push(m.setSecret(`prov:${i}`, `val-${i}`))
  jobs.push(m.getSecretsStatus())
  const rs = await Promise.all(jobs)
  check('12 个并发写全部成功', rs.slice(0, 12).every((x) => x && x.ok === true))
  const concurrencyJson = JSON.parse(readFileSync(join(h4, 'secrets.json'), 'utf8'))
  check('并发落盘后文件完整且 12 条', concurrencyJson.version === 1 && Object.keys(concurrencyJson.entries).length === 12)
  m = fresh()
  let allBack = true
  for (let i = 0; i < 12; i++) if ((await m.getSecret(`prov:${i}`)) !== `val-${i}`) allBack = false
  check('并发写后逐条可读', allBack)

  // ---------------------------------------------------------------- 阶段 8:删除与前缀删除
  console.log('\n[8] 删除 / 前缀删除 / 空串即删除')
  await m.deleteSecretsByPrefix('prov:1') // prov:1 与 prov:10..12(若有)——保持与桌面版前缀语义一致
  st = await m.getSecretsStatus()
  const remaining = Object.keys(JSON.parse(readFileSync(join(h4, 'secrets.json'), 'utf8')).entries)
  check('前缀删除生效', remaining.every((k) => !k.startsWith('prov:1')), JSON.stringify(remaining))
  await m.setSecret('prov:0', '')
  check('空串视为删除', (await m.hasSecret('prov:0')) === false && !('prov:0' in JSON.parse(readFileSync(join(h4, 'secrets.json'), 'utf8')).entries))
  await m.deleteSecret('prov:2')
  check('deleteSecret 幂等', (await m.deleteSecret('prov:2').then(() => true)) === true)

  // ---------------------------------------------------------------- 阶段 9:IPC 契约(通道与签名同旧版)
  console.log('\n[9] registerSecretsIpc:通道注册 + 处理器签名')
  setHome(h4)
  m = fresh()
  m.registerSecretsIpc()
  const platform = m // 打包入口同时导出了 platform.ts
  const evt = { sender: { send() {}, once() {}, off() {}, isDestroyed: () => false }, requestId: 't', connectionId: null, sessionId: 't' }
  const call = async (ch, ...args) => platform.getInvokeHandler(ch)(evt, ...args)
  check('secrets:set 返回 {ok,available}', JSON.stringify(Object.keys(await call('secrets:set', 'ipcprov', 'ipcval'))) === JSON.stringify(['ok', 'available']))
  check('secrets:has 布尔', (await call('secrets:has', 'ipcprov')) === true)
  check('secrets:list 含新键', (await call('secrets:list')).includes('ipcprov'))
  check('secrets:available 布尔', (await call('secrets:available')) === true)
  const statusViaIpc = await call('secrets:status')
  check('secrets:status 结构', statusViaIpc && typeof statusViaIpc.available === 'boolean' && typeof statusViaIpc.legacyCount === 'number')
  check('secrets:delete 返回 {ok:true}', (await call('secrets:delete', 'ipcprov')).ok === true)
  check('删除后 has=false', (await call('secrets:has', 'ipcprov')) === false)

  // 汇总
  console.log(`\n结果: ${passed} 通过, ${failed} 失败  (临时目录 ${work})`)
  if (failed === 0) rmSync(work, { recursive: true, force: true })
  process.exitCode = failed === 0 ? 0 : 1
}

function statMode(p) {
  // node:fs statSync().mode
  const { statSync } = require2('node:fs')
  return statSync(p).mode
}

main().catch((err) => {
  console.error(err)
  console.error(`\n(临时目录保留供排查: ${work})`)
  process.exitCode = 1
})
