// 开发模式:先构建同形态双入口(Vite 前端 + esbuild 服务端),再运行 Node 服务;
// 服务端源码变更 → 增量重建 → 成功后重启 Node 子进程;前端变更由 Vite 自行 HMR。
// 环境变量加载位置明确限定:apps/web/.env.development(仅开发模式,显式路径,不隐式查找任意 .env)。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

// ---- 显式加载 apps/web/.env.development(KEY=VALUE 行,# 注释;不覆盖已存在的环境变量) ----
const envFile = path.join(pkgRoot, '.env.development')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!(m[1] in process.env)) process.env[m[1]] = val
  }
  console.log(`[dev] 已加载 ${path.relative(pkgRoot, envFile)}`)
}

process.env.NODE_ENV = 'development'
// 开发固定 Vite Origin(与 vite.config.ts 的 127.0.0.1:5173 严格一致);用户已设则尊重。
process.env.DEVA_WEB_ORIGIN ??= 'http://127.0.0.1:5173'
process.env.DEVA_WEB_HOST ??= '127.0.0.1'
process.env.DEVA_WEB_PORT ??= '7421'

/** Windows 下终结整棵进程树(taskkill);POSIX 直接 kill 信号。 */
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill(signal)
  }
}

const children = []
let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) killTree(c)
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ---- esbuild watch:两个服务端入口同形态构建 ----
const { context } = await import('esbuild')
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const external = Object.keys(pkg.dependencies ?? {})

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'inline',
  external,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'silent'
}

let serverChild = null
/** 成功构建后(重)启 Node 服务;构建失败保留旧进程继续跑,错误打印到控制台。 */
function restartServer(reason) {
  if (shuttingDown) return
  if (serverChild) {
    killTree(serverChild)
    children.splice(children.indexOf(serverChild), 1)
    serverChild = null
  }
  console.log(`[dev] 启动服务(${reason})...`)
  serverChild = spawn(process.execPath, [path.join(pkgRoot, 'out/server/index.cjs')], {
    cwd: pkgRoot,
    env: process.env,
    stdio: 'inherit'
  })
  children.push(serverChild)
  serverChild.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`[dev] 服务退出(码 ${code}),等待源码变更后重试`)
    }
  })
}

const watchOpts = [
  { entryPoints: [path.join(pkgRoot, 'src/server/index.ts')], outfile: path.join(pkgRoot, 'out/server/index.cjs') },
  { entryPoints: [path.join(pkgRoot, 'src/main/pty-host.ts')], outfile: path.join(pkgRoot, 'out/server/pty-host.cjs') }
]

// 先同步完成首次构建(rebuild)并启动服务:esbuild 的 watch 回调只对"后续重建"触发,
// 首次构建不走回调,不能依赖它拉起服务。
for (const opt of watchOpts) {
  const ctx = await context({ ...common, ...opt })
  await ctx.rebuild()
  await ctx.watch((err) => {
    if (err) {
      console.error('[dev] 构建失败:', err.message)
      return
    }
    // 两个入口都由各自 watch 回调触发重启:多次触发会串行快速重启,可接受(幂等)。
    restartServer(opt.outfile.includes('pty-host') ? 'pty-host 重建' : '服务端重建')
  })
}
restartServer('首次构建完成')

// ---- Vite 开发服务器(前端) ----
// workspace hoisted 安装下 vite 在根 node_modules;exports 不暴露 bin 子路径,先解析包目录
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const vitePkgDir = path.dirname(require2.resolve('vite/package.json', { paths: [pkgRoot] }))
const viteBin = path.join(vitePkgDir, 'bin', 'vite.js')
const vite = spawn(process.execPath, [viteBin], { cwd: pkgRoot, stdio: 'inherit', env: process.env })
children.push(vite)
vite.on('exit', (code) => {
  console.log(`[dev] Vite 退出(码 ${code})`)
  shutdown(0)
})

console.log('[dev] 前端 http://127.0.0.1:5173 · 服务端 127.0.0.1:7421(经 Vite 代理同源访问)')
