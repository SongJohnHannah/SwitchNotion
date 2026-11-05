import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { adaptClient } = require('../src/client-compat.cjs');
const { modulesIn } = require('../src/compat/automatic.cjs');
const locations = ['../.notion-switch/writer-assets/', '../research/.public-assets/'];
const fixtures = locations.flatMap(directory => {
  const url = new URL(directory, import.meta.url);
  return fs.existsSync(url) ? fs.readdirSync(url).filter(name => /^95271-[a-f\d]{16}\.js$/.test(name))
    .map(name => ({ name, source: fs.readFileSync(new URL(name, url), 'utf8') })) : [];
});
function availability(source, name, blocked = false) {
  const module = modulesIn(source).find(item => item.id === '811656');
  assert.ok(module, 'The real native availability module must be present');
  const exported = {}, dependency = id => ({
    ...(id === 48697 ? { Xk: (rules, type) => rules.includes(type) } : {}),
    ...(id === 900989 ? { N8: () => false } : {}),
    ...(id === 337174 ? { hj: value => value } : {})
  });
  dependency.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  const factory = vm.runInNewContext('({' + module.source + '})[811656]', { Math: { ...Math, random: () => 1 } });
  factory({}, exported, dependency);
  const unavailable = { type: 'unavailable', limit: { type: 'none' }, upsell: { type: 'none' } };
  const restricted = { type: 'workspace-rule' };
  return exported.jx({ [name]: { type: 'check', workspaceRestrictions: ['workspace-rule'] } },
    { [name]: () => structuredClone(unavailable) }, {
      name, scope: { id: 'synthetic-workspace', billingData: {}, premiumFeatureOverrides: {}, workspaceRestrictions: blocked ? [restricted] : [] },
      data: undefined, actor: {}, supportedProducts: ['free', 'business'],
      environment: { logFunction() {}, trackFunction() {} }
    });
}

test('the real native dashboard gate opens in the isolated client while workspace restrictions and unrelated paid features remain enforced',
  fixtures.length ? {} : { skip: 'Official client fixtures are private and are not distributed.' }, () => {
    for (const { source, name } of fixtures) {
      assert.equal(availability(source, 'dashboard_view').type, 'unavailable', name + ': native baseline');
      const patched = adaptClient(source, name);
      assert.equal(availability(patched, 'dashboard_view').type, 'available', name + ': dashboard remains behind the upgrade gate');
      assert.equal(availability(patched, 'dashboard_view', true).type, 'unavailable', name + ': workspace restriction');
      assert.equal(availability(patched, 'private_teamspaces').type, 'unavailable', name + ': unrelated entitlement');
    }
  });
