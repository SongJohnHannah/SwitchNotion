# Switch Notion 项目介绍

Switch Notion（仓库名 NotionSwitch）在 Notion 桌面版的原生 AI 入口中接入用户自己的 DeepSeek。它在本机准备隔离的 Notion 副本，处理已接入的 AI 请求，并将结果交回原生界面。官方安装保持原样；访问和修改 Notion 内容仍受账号、工作区连接和页面权限约束。

这是独立项目，与 Notion、DeepSeek 官方没有隶属关系。项目不提供官方服务额度，DeepSeek API 用量由用户自己的账户承担；配置 DeepSeek 也不代表所有 Notion AI 产品都已接入。

## 适合做什么

| 功能 | 当前范围 |
| --- | --- |
| 原生聊天 | DeepSeek Flash / Pro、流式回复、停止、续聊、本机历史及上下文整理 |
| 页面内 Writer | 续写、润色、改写、翻译、摘要和文字编辑；同一父级连续选区、列表文字及原生撤销 |
| 页面与数据库 | 已授权页面/块/数据库操作，原生 AI block、公式预览、限定范围的 Autofill 和建库入口 |
| 附件与 OCR | 常用文档解析、图片输入、本机图片/扫描 PDF OCR；未支持格式明确提示 |
| 研究与外部工具 | 可选公开网页来源、当前工作区只读研究、工作区隔离的可见浏览器和已配置 MCP 服务 |
| 内容收集 | 网页和媒体分享链接、本机音视频、逐字稿与可选画面分析，保存至所选 Notion 位置 |
| 会议与转写 | 本机音轨识别、停止收尾、录音资料和可选 DeepSeek 摘要；转写后端按平台调用 |

各入口仍有格式、数量、来源、权限和协议限制。原生邮件、完整外部连接器、图片生成、任意代码沙箱等不属于已完整接入的能力。实现与实机验收分别记录，详见 [AI 对接检查](AI-INTEGRATION-AUDIT.md)、[引用覆盖](AI-REFERENCE-COVERAGE.md) 和 [内容收集说明](CONTENT-COLLECTION.md)。

## 运行结构

Windows 常用启动顺序：

```text
Switch Notion.exe
  → scripts/launch.ps1
  → Node.js 执行项目脚本
  → 检查并准备本机隔离副本
  → 打开 Switch Notion 窗口
```

EXE 是负责启动的入口程序。聊天、Writer、更新、附件等主要功能由项目代码执行，已有运行副本在正常重新启动时检查是否需要接入新代码。

| 目录或文件 | 用途 |
| --- | --- |
| `src/` | 业务、模型、原生协议、设置及平台接口代码 |
| `scripts/` | 查找安装、准备/启动副本、更新、检查及开发构建脚本 |
| `bin/` | 完整 Windows 项目或分发目录中的 Node 运行环境；源码模式也可使用已安装的 Node |
| `assets/` | 图标及允许随项目保存的资源 |
| `.notion-switch/` | 本机配置、登录、历史、运行副本与缓存，不提交用户资料 |
| `research/` | 本机研究及验证资料，不提交 |
| `dist/` | 构建产物，不是日常启动所必需的目录 |

直接 Git 克隆不会取得已编译的 Windows EXE、本机 Node 二进制、模型及用户资料。源码使用 Git、Node.js 22+ 和本机官方 Notion，可通过 `npm start` / `npm run settings` 启动。已有完整项目目录可使用对应启动入口。

## Windows 与 Mac 的共享边界

聊天、Writer、模型调用、权限与写入核验、历史、引用、附件和数据库处理共用核心代码。网页脚本适配也按已审核的脚本内容选择，相同脚本及配置在两端使用相同处理逻辑。历史文件名中的 `macos-client` / `macos-speech` 表示样本最初来源，不代表另有一份 Mac 业务实现。

安装路径、启动、签名、登录与系统权限、进程命令、文件下载、网络连接和转写后端由平台接口适配。Windows GPU 算子与 Mac CPU 路线可以使用不同资源和调用方式，内容处理仍复用共享流程。Windows 和 Mac 的分发构建入口分别维护。

当前主要面向 Windows x64 和 Apple Silicon Mac。既有 Mac 使用记录、共享代码和协议测试不能代替所有新增原生控件的 Mac 实机验收。详见 [平台接口](PLATFORM-INTERFACE.md)、[语音接口](SPEECH-INTERFACE.md) 和 [Mac 验收清单](MAC-CHECKLIST-ACCEPTANCE-2026-10-29.md)。

## 启动器编译与打包

| 操作 | 实际用途 | 通常何时需要 |
| --- | --- | --- |
| 更新功能代码 | 修改 `src/`、`scripts/` 中的功能实现 | 增加功能、修复 AI/界面/协议问题；重新启动后接入 |
| 编译 Windows EXE | 将 `scripts/windows-launcher.cs` 编译成启动入口 | 启动提示、入口动作或启动器自身实现改变 |
| 打包分发 | 按允许清单整理代码、启动器、运行环境和依赖，生成可迁移目录或 ZIP | 换电脑、交付给别人或保存分发版本 |

