/**
 * Whether this machine has each platform's toolchain at all, and what to
 * install when it does not (PILOT-558). Advice for "no device found" means
 * nothing to someone who has not installed Android Studio or Xcode yet: they
 * must hear what is missing first, not "set `avd`" or "run `xcrun simctl`".
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ADB_FIX } from './adb-devices.js';
import { androidSdkRoots, isOnPath } from './emulator.js';

export const XCODE_FIX = 'Install Xcode from the Mac App Store, open it once to finish setup, then run: sudo xcode-select -s /Applications/Xcode.app';

const PREREQUISITES_URL = 'https://tapsmith.dev/getting-started/#prerequisites';

const NO_ANDROID_SDK_FIX = 'Install Android Studio (https://developer.android.com/studio), or the Android command-line tools and then `sdkmanager platform-tools`; '
  + `set ANDROID_HOME to the SDK and add $ANDROID_HOME/platform-tools to PATH (see ${PREREQUISITES_URL})`;

export interface ToolchainDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
  isFile: (file: string) => boolean;
  isDir: (dir: string) => boolean;
  /** `xcodebuild -version` succeeds: Xcode itself, not just the command-line tools, is selected. */
  xcodeInstalled: () => boolean;
}

function statIs(file: string, kind: 'file' | 'dir'): boolean {
  try {
    const stat = fs.statSync(file);
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

/** Whether `xcodebuild -version` works on this Mac. */
export function isXcodeInstalled(): boolean {
  try {
    execFileSync('xcodebuild', ['-version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function hostDeps(overrides: Partial<ToolchainDeps>): ToolchainDeps {
  return {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir,
    isFile: (file) => statIs(file, 'file'),
    isDir: (dir) => statIs(dir, 'dir'),
    xcodeInstalled: isXcodeInstalled,
    ...overrides,
  };
}

type AdbLocation =
  | { kind: 'no-sdk' }
  | { kind: 'sdk-without-platform-tools' }
  | { kind: 'off-path'; platformTools: string };

/** Where adb is when it is not on PATH: in an SDK's platform-tools, in no SDK, or nowhere. */
function locateAdb(deps: ToolchainDeps): AdbLocation {
  const win = deps.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const roots = androidSdkRoots(deps.env, deps.platform, deps.homedir());
  for (const root of roots) {
    const platformTools = p.join(root, 'platform-tools');
    if (deps.isFile(p.join(platformTools, win ? 'adb.exe' : 'adb'))) return { kind: 'off-path', platformTools };
  }
  return roots.some((root) => deps.isDir(root)) ? { kind: 'sdk-without-platform-tools' } : { kind: 'no-sdk' };
}

/**
 * The SDK `platform-tools` directory that has adb when adb is not on PATH —
 * undefined when it is on PATH or no SDK has it (PILOT-832): init says adb
 * is off PATH rather than missing.
 */
export function adbOffPathDir(overrides: Partial<ToolchainDeps> = {}): string | undefined {
  const deps = hostDeps(overrides);
  if (isOnPath('adb', deps.env, deps.platform, deps.isFile)) return undefined;
  const where = locateAdb(deps);
  return where.kind === 'off-path' ? where.platformTools : undefined;
}

/**
 * doctor's fix for an unset ANDROID_HOME (and ANDROID_SDK_ROOT): the SDK
 * found at the OS default location, where Android Studio installs it
 * without setting either (PILOT-832), else the generic advice.
 */
export function androidHomeUnsetFix(overrides: Partial<ToolchainDeps> = {}): string {
  const deps = hostDeps(overrides);
  const sdk = androidSdkRoots(deps.env, deps.platform, deps.homedir()).find((root) => deps.isDir(root));
  if (!sdk) return 'Set ANDROID_HOME to your Android SDK location';
  const example = deps.platform === 'win32' ? '' : ` (e.g. export ANDROID_HOME="${sdk}" in your shell profile)`;
  return `Your Android SDK is at ${sdk}: set ANDROID_HOME to it${example}`;
}

/**
 * The fix for a missing adb: the platform-tools directory to add to PATH
 * when an SDK has it, the platform-tools install when the SDK lacks it, or
 * installing an SDK at all when there is none.
 */
export function adbMissingFix(overrides: Partial<ToolchainDeps> = {}): string {
  const deps = hostDeps(overrides);
  const where = locateAdb(deps);
  if (where.kind === 'off-path') {
    const example = deps.platform === 'win32' ? '' : ` (e.g. export PATH="${where.platformTools}:$PATH" in your shell profile)`;
    return `adb is in ${where.platformTools} but not on PATH — add that directory to PATH${example}`;
  }
  return where.kind === 'no-sdk' ? NO_ANDROID_SDK_FIX : ADB_FIX;
}

/**
 * Why no Android device can be reached on this machine, with the fix —
 * undefined when adb is on PATH (Tapsmith and its daemon run `adb` from
 * PATH). No trailing period, like `androidStateBlocker`.
 */
export function androidToolchainBlocker(overrides: Partial<ToolchainDeps> = {}): string | undefined {
  const deps = hostDeps(overrides);
  if (isOnPath('adb', deps.env, deps.platform, deps.isFile)) return undefined;
  const noSdk = locateAdb(deps).kind === 'no-sdk';
  return `ADB is not on PATH${noSdk ? ' and no Android SDK was found' : ''}, so Tapsmith cannot reach any Android device: ${adbMissingFix(deps)}`;
}

/**
 * Before launching an emulator: without adb, Tapsmith would boot it and then
 * wait out the whole boot timeout on an adb that cannot run. Throws the
 * {@link androidToolchainBlocker} instead.
 */
export function assertAdbForEmulatorLaunch(overrides: Partial<ToolchainDeps> = {}): void {
  const blocker = androidToolchainBlocker(overrides);
  if (blocker) throw new Error(`${blocker}.`);
}

/**
 * Why no iOS simulator can be used on this machine, with the fix —
 * undefined on a Mac with Xcode. No trailing period.
 */
export function iosToolchainBlocker(overrides: Partial<ToolchainDeps> = {}): string | undefined {
  const deps = hostDeps(overrides);
  if (deps.platform !== 'darwin') return 'iOS testing needs macOS with Xcode installed';
  if (deps.xcodeInstalled()) return undefined;
  return `Xcode is not installed, so there are no iOS simulators: ${XCODE_FIX}`;
}

/** {@link androidToolchainBlocker} or {@link iosToolchainBlocker}, by a config's `platform` (Android when unset). */
export function toolchainBlocker(platform: string | undefined): string | undefined {
  return platform === 'ios' ? iosToolchainBlocker() : androidToolchainBlocker();
}
