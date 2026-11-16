import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { adaptResponse } from '../src/compat/response.cjs';
import { modulesIn } from '../src/compat/automatic.cjs';

const asset = '95271-87feab854df23797.js';
const file = new URL('../research/.public-assets/' + asset, import.meta.url);
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const needsFixture = source ? {} : { skip: 'Reviewed public Notion asset is not distributed with the source.' };

function availability(script, name = 'ai_usage', restricted = false) {
  const module = modulesIn(script).find(item => item.id === '811656');
  assert.ok(module, 'The production availability module must be present');
  const exported = {}, dependency = id => ({
    ...(id === 48697 ? { Xk: (rules, type) => rules.includes(type) } : {}),
    ...(id === 900989 ? { N8: () => false } : {}),
    ...(id === 337174 ? { hj: value => value } : {})
  });
  dependency.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  vm.runInNewContext('({' + module.source + '})[811656]', { Math: { ...Math, random: () => 1 } })({}, exported, dependency);
  return exported.jx({ [name]: { type: 'check', workspaceRestrictions: ['workspace-rule'] } },
    { [name]: () => ({ type: 'unavailable', limit: { type: 'none' }, upsell: { type: 'none' } }) }, {
      name, scope: { id: 'synthetic-workspace', billingData: {}, premiumFeatureOverrides: {},
        workspaceRestrictions: restricted ? [{ type: 'workspace-rule' }] : [] },
      data: {}, actor: {}, supportedProducts: ['free', 'business'],
      environment: { logFunction() {}, trackFunction() {} }
    });
}

test('the November native AI chat no longer reports exhausted hosted replies for the local provider', needsFixture, async () => {
  assert.equal(availability(source).type, 'unavailable');
  const result = await adaptResponse(new Response(source), asset);
  assert.ok(result?.kinds.includes('availability'));
  const patched = await result.response.text();
  const local = availability(patched);
  assert.equal(local.type, 'available'); assert.equal(local.limit.amount, 'unlimited');
  assert.equal(availability(patched, 'ai_usage', true).type, 'unavailable');
  assert.equal(availability(patched, 'private_teamspaces').type, 'unavailable');
});

test('the reviewed November availability module still adapts when repacked and rejects changed permissions or imports', needsFixture, async () => {
  const module = modulesIn(source).find(item => item.id === '811656').source;
  const chunk = value => '"use strict";(globalThis.rspackChunknotion_next||=[]).push([[60001],{' + value + '}]);';
  const renamed = '60001-0123456789abcdef.js';
  const result = await adaptResponse(new Response(chunk(module)), renamed);
  assert.equal(availability(await result.response.text()).type, 'available');
  for (const changed of [module.replace('workspaceRestriction:y', 'workspaceRestriction:undefined'),
    module.replace('i(740776)', 'i(740777)')]) {
    await assert.rejects(adaptResponse(new Response(chunk(changed)), renamed), /Unreviewed/);
  }
});
