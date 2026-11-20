const path = require('node:path');
const { parse } = require('./parser.cjs');
const { models } = require('../native-models.cjs');
const { uuid } = require('../native-context.cjs');

const channel = 'notion-switch:thinking-menu';
const origin = 'https://app.notion.com';

const choices = [
  ['none', '关闭', 'Off'], ['low', '快速', 'Fast'], ['high', '标准', 'Standard'], ['max', '深入', 'Deep']
];

function registerThinkingMenuPreload(session) {
  session.registerPreloadScript?.({ type: 'frame', filePath: path.join(__dirname, 'thinking-menu-preload.cjs'), matches: [`${origin}/*`] });
}

function setupThinkingMenu({ ipcMain, isWorkspaceContents, request }) {
  ipcMain.handle(channel, (event, user, effort) => {
    const { sender, senderFrame } = event;
    if (!senderFrame || senderFrame !== sender.mainFrame || !senderFrame.url.startsWith(`${origin}/`) ||
        !sender.getLastWebPreferences()?.contextIsolation || !isWorkspaceContents(sender) || !uuid(user))
      return { ok: false, error: '此操作只能从 SwitchNotion 的思考菜单执行。' };
    if (effort !== undefined && !choices.some(choice => choice[0] === effort))
      return { ok: false, error: '思考模式请求无效。' };
    return request(effort === undefined ? {} : { effort });
  });
}

// Serialized into the renderer. The preload only exposes this settings call.
async function thinkingRequest(user, effort) {
  const { ok, result } = await window.notionSwitchThinking(user, effort);
  if (!ok) throw Error('Could not read or save the SwitchNotion thinking mode');
  return result.thinking ? result.reasoningEffort : 'none';
}

function thinkingSections(control, native, choices, request) {
  if (!control?.scope[0]) return [];
  const user = control.scope[0], zh = /^zh\b/i.test(control.locale);
  function ThinkingMenu({ menuItemProps, handlers }) {
    const [selected, setSelected] = native.react.useState(null);
    const [failed, setFailed] = native.react.useState(false);
    native.react.useEffect(() => {
      let active = true;
      request(user).then(value => { if (active) setSelected(value); }, () => { if (active) setFailed(true); });
      return () => { active = false; };
    }, [user]);
    const label = zh ? '思考' : 'Thinking', index = zh ? 1 : 2;
    if (!selected) return native.item({ ...menuItemProps, title: label + (failed ? (zh ? ' · 无法读取配置' : ' · Settings unavailable') : '…') });
    const title = label + ' · ' + choices.find(choice => choice[0] === selected)[index];
    const sections = [{ key: 'notion-switch-thinking-options', render: native.section, items: choices.map(([effort, cn, en]) => ({
      key: 'notion-switch-thinking-' + effort,
      render: props => native.item({ ...props, title: zh ? cn : en, isChecked: effort === selected }),
      action: async () => {
        try { setSelected(await request(user, effort)); control.close(); }
        catch { setFailed(true); setSelected(null); }
      }
    })) }];
    return native.submenu({ menuItemProps, onFocus: handlers.onFocus, onAccept: handlers.onAccept, title, sections });
  }
  return [{ key: 'notion-switch-thinking', render: props => native.section({ ...props, topBorder: true }), items: [{
    key: 'notion-switch-thinking-trigger',
    render: (menuItemProps, handlers) => native.element(ThinkingMenu, { menuItemProps, handlers }),
    action: () => {}
  }] }];
}

