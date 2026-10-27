/**
 * Watch mode child process.
 *
 * Spawned by the watch coordinator for each test re-run. Connects to the
 * already-running daemon(s), resets the app, runs a single test file, and
 * streams results back to the parent via IPC. Exits after completion so
 * the next run gets a fresh ESM module cache.
 *
 * @see PILOT-120
 */

import { runTestFile, collectResults, type RunDevice } from './runner.js';
import { telemetry, type RunMode } from './telemetry.js';
import { ensureSessionReady } from './session-preflight.js';
import type { ResetCapabilities } from './app-reset.js';
import { installActionProgressPrinter } from './action-progress-renderer.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  deserializeGrepFilters,
  configFromSerialized,
  type SerializedConfig,
  type RunFileUseOptions,
  type SerializedGrepFilters,
} from './worker-protocol.js';
import { closeDeviceSession, consumePrepared, openDeviceGroup, sessionsForRun } from './device-session.js';
import { currentSession } from './device-claims.js';

// ─── IPC protocol ───

/**
 * Ask the in-flight run to stop and report what it has.
 *
 * The parent used to SIGTERM this child instead. That destroyed the run's own
 * account of itself: the `file-done` message never arrived, so every test that
 * had already finished was missing from the parent's summary even though it had
 * streamed a `test-end` for each one. A cooperative abort lets the run end
 * itself and report, exactly as watch mode's UI-worker counterpart does.
 */
export interface WatchRunAbortMessage {
  type: 'abort'
}

export type WatchRunIncomingMessage = WatchRunMessage | WatchRunAbortMessage;

/** A secondary device of the run's group, with the daemon that drives it. */
export interface WatchRunGroupMember {
  /** Group entry name from `use.devices` (e.g. `bob`). */
  name: string
  daemonAddress: string
  deviceSerial: string
  /** The parent's sticky reset-capability knowledge for this device. */
  resetCapabilities?: ResetCapabilities
}

export interface WatchRunMessage {
  type: 'run'
  /** The primary device's daemon and serial (`devices[0]`). */
  daemonAddress: string
  deviceSerial: string
  /** The primary's group entry name — see `InitMessage.deviceName`. */
  deviceName: string
  filePath: string
  config: SerializedConfig
  screenshotDir?: string
  projectUseOptions?: RunFileUseOptions
  projectName?: string
  /** Run only tests whose fullName matches this (case-insensitive substring). */
  testFilter?: string
  /**
   * The config's grep filters for this file's project, root and project.
   * Required, not read from `config`: the root's alone left a project's
   * `grep` / `grepInvert` unapplied in watch mode and headless MCP runs
   * (PILOT-730).
   */
  grep: SerializedGrepFilters
  /**
   * What to call this run in preflight errors, e.g. "Watch" or "Run".
   *
   * The MCP dispatcher runs its files through this same child, so the default
   * put "Watch (<serial>): … during watch reset" in front of failures from a
   * plain `tapsmith_run_tests` — naming a mode the caller was not using.
   */
  label?: string
  /**
   * Which run path this is, for the run's anonymous telemetry event. Required
   * for the same reason `label` exists: this one child serves both headless
   * watch mode and the MCP dispatcher, and only the parent knows which.
   */
  runMode: Extract<RunMode, 'watch' | 'mcp'>
  /**
   * The parent's sticky reset-capability knowledge for the primary device
   * (in-app hooks detected, …). This child is forked fresh per run, so
   * without it every run would start undetected and `appReset: 'auto'` would
   * resolve to clear · file even when the app supports warm resets. The child
   * reports what it learned back on `file-done`.
   */
  resetCapabilities?: ResetCapabilities
  /**
   * The rest of the device group (`devices[1..]`) for a `use.devices`
   * project; each already has a daemon holding it (the parent owns those
   * daemons across runs). Omitted for single-device runs.
   */
  groupMembers?: WatchRunGroupMember[]
}

export interface WatchRunTestEndMessage {
  type: 'test-end'
  result: import('./worker-protocol.js').SerializedTestResult
}

export interface WatchRunFileDoneMessage {
  type: 'file-done'
  filePath: string
  results: import('./worker-protocol.js').SerializedTestResult[]
  suite: import('./worker-protocol.js').SerializedSuiteResult
  /** What this run learned about the primary device's reset capabilities — the
   * parent folds it into its sticky per-device store (detection only ever upgrades). */
  resetCapabilities?: ResetCapabilities
  /** The same, for every device of the group, keyed by serial. */
  groupResetCapabilities?: Record<string, ResetCapabilities>
}

export interface WatchRunErrorMessage {
  type: 'error'
  error: { message: string; stack?: string }
}

export type WatchRunChildMessage =
  | WatchRunTestEndMessage
  | WatchRunFileDoneMessage
  | WatchRunErrorMessage

// ─── Helpers ───

let ipcOpen = true;

function send(msg: WatchRunChildMessage): void {
  if (!ipcOpen || !process.send) return;
  try {
    process.send(msg);
  } catch {
    // IPC channel may be closed if the parent was killed (e.g. Ctrl+C).
    // Swallow the error — the child is about to exit anyway.
    ipcOpen = false;
  }
}

// ─── Main handler ───

/**
 * Aborts the in-flight run when the parent asks. Set for the duration of a
 * run and cleared after, so a stop arriving while the child sits idle between
 * runs cannot abort the next one.
 */
