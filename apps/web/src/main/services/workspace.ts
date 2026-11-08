import { dialog, ipcMain, shell, type PlatformWindow } from '../platform'
import { promises as fs, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { assertInside, isInsideRoot, trustRoot } from './fs-guard'
import { listSessions } from './chat-store'

/**
 * 工作区文件服务（主进程）。
 * 安全基线：所有读写都必须落在「已打开的项目根目录」之内，防止路径穿越。
 * 受信根集合与校验统一在 ./fs-guard，供 fs IPC 与 Agent 文件工具共享。
 * 详见 docs/architecture/security.md。
 */

export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

export interface OpenFolderResult {
  path: string
  name: string
}

export interface ReadFileResult {
  path: string
  content: string
  /** 超过大小上限，未加载内容 */
  tooLarge?: boolean
  /** 疑似二进制，未加载内容 */
  binary?: boolean
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2MB，超过则不加载正文

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function registerWorkspaceIpc(getWindow: () => PlatformWindow | null): void {
  // 打开文件夹对话框 → 选中目录登记为受信根
  // TODO(P6): Web 端改用 fs:browse 服务器目录选择(§5.4);platform.dialog 是显式失败替身,
  // 调用即抛错,不做假成功 —— 通道保留,落盘/登记逻辑待 fs:browse 就位后接回。
  ipcMain.handle('fs:open-folder', async (): Promise<OpenFolderResult | null> => {
    // 原桌面语义:{ properties: ['openDirectory'], title: '打开项目文件夹' } 选中目录 → trustRoot
    // platform.dialog 返回类型刻意收紧为空 filePaths:标注为通用选择结果形状以保留后续逻辑。
    const res: { canceled: boolean; filePaths: string[] } = await dialog.showOpenDialog()
    if (res.canceled || res.filePaths.length === 0) return null
    const dir = resolve(res.filePaths[0])
    trustRoot(dir)
    return { path: dir, name: basename(dir) || dir }
  })

  // 在系统文件管理器（资源管理器 / 访达）中打开目录。
  // 只收受信根内的「目录」：shell.openPath 对文件等于双击运行，绝不能让渲染层借此执行任意文件。
  // TODO(P6): Web 端改用「复制服务器路径」提示;platform.shell 是显式失败替身,调用即抛错
  // （PlatformUnsupportedError → invoke 以明确错误结束），不做假成功。
  ipcMain.handle('fs:reveal-folder', async (_e, dirPath: unknown): Promise<{ ok: boolean }> => {
    if (typeof dirPath !== 'string' || !dirPath || !isInsideRoot(dirPath)) return { ok: false }
    const stat = await fs.stat(dirPath).catch(() => null)
    if (!stat?.isDirectory()) return { ok: false }
    await shell.openPath()
    return { ok: false } // 不可达:替身恒抛错
  })

  // 读取目录（单层，懒加载）：目录在前，随后按名排序
  ipcMain.handle('fs:read-dir', async (_e, dirPath: string): Promise<DirEntry[]> => {
    assertInside(dirPath)
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: DirEntry[] = dirents
      .filter((d) => d.isDirectory() || d.isFile())
      .map((d) => ({
        name: d.name,
        path: join(dirPath, d.name),
        type: d.isDirectory() ? 'dir' : 'file'
      }))
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  })

  // 读取文件正文（防御超大 / 二进制）
  ipcMain.handle('fs:read-file', async (_e, filePath: string): Promise<ReadFileResult> => {
    assertInside(filePath)
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_BYTES) return { path: filePath, content: '', tooLarge: true }
    const buf = await fs.readFile(filePath)
    if (looksBinary(buf)) return { path: filePath, content: '', binary: true }
    return { path: filePath, content: buf.toString('utf8') }
  })

  // 写入文件正文
  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string): Promise<{ ok: true }> => {
    assertInside(filePath)
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true }
  })
}

// ───────── Web 服务器目录选择（web-migration-plan.md §5.4，P4）─────────
// fs:browse / fs:trust-root 取代桌面的 fs:open-folder（platform.dialog 在 Web 服务端是显式失败替身）：
// 浏览不设受信根前置（选择根之前允许浏览服务账号有权限的目录），登记（trust-root）才进 fs-guard。

/** 单页条目上限（§5.4：不递归、单页最多 500 项）。 */
const BROWSE_PAGE_SIZE = 500

/** fs:browse 成功结果。current/parent 均为服务器 realpath;根/盘符列表 parent=null。 */
export interface BrowseResult {
  ok: true
  current: string | null
  parent: string | null
  entries: DirEntry[]
  nextCursor?: string
}

export type BrowseFailure = { ok: false; reason: string }

/** 游标 = 已取条目数（十进制串）。非法/越界一律按 0 处理（目录内容在页间变化时可重取）。 */
function parseBrowseCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !/^\d{1,9}$/.test(cursor)) return 0
  return Number(cursor)
}

/** Windows 开发环境列盘符（§5.4）：逐个 stat 盘根，不存在/不可访问的字母静默跳过。 */
function listDrives(): DirEntry[] {
  const out: DirEntry[] = []
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i)
    const root = `${letter}:\\`
    try {
      if (statSync(root).isDirectory()) out.push({ name: `${letter}:`, path: root, type: 'dir' })
    } catch {
      /* 空盘位 / 无权限：跳过（软驱/断连网络盘可能慢，仅开发环境接受） */
    }
  }
  return out
}

