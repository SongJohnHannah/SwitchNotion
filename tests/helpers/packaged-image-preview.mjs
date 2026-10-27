import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const USER = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');

// Run the files actually shipped by each packager. This verifies the shared
// Electron contract on the current host, not a Windows desktop UI session.
export async function verifyPackagedImagePreview(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'local-image-uploads.cjs'));
  const { LocalImageUploads } = require('./local-image-uploads.cjs');
  const { AgentMock } = require('./agent-mock.cjs');
  fs.mkdirSync(root, { recursive: true });
  for (const origin of ['https://app.notion.com', 'https://www.notion.so']) {
    const mock = new AgentMock({ stateFile: path.join(root, new URL(origin).hostname + '.json') });
    const store = new LocalImageUploads({ root, owns: input => mock.owns(input), record: id => mock.record(id) });
    const target = { type: 'user' }, filename = '聊天图片 颜色.png';
    const created = store.create({ spaceId: SPACE, target, filename, mediaType: 'image/png', sizeBytes: PNG.length }, USER, origin);
    await store.put(new URL(created.upload.url).pathname.split('/').at(-1), new Request(created.upload.url, { method: 'PUT', body: PNG }));
    const file = store.complete({ spaceId: SPACE, target, fileId: created.file.id }, USER);
    const content = [{ type: 'text', text: '描述图片' }, { type: 'file', file_id: file.id }];
    await mock.create({ spaceId: SPACE, threadId: THREAD, content }, { userId: USER });
    mock.find({ threadId: THREAD }).stop?.('test-cleanup');
    const user = (await mock.transcript({ threadId: THREAD }).json()).patches.find(p => p.entity.kind === 'user_message').entity;
    assert.deepEqual(user.files, [content[1]]);
    const compactUpperId = file.id.replaceAll('-', '').toUpperCase();
    assert.equal(store.hasFile(compactUpperId), true, 'File IDs have identical disk semantics on Windows and Mac');
    const resolved = store.resolve({ spaceId: SPACE, threadId: THREAD, fileId: compactUpperId, includeFileMetadata: true }, USER, origin);
    assert.equal(resolved.file.filename, filename);
    for (const url of [resolved.url, origin + '/image/' + encodeURIComponent(resolved.url) + '?width=240']) {
      const preview = store.preview(new Request(url));
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
    }
    // A fresh store uses persisted files and issues a fresh preview capability.
    const restored = new LocalImageUploads({ root, owns: input => mock.owns(input), record: id => mock.record(id) });
    const next = restored.resolve({ spaceId: SPACE, threadId: THREAD, fileId: file.id }, USER, origin);
    assert.equal(restored.preview(new Request(next.url)).status, 200);
    assert.ok(!JSON.stringify(resolved).includes(root));
  }
}
