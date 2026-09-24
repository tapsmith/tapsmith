/**
 * Persistent UI worker child process.
 *
 * Combines the persistent lifecycle of worker-runner.ts (init once, run
 * many files) with real-time trace streaming to the UI server. Every UI
 * session runs through these workers — one per device group; a single device
 * is one worker that adopts the primary daemon/agent the CLI provisioned. A
 * `use.devices` project's worker holds every device of the group, each on its
 * own daemon.
 *
 * @see PILOT-87, PILOT-310
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { runTestFile, collectResults, type RunDevice } from '../runner.js';
import { telemetry } from '../telemetry.js';
import type { TapsmithConfig } from '../config.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  isRecoverableInfrastructureError,
  configFromSerialized,
} from '../worker-protocol.js';
import { ensureSessionReady, executeAppReset } from '../session-preflight.js';
import type { PreparedState, ResetCapabilities } from '../app-reset.js';
import {
  closeDeviceSession,
  consumePrepared,
  sessionsForRun,
  sessionsToPrepare,
  openDeviceGroup,
  recoverDeviceSessions,
  type DeviceSession,
} from '../device-session.js';
import { createActionProgressMessenger } from '../action-progress-renderer.js';
import { isAbortError } from '../abort.js';
import type { AnyTraceEvent } from '../trace/types.js';
import { createNetworkBodyEncoder } from './encode-bodies.js';
import { streamSourcesForEvent } from './source-stream.js';
import type {
  UIWorkerMessage,
  UIWorkerChildMessage,
  UIWorkerInitMessage,
  UIWorkerPrepareMessage,
  UIWorkerTraceEventMessage,
} from './ui-protocol.js';

// ─── State ───

let workerId = -1;
let config: TapsmithConfig | undefined;
/** The worker's device group, primary first. Empty until `init` completes. */
let sessions: DeviceSession[] = [];
let screenshotDir: string | undefined;
let ipcOpen = true;
let currentAbortController: AbortController | undefined;

// ─── Helpers ───

function send(msg: UIWorkerChildMessage): void {
  if (!ipcOpen || !process.send) return;
  try {
    process.send(msg);
  } catch {
    ipcOpen = false;
  }
}

function sendProgress(message: string): void {
  send({ type: 'progress', workerId, message });
}

/**
 * A launch that already left the app in fresh state (startup, warmup,
 * recovery). Handed to the next file's runner so it can skip its own reset
 * when the declared policy is satisfied — consumed exactly once. The server
 * owns the claim across runs (see handleRunFile); this is the worker's copy
 * for the launch it performed itself.
 */
/**
 * The group's prepared state as one claim, for the server's per-worker
 * readiness: the policy every session's own claim satisfies, or none. Each
 * session keeps its own claim (`DeviceSession.prepared`) — a file that drives
 * only the primary consumes only the primary's, and a preparation resets only
 * the devices its file will use — so this is derived, never stored.
 */
function groupPreparedPolicy(): PreparedState['policy'] | undefined {
  const group = sessions;
  return group.length > 0 && group.every((s) => s.prepared) ? group[0].prepared?.policy : undefined;
}
/** The primary's runtime reset capabilities — the group runs one app build, so its hooks are the group's. */
function sharedCapabilities(): ResetCapabilities {
  return sessions[0]?.capabilities ?? {};
}
/** What the server last heard (`ready` / `capabilities`); diffed after each device op. */
let publishedCapabilities: ResetCapabilities = {};

/**
 * Tell the server when a run or preparation upgraded the shared capabilities
 * (a reset detecting hooks the startup probe missed). The server's copy
 * drives policy resolution for background preparation; without this it would
 * stay a stale snapshot of `ready` and keep preparing with the wrong mode.
 */
function publishCapabilities(): void {
  const current = sharedCapabilities();
  const keys = new Set([...Object.keys(current), ...Object.keys(publishedCapabilities)]) as Set<keyof ResetCapabilities>;
  let changed = false;
  for (const key of keys) {
    if (current[key] !== publishedCapabilities[key]) { changed = true; break; }
  }
  if (!changed) return;
  publishedCapabilities = { ...current };
  send({ type: 'capabilities', workerId, capabilities: { ...current } });
}

function requireSessions(): DeviceSession[] {
  if (!config || sessions.length === 0) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }
  return sessions;
}

// ─── Trace event streaming ───

