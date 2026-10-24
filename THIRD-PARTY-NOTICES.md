# 第三方组件

NotionSwitch 自写源代码采用根目录的 MIT 许可证。

- Windows 包附带 Node.js 时，完整许可保存在 `licenses/NODE-LICENSE.txt`，包含 Node.js 及其第三方组件的许可。它不由项目 MIT 许可证重新授权。
- Notion 桌面客户端属于 Notion，由其原有条款约束。项目 MIT 许可证不覆盖 Notion 客户端、Notion 品牌或 Notion 的云端服务。
- `assets/notion.icns` 和 `assets/notion.ico` 来自官方 Notion 客户端，仅用于用户要求的本地 Switch Notion 启动图标；Notion 图标与品牌不适用本项目 MIT 许可，不代表 Notion 官方产品或认可。
- 仓库研究目录中缓存的公开 Notion 前端脚本属于第三方材料，不纳入项目 MIT 授权，也不放入迁移包。
- API Key、Notion 登录资料、本机聊天历史和运行日志属于本机用户数据，不放入干净的迁移包。
- 可选的离线语音适配使用本机安装的 faster-whisper、CTranslate2 和 Whisper 模型；Windows GPU 后端还需要 NVIDIA 运行库，Apple Silicon 后端使用 CPU。这些组件不随当前源码包分发，项目 MIT 许可证不替代各组件、模型和 NVIDIA 库的原有许可。

项目不附带任何 Notion AI 或 DeepSeek 服务额度。
