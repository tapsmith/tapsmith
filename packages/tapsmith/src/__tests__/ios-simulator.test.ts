import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, tmpdir: vi.fn(() => '/tmp') };
});
// Stub proper-lockfile so manifest tests don't touch the real filesystem.
// The locking is verified in production; here we just want the manifest
// read/write logic to run as if the lock were held.
vi.mock('proper-lockfile', () => ({
  default: {
    lockSync: vi.fn(() => () => { /* no-op release */ }),
    unlockSync: vi.fn(),
  },
}));

// Simulators other live Tapsmith sessions hold (PILOT-381), by UDID. Plain
// functions, not vi.fn: `resetAllMocks` below would wipe their behaviour.
const claims = vi.hoisted(() => ({ held: new Set<string>(), claimedMeanwhile: new Set<string>(), heldAfterFirstLook: new Set<string>(), looks: 0 }));
vi.mock('../device-claims.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-claims.js')>();
  const holder = (device: string) => ({
    device,
    session: { id: 'other', pid: 1, command: 'tapsmith test --ui', project: '/elsewhere', startedAt: '2026-01-01T00:00:00Z' },
    claimantPid: 1,
    claimedAt: '2026-01-01T00:00:00Z',
  });
  return {
    ...actual,
    devicesHeldElsewhere: () => new Set([...claims.held, ...(claims.looks++ > 0 ? claims.heldAfterFirstLook : [])]),
    // `claimedMeanwhile`: claimed by another session after the snapshot above.
    claimDevice: (device: string) => (claims.held.has(device) || claims.claimedMeanwhile.has(device)
      ? { ok: false, holder: holder(device) }
      : { ok: true, fresh: true }),
    withoutHeldDevices: (candidates: readonly string[]) => ({
      free: candidates.filter((d) => !claims.held.has(d)),
      held: candidates.filter((d) => claims.held.has(d)).map(holder),
    }),
  };
});

const bundleMatch = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, result: true }));
vi.mock('../app-bundle-match.js', () => ({
  appBundlesMatch: (installed: string, candidate: string) => {
    bundleMatch.calls.push([installed, candidate]);
    return Promise.resolve(bundleMatch.result);
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFileSync signatures make proper mock typing impractical
const mockedExecFileSync = vi.mocked(childProcess.execFileSync) as any;
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedExistsSync = vi.mocked(fs.existsSync);

// Import after mocks are set up
import {
  listSimulators,
  listBootedSimulators,
  listAdoptableBootedSimulators,
  bootSimulator,
  waitForSimulatorBootComplete,
  installApp,
  isAppInstalled,
  installedAppMatches,
  installAppIfAbsent,
  findSimulator,
  provisionSimulator,
  createSimulator,
  cloneSimulator,
  deleteSimulator,
  probeSimulatorHealth,
  filterHealthySimulators,
  cleanupStaleSimulators,
  killAgentRunnersForSimulators,
  recordClonedSimulators,
  unrecordSimulators,
  provisionSimulators,
  getSimulatorScreenScale,
} from '../ios-simulator.js';
import type { SimulatorInfo } from '../ios-simulator.js';

// ─── Fixtures ───

function makeSimctlOutput(sims: Array<Partial<SimulatorInfo & { deviceTypeIdentifier?: string }>>): string {
  const devices: Record<string, unknown[]> = {};
  for (const s of sims) {
    const runtime = s.runtime ?? 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
    if (!devices[runtime]) devices[runtime] = [];
    devices[runtime].push({
      udid: s.udid ?? 'AAAA-1111',
      name: s.name ?? 'iPhone 16',
      state: s.state ?? 'Booted',
      isAvailable: s.isAvailable ?? true,
      deviceTypeIdentifier: s.deviceTypeIdentifier ?? s.deviceType ?? '',
    });
  }
  return JSON.stringify({ devices });
}

function mockListSimulators(sims: Array<Partial<SimulatorInfo>>): void {
  mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
      return makeSimctlOutput(sims);
    }
    return '';
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  claims.held.clear();
  claims.claimedMeanwhile.clear();
  claims.heldAfterFirstLook.clear();
  claims.looks = 0;
  // Default: manifest doesn't exist (readFileSync throws), but pretend the
  // file exists on disk so ensureManifestFile() skips its initialization
  // write — keeping the first writeFileSync call as the actual data write
  // so existing assertions on calls[0] still hold.
  mockedReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  mockedExistsSync.mockReturnValue(true);
});

// ─── listSimulators ───

describe('listSimulators', () => {
  it('parses simctl JSON output', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16', state: 'Booted' },
      { udid: 'B', name: 'iPhone 16 Pro', state: 'Shutdown' },
    ]);

    const result = listSimulators();
    expect(result).toHaveLength(2);
    expect(result[0].udid).toBe('A');
    expect(result[1].state).toBe('Shutdown');
  });

  it('filters out unavailable simulators', () => {
    mockListSimulators([
      { udid: 'A', isAvailable: true },
      { udid: 'B', isAvailable: false },
    ]);

    const result = listSimulators();
    expect(result).toHaveLength(1);
    expect(result[0].udid).toBe('A');
  });

  it('returns empty array on simctl failure', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('simctl not found'); });
    expect(listSimulators()).toEqual([]);
  });

  it('returns empty array on malformed JSON', () => {
    mockedExecFileSync.mockReturnValue('not json' as unknown as Buffer);
    expect(listSimulators()).toEqual([]);
  });
});

