# Web 迁移验证记录

> 只含脱敏结论(web-migration-plan.md §10.1)。原始日志/截图放忽略目录,不入库。
> 环境基线:Windows 11 x64(开发)· Node v22.16.0 · pnpm 10.8.0 · 迁移分支 migration/web。
> 检查点链:621f749(基线)→ 902e221(P1/P3)→ 2756acf(P0/P1/P2 集成)→ d1548a8(P3)→ 3fff4ec(P4/P5)→ 5723366(波次 2 集成)→ 897e3cb(P7)→ 终版(移除 apps/desktop)。

## 已执行验证(随阶段滚动记录)

| # | 日期 | 验证项 | 命令/方式 | 结论 |
|---|---|---|---|---|
| V01 | 2026-11-04 | 依赖安装(干净 node_modules) | pnpm install(npmmirror,hoisted) | 通过;sharp/esbuild 构建脚本执行;@lydell/node-pty Windows 预编译可用 |
| V02 | 2026-11-04 | PTY 原生模块 Windows 冒烟 | node-pty spawn cmd.exe echo | 输出正确,进程退出码正确 |
| V03 | 2026-11-04 | sharp 冒烟 | 4x4 PNG 生成 | 通过 |
| V04 | 2026-11-04 | 服务端骨架启动 | 临时 DEVA_HOME + 必填 env | health 200、ready 200、未知 API JSON 404、前端未构建 503、路径穿越防护 |
| V05 | 2026-11-04 | 独占锁 | 双启动同 DEVA_HOME | 第二实例拒绝并输出清锁指引;锁文件核对 ownerId 后才释放;崩溃路径(uncaughtException)释放锁 |
| V06 | 2026-11-04 | PTY 宿主协议 E2E | fork out/server/pty-host.cjs + create/input/dispose | ready 探针真实化;data 流回显;dispose→exit;非法 shellId 拒绝(shell-not-allowed) |
| V07 | 2026-11-04 | secrets 存储行为 | tools/legacy-secrets-export/fixtures/verify-secrets-web.mjs | **46/46**:首建 0600/写读/重启持久/错 key 拒绝不覆盖/key 丢失不重生成/legacy 条目识别与保留/AAD 防条目移植/12 并发写/前缀删除/IPC 契约 |
| V08 | 2026-11-04 | 旧密钥迁移工具 | tools/legacy-secrets-export test/run.mjs | **43/43**:封包往返逐字一致/错口令拒绝/导入重加密/冲突跳过/legacy 保留/参数校验/userData 候选含 @deva/desktop;真实钥匙环解密须在原机原环境验证(未验证,见下) |
| V09 | 2026-11-05 | 全量类型检查 | pnpm typecheck(server+web 两 tsconfig) | 0 错误 |
| V10 | 2026-11-05 | 完整构建 | pnpm build(Vite renderer + esbuild index.cjs/pty-host.cjs) | 通过;产物 54.4KB/9.6KB;无 Electron 运行依赖 |
| V11 | 2026-11-05 | HTTP 鉴权与契约 | curl 全链路 | health/静态 200;未登录 invoke 401;错 Origin 403;login→me→invoke(config:get/set)200;业务 ok:false 与传输 ok 分层正确 |
| V12 | 2026-11-05 | WS 握手 | curl upgrade | 无 Cookie 401;合法 Cookie 101+hello(serverId+connectionId) |
| V13 | 2026-11-05 | WS 安全(E 侧实测) | 程序化 WS 客户端 | >64KiB 上行 1009;上行白名单外拒绝;违规 3 次关闭;25s 心跳;logout→该会话全部 WS 4401;会话持久化:重启恢复、换 token 全失效 |
| V14 | 2026-11-05 | 客户端桥单测 | vitest(src/web) | 9/9:信封形状/错误传播/401 快速失败/connectionId/config 缓存+unsetKeys/hello 缓冲/send 形状/4401 停重连/心跳 |
| V15 | 2026-11-05 | 业务接线启动 | 临时 DEVA_HOME 启动日志 | 121 个 invoke 通道注册;chat 先于 remote;清扫与 watcher 就绪;DEVA_AUTOSTART=0 跳过自动连接与调度 tick、run-now 仍可用 |
| V16 | 2026-11-05 | 停机序列 | 进程内注入 SIGTERM 路径 | 7 步有序(调度器→回合收尾→MCP→机器人→PTY→WS→HTTP 排空)→锁释放;幂等;Windows 真实信号留 Linux 验收 |
| V17 | 2026-11-05 | 终端连接归属 | 双 WS 连接程序化 | owner 连接收 data 回显;异主 input 丢弃零泄漏;连接断开回收 PTY、宿主残余事件不误报 |
| V18 | 2026-11-05 | dev 模式双形态 | pnpm dev(esbuild watch + Vite + Node) | 首次构建即拉起服务;业务逐组注册;Vite 代理 /api 全通;PTY 产物同目录定位 |
| V19 | 2026-11-05 | 波次 2 端到端冒烟 | scripts/smoke-e2e.mjs | **10/10**:login→fs:browse(列盘符)→fs:trust-root→files/raw 受信根→chat:snapshot→WS hello(serverId 与快照对齐)→terminal:create(HTTP+connectionId 归属)→WS input→PTY 回显;126 通道注册 |
| V20 | 2026-11-05 | 终版集成(删除 apps/desktop 后) | pnpm typecheck/test/build + smoke-e2e | 0 错误、9/9 单测、构建完成、E2E **10/10**;工作区不再含桌面运行/打包链路(历史见 git 基线 621f749) |
| V21 | 2026-11-05 | 发布归档 | apps/web/scripts/release-archive.mjs | 归档 42 项:out/{server,renderer}+package/lock/workspace/.npmrc+deploy 模板+部署/迁移文档+INSTALL.txt;干净 Linux 按归档安装验证待执行 |

## 待验证(P8 必测项,见计划 §10.2)

- T01 干净 Linux 安装/构建/启动;Windows dev 全流程(dev.mjs)
- T03 登录限流(第 6 次失败 429)/T06 WS 到期断开
- T08/T09 聊天三协议、流中刷新恢复(T10 未决交互)
- T13 终端 Linux 真机(中文/ANSI/Ctrl-C/大输出/宿主崩溃)
- T14 文件路径边界、T15 上传链路、T16 图片/MCP
- T17 技能导入边界(实现已有限额,需实测 zip-slip/炸弹)
- T18 Git 全流程、T20 自动任务(含 DEVA_AUTOSTART=0 补跑)
- T22 交付物 HEAD/Range/伪造、T23 通知双标签
- T24 跨 OS 路径映射迁移演练(dry-run 工具未实现,记为未验证)
- T26 停机(Linux 真实 SIGTERM)、T27 nginx HTTPS 全链路

## 已知限制 / 未验证项(如实记录)

1. **真实钥匙环解密**未验证:legacy-secrets-export 的 Electron 解密路径须在旧电脑原 OS 用户/原应用身份环境运行(README 已声明)。
2. **数据 dry-run 迁移工具**(计划 §7.3)未实现,跨系统路径映射演练未做。
3. Windows 无法真实发 SIGTERM(process.kill 直接 TerminateProcess):停机用同代码路径注入验证;Linux 部署验收补真实信号。
4. registry 逐通道 zod schema 覆盖进行中(未覆盖通道有 X-Deva-Args-Schema 响应头标注)。
5. Playwright e2e 测试套件未建(计划 §10.1 浏览器测试)。
6. 外部联调(真实模型/飞书/Telegram)需部署方提供测试凭据,未执行。
