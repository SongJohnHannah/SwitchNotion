import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
const start = source.indexOf('async function checkUpdates() {'), end = source.indexOf("$('update-switch-notion').addEventListener", start);
assert.ok(start >= 0 && end > start);
async function render(status) {
  const nodes = new Map(), messages = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, disabled: false, textContent: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({ api: { updateStatus: async () => ({ ok: true, result: status }) }, $: element,
    result: (...args) => messages.push(args), clearTimeout() {}, clientUpdatePoll: null });
  vm.runInContext(source.slice(start, end) + '\nthis.checkUpdates = checkUpdates;', context);
  await context.checkUpdates(); return { element, messages };
}
test('successful synchronization stays green when current webpage compatibility reports a separate problem', async () => {
  const message = '原型已同步，启动检查通过。';
  const view = await render({ compatible: true, clientCompatible: false, lastStatus: 'applied', lastResult: message,
    message: '检测到网页模块的实质变化，请更新 Switch Notion。' });
  assert.deepEqual(view.messages.find(args => args[0] === 'updates-result'), ['updates-result', message, false]);
  assert.match(view.element('updates-message').textContent, /网页模块/);
});
test('a failed synchronization stays red even when the installed client and webpage are compatible', async () => {
  const view = await render({ compatible: true, clientCompatible: true, lastStatus: 'blocked', lastResult: '更新未完成。' });
  assert.equal(view.messages.find(args => args[0] === 'updates-result')[2], true);
});
