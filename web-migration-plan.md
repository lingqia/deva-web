# Deva 网页化迁移计划（交接执行版）

> 状态：**已实施（P0–P7 完成并通过本地验证；P8 的 Linux 部署、跨系统迁移演练与外部联调待执行）**。基线：`@deva/desktop 0.1.12`（git 基线快照 621f749）。实施进度与逐项证据见 `docs/validation/web-migration.md`。
>
> 本文是实施和验收依据。新增文件、接口、命令已随 P0–P7 交付；「未验证项」以 docs/validation/web-migration.md 的如实记录为准，不得视为已验证。

执行目标：把现有 Electron 应用迁为 **Node.js 服务端 + React 浏览器前端**，最终移除桌面运行和打包链路，通过裸进程和 nginx HTTPS 反代部署。复用现有业务，完成浏览器必需的边界改造，并提供旧数据迁移、核对和回退方案。

## 0. 执行边界与默认决策

以下沿用原计划目标，并补足交接所需默认值。实施者据此开工；真实域名、服务器账号、旧数据位置在部署前填写。

| 项目 | 本版约定 |
|---|---|
| 用户模型 | 一个管理员/访问令牌，允许多浏览器、多标签页登录并共享业务数据；无注册、角色权限、多租户 |
| 生产环境 | Linux x64、单个 Node 进程、独占本地磁盘上的一个 DEVA_HOME；不使用 cluster、多副本、共享 NFS 数据目录 |
| 版本 | Node.js 22 的受支持补丁版本，与现有 CI 主版本对齐；pnpm 10.8.0。更新 engines/文档，不再以 Node 20 为生产基线 |
| 开发环境 | Windows、Linux；生产原生依赖在 Linux 安装，不能复制 Windows node_modules 上服务器 |
| 浏览器 | 桌面 Chrome/Edge 完整验收，Firefox 核心流程验证；首版不做手机布局、PWA、离线使用 |
| 部署路径 | 独立域名根路径 `/`；首版不支持 `/deva/` 子路径 |
| 工作区 | 目录、文件、Git、终端、MCP 命令作用于**服务器**；浏览器所在电脑的文件经用户选择/粘贴/拖放上传 |
| 页面关闭 | 聊天、后台子任务、自动任务和机器人继续在服务端运行，再次进入时同步状态 |
| 终端 | 属于创建它的连接；首版断线/刷新后结束旧终端，页面提示重新创建；不提供终端保活和输入重放 |
| 通知 | 页面在线时 toast；授权后可用浏览器通知。关闭所有页面后不承诺浏览器推送；现有 IM 通知保留 |
| 交付物 | 浏览器预览/下载、复制服务器路径；HTML 静态预览禁脚本；无调用本机默认应用/服务器文件管理器 |
| 数据 | 非密钥格式尽量沿用；旧密钥需要迁移或重新配置；跨系统绝对路径需要核对，不承诺直接复制目录即可全量使用 |

**完成标准：** 第 9 节所有阶段门禁通过，第 10 节有逐项证据；干净环境可安装、构建、启动；迁移与回退演练完成；另一人可按部署文档独立上线。登录页或聊天单一路径可用不代表完成。

本次不重设现有 Agent 工具权限和自动任务业务规则，不顺带更换模型 SDK、UI 框架或包管理器。技术选择如需偏离本文，提交变更理由、影响和相应验收调整。

## 1. 源码基线与原计划修正

### 1.1 当前项目

- 根目录为 pnpm workspace（`apps/*`、`packages/*`），当前应用在 `apps/desktop`。
- 主入口 `src/main/index.ts`；业务在 `src/main/services/*`，模型协议在 `src/main/providers/*`。
- API 桥在 `src/preload/index.ts`，全局声明在 `index.d.ts`；前端在 `src/renderer/src`。
- 共享模块有 `context.ts`、`effort.ts`、`deliverables.ts`、`update.ts`；迁移不能漏掉 context.ts。
- `.github/workflows/ci.yml` 做类型检查与构建，`release.yml` 打桌面安装包，`pages.yml` 发布整个 docs 目录。
- 当前文件夹没有 `.git`，不能报告已核对的 commit；未发现项目 AGENTS.md、测试文件或 test script。接手人拿到正式仓库后记录 commit 并创建迁移分支。
- 本次是静态源码核对，未安装依赖、运行构建或启动程序。

按当前 preload 中唯一通道名统计：

| 项目 | 数量 |
|---|---:|
| invoke | 131 |
| 推送订阅 on | 13（原计划写 12） |
| send | 3，均为终端输入/resize/dispose |
| sendSync | 1，即 config:get-sync |
| renderer 导入 preload 类型 | 11 个文件，包含两种相对路径深度 |

invoke 分组：chat 27、git 24、remote 10、mcp 9、personas 8、tasks 8、fs 7、skills 6、secrets 5、window 5、deliverables 4、memory 4、update 4、profile 3、clipboard 2、config 2、terminal 2、provider 1。

preload 快照 SHA-256：`55810c93418b9171c9a316093164204db56a215a78d2f2683e98f91b680de693`。P0 应生成逐项 API 清单，记录现有方法/通道、参数、返回值、事件、保留/替换/删除和测试编号。数量用于查漏，不要求 Web 版仍为 131 个通道。

### 1.2 已确认的关键修正

以下源码路径相对于当前 `apps/desktop/src`，迁移后对应 `apps/web/src`。

| 证据 | 必须调整的计划 |
|---|---|
| secrets.ts 用 Electron safeStorage，旧密文绑定 OS 凭据体系 | AES-GCM 不能直接解开旧密文；必须识别格式、迁移或提示重配，不能静默当成空库 |
| pty-host.ts 用 process.parentPort/Electron.MessageEvent；terminal.ts 查找 pty-host.js | 父子两端一起改 Node IPC，统一开发/生产产物位置 |
| image-read.ts 为同步接口；mcp.ts 的 mcpImage/flattenResult 也调用它 | sharp 异步改造必须贯穿 tools 和 MCP 调用链 |
| git.ts 使用 e.sender.send/once/off/isDestroyed | 需要请求所属连接、定向事件和取消处理，不能只有全局广播假窗口 |
| config.ts 用 undefined 删除配置键 | JSON 会丢失该语义；增加显式删除键协议并审计 null/undefined |
| chat:attach-session 仅返回历史和 turnId；pending maps 主要保存 resolve | 刷新/重连必须补全当前输出、未决问答/计划/挂载卡，重新连上 WS 不等于状态恢复 |
| main/index.ts 有单实例锁、角色种子/引用清理、MCP 自动连接 | 服务入口保留这些能力与初始化顺序；锁不能直接删掉 |
| reply-notify.ts/scheduler.ts 操作窗口焦点、显示与点击回调 | 输出通知数据，由浏览器处理可见性和导航 |
| skills.ts 删除等待 shell.trashItem 后返回成功 | 必须真实回收目录，不能 no-op 假成功 |
| skills.ts 先 unzipSync 再检查体积 | Web 上传需在解压前/过程中限额，不能内存耗尽后才拒绝 |
| memory.ts 按真实路径和平台计算 projectMemoryKey | 跨系统/目录迁移需要处理项目记忆映射及历史路径 |
| 根 onlyBuiltDependencies 没有 node-pty | 现有值为 electron、electron-winstaller、esbuild、@parcel/watcher；按实际安装脚本调整 |
| renderer CSP 还允许 https:；Theme/i18n 会写配置；ChatFirstShell 顶层读取 window.deva.platform | 重新设计 CSP、匿名态主题/语言和启动顺序 |
| preload 类型导入分两种深度 | 不能按“14 个同深度文件”机械替换 |

## 2. 功能对齐范围

“复用业务”允许改边界、类型和必要运行态；不要求 chat.ts/tools.ts 字节不变。不得通过删除业务、空返回或假成功达成编译通过。

