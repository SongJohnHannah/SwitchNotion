# 客户端联网来源接口

2026-10-28。实现范围是 Notion 客户端侧栏个人 Agent，以及原生研究模式的明确“仅网页”分支：公开网页搜索、正文读取和带来源链接的回答。默认关闭；本任务未调整 Mac 已正常工作的运行、登录、签名和音频实现。采集模块由另一任务验收。

## 使用

在配置中心的 **DeepSeek → 联网搜索与网页阅读** 中启用并保存。读取公开网址无需额外密钥；搜索需要在同一表单保存 Brave Search API Key，并使用该账号的服务额度。密钥留空保留原值，勾选移除后保存才会清除。

启用后可在侧栏给出公开网址，或要求搜索网页。问题派生的搜索词发送到 Brave Search，读到的网页正文作为本轮资料发送给已配置的 DeepSeek。正文与搜索结果属于资料，不能授予额外操作权限。配置页的“检测搜索连接”只发送固定合成检测词。

此设置也供原生 Research Mode 的明确“仅网页”分支使用，见 [研究模式接口](NATIVE-RESEARCH-INTERFACE.md)；包含 Notion 或全部来源的研究仍等待正文接入授权，不能自动缩小范围。它不会开启交互式浏览器、浮动编辑、AI block、会议、Calendar 或 Custom Agent 的联网；侧栏续聊沿用原始线程类型，不能由新消息改成个人线程来获得工具。原生搜索菜单与管理员策略同步未完成，不能把本地开关称为全部原生控制的兼容实现。

## 入口与工具

