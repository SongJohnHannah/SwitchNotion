# NotionSwitch Windows 使用说明

当前项目在 Windows 直接双击根目录 **Switch Notion.exe** 即可使用，无需重新打包。迁移包附带 Node.js 运行环境；本机已经完成配置的项目继续使用现有入口和资料。Mac 的既有使用方式见 `MAC-使用说明.md`，本次不重新打包 Mac。

接手验证、修复和后续实现请使用 [Windows 待验证与修复清单](docs/WINDOWS-VALIDATION-CHECKLIST.md)。清单已包含最新引用修复、Mac 原生验收证据、Windows 引用逐项矩阵及尚未对接的 AI 功能待办；请分别记录待实现和实机验收结果。

## 第一次启动

1. 将项目放在可写文件夹；如果拿到的是 ZIP，先完整解压。
2. 双击项目或解压目录根部的 **Switch Notion.exe**（兼容入口 **NotionSwitch.exe**）。程序会自动查找本机官方 Notion 桌面版，并在当前文件夹内准备隔离副本。
3. 如果没有安装 Notion，会出现准备窗口。点击“打开 Notion 官网”，安装并登录后点“重新检测”。也可以选择其他位置已安装的 Notion.exe。
4. 双击 **NotionSwitch 配置.exe**，填写 DeepSeek 和需要访问的 Notion 工作区连接密钥。Notion 登录页中可从本机 Notion 同步登录；先确认页面已同步并退出原版 Notion。
5. 从隔离原型右下角的原生 AI 入口使用 DeepSeek。

可选联网来源：在配置中心 **DeepSeek → 联网搜索与网页阅读** 启用并保存。读取公开网址无需额外密钥；网页搜索需填写独立的 Brave Search API Key。该功能默认关闭，搜索词发送到 Brave，读到的正文作为资料发送给 DeepSeek。覆盖侧栏个人 Agent，以及原生研究模式明确选择“仅网页”的分支；包含 Notion 页面/数据库或全部来源的研究仍等待正文接入授权。详见 [联网来源说明](docs/WEB-SOURCES-INTERFACE.md) 和 [研究模式范围](docs/NATIVE-RESEARCH-INTERFACE.md)。

迁移包不包含 Notion 客户端，也不包含这台电脑的 API Key、登录资料或聊天历史。新电脑需要重新配置密钥和登录。Notion 中已保存的页面仍在原来的账号和工作区中。

## 日常使用与更新

- 根目录 **Switch Notion.exe**：启动原型；正在运行时恢复现有窗口，不中断 AI。无需进入 `.notion-switch/runtime`，也无需执行命令。
- **NotionSwitch 配置.exe**：管理工作区、模型、思考模式及登录；“版本与更新”可查看同步情况。
- **NotionSwitch 更新.exe**：退出空闲原型，重新同步本机安装的官方 Notion，并打开配置。也可从配置中点“更新并重启”。更新前确认页面编辑已经同步。
- 包内还保留对应的 VBS 入口作为备用，日常使用 EXE 即可。
- 更新原版 Notion 后，正常退出并重新启动原型，会自动同步可兼容版本。准备失败会继续保留原型；新版本未通过本机启动检查时恢复上一版。不会自动中断正在进行的任务。
  - 网页模块加载时自动检测：文件名、分包、变量名或排版变化且结构与作用域一致时自动适配。权限、协议或录音流程实质改变时暂停相关接管，可能需要新版 Switch Notion；版本回退不能保证恢复网页协议。配置“版本与更新”可查看检测结果。桌面当前自动识别范围是兼容接入结构的 Notion 7.x、Electron 44；新的主版本保留已有原型并显示提示。

所有运行资料保存在解压目录的 `.notion-switch` 中。不要把该目录当成干净安装包公开发送。跨电脑搬运 Cookie 不受支持，请在新电脑重新登录。

## 图片聊天

选择 DeepSeek Flash 后，可从原生输入框上传 PNG、JPEG、GIF 或 WebP 图片。发送后，图片保留在聊天记录中，可查看缩略图和打开预览；升级前已保存的图片消息也会恢复展示。图片文件保存在本机资料目录的 `image-attachments` 中，与 Mac 使用同一套展示和读取逻辑。Windows 分发包已通过上传、预览和重启读取的自动测试，桌面界面仍需 Windows 实机复核。

## 文档聊天

在原生侧栏输入框主动上传 TXT、Markdown、CSV/TSV、JSON、文字型 PDF、DOCX 或 XLSX，并输入处理问题后发送。必要正文、文件名、页码或单元格位置会交给已配置的 DeepSeek；同账号、工作区和对话的后续问题可继续使用这些附件。文档可使用 Flash 或 Pro；当前消息混合图片时仍需 Flash。

单文件最多 16 MiB，本轮当前与历史附件合计最多 8 个、24 MiB、240,000 个解析资料字符。扫描 PDF 需要 OCR，当前不支持；宏、脚本和公式不执行，缺失的公式缓存会提示。原始文档保存在既有资料目录的 `document-attachments`，不自动读取 Notion 页面里的文件；详见 [文档附件接口](docs/NATIVE-DOCUMENTS-INTERFACE.md)。实际路由和合成模型验收通过，原生上传/下载控件仍待手工验收。已有进程请正常退出后重新双击入口加载新源码。

## 许可

NotionSwitch 自写代码采用 `LICENSE` 中的 MIT 许可证。第三方组件及 Notion 客户端不由该许可证重新授权；见 `THIRD-PARTY-NOTICES.md`。Node.js 的完整许可位于 `licenses/NODE-LICENSE.txt`。
