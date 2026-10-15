# 本地运行与维护

[返回项目首页](../README.md) · [文档目录](README.md)

以下命令均在项目根目录执行。服务器安装和自动部署见[部署指南](deployment.md)。

## 启动与后台登录

需要 Node 24 或更高版本和 npm。山姆查询与本地商品管理无需飞书；启用飞书备份时需要服务器上的 lark-cli 用户身份和目标多维表格读写授权。

```sh
npm ci
npm run build
npm start
```

后台入口：<http://127.0.0.1:3001/admin>。初始密码首次启动时生成，保存在 `.data/admin-initial-password.txt`，不会通过网页接口返回。可在 `.env` 配置至少 8 字符的 `ADMIN_PASSWORD`，重启后生效。后台会话 Cookie 为 HttpOnly，重启后需重新登录。

开发模式：`npm run dev`。前端和 API 共用 3001 端口。验证：`npm test`。

## 旧版数据迁移

旧版第一次启动会先备份配置与提交日志，读取飞书商品、原期次和已完整确认订单，一次性导入 `.data/orders.sqlite`，保留旧链接。存在未确认旧提交或不完整飞书订单时停止迁移，要求先核查；之后启动直接读数据库。

## 备份与恢复

SQLite 保存商品（含来源及图片地址）、实际订单、小区、期次和同步状态，需要保留整个数据目录。飞书商品表是额外的数据副本，不包含整个数据库、后台密码和期次配置，不能代替完整本地备份。服务使用单个 Node 进程，并通过运行锁阻止同目录重复启动。

```sh
# 在线一致性备份数据库，并复制配置与后台密码文件。
npm run backup
# 可指定备份目录。
npm run backup -- /absolute/path/to/private-backup
```

默认备份在 `.data/backups`，含联系方式和后台密码，请保持私有。恢复时先停止服务并保留当前数据，建议把备份数据库及配置放到新的私有目录，使用 `DATA_DIR` 指向该目录后启动，避免混入旧 WAL 文件。建议采购前与集中改单后做一次备份。

## 环境配置与飞书授权

环境配置参考 `.env.example`：`DATA_DIR`、`LARK_CLI_BIN`、`ADMIN_PASSWORD`、`PUBLIC_BASE_URL`。飞书固定使用用户身份，浏览器不接触 CLI 授权或凭证。数据库访问不依赖飞书在线，授权失效仅影响手动同步。

```sh
lark-cli auth status --json --verify
lark-cli auth login --help
```

反向代理时配置 `TRUSTED_PROXY_IPS=127.0.0.1,::1`，代理须正确处理转发地址和协议。默认不信任任意转发头。不要公开 `.data`、`.env` 或用户授权文件。

## 本地资料

旧提交日志及维护脚本保留用于迁移核查；新一期通过后台建立。验收记录和含实际联系方式的数据保存在本地，不进入公开仓库。

本地验收记录归档在 `doc/验收记录.md`，由 Git 忽略，也不进入发布包。临时证据和测试产物保留在 `.artifacts/`、`test-results/` 等原目录。
