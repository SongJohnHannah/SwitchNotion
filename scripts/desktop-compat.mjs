import path from 'node:path';
import vm from 'node:vm';
import { readArchive, sha256 } from './asar.mjs';
import windowsModule from '../src/platform/windows.cjs';
import platformModule from '../src/platform/index.cjs';

export const reviewedBuilds = windowsModule.reviewedBuilds;
export function assertReviewedBuild(version, hash) {
  if (!reviewedBuilds[version] || reviewedBuilds[version] !== hash) throw Error('Unreviewed Notion build.');
}
export function inspectDesktop(original, policy = platformModule.createDesktopPlatform().compatibility) {
  if (!policy.enabled) throw Error('此平台的 Notion 安装校验尚未审核，保留现有运行文件。');
  const reviewed = policy.reviewedBuilds;
  const hash = sha256(original), archive = readArchive(original), pkg = JSON.parse(archive.read('package.json'));
  if (reviewed[pkg.version] && reviewed[pkg.version] !== hash) throw Error('已识别版本的安装文件校验不一致，保留现有原型。');
  if (pkg.name !== 'Notion' || pkg.productName !== 'Notion' || !policy.versionPattern.test(pkg.version || '')) throw Error('Notion 主版本或安装结构已变化，保留现有原型。');
  const main = pkg.main?.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!main || path.posix.isAbsolute(main) || main.split('/').includes('..') || !main.startsWith('.webpack/main')) throw Error('Notion 启动入口已变化，保留现有原型。');
  const entry = [main, main + '.js', main + '/index.js'].find(name => archive.entry(name)?.size && !archive.entry(name).files);
  if (!entry) throw Error('无法识别 Notion 启动入口，保留现有原型。');
  const source = archive.read(entry).toString('utf8');
  // The adapter prepends its own Electron lifecycle hooks; it does not rewrite
  // minified main-process logic. These are the API boundaries that it wraps.
  for (const token of ['"electron"', 'session-created', 'web-contents-created', 'protocol.handle', 'session.fromPartition', 'whenReady', 'notion.com']) {
    if (!source.includes(token)) throw Error('Notion 所需接入点已变化，保留现有原型。');
  }
  if (!policy.electronPattern.test(pkg.devDependencies?.electron || '')) throw Error('Notion Electron 主版本已变化，保留现有原型。');
  new vm.Script(source, { filename: entry });
  return { version: pkg.version, hash, entry, compatibility: reviewed[pkg.version] ? 'reviewed' : 'structural' };
}
