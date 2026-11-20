import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { adaptResponse } from '../src/compat/response.cjs';
import { modulesIn } from '../src/compat/automatic.cjs';
import { parse } from '../src/compat/parser.cjs';

const latestAvailabilityAsset = '95271-e5ca9d65d34304cf.js';
const assets = ['95271-87feab854df23797.js', '95271-3b930ea252348c71.js', '95271-adf135991da29369.js', latestAvailabilityAsset];
const chunk = (...modules) => '"use strict";(globalThis.rspackChunknotion_next||=[]).push([[60001],{' + modules.join(',') + '}]);';
const relocatedAsset = '60001-0123456789abcdef.js';

function tierRankingModule(source) {
  const ast = parse(source, { ecmaVersion: 2024 });
  const properties = ast.body[1].expression.arguments[0].elements[1].properties;
  const ranking = properties.find(property => property.key.value === 197459);
  assert.ok(ranking);
  return source.slice(ranking.start, ranking.end);
}

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

for (const asset of assets) {
  const file = new URL('../research/.public-assets/' + asset, import.meta.url);
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const needsFixture = source ? {} : { skip: 'Reviewed public Notion asset is not distributed with the source.' };
  test(`${asset}: native AI chat no longer reports exhausted hosted replies for the local provider`, needsFixture, async () => {
    assert.equal(availability(source).type, 'unavailable');
    const result = await adaptResponse(new Response(source), asset);
    assert.ok(result?.kinds.includes('availability'));
    const patched = await result.response.text();
    const local = availability(patched);
    assert.equal(local.type, 'available'); assert.equal(local.limit.amount, 'unlimited');
    assert.equal(availability(patched, 'ai_usage', true).type, 'unavailable');
    assert.equal(availability(patched, 'private_teamspaces').type, 'unavailable');
  });

  test(`${asset}: repacked availability preserves permissions, imports and override expiry`, needsFixture, async () => {
    const module = modulesIn(source).find(item => item.id === '811656').source;
    const latest = asset === latestAvailabilityAsset;
    const renamed = asset === assets[0] || latest ? relocatedAsset : '95271-0123456789abcdef.js';
    const dependencies = latest ? [tierRankingModule(source)] : [];
    const result = await adaptResponse(new Response(chunk(module, ...dependencies)), renamed);
    assert.equal(availability(await result.response.text()).type, 'available');
    const restriction = asset === assets[0] || latest ? 'workspaceRestriction:y' : 'workspaceRestriction:g';
    for (const [before, after] of [[restriction, 'workspaceRestriction:undefined'],
      ['i(740776)', 'i(740777)'], ['isOverrideAllowed', 'changedOverridePermission'], ['r>=o', 'r>o'],
      ...(latest ? [['i(197459).o3', 'i(197459).o4']] : [])]) {
      assert.ok(module.includes(before), 'Mutation probe must reach the reviewed behavior');
      await assert.rejects(adaptResponse(new Response(chunk(module.replace(before, after), ...dependencies)), renamed), /Unreviewed/);
    }
  });

  if (asset !== latestAvailabilityAsset) continue;
  test('a future tier ranking module ID is accepted only with the reviewed dependency', needsFixture, async () => {
    const module = modulesIn(source).find(item => item.id === '811656').source;
    const renamed = module.replaceAll('i(197459).o3', 'i(456789).o3');
    assert.notEqual(renamed, module);
    const ranking = tierRankingModule(source).replace(/^197459/, '456789');
    const changedRanking = ranking.replace('business:4,enterprise:5', 'business:4,enterprise:6');
    assert.notEqual(changedRanking, ranking);

    const result = await adaptResponse(new Response(chunk(renamed, ranking)), relocatedAsset);
    const patched = await result.response.text();
    assert.equal(availability(patched).type, 'available');
    assert.equal(availability(patched, 'ai_usage', true).type, 'unavailable');

    for (const candidates of [[], [changedRanking], [ranking, ranking]]) {
      await assert.rejects(adaptResponse(new Response(chunk(renamed, ...candidates)), relocatedAsset), /Unreviewed/);
    }
  });
}
