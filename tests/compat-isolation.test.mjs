import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptResponse } from '../src/compat/response.cjs';
import { inlineDocumentRoute } from './helpers/inline-document-route.mjs';

for (const asset of ['95271-87feab854df23797.js', '58104-05a8357fa0359922.js']) {
  const file = new URL('../research/.public-assets/' + asset, import.meta.url);
  test(`${asset} can adapt while the recording backend is unavailable`,
    fs.existsSync(file) ? {} : { skip: 'Official public client fixture is not distributed.' }, async () => {
      const result = await adaptResponse(new Response(fs.readFileSync(file, 'utf8')), asset,
        { prepare: () => assert.fail('AI controls must not prepare the recording backend') });
      assert.equal(result.changed, true);
    });
}

for (const kind of ['availability', 'models', 'provider', 'attachments', 'autofill', 'recording', undefined]) {
  test(`a failed ${kind || 'unknown'} script only invalidates recording when required`, async t => {
    const parent = os.tmpdir(), root = fs.mkdtempSync(path.join(parent, 'notion-ui-isolation-'));
    const fixture = inlineDocumentRoute(root, { allowUpstream: true });
    t.after(() => { fixture.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
    const { context } = fixture;
    context.compatibility = { adaptedAssets: [], automaticAssets: [], unsupportedAssets: [] };
    context.nativeSpeech = { enabled: true, lifecycleReady: true, transportReady: true, drainTransportReady: true };
    context.adaptResponse = async () => { throw Object.assign(Error('Unreviewed native client asset'), kind ? { notionSwitchKind: kind } : {}); };
    const response = await fixture.raw(new Request('https://app.notion.com/_assets/60001-0123456789abcdef.js'));
    assert.equal(response.status, 200); assert.equal(context.compatibility.unsupportedAssets.length, 1);
    assert.equal(context.nativeSpeech.lifecycleReady, ![undefined, 'recording'].includes(kind));
    assert.equal(context.nativeSpeech.transportReady, true); assert.equal(context.nativeSpeech.drainTransportReady, true);
  });
}
