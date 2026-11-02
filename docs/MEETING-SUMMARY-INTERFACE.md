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

读取校验会议类型、父子关系、工作区与编辑角色；文字不完整、过长或生成期间变化时不写入。自定义模板支持当前账号可访问的同一或其他工作区页面；模板使用独立读取范围，不改变原会议的写入账号、工作区和目标。事务提交前保存已生成草稿与 ID，网络结果不明时先读回核验，不能自动重放事务。回执存入本机 `meeting-summaries.local.json`，包含私有生成内容，不进入发布包或 Git。

界面语义：**笔记 = 手写区；转录 = 识别文字；摘要 = AI 生成内容**。自动摘要默认开启；用户可在“离线语音”关闭，关闭后不把文字交给 DeepSeek。音频识别继续在本机进行。

录音停止后只有“笔记 / 转录”、没有“摘要”时，表示摘要尚未成功写回；“Notion AI 将总结笔记和转录内容”只是手写区的占位提示。可打开会议右上角“选项 → 重试总结”，成功后会出现并选中“摘要”标签。重试不会覆盖转录或手写笔记。

失败流先发送原生 `summarize-transcript-error`，再发送终止 `error`，让会议回调显示失败提示并清除准备状态。只发送通用 `error` 会被原生流读取器提前消费，导致会议界面收不到失败通知。成功重试会清除本机状态中的上次错误。`tests/meeting-summary-feedback.test.mjs` 覆盖新旧接口、失败与取消，并在本机有已审核客户端资源时执行实际原生读取器和界面回调。

另一台机器出现“有转录、有音频但无摘要”时，在出问题的机器上保持 Switch Notion 运行，执行 `npm run check:meeting`。也可单独复制 `scripts/check-meeting-summary.mjs` 到该机器的项目根目录，执行 `node check-meeting-summary.mjs`。脚本只读取设置、固定的本机状态接口及事件日志末尾，不录音、不调用模型、不修改页面；输出不含密钥、账号/工作区/会议 ID、路径或正文。Mac 分别检查源码的 `.notion-switch/mac-arm64/` 和分发应用的 Application Support 资料，不使用 Windows 的资料推断 Mac 状态；多个资料目录同时存在时分别报告，以 `live` 判断哪个服务正在运行。支持 `--root` 指定绝对资料目录。现有日志仅记录摘要成功、失败或主动跳过；没有结果事件不能证明原生端没有发出请求。摘要使用当前账号原生会话，与侧栏工具的工作区 API 连接列表无关。

Windows 已验证新旧请求适配、实际 DeepSeek 生成、真实服务器写回与读回、界面“摘要”标签显示。取消、并发重复请求、重启恢复、源内容变化、只读权限和不确定写入由自动测试覆盖。真实麦克风暂停触发的整段交互仍需结合录音场景验收。
