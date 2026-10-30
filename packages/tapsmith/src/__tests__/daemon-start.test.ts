import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { awaitDaemonStart, captureDaemonOutput, daemonStartFailure, planDaemonPort, spawnDaemonBinary, DAEMON_INSTANCE_ENV, type DaemonProbe } from '../daemon-start.js';

// spawn is real unless a test makes it throw, the way it does for a binary of
// another architecture (PILOT-490).
const spawnThrows = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnThrows.error) throw spawnThrows.error;
      return actual.spawn(...args);
    },
  };
});

// What `tapsmith test` says when its daemon does not start: the daemon's own
// words, and "Is tapsmith-core installed?" only when it could not be run at
// all (PILOT-463). Real child processes stand in for the daemon — a shell
// script that prints and exits is exactly the failure being reported.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-daemon-start-'));
});

afterEach(() => {
  spawnThrows.error = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** An executable script standing in for tapsmith-core. */
function fakeDaemon(body: string): string {
  const bin = path.join(tmpDir, 'tapsmith-core');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

function start(bin: string, logPath?: string): { child: ChildProcess; capture: ReturnType<typeof captureDaemonOutput> } {
  const capture = captureDaemonOutput(logPath, () => {});
  try {
    return { child: spawn(bin, [], { stdio: capture.stdio }), capture };
  } finally {
    capture.closeParentFds();
  }
}

const never = (): Promise<boolean> => new Promise(() => {});

/** What answers on the address: `ready` decides when, `instanceId` whose daemon it is. */
function probe(
  ready: (ms: number) => Promise<boolean>,
  answer: { instanceId?: string; pid?: number } | (() => Promise<{ instanceId?: string; pid?: number }>) = { instanceId: MINE },
): DaemonProbe {
  return {
    waitForReady: ready,
    ping: typeof answer === 'function' ? answer : () => Promise.resolve({ version: 'test', agentConnected: false, ...answer }),
  };
}
const MINE = 'instance-mine';
const ours = (child: ChildProcess): { child: ChildProcess; instanceId: string } => ({ child, instanceId: MINE });
function idleChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { exitCode: null, signalCode: null });
  return child;
}

describe('awaitDaemonStart()', () => {
  it('reports an exit at once, with the code, instead of waiting out the budget', async () => {
    const { child, capture } = start(fakeDaemon('echo "Error: Address already in use (os error 48)" >&2\nexit 1'));
    const began = Date.now();
    const outcome = await awaitDaemonStart(ours(child), probe(never), { budgetMs: 30_000, address: 'localhost:50051' });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(outcome).toEqual({ ok: false, cause: 'tapsmith-core exited with code 1 before it answered', spawnFailed: false });
    expect(capture.recentOutput()).toBe('Error: Address already in use (os error 48)');
    capture.dispose();
  });

  it('names the signal that stopped it', async () => {
    const { child, capture } = start(fakeDaemon('kill -9 $$'));
    const outcome = await awaitDaemonStart(ours(child), probe(never), { budgetMs: 30_000, address: 'localhost:50051' });
    expect(outcome).toMatchObject({ ok: false, cause: 'tapsmith-core was stopped by SIGKILL before it answered' });
    capture.dispose();
  });

  it('says it could not run a binary that does not exist', async () => {
    const { child, capture } = start(path.join(tmpDir, 'missing', 'tapsmith-core'));
    const outcome = await awaitDaemonStart(ours(child), probe(never), { budgetMs: 30_000, address: 'localhost:50051' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.spawnFailed).toBe(true);
    expect(outcome.cause).toMatch(/^could not run tapsmith-core: spawn .*tapsmith-core ENOENT$/);
    // The path once: spawn's own message already names it.
    expect(outcome.cause.split(path.join(tmpDir, 'missing')).length).toBe(2);
    capture.dispose();
  });

  it('gives up at the budget when it neither answers nor exits', async () => {
    const { child, capture } = start(fakeDaemon('sleep 30'));
    try {
      const outcome = await awaitDaemonStart(ours(child), probe(() => Promise.resolve(false)), { budgetMs: 300, windowMs: 100, address: 'localhost:50999' });
      expect(outcome).toEqual({ ok: false, cause: 'tapsmith-core did not answer on localhost:50999 within 0.3s', spawnFailed: false });
    } finally {
      child.kill('SIGKILL');
      capture.dispose();
    }
  });

  it('is ready as soon as it answers', async () => {
    expect(await awaitDaemonStart(ours(idleChild()), probe(() => Promise.resolve(true)), { budgetMs: 1_000, address: 'x' })).toEqual({ ok: true });
  });

  // PILOT-914: a daemon of another session that took the port first answers
  // there too. Ours then fails to bind, and the session used to drive theirs.
  it('refuses another daemon that answers on the address, naming its pid, instead of adopting it', async () => {
    const outcome = await awaitDaemonStart(
      ours(idleChild()),
      probe(() => Promise.resolve(true), { instanceId: 'instance-theirs', pid: 4242 }),
      { budgetMs: 1_000, address: 'localhost:50051' },
    );
    expect(outcome).toEqual({
      ok: false,
      cause: 'another tapsmith-core (pid 4242) answered on localhost:50051, so the one this session started could not take that port',
      spawnFailed: false,
      portTaken: true,
    });
  });

  it('refuses one that a Tapsmith session did not start (no instance id) only when ours has one: a hand-started daemon is not ours either', async () => {
    const outcome = await awaitDaemonStart(
      ours(idleChild()),
      probe(() => Promise.resolve(true), { instanceId: '', pid: 77 }),
      { budgetMs: 1_000, address: 'localhost:50051' },
    );
    expect(outcome).toMatchObject({ ok: false, portTaken: true, cause: expect.stringContaining('(pid 77)') });
  });

  it('accepts a daemon too old to report who it is (no pid either): there is nothing to compare', async () => {
    const outcome = await awaitDaemonStart(
      ours(idleChild()),
      probe(() => Promise.resolve(true), { instanceId: '', pid: 0 }),
      { budgetMs: 1_000, address: 'x' },
    );
    expect(outcome).toEqual({ ok: true });
  });

  // Losing the port race, ours usually exits (bind failure) before the other
  // daemon's answer arrives: that is still a taken port, not a crash.
  it('reports a taken port when ours exits and another daemon answers on the address', async () => {
    const { child, capture } = start(fakeDaemon('echo "Error: Address already in use (os error 48)" >&2\nexit 1'));
    const outcome = await awaitDaemonStart(
      ours(child),
      probe(async () => { await new Promise((r) => setTimeout(r, 200)); return true; }, { instanceId: 'instance-theirs', pid: 4242 }),
      { budgetMs: 30_000, address: 'localhost:50051' },
    );
    expect(outcome).toEqual({
      ok: false,
      cause: 'another tapsmith-core (pid 4242) answered on localhost:50051, so the one this session started could not take that port',
      spawnFailed: false,
      portTaken: true,
    });
    capture.dispose();
  });

  it('reports a taken port when ours exits and a daemon too old to name itself answers: it cannot be ours', async () => {
    const { child, capture } = start(fakeDaemon('exit 1'));
    const outcome = await awaitDaemonStart(
      ours(child),
      probe(async () => { await new Promise((r) => setTimeout(r, 100)); return true; }, { instanceId: '', pid: 0 }),
      { budgetMs: 30_000, address: 'localhost:50051' },
    );
    expect(outcome).toMatchObject({ ok: false, portTaken: true, cause: expect.stringContaining('another tapsmith-core (pid unknown)') });
    capture.dispose();
  });

  it('keeps waiting while what answers cannot be asked who it is, and reports our daemon\'s exit', async () => {
    const { child, capture } = start(fakeDaemon('sleep 0.3\necho "Error: Address already in use (os error 48)" >&2\nexit 1'));
    const outcome = await awaitDaemonStart(
      ours(child),
      probe(() => Promise.resolve(true), () => Promise.reject(new Error('14 UNAVAILABLE'))),
      { budgetMs: 30_000, windowMs: 50, address: 'localhost:50051' },
    );
    expect(outcome).toEqual({ ok: false, cause: 'tapsmith-core exited with code 1 before it answered', spawnFailed: false });
    capture.dispose();
  });
});

describe('captureDaemonOutput()', () => {
  it('without a log, catches stderr in a temp file it removes afterwards', async () => {
    const { child, capture } = start(fakeDaemon('echo out\necho err >&2\nexit 2'));
    await awaitDaemonStart(ours(child), probe(never), { budgetMs: 30_000, address: 'x' });
    // stdout is the daemon's tracing; only stderr is kept.
    expect(capture.recentOutput()).toBe('err');
    expect(capture.logPath).toBeUndefined();
    capture.dispose();
    expect(capture.recentOutput()).toBe('');
  });

  it('with TAPSMITH_DAEMON_LOG, appends both streams there and quotes only what this daemon wrote', async () => {
    const logPath = path.join(tmpDir, 'logs', 'daemon.log');
    fs.mkdirSync(path.dirname(logPath));
    fs.writeFileSync(logPath, 'an earlier run\n');
    const { child, capture } = start(fakeDaemon('echo starting\necho "Error: bad" >&2\nexit 1'), logPath);
    await awaitDaemonStart(ours(child), probe(never), { budgetMs: 30_000, address: 'x' });
    expect(capture.logPath).toBe(logPath);
    expect(capture.recentOutput()).toBe('starting\nError: bad');
    capture.dispose();
    // The user's file is theirs: never removed.
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('an earlier run\nstarting\nError: bad\n');
  });

  it('falls back to the temp capture, after a warning, when the log cannot be opened', () => {
    const blocked = path.join(tmpDir, 'blocked');
    fs.mkdirSync(blocked);
    const warnings: string[] = [];
    const capture = captureDaemonOutput(blocked, (m) => warnings.push(m));
    expect(warnings[0]).toContain(`Could not open daemon log ${blocked}`);
    expect(capture.logPath).toBeUndefined();
    expect(Array.isArray(capture.stdio)).toBe(true);
    capture.closeParentFds();
    capture.dispose();
  });
});

describe('daemonStartFailure()', () => {
  it('quotes the daemon\'s output under the cause, with the log path last and nothing after it', () => {
    expect(daemonStartFailure('Failed to start Tapsmith daemon', {
      cause: 'tapsmith-core exited with code 1 before it answered',
      spawnFailed: false,
      recentOutput: 'Error: Address already in use (os error 48)',
      logPath: '/tmp/daemon.log',
    }).split('\n')).toEqual([
      // The cause on the headline: one-line progress rows show only that.
      'Failed to start Tapsmith daemon: tapsmith-core exited with code 1 before it answered',
      '  Recent daemon output:',
      '    Error: Address already in use (os error 48)',
      '  Daemon log: /tmp/daemon.log',
    ]);
  });

  it('asks whether tapsmith-core is installed only when it could not be run', () => {
    const ran = daemonStartFailure('Failed', { cause: 'exited', spawnFailed: false, recentOutput: '' });
    expect(ran).not.toContain('installed');
    const missing = daemonStartFailure('Failed', { cause: 'could not run /x: spawn /x ENOENT', spawnFailed: true, recentOutput: '' });
    expect(missing.split('\n')).toEqual([
      'Failed: could not run /x: spawn /x ENOENT',
      '  Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.',
    ]);
  });

  it('puts extra hints after the cause', () => {
    expect(daemonStartFailure('Failed', {
      cause: 'exited', spawnFailed: false, recentOutput: '', hints: ['Port 50052 is already in use.', 'Run: lsof -ti tcp:50052 | xargs kill'],
    }).split('\n')).toEqual(['Failed: exited', '  Port 50052 is already in use.', '  Run: lsof -ti tcp:50052 | xargs kill']);
  });
});

// ─── spawn throwing (PILOT-490) ───

/** What Node throws from spawn() itself: an ErrnoException with no path in its message. */
function spawnError(code: string, errno: number): Error {
  return Object.assign(new Error(`spawn ${code}`), { code, errno, syscall: 'spawn' });
}

/** Run `fn` as if on `platform`. */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('spawnDaemonBinary()', () => {
  it('hands back the child when spawn succeeds', async () => {
    const spawned = spawnDaemonBinary(fakeDaemon('exit 3'), [], { stdio: 'ignore' });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const code = await new Promise((resolve) => spawned.child.once('exit', resolve));
    expect(code).toBe(3);
  });

  // PILOT-914: the daemon echoes it from Ping, so the session knows its own.
  it('starts each daemon with a fresh instance id in its environment, keeping the rest of the environment', async () => {
    const out = path.join(tmpDir, 'env');
    const bin = fakeDaemon(`echo "$${DAEMON_INSTANCE_ENV} $TAPSMITH_TEST_KEEP" >> ${out}`);
    const first = spawnDaemonBinary(bin, [], { stdio: 'ignore', env: { ...process.env, TAPSMITH_TEST_KEEP: 'kept' } });
    const second = spawnDaemonBinary(bin, [], { stdio: 'ignore', env: { ...process.env, TAPSMITH_TEST_KEEP: 'kept' } });
    if (!first.ok || !second.ok) throw new Error('expected both to spawn');
    await Promise.all([first, second].map((s) => new Promise((resolve) => s.child.once('exit', resolve))));
    expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(fs.readFileSync(out, 'utf-8').trim().split('\n').sort())
      .toEqual([`${first.instanceId} kept`, `${second.instanceId} kept`].sort());
  });

  it('replaces an instance id inherited from its own environment', async () => {
    const out = path.join(tmpDir, 'env');
    const spawned = spawnDaemonBinary(fakeDaemon(`echo "$${DAEMON_INSTANCE_ENV}" > ${out}`), [], { stdio: 'ignore', env: { ...process.env, [DAEMON_INSTANCE_ENV]: 'inherited' } });
    if (!spawned.ok) throw new Error('expected a spawn');
    await new Promise((resolve) => spawned.child.once('exit', resolve));
    expect(fs.readFileSync(out, 'utf-8').trim()).toBe(spawned.instanceId);
  });

  it('turns ENOEXEC into a failed start naming the binary and this machine\'s architecture', () => {
    spawnThrows.error = spawnError('ENOEXEC', -8);
    const target = `${process.platform}-${process.arch}`;
    expect(spawnDaemonBinary('/x/tapsmith-core', ['--port', '1'], { stdio: 'ignore' })).toEqual({
      ok: false,
      cause: 'could not run tapsmith-core: /x/tapsmith-core is not an executable for this machine (ENOEXEC)',
      spawnFailed: true,
      spawnHint: `It is built for another platform or architecture than this Node (${target}), or it is damaged. `
        + `Reinstall Tapsmith with this Node so npm fetches @tapsmith/core-${target}, `
        + `or set TAPSMITH_DAEMON_BIN to a tapsmith-core built for ${target}.`,
    });
  });

  it('names macOS\'s "Bad CPU type" (errno -86, which Node cannot name) EBADARCH', () => {
    spawnThrows.error = Object.assign(new Error('spawn Unknown system error -86'), { code: 'Unknown system error -86', errno: -86, syscall: 'spawn' });
    const spawned = onPlatform('darwin', () => spawnDaemonBinary('/x/tapsmith-core', [], { stdio: 'ignore' }));
    expect(spawned).toMatchObject({
      ok: false,
      cause: 'could not run tapsmith-core: /x/tapsmith-core is not an executable for this machine (EBADARCH)',
      spawnHint: expect.stringContaining('TAPSMITH_DAEMON_BIN'),
    });
  });

  it('reports any other spawn errno in spawn\'s own "spawn <path> <code>" shape, with the install question', () => {
    spawnThrows.error = spawnError('E2BIG', -7);
    const spawned = spawnDaemonBinary('/x/tapsmith-core', [], { stdio: 'ignore' });
    expect(spawned).toEqual({ ok: false, cause: 'could not run tapsmith-core: spawn /x/tapsmith-core E2BIG', spawnFailed: true });
  });

  it('rethrows what is not a spawn failure: a bad argument is the caller\'s bug', () => {
    spawnThrows.error = Object.assign(new TypeError('The "file" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' });
    expect(() => spawnDaemonBinary('/x/tapsmith-core', [], { stdio: 'ignore' })).toThrow(TypeError);
  });

  // The real thing: macOS's posix_spawn refuses a file that is no executable
  // format at all. (Linux's execvp hands it to /bin/sh instead, which exits
  // 126 — an ordinary exit, with the shell's complaint on stderr.)
  it.runIf(process.platform === 'darwin')('catches a real binary macOS cannot execute', () => {
    const bin = path.join(tmpDir, 'tapsmith-core');
    fs.writeFileSync(bin, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]), { mode: 0o755 });
    expect(spawnDaemonBinary(bin, [], { stdio: 'ignore' })).toMatchObject({
      ok: false,
      cause: `could not run tapsmith-core: ${bin} is not an executable for this machine (ENOEXEC)`,
      spawnFailed: true,
    });
  });

  it('reads, formatted, as a start failure with the architecture hint in place of the install question', () => {
    spawnThrows.error = spawnError('ENOEXEC', -8);
    const spawned = spawnDaemonBinary('/x/tapsmith-core', [], { stdio: 'ignore' });
    if (spawned.ok) throw new Error('expected a failed spawn');
    const lines = daemonStartFailure('Failed to start Tapsmith daemon', { ...spawned, recentOutput: '' }).split('\n');
    expect(lines).toEqual([
      'Failed to start Tapsmith daemon: could not run tapsmith-core: /x/tapsmith-core is not an executable for this machine (ENOEXEC)',
      `  ${spawned.spawnHint}`,
    ]);
  });
});

