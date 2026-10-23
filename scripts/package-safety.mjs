import fs from 'node:fs';
import path from 'node:path';
const blocked = '迁移包发现本地凭据或私人配置，已停止打包。';

export function localDeepSeekKeys(project, env = process.env) {
  const root = path.resolve(project, '.notion-switch'), files = [path.join(root, 'deepseek-api-key.txt')];
  const config = path.join(root, 'provider.local.json');
  if (fs.existsSync(config)) {
    const file = JSON.parse(fs.readFileSync(config, 'utf8')).apiKeyFile;
    if (file) {
      const resolved = path.resolve(root, file), relative = path.relative(root, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error(blocked);
      files.push(resolved);
    }
  }
  return [...new Set([env.DEEPSEEK_API_KEY, ...files.filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8'))].filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
}

export function assertDistributionFiles(root, files, keys = []) {
  const needles = keys.flatMap(key => [Buffer.from(key, 'utf8'), Buffer.from(key, 'utf16le')]);
  for (const file of files) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error(blocked);
    const parts = relative.split(path.sep);
    if (parts.some(part => /^(?:\.notion-switch|profile|research|tests|\.env(?:\..*)?|.*\.local\.json|.*api[-_]?key.*\.(?:txt|json)|cookies(?:-journal)?|local state)$/i.test(part))) throw Error(blocked);
    const bytes = fs.readFileSync(file);
    if (needles.some(key => bytes.includes(key)) || /\b(?:sk-|ntn_|secret_)[A-Za-z0-9_-]{20,}/.test(bytes.toString('latin1'))) throw Error(blocked);
  }
}
