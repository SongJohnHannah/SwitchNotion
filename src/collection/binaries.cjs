const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { download } = require('./network.cjs');
const assets = {
  'win32-x64': {
    'yt-dlp': ['yt-dlp/yt-dlp', '2026.10.26', 'yt-dlp.exe', 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'],
    ffmpeg: ['eugeneware/ffmpeg-static', 'b6.1.1', 'ffmpeg-win32-x64.gz', '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77'],
    license: ['eugeneware/ffmpeg-static', 'b6.1.1', 'win32-x64.LICENSE', '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'] },
  'darwin-arm64': {
    'yt-dlp': ['yt-dlp/yt-dlp', '2026.10.26', 'yt-dlp_macos', '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa'],
    ffmpeg: ['eugeneware/ffmpeg-static', 'b6.1.1', 'ffmpeg-darwin-arm64.gz', '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa'],
    license: ['eugeneware/ffmpeg-static', 'b6.1.1', 'darwin-arm64.LICENSE', 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2'] }
};
function resolveBinary(name, directory, { platform = process.platform, env = process.env } = {}) {
  const extensions = platform === 'win32' ? ['.exe'] : [''];
  for (const dir of [directory, ...(env.PATH || '').split(platform === 'win32' ? ';' : ':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (!dir) continue;
    for (const ext of extensions) { const file = path.join(dir, name + ext); try { if (fs.statSync(file).isFile()) return file; } catch {} }
  }
  return null;
}
class CollectionBinaries {
  constructor({ root, platform = process.platform, arch = process.arch, downloadImpl = download } = {}) {
    Object.assign(this, { platform, arch, downloadImpl }); this.directory = path.join(root, 'collection', 'bin');
  }
  status() { return { supported: !!assets[this.platform + '-' + this.arch], downloader: !!this.find('yt-dlp'), ffmpeg: !!this.find('ffmpeg') }; }
  find(name) { return resolveBinary(name, this.directory, { platform: this.platform }); }
  async prepare({ signal, progress = () => {} } = {}) {
    const selected = assets[this.platform + '-' + this.arch]; if (!selected) throw Error('收集组件支持 Windows x64 和 Apple Silicon Mac。');
    fs.mkdirSync(this.directory, { recursive: true });
    for (const [name, [repository, version, filename, digest]] of Object.entries(selected)) {
      const output = path.join(this.directory, name === 'license' ? 'FFMPEG-LICENSE.txt' : name + (this.platform === 'win32' ? '.exe' : ''));
      if (name === 'license' && !fs.existsSync(path.join(this.directory, 'ffmpeg' + (this.platform === 'win32' ? '.exe' : '')))) continue;
      if (name === 'license' && fs.existsSync(output) && createHash('sha256').update(fs.readFileSync(output)).digest('hex') === digest) continue;
      if (name !== 'license' && this.find(name)) continue;
      progress('正在下载并校验 ' + name + '…');
      const temporary = path.join(this.directory, randomUUID() + '.download');
      const ready = output + '.' + randomUUID() + '.ready';
      try {
        await this.downloadImpl(`https://github.com/${repository}/releases/download/${version}/${filename}`, temporary, { signal, maxBytes: 200 * 1024 ** 2 });
        const hasher = createHash('sha256'); for await (const chunk of fs.createReadStream(temporary)) hasher.update(chunk);
        if (hasher.digest('hex') !== digest) throw Error('收集组件校验失败，未安装下载文件。');
        if (filename.endsWith('.gz')) { await pipeline(fs.createReadStream(temporary), zlib.createGunzip(), fs.createWriteStream(ready, { mode: 0o700 }), { signal }); }
        else fs.copyFileSync(temporary, ready);
        if (this.platform !== 'win32' && name !== 'license') fs.chmodSync(ready, 0o700);
        fs.renameSync(ready, output);
      } finally { for (const file of [temporary, ready]) try { fs.unlinkSync(file); } catch {} }
    }
    return this.status();
  }
}
module.exports = { CollectionBinaries, resolveBinary, assets };
