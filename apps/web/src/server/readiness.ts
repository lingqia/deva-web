/**
 * 就绪状态与停机标志:独立小模块,避免 http/ws 与入口 index.ts 的循环依赖。
 * GET /api/ready 按此返回;停机幂等由 markShuttingDown 保证。
 */
export type ReadyState = 'starting' | 'ready' | 'stopping'

let readyState: ReadyState = 'starting'
let shuttingDown = false

export function setReadyState(s: ReadyState): void {
  readyState = s
}

export function getReadyState(): ReadyState {
  return readyState
}

export function isShuttingDown(): boolean {
  return shuttingDown
}

/** 幂等:首次进入停机返回 true,后续调用返回 false。 */
export function markShuttingDown(): boolean {
  if (shuttingDown) return false
  shuttingDown = true
  return true
}
