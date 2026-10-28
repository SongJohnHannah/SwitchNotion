# 第三方组件

NotionSwitch 自写源代码采用根目录的 MIT 许可证。

- Windows 包附带 Node.js 时，完整许可保存在 `licenses/NODE-LICENSE.txt`，包含 Node.js 及其第三方组件的许可。它不由项目 MIT 许可证重新授权。
- Notion 桌面客户端属于 Notion，由其原有条款约束。项目 MIT 许可证不覆盖 Notion 客户端、Notion 品牌或 Notion 的云端服务。
- `assets/notion.icns` 和 `assets/notion.ico` 来自官方 Notion 客户端，仅用于用户要求的本地 Switch Notion 启动图标；Notion 图标与品牌不适用本项目 MIT 许可，不代表 Notion 官方产品或认可。
- 仓库研究目录中缓存的公开 Notion 前端脚本属于第三方材料，不纳入项目 MIT 授权，也不放入迁移包。
- API Key、Notion 登录资料、本机聊天历史和运行日志属于本机用户数据，不放入干净的迁移包。
- 可选的离线语音适配使用本机安装的 faster-whisper、CTranslate2 和 Whisper 模型；Windows GPU 后端还需要 NVIDIA 运行库，Apple Silicon 后端使用 CPU。这些组件不随当前源码包分发，项目 MIT 许可证不替代各组件、模型和 NVIDIA 库的原有许可。
- 网页自动兼容检查内置 Acorn 8.16.0（MIT）、eslint-scope 8.4.0、esrecurse 4.3.0 和 estraverse 5.3.0（BSD-2-Clause）；完整许可位于 `src/compat/VENDOR-LICENSES.txt`。构建依赖不随运行包分发。解析与作用域检查在本机执行，不执行待检查的脚本，不上传账号或页面内容。
- 公开网页正文读取内置 parse5 7.2.1（MIT）与 entities 4.5.0（BSD-2-Clause）。完整许可位于 `src/vendor/parse5/LICENSE` 与 `src/vendor/entities/LICENSE`；来源、固定版本和文件校验值见 `src/vendor/web-parser.manifest.json`。仅调整 parse5 对 entities 的相对模块引用，不执行网页脚本。
- 本地聊天文档解析内置 unpdf 1.9.1（MIT）的服务端 PDF.js 6.4.299 构建、pdfjs-dist 6.4.299（Apache-2.0）的 CMap/字体数据，以及 saxes 6.0.0（ISC，含上游继承的 MIT 许可）和 xmlchars 2.2.0（MIT）。完整许可分别位于 `src/vendor/unpdf/LICENSE`、`src/vendor/pdfjs-dist/LICENSE`、`src/vendor/saxes/LICENSE` 与 `src/vendor/xmlchars/LICENSE`。固定版本、归档校验及文件哈希见 `src/vendor/document-parser.manifest.json`；saxes 仅调整对 xmlchars 的相对引用，其归档遗漏的完整许可证按同版本上游文件及固定哈希补入。不包含 PDF.js 浏览器查看器，不联网下载字体或映射。
- 上述 PDF.js CMap 与标准字体还各自附带原始许可，见 `src/vendor/pdfjs-dist/cmaps/LICENSE`、`src/vendor/pdfjs-dist/standard_fonts/LICENSE_FOXIT` 与 `src/vendor/pdfjs-dist/standard_fonts/LICENSE_LIBERATION`；保留这些完整文本及资源原始字节，不能仅按 PDF.js 主许可证理解全部字体资源。

项目不附带任何 Notion AI、DeepSeek 或 Brave Search 服务额度。

- 快捷收集内置 [SongJohnHannah/media-kit](https://github.com/SongJohnHannah/media-kit) 1.1.0 的独立运行代码，按上游声明的 MIT 许可使用。原始文件哈希、来源和本地适配说明位于 `src/collection/media-kit/manifest.json` 与 `NOTICE.md`。
- yt-dlp 与 FFmpeg 在需要时从各自发布来源下载到本机，不随迁移包携带。FFmpeg 对应平台的完整许可保存在本机收集组件目录 `collection/bin/FFMPEG-LICENSE.txt`；项目 MIT 许可证不替代这些组件的原有许可。
