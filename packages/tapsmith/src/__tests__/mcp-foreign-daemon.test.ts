import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DeviceInfoProto } from '../grpc-client.js';
import type { TapsmithConfig } from '../config.js';

// A daemon the MCP server finds rather than starts — on the default port, the
// config's `daemonAddress`, or a UI session's config — can be another
// session's, serving another platform. Adopting it for this session's config
// repointed it to our device and started our agent on it (PILOT-564). The
// claims registry catches that only for sessions that share this HOME and hold
// a claim at that moment; these tests run with no claims at all.

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type Device = Pick<DeviceInfoProto, 'serial' | 'state' | 'platform'>;
let listDevices: (address: string) => Promise<{ devices: Device[] }>;
let setDevice: (address: string, serial: string) => Promise<{ success: boolean }>;
let startAgent: (address: string) => Promise<unknown>;
let ping: (address: string) => Promise<{ version: string; agentConnected?: boolean }>;
let readyAt: (address: string) => boolean;
vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    constructor(readonly address: string) {}
    waitForReady(): Promise<boolean> { return Promise.resolve(readyAt(this.address)); }
    ping(): Promise<{ version: string; agentConnected?: boolean }> { return ping(this.address); }
    listDevices(): Promise<{ devices: Device[] }> { return listDevices(this.address); }
    setDevice(serial: string): Promise<{ success: boolean }> { return setDevice(this.address, serial); }
    startAgent(): Promise<unknown> { return startAgent(this.address); }
    close(): void {}
  },
}));

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/fake/tapsmith-core' }));
// A simulator's agent start resolves through the on-demand build (PILOT-485);
// never run xcodebuild from a unit test.
vi.mock('../ios-simulator-build.js', () => ({
  ensureSimulatorAgent: async () => '/fake/Agent_iphonesimulator27.0-arm64.xctestrun',
}));

let nextPort = 43000;
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

const {
  closeAllClients, configureMcpConnection, ensureConnected, ensurePlatformTarget, getAllDaemonAddresses, resolveDeviceTarget,
  otherPlatformReason, crossesPlatform, singlePlatformOf,
} = await import('../mcp/connection.js');
const { listDeviceClaims } = await import('../device-claims.js');
const { uiPortFilePath } = await import('../mcp/port-file.js');

class FakeDaemon extends EventEmitter {
  pid = 99998;
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

const FOREIGN = 'localhost:50051';
const baseConfig: Partial<TapsmithConfig> = {
  timeout: 1000, retries: 0, screenshot: 'never', testMatch: [], rootDir: '/p', outputDir: 'out',
  workers: 1, launchEmulators: false, daemonAddress: FOREIGN,
};

let tmpDir: string;
let savedHome: string | undefined;
let stderr: string;
/** Every setDevice and startAgent the session sent, by daemon address. */
let calls: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-foreign-daemon-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => new FakeDaemon());
  calls = [];
  // The foreign daemon answers from the start; ours once it has been spawned.
  readyAt = (address) => address === FOREIGN || spawnMock.mock.calls.length > 0;
  ping = () => Promise.resolve({ version: 'test', agentConnected: false });
  setDevice = (address, serial) => {
    calls.push(`setDevice ${address} ${serial}`);
    return Promise.resolve({ success: true });
  };
  startAgent = (address) => {
    calls.push(`startAgent ${address}`);
    return Promise.resolve({});
  };
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
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

const androidOnForeign = (address: string): Promise<{ devices: Device[] }> => Promise.resolve({
  devices: address === FOREIGN
    ? [{ serial: 'emulator-5554', state: 'Active', platform: 'android' }, { serial: 'SIM-1', state: 'Discovered', platform: 'ios' }]
    : [{ serial: 'SIM-1', state: 'Discovered', platform: 'ios' }],
});

