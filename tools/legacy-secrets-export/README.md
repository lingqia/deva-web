# legacy-secrets-export —— Deva 桌面版密钥一次性迁移工具

把旧 Electron 桌面版(`apps/desktop`,safeStorage:Win DPAPI / macOS Keychain / Linux libsecret)
密钥库**离线**迁移到 Web 版(`apps/web`,AES-256-GCM + `secret.key`)。对应迁移计划
web-migration-plan.md §7.2;操作手册见 `docs/migration-web.md`。

两个模式、同一个入口 `dist/main.js`:

| 模式 | 运行环境 | 作用 |
| --- | --- | --- |
| 导出 | **旧电脑**(原 OS 用户、Electron) | 以旧应用身份解密旧密钥库,输出**加密迁移包**;不输出明文 |
| 导入 | **Web 服务器**(纯 Node,无 Electron) | 解包校验 → 备份目标库 → 按 Web 主密钥重新加密写入;冲突跳过并报告 |

## 为什么必须"原机、原用户、原身份"运行导出

- Windows:DPAPI 密文绑定**原 OS 用户账户**,换用户/换机器解不开。
- macOS/Linux:钥匙环条目按应用身份存储;桌面版 package.json `name=@deva/desktop`
  决定钥匙环条目(`application=@deva/desktop`,见 `apps/desktop/src/main/index.ts` 的注释)。
  本工具导出前会 `app.setName('@deva/desktop')` 对齐该身份;换身份的 Electron 程序
  不保证能读到原钥匙环条目。
- 若原系统/钥匙环已不可用,密文**无法恢复**,不存在任何工具能"破解"safeStorage;
  此时走降级流程:保留旧库备份,在 Web 端逐项重新配置(见 docs/migration-web.md)。

## 导出(旧电脑)

```bash
cd tools/legacy-secrets-export
npm install        # electron 只在旧机器安装(约百 MB 下载)
npm run export -- [--userData <旧userData目录>] [--deva-home <旧DEVA_HOME>] [--out <迁移包.json>]
```

- userData 默认按候选列表自动探测(依次找 `%APPDATA%\@deva\desktop`、`%APPDATA%\deva`、
  `%APPDATA%\Deva`、`%APPDATA%\Electron`;Linux/macOS 同理),取第一个**含 secrets.json**
  的目录;不命中时用 `--userData` 显式指定(目录里应有 secrets.json)。
- 同时扫描旧 `DEVA_HOME`(`--deva-home` 或环境变量 `DEVA_HOME`,默认 `~/.deva`)下的
  secrets.json:旧版曾把 userData 密文原样搬迁过去,一并纳入导出;若发现已是 Web v1 格式
  则跳过并提示(那些条目 Web 端已可直接用)。
- 对旧目录**只读**:工具自身的 Electron userData 被重定向到系统临时目录,绝不写旧目录;
  成功后源文件原样保留。
- 口令:交互输入两次(终端无回显;非终端输入时从 stdin 读两行)。口令不进 argv、
  不落盘、不进日志,也**不要与迁移包同通道传递**(另用口头/独立消息)。
- 迁移包:`deva-secrets-export.json`(`--out` 可改),整包 AES-256-GCM,密钥由口令经
  scrypt(N=2^15, r=8, p=1, 32B)派生;固定 KDF 参数、包 ≤16 MiB、载荷 ≤8 MiB、
  条目 ≤1000、单值 ≤64 KiB,超限一律拒绝。
- 报告只含条目 ID、成败数量与失败分类:`missing`(库/文件缺失)、`corrupt`(非 base64 /
  缺 v10-v11 前缀 / 解密抛错)、`keyring-unavailable`(safeStorage 不可用)。零条目成功时
  不生成迁移包,提示降级流程。

## 导入(Web 服务器,纯 Node)

```bash
# 把 dist/main.js 与迁移包拷到服务器即可,无需 npm install(零运行时依赖,Node >= 20)
node dist/main.js --import deva-secrets-export.json --dry-run   # 先演练
node dist/main.js --import deva-secrets-export.json             # 实际导入
# 可选:--deva-home <目标DEVA_HOME>(默认环境变量 DEVA_HOME,否则 ~/.deva)
```

