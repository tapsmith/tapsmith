import { NetworkReplayBuffer } from './network-replay.js';
/**
 * UI mode server.
 *
 * HTTP server that serves the bundled Preact SPA and upgrades to WebSocket
 * for real-time communication. Manages test discovery, execution (via forked
 * child processes), device screen polling, and watch mode.
 *
 * Supports both single-worker (existing: forks ui-run.ts per file) and
 * multi-worker (new: persistent ui-worker.ts processes with work-stealing)
 * execution modes.
 *
 * @see PILOT-87
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import { McpEventEmitter } from '../mcp/events.js';
import { McpSessionRouter } from '../mcp/http-session-router.js';
import { configureMcpConnection } from '../mcp/connection.js';
import { matchRequestedFiles, fileFailureEntry } from '../mcp/headless-dispatcher.js';
import { pickResolvedDeviceName } from '../mcp/tools/device-target.js';

import type { TestDispatcher, TestRunResult, TestResultEntry, TestTreeEntry, SessionInfo, DiscoveryError, DeviceTarget } from '../mcp/index.js';
import type { DeviceGroupEntry, TapsmithConfig } from '../config.js';
import { findDaemonBin } from '../daemon-bin.js';
import { resolveChildLoader } from '../child-scripts.js';
import { TapsmithGrpcClient } from '../grpc-client.js';
import type { Device } from '../device.js';
import type { ResolvedProject } from '../project.js';
import { collectTransitiveDeps, projectLabel } from '../project.js';
import { LaunchSetupError } from '../dispatcher.js';
import { STOPPED_BY_USER } from '../abort.js';
import { classifyEntryStatus, isInterruptedEntry, uiDeviceChoiceError } from '../mcp/test-dispatcher.js';
import type { LaunchedEmulator } from '../emulator.js';
import { preserveEmulatorsForReuse, getRunningAvdName } from '../emulator.js';
import { listSimulators, getSimulatorScreenScale } from '../ios-simulator.js';
import { listPhysicalDevices } from '../ios-devicectl.js';
import {
  deserializeTestResult,
  deserializeSuiteResult,
  serializeConfig,
  type SerializedConfig,
  type RunFileUseOptions,
} from '../worker-protocol.js';
import type {
  ServerMessage,
  ClientMessage,
  TestTreeNode,
  TraceEventMessage,
  SourceMessage,
  NetworkMessage,
  McpToolCallMessage,
  UIDiscoverMessage,
  UIDiscoverChildMessage,
  UIWorkerChildMessage,
  UIWorkerMessage,
  TestTreeUseOptions,
} from './ui-protocol.js';
import { encodeScreenFrame, mirrorKey, type TestNodeStatus, type WorkerDeviceInfo } from './ui-protocol.js';
import { deviceGroupSize, deviceGroupNames } from '../config.js';
import { runDeviceCount, startDaemon, waitForDaemon } from '../device-session.js';
import { projectTreeUse } from './tree-use.js';
import { RunQueue } from '../watch-queue.js';
import { DeviceReadiness, toWireReadiness, type Candidate, type ReadinessCommand, type ReadinessEvent, type StaleReason } from './device-readiness.js';
import { mergeResetCapabilities, nextCandidate as pickCandidate, policyForFile, type CandidateProject } from './readiness-candidate.js';
import type { AppResetPolicy, PreparedState, ResetCapabilities } from '../app-reset.js';
import { DEFAULT_UI_PREFERENCES, type DeviceActivityMessage, type UIPreferences } from './ui-protocol.js';
import {
  forkStdioForLaunchProgress,
  pipeForkOutputForLaunchProgress,
  type LaunchProgressSink,
} from '../launch-progress.js';
import {
  getTestDiscoveryWatchRoots,
  matchesTestIgnore,
  matchesTestFile,
  relativeTestPath,
} from '../test-file-discovery.js';

// ─── SPA paths ───

const SPA_HTML_PATH = path.resolve(import.meta.dirname, 'index.html');

const TAPSMITH_VERSION = (() => {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return (pkg.version as string) ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const MAX_DISCOVERY_BATCH_CONCURRENCY = 4;
const DISCOVERY_DEBOUNCE_MS = 150;

/** Cached screen-scale lookup keyed by UDID — avoids repeated simctl calls. */
const dprCache = new Map<string, number>();
function cachedScreenScale(udid: string, platform?: 'android' | 'ios'): number | undefined {
  if (platform !== 'ios') return undefined;
  let dpr = dprCache.get(udid);
  if (dpr == null) {
    dpr = getSimulatorScreenScale(udid);
    dprCache.set(udid, dpr);
  }
  return dpr;
}

/**
 * Resolve a device's configured platform. Initialized UI workers should use
 * resolveWorkerPlatform() so the value matches the config that launched the
 * worker daemon.
 */
function resolveDevicePlatform(ctx: UIServerContext, udid: string): 'android' | 'ios' | undefined {
  return ctx.configByDevice?.get(udid)?.platform ?? ctx.config.platform;
}

function resolveWorkerPlatform(
  ctx: UIServerContext,
  worker: { deviceSerial: string; platform?: 'android' | 'ios' },
): 'android' | 'ios' | undefined {
  return worker.platform ?? resolveDevicePlatform(ctx, worker.deviceSerial);
}

const IOS_SIMULATOR_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function isEmulatorOrSimulator(serial: string, platform?: 'android' | 'ios'): boolean {
  if (serial.startsWith('emulator-')) return true;
  if (platform === 'ios' && IOS_SIMULATOR_RE.test(serial)) return true;
  return false;
}

// ─── Types ───

export interface UIServerContext {
  config: TapsmithConfig
  /**
   * The config file backing this session, reported over MCP. Absent means the
   * session really is running on built-in defaults — so it must not be left
   * unset when a config was loaded, or `session_info` says the opposite.
   */
  configPath?: string
  /** Single-worker mode device/client (required when workers <= 1). */
  device?: Device
  client?: TapsmithGrpcClient
  deviceSerial?: string
  daemonAddress?: string
  testFiles: string[]
  screenshotDir?: string
  launchedEmulators: LaunchedEmulator[]
  /**
   * `--force-install`: workers reinstall the app on the devices they set up
   * at startup (the CLI already did the primary). Never on a respawn.
   */
  forceInstall: boolean
  projects?: ResolvedProject[]
  /** Dependency-ordered project waves from topologicalSort(). */
  projectWaves?: ResolvedProject[][]
  /** Number of parallel workers. When > 1, uses multi-worker mode. */
  workers?: number
  /** Device serials for multi-worker mode. */
  deviceSerials?: string[]
  /**
   * The device group of every worker, primary first — one entry per worker.
   * Takes precedence over `deviceSerials`, which describes single-device
   * workers only. A `use.devices` project's workers list all their members.
   */
  workerGroups?: string[][]
  /**
   * The device group every worker drives, primary first — `use.devices`
   * resolved from the session's *project* config. `use.devices` is
   * project-level, so `config` (the root) never declares it; a server that
   * derived the group from `config` ran a two-device project on one device.
   * Multi-bucket sessions override this per worker through `configByDevice`.
   */
  deviceGroup: DeviceGroupEntry[]
  /**
   * Group members the CLI's sequential setup already opened beside the
   * primary (daemon running, agent up, app launched). The worker adopting
   * the primary adopts these too instead of provisioning them again.
   */
  primaryGroupMembers?: Array<{ name: string; serial: string; daemonAddress: string }>
  /**
   * Per-bucket maps for multi-device-target projects. When set, each
   * device serial is paired with its bucket's serialized config and
   * worker dispatch routes files to workers in the matching bucket.
   */
  configByDevice?: Map<string, SerializedConfig>
  /**
   * Each device's worker group, primary first — its bucket's largest
   * `use.devices` group (the bucket's projects share the devices; a smaller
   * project runs on the first N). Set alongside `configByDevice`.
   */
  deviceGroupByDevice?: Map<string, DeviceGroupEntry[]>
  bucketByDevice?: Map<string, string>
  bucketByProject?: Map<string, string>
}

export interface UIServerOptions {
  port?: number
  /**
   * When set, the UI server serves a thin HTML shell that loads the Preact
   * SPA from a running Vite dev server at this URL (e.g. `http://localhost:5174`)
   * instead of the bundled single-file HTML. Enables Preact Fast Refresh so
   * frontend edits hot-swap without a full rebuild + CLI restart.
   */
  devUrl?: string
  launchProgress?: LaunchProgressSink
}

interface TaggedFile {
  filePath: string
  projectUseOptions?: RunFileUseOptions
  projectName?: string
  testFilter?: string
}

/**
 * How many of a worker's devices a file's run drives — the number its child
 * slices its sessions by. A worker holds its target's largest group; a file
 * from a project declaring a smaller one leaves the rest idle, and the
 * client shows them so.
 */
function fileDeviceCount(file: TaggedFile, config: Pick<TapsmithConfig, 'devices'>): number {
  return runDeviceCount(config, file.projectUseOptions);
}

/** The CLI-provisioned primary daemon a worker can attach to instead of spawning its own. */
interface AdoptTarget {
  client: TapsmithGrpcClient
  daemonAddress: string
  daemonPort: number
}

/** A secondary device of a UI worker's group, with the daemon that drives it. */
interface UIWorkerMemberHandle {
  name: string
  deviceSerial: string
  /** Friendly display name, resolved like the worker's own. */
  displayName?: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
  /** False when the CLI owns this daemon (adopted alongside the primary). */
  ownsDaemon: boolean
  /** gRPC client to this member's daemon, for screen polling and mirror gestures. */
  screenClient?: TapsmithGrpcClient
}

interface UIWorkerHandle {
  id: number
  process: ChildProcess
  /** The group's primary device. */
  deviceSerial: string
  /** The rest of the worker's device group (`use.devices`); empty otherwise. */
  members: UIWorkerMemberHandle[]
  /** Effective platform used to launch this worker's daemon. */
  platform?: 'android' | 'ios'
  /** Friendly display name, e.g. "iPhone 16 #1" for iOS or the serial for Android. */
  displayName: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
  /** gRPC client for screen polling from this worker's daemon. */
  screenClient?: TapsmithGrpcClient
  /** False for the worker that adopted the CLI's primary daemon — the CLI owns that process. */
  ownsDaemon?: boolean
  /** False when `screenClient` is the server's shared primary client. */
  ownsScreenClient?: boolean
  /** This worker drives the primary device (`ctx.device` is the same device). */
  adoptedPrimary?: boolean
  /** Source files changed since this process started; recycle before the next run. */
  codeStale?: boolean
  /** Background device preparation state machine. */
  readiness?: DeviceReadiness
  /** Policy the worker's startup launch left the app in (from its `ready` message). */
  initialPolicy?: AppResetPolicy
  /** Runtime reset capabilities the worker probed (in-app hooks detected?). */
  capabilities?: ResetCapabilities
  /** Last file this worker ran — the edit → rerun loop's best guess for what runs next. */
  lastRun?: { file: string; projectName?: string }
  /** Activity-feed id of the in-flight preparation. */
  prepareActivityId?: string
  /** Devices the in-flight background preparation covers (its file's group, primary first). */
  prepareDeviceCount?: number
  busy: boolean
  currentFile?: TaggedFile
  currentTest?: string
  retired?: boolean
  /**
   * Retired on purpose by a respawn (recycle for fresh code, or replacing a
   * crashed handle); the slot is initializing, not errored. Set on the old
   * handle only — the replacement starts clean.
   */
  respawning?: boolean
  /** A dispatch's exit handler is attached — it owns crash handling (requeue). */
  dispatchAttached?: boolean
  passed: number
  failed: number
  skipped: number
  /** Bucket signature this worker is bound to (when multi-bucket UI is in use). */
  bucketSignature?: string
}

interface UITestResultEntry extends TestResultEntry {
  workerId?: number
}

/**
 * Key for the per-test result map. A test's `fullName` is only unique within a
 * single file (it's the `describe > test` chain), so the file path must be part
 * of the key — otherwise same-named tests in different files collide.
 */
function resultEntryKey(entry: Pick<UITestResultEntry, 'projectName' | 'filePath' | 'fullName'>): string {
  return `${entry.projectName ?? ''}::${entry.filePath}::${entry.fullName}`;
}

// ─── UI Server ───

