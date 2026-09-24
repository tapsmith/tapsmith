import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { resolveChildLoader } from '../child-scripts.js';
import { STOPPED_BY_USER } from '../abort.js';
import type { WatchRunAbortMessage } from '../watch-run.js';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { minimatch } from 'minimatch';
import { platformOfSerial, resolveProjects, scopeDevicePinToPlatform, topologicalSort, type ResolvedProject } from '../project.js';
import { discoverTestFiles } from '../test-file-discovery.js';
import {
  deserializeTestResult,
  deserializeSuiteResult,
  serializeConfig,
  type SerializedConfig,
  type RunFileUseOptions,
} from '../worker-protocol.js';
import type { WatchRunMessage, WatchRunChildMessage } from '../watch-run.js';
import { RunQueue } from '../watch-queue.js';
import { telemetry } from '../telemetry.js';
import { ensurePlatformTarget, platformTargetIsLive, type PlatformTarget } from './connection.js';
import { deviceGroupNames, deviceGroupSize, pinnedDeviceSerials, primaryDevicePin, resolveDeviceGroup, type TapsmithConfig } from '../config.js';
import { deviceGroupSignature, deviceSignature } from '../project.js';
import { matchesTestFilter } from '../test-filter.js';
import type {
  TestDispatcher,
  TestRunResult,
  TestResultEntry,
  TestTreeEntry,
  SessionInfo,
  TestFailureDetail,
  DiscoveryError,
  DeviceTarget,
} from './test-dispatcher.js';
import { classifyEntryStatus, isInterruptedEntry } from './test-dispatcher.js';
import { loadMcpConfig } from './config-loader.js';
import { pickResolvedDeviceName } from './tools/device-target.js';

import type { TestTreeNode, UIDiscoverMessage, UIDiscoverChildMessage } from '../ui-mode/ui-protocol.js';

/** Key for a session with no platform of its own (single-platform configs). */
const DEFAULT_PLATFORM_KEY = 'default';

function platformKey(platform?: string): string {
  return platform ?? DEFAULT_PLATFORM_KEY;
}

/**
 * The target key for a project's effective config. One target per platform —
 * except `use.devices` projects, which need their own group of daemons and
 * therefore their own target, keyed by the group's device signature.
 */
function targetKeyFor(config: TapsmithConfig): string {
  const key = platformKey(config.platform);
  return deviceGroupSize(config) > 1 ? `${key}|${deviceSignature(config)}|${deviceGroupSignature(config)}` : key;
}

/**
 * Which platform's device a run belongs on.
 *
 * A project's own platform wins: in a multi-platform config the root has none,
 * which is exactly the case that used to leave every run pointing at whichever
 * device the session picked first.
 *
 * @internal — exported for unit testing.
 */
export function platformKeyForProject(
  projects: Array<{ name: string; effectiveConfig: { platform?: string; devices?: TapsmithConfig['devices'] } }>,
  projectName: string | undefined,
  rootPlatform: string | undefined,
): string {
  const project = projectName ? projects.find((p) => p.name === projectName) : undefined;
  if (project && deviceGroupSize(project.effectiveConfig) > 1) {
    return targetKeyFor(project.effectiveConfig as TapsmithConfig);
  }
  return platformKey(project?.effectiveConfig.platform ?? rootPlatform);
}

const DISCOVERY_CONCURRENCY = 4;
/** The least time between two device-tool retries of failed targets. */
const TARGET_RETRY_INTERVAL_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const RUN_CHILD_TIMEOUT_MS = 60 * 60 * 1000;

// ─── HeadlessTestDispatcher ───

/** Per-test counts one file contributes to a run's summary. */
interface RunTally {
  passed: number
  failed: number
  skipped: number
  interrupted: number
}

/** Grace period between the cooperative abort and the signal that follows it. */
const STOP_GRACE_MS = 5_000;

export class HeadlessTestDispatcher implements TestDispatcher {
  private readonly _configFile?: string;
  private _config: import('../config.js').TapsmithConfig | null = null;
  private _projects: ResolvedProject[] = [];
  private _projectWaves: ResolvedProject[][] = [];
  private _testFiles: string[] = [];
  private _testTree: TestTreeEntry[] = [];
  private _testResults = new Map<string, TestResultEntry>();
  private _isRunning = false;
  private _stopRequested = false;
  private _lastRunEnd: TestRunResult | null = null;
  private readonly _runEndWaiters: Array<(r: TestRunResult) => void> = [];
  private _activeChild: ChildProcess | null = null;
  /**
   * Sticky reset capabilities per device serial. Runs go through fresh
   * watch-run children, so without this store every `tapsmith_run_tests`
   * started undetected and `appReset: 'auto'` resolved to clear · file even
   * when the app supports warm in-app resets. Detection only ever upgrades
   * (compiled-in hooks do not vanish mid-session).
   */
  private readonly _resetCapabilities = new Map<string, import('../app-reset.js').ResetCapabilities>();
  /** Escalation from the cooperative abort to a signal (see `stop`). */
  private _stopEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _deviceSerial: string | null = null;
  private _serializedConfig: SerializedConfig | null = null;
  private _watcher: FSWatcher | null = null;
  private _watchedEntries = new Map<string, WatchedEntry[]>();
  private _watchQueue: RunQueue;
  private _scripts: ResolvedScripts | null = null;
  private _discoveryErrors = new Map<string, string>();
  private _devicesReady = false;
  private _devicesPromise: Promise<void> | null = null;
  /** Config, projects and test files loaded — see `_ensureSession`. */
  private _sessionReady = false;
  private _sessionPromise: Promise<void> | null = null;
  private _configPath: string | null = null;
  private _configWarning: string | null = null;
  private _configError: string | null = null;
  /** Daemon + device per platform, keyed by platform (or DEFAULT_PLATFORM_KEY). */
  private _targets = new Map<string, PlatformTarget>();
  /** Why a platform has no target, kept so a run for it can say so. */
  private _targetErrors = new Map<string, string>();
  /**
   * Platforms already retried during the current run request, so a stuck one is
   * not retried per file. Cleared when a new request arrives — see
   * {@link _startRunRequest}.
   */
  private _retriedTargets = new Set<string>();
  /** Per-project serialized configs handed to workers, built on first use. */
  private _projectConfigs = new Map<string, SerializedConfig>();
  /**
   * The device a `run_tests` call pinned each target to (PILOT-342). Kept for
   * the session's life, so a target resolved again (its daemon died, it had
   * no device) comes back on the same device.
   */
  private readonly _devicePins = new Map<string, string>();
  /** A `run_tests` `device` to pin while the targets are first resolved. */
  private _pendingPin: { device: string; files: string[]; project?: string } | null = null;

  constructor(options?: { configFile?: string }) {
    this._configFile = options?.configFile;
    this._watchQueue = new RunQueue(300, (request) => {
      const run = request.type === 'all'
        ? this.runAll()
        : this.runFiles(request.files);
      run.catch((err) => {
        log(`Watch run error: ${err instanceof Error ? err.message : err}`);
      }).finally(() => {
        this._watchQueue.notifyRunFinished();
      });
    });
  }

  // ─── TestDispatcher interface ───

  async ensureInitialized(): Promise<void> {
    await this._ensureInitialized();
  }

  /**
   * Give every platform its retry back, once per run the caller asks for.
   *
   * The budget stops a platform with no device being re-resolved once per file,
   * which would spawn and discard a daemon each time. Spending it *once for the
   * life of the server* went too far the other way: the failure says "boot a
   * simulator and try again", and the first `run_tests` after startup burns the
   * only retry there is — so the user boots the simulator, tries again, and is
   * handed the same cached error with nothing left that would notice.
   */
  private _startRunRequest(): void {
    this._retriedTargets.clear();
  }