describe('a found daemon serving another platform', () => {
  it('is not adopted by an iOS session: it starts its own, and never touches that daemon or its device', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios' };
    listDevices = androidOnForeign;

    await ensureConnected();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(stderr).toContain(
      `Ignoring ${FOREIGN} — it is driving emulator-5554, an android device, and this session's config is for ios`,
    );
    expect(calls.filter((c) => c.includes(FOREIGN))).toEqual([]);
    expect(listDeviceClaims().map((c) => c.device)).not.toContain('emulator-5554');
  });

  it('is not repointed by the iOS target either, which runs on its own daemon', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios' };
    listDevices = androidOnForeign;

    const target = await ensurePlatformTarget(mcpConfig as TapsmithConfig);
    expect(target.deviceSerial).toBe('SIM-1');
    expect(target.address).not.toBe(FOREIGN);
    expect(calls.filter((c) => c.includes(FOREIGN))).toEqual([]);
  });

  it('is not adopted when it serves only the other platform, even pointed at nothing yet', async () => {
    mcpConfig = { ...baseConfig, platform: 'ios' };
    listDevices = (address) => Promise.resolve({
      devices: address === FOREIGN
        ? [{ serial: 'emulator-5554', state: 'Discovered', platform: 'android' }]
        : [{ serial: 'SIM-1', state: 'Discovered', platform: 'ios' }],
    });

    await ensureConnected();
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(stderr).toContain(`Ignoring ${FOREIGN} — it serves android devices only, and this session's config is for ios`);
  });

  it('is still adopted by a session of its own platform', async () => {
    mcpConfig = { ...baseConfig, platform: 'android' };
    listDevices = androidOnForeign;

    await ensureConnected();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(getAllDaemonAddresses()).toBe(FOREIGN);
  });

  it('is not adopted by a config that names no platform, which runs on Android', async () => {
    mcpConfig = { ...baseConfig };
    listDevices = (address) => Promise.resolve({
      devices: address === FOREIGN
        ? [{ serial: 'SIM-9', state: 'Active', platform: 'ios' }, { serial: 'emulator-5554', state: 'Discovered', platform: 'android' }]
        : [{ serial: 'emulator-5554', state: 'Discovered', platform: 'android' }],
    });

    await ensureConnected();
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(stderr).toContain(`Ignoring ${FOREIGN} — it is driving SIM-9, an ios device, and this session's config is for android`);
    expect(calls.filter((c) => c.includes(FOREIGN))).toEqual([]);
  });

  it('starts its own daemon for the platform a config names no platform for, never a platform-less one', async () => {
    mcpConfig = { ...baseConfig };
    listDevices = (address) => Promise.resolve({
      devices: address === FOREIGN ? [{ serial: 'SIM-9', state: 'Active', platform: 'ios' }] : [],
    });

    await ensureConnected();
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).toContain('--platform android');
  });

  it('still routes a project that names no platform to the daemon it started for it', async () => {
    mcpConfig = { ...baseConfig, projects: [{ name: 'e2e' }] };
    readyAt = (address) => address !== FOREIGN && spawnMock.mock.calls.length > 0;
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5554', state: 'Discovered', platform: 'android' }] });

    const target = await ensurePlatformTarget(mcpConfig as TapsmithConfig);
    const routed = await resolveDeviceTarget({ project: { name: 'e2e' } });
    expect(routed.device ?? target.deviceSerial).toBe('emulator-5554');
  });

  it('starts no agent on a found daemon when the config did not load', async () => {
    mcpConfig = null;
    listDevices = androidOnForeign;

    await ensureConnected().catch(() => undefined);
    expect(calls.filter((c) => c.startsWith(`startAgent ${FOREIGN}`))).toEqual([]);
  });

  it('is not moved across by a project of a mixed config that names no platform', async () => {
    mcpConfig = {
      ...baseConfig,
      projects: [{ name: 'android' }, { name: 'ios', use: { platform: 'ios' } }],
    };
    listDevices = (address) => Promise.resolve({
      devices: address === FOREIGN
        ? [{ serial: 'SIM-9', state: 'Active', platform: 'ios' }, { serial: 'emulator-5554', state: 'Discovered', platform: 'android' }]
        : [{ serial: 'emulator-5554', state: 'Discovered', platform: 'android' }],
    });

    await ensureConnected();
    const android = await ensurePlatformTarget({ ...mcpConfig, device: 'emulator-5554' } as TapsmithConfig);
    expect(android.address).not.toBe(FOREIGN);
    expect(calls.filter((c) => c.includes(FOREIGN))).toEqual([]);
  });

  it('is not taken, unpinned, by a project of a mixed config that names no platform', async () => {
    mcpConfig = {
      ...baseConfig,
      projects: [{ name: 'android' }, { name: 'ios', use: { platform: 'ios' } }],
    };
    listDevices = (address) => Promise.resolve({
      devices: address === FOREIGN
        ? [{ serial: 'SIM-9', state: 'Active', platform: 'ios' }]
        : [{ serial: 'emulator-5554', state: 'Discovered', platform: 'android' }],
    });

    await ensureConnected();
    const android = await ensurePlatformTarget(mcpConfig as TapsmithConfig);
    expect(android).not.toMatchObject({ address: FOREIGN });
    expect(android.deviceSerial).toBe('emulator-5554');
    expect(calls.filter((c) => c.includes(FOREIGN))).toEqual([]);
  });

  it('starts its daemon for the root platform of a config whose projects span two', async () => {
    mcpConfig = {
      ...baseConfig,
      platform: 'ios',
      projects: [{ name: 'ios' }, { name: 'android', use: { platform: 'android' } }],
    };
    readyAt = (address) => address !== FOREIGN && spawnMock.mock.calls.length > 0;
    listDevices = () => Promise.resolve({ devices: [] });

    await ensureConnected();
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).toContain('--platform ios');
  });

  it('reuses its own daemon for the platform every project overrides the root one with', async () => {
    mcpConfig = { ...baseConfig, platform: 'android', projects: [{ name: 'ios', use: { platform: 'ios' } }] };
    readyAt = (address) => address !== FOREIGN && spawnMock.mock.calls.length > 0;
    listDevices = () => Promise.resolve({ devices: [{ serial: 'SIM-1', state: 'Discovered', platform: 'ios' }] });

    await ensureConnected();
    await ensurePlatformTarget({ ...mcpConfig, platform: 'ios' } as TapsmithConfig);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls[0]?.[1] as string[]).join(' ')).toContain('--platform ios');
  });

  it('stays in a multi-platform session for the platform it serves, and the other platform starts its own', async () => {
    mcpConfig = {
      ...baseConfig,
      projects: [{ name: 'android', use: { platform: 'android' } }, { name: 'ios', use: { platform: 'ios' } }],
    };
    listDevices = androidOnForeign;

    await ensureConnected();
    expect(getAllDaemonAddresses()).toContain(FOREIGN);
    const ios = await ensurePlatformTarget({ ...mcpConfig, platform: 'ios' } as TapsmithConfig);
    expect(ios.address).not.toBe(FOREIGN);
    expect(calls).not.toContain(`setDevice ${FOREIGN} SIM-1`);
    const android = await ensurePlatformTarget({ ...mcpConfig, platform: 'android' } as TapsmithConfig);
    expect(android).toMatchObject({ address: FOREIGN, deviceSerial: 'emulator-5554' });
  });
});