导入逻辑(纯 Node 实现,同文件内,electron 只在导出模式被 require):

1. 解包校验:格式/版本/KDF 参数/GCM 认证,任一不符即中止;口令错与包损坏都报
   "口令错误或包体被篡改"。
2. 目标主密钥:与 `apps/web/src/main/services/secrets.ts` 同规则 —— `DEVA_SECRET_KEY`
   (64 hex,严格校验,非法即中止)**优先**;否则 `<home>/secret.key`(原始 32 字节,
   兼容 64 hex 文本);都没有且目标无 v1 条目 → 首建 `secret.key`(0600)。
   目标已有 v1 条目但主密钥缺失/全部不配套 → **拒绝导入**(绝不生成新 key 覆盖)。
3. 备份目标 `secrets.json` → `secrets.json.bak-<时间戳>`(0600)。
4. 冲突策略:**跳过并报告,不覆盖**(与目标已有条目同键的一律跳过,含 legacy/损坏条目);
   目标库中的旧 safeStorage 条目原样保留(不丢数据)。
5. 写入:临时文件 + rename 原子替换;输出导入/跳过/失败清单与备份路径。

导入后:重启 Web 服务重新加载密钥库;导入测试期间建议 `DEVA_AUTOSTART=0`(防旧任务
补跑/机器人抢连,见 web-migration-plan.md §7.3)。

## 夹具与单测

```bash
npm test        # 纯 Node 部分:封/拆包往返、错口令/篡改/降级拒绝、信封 AAD、主密钥规则、
                # 目标库解析、导入编排(dry-run/冲突/备份/首建密钥)、参数解析 —— 43 项断言
```

- `fixtures/userdata-legacy/secrets.json`:假旧格式库(拼造的 v10/v11 前缀假密文)。
  在旧机器上可人工验证导出工具的分类报告:
  `npm run build && npx electron . --export --userData fixtures/userdata-legacy`
  → 预期:openai / mcp:legacy-demo:apiToken 报 `corrupt(解密抛错)`,broken-entry 报
  `corrupt(非 base64)`,最终"没有条目解密成功,不生成迁移包"。
- `fixtures/verify-secrets-web.mjs`:Web 端 `secrets.ts` 的行为回归脚本(46 项断言,
  用临时 DEVA_HOME,不碰真实 `~/.deva`),仓库根目录运行:
  `node tools/legacy-secrets-export/fixtures/verify-secrets-web.mjs`。

## 未验证声明(重要)

- 本仓库环境**没有**真实旧桌面安装:纯 Node 逻辑(加密包、导入编排、密钥规则、格式
  兼容)已由 `npm test` 与 `verify-secrets-web.mjs` 覆盖;但 `safeStorage.decryptString`
  对**真实**旧密文的解密能力依赖旧机器的用户/钥匙环/应用身份,只能按上节在旧机器上用
  夹具与真实环境验证。**在删去旧运行链路前必须先完成该验证**(web-migration-plan.md §7.2)。
- `safeStorage` 的 macOS Keychain 与 Linux kwallet/libsecret 分支未在任何真实环境试过,
  Windows DPAPI 亦同;首次实机使用先 `--dry-run` 思路同样适用于导出:先看报告再封包。

## 安全注意事项汇总

1. 原机、原 OS 用户、原应用身份运行导出;不要在不可信机器上输入口令。
2. 迁移包是**加密的**,但仍按敏感件处理:口令与包分通道传递;用完按你的备份策略保留
   或销毁;不要提交进 git(仓库 .gitignore 已排除本目录 `deva-secrets-export*.json`)。
3. 口令不进 argv、不进日志、不落盘;忘记口令 = 迁移包作废(可重新导出)。
4. 成功后**源文件保留**(旧 userData/secrets.json、DEVA_HOME/secrets.json 均未被修改);
   旧密钥库按原备份策略继续保存,直到 Web 端验证通过。
5. Web 服务端不加载 Electron、不提供任何下载主密钥/迁移包的 HTTP 接口;备份服务器时
   `secret.key`(或 DEVA_SECRET_KEY)必须与 secrets.json **配套**一起备份。
