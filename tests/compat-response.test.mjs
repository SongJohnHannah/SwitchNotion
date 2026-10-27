import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateScript } from '../src/compat/response.cjs';
test('candidate reading preserves the original response and ignores unrelated scripts', async () => {
  const response = new Response('console.log("ordinary");');
  assert.equal(await candidateScript(response, '90000-0123456789abcdef.js'), null);
  assert.equal(await response.text(), 'console.log("ordinary");');
  const candidate = new Response('({331787(a,b,c){}})');
  assert.equal(await candidateScript(candidate, '90000-0123456789abcdef.js'), '({331787(a,b,c){}})');
  assert.equal(candidate.bodyUsed, false);
});
test('oversized and malformed asset responses cannot enter compatibility analysis', async () => {
  const large = new Response('content', { headers: { 'content-length': String(3 * 1024 * 1024) } });
  assert.equal(await candidateScript(large, '90000-0123456789abcdef.js'), null);
  assert.equal(await large.text(), 'content');
  await assert.rejects(candidateScript(new Response('content', { headers: { 'content-length': String(3 * 1024 * 1024) } }), '89269-0123456789abcdef.js'));
  assert.equal(await candidateScript(new Response('content'), 'not-a-script'), null);
});
