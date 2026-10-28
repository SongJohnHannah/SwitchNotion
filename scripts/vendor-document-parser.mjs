// Reproducible source/data vendoring; no npm install or package hooks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/vendor');
const dependencies = [
  { name: 'xmlchars', version: '2.2.0', license: 'MIT', integrity: 'sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==', include: name => /\.js$/.test(name) },
  { name: 'saxes', version: '6.0.0', license: 'ISC', integrity: 'sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==', include: name => name === 'saxes.js' },
  { name: 'unpdf', version: '1.9.1', license: 'MIT', integrity: 'sha512-nO1npM2kNyd4hj1fKzUVU6bvnWjDSxI97eycM/DgzI83dYyW+pNRI9NeMQVEfef8fI3Q06i9lkMeE1HxrQqKoA==', include: name => name === 'dist/pdfjs.mjs' },
  { name: 'pdfjs-dist', version: '6.4.299', license: 'Apache-2.0', integrity: 'sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==', include: name => name.startsWith('cmaps/') || name.startsWith('standard_fonts/') }
];
async function bytes(url, limit) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('Registry HTTP ' + response.status);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > limit) throw Error('Registry response too large'); chunks.push(chunk); }
  return Buffer.concat(chunks, length);
}
const manifest = [];
for (const item of dependencies) {
  const metadata = JSON.parse((await bytes('https://registry.npmjs.org/' + item.name + '/' + item.version, 200000)).toString('utf8'));
  const url = 'https://registry.npmjs.org/' + item.name + '/-/' + item.name + '-' + item.version + '.tgz';
  if (metadata.name !== item.name || metadata.version !== item.version || metadata.license !== item.license || metadata.dist.tarball !== url || metadata.dist.integrity !== item.integrity) throw Error('Unexpected package metadata');
  const archive = await bytes(url, 16 * 1024 * 1024);
  if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== item.integrity) throw Error('Package integrity mismatch');
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }), files = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100), prefix = field(345, 500), kind = field(156, 157), size = parseInt(field(124, 136).trim() || '0', 8), full = prefix ? prefix + '/' + name : name;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || !full.startsWith('package/') || full.includes('\\') || full.split('/').includes('..') || !['', '0', '5'].includes(kind)) throw Error('Unsupported archive entry');
    const relative = full.slice(8);
    if (kind !== '5' && (relative === 'package.json' || /^(LICENSE|NOTICE)(?:[._-].*)?$/.test(relative) || item.include(relative)) && !relative.endsWith('.map')) {
      const output = path.resolve(destination, item.name, relative), root = path.join(destination, item.name);
      if (!output.startsWith(root + path.sep)) throw Error('Archive path escaped');
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, tar.subarray(offset + 512, offset + 512 + size)); files.push(relative);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  let supplementalLicense;
  // The published saxes tarball omits its license. Preserve the complete file
  // from the matching upstream tag, including the inherited sax notices.
  if (item.name === 'saxes') {
    const url = 'https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE', expected = '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e';
    const license = await bytes(url, 20000);
    if (createHash('sha256').update(license).digest('hex') !== expected) throw Error('Supplemental license integrity mismatch');
    fs.writeFileSync(path.join(destination, item.name, 'LICENSE'), license); files.push('LICENSE'); supplementalLicense = { url, sha256: expected };
  }
  if (!files.some(file => /^LICENSE(?:[._-].*)?$/.test(file)) || !files.includes('package.json')) throw Error('Package license missing: ' + item.name);
  if (item.name === 'saxes') {
    const file = path.join(destination, item.name, 'saxes.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/require\("xmlchars\//g, 'require("../xmlchars/'));
  }
  manifest.push({ name: item.name, version: item.version, license: item.license, url, integrity: item.integrity, modifiedRequires: item.name === 'saxes', ...(supplementalLicense ? { supplementalLicense } : {}),
    files: files.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(destination, item.name, file))).digest('hex') })) });
}
fs.writeFileSync(path.join(destination, 'document-parser.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.map(({ name, version, files }) => ({ name, version, files: files.length }))));
