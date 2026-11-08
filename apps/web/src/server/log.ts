/**
 * 服务端日志:统一前缀与时间戳;严禁输出 token、Cookie、API key、会话标识等敏感值
 * (web-migration-plan.md §11.2)。各模块用 tag 区分,如 log('mcp', '已连接 3 个服务')。
 */
let verbose = false

export function setVerbose(v: boolean): void {
  verbose = v
}

function ts(): string {
  return new Date().toISOString()
}

export function log(tag: string, ...args: unknown[]): void {
  console.log(`[${ts()}][${tag}]`, ...args)
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[${ts()}][${tag}]`, ...args)
}

export function error(tag: string, ...args: unknown[]): void {
  console.error(`[${ts()}][${tag}]`, ...args)
}

/** 调试细节(仅 DEVA_LOG=debug 时输出;不得含敏感值)。 */
export function debug(tag: string, ...args: unknown[]): void {
  if (verbose) console.log(`[${ts()}][${tag}][debug]`, ...args)
}

/** 错误对象 → 可展示消息(去堆栈;内部日志另用 error() 记录完整对象)。 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
