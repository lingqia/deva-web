# Deva Web 部署文档

> 状态:模板随 P7 交付,部分章节待实现后补充实测步骤(标注 ⏳)。
> 适用于:Linux x64 服务器、单个 Node 进程、nginx HTTPS 反代、单管理员令牌(见 web-migration-plan.md §0/§11)。

## 1. 目标形态

```text
浏览器 → nginx(443, HTTPS) → 127.0.0.1:7421(Node 单进程 @deva/web)
```

- 应用只监听回环;公网入口只有 nginx。
- 数据根 `DEVA_HOME`(生产示例 `/var/lib/deva`)必须独占:同一目录同时只允许一个服务进程(独占锁,异常遗留锁需人工确认后删除 `<DEVA_HOME>/.deva-web.lock`)。
- 不使用 cluster / 多副本 / 共享 NFS 数据目录。

## 2. 系统要求

| 项 | 要求 |
|---|---|
| OS | Linux x64(Debian/Ubuntu 系示例) |
| Node.js | 22 的受支持补丁版本(如 22.12+);确认绝对路径(示例 `/usr/bin/node`,勿依赖 nvm 交互 shell) |
| pnpm | 10.8.0(仅构建机需要;服务器可用发布归档跳过) |
| Git | 安装并配置服务账号凭据(SSH key / HTTPS 凭据 / known_hosts) |
| Shell | 至少一个可用 shell(bash);PTY 由 `@lydell/node-pty` 提供,若需本地构建准备 python3/make/g++ |
| nginx | 含 HTTPS;证书用 certbot webroot 首签 |

## 3. 安装

⏳ 随发布归档脚本落地(§11.4:归档含构建产物 + package/lock/workspace 元数据,干净环境验证)。源码部署路径:

```bash
# 服务账号与目录
sudo useradd -r -s /usr/sbin/nologin deva
sudo mkdir -p /opt/deva /var/lib/deva /etc/deva
sudo chown deva:deva /var/lib/deva && sudo chmod 700 /var/lib/deva

# 代码
sudo rsync -a --delete <release>/ /opt/deva/current/
cd /opt/deva/current && sudo -u deva pnpm install --frozen-lockfile
sudo -u deva pnpm build   # 产出 apps/web/out/{server,renderer}

# 环境配置
sudo cp deploy/deva-web.env.example /etc/deva/deva-web.env
sudo chmod 600 /etc/deva/deva-web.env
sudoedit /etc/deva/deva-web.env   # 填 DEVA_WEB_TOKEN 等;占位符不替换会拒绝启动

# systemd
sudo cp deploy/deva-web.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now deva-web
```

## 4. 环境变量

见 `deploy/deva-web.env.example` 与计划 §11.1。要点:

- `DEVA_WEB_TOKEN` 所有环境必填(回环上游也不例外);`openssl rand -hex 32` 生成;不进仓库/日志/URL。
- `DEVA_WEB_ORIGIN` 必须与 nginx 对外域名严格一致。
- `DEVA_SECRET_KEY` 不设则使用 `DEVA_HOME/secret.key`(首启生成,0600);**备份必须含主密钥**,否则密钥库不可解密。
- `DEVA_AUTOSTART=0` 用于迁移演练/测试:禁自动调度与自动外连,手动触发不受影响。

## 5. nginx / TLS

- 使用 `deploy/nginx.conf`(复制到 `/etc/nginx/conf.d/deva.conf`,改 server_name/证书路径)。
- 首签流程:先启用仅 HTTP 的 ACME server → `certbot certonly --webroot -w /var/www/deva-acme -d deva.example.com` → 启用完整 HTTPS server → `nginx -t && systemctl reload nginx`。
- 验证:证书续期( dry-run)、7421 无公网入口、WS(/ws)升级与长连接正常。

## 6. Git / MCP 外部环境(服务账号)

- Git 身份:`sudo -u deva git config --global user.name/user.email`;凭据按仓库需要配置(HTTPS 用 credential helper,SSH 用受限 key);`ssh-keyscan` 预置 known_hosts。
- MCP 外部命令的运行时(如 node/python/npx)按 mcp.json 核对安装。
- 无凭据应及时报错(日志可见),不会出现 GUI 登录框。

## 7. 日志与轮转

- 服务日志进 journald:`journalctl -u deva-web`。
- 日志不输出 token、Cookie、API key、迁移包口令(验收项)。
- nginx access_log 使用 `$uri`(不记查询参数);轮转由 logrotate 默认策略覆盖。
- 磁盘:监控 `DEVA_HOME`(对话/媒体/检查点会增长)与备份保留时长。

## 8. 更新与回退

⏳ 按 §11.5 全量落地;流程概要:

1. 新 release 目录独立安装构建(不在运行目录边 pull 边构建),记录 commit/tag/Node/lockfile。
2. 停服务 → 确认锁/子进程释放 → 备份 `DEVA_HOME`、`secret.key`、环境配置、工作区必要状态。
3. 需要数据升级时先对副本 dry-run;切换 `/opt/deva/current` 符号链接后启动。
4. 检查 ready/登录/会话/终端/WS/任务/机器人状态与日志。
5. 失败回退:停新版本,恢复旧 release 与对应备份;禁止两个版本并行写同一数据目录。

## 9. 故障排查

| 症状 | 处置 |
|---|---|
| 启动即退出,日志「数据目录已被其他实例占用」 | 确认旧进程已停(`ps`/`journalctl`),删除 `<DEVA_HOME>/.deva-web.lock` 后重启 |
| 启动即退出,「DEVA_WEB_TOKEN 为示例占位值/缺失」 | 填真实 token 到 `/etc/deva/deva-web.env` 并 `systemctl restart` |
| 登录 429 | 失败限流 5 次/分钟/IP;等限流窗口过后重试 |
| 终端无法创建 | 检查 shell 存在、`@lydell/node-pty` 原生模块与构建工具 |
| 机器人/MCP 显示失败但服务可用 | 就绪不含外部连接;按 §4.1 业务状态排查,外部依赖失败不拖垮服务 |