| 能力 | 必须完成的流程 | 主要入口 |
|---|---|---|
| 聊天/模型 | anthropic/openai/responses、模型探测、思考等级、流式/停止/重试、自动/手动压缩 | chat、providers、provider、compaction |
| 会话/交互 | 新建、载入、重命名、归档、删除/删轮；问答、计划批准/完善/忽略、工作区挂载；刷新后继续处理 | chat-store、chat、store/chat |
| 工具/后台任务 | 文件/命令工具、子智能体过程/完成/停止、待办、角色/任务确认卡 | tools、subagents、todos |
| 检查点 | 预览、冲突提示、代码/对话/同时回滚、撤销，目标必须是正确服务器工作区 | checkpoints、RewindModal |
| 工作区 | 浏览/选择服务器目录、卸载、目录树、文本读取/保存、复制路径 | workspace、fs-guard |
| 附件/头像 | 选择/粘贴/拖入、去重/取消/超限提示、图片/PDF/文本、头像编辑持久化 | attachments、avatar-image、AvatarEditor |
| 终端 | shell 列表、创建、输入/resize/退出、异常恢复，各标签页隔离 | terminal、pty-host、xterm |
| Git | status/diff、暂存/提交/丢弃、分支/合并/冲突、fetch/pull/push、AI 提交信息及取消 | git、ChatFirstShell |
| 角色/资料/记忆 | 角色种子、CRUD/排序/头像、用户资料、全局/项目记忆 | personas、profile、memory |
| 技能 | md/zip 导入、启停、角色作用域、监听、删除与恢复 | skills |
| MCP | 配置/密钥、自动连接/重试、现有传输、工具/图片结果、退出清理 | mcp、mcp-config |
| 自动任务 | 创建/编辑/暂停/删除/立即运行、时区、启动补跑、退避、历史，关闭页面继续执行 | tasks、schedule、scheduler |
| 飞书/Telegram | 扫码、配对/取消、启停/删除、作用域、收发、流式/最终回复 | remote/*、BotsPane |
| 交付物 | 清单、缩略图/图标、预览/下载、复制服务器路径、丢失提示 | deliverables、DeliverablesCard |
| 设置/通知 | 中英文、主题/布局、登录/退出、版本、在线提醒和会话跳转 | theme、i18n、ProfilePanel |

移除桌面专属项：托盘、最小化/关窗、原生标题栏覆盖、自动更新安装器、AppImage 集成、便携通知注册、原生对话框。页面移除无效入口；版本信息保留，更新方式改为服务器部署。

## 3. 工程与适配设计

### 3.1 目标结构

```text
浏览器 React + window.deva
  ├─ HTTP /api/*：请求、上传、下载
  └─ WebSocket /ws：事件、终端 I/O
          │ 同一 Origin
nginx HTTPS → 127.0.0.1:7421
          │
Node 单进程
  ├─ auth / registry / http / ws / 请求上下文
  ├─ 平台桥接 + 原 services/providers
  ├─ 独立 Node PTY 宿主
  └─ DEVA_HOME、服务器工作区、Git、MCP、机器人
```

```text
apps/web/
  package.json
  vite.config.ts
  tsconfig.server.json
  tsconfig.web.json
  scripts/build.mjs
  scripts/dev.mjs
  src/server/
    index.ts、registry.ts、http.ts、ws.ts、auth.ts、files.ts
    notify.ts、runtime-state.ts、instance-lock.ts、log.ts
  src/main/
    platform.ts、pty-host.ts
    services/、providers/
  src/shared/
    api.ts、transport.ts、context.ts、effort.ts、deliverables.ts
  src/web/
    deva.ts、transport.ts
  src/renderer/
    index.html
    src/auth/、其余现有组件与 store
  tests/、e2e/
  out/renderer/
  out/server/index.cjs
  out/server/pty-host.cjs
tools/legacy-secrets-export/     # 独立一次性迁移工具
deploy/
  deva-web.service、nginx.conf、deva-web.env.example
docs/
  deploy-web.md、migration-web.md、web-api-inventory.md
  validation/web-migration.md   # 只含脱敏结论
```

文件可合理合并，职责与验收不能省略。

### 3.2 平台边界

采用**显式的小型平台桥接**，不制作全功能 Electron 仿真层：

1. 保留通道注册风格，ipcMain.handle/on 可暂沿用命名，改从 main/platform.ts 导入。
2. 仅推送事件的业务使用最小 UiEventTarget；请求处理器使用 RequestContext，含登录会话、连接、取消信号、定向发送。Git 的 sender 生命周期据此适配，不用 BrowserWindow 强制断言掩盖缺口。
3. home 对应 os.homedir，版本来自构建注入；DEVA_HOME 统一解析成绝对路径。userData 的旧路径处理移至迁移工具。
4. 图片直接用异步 sharp；PTY 用 child_process.fork；通知为结构化事件；原生对话框、shell GUI 调用直接替换。未支持操作明确失败。
5. shared/api.ts 显式定义 DevaApi/DTO，不能 typeof 引用 preload 实现。shared 不引入 Electron、Node 运行时代码或 React 组件。
6. 统一 @shared/*，同步 Vite/tsconfig/esbuild 配置并替换 11 处不同深度导入。Window.deva 放入 renderer 全局类型声明。
7. 服务源码的 Electron 导入全部替换；最终 apps/web 无 Electron 运行依赖、全局类型或桌面启动代码。旧密钥导出工具单独保留必要的旧环境。

### 3.3 构建与依赖

- apps/desktop → apps/web，包名 @deva/web；迁移期间版本沿用 0.1.12，正式发版另按仓库规则确定。
- 根 scripts 切换到新包，交付 dev/build/start/typecheck/test/test:e2e；删除 package:win/mac/linux。更新 lockfile，验证 frozen-lockfile。
- 删除 electron、electron-builder、electron-vite、electron-updater、electron-toolkit 依赖。新增 express、ws、sharp、mime-types、对应类型及统一参数校验方案（默认 zod）。
- esbuild 为构建依赖，Vite/React 保留；测试默认 Vitest + Playwright，选 Node 22 兼容版本。旧密钥导出工具不进入根 workspace 生产安装。
- 审计 onlyBuiltDependencies 的实际安装需求；保留 esbuild，允许确实需要的 sharp/PTY 构建脚本。@lydell/node-pty 与 node-pty 不是同一包，不能按猜测配置。
- .npmrc 移除 Electron 专用镜像项/过期注释；不顺带改变 registry 和 hoisted 策略，除非验证证明需要。
- tsconfig 不再继承 electron-toolkit，server 用 Node 类型，web 用 DOM/Vite 类型；两个配置真正覆盖各自源码，不能只运行空项目 tsc。
- build.mjs 构建 Vite 和两个 esbuild 入口，Node/CJS，输出 index.cjs、pty-host.cjs；运行时包 external（可使用 packages:external），保留 SDK 动态资源与原生平台依赖。
- PTY 路径相对服务端产物定位。dev 也先构建同形态双入口，再运行 Node；dev.mjs 管理监听、成功构建后重启、Vite 及所有子进程退出。
- Vite root=src/renderer，输出明确到包目录 out/renderer；服务端与前端不能互相清空输出目录。Vite 代理 /api、/ws，浏览器保持同源。
- __APP_VERSION__ 两端同源；打包后的 getVersion 不依赖不存在的相对 package.json。静态根只允许 out/renderer，不暴露 server/source map/源码/配置/数据/node_modules。
- 删除桌面构建配置、入口和专用脚本前完成 API 清单及旧密钥导出方案；保留必要品牌素材，不留下 README 失效图片引用。

实施后的标准命令：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

start 必须在环境变量齐全后执行；缺配置应失败，不能为启动方便绕过鉴权。

## 4. 服务端生命周期与系统能力

### 4.1 启动与停止

启动严格按顺序：

1. 校验 token、origin、host/port、密钥格式；规范化 DEVA_HOME，实际检查目录可读写。
2. 获取该数据目录的原子独占锁，记录随机 ownerId、PID、主机；释放核对 ownerId。不同端口访问同一目录也要拒绝，不能用端口占用代替锁。
3. 数据/密钥预检；旧密文、丢失主密钥、损坏数据、未完成迁移明确失败，不得先开机器人/任务/清扫。
4. 初始化 config/密钥，ensureSeededPersonas、pruneOrphanExtRoles；注册全部业务，chat 先于 remote。
5. 启动 HTTP/WS、状态快照、技能监听、MCP 自动连接、机器人和调度器；保留 checkpoints/subagents/media 清扫。
6. 基础就绪后 readiness 成功；外部 MCP/机器人失败显示业务状态，不拖垮整个服务。
7. 新增 DEVA_AUTOSTART=0 供迁移演练/测试：禁自动调度和自动外连；手动触发保持明确可用的行为，不能因未启动 scheduler 丢掉 run-now 绑定。

异常遗留锁不自动抢夺；文档提供确认旧进程已停后的清锁步骤，测试正常释放及崩溃恢复。本版不支持多个进程共享数据目录。

幂等 shutdown 处理 SIGINT/SIGTERM、dev 重启和启动失败：

- readiness 失败，拒绝新业务变更（503）；停 scheduler、首个延时 tick 和未启动队列。现有 stopScheduler 尚未清完这些状态，需补齐。
- settleActiveTurns(3000) 中止并收尾，处理未决交互、必要写盘；记录中断的任务结果。
- await 断开 MCP、停止机器人/扫码、关闭 watcher 和定时器；结束 PTY/宿主及应用所属子进程。
- 关闭 WS，限时排空 HTTP，最后释放锁。总预算默认 20 秒，systemd 留 30 秒；超时有明确日志和非成功退出状态。
- 不直接 process.exit(0) 跳过清理；关闭页面只结束连接，不停止服务。

### 4.2 PTY

- 宿主改 process.on('message')/process.send，父进程用 child_process.fork；去掉 Electron.MessageEvent/parentPort。
- 定义 ready/create/input/resize/dispose/data/exit；宿主实际 ready 后处理有界排队，spawn 事件不能代替 ready。
- 终端用不可预测 ID，记录 ownerConnectionId，输入/resize/dispose 校验归属，输出定向发送。
- 校验 shellId、目录、有限正整数行列、输入长度；客户端不直接指定任意 shell 可执行路径。
- WS 关闭/登出回收该连接 PTY，宿主崩溃补发退出，下次可新建。断线不缓存或重放输入。
- Linux 验证中文、ANSI、Ctrl-C、resize、exit、大输出、缺 shell、宿主崩溃；Windows 开发另测 PowerShell。

### 4.3 图片、技能与网络

- prepareImage 改 Promise，保持魔数、长边 1568px、发送字节上限、JPEG 降质与错误语义；增加像素/解码并发限制。
- tools 图片路径及 MCP 的 mcpImage → flattenResult → dispatchMcpTool 完整 await，保留图片数量上限。
- 交付物图片缩略图用 sharp；PDF/Office/视频回退现有图标体系的类型图标，不为缩略图增加 Office/视频服务依赖。
- skills 删除移动到 DEVA_HOME/trash/skills/<时间-随机标识>/，保存恢复元数据；移动成功才更新配置。提供手动恢复步骤，不默默永久删除。
- skills watcher 返回 disposer；导入用专属临时目录，finally 清理，md 也检查体积。
- Telegram net.fetch 改 Node fetch 后不再继承 Chromium 系统代理。文档注明出网方式；如支持代理，分别验证模型 HTTP、Telegram、MCP 和飞书 SDK 长连接，不能只设环境变量就宣称全部有效。
- Git/MCP/机器人在服务器服务账号下使用凭据和命令环境；浏览器不承担这些服务请求，也不获取解密后的业务密钥。

## 5. HTTP、鉴权、文件协议

### 5.1 路由

| 路由 | 权限 | 行为 |
|---|---|---|
| GET /、前端静态资源 | 公开 | 页面壳；HTML no-cache，hash 资源 immutable |
| GET /api/health | 公开 | 仅 {ok:true}，不含配置和内部状态 |
| GET /api/ready | 公开 | 就绪 200，启动/停机 503，不含内部异常 |
| GET /api/auth/me | 检查会话 | 有效 200，无效 401，no-store |
| POST /api/login | 限流、来源检查 | {token}，成功设会话 Cookie；失败 401，限流 429 |
| POST /api/logout | 登录、来源检查 | 撤销当前登录会话、清 Cookie、关闭其全部 WS |
| GET /api/config | 登录 | 启动配置快照，no-store，不含认证/加密秘密 |
| POST /api/invoke/:channel | 登录、来源检查 | 仅分发白名单 invoke，并按通道校验 |
| GET /api/files/raw?path=... | 登录 | 受信根内普通文件，见 5.4 |
| GET /api/files/deliverable?sessionId=...&toolUseId=...&index=... | 登录 | 路径由交付记录决定，禁止客户端覆盖 |
| GET /ws Upgrade | Cookie、精确 Origin | HTTP 拒绝非法握手，通过后按第 6 节通信 |

未知 /api 返回 JSON 404；非 GET 不走 SPA fallback；/ws 非升级请求明确失败。静态服务不能暴露源码、数据或任意服务器路径。

### 5.2 登录会话与来源

1. **所有模式必须配置 DEVA_WEB_TOKEN**，包括 nginx 反代的 127.0.0.1 上游。空值/示例占位值拒绝启动；部署使用至少 32 随机字节，示例为 64 位 hex。
2. token 以固定长度摘要 timingSafeEqual 比较，不进入 URL、日志、前端配置、localStorage 或 Cookie。表单值只短暂存在 JS 内存，提交后清理。
3. Cookie 存独立生成的高熵 sessionId；服务端只存其 hash、时间、当前 token 版本指纹。持久化到受保护的 DEVA_HOME/web-sessions.json，使正常重启后仍可保持登录。
4. Cookie：HttpOnly、SameSite=Lax、Path=/、不设置 Domain、默认 30 天；生产 Secure。开发 localhost HTTP 单独允许非 Secure，不能依据任意 X-Forwarded-Proto 降级。
5. 换 token 后旧会话全部失效；登出/到期/轮换同时撤销相关 WS 和连接临时操作。单端登出不误删后台聊天或自动任务。
6. 所有 POST（含 login/logout）要求 JSON、X-Deva-Client:1 和精确允许的 Origin；不开放通配 CORS。生产来源固定为 DEVA_WEB_ORIGIN，开发固定 Vite origin。
7. WS Origin 按完整 HTTP(S) scheme/host/port 比较；缺失、null、不匹配拒绝。不能仅比较可伪造的 Host。
8. 默认不信任代理头；生产仅信任明确的本机 nginx 路径，并由 nginx 覆盖转发头。不能 trust proxy=true 无条件放行。
9. 登录默认每 IP 每分钟最多 5 次失败，超限 429 + Retry-After；附总流量限额与有界过期清理。代理后按可信真实 IP 限流。
10. 握手前鉴权失败使用 HTTP 401/403；**4401 仅是已建立 WS 的关闭码，不能作为升级拒绝的 HTTP 状态**。浏览器握手失败后查询 auth/me，区分过期与断网；连接心跳同步检查会话有效期。

单管理员能执行 shell，实际权限是服务账号权限。fs-guard 只约束相关文件/Git API，现有 Agent 工具并不全面受它限制，不能把它宣传为全应用沙箱。

### 5.3 Invoke 契约

```json
{ "v": 1, "requestId": "随机请求标识", "args": [] }
```

```json
{ "ok": true, "result": { "example": "业务结果" }, "requestId": "同一标识" }
```

```json
{ "ok": false, "error": { "code": "INVALID_ARGUMENT", "message": "可展示说明" }, "requestId": "同一标识" }
```

- 外层 ok 表示传输/调度成功；原 handler 的 {ok:false,reason:...} 保留在 result 内，不能混淆业务错误。
- 400/401/403/404/409/413/429/503/500 对应参数、未登录、禁止、未知资源、冲突、超限、限流、不可用、内部错误；响应不泄露堆栈/密钥/进程环境。
- args 逐通道验证数量、类型、长度、枚举、ID、路径和危险键；不把所有已注册 handle/on 自动暴露。
- 普通 JSON 上限默认 8 MiB；仅附件/技能上传放宽到 40 MiB，并验证解码大小。鉴权/来源检查先于大 body 解析，login 单独小限额。
- config.set(patch) 转为 config:set(cleanPatch, unsetKeys)，显式删除顶层键；写成功更新启动缓存，变化通知其它端重新拉取。
- 附件 Uint8Array 明确编码为 base64，不接收 JSON 数字键对象；审计可选位置参数从 undefined 变成 null 的行为。
- 无返回值统一编码为 null，客户端适配 Promise<void>；DTO 不传 Date/Buffer/Error/Map 等对象。
- 自动重试仅用于安全读操作。chat:send、tasks:run-now 等副作用操作用 requestId 在同一登录会话内去重；覆盖执行中与短期已完成结果，默认保留 15 分钟并有界清理。
- 响应丢失时先查状态，不盲目重复发送/提交/执行；服务崩溃后不承诺 exactly-once，UI 显示结果待确认。
- 实时相关请求携带服务端 hello 分配的连接标识，服务端验证它属于当前 Cookie 会话；标识本身不是授权。
- fetch 取消不等于业务取消；聊天仍用 chat:abort，Git 生成仍有自身取消入口，UI 区分连接失败与执行失败。

### 5.4 目录、上传和文件

**服务器目录选择**

- 新增 fs:browse({path?,cursor?}) → {current,parent,entries,nextCursor?}，不递归，单页最多 500 项；选择根之前允许浏览服务账号有权限的目录。
- Linux 从主目录/根导航，Windows 开发环境列盘符；parent 由服务器计算，支持正常向上导航。
- fs:trust-root({path}) 验证绝对路径、存在/可读目录、真实路径；用户点击“选择此服务器目录”后登记，返回 {path,name}。
- 处理 NUL、非法编码、盘符/UNC 和相对输入；不能仅禁止 .. 字符。读取目标 realpath 失败时拒绝，不静默退回字符串前缀。
- 文件/Git 继续走受信根；重启后根据有效的已挂载工作区重新建立必要授权，缺失目录提示重选，不自动信任任意配置字符串。
- 修正根目录分隔符比较，覆盖 Linux 根、Windows 盘根、兄弟前缀、symlink/junction；现有 root+sep 判断不能未经测试沿用。

**附件与技能上传**

- 选择/粘贴/拖放走统一链路；取消选择 resolve 空结果。图片 5 MiB、PDF 20 MiB、文本 512 KiB；工具 read_file 的 20 MiB 图片源限制是另一项规则。
- 校验声明 size、实际字节、扩展名和必要魔数；清洗双平台分隔符，用户只能传名称/内容，不能指定服务器落盘路径。
- 临时文件放在当前 DEVA_HOME 的实例专属目录或 mkdtemp；不能清理系统所有进程共用的 deva-paste。
- 落盘成功后才登记白名单/去重结果；并发同内容上传共享完成结果。清扫不能与首笔上传竞争；重启后未发送附件失效要提示重新上传。
- 设置上传并发、累计临时空间、过期清理上限；错误/取消清理临时文件，UI 保留逐文件失败原因。
- skills:import-web({name,dataBase64}) 复用导入；zip 上传默认 20 MiB，展开总量 20 MiB、单文件 10 MiB、最多 200 个文件。
- 解压前/过程中检查整个归档预算（包括忽略目录），拒绝 zip-slip、symlink、解压炸弹；md 同样限额，不能先 unzipSync 大量分配再检查。

**预览与下载**

- raw：受信根内普通文件，路径/真实目标/类型均在服务器检查；拒绝目录、设备、管道、socket。
- deliverable：复用/导出 deliveredPath，校验 sessionId/toolUseId/index 与 present_files 记录。交付物可以位于工作区之外，不能简单加 trusted-root 导致既有功能失效。
- 下载时重新校验真实目标；新交付记录保存必要的 canonicalPath，避免链接被替换后绕过授权。旧记录保守兼容，无法安全定位时明确拒绝；inspect 结果不能替代下载校验。
- 图片/PDF 内联、HTML 独立静态预览，其余允许类型下载；类型映射固定，未允许类型按业务规则拒绝，不执行文件。
- HTML/SVG 等主动内容用 HTTP CSP sandbox：禁脚本/表单/同源权限/外部网络/框架嵌入，HTML 可用内联样式和 data 图片；首版不提供任意相对资源或脚本运行开关。
- 返回正确 Content-Type、nosniff、private/no-store、安全 Content-Disposition（含中文 filename*）；文件错误不能返回 SPA。
- 流式读文件，处理断连关闭、HEAD、单段 Range/206/416；大文件不整体 base64 化。文本编辑 2 MiB 上限与下载限制分开。
- 新标签页通过用户点击打开，noopener/noreferrer，参数编码，URL 无 token；缺失文件/登录过期有可理解的错误页。

## 6. WebSocket、状态恢复与多标签页

### 6.1 协议与路由

一个页面只持有一个 WS。信封示例：

```json
{ "v": 1, "type": "hello", "serverId": "本次启动标识", "connectionId": "服务端生成" }
```

```json
{ "v": 1, "type": "event", "stream": "chat:会话ID", "seq": 42, "c": "chat:event", "a": [] }
```

```json
{ "v": 1, "type": "send", "c": "terminal:input", "a": ["终端ID", "输入"] }
```

- 消息有版本/schema；上行最多 64 KiB，单次终端输入 16 KiB，resize 限频，未知通道拒绝。
- chat:event/chat:sessions-changed/mcp:status/skills:changed/tasks:changed/remote:changed 为共享状态；git:commit-gen-delta、terminal:data/exit、remote:scan 按归属定向发送。
- tasks:navigate 是用户点击后的导航意图；后台任务完成不能强迫所有标签页跳页。新增 notify 包含 noticeId/title/body/sessionId/kind。
- 删除网络 update:state/window:fullscreen；浏览器全屏用 DOM 事件。config:get-sync 不允许作为 WS 上行。
- 上行只开放三种终端 send 和明确的协议控制消息，不能成为任意 invoke 通道。
- 先安装监听、收到 hello、完成状态同步，再启用依赖实时输出的操作；处理 HTTP 响应前就到达 delta/done 的情况。
- 每 25 秒 ping/pong，超时关闭；重连 1–10 秒带抖动退避。发送队列/字节有界，慢客户端关闭后重新同步，不无限积压内存。

### 6.2 快照恢复

首版采用**权威快照 + 快照序号之后的事件**，无需持久化整个 WS 日志：

1. 服务端每会话维护单调 seq 和展示运行态，统一事件出口先更新状态再发事件；包含当前文本/思考、工具/子任务、turnId、未决交互。
2. 扩展 chat:attach-session（或新增快照接口），返回 {serverId,seq,messages,turnId,pendingInteractions,...}。messages 必须是该序号下完整、无重复的展示状态，不盲拼磁盘历史和当前片段。
3. pendingAsk/Plan/Mount 增加可重建的题目、正文、提示与稳定 key；已处理恢复终态，未处理可继续回答。现有仅保存 resolve 的结构不够。
4. 客户端建立 WS 后缓冲事件，获取快照并替换状态，只应用同 stream、seq 大于快照的事件；丢弃重复、旧 serverId 数据。
5. 快照与 seq 必须一致获取；HTTP 和 WS 到达先后无保证，不能认为“后到的事件一定比快照新”。
6. 断线显示“连接中断，后台任务可能仍在运行”；恢复重取当前/缓存活动会话，其余缓存失效后按需载入。修正现有 runtimesRef.has(sid) 阻止重新 attach 的逻辑。
7. 同步 config、会话列表、todos、tasks、MCP、skills、remote；用版本或同步期间变更缓冲防止旧响应覆盖新状态。
8. 客户端缓冲默认最多 5,000 条或 8 MiB，溢出重新取快照；服务端运行态随结束/删除回收，不复制多份完整历史。
9. 不自动重发消息/命令/确认答复；多端交互保留“先到者生效”，广播 interaction_resolved，其余端展示已处理。
10. 分别验证刷新、网络断线、服务器重启；服务器重启后的活动回合明确中断，利用既有历史修复继续新一轮，不假装仍在运行。

Git 生成按 reqId 定向推送，连接销毁取消并清监听；终端依第 0/4 节结束旧实例，不套聊天恢复策略。

## 7. 数据与密钥迁移

### 7.1 新密钥存储

- DEVA_HOME/secret.key 为随机 32 字节主密钥；可用 DEVA_SECRET_KEY 的 64 hex 覆盖，严格验证长度/编码。权限 0600，数据目录 0700；Windows 开发环境采用当前用户 ACL，不宣称 chmod 提供同等保护。
- 秘钥密文使用有版本的 AES-256-GCM 信封，记录算法、随机 nonce、tag、ciphertext；每条重新生成 nonce，关联存储键作 AAD，防止条目被替换。
- 密钥只在首次空库初始化时创建；若有新格式密文但密钥丢失/错误，启动失败，不生成新 key 覆盖。
- secrets:available 反映实际初始化/可写状态，不能恒 true；has/list 不能把不可解密旧条目报告成可用。
- 秘密写入和会话表更新串行化、临时文件+原子替换；ensureLoaded 用共享初始化 Promise，防止并发首次请求和落盘乱序。
- 主密钥与数据同盘提供静态文件保护，不能抵御已取得服务账号读权限的人；备份必须含配套主密钥，主密钥不回前端。
- provider、mcp:<id>:<field>、remote:<botId>:<field> 都在 secrets 库中，全部纳入迁移。旧 userData/secrets.json 与 DEVA_HOME/secrets.json 都需检查。

### 7.2 旧密钥迁移路径

**需要保留现有凭据时，交付离线导出/导入工具；不能用“重新输入即可”代替无损迁移验收。**

1. 在仍能解密旧密钥的原电脑、原 OS 用户、原 Electron 应用身份/userData/钥匙环环境中运行导出工具。新建不同应用身份的 Electron 程序不保证能读原钥匙环。
2. 工具放 tools/legacy-secrets-export，独立依赖，主进程模式、不启动 renderer/调度器/机器人、不修改源库。必须在删去旧运行链路前用夹具验证。
3. 导出前实际尝试解密并显示成功/失败条目 ID 与数量；缺失、损坏、无法访问钥匙环分别报告，不输出明文。
4. 输出带版本的**加密迁移包**，由交互输入的一次性口令通过 scrypt 派生密钥后 AES-GCM 加密；口令不放命令行参数/日志，包大小和 KDF 参数严格限额。
5. 服务器离线导入时解包校验，备份目标库，按 Web 主密钥重新加密；冲突有显式策略，输出数量/ID 报告。成功后旧源文件保留，迁移包按使用者的备份策略处理。
6. 若原系统/钥匙环已不可用，密文本身无法恢复。提供“保留旧库备份、逐项重新配置”的降级流程，明确记录哪些条目需重配；禁止暗中覆盖或宣称无损成功。

正常运行的 Web 进程不加载 Electron，不提供 HTTP 下载解密密钥/迁移包的接口。

### 7.3 业务数据与路径

- 停止旧实例后备份整个 DEVA_HOME、旧 userData 密钥库、工作区和需要的外部交付文件。不要只备份 config.json。
- 核对 config、data/chats（含 sidecar/索引）、media、subagents、checkpoints、tasks.json、skills、personas/头像、profile、mcp.json、全局 memory、projects/*/memory、机器人配置/配对关系。
- 非秘密格式兼容读取，新增字段可选且有版本；写入前备份。迁移工具提供 dry-run，只读输出统计、缺失文件、路径冲突和拟变更清单。
- 同 OS/同路径与 Windows→Linux 分别演练。跨系统提交显式 oldRoot→newRoot 映射，只改已识别的结构化路径字段；不对对话正文/命令/提示词全局字符串替换。
- 会话 focusRoot、配置的工作区路径、交付记录、检查点目标、MCP 命令路径、Git/shell 设置逐项处理；命令/工具路径不适配时列为待人工配置。
- 项目记忆按旧平台算法定位旧 key，再按目标 realpath 生成新 key；遇合并冲突保留两份并报告，不能覆盖丢失。
- 历史交付物未搬运时显示“原文件不可用”；检查点目标未明确映射时禁用该项执行，保留历史可读。新工作区下新建检查点必须正常工作。
- 导入测试时 DEVA_AUTOSTART=0，避免旧任务补跑、两个机器人实例抢连接或消耗模型额度；核对后再启用。
- 原始备份只读保留；上线失败时恢复**匹配的旧程序+旧数据+旧加密环境**。Web 新密文不能直接交回旧 Electron；不能只回退代码而继续写新库。

