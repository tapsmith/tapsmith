/**
 * IPC message protocol between the main process (dispatcher) and worker
 * child processes. Each worker is assigned a device and runs test files
 * sent to it by the dispatcher.
 *
 * @see PILOT-106
 */

import type { TestResult, SuiteResult } from './runner.js';
import { normalizeGrep, type AppResetMode, type AppResetScope, type TapsmithConfig } from './config.js';

// ─── Main → Worker messages ───

export interface InitMessage {
  type: 'init'
  workerId: number
  /** The group's primary device (`devices[0]`). */
  deviceSerial: string
  /**
   * The primary's group entry name (`alice`; `device-1` without `use.devices`).
   * The embedder resolves the group from the *project's* config — `use.devices`
   * is project-level, so the root config the worker is handed never declares
   * one — and the child takes the names as given rather than re-deriving them.
   */
  deviceName: string
  daemonPort: number
  config: SerializedConfig
  /** True when the emulator was freshly launched for this run (needs warmup). */
  freshEmulator?: boolean
  /**
   * The rest of the device group (`devices[1..]`), each on its own daemon.
   * Present only for group projects (`use.devices`); a single-device worker
   * omits it.
   */
  groupMembers?: WorkerGroupMember[]
}

/**
 * One secondary device of a worker's group, with the daemon that drives it.
 * Shared by every child protocol (headless workers, UI workers, watch/MCP run
 * children) so a group is described the same way everywhere.
 */
export interface WorkerGroupMember {
  /** Group entry name from `use.devices` (e.g. `bob`). */
  name: string
  deviceSerial: string
  daemonPort: number
  /** Freshly provisioned for this run (needs reinstall + warmup). */
  freshEmulator?: boolean
  /**
   * The daemon already holds this device with the agent running and the app
   * launched (the CLI's sequential setup opened it): attach instead of
   * provisioning. UI workers adopting the CLI's primary adopt its group too.
   */
  adopt?: boolean
}

export interface RunFileMessage {
  type: 'run-file'
  filePath: string
  /** Project-level use options to apply as base layer. */
  projectUseOptions?: RunFileUseOptions
  /** Project name for reporter grouping. */
  projectName?: string
  /**
   * Per-project grep filters, intersected with the root `grep` from the worker's
   * `SerializedConfig`. A test must match at least one entry in each set.
   */
  projectGrep?: SerializedRegExp[]
  /**
   * Per-project grep-invert filters, unioned with the root `grepInvert` from
   * the worker's `SerializedConfig`.
   */
  projectGrepInvert?: SerializedRegExp[]
}

/** IPC-safe subset of UseOptions for project-level overrides. */
export interface RunFileUseOptions {
  timeout?: number
  screenshot?: 'always' | 'only-on-failure' | 'never'
  retries?: number
  trace?: 'off' | 'on' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure' | 'retain-on-first-failure' | 'retain-on-failure-and-retries'
  video?: 'off' | 'on' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure' | 'retain-on-first-failure' | 'retain-on-failure-and-retries'
  appState?: string
  appReset?: AppResetMode
  appResetScope?: AppResetScope
  appResetColdEvery?: number
  baseURL?: string
  extraHTTPHeaders?: Record<string, string>
  /**
   * The project's device group (`use.devices`), verbatim. The runner checks
   * it against the devices it was actually handed, so an embedder that
   * provisioned the wrong number fails loudly instead of running tests whose
   * `devices` fixture is missing the members they destructure.
   */
  devices?: TapsmithConfig['devices']
}

export interface ShutdownMessage {
  type: 'shutdown'
}

export type MainToWorkerMessage = InitMessage | RunFileMessage | ShutdownMessage

// ─── Worker → Main messages ───

export interface ReadyMessage {
  type: 'ready'
  workerId: number
}

export interface WorkerProgressMessage {
  type: 'progress'
  workerId: number
  message: string
}

export interface TestStartMessage {
  type: 'test-start'
  workerId: number
  fullName: string
  filePath: string
  projectName?: string
}

export interface TestEndMessage {
  type: 'test-end'
  workerId: number
  result: SerializedTestResult
}

export interface FileStartMessage {
  type: 'file-start'
  workerId: number
  filePath: string
}

export interface FileDoneMessage {
  type: 'file-done'
  workerId: number
  filePath: string
  suite: SerializedSuiteResult
  results: SerializedTestResult[]
}

