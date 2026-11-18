import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TapsmithConfig } from '../config.js';

// The shared device-session module (PILOT-310): one implementation of
// connect → select → install → agent → launch for every run path, and the
// group opener that runs it for each member of a `use.devices` project.

const mocks = vi.hoisted(() => ({
  devices: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  clients: [] as Array<{ waitForReady: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  clientReady: true,
  installed: true,
  preflight: {
    ensureSessionReady: vi.fn(async () => {}),
    launchConfiguredApp: vi.fn(async () => ({ policy: { mode: 'clear', scope: 'file' }, preparedAt: 1, durationMs: 1, source: 'startup launch' })),
    probeResetCapabilities: vi.fn(async (ctx: { capabilities?: Record<string, unknown> }) => { (ctx.capabilities ??= {}).hooksDetected = true; return ctx.capabilities; }),
    checkMissingResetHooks: vi.fn(async () => {}),
    startAndroidLaunchEarly: vi.fn(async (): Promise<{ launched: Promise<boolean> } | undefined> => ({ launched: Promise.resolve(true) })),
  },
  agentFailures: 0,
  /** Errors the next agent starts throw, in order (then they succeed). */
  agentErrors: [] as string[],
  /** Serials whose agent never starts (permanent failure). */
  failAgentFor: new Set<string>(),
  /** Serials the daemon reports have no agent installed (and no APKs were given). */
  noAgentFor: new Set<string>(),
  /** iOS simulator installs performed (installAppAsync calls). */
  simInstalls: 0,
  /** Whether the simulator's installed .app matches the build on disk. */
  simAppMatches: true,
  /** Device-slice xctestrun `findDeviceXctestrun` reports for physical iOS. */
  deviceXctestrun: '/proj/ios-agent/.build-device/TapsmithAgent.xctestrun' as string | undefined,
  /** Shell commands device-session ran (`execFileSync`). */
  execs: [] as string[][],
  /** Serials the daemon does not list (setDevice: "not found"). */
  unknownToDaemon: new Set<string>(),
  /** How long a pinned phone may look unreachable before selection gives up. */
  unreachableGraceMs: 0,
  /** Serials devicectl reports unreachable, until removed. */
  unreachable: new Set<string>(),
  /** What the daemon answers about the agent's own launch of the app. */
  appLaunchedFresh: false,
}));

// No real backoff between agent-start attempts — the retry is what matters here.
vi.mock('../worker-protocol.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker-protocol.js')>()),
  AGENT_START_RETRY_DELAY_MS: 0,
  get DEVICE_SELECT_UNREACHABLE_GRACE_MS() { return mocks.unreachableGraceMs; },
}));

vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: vi.fn().mockImplementation(function () {
    const client = { waitForReady: vi.fn(async () => mocks.clientReady), close: vi.fn() };
    mocks.clients.push(client);
    return client;
  }),
}));

vi.mock('../device.js', () => ({
  Device: vi.fn().mockImplementation(function () {
    let serial = '';
    const device: Record<string, ReturnType<typeof vi.fn>> = {
      listDevices: vi.fn(async () => ({ devices: [] })),
      setDevice: vi.fn(async (s: string) => {
        if (mocks.unknownToDaemon.has(s)) throw new Error(`Device ${s} not found. Run ListDevices first to refresh the device list.`);
        serial = s;
      }),
      wake: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
      _startNetworkProxyForSession: vi.fn(async () => {}),
      installApk: vi.fn(async () => {}),
      _startAgent: vi.fn(async () => {
        if (mocks.failAgentFor.has(serial)) throw new Error('Failed to connect to agent socket on port 18700');
        if (mocks.noAgentFor.has(serial)) throw new Error('Tapsmith agent is not installed on the device. Set agentApk and agentTestApk in your Tapsmith config, or install manually with: adb install <path-to-agent.apk>');
        const queued = mocks.agentErrors.shift();
        if (queued !== undefined) throw new Error(queued);
        if (mocks.agentFailures > 0) {
          mocks.agentFailures--;
          throw new Error('Failed to connect to agent socket on port 18700');
        }
        return { appLaunchedFresh: mocks.appLaunchedFresh };
      }),
      waitForIdle: vi.fn(async () => {}),
      terminateApp: vi.fn(async () => {}),
      // `_close` is what closeDeviceSession calls (it decides whether the
      // shared gRPC client goes with the Device); `close()` is its public form.
      _close: vi.fn(async () => {}),
      close: vi.fn(),
    };
    mocks.devices.push(device);
    return device;
  }),
}));

vi.mock('../emulator.js', () => ({
  isPackageInstalled: vi.fn(() => mocks.installed),
  installedApkMatches: vi.fn(() => true),
  waitForPackageIndexed: vi.fn(async () => {}),
}));

vi.mock('../ios-simulator.js', () => ({
  installApp: vi.fn(),
  installAppAsync: vi.fn(async () => { mocks.simInstalls++; }),
  installedAppMatches: vi.fn(async () => mocks.simAppMatches),
  isAppInstalled: vi.fn(() => true),
  probeSimulatorHealth: vi.fn(() => ({ healthy: true })),
  rebootSimulator: vi.fn(),
}));

vi.mock('../ios-devicectl.js', () => ({
  isPhysicalDevice: vi.fn((serial: string) => serial.startsWith('PHYS')),
  installAppOnDevice: vi.fn(async () => {}),
  isAppInstalledOnDevice: vi.fn(async () => true),
  describeUnreachablePhysicalDevice: vi.fn(async (serial: string) =>
    serial.startsWith('GONE') || mocks.unreachable.has(serial)
      ? `Old iPhone (${serial}) is not connected: this Mac remembers it, but cannot reach it now.`
      : undefined),
}));

vi.mock('../ios-device-resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-device-resolve.js')>()),
  findDeviceXctestrun: vi.fn(() => mocks.deviceXctestrun),
  describeMissingDeviceXctestrun: vi.fn((dir: string) => `No device xctestrun found under ios-agent/.build-device in ${dir} (described)`),
}));

vi.mock('../ios-simulator-build.js', () => ({
  ensureSimulatorAgent: vi.fn(async () => '/derived/TapsmithAgent.xctestrun'),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn((file: string, args?: readonly string[]) => {
    mocks.execs.push([file, ...(args ?? [])]);
    return '';
  }),
}));

vi.mock('../agent-resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-resolve.js')>()),
  findAgentApk: vi.fn(() => '/agents/agent.apk'),
  findAgentTestApk: vi.fn(() => '/agents/agent-test.apk'),
}));

vi.mock('../session-preflight.js', () => mocks.preflight);

const { openDeviceGroup, openDeviceSession, closeDeviceSession, recoverDeviceSessions, sessionsForRun, sessionsToPrepare, runDeviceCount } = await import('../device-session.js');
const { CLAIMS_DIR_ENV, claimDevice } = await import('../device-claims.js');

