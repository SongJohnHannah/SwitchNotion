const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function supportsArm64(bytes) {
  if (bytes.length < 8) return false;
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === 0x0100000c;
  const magic = bytes.readUInt32BE(0), count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : magic === 0xcafebabf ? 32 : 0;
  if (!stride || count > 32 || 8 + count * stride > bytes.length) return false;
  for (let index = 0; index < count; index++) if (bytes.readUInt32BE(8 + index * stride) === 0x0100000c) return true;
  return false;
}

function headerHash(bytes) {
  const length = bytes.readUInt32LE(12);
  if (!length || length > 16 * 1024 * 1024 || length + 16 > bytes.length) throw Error('Mac ASAR 头部格式无效。');
  return createHash('sha256').update(bytes.subarray(16, 16 + length)).digest('hex');
}
function validateBundleLinks(root, fsImpl = fs) {
  const realRoot = fsImpl.realpathSync(root);
  function visit(directory) {
    for (const item of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        const resolved = fsImpl.realpathSync(file), relative = path.relative(realRoot, resolved);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Mac 应用包包含指向外部的链接，未复制。');
      } else if (item.isDirectory()) visit(file);
    }
  }
  visit(root);
}
function createMacRuntime({ execFileSync, fsImpl = fs }) {
  const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const plist = (file, args) => run('/usr/bin/plutil', [...args, file]);
  function readPlist(file) { return JSON.parse(plist(file, ['-convert', 'json', '-o', '-'])); }
  return {
    stageInstallation({ source, target }) {
      if (fsImpl.existsSync(target.appRoot)) throw Error('Mac 应用暂存位置已经存在。');
      if (!supportsArm64(fsImpl.readFileSync(source.executable))) throw Error('请选择支持 Apple Silicon 的官方 Notion，不能使用 Intel 专用客户端。');
      // Check the installed source before modifying the independent copy.
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source.appRoot]);
      const sourceInfo = readPlist(path.join(source.appRoot, 'Contents', 'Info.plist'));
      if (sourceInfo.CFBundleIdentifier !== 'notion.id' || sourceInfo.ElectronTeamID !== 'LBQJ96FQ8D') throw Error('选择的应用不是已识别的官方 Notion。');
      // Verify the signing authority rather than trusting Info.plist alone.
      run('/usr/bin/codesign', ['--verify', '-R', 'anchor apple generic and certificate leaf[subject.OU] = "LBQJ96FQ8D"', source.appRoot]);
      const expected = sourceInfo.ElectronAsarIntegrity?.['Resources/app.asar'];
      if (expected && (expected.algorithm !== 'SHA256' || expected.hash !== headerHash(fsImpl.readFileSync(source.archive)))) throw Error('官方 Mac Notion ASAR 完整性检查失败。');
      validateBundleLinks(source.appRoot, fsImpl);
      fsImpl.mkdirSync(path.dirname(target.appRoot), { recursive: true });
      run('/usr/bin/ditto', [source.appRoot, target.appRoot]);
      validateBundleLinks(target.appRoot, fsImpl);
    },
    finalizeRuntime(layout) {
      const file = path.join(layout.appRoot, 'Contents', 'Info.plist');
      const info = readPlist(file);
      const set = (key, value) => plist(file, [Object.hasOwn(info, key) ? '-replace' : '-insert', key, '-string', value]);
      set('CFBundleDisplayName', 'Switch Notion'); set('CFBundleName', 'Switch Notion');
      set('CFBundleIdentifier', 'com.notionswitch.desktop');
      for (const key of ['CFBundleURLTypes', 'CFBundleDocumentTypes', 'ElectronTeamID']) if (Object.hasOwn(info, key)) plist(file, ['-remove', key]);
      // Preserve Electron integrity validation; update its expected header hash.
      plist(file, [Object.hasOwn(info, 'ElectronAsarIntegrity') ? '-replace' : '-insert', 'ElectronAsarIntegrity', '-json', JSON.stringify({ 'Resources/app.asar': { algorithm: 'SHA256', hash: headerHash(fsImpl.readFileSync(layout.archive)) } })]);
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', layout.appRoot]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', layout.appRoot]);
    }
  };
}
module.exports = { createMacRuntime, validateBundleLinks, headerHash, supportsArm64 };