export interface FileRetryMessage {
  type: 'file-retry'
  workerId: number
  filePath: string
}

export interface WorkerErrorMessage {
  type: 'error'
  workerId: number
  error: { message: string; stack?: string }
}

export type WorkerToMainMessage =
  | ReadyMessage
  | WorkerProgressMessage
  | TestStartMessage
  | TestEndMessage
  | FileStartMessage
  | FileDoneMessage
  | FileRetryMessage
  | WorkerErrorMessage

// ─── Infrastructure error detection ───

/**
 * Error message patterns that indicate recoverable infrastructure failures.
 * When a test fails with one of these patterns, the worker will attempt to
 * recover the session and retry the file rather than permanently failing.
 */
export const RECOVERABLE_INFRASTRUCTURE_PATTERNS = [
  'Agent command timed out',
  'Agent returned empty response',
  'Agent connection dropped',
  // TCP-reset variant of a dropped connection ("Agent connection lost during
  // read" / "... and agent is unreachable", agent_comms.rs). Without it, a
  // reset-shaped transient drop bypasses every recovery layer (PILOT-282).
  'Agent connection lost',
  'Not connected to agent',
  'Timed out connecting to agent socket',
  'Failed to connect to agent socket',
  'Failed to reconnect to agent',
  'Agent socket not reachable',
  'Unable to lookup in current state',
  'server died',
  'xcodebuild exited with',
  '4 DEADLINE_EXCEEDED',
  '14 UNAVAILABLE',
  'No connection established',
  'ECONNREFUSED',
  'session recovered during before test',
  'Network capture disabled',
] as const;

/**
 * Check whether an error represents a recoverable infrastructure failure
 * (agent disconnection, gRPC unavailability, etc.) as opposed to a real
 * test assertion failure.
 */
export function isRecoverableInfrastructureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (DETERMINISTIC_CAPTURE_REFUSALS.some((pattern) => message.includes(pattern))) return false;
  return RECOVERABLE_INFRASTRUCTURE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * "Network capture disabled" is recoverable in general — a session restart can
 * bring back a capture that failed transiently. These daemon refusals (the iOS
 * system-proxy fallback's policy, PILOT-319) are not: a restarted session gets
 * the same answer until the cause changes, so recovering only restarts the app,
 * fails the retry, and can retire a healthy worker. Substrings of the daemon's
 * messages in `grpc_server.rs` / `ios/system_proxy.rs`.
 */
const DETERMINISTIC_CAPTURE_REFUSALS = [
  // Not on CI and not opted in (FallbackDecision::RefuseLocal).
  'so it is only used on CI',
  // Another live daemon owns the host proxy (Conflict::OtherDaemon).
  'already routes the macOS system proxy',
  // A proxy the user configured (Conflict::ForeignProxy).
  'Tapsmith will not overwrite it',
] as const;

// Generous budget: a session-setup failure fails the whole shard (there is
// no outer retry around setup), and each failed attempt can itself take
// ~35s when the daemon's bounded `simctl list` is riding out a
// CoreSimulator stall — so the budget must fit several such attempts.
export const DEVICE_SELECT_RETRY_BUDGET_MS = 180_000;
export const DEVICE_SELECT_RETRY_DELAY_MS = 3_000;

/**
 * Device-selection failures worth retrying within a bounded window.
 *
 * "not found. Run ListDevices" deserves special mention: SetDevice is only
 * ever called with a serial the caller just resolved (and, for simulators,
 * verified Booted) through simctl itself — so the daemon answering "not
 * found" means its device refresh came back incomplete, i.e. the bounded
 * `simctl list` timed out under a CoreSimulator stall. That's a transient
 * listing failure, not a wrong serial; the next refresh sees the device.
 */
export function isRetryableDeviceSelectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('not found. Run ListDevices') ||
    isRecoverableInfrastructureError(err)
  );
}

/**
 * Run device selection, retrying transient failures (see
 * `isRetryableDeviceSelectionError`) with a short pause until the budget is
 * spent. `onRetry` fires before each re-attempt so callers can report
 * progress their own way.
 */
export async function retryDeviceSelection<T>(
  fn: () => Promise<T>,
  onRetry: (err: unknown) => void,
): Promise<T> {
  const deadline = Date.now() + DEVICE_SELECT_RETRY_BUDGET_MS;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableDeviceSelectionError(err) || Date.now() >= deadline) throw err;
      onRetry(err);
      await new Promise((resolve) => setTimeout(resolve, DEVICE_SELECT_RETRY_DELAY_MS));
    }
  }
}