type MockDevice = Record<string, Mock>;

/** The mocked `Device` class, typed as the factory the `vi.mock` above installs. */
async function mockedDevice(): Promise<Mock<(...args: unknown[]) => MockDevice>> {
  const { Device } = await import('../device.js');
  return vi.mocked(Device) as unknown as Mock<(...args: unknown[]) => MockDevice>;
}

// Claims go to a throwaway registry, never the real `~/.tapsmith/claims`.
const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-session-claims-'));
const previousClaimsDir = process.env[CLAIMS_DIR_ENV];
process.env[CLAIMS_DIR_ENV] = claimsDir;
afterAll(() => {
  if (previousClaimsDir === undefined) delete process.env[CLAIMS_DIR_ENV];
  else process.env[CLAIMS_DIR_ENV] = previousClaimsDir;
  fs.rmSync(claimsDir, { recursive: true, force: true });
});

/** This test process's session. No start token, so liveness never shells out to `ps`. */
const SESSION = {
  id: 'this-session', pid: process.pid, command: 'tapsmith test', project: '/proj', startedAt: new Date().toISOString(),
};
/** Another live session (same pid is fine: liveness is by pid, identity by id). */
const OTHER = { ...SESSION, id: 'other-session', command: 'tapsmith test --ui', project: '/elsewhere' };

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000, retries: 0, screenshot: 'never', testMatch: [], daemonAddress: 'localhost:50051',
    rootDir: '/proj', outputDir: 'out', workers: 1, launchEmulators: false,
    platform: 'android', package: 'com.example.app', apk: './app.apk',
    ...overrides,
  };
}

beforeEach(() => {
  for (const f of fs.readdirSync(claimsDir)) fs.rmSync(path.join(claimsDir, f), { recursive: true, force: true });
  mocks.devices.length = 0;
  mocks.clients.length = 0;
  mocks.clientReady = true;
  mocks.installed = true;
  mocks.agentFailures = 0;
  mocks.agentErrors = [];
  mocks.failAgentFor.clear();
  mocks.simInstalls = 0;
  mocks.simAppMatches = true;
  mocks.deviceXctestrun = '/proj/ios-agent/.build-device/TapsmithAgent.xctestrun';
  mocks.execs.length = 0;
  mocks.unknownToDaemon.clear();
  mocks.unreachableGraceMs = 0;
  mocks.unreachable.clear();
  mocks.appLaunchedFresh = false;
  mocks.preflight.ensureSessionReady.mockClear();
  mocks.preflight.launchConfiguredApp.mockClear();
  mocks.preflight.probeResetCapabilities.mockClear();
  mocks.preflight.checkMissingResetHooks.mockClear();
  mocks.preflight.startAndroidLaunchEarly.mockClear();
});