function setupTraceStreaming(dev: DeviceSession['device']): void {
  const collector = dev.tracing._currentCollector;
  if (!collector) return;

  const sentSources = new Set<string>();
  collector.setEventCallback((event: AnyTraceEvent, screenshots, lifecycle) => {
    streamSourcesForEvent(event, sentSources, (p, fileName, content) =>
      send({ type: 'source', workerId, path: p, fileName, content }));
    const msg: UIWorkerTraceEventMessage = {
      type: 'trace-event',
      workerId,
      event,
      lifecycle,
      screenshotBefore: screenshots?.before?.toString('base64'),
      screenshotAfter: screenshots?.after?.toString('base64'),
      hierarchyBefore: screenshots?.hierarchyBefore,
      hierarchyAfter: screenshots?.hierarchyAfter,
    };
    send(msg);
  });
}

// ─── Init handler ───

async function handleInit(msg: UIWorkerInitMessage): Promise<void> {
  workerId = msg.workerId;
  screenshotDir = msg.screenshotDir;
  const daemonAddress = `localhost:${msg.daemonPort}`;

  config = configFromSerialized(msg.config, daemonAddress);
  config.device = msg.deviceSerial;

  // Force trace on for UI mode
  if (!config.trace || config.trace === 'off') {
    config.trace = 'on';
  }

  // The server resolved the group from the project's config (see
  // `InitMessage.deviceName`); the runner checks the count per file.
  const members = msg.groupMembers ?? [];

  // Adopting the primary device: the CLI already installed the app, started
  // the agent and cold-launched. Verify the session and — on the initial
  // spawn only — hand that launch to the first file as its prepared state. A
  // respawned worker re-adopts a daemon whose app has run tests since;
  // claiming `clear · file` there would skip the first file's reset over the
  // previous run's state. Group members always get the full setup: nothing
  // provisioned them before this worker.
  sessions = await openDeviceGroup(
    [
      {
        name: msg.deviceName,
        serial: msg.deviceSerial,
        daemonAddress,
        adopt: msg.adoptPrimary,
        adoptPrepared: msg.adoptPrepared,
        freshDevice: msg.freshEmulator,
      },
      ...members.map((m) => ({
        name: m.name,
        serial: m.deviceSerial,
        daemonAddress: `localhost:${m.daemonPort}`,
        freshDevice: m.freshEmulator,
        adopt: m.adopt,
        adoptPrepared: m.adopt ? msg.adoptPrepared : undefined,
      })),
    ],
    config,
    {
      label: `UI Worker ${workerId}`,
      launchPhase: 'UI worker startup launch',
      // SetDevice resolves the serial against the daemon's last device listing.
      // A worker that (re)connects later — a recycle, a respawn — cannot assume
      // that listing still holds the device (an Android daemon reported
      // "Device emulator-5554 not found. Run ListDevices first"), so refresh it.
      refreshDeviceList: true,
      onProgress: (message) => sendProgress(message),
    },
  );
  // Each session carries its own prepared state: its startup launch left the
  // app fresh, or (adopted primary) the CLI's launch did.
  finishInit();
}

function finishInit(): void {
  sendProgress('ready');
  publishedCapabilities = { ...sharedCapabilities() };
  send({ type: 'ready', workerId, policy: groupPreparedPolicy(), capabilities: { ...sharedCapabilities() } });

  // From here on, stream slow-device-action progress (between-file preflight,
  // test.use({appState}) restore, recovery) so the UI can show "Restoring app
  // state…" instead of a generic waiting state (PILOT-232). An action's end
  // clears the label — the indicator is "what's happening now", and the
  // Actions panel only renders it while no trace actions have streamed yet,
  // so traced in-test actions can't double-report. Unlike the stdout printer,
  // the label replaces an existing placeholder rather than adding output, so
  // it announces near-immediately; the tiny delay only skips sub-action blips.
  createActionProgressMessenger({
    startDelayMs: 250,
    emit: (text, phase) => sendProgress(phase === 'end' ? '' : text),
  });
}

// ─── Run file handler ───

