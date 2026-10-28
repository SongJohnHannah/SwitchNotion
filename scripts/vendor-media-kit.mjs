import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Only named public source files are copied. Browser profiles and credentials
// are never inputs to this build step.
const source = path.resolve(process.argv[2] || path.join(os.homedir(), 'media-kit'));
const target = path.resolve(import.meta.dirname, '../src/collection/media-kit');
const requireSource = createRequire(path.join(source, 'package.json'));
const ts = requireSource('typescript');
const files = ['index', 'audio-extract', 'transcribe', 'cdp-client', 'cdp-scrape-tool', 'compressor',
  'domain-utils', 'network-policy', 'resolve-bin', 'safe-path', 'utils', 'videodl-tool', 'ytdlp-tool'];
const manifest = { repository: 'https://github.com/SongJohnHannah/media-kit', version: '1.1.0', license: 'MIT', files: {} };
fs.mkdirSync(target, { recursive: true });
for (const name of files) {
  let text = fs.readFileSync(path.join(source, 'src', name + '.ts'), 'utf8');
  manifest.files[name + '.ts'] = createHash('sha256').update(text).digest('hex');
  if (name === 'index') text = text.replace(/export \{\s*browserCdpUrl,[\s\S]*?from "\.\/playwright-client\.js";/, '');
  // Switch Notion owns compression and transcription, preserving originals.
  if (name === 'compressor') text = 'export async function compressIfNeeded(_files: unknown[]): Promise<void> {}';
  if (name === 'transcribe') text = 'export async function transcribeAudio(): Promise<any> { return {ok:false,error:"Use Switch Notion SpeechProvider"}; }';
  if (name === 'resolve-bin') text = text.replace('const dirs = [...UNIX_TRUSTED, ...(extraDirs ?? [])];',
    'const dirs = [...(process.env.MEDIAKIT_BIN_DIR ? [process.env.MEDIAKIT_BIN_DIR] : []), ...UNIX_TRUSTED, ...(process.env.PATH || "").split(path.delimiter).filter(Boolean), ...(extraDirs ?? [])];');
  if (name === 'cdp-client') {
    text = 'import { randomUUID } from "node:crypto";\n' + text;
    text = text.replace(/const COOKIE_CACHE_FILE[\s\S]*?loadCookieCacheFromDisk\(\);/, '').replace('saveCookieCacheToDisk();', '');
    text = text.replace('const tmpDir = os.tmpdir();', 'const tmpDir = process.env.MEDIAKIT_COOKIE_DIR || os.tmpdir();');
    text = text.replace('const domain = new URL(url).hostname;\n  if (!domain)', 'const domain = browserBaseUrl + "|" + new URL(url).hostname;\n  if (!domain)');
    text = text.replace('`ytdlp-cookies-${safeDomain}.txt`', '`switch-notion-cookies-${safeDomain}-${randomUUID()}.txt`');
    text = text.replace('lines.join("\\n") + "\\n", "utf-8"', 'lines.join("\\n") + "\\n", { encoding: "utf8", mode: 0o600 }');
    text = text.replaceAll(/await closeOrphanedTabs\(browserBaseUrl\);/g, '');
    text = text.replace('await killChromeByUserDataDir(userDataDir);', '// Never kill another browser session while preparing the collector.');
    text = text.replace('cleanChromeProfile(userDataDir);', '// Keep the persistent browser profile intact.');
    text = text.replace('"--password-store=basic",', '');
    text = text.replace(/}\s*else\s*\{\s*\/\/ Linux Chrome in WSL2\/Docker:/, '} else if (process.platform !== "darwin") {\n    // Linux Chrome in WSL2/Docker:');
    text = text.replace('if (reqUrl.includes("byteaudio"))', 'if (/media-audio-|mime_type=audio|\\.m4a(?:\\?|$)/i.test(reqUrl) || reqUrl.includes("byteaudio"))');
    text = text.replaceAll('msg.params?.result?.result?.value', 'msg.result?.result?.value');
    text = text.replace("if (e.name.includes('byteaudio')", "if (e.name.includes('media-audio-') || e.name.includes('mime_type=audio') || e.name.includes('byteaudio')");
  }
  if (name === 'cdp-scrape-tool') text = text.replace(/await closeOrphanedTabs\(browserBaseUrl\);/g, '');
  if (name === 'ytdlp-tool' || name === 'videodl-tool') {
    text = text.replace(/"--no-check-certificates",?\s*/g, '');
    text = text.replace('"--no-warnings",', '"--no-warnings", "--no-playlist",');
    text = text.replace('if (params.cookieFilePath)', 'if (process.env.MEDIAKIT_PROXY_URL) args.push("--proxy", process.env.MEDIAKIT_PROXY_URL);\n  if (params.cookieFilePath)');
    text = text.replace('const YTDLP_TIMEOUT_MS = 300_000;', 'const YTDLP_TIMEOUT_MS = 2_280_000;');
    text = text.replace('"--no-warnings",', '"--no-warnings", "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2", "--concurrent-fragments", "4", "--abort-on-unavailable-fragments",');
    text = text.replace('"--no-warnings",', '"--no-warnings", "--encoding", "utf-8",');
    text = text.replace('"%(title)s.%(ext)s"', '"media.%(ext)s"');
    if (name === 'ytdlp-tool') text = text.replace('let result = await runYtdlp(params);', 'const initialCookie = await getCookiesFile(options?.browserBaseUrl, params.url);\n  let result;\n  try { result = await runYtdlp({ ...params, cookieFilePath: initialCookie || params.cookieFilePath }); }\n  finally { if (initialCookie) try { fs.unlinkSync(initialCookie); } catch {} }');
    if (name === 'videodl-tool') text = text.replace(/else\s*\{\s*try\s*\{\s*fs.unlinkSync\(standaloneAudioPath\);[\s\S]*?standaloneAudioPath = undefined;\s*}/, 'else { return { ok: false, method: "none", files: [], error: "独立音轨合并未完成，已保留原始文件。", durationMs: Date.now() - start }; }');
  }
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replaceAll(/(from\s+["']\.\/[^"']+)\.js(["'])/g, '$1.mjs$2');
  if (name === 'cdp-client' && (/await (?:closeOrphanedTabs|killChromeByUserDataDir)\(/.test(output) || output.includes('--password-store=basic') || !output.includes('process.platform !== "darwin"'))) throw Error('MediaKit browser isolation patches did not match the source.');
  fs.writeFileSync(path.join(target, name + '.mjs'), output);
}
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'NOTICE.md'), '# MediaKit\n\nVendored from [SongJohnHannah/media-kit](https://github.com/SongJohnHannah/media-kit), version 1.1.0, under its declared MIT license. Source hashes are in manifest.json.\n\nSwitch Notion disables automatic compression, legacy ASR, plaintext cookie caching, unrelated-tab cleanup and browser termination. It adds native PATH lookup, per-request cookie files and macOS visible browser support. Regenerate with `node scripts/vendor-media-kit.mjs /path/to/media-kit`.\n');
console.log('Prepared MediaKit runtime: ' + files.length + ' modules.');
