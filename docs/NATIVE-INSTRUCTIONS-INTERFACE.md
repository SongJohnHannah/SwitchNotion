# Notion 客户端指令与技能接口（实现中）

**追加状态（2026-10-28）：用户已明确授权，早期“等待正文授权”状态已被本次实现取代。** `native-instructions.cjs` 已接入侧栏第一轮模型之前，读取当前账号目录、当前工作区个人设置、已选个人页及技能目录；手动技能先读正文，自动技能按目录通过 `use_notion_skill` 读取。每轮/工具前核对来源，变更或关闭时停止旧指令。`workspace-memory.cjs` 另提供单账号、按工作区隔离的本地记忆、指令和技能，配置入口在对应 API Key 卡片；本地 `/技能名` 或自动目录使用 `use_workspace_skill`。全局 Instructions 组合优先级未审核时明确拒绝，不静默省略。旧的 3 项待接线检查现已通过；合成来源验证正文和变更失效通过，真实原生设置/Mac 控件待验收。以下保留早期调查、授权与选择内核记录。

2026-10-28。目标是让客户端已选的 Personalize 指令与 Skills 实际影响对应 AI 请求，并在更改、关闭或切换账号/工作区后停止使用旧选择。采集模块另行验收，Mac 的运行、登录、签名和音频实现保持。

**目前只有不联网的选择内核完成，尚未读取真实指令页，也没有将其正文接入 DeepSeek。** 自动审批拒绝了真实指令/技能正文读取与模型接入的代码补丁，理由是现有真实验收授权仅限合成资料。真实资料链路等待新增授权；不能把以下合成测试记为该功能已可用。

## 已核对的原生协议

[官方指令说明](https://www.notion.com/help/instructions-for-notion-agent) 描述个人 Agent 在每个对话使用当前生效的一页 Instructions；[Skills 说明](https://www.notion.com/help/create-and-manage-skills) 区分手动选择与相关任务中的自动使用。普通页面共享本身不会为别人设置个人指令。

| 部分 | 公开生产者或模型 | 核对结论 |
| --- | --- | --- |
| 个人设置 | [当前上下文生产者](https://app.notion.com/_assets/36153-3ec742f43c7a5c48.js) 模块 674880 | `space_view.settings.agent_personalization_settings.context_page_id` 是用户选定指令页；`name` 影响 Agent 称呼。个人设置按当前用户和工作区读取 |
| 工作区目录 | [原生 RecordModel](https://app.notion.com/_assets/RecordModel-24fbeefd99de8bce.js) | 当前用户 `user_root` 的 ID 为用户 ID；优先使用 `space_view_pointers`，兼容旧版 `space_views`。`space_view.parent_table=user_root`、`parent_id=用户 ID`、`space_id` 确定归属，不能假设存在 `user_id` 字段 |
| 自动技能 | [原生设置选择器](https://app.notion.com/_assets/createCollectionPage-67f6e28afed68deb.js) 模块 543858/214062 | 合并已安装、旧版自动和编辑技能，应用个人关闭/覆盖、工作区默认和当前用户所属分组的默认技能 |
| 所属分组 | [原生成员分组读取](https://app.notion.com/_assets/UISpacePermissionGroupToken-cbfe38c487518b52.js) 模块 491920 | `getSpacePermissionGroupIdsContainingMembers` 只应查询当前用户，使用 `userToGroupMap[当前用户]`；不能信任客户端任意传入的分组列表 |
| 手动引用 | [技能菜单](https://app.notion.com/_assets/28805-c854b85a6c3994c8.js) 与 [原生富文本编码](https://app.notion.com/_assets/22194-625f5aaea2cefe74.js) | 使用 `p` 页面注释，可携带显式工作区。页面提及本身不能证明它是技能，需要匹配原生 prompt 标记 |
| 技能标记 | [原生 prompt 模型](https://app.notion.com/_assets/22194-625f5aaea2cefe74.js) 模块 986339 与 [ID 编码](https://app.notion.com/_assets/app-51429654fe3b507f.js) 模块 83388 | `prompt_type=skill` 且父级绑定该页。标记 ID 使用 `MD5("prompt:" + 页面 ID)` 的字节，再按 UUID v4 编码，并非 UUID v5 |

公开脚本仅以文本/语法树检查。测试重放已审核的纯选择函数，不执行整份下载脚本。研究缓存和账号资料均不分发。

## 已完成的纯选择内核

`src/native-instruction-selection.cjs` 只接收内存对象，输出指令页/技能标识和范围，没有文件读写、网络、原生 API、模型调用或运行时接线。

- 检查当前用户目录、个人设置父级、工作区及记录角色；兼容新版指针与旧版 ID 列表。
- 合并个人安装、旧设置、工作区与所选成员分组默认值；关闭、覆盖、重复及禁用开关按已核对的原生选择器处理。
- 保留显式 `p` 引用的工作区并去重；普通链接和格式注释不升级为技能。
- 只有权限/页面范围、确定性 prompt ID、父级及 `prompt_type` 全部匹配时才产生 `skill_candidate`；这仍只是候选标识，尚未读取或应用正文。

`tests/native-instruction-selection.test.mjs` 使用合成账号、设置和引用。已安装/分组默认的结果与公开原生选择器逐项比对，覆盖关闭、切换、越界、错误父级、普通页面伪装和范围上限。

## 待授权的具体接入范围

计划仅在用户从 Notion 客户端发起 AI 请求时执行：

1. 通过当前客户端的同一登录账号，读取其用户目录和当前工作区的个人指令/技能设置；成员分组查询只包含当前用户。
2. 读取当前生效的个人指令页；手动技能按用户本轮引用读取，自动技能先提供启用目录，只按任务相关性读取选中技能正文。普通引用始终作为资料。
3. 仅将本次必要的指令/技能文字发送到用户已经配置的 DeepSeek，作为用户层指导；当前问题优先，不授予额外写入、发消息或扩大任务范围的权限。
4. 每轮及工具操作前复核设置、权限和已用正文；关闭、更改、权限撤销或换工作区时停止旧上下文。多窗口按账号与工作区隔离，不保存跨账号的正文缓存。
5. 不自动读取子页、链接目标或文件附件；未知/过长来源明确失败或标记尚未读取。此接入不自动写入 Notion 页面，也不将测试验收扩展到任意业务页面。

工作区级默认 Instructions 与个人页的组合优先级仍待核对，不把该配置默认为已支持。Custom Agent 自己的指令、会议 Skills、浮动框专用 Skills、用户可编辑记忆与自动记忆仍分别保留待办，不能由个人指令接入替代。

## 验收状态

- 模型前解析缺失已用 `native-instructions-agent-before.log` 复现：合成解析器调用次数为 0。
- 主路由隔离与成员分组接口缺口已用 `native-instructions-bridge-before.log` 复现：原有 4 项通过，新增 2 项失败。
- 待接线的失败验收脚本保留在忽略的 `.notion-switch/pending-native-instructions-*.test.mjs`；未伪装成已通过的运行时测试。
- 纯选择内核 8 项、现有会话桥 4 项与两种实际暂存包共 14 项通过，日志 `native-instruction-selection-packaged.log`；没有真实 Notion 读取、真实正文发送或远程写入。
- Windows 文档允许清单包含本文，递归文档链接验证通过；两种包均从实际复制的源码执行选择内核。此任务未调整 Mac 的运行、登录、签名或音频行为，也未做 Mac 硬件验收。

整体进度仍见 [AI 对接检查](AI-INTEGRATION-AUDIT.md) 与 [Windows 验收清单](WINDOWS-VALIDATION-CHECKLIST.md)。
