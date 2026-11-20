import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ORIGIN, USER } from './helpers/inline-document-route.mjs';

const require = createRequire(import.meta.url);
const { adaptResponse } = require('../src/compat/response.cjs');
const { SettingsService } = require('../src/settings-service.cjs');
const { setupThinkingMenu } = require('../src/compat/thinking-menu.cjs');
const providerMenu = `
  const i = { jsx: (component, props) => ({ component, props }) };
  const o = id => id === 635790 ? react : { A: 'menu-item' };
  const d = { otherModels: { id: 'ProviderModelMenu.otherModels' } };
  function p() {}
  function menu(e) {
    const t = 'fixture', a = true, C = ['models'];
    return{providerSections:a&&C.length>0?[{key:\`\${t}-other-models\`,render:e=>(0,i.jsx)(o(83743).A,{...e,topBorder:!0}),items:[{key:\`\${t}-other-models-trigger\`,render:(e,t)=>(0,i.jsx)(p,{title:d.otherModels,sections:C}),action:()=>{}}]}]:[]};
  }
`;

test('the native menu reads and updates local Settings through IPC without a browser request', async t => {
  const parent = path.resolve('.notion-switch');
  const root = fs.mkdtempSync(path.join(parent, 'thinking-menu-test-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'provider.local.json'), JSON.stringify({ mode: 'deepseek', model: 'deepseek-flash', thinking: 'disabled', reasoningEffort: 'high' }));
  const settings = new SettingsService({ root, fetchImpl: () => assert.fail('A thinking-only change never calls DeepSeek') });
  let handle;
  const frame = { url: ORIGIN + '/test' };
  const sender = { mainFrame: frame, getLastWebPreferences: () => ({ contextIsolation: true }) };
  setupThinkingMenu({ ipcMain: { handle(channel, callback) { assert.equal(channel, 'notion-switch:thinking-menu'); handle = callback; } },
    isWorkspaceContents: contents => contents === sender,
    request: input => settings.request(Object.hasOwn(input, 'effort') ? 'deepseek.thinking.save' : 'deepseek.thinking', input) });
  const event = { sender, senderFrame: frame };
  const window = { notionSwitchThinking: (...args) => handle(event, ...args) };
  let states = [], cursor = 0, cleanup;
  const react = { useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = value; }];
  }, useEffect(effect) { cleanup ||= effect(); } };
  const context = vm.createContext({ react, window, fetch: () => assert.fail('The native setting must not use HTTP') });
  const patched = await adaptResponse(new Response(providerMenu), '10900-0000000000000000.js');
  vm.runInContext(await patched.response.text(), context);
  let closed = 0;
  const control = { scope: [USER], locale: 'zh-CN', close: () => { closed++; } };
  const providerSections = context.menu({ notionSwitchThinking: control }).providerSections;
  assert.equal(providerSections[0].key, 'notion-switch-thinking');
  assert.equal(providerSections[1].key, 'fixture-other-models');
  assert.equal(context.menu({}).providerSections.length, 1, 'leave other AI menus alone');

  const view = providerSections[0].items[0].render({}, {});
  const submenu = () => { cursor = 0; return view.component(view.props).props; };
  const options = () => submenu().sections[0].items;
  assert.equal(submenu().title, '思考…');
  await new Promise(setImmediate);
  assert.equal(submenu().title, '思考 · 关闭');
  assert.deepEqual(Array.from(options(), item => item.render({}).props.title), ['关闭', '快速', '标准', '深入']);
  await options()[3].action();
  assert.equal(submenu().title, '思考 · 深入');
  assert.equal(options()[3].render({}).props.isChecked, true);
  assert.deepEqual((await settings.request('deepseek.thinking')).result, { thinking: true, reasoningEffort: 'max' });
  assert.equal(closed, 1);
  assert.equal((await handle({ ...event, senderFrame: { url: frame.url } }, USER, 'none')).ok, false);
  frame.url = 'https://app.notion.com.other.example/test';
  assert.equal((await handle(event, USER, 'none')).ok, false);
  frame.url = ORIGIN + '/test';
  assert.equal((await handle(event, 'not-a-user-id', 'none')).ok, false);
  assert.equal((await handle(event, USER, 'unknown')).ok, false);
  assert.deepEqual((await settings.request('deepseek.thinking')).result, { thinking: true, reasoningEffort: 'max' });
  await settings.request('deepseek.thinking.save', { effort: 'low' });
  cleanup(); cleanup = undefined; states = [];
  submenu();
  await new Promise(setImmediate);
  assert.equal(submenu().title, '思考 · 快速');
});
