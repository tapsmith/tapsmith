/**
 * Worker child process entry point for parallel test execution.
 *
 * Each worker is forked by the dispatcher and assigned a device group — one
 * device for ordinary projects, several for `use.devices` projects — each on
 * its own daemon. It receives test files to run via IPC, executes them
 * sequentially, and sends results back to the main process.
 *
 * @see PILOT-106, PILOT-310
 */

import * as path from 'node:path';
import { runTestFile, collectResults, markFileRetryFlakes, type RunDevice } from './runner.js';
import type { TapsmithConfig } from './config.js';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  InitMessage,
} from './worker-protocol.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  isRecoverableInfrastructureError,
  deserializeRegExpArray,
  configFromSerialized,
} from './worker-protocol.js';
import { ensureSessionReady } from './session-preflight.js';
import {
  closeDeviceSession,
  sessionsForRun,
  consumePrepared,
  openDeviceGroup,
  recoverDeviceSessions,
  type DeviceSession,
} from './device-session.js';
import { createActionProgressMessenger } from './action-progress-renderer.js';
import type { TapsmithReporter } from './reporter.js';
import { telemetry } from './telemetry.js';


let workerId = -1;
let config: TapsmithConfig | undefined;
/** The worker's device group, primary first. Empty until `init` completes. */
let sessions: DeviceSession[] = [];
let rootGrep: RegExp[] | undefined;
let rootGrepInvert: RegExp[] | undefined;

function send(msg: WorkerToMainMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

function sendProgress(message: string): void {
  send({ type: 'progress', workerId, message });
}

async function handleInit(msg: InitMessage): Promise<void> {
  workerId = msg.workerId;
  const daemonAddress = `localhost:${msg.daemonPort}`;

  config = configFromSerialized(msg.config, daemonAddress);
  config.device = msg.deviceSerial;
  rootGrep = deserializeRegExpArray(msg.config.grep);
  rootGrepInvert = deserializeRegExpArray(msg.config.grepInvert);

  // The dispatcher resolved the group from the project's config and hands
  // over a name + serial + daemon per device; the runner checks the count
  // against the project's `use.devices` when each file runs.
  const members = msg.groupMembers ?? [];
  const specs = [
    { name: msg.deviceName, serial: msg.deviceSerial, daemonAddress, freshDevice: msg.freshEmulator },
    ...members.map((m) => ({
      name: m.name,
      serial: m.deviceSerial,
      daemonAddress: `localhost:${m.daemonPort}`,
      freshDevice: m.freshEmulator,
    })),
  ];

  sessions = await openDeviceGroup(specs, config, {
    label: `Worker ${workerId}`,
    forceInstall: msg.forceInstall,
    launchPhase: 'worker startup launch',
    onProgress: (message) => sendProgress(message),
  });

  sendProgress('ready');
  send({ type: 'ready', workerId });

  // From here on, forward slow-device-action progress (between-file resets,
  // app-state save/restore, …) to the main process so headless multi-worker
  // runs show forward motion instead of going silent (PILOT-232). Installed
  // after init — the init phase above already reports its own progress.
  createActionProgressMessenger({ emit: (text) => sendProgress(text) });
}

/** The runner's view of the group: one entry per device, prepared state consumed once. */
/** The devices one file runs on: its project's group, sliced from the worker's (see `sessionsForRun`). */
function runDevices(projectUseOptions: import('./worker-protocol.js').RunFileUseOptions | undefined): RunDevice[] {
  return sessionsForRun(sessions, config!, projectUseOptions).map((s) => ({
    name: s.name,
    device: s.device,
    serial: s.serial,
    sessionContext: s.context,
    prepared: consumePrepared(s),
  }));
}

async function handleRunFile(
  filePath: string,
  projectUseOptions?: import('./worker-protocol.js').RunFileUseOptions,
  projectName?: string,
  projectGrep?: import('./worker-protocol.js').SerializedRegExp[],
  projectGrepInvert?: import('./worker-protocol.js').SerializedRegExp[],
): Promise<void> {
  if (!config || sessions.length === 0) {
    throw new Error(`Worker ${workerId}: Not initialized`);
  }

  send({ type: 'file-start', workerId, filePath });

  // The between-file app reset is the runner's job now: it executes the
  // declared policy as traced fixture setup and ends with its own session
  // readiness check, so nothing device-side happens here. Infrastructure
  // failures surface in the results and drive runFileWithRecovery.

  const screenshotDir =
    config.screenshot !== 'never'
      ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
      : undefined;

  // Create a reporter proxy that sends events back to main process
  const reporterProxy = {
    onTestStart(fullName: string, testFilePath?: string): void {
      send({
        type: 'test-start',
        workerId,
        fullName,
        filePath: testFilePath ?? filePath,
        projectName,
      });
    },
    onTestEnd(result: import('./runner.js').TestResult): void {
      send({
        type: 'test-end',
        workerId,
        result: serializeTestResult(result, workerId),
      });
    },
  };

  const suiteResult = await runFileWithRecovery(
    filePath,
    screenshotDir,
    reporterProxy,
    projectUseOptions,
    projectName,
    projectGrep,
    projectGrepInvert,
  );

  const results = collectResults(suiteResult);

  send({
    type: 'file-done',
    workerId,
    filePath,
    suite: serializeSuiteResult(suiteResult, workerId),
    results: results.map((r) => serializeTestResult(r, workerId)),
  });
}

/**
 * Per-test readiness check across the whole group. A recovery on any device
 * relaunched its app, destroying beforeAll-established state — surface it as
 * the infra-shaped error that makes the file retry with beforeAll re-run.
 */
async function ensureGroupReady(fullName: string): Promise<void> {
  const recoveries: string[] = [];
  await Promise.all(sessions.map((s) => ensureSessionReady(
    s.context,
    `before test ${fullName}`,
    undefined,
    {
      onRecovery: (err) => {
        const reason = err instanceof Error ? err.message : String(err);
        recoveries.push(sessions.length > 1 ? `${s.name}: ${reason}` : reason);
      },
    },
  )));
  if (recoveries.length > 0) {
    throw new Error(
      `session recovered during before test ${fullName}; retrying file so beforeAll hooks run against the recovered app: ${recoveries.join('; ')}`,
    );
  }
}

async function runFileWithRecovery(
  filePath: string,
  screenshotDir: string | undefined,
  reporterProxy: TapsmithReporter,
  projectUseOptions?: import('./worker-protocol.js').RunFileUseOptions,
  projectName?: string,
  projectGrep?: import('./worker-protocol.js').SerializedRegExp[],
  projectGrepInvert?: import('./worker-protocol.js').SerializedRegExp[],
): Promise<import('./runner.js').SuiteResult> {
  if (!config || sessions.length === 0) {
    throw new Error(`Worker ${workerId}: Not initialized`);
  }

  // Root grep (from SerializedConfig) and project-level grep are passed
  // separately so the runner can apply them with the correct semantics:
  // root AND project must each be satisfied (intersection for grep, union
  // for grepInvert).
  const projectGrepRe = deserializeRegExpArray(projectGrep);
  const projectGrepInvertRe = deserializeRegExpArray(projectGrepInvert);

  let firstAttemptSuite: import('./runner.js').SuiteResult | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let infraError: Error | undefined;
    try {
      const suite = await runTestFile(filePath, {
        config,
        devices: runDevices(projectUseOptions),
        screenshotDir,
        reporter: reporterProxy,
        beforeEachTest: ensureGroupReady,
        abortFileOnError: isRecoverableInfrastructureError,
        // `auto` resolves from the primary's probe; every member runs the
        // same app build, so its hooks are the group's hooks.
        resetCapabilities: sessions[0].capabilities,
        runMode: 'test-parallel',
        // On retry (attempt 2), bust the ESM import cache so the file's
        // test registrations re-execute. Without this, import() returns the
        // cached module and no tests are registered for the retry.
        bustImportCache: attempt > 1,
        projectUseOptions,
        projectName,
        grep: rootGrep,
        grepInvert: rootGrepInvert,
        projectGrep: projectGrepRe,
        projectGrepInvert: projectGrepInvertRe,
      });
      const infrastructureFailure = findRecoverableInfrastructureFailure(collectResults(suite));
      if (!infrastructureFailure) {
        // Tests that failed on the discarded first attempt must surface as
        // flaky, not as clean passes (see markFileRetryFlakes).
        if (attempt === 2 && firstAttemptSuite) {
          markFileRetryFlakes(firstAttemptSuite, suite);
        }
        return suite;
      }
      if (attempt === 2) {
        throw infrastructureFailure;
      }
      infraError = infrastructureFailure;
      firstAttemptSuite = suite;
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) {
        throw err;
      }
      infraError = err instanceof Error ? err : new Error(String(err));
    }

    send({ type: 'file-retry', workerId, filePath });
    process.stderr.write(
      `Retrying ${path.basename(filePath)} after infrastructure error (attempt 2 of 2)\n`,
    );
    await recoverFileSession(filePath, infraError!);
  }

  throw new Error(`Worker ${workerId}: exhausted recovery attempts for ${path.basename(filePath)}`);
}

