/**
 * fs:browse / fs:trust-root 的默认路径与失败语义回归测试。
 *
 * 背景（线上 bug）：WebFolderPicker 打开时无参调用 fs:browse，服务端在非 Windows 上
 * 没有默认路径，返回 `{ok:false, reason:'缺少 path'}` 结果体；而客户端桥只看 HTTP ok 就
 * resolve，渲染层把失败当成空目录渲染，于是「挂载工作区」永远只显示「此目录为空」。
 *
 * 现在：path 缺省/空 = 服务端主目录；失败一律抛 InvokeError（稳定错误码，走 P2 错误协议），
 * 不再返回结果体 —— 渲染层自然走已有的错误横幅，而不是伪造一个空目录。
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// 服务会读写 DEVA_HOME；测到真实用户目录之前先指到临时目录。
process.env.DEVA_HOME = mkdtempSync(join(tmpdir(), 'deva-workspace-test-'))

import { registerWebWorkspaceIpc } from '../workspace'
import { getInvokeHandler, type InvokeHandler } from '../../platform'

const isWin = process.platform === 'win32'
const evt = {} as never

function handler(channel: string): InvokeHandler {
  const h = getInvokeHandler(channel)
  if (!h) throw new Error(`${channel} 未注册`)
  return h
}

beforeAll(() => {
  registerWebWorkspaceIpc()
})

describe('fs:browse 默认路径（对话框打开即无参浏览一次）', () => {
  it('无 path → 浏览服务端主目录', async () => {
    if (isWin) return // Windows 缺省是「我的电脑」盘符列表，另案处理
    const res = (await handler('fs:browse')(evt, {})) as {
      ok: boolean
      current: string | null
      entries: unknown[]
      parent: string | null
    }
    expect(res.ok).toBe(true)
    expect(res.current).toBe(realpathSync(homedir()))
    expect(Array.isArray(res.entries)).toBe(true)
    expect(res.parent).not.toBe(res.current)
  })

  it('path 为空串同样回落主目录', async () => {
    if (isWin) return
    const res = (await handler('fs:browse')(evt, { path: '' })) as { current: string | null }
    expect(res.current).toBe(realpathSync(homedir()))
  })
})

describe('fs:browse 失败抛 InvokeError，不再返回 {ok:false} 结果体', () => {
  it('相对路径 → INVALID_ARGUMENT', async () => {
    await expect(handler('fs:browse')(evt, { path: '~' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: '需要绝对路径'
    })
  })

  it('目录不存在 → NOT_FOUND', async () => {
    await expect(handler('fs:browse')(evt, { path: join(tmpdir(), 'deva-no-such-dir') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: '目录不存在'
    })
  })

  it('目标是文件不是目录 → INVALID_ARGUMENT', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'deva-file-')), 'a.txt')
    writeFileSync(file, 'x')
    await expect(handler('fs:browse')(evt, { path: file })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: '目标不是目录'
    })
  })
})

describe('fs:trust-root', () => {
  it('登记存在的目录 → {ok:true, path, name}', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deva-trust-')))
    const res = (await handler('fs:trust-root')(evt, { path: dir })) as {
      ok: true
      path: string
      name: string
    }
    expect(res).toEqual({ ok: true, path: dir, name: basename(dir) })
  })

  it('登记不存在的目录 → NOT_FOUND', async () => {
    await expect(handler('fs:trust-root')(evt, { path: join(tmpdir(), 'deva-nope') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: '目录不存在'
    })
  })

  it('相对路径 → INVALID_ARGUMENT', async () => {
    await expect(handler('fs:trust-root')(evt, { path: 'foo/bar' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
  })
})
