const path = require('node:path');

// Layout/discovery are usable now. Runtime modification is deliberately gated
// until a Mac-specific compatibility policy, signing and launch are validated.
function macos({ home }) {
  const layout = bundle => {
    const appRoot = path.resolve(bundle), resources = path.join(appRoot, 'Contents', 'Resources');
    return { appRoot, executable: path.join(appRoot, 'Contents', 'MacOS', 'Notion'), resources, archive: path.join(resources, 'app.asar') };
  };
  return {
    id: 'darwin', label: 'macOS', capabilities: { prepareRuntime: false, launchRuntime: false, syncLogin: false },
    compatibility: { enabled: false, reviewedBuilds: {}, versionPattern: /^7\.\d+\.\d+$/, electronPattern: /^44\./ },
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
    configureAppIdentity() {}
  };
}
module.exports = { macos };
