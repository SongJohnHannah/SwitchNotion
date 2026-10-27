import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentMock } from '../src/agent-mock.cjs';

test('image references appear in native chat frames and remain visible after restoring an older conversation', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'test-image-display-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'conversations.json'), mock = new AgentMock({ stateFile });
  const files = [{ type: 'file', file_id: '11111111-1111-4111-8111-111111111111' }];
  const input = { threadId: '22222222-2222-4222-8222-222222222222', spaceId: '33333333-3333-4333-8333-333333333333',
    content: [{ type: 'text', text: '分析图片颜色' }, ...files] };
  await mock.create(input);
  mock.find(input).stop?.('test-cleanup');
  const user = (await mock.transcript(input).json()).patches.find(p => p.entity.kind === 'user_message').entity;
  assert.deepEqual(user.files, files);
  assert.deepEqual(mock.find(input).attachments[user.id], input.content);
  const live = mock.find(input).frames.flatMap(frame => frame.patches).find(p => p.entity?.kind === 'user_message');
  assert.deepEqual(live.entity.files, files);
  // Reproduce existing histories written before the chat display fix.
  const saved = JSON.parse(fs.readFileSync(stateFile));
  saved.threads[0].entities.find(entity => entity.kind === 'user_message').files = [];
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  const restored = new AgentMock({ stateFile });
  const historical = (await restored.transcript(input).json()).patches.find(p => p.entity.kind === 'user_message').entity;
  assert.deepEqual(historical.files, files);
});