describe('openDeviceSession', () => {
  it('connects, selects, wakes, skips a matching install, starts the agent and launches', async () => {
    const progress: string[] = [];
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0', launchPhase: 'worker startup launch', onProgress: (m) => progress.push(m) },
    );

    expect(session.serial).toBe('emulator-5554');
    expect(session.config.device).toBe('emulator-5554');
    expect(session.config.daemonAddress).toBe('localhost:50052');
    const device = mocks.devices[0];
    expect(device.setDevice).toHaveBeenCalledWith('emulator-5554', false, [], []);
    expect(device.wake).toHaveBeenCalled();
    expect(device.installApk).not.toHaveBeenCalled();
    expect(device._startAgent).toHaveBeenCalledWith({
      targetPackage: 'com.example.app', agentApkPath: '/agents/agent.apk', agentTestApkPath: '/agents/agent-test.apk',
      iosXctestrunPath: undefined, iosAppPath: undefined, networkTracingEnabled: false, clearAppDataFirst: false,
    });
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(
      expect.objectContaining({ deviceSerial: 'emulator-5554' }),
      'worker startup launch',
      { freshInstall: false, appLaunched: true },
    );
    expect(session.prepared?.policy).toEqual({ mode: 'clear', scope: 'file' });
    expect(session.context.agentApkPath).toBe('/agents/agent.apk');
    expect(progress).toContain('agent connected');
    // A lone device records untagged events, as it always has.
    expect(device._traceDeviceId).toBeUndefined();
  });

  it('installs onto a device that lacks the app and vouches for the fresh install', async () => {
    mocks.installed = false;
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    );
    expect(mocks.devices[0].installApk).toHaveBeenCalledWith('/proj/app.apk');
    expect(mocks.preflight.startAndroidLaunchEarly).toHaveBeenCalledWith(expect.anything(), { freshInstall: true });
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: true, appLaunched: true });
  });

  describe('Android app launch alongside the agent start', () => {
    const spec = { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' };

    it('clears and starts the launch before the agent starts, and lets the launch skip both', async () => {
      const order: string[] = [];
      let finishLaunch!: (ok: boolean) => void;
      mocks.preflight.startAndroidLaunchEarly.mockImplementationOnce(async () => {
        order.push('early launch');
        return { launched: new Promise<boolean>((resolve) => { finishLaunch = resolve; }) };
      });
      const Device = await mockedDevice();
      Device.mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
        const device = (Device.getMockImplementation() as (...a: unknown[]) => MockDevice).apply(this, args);
        const start = device._startAgent;
        device._startAgent = vi.fn(async (...a: unknown[]) => {
          order.push('agent start');
          const started = await start(...a);
          // The launch finishes while the agent is still starting.
          finishLaunch(true);
          return started;
        });
        return device;
      });
      mocks.preflight.launchConfiguredApp.mockImplementationOnce(async () => {
        order.push('launch');
        return { policy: { mode: 'clear', scope: 'file' }, preparedAt: 1, durationMs: 1, source: 'startup launch' };
      });

      await openDeviceSession(spec, makeConfig(), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' });

      expect(order).toEqual(['early launch', 'agent start', 'launch']);
      expect(mocks.preflight.startAndroidLaunchEarly).toHaveBeenCalledWith(
        expect.objectContaining({ deviceSerial: 'emulator-5554' }), { freshInstall: false },
      );
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: false, appLaunched: true });
    });

    it('runs the usual launch after the agent when the early launch did not go through', async () => {
      mocks.preflight.startAndroidLaunchEarly.mockResolvedValueOnce({ launched: Promise.resolve(false) });
      await openDeviceSession(spec, makeConfig(), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' });
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: false });

      mocks.preflight.launchConfiguredApp.mockClear();
      // A failed clear launched nothing.
      mocks.preflight.startAndroidLaunchEarly.mockResolvedValueOnce(undefined);
      await openDeviceSession({ ...spec, serial: 'emulator-5556', daemonAddress: 'localhost:50053' }, makeConfig(), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' });
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: false });
    });

    it('still fails with the agent error when the agent does not start after an early launch', async () => {
      mocks.failAgentFor.add('emulator-5554');
      await expect(openDeviceSession(spec, makeConfig(), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' }))
        .rejects.toThrow(/Failed to start agent: Failed to connect to agent socket/);
      expect(mocks.preflight.startAndroidLaunchEarly).toHaveBeenCalled();
      expect(mocks.preflight.launchConfiguredApp).not.toHaveBeenCalled();
    });

    it('does not launch early on iOS, without a package, on a just-booted emulator, or when adopting', async () => {
      await openDeviceSession(
        { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
        makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
      );
      await openDeviceSession(
        { ...spec, serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
        makeConfig({ package: undefined }),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
      );
      await openDeviceSession(
        { ...spec, serial: 'emulator-5558', daemonAddress: 'localhost:50054' },
        makeConfig(),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device', freshDevice: true },
      );
      await openDeviceSession(
        { ...spec, serial: 'emulator-5560', daemonAddress: 'localhost:50055' },
        makeConfig(),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device', adopt: true },
      );
      expect(mocks.preflight.startAndroidLaunchEarly).not.toHaveBeenCalled();
    });
  });

  it("retries an iOS agent start whose runner timed out launching the app (PILOT-948)", async () => {
    const launchTimeout = 'The iOS agent could not launch com.example.app on simulator SIM-1: '
      + 'Failed to launch com.example.app: Timed out attempting to launch app.';
    mocks.agentErrors = ['14 UNAVAILABLE: Connection dropped'];
    const ios = makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' });
    await openDeviceSession({ name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' }, ios, { claimSession: SESSION, startNetworkProxy: false, label: 'Device' });
    expect(mocks.devices.at(-1)!._startAgent).toHaveBeenCalledTimes(2);

    mocks.agentErrors = [launchTimeout, launchTimeout];
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'SIM-2', daemonAddress: 'localhost:50053' }, ios, { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow(/Failed to start agent: The iOS agent could not launch .*Timed out attempting to launch app\./s);
    expect(mocks.devices.at(-1)!._startAgent).toHaveBeenCalledTimes(2);
  });

  it('retries a transient agent start once, then fails with the session label', async () => {
    mocks.agentFailures = 1;
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    );
    expect(mocks.devices[0]._startAgent).toHaveBeenCalledTimes(2);

    mocks.agentFailures = 2;
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 1' },
    )).rejects.toThrow(/^Worker 1 \(emulator-5556\): Failed to start agent: Failed to connect to agent socket/);
    // A failed open leaves nothing behind.
    expect(mocks.devices.at(-1)!._close).toHaveBeenCalledWith({ closeClient: false, releaseNetwork: true });
    expect(mocks.clients.at(-1)!.close).toHaveBeenCalled();
  });

  it('adopts a daemon that already holds the device: no install, no agent start, seeded capabilities', async () => {
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50051' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Run', adopt: true, adoptVerify: false, seedCapabilities: { hooksDetected: true } },
    );
    const device = mocks.devices[0];
    expect(device.installApk).not.toHaveBeenCalled();
    expect(device._startAgent).not.toHaveBeenCalled();
    expect(mocks.preflight.ensureSessionReady).not.toHaveBeenCalled();
    // Already known: nothing to probe for.
    expect(mocks.preflight.probeResetCapabilities).not.toHaveBeenCalled();
    expect(session.capabilities).toEqual({ hooksDetected: true });
    // A child that adopts runs the missing-hooks check itself (PILOT-774).
    expect(mocks.preflight.checkMissingResetHooks).toHaveBeenCalledWith(session.context);
    // Recovery still knows the agent artifacts.
    expect(session.context.agentApkPath).toBe('/agents/agent.apk');
  });

  // PILOT-1013: a run whose tests use the network APIs starts the proxy
  // before the app launches.
  describe('network proxy at session start', () => {
    const spec = { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' };

    it('starts it after selecting the device and before the install, the agent and the launch', async () => {
      mocks.installed = false;
      await openDeviceSession(spec, makeConfig({ trace: { mode: 'off', networkHttpPorts: [8080] } }), {
        claimSession: SESSION, startNetworkProxy: { multiDevice: false }, label: 'Device',
      });
      const device = mocks.devices[0];
      expect(device._startNetworkProxyForSession).toHaveBeenCalledWith({ requireIsolation: false, httpPorts: [8080] });
      const startedAt = device._startNetworkProxyForSession.mock.invocationCallOrder[0];
      expect(device.setDevice.mock.invocationCallOrder[0]).toBeLessThan(startedAt);
      expect(device.installApk.mock.invocationCallOrder[0]).toBeGreaterThan(startedAt);
      expect(mocks.preflight.startAndroidLaunchEarly.mock.invocationCallOrder[0]).toBeGreaterThan(startedAt);
      expect(device._startAgent.mock.invocationCallOrder[0]).toBeGreaterThan(startedAt);
    });

    // The daemon prepares the app for a proxied session (on an iOS simulator,
    // gRPC's DNS resolver) only when told a proxy will run (R2-F1).
    it('tells the daemon a proxy will run, at selection, at the agent start and for recovery, with tracing off', async () => {
      const session = await openDeviceSession(spec, makeConfig(), { claimSession: SESSION, startNetworkProxy: { multiDevice: false }, label: 'Device' });
      const device = mocks.devices[0];
      expect(device.setDevice).toHaveBeenCalledWith('emulator-5554', true, [], []);
      expect(device._startAgent).toHaveBeenCalledWith(expect.objectContaining({ networkTracingEnabled: true }));
      expect(session.context.networkTracingEnabled).toBe(true);
    });

    it('keeps telling the daemon so when adopting a session whose run uses network APIs', async () => {
      const session = await openDeviceSession(spec, makeConfig(), {
        claimSession: SESSION, startNetworkProxy: { multiDevice: false }, label: 'Run', adopt: true, adoptVerify: false,
      });
      expect(mocks.devices[0].setDevice).toHaveBeenCalledWith('emulator-5554', true, [], []);
      expect(session.context.networkTracingEnabled).toBe(true);
      // Nobody said the app was launched behind the proxy.
      expect(mocks.devices[0]._launchedBehindProxy).toBeUndefined();
    });

    it('marks an adopted app the session launched behind the proxy', async () => {
      await openDeviceSession(spec, makeConfig(), {
        claimSession: SESSION, startNetworkProxy: { multiDevice: false, startedBeforeLaunch: true }, label: 'Run', adopt: true, adoptVerify: false,
      });
      expect(mocks.devices[0]._launchedBehindProxy).toBe(true);
    });

    it('asks for an isolated capture for a member of a group', async () => {
      await openDeviceSession(spec, makeConfig(), { claimSession: SESSION, startNetworkProxy: { multiDevice: true }, label: 'Device' });
      expect(mocks.devices[0]._startNetworkProxyForSession).toHaveBeenCalledWith({ requireIsolation: true, httpPorts: undefined });
    });

    it('starts nothing when the run does not use network APIs, or when adopting a running app', async () => {
      await openDeviceSession(spec, makeConfig(), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' });
      await openDeviceSession({ ...spec, serial: 'emulator-5556' }, makeConfig(), {
        claimSession: SESSION, startNetworkProxy: { multiDevice: false }, label: 'Run', adopt: true, adoptVerify: false,
      });
      for (const device of mocks.devices) expect(device._startNetworkProxyForSession).not.toHaveBeenCalled();
    });

    it('passes the choice to every member of a group', async () => {
      await openDeviceGroup(
        [
          { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
          { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
        ],
        makeConfig(),
        { claimSession: SESSION, startNetworkProxy: { multiDevice: true }, label: 'Worker 0' },
      );
      expect(mocks.devices).toHaveLength(2);
      for (const device of mocks.devices) {
        expect(device._startNetworkProxyForSession).toHaveBeenCalledWith({ requireIsolation: true, httpPorts: undefined });
      }
    });
  });

  it('fails fast when the daemon does not answer', async () => {
    mocks.clientReady = false;
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50099' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow(/Worker 0 \(emulator-5554\): Failed to connect to daemon at localhost:50099/);
  });
});

describe('openDeviceSession phases (the sequential CLI\'s step rows)', () => {
  const phases = (): Array<[string, string, string]> => [];

  it('reports install, agent and launch in order with the CLI\'s detail strings', async () => {
    const seen = phases();
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', onPhase: (p, s, d) => seen.push([p, s, d]) },
    );
    expect(seen).toEqual([
      ['install', 'start', 'checking app.apk'],
      ['install', 'complete', 'com.example.app already installed (matching build)'],
      ['agent', 'start', 'starting Android automation agent'],
      ['agent', 'complete', 'agent connected'],
      ['launch', 'start', 'launching com.example.app'],
      ['launch', 'complete', 'launched com.example.app'],
    ]);
  });

  it('reports skips when nothing is configured, and an install that was needed', async () => {
    const seen = phases();
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig({ apk: undefined, package: undefined }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', onPhase: (p, s, d) => seen.push([p, s, d]) },
    );
    expect(seen).toEqual([
      ['install', 'skip', 'no Android APK configured'],
      ['agent', 'start', 'starting Android automation agent'],
      ['agent', 'complete', 'agent connected'],
      ['launch', 'skip', 'no package configured'],
    ]);
    seen.length = 0;
    mocks.installed = false;
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', onPhase: (p, s, d) => seen.push([p, s, d]) },
    );
    expect(seen[1]).toEqual(['install', 'complete', 'installed app.apk']);
  });

  it('reports the failing phase and wraps the error as the CLI did', async () => {
    const seen = phases();
    mocks.failAgentFor.add('emulator-5554');
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', onPhase: (p, s, d) => seen.push([p, s, d]) },
    )).rejects.toThrow(/^Device \(emulator-5554\): Failed to start agent: /);
    expect(seen.at(-1)?.slice(0, 2)).toEqual(['agent', 'fail']);
  });

  // PILOT-709: pnpm 11+ skipped @tapsmith/agent-android, and the daemon's
  // advice (config keys, adb install) did not say so.
  it('says the agent package is missing, with an install command, when there were no APKs', async () => {
    const { findAgentApk } = await import('../agent-resolve.js');
    vi.mocked(findAgentApk).mockReturnValueOnce(undefined);
    const seen = phases();
    mocks.noAgentFor.add('emulator-5554');
    try {
      const opening = openDeviceSession(
        { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        makeConfig(),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device', onPhase: (p, s, d) => seen.push([p, s, d]) },
      );
      await expect(opening).rejects.toThrow(/Failed to start agent: Tapsmith's Android agent is not installed on the device, and there is no agent APK to install\. @tapsmith\/agent-android/);
      await expect(opening).rejects.toThrow(/Install it with `(npm init -y && )?npm i -D @tapsmith\/agent-android`/);
      expect(seen.at(-1)?.[2]).toContain('npm i -D @tapsmith/agent-android');
    } finally {
      mocks.noAgentFor.clear();
    }
  });

  it('reuses a caller-provided client and leaves it open on failure', async () => {
    const client = { waitForReady: vi.fn(async () => true), close: vi.fn() };
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', client: client as never },
    );
    expect(session.client).toBe(client);
    expect(mocks.clients).toHaveLength(0);
    await closeDeviceSession(session);
    expect(client.close).not.toHaveBeenCalled();
    // The Device shares that client instance, so it must not close it either.
    expect(mocks.devices.at(-1)!._close).toHaveBeenCalledWith({ closeClient: false, releaseNetwork: true });

    mocks.failAgentFor.add('emulator-5556');
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', client: client as never },
    )).rejects.toThrow();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('on an iOS simulator, overlaps the install with agent resolution, and leaves the launch to the agent', async () => {
    mocks.simAppMatches = false;
    const seen = phases();
    await openDeviceSession(
      { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', onPhase: (p, s, d) => seen.push([p, s, d]) },
    );
    expect(mocks.simInstalls).toBe(1);
    expect(seen).toContainEqual(['install', 'complete', 'installed App.app']);
    expect(seen).toContainEqual(['agent', 'start', 'starting iOS agent (TapsmithAgent.xctestrun)']);
    // The daemon terminates any running instance before the runner launches
    // the app: a `simctl launch` ahead of the agent only cost time.
    expect(mocks.execs).not.toContainEqual(['xcrun', 'simctl', 'launch', 'SIM-1', 'com.example.app']);
    const device = mocks.devices[0];
    // A reinstall keeps the data container, so the agent is asked to wipe it.
    expect(device._startAgent).toHaveBeenCalledWith({
      targetPackage: 'com.example.app', agentApkPath: '/agents/agent.apk', agentTestApkPath: '/agents/agent-test.apk',
      iosXctestrunPath: '/derived/TapsmithAgent.xctestrun', iosAppPath: '/proj/Build/App.app', networkTracingEnabled: false,
      clearAppDataFirst: true,
    });
  });

  describe('the iOS agent\'s own launch as the startup launch', () => {
    const iosConfig = (overrides: Partial<TapsmithConfig> = {}) => makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app', ...overrides });
    const open = (config: TapsmithConfig, opts: { appInstalledFresh?: boolean; serial?: string } = {}) => openDeviceSession(
      { name: 'device-1', serial: opts.serial ?? 'SIM-1', daemonAddress: 'localhost:50052' },
      config,
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', ...(opts.appInstalledFresh ? { appInstalledFresh: true } : {}) },
    );
    const clearFirst = () => (mocks.devices[0]._startAgent.mock.calls[0][0] as { clearAppDataFirst: boolean }).clearAppDataFirst;

    it('takes a launch from wiped data as the clean startup launch: no clear and relaunch', async () => {
      mocks.appLaunchedFresh = true;
      await open(iosConfig());
      expect(clearFirst()).toBe(true);
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: true });
    });

    it('clears and relaunches as before when the daemon cannot vouch for the launch', async () => {
      // A reused or adopted runner, an older agent, a failed wipe.
      mocks.appLaunchedFresh = false;
      await open(iosConfig());
      expect(clearFirst()).toBe(true);
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: false });
    });

    it('asks for no wipe after a fresh install, and launches the app itself when the agent did not', async () => {
      mocks.appLaunchedFresh = false;
      await open(iosConfig(), { appInstalledFresh: true });
      expect(clearFirst()).toBe(false);
      // A reused runner never launched the just-installed app.
      expect(mocks.execs).toContainEqual(['xcrun', 'simctl', 'launch', 'SIM-1', 'com.example.app']);
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: true });
    });

    it('does not launch a freshly installed app twice when the agent launched it', async () => {
      mocks.appLaunchedFresh = true;
      await open(iosConfig(), { appInstalledFresh: true });
      expect(mocks.execs).not.toContainEqual(['xcrun', 'simctl', 'launch', 'SIM-1', 'com.example.app']);
    });

    it('never asks without a package, nor on Android', async () => {
      await open(iosConfig({ package: undefined }));
      expect(clearFirst()).toBe(false);
      mocks.devices.length = 0;
      mocks.appLaunchedFresh = true;
      await open(makeConfig(), { serial: 'emulator-5554' });
      expect(clearFirst()).toBe(false);
      // An Android answer is never taken as a launch (the agent does not launch the app).
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenLastCalledWith(
        expect.anything(), 'startup launch', expect.objectContaining({ freshInstall: false }),
      );
    });

    it('asks again on the retried agent start, and takes that start\'s answer', async () => {
      mocks.agentFailures = 1;
      mocks.appLaunchedFresh = true;
      await open(iosConfig());
      const calls = mocks.devices[0]._startAgent.mock.calls as Array<[{ clearAppDataFirst: boolean }]>;
      expect(calls.map(([o]) => o.clearAppDataFirst)).toEqual([true, true]);
      expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: true });
    });
  });

  it('on an iOS simulator, says a reinstall is for a differing build only when the build was compared and differed', async () => {
    const { installedAppMatches } = await import('../ios-simulator.js');
    const open = async (opts: { forceInstall?: boolean }) => {
      const progress: string[] = [];
      await openDeviceSession(
        { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
        makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device', ...opts, onProgress: (m) => progress.push(m) },
      );
      return progress;
    };

    // A rebuilt bundle: compared, differs, reinstalled with the reason.
    mocks.simAppMatches = false;
    expect(await open({})).toContain('reinstalling App.app (installed build differs)');

    // --force-install over a matching build: reinstalled without comparing,
    // and without claiming the build differs.
    mocks.simAppMatches = true;
    vi.mocked(installedAppMatches).mockClear();
    const forced = await open({ forceInstall: true });
    expect(forced).toContain('reinstalling App.app');
    expect(forced).not.toContain('reinstalling App.app (installed build differs)');
    expect(installedAppMatches).not.toHaveBeenCalled();
  });

  it('writes one app_install timing line per install check to TAPSMITH_TIMING_LOG (PILOT-1134)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-timing-'));
    const log = path.join(dir, 'timing.log');
    const saved = process.env.TAPSMITH_TIMING_LOG;
    process.env.TAPSMITH_TIMING_LOG = log;
    try {
      const open = () => openDeviceSession(
        { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
        makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
      );
      mocks.simAppMatches = false;
      await open();
      mocks.simAppMatches = true;
      await open();
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\[TIMING\] pid=\d+ kind=boot name=app_install dur_ms=\d+ result=reinstalled check_ms=\d+ platform=ios$/);
      expect(lines[1]).toMatch(/ result=matching check_ms=\d+ platform=ios$/);
    } finally {
      if (saved === undefined) delete process.env.TAPSMITH_TIMING_LOG;
      else process.env.TAPSMITH_TIMING_LOG = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trusts an install made right after the simulator booted: no recheck, no reinstall, and a fresh-install launch (PILOT-496)', async () => {
    // The sequential CLI installs the app straight after booting a simulator
    // that lacked it. The session must neither check and reinstall it nor
    // treat it as pre-existing, which cleared its data and restarted it.
    mocks.simAppMatches = false;
    const { isAppInstalled } = await import('../ios-simulator.js');
    vi.mocked(isAppInstalled).mockClear();
    const seen = phases();
    await openDeviceSession(
      { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', appInstalledFresh: true, onPhase: (p, s, d) => seen.push([p, s, d]) },
    );
    expect(mocks.simInstalls).toBe(0);
    expect(isAppInstalled).not.toHaveBeenCalled();
    expect(seen).toContainEqual(['install', 'complete', 'installed App.app while booting the simulator']);
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: true });
  });

  it('surfaces a simulator install failure that lands while the agent is still resolving, not as an unhandled rejection', async () => {
    mocks.simAppMatches = false;
    const { installAppAsync } = await import('../ios-simulator.js');
    vi.mocked(installAppAsync).mockRejectedValueOnce(new Error('simctl install: device is locked'));
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    // The agent build outlives the install by a long way in real life; here a
    // few ticks are enough for the rejection to land before it is awaited.
    vi.mocked(ensureSimulatorAgent).mockImplementationOnce(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      return '/derived/TapsmithAgent.xctestrun';
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(openDeviceSession(
        { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
        makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
        { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
      )).rejects.toThrow('Failed to install iOS app: simctl install: device is locked');
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  // PILOT-386: the daemon does not list a phone devicectl only remembers, so
  // selecting a pinned one fails "not found" — which the selection retry
  // treats as transient for minutes. Say what is wrong at the first retry.
  it('fails fast, naming the cause, when a pinned iOS device is remembered but not connected', async () => {
    mocks.unknownToDaemon.add('GONE-1');
    const started = Date.now();
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'GONE-1', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow(/Old iPhone \(GONE-1\) is not connected/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(mocks.devices[0].setDevice).toHaveBeenCalledTimes(1);
  });

  it('still checks reachability when the first selection failure was a transient infrastructure error', async () => {
    let calls = 0;
    mocks.unknownToDaemon.add('GONE-2');
    const DeviceMock = await mockedDevice();
    const real = DeviceMock.getMockImplementation()!;
    DeviceMock.mockImplementationOnce(function (...args) {
      const device = real(...args);
      const notFound = device.setDevice.getMockImplementation()!;
      device.setDevice.mockImplementation(async (s: string) => {
        calls++;
        if (calls === 1) throw new Error('Agent connection dropped');
        return notFound(s);
      });
      return device;
    });
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'GONE-2', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow(/is not connected/);
    expect(calls).toBe(2);
  }, 10_000);

  it('gives up with the not-connected error once the phone has stayed unreachable past the grace period', async () => {
    // Shorter than the 3 s retry delay: the first retry is inside the grace,
    // the second past it, however the clock ticks.
    mocks.unreachableGraceMs = 2_000;
    mocks.unknownToDaemon.add('PHYS-GONE');
    mocks.unreachable.add('PHYS-GONE');
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'PHYS-GONE', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow(/PHYS-GONE\) is not connected/);
    // One retry inside the grace, then it gives up — not the 180 s budget.
    expect(mocks.devices[0].setDevice).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('keeps retrying a phone that looks unreachable only for a moment (re-enumerating), and selects it', async () => {
    mocks.unreachableGraceMs = 30_000;
    mocks.unknownToDaemon.add('PHYS-BACK');
    mocks.unreachable.add('PHYS-BACK');
    const DeviceMock = await mockedDevice();
    const real = DeviceMock.getMockImplementation()!;
    DeviceMock.mockImplementationOnce(function (...args) {
      const device = real(...args);
      const original = device.setDevice.getMockImplementation()!;
      let calls = 0;
      device.setDevice.mockImplementation(async (s: string) => {
        // devicectl reports the phone unreachable between these attempts; it
        // is back by the second one.
        if (++calls === 2) {
          mocks.unknownToDaemon.delete(s);
          mocks.unreachable.delete(s);
        }
        return original(s);
      });
      return device;
    });
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'PHYS-BACK', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    );
    expect(session.serial).toBe('PHYS-BACK');
    expect(mocks.devices[0].setDevice).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('fails a physical iOS device that has no device-slice xctestrun to run', async () => {
    mocks.deviceXctestrun = undefined;
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'PHYS-1', daemonAddress: 'localhost:50052' },
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow(/No device xctestrun found under ios-agent\/.build-device/);
    expect(mocks.execs.some((e) => e[0] === 'xcrun')).toBe(false);
  });

  // PILOT-264: a hand-set xctestrun that is gone (an upgrade re-extracts
  // ~/.tapsmith/ios-agent, removing the build) is named up front, not left
  // to fail inside xcodebuild.
  describe('a hand-set xctestrun that does not exist', () => {
    const physical = { name: 'device-1', serial: 'PHYS-1', daemonAddress: 'localhost:50052' };
    const iosConfig = (over: Partial<TapsmithConfig> = {}) =>
      makeConfig({ platform: 'ios', apk: undefined, app: './Build/App.app', ...over });

    it('refuses `iosXctestrun`, naming the path resolved against rootDir', async () => {
      await expect(openDeviceSession(physical, iosConfig({ iosXctestrun: 'gone/Agent.xctestrun' }), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' }))
        .rejects.toThrow(/The xctestrun set by `iosXctestrun` does not exist: \/proj\/gone\/Agent\.xctestrun/);
      expect(mocks.devices[0]._startAgent).not.toHaveBeenCalled();
    });

    it('refuses TAPSMITH_IOS_XCTESTRUN by name, for simulators too', async () => {
      const saved = process.env.TAPSMITH_IOS_XCTESTRUN;
      process.env.TAPSMITH_IOS_XCTESTRUN = '/nowhere/Agent.xctestrun';
      try {
        await expect(openDeviceSession(
          { name: 'device-1', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
          iosConfig({ simulator: 'iPhone 16' }),
          { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
        )).rejects.toThrow(/set by TAPSMITH_IOS_XCTESTRUN does not exist: \/nowhere\/Agent\.xctestrun.*unset it/);
      } finally {
        if (saved === undefined) delete process.env.TAPSMITH_IOS_XCTESTRUN;
        else process.env.TAPSMITH_IOS_XCTESTRUN = saved;
      }
    });

    it('says an upgrade removed it when the path is in the npm agent directory', async () => {
      const os = await import('node:os');
      const gone = `${os.homedir()}/.tapsmith/ios-agent/.build-device/Build/Products/Gone_iphoneos-arm64.xctestrun`;
      await expect(openDeviceSession(physical, iosConfig({ iosXctestrun: gone }), { claimSession: SESSION, startNetworkProxy: false, label: 'Device' }))
        .rejects.toThrow(/does not exist: ~\/\.tapsmith\/ios-agent\/.*Upgrading Tapsmith replaces.*tapsmith ios build-agent/);
    });

    it('does not check an adopting session, whose agent is already running', async () => {
      await openDeviceSession(physical, iosConfig({ iosXctestrun: 'gone/Agent.xctestrun' }), {
        claimSession: SESSION, startNetworkProxy: false, label: 'Run', adopt: true, adoptVerify: false, seedCapabilities: { hooksDetected: true },
      });
    });
  });
});

describe('openDeviceGroup', () => {
  it('opens every member, tags their trace events, and shares one artifact resolution', async () => {
    const sessions = await openDeviceGroup(
      [
        { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053', freshDevice: true },
      ],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    );
    expect(sessions.map((s) => [s.name, s.serial])).toEqual([['alice', 'emulator-5554'], ['bob', 'emulator-5556']]);
    expect(mocks.devices[0]._traceDeviceId).toBe('alice');
    expect(mocks.devices[1]._traceDeviceId).toBe('bob');
    // The fresh member is reinstalled and warmed up; the other is not.
    expect(mocks.devices[1].installApk).toHaveBeenCalled();
    expect(mocks.devices[1].terminateApp).toHaveBeenCalled();
    expect(mocks.devices[0].installApk).not.toHaveBeenCalled();
    // Each member ends up with its own capabilities object.
    expect(sessions[0].capabilities).not.toBe(sessions[1].capabilities);
  });

  it('bounds the fresh-emulator warm-up idle waits instead of spending the test timeout on each', async () => {
    // On an app that never goes idle the Android agent holds an idle wait for
    // its whole budget: with the config timeout that was twice 30 s per session.
    await openDeviceGroup(
      [{ name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053', freshDevice: true }],
      makeConfig({ timeout: 30_000 }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    );
    expect(mocks.devices[0].terminateApp).toHaveBeenCalled();
    expect(mocks.devices[0].waitForIdle.mock.calls).toEqual([[5_000], [5_000]]);
  });

  it('refuses an iOS group that mixes simulators and physical devices', async () => {
    // The agent artifacts are resolved once for the group, from the first
    // member; a simulator xctestrun cannot drive a physical device (and vice
    // versa), so the mismatch is named up front instead of failing in xcodebuild.
    await expect(openDeviceGroup(
      [
        { name: 'alice', serial: 'SIM-1', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'PHYS-1', daemonAddress: 'localhost:50053' },
      ],
      makeConfig({ platform: 'ios', apk: undefined, simulator: 'iPhone 16' }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow(/cannot mix iOS simulators and physical devices.*bob \(PHYS-1\) is a physical device.*alice \(SIM-1\) is a simulator/);
    expect(mocks.devices).toHaveLength(0);
  });

  it('is atomic: a member that fails closes the ones that opened', async () => {
    mocks.failAgentFor.add('emulator-5556');
    await expect(openDeviceGroup(
      [
        { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      ],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow(/Failed to connect to agent socket/);
    for (const device of mocks.devices) expect(device._close).toHaveBeenCalled();
  });

  it('prefixes progress with the member name for groups, not for single devices', async () => {
    const lines: string[] = [];
    await openDeviceGroup(
      [{ name: 'alice', serial: 'A', daemonAddress: 'localhost:1' }, { name: 'bob', serial: 'B', daemonAddress: 'localhost:2' }],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0', onProgress: (m) => lines.push(m) },
    );
    expect(lines.some((l) => l.startsWith('[bob] '))).toBe(true);
    lines.length = 0;
    await openDeviceGroup(
      [{ name: 'device-1', serial: 'A', daemonAddress: 'localhost:1' }],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0', onProgress: (m) => lines.push(m) },
    );
    expect(lines.every((l) => !l.startsWith('['))).toBe(true);
  });
});

describe('sessionsForRun', () => {
  // A worker holds its device target's largest group; each file runs on the
  // first N of those sessions, N being what *its* project declares.
  const session = (name: string) => ({ name, serial: `emulator-${name}` }) as unknown as import('../device-session.js').DeviceSession;
  const group = [session('alice'), session('bob'), session('carol')];
  const names = (list: unknown[]) => (list as Array<{ name: string }>).map((s) => s.name);

  it('hands a project without `use.devices` the primary only', () => {
    expect(names(sessionsForRun(group, makeConfig(), undefined))).toEqual(['alice']);
    expect(names(sessionsForRun(group, makeConfig(), { timeout: 5 } as never))).toEqual(['alice']);
  });

  it('hands a project its declared group, primary first', () => {
    expect(names(sessionsForRun(group, makeConfig(), { devices: 2 }))).toEqual(['alice', 'bob']);
    expect(names(sessionsForRun(group, makeConfig(), { devices: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] })))
      .toEqual(['alice', 'bob', 'carol']);
  });

  it('falls back to the run config\'s `devices` when the project declares none', () => {
    expect(names(sessionsForRun(group, makeConfig({ devices: 2 }), undefined))).toEqual(['alice', 'bob']);
    // The project's own declaration wins over the config's.
    expect(names(sessionsForRun(group, makeConfig({ devices: 3 }), { devices: 2 }))).toEqual(['alice', 'bob']);
  });

  it('hands back what there is when the worker holds too few — the runner names the shortfall', () => {
    expect(names(sessionsForRun(group.slice(0, 1), makeConfig(), { devices: 2 }))).toEqual(['alice']);
    expect(sessionsForRun([], makeConfig(), { devices: 2 })).toEqual([]);
  });

  it('runDeviceCount is the number the slice, the runner check and the UI server all agree on', () => {
    // The UI server reports this to the client as the run's active device
    // count; it must be exactly what the child sliced by.
    expect(runDeviceCount(makeConfig(), undefined)).toBe(1);
    expect(runDeviceCount(makeConfig(), { devices: 2 })).toBe(2);
    expect(runDeviceCount(makeConfig({ devices: 3 }), undefined)).toBe(3);
    expect(runDeviceCount(makeConfig({ devices: 3 }), { devices: [{ name: 'a' }, { name: 'b' }] })).toBe(2);
    for (const use of [undefined, { devices: 2 }, { devices: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }]) {
      expect(sessionsForRun(group, makeConfig(), use)).toHaveLength(runDeviceCount(makeConfig(), use));
    }
  });
});

describe('sessionsToPrepare', () => {
  // A background preparation resets the devices the next file will drive —
  // and of those, only the ones no longer holding a satisfying claim.
  const CLEAR = { mode: 'clear' as const, scope: 'file' as const };
  const WARM = { mode: 'warm' as const, scope: 'file' as const };
  const claim = (policy: typeof CLEAR | typeof WARM) => ({ policy, preparedAt: 1, durationMs: 1, source: 'test' });
  const session = (name: string, prepared?: ReturnType<typeof claim>) =>
    ({ name, serial: `emulator-${name}`, prepared }) as unknown as import('../device-session.js').DeviceSession;
  const names = (list: unknown[]) => (list as Array<{ name: string }>).map((s) => s.name);

  it('prepares only the primary for a single-device project, whatever the rest of the group holds', () => {
    const group = [session('alice'), session('bob'), session('carol')];
    expect(names(sessionsToPrepare(group, makeConfig(), undefined, CLEAR))).toEqual(['alice']);
    expect(names(sessionsToPrepare(group, makeConfig(), { timeout: 1 } as never, CLEAR))).toEqual(['alice']);
  });

  it('after a single-device run, a group file only needs the device that run used', () => {
    // bob still holds the claim its last preparation left; alice's was consumed.
    const group = [session('alice'), session('bob', claim(CLEAR))];
    expect(names(sessionsToPrepare(group, makeConfig(), { devices: 2 }, CLEAR))).toEqual(['alice']);
    expect(names(sessionsToPrepare(group, makeConfig(), { devices: 2 }, WARM))).toEqual(['alice']);
  });

  it('re-prepares a member whose claim no longer satisfies the policy', () => {
    const group = [session('alice'), session('bob', claim(WARM))];
    expect(names(sessionsToPrepare(group, makeConfig(), { devices: 2 }, CLEAR))).toEqual(['alice', 'bob']);
    // A group entirely prepared needs nothing.
    expect(sessionsToPrepare([session('alice', claim(CLEAR)), session('bob', claim(CLEAR))], makeConfig(), { devices: 2 }, CLEAR)).toEqual([]);
  });

  it('never reaches past the file\'s group, even for an unprepared member', () => {
    const group = [session('alice'), session('bob'), session('carol')];
    expect(names(sessionsToPrepare(group, makeConfig(), { devices: 2 }, CLEAR))).toEqual(['alice', 'bob']);
  });
});

describe('recovery and teardown', () => {
  it('relaunches every session and records the relaunch as prepared state', async () => {
    const sessions = await openDeviceGroup(
      [{ name: 'alice', serial: 'A', daemonAddress: 'localhost:1' }, { name: 'bob', serial: 'B', daemonAddress: 'localhost:2' }],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    );
    for (const s of sessions) s.prepared = undefined;
    mocks.preflight.launchConfiguredApp.mockClear();
    await recoverDeviceSessions(sessions, 'recovery for chat.test.ts');
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledTimes(2);
    expect(sessions.every((s) => s.prepared?.source === 'startup launch')).toBe(true);
  });

  it('closes the device, the client and an owned daemon', async () => {
    const daemon = { kill: vi.fn() };
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'A', daemonAddress: 'localhost:1' },
      makeConfig({ platform: 'ios', apk: undefined }),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0', daemonProcess: daemon as never },
    );
    await closeDeviceSession(session);
    await closeDeviceSession(session);
    expect(mocks.devices[0]._close).toHaveBeenCalledWith({ closeClient: false, releaseNetwork: true });
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(daemon.kill).toHaveBeenCalledTimes(1);
  });

  it('closing an adopted session keeps the owning daemon\'s network proxy alive', async () => {
    // A watch re-run child attaches to its parent's daemon: the proxy port must
    // survive the child (the app's keep-alive sockets point at it), and the
    // client stays open until the teardown has settled.
    let closeSettled = false;
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50051' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Run', adopt: true, adoptVerify: false },
    );
    const device = mocks.devices[0];
    device._close.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(mocks.clients[0].close).not.toHaveBeenCalled();
      closeSettled = true;
    });
    await closeDeviceSession(session);
    expect(device._close).toHaveBeenCalledWith({ closeClient: false, releaseNetwork: false });
    expect(closeSettled).toBe(true);
    expect(mocks.clients[0].close).toHaveBeenCalled();
  });
});

describe('device claims (PILOT-381)', () => {
  it('claims the device for the session before selecting it', async () => {
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    );
    const { listDeviceClaims } = await import('../device-claims.js');
    expect(listDeviceClaims()).toEqual([
      expect.objectContaining({ device: 'emulator-5554', daemonAddress: 'localhost:50052', live: true }),
    ]);
  });

  it('refuses a device another live session holds, naming the holder, without selecting it', async () => {
    claimDevice('emulator-5554', OTHER);
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow(/Worker 0 \(emulator-5554\): Device emulator-5554 is in use by another Tapsmith session: `tapsmith test --ui`/);
    expect(mocks.devices[0].setDevice).not.toHaveBeenCalled();
  });

  it('opens a device the same session already holds (a respawned worker, a watch re-run)', async () => {
    claimDevice('emulator-5554', SESSION);
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).resolves.toBeDefined();
  });

  it('gives back the claim when the open fails, so the session does not hold a device it never drove', async () => {
    mocks.failAgentFor.add('emulator-5554');
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow();
    const { listDeviceClaims } = await import('../device-claims.js');
    expect(listDeviceClaims()).toEqual([]);
  });

  it('gives back a claim the session made earlier (the CLI\'s pick) when the open of that device fails', async () => {
    claimDevice('emulator-5554', SESSION);
    mocks.failAgentFor.add('emulator-5554');
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow();
    const { listDeviceClaims } = await import('../device-claims.js');
    expect(listDeviceClaims()).toEqual([]);
  });

  it('keeps a claim another process of the session still holds when this open fails (an MCP server\'s run_tests child)', async () => {
    fs.writeFileSync(path.join(claimsDir, 'emulator-5554.json'), JSON.stringify({
      device: 'emulator-5554', session: SESSION, claimantPid: process.ppid, holders: [{ pid: process.ppid }],
      claimedAt: new Date().toISOString(),
    }));
    mocks.failAgentFor.add('emulator-5554');
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device' },
    )).rejects.toThrow();
    const { listDeviceClaims } = await import('../device-claims.js');
    expect(listDeviceClaims().map((c) => [c.device, c.holders?.map((h) => h.pid)])).toEqual([['emulator-5554', [process.ppid]]]);
  });

  it('keeps the claim when an adopting open fails (a watch re-run of a device the session goes on driving)', async () => {
    claimDevice('emulator-5554', SESSION, { daemonAddress: 'localhost:50052' });
    mocks.preflight.ensureSessionReady.mockRejectedValueOnce(new Error('agent gone'));
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Run', adopt: true },
    )).rejects.toThrow();
    const { listDeviceClaims } = await import('../device-claims.js');
    expect(listDeviceClaims().map((c) => c.device)).toEqual(['emulator-5554']);
  });

  it('gives back the members it claimed when a later member is refused', async () => {
    claimDevice('emulator-5556', OTHER);
    await expect(openDeviceGroup(
      [
        { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      ],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow(/emulator-5556 is in use/);
    const { listDeviceClaims } = await import('../device-claims.js');
    expect(listDeviceClaims().map((c) => [c.device, c.session.id])).toEqual([['emulator-5556', 'other-session']]);
  });

  it('refuses a group before resolving agent artifacts when any member is held', async () => {
    claimDevice('emulator-5556', OTHER);
    await expect(openDeviceGroup(
      [
        { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      ],
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Worker 0' },
    )).rejects.toThrow(/emulator-5556 is in use by another Tapsmith session/);
    expect(mocks.devices).toHaveLength(0);
  });

  it("refuses to select anything on another session's daemon while it drives that session's device", async () => {
    claimDevice('emulator-5554', OTHER, { daemonAddress: 'localhost:50051' });
    const client = {
      waitForReady: vi.fn(async () => true),
      close: vi.fn(),
      listDevices: vi.fn(async () => ({ devices: [{ serial: 'emulator-5554', state: 'Active' }] })),
    };
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5556', daemonAddress: '127.0.0.1:50051' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', client: client as never },
    )).rejects.toThrow(/The Tapsmith daemon at 127\.0\.0\.1:50051 belongs to another session/);
    expect(mocks.devices[0].setDevice).not.toHaveBeenCalled();
  });

  it('uses a daemon on a port another session once used when that daemon is not driving its device', async () => {
    // The other session's daemon died and an unrelated, fresh one took the port.
    claimDevice('emulator-5554', OTHER, { daemonAddress: 'localhost:50051' });
    const client = {
      waitForReady: vi.fn(async () => true),
      close: vi.fn(),
      listDevices: vi.fn(async () => ({ devices: [{ serial: 'emulator-5554', state: 'Discovered' }] })),
    };
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5556', daemonAddress: 'localhost:50051' },
      makeConfig(),
      { claimSession: SESSION, startNetworkProxy: false, label: 'Device', client: client as never },
    )).resolves.toBeDefined();
  });
});