describe('the UI server\'s MCP endpoint', () => {
  let server: http.Server;
  const uiPrimary = 'localhost:51999';

  async function serveUi(body: unknown): Promise<void> {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const file = uiPortFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String((server.address() as AddressInfo).port));
  }

  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  it('drives the UI session\'s own primary daemon, not the config\'s address another session answers on', async () => {
    // The UI run found another session on 50051 and started on a free port.
    mcpConfig = { ...baseConfig, platform: 'android' };
    await serveUi({ daemons: [], owned: [uiPrimary], devices: ['emulator-5556'] });
    readyAt = (address) => address === FOREIGN || address === uiPrimary;
    listDevices = (address) => Promise.resolve({
      devices: [{ serial: address === FOREIGN ? 'emulator-5554' : 'emulator-5556', state: 'Active', platform: 'android' }],
    });
    ping = () => Promise.resolve({ version: 'test', agentConnected: true });
    configureMcpConnection({ uiMode: true });

    await ensureConnected();
    expect(getAllDaemonAddresses()).toBe(uiPrimary);
    expect(stderr).toContain(`Ignoring ${FOREIGN} — it is not one of this UI session's daemons`);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reads its own session\'s daemons in-process, not another UI session\'s from the shared port file', async () => {
    // A second UI session in this project started on a free port and now
    // answers through the per-project port file.
    mcpConfig = { ...baseConfig, platform: 'android' };
    await serveUi({ daemons: [], owned: [uiPrimary], devices: ['emulator-5556'] });
    readyAt = (address) => address === FOREIGN || address === uiPrimary;
    listDevices = (address) => Promise.resolve({
      devices: [{ serial: address === FOREIGN ? 'emulator-5554' : 'emulator-5556', state: 'Active', platform: 'android' }],
    });
    ping = () => Promise.resolve({ version: 'test', agentConnected: true });
    configureMcpConnection({ uiMode: true, uiDaemonPorts: () => ({ daemons: [], owned: [FOREIGN], devices: ['emulator-5554'] }) });

    await ensureConnected();
    expect(getAllDaemonAddresses()).toBe(FOREIGN);
  });

  it('adopts nothing found when its own session\'s answer fails', async () => {
    mcpConfig = { ...baseConfig, platform: 'android' };
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5554', state: 'Active', platform: 'android' }] });
    configureMcpConnection({ uiMode: true, uiDaemonPorts: () => { throw new Error('worker has no port'); } });

    await ensureConnected();
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('keeps its UI workers, and starts nothing, when its own session\'s answer fails later', async () => {
    const worker = '127.0.0.1:52001';
    mcpConfig = { ...baseConfig, platform: 'android' };
    readyAt = (address) => address === FOREIGN || address === worker;
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5556', state: 'Active', platform: 'android' }] });
    ping = () => Promise.resolve({ version: 'test', agentConnected: true });
    let fail = false;
    configureMcpConnection({
      uiMode: true,
      uiDaemonPorts: () => {
        if (fail) throw new Error('worker has no port');
        return { daemons: [{ address: worker, deviceSerial: 'emulator-5556', platform: 'android' }], owned: [worker], devices: ['emulator-5556'] };
      },
    });

    await ensureConnected();
    expect(getAllDaemonAddresses()).toBe(worker);
    fail = true;
    const routed = await resolveDeviceTarget();
    expect(routed.device).toBe('emulator-5556');
    expect(getAllDaemonAddresses()).toBe(worker);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps the config\'s address when it is the UI session\'s primary', async () => {
    mcpConfig = { ...baseConfig, platform: 'android' };
    await serveUi({ daemons: [], owned: ['127.0.0.1:50051'], devices: [] });
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5554', state: 'Active', platform: 'android' }] });
    ping = () => Promise.resolve({ version: 'test', agentConnected: true });
    configureMcpConnection({ uiMode: true });

    await ensureConnected();
    // One connection, under the config's spelling of the address.
    expect(getAllDaemonAddresses()).toBe(FOREIGN);
  });
});

describe('otherPlatformReason', () => {
  it('is null when the daemon can serve the platform, or cannot be told', () => {
    expect(otherPlatformReason(undefined, 'ios')).toBeNull();
    expect(otherPlatformReason([], 'ios')).toBeNull();
    expect(otherPlatformReason([{ serial: 'S', state: 'Active', platform: 'ios' } as DeviceInfoProto], 'ios')).toBeNull();
    // A platform-less daemon pointed at nothing can serve either.
    expect(otherPlatformReason([
      { serial: 'e', state: 'Discovered', platform: 'android' },
      { serial: 'S', state: 'Discovered', platform: 'ios' },
    ] as DeviceInfoProto[], 'ios')).toBeNull();
    // An old daemon that reports no platform is not refused on a guess.
    expect(otherPlatformReason([{ serial: 'e', state: 'Active', platform: '' } as DeviceInfoProto], 'ios')).toBeNull();
  });
});

describe('singlePlatformOf', () => {
  it('is the one platform every project runs on, Android when none is named', () => {
    expect(singlePlatformOf({})).toBe('android');
    expect(singlePlatformOf({ platform: 'ios' })).toBe('ios');
    expect(singlePlatformOf({ platform: 'ios', projects: [{ name: 'a' }] })).toBe('ios');
    expect(singlePlatformOf({ projects: [{ name: 'a', use: { platform: 'ios' } }] })).toBe('ios');
    expect(singlePlatformOf({ projects: [{ name: 'a' }, { name: 'b', use: { platform: 'ios' } }] })).toBeUndefined();
  });
});

describe('crossesPlatform', () => {
  it('is true only when the daemon would move off a device of another platform', () => {
    expect(crossesPlatform({ serial: 'S', activeSerial: 'e', activePlatform: 'android' }, 'ios')).toBe(true);
    expect(crossesPlatform({ serial: 'S', activeSerial: 'S', activePlatform: 'android' }, 'ios')).toBe(false);
    expect(crossesPlatform({ serial: 'S', activeSerial: 'e', activePlatform: 'ios' }, 'ios')).toBe(false);
    expect(crossesPlatform({ serial: 'S', activeSerial: 'e', activePlatform: 'android' }, undefined)).toBe(false);
    expect(crossesPlatform({ serial: 'S' }, 'ios')).toBe(false);
  });
});
