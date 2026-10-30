/**
 * Parallel test dispatcher.
 *
 * Coordinates multiple worker processes, each assigned to a dedicated
 * device and daemon instance. Distributes test files using a work-stealing
 * queue for natural load balancing.
 */

import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { normalizeGrep, resolveDeviceStrategy, type TapsmithConfig } from './config.js';
import { sharedDeviceGroup } from './project.js';
import { findDaemonBin } from './daemon-bin.js';
import { assignGroupMemberDevices, deviceGroupSize, resolveDeviceGroup, type DeviceGroupEntry } from './config.js';
import { TapsmithGrpcClient } from './grpc-client.js';
import { claimDeviceOrThrow, claimUpTo, currentSession, heldDevicesNote, skippedHeldDeviceMessage, withoutHeldDevices } from './device-claims.js';
import { labelledMessage, withDetail } from './error-detail.js';
import { awaitDaemonStart, captureDaemonOutput, daemonStartFailure, spawnDaemonBinary, type DaemonOutputCapture, type DaemonStartFailed } from './daemon-start.js';
import type { TestResult, SuiteResult } from './runner.js';
import type { TapsmithReporter, FullResult } from './reporter.js';
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  SerializedConfig,
} from './worker-protocol.js';
import { deserializeTestResult, deserializeSuiteResult, serializeConfig, serializeRegExpArray } from './worker-protocol.js';
import {
  clearOfflineEmulatorTransports,
  provisionEmulators,
  forceCleanupEmulators,
  emulatorsBootingThisProcess,
  filterHealthyDevices,
  getRunningAvdName,
  cleanupStaleEmulators,
  resolveEmulatorLaunchSettings,
  prefilterDevicesForStrategy,
  selectDevicesForStrategy,
  filterPreferInstalledApp,
  listAdbDevices,
  type DeviceHealthResult,
  type LaunchedEmulator,
} from './emulator.js';
import {
  provisionSimulators,
  cleanupStaleSimulators,
  preserveSimulatorsForReuse,
  forceCleanupSimulators,
  killAgentRunnersForSimulators,
  filterHealthySimulators,
  listAdoptableBootedSimulators,
  listBootedSimulators,
  type ClonedSimulator,
} from './ios-simulator.js';
import { freeStaleAgentPort } from './port-utils.js';
import { describeUnusableAndroidDevice, isUsableAndroidState, moreDevicesAdvice, noOnlineDeviceMessage, workerStartAdvice } from './device-advice.js';
import { androidToolchainBlocker, iosToolchainBlocker, toolchainBlocker } from './toolchain.js';
import type { AdbDevice } from './adb-devices.js';
import { notifyLegacySudoersIfPresent } from './legacy-cleanup.js';
import {
  forkStdioForLaunchProgress,
  pipeForkOutputForLaunchProgress,
  type LaunchProgressSink,
  type LaunchStepId,
} from './launch-progress.js';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

interface TaggedFile {
  filePath: string
  projectUseOptions?: import('./worker-protocol.js').RunFileUseOptions
  projectName?: string
  projectGrep?: import('./worker-protocol.js').SerializedRegExp[]
  projectGrepInvert?: import('./worker-protocol.js').SerializedRegExp[]
}

/** A secondary device of a worker's group, with the daemon this dispatcher spawned for it. */
interface WorkerGroupMemberHandle {
  name: string
  deviceSerial: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
}

interface WorkerHandle {
  id: number
  process: ChildProcess
  /** The group's primary device. */
  deviceSerial: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
  /** The rest of the device group (`use.devices`); empty for single-device projects. */
  members: WorkerGroupMemberHandle[]
  busy: boolean
  currentFile?: TaggedFile
  retired?: boolean
  /**
   * Receives ChildProcess 'error' events (spawn/kill/IPC-send failures).
   * Swappable so the init handshake and each dispatch wave can route worker
   * IPC failures to their own recovery logic. Without a listener Node turns
   * an async send failure (write EPIPE to a dead child) into an uncaught
   * exception that kills the whole dispatcher (PILOT-228).
   */
  onIpcError?: (err: Error) => void
}

/**
 * Send a message to a worker child process without ever crashing the
 * dispatcher. `subprocess.send()` can fail synchronously (channel already
 * closed) or asynchronously (EPIPE while the child is dying) — without a
 * callback the async failure is emitted as an unhandled 'error' event and
 * takes down the run. Failures are routed to `onSendFailure`
 * so the caller can treat the worker as gone and requeue its work.
 */
export function sendToWorkerProcess(
  proc: ChildProcess,
  msg: MainToWorkerMessage,
  onSendFailure: (err: Error) => void,
): void {
  // Failure callbacks are always deferred to a microtask so callers never
  // re-enter dispatch bookkeeping (retire → redispatch) synchronously from
  // inside a dispatch loop.
  if (!proc.connected) {
    queueMicrotask(() => onSendFailure(new Error('IPC channel is closed')));
    return;
  }
  try {
    proc.send(msg, (err) => {
      if (err) onSendFailure(err);
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    queueMicrotask(() => onSendFailure(error));
  }
}

/**
 * The log file a worker's daemon appends to under `TAPSMITH_DAEMON_LOG`:
 * the named file for worker 0, a `.worker-N` sibling for the others.
 */
function daemonLogPath(workerId: number): string | undefined {
  const baseLogPath = process.env.TAPSMITH_DAEMON_LOG;
  if (!baseLogPath) return undefined;
  const parsed = path.parse(baseLogPath);
  return workerId === 0
    ? baseLogPath
    : path.join(parsed.dir, `${parsed.name}.worker-${workerId}${parsed.ext}`);
}

interface SpawnedDaemon {
  /** The daemon, or why it could not be run at all. */
  spawned: ReturnType<typeof spawnDaemonBinary>
  /** Its output while it starts, for the failure message; dispose once judged. */
  output: DaemonOutputCapture
}

function spawnDaemonProcess(
  daemonBin: string,
  daemonPort: number,
  agentPort: number,
  workerId: number,
  platform?: string,
): SpawnedDaemon {
  const output = captureDaemonOutput(daemonLogPath(workerId), (message) => {
    process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  });
  try {
    const spawned = spawnDaemonBinary(
      daemonBin,
      [
        '--port', String(daemonPort),
        '--agent-port', String(agentPort),
        ...(platform ? ['--platform', platform] : []),
      ],
      { stdio: output.stdio },
    );
    return { spawned, output };
  } finally {
    output.closeParentFds();
  }
}

export interface DispatcherOptions {
  config: TapsmithConfig
  reporter: TapsmithReporter
  testFiles: string[]
  workers: number
  /** `--force-install`, handed to every worker (see `InitMessage.forceInstall`). */
  forceInstall: boolean
  /** Resolved projects for wave-based execution. When set, files are dispatched per-wave. */
  projects?: import('./project.js').ResolvedProject[]
  /** Pre-sorted project waves from topologicalSort(). Required when `projects` is set. */
  projectWaves?: import('./project.js').ResolvedProject[][]
  /**
   * When set, this `runParallel` call is one bucket of a multi-bucket run.
   * Suppresses the per-bucket "Running N test files across M workers" log
   * line (the parent prints an aggregated summary instead).
   */
  bucketLabel?: string
  /**
   * Offset added to local worker indices when reporting test results, so
   * worker IDs stay globally unique across concurrent buckets.
   */
  workerIndexBase?: number
  /** Hard cap on total workers across all buckets. Passed to allocateBucketWorkers. */
  workerCap?: number
  /** Optional startup checklist used by CLI launch output. */
  launchProgress?: LaunchProgressSink
  /** Internal barrier hook for multi-bucket launch progress. */
  beforeDispatch?: () => Promise<void> | void
  /** Shared worker-ready counter for multi-bucket launch progress. */
  launchProgressReadyCounter?: { count: number }
  /** Shared worker total for multi-bucket launch progress. */
  launchProgressWorkerTotal?: number
  /** Shared aggregate startup phase counters for multi-bucket launch progress. */
  launchProgressPhaseCounters?: LaunchPhaseCounters
}

type LaunchPhaseId = Extract<LaunchStepId, 'daemon' | 'app-install' | 'agent' | 'app-launch'>;
type LaunchPhaseCounters = Record<LaunchPhaseId, { count: number }>;

const launchPhaseIds: LaunchPhaseId[] = ['daemon', 'app-install', 'agent', 'app-launch'];

function createLaunchPhaseCounters(): LaunchPhaseCounters {
  return {
    daemon: { count: 0 },
    'app-install': { count: 0 },
    agent: { count: 0 },
    'app-launch': { count: 0 },
  };
}

const EXISTING_DEVICE_INIT_TIMEOUT_MS = 90_000;
const LAUNCHED_EMULATOR_INIT_TIMEOUT_MS = 180_000;

export class LaunchSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LaunchSetupError';
  }
}

export function isLaunchSetupError(err: unknown): err is LaunchSetupError {
  return err instanceof Error && err.name === 'LaunchSetupError';
}

/**
 * The devices a fully pinned group runs on — every entry's pin, primary
 * first — or `undefined` while any member is left to auto-pick.
 *
 * Pins name their devices outright, so discovery's filters (strategy,
 * health, "prefers the installed app") and emulator provisioning must not
 * apply: a filter dropping the pinned device ran the bucket on another one,
 * and a shortfall booted an emulator nobody would use. An Android pin that
 * is not connected is refused here with what is; iOS pins pass as given, as
 * in the sequential path (the daemon only lists booted simulators).
 *
 * @internal — exported for unit testing.
 */
export function pinnedWorkerDevices(
  group: DeviceGroupEntry[],
  onlineSerials: string[],
  isIos: boolean,
  /**
   * Devices adb lists but cannot use, with their adb state: a pin among them
   * is attached, not missing, and is named with its fix.
   */
  unusable: readonly AdbDevice[],
): string[] | undefined {
  if (!group.every((e) => e.device)) return undefined;
  const pins = group.map((e) => e.device!);
  if (isIos) return pins;
  const missing = pins.filter((p) => !onlineSerials.includes(p));
  if (missing.length > 0) {
    const attached = missing.flatMap((p) => unusable.filter((d) => d.serial === p && !isUsableAndroidState(d.state)).slice(0, 1));
    const absent = missing.filter((p) => !attached.some((d) => d.serial === p));
    throw new LaunchSetupError([
      ...attached.map((d) => `Pinned device ${describeUnusableAndroidDevice(d)}`),
      ...(absent.length > 0
        ? [`Pinned device${absent.length === 1 ? '' : 's'} ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not connected.`]
        : []),
      // "No … connected" would contradict an "is attached" sentence above.
      ...(onlineSerials.length > 0
        ? [`Connected: ${onlineSerials.join(', ')}.`]
        : absent.length > 0 ? ['No Android devices are connected.'] : []),
    ].join(' '));
  }
  return pins;
}

/**
 * A JS engine error — a bug in Tapsmith, not a device that is missing.
 * @internal — exported for the UI/watch provisioning path in cli.ts.
 * Provisioning failures throw plain `Error`s (or LaunchSetupError).
 */
export function isProgrammingError(err: unknown): err is Error {
  // Not SyntaxError: a JSON.parse of malformed simctl/adb output is the
  // environment's fault, not a bug.
  return err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError;
}

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Module-level Ctrl-C coordination. Multi-bucket runs have two concurrent
 * `runParallel` invocations, each registering its own SIGINT handler. They
 * share this flag so:
 *   - the "Interrupted. Shutting down..." message is printed exactly once
 *   - each bucket's handler can skip its own noise-suppression logic
 *   - the process exits ONCE, after all handlers have had a chance to run
 *     their cleanup (emulators, simulators, daemons, workers).
 *
 * We defer the actual `process.exit` via `setImmediate` so any other SIGINT
 * handlers registered for the same event get a chance to finish before the
 * process terminates. Synchronous `process.exit` inside the first handler
 * would leak the second bucket's devices.
 */
let dispatcherIsShuttingDown = false;
let shutdownExitScheduled = false;
function scheduleShutdownExit(signal?: NodeJS.Signals): void {
  if (shutdownExitScheduled) return;
  shutdownExitScheduled = true;
  const code = signal === 'SIGTERM' ? 143 : 130;
  setImmediate(() => process.exit(code));
}

