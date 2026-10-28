import type { ChildProcess, SpawnOptions, spawn, execFileSync } from 'node:child_process';
import type * as filesystem from 'node:fs';

export type Capability = 'prepareRuntime' | 'launchRuntime' | 'syncLogin';
export interface InstallationLayout {
  /** Original installation root, or the app bundle itself on macOS. */
  appRoot: string;
  executable: string;
  resources: string;
  archive: string;
}
export interface CompatibilityPolicy {
  enabled: boolean;
  /** Platform-specific hashes. Windows hashes must not be reused on macOS. */
  reviewedBuilds: Readonly<Record<string, string>>;
  versionPattern: RegExp;
  electronPattern: RegExp;
}
export interface PlatformOptions {
  id?: 'win32' | 'darwin';
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Must bypass Electron ASAR virtualization. Defaults to original-fs there. */
  fs?: typeof filesystem;
  execFileSync?: typeof execFileSync;
  registry?: () => string[];
}
export interface DesktopPlatform {
  readonly id: 'win32' | 'darwin';
  readonly label: string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly compatibility: Readonly<CompatibilityPolicy>;
  readonly login: Readonly<{ strategy: 'windows-local-copy' | 'macos-keychain-copy' | 'interactive'; sourceRoot: string | null }>;
  /** Throws code PLATFORM_CAPABILITY_UNAVAILABLE before side effects. */
  requireCapability(capability: Capability): void;
  /** Pure layout, no existence or compatibility guarantee. */
  installationLayout(candidate: string): InstallationLayout;
  /** Pure layout; macOS uses SwitchNotion.app, with legacy Notion.app support. */
  runtimeLayout(container: string): InstallationLayout;
  /** Requires absolute paths; excludes the isolated state directory and aliases. */
  findInstallation(candidate: string, stateRoot?: string): InstallationLayout | null;
  discoverInstallation(stateRoot: string): InstallationLayout | null;
  /** Copies only into a fresh staging container supplied by the updater. */
  stageInstallation(input: { source: InstallationLayout; container: string; copy: (source: string, target: string) => void }): InstallationLayout;
  /** Runs after archive patching, before promotion; signing belongs here. */
  finalizeRuntime(layout: InstallationLayout): void;
  /** Launches only the isolated container, never modifies the official app. */
  launchRuntime(input: { container: string; stateRoot: string; env?: NodeJS.ProcessEnv; stdio?: SpawnOptions['stdio']; spawnImpl?: typeof spawn }): ChildProcess;
  isNodeExecutable(executable: unknown): boolean;
  samePath(left: string, right: string): boolean;
  configureAppIdentity(app: { setAppUserModelId?: (id: string) => void }): void;
}
export function createDesktopPlatform(options?: PlatformOptions): DesktopPlatform;
