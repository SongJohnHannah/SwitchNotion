const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { McpClient } = require('./mcp-client.cjs');
const REVISION = '0017d5119b53580c7b5277c00ed41d7f76733027';
const FILES = { 'server.py': '7ccc9d6672b10f3af1f367ce1f7e90db982c7e97', 'core.py': '792e26534ad80568dda056df04ae14a4db2af381' };
const MAC_FILES = { 'macos_ocr.py': '9a653b5d17660a022e3dad01ae9aa2046a7b56c6', 'macos_ocr_protocol.py': 'ca602dc08b91f451082c77d30f79e330cfbd5db6', 'macos_ocr_worker.py': '1ce5d88d10bb3aabe58a9d15bb86b5eebcb5003a', 'engine/macos/manifest.json': 'ebb2a868bba16ca13f0db78114615997bc7c8d49', 'scripts/verify_macos_engine.py': 'b327fccf48081dd811945eee52b0700901510cb8' };
const fail = message => { throw Error('Notion 附件 OCR mediaocr ' + message); };
function layout(root, platform = process.platform, arch = process.arch) {
  const directory = path.resolve(root, 'mediaocr', REVISION, platform + '-' + arch);
  return { directory, source: path.join(directory, 'source'), python: path.join(directory, 'venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'])), ready: path.join(directory, 'ready.json') };
}
function verifySource(source, platform = process.platform) {
  for (const [name, expected] of Object.entries({ ...FILES, ...(platform === 'darwin' ? MAC_FILES : { 'wcocr.pyd': 'b727773914c4b2a7563069096387e524d1613dbc' }) })) {
    const file = path.join(source, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 ** 2) fail('源码或调用模块无效，请重新准备。');
    const bytes = fs.readFileSync(file), actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    if (actual !== expected) fail('源码版本与已审核版本不一致，请重新准备。');
  }
}
class MediaOcr {
  constructor({ root, platform = process.platform, arch = process.arch, clientFactory = (server, options) => new McpClient(server, options) }) { Object.assign(this, { root, platform, arch, clientFactory }); }
  available() {
    if (!['win32', 'darwin'].includes(this.platform)) return false;
    const files = layout(this.root, this.platform, this.arch); if (!fs.existsSync(files.ready)) return false;
    try {
      const stat = fs.lstatSync(files.ready); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw Error();
      const ready = JSON.parse(fs.readFileSync(files.ready, 'utf8'));
      if (ready.version !== 1 || ready.revision !== REVISION || ready.platform !== this.platform || ready.arch !== this.arch || !fs.statSync(files.python).isFile()) throw Error();
      verifySource(files.source, this.platform); return true;
    } catch { fail('本机准备记录或文件无效，请重新准备；未启动未知程序。'); }
  }
  async recognize(file, { pages, signal, forceOcr = false } = {}) {
    if (!this.available()) return null;
    signal?.throwIfAborted(); const files = layout(this.root, this.platform, this.arch), pdf = path.extname(file).toLowerCase() === '.pdf';
    if (pdf && !Array.isArray(pages)) return null;
    const client = this.clientFactory({ name: 'mediaocr', transport: 'stdio', enabled: true, command: files.python, args: [path.join(files.source, 'server.py'), '--workers', '1'] }, { signal, cwd: files.source, timeoutMs: 240000 });
    try {
      await client.start(); const tools = await client.tools(), name = pdf ? 'ocr_document' : 'ocr_image';
      const tool = tools.find(tool => tool.name === name);
      if (!tool || !tool.inputSchema?.properties?.[pdf ? 'document_path' : 'image_paths']) fail('工具目录与已审核接口不一致。');
      const result = await client.request('tools/call', { name, arguments: pdf ? { document_path: file, max_pages: Math.max(...pages), dpi: 150, auto_dpi: true, compact: true } : { image_paths: [file], compact: true } });
      signal?.throwIfAborted(); if (result.isError) fail('识别未完成，请检查已准备的本机引擎。');
      let data;
      try { data = result.structuredContent || JSON.parse((result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')); } catch { fail('结果不是有效 JSON。'); }
      if (data?.errcode !== 0) fail('引擎没有返回成功结果，请检查本机组件。');
      const selected = pdf ? data.pages?.filter(page => pages.includes(page.page)) : [{ page: 1, text: data.text, confidence: data.confidence }];
      if (!Array.isArray(selected) || selected.length !== (pdf ? pages.length : 1) || selected.some(page => typeof page.text !== 'string' || page.text.length > 200000 || page.errcode !== undefined && page.errcode !== 0) || pdf && pages.some(number => !selected.some(page => page.page === number))) fail('所选页不完整，未发送缺页结果。');
      // Upstream ocr_document deliberately uses an existing PDF text layer.
      // A user explicitly asking to OCR every page still gets actual native
      // raster OCR for those pages instead of a mislabeled text-layer result.
      if (forceOcr && selected.some(page => page.type === 'text_layer')) return null;
      return { pages: selected.map(page => ({ page: page.page, text: page.text })), languages: [], engine: 'mediaocr (WeChat OCR)', confidence: selected.map(page => typeof page.confidence === 'number' ? page.confidence : null) };
    } catch (error) { signal?.throwIfAborted(); if (/^Notion 附件 OCR mediaocr/.test(error.message)) throw error; fail('本机 MCP 通道或识别未完成，请重新准备后重试。'); }
    finally {
      const child = client.child;
      // EOF lets upstream server.py run its own finally/ocr.close(), including
      // the Mac worker's private process-group cleanup.
      if (child?.pid && child.exitCode === null && !child.killed) {
        await new Promise(resolve => { const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve(); }, timer = setTimeout(finish, 5000); child.once('exit', finish); child.stdin.once('error', () => {}); try { child.stdin.end(); } catch { finish(); } });
        if (child.exitCode === null && !child.killed && this.platform === 'win32') await new Promise(resolve => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve()));
        if (child.exitCode === null && !child.killed && this.platform === 'darwin') {
          const tree = await new Promise(resolve => execFile('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 ** 2 }, (error, stdout) => resolve(error ? '' : stdout)));
          const pairs = tree.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)), owned = new Set([child.pid]);
          for (let at = 0; at < 8; at++) for (const [pid, parent] of pairs) if (owned.has(parent)) owned.add(pid);
          if (child.exitCode === null && !child.killed) for (const pid of [...owned].reverse()) if (pid !== child.pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        }
      }
      client.close();
    }
  }
}
module.exports = { MediaOcr, REVISION, FILES, MAC_FILES, layout, verifySource };
