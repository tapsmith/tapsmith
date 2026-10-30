/**
 * Starting a `tapsmith-core` daemon and, when that fails, saying why.
 *
 * A daemon that does not start used to be reported as "Is tapsmith-core
 * installed?" whatever had happened: the daemon's output went nowhere, so a
 * port already in use, a binary macOS refused or a bad argument all looked
 * like a missing install. This module keeps the daemon's own words and the
 * way it ended, and shapes them with error-detail.ts so they
 * survive every layer that reports a start failure.
 */

import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withDetail } from './error-detail.js';
import { readDaemonLogSince } from './mcp/daemon-log.js';

// ─── Capturing the daemon's output ───

export interface DaemonOutputCapture {
  /** Hand to `spawn`. */
  stdio: StdioOptions
  /** Close this process's copies of the descriptors once the daemon is spawned. */
  closeParentFds(): void
  /** What the daemon has written since it was spawned: its last lines, bounded. */
  recentOutput(): string
  /** The user's log file (`TAPSMITH_DAEMON_LOG`), when there is one to point at. */
  logPath: string | undefined
  /** Remove a temporary capture; a user's log file is never touched. */
  dispose(): void
}

/**
 * Where a daemon's output goes while it starts.
 *
 * With `logPath` (`TAPSMITH_DAEMON_LOG`) both streams are appended to it, as
 * before, and a failure quotes what this daemon added. Without it, stderr
 * alone goes to a private temporary file. That is where the daemon's start
 * failures go — main's `Error: …`, argument errors, panics — while its
 * tracing goes to stdout, which stays discarded. Not a pipe: the daemon, and
 * every process it starts with inherited stdio, would get EPIPE once nothing
 * reads the pipe, and an unread pipe that fills blocks them outright.
 *
 * The temporary file is removed by `dispose()` once the start is judged. A
 * daemon that started keeps its descriptor to the unlinked file, which costs
 * only what it writes to stderr — nothing, normally.
 */
export function captureDaemonOutput(
  logPath: string | undefined,
  warn: (message: string) => void,
): DaemonOutputCapture {
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const fd = fs.openSync(logPath, 'a');
      const startOffset = fs.fstatSync(fd).size;
      return {
        stdio: ['ignore', fd, fd],
        closeParentFds: () => closeQuietly(fd),
        recentOutput: () => readDaemonLogSince({ path: logPath, startOffset }),
        logPath,
        dispose: () => {},
      };
    } catch (err) {
      warn(`Could not open daemon log ${logPath}; only the daemon's errors will be kept: ${messageOf(err)}`);
    }
  }
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-daemon-'));
    const file = path.join(dir, 'stderr.log');
    const fd = fs.openSync(file, 'a', 0o600);
    let disposed = false;
    return {
      stdio: ['ignore', 'ignore', fd],
      closeParentFds: () => closeQuietly(fd),
      recentOutput: () => (disposed ? '' : readDaemonLogSince({ path: file, startOffset: 0 })),
      logPath: undefined,
      dispose: () => {
        disposed = true;
        fs.rmSync(dir!, { recursive: true, force: true });
      },
    };
  } catch {
    // No temp dir to be had: start the daemon anyway, as before, unheard.
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return { stdio: 'ignore', closeParentFds: () => {}, recentOutput: () => '', logPath: undefined, dispose: () => {} };
  }
}

