import { memo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Copy, Check } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { writeText } from '../../lib/clipboard'
import { EXTERNAL_LINK_REL, safeExternalUrl } from '../../lib/external-links'

/**
 * 助手消息的 Markdown 渲染（GFM + 代码高亮），对齐 DeepSeek/Codex 观感。
 *
 * 安全基线（正文＝LLM 输出，属不可信内容）：
 * - react-markdown 把 AST 直接渲染成 React 元素、**不启用 rehype-raw**，故 Markdown 里的裸
 *   `<script>`/`<img onerror>` 一律当文本转义，天然免疫注入；不使用 dangerouslySetInnerHTML。
 * - 链接 href 由 react-markdown 默认 urlTransform 净化后再经 safeExternalUrl 校验：仅放行
 *   http/https，统一 target=_blank + rel="noopener noreferrer"（浏览器新标签打开，应用内不导航）。
 * - 高亮走 rehype-highlight（纯 JS highlight.js，class 主题），无 WASM、无内联脚本，契合当前 CSP。
 *
 * 性能：本组件按 text memo 化；配合 MessageRow 的 React.memo，流式期间只有「正在生长的那条
 * 消息里正在生长的那个文本块」会重解析，历史消息/同消息内其它块都跳过。
 */

/** 行内代码 vs 围栏代码块的判定：有 language- 类名，或内容含换行（围栏块必含换行；行内代码不含）。 */
function isBlockCode(className: string, children: ReactNode): boolean {
  if (/language-[\w-]+/.test(className)) return true
  return typeof children === 'string' && children.includes('\n')
}

/** 代码块表头的「复制」按钮：复制成功后 1.5 秒内显示「已复制」。时间轴上展开的命令框同用。 */
export function CopyButton({ getText }: { getText: () => string }): React.JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  const copy = (): void => {
    const txt = getText()
    if (!txt) return
    // 走 lib 包装（navigator.clipboard）：权限被拒 / 非安全上下文时明确提示失败，
    // 不静默吞掉——代码正文本就在页面上，用户仍可手动选择复制（手动退路）。
    void writeText(txt).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } else {
        setFailed(true)
        setTimeout(() => setFailed(false), 2500)
      }
    })
  }

  return (
    <button type="button" className="md-code__copy" onClick={copy}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? t('chat.md.copied') : failed ? t('chat.md.copyFailed') : t('chat.md.copy')}
    </button>
  )
}

/** DeepSeek 式代码块：顶部「语言名 + 复制」条 + 高亮正文（横向可滚）。 */
function CodeBlock({
  lang,
  codeClassName,
  children
}: {
  lang?: string
  codeClassName: string
  children: ReactNode
}): React.JSX.Element {
  const codeRef = useRef<HTMLElement>(null)

  return (
    <div className="md-code">
      <div className="md-code__head">
        <span className="md-code__lang">{lang || 'text'}</span>
        <CopyButton getText={() => codeRef.current?.textContent ?? ''} />
      </div>
      <pre className="md-code__body">
        <code ref={codeRef} className={codeClassName}>
          {children}
        </code>
      </pre>
    </div>
  )
}

/** 组件覆写表（模块级常量，稳定引用）。 */
const components: Components = {
  // 外链统一新标签打开（rel 隔离 opener）；非 http/https（javascript:/data:/相对地址等）降级为纯文本。
  a({ href, children }) {
    const safe = safeExternalUrl(href ?? null)
    if (!safe) return <span>{children}</span>
    return (
      <a href={safe} target="_blank" rel={EXTERNAL_LINK_REL}>
        {children}
      </a>
    )
  },
  // pre 只用于围栏代码块；这里解包，让 CodeBlock 自带的 pre 不被套两层。
  pre({ children }) {
    return <>{children}</>
  },
  code({ className, children }) {
    const cls = className ?? ''
    const match = /language-([\w-]+)/.exec(cls)
    if (!isBlockCode(cls, children)) {
      return <code className="md-inline">{children}</code>
    }
    return (
      <CodeBlock lang={match?.[1]} codeClassName={cls}>
        {children}
      </CodeBlock>
    )
  }
}

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm]
const rehypePlugins: Options['rehypePlugins'] = [[rehypeHighlight, { ignoreMissing: true }]]

/** 渲染一段 Markdown。muted：思考块用弱化配色。 */
export const Markdown = memo(function Markdown({
  text,
  muted
}: {
  text: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className={muted ? 'md md--muted' : 'md'}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