export async function startUIServer(
  ctx: UIServerContext,
  options: UIServerOptions = {},
): Promise<{ port: number; close: () => void }> {
  const clients = new Set<WebSocket>();
  let testTree: TestTreeNode[] = [];
  let isRunning = false;
  let runStartedAt = 0;
  const runningFiles = new Map<string, { filePath: string; projectName?: string }>();
  const failedFiles = new Set<string>();
  const testResults = new Map<string, UITestResultEntry>();
  const traceBuffer: TraceEventMessage[] = [];
  const sourceBuffer = new Map<string, SourceMessage>();
  const networkBuffer = new NetworkReplayBuffer(2000);
  const mcpToolCallBuffer: McpToolCallMessage[] = [];
  const MAX_TRACE_BUFFER = 5000;
  const MAX_MCP_BUFFER = 200;
  let traceBufferFull = false;

  function markRunStarted(): void {
    isRunning = true;
    runStartedAt = Date.now();
    runFirstActionAt = undefined;
    runPreflightOrigin = undefined;
    // Per-worker counters are per run: `run-ended` reads `failed` to decide
    // whether to hold a device for inspection, so a failure must not stick
    // to the worker across later (single-file) runs.
    for (const w of uiWorkers) {
      w.passed = 0;
      w.failed = 0;
      w.skipped = 0;
    }
    // A new run clears any previous stop request. Multi-file loops check
    // stopRequested BEFORE starting the next file, so a stop still ends the
    // whole user-initiated run — this reset only ever runs for files the
    // loop actually allowed to start.
    stopRequested = false;
    interruptedCount = 0;
  }

  function clearRunBuffers(): void {
    testResults.clear();
    traceBuffer.length = 0;
    traceBufferFull = false;
    sourceBuffer.clear();
    networkBuffer.clear();
  }

  function markRunEnded(): void {
    isRunning = false;
    runStartedAt = 0;
    runningFiles.clear();
    if (workersInitialized && uiWorkers.some((w) => w.codeStale && !w.retired)) {
      setTimeout(() => { if (!isRunning) void recycleStaleWorkers('source files changed during the run'); }, 250);
    }
    if (stopEscalationTimer) { clearTimeout(stopEscalationTimer); stopEscalationTimer = null; }
    forceSettleDispatch = null;
    // Backstop for run paths that end without broadcasting run-end (e.g. an
    // exception escaping to the command handler): never leave an MCP
    // stop_tests call hanging on a waiter. Always a fresh synthetic result —
    // falling back to lastRunEnd would report the PREVIOUS run's outcome.
    if (runEndWaiters.length > 0) {
      const fallback: TestRunResult = { status: 'stopped', passed: 0, failed: 0, skipped: 0, duration: 0 };
      for (const w of runEndWaiters.splice(0)) w(fallback);
    }
  }

  /**
   * Single funnel for finishing a run (PILOT-222): overrides the status to
   * 'stopped' when the user requested a stop, attaches the interrupted-test
   * count, broadcasts run-end, and wakes anyone waiting on the run's outcome
   * (MCP tapsmith_stop_tests).
   */
  function endRun(result: TestRunResult): TestRunResult {
    const final: TestRunResult = {
      ...result,
      status: stopRequested || parallelRunAborted ? 'stopped' : result.status,
      ...(interruptedCount > 0 ? { interrupted: interruptedCount } : {}),
    };
    broadcast({
      type: 'run-end',
      status: final.status,
      duration: final.duration,
      passed: final.passed,
      failed: final.failed,
      skipped: final.skipped,
      interrupted: final.interrupted,
      timeToFirstActionMs: runFirstActionAt !== undefined && runStartedAt > 0 ? runFirstActionAt - runStartedAt : undefined,
      preflight: { origin: runPreflightOrigin ?? 'unknown' },
    });
    lastRunEnd = final;
    for (const w of runEndWaiters.splice(0)) w(final);
    // The run is over: every worker can prepare the device for the next one.
    // `failed` is per worker (counts reset at run start): only devices that
    // actually saw a failure are held for inspection.
    for (const w of uiWorkers) {
      if (!w.retired) readinessEvent(w, { type: 'run-ended', stopped: final.status === 'stopped', failed: w.failed > 0 });
    }
    return final;
  }

  // ─── Device readiness wiring ───

  function speculationAllowed(): boolean {
    return preferences.prepareBetweenRuns;
  }

  function candidateProjects(): CandidateProject[] {
    return (ctx.projects ?? []).map((p) => ({
      name: p.name,
      testFiles: p.testFiles,
      use: p.use,
      effectiveConfig: p.effectiveConfig,
      bucketSignature: ctx.bucketByProject?.get(p.name),
    }));
  }

  function fileUseMap(): Map<string, TestTreeUseOptions | undefined> {
    const m = new Map<string, TestTreeUseOptions | undefined>();
    for (const [file, node] of discoveredFileNodes) m.set(file, node.use);
    return m;
  }

  /** Files sibling workers are already preparing for / prepared for. */
  function claimedCandidateFiles(except: UIWorkerHandle): Set<string> {
    const claimed = new Set<string>();
    for (const w of uiWorkers) {
      if (w === except || w.retired) continue;
      const st = w.readiness?.state;
      if (st?.kind === 'preparing' && st.forFile) claimed.add(st.forFile);
      if (st?.kind === 'ready' && st.forFile) claimed.add(st.forFile);
    }
    return claimed;
  }

  function candidateFor(worker: UIWorkerHandle): Candidate | undefined {
    return pickCandidate({
      bucketSignature: worker.bucketSignature,
      selected: selectedNode,
      lastRun: worker.lastRun,
      lastRunProject,
      projects: candidateProjects(),
      rootConfig: ctx.config,
      treeFiles: ctx.testFiles,
      fileUse: fileUseMap(),
      capabilities: worker.capabilities,
      exclude: claimedCandidateFiles(worker),
    });
  }

  /** The declared policy a file dispatched to `worker` will run under. */
  function policyForDispatch(worker: UIWorkerHandle, file: TaggedFile): AppResetPolicy {
    const project = candidateProjects().find((p) => p.name === file.projectName) ?? candidateProjects().find((p) => p.testFiles.includes(file.filePath));
    return policyForFile(file.filePath, project, { rootConfig: ctx.config, fileUse: fileUseMap(), capabilities: worker.capabilities });
  }

  function attachReadiness(worker: UIWorkerHandle): DeviceReadiness {
    const readiness = new DeviceReadiness(worker.id, {
      now: () => Date.now(),
      speculationEnabled: speculationAllowed,
      nextCandidate: () => candidateFor(worker),
      graceMs: () => preferences.prepareDelayMs,
      recentlyInteracted: () => Date.now() - lastMirrorInteraction < READINESS_INTERACTION_HOLD_WINDOW_MS,
    });
    worker.readiness = readiness;
    return readiness;
  }

  function readinessEvent(worker: UIWorkerHandle, event: ReadinessEvent): void {
    const readiness = worker.readiness;
    if (!readiness) return;
    executeReadinessCommands(worker, readiness.handle(event));
  }

  function executeReadinessCommands(worker: UIWorkerHandle, cmds: ReadinessCommand[]): void {
    for (const cmd of cmds) {
      switch (cmd.type) {
        case 'broadcast':
          broadcastWorkerStatus(
            worker,
            worker.respawning ? 'initializing' : worker.retired ? 'error' : worker.busy ? 'running' : 'idle',
          );
          break;
        case 'start-timer': {
          const existing = readinessTimers.get(cmd.timerId);
          if (existing) clearTimeout(existing);
          readinessTimers.set(cmd.timerId, setTimeout(() => {
            readinessTimers.delete(cmd.timerId);
            readinessEvent(worker, { type: 'grace-elapsed', timerId: cmd.timerId });
          }, cmd.ms));
          break;
        }
        case 'clear-timer': {
          const existing = readinessTimers.get(cmd.timerId);
          if (existing) { clearTimeout(existing); readinessTimers.delete(cmd.timerId); }
          break;
        }
        case 'send-prepare': {
          const project = cmd.projectName ? ctx.projects?.find((p) => p.name === cmd.projectName) : undefined;
          const activityId = `prepare-${worker.id}-${cmd.prepareId}`;
          worker.prepareActivityId = activityId;
          worker.prepareDeviceCount = runDeviceCount(ctx.config, project?.use as RunFileUseOptions | undefined);
          pushActivity({
            type: 'device-activity', id: activityId, workerId: worker.id, kind: 'prepare', status: 'started',
            label: `Prepare device (${describePolicyShort(cmd.target)})`, policy: cmd.target, forFile: cmd.forFile, timestamp: Date.now(),
          });
          try {
            worker.process.send({
              type: 'prepare',
              prepareId: cmd.prepareId,
              policy: cmd.target,
              projectUseOptions: project?.use as RunFileUseOptions | undefined,
              projectName: cmd.projectName,
              forFile: cmd.forFile,
            } satisfies UIWorkerMessage);
          } catch (err) {
            readinessEvent(worker, { type: 'prepare-failed', prepareId: cmd.prepareId, message: err instanceof Error ? err.message : String(err), cancelled: false });
          }
          break;
        }
        case 'send-cancel-prepare':
          try {
            worker.process.send({ type: 'cancel-prepare', prepareId: cmd.prepareId } satisfies UIWorkerMessage);
          } catch { /* IPC closed */ }
          break;
      }
    }
  }

  function describePolicyShort(policy: AppResetPolicy): string {
    if (policy.appState) return `restore ${path.basename(policy.appState)}`;
    if (policy.appState === '') return 'clear';
    return policy.mode;
  }

  function pushActivity(msg: DeviceActivityMessage): void {
    const idx = deviceActivityBuffer.findIndex((m) => m.id === msg.id);
    if (idx >= 0) deviceActivityBuffer[idx] = msg;
    else {
      deviceActivityBuffer.push(msg);
      if (deviceActivityBuffer.length > MAX_ACTIVITY_BUFFER) deviceActivityBuffer.shift();
    }
    broadcast(msg);
  }

  /**
   * A worker learned something new about its device (a reset detected hooks
   * the startup probe missed). Upgrade-only merge, then let readiness
   * re-evaluate: a `ready` prepared under the old resolution may no longer
   * be what the likely-next file wants.
   */
  function upgradeWorkerCapabilities(worker: UIWorkerHandle, capabilities: ResetCapabilities): void {
    const merged = mergeResetCapabilities(worker.capabilities, capabilities);
    if (JSON.stringify(merged) === JSON.stringify(worker.capabilities)) return;
    worker.capabilities = merged;
    if (!worker.retired) readinessEvent(worker, { type: 'candidate-changed' });
  }

  /** Messages a worker sends outside a run dispatch (background preparation). */
  function handleIdleWorkerMessage(worker: UIWorkerHandle, msg: UIWorkerChildMessage): void {
    switch (msg.type) {
      case 'capabilities':
        upgradeWorkerCapabilities(worker, msg.capabilities);
        break;
      case 'prepared': {
        const started = worker.readiness?.state;
        readinessEvent(worker, { type: 'prepared', prepareId: msg.prepareId, policy: msg.policy, startedAt: msg.startedAt, durationMs: msg.durationMs, satisfiedBy: msg.satisfiedBy });
        if (worker.prepareActivityId) {
          pushActivity({
            type: 'device-activity', id: worker.prepareActivityId, workerId: worker.id, kind: 'prepare', status: 'completed',
            label: `Prepared device (${describePolicyShort(msg.policy)})`, detail: msg.steps.join(' · '), policy: msg.policy,
            forFile: started?.kind === 'preparing' ? started.forFile : undefined, timestamp: msg.startedAt, durationMs: msg.durationMs,
          });
          worker.prepareActivityId = undefined;
        }
        lastProgressByWorker.delete(worker.id);
        break;
      }
      case 'prepare-failed': {
        readinessEvent(worker, { type: 'prepare-failed', prepareId: msg.prepareId, message: msg.error.message, cancelled: msg.cancelled });
        if (worker.prepareActivityId) {
          const existing = deviceActivityBuffer.find((m) => m.id === worker.prepareActivityId);
          pushActivity({
            type: 'device-activity', id: worker.prepareActivityId, workerId: worker.id, kind: 'prepare',
            status: msg.cancelled ? 'cancelled' : 'error',
            label: existing?.label ?? 'Prepare device', detail: msg.cancelled ? 'cancelled' : msg.error.message,
            policy: existing?.policy, forFile: existing?.forFile, timestamp: existing?.timestamp ?? Date.now(),
            durationMs: existing ? Date.now() - existing.timestamp : undefined,
          });
          worker.prepareActivityId = undefined;
        }
        lastProgressByWorker.delete(worker.id);
        break;
      }
      case 'progress':
        // Outside a run the label describes the background preparation.
        if (!worker.busy) {
          if (msg.message) lastProgressByWorker.set(worker.id, msg.message);
          else lastProgressByWorker.delete(worker.id);
          readinessEvent(worker, { type: 'progress', detail: msg.message || undefined });
          if (worker.prepareActivityId && msg.message) {
            const existing = deviceActivityBuffer.find((m) => m.id === worker.prepareActivityId);
            if (existing) pushActivity({ ...existing, detail: msg.message });
          }
        }
        break;
      default:
        break;
    }
  }

  function invalidateWorkers(reason: StaleReason, workerIds?: number[]): void {
    for (const w of uiWorkers) {
      if (w.retired) continue;
      if (workerIds && !workerIds.includes(w.id)) continue;
      readinessEvent(w, { type: 'invalidate', reason });
    }
  }

  /** A mirror gesture: bump the interactive poll rate, invalidate the device, and log a coalesced activity entry. */
  function noteMirrorInteraction(workerId: number | undefined, kind: string): void {
    lastMirrorInteraction = Date.now();
    const id = workerId ?? selectedWorkerId;
    invalidateWorkers('mirror-gesture', [id]);
    const now = Date.now();
    let burst = mirrorBursts.get(id);
    if (!burst || now - burst.last > 2_000) {
      burst = { id: `mirror-${id}-${now}`, counts: new Map(), startedAt: now, last: now };
      mirrorBursts.set(id, burst);
    }
    burst.last = now;
    burst.counts.set(kind, (burst.counts.get(kind) ?? 0) + 1);
    const label = 'Mirror: ' + [...burst.counts].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
    pushActivity({ type: 'device-activity', id: burst.id, workerId: id, kind: 'mirror', status: 'completed', label, timestamp: burst.startedAt, durationMs: now - burst.startedAt });
  }

  /** Route an MCP device interaction to the worker(s) it touched. */
  function invalidateForMcpTool(tool: string, args: Record<string, unknown> | undefined): void {
    if (!MUTATING_MCP_TOOLS.has(tool)) return;
    const projectName = typeof args?.project === 'string' ? args.project : undefined;
    const bucket = projectName ? ctx.bucketByProject?.get(projectName) : undefined;
    const targets = bucket ? uiWorkers.filter((w) => w.bucketSignature === bucket).map((w) => w.id) : undefined;
    invalidateWorkers('mcp-tool', targets);
  }

  let screenPollTimer: ReturnType<typeof setTimeout> | null = null;
  let screenSeq = 0;
  let screenPollActive = false;
  let watcher: FSWatcher | null = null;
  let discoveryWatcher: FSWatcher | null = null;
  const pendingDiscoveryFiles = new Set<string>();
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveryBatchRunning = false;
  const discoveredFileNodes = new Map<string, TestTreeNode>();
  // Normalised paths whose source we've served to clients (Source-tab preview).
  // Edits to these are re-broadcast so a not-yet-run test's source stays live.
  const servedSourcePaths = new Set<string>();
  const resolvedRootDir = path.resolve(ctx.config.rootDir);
  const resolvedOutputDir = path.resolve(resolvedRootDir, ctx.config.outputDir);
  /** A single watched entry: optional project scope + optional test filter.
   * testFilter = undefined means "whole file"; projectName = undefined means
   * "whichever project this file resolves to" (non-multi-project configs). */
  interface WatchedEntry { projectName?: string; testFilter?: string }
  type DiscoveryRefreshResult = { treeChanged: boolean; shouldRun: boolean };
  async function forEachWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);

    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) return;
        await fn(items[index], index);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }
  /** filePath → list of watched entries. chokidar adds the file when the
   * first entry appears and removes it when the last entry is cleared. */
  const watchedEntries = new Map<string, WatchedEntry[]>();
  function entryKey(e: WatchedEntry): string {
    // JSON-encode both fields so a test name containing '::' (or any other
    // delimiter) can't collide with a project-name / filter pair that
    // happens to produce the same concatenated string.
    return JSON.stringify([e.projectName ?? null, e.testFilter ?? null]);
  }
  function findEntry(filePath: string, projectName: string | undefined, testFilter: string | undefined): number {
    const list = watchedEntries.get(filePath);
    if (!list) return -1;
    const key = entryKey({ projectName, testFilter });
    return list.findIndex((e) => entryKey(e) === key);
  }

  // ─── Worker state ───
  // Every UI session runs through persistent ui-worker.ts processes — one per
  // device. A single device is one worker that *adopts* the daemon/agent the
  // CLI already provisioned (no second daemon, no second cold launch, and a
  // process that outlives the run so the device can be prepared between runs).
  const workerGroups: string[][] = ctx.workerGroups && ctx.workerGroups.length > 0
    ? ctx.workerGroups
    : ctx.deviceSerials && ctx.deviceSerials.length > 0
      ? ctx.deviceSerials.map((s) => [s])
      : (ctx.deviceSerial ? [[ctx.deviceSerial]] : []);
  const workerSerials: string[] = workerGroups.map((g) => g[0]);
  const workersEnabled = workerSerials.length > 0;
  /** Progress label last reported by each worker (replayed to late clients). */
  const lastProgressByWorker = new Map<number, string>();
  // ─── Device readiness (background preparation) ───
  // Config-declared defaults seed the session; a person's explicit choice in
  // the UI (persisted in their browser and pushed via set-preferences on
  // connect) still wins for that session.
  const configPreferences: Partial<UIPreferences> = {};
  if (ctx.config.ui?.prepareBetweenRuns !== undefined) configPreferences.prepareBetweenRuns = ctx.config.ui.prepareBetweenRuns;
  if (ctx.config.ui?.prepareDelayMs !== undefined) configPreferences.prepareDelayMs = ctx.config.ui.prepareDelayMs;
  let preferences: UIPreferences = { ...DEFAULT_UI_PREFERENCES, ...configPreferences };
  const readinessTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const deviceActivityBuffer: DeviceActivityMessage[] = [];
  const MAX_ACTIVITY_BUFFER = 200;
  /** Node the client has selected — the strongest hint for what runs next. */
  let selectedNode: { file: string; projectName?: string } | undefined;
  let lastRunProject: string | undefined;
  /** Per run: when the first traced action landed, and how the first file's isolation was satisfied. */
  let runFirstActionAt: number | undefined;
  let runPreflightOrigin: 'prepared' | 'inline' | 'skipped' | undefined;
  /** Coalesced mirror-gesture bursts per worker for the activity feed. */
  const mirrorBursts = new Map<number, { id: string; counts: Map<string, number>; startedAt: number; last: number }>();
  const MUTATING_MCP_TOOLS = new Set(['tapsmith_tap', 'tapsmith_type', 'tapsmith_swipe', 'tapsmith_press_key', 'tapsmith_launch_app']);
  /** Mirror interactions within this window hold background preparation. */
  const READINESS_INTERACTION_HOLD_WINDOW_MS = 3_000;
  /** Workers whose Node process should be recycled before the next run (source changed). */
  let recycleTimer: NodeJS.Timeout | null = null;
  const launchProgress = options.launchProgress;
  const uiWorkers: UIWorkerHandle[] = [];
  let workersInitialized = false;
  /** Which worker's device to mirror. Defaults to 0. */
  let selectedWorkerId = 0;
  let lastMirrorInteraction = 0;
  const INTERACTION_WINDOW_MS = 2000;
  const INTERACTIVE_POLL_MS = 90;
  /** Screen view mode: 'all' polls all workers, number polls a specific worker. */
  let screenViewMode: 'all' | number = 'all';
  /** Last known frame dimensions per mirrored device (`mirrorKey`), used to convert normalized coords. */
  const lastFrameDims = new Map<string, { width: number; height: number }>();
  /** Which device of the selected worker's group the single-view mirror shows. */
  let selectedDeviceIndex = 0;
  /** Set to true while a parallel run is in progress, to signal stop. */
  let parallelRunAborted = false;
  /** True from the moment the user requests a stop until the next run starts.
   * Read by the single-worker file loops (so a stop ends the whole run, not
   * just the current file) and by endRun to report status 'stopped'. */
  let stopRequested = false;
  /** Grace timer between graceful abort and SIGKILL escalation. */
  let stopEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Settles the in-flight parallel dispatch promise (escalation). */
  let forceSettleDispatch: (() => void) | null = null;
  /** Tests killed mid-flight by the current stop (reported separately). */
  let interruptedCount = 0;
  /** Final result of the most recently completed run. */
  let lastRunEnd: TestRunResult | null = null;
  /** Callers (MCP stop_tests) waiting for the in-flight run to end. */
  const runEndWaiters: Array<(r: TestRunResult) => void> = [];

  // Detect whether meaningful projects are configured (not just a synthesized
  // one). Keyed on the flag rather than the name for the same reason as
  // `projectLabel`: a config may genuinely name its only project "default".
  const hasRealProjects = ctx.projects != null
    && ctx.projects.length > 0
    && !(ctx.projects.length === 1 && ctx.projects[0].synthesized);

  // Build file → project lookup. Note: when the same file matches multiple
  // projects (e.g. an Android and an iOS project both using `**\/*.test.ts`),
  // the last project wins here. Callers that need the project explicitly —
  // for example because the user clicked a test under a specific project tree
  // node — should pass `projectName` and use `projectForFile()` instead.
  const fileToProject = new Map<string, ResolvedProject>();
  if (ctx.projects) {
    for (const project of ctx.projects) {
      for (const file of project.testFiles) {
        fileToProject.set(file, project);
      }
    }
  }

  /** Resolve a project for a file, preferring an explicit project name when
   * supplied. This is the right call when the same file may live under
   * multiple projects (multi-device configs). */
  function projectForFile(filePath: string, projectName?: string): ResolvedProject | undefined {
    if (projectName && ctx.projects) {
      const byName = ctx.projects.find((p) => p.name === projectName);
      if (byName) return byName;
    }
    return fileToProject.get(filePath);
  }

  const serializedConfig: SerializedConfig = {
    ...serializeConfig(ctx.config),
    // UI mode always enables tracing for the trace viewer
    trace: typeof ctx.config.trace === 'string' || typeof ctx.config.trace === 'object'
      ? ctx.config.trace
      : 'on',
  };

  // Resolve a friendly display name AND the effective platform for single-worker
  // mode. The root config's platform may be unset when the platform is specified
  // per-project, so we also infer from device lookups and project configs.
  const { singleWorkerDisplayName, singleWorkerPlatform } = (() => {
    const serial = ctx.deviceSerial;
    const fallback = { singleWorkerDisplayName: serial, singleWorkerPlatform: ctx.config.platform };
    if (!serial) return { singleWorkerDisplayName: undefined, singleWorkerPlatform: ctx.config.platform };

    // iOS simulator: simctl lists all available sims regardless of root config.
    // Guard on macOS (these commands don't exist on Linux/Windows) and on an
    // iOS-shaped UDID — sim UUIDs and modern physical UDIDs start with 8 hex
    // chars + dash; pre-iPhone-XS physical UDIDs are 40 hex chars, no dash —
    // so Android-only sessions skip the simctl/devicectl execs.
    if (process.platform === 'darwin' && (/^[0-9A-Fa-f]{8}-/.test(serial) || /^[0-9A-Fa-f]{40}$/.test(serial))) {
      const simName = listSimulators().find((s) => s.udid === serial)?.name;
      if (simName) return { singleWorkerDisplayName: simName, singleWorkerPlatform: 'ios' as const };

      // iOS physical device: devicectl finds connected devices.
      const physName = listPhysicalDevices().find((d) => d.udid === serial)?.name;
      if (physName) return { singleWorkerDisplayName: physName, singleWorkerPlatform: 'ios' as const };
    }

    // Android emulator
    if (serial.startsWith('emulator-')) {
      return { singleWorkerDisplayName: getRunningAvdName(serial) ?? serial, singleWorkerPlatform: 'android' as const };
    }

    // Fall back to root config, then project configs
    if (ctx.config.platform) return fallback;
    const projectPlatform = ctx.projects?.find((p) => p.effectiveConfig.platform)?.effectiveConfig.platform;
    if (projectPlatform) return { singleWorkerDisplayName: serial, singleWorkerPlatform: projectPlatform };
    return fallback;
  })();

  // Resolve child scripts (compiled .js in a dist install, .ts under tsx)
  const jsWorkerScript = path.resolve(import.meta.dirname, 'ui-worker.js');
  const tsWorkerScript = path.resolve(import.meta.dirname, 'ui-worker.ts');
  const resolvedWorkerScript = !fs.existsSync(jsWorkerScript) && fs.existsSync(tsWorkerScript)
    ? tsWorkerScript
    : jsWorkerScript;

  const jsDiscoverScript = path.resolve(import.meta.dirname, 'ui-discover.js');
  const tsDiscoverScript = path.resolve(import.meta.dirname, 'ui-discover.ts');
  const resolvedDiscoverScript = !fs.existsSync(jsDiscoverScript) && fs.existsSync(tsDiscoverScript)
    ? tsDiscoverScript
    : jsDiscoverScript;

  // The loader has to follow the *test files*: these children import them, and
  // a compiled install runs .js scripts against a TypeScript suite. Deciding
  // from our own scripts alone only works while something upstream (the CLI's
  // tsx re-exec, via NODE_OPTIONS) happens to have set a loader for us.
  // import.meta.dirname is packages/tapsmith/{src,dist}/ui-mode — the package
  // root (where node_modules lives) is two levels up in both cases.
  const childScripts = [resolvedDiscoverScript, resolvedWorkerScript];
  const tapsmithPkgDir = path.resolve(import.meta.dirname, '..', '..');
  let tsxBin = resolveChildLoader(
    childScripts,
    ctx.testFiles,
    tapsmithPkgDir,
    (message) => console.error(`Warning: ${message}`),
  );

  /**
   * The loader for a fork, resolved lazily.
   *
   * A UI session started with no TypeScript tests needs no loader — until the
   * user writes one, which the watcher adds to `ctx.testFiles` at runtime. A
   * loader decided once at startup would fork that file under bare node, so it
   * silently drops out of the test tree until the server is restarted.
   */
  let warnedAboutMissingTsx = false;
  function childLoader(files: string[] = ctx.testFiles): string | undefined {
    if (tsxBin) return tsxBin;
    tsxBin = resolveChildLoader(
      childScripts,
      files,
      tapsmithPkgDir,
      (message) => {
        // Only the first time: this runs per fork, so an unresolvable tsx
        // would otherwise print once per test file during discovery.
        if (warnedAboutMissingTsx) return;
        warnedAboutMissingTsx = true;
        console.error(`Warning: ${message}`);
      },
    );
    return tsxBin;
  }

  // ─── Broadcast ───

  function broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Catch handler that broadcasts the error to connected clients. */
  function broadcastError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    broadcast({ type: 'error', message });
  }

  function sendSourceFromDisk(filePath: string): void {
    // A malformed WebSocket message could omit `path` or send a non-string;
    // path.resolve(undefined) would throw and take down the server.
    if (typeof filePath !== 'string') return;
    const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
    // Only serve known test files — never an arbitrary client-supplied path.
    // Guards against path traversal / arbitrary file reads over the WebSocket.
    // Resolve both sides so separator/relative-path differences (e.g. Windows)
    // can't bypass the allowlist, and read from the trusted matched entry.
    // Anchor relative paths to the project root (not process.cwd(), which may
    // differ from where tests were discovered). Absolute paths are unaffected.
    const resolved = path.resolve(resolvedRootDir, filePath);
    // On case-insensitive filesystems (macOS/Windows) a path that differs only
    // in casing (e.g. drive letter `c:` vs `C:`) still refers to the same file,
    // so compare case-insensitively there to avoid rejecting a known test file.
    const caseInsensitiveFs = process.platform === 'darwin' || process.platform === 'win32';
    const eq = (a: string, b: string): boolean =>
      caseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
    const isKnown = ctx.testFiles.some((f) => eq(path.resolve(resolvedRootDir, f), resolved));
    if (!isKnown) return;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return;
      const content = fs.readFileSync(resolved, 'utf-8');
      const normalizedPath = resolved.replace(/\\/g, '/');
      const sourceMsg: SourceMessage = {
        type: 'source',
        path: normalizedPath,
        fileName: path.basename(resolved),
        content,
      };
      servedSourcePaths.add(normalizedPath);
      broadcast(sourceMsg);
    } catch {
      // best-effort — file may be unreadable or missing
    }
  }

  function broadcastBinary(data: Buffer): void {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  // ─── MCP Server (SSE) ───

  function collectFailures(): import('../mcp/test-dispatcher.js').TestFailureDetail[] {
    return [...testResults.values()]
      // A stop is not a failure — same rule the headless dispatcher applies.
      .filter((r) => r.status === 'failed' && r.error && !isInterruptedEntry(r))
      .map((r) => ({
        fullName: r.fullName,
        filePath: r.filePath,
        error: r.error!,
        tracePath: r.tracePath,
        projectName: r.projectName,
      }));
  }

  function withFailures(result: TestRunResult): TestRunResult {
    if (result.failed > 0) result.failures = collectFailures();
    return result;
  }

/**
 * The status the UI client's tree understands.
 *
 * That tree has no 'interrupted' node state — a stopped test has always shown
 * there as failed, and its interrupted *count* is reported separately. This
 * store holds raw runner statuses anyway, so the mapping is a formality; it
 * exists to keep the wire type honest rather than casting the difference away.
 */
function wireStatus(status: TestResultEntry['status']): TestNodeStatus {
  return status === 'interrupted' ? 'failed' : status;
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
    if (node.use) entry.use = node.use;
    // A `use.devices` project names its members so an MCP consumer learns
    // both that the tests need a group and what to pass as `device`.
    if (node.type === 'project') {
      const project = realProjects().find((p) => p.name === node.name);
      const devices = project ? deviceGroupNames(project.effectiveConfig) : undefined;
      if (devices) entry.devices = devices;
    }
    return entry;
  }

  /**
   * Projects a caller can actually name. A config that declares none gets one
   * synthesized for it called "default", which is an implementation detail —
   * but a config that genuinely names a project "default" must still be listed,
   * or its files look project-less and cannot be targeted by name.
   */
  function realProjects(): ResolvedProject[] {
    return (ctx.projects ?? []).filter((p) => !p.synthesized);
  }

  /**
   * Map a caller's file arguments onto discovered test files. MCP callers pass
   * project-relative paths and globs as readily as absolute ones; matching on
   * exact absolute paths alone silently ran nothing.
   */
  function resolveRequested(files: string[]): string[] {
    const roots = [ctx.config.rootDir, process.cwd()].filter((r): r is string => Boolean(r));
    return matchRequestedFiles(files, ctx.testFiles, roots);
  }

  const testDispatcher: TestDispatcher = {
    async runFiles(files, options) {
      if (workersEnabled) await ensureWorkersReady();
      const { testFilter, project } = options ?? {};
      const validFiles = resolveRequested(files);
      if (validFiles.length === 0) {
        return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
      }
      if (validFiles.length === 1) return withFailures(await runFile(validFiles[0], testFilter, project));
      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      let stopped = false;
      // Each runFile() clears testResults at the start of its own run, so the
      // map only ever holds the most recent file's results. Snapshot each
      // file's results as it finishes and re-seed the union after the loop so
      // getResults()/collectFailures() (and thus list_results) reflect the
      // whole multi-file run, not just the last file.
      const accumulated: UITestResultEntry[] = [];
      for (const f of validFiles) {
        const r = await runFile(f, testFilter, project);
        accumulated.push(...testResults.values());
        totalPassed += r.passed;
        totalFailed += r.failed;
        totalSkipped += r.skipped;
        totalDuration += r.duration;
        // Checked AFTER each file: a stop during file N must not start file
        // N+1 (each runFile resets the flag when its run begins).
        if (stopRequested || r.status === 'stopped') { stopped = true; break; }
      }
      testResults.clear();
      for (const entry of accumulated) testResults.set(resultEntryKey(entry), entry);
      return withFailures({
        status: stopped ? 'stopped' : totalFailed > 0 ? 'failed' : 'passed',
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        duration: totalDuration,
      });
    },
    async runAll() {
      if (workersEnabled) await ensureWorkersReady();
      return withFailures(await runAllFiles());
    },
    stop() {
      stopRun();
    },
    waitForRunEnd(timeoutMs: number): Promise<TestRunResult | null> {
      if (!isRunning) return Promise.resolve(lastRunEnd);
      return new Promise((resolve) => {
        const waiter = (r: TestRunResult): void => {
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          // Drop the stale waiter so repeated polls of a wedged run don't
          // accumulate closures until the run finally ends.
          const idx = runEndWaiters.indexOf(waiter);
          if (idx >= 0) runEndWaiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        runEndWaiters.push(waiter);
      });
    },
    isRunning: () => isRunning,
    getResults: () => [...testResults.values()].map(classifyEntryStatus),
    getTestFiles: () => ctx.testFiles,
    resolveRequestedFiles: (files) => resolveRequested(files),
    getProjects: () => realProjects().map((p) => p.name),
    getTestTree: () => testTree.map(toTreeEntry),
    getDiscoveryErrors: (): DiscoveryError[] =>
      [...discoveryErrors].map(([filePath, error]) => ({ filePath, error })),
    getSessionInfo: (): SessionInfo => {
      const projects = realProjects().map((p) => ({
        name: p.name,
        platform: p.effectiveConfig.platform,
        package: p.effectiveConfig.package,
        testFiles: p.testFiles,
        dependencies: p.dependencies,
        devices: deviceGroupNames(p.effectiveConfig),
      }));
      // The same per-platform view the headless dispatcher reports, with a
      // `use.devices` group listed member by member under its project.
      // Workers spawn on the first run, so before then this is the primary
      // device and the members the CLI opened beside it — which is genuinely
      // all the session is driving at that point.
      const live = uiWorkers.filter((w) => !w.retired);
      const primaryPlatform = singleWorkerPlatform ?? ctx.config.platform;
      const deviceTargets: DeviceTarget[] = live.length > 0
        ? live.flatMap((w) => {
            const platform = resolveWorkerPlatform(ctx, w);
            const devices = workerDevicesInfo(w);
            if (devices.length === 1) return [{ platform, device: w.deviceSerial }];
            const group = groupProjectName(w.deviceSerial);
            return devices.map((d) => ({ platform, device: d.deviceSerial, name: d.name, group }));
          })
        : ctx.deviceSerial
          ? ctx.deviceGroup.length > 1
            ? [
                { platform: primaryPlatform, device: ctx.deviceSerial, name: ctx.deviceGroup[0].name, group: groupProjectName(ctx.deviceSerial) },
                ...(ctx.primaryGroupMembers ?? []).map((m) => ({
                  platform: primaryPlatform, device: m.serial, name: m.name, group: groupProjectName(ctx.deviceSerial!),
                })),
              ]
            : [{ platform: primaryPlatform, device: ctx.deviceSerial }]
          : [];
      return {
        platform: singleWorkerPlatform ?? ctx.config.platform,
        package: ctx.config.package,
        device: singleWorkerDisplayName ?? ctx.deviceSerial,
        timeout: ctx.config.timeout,
        retries: ctx.config.retries,
        projects,
        deviceTargets,
        configPath: ctx.configPath,
      };
    },
    async deviceChoiceError(files, device, project) {
      // What `validateProjectChoice` refuses by name — an unknown project, a
      // file under several projects with none named — and files that match
      // nothing (the run names them) are left to it, as headless does; a
      // device refusal would hide the real problem.
      const requested = resolveRequested(files);
      const projects = realProjects();
      if (requested.length === 0) return null;
      if (project !== undefined && !projects.some((p) => p.name === project)) return null;
      if (project === undefined && requested.some((f) => projects.filter((p) => p.testFiles.includes(f)).length > 1)) return null;
      let serial: string;
      try {
        serial = testDispatcher.resolveDeviceName(device, project) ?? device;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const live = uiWorkers.filter((w) => !w.retired);
      // Workers spawn on the first run; until then, the ones planned — the
      // session info lists only the CLI's primary then.
      const workers = live.length > 0
        ? live.map((w) => ({ bucket: w.bucketSignature, devices: workerDevicesInfo(w).map((d) => d.deviceSerial) }))
        : workerGroups.map((g) => ({ bucket: ctx.bucketByDevice?.get(g[0]), devices: g }));
      // A multi-target session routes each file to a worker of its own target.
      const fileProjects = requested.flatMap((f) => (project !== undefined
        ? [project]
        : projects.filter((p) => p.testFiles.includes(f)).map((p) => p.name)));
      const fileBuckets = new Set(fileProjects.map((name) => ctx.bucketByProject?.get(name)));
      return uiDeviceChoiceError({ device, serial, workers, fileBuckets });
    },
    resolveDeviceName(name, project) {
      // Live workers first (each lists its group, primary first); before the
      // workers spawn, the primary the CLI set up and the members it opened.
      // With `project`, only the worker(s) driving that project's group: two
      // groups routinely both have an `alice`, and `device` wins over
      // `project` in the target resolver.
      const inScope = (owner: string | undefined) => project === undefined || owner === project;
      const matches: Array<{ project: string | undefined; serial: string }> = [];
      for (const worker of uiWorkers) {
        if (worker.retired) continue;
        const owner = groupProjectName(worker.deviceSerial);
        if (!inScope(owner)) continue;
        const match = workerDevicesInfo(worker).find((d) => d.name === name);
        if (match) matches.push({ project: owner, serial: match.deviceSerial });
      }
      if (matches.length === 0 && ctx.deviceSerial && inScope(groupProjectName(ctx.deviceSerial))) {
        const owner = groupProjectName(ctx.deviceSerial);
        if (ctx.deviceGroup[0]?.name === name) matches.push({ project: owner, serial: ctx.deviceSerial });
        const member = ctx.primaryGroupMembers?.find((m) => m.name === name);
        if (member) matches.push({ project: owner, serial: member.serial });
      }
      return pickResolvedDeviceName(name, matches);
    },

    toggleWatch(filePath, options) {
      const { testFilter, project } = options ?? {};
      const isWatched = findEntry(filePath, project, testFilter) >= 0;
      if (isWatched) {
        stopWatching(filePath, project, testFilter);
        return { enabled: false };
      }
      startWatching(filePath, project, testFilter);
      return { enabled: true };
    },
  };

  const mcpEvents = new McpEventEmitter();
  let mcpPort = 0;

  // This process *is* the UI server, so the worker daemons its MCP sessions
  // discover are its own. Only a UI-mode server may adopt them; a headless one
  // gets its own daemon and device (see `configureMcpConnection`).
  // With the config this server was launched with: `configureMcpConnection`
  // states a whole configuration, so omitting it left `discover()` re-finding
  // one from the cwd. A daemon started for the MCP endpoint of
  // `tapsmith test --ui -c configs/ci.config.ts` would then get its device and
  // agent artifacts from whatever config the working directory happened to hold.
  configureMcpConnection({ uiMode: true, configFile: ctx.configPath });

  // PILOT-221: route MCP over per-session transports so dropped clients can
  // reconnect and multiple agents can attach to this one device session. The
  // router shares `mcpEvents` + `testDispatcher` across every session.
  const mcpRouter = new McpSessionRouter({
    name: 'tapsmith-ui',
    events: mcpEvents,
    dispatcher: testDispatcher,
    onClientsChanged: () => { broadcast(getMcpStatus()); },
  });

  function getMcpStatus(): ServerMessage {
    const clients = mcpRouter.clientList;
    return {
      type: 'mcp-status' as const,
      running: true,
      mcpUrl: mcpPort ? `http://localhost:${mcpPort}/mcp` : undefined,
      clientName: clients[0]?.name,
      clientVersion: clients[0]?.version,
      connectedCount: clients.length,
      clients,
    };
  }

  mcpEvents.onToolCall((event) => {
    const mcpMsg: McpToolCallMessage = { type: 'mcp-tool-call', ...event };
    if (mcpToolCallBuffer.length < MAX_MCP_BUFFER) mcpToolCallBuffer.push(mcpMsg);
    broadcast(mcpMsg);
    if (event.status !== 'started') invalidateForMcpTool(event.tool, event.args);
  });

  // ─── Test Discovery ───

  /** Files that failed to load, so a caller is not left with a silently short list. */
  const discoveryErrors = new Map<string, string>();

  async function discoverFile(filePath: string): Promise<TestTreeNode | null> {
    // Resolved once: a miss re-runs the filesystem and PATH probes, and this
    // is called for every discovered file.
    const fileLoader = childLoader([filePath]);
    return new Promise((resolve) => {
      const child = fork(resolvedDiscoverScript, [], {
        stdio: forkStdioForLaunchProgress(launchProgress),
        ...(fileLoader ? { execPath: fileLoader } : {}),
        env: {
          ...process.env,
          NODE_PATH: path.resolve(import.meta.dirname, '..', '..'),
        },
      });
      pipeForkOutputForLaunchProgress(child, launchProgress);

      let settled = false;

      child.on('message', (response: UIDiscoverChildMessage) => {
        if (settled) return;
        settled = true;

        if (response.type === 'discover-result') {
          discoveryErrors.delete(filePath);
          resolve(response.tree);
        } else {
          console.error(`Discovery error for ${filePath}: ${response.error.message}`);
          discoveryErrors.set(filePath, response.error.message);
          resolve(null);
        }
      });

      // A child that dies without messaging — a crash, an OOM, or an
      // `execPath` loader that cannot run — leaves the file with no tests and
      // no reason. Record why, or the file simply vanishes from the tree and
      // looks like one that genuinely holds none.
      child.on('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          discoveryErrors.set(
            filePath,
            `Discovery process exited without a result (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
          );
          resolve(null);
        }
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          discoveryErrors.set(filePath, `Discovery process failed to start: ${err.message}`);
          resolve(null);
        }
      });

      const msg: UIDiscoverMessage = { type: 'discover', filePath };
      child.send(msg);
    });
  }

  /** Deep-clone a discovered tree node, prefixing every id so the same file
   * appearing under multiple projects gets independent expansion / status
   * state on the client. A node's `use` is its own declaration only: what
   * the project declares sits on the project row (`projectTreeUse`), not on
   * every row under it. */
  function cloneNodeWithIdPrefix(node: TestTreeNode, prefix: string): TestTreeNode {
    return {
      ...node,
      id: `${prefix}${node.id}`,
      children: node.children?.map((c) => cloneNodeWithIdPrefix(c, prefix)),
    };
  }

  /**
   * Project `use` is the base layer under a file's own `test.use()` cascade
   * (mirrors runner.ts: `rootCtx.useOptions = { ...projectUse, ...fileUse }`).
   * Only the isolation-relevant keys travel to the client.
   */
  function rebuildTestTreeFromDiscoveredFiles(): void {
    // Group into project nodes when projects are configured
    if (hasRealProjects && ctx.projects) {
      const trees: TestTreeNode[] = [];
      for (const project of ctx.projects) {
        const idPrefix = `project::${project.name}::`;
        const projectFiles = project.testFiles
          .map((f) => discoveredFileNodes.get(f))
          .filter((n): n is TestTreeNode => n != null)
          // Deep-clone so each project owns its own nodes (unique ids,
          // independent expansion state, scoped status updates).
          .map((n) => cloneNodeWithIdPrefix(n, idPrefix));

        if (projectFiles.length === 0) continue;

        const use = projectTreeUse(project);
        trees.push({
          id: `project::${project.name}`,
          type: 'project',
          name: project.name,
          filePath: '',
          fullName: project.name,
          status: 'idle',
          children: projectFiles,
          dependencies: project.dependencies.length > 0 ? project.dependencies : undefined,
          ...(use ? { use } : {}),
        });
      }
      testTree = trees;
    } else {
      // No meaningful projects — flat file list
      testTree = ctx.testFiles
        .map((f) => discoveredFileNodes.get(f))
        .filter((n): n is TestTreeNode => n != null);
    }
  }

  async function discoverAllFiles(): Promise<void> {
    // Discover all files first
    launchProgress?.start('test-tree', `discovering ${ctx.testFiles.length} file(s)`);
    discoveredFileNodes.clear();
    const files = [...ctx.testFiles];
    let completed = 0;

    await forEachWithConcurrency(files, MAX_DISCOVERY_BATCH_CONCURRENCY, async (file) => {
      launchProgress?.update('test-tree', {
        state: 'running',
        detail: `discovering ${path.basename(file)}`,
        progress: { done: completed, total: files.length },
      });
      const tree = await discoverFile(file);
      if (tree) {
        discoveredFileNodes.set(file, tree);
      }
      completed += 1;
      launchProgress?.update('test-tree', {
        state: 'running',
        detail: `discovered ${path.basename(file)}`,
        progress: { done: completed, total: files.length },
      });
    });

    rebuildTestTreeFromDiscoveredFiles();
    broadcast({ type: 'test-tree', files: testTree });
    launchProgress?.complete('test-tree', `${discoveredFileNodes.size}/${ctx.testFiles.length} file(s) discovered`);
  }

  // ─── Test Execution (shared) ───

  function updateTestStatus(
    fullName: string,
    filePath: string,
    status: TestTreeNode['status'],
    duration?: number,
    error?: string,
    tracePath?: string,
    videoPath?: string,
    workerId?: number,
    projectName?: string,
  ): void {
    if (status === 'failed') failedFiles.add(filePath);

    const key = resultEntryKey({ projectName, filePath, fullName });
    testResults.set(key, { fullName, filePath, status, duration, error, tracePath, videoPath, projectName, workerId });

    broadcast({
      type: 'test-status',
      fullName,
      filePath,
      status,
      duration,
      error,
      tracePath,
      videoPath,
      workerId,
      projectName,
    });
  }

  /**
   * Record a file that failed before any test in it could report.
   *
   * The browser learns about this from an `error` broadcast, but nothing was
   * written to `testResults` — so `getResults()` came back empty and an MCP
   * client saw "No test results yet" moments after the run reported a failure,
   * with `suite_status` showing nothing at all. The headless dispatcher has
   * always recorded a synthetic entry here; this is the same one, so the same
   * board renders it and the same retirement drops it when the file runs.
   */
  function recordFileFailure(filePath: string, projectName: string | undefined, err: unknown): void {
    const entry = fileFailureEntry(filePath, projectName, err);
    failedFiles.add(filePath);
    testResults.set(resultEntryKey(entry), entry);
  }

  /** Broadcast a file-status update, optionally scoped to a project so the
   * client only updates that project's copy of the file node (multi-device
   * configs share the same file across projects). */
  function broadcastFileStatus(filePath: string, status: 'running' | 'done', projectName?: string): void {
    const key = JSON.stringify([filePath, projectName]);
    if (status === 'running') runningFiles.set(key, { filePath, projectName });
    else runningFiles.delete(key);
    broadcast({ type: 'file-status', filePath, status, projectName });
  }

  /**
   * Walk the test tree and broadcast 'skipped' status for every test under
   * a project whose dependency failed, so the UI shows them correctly.
   */
  function markProjectTestsSkipped(projectName: string): void {
    function markChildren(nodes: TestTreeNode[]): void {
      for (const node of nodes) {
        if (node.type === 'test') {
          updateTestStatus(node.fullName, node.filePath, 'skipped', undefined, undefined, undefined, undefined, undefined, projectName);
        }
        if (node.children) markChildren(node.children);
      }
    }

    for (const node of testTree) {
      if (node.type === 'project' && node.name === projectName && node.children) {
        markChildren(node.children);
        return;
      }
    }
  }

  /** Every run needs at least one live worker; without one, say so instead of hanging. */
  function reportNoWorkers(): TestRunResult {
    broadcast({ type: 'error', message: 'No test worker is available for this device — check the startup log, then use "Respawn worker".' });
    return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
  }

  async function runProjectOnly(projectName: string): Promise<void> {
    if (!ctx.projects) return;
    const target = ctx.projects.find((p) => p.name === projectName);
    if (!target) return;

    if (!useParallel()) { reportNoWorkers(); return; }
    if (isRunning) return;
    markRunStarted();
    clearRunBuffers();
    screenPollActive = true;
    parallelRunAborted = false;

    await ensureWorkersReady();

    const files: TaggedFile[] = target.testFiles.map((f) => ({
      filePath: f,
      projectUseOptions: target.use as RunFileUseOptions | undefined,
      projectName: projectLabel(target),
    }));

    broadcast({ type: 'run-start', fileCount: files.length });

    try {
      const r = await dispatchFilesParallel(files);
      endRun({
        status: r.anyFailed ? 'failed' : 'passed',
        duration: r.duration,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    } finally {
      markRunEnded();
      screenPollActive = false;
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // ─── Multi-worker execution (persistent ui-worker.ts processes)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Run a single `lsof` call to find PIDs listening on any of the given ports.
   * Returns a Map from port number to the list of PIDs on that port.
   */
  function collectListeningPids(ports: number[]): Map<number, number[]> {
    const result = new Map<number, number[]>();
    if (ports.length === 0) return result;
    try {
      // Use -F (field mode) to get PID + port associations from a single call.
      const fullArgs = ['-P', '-sTCP:LISTEN', '-F', 'pn', ...ports.map((p) => `-iTCP:${p}`)];
      const out = execFileSync('lsof', fullArgs, { encoding: 'utf-8' }).trim();
      let currentPid = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('n') && currentPid > 0) {
          // Lines look like "n*:50151" or "n127.0.0.1:50151"
          const colonIdx = line.lastIndexOf(':');
          if (colonIdx >= 0) {
            const port = Number(line.slice(colonIdx + 1));
            if (ports.includes(port)) {
              const existing = result.get(port) ?? [];
              if (!existing.includes(currentPid)) existing.push(currentPid);
              result.set(port, existing);
            }
          }
        }
      }
    } catch {
      // lsof failed or no matching processes — fine
    }
    return result;
  }

  /**
   * The group a worker's devices form, primary first: its bucket's config in
   * a multi-bucket session, the session's project group otherwise.
   */
  function workerDeviceGroup(deviceSerial: string): DeviceGroupEntry[] {
    return ctx.deviceGroupByDevice?.get(deviceSerial) ?? ctx.deviceGroup;
  }

  /** The `use.devices` project a worker's group belongs to — the `group` label in session info. */
  function groupProjectName(deviceSerial: string): string | undefined {
    const bucket = ctx.bucketByDevice?.get(deviceSerial);
    return realProjects().find((p) => deviceGroupSize(p.effectiveConfig) > 1
      && (bucket === undefined || ctx.bucketByProject?.get(p.name) === bucket))?.name;
  }

  /**
   * The primary device the CLI provisioned (daemon + agent + launched app).
   * A worker for that serial attaches to it instead of provisioning again.
   * Not used in multi-bucket sessions, where the primary's config may not be
   * the bucket's.
   */
  function adoptTargetFor(deviceSerial: string): AdoptTarget | undefined {
    if (ctx.configByDevice) return undefined;
    if (!ctx.client || !ctx.deviceSerial || deviceSerial !== ctx.deviceSerial) return undefined;
    const address = ctx.daemonAddress ?? ctx.config.daemonAddress;
    return { client: ctx.client, daemonAddress: address, daemonPort: Number.parseInt(address.split(':').pop() ?? '50051', 10) };
  }

  /**
   * Daemon + agent ports for group member `m` of worker `i`. Past the
   * per-worker band (`base+100+i`, at most 100 workers) so members never
   * collide with another worker's primary.
   */
  function memberPorts(workerIndex: number, memberIndex: number): { daemonPort: number; agentPort: number } {
    const baseDaemonPort = Number.parseInt((ctx.daemonAddress ?? ctx.config.daemonAddress).split(':').pop() ?? '50051', 10);
    const offset = 200 + workerIndex * 10 + memberIndex;
    return { daemonPort: baseDaemonPort + offset, agentPort: 18700 + offset };
  }

  /** A CLI-opened group member the primary's worker can adopt instead of provisioning. */
  function adoptMemberFor(deviceSerial: string): { name: string; daemonPort: number } | undefined {
    if (ctx.configByDevice) return undefined;
    const member = ctx.primaryGroupMembers?.find((m) => m.serial === deviceSerial);
    if (!member) return undefined;
    return { name: member.name, daemonPort: Number.parseInt(member.daemonAddress.split(':').pop() ?? '0', 10) };
  }

  /** Initialize persistent workers. Called once during server startup. */
  async function initializeWorkers(): Promise<void> {
    if (!workersEnabled) return;

    const baseDaemonPort = Number.parseInt(
      (ctx.daemonAddress ?? ctx.config.daemonAddress).split(':').pop() ?? '50051',
      10,
    );
    const baseAgentPort = 18700;
    const rawBin = process.env.TAPSMITH_DAEMON_BIN ?? ctx.config.daemonBin ?? findDaemonBin();
    const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
      ? path.resolve(ctx.config.rootDir, rawBin)
      : rawBin;

    const numWorkers = Math.max(1, Math.min(ctx.workers ?? workerSerials.length, workerSerials.length));

    if (launchProgress) {
      launchProgress.start('ui-workers', `starting ${numWorkers} UI worker(s)`);
      launchProgress.update('ui-workers', {
        state: 'running',
        progress: { done: 0, total: numWorkers },
      });
    } else {
      console.log(`${DIM}Initializing ${numWorkers} UI worker(s)...${RESET}`);
    }

    const initPromises: Promise<UIWorkerHandle | null>[] = [];
    let readyWorkerCount = 0;
    const failedWorkerMessages: string[] = [];

    // Collect PIDs listening on all daemon ports in a single lsof call
    // so each worker doesn't need to shell out individually. Group members
    // take ports past the per-worker band (see memberPorts).
    const daemonPorts = Array.from({ length: numWorkers }, (_, i) => baseDaemonPort + 100 + i);
    const memberDaemonPorts = workerGroups.flatMap((g, i) => g.slice(1).map((_, m) => memberPorts(i, m).daemonPort));
    const stalePidsByPort = collectListeningPids([...daemonPorts, ...memberDaemonPorts]);

    for (let i = 0; i < numWorkers; i++) {
      const deviceSerial = workerSerials[i];
      const adopt = adoptTargetFor(deviceSerial);
      const daemonPort = adopt?.daemonPort ?? daemonPorts[i];
      const agentPort = baseAgentPort + 100 + i;

      initPromises.push(
        initializeOneWorker(
          i,
          deviceSerial,
          daemonPort,
          agentPort,
          daemonBin,
          adopt ? undefined : stalePidsByPort.get(daemonPort),
          adopt ? undefined : stalePidsByPort,
          {
            onProgress: (message) => {
              launchProgress?.update('ui-workers', {
                state: 'running',
                detail: `Worker ${i} (${deviceSerial}): ${message}`,
                progress: { done: readyWorkerCount, total: numWorkers },
              });
            },
            onReady: () => {
              readyWorkerCount++;
              launchProgress?.update('ui-workers', {
                state: 'running',
                detail: `Worker ${i} (${deviceSerial}): ready`,
                progress: { done: readyWorkerCount, total: numWorkers },
              });
            },
          },
          adopt,
          true,
          // The CLI already force-installed its own device this session; a
          // multi-bucket session does not adopt it, so skip it here (as watch does).
          ctx.forceInstall && deviceSerial !== ctx.deviceSerial,
        ),
      );
    }

    const results = await Promise.allSettled(initPromises);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        uiWorkers.push(result.value);
      } else {
        const reason = result.status === 'rejected' ? result.reason : 'null result';
        const serial = workerSerials[i];
        const reasonText = reason instanceof Error ? reason.message : String(reason);
        failedWorkerMessages.push(`${serial}: ${reasonText}`);
        launchProgress?.update('ui-workers', {
          state: 'running',
          detail: `Skipping ${serial}: ${reasonText}`,
          progress: { done: readyWorkerCount, total: numWorkers },
        });
        const message = `Skipping device ${serial}: ${reasonText}.`;
        if (launchProgress) launchProgress.note(message);
        else console.error(`${YELLOW}${message}${RESET}`);
      }
    }

    if (uiWorkers.length === 0) {
      const message = 'No test worker could be started — runs will fail until a worker is respawned.';
      if (launchProgress) launchProgress.fail('ui-workers', message);
      else console.error(`${YELLOW}${message}${RESET}`);
      workersInitialized = true;
      return;
    }

    // Resolve friendly display names for workers.
    // iOS: UUID → simulator name (e.g. "iPhone 16 #1")
    // Android: serial → AVD name (e.g. "Pixel_7_Pro #1")
    {
      // Cache simulator list — listSimulators() forks `xcrun simctl` which is
      // slow; we only need it once per init.
      let simulatorsCache: ReturnType<typeof listSimulators> | undefined;
      let physicalDevicesCache: ReturnType<typeof listPhysicalDevices> | undefined;
      const resolveSerialToName = (serial: string): string => {
        // In multi-bucket mode the root config's platform may not match this
        // worker's actual device, so prefer the per-worker config when set.
        const workerPlatform =
          uiWorkers.find((w) => w.deviceSerial === serial)?.platform ?? resolveDevicePlatform(ctx, serial);
        if (workerPlatform === 'ios') {
          if (!simulatorsCache) simulatorsCache = listSimulators();
          const simName = simulatorsCache.find((s) => s.udid === serial)?.name;
          if (simName) return simName;
          if (!physicalDevicesCache) physicalDevicesCache = listPhysicalDevices();
          return physicalDevicesCache.find((d) => d.udid === serial)?.name ?? serial;
        }
        if (serial.startsWith('emulator-')) {
          return getRunningAvdName(serial) ?? serial;
        }
        return serial;
      };

      // Resolve names for all workers, and for every member of their groups.
      const resolvedNames = uiWorkers.map((w) => resolveSerialToName(w.deviceSerial));
      for (const w of uiWorkers) {
        for (const m of w.members) m.displayName = resolveSerialToName(m.deviceSerial);
      }

      // Count occurrences of each name to decide whether to append #N.
      const nameCounts = new Map<string, number>();
      for (const name of resolvedNames) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const nameIndex = new Map<string, number>();
      for (let i = 0; i < uiWorkers.length; i++) {
        const name = resolvedNames[i];
        const count = nameCounts.get(name) ?? 1;
        if (count > 1) {
          const idx = (nameIndex.get(name) ?? 0) + 1;
          nameIndex.set(name, idx);
          uiWorkers[i].displayName = `${name} #${idx}`;
        } else {
          uiWorkers[i].displayName = name;
        }
      }
    }

    workersInitialized = true;
    if (launchProgress) {
      if (failedWorkerMessages.length > 0) {
        launchProgress.update('ui-workers', {
          state: 'warning',
          detail: `${uiWorkers.length}/${numWorkers} UI worker(s) ready; ${failedWorkerMessages.length} failed`,
          progress: { done: uiWorkers.length, total: numWorkers },
        });
      } else {
        launchProgress.complete('ui-workers', `${uiWorkers.length} UI worker(s) ready`);
      }
    } else {
      console.log(`${DIM}${uiWorkers.length} UI worker(s) ready.${RESET}`);
    }
  }

  async function initializeOneWorker(
    id: number,
    deviceSerial: string,
    daemonPort: number,
    agentPort: number,
    daemonBin: string,
    stalePids: number[] | undefined,
    /**
     * Listeners squatting on this worker's member daemon ports, keyed by port
     * (startup only). A respawn passes none: the startup squatters were
     * killed then, and `awaitDaemonExit` has just freed the ports, so a
     * remembered PID could by now belong to an unrelated process.
     */
    staleMemberPidsByPort: Map<number, number[]> | undefined,
    events: {
      onProgress?: (message: string) => void
      onReady?: () => void
    } | undefined,
    adopt: AdoptTarget | undefined,
    /** The adopted primary's startup launch is still unconsumed (initial spawn only). */
    adoptPrepared: boolean,
    /**
     * `--force-install` applies. Required, with no default: a spawn site that
     * forgot it would drop the flag silently (PILOT-261). The initial spawn
     * passes it; a respawn passes false (it must not wipe the app mid-session).
     */
    forceInstall: boolean,
  ): Promise<UIWorkerHandle> {
    // The rest of this worker's device group (`use.devices`), each on a
    // daemon of its own — adopted from the CLI when it opened them beside
    // the primary, spawned here otherwise.
    const memberSerials = workerGroups[id]?.slice(1) ?? [];
    const groupNames = workerDeviceGroup(deviceSerial);
    if (memberSerials.length !== groupNames.length - 1) {
      throw new Error(
        `worker ${id}: config declares a device group of ${groupNames.length} but ${memberSerials.length + 1} device(s) were provisioned for it`,
      );
    }
    // Kill any stale daemon on this port from a previous run or another
    // Tapsmith instance so we always get a fresh daemon with the correct
    // --platform flag. Without this, waitForReady succeeds by connecting
    // to the old daemon, causing cross-instance interference.
    // PIDs were pre-collected via a single batched lsof call.
    if (!adopt && stalePids && stalePids.length > 0) {
      for (const pid of stalePids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Remove stale ADB port forwards whose HOST side is this worker's agent
    // port. A previous Android instance may have set up `adb forward
    // tcp:<agentPort>` which hijacks traffic meant for the iOS XCUITest
    // agent. Match `local === tcp:<agentPort>` exactly so we don't try to
    // remove forwards whose remote side merely happens to be the same port
    // (which would print "listener 'tcp:<port>' not found").
    if (!adopt) {
      try {
        const fwdList = execFileSync('adb', ['forward', '--list'], { encoding: 'utf-8' }).trim();
        for (const line of fwdList.split('\n')) {
          const [serial, local] = line.split(/\s+/);
          if (!serial || local !== `tcp:${agentPort}`) continue;
          try {
            execFileSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${agentPort}`]);
          } catch { /* already gone */ }
        }
      } catch {
        // ADB not available or no forwards — safe to ignore
      }
    }

    // Resolve per-worker config (multi-bucket) or fall back to the
    // server-wide serializedConfig built from ctx.config.
    const workerConfig = ctx.configByDevice?.get(deviceSerial) ?? serializedConfig;
    const workerBucketSig = ctx.bucketByDevice?.get(deviceSerial);

    // Daemon: adopt the primary's, or spawn one for this worker.
    let daemonProcess: ChildProcess | undefined;
    let daemonClient: TapsmithGrpcClient;
    if (adopt) {
      daemonClient = adopt.client;
      const ready = await daemonClient.waitForReady(5_000);
      if (!ready) throw new Error(`primary daemon at ${adopt.daemonAddress} is not reachable`);
    } else {
      daemonProcess = spawn(
        daemonBin,
        ['--port', String(daemonPort), '--agent-port', String(agentPort),
          ...(workerConfig.platform ? ['--platform', workerConfig.platform] : [])],
        { stdio: 'ignore' },
      );
      daemonProcess.on('error', () => { /* handled by waitForReady */ });

      daemonClient = new TapsmithGrpcClient(`localhost:${daemonPort}`);
      const ready = await daemonClient.waitForReady(10_000);
      if (!ready) {
        try { daemonProcess.kill(); } catch { /* already dead */ }
        daemonClient.close();
        throw new Error(`daemon on port ${daemonPort} did not become ready`);
      }
      // Only detach after confirmed ready so kill() works during init failure
      daemonProcess.unref();
    }

    // Member daemons, spawned together — they are independent. Settled, not
    // raced: a sibling still starting when one fails would otherwise finish
    // after the cleanup below and leak its daemon and client.
    const members: UIWorkerMemberHandle[] = [];
    try {
      const settled = await Promise.allSettled(memberSerials.map(async (serial, m) => {

        const name = groupNames[m + 1].name;
        const adoptMember = adopt ? adoptMemberFor(serial) : undefined;
        if (adoptMember) {
          const alive = await waitForDaemon(`localhost:${adoptMember.daemonPort}`, 5_000);
          if (!alive) throw new Error(`primary group member ${name}'s daemon on port ${adoptMember.daemonPort} is not reachable`);
          members[m] = {
            name, deviceSerial: serial, daemonPort: adoptMember.daemonPort, agentPort: 0, ownsDaemon: false,
            screenClient: new TapsmithGrpcClient(`localhost:${adoptMember.daemonPort}`),
          };
          return;
        }
        const ports = memberPorts(id, m);
        for (const pid of staleMemberPidsByPort?.get(ports.daemonPort) ?? []) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
        const daemon = await startDaemon({
          daemonBin, port: ports.daemonPort, agentPort: ports.agentPort, platform: workerConfig.platform,
          describe: `daemon for ${name}`,
        });
        members[m] = {
          name, deviceSerial: serial, ...ports, daemonProcess: daemon.process, ownsDaemon: true,
          screenClient: new TapsmithGrpcClient(`localhost:${ports.daemonPort}`),
        };
      }));
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
    } catch (err) {
      // `initializeWorkers` records the failure and carries on, so anything
      // left open here lives for the whole session: close the members' gRPC
      // channels and the primary's, not just the processes.
      for (const m of members) {
        if (!m) continue;
        m.screenClient?.close();
        if (m.ownsDaemon) { try { m.daemonProcess?.kill(); } catch { /* already dead */ } }
      }
      if (!adopt) {
        daemonClient.close();
        try { daemonProcess?.kill(); } catch { /* already dead */ }
      }
      throw err;
    }


    // Fork ui-worker.ts
    const workerLoader = childLoader();
    const child = fork(resolvedWorkerScript, [], {
      stdio: forkStdioForLaunchProgress(launchProgress),
      ...(workerLoader ? { execPath: workerLoader } : {}),
      env: {
        ...process.env,
        NODE_PATH: path.resolve(import.meta.dirname, '..', '..'),
        TAPSMITH_WORKER_ID: String(id),
      },
    });
    pipeForkOutputForLaunchProgress(child, launchProgress);
    child.setMaxListeners(20);
    child.on('error', (err) => {
      console.error(`${YELLOW}Worker ${id} process error: ${err.message}${RESET}`);
    });

    const worker: UIWorkerHandle = {
      id,
      process: child,
      deviceSerial,
      members,
      platform: workerConfig.platform,
      displayName: deviceSerial,
      daemonPort,
      agentPort,
      daemonProcess,
      screenClient: daemonClient,
      ownsDaemon: !adopt,
      ownsScreenClient: !adopt,
      adoptedPrimary: !!adopt,
      busy: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      bucketSignature: workerBucketSig,
    };

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`worker ${id} timed out during initialization (90s)`));
      }, 90_000);

      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`worker ${id} exited with code ${code} during initialization`));
      };

      const onMessage = (msg: UIWorkerChildMessage) => {
        if (msg.type === 'ready' && msg.workerId === id) {
          worker.initialPolicy = msg.policy;
          worker.capabilities = msg.capabilities;
          events?.onReady?.();
          clearTimeout(timeout);
          cleanup();
          resolve();
        } else if (msg.type === 'progress' && msg.workerId === id) {
          if (launchProgress) events?.onProgress?.(msg.message);
          else console.log(`${DIM}  Worker ${id} (${deviceSerial}): ${msg.message}${RESET}`);
          broadcastWorkerStatus(worker, 'initializing');
        } else if (msg.type === 'error' && msg.workerId === id) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(msg.error.message));
        }
      };

      const cleanup = () => {
        child.removeListener('exit', onExit);
        child.removeListener('message', onMessage);
      };

      child.on('exit', onExit);
      child.on('message', onMessage);

      const initMsg: UIWorkerMessage = {
        type: 'init',
        workerId: id,
        deviceSerial,
        deviceName: groupNames[0].name,
        daemonPort,
        config: workerConfig,
        screenshotDir: ctx.screenshotDir,
        adoptPrimary: !!adopt,
        adoptPrepared: !!adopt && adoptPrepared,
        forceInstall,
        ...(members.length > 0 ? {
          groupMembers: members.map((m) => ({
            name: m.name,
            deviceSerial: m.deviceSerial,
            daemonPort: m.daemonPort,
            adopt: !m.ownsDaemon || undefined,
          })),
        } : {}),
      };
      child.send(initMsg);
    });

    // Background preparation: the state machine and the listener for its
    // messages live for the worker's whole life (dispatch listeners come and go
    // per run).
    child.on('message', (msg: UIWorkerChildMessage) => handleIdleWorkerMessage(worker, msg));
    // A worker that dies while idle used to stay unretired — ensureWorkersReady
    // never respawned it, and the next dispatch threw at process.send(). The
    // per-dispatch exit handler owns crashes during a run (it requeues the
    // in-flight file), so this fallback only acts outside a dispatch.
    child.on('exit', (code, signal) => {
      if (worker.retired || worker.dispatchAttached) return;
      worker.retired = true;
      worker.busy = false;
      worker.currentFile = undefined;
      worker.currentTest = undefined;
      console.error(`${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) exited while idle (${signal ?? code}); it will be respawned before the next run.${RESET}`);
      readinessEvent(worker, { type: 'worker-retired' });
      broadcastWorkerStatus(worker, 'error');
      releaseWorkerResources(worker);
    });
    attachReadiness(worker);
    broadcastWorkerStatus(worker, 'idle');
    readinessEvent(worker, { type: 'worker-ready', initialPolicy: worker.initialPolicy });
    return worker;
  }

  function workerStatusMessage(worker: UIWorkerHandle, status: 'idle' | 'running' | 'done' | 'initializing' | 'error'): ServerMessage {
    return {
      type: 'worker-status',
      workerId: worker.id,
      deviceSerial: worker.deviceSerial,
      currentFile: worker.currentFile?.filePath ? path.basename(worker.currentFile.filePath) : undefined,
      currentTest: worker.currentTest,
      status,
      passed: worker.passed,
      failed: worker.failed,
      skipped: worker.skipped,
      readiness: worker.readiness ? toWireReadiness(worker.readiness.state) : undefined,
      speculation: speculationAllowed() ? 'on' : 'off',
      activeDeviceCount: status === 'running' && worker.currentFile
        ? fileDeviceCount(worker.currentFile, ctx.config)
        : worker.readiness?.state.kind === 'preparing' ? worker.prepareDeviceCount : undefined,
    };
  }

  function broadcastWorkerStatus(worker: UIWorkerHandle, status: 'idle' | 'running' | 'done' | 'initializing' | 'error'): void {
    broadcast(workerStatusMessage(worker, status));
  }

  /**
   * Dispatch files across workers using work-stealing.
   * Returns aggregate counts.
   */
  async function dispatchFilesParallel(files: TaggedFile[]): Promise<{
    passed: number; failed: number; skipped: number; duration: number; anyFailed: boolean; failedProjectNames: Set<string>
  }> {
    const fileQueue = [...files];
    let passed = 0, failed = 0, skipped = 0, duration = 0, anyFailed = false;
    const failedProjectsInDispatch = new Set<string>();

    const activeWorkers = uiWorkers.filter((w) => !w.retired);
    if (activeWorkers.length === 0) {
      throw new Error('No active workers available');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let initialDispatchDone = false;
      const dispatchListeners: Array<{ worker: UIWorkerHandle; messageHandler: (msg: UIWorkerChildMessage) => void; exitHandler: (code: number | null) => void }> = [];

      function settleResolve(): void {
        if (settled) return;
        settled = true;
        forceSettleDispatch = null;
        // Clean up dispatch-specific listeners
        for (const { worker, messageHandler, exitHandler } of dispatchListeners) {
          worker.process.removeListener('message', messageHandler);
          worker.process.removeListener('exit', exitHandler);
          worker.dispatchAttached = false;
        }
        resolve();
      }
      // PILOT-222: lets escalateStop settle this dispatch synchronously
      // after SIGKILLing and retiring the remaining busy workers.
      forceSettleDispatch = settleResolve;

      function maybeResolve(): void {
        if (settled) return;
        if (parallelRunAborted) {
          // Wait for all busy workers to finish their in-flight test
          if (activeWorkers.every((w) => w.retired || !w.busy)) {
            settleResolve();
          }
          return;
        }
        if (fileQueue.length > 0) {
          // Deadlock guard: every surviving worker is idle yet files
          // remain — no worker can serve them. Drain and continue.
          // Skip during initial dispatch — not all workers have been
          // offered work yet.
          if (!initialDispatchDone) return;
          const allDone = activeWorkers.every((w) => w.retired || !w.busy);
          if (allDone) {
            for (const f of fileQueue.splice(0)) {
              broadcastFileStatus(f.filePath, 'done', f.projectName);
              failed++;
              anyFailed = true;
            }
            broadcast({ type: 'error', message: 'Some test files could not be dispatched to any available worker' });
          } else {
            return;
          }
        }
        if (activeWorkers.every((w) => w.retired || !w.busy)) {
          settleResolve();
        }
      }

      function dispatchNext(worker: UIWorkerHandle): void {
        if (worker.retired || parallelRunAborted) return;

        // Multi-bucket: take the first file in the queue whose project's
        // bucket matches this worker. Files for other buckets are skipped
        // and remain in the queue for sibling workers to claim.
        //
        // Deliberate leniency: untagged files (!f.projectName) and files
        // whose project isn't in the bucketByProject map fall through to
        // any worker. In multi-bucket runs the CLI always tags files with
        // their project, so these cases shouldn't happen — but if they did,
        // dropping them entirely would leave the queue stuck forever. Better
        // to run on a possibly-wrong worker than to hang. If this ever turns
        // into a real bug we can tighten to an explicit error.
        let next: TaggedFile | undefined;
        if (worker.bucketSignature && ctx.bucketByProject) {
          const matchIdx = fileQueue.findIndex((f) => {
            if (!f.projectName) return true;
            const sig = ctx.bucketByProject!.get(f.projectName);
            return !sig || sig === worker.bucketSignature;
          });
          if (matchIdx >= 0) {
            next = fileQueue.splice(matchIdx, 1)[0];
          }
        } else {
          next = fileQueue.shift();
        }
        if (!next) {
          worker.busy = false;
          worker.currentFile = undefined;
          worker.currentTest = undefined;
          broadcastWorkerStatus(worker, 'idle');
          maybeResolve();
          return;
        }

        worker.busy = true;
        worker.currentFile = next;
        worker.currentTest = undefined;
        worker.lastRun = { file: next.filePath, projectName: next.projectName };
        lastRunProject = next.projectName ?? lastRunProject;
        // Hand over a background preparation that satisfies this file's policy;
        // otherwise the runner resets inline. Either way the click never waits.
        const want = policyForDispatch(worker, next);
        const preparedFor: PreparedState | undefined = worker.readiness?.preparedFor(want);
        readinessEvent(worker, { type: 'dispatch', file: next.filePath, want });
        broadcastWorkerStatus(worker, 'running');
        broadcastFileStatus(next.filePath, 'running', next.projectName);

        const msg: UIWorkerMessage = {
          type: 'run-file',
          filePath: next.filePath,
          projectUseOptions: next.projectUseOptions,
          projectName: next.projectName,
          testFilter: next.testFilter,
          preparedFor,
        };
        // A worker can die between exit-event delivery and this dispatch; an
        // unguarded send would throw ERR_IPC_CHANNEL_CLOSED out of the
        // dispatch promise. Retiring requeues `next` (it is this worker's
        // currentFile) onto a sibling instead.
        if (!worker.process.connected) {
          retireWorker(worker, 'worker process is not connected');
          return;
        }
        try {
          worker.process.send(msg);
        } catch (err) {
          retireWorker(worker, `failed to send run-file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      function drainUnservableFiles(remaining: UIWorkerHandle[]): TaggedFile[] {
        if (remaining.length === 0) {
          return fileQueue.splice(0);
        }
        if (!ctx.bucketByProject) return [];

        const orphaned: TaggedFile[] = [];
        let i = 0;
        while (i < fileQueue.length) {
          const f = fileQueue[i];
          if (!f.projectName) { i++; continue; }
          const sig = ctx.bucketByProject.get(f.projectName);
          if (sig && !remaining.some((w) => w.bucketSignature === sig)) {
            fileQueue.splice(i, 1);
            orphaned.push(f);
          } else {
            i++;
          }
        }
        return orphaned;
      }

      function retireWorker(worker: UIWorkerHandle, reason: string): void {
        if (worker.retired) return;
        worker.retired = true;
        const inFlightFile = worker.currentFile;
        const inFlightTest = worker.currentTest;
        worker.currentFile = undefined;
        worker.currentTest = undefined;
        worker.busy = false;
        readinessEvent(worker, { type: 'worker-retired' });
        broadcastWorkerStatus(worker, 'error');
        // Release the daemon/screen client now rather than at the next run's
        // respawn — a retired worker's resources serve no one in between —
        // and make sure the child itself is gone (no orphans on the agent).
        releaseWorkerResources(worker);
        void terminateWorkerProcess(worker);

        if (inFlightFile && parallelRunAborted) {
          // During a user stop the file isn't coming back — don't requeue it
          // or log a misleading "Requeueing" line. Whatever was running when
          // the worker died (SIGKILL escalation, worker error, unexpected
          // exit) is recorded as interrupted so it doesn't linger as
          // 'running' and the run-end counts stay honest.
          if (inFlightTest) {
            updateTestStatus(
              inFlightTest,
              inFlightFile.filePath,
              'failed',
              undefined,
              'Interrupted: stopped by user',
              undefined,
              undefined,
              worker.id,
              inFlightFile.projectName,
            );
            interruptedCount++;
          }
          broadcastFileStatus(inFlightFile.filePath, 'done', inFlightFile.projectName);
        } else if (inFlightFile) {
          fileQueue.unshift(inFlightFile);
          console.error(`${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) became unavailable: ${reason}. Requeueing ${path.basename(inFlightFile.filePath)}.${RESET}`);
        }

        const remaining = activeWorkers.filter((w) => !w.retired);

        // Drain files that no surviving worker can serve (e.g. all iOS
        // workers died while Android workers are still alive).
        const orphaned = drainUnservableFiles(remaining);
        for (const f of orphaned) {
          broadcastFileStatus(f.filePath, 'done', f.projectName);
          // Counted *and* recorded. Incrementing `failed` alone reported "1
          // failed" from the run while `list_results` said there were no
          // results and the status board showed nothing — the failure existed
          // only in the number. It carries the reason the worker gave, which
          // is the actual cause (an import error, say) rather than the drain.
          recordFileFailure(f.filePath, f.projectName, new Error(`No worker could run this file: ${reason}`));
          failed++;
          anyFailed = true;
        }
        if (orphaned.length > 0) {
          const names = orphaned.map((f) => path.basename(f.filePath)).join(', ');
          broadcast({ type: 'error', message: `No remaining workers can run: ${names}` });
        }

        if (remaining.length === 0) {
          if (parallelRunAborted) {
            // Stopping a fully-busy run via SIGKILL escalation retires every
            // worker — that's the requested stop, not an error-flavored end.
            settleResolve();
            return;
          }
          settled = true;
          reject(new Error(`All workers became unavailable. Last failure: ${reason}`));
          return;
        }

        const idleWorker = remaining.find((w) => !w.busy);
        if (idleWorker) dispatchNext(idleWorker);
        maybeResolve();
      }

      // Attach listeners and dispatch
      for (const worker of activeWorkers) {
        const messageHandler = (msg: UIWorkerChildMessage): void => {
          if (settled || worker.retired) return;

          switch (msg.type) {
            case 'test-start': {
              // currentTest is still updated for attribution-only re-tags
              // (afterAll hooks) so trace events get tagged to the right
              // test, but the worker was already 'running' — no status ping.
              worker.currentTest = msg.fullName;
              if (!msg.attributionOnly) broadcastWorkerStatus(worker, 'running');
              broadcast({
                type: 'test-start',
                fullName: msg.fullName,
                filePath: msg.filePath,
                workerId: worker.id,
                projectName: worker.currentFile?.projectName,
                attributionOnly: msg.attributionOnly,
                isolation: msg.isolation,
                deviceCount: worker.currentFile ? fileDeviceCount(worker.currentFile, ctx.config) : undefined,
              });
              break;
            }
            case 'test-end': {
              const result = deserializeTestResult(msg.result);
              const tf = worker.currentFile?.testFilter;
              if (tf && result.status === 'skipped' && result.fullName !== tf) {
                break;
              }
              updateTestStatus(
                result.fullName,
                worker.currentFile?.filePath ?? '',
                result.status as TestTreeNode['status'],
                result.durationMs,
                result.error?.message,
                result.tracePath,
                result.videoPath,
                worker.id,
                worker.currentFile?.projectName,
              );
              if (result.status === 'passed') worker.passed++;
              else if (result.status === 'failed') worker.failed++;
              else if (result.status === 'skipped') worker.skipped++;
              break;
            }
            case 'trace-event': {
              const ev = msg.event as { type?: string; action?: string; origin?: string };
              if (runFirstActionAt === undefined && (ev.type === 'action' || ev.type === 'assertion')) {
                runFirstActionAt = Date.now();
              }
              if (runPreflightOrigin === undefined && ev.type === 'action') {
                if (ev.action === 'appReset' && (ev.origin === 'prepared' || ev.origin === 'skipped')) runPreflightOrigin = ev.origin;
                else if (ev.action === 'resetApp' || ev.action === 'restoreAppState') runPreflightOrigin = 'inline';
              }
              const traceMsg: TraceEventMessage = {
                type: 'trace-event',
                testFullName: worker.currentTest ?? '',
                filePath: worker.currentFile?.filePath,
                workerId: worker.id,
                projectName: worker.currentFile?.projectName,
                event: msg.event,
                lifecycle: msg.lifecycle,
                screenshotBefore: msg.screenshotBefore,
                screenshotAfter: msg.screenshotAfter,
                hierarchyBefore: msg.hierarchyBefore,
                hierarchyAfter: msg.hierarchyAfter,
              };
              if (!traceBufferFull) {
              if (traceBuffer.length >= MAX_TRACE_BUFFER) traceBufferFull = true;
              else traceBuffer.push(traceMsg);
            }
              broadcast(traceMsg);
              break;
            }
            case 'source': {
              const sourceMsg: SourceMessage = { type: 'source', path: msg.path, fileName: msg.fileName, content: msg.content };
              sourceBuffer.set(msg.path, sourceMsg);
              broadcast(sourceMsg);
              break;
            }
            case 'network': {
              const networkMsg: NetworkMessage = { type: 'network', filePath: worker.currentFile?.filePath, testFullName: worker.currentTest ?? '', projectName: worker.currentFile?.projectName, entries: msg.entries, bodies: msg.bodies, bodyMode: msg.bodyMode, networkCaptureEnabled: msg.networkCaptureEnabled };
              networkBuffer.add(networkMsg);
              broadcast(networkMsg);
              break;
            }
            case 'file-done': {
              const results = msg.results.map(deserializeTestResult);
              const suite = deserializeSuiteResult(msg.suite);

              // A test the user stopped mid-flight is interrupted, not failed
              // — keeps graceful-abort accounting consistent with the
              // kill-path accounting (single-worker stop / SIGKILL escalation).
              const interruptedHere = results.filter(
                (r) => r.status === 'failed' && r.error?.message === STOPPED_BY_USER,
              ).length;
              interruptedCount += interruptedHere;

              passed += results.filter((r) => r.status === 'passed').length;
              failed += results.filter((r) => r.status === 'failed').length - interruptedHere;
              skipped += results.filter((r) => r.status === 'skipped').length;
              duration += suite.durationMs;
              if (results.some((r) => r.status === 'failed')) {
                anyFailed = true;
                // Track which project this file belongs to
                if (worker.currentFile?.projectName) {
                  failedProjectsInDispatch.add(worker.currentFile.projectName);
                }
              }

              broadcastFileStatus(msg.filePath, 'done', worker.currentFile?.projectName);
              lastProgressByWorker.delete(worker.id);
              broadcast({ type: 'run-progress', workerId: worker.id });
              readinessEvent(worker, { type: 'file-done' });
              worker.currentFile = undefined;
              worker.currentTest = undefined;

              if (parallelRunAborted) {
                // Abort: mark worker idle without dispatching next file
                worker.busy = false;
                broadcastWorkerStatus(worker, 'idle');
                maybeResolve();
              } else {
                broadcastWorkerStatus(worker, 'running');
                dispatchNext(worker);
              }
              break;
            }
            case 'capabilities':
              upgradeWorkerCapabilities(worker, msg.capabilities);
              break;
            case 'progress':
              // Slow-device-action progress during the between-file preflight
              // (PILOT-232). Empty string = the preflight finished, clear it.
              if (msg.message) lastProgressByWorker.set(worker.id, msg.message);
              else lastProgressByWorker.delete(worker.id);
              broadcast({ type: 'run-progress', workerId: worker.id, message: msg.message || undefined });
              break;
            case 'error': {
              retireWorker(worker, msg.error.message);
              break;
            }
          }
        };

        const exitHandler = (code: number | null): void => {
          if (settled) return;
          if (worker.retired) {
            maybeResolve();
            return;
          }
          retireWorker(worker, `exited unexpectedly with code ${code}`);
        };

        dispatchListeners.push({ worker, messageHandler, exitHandler });
        worker.dispatchAttached = true;
        worker.process.on('message', messageHandler);
        worker.process.on('exit', exitHandler);

        dispatchNext(worker);
      }
      initialDispatchDone = true;
      maybeResolve();
    });

    return { passed, failed, skipped, duration, anyFailed, failedProjectNames: failedProjectsInDispatch };
  }

  async function runAllFilesParallel(): Promise<TestRunResult> {
    if (isRunning) return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    markRunStarted();
    clearRunBuffers();
    screenPollActive = true;
    parallelRunAborted = false;

    broadcast({ type: 'run-start', fileCount: ctx.testFiles.length });

    let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;

    try {
      if (hasRealProjects && ctx.projectWaves) {
        const failedProjects = new Set<string>();

        for (const wave of ctx.projectWaves) {
          if (parallelRunAborted) break;

          const waveFiles: TaggedFile[] = [];
          for (const project of wave) {
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(project.name);
              failedProjects.add(project.name);
              continue;
            }

            for (const file of project.testFiles) {
              waveFiles.push({
                filePath: file,
                projectUseOptions: project.use as RunFileUseOptions | undefined,
                projectName: projectLabel(project),
              });
            }
          }

          if (waveFiles.length > 0) {
            const r = await dispatchFilesParallel(waveFiles);
            totalPassed += r.passed;
            totalFailed += r.failed;
            totalSkipped += r.skipped;
            totalDuration += r.duration;

            // Track per-project failures using actual per-file results
            if (r.anyFailed) {
              for (const project of wave) {
                if (failedProjects.has(project.name)) continue;
                if (r.failedProjectNames.has(project.name)) {
                  failedProjects.add(project.name);
                }
              }
            }
          }
        }
      } else {
        const allFiles: TaggedFile[] = ctx.testFiles.map((f) => {
          const project = fileToProject.get(f);
          return {
            filePath: f,
            projectUseOptions: project?.use as RunFileUseOptions | undefined,
            projectName: projectLabel(project),
          };
        });

        const r = await dispatchFilesParallel(allFiles);
        totalPassed = r.passed;
        totalFailed = r.failed;
        totalSkipped = r.skipped;
        totalDuration = r.duration;
      }

      return endRun({
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      });
    } catch (err) {
      if (!parallelRunAborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'error', message: errMsg });
      }
      return endRun({
        status: 'failed',
        duration: totalDuration,
        passed: totalPassed,
        failed: parallelRunAborted ? totalFailed : totalFailed + 1,
        skipped: totalSkipped,
      });
    } finally {
      markRunEnded();
      screenPollActive = false;
      for (const w of uiWorkers) {
        if (!w.retired) broadcastWorkerStatus(w, 'idle');
      }
    }
  }

  async function runFileParallel(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<TestRunResult> {
    if (isRunning) return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    markRunStarted();
    clearRunBuffers();
    screenPollActive = true;
    parallelRunAborted = false;

    const project = projectForFile(filePath, explicitProjectName);
    const projectName = projectLabel(project);
    broadcast({ type: 'run-start', fileCount: 1, filePath, testFilter, projectName });

    const file: TaggedFile = {
      filePath,
      projectUseOptions: project?.use as RunFileUseOptions | undefined,
      projectName,
      testFilter,
    };

    try {
      const r = await dispatchFilesParallel([file]);
      return endRun({ status: r.failed > 0 ? 'failed' : 'passed', duration: r.duration, passed: r.passed, failed: r.failed, skipped: r.skipped });
    } catch (err) {
      if (!parallelRunAborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${errMsg}` });
        recordFileFailure(filePath, file.projectName, err);
      }
      broadcastFileStatus(filePath, 'done', file.projectName);
      return endRun({ status: 'failed', passed: 0, failed: parallelRunAborted ? 0 : 1, skipped: 0, duration: 0 });
    } finally {
      markRunEnded();
      screenPollActive = false;
    }
  }

  /** Grace period between the cooperative abort and SIGKILL escalation. */
  const STOP_GRACE_MS = 5_000;

  /**
   * Stop the in-flight run (Stop button / MCP tapsmith_stop_tests). In the
   * common case the cooperative abort lands within ~1s: workers abort their
   * AbortController, which cancels the in-flight gRPC call and short-circuits
   * poll loops. Wedged workers are SIGKILLed after STOP_GRACE_MS.
   */
  function stopRun(): void {
    if (!isRunning) return;
    stopRequested = true;
    stopParallelRun();
  }

  /** Stop a parallel run: signal each busy worker to abort. The worker's
   * abort cancels the in-flight gRPC call and short-circuits poll loops, so
   * the current action doesn't ride out its own timeout; the worker itself
   * stays alive and ready for the next run. Workers that fail to drain
   * within STOP_GRACE_MS are SIGKILLed by escalateStop. */
  function stopParallelRun(): void {
    parallelRunAborted = true;

    for (const worker of uiWorkers) {
      if (!worker.busy) continue;
      try {
        worker.process.send({ type: 'abort' } satisfies import('./ui-protocol.js').UIWorkerAbortMessage);
      } catch { /* IPC closed */ }
    }

    if (!stopEscalationTimer) {
      stopEscalationTimer = setTimeout(escalateStop, STOP_GRACE_MS);
    }
  }

  /**
   * Escalation backstop (PILOT-222): a worker that hasn't drained within the
   * grace period is wedged (e.g. blocked event loop, hung native call) — the
   * cooperative abort can never land. SIGKILL it, retire it, and record its
   * in-flight test as interrupted SYNCHRONOUSLY — the dispatch's exit
   * listener is removed once the dispatch settles, so relying on the exit
   * event could leave a dead worker unretired (never respawned by
   * ensureWorkersReady) with its test stuck 'running'. With every killed
   * worker retired there is nothing left to wait for, so the dispatch is
   * settled immediately; a late exit event takes the worker.retired →
   * maybeResolve no-op path.
   */
  function escalateStop(): void {
    stopEscalationTimer = null;
    if (!parallelRunAborted) return;

    let killedAny = false;
    for (const worker of uiWorkers) {
      if (worker.retired || !worker.busy) continue;
      killedAny = true;
      console.error(`${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) did not stop within ${STOP_GRACE_MS}ms — force-killing.${RESET}`);
      try { worker.process.kill('SIGKILL'); } catch { /* already dead */ }

      worker.retired = true;
      worker.busy = false;
      readinessEvent(worker, { type: 'worker-retired' });
      broadcastWorkerStatus(worker, 'error');
      releaseWorkerResources(worker);
      if (worker.currentFile) {
        if (worker.currentTest) {
          updateTestStatus(
            worker.currentTest,
            worker.currentFile.filePath,
            'failed',
            undefined,
            'Interrupted: stopped by user',
            undefined,
            undefined,
            worker.id,
            worker.currentFile.projectName,
          );
          interruptedCount++;
        }
        broadcastFileStatus(worker.currentFile.filePath, 'done', worker.currentFile.projectName);
        worker.currentFile = undefined;
        worker.currentTest = undefined;
      }
    }

    if (killedAny) forceSettleDispatch?.();
  }

  /**
   * Kill a retired worker's daemon and close its screen client. SIGTERM (not
   * SIGKILL) so the daemon can tear down its own agent processes — orphaned
   * XCUITest runners re-boot their simulators (see PILOT-230). Safe to call
   * repeatedly: kill on a dead process is a no-op and close() is idempotent.
   */
  function releaseWorkerResources(worker: UIWorkerHandle): void {
    if (worker.ownsDaemon !== false) {
      try { worker.daemonProcess?.kill(); } catch { /* already dead */ }
    }
    for (const m of worker.members) {
      if (m.ownsDaemon) { try { m.daemonProcess?.kill(); } catch { /* already dead */ } }
      m.screenClient?.close();
    }
    if (worker.ownsScreenClient !== false) worker.screenClient?.close();
  }

  /**
   * Wait for a released daemon to actually exit. A respawn that rebinds the
   * same port must not race the SIGTERM: spawning the replacement while the
   * old listener is still up makes it fail to bind and exit, and nothing
   * answers for the whole readiness window ("daemon on port N did not become
   * ready" on every recycle of a non-adopting worker). SIGKILL if the
   * graceful teardown overruns.
   */
  function awaitDaemonExit(worker: UIWorkerHandle, graceMs = 5_000): Promise<void> {
    const owned = [
      ...(worker.ownsDaemon !== false && worker.daemonProcess ? [worker.daemonProcess] : []),
      ...worker.members.flatMap((m) => (m.ownsDaemon && m.daemonProcess ? [m.daemonProcess] : [])),
    ];
    return Promise.all(owned.map((daemon) => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try { daemon.kill('SIGKILL'); } catch { /* already dead */ }
        }, graceMs);
        // A daemon that ignores SIGKILL too (unkillable state) must not wedge
        // the respawn forever — give up and let the bind attempt report it.
        const giveUp = setTimeout(() => { clearTimeout(killTimer); resolve(); }, graceMs + 2_000);
        daemon.once('exit', () => { clearTimeout(killTimer); clearTimeout(giveUp); resolve(); });
      });
    })).then(() => undefined);
  }

  /**
   * End a worker's Node process: cooperative shutdown first, SIGKILL if it
   * hasn't exited shortly after. Retiring a worker used to release its daemon
   * but leave the child alive — an orphan holding the device's agent socket.
   */
  function terminateWorkerProcess(worker: UIWorkerHandle): Promise<void> {
    const child = worker.process;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3_000);
      child.once('exit', () => { clearTimeout(killTimer); resolve(); });
      try {
        if (child.connected) child.send({ type: 'shutdown' } satisfies UIWorkerMessage);
        else child.kill();
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    });
  }

  /** Start a replacement process for the worker at `index` (retired or recycled). */
  // One respawn per slot at a time. `respawnWorkerAtNow` retires the old
  // handle synchronously and then awaits; `ensureWorkersReady` reads
  // `retired` as "needs a respawn", so a run request landing mid-respawn
  // would otherwise fork a second child (and daemon) onto the same device.
  const respawnsInFlight = new Map<number, Promise<void>>();
  function respawnWorkerAt(index: number): Promise<void> {
    const inFlight = respawnsInFlight.get(index);
    if (inFlight) return inFlight;
    const p = respawnWorkerAtNow(index).finally(() => respawnsInFlight.delete(index));
    respawnsInFlight.set(index, p);
    return p;
  }

  async function respawnWorkerAtNow(index: number): Promise<void> {
    const worker = uiWorkers[index];
    const baseDaemonPort = Number.parseInt(
      (ctx.daemonAddress ?? ctx.config.daemonAddress).split(':').pop() ?? '50051',
      10,
    );
    const baseAgentPort = 18700;
    const rawBin = process.env.TAPSMITH_DAEMON_BIN ?? ctx.config.daemonBin ?? findDaemonBin();
    const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
      ? path.resolve(ctx.config.rootDir, rawBin)
      : rawBin;
    const agentPort = baseAgentPort + 100 + worker.id;

    // Make sure the old process is gone before a new one joins its daemon.
    // The old handle is done — retire it first so the idle-exit fallback
    // doesn't treat this deliberate termination as a crash (and release the
    // daemon an adopting respawn is about to reuse). A deliberate retirement
    // is not a crash: the readiness broadcast it triggers must show the slot
    // initializing, not errored (a genuine crash goes through `retireWorker`
    // without this flag).
    worker.respawning = true;
    worker.retired = true;
    readinessEvent(worker, { type: 'worker-retired' });
    try {
      await terminateWorkerProcess(worker);
      // A worker that adopted the primary keeps adopting while that daemon is
      // alive; otherwise (or if the primary died) it gets its own daemon.
      let adopt = adoptTargetFor(worker.deviceSerial);
      if (adopt && !(await adopt.client.waitForReady(2_000))) adopt = undefined;
      // The replacement rebinds this worker's daemon ports (its own, and any
      // group member daemons it spawned): the old daemons have to be gone
      // first, not merely signalled. An adopting worker keeps the CLI's.
      if (!adopt) releaseWorkerResources(worker);
      else {
        // The replacement opens fresh member screen clients (adopted members
        // included), so the old ones go with the old process.
        for (const m of worker.members) {
          if (m.ownsDaemon) { try { m.daemonProcess?.kill(); } catch { /* already dead */ } }
          m.screenClient?.close();
        }
      }
      await awaitDaemonExit(worker);
      const daemonPort = adopt?.daemonPort ?? baseDaemonPort + 100 + worker.id;

      const newWorker = await initializeOneWorker(
        worker.id, worker.deviceSerial, daemonPort, agentPort, daemonBin, undefined, undefined, undefined, adopt,
        false, false,
      );
      // Preserve the friendly display name from before respawn.
      newWorker.displayName = worker.displayName;
      // The device did not change, so nothing it was known to support went
      // away: carry the old capabilities forward and only let the fresh
      // startup probe upgrade them, never downgrade (a probe that misses the
      // marker on a slow relaunch must not turn a verified hooks app into a
      // clear+relaunch one for the rest of the session).
      newWorker.capabilities = mergeResetCapabilities(worker.capabilities, newWorker.capabilities);
      uiWorkers[index] = newWorker;
    } finally {
      // The respawn is over either way. On failure the old handle stays in
      // the slot (retired, so the next run request retries): its later
      // readiness broadcasts must report the slot errored, not initializing.
      worker.respawning = false;
    }
  }

  /**
   * Restart a worker's Node process against its existing daemon so the next
   * run imports fresh code. `bustImportCache` only re-imports the entry test
   * file; page objects and helpers it imports stay in the ESM cache for the
   * life of the process. The device is untouched.
   */
  async function recycleWorker(worker: UIWorkerHandle, reason: string): Promise<void> {
    if (worker.retired || worker.busy) return;
    const index = uiWorkers.indexOf(worker);
    if (index < 0) return;
    console.log(`${DIM}Recycling worker ${worker.id} (${worker.deviceSerial}): ${reason}${RESET}`);
    broadcastWorkerStatus(worker, 'initializing');
    const activityId = `recycle-${worker.id}-${Date.now()}`;
    const startedAt = Date.now();
    pushActivity({ type: 'device-activity', id: activityId, workerId: worker.id, kind: 'recycle', status: 'started', label: 'Recycle worker (fresh code)', detail: reason, timestamp: startedAt });
    try {
      await respawnWorkerAt(index);
      broadcastWorkerStatus(uiWorkers[index], 'idle');
      pushActivity({ type: 'device-activity', id: activityId, workerId: worker.id, kind: 'recycle', status: 'completed', label: 'Recycled worker (fresh code)', detail: reason, timestamp: startedAt, durationMs: Date.now() - startedAt });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      worker.retired = true;
      broadcastWorkerStatus(worker, 'error');
      // Settle the activity row too, or it spins forever in Device Activity.
      pushActivity({ type: 'device-activity', id: activityId, workerId: worker.id, kind: 'recycle', status: 'error', label: 'Recycle worker (fresh code)', detail: errMsg, timestamp: startedAt, durationMs: Date.now() - startedAt });
      broadcast({ type: 'error', message: `Worker ${worker.id} (${worker.deviceSerial}) failed to recycle: ${errMsg}` });
    }
  }

  /** Mark every live worker's code stale; recycle now if idle, else after the run. */
  function markWorkersCodeStale(changedPath: string): void {
    if (!workersInitialized) return;
    for (const w of uiWorkers) if (!w.retired) w.codeStale = true;
    if (recycleTimer) clearTimeout(recycleTimer);
    recycleTimer = setTimeout(() => {
      recycleTimer = null;
      if (isRunning) return; // ensureWorkersReady recycles before the next run
      void recycleStaleWorkers(`${path.basename(changedPath)} changed`);
    }, 750);
  }

  async function recycleStaleWorkers(reason: string): Promise<void> {
    // A worker mid-background-prepare is deliberately skipped: killing it now
    // wastes the preparation for nothing — it stays codeStale and
    // ensureWorkersReady recycles it before the next run anyway.
    const stale = uiWorkers.filter(
      (w) => w.codeStale && !w.retired && !w.busy && w.readiness?.state.kind !== 'preparing',
    );
    await Promise.allSettled(stale.map((w) => recycleWorker(w, reason)));
  }

  /** Respawn retired workers and recycle stale ones before starting a new run. */
  async function ensureWorkersReady(): Promise<void> {
    if (!workersEnabled) return;

    const work: Promise<void>[] = [];
    for (let i = 0; i < uiWorkers.length; i++) {
      const worker = uiWorkers[i];
      if (worker.retired) {
        work.push((async () => {
          try {
            await respawnWorkerAt(i);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`${YELLOW}Failed to respawn worker ${worker.id}: ${errMsg}${RESET}`);
            broadcast({ type: 'error', message: `Worker ${worker.id} (${worker.deviceSerial}) failed to respawn: ${errMsg}` });
          }
        })());
      } else if (worker.codeStale && !worker.busy) {
        work.push(recycleWorker(worker, 'source files changed'));
      }
    }

    if (work.length > 0) {
      console.log(`${DIM}Preparing ${work.length} worker(s)...${RESET}`);
      await Promise.allSettled(work);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ─── Dispatch (routes to single or parallel)
  // ═══════════════════════════════════════════════════════════════════

  const useParallel = () => workersEnabled && workersInitialized && uiWorkers.some((w) => !w.retired);

  async function runFile(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<TestRunResult> {
    await ensureWorkersReady();
    if (!useParallel()) return reportNoWorkers();
    return runFileParallel(filePath, testFilter, explicitProjectName);
  }

  /** Parallel-mode batch dispatch: send multiple TaggedFile entries to
   * `dispatchFilesParallel` under a single run-start/run-end envelope so
   * sibling projects' workers run concurrently. Used by the watch queue
   * when one file change implicates multiple projects (e.g. watching a
   * test under Android and a different test under iOS in a multi-device
   * config). Caller is responsible for ensuring parallel mode is active. */
  async function runBatchParallel(files: TaggedFile[]): Promise<void> {
    if (files.length === 0 || isRunning) return;
    markRunStarted();
    screenPollActive = true;
    parallelRunAborted = false;

    broadcast({ type: 'run-start', fileCount: files.length });

    try {
      const r = await dispatchFilesParallel(files);
      endRun({
        status: r.failed > 0 ? 'failed' : 'passed',
        duration: r.duration,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    } catch (err) {
      if (!parallelRunAborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'error', message: errMsg });
      }
      endRun({ status: 'failed', duration: 0, passed: 0, failed: parallelRunAborted ? 0 : files.length, skipped: 0 });
    } finally {
      markRunEnded();
      screenPollActive = false;
    }
  }

  async function runAllFiles(): Promise<TestRunResult> {
    await ensureWorkersReady();
    if (!useParallel()) return reportNoWorkers();
    return runAllFilesParallel();
  }

  async function runProject(projectName: string): Promise<void> {
    await ensureWorkersReady();
    if (!useParallel()) { reportNoWorkers(); return; }
    // Project runs with deps use the same wave-based approach in parallel
    {
      if (!ctx.projects || !ctx.projectWaves) return;
      if (isRunning) return;

      const target = ctx.projects.find((p) => p.name === projectName);
      if (!target) return;

      markRunStarted();
      clearRunBuffers();
      screenPollActive = true;
      parallelRunAborted = false;

      await ensureWorkersReady();

      const requiredNames = collectTransitiveDeps(new Set([projectName]), ctx.projects);
      const filteredWaves = ctx.projectWaves
        .map((wave) => wave.filter((p) => requiredNames.has(p.name)))
        .filter((wave) => wave.length > 0);

      const allFiles = filteredWaves.flatMap((w) => w.flatMap((p) => p.testFiles));
      broadcast({ type: 'run-start', fileCount: allFiles.length });

      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      const failedProjects = new Set<string>();

      try {
        for (const wave of filteredWaves) {
          if (parallelRunAborted) break;

          const waveFiles: TaggedFile[] = [];
          for (const project of wave) {
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(project.name);
              failedProjects.add(project.name);
              continue;
            }
            for (const file of project.testFiles) {
              waveFiles.push({
                filePath: file,
                projectUseOptions: project.use as RunFileUseOptions | undefined,
                projectName: projectLabel(project),
              });
            }
          }

          if (waveFiles.length > 0) {
            const r = await dispatchFilesParallel(waveFiles);
            totalPassed += r.passed;
            totalFailed += r.failed;
            totalSkipped += r.skipped;
            totalDuration += r.duration;
            if (r.anyFailed) {
              for (const project of wave) {
                if (!failedProjects.has(project.name)) failedProjects.add(project.name);
              }
            }
          }
        }

        endRun({
          status: totalFailed > 0 ? 'failed' : 'passed',
          duration: totalDuration,
          passed: totalPassed,
          failed: totalFailed,
          skipped: totalSkipped,
        });
      } finally {
        markRunEnded();
        screenPollActive = false;
      }
      return;
    }
  }

  async function runFileWithDeps(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<void> {
    await ensureWorkersReady();
    if (!useParallel()) { reportNoWorkers(); return; }
    {
      // Run deps as waves, then the target file
      const project = projectForFile(filePath, explicitProjectName);
      if (!project || project.dependencies.length === 0 || !ctx.projects || !ctx.projectWaves) {
        await runFile(filePath, testFilter, explicitProjectName);
        return;
      }

      if (isRunning) return;
      markRunStarted();
      clearRunBuffers();
      screenPollActive = true;
      parallelRunAborted = false;

      await ensureWorkersReady();

      const depNames = collectTransitiveDeps(new Set(project.dependencies), ctx.projects);
      depNames.delete(project.name);
      const depWaves = ctx.projectWaves
        .map((wave) => wave.filter((p) => depNames.has(p.name)))
        .filter((wave) => wave.length > 0);

      const depFileCount = depWaves.reduce((n, w) => n + w.reduce((m, p) => m + p.testFiles.length, 0), 0);
      broadcast({
        type: 'run-start',
        fileCount: depFileCount + 1,
        filePath,
        testFilter,
        projectName: projectLabel(project),
      });

      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      const failedProjects = new Set<string>();

      try {
        for (const wave of depWaves) {
          if (parallelRunAborted) break;
          const waveFiles: TaggedFile[] = [];
          for (const depProject of wave) {
            const blockedBy = depProject.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${depProject.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(depProject.name);
              failedProjects.add(depProject.name);
              continue;
            }
            for (const f of depProject.testFiles) {
              waveFiles.push({
                filePath: f,
                projectUseOptions: depProject.use as RunFileUseOptions | undefined,
                projectName: projectLabel(depProject),
              });
            }
          }
          if (waveFiles.length > 0) {
            const r = await dispatchFilesParallel(waveFiles);
            totalPassed += r.passed;
            totalFailed += r.failed;
            totalSkipped += r.skipped;
            totalDuration += r.duration;
            if (r.anyFailed) {
              for (const dp of wave) failedProjects.add(dp.name);
            }
          }
        }

        const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
        const projectNameForBroadcast = projectLabel(project);
        if (blockedBy) {
          broadcast({ type: 'error', message: `Skipping "${path.basename(filePath)}" — dependency "${blockedBy}" failed` });
          broadcastFileStatus(filePath, 'done', projectNameForBroadcast);
        } else {
          const targetFile: TaggedFile = {
            filePath,
            projectUseOptions: project.use as RunFileUseOptions | undefined,
            projectName: projectLabel(project),
            testFilter,
          };
          const r = await dispatchFilesParallel([targetFile]);
          totalPassed += r.passed;
          totalFailed += r.failed;
          totalSkipped += r.skipped;
          totalDuration += r.duration;
        }

        endRun({
          status: totalFailed > 0 ? 'failed' : 'passed',
          duration: totalDuration,
          passed: totalPassed,
          failed: totalFailed,
          skipped: totalSkipped,
        });
      } finally {
        markRunEnded();
        screenPollActive = false;
      }
      return;
    }
  }

  // ─── Screen Polling ───

  /** `device-info` for the device the single-view mirror currently shows. */
  function broadcastSelectedDeviceInfo(): void {
    const worker = uiWorkers.find((w) => w.id === selectedWorkerId);
    if (!worker) return;
    const platform = resolveWorkerPlatform(ctx, worker);
    const member = selectedDeviceIndex > 0 ? worker.members[selectedDeviceIndex - 1] : undefined;
    const serial = member?.deviceSerial ?? worker.deviceSerial;
    broadcast({
      type: 'device-info',
      serial: (member ? member.displayName : worker.displayName) || serial,
      model: undefined,
      isEmulator: isEmulatorOrSimulator(serial, platform),
      platform,
      tapsmithVersion: TAPSMITH_VERSION,
      devicePixelRatio: cachedScreenScale(serial, platform),
    });
  }

  /** The devices of a worker's group as `workers-info` describes them, primary first. */
  function workerDevicesInfo(worker: UIWorkerHandle): WorkerDeviceInfo[] {
    const platform = resolveWorkerPlatform(ctx, worker);
    const groupNames = workerDeviceGroup(worker.deviceSerial);
    const describe = (index: number, serial: string, displayName: string | undefined): WorkerDeviceInfo => ({
      index,
      name: groupNames[index]?.name ?? `device-${index + 1}`,
      deviceSerial: serial,
      displayName: displayName || serial,
      platform,
      devicePixelRatio: cachedScreenScale(serial, platform),
      isEmulator: isEmulatorOrSimulator(serial, platform),
    });
    return [
      describe(0, worker.deviceSerial, worker.displayName),
      ...worker.members.map((m, i) => describe(i + 1, m.deviceSerial, m.displayName)),
    ];
  }

  /** The gRPC client driving device `deviceIndex` of a worker's group (0 = primary). */
  function deviceClientOf(worker: UIWorkerHandle, deviceIndex: number): TapsmithGrpcClient | undefined {
    if (deviceIndex <= 0) return worker.screenClient;
    return worker.members[deviceIndex - 1]?.screenClient;
  }

  /** Every device of a worker with the client that drives it, primary first. */
  function workerDeviceClients(worker: UIWorkerHandle): Array<{ deviceIndex: number; client: TapsmithGrpcClient }> {
    const out: Array<{ deviceIndex: number; client: TapsmithGrpcClient }> = [];
    if (worker.screenClient) out.push({ deviceIndex: 0, client: worker.screenClient });
    worker.members.forEach((m, i) => { if (m.screenClient) out.push({ deviceIndex: i + 1, client: m.screenClient }); });
    return out;
  }

  /** Poll a single device and broadcast its frame. */
  async function pollSingleWorker(workerId: number, client: import('../grpc-client.js').TapsmithGrpcClient, deviceIndex = 0): Promise<void> {
    const response = await client.takeScreenshot();
    if (response.success && response.data) {
      const data = Buffer.isBuffer(response.data)
        ? response.data
        : Buffer.from(response.data);
      // Read dimensions from the PNG IHDR chunk (bytes 16-23: width + height as big-endian uint32)
      const width = data.length >= 24 ? data.readUInt32BE(16) : 1080;
      const height = data.length >= 24 ? data.readUInt32BE(20) : 1920;
      lastFrameDims.set(mirrorKey(workerId, deviceIndex), { width, height });
      const frame = encodeScreenFrame(screenSeq++, workerId, width, height, data, deviceIndex);
      broadcastBinary(frame);
    }
  }

  async function pollScreen(): Promise<void> {
    if (clients.size === 0) {
      scheduleScreenPoll();
      return;
    }

    try {
      if (!workersInitialized) {
        scheduleScreenPoll();
        return;
      }
      if (screenViewMode === 'all') {
        // Poll every device of every non-retired worker in parallel — a group
        // worker's members are separate tiles in the grid.
        const activeWorkers = uiWorkers.filter((w) => !w.retired);
        await Promise.allSettled(
          activeWorkers.flatMap((w) => workerDeviceClients(w).map(({ deviceIndex, client }) => pollSingleWorker(w.id, client, deviceIndex))),
        );
      } else {
        const worker = uiWorkers.find((w) => w.id === selectedWorkerId && !w.retired);
        const pollClient = worker ? deviceClientOf(worker, selectedDeviceIndex) : undefined;

        if (!pollClient) {
          scheduleScreenPoll();
          return;
        }

        await pollSingleWorker(selectedWorkerId, pollClient, selectedDeviceIndex);
      }
    } catch {
      // Device may be busy — skip frame
    }

    scheduleScreenPoll();
  }

  function scheduleScreenPoll(): void {
    if (screenPollTimer) clearTimeout(screenPollTimer);
    const interacting = Date.now() - lastMirrorInteraction < INTERACTION_WINDOW_MS;
    const interval = interacting ? INTERACTIVE_POLL_MS : (screenPollActive ? 150 : 500);
    screenPollTimer = setTimeout(pollScreen, interval);
  }

  // ─── Watch Mode ───

  function configuredTestPatterns(): string[] {
    return ctx.projects
      ? ctx.projects.flatMap((p) => p.testMatch)
      : ctx.config.testMatch;
  }

  function matchingProjectsForTestFile(filePath: string): ResolvedProject[] {
    if (!ctx.projects) return [];
    return ctx.projects.filter((project) =>
      matchesTestFile(filePath, project.testMatch, resolvedRootDir, project.testIgnore),
    );
  }

  function matchesConfiguredTestFile(filePath: string): boolean {
    if (ctx.projects) return matchingProjectsForTestFile(filePath).length > 0;
    return matchesTestFile(filePath, ctx.config.testMatch, resolvedRootDir);
  }

  function shouldIgnoreDiscoveryPath(filePath: string): boolean {
    const resolved = path.resolve(resolvedRootDir, filePath);
    const normalizedRelative = relativeTestPath(resolved, resolvedRootDir);
    if (normalizedRelative.startsWith('../') || path.isAbsolute(normalizedRelative)) return true;

    const parts = normalizedRelative.split('/');
    if (parts.includes('.git') || matchesTestIgnore(normalizedRelative)) {
      return true;
    }

    const outputRelative = path.relative(resolvedOutputDir, resolved);
    return outputRelative === '' || (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative));
  }

  function addUnique(files: string[], filePath: string): boolean {
    if (files.includes(filePath)) return false;
    files.push(filePath);
    return true;
  }

  function sortDiscoveredTestFiles(): void {
    ctx.testFiles.sort();
    for (const project of ctx.projects ?? []) {
      project.testFiles.sort();
    }
  }

  function removeFile(files: string[], filePath: string): boolean {
    const idx = files.indexOf(filePath);
    if (idx < 0) return false;
    files.splice(idx, 1);
    return true;
  }

  async function isExistingMatchingTestFile(filePath: string): Promise<boolean> {
    const resolved = path.resolve(resolvedRootDir, filePath);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return false;
    } catch {
      return false;
    }
    return !shouldIgnoreDiscoveryPath(resolved) && matchesConfiguredTestFile(resolved);
  }

  function refreshFileProjectLookup(filePath: string): void {
    fileToProject.delete(filePath);
    if (!ctx.projects) return;
    for (const project of ctx.projects) {
      if (project.testFiles.includes(filePath)) {
        fileToProject.set(filePath, project);
      }
    }
  }

  function isGlobalWholeFileWatchEnabled(): boolean {
    return ctx.testFiles.length > 0
      && ctx.testFiles.every((f) => findEntry(f, undefined, undefined) >= 0);
  }

  function isProjectWholeFileWatchEnabled(project: ResolvedProject): boolean {
    return project.testFiles.length > 0
      && project.testFiles.every((f) => findEntry(f, project.name, undefined) >= 0);
  }

  function replayWatchState(send: (msg: ServerMessage) => void): void {
    const replayWatchedProjects = new Set<string>();
    if (ctx.projects) {
      for (const project of ctx.projects) {
        if (project.testFiles.length > 0 && project.testFiles.every((f) => findEntry(f, project.name, undefined) >= 0)) {
          replayWatchedProjects.add(project.name);
          send({
            type: 'watch-event', filePath: 'project', projectName: project.name, event: 'watch-enabled',
          });
        }
      }
    }
    for (const [filePath, entries] of watchedEntries) {
      for (const entry of entries) {
        if (entry.projectName && replayWatchedProjects.has(entry.projectName) && !entry.testFilter) continue;
        send({
          type: 'watch-event', filePath, testFilter: entry.testFilter,
          projectName: entry.projectName, event: 'watch-enabled',
        });
      }
    }
  }

  function broadcastTestTreeWithCurrentState(): void {
    broadcast({ type: 'test-tree', files: testTree });

    for (const r of testResults.values()) {
      broadcast({
        type: 'test-status',
        fullName: r.fullName,
        filePath: r.filePath,
        status: wireStatus(r.status),
        duration: r.duration,
        error: r.error,
        tracePath: r.tracePath,
        videoPath: r.videoPath,
        workerId: r.workerId,
        projectName: r.projectName,
      });
    }

    for (const { filePath, projectName } of runningFiles.values()) {
      broadcast({ type: 'file-status', filePath, status: 'running', projectName });
    }

    if (workersEnabled && workersInitialized) {
      for (const w of uiWorkers) {
        if (w.busy && w.currentFile && w.currentTest) {
          broadcast({
            type: 'test-status',
            fullName: w.currentTest,
            filePath: w.currentFile.filePath,
            status: 'running',
            projectName: w.currentFile.projectName,
            workerId: w.id,
          });
        }
      }
    }

    replayWatchState(broadcast);
  }

  function removeKnownTestFile(filePath: string): boolean {
    const resolved = path.resolve(resolvedRootDir, filePath);
    if (!ctx.testFiles.includes(resolved)) return false;

    removeFile(ctx.testFiles, resolved);
    discoveredFileNodes.delete(resolved);
    failedFiles.delete(resolved);
    // Or a file deleted while failing to import goes on being reported as a
    // load failure, by path, for the life of the server.
    discoveryErrors.delete(resolved);
    for (const [key, value] of runningFiles) {
      if (value.filePath === resolved) runningFiles.delete(key);
    }
    for (const [key, result] of testResults) {
      if (result.filePath === resolved) testResults.delete(key);
    }
    if (watchedEntries.has(resolved)) {
      watchedEntries.delete(resolved);
      watcher?.unwatch(resolved);
    }

    if (ctx.projects) {
      for (const project of ctx.projects) {
        removeFile(project.testFiles, resolved);
      }
    }
    refreshFileProjectLookup(resolved);
    return true;
  }

  async function discoverOrRefreshTestFile(filePath: string): Promise<DiscoveryRefreshResult> {
    const resolved = path.resolve(resolvedRootDir, filePath);
    if (!(await isExistingMatchingTestFile(resolved))) {
      return { treeChanged: removeKnownTestFile(resolved), shouldRun: false };
    }

    const wasKnown = ctx.testFiles.includes(resolved);
    const matchingProjects = matchingProjectsForTestFile(resolved);
    const globalWatchWasEnabled = !wasKnown && isGlobalWholeFileWatchEnabled();
    const watchedProjects = !wasKnown
      ? matchingProjects.filter(isProjectWholeFileWatchEnabled)
      : [];

    const tree = await discoverFile(resolved);
    if (!tree) {
      return { treeChanged: removeKnownTestFile(resolved), shouldRun: false };
    }

    // A file can be deleted or renamed while the forked discovery process is
    // importing it. Re-check after the await so we don't add a stale node.
    if (!(await isExistingMatchingTestFile(resolved))) {
      return { treeChanged: removeKnownTestFile(resolved), shouldRun: false };
    }

    addUnique(ctx.testFiles, resolved);
    discoveredFileNodes.set(resolved, tree);

    for (const project of matchingProjects) {
      addUnique(project.testFiles, resolved);
    }
    refreshFileProjectLookup(resolved);

    if (globalWatchWasEnabled) {
      startWatching(resolved, undefined, undefined, false);
    }
    for (const project of watchedProjects) {
      startWatching(resolved, project.name, undefined, false);
    }

    return {
      treeChanged: true,
      shouldRun: !wasKnown && (globalWatchWasEnabled || watchedProjects.length > 0),
    };
  }

  async function discoverBatch(files: string[]): Promise<Array<{ file: string; result: DiscoveryRefreshResult }>> {
    const results: Array<{ file: string; result: DiscoveryRefreshResult }> = [];
    await forEachWithConcurrency(files, MAX_DISCOVERY_BATCH_CONCURRENCY, async (file, index) => {
      results[index] = {
        file,
        result: await discoverOrRefreshTestFile(file),
      };
    });
    return results;
  }

  function handleRemovedTestFile(filePath: string): void {
    const resolved = path.resolve(resolvedRootDir, filePath);
    pendingDiscoveryFiles.delete(resolved);
    if (!removeKnownTestFile(resolved)) return;

    rebuildTestTreeFromDiscoveredFiles();
    broadcastTestTreeWithCurrentState();
  }

  function scheduleDiscovery(filePath: string): void {
    const resolved = path.resolve(resolvedRootDir, filePath);
    if (shouldIgnoreDiscoveryPath(resolved) || !matchesConfiguredTestFile(resolved)) return;

    pendingDiscoveryFiles.add(resolved);
    if (discoveryBatchRunning) return;
    if (discoveryTimer) clearTimeout(discoveryTimer);
    discoveryTimer = setTimeout(() => {
      discoveryTimer = null;
      flushPendingDiscovery().catch(broadcastError);
    }, DISCOVERY_DEBOUNCE_MS);
  }

  async function flushPendingDiscovery(): Promise<void> {
    if (discoveryBatchRunning) return;
    discoveryBatchRunning = true;

    try {
      while (pendingDiscoveryFiles.size > 0) {
        const files = [...pendingDiscoveryFiles].sort();
        pendingDiscoveryFiles.clear();

        let treeChanged = false;
        const filesToRun = new Set<string>();
        const results = await discoverBatch(files);
        for (const { file, result } of results) {
          if (result.treeChanged) treeChanged = true;
          if (result.shouldRun) filesToRun.add(file);
        }

        if (treeChanged) {
          sortDiscoveredTestFiles();
          rebuildTestTreeFromDiscoveredFiles();
          broadcastTestTreeWithCurrentState();
        }
        if (filesToRun.size > 0) {
          watchQueue.scheduleFiles([...filesToRun]);
        }
      }
    } finally {
      discoveryBatchRunning = false;
      if (pendingDiscoveryFiles.size > 0 && !discoveryTimer) {
        discoveryTimer = setTimeout(() => {
          discoveryTimer = null;
          flushPendingDiscovery().catch(broadcastError);
        }, DISCOVERY_DEBOUNCE_MS);
      }
    }
  }

  function startTestDiscoveryWatcher(): void {
    if (discoveryWatcher) return;

    const roots = getTestDiscoveryWatchRoots(configuredTestPatterns(), resolvedRootDir)
      .filter((root) => !shouldIgnoreDiscoveryPath(root));
    if (roots.length === 0) return;

    discoveryWatcher = chokidarWatch(roots, {
      ignoreInitial: true,
      ignored: (candidate) => shouldIgnoreDiscoveryPath(candidate.toString()),
    });

    discoveryWatcher.on('error', broadcastError);
    discoveryWatcher.on('add', (filePath) => {
      scheduleDiscovery(filePath);
    });
    discoveryWatcher.on('change', (filePath) => {
      // A non-test source file (page object, fixture, helper) changed: the
      // persistent workers hold the old module in their ESM cache, so mark
      // them for recycling. Test files re-import fresh on every run already.
      const changed = path.resolve(resolvedRootDir, filePath);
      if (!matchesConfiguredTestFile(changed) && /\.(?:[cm]?[jt]sx?|json)$/.test(changed)) {
        markWorkersCodeStale(changed);
      }
      scheduleDiscovery(filePath);
      // Re-serve the source so a Source-tab preview of a not-yet-run test
      // reflects the edit. (For a test that has run, the client merges the
      // trace's captured sources over previews, so this is ignored there.)
      const resolved = path.resolve(resolvedRootDir, filePath);
      if (servedSourcePaths.has(resolved.replace(/\\/g, '/'))) {
        sendSourceFromDisk(resolved);
      }
    });
    discoveryWatcher.on('unlink', (filePath) => {
      const resolved = path.resolve(filePath);
      handleRemovedTestFile(resolved);
    });
  }

  function startWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined, emitEvent = true): void {
    let list = watchedEntries.get(filePath);
    const isNewFile = !list;
    if (!list) {
      list = [];
      watchedEntries.set(filePath, list);
    }
    if (findEntry(filePath, projectName, testFilter) >= 0) return;
    list.push({ projectName, testFilter });

    if (!watcher) {
      watcher = chokidarWatch([], { ignoreInitial: true });
      watcher.on('error', broadcastError);
      watcher.on('change', (changedPath) => {
        if (watchedEntries.has(changedPath)) {
          broadcast({ type: 'watch-event', filePath: changedPath, event: 'changed' });
          watchQueue.scheduleFiles([changedPath]);
        }
      });
    }

    if (isNewFile) watcher.add(filePath);
    if (emitEvent) {
      broadcast({ type: 'watch-event', filePath, testFilter, projectName, event: 'watch-enabled' });
    }
  }

  function stopWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined, emitEvent = true): void {
    const list = watchedEntries.get(filePath);
    const idx = findEntry(filePath, projectName, testFilter);
    if (!list || idx < 0) return;
    list.splice(idx, 1);
    if (list.length === 0) {
      watchedEntries.delete(filePath);
      watcher?.unwatch(filePath);
    }
    if (emitEvent) {
      broadcast({ type: 'watch-event', filePath, testFilter, projectName, event: 'watch-disabled' });
    }
  }

  /** Expand the watched entries for a file into concrete runs. Within a
   * project, a whole-file watch supersedes per-test watches (running the
   * file covers them). */
  function expandWatchedRuns(entries: WatchedEntry[]): Array<{ projectName: string | undefined; testFilter: string | undefined }> {
    const byProject = new Map<string, WatchedEntry[]>();
    for (const e of entries) {
      const key = e.projectName ?? '';
      let arr = byProject.get(key);
      if (!arr) { arr = []; byProject.set(key, arr); }
      arr.push(e);
    }
    const runs: Array<{ projectName: string | undefined; testFilter: string | undefined }> = [];
    for (const [, group] of byProject) {
      const wholeFile = group.find((e) => e.testFilter === undefined);
      if (wholeFile) {
        runs.push({ projectName: wholeFile.projectName, testFilter: undefined });
      } else {
        for (const e of group) runs.push({ projectName: e.projectName, testFilter: e.testFilter });
      }
    }
    return runs;
  }

  const watchQueue = new RunQueue(300, async (request) => {
    try {
      if (request.type === 'all') {
        await runAllFiles();
        return;
      }
      const file = request.files[0];
      if (!file) return;
      const entries = watchedEntries.get(file);
      if (!entries || entries.length === 0) {
        await runFile(file);
        return;
      }
      const runs = expandWatchedRuns(entries);
      // Parallel mode with multiple runs: dispatch as one batch so sibling
      // projects' workers can execute concurrently. The global `isRunning`
      // lock makes back-to-back `runFile` calls serialize — batching is
      // the only way to reach the parallelism the worker pool can offer.
      // Single-worker (or single-run) paths keep the simple sequential
      // shape since one device can only run one thing at a time.
      if (runs.length > 1 && useParallel()) {
        await ensureWorkersReady();
        const files: TaggedFile[] = runs.map((r) => {
          const project = projectForFile(file, r.projectName);
          return {
            filePath: file,
            projectUseOptions: project?.use as RunFileUseOptions | undefined,
            projectName: projectLabel(project),
            testFilter: r.testFilter,
          };
        });
        await runBatchParallel(files);
        return;
      }
      for (const r of runs) {
        await runFile(file, r.testFilter, r.projectName);
      }
    } catch (err) {
      broadcastError(err);
    }
  });

  // ─── Mirror Gesture Helpers ───

  /** Resolve the gRPC client + devicePixelRatio for a mirror gesture target. */
  function resolveGestureTarget(workerId?: number, deviceIndex?: number): {
    client: TapsmithGrpcClient | undefined
    dpr: number
    dims: { width: number; height: number } | undefined
  } {
    if (workersEnabled && workersInitialized) {
      const id = workerId ?? selectedWorkerId;
      const index = deviceIndex ?? (id === selectedWorkerId ? selectedDeviceIndex : 0);
      const worker = uiWorkers.find((w) => w.id === id && !w.retired);
      const platform = worker ? resolveWorkerPlatform(ctx, worker) : undefined;
      const serial = index > 0 ? worker?.members[index - 1]?.deviceSerial : worker?.deviceSerial;
      return {
        client: worker ? deviceClientOf(worker, index) : undefined,
        dpr: (serial && cachedScreenScale(serial, platform)) || 1,
        dims: lastFrameDims.get(mirrorKey(id, index)),
      };
    }
    return {
      client: ctx.client,
      dpr: cachedScreenScale(ctx.deviceSerial ?? '', singleWorkerPlatform) || 1,
      dims: lastFrameDims.get(mirrorKey(0, 0)),
    };
  }

  /** Convert a normalized (0–1) point to logical points for the target. */
  function normalizedToLogical(
    nx: number,
    ny: number,
    dims: { width: number; height: number } | undefined,
    dpr: number,
  ): { x: number; y: number } | undefined {
    if (!dims) return undefined;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return {
      x: (clamp(nx) * dims.width) / dpr,
      y: (clamp(ny) * dims.height) / dpr,
    };
  }

  // ─── Live WebView DOM for the element picker ───

  // A failed WebView connect spins until the device timeout, so don't
  // re-attempt on every 1s hierarchy poll: one attempt at a time, with a
  // cooldown after a failure. A successful connect is cached inside the
  // Device, making subsequent polls cheap. Concurrent polls share the
  // in-flight dump once the connection is established, so consecutive
  // hierarchy broadcasts never alternate between with- and without-DOM —
  // an alternating tree would make picks race the overlay.
  const WEBVIEW_INSPECT_FAILURE_COOLDOWN_MS = 15_000;
  let webviewDumpPromise: Promise<string | undefined> | null = null;
  let webviewEstablished = false;
  let webviewInspectFailedAt = 0;
  const debugWebview = (msg: string) => {
    if (process.env.TAPSMITH_DEBUG_WEBVIEW) console.error(`[webview-picker ${new Date().toISOString().slice(11, 23)}] ${msg}`);
  };
  function dumpWebViewDomForPicker(hierarchyXml: string): Promise<string | undefined> | undefined {
    // A WebView handle opened by the test session takes priority — it matches
    // what trace capture appends.
    const activeWebView = ctx.device?._activeWebView;
    if (activeWebView) {
      return activeWebView._dumpDomHierarchy().catch(() => undefined);
    }
    if (!ctx.device) return undefined;
    if (webviewDumpPromise) {
      // During the initial connect (which can take seconds), don't block the
      // native broadcast behind it; once established, share the dump so every
      // broadcast carries the overlay.
      debugWebview(`in-flight; established=${webviewEstablished}`);
      return webviewEstablished ? webviewDumpPromise : undefined;
    }
    if (Date.now() - webviewInspectFailedAt < WEBVIEW_INSPECT_FAILURE_COOLDOWN_MS) {
      debugWebview('cooldown; skipping');
      return undefined;
    }
    const device = ctx.device;
    debugWebview('starting dump');
    webviewDumpPromise = device._dumpWebViewDomForInspection(hierarchyXml)
      .then((dom) => {
        debugWebview(`dump resolved: ${dom === null ? 'FAILED' : dom === undefined ? 'no-webview' : `dom ${dom.length}b`}`);
        if (dom === null) {
          webviewInspectFailedAt = Date.now();
          webviewEstablished = false;
          return undefined;
        }
        if (dom !== undefined) webviewEstablished = true;
        return dom;
      })
      // The promise is deliberately left un-awaited until the connection is
      // established (below), so a rejection would otherwise be unhandled.
      // _dumpWebViewDomForInspection shouldn't reject, but treat one as a
      // failure (cooldown) rather than trusting that contract.
      .catch(() => {
        webviewInspectFailedAt = Date.now();
        webviewEstablished = false;
        return undefined;
      })
      .finally(() => { webviewDumpPromise = null; });
    // Until the connection is established, run the dump in the background so
    // no hierarchy broadcast — including the initiator's — blocks behind a
    // multi-second connect (or a stale-connection failure). Once established,
    // dumps are cheap and awaiting keeps every broadcast carrying the overlay.
    return webviewEstablished ? webviewDumpPromise : undefined;
  }

  // ─── Command Handler ───

  function handleCommand(msg: ClientMessage): void {
    switch (msg.type) {
      case 'run-test':
        if (!ctx.testFiles.includes(msg.filePath)) break;
        if (msg.runDeps) runFileWithDeps(msg.filePath, msg.fullName, msg.projectName).catch(broadcastError);
        else runFile(msg.filePath, msg.fullName, msg.projectName).catch(broadcastError);
        break;
      case 'run-file':
        if (!ctx.testFiles.includes(msg.filePath)) break;
        if (msg.runDeps) runFileWithDeps(msg.filePath, undefined, msg.projectName).catch(broadcastError);
        else runFile(msg.filePath, undefined, msg.projectName).catch(broadcastError);
        break;
      case 'run-all':
        runAllFiles().catch(broadcastError);
        break;
      case 'run-failed': {
        const files = [...failedFiles];
        if (files.length > 0 && !isRunning) {
          failedFiles.clear();
          ;(async () => {
            if (useParallel() && files.length > 1) {
              markRunStarted();
              screenPollActive = true;
              parallelRunAborted = false;
              await ensureWorkersReady();

              broadcast({ type: 'run-start', fileCount: files.length });

              const taggedFiles: TaggedFile[] = files.map((f) => {
                const project = fileToProject.get(f);
                return {
                  filePath: f,
                  projectUseOptions: project?.use as RunFileUseOptions | undefined,
                  projectName: projectLabel(project),
                };
              });

              try {
                const r = await dispatchFilesParallel(taggedFiles);
                endRun({
                  status: r.failed > 0 ? 'failed' : 'passed',
                  duration: r.duration,
                  passed: r.passed,
                  failed: r.failed,
                  skipped: r.skipped,
                });
              } catch (err) {
                if (!parallelRunAborted) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  broadcast({ type: 'error', message: `Failed to run failed tests: ${errMsg}` });
                }
                endRun({ status: 'failed', duration: 0, passed: 0, failed: parallelRunAborted ? 0 : 1, skipped: 0 });
              } finally {
                markRunEnded();
                screenPollActive = false;
              }
            } else {
              // Single-worker: run files sequentially via runFile (each manages
              // isRunning). A stop during one file must not start the next.
              for (const f of files) {
                const r = await runFile(f);
                if (stopRequested || r.status === 'stopped') break;
              }
            }
          })().catch(broadcastError);
        }
        break;
      }
      case 'run-project':
        if (msg.runDeps) runProject(msg.projectName).catch(broadcastError);
        else runProjectOnly(msg.projectName).catch(broadcastError);
        break;
      case 'stop-run':
        stopRun();
        break;
      case 'toggle-watch':
        if (msg.filePath === 'all') {
          // The 'all' toggle watches every file at whole-file scope,
          // unscoped by project (applies across all projects that include
          // the file).
          const allWhole = ctx.testFiles.every((f) => findEntry(f, undefined, undefined) >= 0);
          for (const f of ctx.testFiles) {
            if (allWhole) stopWatching(f, undefined, undefined);
            else startWatching(f, undefined, undefined);
          }
        } else if (msg.filePath === 'project' && msg.projectName) {
          // Watch every file within a specific project at whole-file scope.
          // Per-file events are suppressed so only the project-level icon
          // lights up in the UI — the child file icons stay dark. A single
          // project-scoped event is broadcast to flip the project node.
          const project = ctx.projects?.find((p) => p.name === msg.projectName);
          if (!project) break;
          const allWatched = project.testFiles.every((f) => findEntry(f, msg.projectName, undefined) >= 0);
          for (const f of project.testFiles) {
            if (allWatched) stopWatching(f, msg.projectName, undefined, false);
            else startWatching(f, msg.projectName, undefined, false);
          }
          broadcast({
            type: 'watch-event',
            filePath: 'project',
            projectName: msg.projectName,
            event: allWatched ? 'watch-disabled' : 'watch-enabled',
          });
        } else {
          const exists = findEntry(msg.filePath, msg.projectName, msg.testFilter) >= 0;
          if (exists) {
            stopWatching(msg.filePath, msg.projectName, msg.testFilter);
          } else {
            startWatching(msg.filePath, msg.projectName, msg.testFilter);
          }
        }
        break;
      case 'request-hierarchy': {
        // Note: deliberately does NOT bump lastMirrorInteraction — the client
        // polls this every second while the Locator tab is live-bound, which
        // would otherwise pin the screenshot poll at the interactive rate.
        const hierWorkerId = msg.workerId ?? selectedWorkerId;
        const hierDeviceIndex = msg.deviceIndex ?? (hierWorkerId === selectedWorkerId ? selectedDeviceIndex : 0);
        const hierWorker = uiWorkers.find((w) => w.id === hierWorkerId && !w.retired);
        const hierClient = hierWorker ? deviceClientOf(hierWorker, hierDeviceIndex) : undefined;
        hierClient?.getUiHierarchy().then(async (response) => {
          let xml = response.hierarchyXml;
          if (!xml) return;
          // Append the WebView DOM so picks inside a WebView suggest
          // webview.* locators. Primary-device only — the server's Device
          // instance can open a WebView connection to that device; other
          // workers' devices (and group members) have none.
          const webviewDom = hierWorker?.adoptedPrimary && hierDeviceIndex === 0 ? await dumpWebViewDomForPicker(xml) : undefined;
          if (webviewDom) {
            const lastClose = xml.lastIndexOf('</');
            if (lastClose !== -1) {
              xml = xml.slice(0, lastClose) + webviewDom + '\n' + xml.slice(lastClose);
            }
          }
          broadcast({ type: 'hierarchy-update', xml, workerId: hierWorkerId, deviceIndex: hierDeviceIndex });
        }).catch(() => {});
        break;
      }
      case 'request-source':
        sendSourceFromDisk(msg.path);
        break;
      case 'mirror-tap': {
        noteMirrorInteraction(msg.workerId, 'tap');
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        const p = normalizedToLogical(msg.x, msg.y, t.dims, t.dpr);
        if (t.client && p) t.client.tapXY(p.x, p.y).catch(() => {});
        break;
      }
      case 'mirror-long-press': {
        noteMirrorInteraction(msg.workerId, 'long press');
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        const p = normalizedToLogical(msg.x, msg.y, t.dims, t.dpr);
        if (t.client && p) t.client.longPressXY(p.x, p.y, msg.durationMs).catch(() => {});
        break;
      }
      case 'mirror-swipe': {
        noteMirrorInteraction(msg.workerId, 'swipe');
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        const from = normalizedToLogical(msg.fromX, msg.fromY, t.dims, t.dpr);
        const to = normalizedToLogical(msg.toX, msg.toY, t.dims, t.dpr);
        if (t.client && from && to) {
          t.client.dragXY(from.x, from.y, to.x, to.y, msg.durationMs).catch(() => {});
        }
        break;
      }
      case 'mirror-input-text': {
        noteMirrorInteraction(msg.workerId, 'text input');
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        if (t.client) t.client.inputText(msg.text).catch(() => {});
        break;
      }
      case 'mirror-press-key': {
        noteMirrorInteraction(msg.workerId, 'key press');
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        if (t.client) t.client.pressKey(msg.key).catch(() => {});
        break;
      }
      case 'mirror-touch-start': {
        noteMirrorInteraction(msg.workerId, 'touch');
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        const p = normalizedToLogical(msg.x, msg.y, t.dims, t.dpr);
        if (t.client && p) t.client.touchDown(p.x, p.y, 0).catch(() => {});
        break;
      }
      case 'mirror-touch-move': {
        lastMirrorInteraction = Date.now();
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        const p = normalizedToLogical(msg.x, msg.y, t.dims, t.dpr);
        if (t.client && p) t.client.touchMove(p.x, p.y, msg.tMs).catch(() => {});
        break;
      }
      case 'mirror-touch-end': {
        lastMirrorInteraction = Date.now();
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        const p = normalizedToLogical(msg.x, msg.y, t.dims, t.dpr);
        if (t.client && p) t.client.touchUp(p.x, p.y, msg.tMs).catch(() => {});
        break;
      }
      case 'mirror-touch-cancel': {
        lastMirrorInteraction = Date.now();
        const t = resolveGestureTarget(msg.workerId, msg.deviceIndex);
        if (t.client) t.client.touchCancel().catch(() => {});
        break;
      }
      case 'select-worker':
        selectedWorkerId = msg.workerId;
        selectedDeviceIndex = msg.deviceIndex ?? 0;
        screenViewMode = msg.workerId;
        broadcastSelectedDeviceInfo();
        break;
      case 'select-worker-view':
        screenViewMode = msg.mode;
        if (typeof msg.mode === 'number') {
          selectedWorkerId = msg.mode;
          selectedDeviceIndex = msg.deviceIndex ?? 0;
          broadcastSelectedDeviceInfo();
        }
        break;
      case 'respawn-worker': {
        const worker = uiWorkers.find((w) => w.id === msg.workerId);
        if (worker && !worker.retired) {
          worker.retired = true;
          worker.busy = false;
          try { if (worker.process.connected) worker.process.send({ type: 'shutdown' }); } catch { /* dead */ }
          console.log(`${DIM}Worker ${worker.id} marked for respawn by user${RESET}`);
          broadcastWorkerStatus(worker, 'error');
          ensureWorkersReady().then(() => {
            const respawned = uiWorkers.find((w) => w.id === msg.workerId);
            if (respawned && !respawned.retired) {
              broadcastWorkerStatus(respawned, 'idle');
            }
          }).catch(() => {});
        }
        break;
      }
      case 'set-preferences': {
        preferences = { ...preferences, ...msg.preferences };
        broadcast({ type: 'preferences', preferences });
        for (const w of uiWorkers) if (!w.retired) readinessEvent(w, { type: 'preferences-changed' });
        break;
      }
      case 'prepare-now': {
        for (const w of uiWorkers) {
          if (w.retired) continue;
          if (msg.workerId !== undefined && w.id !== msg.workerId) continue;
          readinessEvent(w, { type: 'prepare-now' });
        }
        break;
      }
      case 'cancel-prepare': {
        for (const w of uiWorkers) {
          if (w.retired) continue;
          if (msg.workerId !== undefined && w.id !== msg.workerId) continue;
          const st = w.readiness?.state;
          if (st?.kind === 'preparing') executeReadinessCommands(w, [{ type: 'send-cancel-prepare', prepareId: st.prepareId }]);
        }
        break;
      }
      case 'select-node': {
        selectedNode = msg.filePath ? { file: msg.filePath, projectName: msg.projectName } : undefined;
        for (const w of uiWorkers) if (!w.retired) readinessEvent(w, { type: 'candidate-changed' });
        break;
      }
      case 'recycle-worker': {
        const worker = uiWorkers.find((w) => w.id === msg.workerId);
        if (!worker || worker.retired) break;
        if (worker.busy) {
          broadcast({ type: 'error', message: `Worker ${worker.id} is running a file — it will recycle when the run ends` });
          worker.codeStale = true;
          break;
        }
        void recycleWorker(worker, 'requested from the UI');
        break;
      }
      case 'set-filter':
        // Filtering is client-side — no action needed
        break;
    }
  }

  // ─── HTTP Server ───

  let spaHtml: string;
  if (options.devUrl) {
    spaHtml = buildDevShellHtml(options.devUrl);
    if (launchProgress) launchProgress.note(`UI mode dev shell loading SPA from ${options.devUrl} (HMR enabled).`);
    else console.log(`${YELLOW}UI mode dev shell — loading SPA from ${options.devUrl} (HMR enabled)${RESET}`);
  } else {
    try {
      spaHtml = fs.readFileSync(SPA_HTML_PATH, 'utf-8');
    } catch {
      spaHtml = buildFallbackHtml();
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(spaHtml);
      return;
    }

    // Serve video MP4 files for download.
    // Security: only serve .mp4 files that reside within the project's output directory.
    if (url.pathname.startsWith('/video/')) {
      const videoPath = decodeURIComponent(url.pathname.slice('/video/'.length));
      if (!videoPath.endsWith('.mp4')) {
        res.writeHead(404);
        res.end('Video not found');
        return;
      }
      const resolvedVideo = path.resolve(videoPath);
      const resolvedOutputDir = path.resolve(ctx.config.rootDir, ctx.config.outputDir);
      const relative = path.relative(resolvedOutputDir, resolvedVideo);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolvedVideo)) {
        res.writeHead(404);
        res.end('Video not found');
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolvedVideo);
      } catch {
        res.writeHead(404);
        res.end('Video not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(resolvedVideo)}"`,
      });
      fs.createReadStream(resolvedVideo)
        .on('error', () => { res.end(); })
        .pipe(res);
      return;
    }

    // Serve trace ZIP files for download.
    // Security: only serve .zip files that reside within the project's output directory.
    if (url.pathname.startsWith('/trace/')) {
      const tracePath = decodeURIComponent(url.pathname.slice('/trace/'.length));
      if (!tracePath.endsWith('.zip')) {
        res.writeHead(404);
        res.end('Trace not found');
        return;
      }
      // tracePath may be absolute (from packageTrace) or relative
      const resolvedTrace = path.resolve(tracePath);
      const resolvedOutputDir = path.resolve(ctx.config.rootDir, ctx.config.outputDir);
      const relative = path.relative(resolvedOutputDir, resolvedTrace);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolvedTrace)) {
        res.writeHead(404);
        res.end('Trace not found');
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolvedTrace);
      } catch {
        res.writeHead(404);
        res.end('Trace not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(resolvedTrace)}"`,
      });
      fs.createReadStream(resolvedTrace)
        .on('error', () => { res.end(); })
        .pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // ─── WebSocket Server ───

  const wss = new WebSocketServer({ server });

  // ws re-emits the HTTP server's 'error' events here; without a listener
  // they rethrow as uncaughtException and kill the process before the bind
  // failure below can be reported (PILOT-253). Bind failures are surfaced
  // via the listen promise, so only log errors from an already-running server.
  wss.on('error', (err) => {
    if (server.listening) console.error(`UI server error: ${err.message}`);
  });

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send current state to new client
    ws.send(JSON.stringify({ type: 'test-tree', files: testTree } satisfies ServerMessage));

    // Sync run state so the client knows whether a run is in progress.
    // Sent before test results so the Running indicator appears immediately.
    ws.send(JSON.stringify({ type: 'run-state', isRunning, startedAt: runStartedAt } satisfies ServerMessage));

    // Replay accumulated test results so a reconnecting client (e.g. after
    // the laptop wakes from sleep) sees the same passed/failed statuses it
    // had before — `test-tree` ships a tree of 'idle' nodes, and individual
    // `test-status` events aren't buffered.
    for (const r of testResults.values()) {
      ws.send(JSON.stringify({
        type: 'test-status',
        fullName: r.fullName,
        filePath: r.filePath,
        status: wireStatus(r.status),
        duration: r.duration,
        error: r.error,
        tracePath: r.tracePath,
        videoPath: r.videoPath,
        workerId: r.workerId,
        projectName: r.projectName,
      } satisfies ServerMessage));
    }

    // Replay trace events, source files, and network data so the trace
    // panel restores on reconnect (not just the tree pass/fail icons).
    // Trace events go first so entries exist before source injection.
    for (const traceMsg of traceBuffer) {
      ws.send(JSON.stringify(traceMsg));
    }
    for (const sourceMsg of sourceBuffer.values()) {
      ws.send(JSON.stringify(sourceMsg));
    }
    for (const networkMsg of networkBuffer.values()) {
      ws.send(JSON.stringify(networkMsg));
    }

    // Replay running file statuses so the tree shows which files are mid-run.
    for (const { filePath, projectName } of runningFiles.values()) {
      ws.send(JSON.stringify({ type: 'file-status', filePath, status: 'running', projectName } satisfies ServerMessage));
    }

    ws.send(JSON.stringify(getMcpStatus()));
    for (const mcpMsg of mcpToolCallBuffer) {
      ws.send(JSON.stringify(mcpMsg));
    }

    if (workersInitialized) {
      // Send workers info
      ws.send(JSON.stringify({
        type: 'workers-info',
        workers: uiWorkers.map((w) => {
          const platform = resolveWorkerPlatform(ctx, w);
          return {
            workerId: w.id,
            deviceSerial: w.deviceSerial,
            displayName: w.displayName,
            platform,
            devicePixelRatio: cachedScreenScale(w.deviceSerial, platform),
            devices: workerDevicesInfo(w),
          };
        }),
      } satisfies ServerMessage));

      // Send device info for selected worker
      const selectedWorker = uiWorkers.find((w) => w.id === selectedWorkerId);
      if (selectedWorker) {
        const platform = resolveWorkerPlatform(ctx, selectedWorker);
        ws.send(JSON.stringify({
          type: 'device-info',
          serial: selectedWorker.displayName || selectedWorker.deviceSerial,
          model: undefined,
          isEmulator: isEmulatorOrSimulator(selectedWorker.deviceSerial, platform),
          platform,
          tapsmithVersion: TAPSMITH_VERSION,
          devicePixelRatio: cachedScreenScale(selectedWorker.deviceSerial, platform),
        } satisfies ServerMessage));
      }

      // Send current worker statuses (including currentFile/currentTest)
      for (const w of uiWorkers) {
        ws.send(JSON.stringify(workerStatusMessage(w, w.retired ? 'error' : w.busy ? 'running' : 'idle')));
      }
      ws.send(JSON.stringify({ type: 'preferences', preferences } satisfies ServerMessage));
      for (const activity of deviceActivityBuffer) {
        ws.send(JSON.stringify(activity));
      }
      // Replay in-flight slow-action labels ("Clearing app data…") so a
      // client that connects mid-preflight sees what the device is doing.
      for (const [workerId, message] of lastProgressByWorker) {
        ws.send(JSON.stringify({ type: 'run-progress', workerId, message } satisfies ServerMessage));
      }

      // Replay active tests so they highlight as running in the tree.
      // worker-status updates the worker panel but not the tree nodes.
      for (const w of uiWorkers) {
        if (w.busy && w.currentFile && w.currentTest) {
          ws.send(JSON.stringify({
            type: 'test-status',
            fullName: w.currentTest,
            filePath: w.currentFile.filePath,
            status: 'running' as const,
            projectName: w.currentFile.projectName,
            workerId: w.id,
          } satisfies ServerMessage));
        }
      }
    } else if (ctx.deviceSerial) {
      ws.send(JSON.stringify({
        type: 'device-info',
        serial: singleWorkerDisplayName ?? ctx.deviceSerial,
        model: undefined,
        isEmulator: isEmulatorOrSimulator(ctx.deviceSerial, singleWorkerPlatform),
        platform: singleWorkerPlatform,
        tapsmithVersion: TAPSMITH_VERSION,
        devicePixelRatio: cachedScreenScale(ctx.deviceSerial, singleWorkerPlatform),
      } satisfies ServerMessage));
    }

    // Replay watch state so toggle icons restore on reconnect.
    // Derive project-level watches from watchedEntries rather than tracking
    // separately — avoids desync if individual files are unwatched.
    replayWatchState((msg) => ws.send(JSON.stringify(msg)));

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        handleCommand(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  // ─── Start ───

  launchProgress?.start('ui-server', 'binding local web UI');
  let actualPort: number;
  try {
    actualPort = await new Promise<number>((resolve, reject) => {
      const tryPort = options.port ?? 0;
      server.once('error', reject);
      server.listen(tryPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to bind UI server'));
        }
      });
    });
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    const message = (cause as NodeJS.ErrnoException).code === 'EADDRINUSE' && options.port !== undefined
      ? `port ${options.port} is already in use — pass a different --ui-port or free the port`
      : cause.message;
    launchProgress?.fail('ui-server', message);
    throw new LaunchSetupError(`Failed to start UI server: ${message}`, { cause });
  }
  launchProgress?.complete('ui-server', `http://127.0.0.1:${actualPort}/`);
  // ─── MCP Server (separate fixed port) ───

  const MCP_DEFAULT_PORT = 9274;
  const mcpHttpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Streamable HTTP endpoint — handles POST (JSON-RPC) + GET (SSE stream) + DELETE (session close)
    if (url.pathname === '/mcp') {
      try {
        await mcpRouter.handleRequest(req, res);
      } catch (error) {
        console.error('MCP transport error:', error);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      }
      return;
    }

    // Event ingest from standalone `tapsmith mcp-server`
    if (url.pathname === '/mcp-events' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          const mcpMsg: McpToolCallMessage = { type: 'mcp-tool-call', ...event };
          if (mcpToolCallBuffer.length < MAX_MCP_BUFFER) mcpToolCallBuffer.push(mcpMsg);
          broadcast(mcpMsg);
          if (mcpMsg.status !== 'started') invalidateForMcpTool(mcpMsg.tool, mcpMsg.args);
        } catch { /* ignore malformed */ }
        res.writeHead(200);
        res.end('OK');
      });
      return;
    }

    // Daemon discovery for multi-daemon MCP connections
    if (url.pathname === '/api/daemon-ports' && req.method === 'GET') {
      const daemons = uiWorkers
        .filter(w => !w.retired)
        .flatMap(w => [
          {
            address: `127.0.0.1:${w.daemonPort}`,
            deviceSerial: w.deviceSerial,
            // Resolved, like every other consumer of a worker's platform: the raw
            // field comes from the bucket config and is unset when that config
            // declares no platform. An MCP session tags its connection from this,
            // and an untagged one matches no project — so `tap({project: 'ios'})`
            // would report no ios device with the worker sitting right there.
            platform: resolveWorkerPlatform(ctx, w),
          },
          // Group members are this session's too — a headless MCP server must
          // not claim their daemons.
          ...w.members.map((m) => ({
            address: `127.0.0.1:${m.daemonPort}`,
            deviceSerial: m.deviceSerial,
            platform: resolveWorkerPlatform(ctx, w),
          })),
        ]);
      // Every daemon this session drives, workers *and* the primary one. A
      // headless MCP server has to be able to tell that the daemon at the
      // default address belongs to a UI run: it reaches that address through
      // its own `daemonAddress`, where the `ui` and `peer` guards never apply,
      // and would claim it, repoint it and start its own agent on it.
      const owned = [
        ...daemons.map((d) => d.address),
        ctx.daemonAddress ?? ctx.config.daemonAddress,
      ].filter(Boolean);
      // Every device this session provisioned, not just those with a live
      // worker: the primary before its worker spawns, and each group member.
      // A headless MCP server refusing our daemons but then starting its own
      // agent on these devices took them over just the same.
      const devices = [...new Set([...workerGroups.flat(), ...daemons.map((d) => d.deviceSerial)].filter(Boolean))];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ daemons, owned, devices }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  mcpPort = MCP_DEFAULT_PORT;
  launchProgress?.start('mcp', `binding MCP endpoint on ${MCP_DEFAULT_PORT}`);
  try {
    await new Promise<void>((resolve, reject) => {
      mcpHttpServer.listen(MCP_DEFAULT_PORT, '127.0.0.1', resolve);
      mcpHttpServer.on('error', reject);
    });
  } catch {
    // Port in use — fall back to a random port
    mcpPort = await new Promise<number>((resolve, reject) => {
      mcpHttpServer.listen(0, '127.0.0.1', () => {
        const addr = mcpHttpServer.address();
        if (typeof addr === 'object' && addr) resolve(addr.port);
        else reject(new Error('Failed to bind MCP server'));
      });
      mcpHttpServer.on('error', reject);
    });
  }
  launchProgress?.complete('mcp', `http://127.0.0.1:${mcpPort}/mcp`);

  // Discover tests
  await discoverAllFiles();
  startTestDiscoveryWatcher();

  // Initialize multi-worker if configured
  if (workersEnabled) {
    await initializeWorkers();
  }

  // Start screen polling
  scheduleScreenPoll();

  // Open browser
  const viewerUrl = `http://127.0.0.1:${actualPort}/`;
  launchProgress?.start('browser', 'opening default browser');
  try {
    const open = await import('open');
    await open.default(viewerUrl);
    launchProgress?.complete('browser', 'opened default browser');
  } catch {
    if (launchProgress) launchProgress.complete('browser', `open manually: ${viewerUrl}`);
    else console.log(`Tapsmith UI: ${viewerUrl}`);
  }

  launchProgress?.finish();
  if (!launchProgress) {
    const workerLabel = workersEnabled && workersInitialized
      ? `${uiWorkers.length} worker(s) across ${uiWorkers.map((w) => w.deviceSerial).join(', ')}`
      : `Device: ${ctx.deviceSerial ?? 'unknown'}`;
    console.log(`\x1b[2m${workerLabel} | ${ctx.testFiles.length} test file(s)\x1b[0m`);
  }
  console.log(`\x1b[1mUI mode ready at ${viewerUrl}\x1b[0m`);
  console.log(`\x1b[2mMCP ready at http://127.0.0.1:${mcpPort}/mcp\x1b[0m`);

  // Write port file for standalone MCP server discovery
  const { uiPortFilePath, ensureDaemonStateDir } = await import('../mcp/port-file.js');
  const portFilePath = uiPortFilePath();
  try {
    // The directory is ours to create: a UI server writes nothing else there,
    // and without this the first run on a machine publishes no port at all.
    ensureDaemonStateDir();
    fs.writeFileSync(portFilePath, String(mcpPort));
  } catch (err) {
    // Non-fatal, but not silent: headless sessions use this file to tell which
    // daemons belong to this run, and without it they may claim one of them.
    console.error(`${YELLOW}Could not publish the MCP port to ${portFilePath}: ${err instanceof Error ? err.message : err}.${RESET}`);
  }

  return {
    port: actualPort,
    close: () => {
      if (screenPollTimer) clearTimeout(screenPollTimer);

      // Clean up workers, then the primary device/client the CLI handed us
      // (the adopted worker shares that client, so it is closed last).
      if (recycleTimer) clearTimeout(recycleTimer);
      for (const t of readinessTimers.values()) clearTimeout(t);
      readinessTimers.clear();
      // The CLI calls process.exit right after close(), so a cooperative
      // shutdown message may never be flushed — signal the child as well so
      // no worker outlives the server (its tsx wrapper forwards the signal).
      for (const worker of uiWorkers) {
        worker.retired = true; // deliberate shutdown, not an idle crash
        void terminateWorkerProcess(worker);
        try { worker.process.kill('SIGTERM'); } catch { /* already dead */ }
        releaseWorkerResources(worker);
      }
      ctx.device?.close();
      ctx.client?.close();

      mcpHttpServer.close();
      mcpRouter.close();
      try { fs.unlinkSync(portFilePath); } catch { /* already gone */ }
      if (watcher) watcher.close();
      if (discoveryWatcher) discoveryWatcher.close();
      if (discoveryTimer) clearTimeout(discoveryTimer);
      pendingDiscoveryFiles.clear();
      for (const ws of clients) ws.close();
      wss.close();
      server.close();

      preserveEmulatorsForReuse(ctx.launchedEmulators);
    },
  };
}