/**
 * Agent startup failures worth one in-place retry: the daemon's own launch
 * failure text, plus transport-level errors (deadline exceeded, dropped
 * connection) that mean the startAgent call itself died mid-flight — a cold
 * first xcodebuild often warms DerivedData/simulator for the second attempt.
 */
export function isRetryableAgentStartError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('xcodebuild exited') ||
    message.includes('Timed out waiting for iOS agent') ||
    // The daemon's post-launch handshake ping can miss a runner that is
    // still initializing (the launch-time socket probe passed moments
    // earlier) — a second StartAgent either fast-paths onto the now-ready
    // agent or relaunches it.
    message.includes('Agent is not responding') ||
    isRecoverableInfrastructureError(err)
  );
}

/** Pause before retrying a failed agent start. A transient agent-connection
 *  drop takes a few seconds to clear; an immediate retry lands inside the
 *  same drop window and fails identically (PILOT-282). Shared by the CLI
 *  startup path and worker init so both retry with the same tolerance. */
export const AGENT_START_RETRY_DELAY_MS = 2_000;

// ─── Serialized types (safe for IPC / structured clone) ───

/** Config fields needed by workers (subset of TapsmithConfig). */
export interface SerializedConfig {
  timeout: number
  retries: number
  screenshot: 'always' | 'only-on-failure' | 'never'
  rootDir: string
  outputDir: string
  apk?: string
  activity?: string
  package?: string
  agentApk?: string
  agentTestApk?: string
  trace?: string | Record<string, unknown>
  video?: string | Record<string, unknown>
  platform?: 'android' | 'ios'
  app?: string
  iosXctestrun?: string
  simulator?: string
  resetAppDeepLink?: string
  resetAppWaitMs?: number
  appReset?: AppResetMode
  appResetScope?: AppResetScope
  appResetColdEvery?: number
  baseURL?: string
  extraHTTPHeaders?: Record<string, string>
  /** Device group declaration (`use.devices`), verbatim — plain data already. */
  devices?: TapsmithConfig['devices']
  /** RegExp filters for test fullNames. Source/flags are serialized for IPC. */
  grep?: SerializedRegExp[]
  grepInvert?: SerializedRegExp[]
  /** Opt-out flag — children report their own runs, so they must see it. */
  telemetry?: boolean
}

/** Convert a TapsmithConfig into the IPC-safe subset needed by worker child processes. */
export function serializeConfig(config: TapsmithConfig): SerializedConfig {
  return {
    timeout: config.timeout,
    retries: config.retries,
    screenshot: config.screenshot,
    rootDir: config.rootDir,
    outputDir: config.outputDir,
    apk: config.apk,
    activity: config.activity,
    package: config.package,
    agentApk: config.agentApk,
    agentTestApk: config.agentTestApk,
    trace: typeof config.trace === 'string' || typeof config.trace === 'object'
      ? config.trace
      : undefined,
    video: typeof config.video === 'string' || typeof config.video === 'object'
      ? config.video
      : undefined,
    platform: config.platform,
    app: config.app,
    iosXctestrun: config.iosXctestrun,
    simulator: config.simulator,
    resetAppDeepLink: config.resetAppDeepLink,
    resetAppWaitMs: config.resetAppWaitMs,
    appReset: config.appReset,
    appResetScope: config.appResetScope,
    appResetColdEvery: config.appResetColdEvery,
    baseURL: config.baseURL,
    extraHTTPHeaders: config.extraHTTPHeaders,
    devices: config.devices,
    grep: serializeRegExpArray(normalizeGrep(config.grep)),
    grepInvert: serializeRegExpArray(normalizeGrep(config.grepInvert)),
    telemetry: config.telemetry,
  };
}

/**
 * Rebuild a worker-side TapsmithConfig from the IPC-safe subset. The single
 * inverse of {@link serializeConfig} — every child process (headless workers,
 * UI workers, watch/MCP run children) uses this so a new config key only has
 * to be threaded through in one place.
 */
