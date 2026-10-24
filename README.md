# NotionSwitch

在 Notion 桌面版的原生 AI 界面中使用自己的 DeepSeek API Key，支持当前页面上下文、跨页面操作和多个已授权工作区。应用显示名为 Switch Notion，复用 Notion 图标。Windows 已实测；M1 Mac 启动与打包代码已实现，待真机验收。

项目通过本机隔离副本和协议适配器接入 DeepSeek。原版 Notion 安装保持原样，Notion 页面内容通过官方 API 读取和修改。本项目是独立原型，与 Notion、DeepSeek 官方没有隶属关系。

## 功能

- 保留页面右下角原生 AI 入口、侧栏对话、流式回复、停止和续聊。
- 在原生模型菜单切换已接入的 DeepSeek Flash / Pro，并在配置中设置思考模式和多 Agent 协同。
- 自动识别当前页面和工作区，支持“总结此页面”“修改当前页”。
- 搜索和读取已授权页面，创建、修改、移动和归档页面，操作内容块、表格、数据库及相关内容工具。
- 在配置界面添加多个工作区连接，只需名称和 API Key；工作区标识自动识别。
- 本机保存历史对话、任务进度和写入核验记录，支持上下文压缩和自动续跑。
- 支持选区引用和原生浮动 AI 编辑预览。
- 整个普通表格、数据库或记录的选区即使没有文字预览，也能保留引用并读取对应行、字段和记录；记录选区不会自动扩展为整库。视图筛选信息无法确认时会说明范围。
- Flash 图片输入已接入；原生附件上传的完整链路仍需进一步实测。
- 提供 Windows 一键启动与登录同步，新增 M1 Mac 双击启动和 `.app` 分发入口、兼容版本同步和上一版本恢复。

跨工作区操作需要分别配置连接并给目标页面授权。默认使用当前工作区；需要跨区时明确指定工作区或要求跨工作区搜索。未授权页面无法通过连接访问。

## M1 Mac 双击启动

未压缩入口现放在项目根目录：Windows 双击 `Switch Notion.exe`，M1 Mac 双击 `Switch Notion.app`，Mac 也可用 `Switch Notion 启动.command`。入口按当前系统查找 Notion。详见 [一键启动说明](一键启动说明.md)；重新生成入口使用 `npm run prepare:launchers`，无需 ZIP。

下载源码后双击根目录的 `Switch Notion 启动.command`；配置入口为 `Switch Notion 配置.command`。Mac 分发包可双击 `Switch Notion.app`，或把应用拖入“应用程序”后打开。首次自动查找官方 Notion，缺少运行环境时由窗口提示准备，无需输入终端命令。

Mac 代码和分发包已生成并通过合成流程测试，M1 真机尚未验收，也尚未提供 Apple Developer ID 公证。安装、首次系统确认及本机资料位置见 [Mac 使用说明](MAC-使用说明.md)。

## Windows 使用

