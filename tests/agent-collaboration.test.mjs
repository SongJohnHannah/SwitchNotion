import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runAgent } = require('../src/agent-runtime.cjs');
const { writeTools } = require('../src/notion-capabilities.cjs');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const pageUrl = page => 'https://www.notion.so/' + page.replaceAll('-', '');
const tool = name => ({ type: 'function', function: { name, description: 'synthetic fixture', parameters: { type: 'object', properties: {}, required: [] } } });
const call = (name, args, suffix = '') => ({ id: name + suffix, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolsNamed = args => args.tools.map(item => item.function.name);
const childTask = args => {
  const prompt = args.messages.filter(message => message.role === 'user').at(-1)?.content || '';
  return prompt.includes('分配给你的只读子任务：\n') ? prompt.split('分配给你的只读子任务：\n').at(-1) : null;
};
const resultFrom = args => JSON.parse(args.messages.at(-1).content);
const deferred = () => { let resolve, reject; const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; }); return { promise, resolve, reject }; };
async function within(promise, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Fixture timed out: ' + description)), 1000); })]); }
  finally { clearTimeout(timer); }
}

function fixture({ onExecute } = {}) {
  const opened = [], executed = [], writes = [], steps = [];
  const definitions = [tool('read_page'), tool('search_pages'), ...[...writeTools].map(tool)];
  const workspace = { open: async options => {
    const sessionId = opened.length, seen = new Map();
    opened.push({ ...options, sessionId });
    return { definitions, execute: async (name, args) => {
      const event = { sessionId, name, args, signal: options.signal, operationScope: options.operationScope };
      executed.push(event); options.signal?.throwIfAborted();
      if (onExecute) { const value = await onExecute(event); if (value !== undefined) return value; }
      if (name === 'read_page') {
        const revision = `session-${sessionId}-${args.page_id}`; seen.set(args.page_id, revision);
        return { page_id: args.page_id, url: pageUrl(args.page_id), revision, markdown: 'Synthetic content: ' + args.page_id, complete: true };
      }
      if (name === 'search_pages') return { results: [{ page_id: A, url: pageUrl(A), title: 'Synthetic source' }], scanned: 1, has_more: false, complete: true };
      if (writeTools.has(name)) {
        if (name === 'append_page') assert.equal(args.revision, seen.get(args.page_id), 'A reader session revision cannot authorize the main session write');
        writes.push(event);
        return { page_id: args.page_id || B, url: pageUrl(args.page_id || B), verified: true };
      }
      throw Error('Unexpected synthetic tool');
    } };
  } };
  const start = (provider, config = {}, extra = {}) => runAgent({ provider, config: { mode: 'deepseek', model: 'fixture-model', ...config }, workspace, operationScope: 'synthetic-collaboration',
    nativeContext: { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', page_id: A },
    messages: [{ role: 'system', content: '' }, { role: 'user', content: 'Analyze two independent synthetic sources, then apply only the requested result.' }], signal: new AbortController().signal,
    onText: () => {}, onStep: step => steps.push(step), ...extra });
  return { workspace, opened, executed, writes, steps, start };
}

test('default collaboration starts independent readers in parallel, then the main agent alone performs a fresh-read write', async t => {
  const f = fixture(), bothStarted = deferred(), release = deferred(), stop = new AbortController();
  const arrived = new Set(), rounds = new Map(), childRequests = [];
  let mainRound = 0, delegateResult;
  const provider = { async* generate(args) {
    const task = childTask(args);
    if (task) {
      const round = rounds.get(task) || 0; rounds.set(task, round + 1);
      childRequests.push({ config: args.config, tools: toolsNamed(args), signal: args.signal });
      if (round === 0) {
        arrived.add(task); if (arrived.size === 2) bothStarted.resolve();
        await release.promise;
        args.onToolCalls([call('read_page', { page_id: task === 'alpha' ? A : B }, task)]);
      } else yield 'Read-only conclusion: ' + task;
      return;
    }
    assert.equal(toolsNamed(args).includes('delegate_research'), true);
    if (mainRound === 0) args.onToolCalls([call('delegate_research', { tasks: ['alpha', 'beta'] })]);
    else if (mainRound === 1) { delegateResult = resultFrom(args); args.onToolCalls([call('read_page', { page_id: B }, 'main')]); }
    else if (mainRound === 2) args.onToolCalls([call('append_page', { page_id: B, revision: resultFrom(args).revision, content: 'Verified synthetic conclusions' })]);
    else yield 'Main write verified.';
    mainRound++;
  } };
  const running = f.start(provider, {}, { signal: stop.signal });
  t.after(async () => { release.resolve(); stop.abort(); await running.catch(() => {}); });
  await within(bothStarted.promise, 'both reader generations must start before either is released');
  assert.equal(arrived.size, 2); assert.equal(f.opened.length, 3); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.opened.map(session => session.operationScope), ['synthetic-collaboration', 'synthetic-collaboration:reader-0', 'synthetic-collaboration:reader-1']);
  release.resolve(); await running;
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].sessionId, 0);
  assert.equal(delegateResult.agents.length, 2);
  assert.equal(delegateResult.agents.every(agent => agent.read_only === true && !agent.error && agent.answer.includes('Read-only conclusion:')), true);
  assert.deepEqual(delegateResult.agents.map(agent => agent.sources), [[pageUrl(A)], [pageUrl(B)]]);
  assert.equal(childRequests.every(request => request.config.multiAgent === false && request.config.maxTokens === 16384), true);
  assert.equal(childRequests.every(request => request.tools.every(name => !writeTools.has(name) && name !== 'delegate_research')), true);
  assert.equal(childRequests.every(request => request.signal === stop.signal), true);
  assert.equal(f.steps.filter(step => step.name === 'collaborator' && step.state === 'completed').length, 2);
});