  async runFiles(files: string[], options?: { testFilter?: string; project?: string }): Promise<TestRunResult> {
    await this._ensureInitialized();
    if (this._isRunning) {
      return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    }
    // After the guard: a request rejected as already-running is not a new run,
    // and resetting the budget from here would hand the *in-flight* run a fresh
    // retry for every remaining file — the per-file daemon churn the budget
    // exists to prevent.
    this._startRunRequest();

    const { testFilter, project } = options ?? {};
    const validFiles = this.resolveRequestedFiles(files);
    if (validFiles.length === 0) {
      return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    }
    // Running from here, before the first await: resolving devices takes
    // seconds on a first run, and a second run arriving meanwhile must meet
    // the guard above.
    this._isRunning = true;
    this._stopRequested = false;
    this._testResults.clear();
    try {
      // Only once something will run: resolving targets picks devices.
      await this.ensureDevicesReady();
      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      let totalInterrupted = 0;
      for (const f of validFiles) {
        if (this._stopRequested) break;
        const proj = this._projectForFile(f, project);
        const useOptions = proj?.use as RunFileUseOptions | undefined;
        const projectName = this._realProjectName(proj);
        try {
          const { results, suite } = await this._runFileInChild(
            f, useOptions, projectName, testFilter,
          );
          const tally = this._tallyResults(results);
          totalPassed += tally.passed;
          totalFailed += tally.failed;
          totalSkipped += tally.skipped;
          totalInterrupted += tally.interrupted;
          totalDuration += suite.durationMs;
        } catch (err) {
          if (this._accountForFileError(f, projectName, err) === 'interrupted') {
            const salvaged = this._salvageFromStore(f, projectName);
            totalPassed += salvaged.passed;
            totalFailed += salvaged.failed;
            totalSkipped += salvaged.skipped;
            totalInterrupted += salvaged.interrupted;
            totalDuration += salvaged.duration;
            break;
          }
          totalFailed++;
        }
      }
      return this._finishRun(this._withFailures({
        status: this._stopRequested ? 'stopped' : totalFailed > 0 ? 'failed' : 'passed',
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        ...(totalInterrupted > 0 ? { interrupted: totalInterrupted } : {}),
        duration: totalDuration,
      }));
    } finally {
      this._endRunState();
    }
  }