/**
 * Active per-bucket emergency-cleanup callbacks. Each `runParallel` invocation
 * registers its `emergencyCleanup` here on entry and removes it in `finally`.
 * A single process-wide `uncaughtException`/`unhandledRejection` handler (see
 * `installFatalErrorHandlers`) iterates this set so a dispatcher *crash* tears
 * down the same resources a Ctrl-C would — without it, an uncaught error
 * bypasses the SIGINT/SIGTERM handlers entirely and orphans daemons, xcodebuild
 * runners, and booted simulators (PILOT-230).
 */
const activeEmergencyCleanups = new Set<() => void>();
let fatalHandlersInstalled = false;
let fatalExitScheduled = false;
let uncaughtExceptionListener: ((err: Error) => void) | undefined;
let unhandledRejectionListener: ((reason: unknown) => void) | undefined;

/**
 * Install process-wide handlers that route an uncaught exception or unhandled
 * rejection through the same teardown path as SIGINT/SIGTERM, then exit
 * non-zero. Idempotent — only the first active `runParallel` installs them;
 * they are removed by `uninstallFatalErrorHandlers` once the last run finishes
 * so they don't linger in long-lived hosts (MCP server, watch/UI mode) and
 * hijack later unrelated errors. Safe to add a global `unhandledRejection`
 * handler: fixture rejections are already marked handled (see fixtures.ts), so
 * only genuinely fatal errors reach here, and Node ≥15 already crashes the
 * process on unhandled rejection — we just clean up first.
 */
function installFatalErrorHandlers(): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  const runFatalTeardown = (label: string, err: unknown) => {
    // Return early on re-entry: an error thrown during cleanup must not
    // re-run every teardown (redundant work, secondary errors, or loops).
    if (fatalExitScheduled) return;
    fatalExitScheduled = true;
    process.stderr.write(`\n${DIM}Fatal ${label} — shutting down workers and devices...${RESET}\n`);
    // Print the stack, not just the message — async crashes are undebuggable otherwise.
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    for (const cleanup of activeEmergencyCleanups) {
      try { cleanup(); } catch { /* keep tearing down the rest */ }
    }
    // Cleanups are idempotent and coordinate via dispatcherIsShuttingDown; they
    // do NOT schedule the exit themselves on this path (see emergencyCleanup),
    // so force a non-zero exit here.
    if (!shutdownExitScheduled) {
      shutdownExitScheduled = true;
      setImmediate(() => process.exit(1));
    }
  };
  uncaughtExceptionListener = (err) => runFatalTeardown('error', err);
  unhandledRejectionListener = (reason) => runFatalTeardown('rejection', reason);
  process.on('uncaughtException', uncaughtExceptionListener);
  process.on('unhandledRejection', unhandledRejectionListener);
}

/**
 * Remove the process-wide fatal-error handlers. Called when the last active
 * `runParallel` finishes (no remaining `activeEmergencyCleanups`), so the
 * listeners don't accumulate or fire after the dispatcher work is done.
 */
function uninstallFatalErrorHandlers(): void {
  if (!fatalHandlersInstalled) return;
  fatalHandlersInstalled = false;
  fatalExitScheduled = false;
  if (uncaughtExceptionListener) {
    process.removeListener('uncaughtException', uncaughtExceptionListener);
    uncaughtExceptionListener = undefined;
  }
  if (unhandledRejectionListener) {
    process.removeListener('unhandledRejection', unhandledRejectionListener);
    unhandledRejectionListener = undefined;
  }
}

/**
 * True when a SIGINT/SIGTERM handler fired inside any runParallel
 * invocation. The top-level CLI catch reads this to suppress the
 * "Fatal error: All workers became unavailable" message when the real
 * cause was a user-initiated shutdown.
 */
export function isDispatcherShuttingDown(): boolean {
  return dispatcherIsShuttingDown;
}

/**
 * Add a base offset to a deserialized test result's workerIndex so concurrent
 * buckets produce globally-unique worker IDs. No-op when base is undefined/0.
 */
function applyWorkerIndexBase<T extends { workerIndex?: number }>(
  result: T,
  base: number | undefined,
): T {
  if (!base || result.workerIndex == null) return result;
  return { ...result, workerIndex: result.workerIndex + base };
}

function applyWorkerIndexBaseToSuite(
  suite: import('./runner.js').SuiteResult,
  base: number | undefined,
): import('./runner.js').SuiteResult {
  if (!base) return suite;
  return {
    ...suite,
    tests: suite.tests.map((t) => applyWorkerIndexBase(t, base)),
    suites: suite.suites.map((s) => applyWorkerIndexBaseToSuite(s, base)),
  };
}

export function handleParallelTestEndMessage(
  msg: Extract<WorkerToMainMessage, { type: 'test-end' }>,
  workerTestCounts: Map<number, number>,
  reporter: TapsmithReporter,
  workerIndexBase?: number,
): TestResult {
  const result = applyWorkerIndexBase(
    deserializeTestResult(msg.result),
    workerIndexBase,
  );
  if (!result._willRetry) {
    workerTestCounts.set(msg.workerId, (workerTestCounts.get(msg.workerId) ?? 0) + 1);
  }
  reporter.onTestEnd?.(result);
  return result;
}

export function handleParallelTestStartMessage(
  msg: Extract<WorkerToMainMessage, { type: 'test-start' }>,
  reporter: TapsmithReporter,
  workerIndexBase?: number,
): void {
  reporter.onTestStart?.(msg.fullName, msg.filePath, {
    workerIndex: msg.workerId + (workerIndexBase ?? 0),
    project: msg.projectName,
  });
}

export function handleParallelFileRetryMessage(
  msg: Extract<WorkerToMainMessage, { type: 'file-retry' }>,
  workerTestCounts: Map<number, number>,
  reporter: TapsmithReporter,
): number {
  const discarded = workerTestCounts.get(msg.workerId) ?? 0;
  workerTestCounts.set(msg.workerId, 0);
  reporter.onTestFileRetry?.(msg.filePath, discarded);
  return discarded;
}

export function handleParallelFileDoneMessage(
  msg: Extract<WorkerToMainMessage, { type: 'file-done' }>,
  workerTestCounts: Map<number, number>,
  workerIndexBase?: number,
): { results: TestResult[]; suite: SuiteResult } {
  workerTestCounts.delete(msg.workerId);
  return {
    results: msg.results
      .map(deserializeTestResult)
      .map((r) => applyWorkerIndexBase(r, workerIndexBase)),
    suite: applyWorkerIndexBaseToSuite(
      deserializeSuiteResult(msg.suite),
      workerIndexBase,
    ),
  };
}

/**
 * How many ports each bucket reserves. Big enough to cover any reasonable
 * worker count without colliding with the next bucket's range.
 */
export const PORTS_PER_BUCKET = 50;

/**
 * A scheduled bucket: one parallel execution on a specific device signature.
 * `portOffset` ensures each bucket's worker port range doesn't collide with
 * other buckets running concurrently.
 */
export interface BucketPlan {
  portOffset: number
  bucketOpts: DispatcherOptions
}

/**
 * Pure planning step for multi-bucket dispatch. Partitions projects by
 * deviceSignature, allocates workers per bucket, filters projectWaves to
 * each bucket's projects, and assigns each bucket a non-overlapping port
 * range. Kept side-effect-free so it can be unit-tested without spawning
 * workers.
 */
export function planMultiBucket(
  opts: DispatcherOptions,
  allocation: Map<string, number>,
): BucketPlan[] {
  const projects = opts.projects ?? [];
  const bucketsBySig = new Map<string, import('./project.js').ResolvedProject[]>();
  for (const p of projects) {
    const arr = bucketsBySig.get(p.deviceSignature) ?? [];
    arr.push(p);
    bucketsBySig.set(p.deviceSignature, arr);
  }
  const buckets = [...bucketsBySig.values()];

  const plans: BucketPlan[] = [];
  let workerIndexBase = 0;
  buckets.forEach((bucketProjects, idx) => {
    const signature = `${idx}-${bucketProjects[0].deviceSignature}`;
    const workersForBucket = allocation.get(signature) ?? 0;
    if (workersForBucket === 0) return;

    const bucketFiles = bucketProjects.flatMap((p) => p.testFiles);
    const bucketSignature = bucketProjects[0].deviceSignature;
    const bucketEffective = bucketProjects[0].effectiveConfig;

    // Filter the global wave list to only this bucket's projects, preserving
    // dependency order. Dependencies that cross bucket boundaries are not
    // supported — each bucket has its own independent dependency graph.
    const bucketWaves = (opts.projectWaves ?? [])
      .map((wave) => wave.filter((p) => p.deviceSignature === bucketSignature))
      .filter((wave) => wave.length > 0);

    // Short human label for log lines: "android Pixel_6" / "ios iPhone 17".
    const bucketLabel = deviceTargetLabel(bucketSignature);

    plans.push({
      portOffset: idx * PORTS_PER_BUCKET,
      bucketOpts: {
        ...opts,
        config: bucketEffective,
        testFiles: bucketFiles,
        workers: workersForBucket,
        projects: bucketProjects,
        projectWaves: bucketWaves,
        bucketLabel,
        workerIndexBase,
      },
    });
    workerIndexBase += workersForBucket;
  });
  return plans;
}

/**
 * Merge FullResults from concurrent bucket runs into a single aggregated
 * result. Wall-time uses max() because buckets ran in parallel; tests and
 * suites are flat-concatenated in bucket order.
 */
export function mergeBucketResults(results: FullResult[]): FullResult {
  return {
    status: results.some((r) => r.status === 'failed') ? 'failed' : 'passed',
    duration: Math.max(...results.map((r) => r.duration), 0),
    setupDuration: Math.max(...results.map((r) => r.setupDuration ?? 0), 0),
    tests: results.flatMap((r) => r.tests),
    suites: results.flatMap((r) => r.suites),
  };
}

/**
 * Split projects by device signature and run each bucket as an independent
 * parallel execution. Buckets execute concurrently — Android and iOS test
 * suites can run side-by-side, each with their own daemons and devices.
 */
async function runMultiBucket(opts: DispatcherOptions): Promise<FullResult> {
  const projects = opts.projects ?? [];
  const bucketsBySig = new Map<string, import('./project.js').ResolvedProject[]>();
  for (const p of projects) {
    const arr = bucketsBySig.get(p.deviceSignature) ?? [];
    arr.push(p);
    bucketsBySig.set(p.deviceSignature, arr);
  }
  const buckets = [...bucketsBySig.values()];

  const { allocateBucketWorkers, pinnedBucketSignatures } = await import('./project.js');
  const bucketEntries = buckets.map((bucketProjects, i) => ({
    signature: `${i}-${bucketProjects[0].deviceSignature}`,
    projects: bucketProjects,
  }));
  // Live pins are the user's here: the parallel path runs no sequential setup.
  const allocation = allocateBucketWorkers(opts.workers, bucketEntries, opts.workerCap, pinnedBucketSignatures(bucketEntries));
  const bucketWorkers = bucketEntries.map((b) => allocation.get(b.signature) ?? 0);

  const totalWorkersAcrossBuckets = bucketWorkers.reduce((s, n) => s + n, 0);
  const plans = planMultiBucket(opts, allocation);
  const bucketSummary = buckets
    .map((b, i) => `${b[0].deviceSignature.split('|').slice(0, 2).join(' ')} (${bucketWorkers[i]}w)`)
    .join(', ');

  const readyCounter = { count: 0 };
  const phaseCounters = createLaunchPhaseCounters();

  if (opts.launchProgress) {
    opts.launchProgress.start(
      'daemon',
      `starting ${totalWorkersAcrossBuckets} worker daemon(s)`,
    );
    opts.launchProgress.start(
      'worker-devices',
      `preparing ${totalWorkersAcrossBuckets} worker device(s) in ${buckets.length} device bucket(s)`,
    );
    opts.launchProgress.start('ui-workers', `starting ${totalWorkersAcrossBuckets} worker(s)`);
    opts.launchProgress.update('ui-workers', {
      state: 'running',
      detail: bucketSummary,
      progress: { done: 0, total: totalWorkersAcrossBuckets },
    });
  } else {
    process.stderr.write(
      `${DIM}Running ${opts.testFiles.length} test file(s) across ${totalWorkersAcrossBuckets} worker(s) in ${buckets.length} device bucket(s): ${bucketSummary}${RESET}\n`,
    );
  }

  return coordinateBuckets(
    plans.map((plan) => ({
      label: plan.bucketOpts.bucketLabel ?? '',
      projects: plan.bucketOpts.projects ?? [],
      run: (beforeDispatch) => runParallel({
        ...plan.bucketOpts,
        launchProgress: opts.launchProgress,
        beforeDispatch,
        launchProgressReadyCounter: readyCounter,
        launchProgressWorkerTotal: totalWorkersAcrossBuckets,
        launchProgressPhaseCounters: phaseCounters,
      }, plan.portOffset),
    })),
    {
      config: opts.config,
      reporter: opts.reporter,
      testFileCount: opts.testFiles.length,
      launchProgress: opts.launchProgress,
      totalWorkers: totalWorkersAcrossBuckets,
      readyCounter,
      phaseCounters,
    },
  );
}

