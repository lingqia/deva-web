/**
 * Deva Web 服务端入口(Node 单进程)。
 *
 * 启动顺序(web-migration-plan.md §4.1):
 *   1. 环境校验(token/origin/host/port/DEVA_HOME)——缺配置拒绝启动,不为方便绕过鉴权
 *   2. 数据目录独占锁(instance-lock)
 *   3. 会话库加载(auth:web-sessions.json;换 token 即全部失效)
 *   4. 业务全量注册:config/secrets 为预检级(失败明确失败,不先开业务);其余逐服务降级,
 *      chat 先于 remote;清扫在注册完成后后台进行;MCP 自动连接与调度器受 DEVA_AUTOSTART 门控
 *   5. HTTP/WS 监听 → readiness
 *
 * 停机(§4.1,幂等,总预算 20s / systemd 30s):
 *   停调度器 → settleActiveTurns(3s) → 断 MCP → 停机器人 → 回收终端/PTY 宿主 →
 *   关全部 WS → 排空 HTTP(3s) → 释放锁。
 */
import http from 'node:http'
import { appVersion, getBroadcastWindow, listInvokeChannels } from '../main/platform'
import { validateEnv } from './env'
import { acquireLock, releaseLock } from './instance-lock'
import { errMessage, error as logError, log, warn } from './log'
import { markShuttingDown, setReadyState } from './readiness'
import { SessionManager } from './auth'
import { createFilesHandlers } from './files'
import { createApp } from './http'
import { createWsHub } from './ws'
import { setServerId } from './runtime-state'

/**
 * 停机所需的业务句柄(§4.1 停机序列)。对应服务注册失败(降级启动)时为 no-op:
 * 停机与启动同等对待「服务不存在」,逐项安全跳过。
 */
interface BusinessLifecycle {
  stopScheduler(): void
  settleActiveTurns(timeoutMs: number): Promise<void>
  disconnectAllServers(): Promise<void>
  stopAllChannels(): void
  shutdownAllTerminals(): void
}

/** 逐服务注册:加载/注册失败降级为告警(该服务通道按白名单语义 404),不阻断启动。 */
function registerService(describe: string, load: () => void): void {
  try {
    load()
    log('startup', `业务注册: ${describe}`)
  } catch (err) {
    warn('startup', `${describe} 注册失败,相关通道将返回 404(不影响其余服务): ${errMessage(err)}`)
  }
}

/**
 * 业务全量注册(§4.1.4-5;顺序即启动顺序,chat 先于 remote)。
 * - require 加载保持 P2 模式:单个服务迁移/加载失败只降级该服务,传输层照常启动;
 * - config/secrets 例外(预检级,§4.1.3):密钥与配置是全部业务的前置,失败明确失败拒绝启动;
 * - 密钥库预检 available=false 只记录告警并继续(ready 语义保持简单,细粒度状态后续迭代);
 * - autostart=false(§4.1.7 演练模式):跳过 MCP 自动连接与调度器自动 tick,run-now 保持可用。
 */
