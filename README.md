# 山姆代购与小区团购管理

基于 React、Node.js 和 SQLite 的轻量团购系统，支持山姆选品、商品定价、团购期次、顾客自选、按份拼单和订单汇总。

商品与订单以本地数据库为准，飞书用于可选的手动备份和订单导出。网页不在线收款，付款需独立确认。

## 快速启动

需要 Node.js 24 或更高版本及 npm。山姆查询与本地商品管理无需配置飞书。

```sh
npm ci
npm run build
npm start
```

- 顾客首页：<http://127.0.0.1:3001/>
- 管理后台：<http://127.0.0.1:3001/admin>
- 初始密码：首次启动后查看 `.data/admin-initial-password.txt`；也可在 `.env` 设置至少 8 字符的 `ADMIN_PASSWORD`，重启后生效。

开发模式运行 `npm run dev`，前端和 API 共用 3001 端口；自动化验证运行 `npm test`。环境变量参考 `.env.example`，旧版升级先阅读[迁移说明](doc/maintenance.md#旧版数据迁移)。

## 基本流程

山姆选品 → 核对商品并上架 → 新建团购期次 → 分享链接或二维码 → 顾客下单 → 采购与分货 → 手动同步飞书。

## 项目文档

完整说明集中在 [doc/](doc/README.md)：

- [使用指南](doc/usage.md)：团长操作、顾客自选、订单查询、删除恢复与手机访问。
- [商品定价与按份拼单](doc/pricing-and-portions.md)：售价、加价规则、分装与采购确认。
- [飞书备份](doc/feishu.md)：连接配置、同步规则、费率与订单导出。
- [本地运行与维护](doc/maintenance.md)：初始密码、旧版迁移、备份与恢复。
- [部署指南](doc/deployment.md)：GitHub Actions、服务器配置与回滚。
- [山姆商品查询工具](doc/sams-browser.md)：独立工具的启动与接口说明。

## 目录

| 目录 | 用途 |
| --- | --- |
| `client/`、`public/` | 前端页面、样式与静态资源 |
| `server/` | API、SQLite 数据存储与同步逻辑 |
| `scripts/`、`ops/` | 维护脚本、发布与部署模板 |
| `test/` | 自动化测试 |
| `tools/` | 独立辅助工具 |
| `doc/` | 项目文档 |

业务数据库、配置和后台密码默认保存在 `.data/`，请定期[备份](doc/maintenance.md#备份与恢复)。

## 许可证

本项目自有代码采用 **GPL-3.0-only + 单独书面商业授权**，两种路径任选其一。GPL 本身允许商用；希望闭源分发或取得 GPL 之外的许可条件时，可申请商业授权。

详见[双授权指南](doc/licensing.md)、[GPL 全文](LICENSE)、[商业授权说明](COMMERCIAL_LICENSE.md)和[版权与第三方声明](NOTICE.md)。