公开侧栏生产者 [18091 模块](https://app.notion.com/_assets/18091-8f86e8f728659fe1.js) 将当前消息、工作区和策略传给创建与续聊接口；其中的 `browserEnabled` 是另一项能力，不作为搜索开关。旧版 [搜索菜单模块](https://app.notion.com/_assets/38064-dedcc4138e3e886e.js) 的 `useWebSearch` 配置也不能直接当成新版侧栏协议。

`desktop-hook.cjs` 将共用 `WebSources` 交给配置服务与 `NativeMock`，后者把每轮会话工具传入 `runAgent`。保留当前账号/工作区的本地对话归属检查；被拒绝的请求不能打开网络会话。

| 工具 | 输入 | 结果与范围 |
| --- | --- | --- |
| `search_web` | 搜索词、可选时间范围和页码 | Brave 固定官方端点；返回标题、摘要、网址、读取时间和分页状态，明确 `body_available=false`、`snippet_only=true` |
| `read_web_page` | 已明确提供或已核对来源的网址，可选字符位置与长度 | 静态 HTML 主体、纯文本、Markdown 或 JSON；返回最终网址、读取时间、正文片段、快照指纹和完整状态。不会执行脚本、登录、点击或提交表单 |

搜索采用 [Brave Web Search 文档](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) 的接口和分页字段。每批最多 10 条，按服务返回的后续页标记继续；时间范围映射到官方 freshness 参数。不把搜索摘要或标题当作已读全文。

## 读取和保存边界

- 仅访问标准端口的公开 HTTP(S) 地址，不附带 Notion Cookie、登录信息或任意请求头。搜索密钥只发给 Brave 的固定 HTTPS 端点，拒绝跳转。
- DNS 全部解析结果须为公开地址，实际连接固定到已校验地址；每次 HTTP 跳转重新核对。拒绝本机、内网、链路本地、保留地址及常见 IPv6 过渡地址，不允许转向这些目标。
- 每次请求链最多 20 秒、5 次跳转；原始与解压后的响应均限制 2 MiB。HTML 由内置解析器读取，排除脚本、样式、表单、隐藏节点、导航等；不自动加载附带图片、脚本、iframe 或跟随文内链接。
- 正文解析使用独立 Node 线程，不在客户端主线程执行；最多同时 2 项，等待队列最多 16 项，每项含排队最多 4 秒，单线程 V8 老生代限制 128 MiB。取消/超时会终止解析，不继承客户端预载参数或环境变量。当前网络连接使用 Node 直连，不复用浏览器登录或浏览器代理；需要浏览器代理的环境仍需专门适配。
- 仅保存最多 120,000 字符的提取正文；超长时明确 `source_truncated=true`。一轮最多 8 次搜索、12 个网页来源和 480,000 字符缓存。正文未读完、跳过中间范围或被截断时不能报告 `complete=true`。
- 分页基于同轮固定快照，并发读取及跳转别名共用一致快照。结束、停止或关闭设置后释放正文缓存；下一轮重新获取网页，不把旧内容当作实时结果。
- 来源目录来自用户在该对话明确提供的网址、本轮实际搜索结果及同账号/工作区已核对的历史来源。历史只保存最多 32 个、合计 24,000 字符的网址，不保存额外抓取的正文；其他账号和工作区的目录不能复用。
- 更改、关闭设置或清除密钥会取消活动会话；每次工具操作也会重新检查配置。只读协作共享本轮预算，返回实际读取的网址，不获得页面写入能力。
- 网页阅读不能替代 PDF、文件、音视频解析或交互式浏览器。`complete` 只说明本次提取的静态正文已输出完整，不证明登录后或脚本生成的内容可见；登录页、动态提示或未支持格式不能当作目标文章正文。

配置保存在运行资料目录的 `web-sources.local.json`；使用当前平台已有的资料根目录，与工作目录无关。状态接口不回显密钥。分发排除私人配置，并扫描搜索密钥的 UTF-8/UTF-16 内容；解析器与完整许可证随两种包分发，版本及校验见 `src/vendor/web-parser.manifest.json`。

## 验证证据

- 修复前，原生聊天没有打开网页工具；`web-agent-before.log` 已复现。
- 最终项目回归 560 项：555 通过、5 跳过、0 失败/取消，日志 `web-sources-thread-scope-final-tests.log`；继续排除采集模块，跳过原因为两项未安装的官方网页样本和三项按需 GPU 测试。
- 覆盖网络地址、DNS/跳转、实际本机 HTTP 传输、压缩上限、停止、隔离解析/超时、分页、设置、历史续问、只读协作、线程类型、实际桌面路由、许可证及密钥分发；两种实际暂存包都加载自己复制的模块运行工具链。阶段日志 `web-sources-focused.log`、`web-sources-packaged.log`、`web-sources-parser-packaged.log` 保留对应检查范围，不将重叠用例累加为总数。
- 真实公开网页读取通过：IANA 的 [Example Domains](https://www.iana.org/help/example-domains)，得到标题、794 字符主体和完整状态；没有把该公开网页正文发送给模型。结果 `web-sources-public-live-result.json`。
- 最终隔离解析实现的真实 DeepSeek 合成验收通过：2 次模型请求、1 次工具调用、1 次内存合成网页读取，核对随机验收代码及来源链接，会话缓存释放；真实 Notion 读取/修改均为 0。结果 `web-sources-model-live-result.json`。早期直接解析另有 2 次模型请求通过，记录 `web-sources-model-before-worker-result.json`；本轮合计 4 次真实模型请求，全部只发送新合成资料。
- 当前没有用真实 Brave 密钥验收搜索服务，也没有在 Windows/Mac 原生窗口点击新增控件。真实服务额度、原生菜单/管理员策略、Research Mode 的工作区/混合来源及交互式浏览器仍须分别完成；不能报告全部官方 AI 功能已对接。

整体待办见 [AI 对接检查](AI-INTEGRATION-AUDIT.md) 和 [验收清单](WINDOWS-VALIDATION-CHECKLIST.md)。上述私有日志与配置不分发。

在源码工作区复现相关检查：

```powershell
node --test tests/web-agent.test.mjs tests/web-sources.test.mjs tests/web-vendor.test.mjs tests/package-safety.test.mjs tests/package-windows.test.mjs tests/package-macos.test.mjs
```
