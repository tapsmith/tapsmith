import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeviceInfoProto } from '../grpc-client.js';
import type { TapsmithConfig } from '../config.js';

// A headless MCP session started the agent without ever installing the
// config's app, so a simulator without it (or with a stale build) hung for
// the agent's whole deadline. And a refused StartAgent — success: false, the
// daemon's reason in errorMessage — was logged "Agent started", leaving
// every device tool to fail with "Not connected to agent" while the reason
// sat in the daemon log (PILOT-916).

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type Device = Pick<DeviceInfoProto, 'serial' | 'state' | 'platform'>;
let devices: Device[];
/** Every install and agent start the session made, in order. */
let calls: string[];
let agentConnected: boolean;
let startAgentResponse: () => Promise<{ success?: boolean; errorMessage?: string }>;
let installApkResponse: () => Promise<{ success: boolean; errorMessage?: string }>;
/** What each agent round trip after a start answers, in turn (then the last one forever). */
let hierarchyAnswers: Array<() => Promise<{ hierarchyXml: string; errorMessage: string }>>;
vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    constructor(readonly address: string) {}
    waitForReady(): Promise<boolean> { return Promise.resolve(spawnMock.mock.calls.length > 0); }
    ping(): Promise<{ version: string; agentConnected: boolean }> { return Promise.resolve({ version: 'test', agentConnected }); }
    listDevices(): Promise<{ devices: Device[] }> { return Promise.resolve({ devices }); }
    setDevice(): Promise<{ success: boolean }> { return Promise.resolve({ success: true }); }
    startAgent(): Promise<unknown> {
      calls.push('startAgent');
      return startAgentResponse();
    }
    getUiHierarchy(): Promise<unknown> {
      calls.push('getUiHierarchy');
      const answer = hierarchyAnswers.length > 1 ? hierarchyAnswers.shift()! : hierarchyAnswers[0];
      return answer();
    }
    installApk(apkPath: string): Promise<unknown> {
      calls.push(`installApk ${path.basename(apkPath)}`);
      return installApkResponse();
    }
    close(): void {}
  },
}));

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/fake/tapsmith-core' }));
vi.mock('../ios-simulator-build.js', () => ({
  ensureSimulatorAgent: async () => '/fake/Agent_iphonesimulator27.0-arm64.xctestrun',
}));
vi.mock('../ios-devicectl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-devicectl.js')>()),
  isPhysicalDevice: () => false,
}));

/** What the simulator holds: absent, the same build, or another build. */
let simApp: 'absent' | 'matching' | 'stale';
let installAppError: Error | undefined;
vi.mock('../ios-simulator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-simulator.js')>()),
  listBootedSimulators: () => [],
  isAppInstalled: () => simApp !== 'absent',
  installedAppMatches: async () => simApp === 'matching',
  installAppAsync: async (_udid: string, appPath: string) => {
    calls.push(`installApp ${path.basename(appPath)}`);
    if (installAppError) throw installAppError;
  },
}));

let apkInstalled: boolean;
vi.mock('../emulator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../emulator.js')>()),
  isPackageInstalled: () => apkInstalled,
  installedApkMatches: () => true,
  waitForPackageIndexed: async () => {},
}));

let nextPort = 46000;
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

const { closeAllClients, configureMcpConnection, ensureConnected, ensurePlatformTarget, resolveDeviceTarget, confirmAgentAnswers } = await import('../mcp/connection.js');
const { TapsmithGrpcClient } = await import('../grpc-client.js');

class FakeDaemon extends EventEmitter {
  pid = 99996;
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

const iosConfig: Partial<TapsmithConfig> = {
  platform: 'ios', package: 'com.example.ShopNotes', app: 'build/ShopNotes.app',
  timeout: 1000, retries: 0, screenshot: 'never', testMatch: [], rootDir: '/p', outputDir: 'out',
  workers: 1, launchEmulators: false, daemonAddress: 'localhost:1',
};
const sim: Device = { serial: 'SIM-1', state: 'Active', platform: 'ios' };

/** The refusal a real daemon sends when the runner cannot open the app. */
const LAUNCH_REFUSAL = 'The iOS agent could not launch com.example.ShopNotes on simulator SIM-1: '
  + 'Failed to launch com.example.ShopNotes: The request to open "com.example.ShopNotes" failed.';

let tmpDir: string;
let savedHome: string | undefined;
let stderr: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-agent-install-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => new FakeDaemon());
  calls = [];
  devices = [sim];
  agentConnected = false;
  startAgentResponse = () => Promise.resolve({ success: true });
  installApkResponse = () => Promise.resolve({ success: true });
  hierarchyAnswers = [() => Promise.resolve({ hierarchyXml: '<hierarchy/>', errorMessage: '' })];
  simApp = 'absent';
  installAppError = undefined;
  apkInstalled = false;
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