  async runAll(): Promise<TestRunResult> {
    await this._ensureInitialized();
    await this.ensureDevicesReady();
    if (this._isRunning) {
      return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    }
    // After the guard: a request rejected as already-running is not a new run,
    // and resetting the budget from here would hand the *in-flight* run a fresh
    // retry for every remaining file — the per-file daemon churn the budget
    // exists to prevent.
    this._startRunRequest();

    this._isRunning = true;
    this._stopRequested = false;
    this._testResults.clear();
    try {
      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      let totalInterrupted = 0;

      if (this._hasRealProjects() && this._projectWaves.length > 0) {
        const failedProjects = new Set<string>();

        for (const wave of this._projectWaves) {
          if (this._stopRequested) break;
          for (const project of wave) {
            if (this._stopRequested) break;
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              failedProjects.add(project.name);
              continue;
            }

            const useOptions = project.use as RunFileUseOptions | undefined;
            const projectName = this._realProjectName(project);
            let projectFailed = false;

            for (const file of project.testFiles) {
              if (this._stopRequested) break;
              try {
                const { results, suite } = await this._runFileInChild(file, useOptions, projectName);
                const tally = this._tallyResults(results);
                totalPassed += tally.passed;
                totalFailed += tally.failed;
                totalSkipped += tally.skipped;
                totalInterrupted += tally.interrupted;
                totalDuration += suite.durationMs;
                // A stop is not a failure, so it must not block this project's
                // dependents — they were never given their chance to run.
                if (tally.failed > 0) projectFailed = true;
              } catch (err) {
                if (this._accountForFileError(file, projectName, err) === 'interrupted') {
                  const salvaged = this._salvageFromStore(file, projectName);
                  totalPassed += salvaged.passed;
                  totalFailed += salvaged.failed;
                  totalSkipped += salvaged.skipped;
                  totalInterrupted += salvaged.interrupted;
                  totalDuration += salvaged.duration;
                  if (salvaged.failed > 0) projectFailed = true;
                  break;
                }
                totalFailed++;
                projectFailed = true;
              }
            }

            if (projectFailed) failedProjects.add(project.name);
          }
        }
      } else {
        for (const file of this._testFiles) {
          if (this._stopRequested) break;
          try {
            const { results, suite } = await this._runFileInChild(file);
            const tally = this._tallyResults(results);
            totalPassed += tally.passed;
            totalFailed += tally.failed;
            totalSkipped += tally.skipped;
            totalInterrupted += tally.interrupted;
            totalDuration += suite.durationMs;
          } catch (err) {
            if (this._accountForFileError(file, undefined, err) === 'interrupted') {
              const salvaged = this._salvageFromStore(file, undefined);
              totalPassed += salvaged.passed;
              totalFailed += salvaged.failed;
              totalSkipped += salvaged.skipped;
              totalInterrupted += salvaged.interrupted;
              totalDuration += salvaged.duration;
              break;
            }
            totalFailed++;
          }
        }
      }

      return this._finishRun(this._withFailures({
        status: this._stopRequested ? 'stopped' : totalFailed > 0 ? 'failed' : 'passed',
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        ...(totalInterrupted > 0 ? { interrupted: totalInterrupted } : {}),
        duration: totalDuration,
      }));
    } finally {
      this._endRunState();
    }
  }

  /**
   * Stop the in-flight run, asking before killing.
   *
   * A SIGTERM straight away destroyed the run's own account of itself: the
   * child never sent `file-done`, so every test that had already finished was
   * absent from the summary — the tool reported "0 passed" for a run whose
   * `list_results` listed a pass. Requesting an abort lets the run end itself
   * and report what it has, which is how UI mode has always done it. The
   * signal stays as the escalation for a child that cannot answer.
   */
  stop(): void {
    if (!this._isRunning) return;
    this._stopRequested = true;
    const child = this._activeChild;
    if (!child) return;
    let asked = false;
    try {
      child.send({ type: 'abort' } satisfies WatchRunAbortMessage);
      asked = true;
    } catch { /* channel already gone — fall through to the signal */ }
    if (!asked) {
      try { child.kill(); } catch { /* already dead */ }
      return;
    }
    this._clearStopEscalation();
    this._stopEscalationTimer = setTimeout(() => {
      // The abort went unanswered. Kill it, and let the run salvage whatever
      // the child managed to stream before it stopped listening.
      try { child.kill(); } catch { /* already dead */ }
    }, STOP_GRACE_MS);
    this._stopEscalationTimer.unref?.();
  }

  private _clearStopEscalation(): void {
    if (this._stopEscalationTimer) {
      clearTimeout(this._stopEscalationTimer);
      this._stopEscalationTimer = null;
    }
  }

  /**
   * One file's contribution to a run's totals.
   *
   * A test the user's stop ended is `interrupted`, not `failed` — it is
   * subtracted back out of the failure count, since the runner reports it as a
   * failure carrying {@link STOPPED_BY_USER}. Counted per *test*, which is what
   * `passed`/`failed`/`skipped` alongside it have always meant, and what UI
   * mode reports; counting interrupted *files* here made one field in one
   * summary silently change units.
   */
  private _tallyResults(results: { status: string; error?: { message?: string } }[]): RunTally {
    const interrupted = results.filter(
      (r) => r.status === 'failed' && r.error?.message === STOPPED_BY_USER,
    ).length;
    return {
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length - interrupted,
      skipped: results.filter((r) => r.status === 'skipped').length,
      interrupted,
    };
  }

  /**
   * What a file managed to report before its child died without a `file-done`.
   *
   * Every finished test has already streamed a `test-end` into the result
   * store, so the run is not the blank the rejected promise makes it look
   * like. Reading them back is what keeps the summary and `list_results` —
   * which is this same store — telling one story.
   */
  private _salvageFromStore(filePath: string, projectName: string | undefined): RunTally & { duration: number } {
    const entries = [...this._testResults.values()].filter(
      (e) => e.filePath === filePath && e.projectName === projectName && !e.fileLevelFailure,
    );
    const interrupted = entries.filter(isInterruptedEntry).length;
    return {
      passed: entries.filter((e) => e.status === 'passed').length,
      failed: entries.filter((e) => e.status === 'failed').length - interrupted,
      skipped: entries.filter((e) => e.status === 'skipped').length,
      interrupted,
      duration: entries.reduce((sum, e) => sum + (e.duration ?? 0), 0),
    };
  }

  waitForRunEnd(timeoutMs: number): Promise<TestRunResult | null> {
    if (!this._isRunning) return Promise.resolve(this._lastRunEnd);
    return new Promise((resolve) => {
      const waiter = (r: TestRunResult): void => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        // Drop the stale waiter so repeated polls of a wedged run don't
        // accumulate closures until the run finally ends.
        const idx = this._runEndWaiters.indexOf(waiter);
        if (idx >= 0) this._runEndWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this._runEndWaiters.push(waiter);
    });
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  /** Record the final result and wake waitForRunEnd callers. */
  private _finishRun(result: TestRunResult): TestRunResult {
    this._lastRunEnd = result;
    for (const w of this._runEndWaiters.splice(0)) w(result);
    return result;
  }

  /** Run-state teardown; resolves any waiters left by an exception path.
   * Always a fresh synthetic result — falling back to _lastRunEnd would
   * report the PREVIOUS run's outcome. */
  private _endRunState(): void {
    this._isRunning = false;
    this._stopRequested = false;
    // Nothing left to escalate against, and a pending timer would outlive the
    // run to kill whatever process happens to be in `_activeChild` next.
    this._clearStopEscalation();
    if (this._runEndWaiters.length > 0) {
      const fallback: TestRunResult = { status: 'stopped', passed: 0, failed: 0, skipped: 0, duration: 0 };
      for (const w of this._runEndWaiters.splice(0)) w(fallback);
    }
  }

  getResults(): TestResultEntry[] {
    return [...this._testResults.values()].map(classifyEntryStatus);
  }

  getTestFiles(): string[] {
    return this._testFiles;
  }

  getProjects(): string[] {
    // Hide only the project synthesized for a config that declares none — a
    // config that genuinely names a project "default" must still list it, or
    // the caller cannot pass it to `run_tests`.
    return this._projects.filter((p) => !p.synthesized).map((p) => p.name);
  }

  getTestTree(): TestTreeEntry[] {
    return this._testTree;
  }

  /**
   * Map the caller's `files` onto discovered test files.
   *
   * Callers reasonably pass a path relative to the project, or a glob — both
   * used to match nothing and surface as "no tests executed", which reads
   * exactly like a suite that ran and found nothing to do.
   */
  resolveRequestedFiles(files: string[]): string[] {
    const roots = [this._config?.rootDir, process.cwd()].filter((r): r is string => Boolean(r));
    return matchRequestedFiles(files, this._testFiles, roots);
  }

  getDiscoveryErrors(): DiscoveryError[] {
    return [...this._discoveryErrors].map(([filePath, error]) => ({ filePath, error }));
  }

  getSessionInfo(): SessionInfo {
    const projects = this._projects
      .filter((p) => !p.synthesized)
      .map((p) => ({
        name: p.name,
        platform: p.effectiveConfig.platform,
        package: p.effectiveConfig.package,
        testFiles: p.testFiles,
        dependencies: p.dependencies,
        devices: deviceGroupNames(p.effectiveConfig),
      }));
    return {
      platform: this._config?.platform,
      package: this._config?.package,
      device: this._deviceSerial ?? undefined,
      timeout: this._config?.timeout ?? 30_000,
      retries: this._config?.retries ?? 0,
      projects,
      deviceTargets: this._deviceTargets(),
      configPath: this._configPath ?? undefined,
      configWarning: this._configWarning ?? undefined,
      configError: this._configError ?? undefined,
    };
  }

  /**
   * Whether `device` can be honoured for a run of `files`, and why not.
   *
   * A session keeps one device per target for its whole life: moving a target
   * would leave the agent it started attached to the previous device, and the
   * device tools pointed at it. So `device` can *choose* a target's device only
   * while that target is still unresolved — the session's first call, or a
   * target that found no device — and otherwise only confirm the one it has.
   * Anything else is refused: running the tests somewhere the caller did not
   * name is how one session took a device from under another.
   */
  async deviceChoiceError(files: string[], device: string, project?: string): Promise<string | null> {
    // Everything that can refuse or ignore the request is decided from the
    // session alone, before any target is resolved: resolving auto-picks, and
    // an auto-pick spent on a refused call is the session's one chance to
    // choose gone — the retry the refusal itself suggests was then refused.
    await this._ensureSession();
    if (!this._config) return null;
    // An unknown project is `validateProjectChoice`'s to refuse, by name —
    // and so is a file under several projects with none named, even when
    // they share one target.
    // Real projects only: the one a config without projects gets is not a
    // name validateProjectChoice accepts.
    if (project !== undefined && !this._projects.some((p) => !p.synthesized && p.name === project)) return null;
    if (project === undefined && this._hasRealProjects() && this.resolveRequestedFiles(files)
      .some((f) => this._projects.filter((p) => p.testFiles.includes(f)).length > 1)) return null;
    const keys = this._targetKeysFor(files, project);
    // Nothing matches: the run reports the files by name.
    if (keys.length === 0) return null;
    if (keys.length > 1) {
      return `\`device\` names one device, but these files run on ${keys.length} device targets `
        + `(${keys.map((k) => this._describeTargetKey(k)).join(', ')}). Pass \`project\` to pick one, or run them separately.`;
    }
    const key = keys[0];

    const pending = !this._devicesReady ? { device, files, project } : null;
    if (pending) this._pendingPin = pending;
    try {
      await this.ensureDevicesReady();
    } finally {
      // Only our own: a concurrent call may have replaced it meanwhile.
      if (pending && this._pendingPin === pending) this._pendingPin = null;
    }
    let serial: string;
    try {
      // Within the files' own group when they run on one: names are unique
      // per group, not per session.
      serial = this.resolveDeviceName(device, project ?? this._projectForTargetKey(key)) ?? device;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }

    const effective = this._wantedConfigs(this._config).find((c) => targetKeyFor(c) === key);
    const configPin = effective ? primaryDevicePin(effective) : undefined;
    // Resolved on this very device a moment ago: once is enough.
    const triedJustNow = pending !== null && this._devicePins.get(key) === device;
    // A member *name* means nothing until its group's devices are known, so it
    // cannot choose the device of a target that has none.
    // Not during a run: it retries its own target, and two resolutions of one
    // target start two daemons.
    // A retry of failed targets may be under way (a device tool's, or another
    // call's here): let every one land first rather than resolve the same
    // target twice (two daemons). A loop: a waiter woken with another may find
    // that one has started the next retry.
    while (this._retryPromise) await this._retryPromise;
    if (!triedJustNow && !this._isRunning && !this._targets.has(key) && this._targetErrors.has(key) && effective && !configPin
      && this._canPinPrimary(effective, device)) {
      // No device yet, so nothing to move: resolve it on the requested one.
      this._devicePins.set(key, serial);
      this._retriedTargets.add(key);
      this._retryPromise = this._resolveOnePlatformTarget(effective);
      try {
        await this._retryPromise;
      } finally {
        this._retryPromise = null;
      }
    }
    const target = this._targets.get(key);
    // A target's recorded failure, as one sentence ending in a single period.
    const reasonOf = (k: string): string =>
      `${(this._targetErrors.get(k) ?? 'its target did not resolve').replace(/\.\s*$/, '')}.`;
    if (!target) {
      // Set up on the named device and failed (a typo, an offline device):
      // say so and forget the pin, so a later run without `device` may find
      // one rather than retrying this serial for the rest of the session.
      // The config pins another device: that wins, device or none yet. A
      // member of this target's own group, by name or pinned serial, is not
      // another device — the run reports why the group has none.
      const ownMember = effective !== undefined
        && resolveDeviceGroup(effective).some((e) => e.name === device || e.device === serial);
      if (configPin && configPin !== serial && !ownMember) {
        return `The config pins ${configPin} for ${this._describeTargetKey(key)} tests, not ${device}, and that device is not set up yet: `
          + `${reasonOf(key)} Change \`device\` in the config to run on ${device}.`;
      }
      const pinned = this._devicePins.get(key);
      if (pinned !== undefined && (pinned === device || pinned === serial)) {
        this._devicePins.delete(key);
        return `Could not set up ${device} for ${this._describeTargetKey(key)} tests: `
          + `${reasonOf(key)} Nothing is pinned; fix the device and pass \`device\` again.`;
      }
      // Otherwise the run reports the target's own failure.
      return null;
    }
    const serials = [target.deviceSerial, ...(target.members ?? []).map((m) => m.deviceSerial)];
    if (serials.includes(serial)) {
      // Confirmed: hold the target to it, so a target resolved again (its
      // daemon died) cannot come back on another device.
      if (effective && !configPin && !this._devicePins.has(key)) this._devicePins.set(key, target.deviceSerial);
      return null;
    }

    const where = this._describeTargetKey(key);
    return `This session runs ${where} tests on ${serials.join(' + ')}, not ${device}. `
      + 'A headless MCP session keeps the device it started on for its whole life (moving it would strand the agent '
      + 'it started there), so `device` can confirm that device but not choose another. '
      + (configPin
        ? `The config pins ${configPin}; change \`device\` there and restart the MCP server to run on ${device}.`
        : `To run on ${device}, restart the MCP server and pass \`device\` to run_tests before any other run or device tool, `
          + `or set \`device: '${device}'\` in the config.`);
  }

  toggleWatch(filePath: string, options?: { testFilter?: string; project?: string }): { enabled: boolean } {
    const { testFilter, project: projectName } = options ?? {};
    const existing = this._findWatchEntry(filePath, projectName, testFilter);
    if (existing >= 0) {
      this._stopWatching(filePath, projectName, testFilter);
      return { enabled: false };
    }
    this._startWatching(filePath, projectName, testFilter);
    return { enabled: true };
  }

  dispose(): void {
    if (this._activeChild) {
      try { this._activeChild.kill(); } catch { /* already dead */ }
    }
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    this._watchedEntries.clear();
  }

  // ─── Lazy initialization ───

  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    if (this._initPromise) {
      await this._initPromise;
      return;
    }
    this._initPromise = this._initialize();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  /**
   * Config, projects and a device per platform — and nothing else.
   *
   * What a device tool needs to know which device it is talking to, without the
   * part of initialization that costs the time: a forked discovery child per
   * test file. On a suite of any size that is minutes, and a `tap` that waits
   * for it is a `tap` the MCP client times out.
   *
   * Only what needs a device calls this — runs and device tools. Listing tests
   * or reading session info used to resolve every target too, auto-picking a
   * device (another session's, as likely as not) before a `run_tests` could
   * name one, and the documented flow starts with `tapsmith_list_tests`
   * (PILOT-342).
   */
  async ensureDevicesReady(opts?: { retryFailedTargets?: boolean; project?: string }): Promise<void> {
    if (this._devicesReady) {
      if (opts?.retryFailedTargets) await this._retryFailedTargets(opts.project);
      return;
    }
    if (this._devicesPromise) {
      await this._devicesPromise;
      return;
    }
    this._devicesPromise = this._prepareDevices();
    try {
      await this._devicesPromise;
    } finally {
      this._devicesPromise = null;
    }
  }

  /** A retry of failed targets in flight, shared by concurrent device tools. */
  private _retryPromise: Promise<void> | null = null;

  /** When device tools last retried the failed targets (see `_retryFailedTargets`). */
  private _lastTargetRetryAt = 0;

  /**
   * Resolve again every target that found no device (see `ensureDevicesReady`).
   *
   * Budgeted: only when no target serves at all — a missing platform beside a
   * working one would otherwise start and discard a daemon on every tap of the
   * working one — never while a run is in flight (it retries its own target,
   * and two resolutions of one target start two daemons), and at most once per
   * {@link TARGET_RETRY_INTERVAL_MS}, so a tool loop does not churn daemons.
   */
  private async _retryFailedTargets(project?: string): Promise<void> {
    if (this._retryPromise) return this._retryPromise;
    const config = this._config;
    if (!config || this._targetErrors.size === 0 || this._isRunning) return;
    // A tool that names a project wants that project's target: retry it alone
    // when it failed, whatever else serves. Otherwise only when nothing serves.
    const namedKey = project !== undefined && this._projects.some((p) => p.name === project)
      ? platformKeyForProject(this._projects, project, config.platform)
      : undefined;
    if (namedKey !== undefined ? !this._targetErrors.has(namedKey) || this._targets.has(namedKey) : this._targets.size > 0) return;
    if (Date.now() - this._lastTargetRetryAt < TARGET_RETRY_INTERVAL_MS) return;
    this._lastTargetRetryAt = Date.now();
    const failed = this._wantedConfigs(config).filter((c) => (namedKey !== undefined
      ? targetKeyFor(c) === namedKey
      : this._targetErrors.has(targetKeyFor(c))));
    this._retryPromise = (async () => {
      for (const effective of failed) await this._resolveOnePlatformTarget(effective);
    })();
    try {
      await this._retryPromise;
    } finally {
      this._retryPromise = null;
    }
  }

  /** Config, projects and test files, loaded once and shared. */
  private async _ensureSession(): Promise<void> {
    if (this._sessionReady) return;
    if (this._sessionPromise) {
      await this._sessionPromise;
      return;
    }
    this._sessionPromise = this._prepareSession();
    try {
      await this._sessionPromise;
    } finally {
      this._sessionPromise = null;
    }
  }

  private async _initialize(): Promise<void> {
    log('Initializing test dispatcher...');
    await this._ensureSession();

    if (this._testFiles.length > 0 && this._scripts) {
      await this._discoverTestTree();
    }

    this._initialized = true;
    log(`Initialized: ${this._testFiles.length} test file(s)`);
  }

  private async _prepareDevices(): Promise<void> {
    // Shares the in-flight session load, so a device tool and a run racing to
    // start resolve the same targets once rather than twice.
    await this._ensureSession();
    const config = this._config;
    if (config) this._applyPendingPin(config);
    await this._resolvePlatformTargets(config);
    this._devicesReady = true;
    log(`Devices ready: ${this._testFiles.length} test file(s), device=${this._deviceSerial ?? 'none'}`);
  }

  private async _prepareSession(): Promise<void> {
    // Reset, not append. This runs again after a throw — `ensureDevicesReady`
    // only latches on success — and the per-project branch pushes, so a config
    // that failed partway through left its files behind and the next attempt
    // added them a second time. `runAll` then ran each of them twice.
    // Everything derived from the config, together. This runs again after a
    // throw, and leaving last attempt's projects behind while the files they
    // name are gone left `runAll` walking waves of files nothing re-discovered.
    this._testFiles = [];
    this._projects = [];
    this._projectWaves = [];
    this._projectConfigs.clear();
    // Including the load failures: `_discoverTestTree` clears them, but
    // `_initialize` only runs it when files were found. A second pass that
    // discovers none kept reporting "N test file(s) failed to load" for paths
    // this session no longer knows anything about.
    this._discoveryErrors.clear();
    const config = await this._loadConfigWithFallback();
    this._config = config;
    // The MCP server's stderr is the user's terminal (stdout is the protocol
    // stream); this is the last user-facing point before a child runs a file.
    telemetry.printNoticeIfFirstRun(config ?? undefined);
    // Persist the anonymous id in this parent before it forks per-file run
    // children, so they share one id rather than each minting its own on a
    // fresh machine (PILOT-330 review).
    telemetry.ensureIdentity(config ?? undefined);

    if (config) {
      try {
        this._projects = resolveProjects(config);
        // As the CLI does: a root `device` pins only the projects of its own
        // platform, not the other platform's target too.
        if (config.device && new Set(this._projects.map((p) => p.effectiveConfig.platform ?? 'android')).size > 1) {
          scopeDevicePinToPlatform(this._projects, config.device, platformOfSerial(config.device));
        }
        this._projectWaves = topologicalSort(this._projects);
      } catch {
        this._projects = [];
        this._projectWaves = [];
      }

      // Best effort, like `resolveProjects` above. A device tool waits on this
      // now, and a `testMatch` glob that throws would otherwise take down
      // `snapshot` and `tap` — tools with no interest in the test tree at all.
      try {
        if (this._hasRealProjects()) {
          const seen = new Set<string>();
          for (const project of this._projects) {
            const files = await discoverTestFiles(
              project.testMatch,
              config.rootDir,
              undefined,
              project.testIgnore,
            );
            project.testFiles = files;
            for (const f of files) {
              if (!seen.has(f)) {
                seen.add(f);
                this._testFiles.push(f);
              }
            }
          }
        } else {
          this._testFiles = await discoverTestFiles(config.testMatch, config.rootDir);
        }
      } catch (err) {
        log(`Test file discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (config) {
      this._serializedConfig = serializeConfig(config);
    }

    this._scripts = resolveScripts(this._testFiles);
    this._sessionReady = true;
  }

  // ─── Device targets ───

  /**
   * Resolve a daemon + device + agent for every platform the session runs on.
   *
   * A multi-platform config carries its platforms on the projects, not at the
   * top level, so a single session-wide device was both arbitrary (whichever
   * device a daemon happened to list first) and unusable for iOS, whose agent
   * needs platform-specific artifacts. One target per platform fixes both.
   *
   * A platform that cannot be satisfied (no emulator running, say) is recorded
   * rather than thrown: the other platform's tests still run, and a request for
   * the missing one fails with the reason.
   *
   * One device per platform, deliberately: an MCP session runs files one at a
   * time, so a second device for the same platform would sit idle. Projects on
   * one platform that pin *different* devices via `use: { device }` therefore
   * all run on the first one's — `tapsmith test` honours `deviceSignature` and
   * gives each its own, but a session here does not.
   */
  private async _resolvePlatformTargets(config: TapsmithConfig | null): Promise<void> {
    this._targets.clear();
    this._targetErrors.clear();
    this._retriedTargets.clear();
    if (!config) return;

    // Pinned targets first, so they take their devices before an unpinned
    // target's auto-pick can. An unpinned target on the same platform then
    // reuses that daemon and shares its device — the shared-device model —
    // rather than grabbing the pinned device first. (Steering it *away* from
    // the pin instead repointed the shared daemon under the pinned target.)
    const wanted = this._wantedConfigs(config);
    // Any pin counts, a group member's included: an unpinned target resolving
    // first could otherwise take the device a member is pinned to.
    const pinned = wanted.filter((c) => pinnedDeviceSerials(c).length > 0 || this._devicePins.has(targetKeyFor(c)));
    for (const effective of [...pinned, ...wanted.filter((c) => !pinned.includes(c))]) {
      await this._resolveOnePlatformTarget(effective);
    }

    // In project order, as before targets were resolved pinned-first.
    this._deviceSerial = wanted.map((c) => this._targets.get(targetKeyFor(c))?.deviceSerial).find((s) => s !== undefined) ?? null;
  }

  /**
   * One effective config per platform the session runs on.
   *
   * First project wins per platform, matching what `_resolvePlatformTargets`
   * documents: a `Map` built from the full list would keep the *last* one, so
   * two projects pinning different devices would resolve the target for the
   * second while the comment promised the first.
   */
  private _wantedConfigs(config: TapsmithConfig): TapsmithConfig[] {
    if (!this._hasRealProjects()) return [config];
    const byKey = new Map<string, TapsmithConfig>();
    for (const project of this._projects) {
      // A `use.devices` project gets its own target (a group of daemons);
      // single-device projects share one per platform.
      const key = targetKeyFor(project.effectiveConfig);
      if (!byKey.has(key)) byKey.set(key, project.effectiveConfig);
    }
    return [...byKey.values()];
  }

  /**
   * Pin the target a pending `run_tests` `device` is for, before anything
   * auto-picks one. Only an unambiguous request pins: files spanning two
   * targets would pin one of them to a device it cannot use, and a group
   * member's *name* means nothing until its group's devices are known.
   * `deviceChoiceError` refuses both afterwards.
   */
  private _applyPendingPin(config: TapsmithConfig): void {
    const pin = this._pendingPin;
    if (!pin) return;
    if (this._isGroupMemberName(pin.device)) return;
    const keys = this._targetKeysFor(pin.files, pin.project);
    if (keys.length !== 1) return;
    const effective = this._wantedConfigs(config).find((c) => targetKeyFor(c) === keys[0]);
    // A device pinned in the config wins; `deviceChoiceError` says so.
    if (effective && !primaryDevicePin(effective) && this._canPinPrimary(effective, pin.device)) {
      this._devicePins.set(keys[0], pin.device);
    }
  }

  /**
   * Whether `device` may become the primary of the target `effective` builds.
   * Not a member's *name*, and not a serial the config pins to another member:
   * "run on bob's device" would otherwise put alice on it too.
   */
  private _canPinPrimary(effective: TapsmithConfig, device: string): boolean {
    return !this._isGroupMemberName(device) && !pinnedDeviceSerials(effective).includes(device);
  }

  /** Whether `device` is a `use.devices` member name rather than a serial. */
  private _isGroupMemberName(device: string): boolean {
    return this._projects.some((p) => resolveDeviceGroup(p.effectiveConfig).some((e) => e.name === device));
  }

  /**
   * The distinct targets a run of `files` could use. Stricter than the
   * routing in `runFiles`, which falls back to the first project holding a
   * file: a file under several projects counts every one of them, and an
   * unknown `project` counts none. `run_tests` refuses both, and a pin taken
   * from the fallback would land on a target the caller never chose.
   */
  private _targetKeysFor(files: string[], project?: string): string[] {
    if (project !== undefined && !this._projects.some((p) => p.name === project)) return [];
    const root = this._config?.platform;
    const keys = new Set<string>();
    for (const f of this.resolveRequestedFiles(files)) {
      const owners = project !== undefined
        ? this._projects.filter((p) => p.name === project)
        : this._projects.filter((p) => p.testFiles.includes(f));
      if (owners.length === 0) keys.add(platformKeyForProject(this._projects, undefined, root));
      for (const p of owners) keys.add(platformKeyForProject(this._projects, this._realProjectName(p), root));
    }
    return [...keys];
  }

  /**
   * A target key as a caller would name it: a group target by its project
   * (it has one), any other by its platform — several projects share it.
   */
  private _describeTargetKey(key: string): string {
    const group = key.includes('|') ? this._projectForTargetKey(key) : undefined;
    if (group) return `project "${group}"`;
    const platform = key.split('|')[0];
    return platform === DEFAULT_PLATFORM_KEY ? 'its' : platform;
  }



  /** Resolve (or re-resolve) a single platform, leaving the others alone. */
  private async _resolveOnePlatformTarget(effective: TapsmithConfig): Promise<void> {
    const key = targetKeyFor(effective);
    // A `run_tests` pin applies only where the config leaves the primary free.
    const pin = primaryDevicePin(effective) ? undefined : this._devicePins.get(key);
    try {
      const target = await ensurePlatformTarget(pin ? { ...effective, device: pin } : effective, pin ? 'run_tests' : 'config');
      this._targets.set(key, target);
      this._targetErrors.delete(key);
      this._deviceSerial ??= target.deviceSerial;
      log(`Using ${key === DEFAULT_PLATFORM_KEY ? 'device' : `${key} device`} ${target.deviceSerial} via ${target.address}`);
      for (const m of target.members ?? []) log(`  group member ${m.name}: ${m.deviceSerial} via ${m.address}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._targetErrors.set(key, message);
      log(`Warning: ${key === DEFAULT_PLATFORM_KEY ? 'device' : key} setup failed: ${message}`);
    }
  }

  /**
   * The config a project's worker runs under.
   *
   * The worker's session preflight (app launch, agent checks) reads the config
   * it is handed, so handing it the *root* config left a project's platform,
   * app bundle and agent artifacts behind — everything a multi-platform config
   * keeps in `use`. The project's effective config carries all of it.
   */
  private _configForProject(projectName?: string): SerializedConfig {
    if (!projectName) return this._serializedConfig!;
    const cached = this._projectConfigs.get(projectName);
    if (cached) return cached;

    const project = this._projects.find((p) => p.name === projectName);
    const serialized = project ? serializeConfig(project.effectiveConfig) : this._serializedConfig!;
    this._projectConfigs.set(projectName, serialized);
    return serialized;
  }

  /**
   * A project's name, or `undefined` for the synthetic project `resolveProjects`
   * invents when a config declares none.
   *
   * Testing the name alone would also swallow a project a user actually named
   * "default" — which then routes to no platform target and no per-project
   * config, so every one of its files fails with "No device is configured"
   * despite a healthy device.
   */
  private _realProjectName(project?: ResolvedProject): string | undefined {
    if (!project || !this._hasRealProjects()) return undefined;
    return project.name;
  }

  /** Every platform this session runs on, with its device or its failure. */
  private _deviceTargets(): DeviceTarget[] {
    const toPlatform = (key: string): string | undefined => {
      const platform = key.split('|')[0];
      return platform === DEFAULT_PLATFORM_KEY ? undefined : platform;
    };
    return [
      ...[...this._targets].flatMap(([key, t]) => {
        if (!t.members || t.members.length === 0) return [{ platform: toPlatform(key), device: t.deviceSerial }];
        // A group target's key carries the platform only when the project sets
        // one; a single-platform config keeps it on the root, and the members
        // are still Android (or iOS) devices, not "device"s.
        const platform = toPlatform(key)
          ?? this._projects.find((p) => targetKeyFor(p.effectiveConfig) === key)?.effectiveConfig.platform
          ?? this._config?.platform;
        const groupName = this._projectForTargetKey(key);
        const primaryName = this._projectForTargetKey(key, true);
        return [
          { platform, device: t.deviceSerial, name: primaryName, group: groupName },
          ...t.members.map((m) => ({ platform, device: m.deviceSerial, name: m.name, group: groupName })),
        ];
      }),
      ...[...this._targetErrors].map(([key, error]) => ({ platform: toPlatform(key), error })),
    ];
  }

  /** The project a group target belongs to (or, with `primaryName`, its primary's group name). */
  private _projectForTargetKey(key: string, primaryName = false): string | undefined {
    const project = this._projects.find((p) => targetKeyFor(p.effectiveConfig) === key);
    if (!project) return undefined;
    return primaryName ? resolveDeviceGroup(project.effectiveConfig)[0]?.name : project.name;
  }

  /**
   * A group member's serial by name. Every device tool accepts `device`, and
   * `alice` is how a two-user test's author refers to a device; the serial is
   * an implementation detail they have to look up otherwise.
   */
  resolveDeviceName(name: string, project?: string): string | undefined {
    // Only the requested project's own target when one is named: every group
    // may call its members `alice`, and `resolveDeviceTarget` acts on
    // `device` before it looks at `project`, so a name from another group
    // would silently route the call to that group's device.
    const wantedKey = project !== undefined
      ? platformKeyForProject(this._projects, project, this._config?.platform)
      : undefined;
    const matches: Array<{ project: string | undefined; serial: string }> = [];
    for (const [key, target] of this._targets) {
      if (wantedKey !== undefined && key !== wantedKey) continue;
      const owner = this._projectForTargetKey(key);
      if (this._projectForTargetKey(key, true) === name) matches.push({ project: owner, serial: target.deviceSerial });
      const member = target.members?.find((m) => m.name === name);
      if (member) matches.push({ project: owner, serial: member.deviceSerial });
    }
    return pickResolvedDeviceName(name, matches);
  }


  /**
   * The daemon/device a project's tests must run against.
   *
   * Never substitutes another platform's target. A missing iOS device must
   * surface as "boot a simulator", not quietly run the iOS suite against an
   * Android emulator, where every assertion fails for reasons that look
   * nothing like the actual problem.
   */
  /**
   * A platform's target, re-resolving it once if it previously failed.
   *
   * Targets are resolved at startup, but the failure message tells the user to
   * boot a simulator "and try again" — and a server that caches the error for
   * its whole life never lets them. Strictly this platform, and at most once
   * per run request: re-resolving everything would spawn and discard a daemon
   * per file for a platform that stays unavailable, and a transient failure
   * while re-resolving a *healthy* platform would throw away a working target.
   */
  private async _ensureTargetForProject(projectName?: string): Promise<PlatformTarget> {
    const key = platformKeyForProject(this._projects, projectName, this._config?.platform);
    // A device tool's or a run_tests `device`'s retry may be resolving this
    // target now: wait for it rather than resolve it a second time.
    if (this._retryPromise) await this._retryPromise;
    await this._dropTargetIfDaemonDied(key);
    if (this._config && this._targetErrors.has(key) && !this._retriedTargets.has(key)) {
      this._retriedTargets.add(key);
      const effective = this._wantedConfigs(this._config).find((c) => targetKeyFor(c) === key);
      if (effective) await this._resolveOnePlatformTarget(effective);
    }
    return selectPlatformTarget(key, this._targets, this._targetErrors);
  }

  /**
   * Forget a resolved target whose daemon has since died.
   *
   * A *successful* target was never revisited: run children connect to its
   * address themselves, so a daemon killed mid-session left every later run
   * failing at gRPC connect with no path back short of restarting the server.
   * The retry budget is cleared with it — that budget exists to stop churning
   * on a platform with no device, which is a different situation from a daemon
   * that was working a moment ago.
   */
  private async _dropTargetIfDaemonDied(key: string): Promise<void> {
    const target = this._targets.get(key);
    if (!target || await platformTargetIsLive(target)) return;
    log(`Daemon at ${target.address} is gone; re-resolving the ${key === DEFAULT_PLATFORM_KEY ? 'device' : key} target`);
    this._targets.delete(key);
    this._targetErrors.set(key, `The daemon at ${target.address} stopped responding.`);
    this._retriedTargets.delete(key);
  }

  // ─── Test tree discovery ───

  private async _discoverTestTree(): Promise<void> {
    const scripts = this._scripts!;
    const fileNodes = new Map<string, TestTreeNode>();
    this._discoveryErrors.clear();

    const discovered = await mapWithConcurrency(this._testFiles, DISCOVERY_CONCURRENCY, async (file) => {
      const { tree, error } = await discoverFile(file, scripts);
      return { file, tree, error };
    });
    for (const { file, tree, error } of discovered) {
      if (tree) fileNodes.set(file, tree);
      // A file that fails to load has no tests to show, so it would otherwise
      // vanish from the tree with nothing to distinguish it from a file that
      // genuinely holds no tests. Keep the reason for the caller.
      else this._discoveryErrors.set(file, error ?? 'Discovery failed (no result returned)');
    }

    if (this._hasRealProjects()) {
      const trees: TestTreeEntry[] = [];
      for (const project of this._projects) {
        const children: TestTreeEntry[] = [];
        for (const file of project.testFiles) {
          const node = fileNodes.get(file);
          if (node) children.push(toTreeEntry(node));
        }
        if (children.length > 0) {
          trees.push({
            type: 'project',
            name: project.name,
            fullName: project.name,
            filePath: '',
            status: 'idle',
            children,
            devices: deviceGroupNames(project.effectiveConfig),
          });
        }
      }
      this._testTree = trees;
    } else {
      this._testTree = [...fileNodes.values()].map(toTreeEntry);
    }
  }

  // ─── Test execution ───

  private async _runFileInChild(
    filePath: string,
    projectUseOptions?: RunFileUseOptions,
    projectName?: string,
    testFilter?: string,
  ): Promise<RunFileChildResult> {
    if (!this._serializedConfig) {
      throw new Error('No Tapsmith config is loaded, so there is nothing to run against.');
    }

    const target = await this._ensureTargetForProject(projectName);
    const serializedConfig = this._configForProject(projectName);
    // The primary's group name comes from the project's config (`use.devices`
    // is project-level); the child takes the names as given.
    const runProject = projectName ? this._projects.find((p) => p.name === projectName) : undefined;
    const deviceName = resolveDeviceGroup(runProject?.effectiveConfig ?? this._config ?? {})[0].name;

    const scripts = this._scripts!;
    return new Promise((resolve, reject) => {
      const child = fork(scripts.watchRunScript, [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        ...(scripts.tsxBin ? { execPath: scripts.tsxBin } : {}),
        env: {
          ...process.env,
          NODE_PATH: path.resolve(scripts.baseDir, '..'),
        },
      });

      this._activeChild = child;
      let settled = false;
      const clearActiveChild = (): void => {
        if (this._activeChild === child) this._activeChild = null;
        this._clearStopEscalation();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearActiveChild();
        try { child.kill(); } catch { /* already dead */ }
        reject(new Error(`Test worker timed out after ${RUN_CHILD_TIMEOUT_MS}ms`));
      }, RUN_CHILD_TIMEOUT_MS);
      timeout.unref?.();
      const resolveOnce = (value: RunFileChildResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const rejectOnce = (err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearActiveChild();
        reject(err);
      };

      child.on('message', (response: WatchRunChildMessage) => {
        if (settled) return;

        switch (response.type) {
          case 'test-end': {
            const result = deserializeTestResult(response.result);
            if (testFilter && result.status === 'skipped' && !matchesTestFilter(result.fullName, testFilter)) break;
            const key = resultEntryKey(projectName, filePath, result.fullName);
            this._testResults.set(key, {
              fullName: result.fullName,
              filePath,
              status: result.status,
              duration: result.durationMs,
              error: result.error?.message,
              tracePath: result.tracePath,
              videoPath: result.videoPath,
              projectName,
            });
            break;
          }
          case 'file-done': {
            // Fold what the child learned into the sticky per-device store,
            // so the next fresh child starts already-detected.
            if (response.resetCapabilities) {
              const store = this._resetCapabilities.get(target.deviceSerial) ?? {};
              Object.assign(store, response.resetCapabilities);
              this._resetCapabilities.set(target.deviceSerial, store);
            }
            for (const [serial, learned] of Object.entries(response.groupResetCapabilities ?? {})) {
              const store = this._resetCapabilities.get(serial) ?? {};
              Object.assign(store, learned);
              this._resetCapabilities.set(serial, store);
            }
            const results = response.results.map(deserializeTestResult);
            const suite = deserializeSuiteResult(response.suite);
            resolveOnce({ results, suite });
            break;
          }
          case 'error':
            rejectOnce(new Error(response.error.message));
            break;
        }
      });

      child.on('exit', (code) => {
        if (!settled) {
          rejectOnce(new Error(`Test worker exited with code ${code ?? 0} without sending results`));
        } else {
          clearActiveChild();
        }
      });

      child.on('error', (err) => {
        rejectOnce(err);
      });

      // One address, not the pool: a multi-platform session runs several
      // daemons, and the child connects to exactly one.
      const msg: WatchRunMessage = {
        type: 'run',
        daemonAddress: target.address,
        deviceSerial: target.deviceSerial,
        deviceName,
        filePath,
        config: serializedConfig,
        screenshotDir: undefined,
        projectUseOptions,
        projectName,
        testFilter,
        // These runs are `tapsmith_run_tests`, not watch mode, whatever child
        // script they happen to share.
        label: 'Run',
        runMode: 'mcp',
        resetCapabilities: this._resetCapabilities.get(target.deviceSerial),
        ...(target.members && target.members.length > 0 ? {
          groupMembers: target.members.map((m) => ({
            name: m.name,
            daemonAddress: m.address,
            deviceSerial: m.deviceSerial,
            resetCapabilities: this._resetCapabilities.get(m.deviceSerial),
          })),
        } : {}),
      };

      child.send(msg);
    });
  }

  // ─── Watch mode ───

  private _startWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined): void {
    let list = this._watchedEntries.get(filePath);
    const isNewFile = !list;
    if (!list) {
      list = [];
      this._watchedEntries.set(filePath, list);
    }
    if (this._findWatchEntry(filePath, projectName, testFilter) >= 0) return;
    list.push({ projectName, testFilter });

    if (!this._watcher) {
      this._watcher = chokidarWatch([], { ignoreInitial: true });
      this._watcher.on('change', (changedPath) => {
        if (this._watchedEntries.has(changedPath)) {
          // Nothing re-runs discovery in watch mode, so an import failure
          // recorded once was reported by `list_tests` for the life of the
          // server — including after the edit that fixed it. The file just
          // changed; the old reason no longer describes it, and the run about
          // to be scheduled reports whatever is true now.
          this._discoveryErrors.delete(changedPath);
          this._watchQueue.scheduleFiles([changedPath]);
        }
      });
    }

    if (isNewFile) this._watcher.add(filePath);
  }

  private _stopWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined): void {
    const list = this._watchedEntries.get(filePath);
    const idx = this._findWatchEntry(filePath, projectName, testFilter);
    if (!list || idx < 0) return;
    list.splice(idx, 1);
    if (list.length === 0) {
      this._watchedEntries.delete(filePath);
      this._watcher?.unwatch(filePath);
    }
  }

  private _findWatchEntry(filePath: string, projectName: string | undefined, testFilter: string | undefined): number {
    const list = this._watchedEntries.get(filePath);
    if (!list) return -1;
    return list.findIndex((e) =>
      (e.projectName ?? null) === (projectName ?? null) &&
      (e.testFilter ?? null) === (testFilter ?? null),
    );
  }

  // ─── Config discovery ───

  private async _loadConfigWithFallback(): Promise<import('../config.js').TapsmithConfig | null> {
    return loadMcpConfig(this._configFile)
      .then((result) => {
        this._configPath = result.configPath ?? null;
        // Kept for every tool that reports session state: a synthesized config
        // looks exactly like a real one in the tool output, so the session must
        // carry the reason it has none rather than logging it once to stderr
        // that no MCP client ever reads.
        this._configWarning = result.warning ?? null;
        this._configError = null;
        if (result.configPath) log(`Using config: ${path.relative(process.cwd(), result.configPath) || result.configPath}`);
        if (result.warning) log(`Warning: ${result.warning}`);
        return result.config;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this._configPath = null;
        this._configWarning = `Failed to load the Tapsmith config: ${message}\nRestart the MCP server once it is fixed; the load is not retried within a session.`;
        this._configError = message;
        log(`Warning: failed to load config: ${message}`);
        return null;
      });
  }

  // ─── Helpers ───

  private _hasRealProjects(): boolean {
    return this._projects.some((p) => !p.synthesized);
  }

  private _projectForFile(filePath: string, explicitProjectName?: string): ResolvedProject | undefined {
    if (explicitProjectName) {
      const byName = this._projects.find((p) => p.name === explicitProjectName);
      if (byName) return byName;
    }
    return this._projects.find((p) => p.testFiles.includes(filePath));
  }

  /**
   * Account for a file whose child died, and say what it counts as.
   *
   * A child killed by `stop()` did not fail: the error it leaves behind is the
   * SIGTERM we sent it ("exited with code 143"). Recording that as a
   * file-level failure made the user's own stop show up in `list_results` and
   * `suite_status` as a red file with a meaningless cause — while UI mode
   * reported the same stop as interrupted.
   */
  private _accountForFileError(
    filePath: string,
    projectName: string | undefined,
    err: unknown,
  ): 'interrupted' | 'failed' {
    if (this._stopRequested) return 'interrupted';
    this._recordFileError(filePath, projectName, err);
    return 'failed';
  }

  /**
   * Record a failure that killed a whole file before any test could report —
   * an import error, a missing module, a crashed or timed-out worker.
   *
   * The message used to go to stderr only, which an MCP client never sees: the
   * caller got `0 passed, 1 failed` with no cause, and `tapsmith_list_results`
   * showed nothing at all. Storing it as a result entry puts it in front of
   * every consumer — the run's failure details, the results list, and the
   * accumulated suite board.
   *
   * The board takes some care: it is built by walking the test tree, and a file
   * that failed to load contributes no node, so `tapsmith_suite_status` picks
   * this entry up separately (see `unmatchedFailures`).
   */
  private _recordFileError(filePath: string, projectName: string | undefined, err: unknown): void {
    const entry = fileFailureEntry(filePath, projectName, err);
    this._testResults.set(resultEntryKey(projectName, filePath, entry.fullName), entry);
    log(`Error running ${path.basename(filePath)}: ${entry.error}`);
  }

  private _collectFailures(): TestFailureDetail[] {
    return [...this._testResults.values()]
      // A stop is not a failure, so it must not be listed as one under a run
      // whose summary counted it as interrupted.
      .filter((r) => r.status === 'failed' && r.error && !isInterruptedEntry(r))
      .map((r) => ({
        fullName: r.fullName,
        filePath: r.filePath,
        error: r.error!,
        tracePath: r.tracePath,
        projectName: r.projectName,
      }));
  }

  private _withFailures(result: TestRunResult): TestRunResult {
    if (result.failed > 0) result.failures = this._collectFailures();
    return result;
  }
}

