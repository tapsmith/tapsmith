import { STOPPED_BY_USER } from '../abort.js';

export interface TestRunResult {
  status: 'passed' | 'failed' | 'stopped'
  passed: number
  failed: number
  skipped: number
  /** Tests killed mid-flight by a user stop (not counted in `failed`). */
  interrupted?: number
  duration: number
  failures?: TestFailureDetail[]
}

export interface TestFailureDetail {
  fullName: string
  filePath: string
  error: string
  tracePath?: string
  projectName?: string
}

/**
 * The status an MCP client should see for a test, given what the runner said.
 *
 * A test the user's stop cut short arrives as a failure carrying
 * {@link STOPPED_BY_USER}, because that is how the runner ends it. Passing that
 * on made `list_results` render the user's own stop as a red `[FAIL]` while the
 * summary for that very run called it interrupted — the two halves of one
 * answer disagreeing. Applied where each transport hands entries to the MCP
 * tools, so the tree the UI renders keeps the runner's own vocabulary.
 */
export function classifyEntryStatus(entry: TestResultEntry): TestResultEntry {
  return isInterruptedEntry(entry) ? { ...entry, status: 'interrupted' } : entry;
}

/** True for an entry the user's stop ended, which is not a failure. */
export function isInterruptedEntry(entry: { status: string; error?: string }): boolean {
  return entry.status === 'interrupted'
    || (entry.status === 'failed' && entry.error === STOPPED_BY_USER);
}

export interface TestResultEntry {
  fullName: string
  filePath: string
  status: 'passed' | 'failed' | 'skipped' | 'idle' | 'running' | 'interrupted'
  duration?: number
  error?: string
  tracePath?: string
  videoPath?: string
  projectName?: string
  /**
   * True for the synthetic entry standing in for a whole file that could not
   * run. It has no counterpart in the test tree, so consumers that join on the
   * tree have to handle it specially — and it must be dropped as soon as the
   * file runs for real, or a fixed file keeps reporting the old failure.
   */
  fileLevelFailure?: boolean
}

/** A test file that could not be loaded, so it holds no entry in the test tree. */
export interface DiscoveryError {
  filePath: string
  error: string
}

export interface TestTreeEntry {
  type: 'project' | 'file' | 'suite' | 'test'
  name: string
  fullName: string
  filePath: string
  status: string
  children?: TestTreeEntry[]
  /** Declared isolation options (appReset / appResetScope / appState) when any are set. */
  use?: { appReset?: string; appResetScope?: string; appState?: string }
  /** Project nodes only: member names of a `use.devices` project, in group order. */
  devices?: string[]
}

export interface ProjectInfo {
  name: string
  platform?: string
  package?: string
  testFiles: string[]
  dependencies: string[]
  /** Member names of a `use.devices` project, in group order; absent for a single device. */
  devices?: string[]
}

/** A platform's device, or why it has none. */
export interface DeviceTarget {
  platform?: string
  device?: string
  error?: string
  /** Group entry name (`alice`) when this device belongs to a `use.devices` project. */
  name?: string
  /** The `use.devices` project this device is a member of. */
  group?: string
}

export interface SessionInfo {
  platform?: string
  package?: string
  device?: string
  timeout: number
  retries: number
  projects: ProjectInfo[]
  /**
   * The device each platform runs on. A multi-platform session has one per
   * platform, and an entry carries `error` instead of `device` when that
   * platform could not be provisioned.
   */
  deviceTargets?: DeviceTarget[]
  /** Config file backing the session. Absent when none was found. */
  configPath?: string
  /** Why the session has no config file, and what it means for the caller. */
  configWarning?: string
  /**
   * Set when a config file exists but could not be loaded. The session then
   * has no config, no projects and no device targets: device tools report
   * this instead of reaching a daemon nothing prepared.
   */
  configError?: string
}