async function handleRunFile(
  filePath: string,
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions,
  projectName?: string,
  testFilter?: string,
  preparedFor?: PreparedState,
): Promise<void> {
  const group = requireSessions();
  const primary = group[0];
  // The server owns the readiness claim: it mirrors the startup launch into
  // its readiness state and hands it back (or a background preparation) when
  // it still satisfies this file's policy. Each session's own record says
  // what actually happened on that device, and is what the run consumes; the
  // server's is the gate. It omits `preparedFor` when the claim was
  // invalidated — a mirror gesture before the first run, a stale launch — so
  // the records of the devices this file drives must go too, or the runner
  // would skip the file reset over a device the user has already touched.
  // Devices the file leaves alone keep theirs.
  if (!preparedFor) for (const s of sessionsForRun(group, config!, projectUseOptions)) s.prepared = undefined;

  // Created BEFORE the between-files preflight so a stop that lands during
  // wake/unlock/app-reset is honored too — otherwise the abort IPC would be
  // a no-op and the worker would run the entire next file (PILOT-222).
  const abortController = new AbortController();
  currentAbortController = abortController;
  for (const s of group) s.client._setAbortSignal(abortController.signal);

  try {
    // Ensure the devices are awake — the screen may have auto-locked while
    // watch mode was idle waiting for file changes. The between-file app
    // reset itself is the runner's job (declared policy, recorded in the
    // trace as fixture setup, ending with its own readiness check).
    await Promise.all(group.map(async (s) => {
      await s.device.wake();
      await s.device.unlock();
    }));
  } catch (err) {
    // Whether aborted or a genuine preflight failure, this run is over —
    // don't leave a stale controller for a later idle-state abort IPC.
    currentAbortController = undefined;
    if (abortController.signal.aborted || isAbortError(err)) {
      sendEmptyFileDone(filePath);
      return;
    }
    throw err;
  } finally {
    for (const s of group) s.client._setAbortSignal(undefined);
    if (abortController.signal.aborted) currentAbortController = undefined;
  }
  if (abortController.signal.aborted) {
    // Stop arrived during preflight without failing a device call.
    sendEmptyFileDone(filePath);
    return;
  }

  // Send test source file
  try {
    const sourceContent = fs.readFileSync(filePath, 'utf-8');
    send({ type: 'source', workerId, path: filePath.replace(/\\/g, '/'), fileName: path.basename(filePath), content: sourceContent });
  } catch {
    // best-effort
  }

  const reporterProxy = {
    onTestEnd(result: import('../runner.js').TestResult): void {
      send({
        type: 'test-end',
        workerId,
        result: serializeTestResult(result, workerId),
      });
    },
  };

  // Hook into trace streaming — patch once and restore after each run
  // to prevent closure accumulation in persistent workers. The runner starts
  // every collector on the primary; the other devices record into it.
  const dev = primary.device;
  const origStartManaged = dev.tracing._startManaged.bind(dev.tracing);
  dev.tracing._startManaged = (...args: Parameters<typeof dev.tracing._startManaged>) => {
    const collector = origStartManaged(...args);
    setupTraceStreaming(dev);
    return collector;
  };

  let suiteResult;
  try {
    suiteResult = await runFileWithRecovery(
      filePath, reporterProxy, projectUseOptions, projectName, testFilter,
      abortController.signal,
    );
  } finally {
    // Restore original to prevent accumulating wrappers across runs
    dev.tracing._startManaged = origStartManaged;
    currentAbortController = undefined;
  }

  const results = collectResults(suiteResult);

  // Before file-done so the server resolves the next dispatch's policy with
  // whatever this run learned about the device.
  publishCapabilities();
  send({
    type: 'file-done',
    workerId,
    filePath,
    results: results.map((r) => serializeTestResult(r, workerId)),
    suite: serializeSuiteResult(suiteResult, workerId),
  });
}

/** Report a file as done with no results — used when a user stop lands
 * before the file's tests ever started (e.g. during the preflight reset). */
function sendEmptyFileDone(filePath: string): void {
  const emptySuite: import('../runner.js').SuiteResult = { name: '', tests: [], suites: [], durationMs: 0 };
  send({
    type: 'file-done',
    workerId,
    filePath,
    results: [],
    suite: serializeSuiteResult(emptySuite, workerId),
  });
}

/**
 * The runner's view of the devices one file runs on: the project's group,
 * sliced from the worker's (which is its target's largest — see
 * `sessionsForRun`). Each device's prepared state is consumed here, once;
 * a device the file does not drive keeps its claim for a later group file.
 */