// ─── listBootedSimulators ───

describe('listBootedSimulators', () => {
  it('returns only booted simulators', () => {
    mockListSimulators([
      { udid: 'A', state: 'Booted' },
      { udid: 'B', state: 'Shutdown' },
      { udid: 'C', state: 'Booted' },
    ]);

    const result = listBootedSimulators();
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.udid)).toEqual(['A', 'C']);
  });
});

// ─── listAdoptableBootedSimulators ───

describe('listAdoptableBootedSimulators (PILOT-511)', () => {
  it('leaves a booted simulator of another name alone', () => {
    mockListSimulators([
      { udid: 'OTHER', name: 'iPhone 17', state: 'Booted' },
      { udid: 'WANTED', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ]);

    expect(listAdoptableBootedSimulators('iPhone 17 Pro')).toEqual([]);
  });

  it('adopts only the booted simulators named in config, and Tapsmith\'s clones of them', () => {
    mockListSimulators([
      { udid: 'OTHER', name: 'iPhone 17', state: 'Booted' },
      { udid: 'OTHER_CLONE', name: 'iPhone 17 (Tapsmith Worker 1)', state: 'Booted' },
      { udid: 'MAX_CLONE', name: 'iPhone 17 Pro Max (Tapsmith Worker 1)', state: 'Booted' },
      { udid: 'LOOKALIKE', name: 'iPhone 17 Pro (Tapsmith Worker 1) copy', state: 'Booted' },
      { udid: 'WANTED', name: 'iPhone 17 Pro', state: 'Booted' },
      { udid: 'CLONE', name: 'iPhone 17 Pro (Tapsmith Worker 12)', state: 'Booted' },
    ]);

    expect(listAdoptableBootedSimulators('iPhone 17 Pro').map((s) => s.udid)).toEqual(['WANTED', 'CLONE']);
  });

  it('adopts booted clones while the configured simulator is shut down, keeping their runtime', () => {
    // The clones anchor the runtime: provisioning then boots or clones only
    // on that one, rather than any runtime with a same-named device.
    mockListSimulators([
      { udid: 'SOURCE', name: 'iPhone 17 Pro', state: 'Shutdown', runtime: 'iOS-26-1' },
      { udid: 'CLONE', name: 'iPhone 17 Pro (Tapsmith Worker 1)', state: 'Booted', runtime: 'iOS-26-4' },
    ]);

    expect(listAdoptableBootedSimulators('iPhone 17 Pro').map((s) => s.udid)).toEqual(['CLONE']);
  });

  it('matches a configured UDID', () => {
    mockListSimulators([
      { udid: 'OTHER', name: 'iPhone 17', state: 'Booted' },
      { udid: 'WANTED', name: 'iPhone 17 Pro', state: 'Booted' },
    ]);

    expect(listAdoptableBootedSimulators('WANTED').map((s) => s.udid)).toEqual(['WANTED']);
  });

  it('keeps to the runtime of the first match', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-4' },
      { udid: 'B', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-1' },
      { udid: 'C', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-4' },
    ]);

    expect(listAdoptableBootedSimulators('iPhone 17 Pro').map((s) => s.udid)).toEqual(['A', 'C']);
  });

  it('restricts to `among`, in its order, and anchors the runtime there', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-4' },
      { udid: 'B', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-1' },
      { udid: 'C', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-1' },
      { udid: 'X', name: 'iPhone 17', state: 'Booted', runtime: 'iOS-26-1' },
    ]);

    const result = listAdoptableBootedSimulators('iPhone 17 Pro', { among: ['X', 'C', 'B'] });
    expect(result.map((s) => s.udid)).toEqual(['C', 'B']);
  });

  it('anchors the runtime on `compatibleWith`, even when that one is not a match', () => {
    mockListSimulators([
      { udid: 'PRIMARY', name: 'My Pinned Sim', state: 'Booted', runtime: 'iOS-26-1' },
      { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-4' },
      { udid: 'B', name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-1' },
    ]);

    const result = listAdoptableBootedSimulators('iPhone 17 Pro', { compatibleWith: 'PRIMARY' });
    expect(result.map((s) => s.udid)).toEqual(['B']);
  });

  it('adopts nothing when `compatibleWith` is not booted', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted' },
    ]);

    expect(listAdoptableBootedSimulators('iPhone 17 Pro', { compatibleWith: 'MISSING' })).toEqual([]);
  });
});