## 8. 前端实施要点

### 8.1 启动、登录与过期

启动顺序：

```text
安装 window.deva 客户端桥
→ auth/me
  → 401：挂载 LoginScreen
  → 200：拉 config 缓存 → 建 WS/同步 → 动态导入业务 Provider/App
  → 网络/5xx：可重试的连接错误页
```

- window.deva 必须早于 ChatFirstShell 等模块求值；仅在 main.tsx 后面 await 不足以阻止静态 import 提前读取。
- AuthProvider 为 loading/unauthenticated/authenticated/error；业务 Models/Extensions/Workspace/Chat/Tasks/Profile Providers 只在认证成功后挂载。
- LoginScreen 复用品牌、主题/i18n；令牌 password+显示切换、Enter、loading/防重复；401 无效、429 重试时间、网络错误分别显示。
- 登录前主题/语言只用本地偏好和系统默认，不拉/写私有 config；登录后用服务器配置重新初始化。不能为了主题把整个 config 公共化。
- 登录成功可整页 reload；配置 getSync 读预取缓存，后续 set/失效通知更新它。
- HTTP 401/已建立 WS 的 4401 统一过期处理：停止重连，废弃旧请求结果，关闭连接，卸载业务 store、清敏感内存，显示登录页。403/断网不能误判成密码错误。
- 退出 POST/logout 成功后 reload；同一 Cookie 会话其它标签页同步退出。服务端不可达时明确告知撤销未确认，不能仅清 UI 就显示服务端已退出。
- 生产 UI 不保存访问 token/API key 的持久副本；错误日志不记录登录请求体。

