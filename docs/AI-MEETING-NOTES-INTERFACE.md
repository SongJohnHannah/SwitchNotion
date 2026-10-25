# Notion 原生 AI 速记接口调查

原始调查日期：2026-10-24，下面的协议调查基于 Notion 官方公开前端资源，不是一次实录抓包结果。2026-10-25 已实现本机转写与 DeepSeek 原生摘要写回，并在 Windows 上完成一次真实摘要生成与服务器读回；当前实现见 [离线语音](OFFLINE-SPEECH.md) 和 [摘要接口](MEETING-SUMMARY-INTERFACE.md)。

## 结论

AI 速记包含独立的音频转写通道和会议总结请求。替换聊天模型不能自动替换这两个流程。查到的通道属于 Notion 客户端内部协议，不是 JohnBot 等官方页面连接使用的内容接口。

| 阶段 | 客户端调用 | 已确认行为 |
| --- | --- | --- |
| 获取音频会话凭证 | `getAudioProcessorAuthToken`，通过 `environment.api.callApi` 调用 | 返回 `accessToken`，使用 Notion 客户端的请求上下文 |
| 建立实时音频连接 | AudioProcessor + Primus / WebSocket | 连接参数包含 `sessionId`、`token`，可附带 `isReauth` |
| 发送音频 | 长连接 RPC 消息 `type: "/api/v1/audioData"` | 数据包含 `base64Audio`、`language`、`userId`、`spaceId`、`blockId`，可含 `audioSource` |
| 声明当前会议 | 长连接 RPC 消息 `type: "/api/v1/transcriptionInfo"` | 携带 `rootBlockId` 与 `spaceId` |
| 停止并收尾 | 长连接 RPC `drainTranscription` 等 | 等待剩余转写，并完成客户端写入收尾 |
| 新会议总结 | `runMeetingNotesAgent`，通过 `callStreamApi` 调用 | 包含会议块 ID、工作区、语言、摘要目标及模板；返回流式事件/记录更新 |
| 旧会议总结 | `runInferenceTranscript`，通过 `callStreamApi` 调用 | config 的 `type` 为 `summarize-transcript`，包含 transcriptPointer、summaryTabId、language 等 |

普通网页请求层将上述 API 事件名路由到 `/api/v3/<eventName>`。音频 RPC 消息的 `/api/v1/...` 是长连接消息类型，不能把它直接当作 HTTP POST 地址。

生产配置中的 AudioProcessor 基址包括：

```text
https://audioprocessor.app.notion.com
https://audioprocessor.www.notion.so
```

当前 Primus 库的默认路径为 `/primus-v8`，使用 WebSocket transport。根据当前静态配置推导，对应连接地址形式为：

```text
wss://audioprocessor.app.notion.com/primus-v8?...会话参数...
```

主机可能根据 `.com` / `.so` 环境和动态配置覆盖而变化，查询参数也由客户端生成；这里没有验证某个账号的最终网络连接 URL，不能视为稳定的公开开发接口。

## 额度与识别模型

客户端处理服务端的 `free_trial_limit_update`、`upgrade_required`、`live_transcription_unrecoverable` 等事件。免费分钟数并非只在页面按钮上检查；只修改前端提示不会接通自己的语音识别后端。

`audio_writer_settings` 的设置中存在 `transcription_model` 和 `streaming_transcription_route_id`。当前代码声明了 AssemblyAI、Baseten、Fireworks、OpenAI、xAI 等识别/路由枚举，具体选择由服务端返回。这不能证明某个工作区实际使用了其中哪一个，也不能证明存在能用个人供应商 Key 直接替代的单一兼容接口。

## 对 NotionSwitch 的影响

原始调查时，接管主要覆盖侧栏 Agent 和浮动文字编辑。目前 AudioProcessor 已接入本机识别，`runMeetingNotesAgent` 与 `runInferenceTranscript/summarize-transcript` 已接入 DeepSeek 摘要。原生“笔记”是手写区域；AI 生成后新增“摘要”标签，而不是覆盖手写笔记或转录。

保留原生速记界面的替代实现需要独立适配：音频采集 → 自选语音识别 → 原生转写事件和记录 → DeepSeek 会议总结 → 摘要记录写回。录音、停止收尾、会话取消、说话人信息及写入核验均需验证，不能仅替换一个模型地址就宣称支持。

## 原始依据

- [音频连接与令牌调用：17048 模块](https://app.notion.com/_assets/17048-31dd3b95acbe5529.js)
- [Primus transport 与默认路径：17521 模块](https://app.notion.com/_assets/17521-084ec2bc2599898c.js)
- [生产环境服务地址：96074 模块](https://app.notion.com/_assets/96074-c5c79faefb3b968b.js)
- [速记动作、额度事件及会议总结：89269 模块](https://app.notion.com/_assets/89269-cbd3af4d28334ce0.js)
- [旧总结请求的流式 API 调用：61459 模块](https://app.notion.com/_assets/61459-7bd1360a1b3f6b61.js)
- [Notion 官方 AI 速记使用说明](https://www.notion.com/help/ai-meeting-notes)
