import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process');
// Real sockets by default; one test swaps in a connect that never answers.
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, connect: vi.fn(actual.connect) };
});
// Real resolution by default; one test swaps in a lookup that never answers.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFileSync signatures make proper mock typing impractical
const mockedExecFileSync = vi.mocked(childProcess.execFileSync) as any;
const mockedSpawnSync = vi.mocked(childProcess.spawnSync);

import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { connectionRefused, daemonsOnAgentPort, findPidsOnPort, freeStaleAgentPort, parseDaemonsOnAgentPort } from '../port-utils.js';

// ─── Tests ───
//
// freeStaleAgentPort is safety-critical: it sends SIGKILL to PIDs found
// listening on a port. The pattern guard (`TapsmithAgen|tapsmith-core|xctest`) is
// the only thing preventing it from killing arbitrary user processes that
// happen to be on the chosen port. These tests pin that guard.

describe('freeStaleAgentPort', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn on process.kill needs loose typing
  let killSpy: any;

  beforeEach(() => {
    vi.resetAllMocks();
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    // Force darwin path so lsof is used; spawnSync (linux fuser) returns empty.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  function mockPidsAndComm(pid: number, comm: string): void {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'lsof') return `${pid}\n`;
      if (cmd === 'ps' && args?.includes('comm=')) return `${comm}\n`;
      throw new Error(`unexpected cmd: ${cmd}`);
    });
    // Linux branch fallback (unused on darwin path but defined for safety)
    mockedSpawnSync.mockReturnValue({
      pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null,
    } as unknown as ReturnType<typeof childProcess.spawnSync>);
  }

  it('does nothing when no PIDs are listening on the port', () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('no process');
      throw new Error(`unexpected: ${cmd}`);
    });
    freeStaleAgentPort(18701);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills a stale TapsmithAgent process on the port', () => {
    mockPidsAndComm(12345, 'TapsmithAgentUITes');
    freeStaleAgentPort(18701);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  it('reports stale port cleanup through the progress callback when provided', () => {
    mockPidsAndComm(12345, 'TapsmithAgentUITes');
    const onProgress = vi.fn();
    freeStaleAgentPort(18701, onProgress);
    expect(onProgress).toHaveBeenCalledWith({
      port: 18701,
      pid: 12345,
      command: 'TapsmithAgentUITes',
    });
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  it('kills a stale tapsmith-core daemon on the port', () => {
    mockPidsAndComm(12345, 'tapsmith-core');
    freeStaleAgentPort(18701);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  it('kills a stale xctest runner on the port', () => {
    mockPidsAndComm(12345, 'xctest');
    freeStaleAgentPort(18701);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  // ─── Safety guard: never kill unrelated processes ───
  //
  // Each of these is a process name that could realistically be on the same
  // ephemeral port range as agent ports. The regex must reject all of them.

  it.each([
    ['node'],
    ['Node Helper'],
    ['bash'],
    ['zsh'],
    ['Slack Helper'],
    ['Google Chrome Helper'],
    ['Code Helper (Renderer)'],
    ['firefox'],
    ['Python'],
    ['ruby'],
    ['java'],
    ['ssh'],
    ['nginx'],
    ['postgres'],
    ['docker'],
    ['Discord Helper'],
    ['Spotify'],
  ])('does NOT kill unrelated process: %s', (comm) => {
    mockPidsAndComm(12345, comm);
    freeStaleAgentPort(18701);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills only the matching process when multiple PIDs share a port', () => {
    let psCallCount = 0;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'lsof') return '111\n222\n333\n';
      if (cmd === 'ps') {
        psCallCount++;
        const pid = (args as string[])[1];
        // Only PID 222 is a stale TapsmithAgent; the others are unrelated.
        if (pid === '111') return 'node\n';
        if (pid === '222') return 'TapsmithAgentUITes\n';
        if (pid === '333') return 'Slack Helper\n';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    freeStaleAgentPort(18701);

    expect(psCallCount).toBe(3);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGKILL');
  });

  it('survives ps failures without killing anything', () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'lsof') return '12345\n';
      if (cmd === 'ps') throw new Error('process gone');
      throw new Error(`unexpected: ${cmd}`);
    });
    freeStaleAgentPort(18701);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

// ─── Tests: findPidsOnPort ───
//
// findPidsOnPort feeds the stale-daemon SIGTERM loops in cli.ts and
// dispatcher.ts. It must return only *listening* pids — matching both ends
// of established connections made the CLI kill its own gRPC probe socket's
// process (itself) — and must never include the caller's own pid.

describe('findPidsOnPort', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('macOS: queries lsof for LISTEN sockets only and excludes its own pid', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockedExecFileSync.mockReturnValue(`111\n${process.pid}\n222\n`);

    expect(findPidsOnPort(50051)).toEqual([111, 222]);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'lsof',
      ['-ti', 'tcp:50051', '-sTCP:LISTEN'],
      { encoding: 'utf-8' },
    );
  });

  it('macOS: returns empty when lsof finds nothing', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    // lsof exits 1 when no process matches
    mockedExecFileSync.mockImplementation(() => { throw new Error('exit 1'); });

    expect(findPidsOnPort(50051)).toEqual([]);
  });

  it('Linux: parses listener pids from ss output, dedupes, and excludes its own pid', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockedSpawnSync.mockReturnValue({
      pid: 0, output: [], status: 0, signal: null, stderr: '',
      stdout: [
        'LISTEN 0 511 127.0.0.1:50051 0.0.0.0:* users:(("tapsmith-core",pid=333,fd=12),("tapsmith-core",pid=333,fd=13))',
        `LISTEN 0 511 [::1]:50051 [::]:* users:(("node",pid=${process.pid},fd=20))`,
      ].join('\n'),
    } as unknown as ReturnType<typeof childProcess.spawnSync>);

    expect(findPidsOnPort(50051)).toEqual([333]);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'ss',
      ['-ltnpH', 'sport = :50051'],
      { encoding: 'utf-8' },
    );
  });

  it('Linux: returns empty when ss is unavailable or finds nothing', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockedSpawnSync.mockReturnValue({
      pid: 0, output: [], status: null, signal: null, stderr: '', stdout: '',
      error: new Error('spawn ss ENOENT'),
    } as unknown as ReturnType<typeof childProcess.spawnSync>);

    expect(findPidsOnPort(50051)).toEqual([]);
  });
});