// ─── bootSimulator ───

describe('bootSimulator', () => {
  it('calls simctl boot', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    bootSimulator('AAAA');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'xcrun', ['simctl', 'boot', 'AAAA'],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('ignores already-booted error', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Unable to boot device in current state: Booted'), {
        stderr: Buffer.from(''),
      });
    });
    expect(() => bootSimulator('AAAA')).not.toThrow();
  });

  it('throws on real boot errors', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Device not found'), { stderr: Buffer.from('') });
    });
    expect(() => bootSimulator('AAAA')).toThrow('Device not found');
  });
});

// ─── waitForSimulatorBootComplete ───

describe('waitForSimulatorBootComplete', () => {
  it('blocks on simctl bootstatus -b and reports completion', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    expect(waitForSimulatorBootComplete('AAAA', 5_000)).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'xcrun', ['simctl', 'bootstatus', 'AAAA', '-b'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('reports false instead of throwing when the wait times out', () => {
    mockedExecFileSync.mockImplementation(() => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
    expect(waitForSimulatorBootComplete('AAAA', 5_000)).toBe(false);
  });
});

// ─── installApp / isAppInstalled ───

describe('installApp', () => {
  it('calls simctl install', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    installApp('AAAA', '/path/to/App.app');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'xcrun', ['simctl', 'install', 'AAAA', '/path/to/App.app'],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });
});

describe('isAppInstalled', () => {
  it('returns true when get_app_container succeeds', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    expect(isAppInstalled('AAAA', 'com.example')).toBe(true);
  });

  it('returns false when get_app_container fails', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('not installed'); });
    expect(isAppInstalled('AAAA', 'com.example')).toBe(false);
  });
});

describe('installedAppMatches', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFile signatures make proper mock typing impractical
  const mockedExecFile = vi.mocked(childProcess.execFile) as any;
  const container = '/sims/AAAA/data/Containers/Bundle/Application/X/App.app';

  beforeEach(() => {
    bundleMatch.calls = [];
    bundleMatch.result = true;
  });

  function containerLookup(outcome: { stdout?: string, err?: Error }) {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(outcome.err ?? null, outcome.stdout ?? '');
    });
  }

  // PILOT-913: the whole bundle is compared, not only CFBundleExecutable,
  // which a Debug build's stub executable keeps identical across rebuilds.
  it('compares the installed bundle at its container with the candidate bundle', async () => {
    containerLookup({ stdout: `${container}\n` });
    expect(await installedAppMatches('AAAA', 'com.example', '/build/App.app')).toBe(true);
    expect(mockedExecFile).toHaveBeenCalledWith(
      'xcrun', ['simctl', 'get_app_container', 'AAAA', 'com.example', 'app'],
      expect.objectContaining({ timeout: 10_000 }), expect.any(Function),
    );
    expect(bundleMatch.calls).toEqual([[container, '/build/App.app']]);
  });

  it('reports a differing bundle as not matching', async () => {
    containerLookup({ stdout: container });
    bundleMatch.result = false;
    expect(await installedAppMatches('AAAA', 'com.example', '/build/App.app')).toBe(false);
  });

  it('reports no match when the container lookup fails or prints nothing', async () => {
    containerLookup({ err: new Error('not installed') });
    expect(await installedAppMatches('AAAA', 'com.example', '/build/App.app')).toBe(false);
    containerLookup({ stdout: '  \n' });
    expect(await installedAppMatches('AAAA', 'com.example', '/build/App.app')).toBe(false);
    expect(bundleMatch.calls).toEqual([]);
  });
});

// ─── findSimulator ───

describe('findSimulator', () => {
  it('finds by exact UDID', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16' },
      { udid: 'B', name: 'iPhone 16 Pro' },
    ]);

    expect(findSimulator('B')?.name).toBe('iPhone 16 Pro');
  });

  it('finds by name, preferring booted', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16', state: 'Shutdown' },
      { udid: 'B', name: 'iPhone 16', state: 'Booted' },
    ]);

    expect(findSimulator('iPhone 16')?.udid).toBe('B');
  });

  it('returns first match when none are booted', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16', state: 'Shutdown' },
      { udid: 'B', name: 'iPhone 16', state: 'Shutdown' },
    ]);

    expect(findSimulator('iPhone 16')?.udid).toBe('A');
  });

  it('returns undefined when no match', () => {
    mockListSimulators([]);
    expect(findSimulator('iPhone 99')).toBeUndefined();
  });
});

// ─── provisionSimulator ───

