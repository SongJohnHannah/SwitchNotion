# NotionSwitch Windows 迁移包

这是 Windows x64 包，附带 Node.js 运行环境。无需安装 Node.js、修改配置文件或运行命令。Mac 使用独立的 Apple Silicon 版本，见 `MAC-使用说明.md`。

## 第一次启动

1. 将 ZIP 完整解压到一个可写文件夹；不要直接在压缩包中运行。
2. 双击项目或解压目录根部的 **Switch Notion.exe**（兼容入口 **NotionSwitch.exe**）。程序会自动查找本机官方 Notion 桌面版，并在当前文件夹内准备隔离副本。
3. 如果没有安装 Notion，会出现准备窗口。点击“打开 Notion 官网”，安装并登录后点“重新检测”。也可以选择其他位置已安装的 Notion.exe。
4. 双击 **NotionSwitch 配置.exe**，填写 DeepSeek 和需要访问的 Notion 工作区连接密钥。Notion 登录页中可从本机 Notion 同步登录；先确认页面已同步并退出原版 Notion。
5. 从隔离原型右下角的原生 AI 入口使用 DeepSeek。

迁移包不包含 Notion 客户端，也不包含这台电脑的 API Key、登录资料或聊天历史。新电脑需要重新配置密钥和登录。Notion 中已保存的页面仍在原来的账号和工作区中。

## 日常使用与更新

- 根目录 **Switch Notion.exe**：启动原型；正在运行时恢复现有窗口，不中断 AI。无需进入 `.notion-switch/runtime`，也无需执行命令。
- **NotionSwitch 配置.exe**：管理工作区、模型、思考模式及登录；“版本与更新”可查看同步情况。
- **NotionSwitch 更新.exe**：退出空闲原型，重新同步本机安装的官方 Notion，并打开配置。也可从配置中点“更新并重启”。更新前确认页面编辑已经同步。
- 包内还保留对应的 VBS 入口作为备用，日常使用 EXE 即可。
- 更新原版 Notion 后，正常退出并重新启动原型，会自动同步可兼容版本。准备失败会继续保留原型；新版本未通过本机启动检查时恢复上一版。不会自动中断正在进行的任务。
  - 网页模块加载时自动检测：文件名、分包、变量名或排版变化且结构与作用域一致时自动适配。权限、协议或录音流程实质改变时暂停相关接管，可能需要新版 Switch Notion；版本回退不能保证恢复网页协议。配置“版本与更新”可查看检测结果。桌面当前自动识别范围是兼容接入结构的 Notion 7.x、Electron 44；新的主版本保留已有原型并显示提示。

所有运行资料保存在解压目录的 `.notion-switch` 中。不要把该目录当成干净安装包公开发送。跨电脑搬运 Cookie 不受支持，请在新电脑重新登录。

## 许可

NotionSwitch 自写代码采用 `LICENSE` 中的 MIT 许可证。第三方组件及 Notion 客户端不由该许可证重新授权；见 `THIRD-PARTY-NOTICES.md`。Node.js 的完整许可位于 `licenses/NODE-LICENSE.txt`。
