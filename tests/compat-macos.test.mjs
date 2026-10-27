import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import compatibility from '../src/client-compat.cjs';
import { modulesIn } from '../src/compat/automatic.cjs';
import { inspect } from '../src/compat/semantic.cjs';
import { adaptResponse } from '../src/compat/response.cjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../src/compat/macos-reviewed.json', import.meta.url)));
const baseline = JSON.parse(fs.readFileSync(new URL('../src/compat/reviewed.json', import.meta.url))).modules;
const options = { localSpeechEnabled: true, audioEndpoint: 'http://127.0.0.1:32123' };

test('Mac compatibility records extend existing recording and connection kinds', () => {
  assert.deepEqual(Object.keys(manifest.modules).sort(), ['241978', '331787']);
  for (const [id, record] of Object.entries(manifest.modules)) {
    assert.match(record.moduleHash, /^[a-f\d]{64}$/);
    assert.match(record.fingerprint, /^[a-f\d]{64}$/);
    assert.notEqual(record.fingerprint, baseline[id].fingerprint);
  }
});

for (const [id, record] of Object.entries(manifest.modules)) {
  test(`Mac ${baseline[id].kind} supports the reviewed release and repacked chunks`, async t => {
    const file = new URL('../research/.public-assets/' + record.asset, import.meta.url);
    if (!fs.existsSync(file)) return t.skip('Public Notion fixture not cached locally');
    const source = fs.readFileSync(file, 'utf8');
    const module = modulesIn(source).find(module => module.id === id);
    assert.equal(createHash('sha256').update(module.source).digest('hex'), record.moduleHash);
    const info = inspect(module.source);
    assert.equal(info.fingerprint, record.fingerprint);
    for (const [role, name] of [['start', 'startDictation'], ['recorder', 'getDictationAudioRecorder'], ['stop', 'stopDictation']]) {
      if (id === '331787') assert.equal(info.at(baseline[id].selectors[role]).key.name, name);
    }
    const result = await adaptResponse(new Response(source), record.asset, options);
    assert.deepEqual(result.kinds, [baseline[id].kind]);
    const patched = await result.response.text();
    new vm.Script(patched);
    assert.equal(compatibility.adaptClient(source, record.asset), source, 'Disabled local speech preserves the official module');
    if (id === '331787') {
      assert.equal(result.changed, true);
      assert.match(patched, /stopDictationAfterLocalFlush/);
      assert.match(patched, /includeSystemAudio:!0/);
      assert.match(compatibility.adaptClient(source, record.asset, { ...options, inputMode: 'microphone' }), /includeSystemAudio:!1/);
      assert.match(patched, /\.dk\)\(e\.stopSource\?\?e\.from\)/, 'Preserve the new stop-source telemetry');
      assert.match(patched, /this.deadlineAtMs=e.clock.now\(\)\+12e3/);
    } else {
      assert.equal(patched, source);
      assert.match(patched, /watchdog_ms:3e4/);
      assert.match(patched, /recordStopSource/);
    }
    // Force the semantic path with a different chunk ID, formatting and
    // module parameter name. No downloaded third-party code is executed.
    const renamed = module.source.replace(/^(\d+)\(([^,]+),/, '$1(_macModule,');
    assert.equal(inspect(renamed).fingerprint, record.fingerprint);
    const repacked = '"use strict";(globalThis.rspackChunknotion_next||=[]).push([[60002],{' + renamed + '}]);';
    const automatic = await adaptResponse(new Response(repacked), '60002-0123456789abcdef.js', options);
    assert.deepEqual(automatic.kinds, [baseline[id].kind]);
    assert.equal(automatic.automatic[0].moduleId, id);
    new vm.Script(await automatic.response.text());
    const before = id === '331787' ? 'this.deadlineAtMs=e.clock.now()+12e3' : 'watchdog_ms:3e4';
    assert.ok(source.includes(before));
    const changed = source.replace(before, before + '+1');
    const original = new Response(changed);
    await assert.rejects(adaptResponse(original, record.asset, options), /Unreviewed/);
    assert.equal(await original.text(), changed);
  });
}