describe('provisionSimulator', () => {
  it('boots a shutdown simulator and waits for the boot, without installing the app (PILOT-496)', () => {
    // The session installs the app itself (asynchronously, and it decides
    // whether the install was a fresh one). Installing here as well blocked
    // the boot step, and left a pristine CI simulator looking as if it
    // already held the app — so the startup launch cleared its data and
    // restarted it for nothing.
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      calls.push([cmd as string, ...a]);
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([{ udid: 'A', name: 'iPhone 16', state: 'Shutdown' }]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    expect(provisionSimulator('iPhone 16')).toEqual({ udid: 'A', bootComplete: true });
    const simctl = calls.filter((c) => c[0] === 'xcrun' && c[1] === 'simctl').map((c) => c[2]);
    expect(simctl).toEqual(['list', 'boot', 'bootstatus']);
    expect(calls.find((c) => c[2] === 'bootstatus')).toEqual(['xcrun', 'simctl', 'bootstatus', 'A', '-b']);
  });

  it('still returns the simulator when the boot wait times out', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
        return makeSimctlOutput([{ udid: 'A', name: 'iPhone 16', state: 'Shutdown' }]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && args?.[1] === 'bootstatus') throw new Error('ETIMEDOUT');
      return '' as unknown as Buffer;
    });

    // Reported, so the caller does not trust what a still-booting simulator
    // says about its installed apps.
    expect(provisionSimulator('iPhone 16')).toEqual({ udid: 'A', bootComplete: false });
  });

  it('does not boot a simulator found booted, but still waits for its boot to finish', () => {
    // Another process may have just booted it; a simulator still settling
    // can report an installed app as absent.
    const simctl: string[] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl') simctl.push(args[1]);
      if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
        return makeSimctlOutput([{ udid: 'B', name: 'iPhone 16', state: 'Booted' }]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    expect(provisionSimulator('iPhone 16')).toEqual({ udid: 'B', bootComplete: true });
    expect(simctl).toEqual(['list', 'bootstatus']);
  });

  it('throws when no simulator matches after exhausting lookup retries', () => {
    let listCalls = 0;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
        listCalls++;
        return makeSimctlOutput([]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    expect(() => provisionSimulator('iPhone 99', { attempts: 3, delayMs: 1 }))
      .toThrow(/No iOS simulator found/);
    expect(listCalls).toBe(3);
  });

  it('says Xcode is missing, not "run xcrun simctl", when no simulator is found on a Mac without it (PILOT-558)', () => {
    const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...savedPlatform, value: 'darwin' });
    try {
      mockedExecFileSync.mockImplementation((cmd: string) => {
        // Only the command-line tools: xcrun has no simctl, xcodebuild refuses.
        if (cmd === 'xcrun' || cmd === 'xcodebuild') throw new Error('requires Xcode');
        return '' as unknown as Buffer;
      });
      let message = '';
      try {
        provisionSimulator('iPhone 17', { attempts: 1, delayMs: 1 });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^Xcode is not installed, so there are no iOS simulators: Install Xcode .*xcode-select -s/);
      expect(message).not.toContain('xcrun simctl list');
    } finally {
      Object.defineProperty(process, 'platform', savedPlatform);
    }
  });

  it('keeps the simctl advice when Xcode is installed and the simulator is just missing', () => {
    const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...savedPlatform, value: 'darwin' });
    try {
      mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'xcrun' && args?.[1] === 'list') return makeSimctlOutput([]) as unknown as Buffer;
        return '' as unknown as Buffer;
      });
      expect(() => provisionSimulator('iPhone 99', { attempts: 1, delayMs: 1 }))
        .toThrow("No iOS simulator found matching 'iPhone 99'. Run 'xcrun simctl list devices' to see available simulators.");
    } finally {
      Object.defineProperty(process, 'platform', savedPlatform);
    }
  });

  it('retries the lookup when simctl transiently returns no devices', () => {
    // CoreSimulator under load can fail or return an empty set for a beat —
    // the simulator "reappears" on the next list (seen on CI as a fatal
    // "No iOS simulator found" minutes after that exact sim was booted).
    let listCalls = 0;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
        listCalls++;
        if (listCalls === 1) throw new Error('Failed to load CoreSimulatorService');
        return makeSimctlOutput([{ udid: 'B', name: 'iPhone 17', state: 'Booted' }]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    expect(provisionSimulator('iPhone 17', { attempts: 4, delayMs: 1 }).udid).toBe('B');
    expect(listCalls).toBe(2);
  });
});

// ─── installAppIfAbsent ───

