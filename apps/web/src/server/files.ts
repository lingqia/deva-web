/**
 * 文件协议(web-migration-plan.md §5.4,P2 基础版):
 * - GET /api/files/raw?path=:受信根内普通文件。路径/真实目标/类型均在服务器检查;
 *   拒绝目录/设备/管道/socket;流式读(大文件不整体 base64);单段 Range(206/416);处理 HEAD 与断连。
 *   Content-Type 用 mime-types;nosniff;private,no-store;安全 Content-Disposition(含 filename* UTF-8);
 *   HTML/SVG 内联时附加 CSP sandbox 响应头(禁脚本/表单/同源权限/外网/嵌框,允许内联样式与 data 图片)。
 * - GET /api/files/deliverable?sessionId=&toolUseId=&index=:参数校验;路径由交付记录决定,
 *   禁止客户端覆盖 —— P4 已接 deliverables.ts 的交付记录(会话边车 delivered;旧记录回落
 *   present_files 参数):记录即授权(交付物可在工作区外,不加受信根判定),下载时重校验真实
 *   目标(realpath + 普通文件),记录不可定位/文件缺失明确 404 JSON,不回 SPA。
 * - 受信根:复用 main/services/fs-guard(内存态,realpath 比较)。P2 不从配置自动信任任意
 *   路径字符串(§5.4);由 P4 的 fs:trust-root / 工作区挂载在启动与挂载时登记。
 */
