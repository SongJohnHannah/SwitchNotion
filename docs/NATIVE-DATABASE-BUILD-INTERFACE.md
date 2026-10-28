# 原生数据库创建与客户端建库向导

## 本轮交付（2026-10-28）

页面/Home 增加可见的“AI 建库”按钮，应用菜单另有“AI 建库 → 打开建库向导”。客户端没有官方 Build with AI 入口时也能进入；这是本项目补充的客户端入口，不冒充官方未出现的菜单。流程为 **描述需求 → 字段预览/调整 → 选择布局 → 完成并创建**。支持表格、看板、日历、列表、画廊、时间轴，以及看板分组字段和日期字段选择。

`database-wizard-window.cjs` 管理隔离的本地窗口及严格的 IPC 发送者/主框架/本地 URL 检查。Notion 页面仅能请求打开窗口，不能通过打开接口直接生成或写入。当前页面按钮默认将该页面作为父级；从 Home/应用菜单进入可粘贴父页链接，留空则创建工作区私人顶层数据库。向导显示实际工作区名称，打开后固定该工作区。

`database-wizard.cjs` 复用现有字段解析、六布局及 `NativeBuildStore` 权限、方案绑定和受限事务。生成、字段调整、布局准备均不写页面；只有本地向导“完成并创建”的操作可以提交。写前再次检查父级，写后读回验证。方案与状态原子保存在当前资料根目录的 `database-wizard.local.json`；回包不明或重启后只核对既有 ID，不重新创建。界面提供“核对创建结果”和最近方案恢复。关闭窗口取消未完成生成。

Windows 验证：实际本地页面在隔离 Edge 渲染，预览五字段、选择六布局及字段绑定、完成后一笔合成原生事务并读回、重开不重复、深色模式、IPC 和入口保护均通过。真实 DeepSeek 合成需求 **1 请求**，生成五字段、六视图并通过同一创建内核；真实 Notion 写入为 **0**。101 项既有 Agent/建库回归全部通过。验证使用临时脚本，没有新增永久测试文件。

新增文件使用 Node 路径、Electron 窗口/菜单/IPC 和标准浏览器界面，Windows/Mac 共用；原有 Mac 启动、登录、签名、语音和采集代码未改。不打包，Mac 由用户拉取 `main` 后实机测试。真实服务端建库及 Mac 原生窗口仍属待验收；关系、公式、汇总等原内核未支持字段也未因本次向导自动补齐。

以下保留先前 onboarding 接口的实现与验证记录；其中“独立向导尚未完成”为当时状态，以本节为准。

2026-10-28。本任务按用户明确范围继续实现 **Notion 客户端内全部 AI 功能**，包括客户端调用的浏览器、连接器、邮件日历和后台 Agent；不创建独立外部产品。采集模块由另一任务验收，Mac 已正常工作的运行、登录、签名和音频实现保持原样。

**已接通下述 onboarding 建库入口的桌面路由、原生确认/拒绝、本地历史和重启恢复。** 实际公开确认函数、桌面路由及真实模型合成链路已验证。页面/Home 的预览与布局向导是另一入口，尚未完成；真实服务器及 Windows/Mac 新控件仍待验收，不能据此宣称整个 Build with AI 已完成。

## 已核对的两类入口