describe('installAppIfAbsent (PILOT-496)', () => {
  /** How execFileSync fails when the command exits non-zero. */
  const exited = (status: number) => Object.assign(new Error(`exit ${status}`), { status, signal: null });
  /** How execFileSync fails when it kills a command at its timeout. */
  const timedOut = () => Object.assign(new Error('ETIMEDOUT'), { status: null, signal: 'SIGTERM' });

  it('installs an app the simulator lacks and reports a fresh install', () => {
    const simctl: string[] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl') simctl.push(args[1]);
      if (args?.[1] === 'get_app_container') throw exited(2);
      return '' as unknown as Buffer;
    });
    expect(installAppIfAbsent('A', '/app.app', 'com.example.app')).toEqual({ installed: true, outcome: 'installed' });
    expect(simctl).toEqual(['get_app_container', 'install']);
  });

  it('leaves an installed app to the session, which checks the build', () => {
    const simctl: string[] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl') simctl.push(args[1]);
      return '' as unknown as Buffer;
    });
    expect(installAppIfAbsent('A', '/app.app', 'com.example.app')).toEqual({ installed: false, outcome: 'already installed' });
    expect(simctl).toEqual(['get_app_container']);
  });

  it('does not install when the lookup times out: the app may be there, with data', () => {
    // Installing over it keeps the data; reporting that as fresh would skip
    // the startup clear and run the first test against stale state.
    const simctl: string[] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl') simctl.push(args[1]);
      if (args?.[1] === 'get_app_container') throw timedOut();
      return '' as unknown as Buffer;
    });
    expect(installAppIfAbsent('A', '/app.app', 'com.example.app')).toEqual({
      installed: false, outcome: 'could not tell whether it is installed (lookup timed out)',
    });
    expect(simctl).toEqual(['get_app_container']);
  });

  it('does not install when the lookup fails for another reason (simulator not ready)', () => {
    const simctl: string[] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && args?.[0] === 'simctl') simctl.push(args[1]);
      if (args?.[1] === 'get_app_container') throw exited(149);
      return '' as unknown as Buffer;
    });
    expect(installAppIfAbsent('A', '/app.app', 'com.example.app')).toEqual({
      installed: false, outcome: 'could not tell whether it is installed (simctl exit 149)',
    });
    expect(simctl).toEqual(['get_app_container']);
  });

  it('reports no install when every install attempt fails, so the session installs it', () => {
    mockedExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[1] === 'get_app_container') throw exited(2);
      if (args?.[1] === 'install') throw new Error('installd not ready');
      return '' as unknown as Buffer;
    });
    expect(installAppIfAbsent('A', '/app.app', 'com.example.app')).toEqual({
      installed: false, outcome: 'install failed (installd not ready)',
    });
  }, 15_000);
});

// ─── createSimulator / cloneSimulator / deleteSimulator ───

describe('createSimulator', () => {
  it('returns the new UDID', () => {
    mockedExecFileSync.mockReturnValue('NEW-UDID\n' as unknown as Buffer);
    expect(createSimulator('Test', 'type', 'runtime')).toBe('NEW-UDID');
  });
});

describe('cloneSimulator', () => {
  it('returns the cloned UDID', () => {
    mockedExecFileSync.mockReturnValue('CLONE-UDID\n' as unknown as Buffer);
    expect(cloneSimulator('SOURCE', 'Clone Name')).toBe('CLONE-UDID');
  });
});

describe('deleteSimulator', () => {
  it('shuts down then deletes', () => {
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd as string, ...(args as string[])]);
      return '' as unknown as Buffer;
    });

    deleteSimulator('AAAA');
    const ops = calls.filter((c) => c[0] === 'xcrun').map((c) => c[2]);
    expect(ops).toEqual(['shutdown', 'delete']);
  });

  it('does not throw on failure', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(() => deleteSimulator('AAAA')).not.toThrow();
  });
});

// ─── probeSimulatorHealth ───

describe('probeSimulatorHealth', () => {
  it('returns healthy for booted sim with responsive launchd', () => {
    mockListSimulators([{ udid: 'A', state: 'Booted' }]);
    // Allow launchctl to succeed
    const origImpl = mockedExecFileSync.getMockImplementation()!;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'xcrun' && (args as string[])?.[1] === 'spawn') {
        return '' as unknown as Buffer;
      }
      return origImpl(cmd, args, opts);
    });

    expect(probeSimulatorHealth('A')).toEqual({ udid: 'A', healthy: true });
  });

  it('returns unhealthy when sim does not exist', () => {
    mockListSimulators([]);
    const result = probeSimulatorHealth('MISSING');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('no longer exists');
  });

  it('returns unhealthy when sim is shutdown', () => {
    mockListSimulators([{ udid: 'A', state: 'Shutdown' }]);
    const result = probeSimulatorHealth('A');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('Shutdown');
  });
});

// ─── filterHealthySimulators ───

describe('filterHealthySimulators', () => {
  it('separates healthy from unhealthy', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'xcrun' && (args as string[])?.[0] === 'simctl' && (args as string[])?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', state: 'Booted' },
          { udid: 'B', state: 'Shutdown' },
        ]) as unknown as Buffer;
      }
      // Let launchctl succeed for Booted sim
      return '' as unknown as Buffer;
    });

    const result = filterHealthySimulators(['A', 'B']);
    expect(result.healthyUdids).toEqual(['A']);
    expect(result.unhealthySimulators).toHaveLength(1);
    expect(result.unhealthySimulators[0].udid).toBe('B');
  });
});

// ─── Manifest ───

