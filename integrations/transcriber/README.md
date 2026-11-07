# Transcriber 接入统一 GPU 算子

本目录是 `D:\www\claude\transcriber` 的部署暂存区。`original/` 保存修改前必要文件；`integration.diff` 是可审阅差异；`deployment-manifest.json` 记录原始与新文件 SHA256。此子任务没有写入外部项目，也没有启动 GPU 模型。

转写调用统一目录 `D:\迅雷下载\notionSwitch\GPU转写算子` 中的 `bin/node.exe bridge.mjs`，不再导入旧 Torch、faster-whisper 或 CTranslate2，不创建旧双实例模型池。GPU 执行与跨应用资源租约由独立算子负责。`TRANSCRIBER_GPU_BUNDLE` 可明确指定另一算子目录。

## 部署范围

部署 manifest 中 `deploy=true` 的文件到外部项目对应相对路径；先核对现有文件仍匹配 `originalSha256`，并在部署前保留原文件备份。不要部署 `original/`、本说明、diff、manifest、测试日志或测试缓存。已有 `transcriber_state.json` 和媒体文件不在覆盖范围。

启动批文件使用这台电脑已安装 Flask/waitress 的 Python3.12.0，可由 `TRANSCRIBER_PYTHON` 显式覆盖。该 Python 只运行界面和 JSONL 客户端；模型及 GPU 库来自独立包。

## 行为

- 固定展示 `large-v3-turbo / Native30 / CUDA FP16` 稳定方案；旧 beam、模型池和手动切片选项不再生效。
- 默认语言 `auto`；英语采访验收显式设置 `en`，不能混用自动检测与固定英语的性能口径。
- `describe` 只查询入口资源。界面区分资源就绪与最近实际完成的 CUDA 任务，不把资源存在当作 GPU probe。
- 保留文件队列、目录扫描、取消/续跑、进度、TXT、SRT 和可选 IPA。TXT 直接导出算子原文；SRT 保留全部原始全局时间戳；IPA 仅改变派生 TXT。
- 每个源文件在目标输出目录下使用 `.gpu-operator_<stem>-<path-hash>`，保留算子原文、JSONL、checkpoint、音频来源记录和 `transcriber-result.json`。源路径后缀防止同名文件共用检查点；内容身份仍由独立算子校验。
- 取消先发送 stdin `{"type":"cancel"}`，保持 stdin 打开直到算子退出。退出码2/`CANCELLED` 保留检查点与待处理文件；不导出部分成功 TXT。30秒未退出时仅结束本客户端拥有的 bridge 进程树。没有 CPU 回退。
- 实验配置仅通过环境变量 `TRANSCRIBER_GPU_PROFILE` 与 `TRANSCRIBER_GPU_ALLOW_EXPERIMENTAL=1` 同时显式开启；界面不提供实验选项。默认使用 `winner`。

## 验证与离线调用

CPU-only 测试（使用真实 JSONL 子进程夹具，不调用 GPU）已通过22项：

```powershell
& 'C:\Users\songf\.pyenv\pyenv-win\versions\3.12.0\python.exe' -X utf8 -B -m unittest discover -s tests -v
```

部署后可仅描述资源，不载入模型：

```powershell
& 'C:\Users\songf\.pyenv\pyenv-win\versions\3.12.0\python.exe' -X utf8 -B 'D:\www\claude\transcriber\transcribe_file.py' --describe
```

完整 GPU 验收由根 Agent 统一执行，使用同一采访与全新输出根，避免旧检查点复用：

```powershell
& 'C:\Users\songf\.pyenv\pyenv-win\versions\3.12.0\python.exe' -X utf8 -B 'D:\www\claude\transcriber\transcribe_file.py' 'D:\path\interview.mp4' --output-dir 'D:\path\fresh-run' --language en
```

这条 CLI 仅调用 `core.transcribe_one`，不发 Notion 网络请求，使用独立 `transcriber-cli-state.json`。`adapterWallSeconds` 包括 bridge 启动、模型载入、前处理和派生文件写出；算法排名仍应读取算子原始 `start→complete`，不能混用两套数字。桥接 mock 通过不能替代完整 GPU 全片验收。
