import fs from './native-fs.mjs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function notionDirectory(candidate, root) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) return null;
  const dir = path.resolve(/\.exe$/i.test(candidate) ? path.dirname(candidate) : candidate), relative = path.relative(path.resolve(root), dir);
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) return null;
  try {
    if (fs.statSync(path.join(dir, 'Notion.exe')).isFile() && fs.statSync(path.join(dir, 'resources', 'app.asar')).isFile()) return dir;
  } catch {}
  return null;
}
function registryLocations() {
  if (process.platform !== 'win32') return [];
  const script = "$keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notion','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notion','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notion');$values=@(foreach($key in $keys){$p=Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue;if($p.InstallLocation){$p.InstallLocation};if($p.DisplayIcon){$p.DisplayIcon -replace ',[-0-9]+$','' -replace '^\"|\"$',''}});ConvertTo-Json -InputObject $values -Compress";
  try { const found = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 32768 })); return Array.isArray(found) ? found : []; } catch { return []; }
}
export function findNotion(root, { env = process.env, home = os.homedir(), registry = registryLocations } = {}) {
  const candidates = [json(path.join(root, 'installation.local.json'))?.source,
    path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Notion'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Notion'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Notion'), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Notion'),
    json(path.join(root, 'prepared.json'))?.source];
  for (const candidate of candidates) { const found = notionDirectory(candidate, root); if (found) return found; }
  for (const candidate of registry()) { const found = notionDirectory(candidate, root); if (found) return found; }
  return null;
}