### 8.2 浏览器替代流程

- WebFolderPicker 明确标题“选择服务器目录”，支持路径输入、父级/盘符、分页、加载/无权限/不存在、选择、取消、键盘/焦点管理。
- fs.pickAttachments 与现有粘贴/拖放共用上传实现；不要只改文件选择，漏掉 ChatFirstShell.addFiles 的 Uint8Array。
- skills.import 打开文件选择并上传；取消仍返回原有 cancelled 语义，不能静默空成功。
- 剪贴板通过 navigator.clipboard；权限拒绝/非安全上下文提供手动复制/粘贴入口，不返回空字符串伪装成功。
- “在文件夹中显示”改成真实可用的服务器路径操作，避免和已有“复制路径”重复；相关中英文、图标、tooltip 同步调整。
- DevaApi.platform 保留为浏览器客户端平台（快捷键用）；服务端平台另由元信息提供，shell/path 操作遵循服务端。移除 macOS 红绿灯占位和桌面拖拽区。
- 原生窗口操作/自动更新入口删除；如提供全屏则用 Fullscreen API，失败提示；ThemeContext 不再发送 overlay 调色。
- notify 以 noticeId 去重；页面可见/当前会话时不重复弹系统通知。通知权限由用户点击触发；拒绝时 toast 可用；点击只导航操作的页面。跨标签页协调只弹一次系统通知。
- 保留 scheduler 的 AppNotice 对 IM 的现有出口；回复提醒改造成 Web 事件时避免重复推送机器人。
- 生产 CSP 限定同源 API/WS，保留 UI 必需的 style/data/blob 规则，收紧任意 https:/ws:；开发 HMR 单独配置。HTML 交付物使用更严格的独立 CSP。
- 外链保持 noopener/noreferrer 和安全协议；不恢复 Electron 的任意外部协议打开行为。

