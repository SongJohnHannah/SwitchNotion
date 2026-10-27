// Developer-only build. The desktop bundles the result, never npm or source caches.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..'), build = path.join(root, 'research/compat-build');
const require = createRequire(path.join(build, 'package.json'));
const expected = { acorn: '8.16.0', 'eslint-scope': '8.4.0', esrecurse: '4.3.0', estraverse: '5.3.0', esbuild: '0.25.12' };
for (const [name, version] of Object.entries(expected)) {
  if (JSON.parse(fs.readFileSync(path.join(build, 'node_modules', name, 'package.json'))).version !== version) throw Error('Unpinned build dependency');
}
const directory = path.join(root, 'src/compat'); fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'parser.cjs');
require('esbuild').buildSync({ stdin: { contents: 'exports.parse=require("acorn").parse;exports.analyze=require("eslint-scope").analyze;', resolveDir: build },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none', outfile: output });
const notices = ['Vendored JavaScript syntax and scope analyzer. Built with scripts/build-compat-parser.mjs.', ''];
for (const name of ['acorn', 'eslint-scope', 'esrecurse', 'estraverse']) {
  const packageRoot = path.join(build, 'node_modules', name), pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  const license = ['LICENSE', 'LICENSE.BSD', 'LICENSE.txt'].find(file => fs.existsSync(path.join(packageRoot, file)));
  const text = license ? fs.readFileSync(path.join(packageRoot, license), 'utf8') : name === 'esrecurse'
    ? fs.readFileSync(path.join(packageRoot, 'esrecurse.js'), 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0] : null;
  if (!text) throw Error('Missing third-party license: ' + name);
  notices.push(name + ' ' + pkg.version, text, '');
}
fs.writeFileSync(path.join(directory, 'VENDOR-LICENSES.txt'), notices.join('\n').trimEnd() + '\n');
console.log(JSON.stringify({ bytes: fs.statSync(output).size, sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex') }));
