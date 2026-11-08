# Deva Web 功能对齐矩阵(P0 展开)

> 展开 web-migration-plan.md §2 能力表,逐行落到「现有入口文件 → 必须完成的流程 → Web 改造点」。
> 路径约定:`R/` = `apps/web/src/renderer/src`(与桌面版同构复制),`S/` = 主进程服务 `apps/web/src/main/services`,
> `srv/` = Node 服务端 `apps/web/src/server`(P2 起新建)。通道级契约见 docs/web-api-inventory.md。
> 「复用业务」允许改边界/类型,不要求字节不变;不得以空返回或假成功换取编译通过(plan §2)。

| 能力 | 现有入口文件 | 必须完成的流程 | Web 改造点 |
|---|---|---|---|
| 聊天/模型 | R/store/chat.tsx、R/store/models.tsx、R/features/chat/{blocks,Markdown,ModelSetupCard,TaskPickers}.tsx、R/features/settings/{ModelSettings,ModelDetail}.tsx、R/redesign/composer-editor.ts;S/chat.ts、S/compaction.ts、S/model-resolve.ts、providers/* | anthropic/openai/responses 三协议流式;模型探测;思考等级(clampEffort);停止/重试;自动/手动 /compact | 密钥只在服务端解密;流式走 WS chat:event 广播 + 会话 seq;chat:send 以 requestId 去重(plan §5.3);provider:list-models 在服务端发 HTTP;effort 表(shared/effort.ts)原样复用 |
| 会话/交互 | R/store/chat.tsx(状态机+流聚合)、R/redesign/ChatFirstShell.tsx(外壳)、R/features/chat/{Todos,TaskConfirmCard,ScheduleEditor}.tsx;S/chat-store.ts、S/chat.ts | 新建/载入/重命名/归档/删除/删轮;ask_user、计划审阅、挂载卡、角色与定时任务名片;刷新后接上进行中回合 | chat:attach-session 扩为权威快照{serverId,seq,messages,turnId,pendingInteractions}(plan §6.2);pendingAsk/Plan/Mount 补可重建的题目/正文/稳定 key;多端答复先到者生效,interaction_resolved 收敛;runtimesRef.has(sid) 阻止重新 attach 的逻辑修正 |
| 工具/后台任务 | R/features/chat/BackgroundTasks.tsx、R/features/chat/blocks.tsx;S/tools.ts、S/subagents.ts、S/subagent-store.ts、S/todos.ts、S/decision.ts、S/exec-policy.ts | 文件/命令工具;子智能体过程/完成/停止;待办清单;确认卡 | 工具产物(截图/图片)改异步 sharp 链(plan §4.3);后台 Task 卡经 bg 事件广播;命令执行在服务账号权限下,fs-guard 只约束文件/Git API |
| 检查点 | R/redesign/RewindModal.tsx;S/checkpoints.ts | 预览、冲突提示、代码/对话/同时回滚、撤销 | 回滚目标必须是**服务器**工作区受信根;rewind-preview/apply 服务端重算;检查点目标路径迁移按 plan §7.3 映射,未映射禁用执行 |
| 工作区 | R/store/workspace.tsx、R/features/chat/blocks.tsx(fs.openFolder 调用)、R/redesign/ChatFirstShell.tsx(工作区菜单);S/workspace.ts、S/fs-guard.ts、S/listing.ts | 浏览/选择服务器目录、卸载、目录树、文本读取/保存、复制路径 | 新增 fs:browse/fs:trust-root + WebFolderPicker(plan §5.4/§8.2);fs:read-dir/file/write 保留走受信根;「在文件夹中显示」改复制服务器路径(已删 reveal 调用);根目录/盘根/symlink 分隔符判定重测(T14) |
| 附件/头像 | R/redesign/ChatFirstShell.tsx(addFiles/paste)、R/redesign/AvatarEditor.tsx、R/components/humation.tsx;S/attachments.ts、S/avatar-image.ts、S/image-trim.ts | 选择/粘贴/拖入;去重/取消/超限;图片/PDF/文本;头像编辑持久化 | fs:pick-attachments/paste-attachment 保留签名、客户端桥改上传链路;新增 fs:pick-attachments-web(plan §5.4 限额:图 5 MiB/PDF 20 MiB/文本 512 KiB);校验声明 size+魔数,临时目录 mkdtemp,落盘后才登记 |
| 终端 | **渲染层 UI 尚未实现**(桌面 renderer 无 xterm 组件);S/terminal.ts、S/shells.ts、main/pty-host.ts、@xterm/* 依赖已就位 | shell 列表、创建、输入/resize/退出、异常恢复、标签页隔离 | PTY 宿主改 child_process.fork + process.send(plan §4.2);terminal:input/resize/dispose 改 WS 上行 send,data/exit 按连接定向;断线/刷新结束旧终端并提示重建;归属校验防跨页操作(T12/T13) |
| Git | R/redesign/ChatFirstShell.tsx(状态/暂存/提交/分支/CommitModal)、R/store/workspace.tsx;S/git.ts | status/diff、暂存/提交/丢弃、分支/合并/冲突、fetch/pull/push、AI 提交信息及取消 | git:generate-commit-message 按 reqId 定向推送 delta,连接销毁取消并清监听(plan §3.2);凭据在服务账号下配置;git.path 配置沿用 |
| 角色/资料/记忆 | R/store/extensions.tsx(角色)、R/redesign/ProfilePanel.tsx、R/redesign/memory-editor.ts、R/redesign/AvatarEditor.tsx、R/components/humation.tsx;S/personas.ts、S/profile.ts、S/memory.ts、S/default-personas.ts、S/deva-personas.ts | 角色种子/CRUD/排序/头像;用户资料;全局/项目记忆 | ensureSeededPersonas/pruneOrphanExtRoles 保留在服务端启动序(plan §4.1);项目记忆键按 realpath 重算,迁移留双份防丢(plan §7.3);头像 data URI 经上传落盘,渲染层 CSP 禁 file: |
| 技能 | R/store/extensions.tsx;S/skills.ts、S/frontmatter.ts | md/zip 导入、启停、角色作用域、目录监听、删除与恢复 | skills:import 客户端桥改文件上传 → skills:import-web(解压前查预算,拒 zip-slip/炸弹,plan §5.4);删除改 DEVA_HOME/trash/skills/ 真实回收+可恢复;watcher 返回 disposer;skills:changed WS 广播 |
| MCP | R/store/extensions.tsx;S/mcp.ts、S/mcp-config.ts | 配置/密钥、自动连接/重试、现有传输、工具/图片结果、退出清理 | 连接/spawn/解密全在服务端;mcp:status WS 广播;图片结果并入异步 sharp 链(plan §1.2);密钥迁 AES-GCM 库;shutdown await 断开(plan §4.1) |
| 自动任务 | R/store/tasks.tsx、R/features/chat/{TaskConfirmCard,ScheduleEditor,schedule.ts}.tsx、R/redesign/ChatFirstShell.tsx(Tasks 标签);S/tasks.ts、S/tasks-types.ts、S/scheduler.ts、S/schedule.ts | 创建/编辑/暂停/删除/立即运行;时区;启动补跑;退避;历史;关闭页面继续执行 | 调度器在服务端独立于浏览器运行;tasks:run-now 以 requestId 去重;stopScheduler 补齐未清状态(plan §4.1);tasks:changed 广播、tasks:navigate 仅作导航意图;补跑核对 IM 通知不重复(plan §8.2) |
| 飞书/Telegram | R/redesign/BotsPane.tsx、assets/platforms/*.svg;S/remote/*(index、hub、feishu、telegram) | 扫码、配对/取消、启停/删除、作用域、收发、流式/最终回复 | net.fetch 改 Node fetch,出网方式文档化(plan §4.3);remote:scan 定向推送、remote:changed 广播;reply-notify 改输出 Web 通知数据,不再操作窗口焦点;退出停机断开连接(T21) |
| 交付物 | R/features/chat/DeliverablesCard.tsx;S/deliverables.ts、S/media-store.ts | 清单、缩略图/图标、预览/下载、复制服务器路径、丢失提示 | deliverables:open/reveal 已删:预览/下载走 `GET /api/files/deliverable`(P6),HTML/SVG 走 CSP sandbox 静态预览(plan §5.4);缩略图服务端 sharp;复制服务器路径(navigator.clipboard);新记录存 canonicalPath 防链接替换绕权(T22) |
| 设置/通知 | R/redesign/ProfilePanel.tsx、R/theme/ThemeContext.tsx、R/i18n/{i18n.tsx,messages.ts}、R/redesign/resizable.tsx;S/config.ts、S/reply-notify.ts | 中英文、主题/布局、登录/退出、版本、在线提醒与会话跳转 | 登录前主题/语言只用本地偏好+系统默认,登录后拉配置重新初始化(plan §8.1);config:getSync 改 __DEVA_BOOTSTRAP__ 预取(已实施);window:set-overlay/closeToTray 已删(留 TODO(P6));notify WS 广播+浏览器通知授权、noticeId 去重;版本显示 __APP_VERSION__,更新改为服务器部署 |
| 桌面专属(全删) | main/index.ts(托盘/单例/红绿灯)、S/tray-icon.ts、S/appimage.ts、S/portable.ts、S/updater.ts、R/redesign/UpdateSection.tsx | — | 托盘、最小化/关窗、titleBarOverlay、自动更新安装器、AppImage 集成、便携通知注册、原生对话框全部移除;页面无效入口已删(DragBar/useTrafficLights/UpdateSection/托盘设置,留 TODO(P6));单实例锁语义改服务端数据目录锁(plan §4.1) |

## 交接注记

1. **终端 UI 是唯一「通道在、界面缺」的能力**:桌面与 Web 的 renderer 均无 xterm 组件,P6 需按本表新建终端面板(标签页隔离 + WS 定向 data/exit)。
2. R/store/chat.tsx 内仍有与 @shared/api 平行的本地结构复述(DisplayMessage/ChatStreamEvent 等),本次按「最小修改」未合并;P4 快照改造时建议以 @shared/api 为单一来源。
3. 所有 `TODO(P6)` 标记点(拖拽区/红绿灯/托盘/技能删除文案)汇总在本表对应行,验收时逐项消号。
