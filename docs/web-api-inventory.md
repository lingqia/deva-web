# Deva Web API 清单(P0 逐通道去向)

> 基线:`@deva/desktop 0.1.12`,分支 `migration/web`。日期:2026-11-05。
> 源头:`apps/desktop/src/preload/index.ts`(1298 行,复述层)+ `apps/desktop/src/main/*`(实现真源)。
> 契约落点:`apps/web/src/shared/api.ts`(显式 `DevaApi` / `WindowDevaApi`,纯类型,无 Electron/Node 依赖)。
>
## 0. 总量核对与传输映射

| 项 | 桌面版 | Web 去向 |
|---|---:|---|
| invoke | 131 | 保留 117(HTTP `POST /api/invoke/:channel`;其中 fs:open-folder、fs:pick-attachments、fs:paste-attachment、skills:import 4 个原生对话框通道保留签名,由客户端桥改 Web 实现)+ 删除 14(window:* 5、update:* 4、clipboard:* 2、deliverables:open/reveal 2、fs:reveal-folder 1) |
| 推送 on | 13 | 保留 11(广播 7:chat:event、chat:sessions-changed、mcp:status、skills:changed、tasks:changed、tasks:navigate、remote:changed;定向 4:terminal:data/exit、git:commit-gen-delta、remote:scan)+ 删除 2(window:fullscreen、update:state) |
| send | 3 | 改 WS 上行 send(terminal:input/resize/dispose) |
| sendSync | 1 | 删除(config:get-sync → `window.__DEVA_BOOTSTRAP__.config` 预取缓存) |
| 新增 | — | invoke:fs:browse、fs:trust-root、fs:pick-attachments-web、skills:import-web、app:get-platform(主进程已注册,渲染层契约新增);推送:notify |

WS 信封与序号恢复协议见 web-migration-plan.md §5.3/§6.1;本清单只登记通道级契约。

## 1. invoke 通道(131)

图例:保留 = HTTP invoke;保留* = 通道保留但 Web 由客户端桥换实现;删除 = 通道删除并给理由。

### app / window(6)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| app:get-platform | invoke | — | `string`(process.platform) | main/index.ts | 保留 | 与 preload 的同步 `platform` 属性同值;Web 语义 = **浏览器客户端**平台(快捷键/文案用),服务端平台另由元信息提供 |
| window:minimize | invoke | — | void | main/index.ts | **删除** | 桌面窗口操作;浏览器标签页无最小化语义 |
| window:toggle-maximize | invoke | — | void | main/index.ts | **删除** | 同上 |
| window:close | invoke | — | void | main/index.ts | **删除** | 关窗=关标签页;托盘驻留一并废弃(closeToTray 配置键废弃) |
| window:is-fullscreen | invoke | — | boolean | main/index.ts | **删除** | 浏览器全屏用 DOM Fullscreen API |
| window:set-overlay | invoke | symbolColor: string | void | main/index.ts | **删除** | titleBarOverlay 图标配色;调用点已从 ThemeContext 移除(TODO(P6) 注释留档) |