export function configFromSerialized(s: SerializedConfig, daemonAddress: string): TapsmithConfig {
  return {
    timeout: s.timeout,
    retries: s.retries,
    screenshot: s.screenshot,
    testMatch: [],
    daemonAddress,
    rootDir: s.rootDir,
    outputDir: s.outputDir,
    apk: s.apk,
    activity: s.activity,
    package: s.package,
    agentApk: s.agentApk,
    agentTestApk: s.agentTestApk,
    workers: 1,
    launchEmulators: false,
    trace: s.trace as TapsmithConfig['trace'],
    video: s.video as TapsmithConfig['video'],
    platform: s.platform,
    app: s.app,
    iosXctestrun: s.iosXctestrun,
    simulator: s.simulator,
    resetAppDeepLink: s.resetAppDeepLink,
    resetAppWaitMs: s.resetAppWaitMs,
    appReset: s.appReset,
    appResetScope: s.appResetScope,
    appResetColdEvery: s.appResetColdEvery,
    baseURL: s.baseURL,
    extraHTTPHeaders: s.extraHTTPHeaders,
    devices: s.devices,
    grep: deserializeRegExpArray(s.grep),
    grepInvert: deserializeRegExpArray(s.grepInvert),
    telemetry: s.telemetry,
  };
}

/** IPC-safe RegExp representation (RegExp instances don't survive structured clone reliably). */
export interface SerializedRegExp {
  source: string
  flags: string
}

export function serializeRegExp(re: RegExp): SerializedRegExp {
  return { source: re.source, flags: re.flags };
}

export function serializeRegExpArray(values: RegExp[] | undefined): SerializedRegExp[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map(serializeRegExp);
}

export function deserializeRegExpArray(values: SerializedRegExp[] | undefined): RegExp[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((v) => new RegExp(v.source, v.flags));
}

/** TestResult with Error serialized to plain object for IPC. */
export interface SerializedTestResult {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  error?: { message: string; stack?: string }
  firstAttemptError?: { message: string; stack?: string }
  failedAttemptArtifacts?: { screenshot?: boolean; trace?: boolean; video?: boolean }
  screenshotPath?: string
  tracePath?: string
  videoPath?: string
  workerIndex: number
  project?: string
  retry?: number
  _willRetry?: boolean
  filePath?: string
}

export interface SerializedSuiteResult {
  name: string
  tests: SerializedTestResult[]
  suites: SerializedSuiteResult[]
  durationMs: number
}

// ─── Serialization helpers ───

export function serializeTestResult(result: TestResult, workerIndex: number): SerializedTestResult {
  return {
    name: result.name,
    fullName: result.fullName,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error
      ? { message: result.error.message, stack: result.error.stack }
      : undefined,
    firstAttemptError: result.firstAttemptError
      ? { message: result.firstAttemptError.message, stack: result.firstAttemptError.stack }
      : undefined,
    failedAttemptArtifacts: result.failedAttemptArtifacts,
    screenshotPath: result.screenshotPath,
    tracePath: result.tracePath,
    videoPath: result.videoPath,
    workerIndex,
    project: result.project,
    retry: result.retry,
    _willRetry: result._willRetry,
    filePath: result.filePath,
  };
}

export function serializeSuiteResult(suite: SuiteResult, workerIndex: number): SerializedSuiteResult {
  return {
    name: suite.name,
    tests: suite.tests.map((t) => serializeTestResult(t, workerIndex)),
    suites: suite.suites.map((s) => serializeSuiteResult(s, workerIndex)),
    durationMs: suite.durationMs,
  };
}

export function deserializeTestResult(s: SerializedTestResult): TestResult & { workerIndex: number } {
  return {
    name: s.name,
    fullName: s.fullName,
    status: s.status,
    durationMs: s.durationMs,
    error: s.error
      ? Object.assign(new Error(s.error.message), { stack: s.error.stack })
      : undefined,
    firstAttemptError: s.firstAttemptError
      ? Object.assign(new Error(s.firstAttemptError.message), { stack: s.firstAttemptError.stack })
      : undefined,
    failedAttemptArtifacts: s.failedAttemptArtifacts,
    screenshotPath: s.screenshotPath,
    tracePath: s.tracePath,
    videoPath: s.videoPath,
    workerIndex: s.workerIndex,
    project: s.project,
    retry: s.retry,
    _willRetry: s._willRetry,
    filePath: s.filePath,
  };
}

export function deserializeSuiteResult(s: SerializedSuiteResult): SuiteResult {
  return {
    name: s.name,
    tests: s.tests.map(deserializeTestResult),
    suites: s.suites.map(deserializeSuiteResult),
    durationMs: s.durationMs,
  };
}
