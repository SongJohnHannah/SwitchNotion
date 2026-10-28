# 桌面平台接口

平台接口提供 Windows x64 和 Apple Silicon M1 Mac 的安装查找、隔离准备与启动。用户已确认现有 Mac 版本正常使用；2026-10-28 的检查在 Windows 上进行，保留现有 Mac 平台运行实现。新增 AI 引用能力共用同一模块并验证两种分发包，不能据此新增 Mac 硬件实测结论。使用入口见项目 `MAC-使用说明.md`。

## 入口与复用范围

模块入口：`src/platform/index.cjs`，类型声明：`src/platform/index.d.cts`。

```js
// Electron / CommonJS
const { createDesktopPlatform } = require('./src/platform/index.cjs');
const platform = createDesktopPlatform(); // 使用当前系统，不需要用户填写系统类型

// Node / ES modules
// import platformModule from './src/platform/index.cjs';
// const platform = platformModule.createDesktopPlatform();

const installed = platform.discoverInstallation(stateRoot);
if (installed) console.log(installed.appRoot); // 仅安装位置，无凭据
platform.requireCapability('prepareRuntime');
```

DeepSeek、思考模式、工作区路由、Notion 内容工具、上下文压缩和历史记录继续使用原模块。平台模块处理安装位置、文件布局、启动方式、兼容校验策略、应用标识和登录策略。CLI 和配置窗口通过同一接口调用。

## 接口约定

| 接口 | 用途及约定 |
| --- | --- |
| `id / capabilities` | 系统标识及已实现能力；支持查找不代表支持运行 |
| `installationLayout(candidate)` | 只计算安装目录、可执行文件、资源目录和 ASAR 路径 |
| `runtimeLayout(container)` | 计算隔离运行目录内部布局；更新/回退始终交换外层 container |
| `findInstallation(candidate, stateRoot)` | 检查文件存在，拒绝相对路径、隔离目录及指向它的别名 |
| `discoverInstallation(stateRoot)` | 保存的安装位置 → 系统默认位置 → 上次准备位置 → 平台补充来源 |
| `compatibility` | 当前平台的已审核哈希、版本和 Electron 策略；未审核平台保持禁用 |
| `stageInstallation({source, container, copy})` | 在新的暂存目录复制官方安装；平台可采用自己的复制实现 |
| `finalizeRuntime(layout)` | ASAR 注入后、替换现有运行目录前执行；签名失败必须抛错 |
| `launchRuntime({container, stateRoot, env, stdio})` | 启动隔离副本，自动传递本地状态目录；不启动或改写官方安装 |
| `login` | 登录策略和资料位置；不读取或返回 Cookie、密钥 |
| `isNodeExecutable / samePath` | 平台相关的 Node 文件名校验和路径比较 |
| `configureAppIdentity(app)` | Windows 应用标识隔离；其他系统可实现相应策略 |
| `requireCapability(name)` | 能力未实现时，抛出 `PLATFORM_CAPABILITY_UNAVAILABLE`，包含 platform 和 capability |

调用顺序：检查能力 → 暂存安装 → 注入自写模块及 ASAR → finalize → 确认源文件未改 → 交换运行目录 → 启动并健康检查 → 接受版本。失败沿用已有的保留/回退机制。

布局函数不执行文件检查或授权检查。准备和启动必须通过对应能力检查。目录安全、启动锁、备份和回退由共享更新模块负责，平台实现不应自行替换正式运行目录。

Electron 内检测安装与读取归档使用 `original-fs`，避免 Electron 将 ASAR 当作虚拟目录后报 ENOENT。测试与普通 Node 默认使用物理文件系统。

## 当前实现