test('a reader that attempts a hidden write cannot reach the executor or pass off its result as completed', async () => {
  const f = fixture(); let mainRound = 0, delegated;
  const provider = { async* generate(args) {
    const task = childTask(args);
    if (task) {
      assert.equal(toolsNamed(args).some(name => writeTools.has(name)), false);
      assert.equal(toolsNamed(args).includes('delegate_research'), false);
      if (task === 'attempt-write') args.onToolCalls([call('append_page', { page_id: A, revision: 'forged', content: 'must not be written' })]);
      else yield 'Independent read-only analysis completed.';
      return;
    }
    if (mainRound++ === 0) args.onToolCalls([call('delegate_research', { tasks: ['attempt-write', 'safe-analysis'] })]);
    else { delegated = resultFrom(args); yield 'One reader could not finish; no edits were submitted.'; }
  } };
  await f.start(provider);
  assert.equal(f.writes.length, 0);
  assert.equal(f.executed.some(event => writeTools.has(event.name)), false);
  assert.equal(delegated.agents[0].read_only, true); assert.equal(typeof delegated.agents[0].error, 'string');
  assert.equal(Object.hasOwn(delegated.agents[0], 'answer'), false);
  assert.equal(delegated.agents[1].answer.includes('Independent read-only analysis completed.'), true);
  assert.equal(f.steps.some(step => step.name === 'collaborator' && step.agent === 1 && step.state === 'completed'), false);
});

test('a failed child returns an explicit sanitized failure alongside successful child evidence', async () => {
  const f = fixture(), rounds = new Map(); let mainRound = 0, delegated;
  const provider = { async* generate(args) {
    const task = childTask(args);
    if (task === 'fails') { yield 'Unfinished draft'; throw Error('private upstream fixture-key and raw payload must stay private'); }
    if (task) {
      const round = rounds.get(task) || 0; rounds.set(task, round + 1);
      if (round === 0) args.onToolCalls([call('search_pages', { query: 'synthetic', scope: 'title' })]);
      else yield 'Supported conclusion.';
      return;
    }
    if (mainRound++ === 0) args.onToolCalls([call('delegate_research', { tasks: ['fails', 'succeeds'] })]);
    else { delegated = resultFrom(args); yield 'Only the second analysis finished; the first requires checking.'; }
  } };
  await f.start(provider);
  assert.equal(typeof delegated.agents[0].error, 'string'); assert.equal(Object.hasOwn(delegated.agents[0], 'answer'), false);
  assert.equal(JSON.stringify(delegated).includes('fixture-key'), false); assert.equal(JSON.stringify(delegated).includes('Unfinished draft'), false);
  assert.equal(delegated.agents[1].answer.includes('Supported conclusion.'), true);
  assert.deepEqual(delegated.agents[1].sources, [pageUrl(A)]);
  assert.equal(f.steps.some(step => step.name === 'collaborator' && step.agent === 1 && step.state === 'completed'), false);
  assert.equal(f.steps.some(step => step.name === 'collaborator' && step.agent === 2 && step.state === 'completed'), true);
});