function closeQuietly(fd: number): void {
  try { fs.closeSync(fd); } catch { /* already closed */ }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Spawning it ───

export interface DaemonStartFailed {
  ok: false
  /** One line: how it ended, or that it never answered. */
  cause: string
  /** It could not be run at all (ENOENT, EACCES): the one case where the install is in question. */
  spawnFailed: boolean
  /** What to do about a binary that could not be run, in place of the install question. */
  spawnHint?: string
  /**
   * Another daemon answered on the address — one that took the port first, so
   * ours could not bind it. Starting again on a free port can succeed.
   */
  portTaken?: true
}

export type DaemonStartOutcome = { ok: true } | DaemonStartFailed;

/**
 * The environment variable each daemon a session spawns is started with, set
 * to a fresh value: the daemon reports it back from `Ping`, which is how the
 * session tells the daemon it started from another one answering on the same
 * address (PILOT-914).
 */
export const DAEMON_INSTANCE_ENV = 'TAPSMITH_DAEMON_INSTANCE';

/** A spawned daemon, and the instance id it was started with. */
export interface SpawnedDaemon {
  ok: true
  child: ChildProcess
  instanceId: string
}

/**
 * macOS's "Bad CPU type in executable". Node has no name for it, so it
 * arrives as `Unknown system error -86`.
 */
const DARWIN_EBADARCH = -86;

/**
 * Spawn `tapsmith-core`. Most failures to run it — a missing binary (ENOENT),
 * one without execute permission (EACCES) — arrive later, as the child's
 * `error` event, which {@link awaitDaemonStart} reports. A few make `spawn`
 * throw instead: a binary for another architecture or platform (ENOEXEC,
 * macOS's EBADARCH), with a message that does not even name the file
 * ("spawn ENOEXEC"). Those come back here as a failed start, so every caller
 * reports them through its usual {@link daemonStartFailure} path.
 *
 * Only the spawn syscall's own errors are caught: a bad argument is a bug in
 * the caller, and still throws.
 */
export function spawnDaemonBinary(
  bin: string,
  args: readonly string[],
  options: SpawnOptions,
): SpawnedDaemon | DaemonStartFailed {
  const instanceId = randomUUID();
  const env = { ...(options.env ?? process.env), [DAEMON_INSTANCE_ENV]: instanceId };
  try {
    return { ok: true, child: spawn(bin, args, { ...options, env }), instanceId };
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (!(err instanceof Error) || errno.syscall !== 'spawn') throw err;
    const wrongArch = errno.code === 'ENOEXEC' || (process.platform === 'darwin' && errno.errno === DARWIN_EBADARCH);
    if (!wrongArch) {
      // The shape of spawn's own asynchronous errors: "spawn <path> <code>".
      return { ok: false, cause: `could not run tapsmith-core: spawn ${bin} ${errno.code ?? errno.message}`, spawnFailed: true };
    }
    const target = `${process.platform}-${process.arch}`;
    return {
      ok: false,
      cause: `could not run tapsmith-core: ${bin} is not an executable for this machine (${errno.code === 'ENOEXEC' ? 'ENOEXEC' : 'EBADARCH'})`,
      spawnFailed: true,
      spawnHint: `It is built for another platform or architecture than this Node (${target}), or it is damaged. `
        + `Reinstall Tapsmith with this Node so npm fetches @tapsmith/core-${target}, `
        + `or set TAPSMITH_DAEMON_BIN to a tapsmith-core built for ${target}.`,
    };
  }
}

// ─── Choosing its port ───

/** What to do with the port a daemon was asked to start on. */
export type DaemonPortPlan =
  /** Start there, after stopping these daemons of this process's that are still exiting. */
  | { kind: 'take'; stopOwn: number[] }
  /** Leave whoever holds it alone and start on a free port. */
  | { kind: 'move'; reason: string };

/**
 * Whether `tapsmith test` may start its daemon on `port` (PILOT-914).
 *
 * A daemon answering there belongs to another live session. So may one that
 * holds the port without answering a short probe: still starting, or slow on
 * a loaded machine — or the port's listener is no daemon at all. None of
 * those is ours to stop. A daemon that has lost its session shuts down by
 * itself (it watches the process that started it), so the only listeners this
 * process stops are its own earlier daemons that are still exiting.
 */
export function planDaemonPort(opts: {
  port: string
  /** Whether a daemon answered a probe on the port. */
  answered: boolean
  /** The processes listening on it. */
  listeners: readonly number[]
  /** Daemons this process started and has since stopped. */
  ownDaemons: ReadonlySet<number>
}): DaemonPortPlan {
  if (opts.answered) return { kind: 'move', reason: `port ${opts.port} is in use by another Tapsmith session` };
  const others = opts.listeners.filter((pid) => !opts.ownDaemons.has(pid));
  if (others.length > 0) {
    return {
      kind: 'move',
      reason: `port ${opts.port} is held by pid ${others.join(', ')}, which did not answer as a Tapsmith daemon in time `
        + '(it may be another session\'s daemon still starting)',
    };
  }
  return { kind: 'take', stopOwn: [...opts.listeners] };
}

// ─── Waiting for it to answer ───

/** The client calls {@link awaitDaemonStart} needs: a `TapsmithGrpcClient` on the daemon's address. */
export interface DaemonProbe {
  waitForReady(timeoutMs: number): Promise<boolean>
  ping(): Promise<{ instanceId?: string; pid?: number }>
}

/**
 * Wait for a just-spawned daemon to answer, for up to `budgetMs` — and stop
 * waiting the moment it exits or cannot be spawned, which a gRPC readiness
 * wait alone cannot see: a daemon that died at once used to be waited out
 * for the whole budget. Readiness is asked in windows of `windowMs` (grpc-js
 * backs off between connection attempts, so one long wait can sleep through
 * the moment the daemon comes up).
 *
 * Something answering is not enough: it must be *this* daemon (PILOT-914).
 * Another daemon that took the port first answers there too, while ours
 * fails to bind it — and a session that took the answer as its own drove
 * another session's daemon and device. So whatever answers is asked its
 * instance id, and one that is not ours is reported (`portTaken`), never
 * adopted. A daemon too old to report one (no pid either) cannot be told
 * apart and is accepted, as before.
 *
 * Call it straight after `spawn`, in the same tick, so an immediate spawn
 * error is not missed.
 */
export async function awaitDaemonStart(
  daemon: { child: ChildProcess; instanceId: string },
  probe: DaemonProbe,
  opts: { budgetMs: number; windowMs?: number; address: string },
): Promise<DaemonStartOutcome> {
  const { child } = daemon;
  let ended: DaemonStartOutcome | undefined;
  let notifyEnded!: () => void;
  const endedPromise = new Promise<void>((resolve) => { notifyEnded = resolve; });
  const end = (outcome: DaemonStartOutcome): void => {
    ended ??= outcome;
    notifyEnded();
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    end({
      ok: false,
      cause: signal
        ? `tapsmith-core was stopped by ${signal} before it answered`
        : `tapsmith-core exited with code ${code ?? 'unknown'} before it answered`,
      spawnFailed: false,
    });
  };
  // A spawn error's message ("spawn <path> ENOENT") already names the binary.
  const onError = (err: Error): void => {
    end({ ok: false, cause: `could not run tapsmith-core: ${err.message}`, spawnFailed: child.pid === undefined });
  };
  // Left attached: a later 'error' (a failed kill) must not crash the process.
  child.on('error', onError);
  child.once('exit', onExit);
  if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);

  const windowMs = opts.windowMs ?? 10_000;
  const deadline = Date.now() + opts.budgetMs;
  try {
    while (!ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const window = Math.min(windowMs, remaining);
      const windowEnd = Date.now() + window;
      const answered = await Promise.race([probe.waitForReady(window), endedPromise.then(() => false)]);
      if (answered && !ended) {
        // Bounded by the budget: a ping carries a long deadline of its own.
        let pingTimer: NodeJS.Timeout | undefined;
        const who = await Promise.race([
          probe.ping().then((answer) => answer, () => undefined),
          endedPromise.then(() => undefined),
          new Promise<undefined>((resolve) => { pingTimer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now())); }),
        ]);
        clearTimeout(pingTimer);
        if (who && !ended) {
          const pid = who.pid ?? 0;
          if ((who.instanceId ?? '') === daemon.instanceId || (pid === 0 && !who.instanceId)) return { ok: true };
          return {
            ok: false,
            cause: `another tapsmith-core (pid ${pid}) answered on ${opts.address}, so the one this session started could not take that port`,
            spawnFailed: false,
            portTaken: true,
          };
        }
        // It could not be asked: not answering after all, or something that
        // is no Tapsmith daemon. Wait on, for ours to answer or exit.
      }
      // A wait that gave up early (a closed channel) must not become a busy
      // loop: sit out the rest of the window, still watching for an exit.
      const rest = windowEnd - Date.now();
      if (!ended && rest > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, rest); }), endedPromise]);
        clearTimeout(timer);
      }
    }
  } finally {
    child.off('exit', onExit);
  }
  return ended ?? {
    ok: false,
    cause: `tapsmith-core did not answer on ${opts.address} within ${opts.budgetMs / 1000}s`,
    spawnFailed: false,
  };
}

