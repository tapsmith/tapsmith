import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeviceInfoProto } from '../grpc-client.js';
import type { TapsmithConfig } from '../config.js';
import { configDeviceTarget, configTargetMissMessage, type ConfigDeviceTargetDeps } from '../mcp/config-device-target.js';

// A headless MCP session with no `device` pin took the first free device its
// daemon listed, so `simulator: 'iPhone 17'` drove a booted iPhone 17 Pro —
// another session's — and `avd: 'X'` an unrelated emulator (PILOT-915). It
// must pick what `tapsmith test` picks among the running devices.

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type Device = Pick<DeviceInfoProto, 'serial' | 'state' | 'platform'>;
let devices: Device[];
/** What a daemon at that address lists, when it differs from `devices`. */
let devicesAt: Record<string, Device[]>;
/** Daemons already up (found, not started) — answering before any spawn. */
let upFront: Set<string>;
let calls: string[];
vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    constructor(readonly address: string) {}
    waitForReady(): Promise<boolean> { return Promise.resolve(upFront.has(this.address) || spawnMock.mock.calls.length > 0); }
    ping(): Promise<{ version: string; agentConnected: boolean }> { return Promise.resolve({ version: 'test', agentConnected: false }); }
    listDevices(): Promise<{ devices: Device[] }> { return Promise.resolve({ devices: devicesAt[this.address] ?? devices }); }
    setDevice(serial: string): Promise<{ success: boolean }> {
      calls.push(upFront.has(this.address) ? `setDevice ${this.address} ${serial}` : `setDevice ${serial}`);
      return Promise.resolve({ success: true });
    }
    startAgent(): Promise<unknown> { return Promise.resolve({}); }
    close(): void {}
  },
}));

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/fake/tapsmith-core' }));
vi.mock('../ios-simulator-build.js', () => ({
  ensureSimulatorAgent: async () => '/fake/Agent_iphonesimulator27.0-arm64.xctestrun',
}));

let booted: Array<{ udid: string; name: string }>;
vi.mock('../ios-simulator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-simulator.js')>()),
  listBootedSimulators: () => booted,
}));
let avds: Record<string, string>;
vi.mock('../emulator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../emulator.js')>()),
  getRunningAvdName: (serial: string) => avds[serial],
}));

let nextPort = 44000;
vi.mock('../port-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../port-utils.js')>()),
  pickFreePort: () => Promise.resolve(nextPort++),
}));

let mcpConfig: Partial<TapsmithConfig> | null = null;
vi.mock('../mcp/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/config-loader.js')>()),
  loadMcpConfig: () => (mcpConfig
    ? Promise.resolve({ config: mcpConfig as TapsmithConfig, configPath: '/p/tapsmith.config.mjs' })
    : Promise.reject(new Error('no config'))),
}));

const { closeAllClients, configureMcpConnection, ensureConnected, ensurePlatformTarget } = await import('../mcp/connection.js');
const { claimDevice, releaseSessionClaims } = await import('../device-claims.js');

class FakeDaemon extends EventEmitter {
  pid = 99997;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => {
    if (this.exitCode === null) {
      this.signalCode = 'SIGTERM';
      setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    }
    return true;
  });
  unref(): void {}
}

const baseConfig: Partial<TapsmithConfig> = {
  timeout: 1000, retries: 0, screenshot: 'never', testMatch: [], rootDir: '/p', outputDir: 'out',
  workers: 1, launchEmulators: false, daemonAddress: 'localhost:1',
};

// The other session's iPhone 17 Pro is Active and listed first: what the
// unfiltered pick took.
const twoSims: Device[] = [
  { serial: 'SIM-PRO', state: 'Active', platform: 'ios' },
  { serial: 'SIM-17', state: 'Discovered', platform: 'ios' },
];
const twoSimsBooted = [{ udid: 'SIM-PRO', name: 'iPhone 17 Pro' }, { udid: 'SIM-17', name: 'iPhone 17' }];

let tmpDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-config-target-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => new FakeDaemon());
  calls = [];
  devices = [];
  devicesAt = {};
  upFront = new Set();
  booted = [];
  avds = {};
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  configureMcpConnection({});
});

