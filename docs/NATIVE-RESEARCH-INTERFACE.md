# 原生 Research Mode 接口与接入边界

2026-10-28。仅涉及 Notion 客户端的研究入口。本任务没有修改已正常工作的 Mac 平台运行、登录、签名或音频实现；采集模块由另一任务验收。

## 当前状态

**已接通原生 Research Mode 中明确选择“仅网页”的分支**，包含两种配置、报告流、本地历史/事务、停止、超时和重启续问。必须同时开启本轮网页来源和本地联网设置。生产代码没有为此分支提供 Notion 工作区连接或页面正文读取器。

包含 Notion 工作区、页面、数据库或“全部来源”的请求仍未接通，返回未支持；不会自动缩成网页后声称全部研究完成。自动审批此前拒绝了工作区报告流补丁，原因是它将所选 Notion 正文发送给已配置的 DeepSeek，而本次真实服务验收授权仅涵盖合成资料。被拒绝的 `native-research-stream.cjs` 没有写入。新的 `native-web-research.cjs` 是仅公开网页的独立分支，不调用待授权的工作区读取器。个人 Instructions/Skills 的另一项授权也尚未收到。

## 仅网页分支的使用与边界

在客户端研究模式中明确选择网页来源，并在配置中心 **DeepSeek → 联网搜索与网页阅读** 开启联网。未配置 Brave Search 密钥时只能读取用户明确提供的公开网址；搜索需要单独密钥。本轮关闭 `useWebSearch`、HIPAA 限制或本地关闭设置时，不调用模型代替检索。网页读取及搜索的网络保护、预算和静态格式限制沿用 [联网来源接口](WEB-SOURCES-INTERFACE.md)。

`desktop-hook.cjs` 通过 `NativeMock` 接管研究请求，只把问题、已核对的历史回复和实际公开工具结果交给配置的 DeepSeek。账号/工作区不匹配、页面提及、页面/块引用、选区正文、自动注入上下文和未知附件在模型调用前拒绝，不调用浮动引用或工作区 API。原生“全部来源”必须等工作区正文接入完成后再提供。

支持 raw `agent-inference` 和 `patch-start` / `patch-sync` 两种累积流，并发送本地 record-map。报告附本轮实际返回的网址；搜索线索和未完整输出的正文分别标明，不把元数据当全文。最多保存 32 条、合计 16,000 字符的网址账目；模型正文最多 120,000 字符。总时限 5 分钟，停止、取消、设置变更和超时保存部分结果并释放网络缓存。

本地研究消息与普通聊天共用现有账号/工作区隔离；已完成报告不能由客户端伪造或覆盖。`saveTransactionsFanout` 只在本地处理已有研究线程的消息、顺序、标题、归档和必要元数据；混入远程页面或其他线程时整批拒绝，普通事务保持原路径。修改当前问题会先停止旧生成，再提交新消息；停止时新保存的部分回复位于追加问题之前。

研究记录使用原生 `current_inference_id` / `current_inference_lease_expiration` 与终止回执；陈旧的客户端租约清理不会清掉正在运行的新任务。重启将未完成任务标为中断、清除运行标识，不自动调用模型；明确的新问题才能续跑，空续跑不会重复已完成报告。原始网页正文不作为额外缓存写盘；报告及用户主动引用的内容可包含来源中的文字。下一轮重新读取公开网页，历史目录只复用同账号/工作区的网址。

当前尚未在 Windows/Mac 原生窗口逐项点击新增研究入口，也未用真实 Brave 密钥验收搜索。原生管理员策略同步、登录网页、交互式浏览器和连接器未完成；本地开关不能冒充全部原生策略。

## 待批准的具体行为

用户在 Notion 客户端手动发起 Research Mode 问题时，读取本轮所选、当前账号和当前工作区已授权的 Notion 来源，将问题、必要正文及分页状态交给**本机已配置的 DeepSeek**生成只读报告。选择整个 Notion 工作区意味着可在该连接授权范围搜索；选择页面或数据库时限制到所选根对象及其后代。引用仍受本轮来源限制，不能扩大到其他工作区。

这可能包含用户的真实业务资料。报告和必要的聊天历史保存在既有平台资料目录；凭据、Cookie、账号邮箱、渲染页面快照及未选择的个性化页面不进入模型。此范围不包括自动读取 Instructions/Skills，也不包括向 Notion 提交页面修改。研究结果供用户在客户端审阅。

网页来源仅在原生请求允许且本地联网设置已启用时提供现有公开网页工具。问题派生搜索词发给 Brave Search，公开网页正文发给已配置的 DeepSeek；搜索摘要不能冒充已读正文。交互式浏览器、登录网页、文件下载、连接器正文、邮件日历及后台任务不在此补丁中实现。

## 核对的公开协议

