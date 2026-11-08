import { useState, type FormEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useAuth, type LoginResult } from './AuthProvider'
import { useI18n } from '../i18n/i18n'
import devaIcon from '../assets/deva-icon.svg'
import './login.css'

/**
 * 登录页(web-migration-plan.md §8.1):
 * - 复用现有主题/i18n(登录前 __DEVA_BOOTSTRAP__.config 为空对象,主题/语言走 localStorage 本地偏好
 *   与系统默认,不拉/写私有 config)。
 * - 令牌 password 输入 + 显示切换、Enter 提交(form)、loading/防重复。
 * - 结果分类:401 无效、429 显示 Retry-After 倒数、网络错误/服务端错误分别提示;
 *   403/断网不会到这里误判成密码错误(AuthProvider 探针已分流)。
 * - 样式走 tokens.css 语义变量(--bg/--fg/--accent/...),与 redesign token 体系同源。
 * 文案 key 见 i18n/messages.ts 的 auth 段(P5 新增)。
 */

export function LoginScreen(): React.JSX.Element {
  const { t } = useI18n()
  const { login } = useAuth()
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<Extract<LoginResult, { ok: false }> | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (submitting || token.length === 0) return
    setSubmitting(true)
    setFailure(null)
    const res = await login(token)
    // 成功时 AuthProvider 已整页 reload;其余恢复可编辑并展示分类错误
    setSubmitting(false)
    if (!res.ok) setFailure(res)
  }

  let failText = ''
  if (failure?.kind === 'invalid') failText = t('auth.invalid')
  else if (failure?.kind === 'rate_limited') {
    const sec = failure.retryAfterSec ?? 0
    failText =
      sec > 0 ? `${t('auth.rateLimited')} ${t('auth.retryAfter').replace('{n}', String(sec))}` : t('auth.rateLimited')
  } else if (failure?.kind === 'network') failText = t('auth.networkError')
  else if (failure?.kind === 'server') failText = t('auth.serverError')

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void submit(e)} aria-label={t('auth.title')}>
        <div className="login-brand">
          <img className="login-brand__icon" src={devaIcon} alt="" draggable={false} />
          <span className="login-brand__name">Deva</span>
        </div>
        <p className="login-card__hint">{t('auth.hint')}</p>
        <div className="login-field">
          <input
            className="login-input"
            type={show ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('auth.tokenPlaceholder')}
            autoComplete="current-password"
            autoFocus
            disabled={submitting}
            aria-label={t('auth.tokenPlaceholder')}
          />
          <button
            type="button"
            className="login-toggle"
            onClick={() => setShow((v) => !v)}
            title={show ? t('auth.hideToken') : t('auth.showToken')}
            aria-label={show ? t('auth.hideToken') : t('auth.showToken')}
            disabled={submitting}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {failText && (
          <p className="login-error" role="alert">
            {failText}
          </p>
        )}
        <button className="login-submit" type="submit" disabled={submitting || token.length === 0}>
          {submitting ? t('auth.submitting') : t('auth.submit')}
        </button>
      </form>
    </div>
  )
}