### fs(7 + 新增 3)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| fs:open-folder | invoke | — | `OpenFolderResult \| null` | services/workspace.ts | 保留*(过渡) | 原生目录对话框;P6 客户端桥以 WebFolderPicker(fs:browse+fs:trust-root)实现同名方法后移除;调用点:workspace store、blocks.tsx、ChatFirstShell |
| fs:reveal-folder | invoke | dirPath | `{ok}` | services/workspace.ts | **删除** | 打开服务器文件管理器无意义;调用点(工作区菜单「在文件夹中显示」)改为复制服务器路径 |
| fs:read-dir | invoke | dirPath | `DirEntry[]` | services/workspace.ts | 保留 | 受信根内;根目录分隔符判定按 plan §5.4 修正 |
| fs:read-file | invoke | filePath | `ReadFileResult` | services/workspace.ts | 保留 | 2 MiB 文本上限;Web 预览走 /api/files/raw,本通道供编辑器 |
| fs:write-file | invoke | filePath, content | `{ok:true}` | services/workspace.ts | 保留 | 受信根内 |
| fs:pick-attachments | invoke | — | `PickedAttachment[]` | services/attachments.ts | 保留*(过渡) | 原生多选;P6 客户端桥改浏览器文件选择 + fs:pick-attachments-web 上传链路 |
| fs:paste-attachment | invoke | `{name,mime,size,data:Uint8Array\|null}` | `PickedAttachment` | services/attachments.ts | 保留*(过渡) | 字节经客户端 base64 编码传输(plan §5.3);P6 与粘贴/拖放统一上传实现 |
| fs:browse | invoke(新增) | `{path?,cursor?}` | `DirBrowseResult{current,parent,entries,nextCursor?}` | —(P5/P6 实现) | 新增 | plan §5.4:不递归、单页 ≤500 项、parent 由服务端计算 |
| fs:trust-root | invoke(新增) | path | `{path,name}` | —(P5/P6 实现) | 新增 | 验证绝对路径/存在可读/真实路径后登记受信根 |
| fs:pick-attachments-web | invoke(新增) | `[{name,mime,size,dataBase64}]` | `PickedAttachment[]` | —(P5/P6 实现) | 新增 | 统一上传链路:图片 5 MiB / PDF 20 MiB / 文本 512 KiB,校验魔数与声明 size |

### config(2 + 1 sync)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| config:get | invoke | — | `Record<string,unknown>` | services/config.ts | 保留 | 不含密钥;`GET /api/config` 启动快照同源 |
| config:set | invoke | 桌面:patch(undefined 删键) | `{ok:true}` | services/config.ts | 保留(**签名变更**) | Web 契约改 `set(cleanPatch, unsetKeys?)`:显式删除顶层键,JSON 不再承载 undefined 语义;写成功更新预取缓存并通知其它端重拉 |
| config:get-sync | sendSync | — | `Record<string,unknown>` | services/config.ts | **删除** | 渲染层首帧改读 `window.__DEVA_BOOTSTRAP__.config`(登录后预取,plan §8.1);调用点:ThemeContext、i18n、resizable、GeneralPane(托盘设置整块移除) |

### skills(6 + 新增 1)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| skills:list | invoke | — | `SkillRecord[]` | services/skills.ts | 保留 | |
| skills:get | invoke | id | `SkillRecord \| null` | services/skills.ts | 保留 | |
| skills:import | invoke | —(原生文件对话框) | `SkillImportResult` | services/skills.ts | 保留* | plan §8.2:客户端桥打开文件选择并上传;取消保持原 cancelled 语义 |
| skills:import-web | invoke(新增) | name, dataBase64 | `SkillImportResult` | —(P5/P6 实现) | 新增 | zip 默认 20 MiB、展开总量 20 MiB/单文件 10 MiB/≤200 文件;解压前查预算,拒 zip-slip/symlink |
| skills:remove | invoke | id | `{ok}` | services/skills.ts | 保留 | 桌面 shell.trashItem 改服务端 DEVA_HOME/trash/skills/ 真实回收 + 可恢复(plan §4.3) |
| skills:set-enabled | invoke | id, enabled | `{ok:true}` | services/skills.ts | 保留 | |
| skills:set-roles | invoke | id, roles\|null | `{ok}` | services/skills.ts | 保留 | |