async function registerBusinessServices(opts: { hub: ReturnType<typeof createWsHub>; autostart: boolean }): Promise<BusinessLifecycle> {
  const { hub, autostart } = opts
  const lifecycle: BusinessLifecycle = {
    stopScheduler: () => {},
    settleActiveTurns: async () => {},
    disconnectAllServers: async () => {},
    stopAllChannels: () => {},
    shutdownAllTerminals: () => {}
  }

  // ── 预检级:config + secrets(§4.1.3:不满足时不先开机器人/任务/清扫)──────────
  // 失败直接抛出 → main 捕获 → 释放锁退出(明确失败,不做半启动)。
  const config = require('../main/services/config') as typeof import('../main/services/config')
  config.registerConfigIpc()
  log('startup', '业务注册: config(get/set/get-sync) 已接入 invoke 白名单')
  const secrets = require('../main/services/secrets') as typeof import('../main/services/secrets')
  secrets.registerSecretsIpc()
  log('startup', '业务注册: secrets(密钥安全存储)已接入 invoke 白名单')

  // 密钥库预检:available=false(旧密文未迁移/主密钥不可用/条目损坏)→ 告警并继续注册。
  // 密钥实际取用时 getSecret 返回 null,provider/MCP/机器人按「密钥缺失」降级;后续迭代再细化。
  try {
    const st = await secrets.getSecretsStatus()
    if (st.available) {
      log('startup', `密钥库预检通过(keySource=${st.keySource},${st.totalEntries} 条)`)
    } else {
      warn(
        'startup',
        `密钥库预检未就绪(available=false, initialized=${st.initialized}, legacy=${st.legacyCount}, ` +
          `不可解密=${st.undecryptableCount}, keySource=${st.keySource});` +
          '旧桌面密文请先用 tools/legacy-secrets-export 迁移,相关功能将按密钥缺失降级'
      )
    }
  } catch (err) {
    warn('startup', `密钥库预检失败(继续启动,按密钥缺失降级): ${errMessage(err)}`)
  }

  // ── 会话编排与远程通道(chat 先于 remote:remote 订阅会话总线)────────────────
  registerService('chat(Agent 主循环)', () => {
    const chat = require('../main/services/chat') as typeof import('../main/services/chat')
    chat.registerChatIpc(getBroadcastWindow)
    lifecycle.settleActiveTurns = chat.settleActiveTurns
  })
  registerService('remote(飞书/Telegram 机器人)', () => {
    const remote = require('../main/services/remote') as typeof import('../main/services/remote')
    remote.registerRemoteIpc(getBroadcastWindow)
    lifecycle.stopAllChannels = remote.stopAllChannels
  })

  // ── 工作区与基础服务 ────────────────────────────────────────────────────────
  registerService('workspace(工作区文件服务)', () => {
    const workspace = require('../main/services/workspace') as typeof import('../main/services/workspace')
    workspace.registerWorkspaceIpc(getBroadcastWindow)
    // Web 端目录选择/受信根通道(fs:browse、fs:trust-root),并从已挂载工作区重建受信根
    workspace.registerWebWorkspaceIpc()
    workspace.restoreTrustedRoots()
  })
  registerService('provider(服务商探针)', () => {
    ;(require('../main/services/provider') as typeof import('../main/services/provider')).registerProviderIpc()
  })

  // Personas:首启种子 + 孤儿角色清理(须在 MCP 自动连接之前)+ 注册
  registerService('personas(提示词角色)', () => {
    const personas = require('../main/services/personas') as typeof import('../main/services/personas')
    personas.ensureSeededPersonas()
    personas.pruneOrphanExtRoles()
    personas.registerPersonasIpc()
  })
  registerService('profile(用户资料)', () => {
    ;(require('../main/services/profile') as typeof import('../main/services/profile')).registerProfileIpc()
  })
  registerService('memory(记忆)', () => {
    ;(require('../main/services/memory') as typeof import('../main/services/memory')).registerMemoryIpc()
  })
  registerService('mcp(MCP 服务)', () => {
    const mcp = require('../main/services/mcp') as typeof import('../main/services/mcp')
    mcp.registerMcpIpc(getBroadcastWindow)
    lifecycle.disconnectAllServers = mcp.disconnectAllServers
  })
  registerService('attachments(附加文件)', () => {
    ;(require('../main/services/attachments') as typeof import('../main/services/attachments')).registerAttachmentsIpc(getBroadcastWindow)
  })

  // 终端桥:归属(ownerConnectionId)校验 + 定向输出都经依赖注入与 hub 解耦(§4.2);
  // WS 上行分发器在此一并装入 hub(index.ts 是唯一同时持有 hub 与业务层的接线点)。
  registerService('terminal(集成终端 + WS 上行分发)', () => {
    const terminal = require('../main/services/terminal') as typeof import('../main/services/terminal')
    terminal.registerTerminalIpc({
      // 输出/退出定向发到归属连接(hub.toConnection)
      send: (connectionId, channel, args) => {
        hub.toConnection(connectionId, channel, args)
      },
      // 连接断开 → 回收该连接创建的全部 PTY
      onConnectionClosed: (cb) => {
        hub.onConnectionClosed((connectionId) => cb(connectionId))
      }
    })
    hub.setTerminalDispatch(terminal.handleTerminalMessage)
    lifecycle.shutdownAllTerminals = terminal.shutdownAllTerminals
  })

  registerService('git(源代码管理)', () => {
    ;(require('../main/services/git') as typeof import('../main/services/git')).registerGitIpc()
  })
  registerService('deliverables(交付卡)', () => {
    ;(require('../main/services/deliverables') as typeof import('../main/services/deliverables')).registerDeliverablesIpc()
  })
  registerService('tasks(定时任务)', () => {
    ;(require('../main/services/tasks') as typeof import('../main/services/tasks')).registerTasksIpc(getBroadcastWindow)
  })

  // ── 技能(注册 + 目录监听)──────────────────────────────────────────────────
  registerService('skills(技能)', () => {
    const skills = require('../main/services/skills') as typeof import('../main/services/skills')
    skills.registerSkillsIpc(getBroadcastWindow)
    skills.startSkillsWatcher(getBroadcastWindow)
  })

  // ── 清扫(异步后台,不阻塞启动;§4.1.5 保留)─────────────────────────────────
  registerService('清扫(checkpoints/subagents/media,后台)', () => {
    const store = require('../main/services/chat-store') as typeof import('../main/services/chat-store')
    const liveIds = store.listSessions().map((m) => m.id)
    const checkpoints = require('../main/services/checkpoints') as typeof import('../main/services/checkpoints')
    const subagents = require('../main/services/subagent-store') as typeof import('../main/services/subagent-store')
    const media = require('../main/services/media-store') as typeof import('../main/services/media-store')
    void checkpoints.sweepCheckpoints(liveIds).catch((e) => warn('checkpoints', `清扫失败: ${errMessage(e)}`))
    void subagents.sweepSubagents(liveIds).catch((e) => warn('subagents', `清扫失败: ${errMessage(e)}`))
    void media.sweepMedia().catch((e) => warn('media', `清扫失败: ${errMessage(e)}`))
  })

  // ── MCP 自动连接与调度器(DEVA_AUTOSTART 门控,§4.1.7)────────────────────────
  // autostart=false:跳过自动外连与自动调度(演练/迁移测试);run-now 手动触发经
  // enableManualRuns 保持可用(scheduler.ts 的 TaskRunner 绑定不依赖 tick 定时器)。
  if (autostart) {
    registerService('MCP 自动连接(已启用服务,各自降级)', () => {
      ;(require('../main/services/mcp') as typeof import('../main/services/mcp')).autoConnectEnabledServers()
    })
    registerService('scheduler(定时任务调度器,30s tick)', () => {
      const scheduler = require('../main/services/scheduler') as typeof import('../main/services/scheduler')
      scheduler.startScheduler(getBroadcastWindow)
      lifecycle.stopScheduler = scheduler.stopScheduler
    })
  } else {
    log('startup', 'DEVA_AUTOSTART=0:跳过 MCP 自动连接与调度器自动 tick(演练模式,§4.1.7)')
    registerService('scheduler(手动模式:run-now 可用,不自动 tick)', () => {
      const scheduler = require('../main/services/scheduler') as typeof import('../main/services/scheduler')
      scheduler.enableManualRuns(getBroadcastWindow)
      lifecycle.stopScheduler = scheduler.stopScheduler
    })
  }

  // 注册表即白名单:打印通道总数便于审计(未注册通道一律 404)。
  log('startup', `业务注册完成:${listInvokeChannels().length} 个 invoke 通道`)
  return lifecycle
}

