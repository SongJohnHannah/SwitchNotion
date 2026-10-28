# Switch Notion：Apple Silicon Mac

适用 M1 等 Apple Silicon Mac。用户已确认现有 Mac 基础流程正常；AI 回复“添加到聊天”引用及重新加载后的恢复有 Mac 原生窗口验收记录。近期新增 AI 对接通过共用源码和协议验证，仍需逐项核对 Mac 原生控件；详细证据见 [AI 对接检查](docs/AI-INTEGRATION-AUDIT.md)。官方 Notion 的最低系统要求以所安装版本为准。

## 双击启动

下载项目源码后，解压到自己的文件夹，双击项目根目录的 **Switch Notion 启动.command**。以后仍双击这个文件即可；修改配置可双击 **Switch Notion 配置.command**。不需要输入终端命令。

双击 **安装到应用程序.command**，可在“应用程序”中创建带 Notion 图标的 **SwitchNotion**，也可通过 Spotlight 搜索并打开。安装时会编译本机启动器，需要 macOS 命令行开发工具。首次打开时，如果系统询问访问项目所在文件夹，请按提示允许。这个入口使用当前项目的代码和资料；更新项目代码后可再次运行安装脚本，刷新属于当前项目的启动器。如果移动项目文件夹，请先移除旧的应用入口，再从新位置运行安装脚本。安装脚本不会覆盖其他同名应用。

使用 Mac 分发 ZIP 时，解压后双击 **SwitchNotion.app**，也可以把它拖入“应用程序”后双击。分发文件夹中的 **Switch Notion 启动.command** 是另一种入口。移动整个源码文件夹可以继续使用；移动分发版 `.app` 后，直接双击移动后的应用。

首次没有合适的 Node.js 时，窗口询问是否准备本机运行环境；确认后从 nodejs.org 下载固定版本的 ARM64 Node，并核对内置 SHA-256。已有原生 ARM64 Node 22+ 时直接复用。首次准备需要网络，日常不再重复下载。