// ─── Shared utilities ───

/**
 * Key for the per-test result map. A test's `fullName` is only unique within a
 * single file (it's the `describe > test` chain), so the file path must be part
 * of the key — otherwise same-named tests in different files collide and earlier
 * files' results are silently overwritten in a multi-file run.
 */
/**
 * The device target for a platform key.
 *
 * Never substitutes another platform's target: a missing iOS device must
 * surface as "boot a simulator", not quietly run the iOS suite against an
 * Android emulator, where every assertion then fails for reasons that look
 * nothing like the actual problem.
 *
 * @internal — exported for unit testing.
 */
export function selectPlatformTarget(
  key: string,
  targets: Map<string, PlatformTarget>,
  errors: Map<string, string>,
): PlatformTarget {
  const exact = targets.get(key);
  if (exact) return exact;

  const reason = errors.get(key);
  if (reason) throw new Error(reason);

  // The run declares no platform of its own, so a single session target is
  // unambiguous — but several are not.
  if (key === DEFAULT_PLATFORM_KEY) {
    const all = [...targets.values()];
    if (all.length === 1) return all[0];
    if (all.length > 1) {
      throw new Error(
        `This session runs on ${all.length} platforms (${[...targets.keys()].join(', ')}) `
        + 'but the requested tests declare none. Pass a project name so the run targets one of them.',
      );
    }
    const anyReason = [...errors.values()][0];
    if (anyReason) throw new Error(anyReason);
  }

  throw new Error(`No device is configured for ${key === DEFAULT_PLATFORM_KEY ? 'this session' : key}.`);
}