// ─── Saying why ───

export interface DaemonStartFailureDetail {
  cause: string
  spawnFailed: boolean
  /** The daemon's last lines, from {@link DaemonOutputCapture.recentOutput} or the MCP log. */
  recentOutput: string
  logPath?: string
  /** Situation-specific advice (a port squatter's kill command), after the cause. */
  hints?: string[]
  /** Replaces the install question for a binary that could not be run (see {@link spawnDaemonBinary}). */
  spawnHint?: string
}

/**
 * `headline: <cause>`, then why: any hints, the install question only when
 * the binary could not be run, the daemon's recent output, and its log path —
 * last, on its own line, so nothing is copied along with it.
 */
export function daemonStartFailure(headline: string, detail: DaemonStartFailureDetail): string {
  // The cause on the headline: a launch-progress row shows only that line.
  const lines = [...(detail.hints ?? [])];
  if (detail.spawnFailed) {
    lines.push(detail.spawnHint ?? 'Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.');
  }
  const output = detail.recentOutput.split('\n').filter((line) => line.trim() !== '');
  if (output.length > 0) lines.push('Recent daemon output:', ...output.map((line) => `  ${line}`));
  if (detail.logPath) lines.push(`Daemon log: ${detail.logPath}`);
  return withDetail(`${headline}: ${detail.cause}`, lines);
}
