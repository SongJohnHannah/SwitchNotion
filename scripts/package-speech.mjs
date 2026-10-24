import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertDistributionFiles, localDeepSeekKeys } from './package-safety.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = ['src/speech-provider.cjs', 'src/speech-provider.d.cts', 'src/speech/provider.cjs',
  'src/speech/platform.cjs', 'src/speech/discovery.cjs', 'src/speech/wav.cjs',
  'src/speech/worker.py', 'src/speech/faster_backend.py', 'src/speech/requirements.txt',
  'LICENSE', 'THIRD-PARTY-NOTICES.md'];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function stageSpeech({ sourceProject = project, destination }) {
  const parent = path.resolve(sourceProject, 'dist'), target = path.resolve(destination), relative = path.relative(parent, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(target)) throw Error('离线语音打包目标必须是 dist 内的新目录。');
  const sources = [...files, 'docs/SPEECH-INTERFACE.md'].map(file => path.join(sourceProject, file));
  if (sources.some(file => !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw Error('离线语音分发源文件无效。');
  const keys = localDeepSeekKeys(sourceProject); assertDistributionFiles(sourceProject, sources, keys);
  fs.mkdirSync(target, { recursive: true });
  for (const name of files) {
    const output = path.join(target, name); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(sourceProject, name), output);
  }
  fs.copyFileSync(path.join(sourceProject, 'docs/SPEECH-INTERFACE.md'), path.join(target, 'README.md'));
  const version = JSON.parse(fs.readFileSync(path.join(sourceProject, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@notion-switch/offline-speech', version,
    private: true, license: 'MIT', type: 'commonjs', main: './src/speech-provider.cjs', types: './src/speech-provider.d.cts',
    exports: { '.': { types: './src/speech-provider.d.cts', require: './src/speech-provider.cjs', default: './src/speech-provider.cjs' } },
    engines: { node: '>=22' } }, null, 2) + '\n');
  const manifestFiles = [...files, 'README.md', 'package.json'];
  assertDistributionFiles(target, manifestFiles.map(file => path.join(target, file)), keys);
  const manifest = { version, platforms: ['win32-x64-cuda', 'darwin-arm64-cpu'],
    hardwareVerified: ['win32-x64-cuda'],
    includesModels: false, includesRuntime: false, includesUserData: false, includesNotion: false,
    files: manifestFiles.map(file => ({ file, sha256: hash(path.join(target, file)) })) };
  fs.writeFileSync(path.join(target, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { directory: target, fileCount: manifestFiles.length + 1, ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key.startsWith('includes'))) };
}

export function packageSpeech() {
  fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
  const destination = path.join(project, 'dist', 'NotionSwitch-speech-' + Date.now());
  return stageSpeech({ destination });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packageSpeech(), null, 2));