test('disabling collaboration omits delegation from the actual model tool list and retains normal editing tools', async () => {
  const f = fixture(); let generations = 0;
  const provider = { async* generate(args) {
    generations++;
    assert.equal(toolsNamed(args).includes('delegate_research'), false);
    assert.equal(toolsNamed(args).includes('append_page'), true);
    assert.equal(childTask(args), null);
    yield 'Direct analysis only.';
  } };
  await f.start(provider, { multiAgent: false });
  assert.equal(generations, 1); assert.equal(f.opened.length, 1);
  assert.equal(f.steps.some(step => step.name === 'collaborator'), false);
});

test('a model cannot invoke delegation after collaboration was disabled', async () => {
  const f = fixture();
  const provider = { async* generate(args) { args.onToolCalls([call('delegate_research', { tasks: ['one', 'two'] })]); } };
  await assert.rejects(f.start(provider, { multiAgent: false }), /未启用的工具/);
  assert.equal(f.opened.length, 1); assert.equal(f.writes.length, 0);
});

test('parent stop aborts all three in-flight reader requests and prevents later tools or model steps', async t => {
  const stop = new AbortController(), allReading = deferred(), readers = [], cancelled = new Set();
  const f = fixture({ onExecute: event => {
    if (!event.operationScope.includes(':reader-')) return;
    readers.push(event);
    const reading = new Promise((_resolve, reject) => event.signal.addEventListener('abort', () => { cancelled.add(event.sessionId); reject(event.signal.reason); }, { once: true }));
    if (readers.length === 3) allReading.resolve();
    return reading;
  } });
  let mainGenerations = 0, childGenerations = 0;
  const provider = { async* generate(args) {
    if (childTask(args)) { childGenerations++; args.onToolCalls([call('read_page', { page_id: A })]); }
    else { mainGenerations++; args.onToolCalls([call('delegate_research', { tasks: ['one', 'two', 'three'] })]); }
  } };
  const running = f.start(provider, {}, { signal: stop.signal });
  t.after(async () => { stop.abort(); await running.catch(() => {}); });
  await within(allReading.promise, 'all reader requests must be in flight');
  assert.equal(readers.every(event => event.signal === stop.signal), true);
  stop.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(cancelled.size, 3); assert.equal(childGenerations, 3); assert.equal(mainGenerations, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.steps.some(step => step.name === 'collaborator' && step.state === 'completed'), false);
});

test('delegation validates its bounded task count before opening any child session', async () => {
  for (const tasks of [['only-one'], ['a', 'b', 'c', 'd'], ['valid', ' ']]) {
    const f = fixture(); let round = 0, delegated;
    const provider = { async* generate(args) {
      assert.equal(childTask(args), null);
      if (round++ === 0) args.onToolCalls([call('delegate_research', { tasks })]);
      else { delegated = resultFrom(args); yield 'Task format requires correction.'; }
    } };
    await f.start(provider);
    assert.equal(f.opened.length, 1); assert.equal(typeof delegated.error, 'string');
    assert.equal(f.steps.some(step => step.name === 'collaborator'), false);
  }
});

test('reader round limits and result truncation are explicit instead of inventing successful completion', async () => {
  const f = fixture(); let mainRound = 0, spinningRounds = 0, delegated;
  const provider = { async* generate(args) {
    const task = childTask(args);
    if (task === 'bounded-loop') { spinningRounds++; args.onToolCalls([call('read_page', { page_id: A }, String(spinningRounds))]); return; }
    if (task === 'long-answer') { yield 'long '.repeat(5000); return; }
    if (mainRound++ === 0) args.onToolCalls([call('delegate_research', { tasks: ['bounded-loop', 'long-answer'] })]);
    else { delegated = resultFrom(args); yield 'One bounded reader did not finish; the other result was shortened.'; }
  } };
  await f.start(provider);
  assert.equal(spinningRounds, 8);
  assert.equal(typeof delegated.agents[0].error, 'string'); assert.equal(Object.hasOwn(delegated.agents[0], 'answer'), false);
  assert.equal(delegated.agents[1].truncated, true); assert.equal(delegated.agents[1].answer.length, 16000);
  assert.equal(f.steps.some(step => step.name === 'collaborator' && step.agent === 1 && step.state === 'completed'), false);
  assert.equal(f.writes.length, 0);
});
