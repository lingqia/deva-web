/**
 * 平台桥:把 Electron 主进程用到的平台能力收敛为显式接口,供 Node 服务端复用全部业务。
 *
 * 设计原则(web-migration-plan.md §3.2):
 * - 保留通道注册风格:`ipcMain.handle / ipcMain.on` 命名沿用,但实现来自本模块,不再依赖 Electron。
 *   HTTP /api/invoke/:channel 与 WS 上行分发都从本模块的注册表取处理器,注册表本身即白名单。
 * - 推送目标显式化:原 `BrowserWindow.webContents` 的推送改为 UiEventSender(按连接定向)与
 *   broadcastWindow(所有在线连接广播)。旧 `() => BrowserWindow | null` 取窗器签名改为
 *   `() => PlatformWindow | null`,业务代码仅需把 BrowserWindow 类型替换为 PlatformWindow。
 * - 未支持的操作(原生对话框、系统剪贴板、shell 打开等)显式失败,不做假成功。
 * - 本模块不 import Electron;shared 不 import 本模块(Node 运行时代码不进 shared)。
 */

/** 数据根目录:DEVA_HOME 环境变量覆盖(完整路径,原样使用),否则 ~/.deva(与桌面版 config.ts 一致)。 */
export function devaHome(): string {
  const override = process.env['DEVA_HOME']?.trim()
  const { join } = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  if (override && override.length > 0) return override
  return join(os.homedir(), '.deva')
}

/**
 * 旧桌面应用的 userData 目录(密钥库迁移工具专用)。
 * 服务端运行时不提供该路径 —— 旧密文迁移见 tools/legacy-secrets-export。
 */
export function legacyDesktopUserData(): string {
  const { join } = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  // Electron 默认 userData = 系统数据目录/<package.json name>,即 "@deva/desktop"
  // (斜杠成为子目录)。main/index.ts 的 app.setName('deva') 发生在 ready 之后,
  // 不改变 userData 位置,只影响 Linux 钥匙环条目名(application=@deva/desktop)。
  const base =
    process.platform === 'win32'
      ? process.env['APPDATA'] ?? join(os.homedir(), 'AppData', 'Roaming')
      : join(os.homedir(), '.config')
  return join(base, '@deva', 'desktop')
}

/** 应用版本:构建时由 scripts/build.mjs 注入 __APP_VERSION__,缺失时回落 dev 标识。 */
export function appVersion(): string {
  const v =
    typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0
      ? __APP_VERSION__
      : '0.0.0-dev'
  return v
}

/**
 * 推送目标:替代 WebContents.send 的最小接口。
 * - send:定向推送事件到该连接对应的页面。
 * - once('destroyed', cb):连接销毁(断开/登出/页面关闭)时触发,用于取消后台工作(如 git.ts)。
 * - isDestroyed():连接已销毁,继续 send 无效;业务用它停止无意义的流式输出。
 */
export interface UiEventSender {
  send(channel: string, ...args: unknown[]): void
  once(event: 'destroyed', listener: () => void): void
  off(event: 'destroyed', listener?: () => void): void
  isDestroyed(): boolean
}

/** 兼容旧 `BrowserWindow | null` 取窗器的最小窗口形状(仅保留业务实际用到的方法)。 */
export interface PlatformWindow {
  webContents: UiEventSender
  isDestroyed(): boolean
}

/**
 * invoke 请求上下文:替代 IpcMainInvokeEvent。
 * sender 是按请求所属连接定向的推送目标;connectionId 来自 WS hello(HTTP invoke 为 null);
 * onConnectionGone 注册连接断开回调(等价于旧 sender.once('destroyed'))。
 */
export interface InvokeEvent {
  sender: UiEventSender
  requestId: string
  connectionId: string | null
  /** 登录会话标识(服务端注入;业务一般不需要,用于按会话去重等场景)。 */
  sessionId: string
}

export type InvokeHandler = (evt: InvokeEvent, ...args: any[]) => unknown | Promise<unknown>
/** ipcMain.on 风格处理器(config:get-sync 同步读;服务端不从 WS 路由此类通道)。 */
export type SyncHandler = (evt: { returnValue: unknown }, ...args: any[]) => void

const invokeHandlers = new Map<string, InvokeHandler>()
const syncHandlers = new Map<string, SyncHandler>()
const handlerSources = new Map<string, string>()

