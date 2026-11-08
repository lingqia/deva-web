/**
 * 运行态(P4 已填充,web-migration-plan.md §6.2)—— 快照恢复的权威来源。
 *
 * - StreamSequences:每 stream 单调 seq(server 全局,保证多连接看到一致序号);有界;
 *   会话结束/删除由统一事件出口回收。重启后 seq 归零,客户端以 hello.serverId 变更触发
 *   全量重同步,不跨启动比较 seq。
 * - chatStreamSeqs + runtimeStore(本模块单例):chat:<sessionId> 流的序号与每会话权威运行态
 *   **必须同源** —— chat.ts 的统一事件出口(registerChatIpc 内第一个 onChatEvent 订阅)在转发
 *   广播前「先更新快照、再取 seq」;chat:snapshot 通道从 runtimeStore 读出即得 {seq, messages,...}
 *   一致点(§6.2.5)。TODO(H 接线):ws.ts 现自建 StreamSequences 且把 chat 事件随广播走 'shared'
 *   流 —— 接线时 chat 事件须改经 hub.publish('chat:<sid>', ...) 并让该流序号取自 chatStreamSeqs
 *   (把本单例注入 ws.ts 或由出口预分配 seq),否则快照 seq 与 WS 信封 seq 不同源,客户端无法按
 *   「seq 大于快照」去重。
 * - RuntimeStateStore:每聊天会话的权威运行态快照(messages=完整展示态含在途伪气泡、turnId、
 *   pendingInteractions=可重建描述)。回合结束(done)与会话删除/清空时 delete 回收(§6.2.8 不复制
 *   多份完整历史:messages 复用 chat.ts 的内存会话派生,空闲会话回落磁盘历史)。
 */
import { randomBytes } from 'node:crypto'

export class StreamSequences {
  private seqs = new Map<string, number>()

  constructor(private maxStreams = 4096) {}

  next(stream: string): number {
    const v = (this.seqs.get(stream) ?? 0) + 1
    this.seqs.set(stream, v)
    if (this.seqs.size > this.maxStreams) {
      // 有界:丢最旧(Map 保插入序)。重启后 seq 归零由 serverId 变更兜底。
      const first = this.seqs.keys().next()
      if (!first.done) this.seqs.delete(first.value)
    }
    return v
  }

  peek(stream: string): number {
    return this.seqs.get(stream) ?? 0
  }

  forget(stream: string): void {
    this.seqs.delete(stream)
  }

  get size(): number {
    return this.seqs.size
  }
}

/**
 * 待决交互的可重建描述(§6.2.3):pendingAsk/Plan/Mount 只存 resolve,恢复需要
 * 题目/正文/提示 + 稳定 key。在创建 pending 时同步登记(不改 resolve 流程),
 * 答复/取消时移除;chat:snapshot 的 pendingInteractions 即此结构,未决项可继续作答。
 */
export interface PendingInteractionDesc {
  kind: 'ask' | 'plan' | 'mount'
  /** 稳定 key(ask_/plan_/mount_ 前缀的 genId):答复通道与恢复重建据此对上。 */
  key: string
  turnId: string
  sessionId: string
  /** kind='ask':问题列表(元素为 chat.ts 的 AskQuestion)。 */
  questions?: unknown[]
  /** kind='plan':计划正文。 */
  plan?: string
  /** kind='mount':触发工具与缺失基准的路径(卡片「为什么需要」说明)。 */
  tool?: string
  path?: string
}

export interface ChatRuntimeSnapshot {
  sessionId: string
  /** 快照对应 stream 的序号(快照与 seq 必须一致获取,§6.2.5)。 */
  seq: number
  serverId: string
  turnId: string | null
  /** 完整展示态:chat.ts 派生的 DisplayMessage[],流式中末尾带在途伪气泡(含 kind:'thinking' 块)。 */
  messages: unknown[]
  pendingInteractions: PendingInteractionDesc[]
  updatedAt: number
}

export class RuntimeStateStore {
  private snapshots = new Map<string, ChatRuntimeSnapshot>()

  get(sessionId: string): ChatRuntimeSnapshot | null {
    return this.snapshots.get(sessionId) ?? null
  }

  put(snapshot: ChatRuntimeSnapshot): void {
    this.snapshots.set(snapshot.sessionId, snapshot)
  }

  delete(sessionId: string): void {
    this.snapshots.delete(sessionId)
  }

  get size(): number {
    return this.snapshots.size
  }
}

// ---------------------------------------------------------------------------
// 全 server 单例:chat 流序号 + 运行态存储 + 本次启动标识
// ---------------------------------------------------------------------------

/** chat:<sessionId> 流的序号(快照与该流事件同源,见文件头)。 */
export const chatStreamSeqs = new StreamSequences()

/** 每聊天会话的权威运行态。chat.ts 统一事件出口写,chat:snapshot 读。 */
export const runtimeStore = new RuntimeStateStore()

/** chat 事件流键(与 §6.1 信封 stream 命名一致)。 */
export function chatStreamKey(sessionId: string): string {
  return `chat:${sessionId}`
}

/**
 * 本次启动标识:快照响应带回,客户端与 WS hello.serverId 比对以识别重启(重启后 seq 归零,
 * 旧 seq 不可续用)。默认自生成;TODO(H 接线):index.ts 启动时以 WS hub 的 serverId 调
 * setServerId 对齐(需 ws.ts 导出其 serverId),避免客户端看到两个不同的「本次启动标识」。
 */
let SERVER_ID = randomBytes(8).toString('hex')

/** 读本次启动标识(chat:snapshot 响应用)。 */
export function currentServerId(): string {
  return SERVER_ID
}

/** 启动接线用:以 WS hub 的 serverId 覆盖默认自生成值(仅启动阶段调用一次)。 */
export function setServerId(id: string): void {
  if (typeof id === 'string' && id.length > 0 && id.length <= 128) SERVER_ID = id
}