### profile / memory / personas(15)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| profile:get | invoke | — | `UserProfile` | services/profile.ts | 保留 | |
| profile:set-avatar | invoke | spec | `{ok:true}` | services/profile.ts | 保留 | |
| profile:set-avatar-image | invoke | dataUri | string | services/profile.ts | 保留 | 图片走上传链路落 ~/.deva/profile/ |
| memory:list | invoke | root? | `MemorySnapshot` | services/memory.ts | 保留 | 项目记忆键按 realpath 重算(plan §1.2) |
| memory:write | invoke | content, id?, root? | `MemoryIpcResult` | services/memory.ts | 保留 | |
| memory:delete | invoke | id, root? | `MemoryIpcResult` | services/memory.ts | 保留 | |
| memory:clear | invoke | root? | `MemoryIpcResult` | services/memory.ts | 保留 | |
| personas:list | invoke | — | `PersonaRecord[]` | services/personas.ts | 保留 | |
| personas:get | invoke | id | `PersonaRecord \| null` | services/personas.ts | 保留 | |
| personas:upsert | invoke | input | `PersonaRecord` | services/personas.ts | 保留 | |
| personas:remove | invoke | id | `{ok:true}` | services/personas.ts | 保留 | |
| personas:set-enabled | invoke | id, enabled | `{ok:true}` | services/personas.ts | 保留 | |
| personas:reorder | invoke | ids | `{ok:true}` | services/personas.ts | 保留 | |
| personas:set-avatar-image | invoke | id, dataUri | string | services/personas.ts | 保留 | |
| personas:clear-avatar-image | invoke | id | `{ok:true}` | services/personas.ts | 保留 | |

### mcp / secrets / provider(15)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| mcp:list | invoke | — | `McpServerView[]` | services/mcp.ts | 保留 | |
| mcp:get | invoke | id | `McpServerConfig \| null` | services/mcp.ts | 保留 | |
| mcp:upsert | invoke | input | `McpServerConfig` | services/mcp.ts | 保留 | |
| mcp:remove | invoke | id | `{ok:true}` | services/mcp.ts | 保留 | |
| mcp:set-enabled | invoke | id, enabled | `{ok:true}` | services/mcp.ts | 保留 | 启用即由服务端自动对账连接 |
| mcp:set-roles | invoke | id, roles\|null | `{ok}` | services/mcp.ts | 保留 | |
| mcp:retry | invoke | id | `McpServerView \| null` | services/mcp.ts | 保留 | |
| mcp:set-secret | invoke | id, field, value | `{ok,available}` | services/mcp.ts | 保留 | 明文不回传;改写 AES-GCM 新密钥库(plan §7.1) |
| mcp:has-secret | invoke | id, field | boolean | services/mcp.ts | 保留 | |
| secrets:set | invoke | providerId, key | `{ok,available}` | services/secrets.ts | 保留 | available 反映真实初始化/可写状态 |
| secrets:has | invoke | providerId | boolean | services/secrets.ts | 保留 | |
| secrets:delete | invoke | providerId | `{ok:true}` | services/secrets.ts | 保留 | |
| secrets:list | invoke | — | `string[]` | services/secrets.ts | 保留 | |
| secrets:available | invoke | — | boolean | services/secrets.ts | 保留 | safeStorage → AES-256-GCM;旧密文走离线迁移工具 |
| provider:list-models | invoke | `ProbeConfig` | `ProviderListModelsResult` | services/provider.ts | 保留 | 服务端发起 HTTP;kind 字段已修正为 ErrorKind 联合 |