let currentAbortController: AbortController | undefined;

/** Report a run that produced nothing, so the parent still hears an ending. */
function sendEmptyFileDone(filePath: string): void {
  const emptySuite: import('./runner.js').SuiteResult = { name: '', tests: [], suites: [], durationMs: 0 };
  send({
    type: 'file-done',
    filePath,
    results: [],
    suite: serializeSuiteResult(emptySuite, 0),
  });
}

async function handleRun(msg: WatchRunMessage): Promise<void> {
  const config = configFromSerialized(msg.config, msg.daemonAddress);
  config.device = msg.deviceSerial;
  const label = msg.label ?? 'Watch';
  const members = msg.groupMembers ?? [];

  // Every daemon already holds its device with the agent running (the CLI's
  // startup, or a previous run): attach rather than provision. Without a
  // package the runner performs no reset (and so no readiness check of its
  // own), so verify the agent is alive here, recovering it if it died while
  // watch idled — the other run paths do the same in their startup launch.
  const sessions = await openDeviceGroup(
    [
      { name: msg.deviceName, serial: msg.deviceSerial, daemonAddress: msg.daemonAddress, adopt: true, seedCapabilities: msg.resetCapabilities },
      ...members.map((m) => ({
        name: m.name,
        serial: m.deviceSerial,
        daemonAddress: m.daemonAddress,
        adopt: true,
        seedCapabilities: m.resetCapabilities,
      })),
    ],
    config,
    { claimSession: currentSession(), runMode: msg.runMode, label, adoptVerify: !config.package, connectTimeoutMs: 5_000 },
  );

  // Created BEFORE preflight so a stop that lands during wake/unlock/app-reset
  // is honoured rather than being a no-op that runs the whole file anyway.
  const abortController = new AbortController();
  currentAbortController = abortController;
  for (const s of sessions) s.client._setAbortSignal(abortController.signal);

  // Live progress lines for slow device actions (preflight reset, app-state
  // save/restore, …) — the child's stdout reaches the terminal directly (PILOT-232).
  const disposeActionProgressPrinter = installActionProgressPrinter();

  try {
    // The app reset is the runner's job (declared policy, traced as fixture
    // setup, ending with its own readiness check). A stop that lands during
    // it leaves the file's tests untouched and reports an empty ending.
    if (abortController.signal.aborted) {
      sendEmptyFileDone(msg.filePath);
      return;
    }

    const screenshotDir = msg.screenshotDir;

    // Reporter proxy: stream test results to parent
    const reporterProxy = {
      onTestEnd(result: import('./runner.js').TestResult): void {
        send({
          type: 'test-end',
          result: serializeTestResult(result, 0),
        });
      },
    };

    // The child attached to the target's whole group; this file's project
    // may declare a smaller one (or none), and runs on the first N sessions.
    const devices: RunDevice[] = sessionsForRun(sessions, config, msg.projectUseOptions).map((s) => ({
      name: s.name,
      device: s.device,
      serial: s.serial,
      sessionContext: s.context,
      prepared: consumePrepared(s),
    }));

    const suiteResult = await runTestFile(msg.filePath, {
      config,
      devices,
      screenshotDir,
      reporter: reporterProxy,
      // Per-test readiness check, as in every other run path. Watch has no
      // file-retry loop, so a recovery here simply relaunches the app and
      // lets the test proceed rather than surfacing a raw transport error.
      beforeEachTest: async (fullName) => {
        await Promise.all(sessions.map((s) => ensureSessionReady(s.context, `before test ${fullName}`)));
      },
      resetCapabilities: sessions[0].capabilities,
      runMode: msg.runMode,
      projectUseOptions: msg.projectUseOptions,
      projectName: msg.projectName,
      testFilter: msg.testFilter,
      ...deserializeGrepFilters(msg.grep),
      abortSignal: abortController.signal,
    });

    const results = collectResults(suiteResult);

    send({
      type: 'file-done',
      filePath: msg.filePath,
      results: results.map((r) => serializeTestResult(r, 0)),
      suite: serializeSuiteResult(suiteResult, 0),
      resetCapabilities: sessions[0].capabilities,
      groupResetCapabilities: Object.fromEntries(sessions.map((s) => [s.serial, s.capabilities])),
    });
  } finally {
    disposeActionProgressPrinter();
    for (const s of sessions) s.client._setAbortSignal(undefined);
    if (currentAbortController === abortController) currentAbortController = undefined;
  }

  // Attached sessions: this drops the child's streams and client, leaving
  // the parent's daemons (and their warm network proxies) as they were.
  // Awaited so the teardown lands before the process exits.
  await Promise.all(sessions.map((s) => closeDeviceSession(s)));
}

// ─── IPC message handler ───

process.on('message', async (msg: WatchRunIncomingMessage) => {
  try {
    if (msg.type === 'abort') {
      // No run in flight: nothing to abort, and aborting the *next* one would
      // be wrong. The parent escalates to a signal if this goes unanswered.
      currentAbortController?.abort();
      return;
    }
    if (msg.type === 'run') {
      await handleRun(msg);
      // This child exits right after its one file: bounded wait for that
      // file's telemetry event (PILOT-330).
      await telemetry.flush();
      process.exit(0);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    send({
      type: 'error',
      error: { message: error.message, stack: error.stack },
    });
    process.exit(1);
  }
});