let shuttingDown = false;
function handleShutdown(): void {
  // Exit is now deferred behind the telemetry flush, so a second `shutdown`
  // (or any queued message) could re-enter and tear the same sessions down
  // twice. Guard it (PILOT-330 review).
  if (shuttingDown) return;
  shuttingDown = true;
  for (const s of sessions) closeDeviceSession(s);
  // Bounded wait for the last file's telemetry event (PILOT-330).
  void telemetry.flush().finally(() => process.exit(0));
}

function findRecoverableInfrastructureFailure(
  results: Array<import('./runner.js').TestResult>,
): Error | undefined {
  for (const result of results) {
    if (result.status !== 'failed' || !result.error) continue;
    if (!isRecoverableInfrastructureError(result.error)) continue;
    return new Error(`${result.fullName}: ${result.error.message}`);
  }

  return undefined;
}

async function recoverFileSession(filePath: string, err: unknown): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `Worker ${workerId}: Recovering session after infrastructure error in ${path.basename(filePath)}: ${errMsg}\n`,
  );
  // Every device of the group: the failure may have come from any of them,
  // and the retried file's beforeAll expects the whole group fresh.
  await recoverDeviceSessions(sessions, `recovery for ${path.basename(filePath)}`);
}

// ─── IPC message handler ───

process.on('message', async (msg: MainToWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'run-file':
        await handleRunFile(
          msg.filePath,
          msg.projectUseOptions,
          msg.projectName,
          msg.projectGrep,
          msg.projectGrepInvert,
        );
        break;
      case 'shutdown':
        handleShutdown();
        break;
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`Worker ${workerId} error: ${error.message}\n`);
    send({
      type: 'error',
      workerId,
      error: { message: error.message, stack: error.stack },
    });
  }
});
