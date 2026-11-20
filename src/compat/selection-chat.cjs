const { Script } = require('node:vm');

const start = 'notionSwitchSelectionChat';
const storeAnchor = 'let a=new o;(0,i(202146).exposeDebugValue)("CompletionsStore",a),i.d(t,{K:()=>r},{default:a})';
const writerVariants = [
  { name: 'w', anchor: '(e){let a,{completionState:n}=e,', load: 't', react: 'i', jsx: 'd', layout: 'stable', wrapSurface: true, input: 602430 },
  { name: 'k', anchor: '(e){let t,{completionState:r}=e,', load: 'n', react: 'i', jsx: 'u', layout: 'stable', wrapSurface: false, input: 611983 },
  { name: 'B', anchor: '(e){var t;let{completionState:s}=e,c=(0,a(533992).v3)(),', load: 'a', react: 'n', jsx: 'l', layout: 'legacy', wrapSurface: true, input: 602430 },
  { name: 'P', anchor: '(e){var t;let{completionState:s}=e,c=(0,a(533992).v3)(),', load: 'a', react: 'n', jsx: 'l', layout: 'legacy', wrapSurface: false, input: 611983 }
];
const storeAsset = /^(?:68145|UISpacePermissionGroupToken)-[a-f\d]{16}\.js$/;
const popupAsset = /^(?:AgentServiceWriterPopup|agentWriter)-[a-f\d]{16}\.js$/;

// These helpers run in the native client's renderer. The shared DOM marker
// carries a random handoff ID only. Text and generation stay in isolated IPC.
function installHandoff(store) {
  const root = document.documentElement;
  if (!root || typeof store.setState !== 'function' || typeof store.invalidateLastUpdater !== 'function') return;
  const setState = store.setState.bind(store);
  const updateAvailability = () => {
    const ready = store.state?.type === 'closed' ? '1' : '0';
    if (root.dataset.notionSwitchSelectionChatReady !== ready) root.dataset.notionSwitchSelectionChatReady = ready;
  };
  const setStateWithHandoff = (state, ...args) => {
    const token = root.dataset.notionSwitchSelectionChat;
    if (token && state?.type === 'agentCompletionPopup' &&
        (store.state?.type === 'closed' || store.state?.notionSwitchSelectionChat === token)) {
      state = { ...state, stage: 'initialPrompt', notionSwitchSelectionChat: token,
        autoSubmit: undefined, pendingSkill: undefined, prefilledValue: undefined };
    }
    const result = setState(state, ...args);
    updateAvailability();
    return result;
  };
  try { store.setState = setStateWithHandoff; } catch { return; }
  document.addEventListener('notion-switch:selection-chat-cancel', () => {
    const token = root.dataset.notionSwitchSelectionChat;
    if (!token) return;
    if (store.state?.type === 'closed' || store.state?.notionSwitchSelectionChat === token) store.invalidateLastUpdater();
    if (store.state?.notionSwitchSelectionChat === token) store.setState({ type: 'closed' });
  });
  updateAvailability();
}

