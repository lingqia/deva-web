# Deva 桌面版 → Web 版 数据与密钥迁移手册

对应 web-migration-plan.md §7(数据与密钥迁移)。状态标注:

- **[已交付]** 密钥迁移链路:`apps/web/src/main/services/secrets.ts`(Web v1 AES-256-GCM 信封)
  + `tools/legacy-secrets-export`(离线导出/导入工具,独立依赖、不进 pnpm workspace)。
- **[TODO 另一迭代]** 业务数据迁移工具(§7.3:dry-run、路径映射、会话/媒体/检查点等)——
  本手册先给出流程骨架与人工核对清单,工具交付后补全命令。

## 0. 两条铁律(先读)

1. **旧 safeStorage 密文不能直接当 AES 密文。** 桌面版用 Electron safeStorage(Win DPAPI /
   macOS Keychain / Linux libsecret),Web 版用本地主密钥 AES-256-GCM,两者格式完全不兼容。
   Web 端读到旧扁平条目只会标记 legacy 并拒绝解密(绝不尝试当 AES 解),必须经
   `tools/legacy-secrets-export` 导出→导入重新加密。
2. **不能只回退代码继续写新库。** 回退到桌面版时必须同时恢复**匹配的旧程序 + 旧数据 +
   旧加密环境**(§7.3)。Web 写过的 `secrets.json`(v1 格式)交回旧 Electron 会把整个库
   读坏;同理 Web 主密钥 `secret.key` 不要混进旧桌面数据目录。

## 1. 流程总览

```text
[旧电脑] 停旧实例 → 备份(DEVA_HOME + userData + 工作区)
      → 导出密钥(tools/legacy-secrets-export,原机原用户原身份)
      → [传输] 加密迁移包与口令分通道
[服务器] 导入(--dry-run 先行)→ 重启验证 → (失败)回退
```

## 2. 阶段一:旧电脑准备与导出 [已交付]

1. 停止旧桌面实例(锁/子进程释放);**不要**删除或移动旧 userData。
2. 备份:整个 `DEVA_HOME`(默认 `~/.deva`,不只 config.json)、旧 userData
   (`%APPDATA%\@deva\desktop` / `~/.config/@deva\desktop`,见 §7 表格逐项核对)、
   工作区与外部交付文件。**[TODO]** 业务数据备份清单工具化。
3. 导出(在旧 userData 所属的**原 OS 用户**下运行):

   ```bash
   cd tools/legacy-secrets-export
   npm install
   npm run export -- [--userData <旧userData目录>] [--out deva-secrets-export.json]
   ```

4. 检查报告:成功/失败条目 ID 与数量;失败分类 missing / corrupt / keyring-unavailable。
   - 全部或多数 `keyring-unavailable`/`corrupt`:优先排查是否换了用户、未解锁钥匙环、
     指错 userData;**降级流程**:保留旧库备份,记录需在 Web 端重新配置的条目清单
     (报告中的 ID 即清单),Web 端逐项手工重配——禁止宣称无损成功。
5. 先用夹具自检(删旧运行链路之前必须做一次,§7.2.2):
   `npx electron . --export --userData fixtures/userdata-legacy`,预期全部报 corrupt
   且不生成迁移包(夹具是假密文)。

## 3. 阶段二:传输 [流程约定]

1. 迁移包是 AES-256-GCM 加密文件(scrypt 派生,口令交互输入,不进 argv/日志)。
2. **口令与包分通道**:包走文件传输,口令走口头/独立消息。
3. 传输完成后核对:文件大小一致;服务器上 `--dry-run` 能通过解包校验即证明包完好。
4. 迁移包按使用者备份策略保留或销毁;不要提交进 git(工具目录 .gitignore 已排除)。

## 4. 阶段三:导入 [已交付]

```bash
# 服务器上只需 dist/main.js(零运行时依赖,Node>=20)+ 迁移包
DEVA_AUTOSTART=0 node dist/main.js --import deva-secrets-export.json --dry-run
DEVA_AUTOSTART=0 node dist/main.js --import deva-secrets-export.json
```

- `--dry-run`:校验 + 冲突报告,不写盘。核对「将导入/跳过/导出时已失败」三张清单。
- 实际导入:备份目标 `secrets.json` → `secrets.json.bak-<时间戳>`;按 Web 主密钥
  (`DEVA_SECRET_KEY` 优先,否则 `<DEVA_HOME>/secret.key`)重新加密;与目标已有条目
  冲突的键**跳过并报告**(不覆盖);旧 safeStorage 条目原样保留。
