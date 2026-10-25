# Notion 原生会议摘要接口

Windows 与 Mac 共用三个模块：`meeting-summary.cjs`（生成、队列和回执）、`meeting-summary-store.cjs`（会议记录读取和受限写回）、`meeting-summary-native.cjs`（已登录 Electron 会话）。这些模块使用 Node 内置功能，不包含 Windows 路径、UI 坐标或系统录音实现。Mac 原生界面仍需实机验收。

`MeetingSummaryService({root,provider,storeFactory,log?})`：

- `handle(endpoint,input,signal,meta)` 返回原生 NDJSON Response，支持 `runMeetingNotesAgent` 及旧版 `summarize-transcript`。只有服务器读回核验成功才发送 `record-map` 和完成事件。
- `run(info,signal,meta,notify?)` 执行一项已明确指定会议的生成任务；结果为 `{ok,recordMap,tabId,reused?}`。
- `status()` 只返回任务数量、核验与错误状态；`close()` 取消自己的任务。
- `provider` 实现既有 `config()` 与 `generate({config,messages,signal})`。模型无写入工具；转录、笔记和模板作为数据发送给 DeepSeek，原生会话头和 Cookie 不交给模型。

`storeFactory` 返回 `NativeMeetingStore({api,spaceId,userId})`。`api(endpoint,data,{signal,spaceId})` 只能访问可信 Notion HTTPS 同源接口，并使用调用方已授权的登录会话：

- 读：`getRecordValues`。每个记录指针必须包含 `spaceId`；新分配的 ID 也不能省略工作区。
- 写：`saveTransactionsFanout`。只创建摘要容器和正文块，更新当前会议的摘要指针；不覆盖转录、手写笔记或既有摘要正文。
- 新会话保留其对应工作区的原生分区路由。不得把一个工作区的分区头用于另一个工作区；未知或外部源不复用会话。

读取校验会议类型、父子关系、工作区与编辑角色；文字不完整、过长或生成期间变化时不写入。自定义模板支持同一工作区的已授权页面。事务提交前保存已生成草稿与 ID，网络结果不明时先读回核验，不能自动重放事务。回执存入本机 `meeting-summaries.local.json`，包含私有生成内容，不进入发布包或 Git。

界面语义：**笔记 = 手写区；转录 = 识别文字；摘要 = AI 生成内容**。自动摘要默认开启；用户可在“离线语音”关闭，关闭后不把文字交给 DeepSeek。音频识别继续在本机进行。

Windows 已验证新旧请求适配、实际 DeepSeek 生成、真实服务器写回与读回、界面“摘要”标签显示。取消、并发重复请求、重启恢复、源内容变化、只读权限和不确定写入由自动测试覆盖。真实麦克风暂停触发的整段交互仍需结合录音场景验收。
