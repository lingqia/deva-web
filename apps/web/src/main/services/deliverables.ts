import { ipcMain } from '../platform'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import sharp from 'sharp'
import type { DeliverableInfo } from '../../shared/deliverables'
import { getSession } from './chat-store'

/**
 * 交付卡（present_files）的操作：查看文件信息与缩略图、用默认应用打开、在文件夹中显示。
 *
 * 渲染层只给「对话 id + 调用 id + 序号」，路径一律由主进程按该对话里那次 present_files 调用取
 *（会话边车 delivered）。这几个 IPC 因此只能作用于模型明确交付给用户的文件，不会变成任意路径的读取 / 打开口子。
 *
 * Web 化差异：
 * - 缩略图不再走 Electron nativeImage（系统缩略图服务 / 文件图标），改用 sharp 异步缩放图片源文件；
 *   仅对图片类交付出缩略图，其余类型（PDF/Office/视频…）回落渲染层既有的文件类型图标体系（§4.3）。
 * - 「用默认应用打开 / 在文件夹中显示」是桌面语义，服务器端无意义：通道保留但显式失败
 *   （返回 {ok:false,reason:'unsupported'}），Web 端使用复制路径/预览下载。TODO(P6)。
 */

/**
 * 允许「用默认应用打开」的扩展名：成品类文件。可执行 / 脚本类（exe、bat、ps1、js、py、lnk …）
 * 用默认应用打开就等于运行，一律不放行，只能在文件夹中显示。
 */
const OPENABLE = new Set([
  // 网页 / 文本 / 数据
  '.html', '.htm', '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  // 文档
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf', '.epub',
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif', '.heic',
  // 视频
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v',
  // 音频
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus',
  // 压缩包（系统打开即浏览内容）
  '.zip'
])

/** 可用 sharp 生成位图缩略图的扩展名（矢量/位图图片源；其余类型不出缩略图）。 */
const THUMBNAILABLE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.svg', '.ico', '.heic'
])

const THUMB_SIZE = 128

/**
 * 该对话里那次 present_files 调用交付的文件：取会话边车 delivered（已解析、去重）。
 * 边车缺失时回落历史里该调用参数中的绝对路径（早期版本把解析后的路径直接写进了参数，没有边车）。
 */
function deliveredPaths(sessionId: unknown, toolUseId: unknown): string[] {
  if (typeof sessionId !== 'string' || typeof toolUseId !== 'string') return []
  const s = getSession(sessionId)
  if (!s) return []
  const recorded = s.delivered?.[toolUseId]
  if (recorded) return recorded
  for (const m of s.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const p of m.content) {
      if (p.type !== 'tool_use' || p.id !== toolUseId) continue
      if (p.name !== 'present_files') return []
      const paths = (p.input as { paths?: unknown } | null)?.paths
      return Array.isArray(paths)
        ? paths.filter((x): x is string => typeof x === 'string' && isAbsolute(x))
        : []
    }
  }
  return []
}

function deliveredPath(sessionId: unknown, toolUseId: unknown, index: unknown): string | null {
  if (typeof index !== 'number' || !Number.isInteger(index)) return null
  return deliveredPaths(sessionId, toolUseId)[index] ?? null
}

/**
 * Web 交付物下载的服务器侧定位（GET /api/files/deliverable，P4 / §5.4）：
 * 按 sessionId/toolUseId/index 取交付记录里的路径 —— 会话边车 `delivered`（已解析、去重的绝对路径）
 * 优先，旧记录回落 present_files 调用参数中的绝对路径。**授权即来自该记录**：交付物可位于工作区外，
 * 不做受信根判定；真实目标（realpath）与普通文件校验在 files.ts 下载时重做（inspect 结果不能替代下载校验）。
 */
export function deliveredRecordPath(sessionId: unknown, toolUseId: unknown, index: unknown): string | null {
  return deliveredPath(sessionId, toolUseId, index)
}

async function isFile(p: string): Promise<boolean> {
  const st = await fs.stat(p).catch(() => null)
  return Boolean(st?.isFile())
}

export function registerDeliverablesIpc(): void {
  ipcMain.handle(
    'deliverables:inspect',
    async (_e, sessionId: unknown, toolUseId: unknown): Promise<DeliverableInfo[]> =>
      Promise.all(
        deliveredPaths(sessionId, toolUseId).map(async (p) => {
          const st = await fs.stat(p).catch(() => null)
          return {
            path: p,
            name: basename(p),
            dir: dirname(p),
            size: st?.isFile() ? st.size : null,
            openable: OPENABLE.has(extname(p).toLowerCase())
          }
        })
      )
  )

  // 缩略图：sharp 异步缩放图片源文件（保持现有「取不到就回落文件类型图标」语义 —— 出错/非图片返回
  // null，渲染层按类型回落图标；PDF/Office/视频不为缩略图增加 Office/视频服务依赖，§4.3）。
  ipcMain.handle(
    'deliverables:thumbnail',
    async (_e, sessionId: unknown, toolUseId: unknown, index: unknown): Promise<string | null> => {
      const p = deliveredPath(sessionId, toolUseId, index)
      if (!p || !(await isFile(p))) return null
      if (!THUMBNAILABLE.has(extname(p).toLowerCase())) return null
      try {
        // fit:'inside' 等比缩到长边 ≤128px;withoutEnlargement 不放大小图;统一转 PNG 出 data URI。
        const buf = await sharp(p, { failOn: 'none' })
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer()
        return buf.length ? `data:image/png;base64,${buf.toString('base64')}` : null
      } catch {
        /* 解码失败 / sharp 不支持该格式 → 回落文件图标 */
        return null
      }
    }
  )

  // TODO(P6): 「用默认应用打开」是桌面语义,Web 端使用复制路径/预览下载(HTML/PDF/图片内联预览 +
  // 其余下载,见 §5.4 预览与下载)。通道保留但显式失败(返回明确错误对象),不做假成功。
  ipcMain.handle(
    'deliverables:open',
    async (_e, sessionId: unknown, toolUseId: unknown, index: unknown): Promise<{ ok: boolean; reason?: string; message?: string }> => {
      const p = deliveredPath(sessionId, toolUseId, index)
      if (!p || !OPENABLE.has(extname(p).toLowerCase()) || !(await isFile(p))) return { ok: false }
      return { ok: false, reason: 'unsupported', message: 'Web 端使用复制路径/预览下载' }
    }
  )

  // TODO(P6): 「在文件夹中显示」是桌面语义,Web 端使用复制路径/预览下载。通道保留但显式失败。
  ipcMain.handle(
    'deliverables:reveal',
    async (_e, sessionId: unknown, toolUseId: unknown, index: unknown): Promise<{ ok: boolean; reason?: string; message?: string }> => {
      const p = deliveredPath(sessionId, toolUseId, index)
      if (!p || !(await isFile(p))) return { ok: false }
      return { ok: false, reason: 'unsupported', message: 'Web 端使用复制路径/预览下载' }
    }
  )
}