官方 [Research Mode 使用说明](https://www.notion.com/en-gb/help/guides/power-your-deep-work-using-research-mode-in-notion) 描述工作区和网络来源、引用及报告。以下是公开前端样本中的生产者，属于已审查样本，不代表已在当前 Windows/Mac 窗口验收：

- [42968 配置生产者](https://app.notion.com/_assets/42968-3f44bc15b3fbb9a7.js)：旧格式 `type: researcher`，包含 `searchScope`、`useWebSearch`。
- [17387 工作流生产者](https://app.notion.com/_assets/17387-723ffe42f837b541.js)：新格式 `type: workflow`、`isAgentResearchRequest: true`，包含 `searchScopes`、`useWebSearch`。
- [38064 研究入口](https://app.notion.com/_assets/38064-dedcc4138e3e886e.js)：识别以上两种格式。普通 workflow、writer、会议和 Custom Agent 不能通过改字段借用此入口。

## 已实现的来源边界

`native-research.cjs` 识别两种配置，核对账号、工作区、线程和步骤标识，清洗账号资料及未核对的上下文字段。支持 Notion/当前工作区、指定页面、指定数据库数据源、网页和无 Notion 来源。HIPAA 标记强制关闭网页。未知连接器、团队空间、站点或筛选字段明确失败，不能悄悄改成全工作区。

以下工作区代码仍是待接线的准备模块：纯配置内核为原生“全部来源”保留连接器未接入的提示，不证明全部来源已检索；生产网页分支遇到此配置直接拒绝。`research-scope.cjs` 的只读工具层绑定当前工作区，拒绝写入、其他工作区和未核对工具。页面范围适配器必须返回实际限制的证明，不能只相信配置声明。数据库数据源和原生数据库页面之间须验证归属；初始化仅读取所选数据源，不枚举同库其他数据源。搜索或越界校验可能取得候选对象及父级元数据，但不向模型返回未选来源的字段/记录，不查询其正文。直接按 ID 读取单条评论/视图暂不提供，避免核对归属前返回内容。

Router 与 Notion 工具支持可选的 `readScope` / `scopePageIds`：范围读取必须与连接本身的页面授权取交集；正文读取前核对归属，每次重新检查后代父链，避免页面移动后沿用旧的范围许可。普通聊天未传此选项时维持既有路由行为。

本地草稿已经用于仅网页分支的历史、事务和中断恢复。工作区正文研究的生产接线仍未完成，不能用网页链路替代其验收。

## 合成验证

22 项解析、来源隔离和存储检查通过，日志 `native-research-source-final.log`。其中 `native-research-global-scope-before.log` 先复现根页面移出连接白名单后仍复用后代缓存的缺陷；修复后读取会重新核对本地授权与本轮来源两层父链。工作区来源的生产入口检查明确断言返回 501，工作区读取和模型调用均为 0。

上述准备阶段测试使用内存模拟 API、合成标识与资料，不访问真实 Notion 或 DeepSeek。早期 `native-research-before.log` 的失败证明当时入口缺失；工作区正文入口目前仍未接通，不将选择内核或网页分支通过写成完整来源研究已完成。

`native-research-packaged.log` 的 24 项专项和两种实际暂存包检查全部通过。包内加载各自复制的解析/范围/记录模块，使用中文和空格资料目录；验证生产入口不触发模型或正文读取。首轮项目回归发现 Mac 分发测试将源码文件名中的 `research` 误判为研究缓存目录，已改为按完整目录段检查；原有凭据/私有文件扫描保留，Mac 平台运行和打包实现没有因此改动。

最终项目回归 `native-research-preparation-final-tests.log`：581 项，576 通过、5 跳过、0 失败/取消，6 个测试进程并发；排除另一任务负责的 `collection-*`。两项跳过缺少官方网页样本，三项是按需 GPU 测试，不将跳过项算作本批通过。此批真实 Notion 读取/修改与真实模型调用均为 0。

复现相关专项：

```powershell
node --test tests/native-research.test.mjs tests/research-scope.test.mjs tests/inline-records.test.mjs tests/package-windows.test.mjs tests/package-macos.test.mjs
```

## 后续验收

仅网页分支的首批 13 项检查及两平台暂存包共 15 项通过，日志 `native-web-research-packaged.log`。覆盖两种配置、raw/patch、实际桌面路由、本地事务/历史、重启续问、停止/超时、设置关闭、归属及未授权来源拒绝；后补原生运行字段、陈旧租约清理和历史 trace 的 18 项/33 项回归分别见 `native-web-research-lease-fixed.log`、`native-web-research-history-final.log`。再补原生显式 Flash/Pro 选择并保存到配置、传入既有 Provider；14 项研究检查与 5 项记录检查共 19 项通过，日志 `native-web-research-final-core.log`。这些是重叠检查，不能累加为独立总数。

真实 DeepSeek 合成验收通过：2 次模型请求、1 次工具调用、1 次内存合成网页读取，核对新随机代码及来源链接；实际桌面路由、本地标题事务、重开记录和缓存释放通过。真实 Notion 读取/写入和真实网页抓取均为 0。结果 `native-web-research-live-result.json`；随后运行字段/历史元数据对齐由上述专项回归覆盖。

最终项目回归 `native-web-research-final-project-tests.log`：596 项，591 通过、5 跳过、0 失败/取消，6 个测试进程并发并排除另一任务负责的 `collection-*`。两项跳过缺少官方网页样本，三项为按需 GPU 用例；两种实际暂存包分别加载自身模块验证两种配置、报告、本地续问、重开和归属。包含最终运行字段、显式模型选择、字段顺序不同的原生确认以及跨入口 ID 保护。前一轮 595 项日志为 `native-web-research-project-tests.log`；新增跨入口检查的 6 项专项另见 `native-web-research-entry-scope-fixed.log`，不累加重叠数量。

仍需工作区正文生产接线、完整混合来源和两平台原生窗口验收。Brave 实际服务、原生管理员网络策略、连接器和交互式浏览器分别保留为待办。现有运行中的客户端未被本任务重启，新代码需下次启动加载。

整体范围与已有证据见 [AI 对接检查](AI-INTEGRATION-AUDIT.md) 和 [联网来源接口](WEB-SOURCES-INTERFACE.md)。
