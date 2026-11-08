/*
 * 外链安全出口（P6，web-migration-plan.md §8.2）：
 * 所有 window.open / <a target="_blank"> 的目标地址统一经此校验——
 * 仅放行 http:/https: 绝对地址，挡掉 javascript: / data: / vbscript: 等可执行协议
 * （docUrl 等值可被用户/配置注入，不能直接进 href）；新开标签一律
 * rel="noopener noreferrer"（隔离 window.opener，防反向标签劫持）。
 */

/** <a target="_blank"> 统一的 rel 值。 */
export const EXTERNAL_LINK_REL = 'noopener noreferrer'

/** 解析并校验外链：合法返回 URL 对象；非 http(s)（含相对地址、空值、解析失败）返回 null。 */
export function parseSafeExternalUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/** 合法外链返回规范化后的 URL 字符串；非 http(s)（含相对地址、空值、解析失败）返回 null。 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  return parseSafeExternalUrl(raw)?.toString() ?? null
}
