import { MediaKit } from './media-kit/index.mjs';
import errors from './download-error.cjs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
try {
  const { config, url, kind, directory } = JSON.parse(input);
  if (config.proxyUrl) process.env.MEDIAKIT_PROXY_URL = config.proxyUrl;
  const result = await new MediaKit({ ...config, outputDir: directory }).download({ url, title: 'source', outputDir: directory, mediaType: kind, format: 'best' });
  process.stdout.write(JSON.stringify(result));
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, files: [], error: errors.downloadDetail(error?.message) || '媒体下载处理程序未完成。' })); }