function runDevices(projectUseOptions: import('../worker-protocol.js').RunFileUseOptions | undefined): RunDevice[] {
  return sessionsForRun(requireSessions(), config!, projectUseOptions).map((s) => ({
    name: s.name,
    device: s.device,
    serial: s.serial,
    sessionContext: s.context,
    prepared: consumePrepared(s),
  }));
}

async function runFileWithRecovery(
  filePath: string,
  reporterProxy: { onTestEnd(result: import('../runner.js').TestResult): void },
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions,
  projectName?: string,
  testFilter?: string,
  abortSignal?: AbortSignal,
): Promise<import('../runner.js').SuiteResult> {
  const group = requireSessions();
  const cfg = config!;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const encodeBodies = createNetworkBodyEncoder();
      const suite = await runTestFile(filePath, {
        config: cfg,
        devices: runDevices(projectUseOptions),
        screenshotDir,
        reporter: reporterProxy,
        bustImportCache: true,
        abortSignal,
        onTestStart: async (fullName, options) => {
          const policy = options?.policy;
          send({
            type: 'test-start', workerId, fullName, filePath,
            attributionOnly: options?.attributionOnly,
            isolation: policy
              ? { appReset: policy.mode, appResetScope: policy.scope, appState: policy.appState || undefined }
              : undefined,
          });
        },
        beforeEachTest: async (fullName: string) => {
          await Promise.all(group.map((s) => ensureSessionReady(s.context, `before test ${fullName}`)));
        },
        abortFileOnError: isRecoverableInfrastructureError,
        resetCapabilities: sharedCapabilities(),
        runMode: 'ui',
        projectUseOptions,
        projectName,
        testFilter,
        onNetworkEntries: (entries, networkCaptureEnabled, networkCaptureRoute) => {
          for (const { entries: safe, bodies } of encodeBodies(entries)) {
            send({ type: 'network', workerId, entries: safe, bodies, bodyMode: 'patch', networkCaptureEnabled, networkCaptureRoute: networkCaptureRoute ?? null });
          }
        },
      });

      // A user stop is not an infrastructure failure — never recover/retry,
      // just return what ran (PILOT-222).
      if (abortSignal?.aborted) return suite;

      const infrastructureFailure = findRecoverableInfrastructureFailure(collectResults(suite));
      if (!infrastructureFailure) return suite;
      if (attempt === 2) throw infrastructureFailure;
      await recoverFileSession(filePath, infrastructureFailure);
      continue;
    } catch (err) {
      if (abortSignal?.aborted || !isRecoverableInfrastructureError(err) || attempt === 2) throw err;
      await recoverFileSession(filePath, err);
    }
  }

  throw new Error(`UI Worker ${workerId}: exhausted recovery attempts for ${path.basename(filePath)}`);
}

function findRecoverableInfrastructureFailure(
  results: Array<import('../runner.js').TestResult>,
): Error | undefined {
  for (const result of results) {
    if (result.status !== 'failed' || !result.error) continue;
    if (!isRecoverableInfrastructureError(result.error)) continue;
    return new Error(`${result.fullName}: ${result.error.message}`);
  }
  return undefined;
}

async function recoverFileSession(filePath: string, err: unknown): Promise<void> {
  process.stderr.write(
    `UI Worker ${workerId}: Recovering session after infrastructure error in ${path.basename(filePath)}: ${err instanceof Error ? err.message : err}\n`,
  );
  const group = requireSessions();
  // The relaunch is a fresh `clear` on every device, recorded on each session.
  await recoverDeviceSessions(group, `recovery for ${path.basename(filePath)}`);
}

// ─── Shutdown ───

let shuttingDown = false;
function handleShutdown(): void {
  // Exit is deferred behind the telemetry flush, so a worker recycle that
  // sends a second `shutdown` in that window must not tear the same sessions
  // down twice (PILOT-330 review).
  if (shuttingDown) return;
  shuttingDown = true;
  for (const s of sessions) closeDeviceSession(s);
  // Bounded wait for the last file's telemetry event (PILOT-330).
  void telemetry.flush().finally(() => process.exit(0));
}

// ─── Background preparation ───

let currentPrepare: { prepareId: string; abort: AbortController } | undefined;

/**
 * Reset the app to `policy` while no run is in flight so the next Run click
 * pays only a readiness check. Cooperative cancellation: a `run-file` that
 * arrives mid-prepare aborts it (the gRPC call is cancelled through the
 * client's abort signal) and the queue then runs the file — the run never
 * waits for the preparation to finish. Every device of the group is prepared
 * together, as the runner would reset them together.
 */
