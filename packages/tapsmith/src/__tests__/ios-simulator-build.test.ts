import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ─── Mocks ──────────────────────────────────────────────────────────────

vi.mock('node:child_process');
vi.mock('node:fs');

const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mockResolve }),
}));

const { homedir } = vi.hoisted(() => ({
  homedir: vi.fn(() => '/Users/test'),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir };
});

// The host's arch, as host-arch.ts reports it (arm64 under Rosetta). Pinned,
// so these tests mean the same on an x64 CI runner.
const { hostArch } = vi.hoisted(() => ({
  hostArch: vi.fn(() => 'arm64'),
}));

vi.mock('../host-arch.js', async () => {
  const actual = await vi.importActual<typeof import('../host-arch.js')>('../host-arch.js');
  return { ...actual, hostArch, appleArch: (arch: string = hostArch()) => actual.appleArch(arch) };
});

const existsSync = vi.mocked(fs.existsSync);
const readdirSync = vi.mocked(fs.readdirSync);
const statSync = vi.mocked(fs.statSync);
const execFileSyncMock = vi.mocked(execFileSync);

// ─── extractSdkVersion (pure function, no mocks needed) ────────────────

// Static import is fine — extractSdkVersion does not touch fs/os/module.
import { extractSdkVersion, xctestrunArchs } from '../ios-device-resolve.js';

describe('extractSdkVersion()', () => {
  it('extracts SDK version from simulator xctestrun filename', () => {
    expect(extractSdkVersion(
      '/path/to/TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator18.5-arm64.xctestrun',
    )).toBe('18.5');
  });

  it('extracts SDK version from full path with nested dirs', () => {
    expect(extractSdkVersion(
      '/Users/sam/.tapsmith/ios-simulator-agent/TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun',
    )).toBe('26.0');
  });

  it('returns undefined for non-simulator xctestrun', () => {
    expect(extractSdkVersion(
      '/path/to/TapsmithAgentUITests_iphoneos26.4-arm64.xctestrun',
    )).toBeUndefined();
  });

  it('returns undefined for unrelated filenames', () => {
    expect(extractSdkVersion('/path/to/some-file.txt')).toBeUndefined();
  });
});

// ─── getInstalledSimulatorSdkVersion tests ──────────────────────────────

describe('getInstalledSimulatorSdkVersion()', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
  });

  it('returns SDK version from xcrun', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileSyncMock.mockReturnValue('26.0\n');
    const { getInstalledSimulatorSdkVersion } = await import('../ios-device-resolve.js');
    expect(getInstalledSimulatorSdkVersion()).toBe('26.0');
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });

  it('returns undefined when xcrun fails', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileSyncMock.mockImplementation(() => { throw new Error('xcrun not found'); });
    const { getInstalledSimulatorSdkVersion } = await import('../ios-device-resolve.js');
    expect(getInstalledSimulatorSdkVersion()).toBeUndefined();
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });

  it('returns undefined on non-darwin platforms', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { getInstalledSimulatorSdkVersion } = await import('../ios-device-resolve.js');
    expect(getInstalledSimulatorSdkVersion()).toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });
});

// ─── findSimulatorXctestrun SDK-aware resolution ────────────────────────

