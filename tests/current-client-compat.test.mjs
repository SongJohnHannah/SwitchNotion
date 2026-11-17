import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { clientForPlatform } from './helpers/client-platform.mjs';

const entries = [
  ['availability', '95271-87feab854df23797.js', 'workspaceRestriction:y', 'workspaceRestriction:undefined'],
  ['audio', '17521-c51cb99aa3f35657.js', 'audio_processor_client_config_com', 'audio_processor_client_config_changed'],
  ['connection', '17048-04f1eaf35d672dd1.js', 'watchdog_ms:3e4', 'watchdog_ms:3e5'],
  ['recording', '89269-0b37eab23d323462.js', 'this.deadlineAtMs=e.clock.now()+12e3', 'this.deadlineAtMs=e.clock.now()+120e3'],
  ['provider', '58104-05a8357fa0359922.js', '"mystery"', '"changed-provider"'],
  ['attachments', '51103-e26284a203102910.js', 'processAgentAttachment', 'processAgentAttachmentChanged'],
  ['autofill', '57590-b67533fec6321f39.js', 'triggerLiteAgentAutofill', 'triggerLiteAgentAutofillChanged'],
  ['availability', '95271-3b930ea252348c71.js', 'workspaceRestriction:g', 'workspaceRestriction:undefined'],
  ['autofill', '57590-1ff6559994fff905.js', 'subscribeToTaskOutput', 'subscribeToTaskOutputChanged'],
  ['attachments', '51103-2e3dc6cde9c9f009.js', 'processAgentAttachment', 'processAgentAttachmentChanged']
];
const options = { localSpeechEnabled: true, audioEndpoint: 'http://127.0.0.1:32123', inputMode: 'microphone' };

for (const platform of ['win32', 'darwin']) for (const [kind, asset, anchor, replacement] of entries) {
  const file = new URL('../research/.public-assets/' + asset, import.meta.url);
  test(`${platform} production dispatch supports the current ${kind} script and rejects changed behavior`,
    fs.existsSync(file) ? {} : { skip: 'Official public client fixture is not distributed.' }, async () => {
      const source = fs.readFileSync(file, 'utf8'), client = clientForPlatform(platform);
      const result = await client.adaptResponse(new Response(source), asset, { ...options, prepare() {
        assert.ok(['audio', 'recording', 'connection'].includes(kind), 'Unrelated UI must not prepare speech');
      } });
      assert.ok(result); assert.ok(result.kinds.includes(kind));
      const patched = await result.response.text(); new vm.Script(patched);
      if (kind === 'connection') assert.equal(patched, source);
      else assert.notEqual(patched, source);
      if (kind === 'audio') assert.ok(patched.includes(options.audioEndpoint));
      if (kind === 'recording') {
        assert.match(patched, /includeSystemAudio:!1/); assert.match(patched, /stopDictationAfterLocalFlush/);
        assert.ok(patched.includes(anchor), 'Preserve the finite native stop deadline');
      }
      if (['audio', 'connection', 'recording'].includes(kind))
        assert.equal(client.adaptClient(source, asset, { localSpeechEnabled: false }), source);
      assert.ok(source.includes(anchor), 'Mutation probe must reach the native behavior');
      const changed = new Response(source.replace(anchor, replacement));
      await assert.rejects(client.adaptResponse(changed, asset, options), /Unreviewed|Changed .*speech/);
      assert.equal(await changed.text(), source.replace(anchor, replacement));
    });
}

test('current frontend adaptations have identical output on Win and Mac', async t => {
  const windows = clientForPlatform('win32'), mac = clientForPlatform('darwin');
  for (const [, asset] of entries) {
    const file = new URL('../research/.public-assets/' + asset, import.meta.url);
    await t.test(asset, fs.existsSync(file) ? {} : { skip: 'Official public client fixture is not distributed.' }, async () => {
      const source = fs.readFileSync(file, 'utf8');
      const left = await windows.adaptResponse(new Response(source), asset, options);
      const right = await mac.adaptResponse(new Response(source), asset, options);
      assert.deepEqual(left.kinds, right.kinds); assert.equal(await left.response.text(), await right.response.text());
    });
  }
});