async function handlePrepare(msg: UIWorkerPrepareMessage): Promise<void> {
  const group = requireSessions();
  // Only the devices the file being prepared for will drive, and of those
  // only the ones not still holding a satisfying claim: a member the last
  // run left untouched is prepared already, and a single-device project's
  // file needs nothing from the rest of the group.
  const targets = sessionsToPrepare(group, config!, msg.projectUseOptions, msg.policy);
  const abort = new AbortController();
  currentPrepare = { prepareId: msg.prepareId, abort };
  for (const s of targets) s.client._setAbortSignal(abort.signal);
  const startedAt = Date.now();
  try {
    await Promise.all(targets.map(async (s) => {
      await s.device.wake();
      await s.device.unlock();
    }));
    // The reset below mutates the device, so whatever the startup launch left
    // behind is gone the moment it starts — cancelled or failed included. Drop
    // the record now; a successful preparation records itself below, and a
    // failed one must not let the next run consume a stale clear·file claim
    // over a half-restored app.
    for (const s of targets) s.prepared = undefined;
    // Project-level use (appState etc.) is folded into the policy by the
    // server; the effective config is the worker's own.
    const reports = await Promise.all(targets.map((s) => executeAppReset(s.context, msg.policy, {
      phase: `background preparation${msg.forFile ? ` for ${path.basename(msg.forFile)}` : ''}`,
    })));
    if (abort.signal.aborted) throw new Error('preparation cancelled');
    const durationMs = Date.now() - startedAt;
    for (const s of targets) {
      s.prepared = { policy: msg.policy, preparedAt: startedAt + durationMs, durationMs, source: 'background preparation' };
    }
    const steps = reports.flatMap((report, i) => report.steps.map((step) =>
      `${group.length > 1 ? `${targets[i].name}: ` : ''}${step.name}: ${step.durationMs}ms${step.ok ? '' : ' (failed)'}`));
    send({
      type: 'prepared',
      workerId,
      prepareId: msg.prepareId,
      policy: msg.policy,
      startedAt,
      durationMs,
      steps,
      // A device that already satisfied the policy credits the preparation
      // that did the work; the claim is only as good as its weakest member.
      // No target at all (every device the file drives already held a
      // satisfying claim) is a valid, instant preparation with no credit.
      satisfiedBy: reports.length > 0 && reports.every((r) => r.satisfiedBy) ? reports[0].satisfiedBy : undefined,
    });
  } catch (err) {
    const cancelled = abort.signal.aborted || isAbortError(err);
    send({
      type: 'prepare-failed',
      workerId,
      prepareId: msg.prepareId,
      error: { message: err instanceof Error ? err.message : String(err) },
      cancelled,
    });
  } finally {
    for (const s of group) s.client._setAbortSignal(undefined);
    if (currentPrepare?.prepareId === msg.prepareId) currentPrepare = undefined;
    publishCapabilities();
  }
}

// ─── Message loop ───
//
// Device-touching operations (init, run-file) are serialized through one
// promise chain: the IPC handler used to start each message's async work
// concurrently, so a `run-file` arriving while a previous op was still on
// the device raced it. `abort` and `shutdown` bypass the queue — they exist
// to interrupt whatever the queue is doing.

let opQueue: Promise<void> = Promise.resolve();

function reportError(err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`UI Worker ${workerId} error: ${error.message}\n`);
  send({
    type: 'error',
    workerId,
    error: { message: error.message, stack: error.stack },
  });
}

function enqueue(op: () => Promise<void>): void {
  opQueue = opQueue.then(op, op).catch(reportError);
}

process.on('message', (msg: UIWorkerMessage) => {
  switch (msg.type) {
    case 'init':
      enqueue(() => handleInit(msg));
      break;
    case 'run-file':
      enqueue(() => handleRunFile(msg.filePath, msg.projectUseOptions, msg.projectName, msg.testFilter, msg.preparedFor));
      break;
    case 'prepare':
      enqueue(() => handlePrepare(msg));
      break;
    case 'cancel-prepare':
      if (currentPrepare?.prepareId === msg.prepareId) currentPrepare.abort.abort();
      break;
    case 'abort':
      currentAbortController?.abort();
      break;
    case 'shutdown':
      handleShutdown();
      break;
  }
});
