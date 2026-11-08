import { emitNotice } from '../platform'
import { nextRun } from './schedule'
import {
  appendRun,
  applyRunResult,
  getTask,
  listTasks,
  setTaskRunner,
  type TaskRunner
} from './tasks'
import { runScheduledTask, type ScheduledTurnResult } from './chat'
import { publishAppNotice } from './chat-bus'
import type { PlatformWindow } from '../platform'
import type { TaskRecord, TaskRun, TaskSchedule } from './tasks-types'

/**
 * 定时任务调度器（主进程）· 唯一的「触发」发起方。
 *
 * 设计要点：
 *  · **幂等启动**：startScheduler 可重复调用——仅首次装 timer，每次都刷新窗口取用器 getWindow。
 *  · **30s tick**：cron 粒度为 1 分钟，30s 轮询保证不漏分（宁可同分钟内多看一次也不错过）。
 *  · **串行队列**：一次只跑一个任务；同 id 已在队列 / 正在跑则去重跳过——杜绝重入与并发烧 token。
 *  · **追赶策略**：未运行时段错过多次触发，只补跑**最近一次**，跳过数记入单条 skipped 摘要
 *    （启动不雪崩回填）。
 *  · **退避 / 自动暂停**：由 tasks.applyRunResult 统一善后（连续错误累加、达阈值转 error 弹一次通知）。
 *  · **窗口无关**：runScheduledTask 全程在服务端进程内取密钥、执行、落盘；窗口关闭 / 隐藏照常触发，
 *    emit() 对 null 窗口 no-op，渲染层下次打开经 chat-store / tasks:list 追平。
 *
 * Web 迁移说明（web-migration-plan.md §0）：调度器是服务端后台能力，**不依赖任何浏览器连接存在**
 * ——全部浏览器关闭后 tick 继续跑、任务照常触发落盘，通知改走 emitNotice 结构化事件（原系统
 * Notification 的点击聚焦回调已删：可见性 / 点击跳转由浏览器与 WS 通知层处理）。
 *
 * 纯函数 planFires / countMissed 抽出供单测（不碰 IPC / 通知 / 时钟）。
 * 循环依赖规避：tasks.ts 经 setTaskRunner 注入运行器（本文件提供），本文件再直调 chat.runScheduledTask；
 * chat.ts 只 import tasks-types 的类型，绝不 import 本文件。
 */

// ── 纯调度决策（可单测）─────────────────────────────────────────────────────

/** 从 firstFire（含）之后到 now（含）之间，除 firstFire 外还错过多少次触发（有界 ≤ 1000，防病态 cron 卡死）。 */
export function countMissed(schedule: TaskSchedule, firstFire: number, now: number): number {
  let missed = 0
  let cursor = firstFire
  for (let i = 0; i < 1000; i++) {
    const next = nextRun(schedule, cursor)
    if (next == null || next > now) break
    missed++
    cursor = next
  }
  return missed
}

/**
 * 给定任务快照与当前时刻，返回本 tick 应触发的任务及其错过次数。
 * 仅取 `active` 且 `nextRunAt<=now` 的任务；missed = 除本次外错过的触发数（记入 skipped 摘要）。
 */
export function planFires(
  tasks: TaskRecord[],
  now: number
): Array<{ id: string; missed: number }> {
  const out: Array<{ id: string; missed: number }> = []
  for (const t of tasks) {
    if (t.status !== 'active') continue
    if (t.nextRunAt == null || t.nextRunAt > now) continue
    out.push({ id: t.id, missed: countMissed(t.schedule, t.nextRunAt, now) })
  }
  return out
}

// ── 运行期状态（模块级单例）──────────────────────────────────────────────────

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let getWin: (() => PlatformWindow | null) | null = null

/** 串行队列：{ id, manual, missed }。running + currentId 用于去重与互斥。 */
interface Job {
  id: string
  manual: boolean
  missed: number
}
const queue: Job[] = []
let running = false
let currentId: string | null = null

// ── 摘要 / 通知辅助 ───────────────────────────────────────────────────────────