describe('findSimulatorXctestrun() SDK-aware resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSync.mockReset();
    readdirSync.mockReset();
    statSync.mockReset();
    mockResolve.mockReset();
    execFileSyncMock.mockReset();
    homedir.mockReturnValue('/Users/test');
    hostArch.mockReturnValue('arm64');
  });

  /**
   * Build a readdirSync mock backed by a simple dir → entries map.
   * Unknown directories throw ENOENT like the real fs would.
   */
  function mockDirs(dirs: Record<string, string[]>) {
    readdirSync.mockImplementation(((dir: string) => {
      const d = String(dir);
      if (d in dirs) return dirs[d];
      throw new Error('ENOENT');
    }// eslint-disable-next-line @typescript-eslint/no-explicit-any -- readdirSync overloads
) as any);
  }

  /** Entries for a products dir holding a complete runner app + xctest. */
  function productsDirs(parent: string): Record<string, string[]> {
    const products = path.join(parent, 'Debug-iphonesimulator');
    return {
      [products]: ['TapsmithAgentUITests-Runner.app'],
      [path.join(products, 'TapsmithAgentUITests-Runner.app', 'PlugIns')]: ['TapsmithAgentUITests.xctest'],
    };
  }

  it('prefers exact SDK match from npm package subdirectory', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const sdk26Dir = '/node_modules/@tapsmith/agent-ios-simulator-arm64/sdk-26.0';
    const xctestrun26 = 'TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun';

    mockDirs({
      '/node_modules/@tapsmith/agent-ios-simulator-arm64': ['sdk-18.5', 'sdk-26.0'],
      [sdk26Dir]: [xctestrun26, 'Debug-iphonesimulator'],
      ...productsDirs(sdk26Dir),
    });
    existsSync.mockImplementation((p) => String(p) === sdk26Dir);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(sdk26Dir, xctestrun26));
  });

  it('falls back to flat layout for backward compat with old packages', async () => {
    execFileSyncMock.mockReturnValue('18.5\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const pkgDir = '/node_modules/@tapsmith/agent-ios-simulator-arm64';
    const xctestrun = 'TapsmithAgentUITests_iphonesimulator18.5-arm64.xctestrun';

    mockDirs({
      [pkgDir]: [xctestrun, 'Debug-iphonesimulator'],
      ...productsDirs(pkgDir),
    });
    existsSync.mockReturnValue(false);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(pkgDir, xctestrun));
  });

  it('skips an xctestrun whose test products are missing (broken v0.1.3–v0.1.7 packages)', async () => {
    execFileSyncMock.mockReturnValue('26.4\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const sdkDir = '/node_modules/@tapsmith/agent-ios-simulator-arm64/sdk-26.4';

    // The broken packages shipped only the xctestrun — no Debug-iphonesimulator/.
    mockDirs({
      '/node_modules/@tapsmith/agent-ios-simulator-arm64': ['sdk-26.4'],
      [sdkDir]: ['TapsmithAgentUITests_iphonesimulator26.4-arm64.xctestrun'],
    });
    existsSync.mockImplementation((p) => String(p) === sdkDir);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    expect(findSimulatorXctestrun()).toBeUndefined();
  });

  it('falls through a broken SDK-matched subdir to a complete flat layout', async () => {
    execFileSyncMock.mockReturnValue('26.4\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const pkgDir = '/node_modules/@tapsmith/agent-ios-simulator-arm64';
    const sdkDir = path.join(pkgDir, 'sdk-26.4');
    const flatXctestrun = 'TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun';

    mockDirs({
      [pkgDir]: ['sdk-26.4', flatXctestrun, 'Debug-iphonesimulator'],
      [sdkDir]: ['TapsmithAgentUITests_iphonesimulator26.4-arm64.xctestrun'],
      ...productsDirs(pkgDir),
    });
    existsSync.mockImplementation((p) => String(p) === sdkDir);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    expect(findSimulatorXctestrun()).toBe(path.join(pkgDir, flatXctestrun));
  });

  it('skips a products dir whose runner app is missing the .xctest plugin', async () => {
    execFileSyncMock.mockReturnValue('26.4\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const sdkDir = '/node_modules/@tapsmith/agent-ios-simulator-arm64/sdk-26.4';
    const products = path.join(sdkDir, 'Debug-iphonesimulator');

    mockDirs({
      '/node_modules/@tapsmith/agent-ios-simulator-arm64': ['sdk-26.4'],
      [sdkDir]: ['TapsmithAgentUITests_iphonesimulator26.4-arm64.xctestrun', 'Debug-iphonesimulator'],
      [products]: ['TapsmithAgentUITests-Runner.app'],
      [path.join(products, 'TapsmithAgentUITests-Runner.app', 'PlugIns')]: [],
    });
    existsSync.mockImplementation((p) => String(p) === sdkDir);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    expect(findSimulatorXctestrun()).toBeUndefined();
  });

  /** This Tapsmith is 9.9.9, and its cache (PILOT-485: `<root>/9.9.9`) was built for SDK 26.0. */
  function mockCurrentCacheMarkers(): void {
    vi.mocked(fs.readFileSync).mockImplementation(((file: string) => {
      const f = String(file);
      if (f.endsWith('.sdk-version')) return '26.0';
      if (f.endsWith('package.json')) return JSON.stringify({ version: '9.9.9' });
      throw new Error('ENOENT');
    }// eslint-disable-next-line @typescript-eslint/no-explicit-any -- readFileSync overloads
    ) as any);
  }

  // ─── Host architecture (PILOT-559) ───

  it('looks for the arm64 package under Rosetta, not the x64 one npm installed', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    mockResolve.mockImplementation(() => { throw new Error('MODULE_NOT_FOUND'); });
    mockDirs({});
    existsSync.mockReturnValue(false);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    expect(findSimulatorXctestrun()).toBeUndefined();
    expect(mockResolve).toHaveBeenCalledWith('@tapsmith/agent-ios-simulator-arm64/package.json');
    expect(mockResolve).not.toHaveBeenCalledWith('@tapsmith/agent-ios-simulator-x64/package.json');
  });

  it('skips an x86_64 auto-build cache on an arm64 host, so the agent is rebuilt', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    mockCurrentCacheMarkers();
    mockResolve.mockImplementation(() => { throw new Error('MODULE_NOT_FOUND'); });
    const cacheDir = path.join('/Users/test', '.tapsmith', 'ios-simulator-agent', '9.9.9');
    mockDirs({
      [cacheDir]: ['TapsmithAgentUITests_iphonesimulator26.0-x86_64.xctestrun', 'Debug-iphonesimulator'],
      ...productsDirs(cacheDir),
    });
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    expect(findSimulatorXctestrun()).toBeUndefined();
  });

  it('keeps an arm64 or universal cache on an arm64 host, and an x86_64 one on an Intel Mac', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    mockCurrentCacheMarkers();
    mockResolve.mockImplementation(() => { throw new Error('MODULE_NOT_FOUND'); });
    const cacheDir = path.join('/Users/test', '.tapsmith', 'ios-simulator-agent', '9.9.9');
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');

    for (const [arch, name] of [
      ['arm64', 'TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun'],
      ['arm64', 'TapsmithAgentUITests_iphonesimulator26.0-arm64-x86_64.xctestrun'],
      ['x64', 'TapsmithAgentUITests_iphonesimulator26.0-x86_64.xctestrun'],
      ['arm64', 'TapsmithAgent.xctestrun'],
    ] as const) {
      hostArch.mockReturnValue(arch);
      mockDirs({ [cacheDir]: [name, 'Debug-iphonesimulator'], ...productsDirs(cacheDir) });
      expect(findSimulatorXctestrun(), `${arch} host, ${name}`).toBe(path.join(cacheDir, name));
    }
  });

  it('passes over an x86_64 build in a DerivedData scan on an arm64 host', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    mockResolve.mockImplementation(() => { throw new Error('MODULE_NOT_FOUND'); });
    const products = path.join('/Users/test', 'Library', 'Developer', 'Xcode', 'DerivedData', 'TapsmithAgent-abc', 'Build', 'Products');
    mockDirs({
      [path.join('/Users/test', 'Library', 'Developer', 'Xcode', 'DerivedData')]: ['TapsmithAgent-abc'],
      [products]: ['TapsmithAgentUITests_iphonesimulator26.0-x86_64.xctestrun', 'Debug-iphonesimulator'],
      ...productsDirs(products),
    });
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    expect(findSimulatorXctestrun()).toBeUndefined();
  });
});

describe('xctestrunArchs()', () => {
  it('reads the architectures from the file name', () => {
    expect(xctestrunArchs('/x/T_iphonesimulator26.0-arm64.xctestrun')).toEqual(['arm64']);
    expect(xctestrunArchs('/x/T_iphonesimulator26.0-x86_64.xctestrun')).toEqual(['x86_64']);
    expect(xctestrunArchs('/x/T_iphonesimulator26.0-arm64-x86_64.xctestrun')).toEqual(['arm64', 'x86_64']);
    expect(xctestrunArchs('/x/TapsmithAgent.xctestrun')).toBeUndefined();
  });
});