// ─── Dev-shell HTML ───

/**
 * HTML shell used in dev mode: points the browser at a running Vite dev
 * server for the SPA modules while the WebSocket still talks to this server.
 */
// Inlined website favicon (coral Tapsmith "T" mark) so the dev shell's tab icon
// matches the built SPA and the marketing site.
const FAVICON_DATA_URI = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%20213%20256%22%20fill%3D%22none%22%3E%3Cpath%20fill%3D%22%23fd8567%22%20d%3D%22M11.48%2022.33C9.25%2017.5%2012.6%2011.05%2017.98%2010.49%2024.18%2010.14%2030.01%2012.83%2035.99%2014.02%2066.76%2020.77%2097.38%2028.19%20128.06%2035.31%20141.5%2037.95%20154.68%2041.75%20168.07%2044.64%20170.87%2045.08%20173.21%2046.74%20175.45%2048.36%20181.25%2065.26%20187.66%2081.94%20193.43%2098.83%20194.64%20101.62%20195.89%20104.5%20195.43%20107.62%20192.96%20107.83%20190.47%20107.83%20188.07%20107.15%20178.4%20104.74%20168.53%20103.2%20158.87%20100.73%20148.28%2098.08%20137.41%2096.73%20126.94%2093.62%20126.6%2093.88%20125.92%2094.4%20125.58%2094.66%20125.27%2094.86%20124.66%2095.25%20124.35%2095.45%20124.49%2094.71%20124.63%2093.97%20124.76%2093.23%20111.54%2091.01%2098.48%2087.93%2085.23%2085.85%2069.77%2081.91%2053.66%2085.18%2038.01%2082.87%2034.91%2082.32%2031.34%2081.02%2030.29%2077.71%2023.98%2059.27%2017.98%2040.71%2011.48%2022.33Z%22/%3E%3Cpath%20fill%3D%22%23fd8567%22%20d%3D%22M77.6%20137.56C79.44%20135.25%2081.85%20133.48%2084%20131.48%2085.18%20131.79%2086.36%20132.11%2087.54%20132.42%2086.89%20135.34%2086.74%20138.42%2088.29%20141.11%2086.48%20140.47%2084.67%20139.86%2082.84%20139.27%2084.24%20143.44%2086.4%20147.34%2089.47%20150.53%2092.42%20153.63%2094.05%20157.65%2095.44%20161.63%2097.54%20167.71%20101.58%20172.82%20104.37%20178.57%20106.31%20182.58%20108.12%20186.67%20110.68%20190.34%20114.16%20195.34%20116.38%20201.07%20119.84%20206.08%20121.65%20208.41%20121.62%20211.4%20121.64%20214.19%20108.58%20224.22%2096.19%20235.07%2083.45%20245.48%2081.96%20247.13%2079.67%20246.6%2077.71%20246.62%2076.97%20245.82%2076.22%20245.03%2075.47%20244.24%2075.11%20211.83%2076.11%20179.41%2075.83%20147%2075.9%20143.82%2075.71%20140.3%2077.6%20137.56Z%22/%3E%3Cpath%20fill%3D%22%23fd8b6f%22%20d%3D%22M110.93%20106.99C115.32%20103.06%20119.13%2098.35%20124.35%2095.45%20124.66%2095.25%20125.27%2094.86%20125.58%2094.66%20127.12%20103.01%20125.77%20111.54%20126.18%20119.98%20125.26%20148.98%20125.72%20178.02%20125.6%20207.03%20125.67%20209.98%20123.54%20212.21%20121.64%20214.19%20121.62%20211.4%20121.65%20208.41%20119.84%20206.08%20116.38%20201.07%20114.16%20195.34%20110.68%20190.34%20108.12%20186.67%20106.31%20182.58%20104.37%20178.57%20101.58%20172.82%2097.54%20167.71%2095.44%20161.63%2094.05%20157.65%2092.42%20153.63%2089.47%20150.53%2086.4%20147.34%2084.24%20143.44%2082.84%20139.27%2084.67%20139.86%2086.48%20140.47%2088.29%20141.11%2086.74%20138.42%2086.89%20135.34%2087.54%20132.42%2086.36%20132.11%2085.18%20131.79%2084%20131.48%2093.12%20123.47%20101.68%20114.85%20110.93%20106.99Z%22/%3E%3C/svg%3E';

