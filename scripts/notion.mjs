import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { stateRoot } from './prepare-desktop.mjs';
const { NotionWorkspace } = createRequire(import.meta.url)('../src/notion-tools.cjs');
const { NotionRouter, registerConnection, consolidateConnections, registryName } = createRequire(import.meta.url)('../src/notion-routing.cjs');
fs.mkdirSync(stateRoot, { recursive: true });
const action = process.argv[2] || 'status';
const workspace = new NotionWorkspace({ root: stateRoot });
if (action === 'status') console.log(JSON.stringify(new NotionRouter({ root: stateRoot }).status(), null, 2));
else if (action === 'check') {
  const router = new NotionRouter({ root: stateRoot });
  const session = await router.open({ signal: AbortSignal.timeout(60000) });
  console.log(JSON.stringify(await session.execute('list_workspaces'), null, 2));
} else if (action === 'connect') {
  if (!fs.existsSync(path.join(stateRoot, registryName)) && workspace.config().key) {
    await consolidateConnections({ root: stateRoot });
  }
  let options;
  if (process.argv[3]) options = { apiKeyFile: process.argv[3] };
  else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('请在本机交互终端运行 connect，或直接编辑 notion-connections.local.json；不要通过命令行参数传递密钥。');
    console.log('添加工作区：粘贴连接密钥并回车（不回显），按 Ctrl+C 取消。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
    rl._writeToOutput = () => {};
    try { options = { apiKey: await new Promise((resolve, reject) => { rl.once('SIGINT', () => reject(Error('已取消添加。'))); rl.question('', resolve); }) }; }
    finally { rl.close(); process.stdout.write('\n'); }
  }
  console.log(JSON.stringify(await registerConnection({ root: stateRoot, ...options }), null, 2));
} else if (action === 'migrate') console.log(JSON.stringify(await consolidateConnections({ root: stateRoot }), null, 2));
else throw Error('Usage: npm run notion -- [status|check|connect|migrate]');