function SelectionChatShell({ token, load, react, jsx, layout, wrapSurface, input }) {
  const environment = load(533992).v3();
  const overlays = load(579993).O$(load(192314).hj);
  const accessory = load(463226).DV(overlays);
  const close = react.useCallback(() => load(661044).closeInitialPromptAndEndSession(environment, true), [environment]);
  load(505092).n(close);
  const host = react.useRef(null);
  const history = react.useRef(null);
  const follow = react.useRef(true);
  const [ready, setReady] = react.useState(false);
  const [busy, setBusy] = react.useState(false);
  const [status, setStatus] = react.useState('');
  const [turns, setTurns] = react.useState([]);
  const { store, setValue } = load(430937).AI({});
  const value = load(579993).K8(() => store.getValue(), [store]);
  const enterKeyBehavior = load(579993).K8(() => load(192314).jJ.state?.getSettingsStore().getKeyValue('chat_enter_key_behavior') ?? 'send', []);
  load(49768).Q7({ textStore: store, initialFocus: true });

  react.useLayoutEffect(() => {
    const node = host.current;
    function receive(event) {
      let update;
      try { update = JSON.parse(event.detail); } catch { return; }
      if (update?.token !== token) return;
      if (update.type === 'open') { setReady(update.ok); setStatus(update.error || ''); }
      if (update.type === 'status') setStatus(update.message);
      if (update.type === 'start') {
        follow.current = true;
        setStatus('');
        setBusy(true);
        setTurns(previous => [...previous, { question: update.question, answer: '' }]);
      }
      if (update.type === 'delta') setTurns(previous => {
        const turn = previous.at(-1);
        return turn ? [...previous.slice(0, -1), { ...turn, answer: turn.answer + update.delta }] : previous;
      });
      if (update.type === 'finish') {
        setBusy(false);
        setStatus(update.ok ? (update.stopped ? '已停止回复。' : '') : update.error);
        if (!update.ok && !store.getValue()?.length) setValue(load(247438).x9d(update.question));
      }
    }
    node.addEventListener('notion-switch:selection-chat-update', receive);
    return () => node.removeEventListener('notion-switch:selection-chat-update', receive);
  }, [token, store, setValue]);
  react.useLayoutEffect(() => {
    if (history.current && follow.current) history.current.scrollTop = history.current.scrollHeight;
  }, [turns]);

  const command = (action, question) => !host.current.dispatchEvent(new CustomEvent('notion-switch:selection-chat-command', {
    cancelable: true, detail: JSON.stringify({ token, action, question })
  }));
  const submit = () => {
    if (!ready || busy) return;
    const richText = store.getValue();
    const question = (Array.isArray(richText) ? richText.map(span => typeof span[0] === 'string' ? span[0] : '').join('') : '').trim();
    if (question && command('send', question)) setValue([]);
  };
  const writer = load(670987);
  const composer = jsx(load(819464).N, { disabled: !ready || busy || load(247438).w9s(value), onSubmit: submit,
    children: jsx(load(input).A, { store, style: writer.fk.textInput, disabled: false, disableSuggestEdit: true,
      pasteBehavior: 'inline', inPageFind: load(541321).Os.none, placeholder: turns.length ? '继续追问…' : '询问 AI',
      enterBehavior: enterKeyBehavior === 'newline' ? 'soft-break' : 'block-break',
      onEnter: enterKeyBehavior === 'send' ? submit : undefined, onCommandEnter: enterKeyBehavior === 'newline' ? submit : undefined, onEsc: close }) });
  const bodyText = (text, key) => jsx(load(111010).D, { styleKey: 'bodyRegular',
    children: jsx('span', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, children: text }) }, key);
  const transcript = turns.length ? jsx('div', { ref: history, role: 'log', 'aria-live': 'off',
    style: { maxHeight: 'min(38vh, 300px)', overflow: 'auto' }, onScroll: event => {
      const pane = event.currentTarget;
      follow.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32;
    }, children: jsx(load(4458).VP, { gap: 6, children: turns.flatMap(({ question, answer }, index) => [
      bodyText(`你：${question}`, `question-${index}`), answer ? bodyText(answer, `answer-${index}`) : null
    ]) }) }) : null;
  const content = transcript || status || busy ? jsx(load(4458).VP, { width: '100%', gap: 4, children: [
    transcript, status ? jsx('div', { role: 'status', children: bodyText(status) }) : null,
    composer, busy ? jsx(load(988022).p, { size: 'sm', onClick: () => command('stop'), children: '停止' }) : null
  ] }) : composer;
  const popup = jsx(load(369064).N, { capture: true, onEsc: close, onEnter: enterKeyBehavior === 'send' ? submit : undefined,
    debugName: 'SwitchNotionSelectionChat',
    children: jsx('div', { ref: host, 'data-notion-switch-selection-chat-host': token,
      children: jsx(writer.AB, { layout, runningInference: busy, shouldCenterFace: !transcript, accessory, children: content }) }) });
  if (!wrapSurface) return popup;
  const { hP: surface, wy: surfaces } = load(316258);
  return jsx(surface, { surface: load(139424).A.isMobile ? surfaces.mobileWriter : surfaces.writer,
    children: popup });
}

function isSelectionChatCandidate(source) {
  return source.includes('"CompletionsStore"') && source.includes('304636(') ||
    source.includes('debugName:"AgentServiceWriterPopup"') && source.includes('eventName:"runWriter"') ||
    source.includes('debugName:"AgentWriterPopup"') && source.includes('layout:"legacy"');
}

function wrap({ name, load, react, jsx, layout, wrapSurface, input }) {
  return `${SelectionChatShell.toString()}function ${name}(e){const token=e.completionState?.${start};return token?` +
    `(0,${jsx}.jsx)(SelectionChatShell,{key:token,token,load:${load},react:${react},jsx:${jsx}.jsx,layout:${JSON.stringify(layout)},wrapSurface:${wrapSurface},input:${input}}):` +
    `(0,${jsx}.jsx)(__notionSwitchOriginalWriter,e)}function __notionSwitchOriginalWriter`;
}

function adaptSelectionChatClient(source) {
  let output = source;
  if (source.split(storeAnchor).length === 2 && source.includes('304636(e,t,i){')) {
    output = output.replace(storeAnchor, storeAnchor.replace('let a=new o;', `let a=new o;(${installHandoff.toString()})(a);`));
  }
  for (const variant of writerVariants) {
    const signature = 'function ' + variant.name + variant.anchor;
    const debugName = variant.layout === 'stable' ? 'AgentServiceWriterPopup' : 'AgentWriterPopup';
    if (source.split(signature).length !== 2 || !source.includes(`debugName:"${debugName}"`) ||
        !source.includes(`${variant.load}(670987).AB,{layout:"${variant.layout}"`) ||
        !source.includes(`${variant.load}(819464).N`) || !source.includes(`${variant.load}(${variant.input}).A`) ||
        source.includes(`${variant.load}(316258).hP`) !== variant.wrapSurface) continue;
    output = output.replace(signature, () => wrap(variant) + variant.anchor);
  }
  if (output === source) return source;
  try { new Script(output); return output; }
  catch { return source; }
}

module.exports = { storeAsset, popupAsset, isSelectionChatCandidate, adaptSelectionChatClient };
