// 发布归档:打一个可部署的 tar.gz(web-migration-plan.md §11.4)。
// 内容 = 构建产物(apps/web/out)+ 依赖安装所需元数据(package/lock/workspace/.npmrc)
// + 部署与迁移文档 + deploy 模板。**不能只打 out 目录** —— 服务器要按归档内的
// pnpm-lock.yaml 重新安装生产依赖后才能运行(干净 Linux 验证:见 docs/validation)。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const repoRoot = path.resolve(webRoot, '..', '..')
const require2 = createRequire(import.meta.url)
const pkg = require2(path.join(webRoot, 'package.json'))

const version = pkg.version
const outDir = path.join(repoRoot, 'release')
const stage = path.join(outDir, `deva-web-v${version}`)
const archive = path.join(outDir, `deva-web-v${version}.tar.gz`)

rmSync(stage, { recursive: true, force: true })
rmSync(archive, { force: true })
mkdirSync(path.join(stage, 'apps', 'web'), { recursive: true })

// 1) 构建产物(必须先 pnpm build)
for (const dir of ['out/server', 'out/renderer']) {
  const src = path.join(webRoot, dir)
  try {
    statSync(src)
  } catch {
    console.error(`[archive] 缺少 ${dir},请先运行 pnpm build`)
    process.exit(1)
  }
  cpSync(src, path.join(stage, 'apps', 'web', dir), { recursive: true })
}

// 2) 依赖安装元数据(服务器 pnpm install --prod --frozen-lockfile 需要)
for (const f of ['package.json']) {
  cpSync(path.join(webRoot, f), path.join(stage, 'apps', 'web', f))
}
for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
  cpSync(path.join(repoRoot, f), path.join(stage, f))
}

// 3) 部署/迁移文档与模板
cpSync(path.join(repoRoot, 'deploy'), path.join(stage, 'deploy'), { recursive: true })
for (const d of ['docs/deploy-web.md', 'docs/migration-web.md', 'README.md', 'LICENSE']) {
  cpSync(path.join(repoRoot, d), path.join(stage, path.basename(d)))
}

// 4) 安装说明
writeFileSync(
  path.join(stage, 'INSTALL.txt'),
  `Deva Web v${version} 可部署归档

1. 解压到目标目录(示例 /opt/deva): tar -xzf deva-web-v${version}.tar.gz
2. 安装生产依赖(需要 Node.js 22 与 pnpm 10,在归档根目录执行):
     pnpm install --frozen-lockfile --prod
3. 配置环境(deploy/deva-web.env.example → /etc/deva/deva-web.env,占位符必须全部替换)
4. 首次构建产物已含在本归档;若需重新构建: pnpm build
5. 启动: node apps/web/out/server/index.cjs
   生产 systemd/nginx 见 deploy/ 与 deploy-web.md。
`
)

// 5) 打 tar.gz(在 outDir 内用纯文件名调用,避免 GNU tar 把 Windows 盘符路径当远程主机)
const r = spawnSync('tar', ['-czf', path.basename(archive), path.basename(stage)], {
  cwd: outDir,
  stdio: 'inherit'
})
if (r.status !== 0) {
  console.error('[archive] tar 失败')
  process.exit(1)
}
rmSync(stage, { recursive: true, force: true })
console.log(`[archive] 完成: ${archive}`)
