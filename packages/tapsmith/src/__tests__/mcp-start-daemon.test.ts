import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// How the headless MCP server starts its daemon: where the daemon's output
// goes, and what happens to a daemon the session is still waiting on when the
// session ends (PILOT-453). No real daemon — spawn and gRPC are faked.

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

let waitForReady: () => Promise<boolean>;
let ping: (address: string) => Promise<{ version: string; agentConnected?: boolean }>;
let listDevices: (address: string) => Promise<{ devices: Array<{ serial: string; state: string }> }>;
let startAgent: (address: string) => Promise<unknown>;
let setDevice: (address: string) => Promise<{ success: boolean }>;
vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    constructor(readonly address: string) {}
    waitForReady(): Promise<boolean> { return waitForReady(); }
    ping(): Promise<{ version: string; agentConnected?: boolean }> { return ping(this.address); }
    listDevices(): Promise<{ devices: Array<{ serial: string; state: string }> }> { return listDevices(this.address); }
    setDevice(): Promise<{ success: boolean }> { return setDevice(this.address); }
    startAgent(): Promise<unknown> { return startAgent(this.address); }
    close(): void {}
  },
}));

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/fake/tapsmith-core' }));

let nextPort = 41000;
let pickPort: () => Promise<number> = () => Promise.resolve(nextPort++);
vi.mock('../port-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../port-utils.js')>()),
  pickFreePort: () => pickPort(),
}));

const { startDaemon, closeAllClients, ensureConnected, ensurePlatformTarget, getAllDaemonAddresses } = await import('../mcp/connection.js');
const { mcpDaemonLogPath } = await import('../mcp/port-file.js');
const { claimDevice, releaseSessionClaims } = await import('../device-claims.js');

class FakeDaemon extends EventEmitter {
  pid: number | undefined = 99999;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  // Like a real one, a killed daemon exits.
  kill = vi.fn(() => {
    if (this.exitCode === null && this.signalCode === null) this.exitWith(null, 'SIGTERM');
    return true;
  });
  unref(): void {}
  exitWith(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', code, signal));
  }
}