async function main(): Promise<void> {
  const env = validateEnv()
  acquireLock(env.devaHome)
  log('startup', `Deva Web ${appVersion()} · 数据目录 ${env.devaHome}`)

  // 会话库:加载持久化会话(换 token 指纹不符即全部失效)
  const auth = new SessionManager(env)
  if (auth.count > 0) log('auth', `已恢复 ${auth.count} 个登录会话`)

  // WS hub:先建(供 app 依赖),再挂到 http server
  const hub = createWsHub({ env, auth })
  hub.installBroadcastWindow()
  // 启动标识对齐:chat:snapshot 响应与 WS hello 用同一个 serverId(§6.2)
  setServerId(hub.serverId)

  const files = createFilesHandlers()

  // 业务注册(§4.1.4-7;单个服务失败降级不阻断,config/secrets 预检级失败除外)
  const lifecycle = await registerBusinessServices({ hub, autostart: env.autostart })

  const app = createApp(env, { auth, hub, files })
  const server = http.createServer(app)
  hub.attach(server)

  server.listen(env.port, env.host, () => {
    setReadyState('ready')
    log('startup', `监听 http://${env.host}:${env.port}(origin: ${env.origin},autostart: ${env.autostart ? 'on' : 'off'})`)
  })

  // 幂等停机(§4.1):readiness→503 → 停调度器 → 收尾回合 → 断 MCP → 停机器人 →
  // 回收终端 → 关全部 WS → 排空 HTTP → 释放锁。总预算 20s(systemd 30s)。
  const shutdown = (signal: string): void => {
    if (!markShuttingDown()) return
    setReadyState('stopping')
    log('shutdown', `收到 ${signal},开始停机`)
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      try {
        releaseLock()
      } finally {
        process.exit(0)
      }
    }
    // 总预算兜底:任何一步挂死都强制退出(释放锁在 finish 内,不跳过)
    setTimeout(() => {
      warn('shutdown', '停机总预算 20s 超时,强制退出')
      finish()
    }, 20_000).unref()

    const step = (n: number, name: string, run: () => void | Promise<void>): Promise<void> =>
      Promise.resolve()
        .then(run)
        .then(() => {
          log('shutdown', `停机 ${n}/7:${name} 完成`)
        })
        .catch((err) => {
          logError('shutdown', `停机 ${n}/7:${name} 失败(继续后续步骤)`, err)
        })

    void (async () => {
      await step(1, '停调度器', () => lifecycle.stopScheduler())
      await step(2, '收尾进行中的回合(≤3s)', () => lifecycle.settleActiveTurns(3000))
      await step(3, '断开全部 MCP 连接', () => lifecycle.disconnectAllServers())
      await step(4, '停止机器人/扫码通道', () => lifecycle.stopAllChannels())
      await step(5, '回收终端与 PTY 宿主', () => lifecycle.shutdownAllTerminals())
      await step(6, '关闭全部 WS 连接', () => hub.closeAll())
      log('shutdown', '停机 7/7:排空 HTTP(上限 3s)')
      try {
        server.close(() => finish())
        // 排空上限 3 秒,keep-alive/半开连接不阻塞退出
        setTimeout(() => {
          warn('shutdown', 'HTTP 排空超时,强制退出')
          finish()
        }, 3000).unref()
      } catch {
        finish()
      }
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Windows 开发/托管环境没有 SIGTERM 信号(process.kill(pid,'SIGTERM') 直接 TerminateProcess,
  // 不走任何 handler);CTRL_BREAK 可触发本监听 —— 与 SIGINT/SIGTERM 完全同一停机序列
  // (Linux 上收不到该信号,无影响)。
  process.on('SIGBREAK', () => shutdown('SIGBREAK'))

  // 崩溃兜底:未捕获异常记录并释放锁后非零退出,不做静默吞掉(状态已不可信)
  process.on('uncaughtException', (err) => {
    console.error('[crash] 未捕获异常,释放锁后退出:', err)
    try {
      releaseLock()
    } catch {
      /* 忽略 */
    }
    process.exit(1)
  })
  // 未处理的 Promise 拒绝只记录不退出:单个异步失败不应拖垮整个服务(锁随进程退出兜底释放)
  process.on('unhandledRejection', (reason) => {
    logError('crash', '未处理的 Promise 拒绝', reason)
  })
}

main().catch((err) => {
  console.error('[startup] 启动失败:', err)
  try {
    releaseLock()
  } catch {
    /* 忽略 */
  }
  process.exit(1)
})