/**
 * Match caller-supplied file arguments against the discovered test files.
 *
 * Accepts an absolute path, a path relative to any of `roots`, or a glob
 * (matched against the absolute path and against the path relative to each
 * root). Returns only files that exist in `testFiles`, so an argument that
 * matches nothing is distinguishable from one that matches an empty file.
 *
 * @internal — exported for unit testing.
 */
export function matchRequestedFiles(
  requested: string[],
  testFiles: string[],
  roots: string[],
): string[] {
  const uniqueRoots = [...new Set(roots)];
  const matched = new Set<string>();

  for (const request of requested) {
    if (testFiles.includes(request)) {
      matched.add(request);
      continue;
    }

    const relativeMatch = uniqueRoots
      .map((root) => path.resolve(root, request))
      .find((resolved) => testFiles.includes(resolved));
    if (relativeMatch) {
      matched.add(relativeMatch);
      continue;
    }

    for (const candidate of testFiles) {
      if (minimatch(candidate, request)) {
        matched.add(candidate);
        continue;
      }
      for (const root of uniqueRoots) {
        const relative = path.relative(root, candidate);
        if (!relative.startsWith('..') && minimatch(relative, request)) {
          matched.add(candidate);
          break;
        }
      }
    }
  }

  return [...matched];
}

