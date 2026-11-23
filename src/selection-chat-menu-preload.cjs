const { ipcRenderer } = require('electron');

// This preload exposes no API to the Notion page. The native popup receives a
// handoff ID; selected text and model requests travel only through local IPC.
if (process.isMainFrame && process.contextIsolated && location.protocol === 'https:' &&
    ['app.notion.com', 'www.notion.so', 'notion.so', 'www.notion.com', 'notion.com'].includes(location.hostname)) {
  const labels = /^(?:使用\s*AI\s*(?:编辑|編輯)|(?:用|通过|透過)\s*AI\s*(?:编辑|編輯)|Edit with AI|Use AI to edit)$/i;
  const menuSelector = '.notion-text-action-menu, [data-testid="notion-text-action-menu"]';
  const rowSelector = 'button, [role="menuitem"], [role="option"], [role="button"], [tabindex]';
  const pageSelector = '.notion-page-content, [data-block-id]';
  const request = 'notion-switch:selection-chat';
  const hostAttribute = 'data-notion-switch-selection-chat-host';
  const transcriptSelector = '[data-notion-switch-selection-chat-transcript]';
  const handoff = 'notionSwitchSelectionChat';
  const containsTarget = (element, target) => target instanceof Node && element?.contains(target);
  let anchor, item, quote, frame, pending, chat;

  function notice(message) {
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.textContent = message;
    Object.assign(status.style, { position: 'fixed', zIndex: '2147483647', bottom: '20px', right: '24px',
      maxWidth: '320px', color: 'white', background: '#37352f', padding: '10px 14px', borderRadius: '8px', pointerEvents: 'none' });
    document.body?.append(status);
    setTimeout(() => status.remove(), 4500);
  }

  function selectedText() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return '';
    const inPage = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(pageSelector);
    if (!inPage(selection.anchorNode) || !inPage(selection.focusNode)) return '';
    const text = selection.toString();
    return text.trim() ? text : '';
  }

  function selectedTranscript() {
    const transcript = chat?.host.querySelector(transcriptSelector);
    const selection = transcript && window.getSelection();
    return selection && !selection.isCollapsed && containsTarget(transcript, selection.anchorNode) &&
      containsTarget(transcript, selection.focusNode) ? selection.toString() : '';
  }

  function writerItem() {
    // Some clients render the text commands in a separate popover portal.
    const rows = document.querySelectorAll(`${menuSelector}, .notion-overlay-container :is(${rowSelector}), [role="menu"] :is(${rowSelector})`);
    for (const row of rows) {
      if (row.matches(menuSelector)) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (containsTarget(item, walker.currentNode)) continue;
          if (!labels.test(walker.currentNode.textContent.trim())) continue;
          const label = walker.currentNode.parentElement;
          const command = label.closest(rowSelector);
          if (command && command !== row && row.contains(command) && command.getClientRects().length) return command;
          for (let parent = label.parentElement; parent && parent !== row; parent = parent.parentElement) {
            if (parent.children.length > 1 && getComputedStyle(parent).cursor === 'pointer' && parent.getClientRects().length) return parent;
          }
        }
      } else if (row !== item && row.getClientRects().length &&
          labels.test((row.getAttribute('aria-label') || row.textContent).trim()) &&
          !row.querySelector(':is(button, [role="menuitem"], [role="option"], [role="button"])')) return row;
    }
  }

  function cloneWriterItem(source) {
    const button = source.cloneNode(true);
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let label;
    while (walker.nextNode()) {
      if (labels.test(walker.currentNode.textContent.trim())) { label = walker.currentNode; break; }
    }
    label ||= Array.from(button.querySelectorAll('*')).reverse().find(element => labels.test(element.textContent.trim()));
    if (!label) return;
    label.textContent = '询问 AI';

    // Preserve the native row and its icon/label wrappers, including per-side
    // insets and font styles. Leave IDs and editor-specific actions behind.
    for (const element of [button, ...button.querySelectorAll('*')]) {
      for (const name of element.getAttributeNames()) {
        if (/^(?:id$|data-testid$|tabindex$|aria-labelledby$|aria-describedby$|title$|on)/i.test(name)) element.removeAttribute(name);
      }
    }
    button.setAttribute('aria-label', '询问 AI');
    if (button instanceof HTMLButtonElement) button.type = 'button';
    else if (!button.hasAttribute('role')) button.setAttribute('role', 'button');
    button.tabIndex = 0;

    const hover = source.matches(':hover') ? getComputedStyle(source).backgroundColor : '';
    if (hover) button.style.removeProperty('background-color');
    const restingFill = button.style.backgroundColor;
    button.addEventListener('pointerenter', () => {
      if (getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)') {
        button.style.backgroundColor = hover && hover !== 'rgba(0, 0, 0, 0)' ? hover : 'color-mix(in srgb, currentColor 7%, transparent)';
      }
    });
    button.addEventListener('pointerleave', () => { button.style.backgroundColor = restingFill; });
    return button;
  }

  function refresh() {
    frame = undefined;
    if (chat && !chat.host.isConnected) {
      void ipcRenderer.invoke(request, 'close', chat.token).catch(() => {});
      chat = undefined;
    }
    if (pending) {
      const host = document.querySelector(`[${hostAttribute}="${pending.token}"]`);
      if (host) {
        const { token, text } = pending;
        releasePending();
        mountChat(host, token, text);
      }
    }
    if (pending || chat) {
      item?.remove();
      anchor = item = quote = undefined;
      return;
    }
    const text = selectedText();
    // Tabbing to a command can move focus out of the contenteditable range.
    const focused = item && document.activeElement === item;
    const next = document.documentElement.dataset.notionSwitchSelectionChatReady === '1' && (text || focused) && writerItem();
    if (text || !focused) quote = text;
    if (next === anchor && item?.isConnected) return;
    item?.remove();
    item = undefined;
    anchor = next;
    if (!anchor || !text) return;
    item = cloneWriterItem(anchor);
    if (item) anchor.after(item);
  }

  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(refresh);
  }

  function releasePending() {
    clearTimeout(pending.timer);
    delete document.documentElement.dataset[handoff];
    pending = undefined;
  }

  function cancelPending(message) {
    document.dispatchEvent(new Event('notion-switch:selection-chat-cancel'));
    releasePending();
    if (message) notice(message);
    schedule();
  }

  function mountChat(host, token, text) {
    const state = { token, host, ready: false, pendingReply: null, paused: false, transitioning: false, allowCommand: false };
    chat = state;
    host.title = text;
    state.update = (type, value) => {
      if (chat !== state) return;
      host.dispatchEvent(new CustomEvent('notion-switch:selection-chat-update', {
        detail: JSON.stringify({ token, type, ...value })
      }));
    };
    host.addEventListener('notion-switch:selection-chat-command', async event => {
      if (chat !== state || !state.ready || !state.allowCommand || event.target !== host) return;
      let data;
      try { data = JSON.parse(event.detail); } catch { return; }
      if (data?.token !== token || state.transitioning) return;
      if (data.action === 'pause' || data.action === 'resume') {
        const reply = state.pendingReply;
        if (!reply || state.paused === (data.action === 'pause')) return;
        state.allowCommand = false;
        state.transitioning = true;
        event.preventDefault();
        try {
          const result = await ipcRenderer.invoke(request, data.action, token);
          if (result.ok && state.pendingReply === reply) {
            state.paused = data.action === 'pause';
            state.update('phase', { paused: state.paused });
          }
        } catch { state.update('status', { message: '无法切换回复状态，请重试。' }); }
        finally { state.transitioning = false; }
        return;
      }
      if (data.action !== 'send' || (state.pendingReply && !state.paused) || typeof data.question !== 'string' || !data.question.trim()) return;
      const question = data.question.trim();
      state.allowCommand = false;
      if (question.length > state.maxQuestion) {
        state.update('status', { message: '问题过长，请缩短后重试。' });
        return;
      }
      event.preventDefault();
      if (state.pendingReply) {
        state.transitioning = true;
        try {
          await ipcRenderer.invoke(request, 'stop', token);
          await state.pendingReply;
        } catch {
          state.update('retry', { error: '无法发送追问，请重试。', question });
          return;
        } finally { state.transitioning = false; }
        if (chat !== state) return;
      }
      state.paused = false;
      state.update('start', { question });
      let result;
      state.pendingReply = ipcRenderer.invoke(request, 'send', token, question)
        .catch(() => ({ ok: false, error: '回复中断，请重试。' }));
      result = await state.pendingReply;
      state.pendingReply = null;
      state.paused = false;
      state.update('finish', { ...result, question });
    });
    void ipcRenderer.invoke(request, 'open', token, text).then(result => {
      state.ready = result.ok;
      state.maxQuestion = result.maxQuestion;
      state.update('open', result);
    }, () => state.update('open', { ok: false, error: '无法开始聊天，请重新选择文字后重试。' }));
  }

  ipcRenderer.on('notion-switch:selection-chat-delta', (_event, token, payload) => {
    if (chat?.token !== token || !chat.pendingReply) return;
    if (typeof payload === 'string') chat.update('delta', { delta: payload });
    else if (payload?.type === 'thinking') chat.update('thinking');
  });

  function allowChatCommand(event) {
    const state = chat;
    if (!event.isTrusted || !containsTarget(state?.host, event.target)) return;
    state.allowCommand = true;
    setTimeout(() => { state.allowCommand = false; }, 0);
  }

  window.addEventListener('keydown', event => {
    if (pending && event.isTrusted) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') cancelPending();
      return;
    }
    if (containsTarget(item, event.target) && (event.key === 'Enter' || event.key === ' ')) {
      openSelectionChat(event);
      return;
    }
    // Let Chromium issue the real copy event without forwarding the shortcut to the editor.
    if (event.isTrusted && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        event.key.toLowerCase() === 'c' && selectedTranscript()) {
      event.stopImmediatePropagation();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing && event.keyCode !== 229) allowChatCommand(event);
  }, true);

  function preserveSelection(event) {
    if (chat && event.isTrusted && event.type === 'pointerdown') chat.replyPointer = undefined;
    if ((pending && event.isTrusted) || containsTarget(item, event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.isTrusted && event.button === 0 && containsTarget(chat?.host.querySelector(transcriptSelector), event.target)) {
      // The native editor may suppress pointer events to retain composer focus.
      // Keep the browser's default text-selection action for chat replies.
      event.stopImmediatePropagation();
      if (event.type === 'pointerdown') chat.replyPointer = [event.clientX, event.clientY];
    }
  }
  window.addEventListener('pointerdown', preserveSelection, true);
  window.addEventListener('mousedown', preserveSelection, true);
  window.addEventListener('pointerdown', allowChatCommand, true);
  window.addEventListener('copy', event => {
    const text = event.isTrusted && event.clipboardData && selectedTranscript();
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  function openSelectionChat(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.isTrusted || document.documentElement.dataset.notionSwitchSelectionChatReady !== '1' ||
        !anchor?.isConnected || !anchor.getClientRects().length) return;
    const text = selectedText() || (document.activeElement === item ? quote : '');
    if (!text) return;
    const token = crypto.randomUUID();
    pending = { token, text, timer: setTimeout(() => cancelPending('当前 Notion 浮窗未能打开「询问 AI」，请更新 SwitchNotion 后重试。'), 8000) };
    document.documentElement.dataset[handoff] = token;
    anchor.click();
    schedule();
  }
  window.addEventListener('click', event => {
    if (pending && event.isTrusted) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (containsTarget(item, event.target)) openSelectionChat(event);
    else if (event.isTrusted && event.detail > 0 && chat?.replyPointer &&
        containsTarget(chat.host.querySelector(transcriptSelector), event.target) &&
        Math.hypot(event.clientX - chat.replyPointer[0], event.clientY - chat.replyPointer[1]) > 4) {
      event.stopImmediatePropagation();
    } else allowChatCommand(event);
  }, true);

  document.addEventListener('selectionchange', schedule);
  new MutationObserver(() => {
    if (item || pending || chat || !window.getSelection()?.isCollapsed) schedule();
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-notion-switch-selection-chat-ready'] });
}