describe('simulator manifest', () => {
  it('recordClonedSimulators writes entries to manifest', () => {
    mockedReadFileSync.mockReturnValue('[]');
    recordClonedSimulators(
      [{ udid: 'X', name: 'Clone 1', cloned: true }],
      'iPhone 16',
    );
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].udid).toBe('X');
    expect(written[0].sourceName).toBe('iPhone 16');
  });

  it('recordClonedSimulators skips duplicate UDIDs', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'X', name: 'Clone 1', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));
    recordClonedSimulators(
      [{ udid: 'X', name: 'Clone 1', cloned: true }],
      'iPhone 16',
    );
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1); // not duplicated
  });

  it('unrecordSimulators removes entries by UDID', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'A', name: 'C1', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
      { udid: 'B', name: 'C2', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));
    unrecordSimulators(['A']);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].udid).toBe('B');
  });

  it('handles missing manifest gracefully', () => {
    mockedReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    recordClonedSimulators(
      [{ udid: 'X', name: 'Clone', cloned: true }],
      'iPhone 16',
    );
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
  });
});

// ─── cleanupStaleSimulators ───

describe('cleanupStaleSimulators', () => {
  it('deletes unhealthy manifest entries and keeps healthy ones', () => {
    // Manifest has two entries: A (healthy, booted) and B (doesn't exist)
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'A', name: 'C1', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
      { udid: 'B', name: 'C2', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));

    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', state: 'Booted', name: 'C1' },
          // B intentionally missing — simulates deleted sim
        ]) as unknown as Buffer;
      }
      // launchctl check succeeds
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.reusable).toEqual(['A']);
    expect(result.killed).toContain('B');
  });

  it('deletes orphaned Tapsmith Worker sims not in manifest', () => {
    mockedReadFileSync.mockReturnValue('[]');
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'ORPHAN', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted' },
        ]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.killed).toContain('ORPHAN');
  });

  // Phase 1's view of the manifest is as old as the sweep, and its lock is
  // released before phase 2 deletes anything. A run that clones a worker in
  // between records it immediately — and this is what stops the sweep deleting
  // that live simulator on the strength of a snapshot taken before it existed.
  it('spares a worker recorded after the sweep read the manifest', () => {
    const recordedLater = JSON.stringify([
      { udid: 'FRESH', name: 'iPhone 16 (Tapsmith Worker 1)', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]);
    // Phase 1 and the concurrent-additions re-read both see an empty manifest;
    // by the time phase 2 checks, the other run has recorded its clone.
    mockedReadFileSync
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('[]')
      .mockReturnValue(recordedLater);
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'FRESH', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted' },
        ]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.killed).not.toContain('FRESH');
  });

  it('skips manifest entries for different simulator names', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'OTHER', name: 'C1', sourceName: 'iPad Pro', createdAt: '2026-01-01' },
    ]));

    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.reusable).toEqual([]);
    expect(result.killed).toEqual([]);
    // Manifest should still contain the iPad Pro entry
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].sourceName).toBe('iPad Pro');
  });
});

// ─── killAgentRunnersForSimulators ───

describe('killAgentRunnersForSimulators', () => {
  it('kills all runners in one pkill (regex alternation) then terminates each agent', () => {
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd as string, ...(args as string[])]);
      return '' as unknown as Buffer;
    });

    killAgentRunnersForSimulators(['UDID-1', 'UDID-2']);

    // Single pkill batches both UDIDs; simctl terminate stays per-UDID.
    expect(calls).toEqual([
      ['pkill', '-f', 'xcodebuild.*test-without-building.*id=(UDID-1|UDID-2)'],
      ['xcrun', 'simctl', 'terminate', 'UDID-1', 'dev.tapsmith.agent.xctrunner'],
      ['xcrun', 'simctl', 'terminate', 'UDID-2', 'dev.tapsmith.agent.xctrunner'],
    ]);
  });

  it('does not throw when no matching process exists', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('no matching process'); });
    expect(() => killAgentRunnersForSimulators(['UDID-1'])).not.toThrow();
  });

  it('is a no-op for an empty udid list', () => {
    const spy = mockedExecFileSync.mockImplementation(() => '' as unknown as Buffer);
    killAgentRunnersForSimulators([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips empty/falsy udids so the pkill pattern never matches every runner', () => {
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd as string, ...(args as string[])]);
      return '' as unknown as Buffer;
    });

    killAgentRunnersForSimulators(['', 'UDID-1']);

    // No bare `id=()` pattern (would match unrelated xcodebuild runners); only UDID-1 acted on.
    expect(calls.some((c) => c.includes('xcodebuild.*test-without-building.*id=()'))).toBe(false);
    expect(calls).toEqual([
      ['pkill', '-f', 'xcodebuild.*test-without-building.*id=(UDID-1)'],
      ['xcrun', 'simctl', 'terminate', 'UDID-1', 'dev.tapsmith.agent.xctrunner'],
    ]);
  });
});

// ─── provisionSimulators (multi-worker) ───

