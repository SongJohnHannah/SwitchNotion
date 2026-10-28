import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localDeepSeekKeys } from './package-safety.mjs';

export function checkStagedSecrets(root = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const keys = localDeepSeekKeys(root), state = path.join(root, '.notion-switch');
  for (const name of ['notion-connections.local.json', 'notion.local.json']) {
    const file = path.join(state, name);
    if (!fs.existsSync(file)) continue;
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('本机凭据配置无法检查，未提交。'); }
    const visit = item => {
      if (!item || typeof item !== 'object') return;
      for (const [field, text] of Object.entries(item)) {
        if (/^(?:apiKey|accessToken|token)$/i.test(field) && typeof text === 'string' && text.trim()) keys.push(text.trim());
        else if (text && typeof text === 'object') visit(text);
      }
    }; visit(value);
  }
  if (process.env.NOTION_API_KEY?.trim()) keys.push(process.env.NOTION_API_KEY.trim());
  const needles = [...new Set(keys)].flatMap(key => [Buffer.from(key), Buffer.from(key, 'utf16le')]);
  const files = git(['ls-files', '--cached', '-z']).toString('utf8').split('\0').filter(Boolean), blocked = [];
  for (const file of files) {
    // Root dist is a private build output. Reviewed vendored libraries also
    // have nested dist source folders; their bytes still receive every scan.
    const privatePath = file.split('/')[0].toLowerCase() === 'dist' || file.split('/').some(part => /^(?:\.notion-switch|research|node_modules|profiles?|user data|indexeddb|session storage|local storage|\.env(?:\..*)?|.*\.local\.json|.*api[-_]?key.*\.(?:txt|json)|.*\.(?:pem|key|p12|pfx)|cookies(?:-(?:journal|wal|shm))?|(?:login|web) data(?:-(?:journal|wal|shm))?|local state)$/i.test(part)) ||
      /\.(?:wav|mp3|m4a|aac|ogg|opus|flac|aiff?|caf|pcm|webm|mp4|m4v|mov|mkv|(?:sqlite3?|db)(?:-(?:wal|shm|journal))?)$/i.test(file);
    const bytes = git(['cat-file', 'blob', ':' + file]);
    const signature = bytes.subarray(0, 16).toString('latin1');
    const privateBinary = signature.startsWith('SQLite format 3\0') || signature.startsWith('fLaC') || signature.startsWith('OggS') ||
      signature.startsWith('ID3') || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ||
      signature.startsWith('RIFF') && signature.slice(8, 12) === 'WAVE' || signature.startsWith('FORM') && /^(?:AIFF|AIFC)$/.test(signature.slice(8, 12));
    if (privatePath || privateBinary || needles.some(key => bytes.includes(key)) || /\b(?:sk-|ntn_|secret_)[A-Za-z0-9_-]{20,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(bytes.toString('latin1'))) blocked.push(file);
  }
  if (blocked.length) throw Error('暂存区包含凭据或私人文件，已停止提交。问题文件数：' + blocked.length + '（不显示密钥内容）。');
  return { checkedFiles: files.length, credentialsFound: false, privateFilesFound: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkStagedSecrets())); }
  catch { console.error('暂存区敏感信息检查未通过，未提交；不会显示密钥内容。'); process.exitCode = 1; }
}