日常功能更新通常不需要重新编译 EXE，也不需要生成 ZIP。Windows EXE 依赖相邻项目文件，单独复制 EXE 不能组成完整应用。完整迁移包的体积取决于是否包含离线语音/GPU 资源；本机继续使用时可以保留现有资源。

只编译 Windows 主启动器时，可在项目根目录使用已有脚本：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/compile-launcher.ps1 -Source scripts/windows-launcher.cs -Destination "Switch Notion.exe"
```

配置、更新和快捷收集 EXE 使用同一份 C# 源码，按入口文件名选择动作。上述编译命令不会生成 ZIP。`npm run prepare:launchers` 是另一个根入口准备脚本，当前也会准备 Mac `.app`，不能将它视为仅编译 Windows EXE 的命令。

源码更新器目前不会自动重新编译启动器；如果启动器源码发生变化，需要另行编译或替换相应 EXE。打包命令 `npm run package:windows` / `npm run package:mac` 用于分发，普通使用不需要执行。

## 更新按钮与调用链

配置窗口的“版本与更新”包含项目代码更新与本机官方客户端同步。两者分别处理。

| 按钮 | 动作 | 会否重启 |
| --- | --- | --- |
| 更新 Switch Notion | 获取 GitHub `main` 新代码，检查、测试并接入 | 有更新或本地代码待接入时重启 |
| 检查更新 | 刷新本机官方版本、隔离副本、网页适配状态及历史结果 | 不重启 |
| 同步原版 Notion 并重启 | 用本机官方 Notion 重新准备隔离副本，接入当前本地代码 | 成功准备后重启并打开配置 |
| 恢复上一个版本 | 恢复上一份运行副本或适配组件 | 有备份时恢复并重启 |

### 更新 Switch Notion

`update.client` → `UpdateService.updateClient()` → `ClientUpdate.prepare()` → 获取 GitHub 更新 → `update-helper.mjs client` 等待退出 → 应用快进更新 → `runProjectTests()` → `start-desktop.mjs` 启动检查。

更新需要独立 Git 仓库、`main` 分支、干净工作区和可用的 GitHub 访问。下载失败保留当前运行；测试或启动失败尝试恢复更新前代码。本地改动、提交分歧或正在进行的任务会阻止更新。没有 Git 仓库的独立迁移包不能使用这条源码更新流程。代码已是最新且运行副本也已接入时，不必重启。

### 检查更新

`update.status` → `UpdateService.request()` → `runtime-update.mjs:updateStatus()`，同时读取当前 Git 安装信息、运行代码是否待接入以及本次网页适配结果。

此操作检查本机状态，不执行 GitHub 拉取，也不访问官网下载新版官方 Notion。官方客户端尚未在本机升级时，这个按钮不会知道远端新版本是否已经发布。

### 同步原版 Notion 并重启

`update.apply` → 兼容与任务检查 → `update-helper.mjs update` 等待退出 → `start-desktop.mjs` → `prepareRuntime(force=true)` → 备份并准备隔离副本 → 启动检查。

版本以本机已安装的官方 Notion 为准。官方客户端已升级且兼容时，隔离副本可跟随升级；官方版本没变时，同步可能保持相同版本号。这个操作不下载新版官方客户端、不拉取 GitHub 代码，也不编译启动器。准备或启动失败时保留或尝试恢复可用副本。

`NotionSwitch 更新.exe` 通过 `launch.ps1 -Target update` → `open-update.mjs` 进入本机客户端同步流程，不是 GitHub 源码更新入口。

### 恢复上一个版本

`update.rollback` → `update-helper.mjs rollback` → `rollbackRuntime()` → `start-desktop.mjs`。恢复对象是隔离运行副本或 Mac 的适配组件快照，不是 Git 源码版本；没有可用备份时不执行恢复。

以上重启操作前应确认页面已同步并结束活动任务。登录、密钥和本机历史不随运行目录交换。历史显示“原型已同步，启动检查通过”只说明当次启动成功，当前网页协议是否兼容仍须另看网页适配状态。

## 资料、费用与验证范围

密钥和登录资料保存在各电脑本机，迁移包不附带这些资料、官方 Notion 安装或服务额度。调用 DeepSeek 时，选定的必要正文、附件或识别结果会作为资料交给模型；启用联网搜索后，搜索词进入已配置的搜索服务。本机 OCR、转写与模型摘要的处理位置不同，详见各功能接口。

本机聊天记录默认不自动同步到其他设备；显式导入、导出或共享按各自功能处理。跨工作区访问需要分别配置连接并授权目标页面。项目不会把权限检查、结果不确定的写入或未知网页协议视为成功。

验收记录按源码/协议、合成调用和真实窗口分别保存。2026-11-16 的共用 AI 客户端回归为 54 个测试文件、447 项通过、0 跳过；这不等于全部功能或所有平台的实机验收。后续结果见 [AI 对接检查](AI-INTEGRATION-AUDIT.md) 及 [Windows 验证清单](WINDOWS-VALIDATION-CHECKLIST.md)。

使用入口和日常操作参见仓库根目录的 [README](../README.md)、[Windows 使用说明](../WINDOWS-使用说明.md) 与 [Mac 使用说明](../MAC-使用说明.md)。