describe('provisionSimulators', () => {
  it('returns existing UDIDs when workers already satisfied', () => {
    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['A', 'B'],
    });
    expect(result.allUdids).toEqual(['A', 'B']);
    expect(result.clonedSimulators).toEqual([]);
  });

  it('reuses healthy clones from previous runs', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted' },
          { udid: 'REUSE', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted' },
        ]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    // Manifest has the reusable clone
    mockedReadFileSync.mockReturnValue('[]');
    const progress: string[] = [];

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['PRIMARY'],
      reusableUdids: ['REUSE'],
      onProgress: (message) => progress.push(message),
    });

    expect(result.allUdids).toContain('PRIMARY');
    expect(result.allUdids).toContain('REUSE');
    expect(result.reusedUdids).toEqual(['REUSE']);
    expect(progress).toEqual(['Reusing simulator REUSE (iPhone 16 (Tapsmith Worker 1)) from previous run.']);
  });

  it('does not call a booted same-name simulator a previous run\'s (PILOT-511)', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted' },
          { udid: 'B', name: 'iPhone 16', state: 'Booted' },
        ]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');
    const progress: string[] = [];

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['PRIMARY'],
      onProgress: (message) => progress.push(message),
    });

    expect(result.allUdids).toEqual(['PRIMARY', 'B']);
    expect(progress).toEqual(['Reusing already-booted simulator B (iPhone 16).']);
  });

  it('boots shutdown simulators when not enough booted', () => {
    let bootCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', name: 'iPhone 16', state: 'Booted' },
          { udid: 'B', name: 'iPhone 16', state: 'Shutdown' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'boot') {
        bootCalled = true;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['A'],
    });

    expect(result.allUdids).toHaveLength(2);
    expect(bootCalled).toBe(true);
    expect(result.freshUdids.has('B')).toBe(true);
  });

  it('creates new simulator when only matching sim is in existingUdids', () => {
    let createCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', name: 'iPhone 16', state: 'Booted', deviceType: 'com.apple.iPhone-16' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'create') {
        createCalled = true;
        return 'NEW-UDID\n' as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['A'],
    });

    expect(createCalled).toBe(true);
    expect(result.clonedSimulators).toHaveLength(1);
    expect(result.clonedSimulators[0].udid).toBe('NEW-UDID');
    expect(result.allUdids).toEqual(['A', 'NEW-UDID']);
  });

  it('clones from shutdown source when available', () => {
    let cloneCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', name: 'iPhone 16', state: 'Booted' },
          { udid: 'B', name: 'iPhone 16', state: 'Shutdown' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'clone') {
        cloneCalled = true;
        return 'CLONED-UDID\n' as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    // A and B are already assigned; need a 3rd worker
    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 3,
      existingUdids: ['A'],
    });

    expect(cloneCalled).toBe(true);
    expect(result.clonedSimulators.length).toBeGreaterThan(0);
  });

  it('skips reusable clones with mismatched runtime', () => {
    let deleteCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted', runtime: 'iOS-26-4' },
          { udid: 'STALE', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted', runtime: 'iOS-26-1' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'delete') {
        deleteCalled = true;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['PRIMARY'],
      reusableUdids: ['STALE'],
    });

    expect(deleteCalled).toBe(true);
    expect(result.allUdids).not.toContain('STALE');
  });
});

// ─── getSimulatorScreenScale ───

describe('getSimulatorScreenScale', () => {
  it('returns 3 for iPhones', () => {
    mockListSimulators([{ udid: 'PHONE-1', name: 'iPhone 16' }]);
    expect(getSimulatorScreenScale('PHONE-1')).toBe(3);
  });

  it('returns 2 for iPads', () => {
    mockListSimulators([{ udid: 'PAD-1', name: 'iPad Pro (13-inch)' }]);
    expect(getSimulatorScreenScale('PAD-1')).toBe(2);
  });

  it('returns 3 for unknown UDIDs', () => {
    mockListSimulators([]);
    expect(getSimulatorScreenScale('UNKNOWN')).toBe(3);
  });
});

// ─── Device claims (PILOT-381) ───