/**
 * 与 Electron ipcMain 同形的注册入口。业务服务从本模块导入 ipcMain,注册逻辑不变;
 * 通道注册表即服务端 invoke 白名单(未注册通道一律 404/拒绝)。
 */
export const ipcMain = {
  handle(channel: string, handler: InvokeHandler, source = ''): void {
    if (invokeHandlers.has(channel) || syncHandlers.has(channel)) {
      throw new Error(`ipcMain.handle 通道重复注册: ${channel}`)
    }
    invokeHandlers.set(channel, handler)
    if (source) handlerSources.set(channel, source)
  },
  on(channel: string, handler: SyncHandler): void {
    if (invokeHandlers.has(channel) || syncHandlers.has(channel)) {
      throw new Error(`ipcMain.on 通道重复注册: ${channel}`)
    }
    syncHandlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    invokeHandlers.delete(channel)
    syncHandlers.delete(channel)
    handlerSources.delete(channel)
  }
}

/** invoke 通道白名单(注册表快照;排序输出便于审计)。 */
export function listInvokeChannels(): { channel: string; source: string }[] {
  return [...invokeHandlers.keys()]
    .sort()
    .map((channel) => ({ channel, source: handlerSources.get(channel) ?? '' }))
}

/** 取 invoke 处理器;未注册返回 undefined(调用方按未知通道拒绝)。 */
export function getInvokeHandler(channel: string): InvokeHandler | undefined {
  return invokeHandlers.get(channel)
}

// ---------------------------------------------------------------------------
// 广播窗口与通知出口:由服务端 bootstrap 安装,业务服务只读。
// ---------------------------------------------------------------------------

let broadcastProvider: (() => PlatformWindow | null) | null = null

/**
 * 注册广播取窗器(等价旧 mainWindow 提供者)。广播事件送达所有在线连接;
 * 无连接时返回 null,业务按旧「窗口不存在则丢弃」语义处理。
 */
export function setBroadcastProvider(provider: () => PlatformWindow | null): void {
  broadcastProvider = provider
}

/** 取广播目标(等价旧 getWindow());未安装或无在线连接时为 null。 */
export function getBroadcastWindow(): PlatformWindow | null {
  return broadcastProvider ? broadcastProvider() : null
}

/** 结构化通知(替代系统 Notification;由 WS 层广播给在线页面)。 */
export interface AppNotice {
  title: string
  body: string
  /** 关联会话(点击通知跳转用);可空。 */
  sessionId?: string
  kind?: 'reply' | 'task' | 'generic'
}

let noticeEmitter: ((notice: AppNotice) => void) | null = null

/** 安装通知出口(WS 层负责去重与浏览器 Notification 权限处理)。 */
export function setNoticeEmitter(fn: (notice: AppNotice) => void): void {
  noticeEmitter = fn
}

/** 发出结构化通知;未安装出口时静默丢弃(与旧「无窗口不通知」语义一致)。 */
export function emitNotice(notice: AppNotice): void {
  noticeEmitter?.(notice)
}

// ---------------------------------------------------------------------------
// 显式失败的平台替身:调用即抛错,调用方应改走 Web 等价流程。
// ---------------------------------------------------------------------------

export class PlatformUnsupportedError extends Error {
  constructor(op: string, hint: string) {
    super(`平台不支持的操作: ${op}(${hint})`)
    this.name = 'PlatformUnsupportedError'
  }
}

/** 原生对话框替身:Web 端改用 fs:browse(服务器目录选择)与上传链路。 */
export const dialog = {
  async showOpenDialog(): Promise<{ canceled: true; filePaths: [] }> {
    throw new PlatformUnsupportedError('dialog.showOpenDialog', 'Web 端改用 fs:browse / 上传链路')
  }
}

/** shell GUI 替身:打开文件/外部链接/文件夹在服务端无意义,显式失败;P6 由复制路径/下载替代。 */
export const shell = {
  async openExternal(url: string): Promise<void> {
    throw new PlatformUnsupportedError('shell.openExternal', `外链 ${url} 由浏览器直接打开`)
  },
  async openPath(): Promise<string> {
    throw new PlatformUnsupportedError('shell.openPath', '改用交付物预览/下载与复制服务器路径')
  },
  async showItemInFolder(): Promise<void> {
    throw new PlatformUnsupportedError('shell.showItemInFolder', '改用复制服务器路径')
  }
}
