const path = require('node:path');
const { createMacRuntime } = require('./macos-runtime.cjs');

const reviewedBuilds = Object.freeze({ '7.40.1': '48154144947412453a987b55cc1725c5a4dbf66f7b90ea919384d061cde2716f' });
function macos({ home, arch, execFileSync, fs }) {
  const layout = bundle => {
    const appRoot = path.resolve(bundle), resources = path.join(appRoot, 'Contents', 'Resources');
    return { appRoot, executable: path.join(appRoot, 'Contents', 'MacOS', 'Notion'), resources, archive: path.join(resources, 'app.asar') };
  };
  return {
    id: 'darwin', label: 'macOS', capabilities: { prepareRuntime: arch === 'arm64', launchRuntime: arch === 'arm64', syncLogin: false },
    compatibility: { enabled: true, reviewedBuilds, versionPattern: /^7\.\d+\.\d+$/, electronPattern: /^44\./ },
    installationLayout(candidate) {
      const absolute = path.resolve(candidate);
      return layout(path.basename(absolute) === 'Notion' && path.basename(path.dirname(absolute)) === 'MacOS'
        ? path.resolve(absolute, '..', '..', '..') : absolute);
    },
    runtimeLayout: container => layout(path.join(container, 'Notion.app')),
    candidates: () => [path.join(home, 'Applications', 'Notion.app'), '/Applications/Notion.app'],
    fallbackCandidates: () => [],
    login: { strategy: 'interactive', sourceRoot: path.join(home, 'Library', 'Application Support', 'Notion') },
    nodeName: /^node$/,
    launchOptions: {},
    configureAppIdentity() {},
    ...createMacRuntime({ execFileSync, fsImpl: fs })
  };
}
module.exports = { macos, reviewedBuilds };
