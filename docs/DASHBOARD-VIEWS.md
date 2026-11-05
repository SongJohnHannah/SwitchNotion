# 管理面板视图

NotionSwitch 隔离桌面副本支持原生管理面板入口。适配在工作区限制检查之后，仅为 `dashboard_view` 返回可用；Notion 账号订阅、服务器权限和其他付费功能不变。官方客户端和网页仍按原套餐显示。

适配覆盖已审核资源、相同模块的新资源名称，以及通过语义指纹核验的自动适配。未知或行为发生变化的模块仍拒绝修改。

## 聊天中读取和创建

- 管理面板本身没有数据源；用 `list_database_views` 和 `read_database_view` 读取 `configuration.rows`，再读取组件的视图、数据源与筛选条件。
- `rows` 为空表示尚未添加组件，不表示数据源没有字段或记录。
- 创建使用 `create_database_view(type=dashboard)`；组件使用 `dashboard_view_id` 和 `placement` 加入面板，之后独立读回布局和数据。
- AI 建库向导暂未提供管理面板选项，可通过侧栏聊天工具创建。

## 验证

2026-11-05，Windows 当前账号在“NotionSwitch 测试”页下新建独立数据库、1 条合成记录、管理面板及表格组件。4 次创建均返回 `verified=true`，随后独立读回管理面板布局和记录；现有业务数据未修改。

真实客户端模块回归覆盖：原版套餐检查拒绝、隔离副本可用、工作区限制仍生效、无关付费功能仍走原逻辑。命令：

```powershell
node --test tests/dashboard-client.test.mjs tests/client-compat.test.mjs tests/compat-automatic.test.mjs tests/compat-response.test.mjs tests/notion-collaboration.test.mjs
```

本地验证不代表服务端或后续客户端版本永久支持；官方更新后若适配或请求失败，应报告实际失败，不能仅隐藏升级提示就声称可用。