const target = (config: Partial<TapsmithConfig> = iosConfig) => ensurePlatformTarget(config as TapsmithConfig);

describe('the app under test, on a headless session\'s device', () => {
  it('is installed on the simulator before the agent starts when it is missing', async () => {
    await target();
    expect(calls).toEqual(['installApp ShopNotes.app', 'startAgent']);
    expect(stderr).toContain('installing ShopNotes.app');
  });

  it('is replaced when the simulator holds a different build', async () => {
    simApp = 'stale';
    await target();
    expect(calls).toEqual(['installApp ShopNotes.app', 'startAgent']);
    expect(stderr).toContain('(installed build differs)');
  });

  it('is left alone when the simulator holds the same build', async () => {
    simApp = 'matching';
    await target();
    expect(calls).toEqual(['startAgent']);
  });

  it('is not installed without `app` in the config', async () => {
    await target({ ...iosConfig, app: undefined });
    expect(calls).toEqual(['startAgent']);
  });

  it('is not reinstalled under an agent that is already running', async () => {
    agentConnected = true;
    await target();
    expect(calls).toEqual([]);
  });

  it('is installed from `apk` on Android too', async () => {
    devices = [{ serial: 'emulator-5554', state: 'Active', platform: 'android' }];
    await target({ ...iosConfig, platform: 'android', app: undefined, apk: 'build/app.apk', package: 'com.x' });
    expect(calls).toEqual(['installApk app.apk', 'startAgent', 'getUiHierarchy']);
  });

  it('that fails to install fails the target with the reason, and no agent is started', async () => {
    installAppError = new Error('simctl install: bundle is damaged');
    await expect(target()).rejects.toThrow('Failed to install iOS app: simctl install: bundle is damaged');
    expect(calls).toEqual(['installApp ShopNotes.app']);
  });

  it('is installed by a UI session\'s discovery start too', async () => {
    mcpConfig = iosConfig;
    configureMcpConnection({ uiMode: true });
    await ensureConnected();
    expect(calls).toEqual(['installApp ShopNotes.app', 'startAgent']);
  });
});

describe('an agent the daemon refused to start', () => {
  it('fails the target with the daemon\'s reason', async () => {
    startAgentResponse = () => Promise.resolve({ success: false, errorMessage: LAUNCH_REFUSAL });
    await expect(target()).rejects.toThrow(`Failed to start the agent on SIM-1: ${LAUNCH_REFUSAL}`);
  });

  it('is never logged as started', async () => {
    startAgentResponse = () => Promise.resolve({ success: false, errorMessage: LAUNCH_REFUSAL });
    await target().catch(() => undefined);
    expect(stderr).not.toContain('Agent started');
    expect(stderr).toContain(LAUNCH_REFUSAL);
  });

  // QA on a simulator: the target failed with the reason, but a device tool
  // naming the device went on to the daemon pointed at it — whose agent never
  // started — and answered "Not connected to agent".
  it('is the reason a device tool naming that device fails with', async () => {
    startAgentResponse = () => Promise.resolve({ success: false, errorMessage: LAUNCH_REFUSAL });
    await target().catch(() => undefined);
    await expect(resolveDeviceTarget({ device: 'SIM-1' })).rejects.toThrow(`Failed to start the agent on SIM-1: ${LAUNCH_REFUSAL}`);
  });

  it('no longer stops a device tool once a later start succeeds', async () => {
    startAgentResponse = () => Promise.resolve({ success: false, errorMessage: LAUNCH_REFUSAL });
    await target().catch(() => undefined);
    startAgentResponse = () => Promise.resolve({ success: true });
    await target();
    await expect(resolveDeviceTarget({ device: 'SIM-1' })).resolves.toMatchObject({ device: 'SIM-1' });
  });

  // The recorded reason is SIM-1's. Another session can move that daemon to
  // SIM-2, whose agent it then starts; SIM-1's reason is not SIM-2's.
  it('is not the reason given for another device the daemon was moved to', async () => {
    devices = [sim, { serial: 'SIM-2', state: 'Discovered', platform: 'ios' }];
    startAgentResponse = () => Promise.resolve({ success: false, errorMessage: LAUNCH_REFUSAL });
    await target().catch(() => undefined);
    devices = [{ ...sim, state: 'Discovered' }, { serial: 'SIM-2', state: 'Active', platform: 'ios' }];
    const err = await resolveDeviceTarget({ device: 'SIM-2' }).then(() => undefined, (e: Error) => e);
    expect(err?.message ?? '').not.toContain(LAUNCH_REFUSAL);
  });

  it('is reported, not taken as started, by a UI session\'s discovery start', async () => {
    mcpConfig = iosConfig;
    configureMcpConnection({ uiMode: true });
    startAgentResponse = () => Promise.resolve({ success: false, errorMessage: LAUNCH_REFUSAL });
    await ensureConnected();
    expect(stderr).not.toContain('Agent started');
    expect(stderr).toContain(LAUNCH_REFUSAL);
  });
});