/** One bucket of a multi-bucket run, as {@link coordinateBuckets} drives it. */
export interface BucketRunner {
  /** Short target label for messages, e.g. "android Pixel_6". */
  label: string
  /** The bucket's projects — whose files are reported failed if it cannot start. */
  projects: import('./project.js').ResolvedProject[]
  /**
   * Run the bucket. It must await `beforeDispatch` once its workers are
   * ready and before dispatching any file; a rejection before that is a
   * failed start.
   */
  run: (beforeDispatch: () => Promise<void>) => Promise<FullResult>
}

export interface BucketCoordination {
  config: TapsmithConfig
  reporter: TapsmithReporter
  testFileCount: number
  launchProgress?: LaunchProgressSink
  totalWorkers: number
  readyCounter: { count: number }
  phaseCounters: LaunchPhaseCounters
  /** Suppress the stderr summary of failed targets (unit tests). */
  quiet?: boolean
}

/**
 * Run concurrent buckets behind one launch barrier: no bucket dispatches a
 * file until every bucket has either finished starting or failed to.
 *
 * A bucket that fails before the barrier does not stop the others (it used
 * to abort the whole run). Each of its projects' files is
 * reported as one failed result carrying the target-labelled reason, the
 * way Playwright fails every test of a project whose browser cannot launch
 * and runs the rest. Files, not tests: tests are only collected inside a
 * worker, and this bucket never had one. When every bucket fails, nothing
 * ran and the run fails to start, as a single-bucket run does.
 *
 * Every bucket settles before this returns or rejects, so a sibling always
 * reaches its own teardown instead of being orphaned when the process exits.
 *
 * @internal — exported for unit testing.
 */
export async function coordinateBuckets(
  buckets: BucketRunner[],
  c: BucketCoordination,
): Promise<FullResult> {
  const progress = c.launchProgress;
  const total = c.totalWorkers;
  const arrived = buckets.map(() => false);
  const startFailures = new Map<number, unknown>();
  // In bucket order, not the order they happened to fail in: reports and
  // messages must not reshuffle from run to run.
  const failuresInOrder = (): Array<[number, unknown]> => [...startFailures].sort(([a], [b]) => a - b);
  let arrivedCount = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

  // Progress rows are one line each; the whole reason is printed below them
  // (or thrown, when no target started).
  const failureSummary = (err: unknown): string => messageFromUnknown(err).split('\n')[0];
  const failedTargetsDetail = (): string => failuresInOrder()
    .map(([i, err]) => `${buckets[i].label} could not start: ${failureSummary(err)}`)
    .join('; ');

  const renderAllFailed = () => {
    if (!progress) return;
    const detail = failedTargetsDetail();
    progress.fail('worker-devices', `0/${total} worker device(s) ready; ${detail}`);
    for (const phase of launchPhaseIds) {
      if (c.phaseCounters[phase].count >= total) continue;
      progress.update(phase, {
        state: 'failed',
        detail,
        progress: { done: c.phaseCounters[phase].count, total },
      });
    }
    progress.fail('ui-workers', detail);
    progress.finish();
  };

  const renderStarted = () => {
    const ready = c.readyCounter.count;
    if (progress) {
      if (startFailures.size > 0) {
        progress.update('worker-devices', {
          state: 'warning',
          detail: `${ready}/${total} worker device(s) ready; ${failedTargetsDetail()}`,
        });
      } else {
        progress.complete(
          'worker-devices',
          `${ready}/${total} worker device(s) ready across ${buckets.length} bucket(s)`,
        );
      }
      if (ready < total) {
        progress.update('ui-workers', {
          state: 'warning',
          detail: `${ready}/${total} worker(s) ready; ${total - ready} failed`,
          progress: { done: ready, total },
        });
        for (const phase of launchPhaseIds) {
          if (c.phaseCounters[phase].count >= total) continue;
          progress.update(phase, {
            state: 'warning',
            detail: `${c.phaseCounters[phase].count}/${total} completed; ${total - c.phaseCounters[phase].count} worker(s) did not finish`,
            progress: { done: c.phaseCounters[phase].count, total },
          });
        }
      } else {
        progress.complete('ui-workers', `${total} worker(s) ready`);
      }
      progress.finish();
    }
    if (!c.quiet) {
      for (const [i, err] of failuresInOrder()) {
        const fileCount = buckets[i].projects.reduce((n, p) => n + p.testFiles.length, 0);
        process.stderr.write(`${YELLOW}${targetStartNotice(
          targetStartWarning(buckets[i].label, fileCount, false),
          // A TypeError and the like is a bug, not a missing device: keep its
          // stack. Plain Errors are ordinary provisioning failures.
          isProgrammingError(err) ? (err.stack ?? err.message) : messageFromUnknown(err),
        )}${RESET}\n`);
      }
    }
    c.reporter.onRunStart?.(c.config, c.testFileCount);
    for (const [i, err] of failuresInOrder()) {
      for (const result of targetStartFailureResults(buckets[i].label, buckets[i].projects, err)) {
        startFailureResults.push(result);
        c.reporter.onTestFileStart?.(result.filePath!);
        c.reporter.onTestEnd?.(result);
        c.reporter.onTestFileEnd?.(result.filePath!, [result]);
      }
    }
  };

  const startFailureResults: TestResult[] = [];
  const arrive = (i: number) => {
    if (arrived[i]) return;
    arrived[i] = true;
    arrivedCount++;
    if (arrivedCount < buckets.length) return;
    // Released whatever rendering does: a throw here must not leave every
    // waiting bucket parked on the barrier forever.
    try {
      if (startFailures.size === buckets.length) renderAllFailed();
      else renderStarted();
    } finally {
      releaseBarrier();
    }
  };

  const settled = await Promise.allSettled(buckets.map(async (bucket, i) => {
    try {
      return await bucket.run(async () => {
        arrive(i);
        await barrier;
      });
    } catch (err) {
      if (arrived[i]) throw err; // failed mid-run, not at start
      startFailures.set(i, err);
      arrive(i);
      return undefined;
    }
  }));

  const midRunFailure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (midRunFailure) throw midRunFailure.reason;

  if (buckets.length > 0 && startFailures.size === buckets.length) {
    const errors = failuresInOrder().map(([, err]) => err);
    // One bucket (the others planned no workers) is a single-target run:
    // its error, hints and all, as runParallel would have thrown it.
    if (errors.length === 1) throw errors[0];
    // A bug in Tapsmith surfaces as itself — "Fatal error" with its stack —
    // not folded into a "could not start" message.
    const bug = errors.find(isProgrammingError);
    if (bug) throw bug;
    throw noTargetCouldStart(failuresInOrder().map(([i, err]) => ({ label: buckets[i].label, err })));
  }

  const results = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
  const merged = mergeBucketResults(results);
  return {
    ...merged,
    status: startFailures.size > 0 ? 'failed' : merged.status,
    tests: [...startFailureResults, ...merged.tests],
    // Suite-driven reporters (JUnit, JSON) would otherwise leave them out.
    suites: [...startFailureResults.map(startFailureSuite), ...merged.suites],
  };
}

/**
 * The error when no device target of a run or session could start: each
 * target's whole message, its later lines (the hints: per-worker failures, a
 * port squatter's kill command, the advice) indented under it. Shared by the
 * parallel path, UI mode and watch.
 *
 * @internal — exported for unit testing.
 */
export function noTargetCouldStart(failures: Array<{ label: string; err: unknown }>): LaunchSetupError {
  return new LaunchSetupError(
    'No device target could start\n'
    + failures.map(({ label, err }) => labelledMessage(`${label}: `, messageFromUnknown(err))).join('\n'),
    { cause: failures[0]?.err },
  );
}

/**
 * The failure a test file of a target that could not start reports: the
 * whole reason, since its later lines carry the hints (advice, a build
 * excerpt, the log path) — bounded, and indented under the headline.
 */
export function targetUnavailableMessage(label: string, err: unknown): string {
  return labelledMessage(`Device target "${label}" could not start: `, messageFromUnknown(err));
}

/**
 * A target-start warning line with the target's whole reason under it.
 * Shared by the parallel path and the CLI's.
 */
export function targetStartNotice(warning: string, reason: string): string {
  return withDetail(warning, reason.split('\n'));
}

/** One worker's start failure, in the list a "No worker could start" error carries. */
export function workerFailureMessage(workerLabel: string, reason: string): string {
  return labelledMessage(`${workerLabel}: `, reason);
}

/**
 * The note printed when a worker's device is dropped and the others go on.
 * Nothing is appended to the reason: its last line is often a log path, and
 * a full stop after it is copied along with the path.
 */
export function skippingDeviceNotice(serial: string, reason: string): string {
  return labelledMessage(`Skipping device ${serial}: `, reason);
}

/**
 * The warning printed when one device target could not start and the others
 * go on. `retries`: the session keeps running (UI, watch) and a re-run of
 * the target's tests tries it again.
 */
export function targetStartWarning(label: string, fileCount: number, retries: boolean): string {
  return `Device target ${label} could not start; its ${fileCount} test file(s) are reported as failed. `
    + 'The other device targets still run.'
    + (retries ? ' Running its tests again retries it.' : '');
}

/** The one-test suite a start-failure result is reported under. */
export function startFailureSuite(result: TestResult): SuiteResult {
  return { name: result.name, tests: [result], suites: [], durationMs: 0 };
}

/**
 * Short label for a device target, from its signature: "android Pixel_6",
 * "ios iPhone 17".
 */
export function deviceTargetLabel(deviceSignature: string): string {
  return deviceSignature.split('|').slice(0, 2).join(' ').trim();
}

/**
 * One failed result per test file of `projects`, for a device target that
 * could not start. Shared by the parallel and sequential paths.
 */
export function targetStartFailureResults(
  label: string,
  projects: import('./project.js').ResolvedProject[],
  err: unknown,
): TestResult[] {
  const message = targetUnavailableMessage(label, err);
  return projects.flatMap((project) => project.testFiles.map((file) => {
    const error = new Error(message);
    // The stack is the dispatcher's, not the user's: reporters would print
    // its frames under every file.
    error.stack = undefined;
    return {
      name: path.basename(file),
      fullName: path.basename(file),
      filePath: file,
      status: 'failed' as const,
      durationMs: 0,
      project: project.name,
      error,
    };
  }));
}

/**
 * Run test files in parallel across multiple workers/devices.
 *
 * When `opts.projects` contains multiple distinct device signatures,
 * runParallel forks one execution per bucket, each with its own port
 * range, and runs them concurrently. Results are merged.
 *
 * Returns a FullResult aggregating all worker results.
 */
