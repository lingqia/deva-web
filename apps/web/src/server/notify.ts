/**
 * 结构化通知(web-migration-plan.md §6.1):
 * platform.emitNotice → WS 层广播 {v,type:'event',stream:'notify',c:'notify',a:[notice]}。
 * notice 携带稳定 noticeId(内容摘要),短窗口内去重,避免多端/多事件源重复弹通知。
 */
import { createHash } from 'node:crypto'
import type { AppNotice } from '../main/platform'

export interface WebNotice {
  noticeId: string
  title: string
  body: string
  sessionId?: string
  kind: 'reply' | 'task' | 'generic'
}

/** 由 AppNotice 构造带 noticeId 的通知(内容不变则 id 稳定,便于客户端去重)。 */
export function makeNotice(n: AppNotice): WebNotice {
  const kind = n.kind ?? 'generic'
  const base = `${kind}|${n.sessionId ?? ''}|${n.title}|${n.body}`
  const noticeId = createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 32)
  const out: WebNotice = { noticeId, title: n.title, body: n.body, kind }
  if (n.sessionId) out.sessionId = n.sessionId
  return out
}

const DEDUPE_MS = 2_000
const MAX_ENTRIES = 200
const recent = new Map<string, number>()

/** 同一 noticeId 在去重窗口内只投递一次;窗口外同内容允许再次提醒。 */
export function shouldDeliver(notice: WebNotice): boolean {
  const now = Date.now()
  if (recent.size > MAX_ENTRIES) {
    for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k)
  }
  const last = recent.get(notice.noticeId)
  if (last !== undefined && now - last < DEDUPE_MS) return false
  recent.set(notice.noticeId, now)
  if (recent.size > MAX_ENTRIES * 2) {
    // 兜底:仍超限则按插入序丢最旧
    let drop = recent.size - MAX_ENTRIES
    for (const k of recent.keys()) {
      if (drop-- <= 0) break
      recent.delete(k)
    }
  }
  return true
}
