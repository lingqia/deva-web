import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { ThemeProvider } from './theme/ThemeContext'
import { I18nProvider, useI18n } from './i18n/i18n'
import { AuthProvider, useAuth, type AuthError } from './auth/AuthProvider'
import { LoginScreen } from './auth/LoginScreen'

/**
 * 应用引导(plan §8.1 启动顺序,由 main.tsx 在安装 window.deva 之后动态 import):
 *
 *   window.deva 安装(main.tsx,同步)
 *   → GET /api/auth/me(AuthProvider 探针)
 *     → 401:LoginScreen(登录前 __DEVA_BOOTSTRAP__.config = {},主题/语言只用本地偏好,不发私有请求)
 *     → 200:startSession()(预取 config 回填启动缓存 + 建 WS)→ 动态 import 业务 Provider/App
 *     → 网络/5xx:可重试的连接错误页
 *
 * 业务 Provider(Models/Extensions/Workspace/Chat/Tasks/Profile)与 App 只在 authenticated 后求值:
 * 它们经下方 lazy 工厂动态 import,unauthenticated/loading/error 态不加载(过期即卸载)。
 * ThemeProvider/I18nProvider 为无窗口依赖的 UI 基础设施,静态挂载(登录页也用);
 * Dialog/Toast 弹层仅业务树消费,挂业务子树顶层。
 */

// 业务树:认证成功后才 import(含 ChatFirstShell 等全部业务模块)
const AuthenticatedTree = lazy(async () => {
  const [
    { ModelsProvider },
    { ExtensionsProvider },
    { WorkspaceProvider },
    { ChatProvider },
    { TasksProvider },
    { ProfileProvider },
    { App }
  ] = await Promise.all([
    import('./store/models'),
    import('./store/extensions'),
    import('./store/workspace'),
    import('./store/chat'),
    import('./store/tasks'),
    import('./store/profile'),
    import('./App')
  ])
  return {
    default: function AuthenticatedTree(): React.JSX.Element {
      return (
        <ModelsProvider>
          <ExtensionsProvider>
            <WorkspaceProvider>
              <ChatProvider>
                <TasksProvider>
                  <ProfileProvider>
                    <DialogLayer>
                      <App />
                    </DialogLayer>
                  </ProfileProvider>
                </TasksProvider>
              </ChatProvider>
            </WorkspaceProvider>
          </ExtensionsProvider>
        </ModelsProvider>
      )
    }
  }
})

// Dialog/Toast 弹层挂业务子树顶层:App 内所有 useDialog/useToast 消费点都在其下
const DialogLayer = lazy(async () => {
  const [{ DialogProvider }, { ToastProvider }] = await Promise.all([
    import('./components/DialogProvider'),
    import('./components/ToastProvider')
  ])
  return {
    default: function DialogLayer({ children }: { children: React.ReactNode }): React.JSX.Element {
      return (
        <DialogProvider>
          <ToastProvider>{children}</ToastProvider>
        </DialogProvider>
      )
    }
  }
})

/** 启动占位(loading / lazy 分包加载中)。 */
function BootSplash(): React.JSX.Element {
  return (
    <div className="boot-splash" role="status" aria-busy="true">
      <span className="boot-splash__dot" />
    </div>
  )
}

/** 网络/5xx 连接错误页:可重试(不误判为密码错误,401 已由探针分流到登录页)。 */
function ConnErrorPage({ error }: { error: AuthError | null }): React.JSX.Element {
  const { t } = useI18n()
  const { retry } = useAuth()
  return (
    <div className="login-screen">
      <div className="login-card" role="alert">
        <div className="login-brand">
          <span className="login-brand__name">{t('auth.connTitle')}</span>
        </div>
        <p className="login-card__hint">{error?.kind === 'server' ? error.message : t('auth.connHint')}</p>
        <button className="login-submit" type="button" onClick={retry}>
          {t('auth.retry')}
        </button>
      </div>
    </div>
  )
}

function AuthGate(): React.JSX.Element {
  const { state, error } = useAuth()
  if (state === 'loading') return <BootSplash />
  if (state === 'error') return <ConnErrorPage error={error} />
  if (state === 'unauthenticated') return <LoginScreen />
  return (
    <Suspense fallback={<BootSplash />}>
      <AuthenticatedTree />
    </Suspense>
  )
}

function Root(): React.JSX.Element {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode 下探针/订阅 effect 双跑均为幂等操作(GET 探针、桥内 wanted/幂等守卫),保留开发期检查
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