export async function runParallel(opts: DispatcherOptions, _portOffset = 0): Promise<FullResult> {
  // ─── Multi-bucket dispatch: split projects by deviceSignature ───
  if (opts.projects && opts.projects.length > 0 && _portOffset === 0) {
    const signatures = new Set(opts.projects.map((p) => p.deviceSignature));
    if (signatures.size > 1) {
      return runMultiBucket(opts);
    }
  }

  const { config, reporter, testFiles } = opts;
  const isIos = config.platform === 'ios';
  const deviceStrategy = resolveDeviceStrategy(config);
  const launchProgress = opts.launchProgress;
  // One bucket of a multi-bucket run failing to start is not the run
  // failing: the other buckets still run, and coordinateBuckets writes the
  // launch rows' final state. Mark this bucket's trouble as a labelled
  // warning so no ✗ precedes a run that goes on (PILOT-400).
  const failStep = (id: LaunchStepId, detail: string) => {
    if (opts.bucketLabel) launchProgress?.update(id, { state: 'warning', detail: `${opts.bucketLabel}: ${detail}` });
    else launchProgress?.fail(id, detail);
  };

  // Display IDs for log lines: globally unique across concurrent buckets.
  // Internal worker.id stays local (it's tied to daemon-port assignment).
  const displayWorkerId = (id: number): number => id + (opts.workerIndexBase ?? 0);
  // Cap workers at the max files in any single wave — workers in other waves
  // would sit idle since waves execute sequentially.
  const maxFilesInWave = opts.projectWaves
    ? Math.max(...opts.projectWaves.map((wave) =>
        wave.reduce((sum, p) => sum + p.testFiles.length, 0),
      ))
    : testFiles.length;
  // A worker is a device group: a `use.devices` project needs `groupSize`
  // devices (and daemons) per worker, so device counts below are workers ×
  // group size. Pinned members (`{ device }`) name their devices outright,
  // which fixes the bucket to a single worker.
  //
  // `use.devices` is project-level, so the root config never declares a
  // group. Every project of this run shares one device target (a second
  // signature would have gone through its own bucket), and the target is
  // provisioned for the largest group among them: a project declaring a
  // smaller group runs on the first N devices of each worker.
  const groupConfig = opts.projects && opts.projects.length > 0 ? sharedDeviceGroup(opts.projects).config : config;
  const groupSize = deviceGroupSize(groupConfig);
  const deviceGroup = resolveDeviceGroup({ devices: groupConfig.devices, device: config.device ?? groupConfig.device });
  const pinnedMemberSerials = deviceGroup.slice(1).flatMap((e) => (e.device ? [e.device] : []));
  // Any pin — the primary's from `--device` / root `device` included — fixes
  // the bucket to one worker on exactly the pinned devices. Checking only the
  // members' pins let a `--device` run go to whichever devices were found
  // (PILOT-261).
  const pinnedGroup = deviceGroup.some((e) => e.device);
  const maxUsefulWorkers = pinnedGroup ? 1 : Math.min(opts.workers, maxFilesInWave);
  const progressWorkerTotal = opts.launchProgressWorkerTotal ?? maxUsefulWorkers;
  const progressReadyCounter = opts.launchProgressReadyCounter ?? { count: 0 };
  const phaseCounters = opts.launchProgressPhaseCounters ?? createLaunchPhaseCounters();
  const phaseCompletedByWorker = new Map<LaunchPhaseId, Set<number>>(
    launchPhaseIds.map((phase) => [phase, new Set<number>()]),
  );
  const phaseSummary = (phase: LaunchPhaseId, count: number, total: number): string => {
    switch (phase) {
      case 'daemon':
        return `${count}/${total} worker daemon(s) ready`;
      case 'app-install':
        return `${count}/${total} device app(s) ready`;
      case 'agent':
        return `${count}/${total} automation agent(s) connected`;
      case 'app-launch':
        return `${count}/${total} app session(s) ready`;
    }
  };
  const markLaunchPhaseComplete = (phase: LaunchPhaseId, workerDisplayId: number, detail?: string) => {
    const completed = phaseCompletedByWorker.get(phase)!;
    if (completed.has(workerDisplayId)) return;
    completed.add(workerDisplayId);
    phaseCounters[phase].count++;
    const count = phaseCounters[phase].count;
    const done = count >= progressWorkerTotal;
    launchProgress?.update(phase, {
      state: done ? 'done' : 'running',
      detail: done
        ? phaseSummary(phase, progressWorkerTotal, progressWorkerTotal)
        : (detail ?? phaseSummary(phase, count, progressWorkerTotal)),
      progress: { done: Math.min(count, progressWorkerTotal), total: progressWorkerTotal },
    });
  };
  const updateLaunchPhaseProgress = (phase: LaunchPhaseId, detail: string) => {
    launchProgress?.update(phase, {
      state: 'running',
      detail,
      progress: { done: phaseCounters[phase].count, total: progressWorkerTotal },
    });
  };
  const updateWorkerLaunchPhases = (workerDisplayId: number, message: string) => {
    const workerLabel = `Worker ${workerDisplayId}`;
    if (message.startsWith('starting worker daemon') || message.startsWith('connecting to daemon')) {
      updateLaunchPhaseProgress('daemon', `${workerLabel}: ${message}`);
    } else if (message.startsWith('installing ') || message.includes('already installed')) {
      if (message.includes('already installed')) {
        markLaunchPhaseComplete('app-install', workerDisplayId, `${workerLabel}: app already installed`);
      } else {
        updateLaunchPhaseProgress('app-install', `${workerLabel}: ${message}`);
      }
    } else if (message === 'app install complete' || message === 'app install skipped') {
      markLaunchPhaseComplete('app-install', workerDisplayId, `${workerLabel}: app ready`);
    } else if (message === 'starting Tapsmith agent') {
      updateLaunchPhaseProgress('agent', `${workerLabel}: starting agent`);
    } else if (message === 'agent connected') {
      markLaunchPhaseComplete('agent', workerDisplayId, `${workerLabel}: agent connected`);
    } else if (message.startsWith('launching ') || message === 'validating session readiness') {
      updateLaunchPhaseProgress('app-launch', `${workerLabel}: ${message}`);
    } else if (message === 'app launched' || message === 'session ready') {
      markLaunchPhaseComplete('app-launch', workerDisplayId, `${workerLabel}: session ready`);
    }
  };
  const markAllLaunchPhasesCompleteForWorker = (workerDisplayId: number) => {
    for (const phase of launchPhaseIds) {
      markLaunchPhaseComplete(phase, workerDisplayId);
    }
  };
  const markIncompleteLaunchPhases = (state: 'warning' | 'failed', detail: string) => {
    for (const phase of launchPhaseIds) {
      const count = phaseCounters[phase].count;
      if (count >= progressWorkerTotal) continue;
      launchProgress?.update(phase, {
        state,
        detail,
        progress: { done: count, total: progressWorkerTotal },
      });
    }
  };
  const updateWorkerProgress = (detail: string) => {
    launchProgress?.update('ui-workers', {
      state: 'running',
      detail,
      progress: { done: progressReadyCounter.count, total: progressWorkerTotal },
    });
  };
  const note = (message: string) => {
    if (launchProgress) launchProgress.note(message);
    else process.stderr.write(`${DIM}${message}${RESET}\n`);
  };

  if (launchProgress && !opts.bucketLabel) {
    launchProgress.start('daemon', `starting ${progressWorkerTotal} worker daemon(s)`);
    launchProgress.start('worker-devices', `preparing ${progressWorkerTotal} worker device(s)`);
    launchProgress.update('ui-workers', {
      state: 'pending',
      progress: { done: 0, total: progressWorkerTotal },
    });
  }

  // ─── Pre-discovery cleanup ───
  let reusableSimulatorUdids: string[] = [];
  let reusedSimulatorCount = 0;

  if (isIos) {
    if (config.simulator) {
      const staleResult = cleanupStaleSimulators(config.simulator);
      reusableSimulatorUdids = staleResult.reusable;
      if (staleResult.killed.length > 0) {
        note(`Cleaned up ${staleResult.killed.length} stale simulator(s).`);
      }
      if (staleResult.reusable.length > 0) {
        if (launchProgress) {
          launchProgress.update('worker-devices', {
            state: 'running',
            detail: `found ${staleResult.reusable.length} reusable simulator(s) from previous run`,
          });
        } else {
          note(`Reusing ${staleResult.reusable.length} simulator(s) from previous run.`);
        }
      }
    }
  } else {
    const clearedOfflineEmulators = clearOfflineEmulatorTransports();
    for (const serial of clearedOfflineEmulators) {
      if (launchProgress) launchProgress.note(`Cleared stale offline emulator transport ${serial} before device discovery.`);
      else process.stderr.write(`${YELLOW}Cleared stale offline emulator transport ${serial} before device discovery.${RESET}\n`);
    }

    const staleResult = cleanupStaleEmulators(config.avd, {}, resolveEmulatorLaunchSettings(config.emulatorLaunchOptions).headless);
    if (staleResult.killed.length > 0) {
      note(`Cleaned up ${staleResult.killed.length} stale emulator(s).`);
    }
  }

  // Spawn the first worker daemon early so we can use it for device discovery.
  // This daemon will also serve as worker 0's daemon.
  const baseDaemonPort = Number.parseInt(config.daemonAddress.split(':').pop() ?? '50051', 10);
  const baseAgentPort = 18700;
  const rawBin = process.env.TAPSMITH_DAEMON_BIN ?? config.daemonBin ?? findDaemonBin();
  const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
    ? path.resolve(config.rootDir, rawBin)
    : rawBin;

  const reportFreedAgentPort = launchProgress
    ? ({ port, pid }: { port: number; pid: number; command: string }) => launchProgress.update('worker-devices', {
      state: 'running',
      detail: `cleared stale agent port ${port} (pid ${pid})`,
    })
    : undefined;

  let firstDaemonPort: number | undefined;
  let firstAgentPort: number | undefined;
  const maxFirstDaemonPortAttempts = Math.min(PORTS_PER_BUCKET, Math.max(maxUsefulWorkers + 10, 10));

  // Worker 0 also walks the reserved bucket port range. Otherwise one stale
  // daemon on the first port can fail the entire launch while later workers
  // already know how to skip occupied ports.
  for (let offset = 0; offset < maxFirstDaemonPortAttempts; offset++) {
    const candidateDaemonPort = baseDaemonPort + 1 + _portOffset + offset;
    const candidateAgentPort = baseAgentPort + 1 + _portOffset + offset;
    // The agent port is freed only for a slot whose daemon port is free: a
    // live daemon on the slot is another session's (or another bucket's), and
    // the runner on its agent port is that session's live agent, not a stale
    // one — killing it broke the other run mid-test (PILOT-381).
    if (await isPortAvailable(candidateDaemonPort)) {
      freeStaleAgentPort(candidateAgentPort, reportFreedAgentPort);
      firstDaemonPort = candidateDaemonPort;
      firstAgentPort = candidateAgentPort;
      break;
    }
    const message = `Skipping daemon port ${candidateDaemonPort} (in use), trying next...`;
    if (launchProgress) {
      launchProgress.update('worker-devices', { state: 'running', detail: message });
    } else {
      note(message);
    }
  }

  if (firstDaemonPort === undefined || firstAgentPort === undefined) {
    failStep('daemon', `no daemon port available near ${baseDaemonPort + 1 + _portOffset}`);
    throw new LaunchSetupError(
      `No daemon port available for worker startup.\n` +
      `Checked ${maxFirstDaemonPortAttempts} port(s) starting at ${baseDaemonPort + 1 + _portOffset}.\n` +
      `Run: lsof -nP -iTCP -sTCP:LISTEN | grep tapsmith-core`,
    );
  }

  updateLaunchPhaseProgress('daemon', `Worker ${displayWorkerId(0)}: starting daemon on localhost:${firstDaemonPort}`);
  const { spawned: firstDaemonSpawn, output: firstDaemonOutput } = spawnDaemonProcess(daemonBin, firstDaemonPort, firstAgentPort, displayWorkerId(0), config.platform);
  const firstDaemonFailure = async (outcome: DaemonStartFailed): Promise<LaunchSetupError> => {
    const portInUse = !outcome.spawnFailed && !(await isPortAvailable(firstDaemonPort));
    failStep('daemon', `failed to start worker daemon: ${outcome.cause}`);
    const message = daemonStartFailure('Failed to start worker daemon', {
      ...outcome,
      recentOutput: firstDaemonOutput.recentOutput(),
      logPath: firstDaemonOutput.logPath,
      hints: portInUse
        ? [
          `Port ${firstDaemonPort} is already in use. Another Tapsmith run may be active, or a stale daemon is running.`,
          `Run: lsof -ti tcp:${firstDaemonPort} | xargs kill`,
        ]
        : [],
    });
    firstDaemonOutput.dispose();
    return new LaunchSetupError(message);
  };
  if (!firstDaemonSpawn.ok) throw await firstDaemonFailure(firstDaemonSpawn);
  const firstDaemon = firstDaemonSpawn.child;
  firstDaemon.unref();

  // Wait for daemon to be ready
  const discoveryClient = new TapsmithGrpcClient(`localhost:${firstDaemonPort}`);
  const firstDaemonStart = await awaitDaemonStart(firstDaemonSpawn, discoveryClient, {
    budgetMs: 10_000,
    address: `localhost:${firstDaemonPort}`,
  });
  if (!firstDaemonStart.ok) {
    firstDaemon.kill();
    discoveryClient.close();
    throw await firstDaemonFailure(firstDaemonStart);
  }
  firstDaemonOutput.dispose();

  // Discover available devices
  const deviceList = await discoveryClient.listDevices();
  discoveryClient.close();
  // Device states from tapsmith-core: "Discovered" (available), "Active" (in use), "Disconnected"
  const onlineDevices = deviceList.devices.filter((d) =>
    d.state === 'Discovered' || d.state === 'Active',
  );

  let launchedEmulators: LaunchedEmulator[] = [];
  let clonedSimulators: ClonedSimulator[] = [];
  let freshIosUdids = new Set<string>();
  let deviceSerials: string[];

  const workers: WorkerHandle[] = [];
  let firstDaemonAssigned = false;

  // Register cleanup handlers BEFORE provisioning devices. Two paths can tear
  // these resources down:
  //   - SIGINT/SIGTERM (Ctrl-C) via the signal handlers below.
  //   - An uncaught exception / unhandled rejection — i.e. a dispatcher *crash*
  //     — via the process-wide handler installed by installFatalErrorHandlers,
  //     which iterates `activeEmergencyCleanups`. Without this, a crash bypasses
  //     the signal handlers entirely and orphans daemons, xcodebuild runners,
  //     and booted simulators, overloading the host (PILOT-230).
  // Multi-bucket runs register one handler per bucket; they coordinate via the
  // module-level `dispatcherIsShuttingDown` flag so the "Interrupted" message
  // prints exactly once and the process exits exactly once — but only AFTER
  // every bucket's cleanup has had a chance to run. teardownResources is
  // idempotent and synchronous, so re-entry (a second SIGINT, or a crash during
  // shutdown) is safe and always completes before the deferred exit.
  const teardownResources = () => {
    dispatcherIsShuttingDown = true;
    // 1. Stop workers issuing new RPCs.
    for (const worker of workers) {
      try { worker.process?.kill(); } catch { /* already dead */ }
    }
    // 2. Kill xcodebuild XCUITest runners BEFORE touching their sims — a runner
    //    re-boots its target sim after a simctl shutdown, so deleting the sim
    //    first just lets the survivor boot a replacement and keep the host hot.
    //    Cover reused/pre-existing devices too (present in deviceSerials but not
    //    clonedSimulators), not just the sims we cloned this run.
    if (isIos) {
      const udids = new Set(clonedSimulators.map((s) => s.udid));
      if (Array.isArray(deviceSerials)) {
        for (const serial of deviceSerials) udids.add(serial);
      }
      if (udids.size > 0) {
        killAgentRunnersForSimulators([...udids]);
      }
    }
    // 3. Shut down / delete the worker simulators and emulators — including
    //    any still booting: interrupted mid-provisioning, they were never
    //    handed to a worker and would otherwise be left running (PILOT-441).
    const stillBooting = emulatorsBootingThisProcess();
    if (launchedEmulators.length > 0 || stillBooting.length > 0) {
      forceCleanupEmulators([...launchedEmulators, ...stillBooting]);
    }
    if (clonedSimulators.length > 0) {
      forceCleanupSimulators(clonedSimulators);
    }
    // 4. Kill the daemons last (their xcodebuild children are already gone).
    for (const worker of workers) {
      try { worker.daemonProcess?.kill(); } catch { /* already dead */ }
    }
    if (!firstDaemonAssigned) {
      try { firstDaemon.kill(); } catch { /* already dead */ }
    }
  };
  activeEmergencyCleanups.add(teardownResources);
  installFatalErrorHandlers();

  const emergencyCleanup = (signal?: NodeJS.Signals) => {
    const firstEntry = !dispatcherIsShuttingDown;
    if (firstEntry) {
      if (launchProgress) {
        launchProgress.finish();
        process.stderr.write(`${DIM}Interrupted. Shutting down...${RESET}\n`);
      } else {
        process.stderr.write(`\n${DIM}Interrupted. Shutting down...${RESET}\n`);
      }
    }
    teardownResources();
    scheduleShutdownExit(signal);
  };
  const sigintHandler = () => emergencyCleanup('SIGINT');
  const sigtermHandler = () => emergencyCleanup('SIGTERM');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  const allResults: TestResult[] = [];
  const allSuites: SuiteResult[] = [];
  let totalStart = 0;
  let setupDuration = 0;

  // The try spans device provisioning AND dispatch so a setup-phase
  // failure still runs the finally below (deregistering the signal/crash
  // handlers) instead of leaking them on the process (PILOT-230).
  try {
    const fullyPinned = pinnedWorkerDevices(
      deviceGroup,
      onlineDevices.filter((d) => (d.platform === 'ios') === isIos).map((d) => d.serial),
      isIos,
      deviceList.unusableDevices,
    );
    if (isIos && !config.simulator) {
      // ─── Physical iOS device bucket ───
      // No `simulator` configured → treat as a physical device run. Use the
      // explicit `config.device` UDID when set, otherwise auto-pick the single
      // paired USB device. Mirrors the single-worker resolution in cli.ts.
      // Parallel workers against one physical device aren't supported (only
      // one XCUITest session per device) — the dispatcher caps workers to 1
      // downstream via the project's explicit `workers: 1`, but we don't
      // enforce that here; any over-count is handled by the worker slot
      // allocator.
      if (config.device) {
        deviceSerials = [config.device];
      } else {
        try {
          const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
          deviceSerials = [resolvePhysicalIosDevice()];
        } catch (e) {
          throw new Error(
            `Physical iOS device bucket failed to resolve: ${(e as Error).message}`,
          );
        }
      }
      // Refused before any worker touches it when another session drives it.
      claimDeviceOrThrow(deviceSerials[0], currentSession());
      launchProgress?.update('worker-devices', { state: 'running', detail: `physical iOS device ${deviceSerials[0]}` });
      if (!launchProgress) process.stderr.write(`${DIM}Physical iOS device: ${deviceSerials[0]}${RESET}\n`);
    } else if (fullyPinned) {
      // ─── Every device named outright ───
      deviceSerials = fullyPinned;
      // Refused before any worker touches them when another session drives one.
      for (const serial of fullyPinned) claimDeviceOrThrow(serial, currentSession());
      launchProgress?.update('worker-devices', { state: 'running', detail: `pinned ${fullyPinned.join(', ')}` });
    } else if (isIos && config.simulator) {
      // ─── iOS simulator discovery & provisioning ───
      // (`isIos` without `simulator` is the physical bucket above.)
      // The daemon reports ALL booted iOS simulators. Adopt only the ones the
      // config names (`simulator`, by name or UDID) — any other may be one the
      // developer is using (PILOT-511) — and Tapsmith's own clones of it, on
      // one runtime, since xcodebuild test-without-building fails across OS
      // versions.
      const iosDevices = onlineDevices.filter((d) => d.platform === 'ios');
      const daemonIosUdids = new Set(iosDevices.map((d) => d.serial));
      const candidateUdids = listAdoptableBootedSimulators(config.simulator, {
        among: iosDevices.map((d) => d.serial),
      }).map((s) => s.udid);
      const iosHealthy = filterHealthySimulators(candidateUdids);
      for (const unhealthy of iosHealthy.unhealthySimulators) {
        if (launchProgress) launchProgress.note(`Skipping unhealthy simulator ${unhealthy.udid}: ${unhealthy.reason}.`);
        else process.stderr.write(`${YELLOW}Skipping unhealthy simulator ${unhealthy.udid}: ${unhealthy.reason}.${RESET}\n`);
      }
      deviceSerials = iosHealthy.healthyUdids;

      const neededWorkers = maxUsefulWorkers * groupSize;
      if (deviceSerials.length < neededWorkers) {
        const detail = `provisioning iOS simulators: have ${deviceSerials.length}, need ${neededWorkers}`;
        if (launchProgress) launchProgress.update('worker-devices', { state: 'running', detail });
        else process.stderr.write(`${DIM}${detail}${RESET}\n`);
        const provision = provisionSimulators({
          simulatorName: config.simulator,
          workers: neededWorkers,
          existingUdids: deviceSerials,
          appPath: config.app ? path.resolve(config.rootDir, config.app) : undefined,
          reusableUdids: reusableSimulatorUdids,
          onProgress: (message, level) => {
            if (!launchProgress) return;
            if (level === 'warning') launchProgress.note(message);
            else launchProgress.update('worker-devices', { state: 'running', detail: message });
          },
        });
        clonedSimulators = provision.clonedSimulators;
        freshIosUdids = provision.freshUdids;
        deviceSerials = provision.allUdids;
        reusedSimulatorCount += provision.reusedUdids.length;

        if (clonedSimulators.length > 0) {
          const message = `Cloned ${clonedSimulators.length} simulator(s) for parallel workers.`;
          if (launchProgress) launchProgress.update('worker-devices', { state: 'running', detail: message });
          else note(message);
        }

        // Re-discover devices so the daemon sees newly booted simulators. By
        // UDID, not count: simulators left alone above pad the daemon's list.
        if (provision.allUdids.some((u) => !daemonIosUdids.has(u))) {
          // Give simulators a moment to register, then refresh
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const refreshClient = new TapsmithGrpcClient(`localhost:${firstDaemonPort}`);
          await refreshClient.waitForReady(5_000);
          await refreshClient.listDevices();
          refreshClient.close();
        }
      }
    } else {
      // ─── Android device discovery & provisioning ───
      const androidDevices = onlineDevices.filter((d) => d.platform !== 'ios');
      // Devices another live Tapsmith session holds are skipped (PILOT-381),
      // but stay "occupied" for the emulator launch below.
      const unheldAndroid = withoutHeldDevices(androidDevices.map((d) => d.serial));
      for (const claim of unheldAndroid.held) note(skippedHeldDeviceMessage(claim));
      const prefilteredOnline = prefilterDevicesForStrategy(
        unheldAndroid.free,
        deviceStrategy,
        config.avd,
      );
      warnSkippedDevices(prefilteredOnline.skippedDevices, launchProgress);
      const healthyOnline = filterHealthyDevices(prefilteredOnline.candidateSerials);
      warnUnhealthyDevices(healthyOnline.unhealthyDevices, launchProgress);
      const selectedOnline = selectDevicesForStrategy(
        healthyOnline.healthySerials,
        deviceStrategy,
        config.avd,
      );
      warnSkippedDevices(
        selectedOnline.skippedDevices.filter(
          (device) => !prefilteredOnline.skippedDevices.some((prefiltered) => prefiltered.serial === device.serial),
        ),
        launchProgress,
      );

      // Disambiguate among already-running same-AVD instances: if more than one
      // emulator reports the configured AVD name, prefer the one(s) where the
      // app under test is actually installed. This avoids grabbing a leftover
      // emulator from another project's run that shares the generic AVD name
      // but doesn't have this project's app (which would silently run, and
      // "restore app state", against the wrong app). Fresh emulators we boot
      // below have nothing installed yet and are handled by selectedProvisioned.
      const installedOnline = filterPreferInstalledApp(
        selectedOnline.selectedSerials,
        config.package,
      );
      warnSkippedDevices(installedOnline.skippedDevices, launchProgress);

      if (
        config.launchEmulators &&
        installedOnline.selectedSerials.length < maxUsefulWorkers * groupSize
      ) {
        // Without adb the emulator would boot and the boot wait time out:
        // say so now, as a launch failure rather than a crash.
        const adbBlocker = androidToolchainBlocker();
        if (adbBlocker) {
          failStep('worker-devices', 'adb is not on PATH');
          throw new LaunchSetupError(`${adbBlocker}.`);
        }
        const provision = await provisionEmulators({
          existingSerials: installedOnline.selectedSerials,
          occupiedSerials: androidDevices.map((d) => d.serial),
          workers: maxUsefulWorkers * groupSize,
          avd: config.avd,
          launchOptions: config.emulatorLaunchOptions,
          onProgress: (message, level) => {
            // Without a progress display a warning (an emulator's early-exit reason,
            // how to stop it) still has to reach the user.
            if (!launchProgress) {
              if (level === 'warning') process.stderr.write(`${YELLOW}${message}${RESET}\n`);
              return;
            }
            if (level === 'warning') launchProgress.note(message);
            else launchProgress.update('worker-devices', { state: 'running', detail: message });
          },
        });
        launchedEmulators = provision.launched;
        const healthyProvisioned = filterHealthyDevices(provision.allSerials);
        warnUnhealthyDevices(healthyProvisioned.unhealthyDevices, launchProgress);
        const selectedProvisioned = selectDevicesForStrategy(
          healthyProvisioned.healthySerials,
          deviceStrategy,
          config.avd,
        );
        warnSkippedDevices(selectedProvisioned.skippedDevices, launchProgress);
        deviceSerials = selectedProvisioned.selectedSerials;
      } else {
        deviceSerials = installedOnline.selectedSerials;
      }
    }

    if (deviceSerials.length === 0) {
      failStep('worker-devices', 'no worker-ready devices found');
      const iosBlocker = isIos ? iosToolchainBlocker() : undefined;
      throw new LaunchSetupError(
        isIos
          ? `No booted iOS simulators found.${iosBlocker ? ` ${iosBlocker}.` : config.simulator ? ` Boot a simulator matching '${config.simulator}', or add more simulators for parallel execution.` : ' Set `simulator` in your config and boot at least one.'}`
            // Booted ones other sessions hold are named, not reported missing.
            + heldDevicesNote(withoutHeldDevices(
              listBootedSimulators().filter((sim) => sim.name === config.simulator || sim.udid === config.simulator).map((sim) => sim.udid),
            ).held)
          // adb's state now, not at discovery: provisioning may have changed it.
          : noOnlineDeviceMessage(config, listAdbDevices(), androidToolchainBlocker())
            + heldDevicesNote(withoutHeldDevices(listAdbDevices().filter((d) => d.state === 'device').map((d) => d.serial)).held),
      );
    }

    if (pinnedGroup) {
      // A pinned member another session drives is refused by name, not left
      // to surface as a device shortfall (PILOT-381).
      for (const serial of [deviceGroup[0].device, ...pinnedMemberSerials]) {
        if (serial) claimDeviceOrThrow(serial, currentSession());
      }
      // A pinned group: its one worker holds the primary (from `config.device`
      // or the first unpinned device found), then the members in order — each
      // keeping its pin, the unpinned ones taking the next free device.
      const primary = deviceGroup[0].device ?? deviceSerials.find((s) => !pinnedMemberSerials.includes(s));
      if (!primary) {
        failStep('worker-devices', 'no device left for the group primary');
        throw new LaunchSetupError(
          `use.devices pins ${pinnedMemberSerials.join(', ')} but no other device is available for "${deviceGroup[0].name}". `
          + 'Pin it too with `device`, or boot another device.',
        );
      }
      const members = assignGroupMemberDevices(deviceGroup, primary, deviceSerials);
      // Short of devices: keep what there is so the check below reports the
      // shortfall with the real list.
      deviceSerials = members
        ? [primary, ...members]
        : [primary, ...pinnedMemberSerials, ...deviceSerials.filter((s) => s !== primary && !pinnedMemberSerials.includes(s))];
    }
    // Claimed as they are picked, and only as many as the workers use
    // (PILOT-381): two sessions provisioning at once then divide the free
    // devices instead of both taking the first ones (pinned ones were claimed
    // above, and are this session's already).
    deviceSerials = claimUpTo(deviceSerials, maxUsefulWorkers * groupSize).claimed;
    if (deviceSerials.length < groupSize) {
      failStep('worker-devices', `device group needs ${groupSize} device(s); ${deviceSerials.length} available`);
      throw new LaunchSetupError(
        `use.devices asks for ${groupSize} device(s) per test but only ${deviceSerials.length} could be provisioned `
        + `(${deviceSerials.join(', ')}). `
        + moreDevicesAdvice(config, toolchainBlocker(config.platform)),
      );
    }

    if (launchProgress && !opts.bucketLabel) {
      const reuseSuffix = reusedSimulatorCount > 0 ? ` (${reusedSimulatorCount} reused)` : '';
      launchProgress.complete(
        'worker-devices',
        `${deviceSerials.slice(0, maxUsefulWorkers).length} device(s)${reuseSuffix}: ${deviceSerials.slice(0, maxUsefulWorkers).join(', ')}`,
      );
      launchProgress.update('ui-workers', {
        state: 'running',
        detail: `starting workers on ${deviceSerials.slice(0, maxUsefulWorkers).join(', ')}`,
        progress: { done: progressReadyCounter.count, total: progressWorkerTotal },
      });
    } else if (launchProgress) {
      launchProgress.update('worker-devices', {
        state: 'running',
        detail: `${opts.bucketLabel}: ${deviceSerials.slice(0, maxUsefulWorkers).join(', ')}`,
      });
    }

    // Start the dispatch clock after provisioning, before forking workers.
    totalStart = Date.now();
    // Fork worker processes.
    // When running under tsx (TypeScript test files), import.meta.dirname points to src/
    // and we need to fork with tsx as the loader. When running from compiled JS,
    // import.meta.dirname points to dist/ and we can fork directly.
    const jsScript = path.resolve(import.meta.dirname, 'worker-runner.js');
    const tsScript = path.resolve(import.meta.dirname, 'worker-runner.ts');
    const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript);
    const resolvedScript = useTypeScript ? tsScript : jsScript;

    // When forking a .ts file, we need tsx to handle it.
    let tsxBin: string | undefined;
    if (useTypeScript) {
      const tapsmithPkgDir = path.resolve(import.meta.dirname, '..');
      const localTsx = path.join(tapsmithPkgDir, 'node_modules', '.bin', 'tsx');
      tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';
    }

    // iOS network capture lifecycle is now fully owned by tapsmith-core via
    // the macOS Network Extension redirector (PILOT-182). No host-side
    // sudo, no `networksetup`, no per-worker collision. One-time legacy
    // cleanup: warn if the old sudoers rule is still installed.
    if (isIos) {
      notifyLegacySudoersIfPresent();
    }

    // Serialize config for workers
    const serializedConfig: SerializedConfig = serializeConfig(config);

    const launchedSerials = new Set(launchedEmulators.map((emu) => emu.serial));

    // Pre-check port availability to avoid wasting time on occupied ports.
    // Ports are baseDaemonPort+1+workerId; skip workers whose port is taken.
    // For each candidate slot we also free any stale iOS TapsmithAgent squatting
    // on the agent port — the slot loop may walk past opts.workers when daemon
    // ports are occupied, so we cannot rely on a fixed-size upfront sweep.
    // Worker 0 is special: it reuses firstDaemon (already spawned), and its
    // port may have walked past stale daemon ports before the spawn.
    // Every worker needs one daemon + agent port pair per device of its group.
    // Pairs are walked in order and chunked into slots of `groupSize`; the
    // first pair is the already-spawned discovery daemon (worker 0's primary).
    const wantedWorkers = Math.min(maxUsefulWorkers, Math.floor(deviceSerials.length / groupSize));
    const wantedPairs = wantedWorkers * groupSize;
    const portPairs: Array<{ daemonPort: number; agentPort: number }> = [
      { daemonPort: firstDaemonPort, agentPort: firstAgentPort },
    ];
    const reservedDaemonPorts = new Set([firstDaemonPort]);
    for (let k = 0; portPairs.length < wantedPairs && k < wantedPairs + 10; k++) {
      const port = baseDaemonPort + 1 + _portOffset + k;
      const agentPort = baseAgentPort + 1 + _portOffset + k;
      if (reservedDaemonPorts.has(port)) continue;
      // As for worker 0: only a free slot's agent port is cleared.
      if (await isPortAvailable(port)) {
        freeStaleAgentPort(agentPort, reportFreedAgentPort);
        portPairs.push({ daemonPort: port, agentPort });
        reservedDaemonPorts.add(port);
      } else {
        note(`Skipping port ${port} (in use), trying next...`);
      }
    }
    const availableWorkerSlots: Array<{
      workerId: number
      daemonPort: number
      agentPort: number
      members: Array<{ daemonPort: number; agentPort: number }>
    }> = [];
    for (let w = 0; (w + 1) * groupSize <= portPairs.length; w++) {
      const pairs = portPairs.slice(w * groupSize, (w + 1) * groupSize);
      availableWorkerSlots.push({ workerId: w, ...pairs[0], members: pairs.slice(1) });
    }

    // Initialize all workers in parallel — each has its own daemon(s),
    // device(s), and agent(s) so there are no shared resources during init.
    const initPromises: Promise<WorkerHandle>[] = [];
    const failedWorkerMessages: string[] = [];
    const slotSerials = (workerId: number): string[] => deviceSerials.slice(workerId * groupSize, (workerId + 1) * groupSize);
    const isFreshSerial = (serial: string): boolean => launchedSerials.has(serial) || freshIosUdids.has(serial);

    for (const slot of availableWorkerSlots) {
      const serials = slotSerials(slot.workerId);
      const candidateSerial = serials[0];
      const isFresh = isFreshSerial(candidateSerial);
      initPromises.push(
        initializeWorker({
          workerId: slot.workerId,
          deviceSerial: candidateSerial,
          deviceName: deviceGroup[0].name,
          members: slot.members.map((ports, i) => ({
            name: deviceGroup[i + 1].name,
            deviceSerial: serials[i + 1],
            fresh: isFreshSerial(serials[i + 1]),
            ...ports,
          })),
          daemonBin,
          serializedConfig,
          baseDaemonPort,
          baseAgentPort,
          firstDaemon,
          resolvedScript,
          initializationTimeoutMs: isFresh
            ? LAUNCHED_EMULATOR_INIT_TIMEOUT_MS
            : EXISTING_DEVICE_INIT_TIMEOUT_MS,
          freshEmulator: isFresh,
          forceInstall: opts.forceInstall,
          tsxBin,
          daemonPortOverride: slot.daemonPort,
          agentPortOverride: slot.agentPort,
          displayWorkerId: displayWorkerId(slot.workerId),
          launchProgress,
          ...(launchProgress ? {
            onProgress: (message: string) => {
              updateWorkerLaunchPhases(displayWorkerId(slot.workerId), message);
              updateWorkerProgress(`Worker ${displayWorkerId(slot.workerId)} (${candidateSerial}): ${message}`);
            },
            onDaemonReady: () => {
              markLaunchPhaseComplete(
                'daemon',
                displayWorkerId(slot.workerId),
                `Worker ${displayWorkerId(slot.workerId)}: daemon ready on localhost:${slot.daemonPort}`,
              );
            },
            onReady: () => {
              markAllLaunchPhasesCompleteForWorker(displayWorkerId(slot.workerId));
              progressReadyCounter.count++;
              updateWorkerProgress(`Worker ${displayWorkerId(slot.workerId)} (${candidateSerial}): ready`);
            },
          } : {}),
        }),
      );
    }

    const initResults = await Promise.allSettled(initPromises);
    for (let i = 0; i < initResults.length; i++) {
      const result = initResults[i];
      if (result.status === 'fulfilled') {
        const worker = result.value;
        if (worker.id === 0) firstDaemonAssigned = true;
        workers.push(worker);
      } else {
        const serial = slotSerials(i).join('+');
        const reasonText = messageFromUnknown(result.reason);
        // The progress row is one line; the whole reason is in the error.
        const reasonSummary = reasonText.split('\n')[0];
        const workerLabel = `Worker ${displayWorkerId(i)} (${serial})`;
        failedWorkerMessages.push(workerFailureMessage(workerLabel, reasonText));
        if (launchProgress) {
          launchProgress.update('ui-workers', {
            state: 'running',
            detail: `${workerLabel} failed: ${reasonSummary}`,
            progress: { done: progressReadyCounter.count, total: progressWorkerTotal },
          });
        } else {
          process.stderr.write(`${YELLOW}${skippingDeviceNotice(serial, reasonText)}${RESET}\n`);
        }
      }
    }

    const workerCount = workers.length;

    if (workerCount === 0) {
      const prefix = opts.bucketLabel ? `${opts.bucketLabel}: ` : '';
      const firstFailure = failedWorkerMessages[0]
        ?.replace(/^Worker \d+ \([^)]+\): /, '')
        .split('\n')[0];
      markIncompleteLaunchPhases(
        opts.bucketLabel ? 'warning' : 'failed',
        `${prefix}${firstFailure ?? 'worker startup failed'}`,
      );
      failStep(
        'ui-workers',
        firstFailure
          ? `0/${maxUsefulWorkers} worker(s) ready; ${firstFailure}`
          : 'no worker-ready devices',
      );
      // Devices were found — the workers on them failed. Say which, and
      // why: "no worker-ready devices … or set `avd`" was wrong on both
      // counts when another bucket had a ready device or `avd` was set
      // (PILOT-400). A multi-bucket run labels it with the target.
      throw new LaunchSetupError(withDetail(
        `No worker could start${firstFailure ? `: ${firstFailure}` : ''}`,
        [...failedWorkerMessages.flatMap((m) => m.split('\n')), workerStartAdvice()],
      ));
    }

    if (workerCount < maxUsefulWorkers) {
      const message = `Requested ${maxUsefulWorkers} workers but only ${workerCount} healthy worker-ready device(s) available. Using ${workerCount} worker(s).`;
      markIncompleteLaunchPhases(
        'warning',
        `${workerCount}/${maxUsefulWorkers} worker(s) ready; ${maxUsefulWorkers - workerCount} failed`,
      );
      if (launchProgress) {
        launchProgress.update('ui-workers', {
          state: 'warning',
          detail: `${opts.bucketLabel ? `${opts.bucketLabel}: ` : ''}${workerCount}/${maxUsefulWorkers} worker(s) ready; ${maxUsefulWorkers - workerCount} failed`,
          progress: { done: progressReadyCounter.count, total: progressWorkerTotal },
        });
      } else {
        process.stderr.write(`${YELLOW}Warning: ${message}${RESET}\n`);
      }
    }

    setupDuration = Date.now() - totalStart;

    // Top-level (non-bucket) runs print their own "Running N test files
    // across M workers" line. When this call is one of N concurrent buckets,
    // the parent runMultiBucket prints an aggregated line and we stay quiet.
    if (launchProgress) {
      if (!opts.bucketLabel) {
        if (workerCount < maxUsefulWorkers) {
          launchProgress.update('ui-workers', {
            state: 'warning',
            detail: `${workerCount}/${maxUsefulWorkers} worker(s) ready; ${maxUsefulWorkers - workerCount} failed`,
            progress: { done: workerCount, total: maxUsefulWorkers },
          });
        } else {
          launchProgress.complete('ui-workers', `${workerCount} worker(s) ready`);
        }
      }
      if (!opts.beforeDispatch) {
        launchProgress.finish();
        reporter.onRunStart?.(config, testFiles.length);
      }
    } else if (!opts.bucketLabel) {
      process.stderr.write(
        `${DIM}Running ${testFiles.length} test file(s) across ${workerCount} worker(s)${RESET}\n`,
      );
    }
    // A multi-bucket run's barrier: every bucket has to arrive (or fail to
    // start) before any dispatches, with or without launch progress.
    if (opts.beforeDispatch) await opts.beforeDispatch();

    // ─── Wave-based work-stealing dispatch ───
    // Build tagged file entries for dispatch. When projects are configured,
    // we dispatch in waves (one per dependency tier). Otherwise, single wave.

    type Wave = TaggedFile[]

    const waves: Wave[] = [];
    const failedProjects = new Set<string>();

    if (opts.projectWaves && opts.projects) {
      for (const wave of opts.projectWaves) {
        const waveFiles: TaggedFile[] = [];
        for (const project of wave) {
          const projectGrep = serializeRegExpArray(normalizeGrep(project.grep));
          const projectGrepInvert = serializeRegExpArray(normalizeGrep(project.grepInvert));
          for (const file of project.testFiles) {
            waveFiles.push({
              filePath: file,
              projectUseOptions: project.use as TaggedFile['projectUseOptions'],
              projectName: project.name,
              projectGrep,
              projectGrepInvert,
            });
          }
        }
        if (waveFiles.length > 0) {
          waves.push(waveFiles);
        }
      }
    } else {
      // No projects — single wave with all files
      waves.push(testFiles.map((f) => ({ filePath: f })));
    }

    // Dispatch one wave at a time. Within a wave, work-stealing across workers.
    async function dispatchWave(waveFiles: TaggedFile[]): Promise<void> {
      const fileQueue = [...waveFiles];

      try {
        await dispatchWaveInner(fileQueue);
      } finally {
        // Stop routing IPC errors into this wave's (now settled) dispatch
        // state; the fork-time 'error' listener falls back to a stderr note.
        for (const worker of workers) {
          worker.onIpcError = undefined;
        }
      }
    }

    async function dispatchWaveInner(fileQueue: TaggedFile[]): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        let hasError = false;
        let settled = false;

        function maybeResolve(): void {
          if (settled || hasError) return;
          if (fileQueue.length > 0) return;
          if (workers.every((w) => w.retired || !w.busy)) {
            settled = true;
            resolve();
          }
        }

        function failRun(error: Error): void {
          if (settled || hasError) return;
          hasError = true;
          settled = true;
          reject(error);
        }

        function dispatchNext(worker: WorkerHandle): void {
          if (worker.retired) return;

          const next = fileQueue.shift();
          if (!next) {
            worker.busy = false;
            worker.currentFile = undefined;
            maybeResolve();
            return;
          }

          worker.busy = true;
          worker.currentFile = next;
          reporter.onTestFileStart?.(next.filePath);

          const msg: MainToWorkerMessage = {
            type: 'run-file',
            filePath: next.filePath,
            projectUseOptions: next.projectUseOptions,
            projectName: next.projectName,
            projectGrep: next.projectGrep,
            projectGrepInvert: next.projectGrepInvert,
          };
          sendToWorkerProcess(worker.process, msg, (err) => {
            // The file we just assigned is worker.currentFile, so retiring
            // the worker requeues it onto a surviving worker.
            retireWorker(worker, `could not send ${path.basename(next.filePath)} to the worker process: ${err.message}`);
          });
        }

        const workerTestCounts = new Map<number, number>();

        function retireWorker(worker: WorkerHandle, reason: string): void {
          if (worker.retired) return;
          // On Ctrl-C we killed these workers ourselves — don't spam the
          // user with "became unavailable" warnings that are a consequence
          // of our own cleanup. emergencyCleanup will force-exit shortly.
          // Likewise once the wave has settled: worker deaths after that
          // point are teardown noise, not lost work.
          if (dispatcherIsShuttingDown || settled) {
            worker.retired = true;
            return;
          }

          worker.retired = true;
          const inFlightFile = worker.currentFile;
          worker.currentFile = undefined;
          worker.busy = false;

          cleanupWorkerResources(worker);

          if (inFlightFile) {
            const discarded = workerTestCounts.get(worker.id) ?? 0;
            workerTestCounts.delete(worker.id);
            if (discarded > 0) {
              reporter.onTestFileRetry?.(inFlightFile.filePath, discarded);
            }
            fileQueue.unshift(inFlightFile);
            process.stderr.write(
              `${YELLOW}Worker ${displayWorkerId(worker.id)} (${worker.deviceSerial}) became unavailable: ${reason}. Requeueing ${path.basename(inFlightFile.filePath)} and continuing with remaining workers.${RESET}\n`,
            );
          } else {
            process.stderr.write(
              `${YELLOW}Worker ${displayWorkerId(worker.id)} (${worker.deviceSerial}) became unavailable: ${reason}. Continuing with remaining workers.${RESET}\n`,
            );
          }

          const activeWorkers = workers.filter((w) => !w.retired);
          if (activeWorkers.length === 0) {
            failRun(
              new Error(
                `All workers became unavailable before the run completed. Last failure: ${reason}`,
              ),
            );
            return;
          }

          const idleWorker = activeWorkers.find((w) => !w.busy);
          if (idleWorker) {
            dispatchNext(idleWorker);
          }

          maybeResolve();
        }

        // Workers retired in an earlier wave stay retired. If none survived,
        // fail now instead of waiting forever for dispatches that never start.
        if (workers.every((w) => w.retired)) {
          failRun(
            new Error('All workers became unavailable before the run completed.'),
          );
          return;
        }

        // Remove previous listeners and re-attach for this wave
        for (const worker of workers) {
          worker.process.removeAllListeners('message');
          worker.process.removeAllListeners('exit');

          // Async IPC failures (e.g. kill/send races with a dying child)
          // surface as ChildProcess 'error' events — treat them as the
          // worker being gone, not as a fatal dispatcher crash.
          worker.onIpcError = (err) => {
            retireWorker(worker, `IPC channel error: ${err.message}`);
          };

          worker.process.on('message', (msg: WorkerToMainMessage) => {
            if (hasError || worker.retired) return;

            switch (msg.type) {
              case 'test-start':
                handleParallelTestStartMessage(msg, reporter, opts.workerIndexBase);
                break;
              case 'test-end': {
                handleParallelTestEndMessage(
                  msg,
                  workerTestCounts,
                  reporter,
                  opts.workerIndexBase,
                );
                break;
              }
              case 'file-start':
                workerTestCounts.set(msg.workerId, 0);
                break;
              case 'file-retry': {
                handleParallelFileRetryMessage(msg, workerTestCounts, reporter);
                break;
              }
              case 'file-done': {
                worker.currentFile = undefined;
                const { results, suite } = handleParallelFileDoneMessage(
                  msg,
                  workerTestCounts,
                  opts.workerIndexBase,
                );
                allResults.push(...results);
                allSuites.push(suite);

                reporter.onTestFileEnd?.(msg.filePath, results);

                dispatchNext(worker);
                break;
              }
              case 'progress': {
                // Live progress for slow device actions (between-file resets,
                // app-state save/restore) so the run doesn't look hung (PILOT-232).
                // Goes through process.stdout.write so the list reporter's
                // live-region interceptor can redraw around it.
                const displayId = msg.workerId + (opts.workerIndexBase ?? 0);
                process.stdout.write(`${DIM}  [worker ${displayId}] ${msg.message}${RESET}\n`);
                break;
              }
              case 'error': {
                retireWorker(worker, msg.error.message);
                break;
              }
            }
          });

          worker.process.on('exit', (code, signal) => {
            if (dispatcherIsShuttingDown) return;
            // Any exit during a wave is unexpected — workers only exit
            // legitimately via the post-run 'shutdown' message (and
            // retireWorker is a silent no-op once the wave has settled).
            // A code-0 exit mid-wave previously left the worker "active",
            // wedging the wave or crashing a later send to the dead child.
            if (!hasError && !worker.retired) {
              retireWorker(
                worker,
                `exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`,
              );
            }
          });

          // Start dispatching to each worker
          dispatchNext(worker);
        }
      });
    }

    // Execute waves sequentially, with dependency-failure skipping
    if (opts.projectWaves && opts.projects) {
      for (const projectWave of opts.projectWaves) {
        const filteredWaveFiles: TaggedFile[] = [];
        for (const project of projectWave) {
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
          if (blockedBy) {
            process.stderr.write(
              `${DIM}Skipping project "${project.name}" — dependency "${blockedBy}" failed${RESET}\n`,
            );
            for (const file of project.testFiles) {
              const skippedResult: TestResult = {
                name: path.basename(file),
                fullName: path.basename(file),
                status: 'skipped',
                durationMs: 0,
                project: project.name,
              };
              allResults.push(skippedResult);
              reporter.onTestEnd?.(skippedResult);
            }
            failedProjects.add(project.name);
            continue;
          }
          const projectGrep = serializeRegExpArray(normalizeGrep(project.grep));
          const projectGrepInvert = serializeRegExpArray(normalizeGrep(project.grepInvert));
          for (const file of project.testFiles) {
            filteredWaveFiles.push({
              filePath: file,
              projectUseOptions: project.use as TaggedFile['projectUseOptions'],
              projectName: project.name,
              projectGrep,
              projectGrepInvert,
            });
          }
        }
        if (filteredWaveFiles.length > 0) {
          const resultsBefore = allResults.length;
          await dispatchWave(filteredWaveFiles);

          // Track failures per-project (not per-wave) so only actual failed
          // projects block their dependents, not unrelated sibling projects.
          const waveResults = allResults.slice(resultsBefore);
          for (const project of projectWave) {
            if (failedProjects.has(project.name)) continue;
            const projectFailed = waveResults.some(
              (r) => r.status === 'failed' && r.project === project.name,
            );
            if (projectFailed) {
              failedProjects.add(project.name);
            }
          }
        }
      }
    } else {
      // No projects — single wave with all files
      await dispatchWave(waves[0] ?? []);
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    activeEmergencyCleanups.delete(teardownResources);
    // Once the last concurrent bucket is done, drop the process-wide crash
    // handlers so they don't linger in long-lived hosts (MCP server, watch/UI
    // mode) and hijack later unrelated errors.
    if (activeEmergencyCleanups.size === 0) {
      uninstallFatalErrorHandlers();
    }

    // Cleanup order matters: workers first, then daemons, then ADB state, then emulators.
    // This ensures nothing is using the resources when we clean them up.

    // 1. Shut down workers gracefully, then force-kill
    const workerExitPromises: Promise<void>[] = [];
    for (const worker of workers) {
      try {
        // The run is over and we're discarding this worker either way; mark
        // it retired so late IPC errors from the shutdown don't print
        // spurious notes via the permanent 'error' listener.
        worker.retired = true;
        const alive = worker.process?.exitCode === null
          && worker.process.signalCode === null;
        if (alive) {
          const exitPromise = new Promise<void>((resolve) => {
            worker.process.once('exit', () => resolve());
            setTimeout(() => {
              try { worker.process.kill(); } catch { /* already dead */ }
              resolve();
            }, 3_000);
          });
          if (worker.process.connected) {
            // Send failures mean the worker is already dead/dying; the kill
            // timeout above resolves the exit promise either way.
            sendToWorkerProcess(worker.process, { type: 'shutdown' }, () => {});
          } else {
            // Alive but IPC channel gone — can't ask nicely, kill directly.
            try { worker.process.kill(); } catch { /* already dead */ }
          }
          workerExitPromises.push(exitPromise);
        }
      } catch { /* worker may already be dead */ }
    }
    await Promise.all(workerExitPromises);

    // 2. Kill daemons
    for (const worker of workers) {
      try {
        worker.daemonProcess?.kill();
      } catch { /* daemon may already be dead */ }
    }

    if (!firstDaemonAssigned) {
      try {
        firstDaemon.kill();
      } catch { /* daemon may already be dead */ }
    }

    if (isIos) {
      // 3. Preserve cloned simulators for reuse by the next run.
      // They stay booted and in the manifest. Only emergency cleanup deletes them.
      preserveSimulatorsForReuse(clonedSimulators);
    } else {
      // 3. Clean up ADB port forwards created by worker daemons.
      // Each daemon set up `adb forward tcp:<agentPort> tcp:18700` on its device.
      // Stale forwards break subsequent runs on the same device.
      for (const worker of workers) {
        for (const { deviceSerial, agentPort } of [worker, ...worker.members]) {
          try {
            execFileSync('adb', ['-s', deviceSerial, 'forward', '--remove', `tcp:${agentPort}`], {
              timeout: 5_000,
              stdio: 'ignore',
            });
          } catch { /* forward may already be gone */ }
        }
      }

      // 4. Leave emulators running for reuse by the next run.
      // The PID manifest keeps them tracked. Only emergency cleanup kills them.
      // The CLI names them after the run summary (preserveEmulatorsForReuse):
      // printed here, per bucket, it would land mid-run.
    }
  }

  const totalDuration = Date.now() - totalStart;
  const hasFailed = allResults.some((r) => r.status === 'failed');

  return {
    status: hasFailed ? 'failed' : 'passed',
    duration: totalDuration,
    setupDuration,
    tests: allResults,
    suites: allSuites,
  };
}