afterEach(() => {
  closeAllClients();
  configureMcpConnection({});
  vi.restoreAllMocks();
  mcpConfig = null;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a headless session\'s device, with `simulator` in the config', () => {
  it('is the configured simulator, not the first booted one', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17' };
    devices = twoSims;
    booted = twoSimsBooted;

    const target = await ensurePlatformTarget(mcpConfig as TapsmithConfig);
    expect(target.deviceSerial).toBe('SIM-17');
    expect(calls).not.toContain('setDevice SIM-PRO');
  });

  it('is never another simulator when a UI endpoint\'s discovery starts its own daemon either', async () => {
    // Only a UI-mode endpoint selects a device at discovery; a headless one
    // waits for its platform target.
    configureMcpConnection({ uiMode: true });
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17' };
    devices = twoSims;
    booted = twoSimsBooted;

    await ensureConnected();
    expect(calls).toEqual(['setDevice SIM-17']);
  });

  it('matches a simulator named by UDID', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'SIM-17' };
    devices = twoSims;
    booted = twoSimsBooted;

    expect((await ensurePlatformTarget(mcpConfig as TapsmithConfig)).deviceSerial).toBe('SIM-17');
  });

  it('gives way to a `device` pin, as the runner does', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17', device: 'SIM-PRO' };
    devices = twoSims;
    booted = twoSimsBooted;

    expect((await ensurePlatformTarget(mcpConfig as TapsmithConfig)).deviceSerial).toBe('SIM-PRO');
  });

  it('is refused, naming the target and what is running, when no such simulator is booted', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17' };
    devices = [{ serial: 'SIM-PRO', state: 'Active', platform: 'ios' }];
    booted = [{ udid: 'SIM-PRO', name: 'iPhone 17 Pro' }];

    await expect(ensurePlatformTarget(mcpConfig as TapsmithConfig)).rejects.toThrow(
      'No running ios device matches simulator "iPhone 17" from your config. Visible ios devices: SIM-PRO. '
      + 'Boot it (`xcrun simctl boot "iPhone 17"`, or run `tapsmith test` once, which boots it), '
      + 'change it in your config, or pass one of those as `device`.',
    );
    expect(calls).toEqual([]);
  });

  it('is the configured simulator on a daemon the session finds pointed at another one', async () => {
    // The reuse path: a found daemon serving the other simulator is moved to
    // the configured one, not adopted for the simulator it already drives.
    const found = 'localhost:47001';
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17', daemonAddress: found };
    upFront.add(found);
    devices = twoSims;
    booted = twoSimsBooted;

    const target = await ensurePlatformTarget(mcpConfig as TapsmithConfig);
    expect(target).toMatchObject({ address: found, deviceSerial: 'SIM-17' });
    expect(calls).toContain(`setDevice ${found} SIM-17`);
    expect(calls).not.toContain(`setDevice ${found} SIM-PRO`);
    // And again on the daemon it now holds.
    expect((await ensurePlatformTarget(mcpConfig as TapsmithConfig)).deviceSerial).toBe('SIM-17');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  describe('when the configured simulator runs but is taken', () => {
    const other = {
      id: 'other-session', pid: process.pid, command: 'tapsmith test --ui', project: '/elsewhere', startedAt: new Date().toISOString(),
    };
    afterEach(() => releaseSessionClaims(other.id));

    it('says another session holds it, rather than to boot it', async () => {
      mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17' };
      // Serials no earlier test claimed: the registry is per worker, not per test.
      devices = [{ serial: 'SIM-PRO-H', state: 'Active', platform: 'ios' }, { serial: 'SIM-17-H', state: 'Discovered', platform: 'ios' }];
      booted = [{ udid: 'SIM-PRO-H', name: 'iPhone 17 Pro' }, { udid: 'SIM-17-H', name: 'iPhone 17' }];
      expect(claimDevice('SIM-17-H', other).ok).toBe(true);

      const err = await ensurePlatformTarget(mcpConfig as TapsmithConfig).then((t) => `resolved ${JSON.stringify(t)}`, (e: Error) => e.message);
      expect(err).toContain('Every running device that matches simulator "iPhone 17" from your config is taken.');
      expect(err).toContain('In use by another Tapsmith session: SIM-17-H');
      expect(err).not.toContain('Boot it');
      expect(calls).toEqual([]);
    });
  });

  it('says a group member\'s only match already serves the primary, rather than to boot it', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17', devices: 2 };
    devices = twoSims;
    booted = twoSimsBooted;

    const err = await ensurePlatformTarget(mcpConfig as TapsmithConfig).then(() => undefined, (e: Error) => e.message);
    expect(err).toContain(
      'Every running device that matches simulator "iPhone 17" from your config is taken: SIM-17 already serves the group\'s other members. '
      + 'Boot another simulator named "iPhone 17"',
    );
    expect(err).toContain('(needed for group member');
  });

  it('picks the configured simulator for an unpinned group member too', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios', simulator: 'iPhone 17', devices: 2 };
    devices = [
      { serial: 'SIM-PRO', state: 'Active', platform: 'ios' },
      { serial: 'SIM-17', state: 'Discovered', platform: 'ios' },
      { serial: 'SIM-17-CLONE', state: 'Discovered', platform: 'ios' },
    ];
    booted = [...twoSimsBooted, { udid: 'SIM-17-CLONE', name: 'iPhone 17 (Tapsmith Worker 2)' }];

    const target = await ensurePlatformTarget(mcpConfig as TapsmithConfig);
    expect([target.deviceSerial, ...(target.members ?? []).map((m) => m.deviceSerial)].sort())
      .toEqual(['SIM-17', 'SIM-17-CLONE']);
  });
});