### chat(27)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| chat:send | invoke | `ChatSendRequest` | `{turnId}` | services/chat.ts | 保留 | 副作用操作,requestId 去重(plan §5.3) |
| chat:compact | invoke | `ChatCompactRequest` | `{turnId}` | services/chat.ts | 保留 | |
| chat:create-session | invoke | `ChatCreateSessionRequest` | `{ok:true}` | services/chat.ts | 保留 | |
| chat:set-model | invoke | `ChatSetModelRequest` | `{ok:true}` | services/chat.ts | 保留 | |
| chat:set-effort | invoke | `ChatSetEffortRequest` | `{ok:true}` | services/chat.ts | 保留 | |
| chat:set-focus | invoke | `ChatSetFocusRequest` | `{ok:true}` | services/chat.ts | 保留 | |
| chat:rename-session | invoke | `ChatRenameSessionRequest` | `{title}\|null` | services/chat.ts | 保留 | |
| chat:set-archived | invoke | `{sessionId,archived}` | `{ok}` | services/chat.ts | 保留 | |
| chat:abort | invoke | turnId | `{ok:true}` | services/chat.ts | 保留 | fetch 取消≠业务取消,仍走本通道 |
| chat:stop-subagent | invoke | sessionId, toolUseId | `{ok}` | services/chat.ts | 保留 | |
| chat:reset | invoke | sessionId, workspaceRoot | `{ok:true}` | services/chat.ts | 保留 | |
| chat:list-sessions | invoke | workspaceRoot\|null | `ChatSessionMeta[]` | services/chat.ts | 保留 | |
| chat:load-session | invoke | sessionId, workspaceRoot | `DisplayMessage[]` | services/chat.ts | 保留 | |
| chat:attach-session | invoke | sessionId | `{messages,turnId}` | services/chat.ts | 保留(**将扩展**) | P4 按 plan §6.2 扩为权威快照 `{serverId,seq,messages,turnId,pendingInteractions,...}` |
| chat:delete-session | invoke | sessionId, workspaceRoot | `{ok:true}` | services/chat.ts | 保留 | |
| chat:delete-turns | invoke | sessionId, workspaceRoot, turnIndices | `DisplayMessage[]` | services/chat.ts | 保留 | |
| chat:todos | invoke | sessionId | `TodoState` | services/chat.ts | 保留 | |
| chat:todo-cancel | invoke | sessionId | `TodoState` | services/chat.ts | 保留 | |
| chat:rewind-list | invoke | sessionId | `{turns,canUndo}` | services/chat.ts | 保留 | 目标=服务器工作区 |
| chat:rewind-preview | invoke | sessionId, turn | `RewindPreview\|null` | services/chat.ts | 保留 | |
| chat:rewind-apply | invoke | `RewindApplyRequest` | `RewindApplyResult` | services/chat.ts | 保留 | |
| chat:rewind-undo | invoke | sessionId | `RewindUndoResult` | services/chat.ts | 保留 | |
| chat:resolve-proposal | invoke | sessionId, toolUseId, status | `{ok}` | services/chat.ts | 保留 | 多端先到者生效,interaction_resolved 收敛 |
| chat:resolve-autotask | invoke | sessionId, toolUseId, action, taskInput? | `ResolveAutotaskResult` | services/chat.ts | 保留 | 唯一授权时刻 |
| chat:ask-response | invoke | `AskResponse` | `{ok}` | services/chat.ts | 保留 | |
| chat:plan-response | invoke | `PlanResponse` | `{ok}` | services/chat.ts | 保留 | |
| chat:mount-response | invoke | `MountResponse` | `{ok}` | services/chat.ts | 保留 | 挂载走服务器目录选择(P6) |

### terminal(2 invoke + 3 send)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| terminal:list-shells | invoke | — | `ShellProfile[]` | services/terminal.ts(shells.ts) | 保留 | 按服务端平台探测 |
| terminal:create | invoke | `TerminalCreateOptions` | `{id}` | services/terminal.ts | 保留 | PTY 宿主改 child_process.fork(plan §4.2);不可预测 id + ownerConnectionId |
| terminal:input | send | id, data | — | services/terminal.ts | **改 WS 上行 send** | 校验归属;单次 ≤16 KiB;断线不重放 |
| terminal:resize | send | id, cols, rows | — | services/terminal.ts | **改 WS 上行 send** | 限频、正整数行列 |
| terminal:dispose | send | id | — | services/terminal.ts | **改 WS 上行 send** | WS 关闭/登出服务端兜底回收 |