function buildDevShellHtml(devUrl: string): string {
  // Validate as a URL (fail loudly on garbage) and escape for an attribute
  // context before interpolation. The value comes from a CLI flag / env var
  // and isn't attacker-controlled in any realistic threat model, but an
  // unescaped interpolation would trip future linters and make this
  // function unsafe if anyone ever wires in untrusted input.
  let base: string;
  try {
    const u = new URL(devUrl);
    base = u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid --ui-dev-url: ${devUrl}`);
  }
  // Covers both attribute-context delimiters (double + single quote) so the
  // helper stays safe if the template below ever switches to single quotes.
  const attr = (s: string) => s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tapsmith UI Mode (dev)</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
  <script type="module" src="${attr(base)}/@vite/client"></script>
  <script type="module" src="${attr(base)}/main.tsx"></script>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;
}

// ─── Fallback HTML ───

function buildFallbackHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tapsmith UI Mode</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 40px; background: #1e1e1e; color: #e0e0e0; }
    h1 { color: #fff; }
    .info { color: #888; }
  </style>
</head>
<body>
  <h1>Tapsmith UI Mode</h1>
  <p class="info">The UI mode bundle was not found. Run <code>npm run build:ui-mode</code> to build it.</p>
  <p class="info">In development, run <code>npx vite --config vite.config.ui-mode.ts</code> for hot-reload.</p>
</body>
</html>`;
}
