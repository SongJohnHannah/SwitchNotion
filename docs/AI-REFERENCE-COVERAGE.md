# AI 引用验收与功能对接范围

检查日期：2026-10-27。范围是当前 SwitchNotion 代码、原生请求结构和可用的合成测试资料；界面显示一个入口不代表它已接入本地模型。后续 Notion 新功能需要重新核对协议。

## 本次修复

- 从 AI 回复中选中文字后“Ask AI”，原生请求使用 `threadContext.annotations[].type = chat_selection`。此前此字段被忽略，现在会作为引用资料传给模型，并保留在原生消息、本地历史、重启恢复和上下文整理中。
- 混合页面选区与对话片段时保留两种来源。引用中的文字与 comment 作为资料处理；对话事件 ID 不能当作页面 ID 使用。字段类型、数量和总长度不合法时明确失败，不退回整页回答。
- 浮动文字编辑框的额外 `pointers` 引用尚无读取通道。此前会被静默忽略，现在在调用模型前提示转到侧栏 Agent，避免缺少资料时继续生成。
- 明确区分“读取链接/附件元数据”和“读取正文/识别媒体”。模型不能仅凭 URL 或说明声称已浏览网页、阅读 PDF、看见图片或听过音视频。

## 引用逐项结果

“API 实测”使用本机已配置连接；“模型实测”实际调用已配置的 DeepSeek，工具侧强制只读。测试仅使用专门的合成验收页及已有合成词汇数据库。

| 引用入口或对象 | 结果与边界 | 验证依据 |
| --- | --- | --- |
| 当前页、页面链接、页面信息 | 可读；不会沿用上一轮的当前页 | API 实测；路由与当前页自动测试 |
| 精确文字范围 | 保留起止块及字符位置、预览和截断标记 | 模型实测正确复述合成文字；重启、压缩测试 |
| 单块、多个块、无文字预览的块 | 按指针读取；不以整页代替 | 模型实测逐个读取 22 个选中块 |
| 段落、三级标题、无序/有序列表、引用块、待办、折叠、标注、代码、公式 | 可读正文和结构 | API 与模型实测 |
| 普通表格、行和单元格 | 按层读取并继续分页 | API 小分页实测；模型读取两行表格 |
| 分栏、列、同步块及子块 | 读取容器与子块；同步指针本身不是目标正文 | API 与模型实测 |
| 页面链接块、页面提及 | 可读取目标指针；需要正文时另读目标 | API 与模型实测指针及提及；测试禁止打开目标时未扩读 |
| 分隔线、面包屑、目录 | 可读取类型与配置，没有虚构正文 | API 与模型实测 |
| 数据库、数据源、字段 | 可读结构、字段和记录 | API 与模型实测合成词汇数据库 |
| 数据库记录、字段分页 | 单条记录使用专用读取；超长字段需继续分页 | 模型只读指定记录，未查询整库；字段分页自动测试 |
| 数据库视图链接 | 有数据库 ID 和视图 ID 时先读筛选/排序；仅有数据库块不能证明当前 UI 视图范围 | API 与模型实测 Default view；视图、筛选自动测试 |
| AI 回复选区 | 已修复丢失，作为对话引用资料保留 | 模型实测正确复述合成颜色和数字；Mac 原生 Add to chat、发送、回复及重新加载验收通过；历史、压缩、混合引用测试 |
| 浮动编辑框文字选区 | 解释、润色、翻译等原生文字预览可用 | 原生协议自动测试；不提供直接写入工具 |
| 浮动框整表/整库、额外页面/文件 pointers、截断预览 | 明确提示使用侧栏 Agent；这些入口仍未实现完整读取 | 自动测试确认不调用模型、不静默丢弃 |
| 聊天图片上传、粘贴、缩略图、预览、恢复 | Flash 支持 PNG/JPEG/GIF/WebP；Pro 输入图片明确失败 | 图片协议、模型路由、本地上传、恢复与两种分发包自动测试；本次未新增真机图片上传验收 |
| 页面图片、PDF、文件、音频、视频块 | 可读类型、链接、说明；尚未把这些块的二进制正文自动转换成模型输入 | 分发包模拟读取与媒体限制；不能等同“附件正文已读” |
| 书签、嵌入、link_preview | 可读已有元数据，尚无网页抓取工具 | 书签/嵌入 API 和模型实测；link_preview 模拟测试 |
| 页面/块评论 | 工具已对接，但当前测试连接无评论权限，实际返回 HTTP 403 | 真实失败已记录；归属核对、分页与错误处理自动测试 |
| 未授权/不存在的对象、错工作区 | 明确报错；同一轮不反复提交相同失败读取 | 404、工作区隔离与权限测试；不会绕过授权 |
| 未知块类型 | 保留 API 实际返回的类型与字段；不宣称可理解其完整语义 | 分发包 `unsupported` 模拟测试 |

API 验收共 39 项：38 通过，1 项评论权限受限。覆盖 31 个块实例、23 种实际块类型，以及页面、页面信息、数据库、数据源、两条记录和一个视图。媒体文件未作为已完成的真实正文解析项目统计。

## Mac 与 Windows 验证边界

