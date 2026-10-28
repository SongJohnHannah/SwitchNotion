import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollectionService } = require('../src/collection/service.cjs');
const { cdpCommand } = require('../src/collection/browser.cjs');
const root = path.resolve(import.meta.dirname, '../.notion-switch'), service = new CollectionService({ root });
try {
  const signal = AbortSignal.timeout(70000), browser = service.browser, tab = await browser.tab(process.argv[2], signal);
  try { await browser.waitReady(tab, signal); } catch {}
  const inspect = () => ({ url: location.origin + location.pathname, title: document.title, ready: document.readyState,
    bodyCharacters: (document.body?.innerText || '').length, htmlCharacters: document.documentElement.outerHTML.length,
    videos: document.querySelectorAll('video').length,
    iframes: [...document.querySelectorAll('iframe')].map(x => { try { return new URL(x.src).origin + new URL(x.src).pathname; } catch { return 'unknown'; } }),
    errorCode: (document.body?.innerText || '').match(/ERR_[A-Z_]+/)?.[0],
    candidates: [...document.querySelectorAll('article,main,[role="article"],[role="main"],[data-testid*="Article"],[data-testid*="article"]')].map(el => ({ tag: el.tagName, role: el.getAttribute('role'), testid: el.getAttribute('data-testid'), textCharacters: (el.innerText || '').length, images: el.querySelectorAll('img').length })).sort((a,b)=>b.textCharacters-a.textCharacters).slice(0,35),
    images: [...document.querySelectorAll('img')].slice(0,30).map(el => ({ origin: (()=>{try{return new URL(el.currentSrc||el.src).origin}catch{return ''}})(), profileImage: /\/profile_images\//.test(el.src), parents: [...(function*(){let n=el;for(let i=0;n&&i<5;i++,n=n.parentElement)yield n;})()].map(n=>n.getAttribute('data-testid')).filter(Boolean) })) });
  const result = await cdpCommand(tab.wsUrl, 'Runtime.evaluate', { expression: '(' + inspect.toString() + ')()', returnByValue: true }, { signal });
  fs.writeFileSync(path.join(root,'collection/page-inspection.local.json'),JSON.stringify(result.result?.value,null,2)); console.log(JSON.stringify(result.result?.value));
  if (process.argv.includes('--screenshot')) { const screenshot = await cdpCommand(tab.wsUrl,'Page.captureScreenshot',{format:'png'},{signal});fs.writeFileSync(path.join(root,'collection/page-inspection.png'),Buffer.from(screenshot.data,'base64')); }
} catch(error) { console.log(JSON.stringify({message:error.message,cdpCode:error.cdpCode,cdpMessage:error.cdpMessage}));process.exitCode=1; }
finally {service.close();}
