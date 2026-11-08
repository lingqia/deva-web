import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ChevronRight, File as FileIcon, Folder, Loader2 } from 'lucide-react'
import type { DirBrowseResult, OpenFolderResult } from '@shared/api'
import { DevaInvokeError } from '../../../web/deva'
import { Modal } from './Modal'
import { useI18n } from '../i18n/i18n'

/*
 * WebFolderPicker（P6，web-migration-plan.md §8.2）：服务器目录选择对话框。
 *
 * 桌面版的「系统目录对话框」（fs:open-folder）在浏览器没有对应物：工作区/挂载的目标是
 * **服务器**上的目录，由 fs:browse（分页浏览，服务端算 parent）+ fs:trust-root（登记受信根）
 * 两步组成，标题明确为「选择服务器目录」。
 *
 * 用法（命令式，与 DialogProvider 的 useDialog 同风格，但不走 Provider——
 * 调用点多在 store / 事件回调里，且本组件经 App 挂载一次即可全局使用）：
 *   const r = await pickServerFolder()   // 选定 → {path,name}；取消 → null（原 cancelled 语义）
 *
 * 交互：路径输入框（Enter 跳转）+ 目录条目列表（点击进入子目录）+ 上一级 +
 * 分页（nextCursor → 加载更多）+「选择当前目录」；Esc / 取消按钮 / 点遮罩 = 取消。
 * 键盘：列表内 ↑↓ 移动选中、Enter 进入选中目录；Tab 焦点困在对话框内。
 * 错误分类：不存在 / 无权限 / 网络 / 其它，内联横幅展示，不打断已浏览结果。
 */

// ── 命令式请求通道（模块级：挂一个 Host 即可服务全应用） ──────────────────────────

type PickerRequest = { resolve: (r: OpenFolderResult | null) => void }

let current: PickerRequest | null = null
const subscribers = new Set<(req: PickerRequest | null) => void>()

function emit(): void {
  for (const sub of [...subscribers]) sub(current)
}

/**
 * 打开「选择服务器目录」对话框。resolve 选定目录（{path,name}）；用户取消 / 关闭 → null。
 * 已有一个未决请求时，先按取消结算旧请求（用户驱动的 UI 不会叠加到两个）。
 */
export function pickServerFolder(): Promise<OpenFolderResult | null> {
  if (current) {
    const prev = current
    current = null
    prev.resolve(null)
  }
  return new Promise((resolve) => {
    current = { resolve }
    emit()
  })
}

/** 关闭当前请求并回传结果（Host 内部用）。 */
function settle(r: OpenFolderResult | null): void {
  const req = current
  current = null
  emit()
  req?.resolve(r)
}

/** 常驻宿主：挂在业务树根部（App），有请求时渲染对话框。 */
export function WebFolderPickerHost(): React.JSX.Element | null {
  const [req, setReq] = useState<PickerRequest | null>(null)
  useEffect(() => {
    subscribers.add(setReq)
    setReq(current)
    return () => {
      subscribers.delete(setReq)
    }
  }, [])
  if (!req) return null
  return <FolderPickerDialog onClose={settle} />
}

// ── 错误分类 ──────────────────────────────────────────────────────────────────

type PickerErrorKind = 'notfound' | 'denied' | 'network' | 'generic'

/** 服务端稳定错误码 → 分类文案（NOT_FOUND/FORBIDDEN 来自 P2 错误协议；NETWORK/HTTP_* 来自客户端桥）。 */
function classifyError(err: unknown): PickerErrorKind {
  if (err instanceof DevaInvokeError) {
    if (err.code === 'NOT_FOUND') return 'notfound'
    if (err.code === 'FORBIDDEN' || err.code === 'PERMISSION_DENIED') return 'denied'
    if (err.code === 'NETWORK' || err.code.startsWith('HTTP_')) return 'network'
  }
  return 'generic'
}

// ── 对话框本体 ────────────────────────────────────────────────────────────────