| 内容 | Windows | macOS |
| --- | --- | --- |
| 安装自动查找 | 用户目录、Program Files、注册表、手动选择 | `~/Applications/Notion.app`、`/Applications/Notion.app`、保存位置 |
| 官方程序布局 | `Notion.exe`、`resources/app.asar` | `Notion.app/Contents/MacOS/Notion`、`Contents/Resources/app.asar` |
| 隔离布局 | `runtime/Notion.exe` | `runtime/SwitchNotion.app/Contents/...`，兼容既有 `runtime/Notion.app` |
| 准备与启动 | 已接入并验证 | 保留既有 ditto 复制、本机签名和启动实现；用户已确认可用 |
| 兼容校验 | Windows 自己的已审核版本和结构检查 | 官方 Mac 7.40.1 独立 ASAR 哈希、结构和发行者签名检查，不继承 Windows 哈希 |
| 登录 | 既有本机 Windows 登录同步 | ARM64 使用既有 `macos-keychain-copy`，其余为交互策略；不执行 Windows Cookie 加密资料复制 |

配置中的登录状态返回 `syncSupported` 和 `loginStrategy`；不支持复制时禁用同步按钮，仍可通过 Electron 检查隔离窗口已登录的状态。该检查不代表服务端会话仍有效。

应用包资源布局依据 [Electron 应用分发文档](https://www.electronjs.org/docs/latest/tutorial/application-distribution)。macOS 的签名和发布要求见 [Electron 代码签名文档](https://www.electronjs.org/docs/latest/tutorial/code-signing)。

## Mac 实现与待验收项目

1. `macos.cjs` 配置官方 Mac 7.40.1 的独立 ASAR 哈希与 Electron 44 策略；`macos-runtime.cjs` 校验 ARM64 Mach-O、官方签名和发行者要求。
2. stageInstallation 验证内部链接，使用系统 ditto 保留 `.app` 结构及权限，拒绝外部链接。源码和独立副本分别检查。
3. finalizeRuntime 设置 SwitchNotion 包名称及既有应用标识，保留图标并更新 ASAR 完整性哈希，随后本机签名和验证；失败保留上一个版本。不关闭系统安全检查。
4. `.command` 为源码双击入口；`.app` 为可搬到“应用程序”的入口。缺少 Node 时由窗口提示后下载固定 ARM64 版本并核对校验和。Mac 原生工具与 Finder 行为仍需实机验证。
5. 源码模式在项目内保存状态；分发 `.app` 使用用户 Library/Application Support。更新工具使用记录的项目位置。ARM64 登录沿用已有 Keychain 复制实现，本轮不修改其行为；类型声明现与该策略一致。
6. 已有 Mac 原生 AI 回复选区验收记录见 [引用覆盖](AI-REFERENCE-COVERAGE.md)。新增浮动框附加引用和 AI block 指定页面的原生控件仍需在 Mac 上复核；本轮不重复调整已经可用的启动、签名、登录和录音流程。正式下载分发还需 Developer ID 签名及公证。当前不考虑 Intel Mac。

共享的 Agent 和页面工具不应加入 macOS 路径判断。API Key 保持各电脑本地配置，不把 Windows 登录、密钥或用户状态打进 Mac 包。

语音转写另有独立的 [转写接口](SPEECH-INTERFACE.md)：Windows CUDA FP16 和 M1 CPU INT8 共用 `SpeechProvider`。M1 后端的实现和模拟契约测试不代表 Mac Notion 的准备、签名或原生录音已完成实机验收。

## 验证方式

`tests/desktop-platform.test.mjs` 跨平台构造安装布局，检查真实查找、启动参数和未支持能力无副作用。`tests/macos-launch.test.mjs` 和 `tests/package-macos.test.mjs` 验证 Mac 签名顺序、完整性、失败保留、分发路径和 ZIP 可执行位。`tests/runtime-update.test.mjs` 验证共享更新与回退；这些测试不代表完成 macOS 实机运行。

运行 `npm test` 验证 Windows 现有行为。Windows 包仍由 `npm run package:windows` 构建，自动包含 `src/platform/`，并沿用密钥过滤和分发允许清单。