- 若 Web 尚未首启过(无 `secret.key`),导入会按同一规则首建主密钥 —— 该 key 必须与
  `secrets.json` **配套备份**。
- `DEVA_AUTOSTART=0` 防止导入测试期间旧任务补跑、机器人双实例抢连接(§7.3)。

## 5. 阶段四:dry-run 与业务数据迁移工具 [TODO 另一迭代]

> 本节为骨架;数据迁移工具(只读 dry-run:统计、缺失文件、路径冲突、拟变更清单)另迭代交付,
> 交付后在此补全命令与输出解读。

- 范围(§7.3 全量核对):config、data/chats(含 sidecar/索引)、media、subagents、
  checkpoints、tasks.json、skills、personas/头像、profile、mcp.json、全局 memory、
  `projects/*/memory`、机器人配置/配对关系。
- 路径映射:同 OS/同路径先演练;Windows→Linux 需显式 `oldRoot→newRoot` 映射,只改已识别的
  结构化路径字段,**不对对话正文/命令/提示词做全局字符串替换**。
- 项目记忆:按旧平台算法定位旧 key,再按目标 realpath 生成新 key;合并冲突保留两份并报告。
- 历史交付物未搬运 → 界面显示"原文件不可用";检查点目标未映射 → 禁用该项执行、保留历史可读。
- 命令/工具路径(MCP 命令、Git/shell 设置)不适配 → 列入待人工配置(见 §7 表格)。

## 6. 阶段五:验证清单

密钥 [已交付可自动核对部分]:

- [ ] `secrets:status` 返回 `available=true`、`legacyCount=0`(全量迁移后);
       若 `legacyCount>0`,报告中的 legacy ID 即"需重新配置"清单。
- [ ] `secrets:list` 覆盖迁移包内全部键:`provider:*`、`mcp:<serverId>:<field>`、
       `remote:<botId>:<field>`(三类都在 secrets 库,§7.1)。
- [ ] 任选一条 provider 密钥发起真实模型请求成功(证明解密链路 OK)。
- [ ] MCP 服务配置页字段读写正常;删除 MCP 服务后 `mcp:<id>:` 前缀条目同步清除。
- [ ] 重启 Web 服务后 `secrets:list` 不变(主密钥持久);`DEVA_HOME` 下存在
       `secret.key`(0600)且与 `secrets.json` 配套。

业务数据 [TODO]:会话列表/正文/媒体引用、任务调度、检查点可读、新检查点可建、
交付物链接可达、项目记忆命中。

## 7. 待人工核对项

| # | 核对项 | 旧值/位置(示例) | 结论/备注 |
| --- | --- | --- | --- |
| 1 | 旧 userData 实际路径(工具候选列表 vs 实际) | `%APPDATA%\@deva\desktop` / `~/.config/@deva/desktop` | TODO:实机填写 |
| 2 | 钥匙环可用性(原用户登录、keyring 已解锁;DPAPI 可用) | `safeStorage.isEncryptionAvailable()` | TODO |
| 3 | 旧 DEVA_HOME 是否存在(`~/.deva/secrets.json` 可能有搬迁副本) | | TODO |
| 4 | 平台与路径映射(Windows→Linux oldRoot→newRoot,逐字段) | `E:\workspace` → `/srv/deva/workspace` | TODO:逐条列出 |
| 5 | MCP 命令路径 / Git、shell 设置在新环境是否有效 | | TODO:列为待人工配置 |
| 6 | `secret.key` 与 `DEVA_SECRET_KEY` 是否有并存冲突(以 env 为准) | | TODO |
| 7 | 备份完整性:DEVA_HOME + userData + secret.key 配套 | | TODO |

## 8. 回退 [流程约定]

1. 回退 = 恢复**匹配的旧程序 + 旧数据 + 旧加密环境**(同一 OS 用户)。旧备份只读保留,
   原始 `secrets.json`(扁平 legacy)未删未改,可直接被旧桌面版读取。
2. **Web 新密文不能直接交回旧 Electron**:v1 格式文件对旧版是乱码,绝不能拷回 userData。
3. **不能只回退代码继续写新库**:若旧程序指向了含 v1 文件的目录,先移走 v1 文件并恢复
   原始 legacy 文件,再启动旧程序。
4. 导入失败的撤销:用导入时生成的 `secrets.json.bak-<时间戳>` 覆盖回去;`secret.key`
   若为导入首建且无其它数据,可一并删除(库内无 v1 数据时无副作用)。
5. 密钥迁移失败不影响回退:旧环境凭据仍在旧密钥库里,从未被修改或删除。
