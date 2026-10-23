import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertReviewedBuild, reviewedBuilds } from '../scripts/prepare-desktop.mjs';
const { adaptClient } = createRequire(import.meta.url)('../src/client-compat.cjs');
const asset = '95271-adc4a76136e50ec0.js';
const cached = name => { const file = path.resolve('research/.public-assets', name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
const source = cached(asset), renamedSource = cached('95271-ae201a176278efa7.js');
const requiresCache = source ? {} : { skip: 'Reviewed third-party Notion assets are not distributed with the source.' };
test('reviewed October 23 native client enables the local provider after workspace restriction checks', requiresCache, () => {
  const patched = adaptClient(source, asset), gate = patched.indexOf('if(u==="ai_usage")return{type:"available"');
  assert.ok(gate > patched.indexOf('workspaceRestriction:y'));
  assert.ok(patched.includes('if(u==="ai_model_selection")'));
  assert.notEqual(patched, source);
});
test('unknown or changed native assets remain rejected instead of applying a blind patch', requiresCache, () => {
  assert.throws(() => adaptClient(source + '\n// changed', asset), /Unreviewed/);
  assert.throws(() => adaptClient(source, '95271-unknown.js'), /Unreviewed/);
});

test('a newly named chunk is automatically accepted only when its exact reviewed target module is unchanged', requiresCache, () => {
  const renamed = '95271-0123456789abcdef.js';
  assert.doesNotThrow(() => adaptClient(source + '\n// unrelated outer change', renamed));
  assert.throws(() => adaptClient(source.replace('workspaceRestriction:y', 'workspaceRestriction:undefined'), renamed), /Unreviewed/);
  assert.throws(() => adaptClient(source.replace('811656(', '811655('), renamed), /Unreviewed/);
});

test('reviewed local minifier renaming is accepted without weakening permission checks', renamedSource ? {} : { skip: 'Reviewed third-party Notion assets are not distributed with the source.' }, () => {
  const name = '95271-ae201a176278efa7.js', renamed = renamedSource;
  const patched = adaptClient(renamed, name);
  assert.ok(patched.indexOf('if(u==="ai_usage")') > patched.indexOf('workspaceRestriction:y'));
  assert.ok(patched.includes('let g=(null==(r=(o=e[u]).isOverrideAllowed)'));
  assert.throws(() => adaptClient(renamed.replace('workspaceRestriction:y', 'workspaceRestriction:undefined'), name), /Unreviewed/);
  assert.throws(() => adaptClient(renamed.replace('isOverrideAllowed', 'differentPermission'), name), /Unreviewed/);
});
test('the updated desktop build is pinned while unknown versions and changed hashes remain blocked', () => {
  assert.doesNotThrow(() => assertReviewedBuild('7.40.1', '36cc65c5d17811f6bbe90aa0444be3f3f267f3151ea59988411e8f94dba9ff73'));
  assert.doesNotThrow(() => assertReviewedBuild('7.40.0', reviewedBuilds['7.40.0']));
  assert.throws(() => assertReviewedBuild('7.40.1', 'changed'));
  assert.throws(() => assertReviewedBuild('future', reviewedBuilds['7.40.1']));
});
