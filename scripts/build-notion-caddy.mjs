import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = { 'win32:x64': ['windows-amd64', 'windows', 'amd64'], 'darwin:arm64': ['darwin-arm64', 'darwin', 'arm64'] };

export function buildNotionCaddy({ platform = process.platform, arch = process.arch, root, run = execFileSync, env = process.env } = {}) {
  const target = targets[platform + ':' + arch];
  if (!target) throw Error('当前只提供 Windows x64 和 Apple Silicon 的 Caddy 构建入口。');
  const state = root || env.NOTION_SWITCH_ROOT || path.join(project, '.notion-switch', ...(platform === 'darwin' ? ['mac-arm64'] : []));
  if (!path.isAbsolute(state)) throw Error('运行资料目录必须是绝对路径。');
  const directory = path.join(state, 'caddy-route', target[0]);
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'caddy'), temporary = path.join(directory, 'caddy-build-' + randomUUID());
  try {
    run('go', ['run', 'github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7', 'build', 'v2.11.7', '--output', temporary,
      '--with', 'github.com/mholt/caddy-l4@v0.1.3'], { cwd: project, stdio: 'inherit', windowsHide: true,
      env: { ...env, GOOS: target[1], GOARCH: target[2], XCADDY_PRINT_VERSION: '0' } });
    if (!fs.statSync(temporary).isFile()) throw Error('Caddy 构建未生成文件。');
    fs.renameSync(temporary, output);
    return output;
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('Caddy 已准备：' + buildNotionCaddy()); }
  catch (error) { console.error('Caddy 构建失败，请确认已安装 Go 并联网；如组件正在使用，请退出 Switch Notion。', error.message); process.exitCode = 1; }
}