两种打包测试会加载**实际暂存到包里的源文件**，执行原生选区 → Agent → 工作区路由 → 模拟 HTTP → 工具结果 → 模型 → 本地历史恢复的完整流程。覆盖 35 种块类型、混合多块、表格分页、只读限制，以及中文和空格路径；独立图片链路同时验证两种包。

35 种模拟类型包括：paragraph、heading_1/2/3/4、bulleted_list_item、numbered_list_item、quote、to_do、toggle、callout、code、equation、divider、breadcrumb、table_of_contents、table、table_row、column_list、column、synced_block、link_to_page、child_page、child_database、image、video、audio、file、pdf、bookmark、embed、link_preview、tab、meeting_notes、unsupported。模拟可读不表示官方允许创建每一种类型。

本次完整回归：382 项，362 通过、20 跳过、0 失败。跳过项目需要未随源码分发的官方样本、显式 GPU 验收或 Windows 真机环境。本机是 Apple Silicon Mac；没有 Windows 桌面环境，不能把共用代码和分发包测试称为 Windows 窗口实测。Windows 真机步骤见 [验收清单](WINDOWS-VALIDATION-CHECKLIST.md)。

补充 Mac 原生界面验收（Notion 7.41.0）：解锁后确认应用运行文件与提交的修复一致。在 AI 回复中选中合成文字，通过 Add to chat 添加为引用后提问，界面保留 `1 selection` 和“引用的 AI 对话”，模型正确返回“颜色是青色，数字是 927”。本地消息保存了原生 `chat_selection` 注释；重新加载窗口后，引用标记、片段、问题和回答均恢复，未出现错误。测试未读取或修改页面内容。

可重复执行：

```sh
npm test
node --test tests/native-selection.test.mjs tests/native-inline.test.mjs tests/notion-blocks.test.mjs tests/notion-databases.test.mjs tests/notion-collaboration.test.mjs tests/notion-routing.test.mjs tests/package-macos.test.mjs tests/package-windows.test.mjs
npm run check:secrets
```

## 还有哪些 AI 功能没有完整对接

下表是代码审查结论。“未对接”指没有对应的本地适配、工具或协议处理；不表示 Notion 官方没有此功能。官方功能名称参照 [Notion AI 功能说明](https://www.notion.com/help/notion-ai-faqs) 和 [AI 帮助目录](https://www.notion.com/help/category/notion-ai)。

| 功能 | SwitchNotion 当前状态 |
| --- | --- |
| 侧栏对话、流式回复、停止、续聊、历史 | 已对接；Flash/Pro 路由与长任务进度共用本地实现 |
| 页面、块、数据库、记录、视图操作 | 已对接已授权范围的工具；修改前读取并核验写入结果 |
| 选中文字浮动编辑 | 已对接文字预览；额外来源与容器读取的边界见上表 |
| AI block 摘要、要点、自定义输出 | 已对接 Current page only；其他页、连接器和搜索上下文未接入 |
| AI 会议转写、摘要、自定义摘要指令、录音归档 | 已有本地实现和测试；仍有设备、官方样本与 Windows 真机验收项，不能声称全平台均已验收 |
| 数据库原生 AI Autofill（摘要、翻译、分类、自定义填充） | 未对接原生 Autofill 入口；侧栏手动要求读取并写入字段是另一条现有能力。[官方 Autofill 说明](https://www.notion.com/help/autofill) |
| Build with AI 数据库创建向导、独立公式编辑器 AI 入口 | 未对接这些专用原生协议；侧栏可以创建数据库、设置支持的字段与公式 |
| Skills、Personalize 指令页与记忆 | 未读取原生技能注册或个性化设置；不能因按钮可见就声称已生效 |
| Web search、Web Browser、Research Mode | 未接入搜索引擎、网页正文抓取、浏览器操作或官方研究模式；现有多 Agent 只读协作局限于已授权 Notion 工具。[官方浏览器说明](https://www.notion.com/help/turn-on-web-browser-for-notion-agent) |
| AI Connectors 与跨应用 Enterprise Search | 未接入 Slack、Drive、GitHub 等原生连接器索引；当前只搜索配置的 Notion 连接已授权页面 |
| 原生 Custom Agents、定时/事件触发、外部 Agents/MCP | 未对接官方 Agent 管理与执行协议；本地多 Agent 分析不等于后台自动化或外部代理 |
| Calendar/Mail 上下文、日程操作 | 没有相应读取或操作工具；`createCalendarAgentThread` 仅接管对话，不等于接入日历资料 |
| PDF/Word/Excel/音视频附件全文理解 | 未实现通用解析、OCR、视频理解和聊天音频理解；已有离线会议转写是独立入口 |
| 生成/编辑图片、生成可下载 PDF/表格/幻灯片、运行代码的计算机工作区 | 未实现文件生成、图像生成或沙箱执行工具；文字回答不能当成已生成附件 |
| 原生计划审批、通知推送、共享本地 AI 聊天 | 未实现对应完整协议；现有写入版本检查和本地回执不等于原生审批流程 |

最关键的剩余缺口是：原生 Autofill、技能/个性化、外部连接器与浏览器、通用文件解析。它们需要单独实现与验收，无法通过更改一个引用字段获得。
