// Reproducible source-only vendoring. No package install hooks are executed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination = path.join(project, 'src/vendor');
const dependencies = [
  { name: 'entities', version: '4.5.0', license: 'BSD-2-Clause', directories: ['lib/'], integrity: 'sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==' },
  { name: 'parse5', version: '7.2.1', license: 'MIT', directories: ['dist/cjs/'], integrity: 'sha512-BuBYQYlv1ckiPdQi/ohiivi9Sagc9JG+Ozs0r7b/0iK3sKmrb0b9FdWdBbOdx6hBCM/F9Ir82ofnBhtZOjCRPQ==' }
];
async function bytes(url, limit) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('Registry HTTP ' + response.status);
  const parts = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > limit) throw Error('Registry response too large'); parts.push(chunk); }
  return Buffer.concat(parts);
}
const manifest = [];
for (const item of dependencies) {
  const metadata = JSON.parse((await bytes('https://registry.npmjs.org/' + item.name + '/' + item.version, 200000)).toString('utf8'));
  const expectedUrl = 'https://registry.npmjs.org/' + item.name + '/-/' + item.name + '-' + item.version + '.tgz';
  if (metadata.name !== item.name || metadata.version !== item.version || metadata.license !== item.license || metadata.dist.tarball !== expectedUrl || !/^sha512-[\w+/]+=*$/.test(metadata.dist.integrity)) throw Error('Unexpected package metadata');
  const archive = await bytes(expectedUrl, 4 * 1024 * 1024), integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  if (integrity !== metadata.dist.integrity || integrity !== item.integrity) throw Error('Package integrity mismatch');
  const tar = gunzipSync(archive, { maxOutputLength: 20 * 1024 * 1024 }), files = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100), prefix = field(345, 500), kind = field(156, 157), size = parseInt(field(124, 136).trim() || '0', 8);
    const full = prefix ? prefix + '/' + name : name;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || !full.startsWith('package/') || full.includes('\\') || full.split('/').includes('..') || !['', '0', '5'].includes(kind)) throw Error('Unsupported archive entry');
    const relative = full.slice('package/'.length);
    if (kind !== '5' && (['package.json', 'LICENSE'].includes(relative) || item.directories.some(dir => relative.startsWith(dir))) && !relative.startsWith('lib/esm/') && !relative.endsWith('.map') && !relative.endsWith('.d.ts')) {
      const output = path.resolve(destination, item.name, relative), root = path.resolve(destination, item.name);
      if (!output.startsWith(root + path.sep)) throw Error('Archive path escaped');
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, tar.subarray(offset + 512, offset + 512 + size)); files.push(relative);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.includes('LICENSE') || !files.includes('package.json')) throw Error('Package license missing');
  if (item.name === 'parse5') for (const relative of files.filter(name => name.endsWith('.js'))) {
    const file = path.join(destination, item.name, relative), source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, source.replace(/require\("entities([^"\n]*)"\)/g, (_, subpath) => {
      const target = path.join(destination, 'entities', subpath), link = path.relative(path.dirname(file), target).split(path.sep).join('/');
      return 'require(' + JSON.stringify(link.startsWith('.') ? link : './' + link) + ')';
    }));
  }
  manifest.push({ name: item.name, version: item.version, license: item.license, url: expectedUrl, integrity,
    modifiedRequires: item.name === 'parse5', files: files.map(relative => ({ file: relative, sha256: createHash('sha256').update(fs.readFileSync(path.join(destination, item.name, relative))).digest('hex') })) });
}
fs.writeFileSync(path.join(destination, 'web-parser.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.map(({ name, version, files }) => ({ name, version, files: files.length }))));
