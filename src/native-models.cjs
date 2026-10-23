// Native IDs are already recognized by this reviewed Notion frontend. They are
// local UI identifiers only; generation always goes to the configured provider.
const models = Object.freeze([
  Object.freeze({ nativeId: 'baseten-deepseek-v4.1-flash', apiId: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }),
  Object.freeze({ nativeId: 'baseten-deepseek-v4-pro', apiId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' })
]);
function nativeModelCatalog() {
  return {
    models: models.map(m => ({
      // This client groups open models under its generic "mystery" family;
      // "deepseek" is a provider but is not in the picker-family enum.
      model: m.nativeId, modelMessage: m.label, modelFamily: 'mystery', modelProvider: 'deepseek',
      isDisabled: false, billsNotionCredits: false,
      workflow: { finalModelName: m.nativeId, isDisabled: false },
      agentService: { finalModelName: m.nativeId, isDisabled: false }
    })),
    restrictedAccessModelsInPickerConfig: [], restrictedGeoPolicyApplied: false,
    modelSelectionRestricted: false, modelPickerUpsellPreviews: []
  };
}
function selectionFrom(input, previous = { type: 'automatic' }) {
  if (Object.hasOwn(input, 'modelSelection')) {
    const s = input.modelSelection;
    if (s?.type === 'automatic') return { type: 'automatic' };
    if (s?.type === 'explicit' && models.some(m => m.nativeId === s.model)) return { type: 'explicit', model: s.model };
    throw Error('DeepSeek 原生模型选择无效，请重新选择 Flash 或 Pro。');
  }
  if (Object.hasOwn(input, 'model') && input.model !== undefined) {
    if (models.some(m => m.nativeId === input.model)) return { type: 'explicit', model: input.model };
    throw Error('DeepSeek 暂不支持这个原生模型选项，请选择 Flash 或 Pro。');
  }
  return { ...previous };
}
function applySelection(config, selection) {
  if (config.mode !== 'deepseek' || !selection || selection.type === 'automatic') return { ...config };
  const model = models.find(m => m.nativeId === selection.model);
  if (!model) throw Error('DeepSeek 原生模型选择已失效，请重新选择。');
  return { ...config, model: model.apiId };
}
module.exports = { models, nativeModelCatalog, selectionFrom, applySelection };
