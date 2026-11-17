import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { defaultOutputDirectory } from '../src/collection/media-kit/default-output.mjs';
import { MediaKit } from '../src/collection/media-kit/index.mjs';

test('Mac media defaults use its own Downloads directory, including spaces in the home path', () => {
  const home = '/Users/Example User';
  assert.equal(defaultOutputDirectory({ platform: 'darwin', home }), home + '/Downloads/NotionSwitch');
  assert.equal(defaultOutputDirectory({ platform: 'darwin', home, video: true }), home + '/Downloads/NotionSwitch/original_video');
  if (process.platform === 'darwin') assert.equal(new MediaKit().config.outputDir, path.join(os.homedir(), 'Downloads/NotionSwitch/original_video'));
});
test('Windows and WSL media defaults retain their existing directories and explicit output choices still win', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(defaultOutputDirectory({ platform }), '/mnt/d/Download');
    assert.equal(defaultOutputDirectory({ platform, video: true }), '/mnt/d/Download/original_video');
  }
  assert.equal(new MediaKit({ outputDir: '/chosen folder' }).config.outputDir, '/chosen folder');
});