const appThread = 'agent_service_model_switching_during_chat';
const conversationPicker = /children:\(0,\w+\.jsx\)\(n\(133735\)\.VK,\{modelPickerUpsell:e\.modelPickerUpsell,/g;
const modelMenu = 'keyPrefix:"revamped-model-picker",providerGroups:';
const providerMenu = /return\{providerSections:\w+&&\w+\.length>0\?\[\{key:`\$\{\w+\}-other-models`,render:e=>\(0,(\w+)\.jsx\)\((\w+)\(83743\)\.A,\{\.\.\.e,topBorder:!0\}\),items:\[\{key:`\$\{\w+\}-other-models-trigger`,render:\(e,t\)=>\(0,\1\.jsx\)\((\w+(?:\(\d+\)\.\w+)?),/g;
function replaceOnce(source, anchor, value) {
  const matches = typeof anchor === 'string' ? source.split(anchor).length - 1 : [...source.matchAll(anchor)].length;
  if (matches !== 1) throw Error('Unrecognized thinking menu integration point');
  return source.replace(anchor, value);
}

function isThinkingCandidate(source) {
  return source.includes(appThread) && source.includes('agent-service-reasoning-effort-button') ||
    source.includes(modelMenu) && source.includes('"agent_service"') ||
    source.includes('ProviderModelMenu.otherModels');
}

function adaptConversationPicker(source) {
  let result = replaceOnce(source, conversationPicker, '$&notionSwitchThinking:e.notionSwitchThinking,');
  const current = source.includes('modelPickerRevampEnabled:t$&&t4,onSelectAuto:nj,onSelect:nI');
  const props = current ? 'modelPickerRevampEnabled:t$&&t4,onSelectAuto:nj,onSelect:nI' : 'modelPickerRevampEnabled:tR&&tz,onSelectAuto:t8,onSelect:t9';
  const scope = current ? 't4?[ea.currentUser.id,X,Z]:void 0' : 'tz&&!e2&&!te?[ee.currentUser.id,Y,X]:void 0';
  const dependencies = current ? '[t6,tN,tW,nC,n_,eu,np,tg,ts,' : '[tT,nt,nn,eo,tJ,eK,tj,tE,t5,';
  result = replaceOnce(result, props, `$&,notionSwitchThinking:${scope}`);
  const scopeDependencies = current ? 'ea.currentUser.id,X,Z' : 'ee.currentUser.id,Y,X,te';
  return replaceOnce(result, dependencies, `[${scopeDependencies},${dependencies.slice(1)}`);
}

function adaptModelMenu(source) {
  const current = source.includes('keyPrefix:"revamped-model-picker",providerGroups:ei,chatGptTokenSharing:v,');
  const modelIds = JSON.stringify(models.map(model => model.nativeId));
  const group = current ? 'providerGroups:ei,chatGptTokenSharing:v,' : 'providerGroups:eo,chatGptTokenSharing:p,';
  const [disabled, available, intl, popup] = current ? ['f', 'c', 'O', 'M'] : ['b', 'u', 'T', 'h'];
  let result = replaceOnce(source, 'keyPrefix:"revamped-model-picker",' + group,
    `$&notionSwitchThinking:!${disabled}&&e.notionSwitchThinking&&${available}.some(model=>${modelIds}.includes(model.model))?{scope:e.notionSwitchThinking,locale:${intl}.locale,close:()=>${popup}.close()}:void 0,`);
  if (current) {
    result = replaceOnce(result, 'children:(0,a.jsx)(p,{modelPickerUpsell:eJ,modelPickerTrialModels:e7,', '$&notionSwitchThinking:!es?[M.currentUser.id,b,Q]:void 0,');
    result = replaceOnce(result, '[e9,e7,eZ,en,e1,ec,_,n,J,k,es,w,eQ,ed,u,m,e2,y,oe,oo,eJ]', '[M.currentUser.id,b,Q,e9,e7,eZ,en,e1,ec,_,n,J,k,es,w,eQ,ed,u,m,e2,y,oe,oo,eJ]');
  }
  return result;
}

function adaptThinkingClient(source) {
  let result = source;
  try {
    // The existing conversation view already supplies stable IDs, including
    // the ID reserved for a draft before its first request.
    if ([...source.matchAll(conversationPicker)].length) result = adaptConversationPicker(result);
    if (source.includes(modelMenu) && source.includes('"agent_service"')) result = adaptModelMenu(result);
    if (source.includes('ProviderModelMenu.otherModels')) {
      result = replaceOnce(result, providerMenu, (match, jsx, load, submenu) => {
        const components = `{react:${load}(635790),element:(component,props)=>(0,${jsx}.jsx)(component,props),section:props=>(0,${jsx}.jsx)(${load}(83743).A,props),item:props=>(0,${jsx}.jsx)(${load}(95582).A,props),submenu:props=>(0,${jsx}.jsx)(${submenu},props)}`;
        return match.replace('?[{', `?[...(${thinkingSections.toString()})(e.notionSwitchThinking,${components},${JSON.stringify(choices)},(${thinkingRequest.toString()})),{`);
      });
    }
    if (result !== source) parse(result, { ecmaVersion: 2024 });
    return result;
  } catch { return source; }
}

module.exports = { adaptThinkingClient, isThinkingCandidate, registerThinkingMenuPreload, setupThinkingMenu };