## 9. 分阶段执行与交付门禁

每一阶段单独提交可审查的变更，说明修改、验证结果、剩余限制。未通过门禁不得把阶段标为完成；不得只以“编译通过”代替功能验收。角色是交接责任划分，可由同一人承担。

| 阶段 | 依赖 / 责任 | 修改范围与交付物 | 通过标准 |
|---|---|---|---|
| P0 基线与契约 | 无；负责人/后端 | 记录 commit 或源码快照；逐项 API 清单、功能矩阵、协议 DTO；验证旧密钥可导出、Node PTY/ sharp 可运行；登记旧数据/平台 | 131 invoke、13 推送、3 send、1 sync 均有明确去向；旧密钥路线和跨系统限制有证据；记录原版 typecheck/build 结果 |
| P1 工程骨架 | P0；工程/后端 | 重命名包、双入口构建、tsconfig、平台桥、shared API、根 scripts、lockfile；移除桌面构建链路 | 干净安装、typecheck/build；无 Electron 的 Node 环境启动 health；dev 与生产都能找到 PTY 产物 |
| P2 认证与传输 | P1；后端 | HTTP/WS、登录会话、Origin/CSRF、限流、注册白名单、参数校验、错误协议、连接归属 | 未登录/错来源/非法消息被拒；正确会话可调用受控 API；登出/到期使 HTTP 与 WS 同步失效 |
| P3 数据与生命周期 | P0、P1；后端 | 新密钥存储、离线导出/导入、dry-run/路径映射、原子写、独占锁、初始化/停机 | 旧数据副本迁移与回退演练；错密钥不覆盖；双实例被拒；停机无孤儿进程/悬空任务 |
| P4 业务接线与实时恢复 | P2、P3；后端 | 全部服务注册；图片异步链；聊天快照/序号/未决卡；PTY；Git 定向流；通知 | 第 2 节服务能力可调用；流中刷新/断网无缺字重字，未决卡可继续；双标签终端/Git 不串流 |
| P5 浏览器客户端与登录 | P2；前端 | window.deva、动态启动、配置缓存、AuthProvider/LoginScreen、401/退出、i18n/主题 | 登录前无私有请求；登录后 Provider 正常；无顶层 window.deva 读取错误；缓存和退出行为正确 |
| P6 特殊 UI 与业务闭环 | P4、P5；前后端 | 服务器目录选择、附件/技能上传、交付物、剪贴板、通知、移除桌面入口 | 第 2 节逐项功能可操作；上传/取消/错误反馈真实；文件预览/下载与权限规则一致 |
| P7 部署与发布资料 | P3、P6；工程/运维 | nginx/systemd/env 模板、CI/Release、README 中英文、官网说明、迁移/部署文档 | Linux 干净部署；nginx -t；服务账号权限/依赖齐全；更新、重启、回退均可复现 |
| P8 总验收与交接 | P0–P7；独立验收人 | 第 10 节证据、缺陷收敛、版本/环境信息、已知限制、运维交接 | 必测项通过，外部联调有真实证据；未验证项明确标出，不能签为“全量完成” |

