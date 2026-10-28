# 客户端日历 AI：读取、空闲时间与写入

## 本轮写入交付（2026-10-28）

普通侧栏与原生日历 AI 对话增加 `connect_calendar`、`list_calendar_sources`、`get_calendar_event`、`create_calendar_event`、`update_calendar_event`、`verify_calendar_write`。可创建非重复事件、修改标题/日期/时区/地点/描述/参与人，支持全天日期和参与人邀请。读取 Home 可见事件及空闲时间仍沿用下面的原生只读接口；写入列表来自 Calendar 中当前账号有写权限的日历，两者范围明确区分。

已审核当前 [Calendar 主程序](https://calendar.notion.so/assets/App-CVACXgZ_.js) 和 [Calendar API 生产者](https://calendar.notion.so/assets/useStores-DykF7fQ4.js)，版本 `cron-web@1.142.0+1793128938`。固定使用 `https://calendar-api.notion.so/v2/`：`getUser`、`getCalendars`、`getEvent`、`createEvent` 的单个 mutation，以及 `updateEvents` 的 mutations 数组；不猜测 Notion `/api/v3` 写日历接口。

`calendar-connection.cjs` 在首次需要时打开官方 Notion Calendar 登录窗口，用户选择**使用同一 Notion 账号登录**，并在 Calendar 中连接自己的日历。无需新增 Calendar API Key。只监听本项目专用 Calendar 会话发往固定 Calendar API 的授权头，通过 `getNotionSessionUsers` 与 `getUser.notionUserId` 双重核对当前 Notion 用户后使用；不读取其他浏览器/应用登录资料。令牌只留内存，不交给模型或写入日志；官方窗口自身登录资料保存在本应用隔离 profile 中。登录/连接必须由用户亲自完成。

`calendar-writes.cjs` 只接受实际列出的可写日历。修改前读取事件版本；提交前显示原生确认，完整列出日历、标题、起止时间、时区、地点、描述及参与人，并说明邀请/通知影响。拒绝后本轮不继续弹出写入。确认后重新检查日历权限和事件版本；原事件与明确修改字段合并，依照原生生产者仅移除两个派生时间戳，保留未修改字段和 etag。写后通过 `getEvent` 读回预期字段，只有一致才返回 `verified=true`。

写前将 submitted 状态原子保存至当前资料根目录的 `calendar-writes.local.json`。同轮重复参数、重启和回包丢失不会重复创建；未知结果阻止该账号继续写入，`verify_calendar_write` 只读核对。服务端可能改写新事件 ID，因此先保存回包的实际 ID 再核验。账号/工作区归属检查贯穿日志和模型工具，Calendar 登录令牌、邮箱账号配置不作为工具输出。

Windows 合成检查通过：实际请求结构、确认取消零写入、创建/改期读回、保留无关字段、服务端改写 ID、丢包恢复、未知结果/重启防重、并发版本变化、全天/DST、同一 Notion 用户登录绑定，以及 Agent 写入回执和只读 Agent 隔离。真实 Calendar 邀请/写入为 **0**，真实登录和服务端回包仍待用户实测；没有发送业务资料。仅使用跨平台 Node/Electron API，Mac 不增加系统脚本，原有平台代码保持不变。

当前边界：未支持重复日程整组/单次修改、删除事件、同事空闲和自动会议链接。现有原生 Calendar 卡片的全部专用展示没有逐个复刻；本次写入通过客户端 AI 工具及原生确认完成。Mac 操作步骤见使用说明 N14/N15；Mac 实测由用户完成，不阻塞提交。

## 先前读取实现与验证记录

2026-10-28。第 15 项按原生客户端接线：保留 Notion 原来的日历连接设置，在 `createCalendarAgentThread` 和普通 AI 对话中提供 `list_calendar_events` 和 `find_calendar_availability`。不创建独立日历产品，也不把日历 API Key 放进模型。

## 已核对的接口

[官方日历 AI 连接说明](https://www.notion.com/help/notion-calendar-ai-connector)说明连接位置和事件搜索能力。客户端公开 [Home 日历读取生产者](https://app.notion.com/_assets/58422-8ec801559812baac.js) 调用 `getCalendarEvents`，开始/结束时间使用毫秒；[事件转换消费者](https://app.notion.com/_assets/58882-258001748569e4ca.js) 处理 accounts/calendars/events，以及 `start.date` / `start.dateTime`、结束时刻和全天事件的排他结束日期。

本地审核文件的 SHA-256 分别为 `28e11d5a6953698da5a25912bbeced83e7e674c6706617f9bcb0b7e5fb81d853`、`69f91a0221f125e440a1573ec568848e56df09f11878f84c4f93381dd7d259ca`。读取使用当前原生登录会话，固定 API、当前账号和工作区；不能指定其他用户邮箱、bot 或第三方地址。

## 本次接线

- 查询要求带时区的起止时间，每次不超过 31 天；可按月分批和按关键词查找。
- 只返回 Home 可见日历中相关事件的标题、日期、地点及有界描述。隐藏、已拒绝或取消事件排除；没有日历连接与“没有事件”分别处理。
- 可见范围按 [58422](https://app.notion.com/_assets/58422-8ec801559812baac.js) 的原生模块 377382 核对，只纳入 `selected=true` 的日历。之前 `selected!==false` 会把未标记状态的日历错误纳入；合成回放已复现并修复。缺少显示标记不代表用户选中了此日历；此规则同时用于查事件和计算空闲时间。
- 全天事件按所选 IANA 时区转换，保留原日期；日期、数量、分页信号和正文截断都影响完整性标记，不把有界结果说成全部事件。
- 登录会话、账户列表、Cookie 和授权令牌不交给 DeepSeek；返回的事件正文作为资料，不能授权修改或邀请。
- 工具只在实际提问需要时调用，没有打开聊天即自动读取日历。停止信号贯穿原生请求。
- 空闲时间工具读取完整事件后合并重叠/相邻占用区间，按时长和所选时区计算候选时间。默认周一至周五 09:00–18:00，可指定星期、工作时间、5–480 分钟时长、5–120 分钟间隔及最多 50 个候选；只返回当前时刻之后的时间。全天事件占用完整本地日期，标为空闲的事件不占用时间。
- 计算不按关键词过滤事件，不受事件正文或前 200 条展示上限影响。分页、无效事件、未知日历或冲突的重复事件导致明确失败，不能据不完整事件声称空闲。输出标记计算依据、候选总数和展示是否截断，并说明隐藏日历及同事空闲未检查。
- 计算仅使用 JavaScript 的日期与 Intl 时区接口，Windows/Mac 共用，无外部依赖或平台脚本。

创建、改期、邀请和删除事件的原生工具卡片仍未接通；已配置的日历 MCP 可另行执行其提供的操作，但不等于这些原生控件已完成。真实日历连接和 Windows/Mac 控件尚待验收。

## 验证

使用合成事件完成原生 `createCalendarAgentThread` → 工具调用 → 回复记录的链路；另通过实际 MeetingNativeBridge 核对活动账号头、工作区、只读参数和越界拒绝。上海、纽约夏令时/标准时的全天日期转换通过；隐藏日历未进入结果。真实 Notion 日历读取和真实模型调用为零。复用检查，不新增永久测试脚本。

空闲时间扩展通过临时合成检查：区间合并、边界相邻、全天/透明/隐藏事件、250 条事件、候选截断、分页/无效/冲突事件拒绝、纽约 DST 两端、加德满都 45 分钟时区、取消及工作区变化。证据保存在私有 `calendar-availability-result.json`，没有真实日历读写或模型请求。原生事件创建/修改及 Windows/Mac 控件仍待完成，不能由计算通过推断写入功能已接通。