### git(24)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| git:available | invoke | — | `GitAvailable` | services/git.ts | 保留 | |
| git:status | invoke | dir | `GitStatus` | services/git.ts | 保留 | |
| git:diff | invoke | dir, path, opts | `GitDiffLine[]` | services/git.ts | 保留 | |
| git:stage | invoke | dir, paths | `GitOpResult` | services/git.ts | 保留 | |
| git:unstage | invoke | dir, paths | `GitOpResult` | services/git.ts | 保留 | |
| git:discard | invoke | dir, tracked, untracked | `GitOpResult` | services/git.ts | 保留 | 破坏性,UI 先确认 |
| git:commit | invoke | dir, message | `GitOpResult` | services/git.ts | 保留 | 服务账号身份/凭据(plan §11.2) |
| git:set-config | invoke | dir, name, email, global | `GitOpResult` | services/git.ts | 保留 | |
| git:branches | invoke | dir | `GitBranch[]` | services/git.ts | 保留 | |
| git:checkout | invoke | dir, ref | `GitOpResult` | services/git.ts | 保留 | |
| git:create-branch | invoke | dir, name, checkout | `GitOpResult` | services/git.ts | 保留 | |
| git:checkout-remote | invoke | dir, remoteRef | `GitOpResult` | services/git.ts | 保留 | |
| git:merge | invoke | dir, ref | `GitOpResult` | services/git.ts | 保留 | |
| git:merge-abort | invoke | dir | `GitOpResult` | services/git.ts | 保留 | |
| git:delete-branch | invoke | dir, name, force | `GitOpResult` | services/git.ts | 保留 | |
| git:rename-branch | invoke | dir, oldName, newName | `GitOpResult` | services/git.ts | 保留 | |
| git:delete-remote-branch | invoke | dir, remote, branch | `GitOpResult` | services/git.ts | 保留 | |
| git:log | invoke | dir, depth? | `GitCommit[]` | services/git.ts | 保留 | |
| git:init | invoke | dir | `GitOpResult` | services/git.ts | 保留 | |
| git:fetch | invoke | dir | `GitOpResult` | services/git.ts | 保留 | |
| git:pull | invoke | dir | `GitOpResult` | services/git.ts | 保留 | |
| git:push | invoke | dir, setUpstreamBranch | `GitOpResult` | services/git.ts | 保留 | |
| git:generate-commit-message | invoke | dir, model, locale, reqId? | `GitGenerateResult` | services/git.ts | 保留 | e.sender 语义改 InvokeEvent 定向推送;连接销毁即取消(plan §3.2) |
| git:cancel-commit-message | invoke | reqId | boolean | services/git.ts | 保留 | |

### tasks(8)/ clipboard(2)/ deliverables(4)/ update(4)/ remote(10)

