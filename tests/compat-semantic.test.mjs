import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from '../src/compat/semantic.cjs';
const hash = body => inspect('123(module,exports,require){' + body + '}').fingerprint;

test('automatic compatibility accepts only syntax-preserving binding renames and formatting', () => {
  assert.equal(hash('const x=1;function f(y){return x+y}exports.value=f(2);'),
    hash('const a = 1; /* repacked */ function b(c) { return a + c; } exports.value = b(2);'));
  assert.equal(hash('let x=1;{let x=2;exports.value=x}exports.other=x'), hash('let a=1;{let b=2;exports.value=b}exports.other=a'));
  assert.equal(hash('function f({id:x}){return x}exports.value=f({id:1});'), hash('function g({id:y}) { return y; } exports.value=g({id:1});'));
});

test('changed permissions, literals, properties, globals and variable capture are incompatible', () => {
  for (const [before, after] of [
    ['exports.allowed=state.permission!==false', 'exports.allowed=true'],
    ['exports.deadline=12000', 'exports.deadline=120000'],
    ['exports.value=state.allowed', 'exports.value=state.admin'],
    ['exports.value=Promise.resolve(1)', 'exports.value=Other.resolve(1)'],
    ['let x=1;function f(y){return x}exports.value=f(2)', 'let a=1;function b(a){return a}exports.value=b(2)'],
    ['let x=1;exports.value={x}', 'let y=1;exports.value={y}']
  ]) assert.notEqual(hash(before), hash(after));
  assert.throws(() => hash('with(obj){exports.value=x}'));
  assert.throws(() => hash('eval("code")'));
});

test('automatic analysis has bounded inputs and does not run inspected code', () => {
  assert.throws(() => inspect('x'.repeat(512 * 1024 + 1)));
  assert.doesNotThrow(() => hash('throw Error("must not execute");'));
});
