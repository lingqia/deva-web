import { emitNotice, type PlatformWindow } from '../platform'
import { getConfig } from './config'

/**
 * 回复提醒：一轮对话结束、或中途停下来等用户处理时，弹一条通知告知用户（点击打开该对话）。
 *
 * Web 迁移说明：原桌面版在窗口失焦时才弹系统 Notification（点击 → 聚焦窗口 + 推 tasks:navigate）；
 * Web 端一律发结构化通知（emitNotice，kind='reply'，带 sessionId），由 WS 层广播给在线页面，
 * 浏览器自行处理可见性判断 / 去重 / 点击导航 —— 服务端不再读窗口焦点（PlatformWindow 也没有该
 * 能力），「用户是否在看」的判断整体下沉到浏览器端。getWindow 参数保留（chat.ts 接线兼容），
 * 不再参与任何判断。
 */

/** 正文压成一行预览：略去代码块与行首 Markdown 标记，限长。 */
function preview(text: string, max = 120): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function isEn(): boolean {
  return getConfig().locale === 'en'
}

/** 发结构化通知（不可用则静默降级）。 */
function show(
  getWindow: () => PlatformWindow | null,
  sessionId: string,
  title: string,
  body: string
): void {
  // 原桌面版此处先判窗口焦点（isFocused）再决定是否打扰；Web 端直接发通知，可见性 / 去重由浏览器处理。
  void getWindow
  try {
    emitNotice({ title: title || 'Deva', body, sessionId, kind: 'reply' })
  } catch {
    /* 通知出口抛错 → 静默降级 */
  }
}

/**
 * 一轮结束。
 * @param opts.error 有值（可为空串）即按失败提醒；否则正文取回复预览，回复无正文（只调了工具）时给通用文案。
 */
export function notifyReplyDone(
  getWindow: () => PlatformWindow | null,
  opts: { sessionId: string; title: string; text: string; error?: string }
): void {
  const en = isEn()
  let body: string
  if (opts.error !== undefined) {
    const reason = preview(opts.error, 80)
    body = en
      ? `Reply interrupted by an error${reason ? `: ${reason}` : ''}`
      : `回复因错误中断${reason ? `：${reason}` : ''}`
  } else {
    body = preview(opts.text) || (en ? 'Reply completed' : '回复已完成')
  }
  show(getWindow, opts.sessionId, opts.title, body)
}

/** 回合停下来等用户：问答（带首个问题）/ 计划审阅 / 挂载工作区。 */
export type PendingInput =
  | { kind: 'ask'; questions: string[] }
  | { kind: 'plan' }
  | { kind: 'mount' }

export function notifyNeedsInput(
  getWindow: () => PlatformWindow | null,
  opts: { sessionId: string; title: string; input: PendingInput }
): void {
  const en = isEn()
  const { input } = opts
  let body: string
  if (input.kind === 'ask') {
    const first = preview(input.questions[0] ?? '', 80)
    const more = input.questions.length - 1
    const suffix = more > 0 ? (en ? ` (+${more} more)` : `（另有 ${more} 个问题）`) : ''
    body = first
      ? `${en ? 'Needs your answer: ' : '需要你回答：'}${first}${suffix}`
      : en
        ? 'Needs your answer'
        : '需要你回答问题'
  } else if (input.kind === 'plan') {
    body = en ? 'A plan is ready for your review' : '计划已拟好，等待你审阅'
  } else {
    body = en
      ? 'A workspace folder must be mounted to continue'
      : '需要挂载工作区文件夹才能继续'
  }
  show(getWindow, opts.sessionId, opts.title, body)
}