describe('simulators another live Tapsmith session holds', () => {
  function simctl(sims: Array<Partial<SimulatorInfo>>, calls: string[][] = []): void {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd, ...(args ?? [])]);
      if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
        return makeSimctlOutput(sims) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
  }

  it('are not adoptable', () => {
    simctl([
      { udid: 'HELD', name: 'iPhone 17 Pro', state: 'Booted' },
      { udid: 'HELD_CLONE', name: 'iPhone 17 Pro (Tapsmith Worker 1)', state: 'Booted' },
      { udid: 'FREE_CLONE', name: 'iPhone 17 Pro (Tapsmith Worker 2)', state: 'Booted' },
    ]);
    claims.held = new Set(['HELD', 'HELD_CLONE']);
    expect(listAdoptableBootedSimulators('iPhone 17 Pro').map((s) => s.udid)).toEqual(['FREE_CLONE']);
  });

  it('are passed over by name for a free one of the same name', () => {
    const calls: string[][] = [];
    simctl([
      { udid: 'HELD', name: 'iPhone 16', state: 'Booted' },
      { udid: 'FREE', name: 'iPhone 16', state: 'Shutdown' },
    ], calls);
    claims.held = new Set(['HELD']);
    expect(provisionSimulator('iPhone 16').udid).toBe('FREE');
    expect(calls.some((c) => c[2] === 'boot' && c[3] === 'FREE')).toBe(true);
  });

  it('are refused by name, naming the holder, when every one of that name is held', () => {
    simctl([{ udid: 'HELD', name: 'iPhone 16', state: 'Booted' }]);
    claims.held = new Set(['HELD']);
    expect(() => provisionSimulator('iPhone 16', { attempts: 3, delayMs: 0 }))
      .toThrow(/Device HELD is in use by another Tapsmith session: `tapsmith test --ui`/);
  });

  it('are neither reused nor deleted by the stale-clone sweep', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'HELD_CLONE', name: 'iPhone 16 (Tapsmith Worker 1)', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));
    const calls: string[][] = [];
    simctl([
      { udid: 'HELD_CLONE', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted' },
      { udid: 'HELD_ORPHAN', name: 'iPhone 16 (Tapsmith Worker 2)', state: 'Booted' },
    ], calls);
    claims.held = new Set(['HELD_CLONE', 'HELD_ORPHAN']);

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result).toEqual({ reusable: [], killed: [] });
    expect(calls.some((c) => c[2] === 'delete' || c[2] === 'shutdown')).toBe(false);
    // Still recorded: its owner's clone stays in the manifest.
    const written = JSON.parse(String(mockedWriteFileSync.mock.calls.at(-1)?.[1] ?? '[]')) as Array<{ udid: string }>;
    expect(written.map((e) => e.udid)).toContain('HELD_CLONE');
  });

  it('are not taken, pruned or shut down as a clone source by provisioning', () => {
    const calls: string[][] = [];
    simctl([
      { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted' },
      { udid: 'HELD', name: 'iPhone 16', state: 'Booted' },
      { udid: 'HELD_REUSE', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted' },
    ], calls);
    mockedReadFileSync.mockReturnValue('[]');
    claims.held = new Set(['HELD', 'HELD_REUSE']);

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['PRIMARY'],
      reusableUdids: ['HELD_REUSE'],
      onProgress: () => {},
    });
    expect(result.allUdids).not.toContain('HELD');
    expect(result.allUdids).not.toContain('HELD_REUSE');
    for (const c of calls) {
      if (c[2] === 'delete' || c[2] === 'shutdown') expect(c).not.toContain('HELD');
      if (c[2] === 'delete') expect(c).not.toContain('HELD_REUSE');
    }
  });

  it('are claimed as they are taken, passing over one another session claimed meanwhile', () => {
    const calls: string[][] = [];
    simctl([
      { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted' },
      { udid: 'RACED', name: 'iPhone 16', state: 'Booted' },
      { udid: 'FREE', name: 'iPhone 16', state: 'Shutdown' },
    ], calls);
    mockedReadFileSync.mockReturnValue('[]');
    claims.claimedMeanwhile = new Set(['RACED']);

    const result = provisionSimulators({ simulatorName: 'iPhone 16', workers: 2, existingUdids: ['PRIMARY'], onProgress: () => {} });
    expect(result.allUdids).toEqual(['PRIMARY', 'FREE']);
  });

  it('never shut down as a clone source once another session claimed one meanwhile', () => {
    const calls: string[][] = [];
    simctl([
      { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted', deviceType: 'iPhone-16' },
      { udid: 'RACED', name: 'iPhone 16', state: 'Booted' },
    ], calls);
    mockedReadFileSync.mockReturnValue('[]');
    claims.claimedMeanwhile = new Set(['RACED']);

    provisionSimulators({ simulatorName: 'iPhone 16', workers: 3, existingUdids: ['PRIMARY'], onProgress: () => {} });
    expect(calls.some((c) => c[2] === 'shutdown' && c[3] === 'RACED')).toBe(false);
  });

  it('never pruned as an unused reusable clone once another session claimed one meanwhile', () => {
    const calls: string[][] = [];
    simctl([
      { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted' },
      { udid: 'R1', name: 'iPhone 16 (Tapsmith Worker 1)', state: 'Booted' },
      { udid: 'R2', name: 'iPhone 16 (Tapsmith Worker 2)', state: 'Booted' },
    ], calls);
    mockedReadFileSync.mockReturnValue('[]');
    claims.heldAfterFirstLook = new Set(['R2']);

    provisionSimulators({ simulatorName: 'iPhone 16', workers: 2, existingUdids: ['PRIMARY'], reusableUdids: ['R1', 'R2'], onProgress: () => {} });
    expect(calls.some((c) => c[2] === 'delete' && c[3] === 'R2')).toBe(false);
  });
});
