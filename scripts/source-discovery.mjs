import platformModule from '../src/platform/index.cjs';

// Compatibility wrappers for CLI callers. The platform API also exposes the
// complete descriptor for code that needs executable/resources/bundle paths.
const { createDesktopPlatform } = platformModule;
export function notionDirectory(candidate, root, options = {}) {
  return createDesktopPlatform(options).findInstallation(candidate, root)?.appRoot || null;
}
export function findNotion(root, options = {}) {
  return createDesktopPlatform(options).discoverInstallation(root)?.appRoot || null;
}
