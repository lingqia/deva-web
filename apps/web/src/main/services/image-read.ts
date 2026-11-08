import sharp from 'sharp'
import type { ImagePart } from '../providers/types'

/**
 * 工具结果里的图片整形（服务端）。read_file 读到的图片文件、MCP 工具返回的图片块都走这里，
 * 产出可直接随 tool_result 发给模型的 ImagePart——模型凭视觉能力直接「看」图，而非读文字描述。
 *
 * 两条约束决定了这里的做法：
 *  - **media_type 必须与实际字节一致**：服务商会校验，不一致直接 400；扩展名不可信，故按魔数识别。
 *  - **体积 / 尺寸有上限**：Anthropic 单图 base64 上限 5MB（原始字节约 3.75MB）；长边超过 1568px
 *    服务端也会先缩小再看，发大图只是白占上下文与落盘体积。故超限就地缩放 / 转码再发。
 *
 * Web 迁移说明（原桌面版用 Electron nativeImage，只可靠解码 PNG / JPEG）：改用 sharp 异步解码，
 * PNG / JPEG / GIF / WebP 静态图均可解可缩。**动图**（多帧：GIF / WebP / APNG）转码会把动画压成
 * 首帧，为不静默破坏内容，沿用桌面版「解不开的格式」的错误语义——不超限原样发，超限如实报错。
 * 已异步化：prepareImage 等返回 Promise，导出名不变；mcp.ts 的调用点（mcpImage → flattenResult）
 * 由负责 mcp 的 agent 补 await。解码 / 缩放走信号量限流（上限 4），避免一批图片同时解码造成内存尖峰。
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** 长边上限：与服务端内部缩放阈值对齐，约 1600 token/张（compaction 的 IMAGE_TOKENS 同此估算）。 */
const MAX_EDGE = 1568
/** 发送体积上限（原始字节）：base64 膨胀 4/3 后恰在 Anthropic 的 5MB 之内。 */
const MAX_SEND_BYTES = Math.floor(3.75 * 1024 * 1024)
/** 可接受的源文件上限：再大的图缩放也能压下来，但读盘解码本身已不划算。 */
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024
/** 超限回退 JPEG 时的质量阶梯。 */
const JPEG_QUALITIES = [85, 70, 50]

/** 解码 / 缩放并发上限：同时最多 4 张图在整形，其余排队。 */
const DECODE_CONCURRENCY = 4

/** 简单信号量：名额转让制（释放时直接交给队首等待者），避免唤醒竞态导致超发。 */
class Semaphore {
  private free: number
  private readonly waiters: (() => void)[] = []

  constructor(limit: number) {
    this.free = limit
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => this.waiters.push(resolve))
    try {
      return await fn()
    } finally {
      const next = this.waiters.shift()
      if (next) next() // 名额直接转交，不经过 free 的增减
      else this.free++
    }
  }
}

const decodeGate = new Semaphore(DECODE_CONCURRENCY)

/** 按魔数识别图片格式；不是这四种之一返回 null。 */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
    return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export type PreparedImage =
  | {
      ok: true
      part: ImagePart
      /** 原图尺寸（解码不了时缺省）。 */
      width?: number
      height?: number
      /** 实际发送的尺寸 / 体积（缩放或转码过才与原图不同）。 */
      sentWidth?: number
      sentHeight?: number
      sentBytes: number
      resized: boolean
    }
  | { ok: false; reason: string }

/**
 * 把一张图整形成可发送的 ImagePart。`mime` 应来自 sniffImageMime（而非扩展名）。
 * 不超限则原样发送（字节不动）；超限则缩放到长边 MAX_EDGE，PNG 优先保持 PNG（保透明与文字锐度），
 * 仍超限再逐级降质回退 JPEG。永不抛错；解码 / 缩放失败时按「无法本地压缩」的语义原样发或报错。
 */
export async function prepareImage(buf: Buffer, mime: ImageMime, name?: string): Promise<PreparedImage> {
  return decodeGate.run(async () => {
    const make = (data: Buffer, mediaType: string): ImagePart => ({
      type: 'image',
      mediaType,
      data: data.toString('base64'),
      ...(name ? { name } : {})
    })

    /** 不动字节直接发（解码不了 / 不需处理时）：超发送上限则报桌面版同款「无法本地压缩」错误。 */
    const asIsOrTooLarge = (width?: number, height?: number): PreparedImage => {
      if (buf.length > MAX_SEND_BYTES)
        return {
          ok: false,
          reason: `图片过大（${formatBytes(buf.length)}），且该格式无法在本地压缩；上限 ${formatBytes(MAX_SEND_BYTES)}`
        }
      const dims = width && height ? { width, height, sentWidth: width, sentHeight: height } : {}
      return { ok: true, part: make(buf, mime), ...dims, sentBytes: buf.length, resized: false }
    }

    let meta: sharp.Metadata | null = null
    try {
      meta = await sharp(buf).metadata()
    } catch {
      /* 解码失败按未解出处理 */
    }
    if (!meta?.width || !meta?.height) return asIsOrTooLarge()

    const width = meta.width
    const height = meta.height
    // 动图不转码（转码会把动画压成首帧）：不超限原样发，超限如实报错。
    if ((meta.pages ?? 1) > 1) return asIsOrTooLarge(width, height)

    const longEdge = Math.max(width, height)
    if (longEdge <= MAX_EDGE && buf.length <= MAX_SEND_BYTES)
      return { ok: true, part: make(buf, mime), width, height, sentWidth: width, sentHeight: height, sentBytes: buf.length, resized: false }

    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1
    // sharp 的流水线实例只能消费一次，逐级试编码前先 clone；宽高按比例算好再缩，与桌面版一次到位一致。
    const out = scale < 1 ? sharp(buf).resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { fit: 'fill' }) : sharp(buf)
    const done = (data: Buffer, mediaType: string): PreparedImage => ({
      ok: true,
      part: make(data, mediaType),
      width,
      height,
      sentWidth: Math.max(1, Math.round(width * scale)),
      sentHeight: Math.max(1, Math.round(height * scale)),
      sentBytes: data.length,
      resized: true
    })

    try {
      // 源为 JPEG（照片居多）直接出 JPEG；其余先试 PNG。
      if (mime !== 'image/jpeg') {
        const png = await out.clone().png().toBuffer()
        if (png.length <= MAX_SEND_BYTES) return done(png, 'image/png')
      }
      for (const q of JPEG_QUALITIES) {
        const jpg = await out.clone().jpeg({ quality: q }).toBuffer()
        if (jpg.length <= MAX_SEND_BYTES) return done(jpg, 'image/jpeg')
      }
    } catch {
      // 编码阶段失败（截断文件等）：字节不超限就原样发，交给服务端兜底；否则如实报错。
      return asIsOrTooLarge(width, height)
    }
    return { ok: false, reason: `图片压缩后仍超过 ${formatBytes(MAX_SEND_BYTES)}，无法发送` }
  })
}