[官方创建说明](https://www.notion.com/help/create-a-database) 描述页面及 Home 中的 Build with AI：先预览字段并调整，再继续选择布局、完成创建。该流程需要独立验收，不能用普通侧栏建库代替。

当前公开前端还包含 onboarding 建库入口：

| 层次 | 已核对来源与字段 |
| --- | --- |
| 打开入口 | [use-ai-database-build-toast](https://app.notion.com/_assets/use-ai-database-build-toast-78d4d3dc65c03054.js) 模块 125406，`createdSource=post_onboarding_agent`，指定 work/personal/school 的 database_build 版本 |
| 生成配置与触发消息 | [90710](https://app.notion.com/_assets/90710-35d46d4331f5e658.js) 模块 939679，`type=workflow`、`oracleThreadType=onboarding`、`onboardingAgentVersion`、`createResultNavigationBehavior=first_top_level_page_only` |
| 发送请求 | [98326](https://app.notion.com/_assets/98326-304e39256b26a36e.js) 模块 225900 调用 runFromStep；[42968](https://app.notion.com/_assets/42968-3f44bc15b3fbb9a7.js) 模块 826635 向 `runInferenceTranscript` 发送 transcript 和补丁流配置 |
| 预览图谱 | [原生预览缓存](https://app.notion.com/_assets/UISpacePermissionGroupToken-cbfe38c487518b52.js) 模块 354128，在临时记录缓存中应用 tool step 的 threadOperations；模块 897011 读取操作封装 |
| 确认与拒绝 | [22299](https://app.notion.com/_assets/22299-15b5c35dcfff26f6.js) 模块 752104，更新原生 tool step 的 `confirmation:confirmed` / `confirmation:rejected`，并通过原生事务提交消息状态 |

两类入口不能在尚未核对实际请求之前视为同一个协议。上述 onboarding 请求由 `desktop-hook.cjs` 路由到独立 `native-build-service.cjs`，不走普通侧栏聊天的兜底回复。

2026-10-28 再次核对官方创建帮助页，仍描述页面/Home 的独立 Continue/Done 流程；目前审查到的公开入口是上述 onboarding 配置，不能由此证明独立向导使用相同请求。独立向导继续保留为待实现/待验证，不为缺少样本的入口编造 API 或将对话预览记为其验收。

## 已实现的共用内核

`native-database-build.cjs` 识别已核对的 onboarding 建库配置，校验请求与来源，构造模型输入并解析严格的 JSON 方案。不会把调试配置和用户资料记录传入模型；尚未读取的附件或来源明确拒绝。模型不能指定记录 ID 或原生事务。

预览包括新数据库块、collection 和 1 至 8 个视图，字段覆盖标题、文字、数字、选择/多选、三组状态、日期、复选框、URL、邮箱、电话、人员、文件、创建/编辑时间和人员、自动编号。字段、选项、名称、状态组、数字格式、数量及长度均校验；关系、公式、汇总和其他类型尚须继续实现。

所有新记录 ID 由程序生成。预览使用原生 `agent-tool-result`、`confirmation:requested` 和 threadOperations；原生预览消费者的重放测试能在内存还原完整图谱。只附加新数据库块，不替换父页正文，也不生成示例记录或自动化。

`native-database-build-store.cjs` 使用当前原生账号读取父级并检查编辑权限，保存父级内容/权限指纹及方案指纹。提交调用必须提供与账号、工作区、预览步骤和方案指纹完全匹配的 confirmed 记录；缺失、拒绝或不匹配时不会开始事务。确认桥只接受所存方案对应的原生消息状态事务或明确的确认列表，不能由模型输出生成创建授权。提交时再次复核原始方案与新记录 ID，父级发生变化时拒绝旧方案。事务只有新记录、父级追加和必要编辑元数据，提交后独立读取字段、视图、父级链和顶层私有权限。

同一计划的已核验结果或写回回包丢失后的完整结果可读取复用，不再次创建；已有记录不完整或不匹配时拒绝覆盖。

## 本地确认与历史服务

`native-build-service.cjs` 将已校验消息、预览方案、确认凭据、提交及核验状态原子保存到当前资料根目录的 `native-builds.local.json`。写入前保存 submitted 状态；回包不明或重启后只读取原计划的记录标识核对，不再次提交。损坏日志保留原文件并停用建库，不影响普通聊天。并发确认按线程串行，已核验方案的重试返回既有结果，不重新调用模型或创建。

原生 `saveTransactionsFanout` 中本地建库消息修改先整批校验，混入其他页面修改时整批拒绝；普通远程事务保持原路径。预览只读检查同时识别记录本身及其父级/数据库指针，不能用一个新的记录 ID 把行、子块或视图写到尚未确认的图谱；确认完成后这些编辑恢复原生路径。支持原生后续用户消息创建和列表关联，再由空的 partial transcript 续聊。生成结果不能由客户端改成已创建；问题、位置、只读开关或父级变化会使旧方案无法提交。拒绝/替换方案不产生页面事务。

待确认图谱通过本地记录及空表查询提供，角色为 reader；没有记录时只返回空行及零计数。看板按实际方案的状态/单选选项提供空分组，支持隐藏/固定列、列顺序和列数限制；不提供未知聚合、交叉或嵌套分组。确认并读回成功后，返回真实图谱记录，停止提供虚拟记录。历史使用既有 `LocalHistory` 的合并及游标服务，按当前账号和工作区过滤；线程元数据、预览读取和停止同样检查范围。运行中状态加入桌面忙碌检查，退出时取消生成。代码仅使用 Node 跨平台路径和当前原生会话，不新增系统平台分支。

原生仅网页研究接入后，桌面路由补充跨入口线程 ID 保护：新建建库不能占用已知侧栏/浮动/研究记录；侧栏创建也不能占用已有建库 ID。真实路由的专项检查确认拒绝时不新增模型请求或页面事务，既有历史归属保留。完整项目回归见 [研究模式接口](NATIVE-RESEARCH-INTERFACE.md) 的 596 项结果。

## 对话建库的布局

`native-database-build-views.cjs` 处理表格、看板、日历、列表、画廊和时间轴。模型只提供视图名及 columns 内的字段名称；字段和记录 ID 仍由程序产生。看板必须绑定状态或单选字段；日历/时间轴必须绑定日期、创建时间或编辑时间，时间轴可选择结束日期。可指定显示字段顺序及排序。名称重复、未知字段、不匹配类型、图表/表单等未支持布局在预览前拒绝。

多个视图一起进入原生预览和确认指纹，提交仍是一笔建库事务。读回逐一核对视图类型、顺序、归属、字段显示、分组、日期及排序；缺少视图、日期错绑或被额外加入筛选/排序不能报告成功。旧版单视图日志继续可读。此能力通过对话描述调整，**没有将它冒充页面/Home 的 Continue/Done 向导接入**。

协议核对使用 [原生数据库规格编译器](https://app.notion.com/_assets/73900-a65537ccfd465a3a.js) 的 `buildViewPropertiesFormat`、[分组种子与查询结果实现](https://app.notion.com/_assets/66443-aec4a5ee6ea8e91c.js) 的模块 861044/49313/753642，以及 [原生日历/时间轴模板](https://app.notion.com/_assets/11327-b82b87be0dc5578d.js)。测试只重放已审核的独立函数，不执行整个下载脚本。2026-10-28 重新检查未登录公开入口后，确认 [当前建库入口](https://app.notion.com/_assets/use-ai-database-build-toast-7cb05988f893efa1.js) 与 [当前确认生产者](https://app.notion.com/_assets/22299-32a207982513c662.js) 继续使用相同协议；两版确认函数分别回放通过。公开资源清单在忽略的 research 中，不随包分发。

## 验收与剩余工作

- 确认服务阶段 36 项通过；布局阶段专项及两种实际暂存包共 48 项通过，包括六种布局、字段绑定、原生规格编译器/分组种子/行收集器对照，以及两版确认函数。随后补充“额外筛选/排序必须核验失败”的回归，14 项内核专项通过。Windows/Mac 包加载各自模块执行六视图预览、确认、读回和重启后重复确认。不等同原生窗口或 Mac 硬件验收。
- 初次项目回归排除 `collection-*` 后 488 项：483 通过、5 跳过、0 失败、0 取消；随后确认绑定和空选项处理的补充改动由上述 19 项专项与包内测试验证。
- 确认服务阶段的项目回归排除 `collection-*` 后 507 项：502 通过、5 跳过、0 失败、0 取消；跳过项为两项缺少的官方网页样本和三项需显式启用的 GPU 验收。暂存区 225 个既有文件的敏感检查通过；当前分发源码另由两种包内扫描覆盖，不能把暂存检查数量写成全部新文件已暂存。
- 真实 DeepSeek 早期内核验收两次，各 1 请求。最新服务验收再使用 1 次请求生成 5 个字段，经实际 desktop route 返回预览，重放原生确认生产者后执行一笔内存事务；读回、重启、历史与重复确认通过。真实 Notion 修改为 0，没有执行原生窗口点击。
- 布局阶段新增真实模型合成验收 1 请求：5 字段、6 视图，实际桌面路由与当前原生确认函数通过；预览零事务，确认一笔内存事务，六视图读回、历史、重启防重复通过。证据 `native-build-layouts-live-result.json`；真实 Notion 修改为 0。
- 首次布局项目回归 519 项：514 通过、5 跳过、0 失败、0 取消，日志 `native-build-layouts-project-tests.log`。随后复现并修复“新增子记录使用新 ID 漏过预览拦截”，25 项服务/路由/查询专项通过，证据 `native-build-preview-child-before.log` 与 `native-build-preview-child.log`。
- 最终布局回归 520 项：515 通过、5 跳过、0 失败、0 取消，日志 `native-build-layouts-final-project-tests.log`。包含最终子记录拦截代码、两种实际包内六视图链路；继续排除采集测试，跳过原因同上。
- 私有证据：早期 `database-build-*.log`、`database-build-preview-live-result.json`；最新 `native-build-route-before.log`、`native-build-confirm-lists-before.log`、`native-builder-packaged.log`、`native-build-service-live-result.json` 与 `native-builder-project-tests.log`。
- 必须继续：页面/Home 的 Build with AI 独立预览/布局入口、其余字段类型、暂停/恢复语义、真实服务端查询/事务，以及 Windows/Mac 原生控件验收。

整体待办仍见 [AI 对接检查](AI-INTEGRATION-AUDIT.md) 与 [Windows 验收清单](WINDOWS-VALIDATION-CHECKLIST.md)。