let tmpDir: string;
let savedHome: string | undefined;
let savedLog: string | undefined;
let stderr: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-start-daemon-'));
  savedHome = process.env.HOME;
  savedLog = process.env.TAPSMITH_DAEMON_LOG;
  process.env.HOME = tmpDir;
  delete process.env.TAPSMITH_DAEMON_LOG;
  spawnMock.mockReset();
  pickPort = () => Promise.resolve(nextPort++);
  ping = () => Promise.resolve({ version: 'test', agentConnected: true });
  listDevices = () => Promise.resolve({ devices: [] });
  startAgent = () => Promise.resolve({});
  setDevice = () => Promise.resolve({ success: true });
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  closeAllClients();
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedLog === undefined) delete process.env.TAPSMITH_DAEMON_LOG; else process.env.TAPSMITH_DAEMON_LOG = savedLog;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// What the MCP client sees: the tool result, not the server's stderr, which
// few clients show (PILOT-463).
describe('ensureConnected', () => {
  it('puts the daemon\'s own error in the tool error when the daemon it starts exits', async () => {
    // Nothing is running, so the session starts a daemon, which dies.
    waitForReady = () => Promise.resolve(false);
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      const daemon = new FakeDaemon();
      fs.writeSync(opts.stdio[2], 'Error: tapsmith-core refused to start: mitmproxy not found\n');
      daemon.exitWith(1);
      return daemon;
    });

    const err = await ensureConnected().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Error: tapsmith-core refused to start: mitmproxy not found');
    expect(message).toContain(`Daemon log: ${mcpDaemonLogPath()}`);
    expect(message).not.toContain('Is tapsmith-core installed?');
  });

  // A daemon that answers the readiness probe but not a ping — stale, wedged,
  // or not a Tapsmith daemon at all — is no more use than none (PILOT-489).
  const unconnectableAtDefault = (address: string): Promise<{ version: string; agentConnected?: boolean }> =>
    address === 'localhost:50051'
      ? Promise.reject(new Error('14 UNAVAILABLE: Connection dropped'))
      : Promise.resolve({ version: 'test', agentConnected: true });

  it('starts its own daemon when the only daemon it found cannot be connected to', async () => {
    waitForReady = () => Promise.resolve(true);
    ping = unconnectableAtDefault;
    spawnMock.mockImplementation(() => new FakeDaemon());

    await ensureConnected();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The new daemon, on a free port — not the one that failed.
    expect(getAllDaemonAddresses()).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('says why a daemon it found could not be used when its own daemon fails to start too', async () => {
    // The found daemon answers but fails its ping; the started one exits.
    ping = unconnectableAtDefault;
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      const daemon = new FakeDaemon();
      fs.writeSync(opts.stdio[2], 'Error: tapsmith-core refused to start: mitmproxy not found\n');
      daemon.exitWith(1);
      return daemon;
    });
    // Exits before it answers, so only the found daemon is ever ready.
    waitForReady = () => Promise.resolve(spawnMock.mock.calls.length === 0);

    const err = await ensureConnected().then(() => undefined, (e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain('Could not connect to the daemon at localhost:50051: 14 UNAVAILABLE: Connection dropped');
    expect(message).toContain('Failed to start an android daemon: tapsmith-core exited with code 1 before it answered');
    expect(message).toContain('Error: tapsmith-core refused to start: mitmproxy not found');
    expect(message).toContain(`Daemon log: ${mcpDaemonLogPath()}`);
    expect(message).not.toContain('installed');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('starts no daemon of its own when one of the daemons it found connects', async () => {
    const saved = process.env.TAPSMITH_DAEMON_ADDRESS;
    process.env.TAPSMITH_DAEMON_ADDRESS = 'localhost:50051,localhost:50052';
    try {
      waitForReady = () => Promise.resolve(true);
      ping = unconnectableAtDefault;

      await ensureConnected();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(getAllDaemonAddresses()).toBe('localhost:50052');
    } finally {
      if (saved === undefined) delete process.env.TAPSMITH_DAEMON_ADDRESS; else process.env.TAPSMITH_DAEMON_ADDRESS = saved;
    }
  });

  it('starts no daemon for a session that closed while it was connecting', async () => {
    waitForReady = () => Promise.resolve(true);
    ping = (address) => {
      closeAllClients();
      return unconnectableAtDefault(address);
    };

    await ensureConnected().then(() => undefined, (e: unknown) => e);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('startDaemon', () => {
  it('hands the daemon a log file for stdout and stderr, never a pipe back to the server', async () => {
    let stdio: unknown;
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: unknown; detached: boolean }) => {
      stdio = opts.stdio;
      expect(opts.detached).toBe(true);
      const [, out, err] = opts.stdio as [string, number, number];
      fs.writeSync(err, 'daemon says hello\n');
      expect(out).toBe(err);
      return new FakeDaemon();
    });
    waitForReady = () => Promise.resolve(true);

    const conn = await startDaemon();
    expect(conn).not.toBeNull();
    expect(Array.isArray(stdio)).toBe(true);
    expect((stdio as unknown[])[0]).toBe('ignore');
    expect(typeof (stdio as unknown[])[2]).toBe('number');
    expect(fs.readFileSync(mcpDaemonLogPath(), 'utf-8')).toBe('daemon says hello\n');
    expect(stderr).toContain(`log: ${mcpDaemonLogPath()}`);
  });

  it('fails with the daemon\'s own words and its log path when it exits, without asking about the install', async () => {
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      fs.writeSync(opts.stdio[2], 'Error: address already in use\n');
      daemon.exitWith(1);
      return daemon;
    });
    // Never answers: only the exit can end the wait, and it must, at once.
    waitForReady = () => new Promise(() => {});

    const err = await startDaemon('ios').then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.split('\n')).toEqual([
      'Failed to start an ios daemon: tapsmith-core exited with code 1 before it answered',
      '  Recent daemon output:',
      '    Error: address already in use',
      `  Daemon log: ${mcpDaemonLogPath()}`,
    ]);
    // The server's stderr still says it too.
    expect(stderr).toContain('Error: address already in use');
  });

  it('asks whether tapsmith-core is installed when it could not be run', async () => {
    const daemon = new FakeDaemon();
    daemon.pid = undefined;
    spawnMock.mockImplementation(() => {
      setImmediate(() => daemon.emit('error', Object.assign(new Error('spawn /fake/tapsmith-core ENOENT'), { code: 'ENOENT' })));
      return daemon;
    });
    waitForReady = () => new Promise(() => {});

    const err = await startDaemon().then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain('spawn /fake/tapsmith-core ENOENT');
    expect((err as Error).message).toContain('Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN');
  });

  it('reports a binary for another architecture (spawn throws) through the same formatted error, with its log path', async () => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC', errno: -8, syscall: 'spawn' });
    });

    const err = await startDaemon('android').then(() => undefined, (e: unknown) => e);
    const lines = (err as Error).message.split('\n');
    expect(lines[0]).toBe('Failed to start an android daemon: could not run tapsmith-core: /fake/tapsmith-core is not an executable for this machine (ENOEXEC)');
    expect(lines[1]).toContain(`than this Node (${process.platform}-${process.arch})`);
    expect(lines.at(-1)).toBe(`  Daemon log: ${mcpDaemonLogPath()}`);
    expect((err as Error).message).not.toContain('Is tapsmith-core installed?');
    // The server's stderr says it too.
    expect(stderr).toContain('is not an executable for this machine');
  });

  it('says it did not answer when it neither answers nor exits', async () => {
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation(() => daemon);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      waitForReady = () => new Promise((resolve) => setTimeout(() => resolve(false), 10_000));
      const starting = startDaemon().then(() => undefined, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      const err = await starting;
      expect((err as Error).message).toMatch(/tapsmith-core did not answer on 127\.0\.0\.1:\d+ within 10s/);
      expect((err as Error).message).not.toContain('installed');
      expect(daemon.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still starts the daemon, output discarded, when the log cannot be opened', async () => {
    const blocked = path.join(tmpDir, 'blocked.log');
    fs.mkdirSync(blocked);
    process.env.TAPSMITH_DAEMON_LOG = blocked;
    let stdio: unknown;
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: unknown }) => {
      stdio = opts.stdio;
      return new FakeDaemon();
    });
    waitForReady = () => Promise.resolve(true);

    expect(await startDaemon()).not.toBeNull();
    expect(stdio).toBe('ignore');
    expect(stderr).toContain('daemon output will be discarded');
  });

  it('stops a daemon that is still starting when the session closes', async () => {
    // The client leaves during the seconds a daemon takes to answer. The
    // daemon is detached and `--outlive-parent`, and not yet registered or in
    // the connection list: nothing else would ever stop it.
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation(() => daemon);
    let ready!: (ok: boolean) => void;
    waitForReady = () => new Promise<boolean>((resolve) => { ready = resolve; });

    const starting = startDaemon();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    closeAllClients();
    expect(daemon.kill).toHaveBeenCalled();

    ready(false);
    expect(await starting).toBeNull();
  });

  it('does not join a closed session when the daemon answers just after the close', async () => {
    // The kill and a `waitForReady` that already succeeded race: the daemon
    // answers, and the connection must not land in the list the close reset.
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation(() => daemon);
    let ready!: (ok: boolean) => void;
    waitForReady = () => new Promise<boolean>((resolve) => { ready = resolve; });

    const starting = startDaemon();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    closeAllClients();
    ready(true);
    expect(await starting).toBeNull();
    expect(daemon.kill).toHaveBeenCalled();
  });

  it('never spawns a daemon for a session that closed while it was picking ports', async () => {
    let releasePort!: () => void;
    const portGate = new Promise<void>((resolve) => { releasePort = resolve; });
    pickPort = async () => { await portGate; return nextPort++; };
    waitForReady = () => Promise.resolve(true);

    const starting = startDaemon();
    closeAllClients();
    releasePort();
    expect(await starting).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// PILOT-381: the default-address fallback adopted another worktree's daemon and
// restarted that session's agent. A daemon another live session is driving its
// device through is not a candidate.
describe('daemons another session owns', () => {
  const other = {
    id: 'other-session', pid: process.pid, command: 'tapsmith test', project: '/elsewhere', startedAt: new Date().toISOString(),
  };
  afterEach(() => releaseSessionClaims(other.id));

  it('is not adopted while that session drives its device through it: the session starts its own', async () => {
    claimDevice('emulator-5554', other, { daemonAddress: 'localhost:50051' });
    waitForReady = () => Promise.resolve(true);
    listDevices = (address) => Promise.resolve({
      devices: address === 'localhost:50051' ? [{ serial: 'emulator-5554', state: 'Active' }] : [],
    });
    spawnMock.mockImplementation(() => new FakeDaemon());

    await ensureConnected();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(stderr).toContain('Ignoring localhost:50051 — another Tapsmith session is driving emulator-5554 through it');
  });

  it('is adopted when the daemon on that port is no longer driving the claimed device (a reused port)', async () => {
    claimDevice('emulator-5554', other, { daemonAddress: 'localhost:50051' });
    waitForReady = () => Promise.resolve(true);
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5554', state: 'Discovered' }] });
    spawnMock.mockImplementation(() => new FakeDaemon());

    await ensureConnected();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(getAllDaemonAddresses()).toContain('localhost:50051');
  });

  it('refuses a pinned device another live session holds, naming it, before starting a daemon for it', async () => {
    claimDevice('emulator-5554', { ...other, command: 'tapsmith test --ui' });
    spawnMock.mockImplementation(() => new FakeDaemon());
    // The session's own discovery daemon answers once spawned.
    waitForReady = () => Promise.resolve(spawnMock.mock.calls.length > 0);

    const config = {
      platform: 'android', device: 'emulator-5554', package: 'com.x', timeout: 1000, retries: 0, screenshot: 'never',
      testMatch: [], daemonAddress: 'localhost:50051', rootDir: '/p', outputDir: 'out', workers: 1, launchEmulators: false,
    } as unknown as Parameters<typeof ensurePlatformTarget>[0];
    await expect(ensurePlatformTarget(config)).rejects.toThrow(
      /Device emulator-5554 is in use by another Tapsmith session: `tapsmith test --ui` \(pid \d+\) in \/elsewhere/,
    );
    // Only discovery's daemon: none was started for the refused pin.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('gives the device back when its target cannot be prepared', async () => {
    const { listDeviceClaims } = await import('../device-claims.js');
    spawnMock.mockImplementation(() => new FakeDaemon());
    waitForReady = () => Promise.resolve(spawnMock.mock.calls.length > 0);
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5560', state: 'Discovered', platform: 'android' } as never] });
    setDevice = () => Promise.reject(new Error('selecting the device failed'));
    const config = {
      platform: 'android', device: 'emulator-5560', package: 'com.x', timeout: 1000, retries: 0, screenshot: 'never',
      testMatch: [], daemonAddress: 'localhost:50051', rootDir: '/p', outputDir: 'out', workers: 1, launchEmulators: false,
    } as unknown as Parameters<typeof ensurePlatformTarget>[0];
    await expect(ensurePlatformTarget(config)).rejects.toThrow();
    expect(listDeviceClaims().map((c) => c.device)).not.toContain('emulator-5560');
  });

  it('is not adopted when it is pointed at a device another session drives through a different daemon', async () => {
    claimDevice('emulator-5554', other, { daemonAddress: 'localhost:50999' });
    waitForReady = () => Promise.resolve(true);
    listDevices = (address) => Promise.resolve({
      devices: address === 'localhost:50051' ? [{ serial: 'emulator-5554', state: 'Active' }] : [],
    });
    spawnMock.mockImplementation(() => new FakeDaemon());

    await ensureConnected();
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(stderr).toContain('emulator-5554, which another Tapsmith session is driving');
  });

  it('claims the device an adopted daemon of its own is already pointed at', async () => {
    const { listDeviceClaims, currentSession } = await import('../device-claims.js');
    waitForReady = () => Promise.resolve(true);
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5570', state: 'Active' }] });
    spawnMock.mockImplementation(() => new FakeDaemon());

    await ensureConnected();
    expect(getAllDaemonAddresses()).toContain('localhost:50051');
    const claim = listDeviceClaims().find((c) => c.device === 'emulator-5570');
    expect(claim?.session.id).toBe(currentSession().id);
    // Given back with the connection.
    closeAllClients();
  });

  it('gives back the device it claimed for a found daemon that then cannot be connected to', async () => {
    const { listDeviceClaims } = await import('../device-claims.js');
    waitForReady = () => Promise.resolve(true);
    listDevices = (address) => Promise.resolve({
      devices: address === 'localhost:50051' ? [{ serial: 'emulator-5580', state: 'Active' }] : [],
    });
    ping = (address) => (address === 'localhost:50051'
      ? Promise.reject(new Error('14 UNAVAILABLE: Connection dropped'))
      : Promise.resolve({ version: 'test', agentConnected: true }));
    spawnMock.mockImplementation(() => new FakeDaemon());

    await ensureConnected();
    expect(getAllDaemonAddresses()).not.toContain('50051');
    expect(listDeviceClaims().map((c) => c.device)).not.toContain('emulator-5580');
  });

  it('gives the device back when the agent fails to start on a daemon it already pools', async () => {
    const { listDeviceClaims } = await import('../device-claims.js');
    // A configured daemon on the default address, pointed at nothing yet.
    waitForReady = () => Promise.resolve(true);
    listDevices = () => Promise.resolve({ devices: [{ serial: 'emulator-5610', state: 'Discovered', platform: 'android' } as never] });
    ping = () => Promise.resolve({ version: 'test', agentConnected: false });
    startAgent = () => Promise.reject(new Error('agent never started'));
    spawnMock.mockImplementation(() => new FakeDaemon());
    const config = {
      platform: 'android', device: 'emulator-5610', package: 'com.x', timeout: 1000, retries: 0, screenshot: 'never',
      testMatch: [], daemonAddress: 'localhost:50051', rootDir: '/p', outputDir: 'out', workers: 1, launchEmulators: false,
    } as unknown as Parameters<typeof ensurePlatformTarget>[0];
    await expect(ensurePlatformTarget(config)).rejects.toThrow(/agent never started/);
    expect(listDeviceClaims().map((c) => c.device)).not.toContain('emulator-5610');
  });
});