// ─── Daemons on an agent port (PILOT-550) ───

describe('parseDaemonsOnAgentPort', () => {
  const ps = [
    '  101 /usr/local/lib/node_modules/@tapsmith/core-darwin-arm64/tapsmith-core --port 50051 --platform android',
    '  102 tapsmith-core --port 50961 --agent-port 18700',
    '  103 /repo/target/release/tapsmith-core --port 50070 --agent-port 18800',
    '  104 /bin/zsh -c grep tapsmith-core --agent-port 18700',
    '  105 /Users/me/My Tools/tapsmith-core --port 50052',
    '  106 /repo/target/release/tapsmith-core-helper --port 50053',
    '  107 /repo/tapsmith-core --agent-port=18700 --port 50054',
  ].join('\n');

  it('finds daemons on the default agent port and on an explicit one', () => {
    // 101 and 105 take the default; 102 and 107 name it; 104 is not a daemon; 106 is another binary.
    expect(parseDaemonsOnAgentPort(ps, 18700, new Set())).toEqual([101, 102, 105, 107]);
    expect(parseDaemonsOnAgentPort(ps, 18800, new Set())).toEqual([103]);
    expect(parseDaemonsOnAgentPort(ps, 18900, new Set())).toEqual([]);
  });

  it('leaves out the excluded pids', () => {
    expect(parseDaemonsOnAgentPort(ps, 18700, new Set([101, 105]))).toEqual([102, 107]);
  });
});

describe('daemonsOnAgentPort', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reads every process from ps', () => {
    mockedExecFileSync.mockReturnValue('  7 tapsmith-core --port 50961\n');
    expect(daemonsOnAgentPort(18700, new Set())).toEqual([7]);
    expect(mockedExecFileSync).toHaveBeenCalledWith('ps', ['-A', '-ww', '-o', 'pid=,args='], expect.anything());
  });

  it('is undefined when ps cannot be read', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(daemonsOnAgentPort(18700, new Set())).toBeUndefined();
  });
});

describe('connectionRefused', () => {
  /** A loopback server on a free port, closed after the test. */
  async function listen(host: string): Promise<{ port: number; close: () => Promise<void> }> {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    const port = (server.address() as net.AddressInfo).port;
    return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  /** A port that was free a moment ago: nothing listens there. */
  async function deadPort(): Promise<number> {
    const { port, close } = await listen('127.0.0.1');
    await close();
    return port;
  }

  it('is true when nothing listens on the address', async () => {
    const port = await deadPort();
    expect(await connectionRefused(`127.0.0.1:${port}`)).toBe(true);
    expect(await connectionRefused(`localhost:${port}`)).toBe(true);
  });

  it('is false when something accepts the connection', async () => {
    const server = await listen('127.0.0.1');
    try {
      expect(await connectionRefused(`127.0.0.1:${server.port}`)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('is false for localhost when only one of its addresses listens (the daemon binds 127.0.0.1 alone)', async () => {
    // `localhost` can resolve to ::1 first; a refusal there must not hide the
    // daemon on 127.0.0.1, which gRPC itself would reach.
    const server = await listen('127.0.0.1');
    try {
      expect(await connectionRefused(`localhost:${server.port}`)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('is false when the connect neither succeeds nor is refused in time', async () => {
    // A filtered port: the socket never connects and never errors.
    vi.mocked(net.connect).mockImplementationOnce((() => new net.Socket()) as unknown as typeof net.connect);
    const started = Date.now();
    expect(await connectionRefused('127.0.0.1:50051', 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('is false for an address it cannot parse or resolve', async () => {
    expect(await connectionRefused('no-port-here')).toBe(false);
    expect(await connectionRefused('host.invalid:50051')).toBe(false);
  });

  it('is false for a port out of range rather than throwing', async () => {
    await expect(connectionRefused('localhost:65536')).resolves.toBe(false);
  });

  it('is false when the host name does not resolve in time', async () => {
    vi.mocked(dns.lookup).mockImplementationOnce((() => new Promise(() => {})) as unknown as typeof dns.lookup);
    const started = Date.now();
    expect(await connectionRefused('slow-resolver.test:50051', 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
