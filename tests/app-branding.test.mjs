import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { appImage, icons, installAppBranding } = createRequire(import.meta.url)('../src/app-branding.cjs');
const { createDesktopPlatform } = createRequire(import.meta.url)('../src/platform/index.cjs');

test('startup and window details use a fresh branded taskbar identity instead of the cached prototype group', () => {
  const app = new EventEmitter(), processIds = [];
  app.whenReady = async () => {};
  app.setAppUserModelId = id => processIds.push(id);
  createDesktopPlatform({ id: 'win32' }).configureAppIdentity(app);
  assert.deepEqual(processIds, ['com.switchnotion.desktop.bear'], 'Identity must be set before native startup can create a taskbar group');
  app.setAppUserModelId('notion.id');
  assert.equal(processIds.at(-1), 'com.switchnotion.desktop.bear', 'Later native identity updates must preserve the branded group');
  const electron = { app, nativeImage: { createFromPath: file => ({ file }) } };
  installAppBranding(electron, { platform: 'win32' });
  for (const [title, expected] of [['工作区', 'com.switchnotion.desktop.bear'], ['NotionSwitch 配置', 'com.switchnotion.desktop.bear.settings']]) {
    const window = new EventEmitter(); window.getTitle = () => title;
    window.setAppDetails = details => { window.details = details; };
    app.emit('browser-window-created', {}, window);
    assert.equal(window.details.appId, expected);
    window.setAppDetails({ appId: 'notion.switch.prototype' });
    assert.equal(window.details.appId, expected);
  }
});

test('both native and configuration trays retain their distinct personal icons after upstream icon updates', async () => {
  const app = new EventEmitter(), dock = [];
  app.whenReady = async () => {}; app.dock = { setIcon: image => dock.push(image) };
  const nativeImage = { createFromPath: file => ({ file, resize: size => ({ file, size }) }) };
  class Tray { constructor(image) { this.image = image; } setImage(image) { this.image = image; } }
  const electron = { app, nativeImage, Tray };
  installAppBranding(electron, { platform: 'win32', project: 'D:\\Switch Notion' });
  const main = new electron.Tray('upstream-notion.ico');
  assert.equal(main.image.file, icons.main);
  main.setImage('upstream-notion-hover.ico');
  assert.equal(main.image.file, icons.main);
  const configuration = new electron.Tray(appImage(nativeImage, 'settings', 32));
  assert.equal(configuration.image.file, icons.settings);
  configuration.setImage(appImage(nativeImage, 'settings', 18));
  assert.equal(configuration.image.file, icons.settings);
  const current = electron.Tray; installAppBranding(electron); assert.equal(electron.Tray, current);
  for (const [title, expected] of [['工作区', icons.main], ['NotionSwitch 配置', icons.settings]]) {
    const window = new EventEmitter(); window.getTitle = () => title; window.isDestroyed = () => false;
    window.setIcon = image => { window.image = image; };
    window.setAppDetails = details => { window.taskbar = details; };
    app.emit('browser-window-created', {}, window); assert.equal(window.image.file, expected);
    assert.equal(window.taskbar.appIconPath, expected.replace(/\.png$/, '.ico'));
    assert.ok(window.taskbar.relaunchCommand.endsWith('.exe"'));
    window.setAppDetails({ appIconPath: 'upstream-notion.ico', appId: 'notion.id' });
    assert.equal(window.taskbar.appIconPath, expected.replace(/\.png$/, '.ico'));
    window.image = null; window.emit('ready-to-show'); assert.equal(window.image.file, expected);
  }
  await Promise.resolve(); assert.equal(dock[0].file, icons.main);
});

test('personal icon exports contain Windows multi-size PNG frames and Mac retina frames from the approved assets', () => {
  for (const base of ['notion', 'notion-settings']) {
    const ico = fs.readFileSync(new URL('../assets/' + base + '.ico', import.meta.url));
    assert.equal(ico.readUInt16LE(2), 1);
    const sizes = [];
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const at = 6 + 16 * i, size = ico[at] || 256, start = ico.readUInt32LE(at + 12), length = ico.readUInt32LE(at + 8);
      sizes.push(size); assert.ok(start + length <= ico.length);
      assert.equal(ico.toString('ascii', start + 1, start + 4), 'PNG');
      assert.equal(ico.readUInt32BE(start + 16), size); assert.equal(ico[start + 25], 6, 'PNG must retain alpha');
    }
    assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
    const icns = fs.readFileSync(new URL('../assets/' + base + '.icns', import.meta.url)), types = [];
    assert.equal(icns.toString('ascii', 0, 4), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
    for (let at = 8; at < icns.length;) {
      types.push(icns.toString('ascii', at, at + 4)); const length = icns.readUInt32BE(at + 4);
      assert.ok(length >= 8 && at + length <= icns.length); at += length;
    }
    assert.ok(types.includes('ic10')); assert.ok(types.includes('ic13'));
  }
});

test('the native non-configurable Electron Tray getter is preserved while subsequent imports use the branded constructor', () => {
  const app = new EventEmitter(); app.whenReady = async () => {};
  const nativeImage = { createFromPath: file => ({ file, resize: () => ({ file }) }) };
  class Tray { constructor(image) { this.image = image; } setImage(image) { this.image = image; } }
  const electron = { app, nativeImage };
  Object.defineProperty(electron, 'Tray', { configurable: false, get: () => Tray });
  const moduleLoader = { _load: name => 'original:' + name };
  const brandedElectron = installAppBranding(electron, { moduleLoader, platform: 'win32' });
  assert.equal(electron.Tray, Tray); assert.equal(brandedElectron.app, app);
  assert.equal(moduleLoader._load('electron'), brandedElectron);
  assert.equal(moduleLoader._load('electron/main'), brandedElectron);
  assert.equal(moduleLoader._load('node:fs'), 'original:node:fs');
  const imported = moduleLoader._load('electron');
  assert.equal(new imported.Tray('upstream.ico').image.file, icons.main);
  assert.equal(new brandedElectron.Tray(appImage(nativeImage, 'settings')).image.file, icons.settings);
});

test('Mac keeps its native tray and applies the personal Dock icon without Windows taskbar changes', async () => {
  const app = new EventEmitter(), dock = []; app.whenReady = async () => {}; app.dock = { setIcon: image => dock.push(image) };
  const nativeImage = { createFromPath: file => ({ file, resize: () => ({ file }) }) };
  class Tray {}
  const electron = { app, nativeImage, Tray };
  installAppBranding(electron, { platform: 'darwin' }); assert.equal(electron.Tray, Tray);
  const window = new EventEmitter(); window.setIcon = () => {}; window.setAppDetails = () => assert.fail('Windows taskbar API on Mac');
  app.emit('browser-window-created', {}, window);
  await Promise.resolve(); assert.equal(dock[0].file, icons.main);
});
