import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Load the real dispatch for either OS without changing the host process.
// The response adapter must resolve this same instance, including on Windows.
export function clientForPlatform(platform) {
  const clientFile = new URL('../../src/client-compat.cjs', import.meta.url);
  const clientRequire = createRequire(clientFile), client = { exports: {} };
  vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), {
    require: clientRequire, module: client, process: { platform }, URL
  });
  const responseFile = new URL('../../src/compat/response.cjs', import.meta.url);
  const responseRequire = createRequire(responseFile), response = { exports: {} };
  vm.runInNewContext(fs.readFileSync(responseFile, 'utf8'), {
    require: id => id === '../client-compat.cjs' ? client.exports : responseRequire(id),
    module: response, Buffer, Headers, Response
  });
  return { ...client.exports, ...response.exports, async adaptResponse(...args) {
    const result = await response.exports.adaptResponse(...args);
    return result && { ...result, kinds: Array.from(result.kinds), automatic: Array.from(result.automatic) };
  } };
}
