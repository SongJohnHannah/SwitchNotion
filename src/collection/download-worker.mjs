import { MediaKit } from './media-kit/index.mjs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
try {
  const { config, url, kind, directory } = JSON.parse(input);
  if (config.proxyUrl) process.env.MEDIAKIT_PROXY_URL = config.proxyUrl;
  const result = await new MediaKit({ ...config, outputDir: directory }).download({ url, title: 'source', outputDir: directory, mediaType: kind, format: 'best' });
  process.stdout.write(JSON.stringify(result));
} catch { process.stdout.write(JSON.stringify({ ok: false, error: '媒体下载失败，请检查组件、登录和网络。' })); process.exitCode = 1; }