Windows 支持 x64。需要本机安装官方 [Notion 桌面版](https://www.notion.com/desktop)。

桌面安装、启动、更新校验和登录策略已封装到平台接口，自动按本机系统查找 Notion；接入说明见 [平台接口](docs/PLATFORM-INTERFACE.md)。

如果使用迁移包：

1. 完整解压 ZIP 到可写目录。
2. 双击 `Switch Notion.exe`（保留原入口 `NotionSwitch.exe`），自动查找已安装的 Notion。
3. 未安装时，使用准备窗口的官网入口安装，随后重新检测；也可手动选择安装位置。
4. 双击 `NotionSwitch 配置.exe`，填写 DeepSeek Key 和需要访问的工作区连接密钥。
5. 在隔离原型中登录，或在配置界面按提示同步本机 Notion 登录。
6. 从页面右下角原生 AI 入口开始使用。

换电脑需要重新登录、配置密钥并授权页面。迁移包不附带 Notion 客户端、服务额度或用户数据。详细步骤见 [Windows 使用说明](WINDOWS-使用说明.md)。

## 从源码运行

需要 Node.js 22 或更新版本，无第三方 npm 依赖。

```powershell
git clone git@github.com:SongJohnHannah/SwitchNotion.git
cd SwitchNotion
npm run settings
```

也可以双击项目内的 `NotionSwitch 配置.vbs` 或 `NotionSwitch 启动.vbs`。源码运行时需要自行安装 Node.js；迁移包自带运行环境。

开发命令：

```powershell
npm start
npm run status
npm run stop
npm test
npm run check:secrets
npm run package:windows
```

Windows 迁移包构建产物保存在 `dist/`，不创建桌面文件。配置界面保存后，下一轮 AI 对话使用新设置。

## 密钥和本机资料

**DeepSeek Key、Notion 连接密钥、登录资料和本机聊天记录只在本机保存，不提交到 Git，也不打包分发。** 调用 DeepSeek 时，Key 通过官方 HTTPS API 用于认证，不传给 Notion。选定的页面内容会作为任务上下文发送给 DeepSeek。

- 本机运行资料集中保存在 `.notion-switch/`；整个目录已忽略。
- `research/` 包含本机验证记录，`dist/` 包含构建产物，均不提交。
- `.env`、私人配置、密钥文件、Cookie、日志和私钥文件已加入忽略规则。
- `npm run check:secrets` 检查实际 Git 暂存内容，并与本机已配置密钥比对；发现凭据或私人文件时停止，且不输出密钥值。
- 打包使用允许清单，并额外检查凭据内容。新电脑的初始配置不包含工作区或 API Key。

不要公开复制整个使用过的项目目录；分发时使用 `npm run package:windows` 的干净产物。

## 更新与兼容

已审核 Notion 7.40.0 和 7.40.1。兼容检查目前覆盖原有接入结构的 Notion 7.x、Electron 44，以及已审核的网页模块。

原版更新后，完全退出并重新启动原型会尝试同步兼容版本。配置中的“版本与更新”提供检查、更新并重启、恢复上一版；也可使用独立的更新启动入口。更新不会自动打断正在进行的 AI 任务。

更新在项目内暂存和校验，通过本机启动检查后才确认。准备失败保留现有原型；新版本启动失败时尝试恢复上一版。登录、密钥和历史资料不参与运行目录交换。

启动检查不代表所有云端协议都兼容。Notion 网页协议或桌面接入点变化时，仍可能需要新版适配器；客户端回退也不能保证恢复云端协议。目前没有远程适配器自动发布服务。

## 页面操作边界

写入工具在本机保存核验记录。提交期间断网或停止，远端操作可能已经生效，程序会阻止盲目重复写入；停止不会撤销已提交的修改。客户端版本检查无法提供服务端事务或多人编辑锁。

本地校验失败、官方明确的参数拒绝与结果不确定的写入分别记录。明确未执行的请求不会锁住整轮其他操作；断网、服务端未知错误及写入后的读回失败仍停止后续写入。中间插入使用当前 `position` 参数，通过插入前后的块 ID、顺序和内容核验，回包中的已有相邻块不会被当成新建块。

自动测试覆盖 Agent、工具调用、凭据隔离、模型路由、流式中断、历史、选区、更新与打包等行为；真实 Notion 界面和未来网页版本仍需另行验收。浮动编辑预览已验证，应用修改及浮动框后续追问的完整验收仍有限。旧协议和未知协议不会自动回退到 Notion 托管推理。

依赖已审核 Notion 网页缓存的四项兼容测试，在没有对应本机缓存时明确跳过；第三方网页代码不随本项目分发。其余测试可在干净源码目录运行。

本机聊天记录不会同步到 Notion 云端或其他设备。目前仅接入 DeepSeek。

Windows 新增本机 faster-whisper Medium / NVIDIA GPU 离线转写适配，在配置的“离线语音”中检测现有组件并测试 WAV。原生速记连接、尾段处理和去重已实现并通过协议测试，麦克风控件的实录体验仍待验收；这是按短片段更新的识别，并非逐字实时流式。音频不发送给云端识别，写入 Notion 的文字仍按 Notion 自身规则同步。离线模式不自动调用云端会议总结，需要时可在既有侧栏 Agent 手动要求 DeepSeek 总结页面。转写模块已独立封装：Windows 使用 CUDA FP16，M1 等 Apple Silicon Mac 使用 CPU INT8；M1 和完整 Mac Notion 桌面版尚未实机验收。`npm run package:speech` 可导出不包含模型、运行环境或用户资料的独立模块。详见 [跨平台转写接口](docs/SPEECH-INTERFACE.md) 和 [原生速记适配](docs/OFFLINE-SPEECH.md)。

## 许可证

自写代码采用 [MIT](LICENSE)。Notion 客户端及其前端资源不属于本项目 MIT 授权范围。迁移包包含的 Node.js 保留原有许可，详见 [第三方说明](THIRD-PARTY-NOTICES.md)。