/** 校验浏览目标：非空绝对路径、无 NUL、长度受限;返回 resolve 后的绝对路径,失败回 null（reason 已定）。 */
function validateBrowsePath(raw: unknown): { path: string } | { reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { reason: '缺少 path' }
  if (raw.includes('\0')) return { reason: '路径含非法字符' }
  if (raw.length > 4096) return { reason: '路径过长' }
  // 相对输入（含盘符相对 C:foo）直接拒绝（§5.4:不以 cwd 暗示基准）。UNC(\\server\share)与
  // 盘符绝对路径都放行;必须先于 resolve 判定 —— resolve 的产物恒为绝对路径,判产物会漏掉。
  if (!isAbsolute(raw)) return { reason: '需要绝对路径' }
  return { path: resolve(raw) }
}

async function browseDir(abs: string, cursor: unknown): Promise<BrowseResult | BrowseFailure> {
  // realpath 闭合符号链接（§5.4:读取目标 realpath 失败时拒绝,不静默退回字符串前缀）
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: '目录不存在' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: '无权访问该路径' }
    return { ok: false, reason: '路径无法解析' }
  }
  const st = await fs.stat(real).catch(() => null)
  if (!st?.isDirectory()) return { ok: false, reason: '目标不是目录' }
  const read = await fs.readdir(real, { withFileTypes: true }).catch((err) => {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'failed'
  })
  if (read === 'denied') return { ok: false, reason: '无权读取该目录' }
  if (read === 'failed') return { ok: false, reason: '目录读取失败' }
  const dirents = read
  // 与 fs:read-dir 同形：只留目录/文件,目录在前、按名称排序;不递归。
  const entries: DirEntry[] = dirents
    .filter((d) => d.isDirectory() || d.isFile())
    .map((d) => ({
      name: d.name,
      path: join(real, d.name),
      type: d.isDirectory() ? 'dir' : 'file'
    }))
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const offset = parseBrowseCursor(cursor)
  const page = offset < entries.length ? entries.slice(offset, offset + BROWSE_PAGE_SIZE) : []
  const parent = dirname(real)
  return {
    ok: true,
    current: real,
    parent: parent === real ? null : parent,
    entries: page,
    ...(offset + BROWSE_PAGE_SIZE < entries.length ? { nextCursor: String(offset + BROWSE_PAGE_SIZE) } : {})
  }
}

/**
 * 重启后重建受信根（fs-guard 是内存表,随进程清空;§5.4「重启后根据有效的已挂载工作区重新建立
 * 必要授权,缺失目录提示重选,不自动信任任意配置字符串」）。来源 = 各对话的 focusRoot —— 那是
 * 「已挂载工作区」的持久记录（对话属性,见 chat-store StoredSession.focusRoot）;缺失/无效目录
 * 跳过并告警,留待用户在该对话里重选。
 *
 * TODO(P4-H 接线):index.ts 业务注册（registerBusinessServices）之后调用一次
 * `require('./services/workspace').restoreTrustedRoots()`;须在对外服务就绪前完成,避免
 * files/raw 与 git 通道在挂载列表首次拉取前出现「尚未登记受信根」。
 */
export function restoreTrustedRoots(): void {
  const roots = listSessions()
    .map((m) => m.focusRoot)
    .filter((r): r is string => typeof r === 'string' && (r ?? '').trim().length > 0)
  for (const root of roots) {
    try {
      const real = realpathSync(root)
      if (statSync(real).isDirectory()) trustRoot(real)
      else console.warn(`[workspace] 受信根恢复跳过（不是目录）: ${root}`)
    } catch {
      console.warn(`[workspace] 受信根恢复跳过（缺失/不可读,请在该对话重选）: ${root}`)
    }
  }
}

/** fs:browse / fs:trust-root（Web 目录选择,P4）。注册进同一张 invoke 白名单。 */
export function registerWebWorkspaceIpc(): void {
  // 浏览服务器目录:不递归、单页 ≤500、目录在前按名称排序;path 缺省在 Windows 列盘符,
  // 其余平台从主目录/根开始导航由前端给定。parent 由服务器计算,支持正常向上导航。
  ipcMain.handle(
    'fs:browse',
    async (_e, q?: { path?: string; cursor?: string }): Promise<BrowseResult | BrowseFailure> => {
      // Windows:path 缺省/空 = 「我的电脑」盘符列表（current/parent 均无）。
      if (process.platform === 'win32' && (typeof q?.path !== 'string' || q.path.length === 0)) {
        return { ok: true, current: null, parent: null, entries: listDrives() }
      }
      const v = validateBrowsePath(q?.path)
      if ('reason' in v) return { ok: false, reason: v.reason }
      return browseDir(v.path, q?.cursor)
    }
  )

  // 登记受信根（「选择此服务器目录」）:绝对路径 + 存在且是目录 + realpath 可读,任一不满足即拒。
  // 登记的是 realpath（与 isInsideRoot 的真实路径比较同源,堵「链接在根内、目标在根外」）。
  ipcMain.handle(
    'fs:trust-root',
    async (_e, q?: { path?: string }): Promise<{ ok: true; path: string; name: string } | BrowseFailure> => {
      const v = validateBrowsePath(q?.path)
      if ('reason' in v) return { ok: false, reason: v.reason }
      let real: string
      try {
        real = await fs.realpath(v.path)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { ok: false, reason: '目录不存在' }
        if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: '无权访问该路径' }
        return { ok: false, reason: '路径无法解析' }
      }
      const st = await fs.stat(real).catch(() => null)
      if (!st?.isDirectory()) return { ok: false, reason: '目标不是目录' }
      trustRoot(real)
      return { ok: true, path: real, name: basename(real) || real }
    }
  )
}
