# 桌面平台接口

本轮只封装跨平台接入接口，继续提供 Windows 版本。macOS 已实现安装布局和自动查找，但还没有可运行的 Mac 包。

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
| 隔离布局 | `runtime/Notion.exe` | `runtime/Notion.app/Contents/...` |
| 准备与启动 | 已接入并验证 | 能力关闭，未实机验证 |
| 兼容校验 | Windows 自己的已审核版本和结构检查 | 独立策略槽，尚未审核，无 Windows 哈希继承 |
| 登录 | 既有本机 Windows 登录同步 | 交互登录策略；不执行 Windows Cookie 加密资料复制 |

配置中的登录状态返回 `syncSupported` 和 `loginStrategy`；不支持复制时禁用同步按钮，仍可通过 Electron 检查隔离窗口已登录的状态。该检查不代表服务端会话仍有效。

应用包资源布局依据 [Electron 应用分发文档](https://www.electronjs.org/docs/latest/tutorial/application-distribution)。macOS 的签名和发布要求见 [Electron 代码签名文档](https://www.electronjs.org/docs/latest/tutorial/code-signing)。

## 以后接入 Mac

1. 在 `macos.cjs` 中审核目标 Notion 的 ASAR、Electron 与原生接入点，配置该平台自己的 compatibility。
2. 实现 stageInstallation：保留完整 `.app`、可执行权限及框架内部合法链接；不能直接使用当前拒绝符号链接的 Windows 复制逻辑。
3. 实现 finalizeRuntime：对已修改的隔离应用包完成所需签名及验证，失败时抛错。签名身份、Entitlements 和分发方式需要在 Mac 上验证。
4. 验证启动环境、单实例、深链和默认应用关联，必要时调整平台启动实现。交互登录可先使用；要支持迁移登录需另做 macOS 加密/Keychain 适配。
5. 新增 Mac 启动/打包入口，验证 Apple Silicon M1 的原生 ARM64 运行环境。本项目当前不考虑 Intel Mac。Windows 的 PowerShell、VBS、EXE 打包入口继续专用于 Windows。
6. 在 Mac 实机验收原生选区、侧栏、停止/续聊、数据库和跨工作区写入、更新失败恢复后，再打开对应能力。

共享的 Agent 和页面工具不应加入 macOS 路径判断。API Key 保持各电脑本地配置，不把 Windows 登录、密钥或用户状态打进 Mac 包。

语音转写另有独立的 [转写接口](SPEECH-INTERFACE.md)：Windows CUDA FP16 和 M1 CPU INT8 共用 `SpeechProvider`。M1 后端的实现和模拟契约测试不代表 Mac Notion 的准备、签名或原生录音已完成实机验收。

## 验证方式

`tests/desktop-platform.test.mjs` 跨平台构造安装布局，检查真实查找、启动参数和未支持能力无副作用。`tests/runtime-update.test.mjs` 用合成应用包布局运行实际共享更新流程，验证补丁后 finalize 顺序、失败保留和回退；它不代表完成了 macOS 实机测试。

运行 `npm test` 验证 Windows 现有行为。Windows 包仍由 `npm run package:windows` 构建，自动包含 `src/platform/`，并沿用密钥过滤和分发允许清单。
