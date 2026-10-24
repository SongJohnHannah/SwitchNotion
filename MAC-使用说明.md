# Switch Notion：Apple Silicon Mac

适用 M1 等 Apple Silicon Mac，当前 Mac Notion 7.40.1 要求 macOS 13 或更新版本。已实现启动与打包流程、核对官方 Mac 安装包并通过合成流程测试；尚未完成 M1 真机启动、登录和原生 AI 验收。

## 双击启动

下载项目源码后，解压到自己的文件夹，双击项目根目录的 **Switch Notion 启动.command**。以后仍双击这个文件即可；修改配置可双击 **Switch Notion 配置.command**。不需要输入终端命令。

使用 Mac 分发 ZIP 时，解压后双击 **Switch Notion.app**，也可以把它拖入“应用程序”后双击。分发文件夹中的 **Switch Notion 启动.command** 是另一种入口。移动整个源码文件夹可以继续使用；移动分发版 `.app` 后，直接双击移动后的应用。

首次没有合适的 Node.js 时，窗口询问是否准备本机运行环境；确认后从 nodejs.org 下载固定版本的 ARM64 Node，并核对内置 SHA-256。已有原生 ARM64 Node 22+ 时直接复用。首次准备需要网络，日常不再重复下载。

启动器自动识别当前平台。Mac 查找 `~/Applications/Notion.app` 和 `/Applications/Notion.app`；Windows 使用 Windows 安装位置和注册表。无需填写系统类型或安装路径。找不到 Notion 时，窗口提供“选择 Notion”“打开官网”和“取消”。请从 [Notion 官网](https://www.notion.com/desktop) 安装官方应用。

首次在独立窗口中登录 Notion，并在配置页填写本机 DeepSeek 和工作区连接密钥。Mac 使用交互登录，不复制 Windows 登录或 Keychain 资料。登录和原生控件的具体行为仍需在 M1 上验收。

## 名称与图标

应用显示名称为 **Switch Notion**。图标取自官方 Notion；Notion 图标和品牌不属于本项目 MIT 授权。分发包只携带图标和本项目代码，不携带 Notion 客户端。

首次启动核对本机官方 Notion 的签名、发行者和安装结构，复制到独立目录，再注入自己的模块并对副本进行本机签名。ASAR 完整性校验继续保留。原版 Notion 更新后，下一次完全退出并启动 Switch Notion 时会检查和准备兼容副本；失败时保留或恢复上一个版本。

本分发包尚未使用 Apple Developer ID 签名和公证。macOS 首次打开时可能要求系统确认或拦截；需要由你本人按系统提示处理。启动器不修改 Gatekeeper、不移除 quarantine，也不代你批准系统权限。正式公证发布仍需 Apple 开发者签名。

## 本机资料位置

- 源码 `.command` 或根目录项目模式 `.app` 启动：项目内 `.notion-switch/mac-arm64/`。
- 分发 `.app` 启动：`~/Library/Application Support/Switch Notion/`。
- 启动结果：上述目录中的 `launcher-last.log`。

应用移到“应用程序”后不往应用包内写密钥或运行资料。Mac 更新工具使用启动时记录的实际项目路径，可保留原来的本机登录、密钥和历史。

不要把 Windows 的 `.notion-switch/` 直接复制到 Mac。API Key 在新电脑的配置窗口重新填写；M1 的 Python、语音依赖也需使用本机 ARM64 版本。

## 离线语音

M1 使用 faster-whisper Medium / CPU INT8，尚未开启 Apple GPU 加速。下载 Node 和使用 DeepSeek、加载及同步 Notion 页面需要网络；离线语音识别本身不联网。语音模型及 Python 不包含在桌面启动包中，接入准备见项目 `docs/SPEECH-INTERFACE.md`。

## 开发与验证

`npm run package:mac` 在 `dist/` 生成 `.app` 和 ZIP；构建机可以为 Windows，ZIP 会明确保留 Mac 启动文件的 Unix 可执行位。打包不包含本机密钥、登录、模型或研究材料。

Windows 自动测试验证包结构、签名调用顺序、完整性哈希、失败保留和路径扫描，不能代替 M1 真机验收。下载到 M1 后先验证正常启动与登录，再验证配置、原生 AI、停止和续聊、当前页及跨工作区操作。
