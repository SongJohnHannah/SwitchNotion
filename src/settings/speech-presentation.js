(() => {
  const turbo = { id: 'large-v3-turbo', name: 'Whisper Large-v3 Turbo' }, medium = { id: 'medium', name: 'Whisper Medium' };
  window.speechPresentation = state => {
    const locked = state.modelLocked === true || state.operatorSession === true;
    const model = locked ? turbo.id : state.model || 'medium';
    const models = locked ? [turbo] : state.modelOptions || [turbo, medium];
    const name = locked ? turbo.name : state.modelName || models.find(item => item.id === model)?.name || model;
    const hardware = state.hardwareLabel || (locked ? 'NVIDIA GPU' : '本机设备');
    const backend = [state.engineName || (locked ? '本项目内置 GPU 算子' : 'faster-whisper'), name, hardware, state.computeType].filter(Boolean).join(' · ');
    const badge = !state.supported ? '系统暂不支持' : locked
      ? state.loaded ? 'GPU 模型已载入' : state.configured ? 'GPU 资源已就绪' : '内置算子未就绪'
      : state.ready ? '离线引擎就绪' : state.configured ? '已配置' : '尚未准备';
    const description = locked
      ? state.loaded ? `本项目内置算子的模型已载入 ${hardware}；空闲后自动释放，录音、文件转写与视频转码共用 GPU 队列。`
        : state.configured ? '本项目内置 GPU 算子资源已就绪，模型尚未载入；录音或测试时按同一 GPU 队列载入。'
          : state.lastFailure || '本项目内置 GPU 算子尚未就绪；点击检测可查看缺少的资源，不会安装旧引擎或改用 CPU。'
      : state.loaded ? `模型已载入 ${hardware}；空闲后自动释放，下一次使用会重新载入。`
        : state.configured ? `已发现本机 ${name} 模型，下一次使用时载入。` : '尚未准备；点击“检测并准备”会自动下载缺少的组件，首次需要联网。';
    return { model, models, modelLocked: locked, backend, badge, description,
      modelHelp: locked ? 'Windows 录音、录音测试与文件转写共用本项目内置 GPU 算子；模型固定为 Large-v3 Turbo，资源与 GPU 队列只有一套。'
        : '修改后点“保存设置”，缺少模型会自动下载；麦克风、系统音频和录音测试统一使用所选模型。已有模型会保留。' };
  };
})();
