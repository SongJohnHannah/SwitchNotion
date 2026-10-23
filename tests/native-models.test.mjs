import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { models, nativeModelCatalog } = require('../src/native-models.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');

test('native catalog maps both reviewed DeepSeek options to official API models without credentials', () => {
  const catalog = nativeModelCatalog();
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models.map(m => m.agentService.finalModelName), models.map(m => m.nativeId));
  assert.ok(catalog.models.every(m => m.isDisabled === false && m.billsNotionCredits === false));
  assert.equal(JSON.stringify(catalog).includes('apiKey'), false);
});

test('native selection changes real request model, keeps history and survives restart; auto uses local default', async () => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'test-model-selection-'));
  try {
    const configFile = path.join(dir, 'provider.local.json');
    fs.writeFileSync(configFile, JSON.stringify({ mode: 'deepseek', model: 'deepseek-flash', apiKeyFile: 'key.txt' }));
    fs.writeFileSync(path.join(dir, 'key.txt'), 'fixture-key');
    const sent = [];
    const provider = new ProviderRouter({ root: dir, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); sent.push({ url, body, headers: options.headers });
      return new Response('data: ' + JSON.stringify({ model: body.model, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } });
    const stateFile = path.join(dir, 'conversations.json');
    let agent = new AgentMock({ provider, stateFile });
    const input = { threadId: 'models', spaceId: 'space', model: models[0].nativeId, content: [{ type: 'text', text: 'Remember fixture code BLUE.' }] };
    const idle = async () => { for (let i = 0; agent.status().active && i < 100; i++) await sleep(1); assert.equal(agent.status().active, 0); };
    agent.create(input); await idle();
    assert.equal(agent.record(input.threadId).data.agent_provider.model, models[0].nativeId);
    agent.send({ threadId: input.threadId, modelSelection: { type: 'explicit', model: models[1].nativeId }, event: { type: 'user.message', content: [{ type: 'text', text: 'Continue using the code.' }] } }); await idle();
    agent = new AgentMock({ provider, stateFile });
    assert.equal(agent.record(input.threadId).data.agent_provider.model, models[1].nativeId);
    agent.send({ threadId: input.threadId, event: { type: 'user.message', content: [{ type: 'text', text: 'After restart.' }] } }); await idle();
    agent.send({ threadId: input.threadId, modelSelection: { type: 'automatic' }, event: { type: 'user.message', content: [{ type: 'text', text: 'Auto.' }] } }); await idle();
    assert.deepEqual(sent.map(x => x.body.model), ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-flash']);
    assert.ok(sent.every(x => x.url === 'https://api.deepseek.com/chat/completions'));
    assert.ok(sent[1].body.messages.some(m => m.role === 'user' && m.content.includes('BLUE')));
    assert.equal(JSON.parse(fs.readFileSync(configFile)).model, 'deepseek-flash');
    assert.equal(agent.record(input.threadId).data.agent_provider.modelSelection, 'auto');
    assert.equal(provider.status().lastGeneration.responseModel, 'deepseek-flash');
    assert.throws(() => agent.send({ threadId: input.threadId, modelSelection: { type: 'explicit', model: 'unknown-model' }, event: { type: 'user.message', content: [] } }), /DeepSeek/);
    assert.equal(sent.length, 4);
    assert.throws(() => agent.create({ threadId: 'rejected', model: 'unknown', content: [] }), /DeepSeek/);
    assert.equal(agent.record('rejected'), undefined);
  } finally { assert.equal(path.dirname(path.resolve(dir)), parent); fs.rmSync(dir, { recursive: true, force: true }); }
});
