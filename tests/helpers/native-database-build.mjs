export const buildId = n => 'bbbbbbee-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
export const buildIds = { space: buildId(1), user: buildId(2), parent: buildId(3), thread: buildId(4), config: buildId(5), context: buildId(6), message: buildId(7) };
export const databaseBuildInput = () => ({ spaceId: buildIds.space, threadId: buildIds.thread, traceId: buildId(8),
  createdSource: 'post_onboarding_agent', threadType: 'workflow', createThread: true, asPatchResponse: true, patchResponseVersion: 2,
  transcript: [
    { id: buildIds.config, type: 'config', value: { type: 'workflow', oracleThreadType: 'onboarding', onboardingAgentVersion: 'work_database_build',
      agentSource: 'onboarding', enableScriptAgent: true, createResultNavigationBehavior: 'first_top_level_page_only' } },
    { id: buildIds.context, type: 'context', value: { spaceId: buildIds.space, blockId: buildIds.parent, surface: 'post_onboarding_agent', privateUserProfile: 'must-not-forward-profile' } },
    { id: buildIds.message, type: 'user', value: [['创建一个项目跟踪数据库，包含名称、摘要、优先级、状态和截止日期；先给预览。']] }
  ], debugOverrides: { privateData: 'must-not-forward-debug' } });
export const databaseBuildDraft = () => ({ type: 'database', title: '合成项目跟踪', columns: [
  { name: '名称', type: 'title' }, { name: '摘要', type: 'text' },
  { name: '优先级', type: 'select', options: ['高', '中', '低'] },
  { name: '状态', type: 'status', groups: [
    { name: '待处理', options: ['未开始'] }, { name: '进行中', options: ['处理中', '阻塞'] }, { name: '已完成', options: ['完成'] }
  ] }, { name: '截止日期', type: 'date' }
] });
