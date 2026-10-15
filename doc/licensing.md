# GPL 与商业双授权指南

[返回项目首页](../README.md) · [文档目录](README.md)

本项目自有代码采用 **GPL-3.0-only + 单独书面商业授权** 模式。两条路径为可选关系，遵守其中适用的一条即可取得该路径授予的项目代码使用权；第三方内容仍须遵守其原有许可。

## 开源路径：GPL-3.0-only

开源路径采用 GNU General Public License 第 3 版，限定该版本，不自动授权选择后续版本。GPL 完整英文原文保存在根目录 [LICENSE](../LICENSE)，本指南不修改 GPL 正文或增加额外限制。

GPL 允许个人和企业使用、修改和分发软件，也允许商业经营及收费。商业性质本身不触发另购商业授权的要求。

当向他人分发 GPL 覆盖的源码或可执行形式时，应按 GPL 的适用条款保留声明、提供许可证，并履行相应源码及修改说明等义务。GPL 要求提供源码时，义务对象和提供方式以 GPL 为准，不应概括成一律向全网公开。修改后的受覆盖作品须按 GPL 的适用要求许可，不能以另加限制剥夺接收者的 GPL 权利。

GPL 不因仅在服务器运行软件而自动产生向远程访问者提供服务器源码的义务；但交付给浏览器的前端代码、客户端、安装包或镜像等，应分别判断其分发义务。网站业务数据和第三方素材不会仅因使用本系统而自动变成 GPL 内容。

## 商业路径：单独书面许可

如希望在权利人许可范围内闭源分发、集成到专有产品、OEM 交付，或获得其他 GPL 之外的许可条件，可联系维护者申请商业授权。授权范围、费用、期限与服务等须单独书面约定。

[COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md) 说明申请与生效条件；下载源码、提交咨询或支付未约定用途的款项，本身不代表已获得商业许可。商业协议也不能免除第三方依赖的许可义务。

## 版权、素材与外部贡献

项目版权及第三方范围见 [NOTICE.md](../NOTICE.md)。山姆标识、上游商品图片和资料、第三方依赖及参考实现不属于本项目可任意再许可的内容。

贡献者保留其贡献的版权。维护者在将外部贡献纳入商业授权范围前，须另外取得明确的商业再许可授权；不能仅凭收到 GPL 代码推定已经取得该授权。

## 文件与发布包

| 文件 | 作用 |
| --- | --- |
| [LICENSE](../LICENSE) | 未修改的 GPL 第 3 版全文 |
| [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md) | 商业授权申请、生效条件与范围 |
| [NOTICE.md](../NOTICE.md) | 项目版权与第三方权利边界 |
| 本文 | 两条授权路径的说明与入口 |

`package.json` 和锁文件根包的 `license` 使用 `SEE LICENSE IN doc/licensing.md`，指向双授权说明。发布包同时包含上表中的协议和声明，避免授权文件在构建或部署时丢失。

商业授权联系：[GitHub 维护者 g-dxw](https://github.com/g-dxw)。

## 官方参考

- [GNU GPL 第 3 版](https://www.gnu.org/licenses/gpl-3.0.html)
- [GNU：GPL 与商业收费](https://www.gnu.org/licenses/gpl-faq.en.html#DoesTheGPLAllowMoney)
- [GNU：私下修改与源码提供义务](https://www.gnu.org/licenses/gpl-faq.en.html#GPLRequireSourcePostedPublic)
- [GNU：同一程序的多种许可](https://www.gnu.org/licenses/gpl-faq.en.html#ReleaseUnderGPLAndNF)
