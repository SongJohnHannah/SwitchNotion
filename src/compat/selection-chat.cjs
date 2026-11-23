const { Script } = require('node:vm');

const start = 'notionSwitchSelectionChat';
const storeAnchor = 'let a=new o;(0,i(202146).exposeDebugValue)("CompletionsStore",a),i.d(t,{K:()=>r},{default:a})';
// The wrapper reads the public prop directly. The minifier's local alias can change.
const writerVariants = [
  { signature: /function (w)(\(e\)\{let a,\{completionState:[$\w]+\}=e,)/g, load: 't', react: 'i', jsx: 'd', layout: 'stable', wrapSurface: true, input: 602430 },
  { signature: /function (k)(\(e\)\{let t,\{completionState:[$\w]+\}=e,)/g, load: 'n', react: 'i', jsx: 'u', layout: 'stable', wrapSurface: false, input: 611983 },
  { signature: /function (B)(\(e\)\{var t;let\{completionState:[$\w]+\}=e,c=\(0,a\(533992\)\.v3\)\(\),)/g, load: 'a', react: 'n', jsx: 'l', layout: 'legacy', wrapSurface: true, input: 602430 },
  { signature: /function (P)(\(e\)\{var t;let\{completionState:[$\w]+\}=e,c=\(0,a\(533992\)\.v3\)\(\),)/g, load: 'a', react: 'n', jsx: 'l', layout: 'legacy', wrapSurface: false, input: 611983 }
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

function decorateReplyControl(root, mode) {
  const button = [...root.querySelectorAll('button, [role="button"]')].findLast(node => !node.closest('[contenteditable="true"]'));
  const icon = button?.querySelector('svg');
  if (!icon) return;
  const label = mode === 'pause' ? '暂停回复' : '继续回复';
  const previous = { position: button.style.position, visibility: icon.style.visibility, title: button.getAttribute('title'), label: button.getAttribute('aria-label') };
  const size = Math.max(12, icon.getBoundingClientRect().width);
  const circle = document.createElement('span'), glyph = document.createElement('span');
  circle.setAttribute('aria-hidden', 'true');
  Object.assign(circle.style, { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    width: `${size}px`, height: `${size}px`, display: 'grid', placeItems: 'center', borderRadius: '50%',
    backgroundColor: 'var(--c-blu6, #2383e2)', pointerEvents: 'none' });
  Object.assign(glyph.style, { width: '38%', height: '38%', backgroundColor: '#fff', borderRadius: '1px',
    ...(mode === 'resume' ? { clipPath: 'polygon(15% 0, 100% 50%, 15% 100%)' } : {}) });
  circle.append(glyph);
  if (getComputedStyle(button).position === 'static') button.style.position = 'relative';
  icon.style.visibility = 'hidden';
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  button.append(circle);
  return () => {
    circle.remove();
    button.style.position = previous.position;
    icon.style.visibility = previous.visibility;
    for (const [attribute, value] of [['title', previous.title], ['aria-label', previous.label]]) {
      if (value === null) button.removeAttribute(attribute);
      else button.setAttribute(attribute, value);
    }
  };
}

function insertionTarget(context) {
  if (context?.type !== 'textSelection') return;
  const page = context.currentPage;
  const block = context.stores?.at?.(-1) ?? context.endBlock;
  const parent = block?.getParentBlockStore?.();
  const spaceId = page?.getSpaceId?.();
  if (!block || !parent || !spaceId || block.id === page.id || block.getSpaceId?.() !== spaceId || parent.getSpaceId?.() !== spaceId) return;
  const editable = store => store.getRole?.() && store.canEdit?.() && store.getAlive?.() !== false &&
    !store.getFormat?.()?.page_locked && !store.getFormat?.()?.block_locked;
  if (!editable(page) || !editable(parent) || !editable(block) || !parent.getContentStore?.()?.getValue?.()?.includes(block.id)) return;
  for (let ancestor = parent, depth = 0; ancestor && depth < 32; ancestor = ancestor.getParentBlockStore?.(), depth++) {
    if (ancestor.id === page.id) return { block, parent, spaceId };
  }
}

async function insertReplyText({ load, environment, context, targetAtOpen, text, insertedSiblings }) {
  return load(323517).createAndCommitAsync({ userAction: 'SwitchNotionSelectionChat.insertReply', environment,
    cellTarget: { spaceWithId: targetAtOpen.spaceId }, canUndo: true, waitForServerCommit: true,
    perform: transaction => {
      const current = insertionTarget(context);
      if (!current || current.block.id !== targetAtOpen.block.id || current.parent.id !== targetAtOpen.parent.id ||
          current.spaceId !== targetAtOpen.spaceId) throw Error('目标段落的位置或权限已变化。');
      const parentStore = current.parent.getContentStore();
      const ids = parentStore.getValue();
      let index = ids.indexOf(current.block.id);
      const consecutive = [];
      for (const id of insertedSiblings) {
        if (ids[index + 1] !== id) break;
        consecutive.push(id);
        index++;
      }
      const child = load(918300).Wv({ environment, type: 'text', spaceId: current.spaceId, transaction,
        inMemoryRecordCache: current.parent.inMemoryRecordCache, properties: { title: load(247438).x9d(text) } });
      load(745792).b({ parentStore, childStore: child, alive: true, transaction });
      load(149881).NI({ parentStore, childStore: child, after: ids[index], transaction });
      return [...consecutive, child.id];
    } });
}

function SelectionChatShell({ token, load, react, jsx, layout, wrapSurface, input, context }) {
  const environment = load(533992).v3();
  const overlays = load(579993).O$(load(192314).hj);
  const accessory = load(463226).DV(overlays);
  const close = react.useCallback(() => load(661044).closeInitialPromptAndEndSession(environment, true), [environment]);
  load(505092).n(close);
  const host = react.useRef(null);
  const history = react.useRef(null);
  const follow = react.useRef(true);
  const compose = react.useRef(null);
  const writing = react.useRef(false), insertedSiblings = react.useRef([]), insertedReplies = react.useRef(new Set());
  const targetAtOpen = react.useMemo(() => insertionTarget(context), [token]);
  const userAtOpen = react.useRef(environment.currentUser?.id);
  const [ready, setReady] = react.useState(false);
  const [phase, setPhase] = react.useState('idle');
  const [status, setStatus] = react.useState('');
  const [turns, setTurns] = react.useState([]);
  const [insertMenu, setInsertMenu] = react.useState(null);
  const [inserted, setInserted] = react.useState({});
  const [hovered, setHovered] = react.useState(null);
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
      if (update.type === 'phase') setPhase(update.paused ? 'paused' : 'running');
      if (update.type === 'start') {
        follow.current = true;
        setStatus('');
        setPhase('running');
        setTurns(previous => [...previous, { question: update.question, answer: [], settled: false }]);
      }
      if (update.type === 'delta' || update.type === 'thinking') setTurns(previous => {
        const turn = previous.at(-1);
        if (!turn) return previous;
        const change = update.type === 'thinking' ? { thinking: true } : { answer: [...turn.answer, update.delta] };
        return [...previous.slice(0, -1), { ...turn, ...change }];
      });
      if (update.type === 'finish') {
        setPhase('idle');
        setTurns(previous => previous.length ? [...previous.slice(0, -1), { ...previous.at(-1), settled: true }] : previous);
        setStatus(update.ok ? '' : update.error);
        if (!update.ok && !store.getValue()?.length) setValue(load(247438).x9d(update.question));
      }
      if (update.type === 'retry') {
        setStatus(update.error);
        if (!store.getValue()?.length) setValue(load(247438).x9d(update.question));
      }
    }
    node.addEventListener('notion-switch:selection-chat-update', receive);
    return () => node.removeEventListener('notion-switch:selection-chat-update', receive);
  }, [token, store, setValue]);
  react.useLayoutEffect(() => {
    const pane = history.current, selection = window.getSelection();
    if (pane && follow.current && (selection?.isCollapsed !== false || !pane.contains(selection.anchorNode))) pane.scrollTop = pane.scrollHeight;
  }, [turns]);

  const empty = load(247438).w9s(value);
  const control = phase === 'running' ? 'pause' : phase === 'paused' && empty ? 'resume' : null;
  react.useLayoutEffect(() => {
    if (control && compose.current) return decorateReplyControl(compose.current, control);
  }, [control]);

  const command = (action, question) => !host.current.dispatchEvent(new CustomEvent('notion-switch:selection-chat-command', {
    cancelable: true, detail: JSON.stringify({ token, action, question })
  }));
  const submit = () => {
    if (!ready || phase === 'running') return;
    const richText = store.getValue();
    const question = (Array.isArray(richText) ? richText.map(span => typeof span[0] === 'string' ? span[0] : '').join('') : '').trim();
    if (question && command('send', question)) setValue([]);
  };
  const writer = load(670987);
  const composer = jsx('div', { ref: compose, style: { display: 'contents' }, children: jsx(load(819464).N, {
    disabled: !ready || !control && empty, onSubmit: control ? () => command(control) : submit,
    children: jsx(load(input).A, { store, style: writer.fk.textInput, disabled: false, disableSuggestEdit: true,
      pasteBehavior: 'inline', inPageFind: load(541321).Os.none, placeholder: turns.length ? '继续追问…' : '询问 AI',
      enterBehavior: enterKeyBehavior === 'newline' ? 'soft-break' : 'block-break',
      onEnter: enterKeyBehavior === 'send' ? submit : undefined, onCommandEnter: enterKeyBehavior === 'newline' ? submit : undefined, onEsc: close }) }) });
  const bodyText = (text, key) => jsx(load(111010).D, { styleKey: 'bodyRegular',
    children: jsx('span', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, children: text }) }, key);
  const insert = async (event, index, mode) => {
    if (!(event.nativeEvent ?? event).isTrusted || writing.current || !targetAtOpen || !userAtOpen.current ||
        userAtOpen.current !== environment.currentUser?.id) return;
    if (mode === 'reply') {
      const selection = window.getSelection();
      if (selection?.isCollapsed === false && history.current?.contains(selection.anchorNode)) return;
    }
    const indexes = mode === 'all' ? turns.flatMap((turn, at) => turn.settled && turn.answer.length && !insertedReplies.current.has(at) ? [at] : []) : [index];
    const texts = mode === 'selected' ? [insertMenu?.selected] : indexes.map(at => !insertedReplies.current.has(at) && turns[at]?.settled ? turns[at].answer.join('') : '');
    const text = texts.filter(value => value?.trim()).join('\n\n');
    if (!text) return;
    event.stopPropagation();
    setInsertMenu(null);
    const target = insertionTarget(context);
    if (!target || target.block.id !== targetAtOpen.block.id || target.parent.id !== targetAtOpen.parent.id) {
      setStatus('目标段落的位置或权限已变化，请重新选择。');
      return;
    }
    writing.current = true;
    try {
      const result = await insertReplyText({ load, environment, context, targetAtOpen, text, insertedSiblings: insertedSiblings.current });
      insertedSiblings.current = result.performResult;
      if (mode !== 'selected') {
        for (const at of indexes) insertedReplies.current.add(at);
        setInserted(Object.fromEntries([...insertedReplies.current].map(at => [at, true])));
      }
      setStatus('已插入原选区下方。');
      writing.current = false;
    } catch {
      setStatus('无法确认插入结果，请先检查原选区下方。');
    }
  };
  const anyUninserted = turns.some((turn, index) => turn.settled && turn.answer.length && !inserted[index]);
  const reply = ({ answer, settled, thinking }, index) => {
    if (!answer.length) return thinking && !settled && phase === 'running' ? jsx('div', {
      role: 'status', style: { padding: '5px 8px', opacity: 0.7 }, children: bodyText('思考中…')
    }, `answer-${index}`) : null;
    const actionable = settled && targetAtOpen && !inserted[index];
    const menu = settled && targetAtOpen && insertMenu?.index === index ? jsx(load(4458).fI, {
      role: 'menu', gap: 4, alignItems: 'center', children: [
        insertMenu.selected ? jsx(load(988022).p, { size: 'sm', children: '插入所选文字', onClick: event => void insert(event, index, 'selected') }) : null,
        anyUninserted ? jsx(load(988022).p, { size: 'sm', children: '全部插入', onClick: event => void insert(event, index, 'all') }) : null
      ] }) : null;
    return jsx('div', { children: [jsx('div', {
      title: actionable ? '单击插入这条回复，右键查看更多操作' : undefined,
      style: { padding: '5px 8px', borderRadius: 6, cursor: actionable ? 'pointer' : 'text',
        background: actionable && hovered === index ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent' },
      onMouseEnter: () => setHovered(index), onMouseLeave: () => setHovered(null),
      onClick: actionable ? event => void insert(event, index, 'reply') : undefined,
      onContextMenu: settled && targetAtOpen ? event => {
        if (!(event.nativeEvent ?? event).isTrusted) return;
        const selection = window.getSelection(), element = event.currentTarget;
        const selected = selection?.isCollapsed === false && element.contains(selection.anchorNode) && element.contains(selection.focusNode)
          ? selection.toString() : '';
        if (!selected.trim() && !anyUninserted) return;
        event.preventDefault();
        event.stopPropagation();
        setInsertMenu({ index, selected });
      } : undefined,
      children: bodyText(answer.map((chunk, at) => jsx(react.Fragment, { children: chunk }, at)))
    }), menu] }, `answer-${index}`);
  };
  const transcript = turns.length ? jsx('div', { ref: history, role: 'log', 'aria-live': 'off',
    'data-notion-switch-selection-chat-transcript': '',
    style: { maxHeight: 'min(38vh, 300px)', boxSizing: 'border-box', padding: '12px 12px 12px 0', overflow: 'auto', userSelect: 'text' }, onScroll: event => {
      const pane = event.currentTarget;
      follow.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32;
    }, children: jsx(load(4458).VP, { gap: 8, children: turns.flatMap((turn, index) => [
      jsx('div', { style: { alignSelf: 'flex-end', maxWidth: '84%', borderRadius: 10, padding: '8px 12px',
        background: 'color-mix(in srgb, currentColor 8%, transparent)' }, children: bodyText(turn.question) }, `question-${index}`),
      reply(turn, index)
    ]) }) }) : null;
  const content = transcript || status || phase !== 'idle' ? jsx(load(4458).VP, { width: '100%', gap: 4, children: [
    transcript, status ? jsx('div', { role: 'status', children: bodyText(status) }) : null, composer
  ] }) : composer;
  const popup = jsx(load(369064).N, { capture: true, onEsc: close, onEnter: enterKeyBehavior === 'send' ? submit : undefined,
    debugName: 'SwitchNotionSelectionChat',
    children: jsx('div', { ref: host, 'data-notion-switch-selection-chat-host': token,
      children: jsx(writer.AB, { layout, runningInference: phase === 'running', shouldCenterFace: !transcript, accessory, children: content }) }) });
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
  return `${[decorateReplyControl, insertionTarget, insertReplyText, SelectionChatShell].map(fn => fn.toString()).join('\n')}\nfunction ${name}(e){const token=e.completionState?.${start};return token?` +
    `(0,${jsx}.jsx)(SelectionChatShell,{key:token,token,load:${load},react:${react},jsx:${jsx}.jsx,layout:${JSON.stringify(layout)},wrapSurface:${wrapSurface},input:${input},context:e.completionState.context}):` +
    `(0,${jsx}.jsx)(__notionSwitchOriginalWriter,e)}function __notionSwitchOriginalWriter`;
}

function adaptSelectionChatClient(source) {
  let output = source;
  if (source.split(storeAnchor).length === 2 && source.includes('304636(e,t,i){')) {
    output = output.replace(storeAnchor, storeAnchor.replace('let a=new o;', `let a=new o;(${installHandoff.toString()})(a);`));
  }
  for (const variant of writerVariants) {
    const matches = [...source.matchAll(variant.signature)];
    const debugName = variant.layout === 'stable' ? 'AgentServiceWriterPopup' : 'AgentWriterPopup';
    if (matches.length !== 1 || !source.includes(`debugName:"${debugName}"`) ||
        !source.includes(`${variant.load}(670987).AB,{layout:"${variant.layout}"`) ||
        !source.includes(`${variant.load}(819464).N`) || !source.includes(`${variant.load}(${variant.input}).A`) ||
        source.includes(`${variant.load}(316258).hP`) !== variant.wrapSurface) continue;
    const [signature, name, originalBodyStart] = matches[0];
    output = output.replace(signature, () => wrap({ ...variant, name }) + originalBodyStart);
  }
  if (output === source) return source;
  try { new Script(output); return output; }
  catch { return source; }
}

module.exports = { storeAsset, popupAsset, isSelectionChatCandidate, adaptSelectionChatClient };