function FolderPickerDialog({ onClose }: { onClose: (r: OpenFolderResult | null) => void }): React.JSX.Element {
  const { t } = useI18n()
  const [pathInput, setPathInput] = useState('')
  const [browse, setBrowse] = useState<DirBrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [trusting, setTrusting] = useState(false)
  const [error, setError] = useState<{ kind: PickerErrorKind; detail?: string } | null>(null)
  /** 键盘选中项：dir 条目在 entries 里的下标（-1 = 未选中）。 */
  const [sel, setSel] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  /** 加载某目录（或某页）。失败保留上次浏览结果 + 内联错误，便于改正路径重试。 */
  const load = useCallback(async (path?: string, cursor?: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.deva.fs.browse({ path, cursor })
      setBrowse(res)
      setPathInput(res.current)
      setSel(-1)
    } catch (err) {
      setError({ kind: classifyError(err), detail: err instanceof Error ? err.message : undefined })
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开即浏览服务端默认目录（服务端算 home / 上次受信根），不留空窗。
  useEffect(() => {
    void load()
  }, [load])

  const dirs = (browse?.entries ?? []).filter((e) => e.type === 'dir')
  const files = (browse?.entries ?? []).filter((e) => e.type !== 'dir')

  const goParent = (): void => {
    if (browse?.parent && !loading) void load(browse.parent)
  }
  const enterDir = (path: string): void => {
    if (!loading) void load(path)
  }
  const submitPath = (): void => {
    const p = pathInput.trim()
    if (p && !loading) void load(p)
  }
  const loadMore = (): void => {
    if (!browse?.nextCursor || loading) return
    setLoading(true)
    setError(null)
    void window.deva.fs
      .browse({ path: browse.current, cursor: browse.nextCursor })
      .then((res) => {
        // 追加一页；服务端若另回了不同目录则按新目录整体替换（防御性，不应发生）。
        setBrowse((prev) =>
          prev && prev.current === res.current
            ? { ...res, entries: [...prev.entries, ...res.entries] }
            : res
        )
        setSel(-1)
      })
      .catch((err) => setError({ kind: classifyError(err), detail: err instanceof Error ? err.message : undefined }))
      .finally(() => setLoading(false))
  }

  /** 「选择当前目录」：fs:trust-root 校验登记，成功回传给调用方；失败内联报错，对话框不关。 */
  const confirm = (): void => {
    if (!browse || loading || trusting) return
    setTrusting(true)
    setError(null)
    void window.deva.fs
      .trustRoot(browse.current)
      .then((r) => onClose(r))
      .catch((err) => {
        setError({ kind: classifyError(err), detail: err instanceof Error ? err.message : undefined })
        setTrusting(false)
      })
  }

  // 列表键盘导航：↑↓ 在目录条目间移动选中并滚进可视区，Enter 进入选中目录。
  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (dirs.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((cur) => {
        const next = e.key === 'ArrowDown' ? Math.min(cur + 1, dirs.length - 1) : Math.max(cur - 1, 0)
        listRef.current
          ?.querySelectorAll('[data-dirrow]')
          [next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const d = dirs[sel]
      if (d) enterDir(d.path)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setSel(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setSel(dirs.length - 1)
    }
  }

  // 焦点陷阱：Tab 循环在对话框卡片内（Modal 负责 Esc 关闭）。
  const trapTab = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || !cardRef.current) return
    const focusables = cardRef.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || !cardRef.current.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const busy = loading || trusting
  const errText = error
    ? error.kind === 'notfound'
      ? t('folderPicker.errNotFound')
      : error.kind === 'denied'
        ? t('folderPicker.errDenied')
        : error.kind === 'network'
          ? t('folderPicker.errNetwork')
          : t('folderPicker.errGeneric')
    : null

  return (
    <Modal open width={560} onClose={() => onClose(null)} labelledBy="web-folder-picker-title">
      {/* 焦点陷阱挂在卡片容器上（Modal 的卡片由 Portal 渲染，这里经 ref 挂到本层再上溯） */}
      <div ref={cardRef} onKeyDown={trapTab} className="fpicker">
        <h2 id="web-folder-picker-title" className="modal__title">
          {t('folderPicker.title')}
        </h2>

        {/* 路径输入行：Enter 跳转到输入的绝对路径 */}
        <div className="fpicker__pathrow">
          <input
            className="input fpicker__path"
            value={pathInput}
            autoFocus
            spellCheck={false}
            placeholder={t('folderPicker.pathPlaceholder')}
            aria-label={t('folderPicker.pathLabel')}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submitPath()
              }
            }}
          />
          <button type="button" className="btn" disabled={busy || !pathInput.trim()} onClick={submitPath}>
            {t('folderPicker.go')}
          </button>
        </div>

        {/* 上一级 + 当前目录 */}
        <div className="fpicker__crumbs">
          <button
            type="button"
            className="fpicker__parent"
            disabled={busy || !browse?.parent}
            onClick={goParent}
            title={browse?.parent ?? undefined}
          >
            <ArrowLeft size={13} />
            {t('folderPicker.parent')}
          </button>
          {browse && <span className="fpicker__cur">{browse.current}</span>}
        </div>

        {error && (
          <div className="fpicker__error" role="alert">
            <AlertTriangle size={14} />
            <span>
              {errText}
              {error.detail && error.detail !== errText ? ` (${error.detail})` : ''}
            </span>
          </div>
        )}

        {/* 目录条目：目录可进入，文件置灰仅展示 */}
        <div
          ref={listRef}
          className="fpicker__list"
          tabIndex={0}
          role="listbox"
          aria-label={t('folderPicker.title')}
          aria-busy={loading}
          onKeyDown={onListKeyDown}
        >
          {!browse && loading && (
            <div className="fpicker__hint">
              <Loader2 size={14} className="fpicker__spin" />
              {t('folderPicker.loading')}
            </div>
          )}
          {browse && (
            <>
              {dirs.map((d, idx) => (
                <button
                  key={d.path}
                  type="button"
                  data-dirrow=""
                  role="option"
                  aria-selected={idx === sel}
                  className={`fpicker__row${idx === sel ? ' is-sel' : ''}`}
                  disabled={busy}
                  onClick={() => enterDir(d.path)}
                >
                  <Folder size={14} className="fpicker__icon" />
                  <span className="fpicker__name">{d.name}</span>
                  <ChevronRight size={13} className="fpicker__chev" />
                </button>
              ))}
              {files.map((f) => (
                <div key={f.path} className="fpicker__row is-file" aria-disabled="true">
                  <FileIcon size={14} className="fpicker__icon" />
                  <span className="fpicker__name">{f.name}</span>
                </div>
              ))}
              {dirs.length === 0 && files.length === 0 && !loading && (
                <div className="fpicker__hint">{t('folderPicker.empty')}</div>
              )}
              {browse.nextCursor && (
                <button type="button" className="fpicker__more" disabled={busy} onClick={loadMore}>
                  {loading ? t('folderPicker.loading') : t('folderPicker.loadMore')}
                </button>
              )}
            </>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" disabled={trusting} onClick={() => onClose(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!browse || busy || !!error} onClick={confirm}>
            {trusting ? t('folderPicker.trusting') : t('folderPicker.selectCurrent')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