export interface TestDispatcher {
  ensureInitialized?(): Promise<void>
  /**
   * Settle only what a device tool needs — config, projects, and a device per
   * platform — skipping the test-tree discovery `ensureInitialized` also waits
   * for. Optional: a dispatcher that is ready by the time it is handed over
   * (UI mode's) need not implement it.
   */
  ensureDevicesReady?(opts?: {
    /**
     * Also try a platform whose target found no device again (once, now). For
     * device tools: without it only a run ever retried, so a device booted
     * after a failed tool call stayed unusable to every later tool.
     */
    retryFailedTargets?: boolean
    /** The project the tool names, if any: its target is the one worth retrying. */
    project?: string
  }): Promise<void>
  runFiles(files: string[], options?: { testFilter?: string; project?: string }): Promise<TestRunResult>
  /**
   * Why `run_tests` cannot run `files` on `device` (a serial or a group
   * member's name), or `null` when it can. Asked before the run so a `device`
   * the dispatcher cannot honour is refused rather than ignored — ignoring it
   * ran the tests on another session's device (PILOT-342). The headless
   * dispatcher may pin an unresolved target to `device` while answering.
   * Required, like `resolveDeviceName`.
   */
  deviceChoiceError(files: string[], device: string, project?: string): Promise<string | null>
  runAll(): Promise<TestRunResult>
  stop(): void
  /**
   * Resolves with the run's final result once it actually ends (or
   * immediately with the last run's result when no run is in progress);
   * resolves with `null` if the run is still terminating after `timeoutMs`.
   */
  waitForRunEnd?(timeoutMs: number): Promise<TestRunResult | null>
  isRunning(): boolean
  getResults(): TestResultEntry[]
  getTestFiles(): string[]
  getProjects(): string[]
  getTestTree(): TestTreeEntry[]
  /**
   * Files that failed to load during discovery. They are absent from the test
   * tree, so a caller that only reads the tree sees a silently short list.
   */
  getDiscoveryErrors?(): DiscoveryError[]
  /**
   * The discovered test files a caller's `files` argument maps onto —
   * absolute paths, project-relative paths and globs alike. Empty means
   * nothing matched, which is a different answer from "ran and found nothing".
   */
  resolveRequestedFiles?(files: string[]): string[]
  getSessionInfo(): SessionInfo
  /**
   * The serial behind a `use.devices` group name (`alice`), so device tools
   * can take the name a test author uses instead of a serial; `undefined`
   * when no device goes by that name. Required — an optional method let the
   * UI-mode dispatcher omit it, and group names silently stopped resolving
   * over UI-mode MCP while the unit tests (mocking it) stayed green.
   *
   * Names are unique within a group, not across a session: two group
   * projects (an Android and an iOS one, say) routinely both call their
   * members `alice` and `bob`. With `project` the name is resolved within
   * that project's group only; without it, a name that resolves to more than
   * one device throws rather than picking whichever group came first.
   */
  resolveDeviceName(name: string, project?: string): string | undefined

  toggleWatch(filePath: string, options?: { testFilter?: string; project?: string }): { enabled: boolean }
}

/** One UI worker as `uiDeviceChoiceError` sees it: its device target and its devices. */
export interface UiWorkerDevices {
  /** Bucket signature in a multi-target session; `undefined` otherwise. */
  bucket: string | undefined
  /** The worker's devices, primary first. */
  devices: string[]
}

/**
 * UI mode's answer to {@link TestDispatcher.deviceChoiceError}. A UI session
 * hands each run to a free worker of the files' own device target, so
 * `device` can only be honoured when exactly one worker could take the run
 * and `device` is on it. The tool used to document `device` as "ignored in UI
 * mode" and ignore it — a caller naming a device got its tests run on another
 * one without a word.
 *
 * @internal — exported for unit testing.
 */
export function uiDeviceChoiceError(opts: {
  /** What the caller passed. */
  device: string
  /** `device` resolved from a group member name to its serial (else `device`). */
  serial: string
  /** Every worker of the session (the planned ones, before they spawn). */
  workers: UiWorkerDevices[]
  /** The device targets the requested files run on; `undefined` for a file with none. */
  fileBuckets: ReadonlySet<string | undefined>
}): string | null {
  const { device, serial, workers, fileBuckets } = opts;
  const sessionDevices = [...new Set(workers.flatMap((w) => w.devices))];
  if (!sessionDevices.includes(serial)) {
    return `${device} is not a device this UI session drives `
      + `(${sessionDevices.length > 0 ? sessionDevices.join(', ') : 'none yet'}). UI mode runs tests only on its own workers: `
      + 'omit `device` (use `project` to pick a platform), or start the UI session with `--device` on the device you want.';
  }
  // Only the files' own target's workers can take the run.
  const anyWorker = fileBuckets.size === 0 || fileBuckets.has(undefined);
  const eligible = workers.filter((w) => anyWorker || w.bucket === undefined || fileBuckets.has(w.bucket));
  if (eligible.length > 1) {
    return `UI mode hands each run to whichever of its ${eligible.length} workers is free, so \`device\` cannot pin this run to ${device}. `
      + 'Omit `device` (use `project` to pick a platform), or start the UI session with `--device` to use only that device.';
  }
  const theirs = eligible[0]?.devices ?? [];
  if (!theirs.includes(serial)) {
    return `In this UI session these files run on ${theirs.join(' + ') || 'no worker'}, not ${device}: `
      + 'each device target has its own worker. Omit `device`, or pass `project` for the target you mean.';
  }
  return null;
}
