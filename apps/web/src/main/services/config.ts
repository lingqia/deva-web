import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'node:os'
import { join } from 'path'
import { ipcMain } from '../platform'

/**
 * 应用配置存储（主进程）。
 * 非敏感的用户配置（主题 / 语言 / 服务商与模型 / 默认模型等）以**明文 JSON** 存于
 * `~/.deva/config.json`，开发者可手改 / 备份 / 版本化（对标 ~/.claude）。
 * 根目录可用环境变量 `DEVA_HOME` 覆盖（便携安装 / 测试 / CI）。
 * **敏感信息（API 密钥）绝不进此文件**——见 services/secrets.ts（Web 端改加密的 secrets.json）。
 * 详见 docs/architecture/security.md。
 *
 * Web 迁移说明：`config:get-sync` 为同步读通道，不经 HTTP / WS invoke 路由
 * （platform.ts 仅登记 SyncHandler）；渲染层首帧改走服务端预取缓存，不再逐次同步 IPC。
 * 渲染层写配置走 `config:set` 的显式删键协议（见 setConfig）——JSON 传输没有 undefined，
 * 删除顶层键须以 unsetKeys 显式表达。
 */

let home = ''

/** Deva 配置根目录：DEVA_HOME 覆盖，否则 ~/.deva。首次调用即确保目录存在。 */
export function getDevaHome(): string {
  if (home) return home
  const override = process.env.DEVA_HOME?.trim()
  // 原桌面版取 app.getPath('home')；Web 服务端等价用 os.homedir()（同为当前用户主目录）。
  home = override && override.length > 0 ? override : join(homedir(), '.deva')
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
  } catch {
    /* 目录创建失败：后续读写各自兜底，不阻断启动 */
  }
  return home
}

function configPath(): string {
  return join(getDevaHome(), 'config.json')
}

let config: Record<string, unknown> = {}
let loaded = false

/** 同步载入（配置很小；同步读简化了首帧同步 IPC）。 */
function ensureLoaded(): void {
  if (loaded) return
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>
  } catch {
    // 首次运行 / 文件不存在 / 解析失败 —— 视为空配置
    config = {}
  }
  loaded = true
}

function persist(): void {
  try {
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch {
    /* 持久化失败静默：不影响本次会话的内存态 */
  }
}

/**
 * 主进程内读取整份配置（只读快照）。
 * 供其它服务在进程内复用（如 git.ts 读 `git.path` 覆盖），避免各自重复读文件。
 */
export function getConfig(): Record<string, unknown> {
  ensureLoaded()
  return config
}

/**
 * 主进程内写配置（顶层浅合并），并落盘。
 * 供 skills.ts / personas.ts 等服务在进程内维护启用态（config.json 内的 skills/personas 段），
 * 与渲染层的 `config:set` IPC 走同一份内存态 + 持久化路径。
 *
 * 显式删键协议（web-migration-plan.md §5.3）：进程内调用沿用旧语义——`cleanPatch` 顶层浅合并、
 * 值为 undefined 时删除该键；渲染层经 JSON 传输没有 undefined，删键改走第二参 `unsetKeys`
 * （顶层键名数组，在补丁合并之后逐个 delete）。两个入参名即协议：调用方须先把补丁里的
 * undefined 值剔除成 cleanPatch，再把要删的键名列进 unsetKeys，不得混用。
 */
export function setConfig(cleanPatch: Record<string, unknown>, unsetKeys?: string[]): void {
  ensureLoaded()
  if (cleanPatch && typeof cleanPatch === 'object') {
    for (const [k, v] of Object.entries(cleanPatch)) {
      if (v === undefined) delete config[k]
      else config[k] = v
    }
  }
  // 显式删键在补丁合并之后执行：同键先补后删 = 删除（渲染层不会这么传，进程内也不应混用）。
  if (Array.isArray(unsetKeys)) {
    for (const k of unsetKeys) {
      if (typeof k === 'string') delete config[k]
    }
  }
  persist()
}

export function registerConfigIpc(): void {
  ensureLoaded()

  // 同步读取整份配置：供渲染层首帧读取主题/语言，避免闪烁（FOUC）。
  // Web 端该通道不经 WS 路由（platform.ts 只登记 SyncHandler），渲染层走预取缓存取同份数据。
  ipcMain.on('config:get-sync', (evt) => {
    ensureLoaded()
    evt.returnValue = config
  })

  // 异步读取整份配置。
  ipcMain.handle('config:get', () => {
    ensureLoaded()
    return config
  })

  // 顶层浅合并补丁 + 显式删键（§5.3）：cleanPatch 不得携带 undefined（JSON 传输本就不可能有），
  // 要删的顶层键改列入 unsetKeys（string[]，≤64 项）。
  ipcMain.handle(
    'config:set',
    (_e, cleanPatch: Record<string, unknown>, unsetKeys?: string[]): { ok: true } => {
      if (cleanPatch === null || typeof cleanPatch !== 'object' || Array.isArray(cleanPatch))
        throw new Error('config:set 的补丁必须是普通对象')
      if (unsetKeys !== undefined) {
        if (!Array.isArray(unsetKeys) || unsetKeys.length > 64)
          throw new Error('config:set 的 unsetKeys 必须是不超过 64 项的字符串数组')
        for (const k of unsetKeys)
          if (typeof k !== 'string') throw new Error('config:set 的 unsetKeys 必须全为字符串')
      }
      setConfig(cleanPatch, unsetKeys)
      return { ok: true as const }
    }
  )
}