function cleanupWorkerResources(worker: WorkerHandle): void {
  try {
    // Kill based on liveness, not `connected` — a worker whose IPC channel
    // broke (the reason it's being retired) can still be alive and running
    // a test, and would otherwise be orphaned.
    if (worker.process.exitCode === null && worker.process.signalCode === null) {
      worker.process.kill();
    }
  } catch { /* already dead */ }

  for (const { deviceSerial, agentPort, daemonProcess } of [worker, ...worker.members]) {
    try {
      daemonProcess?.kill();
    } catch { /* already dead */ }

    try {
      execFileSync('adb', ['-s', deviceSerial, 'forward', '--remove', `tcp:${agentPort}`], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch { /* forward may already be gone */ }
  }
}

interface InitializeWorkerOptions {
  workerId: number
  deviceSerial: string
  /** The primary's group entry name (`InitMessage.deviceName`). */
  deviceName: string
  /** The rest of the worker's device group, each needing its own daemon. */
  members: Array<{ name: string; deviceSerial: string; daemonPort: number; agentPort: number; fresh: boolean }>
  daemonBin: string
  serializedConfig: SerializedConfig
  baseDaemonPort: number
  baseAgentPort: number
  firstDaemon: ChildProcess
  resolvedScript: string
  initializationTimeoutMs: number
  freshEmulator: boolean
  forceInstall: boolean
  tsxBin?: string
  /** Override the daemon port instead of computing baseDaemonPort + 1 + workerId. */
  daemonPortOverride?: number
  /** Override the agent port instead of computing baseAgentPort + 1 + workerId. */
  agentPortOverride?: number
  /** Globally-unique worker ID used in user-facing log lines. */
  displayWorkerId?: number
  onProgress?: (message: string) => void
  onDaemonReady?: () => void
  onReady?: () => void
  launchProgress?: LaunchProgressSink
}

async function initializeWorker(opts: InitializeWorkerOptions): Promise<WorkerHandle> {
  const {
    workerId,
    deviceSerial,
    daemonBin,
    serializedConfig,
    baseDaemonPort,
    baseAgentPort,
    firstDaemon,
    resolvedScript,
    initializationTimeoutMs,
    tsxBin,
  } = opts;

  const daemonPort = opts.daemonPortOverride ?? (baseDaemonPort + 1 + workerId);
  const agentPort = opts.agentPortOverride ?? (baseAgentPort + 1 + workerId);

  const spawnWorkerDaemon = async (port: number, agent: number, describe: string): Promise<ChildProcess> => {
    opts.onProgress?.(`starting worker daemon on localhost:${port}`);
    const { spawned, output } = spawnDaemonProcess(daemonBin, port, agent, opts.displayWorkerId ?? workerId, opts.serializedConfig.platform);
    const startFailure = async (outcome: DaemonStartFailed): Promise<Error> => {
      const portInUse = !outcome.spawnFailed && !(await isPortAvailable(port));
      // "port in use" on the headline, which is all a progress row shows.
      const message = daemonStartFailure(`Daemon for ${describe} on port ${port}${portInUse ? ' (already in use)' : ''} did not start`, {
        ...outcome,
        recentOutput: output.recentOutput(),
        logPath: output.logPath,
      });
      output.dispose();
      return new Error(message);
    };
    if (!spawned.ok) throw await startFailure(spawned);
    const proc = spawned.child;
    proc.unref();

    const client = new TapsmithGrpcClient(`localhost:${port}`);
    const started = await awaitDaemonStart(spawned, client, {
      budgetMs: 10_000,
      address: `localhost:${port}`,
    });
    client.close();
    if (!started.ok) {
      try { proc.kill(); } catch { /* already dead */ }
      throw await startFailure(started);
    }
    output.dispose();
    return proc;
  };

  let daemonProcess: ChildProcess | undefined;
  if (workerId === 0) {
    daemonProcess = firstDaemon;
    opts.onDaemonReady?.();
  } else {
    daemonProcess = await spawnWorkerDaemon(daemonPort, agentPort, `worker ${opts.displayWorkerId ?? workerId}`);
    opts.onDaemonReady?.();
  }

  // One more daemon per group member, spawned together — they are independent.
  const members: WorkerGroupMemberHandle[] = [];
  try {
    // Settle every spawn before judging: `Promise.all` would reject on the
    // first failure while its siblings were still starting, and the ones that
    // then came up would never be captured — or killed.
    const settled = await Promise.allSettled(opts.members.map((m) =>
      spawnWorkerDaemon(m.daemonPort, m.agentPort, `worker ${opts.displayWorkerId ?? workerId} member ${m.name}`)));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      for (const r of settled) {
        if (r.status === 'fulfilled') { try { r.value.kill(); } catch { /* already dead */ } }
      }
      throw failure.reason;
    }
    const memberDaemons = settled.map((r) => (r as PromiseFulfilledResult<ChildProcess>).value);
    opts.members.forEach((m, i) => members.push({

      name: m.name,
      deviceSerial: m.deviceSerial,
      daemonPort: m.daemonPort,
      agentPort: m.agentPort,
      daemonProcess: memberDaemons[i],
    }));
  } catch (err) {
    if (workerId !== 0) {
      try { daemonProcess?.kill(); } catch { /* already dead */ }
    }
    throw err;
  }

  const child = fork(resolvedScript, [], {
    stdio: forkStdioForLaunchProgress(opts.launchProgress),
    ...(tsxBin ? { execPath: tsxBin } : {}),
    env: {
      ...process.env,
      TAPSMITH_WORKER_ID: String(workerId),
    },
  });
  pipeForkOutputForLaunchProgress(child, opts.launchProgress);
  // Init + dispatch loop each add message/exit listeners; raise the cap to avoid warnings.
  child.setMaxListeners(20);

  const worker: WorkerHandle = {
    id: workerId,
    process: child,
    deviceSerial,
    daemonPort,
    agentPort,
    daemonProcess,
    members,
    busy: false,
  };

  // Permanent listener: a ChildProcess with no 'error' listener turns any
  // spawn/kill/IPC failure into an uncaught exception that kills the whole
  // dispatcher (PILOT-228). Routed through the handle so the init handshake
  // and each dispatch wave can install their own recovery.
  child.on('error', (err) => {
    if (worker.onIpcError) {
      worker.onIpcError(err);
    } else if (!worker.retired && !dispatcherIsShuttingDown) {
      // Retired/shutting-down workers are deliberately killed — late IPC
      // errors from them are expected and not worth a note.
      process.stderr.write(
        `${DIM}Worker ${opts.displayWorkerId ?? workerId} (${deviceSerial}) IPC error ignored outside dispatch: ${err.message}${RESET}\n`,
      );
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `worker ${workerId} timed out during initialization after ${Math.round(initializationTimeoutMs / 1000)}s`,
          ),
        );
      }, initializationTimeoutMs);

      const onExit = (code: number | null) => {
        if (code !== 0) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`worker ${workerId} exited with code ${code} during initialization`));
        }
      };

      const onMessage = (msg: WorkerToMainMessage) => {
        if (msg.type === 'ready' && msg.workerId === worker.id) {
          opts.onReady?.();
          clearTimeout(timeout);
          cleanup();
          resolve();
        } else if (msg.type === 'progress' && msg.workerId === worker.id) {
          const displayId = opts.displayWorkerId ?? worker.id;
          if (opts.onProgress) opts.onProgress(msg.message);
          else process.stderr.write(`${DIM}  Worker ${displayId} (${worker.deviceSerial}): ${msg.message}${RESET}\n`);
        } else if (msg.type === 'error' && msg.workerId === worker.id) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(msg.error.message));
        }
      };

      const cleanup = () => {
        worker.process.removeListener('exit', onExit);
        worker.process.removeListener('message', onMessage);
        worker.onIpcError = undefined;
      };

      worker.process.on('exit', onExit);
      worker.process.on('message', onMessage);
      worker.onIpcError = (err) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`worker ${workerId} IPC failure during initialization: ${err.message}`));
      };

      // Send init after listeners are registered so no messages are lost.
      sendToWorkerProcess(worker.process, {
        type: 'init',
        workerId: worker.id,
        deviceSerial: worker.deviceSerial,
        deviceName: opts.deviceName,
        daemonPort: worker.daemonPort,
        config: serializedConfig,
        freshEmulator: opts.freshEmulator === true ? true : undefined,
        forceInstall: opts.forceInstall,
        ...(members.length > 0 ? {
          groupMembers: members.map((m, i) => ({
            name: m.name,
            deviceSerial: m.deviceSerial,
            daemonPort: m.daemonPort,
            freshEmulator: opts.members[i].fresh || undefined,
          })),
        } : {}),
      }, (err) => {
        worker.onIpcError?.(err);
      });
    });

    return worker;
  } catch (err) {
    // Mark retired so late IPC errors from the process we're about to kill
    // don't print spurious notes via the permanent 'error' listener.
    worker.retired = true;
    try {
      if (worker.process.exitCode === null && worker.process.signalCode === null) {
        worker.process.kill();
      }
    } catch { /* already dead */ }

    if (workerId !== 0) {
      try { daemonProcess?.kill(); } catch { /* already dead */ }
    }
    for (const m of members) {
      try { m.daemonProcess?.kill(); } catch { /* already dead */ }
    }

    for (const target of [{ deviceSerial, agentPort }, ...members]) {
      try {
        execFileSync('adb', ['-s', target.deviceSerial, 'forward', '--remove', `tcp:${target.agentPort}`], {
          timeout: 5_000,
          stdio: 'ignore',
        });
      } catch { /* forward may not exist */ }
    }

    throw err;
  }
}

/**
 * Check whether a TCP port is available for binding.
 * Returns true if the port is free, false if already in use.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function warnUnhealthyDevices(devices: DeviceHealthResult[], progress?: LaunchProgressSink): void {
  for (const device of devices) {
    const avd = device.serial.startsWith('emulator-') ? getRunningAvdName(device.serial) : undefined;
    const label = avd ? `${device.serial} (${avd})` : device.serial;
    const message = `Skipping unhealthy device ${label}: ${device.reason ?? 'unknown health check failure'}.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }
}

function warnSkippedDevices(devices: Array<{ serial: string; reason: string }>, progress?: LaunchProgressSink): void {
  for (const device of devices) {
    const message = `Skipping device ${device.serial}: ${device.reason}.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }
}