/** 取文本首行作运行摘要（去空白、单行、限长）。 */
function firstLine(text: string): string {
  const t = (text || '').trim()
  if (!t) return ''
  const nl = t.indexOf('\n')
  const line = (nl >= 0 ? t.slice(0, nl) : t).trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * 弹一条任务通知（不可用则静默降级）。
 * 旧桌面版在此构造系统 Notification 并注册「点击 → 聚焦窗口 + 推 tasks:navigate」的回调；Web 端改为
 * 结构化通知（emitNotice，kind='task'，带 sessionId 供点击跳转），由 WS 层广播给在线页面，
 * 浏览器自行处理可见性判断 / 去重 / 点击导航 —— 服务端不再区分「用户是否在看」。
 */
function notify(title: string, body: string, sessionId?: string, echoesReply = false): void {
  // 远程通道（飞书等）经总线同步推送到手机；与页面通知互不影响。
  publishAppNotice({ title: title || 'Deva', body, sessionId, echoesReply })
  try {
    emitNotice({ title: title || 'Deva', body, sessionId, kind: 'task' })
  } catch {
    /* 通知出口抛错 → 静默降级（运行仍已记录） */
  }
}

/**
 * 依结果决定是否弹通知（通知固定开启，不再有开关/类型区分）：
 *  · ok → 必弹（末轮摘要，缺失回落任务指令正文）；
 *  · error 且自动暂停 → 弹一次「已自动暂停」（单次错误不打扰，避免每 tick 风暴）；
 *  · skipped → 不弹。
 */
function notifyForRun(task: TaskRecord, run: TaskRun, autoPaused: boolean): void {
  if (run.status === 'error') {
    if (autoPaused)
      notify(task.title, '定时任务多次执行失败，已自动暂停，请在「定时任务」中查看。', task.sessionId)
    return
  }
  if (run.status === 'skipped') return
  notify(task.title, run.summary || task.prompt, task.sessionId, true)
}

// ── 触发一次（队列消费单元）─────────────────────────────────────────────────

/**
 * 触发一个任务一次：追赶跳过记录 → 密封执行 → 记运行 → （非手动）applyRunResult 善后 → 通知。
 * @param manual 手动「立即运行」：只追加运行记录，**不** applyRunResult（不重排 nextRunAt、不动退避）。
 */
async function fireOnce(id: string, manual: boolean, missed: number): Promise<void> {
  const task = getTask(id)
  if (!task) return
  const firedAt = Date.now()

  // 追赶：错过多次只补跑最近一次，跳过数记入单条 skipped 摘要。
  if (!manual && missed > 0) {
    appendRun(id, {
      firedAt,
      finishedAt: firedAt,
      status: 'skipped',
      summary: `未运行时段错过 ${missed} 次触发，仅补跑最近一次。`
    })
  }

  let res: ScheduledTurnResult
  try {
    res = await runScheduledTask(task)
  } catch (e) {
    res = { stopReason: 'error', text: '', errorMessage: (e as Error)?.message ?? String(e) }
  }
  const finishedAt = Date.now()
  const ok = res.stopReason !== 'error'
  const run: TaskRun = {
    firedAt,
    finishedAt,
    status: ok ? 'ok' : 'error',
    summary: ok ? firstLine(res.text) || undefined : undefined,
    error: ok ? undefined : res.errorMessage || '执行失败'
  }
  appendRun(id, run)

  let autoPaused = false
  if (!manual) {
    const applied = applyRunResult(id, { ok }, firedAt)
    autoPaused = applied?.autoPausedError ?? false
  }

  // 通知取善后后的最新记录（title 可能已被首轮派生）。
  notifyForRun(getTask(id) ?? task, run, autoPaused)
}

// ── 串行队列 ──────────────────────────────────────────────────────────────────

/**
 * 入队（去重：已在队列 / 正在跑同 id 则忽略），并驱动队列消费。
 * @returns 'enqueued' 新入队；'running' 同 id 正在跑；'queued' 同 id 已在队列里等待（后两者本次不入队）。
 */
function enqueue(id: string, manual: boolean, missed: number): ReturnType<TaskRunner> {
  if (currentId === id) return 'running'
  if (queue.some((j) => j.id === id)) return 'queued'
  queue.push({ id, manual, missed })
  void drain()
  return 'enqueued'
}

/** 串行消费队列（一次只跑一个；drain 自身互斥）。 */
async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      currentId = job.id
      try {
        await fireOnce(job.id, job.manual, job.missed)
      } catch {
        /* fireOnce 内部已兜底；此处再防御一层，绝不让队列因单个任务崩掉 */
      }
      currentId = null
    }
  } finally {
    running = false
  }
}

// ── tick ──────────────────────────────────────────────────────────────────────

function tick(): void {
  try {
    const now = Date.now()
    for (const f of planFires(listTasks(), now)) enqueue(f.id, false, f.missed)
  } catch {
    /* 单次 tick 抛错不应停摆调度器；下一 tick 继续 */
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────

/**
 * 幂等启动调度器：装 30s 定时 tick + 注入「立即运行」运行器。
 * 首 tick 延后 ~3s（等主进程 / chat runtime 就绪，并补跑启动时已错过的任务）。
 * @param getWindow 窗口取用器（保留接线兼容；通知已走 emitNotice，本文件仅在启动时留存，
 *   不再用于判断或聚焦——调度器不依赖窗口存在）。
 */
export function startScheduler(getWindow: () => PlatformWindow | null): void {
  getWin = getWindow
  if (started) return
  started = true

  // tasks:run-now 与 UI「立即运行」经此入串行队列（manual：不重排 / 不退避）。
  setTaskRunner((id) => enqueue(id, true, 0))

  setTimeout(tick, 3000)
  timer = setInterval(tick, 30_000)
  if (timer.unref) timer.unref()
}

/**
 * 仅注入「立即运行」运行器，不启动自动 tick（web-migration-plan.md §4.1.7：DEVA_AUTOSTART=0
 * 演练/测试模式下禁止自动调度，但 tasks:run-now 手动触发保持明确可用 —— run-now 路径依赖
 * startScheduler 注入的 TaskRunner，不能因未启动调度器丢掉绑定）。
 * 与 startScheduler 二选一调用（由启动环境决定）；stopScheduler 会同时撤销该绑定。
 */
export function enableManualRuns(getWindow: () => PlatformWindow | null): void {
  getWin = getWindow
  setTaskRunner((id) => enqueue(id, true, 0))
}

/** 停止调度器（供退出 / 测试清理；生产一般随进程退出）。 */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  started = false
  setTaskRunner(null)
}