import { createReadStream, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'
import type { Request, Response } from 'express'
import { contentType as mimeContentType } from 'mime-types'
import { isInsideRoot, listRoots } from '../main/services/fs-guard'
import { deliveredRecordPath } from '../main/services/deliverables'
import { InvokeError } from './registry'
import { errMessage, warn } from './log'

/** 错误码复用 invoke 的映射:INVALID_ARGUMENT 400 / NOT_FOUND 404 / FORBIDDEN 403。 */

export interface FilesHandlers {
  raw(req: Request, res: Response): Promise<void>
  deliverable(req: Request, res: Response): Promise<void>
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** 单段 Range 解析:无/非法/多段 → null(按 RFC 忽略,200 全量);越界 → 'unsatisfiable'(416)。 */
export function parseSingleRange(
  header: string | string[] | undefined,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || Array.isArray(header) || typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (a === '') {
    // 后缀式:bytes=-N → 最后 N 字节
    const n = Number(b)
    if (!Number.isInteger(n) || n <= 0) return null
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  if (!Number.isInteger(start)) return null
  if (start >= size) return 'unsatisfiable'
  let end: number
  if (b === '') {
    end = size - 1
  } else {
    end = Number(b)
    if (!Number.isInteger(end)) return null
    if (end < start) return null // 非法区间:忽略 Range,200 全量
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

/** 安全 Content-Disposition:ASCII 回退 + RFC 5987 filename*(中文/空格等)。 */
function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[\r\n]/g, '')
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export function createFilesHandlers(): FilesHandlers {
  async function raw(req: Request, res: Response): Promise<void> {
    const q = req.query['path']
    if (typeof q !== 'string' || q.length === 0) throw new InvokeError('INVALID_ARGUMENT', '缺少 path 参数')
    if (q.includes('\0')) throw new InvokeError('INVALID_ARGUMENT', 'path 含非法字符')
    if (q.length > 4096) throw new InvokeError('INVALID_ARGUMENT', 'path 过长')

    // 真实路径:跟随符号链接后判定,闭合「链接在根内、目标在根外」穿越
    let real: string
    try {
      real = realpathSync(q)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new InvokeError('NOT_FOUND', '文件不存在')
      if (code === 'EACCES' || code === 'EPERM') throw new InvokeError('FORBIDDEN', '无权访问该路径')
      throw new InvokeError('INVALID_ARGUMENT', '路径无法解析')
    }
    if (!isInsideRoot(real)) {
      if (listRoots().length === 0) {
        // 受信根登记入口:fs:trust-root(服务器目录选择,workspace.ts)/ 对话挂载(chat:load-sessions
        // 与 mount-response)/ 启动恢复(restoreTrustedRoots,index 接线调用);不自动信任配置字符串
        throw new InvokeError('FORBIDDEN', '尚未登记受信根目录(请先在设置中选择服务器目录)')
      }
      throw new InvokeError('FORBIDDEN', '路径不在受信根内')
    }

    // 类型检查:仅普通文件;拒绝目录/设备/管道/socket
    let st: Stats
    try {
      st = statSync(real)
    } catch {
      throw new InvokeError('NOT_FOUND', '文件不存在')
    }
    if (!st.isFile()) throw new InvokeError('FORBIDDEN', '目标不是普通文件')

    serveFileFromDisk(req, res, real, st.size)
  }

  function serveFileFromDisk(req: Request, res: Response, real: string, size: number): void {
    const name = path.basename(real)
    const type = mimeContentType(name) || 'application/octet-stream'
    const isHtml = type.startsWith('text/html')
    const isSvg = type === 'image/svg+xml'
    // 图片/PDF 内联;HTML/SVG 静态预览(CSP sandbox);其余允许类型按附件下载,不执行文件
    const inline = isHtml || isSvg || type.startsWith('image/') || type === 'application/pdf'

    const headers: Record<string, string> = {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name)
    }
    if (isHtml || isSvg) {
      headers['Content-Security-Policy'] =
        "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
        "form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
    }

    const range = parseSingleRange(req.headers['range'], size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    let status = 200
    let start = 0
    let end = size - 1
    if (range) {
      status = 206
      start = range.start
      end = range.end
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)

    res.writeHead(status, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    // 空文件不带区间参数(0 > -1 会触发 createReadStream 的范围校验错误)
    const stream =
      size === 0
        ? createReadStream(real)
        : createReadStream(real, { start, end, autoClose: true })
    stream.on('error', (err) => {
      warn('files', `读取失败(${name}): ${errMessage(err)}`)
      if (res.headersSent) res.destroy()
      else if (!res.writableEnded) res.destroy()
    })
    // 断连即停读;正常 end 后 destroy 为无害操作
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  async function deliverable(req: Request, res: Response): Promise<void> {
    const sessionId = req.query['sessionId']
    const toolUseId = req.query['toolUseId']
    const indexRaw = req.query['index']
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) throw new InvokeError('INVALID_ARGUMENT', 'sessionId 不合法')
    if (typeof toolUseId !== 'string' || !ID_RE.test(toolUseId)) throw new InvokeError('INVALID_ARGUMENT', 'toolUseId 不合法')
    const index = typeof indexRaw === 'string' ? Number(indexRaw) : Number.NaN
    if (!Number.isInteger(index) || index < 0 || index > 1_000_000) throw new InvokeError('INVALID_ARGUMENT', 'index 不合法')

    // 授权链（§5.4 预览与下载）:路径由服务端交付记录决定（sessionId/toolUseId/index 必须命中记录,
    // 客户端不能覆盖路径）。交付物可位于工作区外 —— **不做受信根判定**,记录即授权。旧记录
    // （delivered 边车无 canonicalPath 字段,只有 deliveredPath）用其 realpath 定位;真实目标在
    // 下载时重校验（realpath + 普通文件）,inspect 结果不能替代。记录不可定位 / 文件缺失一律
    // 明确 404 JSON（错误中间件,不回 SPA）。记录路径不进响应头（不向客户端泄露服务器路径）。
    const recorded = deliveredRecordPath(sessionId, toolUseId, index)
    if (!recorded) throw new InvokeError('NOT_FOUND', '交付记录不存在')

    let real: string
    try {
      real = realpathSync(recorded)
    } catch {
      throw new InvokeError('NOT_FOUND', '交付文件不存在')
    }
    let st: Stats
    try {
      st = statSync(real)
    } catch {
      throw new InvokeError('NOT_FOUND', '交付文件不存在')
    }
    if (!st.isFile()) throw new InvokeError('NOT_FOUND', '交付文件不可用')

    serveFileFromDisk(req, res, real, st.size)
  }

  return { raw, deliverable }
}