/**
 * A whole-file failure as a result entry, so it reaches every consumer that
 * reads results rather than living only in the server's stderr.
 *
 * @internal — exported for unit testing.
 */
export function fileFailureEntry(
  filePath: string,
  projectName: string | undefined,
  err: unknown,
): TestResultEntry {
  return {
    fullName: `${path.basename(filePath)} — file failed to run`,
    filePath,
    status: 'failed',
    duration: 0,
    error: err instanceof Error ? err.message : String(err),
    projectName,
    fileLevelFailure: true,
  };
}

export function resultEntryKey(
  projectName: string | undefined,
  filePath: string,
  fullName: string,
): string {
  return `${projectName ?? ''}::${filePath}::${fullName}`;
}

interface WatchedEntry {
  projectName?: string
  testFilter?: string
}

interface DiscoverFileResult {
  tree: TestTreeNode | null
  /** Why the file produced no tree. Absent on success. */
  error?: string
}

interface ResolvedScripts {
  watchRunScript: string
  discoverScript: string
  tsxBin?: string
  baseDir: string
}

type RunFileChildResult = {
  results: import('../runner.js').TestResult[]
  suite: import('../runner.js').SuiteResult
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

/**
 * Locate the scripts the discovery/run children run, and the loader they need.
 *
 * `testFiles` decides the loader: the children `import()` the project's test
 * files, so TypeScript tests need tsx regardless of whether *our* scripts are
 * compiled. Deciding from our own scripts alone (as this used to) meant a
 * published install — which ships only `.js` — always forked bare node, whose
 * native type stripping resolves `.ts` files but does not remap a `./x.js`
 * specifier to `x.ts`. Every test file importing a sibling module the ESM way
 * then failed to load: silently dropped from the test tree during discovery,
 * and failing with a bare count at run time.
 *
 * @internal — exported for unit testing.
 */
export function resolveScripts(testFiles: string[] = []): ResolvedScripts {
  // import.meta.dirname is either src/mcp/ or dist/mcp/
  // watch-run is at src/watch-run.ts or dist/watch-run.js
  // ui-discover is at src/ui-mode/ui-discover.ts or dist/ui-mode/ui-discover.js
  const baseDir = path.resolve(import.meta.dirname, '..');

  const jsWatchRun = path.resolve(baseDir, 'watch-run.js');
  const tsWatchRun = path.resolve(baseDir, 'watch-run.ts');
  const watchRunScript = !fs.existsSync(jsWatchRun) && fs.existsSync(tsWatchRun)
    ? tsWatchRun
    : jsWatchRun;

  const jsDiscover = path.resolve(baseDir, 'ui-mode', 'ui-discover.js');
  const tsDiscover = path.resolve(baseDir, 'ui-mode', 'ui-discover.ts');
  const discoverScript = !fs.existsSync(jsDiscover) && fs.existsSync(tsDiscover)
    ? tsDiscover
    : jsDiscover;

  const tsxBin = resolveChildLoader(
    [watchRunScript, discoverScript],
    testFiles,
    path.resolve(baseDir, '..'),
    (message) => log(`Warning: ${message}`),
  );

  return { watchRunScript, discoverScript, tsxBin, baseDir };
}

function discoverFile(filePath: string, scripts: ResolvedScripts): Promise<DiscoverFileResult> {
  return new Promise((resolve) => {
    const child = fork(scripts.discoverScript, [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      ...(scripts.tsxBin ? { execPath: scripts.tsxBin } : {}),
      env: {
        ...process.env,
        NODE_PATH: path.resolve(scripts.baseDir, '..'),
      },
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`Discovery timed out for ${filePath} after ${DISCOVERY_TIMEOUT_MS}ms`);
      try { child.kill(); } catch { /* already dead */ }
      resolve({ tree: null, error: `Discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms` });
    }, DISCOVERY_TIMEOUT_MS);
    timeout.unref?.();
    const settle = (result: DiscoverFileResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.on('message', (response: UIDiscoverChildMessage) => {
      if (settled) return;

      if (response.type === 'discover-result') {
        settle({ tree: response.tree });
      } else {
        log(`Discovery error for ${filePath}: ${response.error.message}`);
        settle({ tree: null, error: response.error.message });
      }
    });

    child.on('exit', (code, signal) => {
      settle({ tree: null, error: `Discovery process exited without a result (code ${code ?? 'null'}, signal ${signal ?? 'none'})` });
    });

    child.on('error', (err) => {
      settle({ tree: null, error: `Discovery process failed to start: ${err.message}` });
    });

    const msg: UIDiscoverMessage = { type: 'discover', filePath };
    child.send(msg);
  });
}

function toTreeEntry(node: TestTreeNode): TestTreeEntry {
  const entry: TestTreeEntry = {
    type: node.type,
    name: node.name,
    fullName: node.fullName,
    filePath: node.filePath,
    status: node.status,
  };
  if (node.children && node.children.length > 0) {
    entry.children = node.children.map(toTreeEntry);
  }
  // Declared isolation (appReset / appResetScope / appState) — the MCP client
  // uses it to explain why a test resets the way it does.
  if (node.use) entry.use = { ...node.use };
  return entry;
}

function log(msg: string): void {
  process.stderr.write(`[tapsmith-mcp] ${msg}\n`);
}