P3 的离线迁移工具可在 P2 开发期间推进；P5 在 P2 契约冻结后推进；最终 P4/P6 必须联合验证。协议或数据格式发生变化时同步更新 API 清单、测试和文档，不留两套描述。

执行状态：

- [x] P0 基线与契约（docs/web-api-inventory.md 148 通道逐项去向、docs/web-feature-matrix.md、src/shared/api.ts 契约；PTY/sharp/密钥路线可行性已验证）
- [x] P1 工程骨架（apps/web @deva/web、双入口 esbuild+Vite、platform.ts 平台桥、shared API、根 scripts、lockfile；桌面构建链路已移除，apps/desktop 已删除，历史在 git 基线 621f749）
- [x] P2 认证与传输（HTTP/WS、登录会话、Origin/CSRF、限流、白名单、错误协议、连接归属；401/403/429/4401/1009 实测）
- [x] P3 数据与生命周期（AES-256-GCM 密钥库 46/46、离线导出/导入工具 43/43+往返 PASS、独占锁、初始化/停机序列；dry-run 迁移工具未实现→未验证）
- [x] P4 业务接线与实时恢复（126 通道注册、聊天快照/seq 同源、PTY 连接归属、Git 定向流、通知出口、DEVA_AUTOSTART）
- [x] P5 浏览器客户端与登录（window.deva 桥、动态启动、AuthProvider/LoginScreen、401/退出；9 单测）
- [x] P6 特殊 UI 与业务闭环（WebFolderPicker、fs 上传通道、通知去重/跨标签页、外链加固、桌面入口清理）
- [x] P7 部署与发布资料（deploy/ 模板、docs/deploy-web.md、CI/Release、README 中英、官网部署入口、发布归档）
- [ ] P8 总验收与交接（本地 Windows 验证 V01–V19 已记录；**待执行**：干净 Linux 部署与 T01/T13/T26、跨系统迁移演练 T24、真实外部联调 T08/T21、浏览器全量必测项）

## 10. 验收矩阵与证据

### 10.1 执行方式

- 自动测试使用临时 DEVA_HOME、临时 Git 仓库、受控模型/MCP 假服务；不读取开发者真实 ~/.deva，不发真实 IM 消息，不修改真实工作区。
- 传输测试启动真实 HTTP/WS 服务，验证浏览器可见结果；不只 mock invoke 然后断言调用自身。
- 实时恢复测试注入延迟、丢响应、断线和乱序到达；加密测试覆盖旧/新格式与失败保护；PTY/原生模块必须在目标 Linux 运行。
- 浏览器测试覆盖真实 UI；Chrome/Edge 为完整流程，Firefox 核心流程。测试安装步骤、端口、环境变量写入包脚本/CI。
- 自动测试不依赖付费外部服务。真实模型、真实 MCP、飞书/Telegram 的最终联调使用专门测试账号，由部署方提供凭据和允许收发的测试会话。
- 证据写 docs/validation/web-migration.md：代码版本、日期、OS/Node/pnpm/浏览器、命令、结论、失败/未验证项。日志/截图必须脱敏；原始证据放忽略目录，不能让 pages.yml 发布秘密或用户数据。

### 10.2 必测项

