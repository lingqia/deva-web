import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { getDevaBridge } from '../../../web/deva'

/**
 * 认证状态机(web-migration-plan.md §8.1):loading / unauthenticated / authenticated / error 四态。
 * - 挂载即探针 GET /api/auth/me(no-store):401 → 登录页;200 → 预取 config 回填启动缓存 + 建 WS,
 *   然后 AuthProvider 才放行业务树(业务 Provider/App 由 boot.tsx 在 authenticated 后动态 import);
 *   网络/5xx → 可重试的连接错误态(error)。
 * - HTTP 401(invoke 响应)与 WS 4401 统一经桥的 onAuthExpired 进入 expireSession():
 *   停 WS 重连、废弃后续请求(桥内置过期位)、卸载业务树(切回 unauthenticated)并整页 reload。
 *   TODO(P6): 不经 reload 的就地卸载 + 清敏感内存(chat 气泡/密钥布尔态等)。
 * - 退出走 window.deva.authLogout()(POST /api/logout,成功由桥整页 reload);
 *   服务端不可达返回 false,调用方必须提示「撤销未确认」。
 */

export type AuthState = 'loading' | 'unauthenticated' | 'authenticated' | 'error'

/** 连接错误分类:error 态可重试;403/断网不会误判成密码错误(密码错误只在登录结果里)。 */
export interface AuthError {
  kind: 'network' | 'server'
  message: string
}

export type LoginResult =
  | { ok: true }
  | { ok: false; kind: 'invalid' | 'rate_limited' | 'network' | 'server'; retryAfterSec?: number }

interface AuthContextValue {
  state: AuthState
  error: AuthError | null
  /** 登录(结果返回给 UI 分类展示;成功由内部整页 reload)。 */
  login(token: string): Promise<LoginResult>
  /** 退出;false = 撤销未确认(服务端不可达),UI 须提示。 */
  logout(): Promise<boolean>
  /** error 态重试(重新探针)。 */
  retry(): void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>('loading')
  const [error, setError] = useState<AuthError | null>(null)
  const stateRef = useRef<AuthState>('loading')
  const mountedRef = useRef(true)

  const setAuthState = useCallback((next: AuthState) => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
  }, [])

  const probe = useCallback(async (): Promise<void> => {
    setAuthState('loading')
    setError(null)
    let res: Response
    try {
      res = await fetch('/api/auth/me')
    } catch {
      setAuthState('error')
      setError({ kind: 'network', message: '无法连接服务器' })
      return
    }
    if (res.status === 401) {
      // 未登录/会话过期:登录页(登录前不发私有请求)
      setAuthState('unauthenticated')
      return
    }
    if (!res.ok) {
      setAuthState('error')
      setError({ kind: 'server', message: `服务器不可用(HTTP ${res.status})` })
      return
    }
    // 已认证:预取 config 回填 __DEVA_BOOTSTRAP__ 缓存并建 WS,再放行业务树
    try {
      await getDevaBridge().startSession()
    } catch {
      /* startSession 内部已兜底(预取失败不阻塞) */
    }
    setAuthState('authenticated')
  }, [setAuthState])

  useEffect(() => {
    mountedRef.current = true
    void probe()
    return () => {
      mountedRef.current = false
    }
  }, [probe])

  // 全局过期(HTTP 401 / WS 4401):统一停重连、卸载业务、回登录页
  useEffect(() => {
    const off = getDevaBridge().onAuthExpired(() => {
      if (stateRef.current !== 'authenticated') return
      // 状态切换即卸载业务树;整页 reload 兜底清请求与内存(简单实现,plan §8.1 允许)
      // TODO(P6): 就地卸载 + 清敏感内存,避免整页刷新
      setAuthState('unauthenticated')
      window.setTimeout(() => location.reload(), 50)
    })
    return off
  }, [setAuthState])

  const login = useCallback(async (token: string): Promise<LoginResult> => {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Deva-Client': '1' },
        body: JSON.stringify({ token })
      })
      if (res.ok) {
        // 登录成功整页 reload:配置 getSync 走重新预取的启动缓存(plan §8.1)
        location.reload()
        return { ok: true }
      }
      if (res.status === 401) return { ok: false, kind: 'invalid' }
      if (res.status === 429) {
        const ra = Number(res.headers.get('Retry-After') ?? '0')
        return { ok: false, kind: 'rate_limited', retryAfterSec: Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 0 }
      }
      return { ok: false, kind: 'server' }
    } catch {
      return { ok: false, kind: 'network' }
    }
  }, [])

  const logout = useCallback(async (): Promise<boolean> => {
    const res = await getDevaBridge().api.authLogout()
    // ok 时桥已整页 reload;false = 撤销未确认
    return res.ok === true
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ state, error, login, logout, retry: () => void probe() }),
    [state, error, login, logout, probe]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
