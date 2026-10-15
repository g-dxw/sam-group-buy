# 部署指南

[返回项目首页](../README.md) · [文档目录](README.md)

以下命令均在项目根目录执行。日常备份与恢复见[本地运行与维护](maintenance.md)。

## GitHub Actions 与服务器部署

CI 在 main 推送和 Pull Request 上运行 Node 24 的测试、前端构建和发布包检查。发布包只包含运行代码、前端产物、维护脚本、部署模板及公开文档，排除数据库、授权、环境文件和本地验收资料。

服务器采用独立 Node 24、systemd 单进程和 Nginx HTTPS。目录约定：

- `/srv/apps/sam-group-buy/current`：指向当前版本。
- `releases/<commit>`：编译包及生产依赖。
- `shared/data`：SQLite 和后台密码，部署不会替换。
- `shared/.env`：环境变量，权限 600。
- `shared/home`：服务用户的飞书 CLI 配置与授权，保持私有。
- `shared/backups`：部署前的一致性数据库备份。
- `runtime/node`、`runtime/bin/lark-cli`：独立运行环境。

首次配置由服务器管理员完成：安装 Node 24 与 lark-cli、新建 `sam-group-buy` 服务用户、放入私有数据和环境文件，安装 [ops/sam-group-buy.service](../ops/sam-group-buy.service)，按 [ops/nginx.conf.example](../ops/nginx.conf.example) 配置域名与证书。仅给部署用户重启及查询这一项 systemd 服务的 sudo 权限；GitHub 使用独立部署 SSH 密钥。

`production` GitHub environment 使用这些 Secrets：`DEPLOY_HOST`、`DEPLOY_PORT`（通常 22）、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。主机密钥须在可信 SSH 连接核对，不能关闭主机校验。Repository Variables：`DEPLOY_PATH`（默认上述目录）、`DEPLOY_ENABLED=true`（开启 main 推送自动部署）。未开启自动部署时仍可手动运行 `Deploy production`，仅 main 可部署。

部署会重新测试和构建，校验发布包与逐文件 SHA256，安装生产依赖，再备份当前数据库、切换版本、重启并检查本地健康接口。健康检查失败时恢复前一版本；保留当前、前一版本与最近一个版本。共享业务数据始终独立，代码回退不会自动回退数据库。

`npm run package:release` 生成 `.artifacts/sam-group-buy-<commit>.tar.gz` 和相应 manifest。维护环境参考 `.env.example`；生产设置 `HOST=127.0.0.1`、`DATA_DIR=/srv/apps/sam-group-buy/shared/data`、`PUBLIC_BASE_URL=https://你的域名`、`TRUSTED_PROXY_IPS=127.0.0.1,::1` 和 `LARK_CLI_BIN=/srv/apps/sam-group-buy/runtime/bin/lark-cli`。

飞书重新授权应在服务用户身份下执行 CLI，保证网页后台与命令行读取同一份配置；OAuth 链接及二维码只供本人操作，不写入公开仓库或 Actions 日志。

## 发布包中的文档

发布包包含根目录 `README.md`，以及 `doc/` 中明确列入白名单的公开文档，保留文档导航。`doc/验收记录.md` 和未列入白名单的其他文档不进入发布包。新增公开文档时，需要同时更新 `scripts/package-release.mjs` 与 `ops/deploy-release.sh` 的文件白名单。