| ID | 操作/场景 | 验收结果 |
|---|---|---|
| T01 构建 | 干净 Linux 安装、typecheck、test、build、start；另验 Windows dev | 命令可复现；前后端完整检查；产物无需 Electron；sharp/PTY 实际可用 |
| T02 启动配置 | 缺 token、占位 token、非法 origin/port、数据目录不可写 | 明确非零失败；回环地址同样不能绕过认证 |
| T03 会话 | 首次访问、错 token、第六次失败尝试、正确登录、刷新、服务重启、退出、轮换 token | 错误/429 正确，Cookie 属性正确，重启保留有效会话；退出/轮换失效且日志无秘密 |
| T04 HTTP 权限 | 未登录访问 config/invoke/raw/deliverable；错 Origin、缺防护头、伪造代理头 | 401/403；不能读写私有数据、伪造 IP 绕过限流或降级 Cookie |
| T05 路由/错误 | 未知 API、非法 args、超 body、业务 ok:false、内部异常 | 正确 JSON/状态码；不回 SPA，不混淆业务失败，不泄露堆栈 |
| T06 WS | 无 Cookie/错 Origin 握手、有效连接到期、非法/超大上行、心跳超时 | HTTP 拒绝或已建立连接关闭；无未授权广播；客户端能区分断网与过期 |
| T07 JSON 兼容 | 删除配置键、可选参数、省略值、上传字节、void 返回 | 与业务语义一致，config.getSync 缓存不陈旧 |
| T08 聊天基础 | 三种模型协议；流式/思考/工具/停止/错误/压缩；会话 CRUD/归档/删轮 | 原功能保持，持久化后可续聊，provider 密钥不回前端 |
| T09 流中恢复 | 首个事件早于 HTTP 响应；回复中刷新；断网 10 秒后重连；同步期间立即 done | 无缺字/重字/卡死；有序恢复到最新状态，不再次发起回合 |
| T10 未决交互 | ask_user/计划/挂载卡出现时刷新或重连；两端同时答复 | 卡可继续操作，稳定 key，只接受一次，其它端收敛到终态 |
| T11 请求去重 | chat:send/tasks:run-now 响应丢失，重复同 requestId；Git 操作网络异常 | 不重复创建/执行；无法确认结果时提示并查询，不盲重试 |
| T12 多端隔离 | 两个标签页分别开 PTY、生成 Git 提交信息、扫码接入；一个退出 | 定向结果不串页；不能操作另一连接终端；撤销会话清理相应资源 |
| T13 终端 | 中文/ANSI/Ctrl-C/resize/exit、大输出、宿主杀死、页面断线 | 输出正确，新建可恢复；旧 PTY 被回收，没有输入重放/孤儿进程 |
| T14 文件路径 | 根目录/盘根、中文空格、兄弟前缀、..、symlink/junction、无权限/已删除路径 | browse 可正常导航；文件/Git/下载越界被拒，错误可理解 |
| T15 上传 | 选择/取消/粘贴/拖放、同名异内容/同内容并发、超限/伪造 size/非法 base64 | 正确去重与限额，落盘后才可发送；错误不假成功，临时空间受控 |
| T16 图片/MCP | 大 PNG/JPEG、GIF/WebP、伪 MIME、损坏/极大像素图片；MCP 图片结果 | 返回真实 MIME，异步链无遗漏，限额生效，不阻塞服务/无限占内存 |
| T17 技能 | md/zip、正常嵌套、zip-slip、symlink/压缩炸弹、缺 SKILL.md、删除/恢复 | 导入有效；恶意/超限拒绝且无越界写；删除实际回收，恢复可用 |
| T18 Git/检查点 | 临时仓库完整 Git 流程，AI 提交取消；回滚预览/冲突/三种模式/撤销 | 服务账号凭据与 Git 正常；路径正确、回滚符合预览、不影响其它目录 |
| T19 资料/记忆 | 角色种子、增删改/排序/头像、用户头像、全局/项目记忆、重启 | 数据保留，不重复种子，不发生两项目记忆错绑 |
| T20 自动任务 | 时区、立即执行、关闭所有页面、停机补跑、失败退避、双实例 | 规则保持，只触发预期次数，历史正确，不因浏览器退出停调度 |
| T21 MCP/机器人 | MCP 配置/密钥/重试/工具；飞书与 Telegram 扫码/配对/收发/范围 | 受控假服务自动验证，加真实测试账号联调；退出不遗留连接/进程 |
| T22 交付物 | 图片/PDF/静态 HTML/下载、中文名、HEAD/Range、记录伪造、文件丢失 | 下载/预览正常；HTML/SVG 脚本、API 访问、表单及 opener 攻击无效 |
| T23 通知/界面 | 中英文/主题、通知允许/拒绝、双标签、浏览器前后台、复制拒绝 | 通知去重/正确跳转，拒绝时有可用退路，无桌面残留入口/空白页 |
| T24 迁移/密钥 | 原环境导出、导入、副本 dry-run、错口令/错 key/丢 key/损坏密文、跨 OS 路径 | 数量/ID 核对，无明文输出或旧库覆盖；路径/记忆正确，无法迁移项明确 |
| T25 并发与资源 | 并发配置/密钥修改、重复启动、慢 WS、多次重连/上传/终端开关 | 无丢写/损坏；锁有效；监听、子进程、临时文件与内存不会持续累积 |
| T26 停机/更新 | 活动回合/等待交互/终端/MCP/机器人并存时 SIGTERM；更新失败回退 | 限时收尾、写盘完整、无孤儿进程；旧版本+旧数据恢复成功 |
| T27 HTTPS 部署 | nginx -t、真实域名 TLS、登录/上传/流式/WS/下载、服务重启 | 全链路通过，Node 仅回环监听，无直连公网后门；证书更新流程清楚 |

禁止将“外部凭据未提供”记为通过；记录为未验证，并由交付双方决定是否只验收本地阶段。所有核心本地门禁应先完成，不因缺少服务器域名停止工程实现。

## 11. 部署、发布与回退资产

### 11.1 环境变量

| 变量 | 默认/要求 |
|---|---|
| NODE_ENV | 正式 start 默认为 production；dev.mjs 显式设置 development |
| DEVA_WEB_TOKEN | 所有环境必填；建议 openssl rand -hex 32 生成，不写入仓库 |
| DEVA_WEB_HOST | 127.0.0.1；生产示例只绑定回环 |
| DEVA_WEB_PORT | 7421 |
| DEVA_WEB_ORIGIN | 必填，生产为完整 https://域名，开发为固定 Vite origin；无路径/查询串 |
| DEVA_TRUST_PROXY | 默认关闭；示例生产只信任回环的单层 nginx，不能无条件信任所有代理 |
| DEVA_HOME | 默认 ~/.deva；生产示例 /var/lib/deva，必须可读写且独占 |
| DEVA_SECRET_KEY | 可选，64 hex；为空时从 DEVA_HOME/secret.key 读取/首建，规则见 7.1 |
| DEVA_AUTOSTART | 默认 1；迁移演练/测试设 0 禁止后台自动连接与调度 |

应用不隐式查找任意工作目录下的 .env。开发环境加载位置由 dev.mjs 明确限定并文档化；生产由 systemd EnvironmentFile 注入。原计划“token 不落盘”和需要重启持久运行存在冲突，本版允许放在仓库外、受限权限的环境文件中，禁止写入业务 config.json。

### 11.2 systemd 模板

交付 deploy/deva-web.service：

