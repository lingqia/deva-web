/**
 * 纯 Node 单测(不启动 Electron):验证导出/导入工具中**不依赖 Electron**的全部逻辑。
 * 运行:npm test(先 tsc 构建 dist,再跑本文件)
 *
 * 覆盖:
 *  - 迁移包:封/拆往返、错口令拒绝、密文篡改拒绝、KDF 参数降级拒绝、载荷/条目限额
 *  - Web v1 信封:加解密往返、AAD=键名(条目移植到别的键名下必须解不开)
 *  - 主密钥:DEVA_SECRET_KEY 严格校验、secret.key 三种形态(原始 32B / 64 hex / 异常)
 *  - 目标库解析:旧扁平库、v1 混存(legacy 字符串原样保留)、损坏拒绝
 *  - 旧 safeStorage 密文前置分类:非字符串/坏 base64/缺 v10-v11 前缀 → corrupt(离线部分;
 *    真实 safeStorage 解密只能在旧机器 Electron 下验证,见 README「未验证声明」)
 *  - 导入编排:dry-run 不写盘、冲突跳过并报告、legacy 条目保留、首建主密钥、备份文件、
 *    已有 v1 条目但密钥缺失 → 拒绝导入
 *  - 参数解析与 userData 候选探测
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const toolRoot = join(here, '..')
const require2 = createRequire(import.meta.url)
const crypto = require2(join(toolRoot, 'dist', 'crypto.js'))
const mainMod = require2(join(toolRoot, 'dist', 'main.js'))

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
async function rejects(name, fn, matcher) {
  try {
    await fn()
    check(name, false, '未抛错')
  } catch (err) {
    check(name, matcher ? (err instanceof Error && matcher.test(err.message)) : true, String(err))
  }
}

async function main() {
  const passphrase = 'p4ssphrase-ok'
  const tmp = mkdtempSync(join(tmpdir(), 'deva-legacy-export-test-'))

  // ---------------------------------------------------------------- 迁移包
  console.log('\n[1] 迁移包封/拆')
  const payload = {
    format: crypto.EXPORT_FORMAT,
    version: crypto.EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { platform: 'test' },
    entries: { openai: 'sk-test-1', 'mcp:s1:field': 'tok-1' },
    failures: [{ id: 'broken', reason: 'corrupt', detail: 'x' }],
    counts: { total: 3, ok: 2, failed: 1 }
  }
  const pkg = crypto.sealPackage(payload, passphrase)
  check('包结构/版本/KDF', pkg.format === 'deva-secrets-export' && pkg.version === 1 && pkg.kdf.N === 32768 && pkg.kdf.r === 8 && pkg.kdf.p === 1)
  const opened = crypto.openPackage(pkg, passphrase)
  check('拆包往返,载荷一致', JSON.stringify(opened.entries) === JSON.stringify(payload.entries) && opened.counts.ok === 2)
  await rejects('错口令拒绝', async () => crypto.openPackage(pkg, 'wrong-passphrase-1'), /口令错误或包体被篡改/)
  const tampered = { ...pkg, ct: Buffer.from('tampered!' + pkg.ct.slice(9)).toString('base64').slice(0, pkg.ct.length) }
  await rejects('密文篡改拒绝', async () => crypto.openPackage(tampered, passphrase), /口令错误或包体被篡改/)
  const kdfDowngrade = { ...pkg, kdf: { name: 'scrypt', N: 16384, r: 8, p: 1 } }
  await rejects('KDF 降级拒绝', async () => crypto.openPackage(kdfDowngrade, passphrase), /KDF/)
  const versionBump = { ...pkg, version: 2 }
  await rejects('未知版本拒绝', async () => crypto.openPackage(versionBump, passphrase), /格式\/版本/)
  const giantPayload = { ...payload, entries: { big: 'x'.repeat(crypto.MAX_PAYLOAD_BYTES + 1) } }
  await rejects('载荷超限拒绝', async () => crypto.sealPackage(giantPayload, passphrase), /超过限额/)
  await rejects('单值超限拒绝', async () => crypto.validatePayload({ ...payload, entries: { big: 'x'.repeat(crypto.MAX_VALUE_BYTES + 1) } }), /超过/)
  await rejects('条目数超限拒绝', async () => {
    const many = {}
    for (let i = 0; i < crypto.MAX_ENTRIES + 1; i++) many[`k${i}`] = 'v'
    crypto.validatePayload({ ...payload, entries: many })
  }, /条目数/)

  // ---------------------------------------------------------------- v1 信封
  console.log('\n[2] Web v1 信封(AAD=键名)')
  const master = Buffer.alloc(32, 9)
  const env = crypto.encryptForEntry('openai', 'sk-test-1', master)
  check('信封形状/长度', env.v === 1 && env.alg === 'aes-256-gcm' && Buffer.from(env.iv, 'base64').length === 12 && Buffer.from(env.tag, 'base64').length === 16)
  check('解密往返', crypto.decryptForEntry('openai', env, master) === 'sk-test-1')
  await rejects('换键名(AAD 变)必须解不开(防移植)', async () => crypto.decryptForEntry('mcp:other', env, master), /./)
  await rejects('错主密钥必须解不开', async () => crypto.decryptForEntry('openai', env, Buffer.alloc(32, 8)), /./)

  // ---------------------------------------------------------------- 主密钥
  console.log('\n[3] 主密钥规则')
  check('parseHexKey 大小写混合通过', crypto.parseHexKey('A1B2C3D4E5F60718293A4B5C6D7E8F90a1b2c3d4e5f60718293a4b5c6d7e8f90').length === 32)
  await rejects('parseHexKey 非法长度拒绝', async () => crypto.parseHexKey('abcd'), /非法/)
  await rejects('parseHexKey 非 hex 拒绝', async () => crypto.parseHexKey('z'.repeat(64)), /非法/)
  const keyDir = join(tmp, 'keys')
  mkdirSync(keyDir, { recursive: true })
  const raw32 = Buffer.alloc(32, 1)
  writeFileSync(join(keyDir, 'raw.key'), raw32)
  check('secret.key:原始 32 字节', Buffer.compare(await crypto.readKeyFile(join(keyDir, 'raw.key')), raw32) === 0)
  const hexText = Buffer.from('a'.repeat(64) + '\n', 'utf8')
  writeFileSync(join(keyDir, 'hex.key'), hexText)
  check('secret.key:64 hex 文本', Buffer.compare(await crypto.readKeyFile(join(keyDir, 'hex.key')), Buffer.alloc(32, 0xaa)) === 0)
  writeFileSync(join(keyDir, 'bad.key'), Buffer.alloc(31, 1))
  await rejects('secret.key:31 字节异常拒绝且不覆盖', async () => crypto.readKeyFile(join(keyDir, 'bad.key')), /编码异常/)
  check('secret.key:不存在返回 null', (await crypto.readKeyFile(join(keyDir, 'nope.key'))) === null)

  // ---------------------------------------------------------------- 目标库解析
  console.log('\n[4] 目标库解析')
  const flat = JSON.stringify({ openai: 'QUJD', 'mcp:x:field': 'REVG' })
  const parsedFlat = crypto.parseTargetStore(flat)
  check('旧扁平库 → 全部按 legacy 字符串保留', parsedFlat.entries['openai'] === 'QUJD' && typeof parsedFlat.entries['mcp:x:field'] === 'string')
  const v1Mixed = JSON.stringify({
    version: 1,
    entries: { openai: env, 'legacy-key': 'QUJD' }
  })
  const parsedV1 = crypto.parseTargetStore(v1Mixed)
  check('v1 混存:信封为对象、legacy 为字符串', crypto.isEnvelopeV1(parsedV1.entries['openai']) && parsedV1.entries['legacy-key'] === 'QUJD')
  await rejects('损坏库拒绝(不覆盖)', async () => crypto.parseTargetStore('{not json'), /解析失败/)
  await rejects('未知版本拒绝', async () => crypto.parseTargetStore(JSON.stringify({ version: 2, entries: {} })), /版本/)

  // ---------------------------------------------------------------- 旧密文前置分类(离线部分)
  console.log('\n[5] 旧 safeStorage 密文分类(离线校验)')
  const c1 = mainMod.tryDecryptLegacy(123, null)
  check('非字符串 → corrupt', c1.ok === false && c1.reason === 'corrupt')
  const c2 = mainMod.tryDecryptLegacy('!!!not-base64!!!', null)
  check('坏 base64 → corrupt', c2.ok === false && /base64/.test(c2.detail))
  const fakeV10 = Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 3)]).toString('base64')
  const c3 = mainMod.tryDecryptLegacy(fakeV10, null)
  check('v10 前缀但无 Electron → 归 corrupt(真实解密只能在旧机验证)', c3.ok === false && c3.reason === 'corrupt')
  const c4 = mainMod.tryDecryptLegacy(Buffer.from('plain-no-prefix').toString('base64'), null)
  check('缺 v10/v11 前缀 → corrupt(绝不喂给解密)', c4.ok === false && /v10\/v11/.test(c4.detail))

  // ---------------------------------------------------------------- 导入编排
  console.log('\n[6] 导入:dry-run / 冲突跳过 / legacy 保留 / 首建主密钥 / 备份')
  const home = join(tmp, 'home-import')
  mkdirSync(home, { recursive: true })
  // 预置旧扁平目标库:1 个与包冲突的键 + 1 个无关 legacy 键
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ 'legacy-conflict': 'T0xEX1ZBTFVF', 'other-legacy': 'bGVnYWN5' }, null, 2), 'utf8')
  const importPayload = {
    ...payload,
    entries: { openai: 'sk-imported-1', 'mcp:s1:field': 'tok-imported', 'legacy-conflict': 'new-value' }
  }
  const pkgFile = join(tmp, 'package.json-export.json')
  writeFileSync(pkgFile, JSON.stringify(crypto.sealPackage(importPayload, passphrase), null, 2), 'utf8')
  const args = { mode: 'import', packageFile: pkgFile, devaHome: home, dryRun: false, help: false }

  // 6a dry-run:不写盘
  const dryReport = await mainMod.runImport({ ...args, dryRun: true }, { passphrase, log: () => {} })
  check('dry-run:导入 2 条、跳过冲突 1 条', dryReport.imported.length === 2 && dryReport.skippedConflicts.length === 1 && dryReport.skippedConflicts[0] === 'legacy-conflict')
  check('dry-run:目标库未被改写', readFileSync(join(home, 'secrets.json'), 'utf8').includes('T0xEX1ZBTFVF'))
  check('dry-run:无备份文件、无主密钥生成', readdirSync(home).filter((f) => f.startsWith('secrets.json.bak') || f === 'secret.key').length === 0)

  // 6b 实际导入
  const report = await mainMod.runImport(args, { passphrase, log: () => {} })
  check('导入:主密钥首建 keySource=generated', report.keySource === 'generated')
  check('导入:备份已建', typeof report.backupPath === 'string' && readdirSync(home).some((f) => f.startsWith('secrets.json.bak-')))
  const storeAfter = crypto.parseTargetStore(readFileSync(join(home, 'secrets.json'), 'utf8'))
  const keyAfter = await crypto.readKeyFile(join(home, 'secret.key'))
  check('导入:secret.key 已建且 32 字节', keyAfter && keyAfter.length === 32)
  check('导入:新条目可解密且值正确', crypto.decryptForEntry('openai', storeAfter.entries['openai'], keyAfter) === 'sk-imported-1' && crypto.decryptForEntry('mcp:s1:field', storeAfter.entries['mcp:s1:field'], keyAfter) === 'tok-imported')
  check('导入:legacy 条目原样保留(不覆盖不丢弃)', storeAfter.entries['legacy-conflict'] === 'T0xEX1ZBTFVF' && storeAfter.entries['other-legacy'] === 'bGVnYWN5')
  check('导入:每条独立 nonce', storeAfter.entries['openai'].iv !== storeAfter.entries['mcp:s1:field'].iv)
  check('导入:旧备份里仍是原始扁平库', readFileSync(report.backupPath, 'utf8').includes('T0xEX1ZBTFVF'))

  // 6c 已有 v1 条目但主密钥缺失 → 拒绝导入
  const home2 = join(tmp, 'home-nolock')
  mkdirSync(home2, { recursive: true })
  writeFileSync(join(home2, 'secrets.json'), JSON.stringify({ version: 1, entries: { openai: env } }), 'utf8')
  await rejects('已有 v1 条目但密钥缺失 → 拒绝导入(不重生成)', async () => mainMod.runImport({ ...args, devaHome: home2 }, { passphrase, log: () => {} }), /主密钥缺失/)

  // 6d 非法 DEVA_SECRET_KEY → 拒绝(不回落)
  process.env['DEVA_SECRET_KEY'] = 'not-hex'
  await rejects('非法 DEVA_SECRET_KEY → 拒绝', async () => mainMod.runImport({ ...args, devaHome: home2 }, { passphrase, log: () => {} }), /非法/)
  delete process.env['DEVA_SECRET_KEY']

  // ---------------------------------------------------------------- 参数与候选
  console.log('\n[7] 参数解析与 userData 候选')
  const parsedArgs = mainMod.parseArgs(['--import', 'pkg.json', '--deva-home', '/tmp/h', '--dry-run'])
  check('parseArgs --import/--deva-home/--dry-run', parsedArgs.mode === 'import' && parsedArgs.packageFile === 'pkg.json' && parsedArgs.dryRun === true)
  await rejects('parseArgs 未知参数拒绝', async () => mainMod.parseArgs(['--wat']), /未知参数/)
  const candidates = mainMod.discoverUserDataCandidates()
  check(
    'userData 候选含 @deva/desktop 与 deva',
    candidates.some((c) => c.includes('@deva') && c.includes('desktop')) && candidates.some((c) => /deva/.test(c) && !c.includes('@deva')),
    JSON.stringify(candidates)
  )

  // ---------------------------------------------------------------- 汇总
  console.log(`\n结果: ${passed} 通过, ${failed} 失败  (临时目录 ${tmp})`)
  if (failed === 0) rmSync(tmp, { recursive: true, force: true })
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
