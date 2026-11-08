/**
 * 数据目录独占锁:同一 DEVA_HOME 只允许一个服务进程(web-migration-plan.md §4.1)。
 * - 原子创建锁文件(O_EXCL),记录 ownerId(随机)、PID、主机名、启动时间。
 * - 正常停止时核对 ownerId 后删除;异常遗留锁不自动抢夺,明确报错并提示清锁步骤。
 * - 不同端口访问同一数据目录同样被拒(锁按数据目录,不按端口)。
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './log'

interface LockInfo {
  ownerId: string
  pid: number
  host: string
  startedAt: string
}

let lockPath: string | null = null
let ownerId: string | null = null

export class LockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockError'
  }
}

/** 获取独占锁;被占时抛 LockError(含既有持有者信息与清锁指引)。 */
export function acquireLock(devaHome: string): string {
  if (!ownerId) ownerId = randomBytes(16).toString('hex')
  lockPath = path.join(devaHome, '.deva-web.lock')
  const info: LockInfo = {
    ownerId,
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString()
  }
  try {
    // wx:已存在即失败 —— 原子性由 O_EXCL 语义保证,不做读改写竞争。
    writeFileSync(lockPath, JSON.stringify(info, null, 2), { flag: 'wx' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') {
      let existing: LockInfo | null = null
      try {
        existing = JSON.parse(readFileSync(lockPath!, 'utf8')) as LockInfo
      } catch {
        // 锁文件损坏:仍按被占处理,提示人工清锁(不自动覆盖)。
      }
      const who = existing
        ? `ownerId=${existing.ownerId} pid=${existing.pid} host=${existing.host} 启动于 ${existing.startedAt}`
        : '(锁文件无法解析)'
      throw new LockError(
        `数据目录已被其他实例占用: ${devaHome}(${who})。` +
          `确认旧进程已停止后,删除锁文件 ${lockPath} 再启动。`
      )
    }
    throw err
  }
  log('lock', `已获取数据目录锁 ${devaHome} (ownerId=${info.ownerId})`)
  return ownerId
}

/** 释放锁:核对 ownerId,避免误删他人的锁(如竞态下后来者已建新锁)。 */
export function releaseLock(): void {
  if (!lockPath || !ownerId) return
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf8')) as LockInfo
    if (info.ownerId !== ownerId) {
      log('lock', '锁已属于其他实例,跳过释放')
      return
    }
    rmSync(lockPath)
    log('lock', '已释放数据目录锁')
  } catch {
    // 锁文件已不存在或不可读:视为已释放。
  } finally {
    lockPath = null
  }
}
