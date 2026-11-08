/**
 * `config:set` 的 unsetKeys 归一化回归测试。
 *
 * 背景（线上 bug）：渲染层 `config.set(patch)` 只传一个参数，`[cleanPatch, unsetKeys]` 里的
 * `undefined` 经 JSON 传输会变成 `null`（`JSON.stringify([patch, undefined]) === '[patch,null]'`）。
 * registry 的 args schema 早已放行 `[patch]` / `[patch, null]` / `[patch, unsetKeys]` 三种形态，
 * 但 handler 只认 `unsetKeys === undefined`，于是 `null` 被当成非法删键数组，
 * 抛「config:set 的 unsetKeys 必须是不超过 64 项的字符串数组」——模型配置等一律存不进去。
 *
 * 这里锁死三种形态的正确语义，防止回退。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// config.json 落在 DEVA_HOME；必须在首次读写前设好，避免污染真实 ~/.deva。
process.env.DEVA_HOME = mkdtempSync(join(tmpdir(), 'deva-config-test-'))

import { getConfig, registerConfigIpc } from '../config'
import { getInvokeHandler, type InvokeHandler } from '../../platform'

type SetArgs = [Record<string, unknown>, ...(string[] | null | undefined)[]]

let setHandler: InvokeHandler

beforeAll(() => {
  registerConfigIpc()
  const h = getInvokeHandler('config:set')
  if (!h) throw new Error('config:set 未注册')
  setHandler = h
})

/** 直接以 args 形态调用处理器（evt 未被使用）。 */
function call(...args: SetArgs): unknown {
  return setHandler({} as never, ...args)
}

describe('config:set 的 args 三种形态', () => {
  it('[cleanPatch] —— 只传补丁，顶层浅合并', () => {
    call({ shape1: 'a', keep: 'k' })
    expect(getConfig()).toMatchObject({ shape1: 'a', keep: 'k' })
    expect(call({ shape1: 'a' })).toEqual({ ok: true })
  })

  it('[cleanPatch, null] —— JSON 把缺省 undefined 变 null，应等价于只传补丁（回归）', () => {
    call({ keep: 'k', shape2: 'b' })
    expect(call({ shape2: 'B' }, null)).toEqual({ ok: true })
    const cfg = getConfig()
    expect(cfg).toMatchObject({ shape2: 'B', keep: 'k' })
    // null 不是删键清单：keep 必须还在
    expect('keep' in cfg).toBe(true)
  })

  it('[cleanPatch, unsetKeys] —— 补丁合并后再显式删键', () => {
    call({ shape3: 'c', drop: 'd' })
    expect(call({ shape3: 'C' }, ['drop'])).toEqual({ ok: true })
    const cfg = getConfig()
    expect(cfg).toMatchObject({ shape3: 'C' })
    expect('drop' in cfg).toBe(false)
  })
})

describe('config:set 的非法入参仍须拒绝', () => {
  it('unsetKeys 非数组（null 除外）报错', () => {
    expect(() => call({ x: 1 }, 'drop' as unknown as string[])).toThrow(
      'config:set 的 unsetKeys 必须是不超过 64 项的字符串数组'
    )
    expect(() => call({ x: 1 }, { k: 1 } as unknown as string[])).toThrow(
      'config:set 的 unsetKeys 必须是不超过 64 项的字符串数组'
    )
  })

  it('unsetKeys 超过 64 项报错', () => {
    const keys = Array.from({ length: 65 }, (_, i) => `k${i}`)
    expect(() => call({ x: 1 }, keys)).toThrow('config:set 的 unsetKeys 必须是不超过 64 项的字符串数组')
  })

  it('unsetKeys 含非字符串报错', () => {
    expect(() => call({ x: 1 }, ['ok', 2] as unknown as string[])).toThrow(
      'config:set 的 unsetKeys 必须全为字符串'
    )
  })

  it('补丁不是普通对象报错', () => {
    expect(() => call(null as unknown as Record<string, unknown>)).toThrow(
      'config:set 的补丁必须是普通对象'
    )
    expect(() => call([1] as unknown as Record<string, unknown>)).toThrow(
      'config:set 的补丁必须是普通对象'
    )
    expect(() => call('patch' as unknown as Record<string, unknown>)).toThrow(
      'config:set 的补丁必须是普通对象'
    )
  })
})
