# 清理与更新保留规则

## 本次清理记录

2026-11-06，按明确的本机路径清单完成：

- 23 个已结束的临时测试副本。
- 3 个已完成的图标、启动及生成文件诊断目录。
- 3 个旧打包暂存目录。
- 21 个旧 Mac 分发包、校验文件及展开目录。
- 11 个已结束的图标诊断辅助脚本、结果文件及临时提交清单。

前四项共 50 个清理目标，逻辑大小约 2.20 GiB；包含硬链接，因此不将逻辑大小等同于实际释放空间。没有清理历史研究目录或删除项目源码。

这些对象原本就位于 Git 忽略的本机产物目录。本次仓库提交记录保留规则与核验结果，不包含源码、测试或 Git 历史的删除。逐项结果仅保存在本机 `.notion-switch/cleanup-confirmed-result.json` 与 `.notion-switch/cleanup-diagnostics-result.json`，不上传私人运行记录。

## 必须保留

- `.git/`、`package.json`、`src/`、`assets/`、`tests/` 及所有测试夹具；`.git/` 是代码更新、版本核对及失败回退所需的仓库元数据。
- 根目录的 Windows/Mac 启动与配置入口、`bin/`、许可证及第三方声明。
- 更新链路：`src/client-update.cjs`、`src/update-service.cjs`、`scripts/client-tests.mjs`、`scripts/client-update-helper.mjs`、`scripts/update-helper.mjs`、`scripts/runtime-update.mjs`、`scripts/runtime-health.mjs`、`scripts/start-desktop.mjs`、`scripts/launch-lock.mjs`、`scripts/launch.ps1` 及其依赖。
- 当前运行目录、`runtime-previous/` 与相应版本标记、Mac 适配器快照、启动记录和更新状态；不能把真实回退备份当作临时测试副本清理。
- 用户登录、密钥、资料、未完成任务、录音、写入回执、模型与运行环境；最近一次更新测试及启动日志。
- `research/.public-assets/`、`.notion-switch/writer-assets/`、`research/speech-fixtures/`、Mac 客户端样本等仍被回归测试引用的资料。不能因目录名是 `research` 就整体删除。
- 正在开发的 GPU 算子、转写方法、试验队列及原始识别记录。本次没有停止或删除这些任务。
- 每个平台最新的分发包及对应 `.sha256`，以及仍需保留的语音分发包。

历史文档如仍出现在 Windows/Mac 打包清单中，归档或移除前必须同步处理引用。源代码是否废弃必须核对调用、跨平台行为及更新回退用途，不能仅凭名称或文件日期判断。

## 更新按钮实际执行的检查

“更新 Switch Notion”在 Git 项目模式下下载并应用新代码后，由 `scripts/client-tests.mjs` 直接调用 Node 测试执行器，枚举 `tests/*.test.mjs`。这是当前 `package.json` 中 `npm test` 对应的同一套 Node 测试集，不依赖额外安装 npm。

测试通过后才启动新代码并检查隔离运行副本；测试缺失、失败、超时或新代码启动失败时，尝试恢复更新前版本。若本地已有其他改动，更新或回退会拒绝覆盖这些改动，不承诺无条件强制恢复。测试日志保存在本机 `client-update-tests.log`。

已是最新代码且没有待接入改动时，不会重复运行测试。“同步原版 Notion”是另一条桌面运行副本更新流程，执行兼容性及启动健康检查，不运行整套项目测试。

默认 Node 测试集不等于所有 Python 单测、真实 GPU 连续运行或 Mac 实机验收。若以后扩展 `npm test` 的内容，必须同步更新自动更新的测试入口，不能假定新增 npm 步骤会自动被继承。

## 本次核验

- 清理前，更新、自动测试、失败回退和设置入口专项共 21 项检查通过。
- 删除前逐一核对绝对路径、后代链接、活动进程引用、盘点后的新写入及 Git 跟踪文件；只处理已确认闲置的具体目标。
- 清理后核对 724 个当时存在的项目文件，未发现缺失；11 个关键更新文件校验值一致，受保护的运行目录、回退数据与 Git 版本保持完整。
- 本机清理没有改变更新测试执行器或测试源码，不额外启动更新、GPU 试验或全量测试。