// Measured on an emulator: StartAgent on Android answered while the agent it
// replaced was still being torn down, so the first device tool after a fresh
// app install failed "Agent connection dropped (empty response) and agent is
// unreachable", and one a second later worked.
describe('an Android agent, once started in a headless session', () => {
  const androidConfig = { ...iosConfig, platform: 'android', app: undefined, apk: 'build/app.apk', package: 'com.x' } as Partial<TapsmithConfig>;
  const dropped = () => Promise.reject(new Error('Agent connection dropped (empty response) and agent is unreachable'));

  beforeEach(() => {
    devices = [{ serial: 'emulator-5554', state: 'Active', platform: 'android' }];
  });

  it('is confirmed to answer before the target is ready, riding out a first dropped request', async () => {
    hierarchyAnswers = [dropped, () => Promise.resolve({ hierarchyXml: '<hierarchy/>', errorMessage: '' })];
    const t = await target(androidConfig);
    expect(t.deviceSerial).toBe('emulator-5554');
    expect(calls.filter((c) => c === 'getUiHierarchy')).toHaveLength(2);
  });

  it('is not probed on iOS, whose agent start waits for the runner itself', async () => {
    devices = [sim];
    await target();
    expect(calls).not.toContain('getUiHierarchy');
  });

  it('serves a device tool straight after the start', async () => {
    hierarchyAnswers = [dropped, () => Promise.resolve({ hierarchyXml: '<hierarchy/>', errorMessage: '' })];
    mcpConfig = androidConfig;
    await target(androidConfig);
    await expect(resolveDeviceTarget({ device: 'emulator-5554' })).resolves.toMatchObject({ device: 'emulator-5554' });
  });
});

describe('confirmAgentAnswers', () => {
  const client = () => new TapsmithGrpcClient('fake') as unknown as InstanceType<typeof TapsmithGrpcClient>;

  it('gives up after its attempts with the agent\'s last answer', async () => {
    hierarchyAnswers = [() => Promise.reject(new Error('Agent connection dropped (empty response) and agent is unreachable'))];
    await expect(confirmAgentAnswers(client(), { attempts: 3, delayMs: 1 }))
      .rejects.toThrow('The agent started but does not answer: Agent connection dropped (empty response) and agent is unreachable');
    expect(calls.filter((c) => c === 'getUiHierarchy')).toHaveLength(3);
  });

  it('counts an answer carrying an error as no answer', async () => {
    hierarchyAnswers = [
      () => Promise.resolve({ hierarchyXml: '', errorMessage: 'Not connected to agent' }),
      () => Promise.resolve({ hierarchyXml: '<hierarchy/>', errorMessage: '' }),
    ];
    await confirmAgentAnswers(client(), { attempts: 3, delayMs: 1 });
    expect(calls.filter((c) => c === 'getUiHierarchy')).toHaveLength(2);
  });
});
