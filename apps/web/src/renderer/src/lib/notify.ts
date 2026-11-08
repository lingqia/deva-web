import { useEffect, useRef } from 'react'
import type { DevaNotifyEvent } from '@shared/api'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'

/*
 * notify 桥（P6，web-migration-plan.md §6.1 / §8.2）：把 WS 的 notify 推送落成用户可见的通知。
 *
 * 规则（§8.2）：
 * - 以 noticeId 去重：重连重放 / 服务端重发只处理一次；
 * - 页面可见（document.visibilityState === 'visible'）且通知的 sessionId 是当前会话
 *   → 只用应用内 toast（带「查看」跳转），不发系统通知；
 * - 其余情形：仅在用户已授权 Notification 时弹系统通知，点击 → 聚焦页面并导航到对应会话；
 *   权限被拒 / 尚未授权 → toast 退路（不伪装成系统通知已发出）；
 * - 跨标签页协调：localStorage 认领（先到先得）+ BroadcastChannel 通告，同一通知只在
 *   一个标签页弹系统通知；应用内 toast 不参与协调（每个可见页面都可以给自己一条）。
 *
 * 通知权限必须由用户手势触发（浏览器不给无手势的 requestPermission）：设置 → 通用 →
 * 「浏览器通知」行调用 enableNotifications()。服务端 chat-bus 的 AppNotice 对 IM 的
 * 出口在服务端，与本桥无关、不受影响。
 */

/** 本标签页标识：认领记录里用于排查（非安全标识）。 */
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}`

const CLAIM_PREFIX = 'deva.notify.claim.'
/** 认领记录保留时长：过了这窗口同一通知再重放就当新通知（正常推送不会）。 */
const CLAIM_TTL_MS = 5 * 60 * 1000

let channel: BroadcastChannel | null = null
/** 其它标签页已认领的通知（经 BroadcastChannel/storage 事件得知）。 */
const foreignClaims = new Set<string>()
/** 去重集合上限（防长会话下无界增长；正常量级远到不了）。 */
const CLAIMS_MAX = 500

function initChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return
  try {
    channel = new BroadcastChannel('deva-notify')
    channel.onmessage = (ev) => {
      const d = ev.data as { type?: string; noticeId?: string } | null
      if (d?.type === 'claimed' && typeof d.noticeId === 'string') {
        if (foreignClaims.size > CLAIMS_MAX) foreignClaims.clear()
        foreignClaims.add(d.noticeId)
      }
    }
  } catch {
    channel = null
  }
}

/** 清理过期认领 + 尝试认领某通知：true = 本标签页负责弹系统通知。 */
function claimNotice(noticeId: string): boolean {
  try {
    const now = Date.now()
    // 顺手清掉过期认领，localStorage 不留垃圾。
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(CLAIM_PREFIX)) {
        const at = Number(localStorage.getItem(k))
        if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS) stale.push(k)
      }
    }
    for (const k of stale) localStorage.removeItem(k)
    if (localStorage.getItem(CLAIM_PREFIX + noticeId) !== null) return false
    localStorage.setItem(CLAIM_PREFIX + noticeId, String(now))
    channel?.postMessage({ type: 'claimed', noticeId, tabId: TAB_ID })
    return true
  } catch {
    // localStorage 不可用（隐私模式等）：放弃跨页协调，宁可在每个标签页各弹一次。
    return true
  }
}

/** storage 事件兜底（BroadcastChannel 不可用时仍能感知其它标签页的认领）。 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith(CLAIM_PREFIX) && e.newValue) foreignClaims.add(e.key.slice(CLAIM_PREFIX.length))
  })
}

// ── 权限（供设置页的用户手势入口调用） ──────────────────────────────────────────

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notifyPermission(): 'granted' | 'denied' | 'default' | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

/** 须由用户点击调用；返回最终权限态（浏览器可能不弹询问而直接回当前态）。 */
export async function enableNotifications(): Promise<'granted' | 'denied' | 'default' | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

// ── React 桥（在 ChatFirstShell 挂一次） ────────────────────────────────────────

/** 去重集合上限：超过即整表清空（窗口重置，正常量级远到不了）。 */
const SEEN_MAX = 500

/**
 * 订阅 notify 推送并按上述规则分发。openSession 稳定性无需保证：内部经 ref 取最新值，
 * 订阅只建立一次（WS 断线重连由桥的传输层负责，事件流不断）。
 */
export function useNotifyBridge(opts: {
  currentSessionId: string | null
  openSession: (sessionId: string) => void
}): void {
  const toast = useToast()
  const { t } = useI18n()
  const optsRef = useRef(opts)
  optsRef.current = opts
  const seenRef = useRef<Set<string>>(new Set())
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    initChannel()
    const showInApp = (notice: DevaNotifyEvent): void => {
      const sid = notice.sessionId
      toastRef.current.show({
        title: notice.title,
        message: notice.body,
        variant: 'default',
        action: sid
          ? { label: tRef.current('notify.view'), onClick: () => optsRef.current.openSession(sid) }
          : undefined
      })
    }
    const handle = (notice: DevaNotifyEvent): void => {
      const seen = seenRef.current
      if (seen.has(notice.noticeId)) return
      if (seen.size > SEEN_MAX) seen.clear()
      seen.add(notice.noticeId)

      const { currentSessionId } = optsRef.current
      const isCurrent = notice.sessionId != null && notice.sessionId === currentSessionId
      // 页面可见且就是当前会话：应用内提示足够，不再发系统通知（§8.2）。
      if (document.visibilityState === 'visible' && isCurrent) {
        showInApp(notice)
        return
      }
      if (notificationsSupported() && Notification.permission === 'granted' && !foreignClaims.has(notice.noticeId) && claimNotice(notice.noticeId)) {
        try {
          const n = new Notification(notice.title, { body: notice.body, tag: `deva:${notice.noticeId}` })
          n.onclick = (): void => {
            window.focus()
            const sid = notice.sessionId
            if (sid) optsRef.current.openSession(sid)
            n.close()
          }
          return
        } catch {
          /* 系统通知构造失败（个别平台限制）：落回应用内提示 */
        }
      }
      showInApp(notice)
    }
    return window.deva?.onNotify?.(handle) ?? (() => {})
  }, [])
}