启动器自动识别当前平台。Mac 查找 `~/Applications/Notion.app` 和 `/Applications/Notion.app`；Windows 使用 Windows 安装位置和注册表。无需填写系统类型或安装路径。找不到 Notion 时，窗口提供“选择 Notion”“打开官网”和“取消”。请从 [Notion 官网](https://www.notion.com/desktop) 安装官方应用。

首次使用时，可在独立窗口中登录 Notion，也可在配置页的“Notion 登录”中从本机原版 Notion 同步登录。同步前请保存内容并退出原版 Notion；同步会备份隔离副本的 Cookie，只读取 Notion 域的登录资料，不复制钥匙串或页面数据库。重启后如果系统询问钥匙串访问，请按提示确认；登录是否有效仍以 Notion 窗口为准。DeepSeek 和工作区连接密钥需要在配置页单独填写。

## 名称与图标

应用显示名称为 **SwitchNotion**。图标取自官方 Notion；Notion 图标和品牌不属于本项目 MIT 授权。分发包只携带图标和本项目代码，不携带 Notion 客户端。

首次启动核对本机官方 Notion 的签名、发行者和安装结构，复制到独立目录，再注入自己的模块并对副本进行本机签名。ASAR 完整性校验继续保留。原版 Notion 更新后，下一次完全退出并启动 Switch Notion 时会检查和准备兼容副本；失败时保留或恢复上一个版本。

本分发包尚未使用 Apple Developer ID 签名和公证。macOS 首次打开时可能要求系统确认或拦截；需要由你本人按系统提示处理。启动器不修改 Gatekeeper、不移除 quarantine，也不代你批准系统权限。正式公证发布仍需 Apple 开发者签名。

## 本机资料位置

- 源码 `.command` 或根目录项目模式 `.app` 启动：项目内 `.notion-switch/mac-arm64/`。
- 分发 `.app` 启动：`~/Library/Application Support/Switch Notion/`。
- 启动结果：上述目录中的 `launcher-last.log`。

应用移到“应用程序”后不往应用包内写密钥或运行资料。Mac 更新工具使用启动时记录的实际项目路径，可保留原来的本机登录、密钥和历史。

新增聊天文档沿用同一资料根目录，在 `document-attachments` 保存原始文件。两种资料目录、中文和空格路径、从其他工作目录启动、附件解析及重启续问均已有源码测试；没有修改上述 Mac 路径或现有启动、登录和签名实现。源码路径检查不等于 Mac 文件系统或原生窗口实测。

不要把 Windows 的 `.notion-switch/` 直接复制到 Mac。API Key 在新电脑的配置窗口重新填写；M1 的 Python、语音依赖也需使用本机 ARM64 版本。

## 图片聊天

选择 DeepSeek Flash 后，可从原生输入框上传 PNG、JPEG、GIF 或 WebP 图片。发送后，图片保留在聊天记录中，可查看缩略图和打开预览；升级前已保存的图片消息也会恢复展示。图片文件保存在上述本机资料目录的 `image-attachments` 中，应用包移动后仍从原资料位置读取。Mac 与 Windows 使用同一套图片逻辑，两种分发包均有上传、预览和重启读取测试。

## 离线语音

M1 使用 faster-whisper Medium / CPU INT8，尚未开启 Apple GPU 加速。下载 Node 和使用 DeepSeek、加载及同步 Notion 页面需要网络；离线语音识别本身不联网。语音模型及 Python 不包含在桌面启动包中，接入准备见项目 `docs/SPEECH-INTERFACE.md`。

## 新增 AI 手动验收清单

本轮沿用现有 `main` 分支同步。在 Mac 项目目录执行 `git pull --ff-only` 后，正常退出并用原有入口重开一次；保留原来的登录、API Key、音频和资料目录。可选执行只读命令 `npm run check:ai-runtime` 检查磁盘源码同步；使用 Application Support 资料时可执行 `node scripts/check-ai-runtime.mjs --root "$HOME/Library/Application Support/Switch Notion"`。该检查不更新或重启程序。

只使用合成测试页/数据库和项目 `tests/fixtures/mac-ai/` 中的三个小文件。样例共同代码是 `SYNTHETIC-DOCUMENT-97c8bcabaf`；XLSX 原文件的 `合成明细!B1` 保存代码，`B2` 保存公式 `900+27`，没有计算缓存。直接上传原文件核对。

| 编号 | 操作 | 预期结果 |
| --- | --- | --- |
| M01 回复引用 | 让 AI 回答“青色927”，选中回复文字，点“添加到聊天”，再问引用的颜色和数字 | 引用标记保留，回答青色和927；重开后仍保留 |
| M02 选区与表格 | 在合成页选中一段文字或整个两行表格，要求只解释/列出所选内容 | 只使用选区；表格行、单元格完整，不扩读整页 |
| M03 附件 | 侧栏上传 `AI-check.pdf`、`AI-check.docx`、`AI-check.xlsx`，要求报告共同代码、文件名与位置 | 三份代码一致；PDF 有页码，Excel 指向 B1；追问 B2 时明确无缓存，不能声称执行了公式 |
| M04 浮动附件 | 当前浮动框有附件入口时，上传同一 PDF 并询问第1页代码 | 返回正确预览；没有该入口则记“无入口”，不要改变已有配置 |
| M05 停止与历史 | 要求较长的合成回答，中途停止；重开后继续询问刚才的附件 | 停止后不继续输出，历史和附件引用恢复 |
| M06 公式与 AI block | 在合成数据库打开公式 AI 预览；在合成页使用已有 AI block 来源 | 公式正常返回预览且可取消；AI block 使用实际选中的来源 |
| M07 Autofill | 已有基础 Autofill 测试字段时，只选择一条合成记录运行 | 进度结束，只有所选记录变化；没有现成测试字段可先记“未测” |

其他入口先记录“通过/失败/无入口/未测”，不为了验收新建工作区或改现有音频设置。独立页面/Home 建库向导、混合工作区研究、Skills/记忆等已知未完整接入项，不标为 Mac 兼容通过。

反馈格式：`macOS版本；Notion版本；M01～M07结果；失败项提示原文`。无需提供 API Key、Cookie 或真实业务正文。

## 验证证据

当前核对直接使用项目源码和已有启动入口，不重新打包 Mac。既有平台流程、官方协议样本、资料路径与隔离检查已通过；Windows 宿主中的模拟签名调用顺序、完整性和回退检查不能替代 M1 系统操作。原有 Mac 基础流程保持现状，新增的选区/来源、公式、Autofill、建库、研究和附件控件仍需对应 Mac 原生验收，不能将“共用源码通过”写成“全部新增 AI 已实测兼容”。