describe('a headless session\'s device, with `avd` in the config', () => {
  const twoEmulators: Device[] = [
    { serial: 'emulator-5554', state: 'Active', platform: 'android' },
    { serial: 'emulator-5556', state: 'Discovered', platform: 'android' },
  ];

  it('is an emulator running that AVD (avd-only is the default with `avd`)', async () => {
    mcpConfig = { ...baseConfig, platform: 'android', avd: 'Tapsmith_Phone_API_36' };
    devices = twoEmulators;
    avds = { 'emulator-5554': 'Medium_Phone_API_36', 'emulator-5556': 'Tapsmith_Phone_API_36' };

    expect((await ensurePlatformTarget(mcpConfig as TapsmithConfig)).deviceSerial).toBe('emulator-5556');
  });

  it('is any device under an explicit prefer-connected', async () => {
    mcpConfig = { ...baseConfig, platform: 'android', avd: 'Tapsmith_Phone_API_36', deviceStrategy: 'prefer-connected' };
    devices = twoEmulators;
    avds = { 'emulator-5554': 'Medium_Phone_API_36', 'emulator-5556': 'Tapsmith_Phone_API_36' };

    expect((await ensurePlatformTarget(mcpConfig as TapsmithConfig)).deviceSerial).toBe('emulator-5554');
  });

  it('offers only Android devices instead when the config names no platform', async () => {
    // Such a config's daemon lists both platforms; a booted simulator is no
    // way out of a missing AVD.
    mcpConfig = { ...baseConfig, avd: 'Tapsmith_Phone_API_36' };
    devices = [
      { serial: 'SIM-1', state: 'Active', platform: 'ios' },
      { serial: 'emulator-5554', state: 'Discovered', platform: 'android' },
    ];
    avds = { 'emulator-5554': 'Medium_Phone_API_36' };

    const err = await ensurePlatformTarget(mcpConfig as TapsmithConfig).then((t) => `resolved ${JSON.stringify(t)}`, (e: Error) => e.message);
    expect(err).toContain('No running android device matches AVD "Tapsmith_Phone_API_36" from your config. Visible android devices: emulator-5554.');
    expect(err).not.toContain('SIM-1');
  });

  it('is refused when no emulator runs that AVD', async () => {
    mcpConfig = { ...baseConfig, platform: 'android', avd: 'Tapsmith_Phone_API_36' };
    devices = twoEmulators;
    avds = { 'emulator-5554': 'Medium_Phone_API_36', 'emulator-5556': 'Pixel_9' };

    await expect(ensurePlatformTarget(mcpConfig as TapsmithConfig)).rejects.toThrow(
      'No running android device matches AVD "Tapsmith_Phone_API_36" from your config. '
      + 'Visible android devices: emulator-5554, emulator-5556.',
    );
  });
});

describe('configDeviceTarget', () => {
  const deps = (over: Partial<ConfigDeviceTargetDeps> = {}): ConfigDeviceTargetDeps => ({
    listBootedSimulators: () => [],
    getRunningAvdName: () => undefined,
    isTapsmithCloneOf: (name, source) => name.startsWith(`${source} (Tapsmith Worker `),
    ...over,
  });

  it('leaves the choice free without `simulator`, or under prefer-connected', async () => {
    expect(await configDeviceTarget({ platform: 'ios' }, deps())).toBeUndefined();
    expect(await configDeviceTarget({ platform: 'android' }, deps())).toBeUndefined();
    expect(await configDeviceTarget({ platform: 'android', avd: 'A', deviceStrategy: 'prefer-connected' }, deps())).toBeUndefined();
  });

  it('accepts only booted simulators of that name or UDID, and Tapsmith clones of it — never a phone', async () => {
    const target = await configDeviceTarget({ platform: 'ios', simulator: 'iPhone 17' }, deps({
      listBootedSimulators: () => [
        { udid: 'A', name: 'iPhone 17' },
        { udid: 'B', name: 'iPhone 17 Pro' },
        { udid: 'C', name: 'iPhone 17 (Tapsmith Worker 2)' },
      ],
    }));
    expect(['A', 'B', 'C', '00008110-PHONE'].filter((s) => target?.accepts(s))).toEqual(['A', 'C']);
  });

  it('accepts only emulators of the AVD under avd-only, for a config that names no platform too', async () => {
    const target = await configDeviceTarget({ avd: 'A' }, deps({
      getRunningAvdName: (serial) => ({ 'emulator-5554': 'A', 'emulator-5556': 'B' } as Record<string, string>)[serial],
    }));
    expect(['emulator-5554', 'emulator-5556', 'R5CT1234'].filter((s) => target?.accepts(s))).toEqual(['emulator-5554']);
  });

  it('names an explicit deviceStrategy in its description', async () => {
    const target = await configDeviceTarget({ platform: 'android', avd: 'A', deviceStrategy: 'avd-only' }, deps());
    expect(configTargetMissMessage(target!, 'android', ['emulator-5556'])).toContain('AVD "A" (deviceStrategy "avd-only") from your config');
  });
});