// PILOT-914: what `tapsmith test` does with the port it was asked to start
// its daemon on. A listener that misses the 1 s probe used to be SIGTERMed as
// stale — another session's daemon that was still starting, or slow on a
// loaded machine, or a process that is no daemon at all.
describe('planDaemonPort()', () => {
  const own = new Set([111]);

  it('takes a free port', () => {
    expect(planDaemonPort({ port: '50051', answered: false, listeners: [], ownDaemons: own })).toEqual({ kind: 'take', stopOwn: [] });
  });

  it('moves off a port where another live session answers', () => {
    expect(planDaemonPort({ port: '50051', answered: true, listeners: [222], ownDaemons: own }))
      .toEqual({ kind: 'move', reason: 'port 50051 is in use by another Tapsmith session' });
  });

  it('moves off, and never stops, a listener that is not this process\'s own daemon even when it does not answer', () => {
    expect(planDaemonPort({ port: '50051', answered: false, listeners: [222, 333], ownDaemons: own })).toEqual({
      kind: 'move',
      reason: 'port 50051 is held by pid 222, 333, which did not answer as a Tapsmith daemon in time (it may be another session\'s daemon still starting)',
    });
  });

  it('moves off when its own stopping daemon shares the port with another listener', () => {
    expect(planDaemonPort({ port: '50051', answered: false, listeners: [111, 222], ownDaemons: own }))
      .toMatchObject({ kind: 'move', reason: expect.stringContaining('pid 222,') });
  });

  it('stops only this process\'s own earlier daemons still exiting, and reuses the port', () => {
    expect(planDaemonPort({ port: '50051', answered: false, listeners: [111], ownDaemons: own })).toEqual({ kind: 'take', stopOwn: [111] });
  });
});
