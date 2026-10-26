import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  adbMissingFix,
  androidHomeUnsetFix,
  androidToolchainBlocker,
  assertAdbForEmulatorLaunch,
  iosToolchainBlocker,
  XCODE_FIX,
  type ToolchainDeps,
} from '../toolchain.js';
import { ADB_FIX } from '../adb-devices.js';

/** A fake host: `files` and `dirs` are what exists; nothing else does. */
function host(opts: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  files?: string[];
  dirs?: string[];
  xcode?: boolean;
} = {}): ToolchainDeps {
  const files = new Set(opts.files ?? []);
  const dirs = new Set(opts.dirs ?? []);
  return {
    env: opts.env ?? { PATH: '/usr/bin:/bin' },
    platform: opts.platform ?? 'darwin',
    homedir: () => '/Users/me',
    isFile: (f) => files.has(f),
    isDir: (d) => dirs.has(d),
    xcodeInstalled: () => opts.xcode ?? false,
  };
}

const DEFAULT_SDK = '/Users/me/Library/Android/sdk';

describe('adbMissingFix()', () => {
  it('with no Android SDK anywhere, says to install one and links the prerequisites', () => {
    const fix = adbMissingFix(host());
    expect(fix).toContain('Install Android Studio');
    expect(fix).toContain('ANDROID_HOME');
    expect(fix).toContain('platform-tools');
    expect(fix).toContain('https://tapsmith.dev/getting-started/#prerequisites');
  });

  it('treats an ANDROID_HOME that does not exist as no SDK', () => {
    expect(adbMissingFix(host({ env: { PATH: '/usr/bin', ANDROID_HOME: '/nope' } }))).toContain('Install Android Studio');
  });

  it('with an SDK but no platform-tools, says to install platform-tools', () => {
    expect(adbMissingFix(host({ dirs: [DEFAULT_SDK] }))).toBe(ADB_FIX);
  });

  it('with adb in an SDK\'s platform-tools, names that directory to add to PATH', () => {
    const tools = path.posix.join(DEFAULT_SDK, 'platform-tools');
    const fix = adbMissingFix(host({ dirs: [DEFAULT_SDK], files: [`${tools}/adb`] }));
    expect(fix).toBe(`adb is in ${tools} but not on PATH — add that directory to PATH (e.g. export PATH="${tools}:$PATH" in your shell profile)`);
  });

  it('looks in ANDROID_HOME before the default location', () => {
    const tools = '/sdk/platform-tools';
    const fix = adbMissingFix(host({ env: { PATH: '', ANDROID_HOME: '/sdk' }, dirs: ['/sdk'], files: [`${tools}/adb`] }));
    expect(fix).toContain(`adb is in ${tools}`);
  });
});

describe('androidToolchainBlocker()', () => {
  it('is undefined when adb is on PATH', () => {
    expect(androidToolchainBlocker(host({ env: { PATH: '/tools:/usr/bin' }, files: ['/tools/adb'] }))).toBeUndefined();
  });

  it('says no SDK was found, and how to install one, when there is none', () => {
    const blocker = androidToolchainBlocker(host());
    expect(blocker).toMatch(/^ADB is not on PATH and no Android SDK was found, so Tapsmith cannot reach any Android device: Install Android Studio/);
  });

  it('only says ADB is missing when an SDK exists', () => {
    const blocker = androidToolchainBlocker(host({ dirs: [DEFAULT_SDK] }));
    expect(blocker).toBe(`ADB is not on PATH, so Tapsmith cannot reach any Android device: ${ADB_FIX}`);
  });
});

describe('iosToolchainBlocker()', () => {
  it('is undefined on a Mac with Xcode', () => {
    expect(iosToolchainBlocker(host({ xcode: true }))).toBeUndefined();
  });

  it('says to install Xcode on a Mac without it (only the command-line tools, or nothing)', () => {
    expect(iosToolchainBlocker(host({ xcode: false }))).toBe(`Xcode is not installed, so there are no iOS simulators: ${XCODE_FIX}`);
    expect(XCODE_FIX).toContain('xcode-select -s');
  });

  it('says iOS needs macOS elsewhere, without asking about Xcode', () => {
    let asked = false;
    const deps = { ...host({ platform: 'linux' }), xcodeInstalled: () => { asked = true; return true; } };
    expect(iosToolchainBlocker(deps)).toBe('iOS testing needs macOS with Xcode installed');
    expect(asked).toBe(false);
  });
});

// Launching an emulator without adb boots it and then waits out the whole boot
// timeout on an adb that cannot run: refuse before launching instead.
describe('assertAdbForEmulatorLaunch()', () => {
  it('throws the adb blocker, naming the platform-tools directory, when adb is off PATH', () => {
    const tools = path.posix.join(DEFAULT_SDK, 'platform-tools');
    expect(() => assertAdbForEmulatorLaunch(host({ dirs: [DEFAULT_SDK], files: [`${tools}/adb`] })))
      .toThrow(`ADB is not on PATH, so Tapsmith cannot reach any Android device: adb is in ${tools} but not on PATH`);
  });

  it('does nothing when adb is on PATH', () => {
    expect(() => assertAdbForEmulatorLaunch(host({ env: { PATH: '/tools' }, files: ['/tools/adb'] }))).not.toThrow();
  });
});

describe('androidHomeUnsetFix() (PILOT-832)', () => {
  it('names the SDK it found at the default location, with the export line', () => {
    const fix = androidHomeUnsetFix(host({ env: {}, dirs: [DEFAULT_SDK] }));
    expect(fix).toBe(`Your Android SDK is at ${DEFAULT_SDK}: set ANDROID_HOME to it (e.g. export ANDROID_HOME="${DEFAULT_SDK}" in your shell profile)`);
  });

  it('uses ~/Android/Sdk on Linux, and no export example on Windows', () => {
    expect(androidHomeUnsetFix(host({ env: {}, platform: 'linux', dirs: ['/Users/me/Android/Sdk'] }))).toContain('export ANDROID_HOME="/Users/me/Android/Sdk"');
    const win = androidHomeUnsetFix(host({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32', dirs: ['C:\\Users\\me\\AppData\\Local\\Android\\Sdk'] }));
    expect(win).toBe('Your Android SDK is at C:\\Users\\me\\AppData\\Local\\Android\\Sdk: set ANDROID_HOME to it');
  });

  it('keeps the generic advice when no SDK is at the default location', () => {
    expect(androidHomeUnsetFix(host({ env: {} }))).toBe('Set ANDROID_HOME to your Android SDK location');
  });
});
