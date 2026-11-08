/**
 * 剪贴板纯文本读写(替代已删除的 clipboard:* IPC 通道,web-migration-plan.md §8.2)。
 *
 * 走 navigator.clipboard;非安全上下文(HTTP 且非 localhost)或权限被拒时 catch,
 * 给出可理解的提示文案并返回 null / false——不返回空字符串伪装成功。
 * 双语文案内置(调用点多在事件回调里,不便再穿 i18n 上下文)。
 */

/** 通用失败提示(权限拒绝 / 非安全上下文 / 旧浏览器)。 */
const WRITE_FAIL_MSG =
  typeof navigator !== 'undefined' &&
  typeof window !== 'undefined' &&
  window.isSecureContext
    ? '无法写入剪贴板(权限被拒绝)。Clipboard write was denied.'
    : '无法写入剪贴板(需 HTTPS 或 localhost)。Clipboard needs HTTPS or localhost.'
const READ_FAIL_MSG =
  typeof navigator !== 'undefined' &&
  typeof window !== 'undefined' &&
  window.isSecureContext
    ? '无法读取剪贴板(权限被拒绝)。Clipboard read was denied.'
    : '无法读取剪贴板(需 HTTPS 或 localhost)。Clipboard needs HTTPS or localhost.'

/** 可选的提示出口(如 ToastProvider 的 toast.show);不传则静默失败。 */
type Report = (message: string) => void

/** 写入纯文本。成功返回 true;失败提示并返回 false。 */
export async function writeText(text: string, report?: Report): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    report?.(WRITE_FAIL_MSG)
    return false
  }
}

/** 读取纯文本。成功返回内容;失败提示并返回 null。 */
export async function readText(report?: Report): Promise<string | null> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    report?.(READ_FAIL_MSG)
    return null
  }
}
