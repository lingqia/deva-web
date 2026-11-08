// 生产构建:Vite 前端 + esbuild 两个服务端入口(Node/CJS)。
// 产物:out/renderer/(Vite)、out/server/index.cjs、out/server/pty-host.cjs(esbuild)。
// 服务端依赖全部 external(运行时由 node_modules 提供),仅打包工作区源码。
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const pkg = require(path.join(pkgRoot, 'package.json'))

// 运行时依赖全量 external;node 内置模块 esbuild 默认已外部化(platform: 'node')。
const external = Object.keys(pkg.dependencies ?? {})

/** Vite 前端构建(root=src/renderer,输出 out/renderer)。 */
function buildRenderer() {
  // workspace hoisted 安装下 vite 在根 node_modules;exports 不暴露 bin 子路径,先解析包目录
  const vitePkgDir = path.dirname(require.resolve('vite/package.json', { paths: [pkgRoot] }))
  const viteBin = path.join(vitePkgDir, 'bin', 'vite.js')
  const r = spawnSync(process.execPath, [viteBin, 'build'], {
    cwd: pkgRoot,
    stdio: 'inherit'
  })
  if (r.status !== 0) throw new Error(`Vite 构建失败(退出码 ${r.status})`)
}

/** 服务端入口构建:bundle 工作区源码,依赖 external,输出 CJS。 */
async function buildServerEntry(entry, outfile) {
  await build({
    entryPoints: [path.join(pkgRoot, entry)],
    outfile: path.join(pkgRoot, outfile),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: 'external',
    sourcesContent: false,
    external,
    // 与前端 Vite define 同源:服务端 appVersion() 读取的版本号
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'info'
  })
}

async function main() {
  console.log('[build] 1/3 Vite 前端...')
  buildRenderer()

  console.log('[build] 2/3 服务端入口 index.cjs...')
  rmSync(path.join(pkgRoot, 'out', 'server'), { recursive: true, force: true })
  mkdirSync(path.join(pkgRoot, 'out', 'server'), { recursive: true })
  await buildServerEntry('src/server/index.ts', 'out/server/index.cjs')

  console.log('[build] 3/3 PTY 宿主 pty-host.cjs...')
  await buildServerEntry('src/main/pty-host.ts', 'out/server/pty-host.cjs')

  console.log('[build] 完成')
}

main().catch((err) => {
  console.error('[build] 失败:', err?.message ?? err)
  process.exit(1)
})