```ini
[Unit]
Description=Deva Web
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=deva
Group=deva
WorkingDirectory=/opt/deva/current
Environment=NODE_ENV=production
EnvironmentFile=/etc/deva/deva-web.env
ExecStart=/usr/bin/node /opt/deva/current/apps/web/out/server/index.cjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

- /usr/bin/node 是示例，部署时确认实际绝对路径和版本；不能依赖交互 shell 的 nvm 初始化。
- 创建专用服务账号、/var/lib/deva 和工作区目录，授予必要权限；代码目录/数据目录分开。
- /etc/deva/deva-web.env 由 systemd 读取，示例权限 root:root 0600，填写实际 token/origin/home/proxy 等；样例文件只放占位符，应用拒绝占位 token。
- 安装 Git、可用 shell；PTY 原生构建如需 python3/make/g++，在目标系统准备。MCP 外部命令的运行时另核对。
- Git 身份、SSH/HTTP 凭据、known_hosts 在服务账号下配置并验证；无凭据应及时报错，不能等不可见的 GUI 登录框。
- 确认日志不输出 token、Cookie、API key、迁移包口令。日志轮转、磁盘空间、备份保留由部署文档列出。

### 11.3 nginx 模板

以下放在 nginx 的 http 上下文内（如 conf.d 中）；证书存在后才启用 HTTPS server：

```nginx
map $http_upgrade $deva_connection_upgrade {
    default upgrade;
    '' close;
}

log_format deva '$remote_addr $request_method $uri $status $body_bytes_sent';

server {
    listen 80;
    server_name deva.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/deva-acme;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name deva.example.com;

    ssl_certificate     /etc/letsencrypt/live/deva.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/deva.example.com/privkey.pem;

    client_max_body_size 40m;
    access_log /var/log/nginx/deva-access.log deva;

    location / {
        proxy_pass http://127.0.0.1:7421;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade          $http_upgrade;
        proxy_set_header Connection       $deva_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

- 模板假设只有一层 nginx；X-Forwarded-For 覆盖客户端值。前面还有 CDN/负载均衡时，需重新配置可信代理/IP 限流并验证。
- 首次发证先启用仅 HTTP 的 ACME 配置，使用 certbot webroot 签证；证书存在后安装完整 HTTPS 配置、nginx -t、reload。不能先启用不存在证书的 server 再运行 certbot。
- 所有域名/origin/证书路径必须一致；关闭 7421 的公网入口。测试证书续期与 reload。
- access_log 使用 $uri 不记录查询参数；生产 header/CSP 由应用按页面/API/交付物类别设置，避免 nginx 全局 CSP 与文件预览相冲突。
- optional basic auth 如需启用，另验证 WS/下载；它不能替代应用内鉴权。

### 11.4 CI、发布和文档

- ci.yml：去掉 ELECTRON_SKIP_BINARY_DOWNLOAD；保留 Node 22，执行 frozen install、typecheck、自动测试、build、真实 HTTP/WS/PTY 冒烟；使用临时数据目录。
- release.yml：移除桌面多平台安装器/latest.yml/blockmap；改为 Web 发布材料或明确禁用旧任务，不留下指向 apps/desktop 的发布路径。保留版本一致性检查与审阅习惯。
- 如发布可部署归档，包含构建产物、必要 package/lock/workspace 元数据、部署/迁移说明；在干净 Linux 按归档说明验证生产依赖安装。不能仅打 out 目录就宣称可运行。
- 更新 README.md、README.en.md 的定位、安装/构建、数据位置和更新说明；清理桌面图标失效链接。
- docs/index.html 的桌面下载入口改为 Web 部署说明；Pages 继续只是官网，不能把 Node 应用当作 Pages 站点部署。
- docs/deploy-web.md 覆盖安装、环境变量、服务账号、nginx/TLS、日志、代理、原生依赖、Git/MCP 环境、备份、更新和故障排查。
- docs/migration-web.md 覆盖原环境导出、导入、dry-run、路径/记忆映射、不可恢复场景、验证报告与回退步骤。
- 检查已删除路径、Electron 依赖、preload 引用、桌面 CSS/文案、旧构建脚本；区分迁移说明中的历史引用和运行代码残留。

### 11.5 更新与回退

1. 在独立的新 release 目录安装、构建和检查；记录 commit/tag/Node/lockfile，不能直接在运行目录边 git pull 边构建。
2. 停服务，确认锁/子进程已释放，备份数据、secret.key 或外部密钥管理引用、环境配置与工作区必要状态。
3. 如需数据升级，先对副本 dry-run/验证，再按记录执行；切换 /opt/deva/current 到新版本并启动。
4. 检查 ready、登录、会话/模型、终端、WS、任务/机器人状态，核对日志。
5. 失败则停止新版本，恢复匹配的旧 release 和对应备份；禁止两个版本并行写同一数据目录。
6. 记录切换期间任务补跑和外部副作用；恢复文件备份不能撤回已经发出的 IM 消息、Git 推送或外部命令效果。

## 12. 排期、待填信息与交付包

优先完成 P0 的密钥、PTY、图片和状态恢复可行性验证后再锁定排期。不能沿用原计划“新增 1.5–2.5k 行、一轮迭代完成”的承诺：本次包含独立的数据迁移、实时一致性、测试和运维工作。

供排期参考（非承诺）：P0 约 1–2 人日；P1–P4 约 8–13 人日；P5–P6 约 5–8 人日；P7–P8 约 4–6 人日，合计约 18–29 人日，另为旧钥匙环、跨平台依赖、外部平台联调留缓冲。实际以 P0 结果、人员经验和既有数据规模修订。

部署前由负责人填写：

| 信息 | 待填内容 | 最迟需要阶段 |
|---|---|---|
| 代码基线 | 仓库 URL、commit、迁移分支 | P0 |
| 旧环境 | OS/用户、应用身份、DEVA_HOME/userData、密钥能否解密 | P0/P3 |
| 路径映射 | 旧工作区/交付文件位置 → 新服务器位置 | P3 |
| 服务器 | Linux 发行版/架构、Node 路径、服务账号、工作区目录 | P7 |
| 对外访问 | 域名、DNS、TLS 方式、是否有额外代理 | P7 |
| 联调凭据 | 测试模型/MCP/飞书/Telegram 账号及测试会话，安全交付方式 | P8 |
| 数据保护 | 备份位置、保留时长、回退负责人 | P7/P8 |

最终必须交付：

- [ ] 可构建运行的迁移代码及锁文件，明确版本/基线。
- [ ] 完整 API 去向清单、功能对齐矩阵，没有未说明的删减。
- [ ] 自动测试和浏览器流程测试，可重复执行的临时数据夹具。
- [ ] 旧密钥导出/导入、数据 dry-run/映射工具和脱敏迁移报告。
- [ ] nginx/systemd/env 模板、部署/更新/回退文档。
- [ ] 中英文 README、官网和 CI/Release 同步完成。
- [ ] 逐项验收证据，真实外部联调结论，明确的已知限制。
- [ ] 无真实 token、API key、用户数据、迁移包、私钥进入提交或发布包。

## 13. 可直接复制给实施者的交接说明

> 按仓库根目录 web-migration-plan.md 实施 Deva 网页化迁移。目标为单管理员、Node 服务端+浏览器前端、Linux 裸进程+nginx HTTPS，保留第 2 节全部业务，最终移除桌面运行/打包。
>
> 先做 P0：确认代码基线，生成现有 API 清单，验证旧密钥导出、Node PTY、sharp 和聊天状态恢复。随后按 P1–P8 交付，每阶段附修改范围、验证命令/结果、剩余问题，不把未验证功能写为完成。
>
> 特别遵守：回环也强制鉴权；旧 safeStorage 密文不能直接当 AES 密文；PTY 两端协议一起迁；Git/终端事件按连接归属；刷新后恢复当前输出和未决交互；保留单实例、正常停机、角色初始化和 MCP 自动连接。不得用 no-op/假成功代替文件打开、技能删除或其它业务。
>
> 开发使用临时数据与测试服务。旧数据先备份并在副本演练，域名/账号未提供时先完成本地工程、部署模板和验证，再记录环境待办。最终以第 10 节验收矩阵和第 12 节交付清单为准。
