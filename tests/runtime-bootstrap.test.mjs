import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import platformModule from '../src/platform/index.cjs';

const require = createRequire(import.meta.url), sourceRoot = path.resolve('src');
const { disableBuiltinUpdates } = require('../src/runtime-bootstrap.cjs');
function fixture(t, id = 'win32') {
  const parent = path.resolve('.notion-switch'), project = fs.mkdtempSync(path.join(parent, 'test-bootstrap-'));
  t.after(() => { assert.equal(path.dirname(project), parent); fs.rmSync(project, { recursive: true, force: true }); });
  const root = path.join(project, '.notion-switch');
  const platform = platformModule.createDesktopPlatform({ id, arch: 'arm64' });
  const resourcesPath = platform.runtimeLayout(path.join(root, 'runtime')).resources;
  fs.mkdirSync(resourcesPath, { recursive: true }); fs.mkdirSync(path.join(project, 'scripts'));
  fs.writeFileSync(path.join(project, 'scripts/open-notion.mjs'), '// fixture root launch flow');
  fs.writeFileSync(path.join(root, 'prepared.json'), JSON.stringify({ platform: id, runtime: path.join(root, 'runtime') }));
  const node = id === 'darwin' ? path.join(project, 'node') : process.execPath;
  if (id === 'darwin') fs.writeFileSync(node, 'fixture ARM64 Node');
  fs.writeFileSync(path.join(root, 'launcher.local.json'), JSON.stringify({ nodeExecutable: node, projectDirectory: project }));
  return { root, project, platform, resourcesPath, node };
}
function runHook(f, env = {}) {
  const spawned = [], exits = [], dialogs = [], cache = new Map();
  const electron = { app: { exit: code => exits.push(code) }, dialog: { showErrorBox: (...args) => dialogs.push(args) } };
  const childProcess = { spawn: (...args) => { spawned.push(args); return { pid: 12345, on() {}, unref() {} }; } };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const localRequire = name => {
      if (name === 'electron') return electron;
      if (name === 'node:child_process') return childProcess;
      if (name === './platform/index.cjs') return { createDesktopPlatform: () => f.platform };
      if (name === './runtime-bootstrap.cjs') return load(path.join(sourceRoot, 'runtime-bootstrap.cjs'));
      if (name.startsWith('.')) return {};
      return require(name);
    };
    const wrapper = vm.runInNewContext('(function(exports,require,module,__filename,__dirname){\n' + fs.readFileSync(file, 'utf8') + '\n})', { process: { env, resourcesPath: f.resourcesPath } }, { filename: file });
    wrapper(module.exports, localRequire, module, file, path.dirname(file)); return module.exports;
  }
  load(path.join(sourceRoot, 'desktop-hook.cjs'));
  return { spawned, exits, dialogs };
}

for (const id of ['win32', 'darwin']) test(`a directly opened ${id} runtime returns to the project launch flow without the npm-start exception`, t => {
  const f = fixture(t, id); let result;
  assert.doesNotThrow(() => { result = runHook(f); });
  assert.equal(result.spawned.length, 1);
  const [node, args, options] = result.spawned[0];
  assert.equal(node, f.node); assert.deepEqual(Array.from(args), [path.join(f.project, 'scripts/open-notion.mjs')]);
  assert.equal(options.cwd, f.project); assert.equal(options.env.NOTION_SWITCH_ROOT, f.root);
  assert.deepEqual(result.exits, [0]); assert.equal(result.dialogs.length, 0);
});

test('a runtime with missing launch metadata gives root-directory instructions and exits without continuing official startup', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, 'launcher.local.json'));
  const result = runHook(f);
  assert.equal(result.spawned.length, 0); assert.deepEqual(result.exits, [1]);
  assert.match(result.dialogs[0][1], /项目根目录.*Switch Notion/);
});

test('only the isolated profile disables its built-in updater and all other saved state is preserved', t => {
  const f = fixture(t), profile = path.join(f.root, 'profile'); fs.mkdirSync(profile);
  const file = path.join(profile, 'state.json');
  const state = { appState: { preferences: { isAutoUpdaterDisabled: false, fixturePreference: 'keep' }, fixtureTabs: ['keep'] }, history: ['keep'] };
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(disableBuiltinUpdates(f.root), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...state, appState: { ...state.appState, preferences: { ...state.appState.preferences, isAutoUpdaterDisabled: true } } });
  assert.equal(disableBuiltinUpdates(f.root), false);
  fs.writeFileSync(file, '{incomplete state');
  assert.equal(disableBuiltinUpdates(f.root), false); assert.equal(fs.readFileSync(file, 'utf8'), '{incomplete state');
  fs.unlinkSync(file); assert.equal(disableBuiltinUpdates(f.root), false); assert.equal(fs.existsSync(file), false);
});