| 通道 | 类型 | 参数 | 返回/事件 | 主进程实现 | Web 去向 | 备注 |
|---|---|---|---|---|---|---|
| tasks:list | invoke | — | `TaskRecord[]` | services/tasks.ts | 保留 | |
| tasks:get | invoke | id | `TaskRecord \| null` | services/tasks.ts | 保留 | |
| tasks:create | invoke | `TaskCreateInput` | `CreateTaskResult` | services/tasks.ts | 保留 | |
| tasks:update | invoke | `TaskUpdateInput` | `TaskRecord \| null` | services/tasks.ts | 保留 | |
| tasks:delete | invoke | id | `{ok:true}` | services/tasks.ts | 保留 | |
| tasks:set-status | invoke | id, status | `TaskRecord \| null` | services/tasks.ts | 保留 | |
| tasks:run-now | invoke | id | `{ok,reason?,already?}` | services/tasks.ts(scheduler.ts) | 保留 | 副作用操作,requestId 去重 |
| tasks:preview | invoke | schedule, locale, allowPast? | `PreviewScheduleResult` | services/tasks.ts | 保留 | |
| clipboard:read-text | invoke | — | string | services/clipboard.ts | **删除** | 改 `navigator.clipboard.readText`;renderer/src/lib/clipboard.ts 包装,权限拒绝/非安全上下文提示并返回 null |
| clipboard:write-text | invoke | text | `{ok:true}` | services/clipboard.ts | **删除** | 同上(writeText);调用点:ChatFirstShell 工作区菜单/选区复制、DeliverablesCard 复制路径 |
| deliverables:inspect | invoke | sessionId, toolUseId | `DeliverableInfo[]` | services/deliverables.ts | 保留 | |
| deliverables:thumbnail | invoke | sessionId, toolUseId, index | `string\|null` | services/deliverables.ts | 保留 | 缩略图改服务端 sharp 生成(plan §4.3) |
| deliverables:open | invoke | sessionId, toolUseId, index | `{ok}` | services/deliverables.ts | **删除** | 调系统默认应用无意义;改预览/下载直链 `GET /api/files/deliverable?...`(HTML sandbox 静态预览) |
| deliverables:reveal | invoke | sessionId, toolUseId, index | `{ok}` | services/deliverables.ts | **删除** | 文件夹定位改复制服务器路径;DeliverablesCard 按钮已删 |
| update:get-state | invoke | — | `UpdateState` | services/updater.ts | **删除** | 自动更新安装器随桌面链路移除;版本显示改 `__APP_VERSION__`,更新方式=服务器部署 |
| update:check | invoke | — | void | services/updater.ts | **删除** | 同上 |
| update:download | invoke | — | void | services/updater.ts | **删除** | 同上 |
| update:install | invoke | — | void | services/updater.ts | **删除** | 同上;shared/update.ts 已删除(UpdateState 类型未保留——renderer 已无消费者) |
| remote:get-state | invoke | — | `RemoteState` | services/remote/index.ts | 保留 | |
| remote:scan-start | invoke | platform, opts? | `{ok,scanId,qr,...}` | services/remote/index.ts | 保留 | 结果经 remote:scan 定向推回 |
| remote:scan-cancel | invoke | scanId | `{ok:true}` | services/remote/index.ts | 保留 | |
| remote:set-enabled | invoke | id, enabled | `{ok,error?}` | services/remote/index.ts | 保留 | |
| remote:set-reply-mode | invoke | id, mode | `{ok:true}` | services/remote/index.ts | 保留 | |
| remote:set-scope | invoke | id, scope | `{ok:true}` | services/remote/index.ts | 保留 | |
| remote:delete-bot | invoke | id | `{ok:true}` | services/remote/index.ts | 保留 | |
| remote:pair-code | invoke | id | `{code,expiresAt}` | services/remote/index.ts | 保留 | |
| remote:pair-cancel | invoke | id | `{ok:true}` | services/remote/index.ts | 保留 | |
| remote:remove-user | invoke | id, userId | `{ok:true}` | services/remote/index.ts | 保留 | |

## 2. 推送事件(13,ipcRenderer.on)

| 通道 | 参数(负载) | 主进程发送点 | Web 去向 | 备注 |
|---|---|---|---|---|
| chat:event | `ChatEventPayload{turnId,sessionId,event}` | services/chat.ts(chat-bus.ts 出口) | **WS 广播** | 共享状态;P4 增加会话级 seq 供快照恢复 |
| chat:sessions-changed | — | services/chat.ts | **WS 广播** | 触发 listSessions 重拉 |
| mcp:status | `McpServerView` | services/mcp.ts | **WS 广播** | |
| skills:changed | `SkillRecord[]` | services/skills.ts(watcher 防抖) | **WS 广播** | watcher 返回 disposer(plan §4.3) |
| tasks:changed | `TaskRecord[]` | services/tasks.ts | **WS 广播** | |
| tasks:navigate | `{sessionId?,pane?}` | main/index.ts、reply-notify.ts | **WS 广播** | 用户点击后的导航意图,不强迫所有标签页跳页 |
| remote:changed | `RemoteState` | services/remote/index.ts | **WS 广播** | |
| notify(新增) | `DevaNotifyEvent{noticeId,title,body,sessionId?,kind?}` | —(WS 层) | **WS 广播** | plan §6.1:以 noticeId 去重;合并 chat-bus AppNotice(echoesReply)与 platform AppNotice(kind)两形状 |
| terminal:data | `TerminalDataPayload{id,data}` | services/terminal.ts(pty-host 转发) | **WS 定向** | 只发创建它的连接 |
| terminal:exit | `TerminalExitPayload{id,exitCode}` | services/terminal.ts | **WS 定向** | 宿主崩溃补发全部活跃会话 |
| git:commit-gen-delta | reqId, text | services/git.ts | **WS 定向** | 按 reqId/连接定向;连接销毁取消生成 |
| remote:scan | `BotScanEvent` | services/remote/index.ts | **WS 定向** | 只发发起扫码的连接 |
| window:fullscreen | boolean | main/index.ts | **删除** | 浏览器全屏走 DOM 事件;调用点(useTrafficLights)已删 |
| update:state | `UpdateState` | services/updater.ts | **删除** | update:* 一并移除 |

