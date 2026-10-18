/**
 * PILOT-485: the simulator agent auto-build cache is only as current as the
 * agent source it was compiled from. A cache another Tapsmith version built
 * (or one from before versions were recorded) must never be picked, and a
 * prebuilt npm package from this release for the installed SDK beats any
 * cache. Real files under a temp HOME; only the SDK probe, the npm package
 * lookup and the host arch are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fake = vi.hoisted(() => ({ sdk: '27.1' as string | undefined, pkgDir: undefined as string | undefined }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => {
    if (fake.sdk === undefined) throw new Error('xcrun: error');
    return `${fake.sdk}\n`;
  }),
}));

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: () => ({
    resolve: (id: string) => {
      if (id === '@tapsmith/agent-ios-simulator-arm64/package.json' && fake.pkgDir) {
        return path.join(fake.pkgDir, 'package.json');
      }
      throw new Error(`Cannot find module '${id}'`);
    },
  }),
}));

vi.mock('../host-arch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-arch.js')>();
  return { ...actual, hostArch: () => 'arm64', appleArch: () => 'arm64' };
});

import { tapsmithPackageVersion } from '../ios-agent-paths.js';

const CURRENT = tapsmithPackageVersion();
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const savedHome = process.env.HOME;
const savedCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sim-cache-')));
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME);
  // The DerivedData scan also looks under the cwd's ios-agent/.
  process.chdir(tmp);
  Object.defineProperty(process, 'platform', { ...savedPlatform, value: 'darwin' });
  fake.sdk = '27.1';
  fake.pkgDir = undefined;
});

afterEach(() => {
  process.chdir(savedCwd);
  Object.defineProperty(process, 'platform', savedPlatform);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cacheRoot = (): string => path.join(tmp, 'home', '.tapsmith', 'ios-simulator-agent');
/** Where `version` builds (the root itself for a release before the per-version layout). */
const cacheDir = (version: string | null = CURRENT): string => (version === null ? cacheRoot() : path.join(cacheRoot(), version));

/** A complete simulator build (xctestrun + runner app + .xctest) in `dir`; returns the xctestrun. */
function writeBuild(dir: string, sdk: string): string {
  const plugins = path.join(dir, 'Debug-iphonesimulator', 'TapsmithAgentUITests-Runner.app', 'PlugIns');
  fs.mkdirSync(path.join(plugins, 'TapsmithAgentUITests.xctest'), { recursive: true });
  const xctestrun = path.join(dir, `TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator${sdk}-arm64.xctestrun`);
  fs.writeFileSync(xctestrun, '<plist/>');
  return xctestrun;
}

/** A complete auto-build cache for `sdk`, where a build by `builtBy` puts it (`null`: a pre-PILOT-485 release). */
function writeCache(sdk: string, builtBy: string | null): string {
  const xctestrun = writeBuild(cacheDir(builtBy), sdk);
  fs.writeFileSync(path.join(cacheDir(builtBy), '.sdk-version'), sdk);
  return xctestrun;
}

/** The prebuilt npm package at `version`, with a build per SDK. */
function writePackage(version: string, sdks: string[]): Record<string, string> {
  fake.pkgDir = path.join(tmp, 'node_modules', '@tapsmith', 'agent-ios-simulator-arm64');
  fs.mkdirSync(fake.pkgDir, { recursive: true });
  fs.writeFileSync(path.join(fake.pkgDir, 'package.json'), JSON.stringify({ version }));
  const builds: Record<string, string> = {};
  for (const sdk of sdks) builds[sdk] = writeBuild(path.join(fake.pkgDir, `sdk-${sdk}`), sdk);
  return builds;
}

async function resolve(): Promise<typeof import('../ios-device-resolve.js')> {
  return import('../ios-device-resolve.js');
}

