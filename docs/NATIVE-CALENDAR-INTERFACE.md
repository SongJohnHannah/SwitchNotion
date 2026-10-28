# 原生日历 AI 事件读取

2026-10-28。第 15 项按原生客户端接线：保留 Notion 原来的日历连接设置，在 `createCalendarAgentThread` 和普通 AI 对话中提供 `list_calendar_events`。不创建独立日历产品，也不把日历 API Key 放进模型。

## 已核对的接口

[官方日历 AI 连接说明](https://www.notion.com/help/notion-calendar-ai-connector)说明连接位置和事件搜索能力。客户端公开 [Home 日历读取生产者](https://app.notion.com/_assets/58422-8ec801559812baac.js) 调用 `getCalendarEvents`，开始/结束时间使用毫秒；[事件转换消费者](https://app.notion.com/_assets/58882-258001748569e4ca.js) 处理 accounts/calendars/events，以及 `start.date` / `start.dateTime`、结束时刻和全天事件的排他结束日期。

本地审核文件的 SHA-256 分别为 `28e11d5a6953698da5a25912bbeced83e7e674c6706617f9bcb0b7e5fb81d853`、`69f91a0221f125e440a1573ec568848e56df09f11878f84c4f93381dd7d259ca`。读取使用当前原生登录会话，固定 API、当前账号和工作区；不能指定其他用户邮箱、bot 或第三方地址。

## 本次接线

- 查询要求带时区的起止时间，每次不超过 31 天；可按月分批和按关键词查找。
- 只返回 Home 可见日历中相关事件的标题、日期、地点及有界描述。隐藏、已拒绝或取消事件排除；没有日历连接与“没有事件”分别处理。
- 全天事件按所选 IANA 时区转换，保留原日期；日期、数量、分页信号和正文截断都影响完整性标记，不把有界结果说成全部事件。
- 登录会话、账户列表、Cookie 和授权令牌不交给 DeepSeek；返回的事件正文作为资料，不能授权修改或邀请。
- 工具只在实际提问需要时调用，没有打开聊天即自动读取日历。停止信号贯穿原生请求。

创建、改期、邀请和删除事件的原生工具卡片仍未接通；已配置的日历 MCP 可另行执行其提供的操作，但不等于这些原生控件已完成。真实日历连接和 Windows/Mac 控件尚待验收。

## 验证

使用合成事件完成原生 `createCalendarAgentThread` → 工具调用 → 回复记录的链路；另通过实际 MeetingNativeBridge 核对活动账号头、工作区、只读参数和越界拒绝。上海、纽约夏令时/标准时的全天日期转换通过；隐藏日历未进入结果。真实 Notion 日历读取和真实模型调用为零。复用检查，不新增永久测试脚本。