## 3. send 上行(3)与 sendSync(1)

| 通道 | 现传输 | 参数 | 主进程实现 | Web 去向 |
|---|---|---|---|---|
| terminal:input | ipcRenderer.send | id, data | services/terminal.ts | WS `{type:'send',c:'terminal:input',a:[id,data]}` |
| terminal:resize | ipcRenderer.send | id, cols, rows | services/terminal.ts | 同上(限频) |
| terminal:dispose | ipcRenderer.send | id | services/terminal.ts | 同上 |
| config:get-sync | ipcRenderer.sendSync | — | services/config.ts | 删除:`window.__DEVA_BOOTSTRAP__.config` 预取缓存;不允许作为 WS 上行 |

## 4. preload 复述与 main 真源的类型差异(已修正进 api.ts)

| 位置 | preload 复述 | main 真源 | 处置 |
|---|---|---|---|
| ChatStreamEvent `done.stopReason` | `string` | providers/types.ts `StopReason`(7 值联合) | api.ts 采用联合 |
| provider:list-models 返回 `kind` | `string` | providers/types.ts `ErrorKind`(10 值联合) | api.ts 采用联合(`ProviderErrorKind`) |
| notify 负载 | —(桌面无此事件) | chat-bus.ts `AppNotice{echoesReply?}` vs platform.ts `AppNotice{kind?}` | 两形状在 WS 出口合并为 `DevaNotifyEvent{noticeId,kind}`;IM 出口保留 echoesReply |
| config:set | patch(undefined 删键) | services/config.ts 以 undefined 判删 | Web 契约改 `(cleanPatch, unsetKeys)` |
| remote 域别名 | string 直写 | ChannelId/Platform/ReplyMode/ReplyScope/ChannelState | 值域一致,api.ts 直写实类型 |
| 其余 DTO | — | 与 services 定义逐字段一致 | 未发现其它漂移 |

## 5. renderer 处置摘要(本次已实施)

- 11 个文件 preload 类型导入 → `@shared/api`(含两种相对路径深度)。
- 新建 `src/renderer/src/lib/clipboard.ts`(navigator.clipboard 包装,失败提示+返回 null/false);替换 ChatFirstShell 两处、DeliverablesCard 一处 clipboard 调用。
- 删除 `redesign/UpdateSection.tsx` 与其挂载;About 版本号用 `__APP_VERSION__`(env.d.ts 已声明)。
- 删除 ChatFirstShell 的 DragBar(×5)、useTrafficLights/IS_MAC 分支、GeneralPane 托盘设置;ThemeContext 移除 setOverlaySymbolColor;均留 `TODO(P6)` 注释。
- getSync 调用点(ThemeContext/i18n/resizable)改读 `window.__DEVA_BOOTSTRAP__.config`(类型兜底 `?? {}`/try-catch)。
- 删除 fs:reveal-folder 与 deliverables:open/reveal 调用:工作区菜单只留复制路径;DeliverablesCard 打开改 `/api/files/deliverable` 预览直链,「在文件夹中显示」按钮移除。
- 删除 `apps/web/src/preload/`(index.ts、index.d.ts)与 `src/shared/update.ts`(仅 updater/preload 引用;UpdateState 无 renderer 消费者,未并入契约)。
- `env.d.ts` 重写:声明 `__APP_VERSION__`、`window.deva: WindowDevaApi`、`window.__DEVA_BOOTSTRAP__?: DevaBootstrap`。