describe('findSimulatorXctestrun() and the auto-build cache (PILOT-485)', () => {
  it('uses a cache this version built for the installed SDK', async () => {
    const cached = writeCache('27.1', CURRENT);
    expect((await resolve()).findSimulatorXctestrun()).toBe(cached);
  });

  // Not `toBeUndefined()`: the lookup's last step also scans this checkout's
  // own ios-agent build dirs, which a developer's machine may have.
  it('skips a cache another Tapsmith version built', async () => {
    const cached = writeCache('27.1', '0.0.1-older');
    expect((await resolve()).findSimulatorXctestrun()).not.toBe(cached);
    expect(fs.existsSync(cached)).toBe(true); // that version still uses it
  });

  it('skips a cache a release before the per-version layout built', async () => {
    const cached = writeCache('27.1', null);
    expect((await resolve()).findSimulatorXctestrun()).not.toBe(cached);
  });

  it('skips a cache built for another SDK, and an unfinished one', async () => {
    const cached = writeCache('27.0', CURRENT);
    expect((await resolve()).findSimulatorXctestrun()).not.toBe(cached);
    fs.rmSync(path.join(cacheDir(), '.sdk-version'));
    vi.resetModules();
    expect((await resolve()).findSimulatorXctestrun()).not.toBe(cached);
  });

  it('uses its own build when another version\'s (or an older release\'s) is newer', async () => {
    const own = writeCache('27.1', CURRENT);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(writeCache('27.1', '0.0.1-older'), later, later);
    fs.utimesSync(writeCache('27.1', null), later, later);
    expect((await resolve()).findSimulatorXctestrun()).toBe(own);
  });

  it('keeps a current cache when the SDK cannot be detected', async () => {
    fake.sdk = undefined;
    const cached = writeCache('27.1', CURRENT);
    expect((await resolve()).findSimulatorXctestrun()).toBe(cached);
  });

  it('falls through a stale cache to the npm package (whose other-SDK build ensureSimulatorAgent rebuilds)', async () => {
    writeCache('27.1', '0.0.1-older');
    const pkg = writePackage(CURRENT, ['26.5']);
    expect((await resolve()).findSimulatorXctestrun()).toBe(pkg['26.5']);
  });

  it('prefers this release\'s npm build for the installed SDK over a current cache', async () => {
    writeCache('27.1', CURRENT);
    const pkg = writePackage(CURRENT, ['26.5', '27.1']);
    expect((await resolve()).findSimulatorXctestrun()).toBe(pkg['27.1']);
  });

  it('prefers a current cache over the npm package\'s build for another SDK, so a rebuild is not repeated every run', async () => {
    const cached = writeCache('27.1', CURRENT);
    writePackage(CURRENT, ['26.5']);
    expect((await resolve()).findSimulatorXctestrun()).toBe(cached);
  });

  it('never uses an npm package from another release, even for the installed SDK', async () => {
    const cached = writeCache('27.1', CURRENT);
    writePackage('0.0.1-older', ['27.1']);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect((await resolve()).findSimulatorXctestrun()).toBe(cached);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('does not match the SDK version'));
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('inspectSimulatorAgentCache()', () => {
  it('is undefined without a cached build', async () => {
    expect((await resolve()).inspectSimulatorAgentCache('27.1')).toBeUndefined();
  });

  it('says what this version\'s cache holds and why it is not used', async () => {
    const { inspectSimulatorAgentCache } = await resolve();
    const xctestrun = writeCache('27.1', CURRENT);
    expect(inspectSimulatorAgentCache('27.1')).toEqual({ xctestrun, sdk: '27.1', builtBy: CURRENT, current: CURRENT });
    expect(inspectSimulatorAgentCache('27.2')).toMatchObject({ stale: 'sdk' });
    fs.rmSync(path.join(cacheDir(), '.sdk-version'));
    expect(inspectSimulatorAgentCache('27.1')).toMatchObject({ stale: 'incomplete' });
  });

  it('without a build of its own, names the newest build another version left', async () => {
    const { inspectSimulatorAgentCache } = await resolve();
    const legacy = writeCache('27.1', null);
    expect(inspectSimulatorAgentCache('27.1')).toEqual({ xctestrun: legacy, sdk: '27.1', builtBy: undefined, current: CURRENT, stale: 'version' });
    const later = new Date(Date.now() + 60_000);
    const older = writeCache('26.5', '0.0.1-older');
    fs.utimesSync(older, later, later);
    expect(inspectSimulatorAgentCache('27.1')).toEqual({ xctestrun: older, sdk: '26.5', builtBy: '0.0.1-older', current: CURRENT, stale: 'version' });
  });

  it('names who built a stale cache', async () => {
    const { describeStaleSimulatorAgentCache } = await resolve();
    const base = { xctestrun: '/x', sdk: '27.1', current: '0.7.1', stale: 'version' as const };
    expect(describeStaleSimulatorAgentCache({ ...base, builtBy: '0.7.0' }))
      .toBe('the cached iOS simulator agent in ~/.tapsmith/ios-simulator-agent was built by Tapsmith 0.7.0 (this is 0.7.1)');
    expect(describeStaleSimulatorAgentCache({ ...base, builtBy: undefined }))
      .toContain('was built by an earlier Tapsmith version (this is 0.7.1)');
  });
});
