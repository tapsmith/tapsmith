#!/usr/bin/env -S node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON

/**
 * The CLI. `npx tapsmith` runs `bin.ts`, which checks the Node.js version
 * and then imports this file; the shebang here serves only running dist/cli.js
 * directly. The command tree, flags and help live in `cli-program.ts`; this
 * file holds what the commands do, above all the `tapsmith test` run body.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { claimBanner, printsBanner, runCli, type CliHandlers, type TestCommandArgs } from './cli-program.js';
import { loadConfig, configPathOf, tapsmithExecCommand, normalizeGrep, resolveDeviceStrategy, resolveDeviceGroup, primaryDevicePin, deviceGroupSize, assignGroupMemberDevices, EXPLICIT_WORKERS, isExplicitWorkers, isTapsmithNotInstalledError, isConfigValidationError, configLoadFailureOf, type DeviceGroupEntry, type TapsmithConfig } from './config.js';
import figlet from 'figlet';
import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, loadFailureResult, collectResults, markFileRetryFlakes, type RunDevice, type TestResult, type SuiteResult } from './runner.js';
import { runnerClaimsUnhandledRejection } from './unhandled-errors.js';
import { telemetry, readSdkVersion, ensureSessionEnv } from './telemetry.js';
import { createReporters, ReporterDispatcher, type FullResult } from './reporter.js';
import { ensureSessionReady } from './session-preflight.js';
import {
  closeDeviceSession,
  sessionsForRun,
  consumePrepared,
  openDeviceGroup,
  openDeviceSession,
  recoverDeviceSessions,
  resolveDaemonBin,
  startDaemon,
  type DeviceSession,
} from './device-session.js';
import type { PreparedState, ResetCapabilities } from './app-reset.js';
import { claimDeviceOrThrow, claimFirstFree, claimUpTo, currentSession, ensureClaimSession, devicesHeldByThisProcess, heldDevicesNote, listDeviceClaims, releaseDeviceClaim, skippedHeldDeviceMessage, withoutHeldDevices } from './device-claims.js';
import { installActionProgressPrinter } from './action-progress-renderer.js';
import { discoverTestFiles, noConfigFoundMessage, noTestFilesFoundMessage, relativeTestPath, resolveTestFileArgs } from './test-file-discovery.js';
import { resolveTsxBin, tsxIpcPathProblem } from './child-scripts.js';
import { filterRanNothing } from './test-filter.js';
import {
  resolveTraceConfig,
  isNetworkTracingEnabled,
} from './trace/types.js';
import { resolveVideoConfig } from './video/types.js';
import { recordsOnlyOnRetry } from './trace/trace-mode.js';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

import {
  clearOfflineEmulatorTransports,
  preserveEmulatorsForReuse,
  emulatorsLaunchedThisProcess,
  filterHealthyDevices,
  listAdbDevices,
  cleanupStaleEmulators,
  resolveEmulatorLaunchSettings,
  prefilterDevicesForStrategy,
  probeDeviceHealth,
  provisionEmulators,
  type DeviceHealthResult,
  type LaunchedEmulator,
  selectDevicesForStrategy,
  waitForDeviceStability,
  ensureAdbRoot,
} from './emulator.js';
import { isRecoverableInfrastructureError, serializeConfig } from './worker-protocol.js';
import { DEFAULT_AGENT_PORT, daemonsOnAgentPort, findPidsOnPort, freeStaleAgentPort, pickFreePort } from './port-utils.js';
import { findDaemonBin } from './daemon-bin.js';
import { awaitDaemonStart, captureDaemonOutput, daemonStartFailure, spawnDaemonBinary } from './daemon-start.js';
import { splitHeadline } from './error-detail.js';
import { attachedDeviceAdvice, moreDevicesAdvice, noOnlineDeviceMessage } from './device-advice.js';
import { checkPinnedDeviceHealth } from './adb-recovery.js';
import { rosettaNodeWarning } from './host-arch.js';
import { yarnPnpRefusal } from './yarn-pnp.js';
import { androidToolchainBlocker, assertAdbForEmulatorLaunch, iosToolchainBlocker, toolchainBlocker } from './toolchain.js';
import {
  createUiLaunchSteps,
  UiLaunchProgress,
  launchRowsShareStderr,
  unshownPart,
  withoutShownHeadline,
  type LaunchProgressSink,
  type LaunchStepId,
} from './launch-progress.js';
import { killAgentRunnersForSimulators } from './ios-simulator.js';

// ─── ANSI helpers ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

let activeLaunchProgress: LaunchProgressSink | undefined;

function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

function printTapsmithBanner(): void {
  if (!claimBanner()) return;
  console.log();
  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  console.log(banner.split('\n').map((line) => `${GREEN}${line}${RESET}`).join('\n'));
  console.log(dim(`v${getVersion()}`));
  console.log();
}

function warnSequentialUnhealthyDevices(devices: DeviceHealthResult[], progress?: LaunchProgressSink): void {
  for (const device of devices) {
    const message = `Skipping unhealthy device ${device.serial}: ${device.reason ?? 'unknown health check failure'}.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }
}

function warnSequentialSkippedDevices(
  devices: Array<{ serial: string; reason: string }>,
  progress?: LaunchProgressSink,
): void {
  for (const device of devices) {
    const message = `Skipping device ${device.serial}: ${device.reason}.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }
}

// ─── Version ───

function getVersion(): string {
  return readSdkVersion();
}

// ─── TSX re-exec ───

/**
 * If test files are TypeScript and we're not already running under tsx,
 * re-exec the CLI using tsx as the loader. This allows `import from "tapsmith"`
 * and TypeScript syntax in test files.
 */
function needsTsx(testFiles: string[]): boolean {
  return testFiles.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

function reExecWithTsx(args: string[]): never {
  // The same lookup the UI-mode and MCP children use: our own node_modules,
  // then the hoisted `<project>/node_modules/.bin` a normal npm install puts
  // it in, then the package itself, then PATH. Checking only our own
  // node_modules missed the hoisted copy whenever the CLI ran outside
  // npx/npm scripts (which put `.bin` on PATH) — `spawn tsx ENOENT`.
  const tapsmithPkgDir = path.resolve(import.meta.dirname, '..');
  const tsxBin = resolveTsxBin(tapsmithPkgDir);
  if (!tsxBin) {
    // tsx is one of our dependencies, so a missing one means a broken install.
    console.error(red('TypeScript test files were found, but Tapsmith could not find the tsx loader it runs them with.'));
    console.error(dim('tsx ships as a dependency of tapsmith; reinstall it (npm install tapsmith), or install tsx: npm install -D tsx'));
    process.exit(1);
  }

  // tsx would crash on its own socket before running anything (PILOT-569).
  const ipcProblem = tsxIpcPathProblem();
  if (ipcProblem) {
    console.error(red(ipcProblem));
    process.exit(1);
  }

  const cliPath = process.argv[1];
  const result = spawn(tsxBin, [cliPath, ...args, '--__tsx-reexec'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Tell Node to resolve "tapsmith" to our package
      NODE_PATH: path.join(tapsmithPkgDir, '..'),
    },
  });

  result.on('close', (code) => {
    process.exit(code ?? 1);
  });

  // Keep alive until child exits
  result.on('error', (err) => {
    console.error(red(`Failed to start tsx (${tsxBin}): ${err.message}`));
    console.error(dim('tsx ships as a dependency of tapsmith; reinstall it (npm install tapsmith), or install tsx: npm install -D tsx'));
    process.exit(1);
  });

  // Prevent the current process from continuing
  // This is a "never" return since we rely on the child process
  return undefined as never;
}

// ─── Device health check ───

/**
 * Verify the target device is responsive before running tests, recovering it
 * if it is not — targeted `adb reconnect` first, an ADB server restart only
 * as a last resort (PILOT-475, `adb-recovery.ts`). Throws if not recoverable
 * (the caller decides whether the run can go on without this device).
 */
async function checkDeviceHealth(serial: string, progress?: LaunchProgressSink): Promise<void> {
  const note = (message: string): void => (progress ? progress.note(message) : console.log(yellow(message)));
  // A progress note renders dim; the restart warning keeps its colour.
  const warn = (message: string): void => (progress ? progress.note(yellow(message)) : console.log(yellow(message)));
  await checkPinnedDeviceHealth(serial, {
    adb: (args, timeoutMs) => execFileSync('adb', [...args], {
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    waitForStable: (s) => waitForDeviceStability(s, 20_000, probeDeviceHealth),
    heldElsewhere: () => {
      const session = currentSession();
      return listDeviceClaims().filter((c) => c.live && c.session.id !== session.id);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    note,
    warn,
  });
}

// ─── Daemon management ───


/** Track the daemon process we spawned so we can kill it on exit. */
let spawnedDaemonProcess: ReturnType<typeof spawn> | undefined;
/**
 * Daemons this process started and has since stopped, by pid. SIGTERM does
 * not wait: an iOS daemon stays alive for a few seconds after closing its
 * port while it stops its agent, and the next target's daemon start must not
 * mistake it for another session's (PILOT-550).
 */
const stoppedOwnDaemons = new Set<number>();

/** Stop this target's daemon (SIGTERM) and forget its handle. */
function stopSpawnedDaemon(): void {
  if (!spawnedDaemonProcess) return;
  if (spawnedDaemonProcess.pid !== undefined) stoppedOwnDaemons.add(spawnedDaemonProcess.pid);
  try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
  spawnedDaemonProcess = undefined;
}

let sequentialFatalHandlersInstalled = false;
// The handler is registered once, but the active run context is refreshed on
// every install call so a crash always tears down the CURRENT run rather than a
// stale first-run closure (matters if main() runs more than once in a process).
let activeSequentialConfig: TapsmithConfig | undefined;
let activeSequentialDeviceGetter: (() => string | undefined) | undefined;
/** Sessions of the current device group beyond the primary (their daemons are ours to kill). */
let activeSequentialMembersGetter: (() => DeviceSession[]) | undefined;

/**
 * Install process-wide handlers so a *crash* in single-worker (sequential) mode
 * still tears down its daemon and the daemon's xcodebuild XCUITest runner,
 * instead of orphaning them and loading the host (PILOT-230, sequential variant
 * of the dispatcher fix). Idempotent. The sim itself is left booted — sequential
 * mode reuses a named simulator rather than cloning, so deleting it would be
 * wrong; killing the runner is enough to stop it holding the host hot.
 */
function installSequentialFatalHandlers(
  config: TapsmithConfig,
  getActiveDevice?: () => string | undefined,
  getActiveMembers?: () => DeviceSession[],
): void {
  activeSequentialConfig = config;
  activeSequentialDeviceGetter = getActiveDevice;
  activeSequentialMembersGetter = getActiveMembers;

  if (sequentialFatalHandlersInstalled) return;
  sequentialFatalHandlersInstalled = true;
  let teardownDone = false;
  const runFatalTeardown = (label: string, err: unknown) => {
    if (teardownDone) return;
    teardownDone = true;
    process.stderr.write(`\n${DIM}Fatal ${label} — shutting down daemon and agent...${RESET}\n`);
    // Print the stack, not just the message — async crashes are undebuggable otherwise.
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    // Read the active config/device lazily at crash time: in heterogeneous
    // project runs the sequential device switches mid-run, so this reflects the
    // currently-active sim/device. Fall back to config.device before setup ran.
    const activeConfig = activeSequentialConfig ?? config;
    const activeDevice = activeSequentialDeviceGetter?.() ?? activeConfig.device;
    if (activeConfig.platform === 'ios' && activeDevice) {
      try { killAgentRunnersForSimulators([activeDevice]); } catch { /* best effort */ }
    }
    if (spawnedDaemonProcess) {
      try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    }
    for (const member of activeSequentialMembersGetter?.() ?? []) {
      if (activeConfig.platform === 'ios') {
        try { killAgentRunnersForSimulators([member.serial]); } catch { /* best effort */ }
      }
      closeDeviceSession(member);
    }
    setImmediate(() => process.exit(1));
  };
  process.on('uncaughtException', (err) => runFatalTeardown('error', err));
  // While a test file runs, the runner owns unhandled rejections: it fails
  // the test the rejection happened in and the run carries on (PILOT-543).
  // It also reports a late leftover of a test that has already ended.
  process.on('unhandledRejection', (reason) => {
    if (!runnerClaimsUnhandledRejection(reason)) runFatalTeardown('rejection', reason);
  });
}

/**
 * Start (or attach to) the daemon and return the client together with the
 * address actually used — which differs from the requested one when another
 * live Tapsmith session already owns that port.
 */
async function ensureDaemonRunning(
  requestedAddress: string,
  daemonBin?: string,
  platform?: string,
  progress?: LaunchProgressSink,
): Promise<{ client: TapsmithGrpcClient; address: string }> {
  let address = requestedAddress;
  let port = address.split(':').pop() ?? '50051';
  progress?.start('daemon', `starting tapsmith-core on ${address}`);

  // When TAPSMITH_REUSE_DAEMON is set (e.g. from MCP server's tapsmith_run_tests),
  // connect to the existing daemon without killing it. This avoids destroying
  // a daemon owned by UI mode or another long-lived session.
  if (process.env.TAPSMITH_REUSE_DAEMON) {
    const client = new TapsmithGrpcClient(address);
    const alive = await client.waitForReady(5_000);
    if (alive) {
      const version = (await client.ping()).version;
      if (progress) progress.complete('daemon', `connected to existing tapsmith-core v${version}`);
      else console.log(dim(`Connected to existing Tapsmith daemon v${version}`));
      return { client, address };
    }
    client.close();
    // Fall through to normal startup if no daemon is running
  }

  // A daemon that answers on the requested port belongs to another live
  // Tapsmith session (UI mode on the other platform, a watch, an MCP server).
  // Killing it would break that session — and worse, its workers would then
  // silently reconnect to *our* daemon and drive the wrong device. Start on a
  // free port instead; the resolved address is threaded to every consumer via
  // the config. A listener that does not answer is a stale daemon: kill it and
  // reuse the port so the --platform flag is always the current one.
  let sharingWithLiveSession = false;
  // The agent port the daemon forwards to (iOS: the port its runner listens
  // on). The default 18700 is the live session's too when we share the
  // machine with one, so ours takes a free port as well — the new daemon
  // would otherwise find that session's runner on 18700 and (rightly) refuse
  // to adopt it, or a second runner could not bind it (PILOT-381).
  let agentPort: number | undefined;
  // Set when the default agent port belongs to another live session.
  let agentPortInUse = false;
  // Daemons that may still be exiting and are not another session's: this
  // process's earlier targets' daemons, and those on our port that did not
  // answer, sent SIGTERM below.
  const stoppedStaleDaemons = new Set<number>(stoppedOwnDaemons);
  try {
    const probe = new TapsmithGrpcClient(address);
    const alive = await probe.waitForReady(1_000);
    probe.close();
    if (alive) {
      sharingWithLiveSession = true;
      const freePort = await pickFreePort();
      const requestedPort = requestedAddress.split(':').pop() ?? port;
      address = `localhost:${freePort}`;
      port = String(freePort);
      let freeAgentPort = await pickFreePort();
      while (freeAgentPort === freePort) freeAgentPort = await pickFreePort();
      agentPort = freeAgentPort;
      if (progress) progress.note(`port ${requestedPort} is in use by another Tapsmith session; starting on ${address}`);
      else console.log(dim(`Daemon port ${requestedPort} is in use by another Tapsmith session; starting on ${address}`));
    } else {
      const pids = findPidsOnPort(port);
      for (const pid of pids) {
        stoppedStaleDaemons.add(pid);
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      if (pids.length > 0) await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // No daemon running, nothing to kill
  }

  // A live daemon of another session can use the default agent port without
  // answering on ours — a sequential run on another `daemonAddress`. Its
  // `adb forward` (Android) or runner (iOS) on that port is live: sweeping
  // it would cut that session off, and keeping it would shadow our agent
  // (PILOT-550). Take a free agent port instead, as for a shared daemon port;
  // so too when the processes cannot be read to tell.
  if (!sharingWithLiveSession) {
    const owners = daemonsOnAgentPort(DEFAULT_AGENT_PORT, stoppedStaleDaemons);
    if (owners === undefined || owners.length > 0) {
      agentPortInUse = true;
      agentPort = await pickFreePort();
      while (agentPort === Number(port)) agentPort = await pickFreePort();
      const why = owners === undefined
        ? `could not check whether another Tapsmith session uses agent port ${DEFAULT_AGENT_PORT}`
        : `agent port ${DEFAULT_AGENT_PORT} is in use by another Tapsmith session (daemon pid ${owners.join(', ')})`;
      if (progress) progress.note(`${why}; using agent port ${agentPort}`);
      else console.log(dim(`${why[0].toUpperCase()}${why.slice(1)}; using agent port ${agentPort}`));
    }
  }

  // Remove stale ADB port forwards whose HOST side is the default agent port
  // (18700). A previous Android instance may have left a forward that hijacks
  // traffic meant for the iOS XCUITest agent. Each line is "<serial> <local>
  // <remote>" — match `local === tcp:18700` exactly so we don't try to remove
  // forwards whose remote side happens to be 18700 but whose host port is not
  // (which would print "listener 'tcp:18700' not found").
  //
  // Skipped entirely when another live Tapsmith session owns the requested
  // port or the default agent port: its agent forward and agent process are
  // not stale, they are that session's — sweeping them would cut it off from
  // its device, which is exactly what starting on a free port above set out
  // to avoid.
  if (!sharingWithLiveSession && !agentPortInUse) try {
    const fwdList = execFileSync('adb', ['forward', '--list'], { encoding: 'utf-8' }).trim();
    for (const line of fwdList.split('\n')) {
      const [serial, local] = line.split(/\s+/);
      if (!serial || local !== 'tcp:18700') continue;
      try {
        execFileSync('adb', ['-s', serial, 'forward', '--remove', 'tcp:18700']);
      } catch { /* already gone */ }
    }
  } catch {
    // ADB not available or no forwards — safe to ignore
  }

  // Free the agent host port from any leftover process (stale iOS TapsmithAgent
  // from a previous run, or a stuck tapsmith-core daemon). If we leave a stale
  // listener squatting on this port, the new daemon's `adb forward` is
  // shadowed by the stale socket and every command silently routes to the
  // wrong device — see freeStaleAgentPort for the full rationale.
  if (!sharingWithLiveSession && !agentPortInUse) {
    freeStaleAgentPort(DEFAULT_AGENT_PORT, progress
      ? ({ port, pid }) => progress.update('daemon', {
        state: 'running',
        detail: `cleared stale agent port ${port} (pid ${pid})`,
      })
      : undefined);
  }

  // Start a fresh daemon
  const resolvedBin = process.env.TAPSMITH_DAEMON_BIN ?? daemonBin ?? findDaemonBin();
  const daemonArgs = ['--port', port];
  if (agentPort !== undefined) daemonArgs.push('--agent-port', String(agentPort));
  if (platform) daemonArgs.push('--platform', platform);
  // `TAPSMITH_DAEMON_LOG=<path>` sends the daemon's stdout and stderr to a
  // file, for debugging daemon-side behaviour (MITM proxy pre-start,
  // `/tapsmith.pac` serves, agent startup). Without it only stderr is kept,
  // and only while it starts: that is where its start failures go.
  const output = captureDaemonOutput(process.env.TAPSMITH_DAEMON_LOG, (message) => {
    if (progress) progress.note(message);
    else console.error(yellow(message));
  });
  let spawned: ReturnType<typeof spawnDaemonBinary>;
  try {
    spawned = spawnDaemonBinary(resolvedBin, daemonArgs, { stdio: output.stdio });
  } finally {
    output.closeParentFds();
  }
  if (spawned.ok) {
    spawned.child.unref();
    spawnedDaemonProcess = spawned.child;
  }

  // Wait for daemon to be ready. First-exec of a freshly-downloaded unsigned
  // binary on a loaded CI runner can take ~30s before the listener binds
  // (macOS scans the binary), and grpc-js reconnect backoff grows ~1.6x per
  // attempt so a single 10s window can skip right past the moment the server
  // comes up. Retry in bounded windows up to 60s total, bailing early if the
  // daemon process exited (crash — no point waiting out the budget).
  const newClient = new TapsmithGrpcClient(address);
  const outcome = spawned.ok
    ? await awaitDaemonStart(spawned.child, (ms) => newClient.waitForReady(ms), {
      budgetMs: 60_000,
      windowMs: 10_000,
      address,
    })
    : spawned;
  if (!outcome.ok) {
    progress?.fail('daemon', outcome.cause);
    // Thrown, not exited: a multi-target run goes on without this target.
    newClient.close();
    const message = daemonStartFailure('Failed to start Tapsmith daemon', {
      ...outcome,
      recentOutput: output.recentOutput(),
      logPath: output.logPath,
    });
    output.dispose();
    throw new Error(message);
  }
  output.dispose();

  const version = (await newClient.ping()).version;
  if (progress) progress.complete('daemon', `connected to tapsmith-core v${version}`);
  else console.log(dim(`Connected to Tapsmith daemon v${version}`));
  return { client: newClient, address };
}

// ─── Sequential per-project device setup ───

interface SequentialDeviceState {
  effectiveConfig: TapsmithConfig
  /**
   * The group this state's sessions form, primary first — the largest
   * `use.devices` group among the projects on this device target
   * (`sharedDeviceGroup`), which is what `sessions` holds. A project
   * declaring a smaller group runs on the first N of them.
   */
  deviceGroup: DeviceGroupEntry[]
  client: TapsmithGrpcClient
  device: Device
  deviceSerial: string
  launchedEmulators: LaunchedEmulator[]
  resolvedAgentApk?: string
  resolvedAgentTestApk?: string
  resolvedIosXctestrun?: string
  resolvedIosAppPath?: string
  signature: string
  /** Reset capabilities probed after the startup launch (in-app hooks, …).
   * One object per device, shared into every file's sessionContext so the
   * runner resolves `appReset: 'auto'` from it and warm resets refresh it. */
  capabilities: ResetCapabilities
  /** What the startup launch left the app in — consumed by the first file's
   * reset so it can skip work the launch already did. Absent when there is
   * no package to launch. */
  prepared?: PreparedState
  /**
   * The device group, primary first. The primary's session wraps the fields
   * above; the others (`use.devices` projects) each run on a daemon this
   * state spawned and owns.
   */
  sessions: DeviceSession[]
}

/**
 * Provision a device, start the daemon + agent, install + launch the app
 * for a given effective config. Used by sequential mode to set up the
 * initial device and to switch devices between projects whose
 * `deviceSignature` differs.
 *
 * A setup that fails gives back the devices it claimed (PILOT-381): a session
 * that goes on — a multi-target run without this target, a UI session — must
 * not hold a device it is not driving.
 */
async function setupSequentialDevice(
  ...args: Parameters<typeof setupSequentialDeviceClaimed>
): Promise<SequentialDeviceState> {
  const session = currentSession();
  // This process's holds, not the session's: another process of the session
  // (an MCP server whose run_tests child this is) may claim meanwhile.
  const heldBefore = devicesHeldByThisProcess(session);
  try {
    return await setupSequentialDeviceClaimed(...args);
  } catch (err) {
    for (const device of devicesHeldByThisProcess(session)) {
      if (!heldBefore.has(device)) releaseDeviceClaim(device, session);
    }
    throw err;
  }
}

async function setupSequentialDeviceClaimed(
  cfg: TapsmithConfig,
  forceInstall: boolean,
  signature: string,
  progress?: LaunchProgressSink,
  /** The group to open (`sharedDeviceGroup` of the target's projects); defaults to what `cfg` declares. */
  deviceGroup?: DeviceGroupEntry[],
): Promise<SequentialDeviceState> {
  progress?.start('primary-device');
  const target = await ensureSequentialTargetDevice(cfg, progress);
  const launchedEmulators = target.launched;

  if (!target.selectedSerial) {
    progress?.fail('primary-device', 'no online device found');
    // Devices that are there but held by other sessions are named: the user
    // stops one, rather than looking for a device problem they do not have.
    throw new Error(noOnlineDeviceMessage(cfg, listAdbDevices(), androidToolchainBlocker()) + heldDevicesNote(withoutHeldDevices(listConnectedDeviceSerials()).held));
  }

  cfg.device = target.selectedSerial;
  const deviceSerial = cfg.device;

  // CI=false (string) must be treated as falsy — some systems export CI=false
  // for "not in CI" which is truthy in JavaScript. Normalise once here.
  const isCI = !!(process.env.CI && process.env.CI !== 'false');

  // Pre-flight: verify device is responsive before doing anything slow (Android only).
  // Skip in CI — the workflow already verified boot_completed=1 and disabled animations.
  if (cfg.platform !== 'ios' && !isCI) {
    progress?.update('primary-device', { state: 'running', detail: `checking ${deviceSerial}` });
    await checkDeviceHealth(deviceSerial, progress);
  }

  const { client, address: daemonAddress } = await ensureDaemonRunning(cfg.daemonAddress, cfg.daemonBin, cfg.platform, progress);
  // Workers, the UI server and recovery all read the address from the config.
  cfg.daemonAddress = daemonAddress;

  // Determine whether this UDID targets a physical device or a simulator.
  let targetIsPhysical = false;
  if (cfg.platform === 'ios') {
    const { isPhysicalDevice } = await import('./ios-devicectl.js');
    targetIsPhysical = isPhysicalDevice(deviceSerial);
  }

  // Physical-iOS fast-fail checks. Fire BEFORE the 8-second installAppOnDevice
  // so the user gets an immediate, actionable error instead of a mid-test hang.
  if (cfg.platform === 'ios' && targetIsPhysical) {
    // Cert-trust probe. The devicectl launch is ~1s and pattern-matches
    // cleanly on "cert not trusted". Only helpful when the runner is
    // already installed (i.e. second-and-subsequent runs on the device)
    // — on a fresh device the probe returns 'runner-not-installed' and
    // we proceed silently so xcodebuild can install it via the normal
    // path and trigger the iOS trust prompt.
    const { probeCertTrust } = await import('./ios-trust-probe.js');
    const trust = await probeCertTrust(deviceSerial);
    if (trust.state === 'untrusted') {
      progress?.fail('primary-device', 'developer certificate is not trusted');
      console.error();
      console.error('\x1b[31m✗ Tapsmith runner is installed but the developer certificate is not trusted.\x1b[0m');
      console.error();
      console.error('  On the phone, open \x1b[1mSettings → General → VPN & Device Management\x1b[0m,');
      console.error('  find \x1b[1mApple Development: <your name>\x1b[0m, and tap \x1b[1mTrust\x1b[0m.');
      console.error();
      console.error(dim('  Free Apple Developer accounts re-roll the profile every 7 days,'));
      console.error(dim('  so this step recurs weekly. Re-run `tapsmith ios build-agent`'));
      console.error(dim('  before trusting so the profile on the phone matches.'));
      console.error();
      throw new Error('iOS developer certificate not trusted on device');
    }
    // Host-IP drift when tracing is enabled. A stale sidecar means the
    // mobileconfig points at the Mac's old LAN IP and the device will
    // silently fail to route through the proxy.
    if (isNetworkTracingEnabled(cfg.trace)) {
      const { checkHostIpDrift } = await import('./ios-host-ip-check.js');
      const drift = checkHostIpDrift(deviceSerial);
      if (!drift.ok && drift.sidecarHostIp && drift.currentHostIp) {
        if (progress) {
          progress.note(
            `Host IP drift detected: profile points at ${drift.sidecarHostIp}, Mac is now ${drift.currentHostIp}.`,
          );
          progress.note(`Run \`tapsmith ios network configure ${deviceSerial} --refresh\` and reinstall the updated profile.`);
        } else {
          console.log();
          console.log('\x1b[33m⚠ Host IP drift detected.\x1b[0m');
          console.log(
            dim(`  Installed profile points at ${drift.sidecarHostIp}, Mac is now ${drift.currentHostIp}.`),
          );
          console.log(
            dim(`  Run \`tapsmith ios network configure ${deviceSerial} --refresh\` and reinstall the updated`),
          );
          console.log(dim('  profile on the device, otherwise traces will come back empty.'));
          console.log();
        }
      }
    }
  }

  const traceConfig = resolveTraceConfig(cfg.trace);
  // PILOT-182: iOS network capture no longer needs sudo — the daemon uses
  // a macOS Network Extension redirector for per-simulator isolation. If
  // the legacy sudoers file is still on disk from an older Tapsmith version,
  // print a one-time deprecation notice.
  if (cfg.platform === 'ios') {
    const { notifyLegacySudoersIfPresent } = await import('./legacy-cleanup.js');
    notifyLegacySudoersIfPresent();
  }
  if (cfg.platform !== 'ios' && traceConfig.mode !== 'off' && traceConfig.network) {
    const restarted = ensureAdbRoot(deviceSerial);
    if (restarted) {
      if (progress) progress.note('Enabled adb root for network capture.');
      else console.log(dim('Enabled adb root for network capture.'));
    }
  }

  // The shared session module does the rest — select, wake, install, agent,
  // launch — exactly as it does for every worker. Its phase callbacks drive
  // the step rows below; its progress lines fill in the running detail.
  const group = deviceGroup ?? resolveDeviceGroup(cfg);
  const deviceJustLaunched = launchedEmulators.some((e) => e.serial === deviceSerial);
  const phaseSteps: Record<'install' | 'agent' | 'launch', LaunchStepId> = {
    install: 'app-install', agent: 'agent', launch: 'app-launch',
  };
  let currentStep: LaunchStepId = 'primary-device';
  let primaryCompleted = false;
  const completePrimary = (detail: string): void => {
    if (primaryCompleted) return;
    primaryCompleted = true;
    progress?.complete('primary-device', detail);
  };
  let session: DeviceSession;
  try {
    session = await openDeviceSession(
      { name: group[0].name, serial: deviceSerial, daemonAddress },
      cfg,
      {
        claimSession: currentSession(),
        label: 'Device',
        client,
        forceInstall,
        freshDevice: deviceJustLaunched,
        appInstalledFresh: target.appInstalledFresh,
        // Headless CI emulators have no lockscreen; iOS never needed it here.
        skipWakeUnlock: cfg.platform !== 'ios' && isCI,
        readinessAttempts: 3,
        launchPhase: 'startup launch',
        onProgress: (message) => {
          if (message === 'waking and unlocking device') {
            progress?.update('primary-device', { state: 'running', detail: `waking ${deviceSerial}` });
            return;
          }
          // Lines the phase callbacks already turn into step completions.
          if (
            message === 'app launched' || message === 'session ready' || message === 'agent connected'
            || message === 'app install complete' || message === 'app install skipped'
            || message.includes('already installed')
          ) return;
          progress?.update(currentStep, { state: 'running', detail: message });
        },
        onPhase: (phase, state, detail) => {
          const step = phaseSteps[phase];
          if (state === 'start') {
            // Selecting and waking are done once the install begins.
            completePrimary(`${deviceSerial} selected`);
            currentStep = step;
            progress?.start(step, detail);
            if (!progress && phase === 'agent' && cfg.platform === 'ios') {
              console.log(dim(`Starting iOS agent (${detail.replace(/^starting iOS agent \(|\)$/g, '')})`));
            }
          } else if (state === 'complete') {
            progress?.complete(step, detail);
            if (!progress) console.log(dim(phaseLine(phase, detail)));
          } else if (state === 'skip') {
            completePrimary(`${deviceSerial} selected`);
            progress?.skip(step, detail);
          } else {
            progress?.fail(step, detail);
          }
        },
      },
    );
  } catch (err) {
    if (!primaryCompleted) progress?.fail('primary-device', `failed to set up ${deviceSerial}`);
    // A multi-target run goes on without this target (PILOT-400); don't
    // leave a channel reconnecting to a daemon that is about to be killed.
    try { client.close(); } catch { /* already closed */ }
    throw err;
  }
  completePrimary(`${deviceSerial} selected`);
  if (!progress) console.log(dim(`Using device: ${deviceSerial}`));

  // Physical-iOS provisioning-profile expiry warning, now that the xctestrun
  // is resolved. Three-point surfacing (here + ios build-agent tail +
  // ios setup-device preflight) so users hit the warning whichever path they
  // took to get to this point.
  if (cfg.platform === 'ios' && targetIsPhysical && session.context.iosXctestrunPath) {
    const { getProfileExpiryInfo, formatExpiryWarning } = await import('./ios-profile-expiry.js');
    const info = getProfileExpiryInfo(session.context.iosXctestrunPath);
    if (info) {
      const warning = formatExpiryWarning(info);
      if (warning) {
        if (progress) progress.note(warning);
        else console.log(`  \x1b[33m⚠\x1b[0m ${warning}`);
      }
    }
  }

  const primarySession = session;
  const device = primarySession.device;
  let sessions: DeviceSession[] = [primarySession];
  if (group.length > 1) {
    device._traceDeviceId = group[0].name;
    try {
      const members = await openSequentialGroupMembers(cfg, group, launchedEmulators, forceInstall, progress);
      sessions = [primarySession, ...members];
    } catch (err) {
      // The primary is up; a group that cannot complete is a failed setup.
      try { device.close(); } catch { /* already closed */ }
      try { client.close(); } catch { /* already closed */ }
      throw err;
    }
  }

  return {
    effectiveConfig: cfg,
    deviceGroup: group,
    client,
    device,
    deviceSerial,
    launchedEmulators,
    resolvedAgentApk: primarySession.context.agentApkPath,
    resolvedAgentTestApk: primarySession.context.agentTestApkPath,
    resolvedIosXctestrun: primarySession.context.iosXctestrunPath,
    resolvedIosAppPath: primarySession.context.iosAppPath,
    signature,
    capabilities: primarySession.capabilities,
    prepared: primarySession.prepared,
    sessions,
  };
}

/** Plain-console line for a completed setup phase (no progress UI). */
function phaseLine(phase: 'install' | 'agent' | 'launch', detail: string): string {
  switch (phase) {
    case 'install': return detail.startsWith('installed') ? `Installed ${detail.slice('installed '.length)}` : `App ${detail}, skipping install. Use --force-install to reinstall.`;
    case 'agent': return 'Agent connected.';
    case 'launch': return detail.replace(/^launched /, 'Launched ');
  }
}

/**
 * Bring up the rest of a `use.devices` group next to the primary: provision
 * (or pin) a device per member, spawn a daemon for each on free ports, and
 * open a session on it — install, agent, cold launch. Members open
 * concurrently; any failure tears the opened ones down and fails setup.
 */
async function openSequentialGroupMembers(
  cfg: TapsmithConfig,
  group: DeviceGroupEntry[],
  launchedEmulators: LaunchedEmulator[],
  forceInstall: boolean,
  progress?: LaunchProgressSink,
): Promise<DeviceSession[]> {
  const members = group.slice(1);
  progress?.start('worker-devices', `preparing ${members.length} more device(s) for the group`);
  try {
    return await openGroupMembersOnFreshDaemons(cfg, group, launchedEmulators, forceInstall, progress);
  } catch (err) {
    // Whatever failed — provisioning, a daemon, a session — it is this step's
    // failure. The caller marks the primary failed only when the primary is;
    // a group failure used to leave this row spinning under a "✗ Primary
    // device" that had in fact come up fine.
    progress?.fail('worker-devices', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function openGroupMembersOnFreshDaemons(
  cfg: TapsmithConfig,
  group: DeviceGroupEntry[],
  launchedEmulators: LaunchedEmulator[],
  forceInstall: boolean,
  progress?: LaunchProgressSink,
): Promise<DeviceSession[]> {
  const members = group.slice(1);
  const provisioned = await provisionGroupMemberDevices(cfg, group, progress);
  launchedEmulators.push(...provisioned.launched);
  // Before `adb root` below: a member another session drives is refused
  // without touching it (PILOT-381). openDeviceGroup re-claims them as its own.
  for (const serial of provisioned.serials) claimDeviceOrThrow(serial, currentSession());

  const daemonBin = resolveDaemonBin(cfg);
  const traceConfig = resolveTraceConfig(cfg.trace);
  const specs: Array<Parameters<typeof openDeviceGroup>[0][number] & { daemonProcess: ChildProcess }> = [];
  const killSpawned = () => {

    for (const spec of specs) {
      try { spec.daemonProcess.kill(); } catch { /* already gone */ }
    }
  };
  // Every port handed out so far. A daemon port leaves circulation once its
  // daemon binds, but an agent port is only ever forwarded (never bound by
  // this process), so nothing else stops a later pick from repeating it.
  const taken = new Set<number>();
  const pickUnusedPort = async (): Promise<number> => {
    let port = await pickFreePort();
    while (taken.has(port)) port = await pickFreePort();
    taken.add(port);
    return port;
  };
  try {
    for (const [i, entry] of members.entries()) {
      const serial = provisioned.serials[i];
      if (cfg.platform !== 'ios' && traceConfig.mode !== 'off' && traceConfig.network) {
        // Same as the primary: capture needs adb root on Android.
        ensureAdbRoot(serial);
      }
      const port = await pickUnusedPort();
      const agentPort = await pickUnusedPort();
      progress?.update('worker-devices', { state: 'running', detail: `${entry.name}: starting daemon on localhost:${port} for ${serial}` });
      const daemon = await startDaemon({
        daemonBin, port, agentPort, platform: cfg.platform,
        describe: `daemon for ${entry.name}`,
      });
      specs.push({
        name: entry.name,
        serial,
        daemonAddress: daemon.address,
        daemonProcess: daemon.process,
        agentPort,
        freshDevice: provisioned.fresh.has(serial),
      });
    }
  } catch (err) {
    // A daemon that failed to start for member n must not orphan the ones
    // already running for members 0..n-1 (they would keep their ports).
    killSpawned();
    throw err;
  }

  try {

    const sessions = await openDeviceGroup(specs, cfg, {
      claimSession: currentSession(),
      label: 'Device',
      forceInstall,
      launchPhase: 'startup launch',
      // Tag the primary too (done by the caller) — a group's trace tells its
      // devices apart by name.
      onProgress: (message) => progress?.update('worker-devices', { state: 'running', detail: message }),
    });
    for (const s of sessions) s.device._traceDeviceId = s.name;
    progress?.complete('worker-devices', `${sessions.length} more device(s): ${sessions.map((s) => `${s.name}=${s.serial}`).join(', ')}`);
    if (!progress) console.log(dim(`Device group: ${[group[0].name, ...sessions.map((s) => s.name)].join(', ')}`));
    return sessions;
  } catch (err) {
    killSpawned();
    throw err;
  }
}


/**
 * A device for every member of the group beyond the primary (`cfg.device`),
 * in member order. Pinned members (`{ device }`) use their serial; the rest
 * are provisioned like extra worker devices — booted emulators/simulators
 * first, then launched/cloned ones. Physical iOS members must be pinned:
 * there is no way to auto-pick a second USB device.
 */
async function provisionGroupMemberDevices(
  cfg: TapsmithConfig,
  group: DeviceGroupEntry[],
  progress?: LaunchProgressSink,
): Promise<{ serials: string[]; launched: LaunchedEmulator[]; fresh: Set<string> }> {
  const members = group.slice(1);
  const pinned = members.flatMap((m) => (m.device ? [m.device] : []));
  const unpinned = members.filter((m) => !m.device);
  if (unpinned.length === 0) {
    return { serials: members.map((m) => m.device!), launched: [], fresh: new Set() };
  }
  if (cfg.platform === 'ios' && !cfg.simulator) {
    throw new Error(
      `Device group members on physical iOS must be pinned: set \`device\` on ${unpinned.map((m) => `"${m.name}"`).join(', ')} `
      + '(a paired UDID from `xcrun devicectl list devices`). Tapsmith can auto-pick only one physical device.',
    );
  }
  const provision = await provisionMultiWorkerDevices(cfg, 'Device group', {
    quiet: true,
    progress,
    // The caller owns the "Device group" launch row (openSequentialGroupMembers).
    reportProgress: false,
    wanted: group.length,
    pinned,
  });
  const primary = cfg.device;
  const provisionedSerials = provision.deviceSerials ?? [];
  const serials = assignGroupMemberDevices(group, primary, provisionedSerials);
  if (!serials) {
    const pool = provisionedSerials.filter((s) => s !== primary && !pinned.includes(s));
    throw new Error(
      `use.devices asks for ${group.length} device(s) but only ${pool.length + pinned.length + 1} could be provisioned `
      + `(${[primary, ...pinned, ...pool].filter(Boolean).join(', ')}). `
      + moreDevicesAdvice(cfg, toolchainBlocker(cfg.platform)),
    );
  }
  return { serials, launched: provision.launched, fresh: provision.freshSerials };
}

/**
 * Tear down a sequential device state when switching projects to a
 * different device. Closes the gRPC client and Device, kills the
 * spawned daemon process, and preserves any launched emulators for reuse.
 */
function teardownSequentialDevice(state: SequentialDeviceState): void {
  for (const member of state.sessions.slice(1)) closeDeviceSession(member);
  // The run moves to another target: give its devices back (PILOT-381).
  for (const serial of new Set([state.deviceSerial, ...state.sessions.map((s) => s.serial)])) {
    releaseDeviceClaim(serial, currentSession());
  }
  try { state.device.close(); } catch { /* already closed */ }
  try { state.client.close(); } catch { /* already closed */ }
  stopSpawnedDaemon();
  // Its emulators are left running for reuse, and named at the end of the
  // run (emulatorsLaunchedThisProcess): a notice here would read as if the
  // run had ended.
}

function listConnectedDeviceSerials(): string[] {
  return listAdbDevices()
    .filter((d) => d.state === 'device')
    .map((d) => d.serial);
}

async function ensureSequentialTargetDevice(
  config: Awaited<ReturnType<typeof loadConfig>>,
  progress?: LaunchProgressSink,
): Promise<{
  selectedSerial?: string
  launched: LaunchedEmulator[]
  /** The iOS simulator was booted here and the app installed onto it fresh. */
  appInstalledFresh?: boolean
}> {
  // The first `use.devices` member's pin, or root `device` — not `config.device`
  // alone, which left a group pinning both members with its primary auto-picked.
  const pinned = primaryDevicePin(config);
  if (pinned) {
    // Claimed before anything touches it (the health check may restart adb,
    // network capture restarts adbd as root): a device another session drives
    // is refused here, not after its run has been disturbed (PILOT-381).
    claimDeviceOrThrow(pinned, currentSession());
    // If the device is an iOS simulator that's already booted, log reuse
    if (config.platform === 'ios') {
      const { listBootedSimulators } = await import('./ios-simulator.js');
      const booted = listBootedSimulators();
      const sim = booted.find((s) => s.udid === pinned);
      if (sim) {
        // "Already booted" and nothing more — the boot may have come from a
        // previous tapsmith run OR from something else entirely (e.g. a CI
        // workflow step that pre-boots the simulator).
        const message = `Reusing already-booted simulator ${sim.udid} (${sim.name}).`;
        if (progress) progress.update('primary-device', { state: 'running', detail: `reusing already-booted ${sim.name}` });
        else process.stderr.write(`${DIM}${message}${RESET}\n`);
      }
    }
    return { selectedSerial: pinned, launched: [] };
  }

  // ─── iOS: use simulator instead of ADB device ───
  if (config.platform === 'ios') {
    const { listBootedSimulators, provisionSimulator, cleanupStaleSimulators, installAppIfAbsent } = await import('./ios-simulator.js');
    // If no simulator is configured, try to auto-resolve a single paired
    // physical device. Mirrors how simulators are picked by name — the
    // user should not have to hand-parse `devicectl` JSON in their config.
    if (!config.simulator) {
      try {
        const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
        const udid = resolvePhysicalIosDevice();
        claimDeviceOrThrow(udid, currentSession());
        const message = `Auto-detected physical iOS device ${udid}.`;
        if (progress) progress.note(message);
        else process.stderr.write(`${DIM}${message}${RESET}\n`);
        return { selectedSerial: udid, launched: [] };
      } catch (e) {
        // Thrown, not exited: the caller decides whether the run can go on
        // without this device target (a multi-target run can — PILOT-400).
        throw new Error(
          `No simulator specified and physical device auto-detect failed: ${(e as Error).message}\n` +
            `Set \`simulator\` (e.g. simulator: "iPhone 16") or \`device\` in your config.`,
        );
      }
    }
    const simulatorName = config.simulator;

    // Clean up stale clones from previous runs
    const staleResult = cleanupStaleSimulators(simulatorName);
    if (staleResult.killed.length > 0) {
      const message = `Cleaned up ${staleResult.killed.length} stale simulator(s).`;
      if (progress) progress.note(message);
      else process.stderr.write(`${DIM}${message}${RESET}\n`);
    }

    // Check for already-booted simulators
    // Not one another live Tapsmith session holds (PILOT-381):
    // provisionSimulator below passes over those too.
    // Claimed as it is picked, so a session starting at the same moment
    // takes another one rather than this one.
    const booted = listBootedSimulators();
    const matchingUdid = claimFirstFree(
      booted.filter((s) => s.name === simulatorName || s.udid === simulatorName).map((s) => s.udid),
    );
    const matching = booted.find((s) => s.udid === matchingUdid);
    if (matching) {
      const message = `Reusing already-booted simulator ${matching.udid} (${matching.name}).`;
      if (progress) progress.update('primary-device', { state: 'running', detail: `reusing already-booted ${matching.name}` });
      else process.stderr.write(`${DIM}${message}${RESET}\n`);
      return { selectedSerial: matching.udid, launched: [] };
    }

    // Boot the simulator
    try {
      progress?.update('primary-device', { state: 'running', detail: `booting ${simulatorName}` });
      const { udid, bootComplete } = provisionSimulator(simulatorName);
      claimDeviceOrThrow(udid, currentSession());
      // Installed now, while the simulator is still settling, rather than
      // right before the agent starts: on a hosted runner the first launch
      // of a just-installed app then pushed the agent past its startup bound.
      // Reported as fresh so the session neither re-checks it nor clears it.
      // Not on a simulator whose boot wait timed out: one still booting can
      // report an installed app as absent.
      let appInstalledFresh = false;
      if (config.app && config.package) {
        const app = path.resolve(config.rootDir, config.app);
        if (!bootComplete) {
          progress?.update('primary-device', { state: 'running', detail: `${simulatorName} is still booting; the app is installed after selection` });
        } else {
          progress?.update('primary-device', { state: 'running', detail: `installing ${path.basename(app)} on the booted ${simulatorName}` });
          const early = installAppIfAbsent(udid, app, config.package);
          appInstalledFresh = early.installed;
          progress?.update('primary-device', { state: 'running', detail: `${path.basename(app)}: ${early.outcome}` });
        }
      }
      return { selectedSerial: udid, launched: [], appInstalledFresh };
    } catch (e) {
      throw new Error(`Failed to provision iOS simulator: ${(e as Error).message}`);
    }
  }

  const clearedOfflineEmulators = clearOfflineEmulatorTransports();
  for (const serial of clearedOfflineEmulators) {
    const message = `Cleared stale offline emulator transport ${serial} before device selection.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }

  // Reclaim healthy emulators from previous runs, kill unhealthy ones.
  // cleanupStaleEmulators logs details about each action internally.
  const staleResult = cleanupStaleEmulators(config.avd, {}, resolveEmulatorLaunchSettings(config.emulatorLaunchOptions).headless);
  if (staleResult.killed.length > 0) {
    const message = `Cleaned up ${staleResult.killed.length} stale emulator(s).`;
    if (progress) progress.note(message);
    else process.stderr.write(`${DIM}${message}${RESET}\n`);
  }

  const deviceStrategy = resolveDeviceStrategy(config);
  const onlineSerials = listConnectedDeviceSerials();
  // Devices another live Tapsmith session holds are skipped, not taken
  // (PILOT-381). They stay "occupied" for the emulator launch below.
  const unheldOnline = withoutHeldDevices(onlineSerials);
  for (const claim of unheldOnline.held) {
    if (progress) progress.note(skippedHeldDeviceMessage(claim));
    else process.stderr.write(`${DIM}${skippedHeldDeviceMessage(claim)}${RESET}\n`);
  }
  const prefilteredOnline = prefilterDevicesForStrategy(
    unheldOnline.free,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(prefilteredOnline.skippedDevices, progress);
  const healthyOnline = filterHealthyDevices(prefilteredOnline.candidateSerials);
  warnSequentialUnhealthyDevices(healthyOnline.unhealthyDevices, progress);
  const selectedOnline = selectDevicesForStrategy(
    healthyOnline.healthySerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(
    selectedOnline.skippedDevices.filter(
      (device) => !prefilteredOnline.skippedDevices.some((prefiltered) => prefiltered.serial === device.serial),
    ),
    progress,
  );

  // Claimed as it is picked: a session starting at the same moment, which
  // saw the same free devices, takes the next one instead of this one.
  const pickedOnline = claimFirstFree(selectedOnline.selectedSerials);
  if (pickedOnline) {
    return { selectedSerial: pickedOnline, launched: [] };
  }

  if (!config.launchEmulators) {
    return { selectedSerial: undefined, launched: [] };
  }

  assertAdbForEmulatorLaunch();
  progress?.update('primary-device', { state: 'running', detail: 'launching Android emulator' });
  const provision = await provisionEmulators({
    existingSerials: [],
    occupiedSerials: onlineSerials,
    workers: 1,
    avd: config.avd,
    launchOptions: config.emulatorLaunchOptions,
    onProgress: (message, level) => {
      // Without a progress display a warning (an emulator's early-exit reason,
      // how to stop it) still has to reach the user.
      if (!progress) {
        if (level === 'warning') process.stderr.write(`${YELLOW}${message}${RESET}\n`);
        return;
      }
      if (level === 'warning') progress.note(message);
      else progress.update('primary-device', { state: 'running', detail: message });
    },
  });
  const healthyProvisioned = filterHealthyDevices(provision.allSerials);
  warnSequentialUnhealthyDevices(healthyProvisioned.unhealthyDevices, progress);
  const selectedProvisioned = selectDevicesForStrategy(
    healthyProvisioned.healthySerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(selectedProvisioned.skippedDevices, progress);

  return {
    selectedSerial: claimFirstFree(selectedProvisioned.selectedSerials),
    launched: provision.launched,
  };
}

/**
 * Provision additional device serials for multi-worker iOS/Android modes.
 * Returns the full list of device serials (including the primary), or
 * undefined if fewer than 2 devices are available.
 */
async function provisionMultiWorkerDevices(
  config: Awaited<ReturnType<typeof loadConfig>>,
  modeName: string,
  opts?: {
    quiet?: boolean
    progress?: LaunchProgressSink
    /** Devices wanted in total, primary included. Defaults to `config.workers`. */
    wanted?: number
    /** Serials that must be part of the set (pinned group members), after the primary. */
    pinned?: string[]
    /**
     * Whether this call owns the `worker-devices` launch row (start / skip /
     * complete). `false` when the caller reports that row itself and only
     * wants the intermediate `update`s; defaults to `true`.
     */
    reportProgress?: boolean
  },
): Promise<{ deviceSerials: string[] | undefined; launched: LaunchedEmulator[]; freshSerials: Set<string> }> {
  let launched: LaunchedEmulator[] = [];
  const freshSerials = new Set<string>();
  const wanted = opts?.wanted ?? config.workers;
  if (wanted <= 1) return { deviceSerials: undefined, launched, freshSerials };
  const pinned = (opts?.pinned ?? []).filter((s) => s !== config.device);
  // A pinned member another session drives is refused by name, not dropped.
  for (const serial of pinned) claimDeviceOrThrow(serial, currentSession());
  const rowProgress = opts?.reportProgress === false ? undefined : opts?.progress;
  rowProgress?.start('worker-devices', `preparing ${wanted} worker device(s)`);

  let serials: string[];
  let reusedSimulatorCount = 0;
  if (config.platform === 'ios') {
    const { listAdoptableBootedSimulators, provisionSimulators, cleanupStaleSimulators } = await import('./ios-simulator.js');
    let reusableUdids: string[] = [];
    if (config.simulator) {
      const staleResult = cleanupStaleSimulators(config.simulator);
      reusableUdids = staleResult.reusable;
      if (staleResult.reusable.length > 0 && opts?.progress) {
        opts.progress.update('worker-devices', {
          state: 'running',
          detail: `found ${staleResult.reusable.length} reusable simulator(s) from previous run`,
        });
      }
    }
    // Only booted simulators the config names and Tapsmith's clones of them,
    // on the primary's runtime: any other may be one the developer is using
    // (PILOT-511). No `simulator` (a physical primary) → nothing to adopt.
    const adoptable = config.simulator
      ? listAdoptableBootedSimulators(config.simulator, { compatibleWith: config.device })
      : [];
    const others = adoptable
      .filter((s) => s.udid !== config.device && !pinned.includes(s.udid))
      .slice(0, Math.max(0, wanted - 1 - pinned.length));
    if (others.length > 0) {
      reusedSimulatorCount += others.length;
      if (opts?.progress) {
        opts.progress.update('worker-devices', {
          state: 'running',
          detail: `reusing ${others.length} already-booted ${config.simulator} simulator(s)`,
        });
      } else {
        for (const sim of others) {
          process.stderr.write(`${DIM}Reusing already-booted simulator ${sim.udid} (${sim.name}).${RESET}\n`);
        }
      }
    }
    serials = [config.device!, ...pinned, ...others.map((s) => s.udid)].filter(Boolean);

    if (serials.length < wanted && config.simulator) {
      const provision = provisionSimulators({
        simulatorName: config.simulator,
        workers: wanted,
        existingUdids: serials,
        appPath: config.app ? path.resolve(config.rootDir, config.app) : undefined,
        reusableUdids,
        onProgress: (message, level) => {
          if (!opts?.progress) return;
          if (level === 'warning') opts.progress.note(message);
          else opts.progress.update('worker-devices', { state: 'running', detail: message });
        },
      });
      reusedSimulatorCount += provision.reusedUdids.length;
      for (const u of provision.freshUdids) freshSerials.add(u);
      serials = provision.allUdids;
    }
  } else {
    const allConnected = listConnectedDeviceSerials();
    // Never another live session's device (PILOT-381, PILOT-328).
    const unheld = withoutHeldDevices(allConnected);
    for (const claim of unheld.held) {
      if (opts?.progress) opts.progress.note(skippedHeldDeviceMessage(claim));
      else if (!opts?.quiet) process.stderr.write(`${DIM}${skippedHeldDeviceMessage(claim)}${RESET}\n`);
    }
    const others = unheld.free.filter((s) => s !== config.device && !pinned.includes(s));
    serials = [config.device!, ...pinned, ...others].filter(Boolean);

    if (serials.length < wanted && config.launchEmulators) {
      assertAdbForEmulatorLaunch();
      const provision = await provisionEmulators({
        existingSerials: serials,
        occupiedSerials: allConnected,
        workers: wanted,
        avd: config.avd,
        launchOptions: config.emulatorLaunchOptions,
        onProgress: (message, level) => {
          // Without a progress display a warning (an emulator's early-exit reason,
          // how to stop it) still has to reach the user.
          if (!opts?.progress) {
            if (level === 'warning') process.stderr.write(`${YELLOW}${message}${RESET}\n`);
            return;
          }
          if (level === 'warning') opts.progress.note(message);
          else opts.progress.update('worker-devices', { state: 'running', detail: message });
        },
      });
      launched = provision.launched;
      for (const e of provision.launched) freshSerials.add(e.serial);
      serials = provision.allSerials;
    }
  }

  // Claimed as they are picked, and only as many as wanted (PILOT-381): two
  // sessions provisioning at once then divide the free devices instead of
  // both taking the first ones, and the run holds nothing it will not use.
  serials = claimUpTo(serials, wanted).claimed;

  if (serials.length < 2) {
    rowProgress?.skip('worker-devices', `${serials.length} device(s) available; using single-worker mode`);
    if (!opts?.quiet && !opts?.progress) {
      process.stderr.write(
        `${YELLOW}Only ${serials.length} device(s) available. ${modeName} needs 2+ devices for parallel. Using single-worker mode.${RESET}\n`,
      );
    }
    return { deviceSerials: undefined, launched, freshSerials };
  }

  const reuseSuffix = reusedSimulatorCount > 0 ? ` (${reusedSimulatorCount} reused)` : '';
  rowProgress?.complete('worker-devices', `${serials.length} device(s)${reuseSuffix}: ${serials.join(', ')}`);
  return { deviceSerials: serials, launched, freshSerials };
}

/**
 * Worker device groups for a single-bucket UI / watch session: worker 0 is
 * the group the sequential setup already opened (primary + `use.devices`
 * members); further workers get `groupSize` devices each, provisioned like
 * extra worker devices. `undefined` when the session stays single-worker.
 */
async function provisionWorkerGroups(
  state: SequentialDeviceState,
  modeName: string,
  opts?: { quiet?: boolean; progress?: LaunchProgressSink },
): Promise<{ workerGroups: string[][] | undefined; launched: LaunchedEmulator[] }> {
  const config = state.effectiveConfig;
  const groupSize = state.deviceGroup.length;
  const firstGroup = state.sessions.map((s) => s.serial);
  // Any pin — `--device` or root `device` on the primary included — fixes
  // the session to the one group the setup opened. Extra workers used to be
  // spread onto every other connected device beside a `--device` primary
  // (PILOT-313). `state.deviceGroup` predates the setup's auto-pick.
  const pinned = state.deviceGroup.some((e) => e.device);
  if (config.workers <= 1 || pinned) return { workerGroups: undefined, launched: [] };
  const provision = await provisionMultiWorkerDevices(config, modeName, {
    ...opts,
    wanted: config.workers * groupSize,
    pinned: firstGroup.slice(1),
  });
  if (!provision.deviceSerials) return { workerGroups: undefined, launched: provision.launched };
  const rest = provision.deviceSerials.filter((s) => !firstGroup.includes(s));
  const groups = [firstGroup];
  for (let i = 0; i + groupSize <= rest.length && groups.length < config.workers; i += groupSize) {
    groups.push(rest.slice(i, i + groupSize));
  }
  if (groups.length < 2) {
    // Enough devices for one group but not two: the row above completed, so
    // downgrade it to the same skip a plain device shortfall reports.
    opts?.progress?.skip('worker-devices', `${provision.deviceSerials.length} device(s) available; using single-worker mode`);
    if (!opts?.quiet && !opts?.progress) {
      process.stderr.write(
        `${YELLOW}Only ${provision.deviceSerials.length} device(s) available. ${modeName} needs ${2 * groupSize}+ for parallel. Using single-worker mode.${RESET}\n`,
      );
    }
    return { workerGroups: undefined, launched: provision.launched };
  }
  return { workerGroups: groups, launched: provision.launched };
}

interface PerProjectProvisionResult {
  deviceSerials: string[]
  /** One entry per worker: its device group, primary first. */
  workerGroups: string[][]
  /**
   * Each device's worker config: its bucket's effective config with `devices`
   * reset to the root's, so a child sizes a run from the *project's* group
   * (`use.devices`, else this) rather than the bucket's largest.
   */
  configByDevice: Map<string, import('./worker-protocol.js').SerializedConfig>
  /** Each device's worker group, primary first — the bucket's largest, pinned to that device. */
  deviceGroupByDevice: Map<string, DeviceGroupEntry[]>
  bucketByDevice: Map<string, string>
  bucketByProject: Map<string, string>
  launched: LaunchedEmulator[]
  reusedSimulatorCount: number
  /**
   * The targets that could not start, and how to try one again: the session
   * goes on with the others (PILOT-415).
   */
  unavailableTargets: import('./unavailable-targets.js').UnavailableTargets
}

/**
 * Provision devices for a single bucket using its effective config and a
 * fixed worker count. Returns the device serials successfully provisioned
 * (may be fewer than requested if hardware constraints prevent it).
 */
/**
 * {@link provisionDevicesForBucketUnclaimed}, with the devices it hands back
 * claimed as they are picked — no more than `desiredWorkers` of them, and none
 * another session holds (PILOT-381).
 */
async function provisionDevicesForBucket(
  ...args: Parameters<typeof provisionDevicesForBucketUnclaimed>
): Promise<{ serials: string[]; launched: LaunchedEmulator[]; reusedSimulatorCount: number }> {
  const provisioned = await provisionDevicesForBucketUnclaimed(...args);
  return { ...provisioned, serials: claimUpTo(provisioned.serials, args[1]).claimed };
}

async function provisionDevicesForBucketUnclaimed(
  effectiveConfig: TapsmithConfig,
  desiredWorkers: number,
  progress?: LaunchProgressSink,
  /**
   * The bucket's device group as it was before the sequential setup (see
   * `pinnedBucketSignatures`) when it pins anything. Never re-resolved from
   * `effectiveConfig`: that setup has since written its auto-picked serial
   * onto the root config `use`-less projects share.
   */
  pinnedGroup?: readonly DeviceGroupEntry[],
): Promise<{ serials: string[]; launched: LaunchedEmulator[]; reusedSimulatorCount: number }> {
  if (desiredWorkers <= 0) return { serials: [], launched: [], reusedSimulatorCount: 0 };
  const pinnedMembers = (pinnedGroup ?? []).flatMap((e) => (e.device ? [e.device] : []));
  if (pinnedGroup && pinnedMembers.length > 0) {
    // A pinned member another session drives is refused by name, not left to
    // surface as a device shortfall (PILOT-381).
    for (const serial of [pinnedGroup[0].device, ...pinnedMembers]) {
      if (serial) claimDeviceOrThrow(serial, currentSession());
    }
    // A pinned group is exactly one worker: the primary (pinned or the first
    // device found), then the members in order — each keeping its pin, the
    // unpinned ones taking the next free device provisioned here. Nothing to
    // provision when every entry is pinned.
    const group = pinnedGroup.map((e) => ({ ...e }));
    if (group.every((e) => e.device)) {
      // Every device named outright: the same pins-only group (and the same
      // refusal of an Android pin that is not connected) as the parallel path.
      const { pinnedWorkerDevices } = await import('./dispatcher.js');
      const isIos = effectiveConfig.platform === 'ios';
      // One adb snapshot for both lists, so a pin's state cannot change between them.
      const adb = isIos ? [] : listAdbDevices();
      const pins = pinnedWorkerDevices(group, adb.filter((d) => d.state === 'device').map((d) => d.serial), isIos, adb)!;
      return { serials: pins, launched: [], reusedSimulatorCount: 0 };
    }
    const pool = await provisionDevicesForBucketUnclaimed({ ...effectiveConfig, devices: undefined, device: undefined }, group.length, progress);
    const first = group[0].device ?? pool.serials.find((s) => !pinnedMembers.includes(s));
    const members = first ? assignGroupMemberDevices(group, first, pool.serials) : undefined;
    return {
      // Short of devices: hand back what there is, so the caller's
      // `< groupSize` check reports the shortfall with the real list.
      serials: members ? [first!, ...members] : first ? [first, ...pinnedMembers.filter((s) => s !== first)] : pinnedMembers,
      launched: pool.launched,
      reusedSimulatorCount: pool.reusedSimulatorCount,
    };
  }

  if (effectiveConfig.platform === 'ios') {
    // Physical-device bucket: no `simulator` set → resolve a paired USB
    // device. Parallel workers against one physical device aren't
    // supported, so we always return a single serial here regardless of
    // desiredWorkers; the caller's worker allocation is capped elsewhere.
    if (!effectiveConfig.simulator) {
      if (effectiveConfig.device) {
        return { serials: [effectiveConfig.device], launched: [], reusedSimulatorCount: 0 };
      }
      const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
      try {
        const udid = resolvePhysicalIosDevice();
        return { serials: [udid], launched: [], reusedSimulatorCount: 0 };
      } catch (e) {
        throw new Error(
          `iOS physical device bucket failed to resolve: ${(e as Error).message}`,
        );
      }
    }
    const { provisionSimulators, listBootedSimulators, cleanupStaleSimulators } =
      await import('./ios-simulator.js');

    const stale = cleanupStaleSimulators(effectiveConfig.simulator);
    const reusableUdids = stale.reusable;
    if (reusableUdids.length > 0 && progress) {
      progress.update('worker-devices', {
        state: 'running',
        detail: `found ${reusableUdids.length} reusable simulator(s) from previous run`,
      });
    }

    // Find any already-booted matching simulators (no primary required)
    // Not one another live Tapsmith session holds (PILOT-381).
    const heldElsewhere = new Set(withoutHeldDevices(listBootedSimulators().map((s) => s.udid)).held.map((c) => c.device));
    const booted = listBootedSimulators().filter(
      (s) => (s.name === effectiveConfig.simulator || s.udid === effectiveConfig.simulator) && !heldElsewhere.has(s.udid),
    );
    const existing = booted.map((s) => s.udid).slice(0, desiredWorkers);

    if (existing.length >= desiredWorkers) {
      return { serials: existing, launched: [], reusedSimulatorCount: 0 };
    }

    const provision = provisionSimulators({
      simulatorName: effectiveConfig.simulator,
      workers: desiredWorkers,
      existingUdids: existing,
      appPath: effectiveConfig.app
        ? path.resolve(effectiveConfig.rootDir, effectiveConfig.app)
        : undefined,
      reusableUdids,
      onProgress: (message, level) => {
        if (!progress) {
          // A mid-session retry has no progress display; a warning still has
          // to reach the user, as on the Android path.
          if (level === 'warning') process.stderr.write(`${YELLOW}${message}${RESET}\n`);
          return;
        }
        if (level === 'warning') progress.note(message);
        else progress.update('worker-devices', { state: 'running', detail: message });
      },
    });
    return { serials: provision.allUdids, launched: [], reusedSimulatorCount: provision.reusedUdids.length };
  }

  // Android
  const allConnected = listConnectedDeviceSerials();
  const deviceStrategy = resolveDeviceStrategy(effectiveConfig);
  // Devices another live Tapsmith session holds are skipped (PILOT-381), but
  // stay "occupied" for the emulator launch below.
  const unheld = withoutHeldDevices(allConnected);
  for (const claim of unheld.held) {
    if (progress) progress.note(skippedHeldDeviceMessage(claim));
    else process.stderr.write(`${DIM}${skippedHeldDeviceMessage(claim)}${RESET}\n`);
  }
  const prefiltered = prefilterDevicesForStrategy(
    unheld.free,
    deviceStrategy,
    effectiveConfig.avd,
  );
  const healthy = filterHealthyDevices(prefiltered.candidateSerials);
  const selected = selectDevicesForStrategy(
    healthy.healthySerials,
    deviceStrategy,
    effectiveConfig.avd,
  );
  let serials = selected.selectedSerials.slice(0, desiredWorkers);

  if (serials.length >= desiredWorkers) {
    return { serials, launched: [], reusedSimulatorCount: 0 };
  }

  if (!effectiveConfig.launchEmulators) {
    return { serials, launched: [], reusedSimulatorCount: 0 };
  }

  assertAdbForEmulatorLaunch();
  const provision = await provisionEmulators({
    existingSerials: serials,
    occupiedSerials: allConnected,
    workers: desiredWorkers,
    avd: effectiveConfig.avd,
    launchOptions: effectiveConfig.emulatorLaunchOptions,
    onProgress: (message, level) => {
      // Without a progress display a warning (an emulator's early-exit reason,
      // how to stop it) still has to reach the user.
      if (!progress) {
        if (level === 'warning') process.stderr.write(`${YELLOW}${message}${RESET}\n`);
        return;
      }
      if (level === 'warning') progress.note(message);
      else progress.update('worker-devices', { state: 'running', detail: message });
    },
  });
  const healthyLaunched = filterHealthyDevices(provision.allSerials);
  const selectedAfter = selectDevicesForStrategy(
    healthyLaunched.healthySerials,
    deviceStrategy,
    effectiveConfig.avd,
  );
  serials = selectedAfter.selectedSerials.slice(0, desiredWorkers);
  return { serials, launched: provision.launched, reusedSimulatorCount: 0 };
}

/**
 * Provision devices per project bucket. Each bucket (set of projects sharing
 * a deviceSignature) gets its own devices and serialized config. Used by
 * UI mode and watch mode to support multi-device-target projects.
 *
 * A bucket that cannot be provisioned does not fail the session while
 * another can (PILOT-415): it comes back in `unavailableTargets`, which can
 * provision it again for a later run. Only every bucket failing throws.
 */
async function provisionPerProjectDevices(
  rootConfig: TapsmithConfig,
  projects: import('./project.js').ResolvedProject[],
  budgetCap: number | undefined,
  /** Buckets that pin a device, taken before the sequential setup ran (see `allocateBucketWorkers`). */
  pinnedSignatures: import('./project.js').PinnedBuckets,
  /** Targets whose primary setup already failed: not tried again at startup, only on a later run. */
  alreadyFailed: ReadonlyMap<string, unknown>,
  /**
   * The root config's own `device` before the primary setup wrote its serial
   * there. A retry of a `use`-less target (whose config is the root) puts it
   * back: the primary may since be another target's device.
   */
  rootDeviceBeforeSetup: string | undefined,
  progress?: LaunchProgressSink,
): Promise<PerProjectProvisionResult> {
  progress?.start('worker-devices', 'preparing devices across project targets');
  const result: Omit<PerProjectProvisionResult, 'unavailableTargets'> = {
    deviceSerials: [],
    workerGroups: [],
    configByDevice: new Map(),
    deviceGroupByDevice: new Map(),
    bucketByDevice: new Map(),
    bucketByProject: new Map(),
    launched: [],
    reusedSimulatorCount: 0,
  };

  const { allocateBucketWorkers, bucketizeProjects, sharedDeviceGroup } = await import('./project.js');
  const bucketEntries = bucketizeProjects(projects);
  for (const b of bucketEntries) {
    for (const p of b.projects) {
      result.bucketByProject.set(p.name, b.signature);
    }
  }

  // Allocate workers across buckets
  const allocation = allocateBucketWorkers(rootConfig.workers, bucketEntries, budgetCap, pinnedSignatures);

  /** Provision one bucket's devices; null when it was allocated no worker. */
  const provisionBucket = async (
    { signature, projects: bucketProjects }: (typeof bucketEntries)[number],
    sink: LaunchProgressSink | undefined,
    retrying = false,
  ) => {
    const desiredWorkers = allocation.get(signature) ?? 0;
    if (desiredWorkers === 0) return null;

    // The bucket's projects share its devices: provision for the largest
    // group any of them declares (a smaller project runs on the first N).
    const shared = sharedDeviceGroup(bucketProjects).config;
    const bucketEffective = retrying && shared === rootConfig ? { ...shared, device: rootDeviceBeforeSetup } : shared;
    const groupSize = deviceGroupSize(bucketEffective);
    // Every pin, the primary's included, from the snapshot taken before the
    // sequential setup: that setup has since written its auto-picked serial
    // onto the root config `use`-less projects share, which is not a pin.
    const snapshot = pinnedSignatures.get(signature);
    const pinned = [...(snapshot?.pins ?? [])];
    const workersWanted = pinned.length > 0 ? 1 : desiredWorkers;
    const desiredDevices = workersWanted * groupSize;
    sink?.update(
      'worker-devices',
      { state: 'running', detail: `preparing ${desiredDevices} device(s) for ${bucketProjects.map((p) => p.name).join(', ')}` },
    );
    const provisioned = await provisionDevicesForBucket(bucketEffective, desiredDevices, sink, snapshot?.group);

    if (provisioned.serials.length === 0) {
      const iosBucketBlocker = bucketEffective.platform === 'ios' ? iosToolchainBlocker() : undefined;
      throw new Error(
        `Failed to provision any devices for bucket "${signature.split('|').slice(0, 2).join(' ')}".`
        + (bucketEffective.platform === 'ios'
          ? (iosBucketBlocker ? ` ${iosBucketBlocker}.` : '')
          : ` ${attachedDeviceAdvice(bucketEffective, listAdbDevices(), androidToolchainBlocker())}`)
        // Devices other sessions hold are named, not left to read as missing.
        + (bucketEffective.platform === 'ios' ? '' : heldDevicesNote(withoutHeldDevices(listConnectedDeviceSerials()).held)),
      );
    }
    if (provisioned.serials.length < groupSize) {
      throw new Error(
        `Bucket "${bucketProjects.map((p) => p.name).join(',')}" needs ${groupSize} device(s) per worker (use.devices) but only `
        + `${provisioned.serials.length} could be provisioned (${provisioned.serials.join(', ')}).`,
      );
    }
    if (provisioned.serials.length < desiredDevices) {
      const message = `Bucket "${bucketProjects.map((p) => p.name).join(',')}" requested ${workersWanted} workers but only ${Math.floor(provisioned.serials.length / groupSize)} could be provisioned.`;
      if (sink) sink.note(message);
      else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
    }

    const bucketSerialized = serializeConfig({ ...bucketEffective, devices: rootConfig.devices });
    // Whole groups only: a trailing partial group has no worker to serve.
    const usable = provisioned.serials.slice(0, Math.floor(provisioned.serials.length / groupSize) * groupSize);
    const target: import('./unavailable-targets.js').ProvisionedTarget = {
      workerGroups: [],
      configByDevice: new Map(),
      deviceGroupByDevice: new Map(),
      launched: provisioned.launched,
    };
    for (const serial of usable) {
      target.configByDevice.set(serial, bucketSerialized);
      target.deviceGroupByDevice.set(serial, resolveDeviceGroup({ devices: bucketEffective.devices, device: serial }));
    }
    for (let i = 0; i < usable.length; i += groupSize) {
      target.workerGroups.push(usable.slice(i, i + groupSize));
    }
    return { signature, target, reusedSimulatorCount: provisioned.reusedSimulatorCount };
  };

  // Provision each bucket's devices in parallel — Android emulators and
  // iOS simulators both have multi-second cold-start costs, and there's
  // no cross-bucket dependency. Every bucket settles, so none is left
  // provisioning behind a failure, and results keep bucket order.
  const settled = await Promise.allSettled(bucketEntries.map((entry) => (alreadyFailed.has(entry.signature)
    ? Promise.reject(alreadyFailed.get(entry.signature))
    : provisionBucket(entry, progress))));
  const { deviceTargetLabel, isProgrammingError, noTargetCouldStart, targetStartNotice, targetStartWarning } = await import('./dispatcher.js');
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  // A bug in Tapsmith surfaces as itself, with its stack.
  const bug = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected' && isProgrammingError(r.reason));
  if (bug) throw bug.reason;
  const failures = settled.flatMap((r, i) => (r.status === 'rejected'
    ? [{ signature: bucketEntries[i].signature, label: deviceTargetLabel(bucketEntries[i].signature), err: r.reason as unknown }]
    : []));
  const outcomes = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
  if (outcomes.length === 0 && failures.length > 0) {
    const error = noTargetCouldStart(failures);
    progress?.fail('worker-devices', error.message.split('\n')[0]);
    throw error;
  }

  for (const { signature, target, reusedSimulatorCount } of outcomes) {
    result.launched.push(...target.launched);
    result.reusedSimulatorCount += reusedSimulatorCount;
    for (const group of target.workerGroups) {
      result.workerGroups.push(group);
      for (const serial of group) {
        result.deviceSerials.push(serial);
        result.configByDevice.set(serial, target.configByDevice.get(serial)!);
        result.deviceGroupByDevice.set(serial, target.deviceGroupByDevice.get(serial)!);
        result.bucketByDevice.set(serial, signature);
      }
    }
  }

  const { UnavailableTargets } = await import('./unavailable-targets.js');
  const unavailableTargets = new UnavailableTargets(
    async (signature) => {
      const entry = bucketEntries.find((b) => b.signature === signature);
      const outcome = entry ? await provisionBucket(entry, undefined, true) : null;
      if (!outcome) throw new Error(`internal: device target ${deviceTargetLabel(signature)} has no worker planned`);
      return outcome.target;
    },
    failures.map((f) => [f.signature, f.err] as [string, unknown]),
  );

  const reuseSuffix = result.reusedSimulatorCount > 0 ? ` (${result.reusedSimulatorCount} reused)` : '';
  const ready = `${result.deviceSerials.length} device(s)${reuseSuffix}: ${result.deviceSerials.join(', ')}`;
  if (failures.length > 0) {
    progress?.update('worker-devices', {
      state: 'warning',
      detail: `${ready}; ${failures.map((f) => `${f.label} could not start: ${messageOf(f.err).split('\n')[0]}`).join('; ')}`,
    });
    // A target whose primary setup failed was announced then.
    for (const f of failures.filter((x) => !alreadyFailed.has(x.signature))) {
      const fileCount = bucketEntries.find((b) => b.signature === f.signature)!.projects.reduce((n, p) => n + p.testFiles.length, 0);
      process.stderr.write(`${YELLOW}${targetStartNotice(targetStartWarning(f.label, fileCount, true), messageOf(f.err))}${RESET}\n`);
    }
  } else {
    progress?.complete('worker-devices', ready);
  }
  return { ...result, unavailableTargets };
}

// ─── Main ───

/** What each command does. Heavy modules load only when their command runs. */
const cliHandlers: CliHandlers = {
  test: (args) => runTestCommand(args),

  showReport: async ({ dir }) => {
    const reportPath = path.resolve(process.cwd(), dir ?? 'tapsmith-report', 'index.html');
    if (!fs.existsSync(reportPath)) {
      console.error(red(`No report found at ${reportPath}`));
      process.exit(1);
    }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    console.log(bold('Opening HTML report'));
    console.log(dim(reportPath));
    try {
      spawn(cmd, [reportPath], { detached: true, stdio: 'ignore' }).unref();
      console.log(green('✓ opened default browser'));
    } catch (err) {
      console.error(red(`Failed to open report: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  },

  showTrace: async ({ file }) => {
    const { showTrace } = await import('./trace/show-trace-server.js');
    try {
      console.log(bold('Opening trace viewer'));
      console.log(dim(path.resolve(file)));
      const server = await showTrace({ tracePath: file });
      console.log(green('✓ trace viewer ready'));
      console.log(dim(`Trace viewer running at http://127.0.0.1:${server.port}/`));
      console.log(dim('Press Ctrl+C to stop.'));
      // Keep alive until Ctrl+C
      process.on('SIGINT', () => {
        server.close();
        process.exit(0);
      });
      // Prevent Node from exiting
      await new Promise(() => {});
    } catch (err) {
      console.error(red(`${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  },

  mergeReports: async ({ dir, config: configFile }) => {
    const { runMergeReports } = await import('./merge-reports.js');
    const config = await loadConfig(undefined, configFile);
    const code = await runMergeReports(dir ?? 'blob-report', config);
    if (code !== 0) process.exit(code);
  },

  listDevices: async (opts) => (await import('./list-devices.js')).runListDevices(opts),
  iosSetupDevice: async (opts) => (await import('./setup-ios-device.js')).runSetupIosDevice(opts),
  iosBuildAgent: async (opts) => (await import('./build-ios-agent.js')).runBuildIosAgent(opts),
  iosNetworkSetupSimulator: async () => (await import('./setup-ios.js')).runSetupIos(),
  iosNetworkConfigure: async (opts) => (await import('./configure-ios-network.js')).runConfigureIosNetwork(opts),
  iosNetworkVerify: async (opts) => (await import('./verify-ios-network.js')).runVerifyIosNetwork(opts),
  createAvd: async (opts) => (await import('./create-avd.js')).runCreateAvd(opts),
  init: async (opts) => (await import('./init.js')).runInit(opts),
  verify: async (opts) => (await import('./verify.js')).runVerify(opts),
  doctor: async (opts) => (await import('./doctor.js')).runDoctor(opts),
  mcpServer: async ({ config }) => (await import('./mcp/index.js')).runMcpServer({ configFile: config }),
  telemetry: async (opts) => (await import('./telemetry-cli.js')).runTelemetryCommand(opts),
};

async function main(): Promise<void> {
  // Stamp one telemetry session id into the environment before any child is
  // forked (the tsx re-exec, workers, watch/MCP run children all inherit it),
  // so every per-file event of this invocation shares one session (PILOT-330).
  ensureSessionEnv();
  // Likewise the device-claim session (PILOT-381): every process this
  // invocation forks claims devices as this one session, and this process's
  // exit releases them.
  ensureClaimSession(claimSessionCommand(process.argv.slice(2)));

  const code = await runCli(process.argv.slice(2), {
    handlers: cliHandlers,
    version: getVersion(),
    beforeAction: (command, opts) => {
      if (printsBanner(command, opts)) printTapsmithBanner();
    },
    refuse: (command) => yarnPnpRefusal(command),
  });
  // A handler that set process.exitCode itself returns nothing: keep its code.
  if (code !== 0) process.exitCode = code;
}

/**
 * How a session is named to other sessions it holds a device against:
 * `tapsmith test --ui`, `tapsmith mcp-server`. The subcommand and the flags
 * that say which kind of run it is — nothing else from the command line.
 */
function claimSessionCommand(argv: readonly string[]): string {
  const subcommand = argv.find((a) => !a.startsWith('-'));
  const modes = argv.filter((a) => a === '--ui' || a === '--watch' || a === '--workers' || a.startsWith('--workers='));
  return ['tapsmith', ...(subcommand ? [subcommand] : []), ...modes.map((m) => (m.startsWith('--workers') ? '--workers' : m))].join(' ');
}

/**
 * The failed-to-load result of each file of the run that the preflight child
 * could not load, one per project that runs it, as the run itself would have
 * reported them.
 */
async function preflightLoadFailures(
  projects: import('./project.js').ResolvedProject[],
  found: Map<string, import('./selection-preflight.js').FilePreflight | undefined>,
): Promise<TestResult[]> {
  const { preflightLoadError } = await import('./selection-preflight.js');
  const { projectLabel } = await import('./project.js');
  const results: TestResult[] = [];
  for (const project of projects) {
    for (const file of project.testFiles) {
      const result = found.get(file);
      if (!result || !('error' in result)) continue;
      results.push(loadFailureResult(
        { testFilePath: file, projectName: projectLabel(project) },
        preflightLoadError(result.error),
      ));
    }
  }
  return results;
}

async function runTestCommand(args: TestCommandArgs): Promise<void> {
  // Load config
  const config = await loadConfig(undefined, args.config);
  const configPath = configPathOf(config);
  // No config file: a project not set up yet, with no app to test. Say how
  // to set it up, before finding files or a device the defaults would send
  // the run looking for (PILOT-784). A missing --config file already threw.
  if (configPath === undefined) {
    console.error(red(noConfigFoundMessage(config.rootDir, await tapsmithExecCommand(config.rootDir))));
    process.exit(1);
  }
  if (args.device) {
    config.device = args.device;
  }
  if (args.workers !== undefined) {
    config.workers = args.workers;
    Object.defineProperty(config, EXPLICIT_WORKERS, {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  if (args.shard) {
    config.shard = args.shard;
  }
  if (args.trace) {
    config.trace = args.trace;
  }
  if (args.video) {
    config.video = args.video;
  }
  if (args.grep !== undefined) {
    config.grep = args.grep;
  }
  if (args.grepInvert !== undefined) {
    config.grepInvert = args.grepInvert;
  }
  if (args.reporter) {
    config.reporter = args.reporter;
  }


  // Validate watch mode constraints
  if (args.watch) {
    if (args.shard) {
      console.error(red('--watch cannot be combined with --shard'));
      process.exit(1);
    }
    // Watch mode supports parallel workers when multiple devices are available.
    // config.workers is left as-is; the watch coordinator handles multi-device setup.
  }

  // Validate UI mode constraints
  if (args.ui) {
    if (args.shard) {
      console.error(red('--ui cannot be combined with --shard'));
      process.exit(1);
    }
    if (args.watch) {
      // UI mode has its own watch — ignore --watch
      args.watch = false;
    }
    // UI mode supports parallel workers when multiple devices are available.
    // config.workers is left as-is; the UI server handles multi-device setup.
  }

  // ─── Project resolution & test file discovery ───
  const { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectsForFile, validateProjectNames, projectLabel, shardProjects } = await import('./project.js');
  const hasProjects = config.projects && config.projects.length > 0;
  const hasExplicitFiles = args.files && args.files.length > 0;
  const selectedProjects = args.project && args.project.length > 0 ? args.project : undefined;

  // `--project` requires a configured `projects` array (the only exception is
  // explicitly selecting the synthetic "default" project).
  if (selectedProjects && !hasProjects && !selectedProjects.every((n) => n === 'default')) {
    console.error(red(
      `--project requires a "projects" array in your config. `
      + `Requested: ${selectedProjects.map((n) => `"${n}"`).join(', ')}`,
    ));
    process.exit(1);
  }

  let projects: import('./project.js').ResolvedProject[];
  let projectWaves: import('./project.js').ResolvedProject[][];
  // What the positional arguments failed to select, for "No tests found".
  let unmatchedFileArgs: string[] = [];
  let regexReadFileArgs: string[] = [];
  const filesOutsideProjects: string[] = [];
  const discoveredByProject = new Map<string, string[]>();
  // The testMatch patterns the selection was drawn from, for that message.
  let selectionTestMatch: string[] = config.testMatch;

  if (hasProjects && !hasExplicitFiles) {
    // Full project mode — discover all files per project
    projects = resolveProjects(config);
    if (selectedProjects) {
      try {
        validateProjectNames(selectedProjects, projects);
      } catch (err) {
        console.error(red((err as Error).message));
        process.exit(1);
      }
      // Run the selected projects plus their transitive dependencies.
      const required = collectTransitiveDeps(new Set(selectedProjects), projects);
      projects = projects.filter((p) => required.has(p.name));
    }
    projectWaves = topologicalSort(projects);
    selectionTestMatch = [...new Set(projects.flatMap((p) => p.testMatch))];
    for (const project of projects) {
      project.testFiles = await discoverTestFiles(project.testMatch, config.rootDir, project.testIgnore);
    }
  } else if (hasProjects && hasExplicitFiles) {
    // Explicit files with projects — auto-run dependencies
    const allProjects = resolveProjects(config);
    if (selectedProjects) {
      try {
        validateProjectNames(selectedProjects, allProjects);
      } catch (err) {
        console.error(red((err as Error).message));
        process.exit(1);
      }
    }
    const selectedSet = selectedProjects ? new Set(selectedProjects) : undefined;
    // Directories, globs and filters select among the files the (selected)
    // projects discover; a file named outright is kept even if none does,
    // and is then reported below rather than silently dropped.
    for (const project of allProjects) {
      if (selectedSet && !selectedSet.has(project.name)) continue;
      const files = await discoverTestFiles(project.testMatch, config.rootDir, project.testIgnore);
      discoveredByProject.set(project.name, files);
    }
    selectionTestMatch = [...new Set(allProjects
      .filter((p) => discoveredByProject.has(p.name))
      .flatMap((p) => p.testMatch))];
    const resolution = resolveTestFileArgs(
      args.files,
      [...new Set([...discoveredByProject.values()].flat())].sort(),
      [config.rootDir, process.cwd()],
    );
    unmatchedFileArgs = resolution.unmatched;
    regexReadFileArgs = resolution.readAsRegex;
    const explicitPaths = resolution.files;

    // Find which projects the explicit files belong to
    const targetProjectNames = new Set<string>();
    const filesByProject = new Map<string, string[]>();
    for (const filePath of new Set(explicitPaths)) {
      // The projects whose discovery found it — `testMatch` may be shaped
      // (`./…`) so only glob reads it — else, for a file named outright that
      // none discovered, the projects whose patterns match it.
      const discoveredBy = [...discoveredByProject].filter(([, files]) => files.includes(filePath)).map(([name]) => name);
      const owners = (discoveredBy.length > 0 ? discoveredBy : findProjectsForFile(filePath, allProjects, config.rootDir))
        .filter((name) => !selectedSet || selectedSet.has(name));
      if (owners.length === 0) filesOutsideProjects.push(filePath);
      for (const name of owners) {
        targetProjectNames.add(name);
        let list = filesByProject.get(name);
        if (!list) {
          list = [];
          filesByProject.set(name, list);
        }
        list.push(filePath);
      }
    }

    // Collect transitive dependencies
    const requiredNames = collectTransitiveDeps(targetProjectNames, allProjects);

    // Filter to only required projects
    projects = allProjects.filter((p) => requiredNames.has(p.name));
    projectWaves = topologicalSort(projects);

    // A project another project in this run depends on runs whole, as in
    // Playwright — even when an argument also selected some of its files, so
    // `auth` cannot cut a setup project down to auth.setup.ts while the tests
    // that need all of it run. Any other target runs only the selected files.
    const dependedOn = new Set(projects.flatMap((p) => p.dependencies));
    for (const project of projects) {
      if (targetProjectNames.has(project.name) && !dependedOn.has(project.name)) {
        project.testFiles = filesByProject.get(project.name) ?? [];
      } else {
        // Dependency project — run all its files
        project.testFiles = discoveredByProject.get(project.name)
          ?? await discoverTestFiles(project.testMatch, config.rootDir, project.testIgnore);
      }
    }
  } else {
    // No projects configured — single default project
    const { deviceSignature: makeDeviceSignature } = await import('./project.js');
    const defaultProject: import('./project.js').ResolvedProject = {
      name: 'default',
      // Invented because the config declares no projects — the flag is what
      // stops the UI and MCP from presenting it as one the user can name.
      synthesized: true,
      testMatch: config.testMatch,
      testIgnore: [],
      dependencies: [],
      testFiles: [],
      effectiveConfig: config,
      deviceSignature: makeDeviceSignature(config),
    };
    const discovered = await discoverTestFiles(config.testMatch, config.rootDir);
    if (hasExplicitFiles) {
      const resolution = resolveTestFileArgs(args.files, discovered, [config.rootDir, process.cwd()]);
      unmatchedFileArgs = resolution.unmatched;
      regexReadFileArgs = resolution.readAsRegex;
      defaultProject.testFiles = resolution.files;
    } else {
      defaultProject.testFiles = discovered;
    }
    projects = [defaultProject];
    projectWaves = [[defaultProject]];
  }

  // Flat list for backward-compatible code paths (reporters, tsx check, etc.)
  let testFiles = projects.flatMap((p) => p.testFiles);
  // Deduplicate (a file could match multiple projects' globs)
  testFiles = [...new Set(testFiles)].sort();

  // Before any daemon, device or tsx work: an argument that selects nothing
  // must not cost a device boot to find out (PILOT-553).
  if (testFiles.length === 0) {
    console.error(red(noTestFilesFoundMessage({
      args: hasExplicitFiles ? args.files : [],
      unmatched: unmatchedFileArgs,
      outsideProjects: filesOutsideProjects.map((f) => relativeTestPath(f, config.rootDir)),
      testMatch: selectionTestMatch,
      rootDir: config.rootDir,
      projectsSelected: selectedProjects !== undefined,
    })));
    process.exit(1);
  }

  // Every project's files before sharding: whether a grep selects anything is
  // a question about the whole suite, so every shard with files answers it the
  // same way (a shard left with none still exits 0 below, as it always has).
  const unshardedFiles = projects.map((p) => ({ project: p, files: [...p.testFiles] }));

  let shardMessage: string | undefined;
  // Apply sharding — a deterministic split within each project, the default
  // one included, since the run iterates the projects' lists (PILOT-596).
  if (config.shard) {
    const { current, total } = config.shard;
    testFiles = shardProjects(projects, config.shard);
    if (testFiles.length === 0) {
      console.log(dim(`Shard ${current}/${total}: no test files in this shard.`));
      // Still leave this shard's (empty) blob, or merge-reports would report
      // the shard as missing whenever there are fewer files than shards.
      const { writeEmptyShardBlob } = await import('./merge-reports.js');
      const refusal = await writeEmptyShardBlob(config);
      if (refusal) {
        console.error(red(refusal));
        process.exit(1);
      }
      process.exit(0);
    }
    shardMessage = `Shard ${current}/${total}: running ${testFiles.length} file(s)`;
  }

  // Re-exec under tsx if we have TypeScript test files and haven't already
  if (needsTsx(testFiles) && !args.tsxReexec) {
    const forwardArgs = process.argv.slice(2).filter((a) => a !== '--__tsx-reexec');
    reExecWithTsx(forwardArgs);
    return;
  }

  // An x64 Node under Rosetta (PILOT-559) runs, translated, but should not
  // pass unremarked. After the tsx re-exec, so it prints once.
  const rosettaWarning = rosettaNodeWarning();
  if (rosettaWarning) console.error(yellow(`⚠ ${rosettaWarning}`));

  // After the tsx re-exec, so each prints once.
  for (const arg of unmatchedFileArgs) {
    console.error(yellow(`Warning: "${arg}" matched no test file — running the files the other arguments selected.`));
  }
  for (const arg of regexReadFileArgs) {
    // A glob that globbed nothing can select far more as a regex (`tests/*`).
    console.error(yellow(`Note: "${arg}" matched no file as a glob, so it was read as a regular expression over the test file paths.`));
  }
  for (const file of filesOutsideProjects) {
    console.error(yellow(`Warning: ${relativeTestPath(file, config.rootDir)} is not matched by any${selectedProjects ? ' selected' : ''} project's testMatch, so it does not run.`));
  }

  // A selection filter (grep / grep-invert, at root or any project) is active.
  const selectionFilterActive =
    config.grep !== undefined || config.grepInvert !== undefined ||
    (hasProjects && projects.some((p) => p.grep !== undefined || p.grepInvert !== undefined));

  // Every file the run imports is loaded first, in a child process, so a
  // grep that selects no test (PILOT-553) and a file that fails to load
  // (PILOT-784) fail before the daemon and the device: a syntax error must
  // not cost an emulator boot to find out, as in Playwright, which loads
  // every file before launching a browser. A child, so no test file's
  // top-level code runs in this process before the run imports it. Not in UI
  // mode, which shows the tree (load failures included) to pick from, nor in
  // watch mode, which waits for the edit that fixes the file, or adds the
  // test a pattern is waiting for.
  let preflight: Map<string, import('./selection-preflight.js').FilePreflight | undefined> | undefined;
  if (!args.ui && !args.watch) {
    const { preflightTestFiles } = await import('./selection-preflight.js');
    // A grep is answered from the whole suite, so every shard answers it the
    // same way; load failures are reported for this shard's files.
    preflight = await preflightTestFiles([...new Set([
      ...(selectionFilterActive ? unshardedFiles.flatMap(({ files }) => files) : []),
      ...testFiles,
    ])]);
  }

  // A grep that selects no test fails here, before the reporters too.
  if (selectionFilterActive && preflight) {
    const found = preflight;
    const { findSelectionMiss, grepFiltersFor, noTestsMatchFilterMessage } = await import('./test-filter.js');
    const miss = findSelectionMiss(
      unshardedFiles.flatMap(({ project, files }) => {
        const filters = grepFiltersFor(config, project);
        return files.map((file) => ({ file, filters }));
      }),
      (file) => {
        const result = found.get(file);
        return result && 'names' in result ? result.names : undefined;
      },
    );
    if (miss) {
      console.error(red(noTestsMatchFilterMessage(
        miss,
        config.grep,
        config.grepInvert,
        hasProjects && projects.some((p) => p.grep !== undefined || p.grepInvert !== undefined),
      )));
      process.exit(1);
    }
  }

  // Retry-only video/trace modes start no recorder on attempt 0, so with
  // `retries: 0` they can never produce an artifact. Warn at run start —
  // one line per misconfigured project and artifact — rather than letting
  // the run silently record nothing (PILOT-240; same caveat Playwright
  // documents for its `on-first-retry` video mode). Placed after the tsx
  // re-exec so each warning prints exactly once.
  for (const project of projects) {
    const cfg = project.effectiveConfig;
    if (cfg.retries > 0) continue;
    const scope = projects.length > 1 ? ` in project "${project.name}"` : '';
    for (const [artifact, mode] of [
      ['video', resolveVideoConfig(cfg.video).mode],
      ['trace', resolveTraceConfig(cfg.trace).mode],
    ] as const) {
      if (recordsOnlyOnRetry(mode)) {
        console.error(yellow(
          `Warning: ${artifact} mode '${mode}' only records retry attempts, but retries is 0${scope} — no ${artifact} will ever be recorded. Set retries to 1 or more to get ${artifact}s.`,
        ));
      }
    }
  }

  // Initialize reporters
  const reporters = await createReporters(config.reporter);
  // Auto-add GitHub Actions reporter when running in GitHub Actions
  if (process.env.GITHUB_ACTIONS) {
    const hasGithub = reporters.some((r) => r.constructor.name === 'GitHubActionsReporter');
    if (!hasGithub) {
      const { GitHubActionsReporter } = await import('./reporters/github.js');
      reporters.push(new GitHubActionsReporter());
    }
  }
  // Auto-add blob reporter when sharding (for merge-reports)
  if (config.shard) {
    const hasBlob = reporters.some((r) => r.constructor.name === 'BlobReporter');
    if (!hasBlob) {
      const { BlobReporter } = await import('./reporters/blob.js');
      reporters.push(new BlobReporter());
    }
  }
  const reporter = new ReporterDispatcher(reporters);

  // A file that failed to load: report it, as the run would have, to every
  // reporter, and run nothing (PILOT-784).
  const loadFailures = preflight ? await preflightLoadFailures(projects, preflight) : [];
  if (loadFailures.length > 0) {
    const fileCount = new Set(loadFailures.map((r) => r.filePath)).size;
    reporter.onRunStart(config, fileCount);
    for (const result of loadFailures) {
      reporter.onTestFileStart(result.filePath!);
      reporter.onTestEnd(result);
      reporter.onTestFileEnd(result.filePath!, [result]);
    }
    await reporter.onRunEnd({
      status: 'failed',
      duration: 0,
      tests: loadFailures,
      suites: loadFailures.map((result) => ({ name: '', tests: [result], suites: [], durationMs: 0 })),
    });
    console.error(red(`No tests ran: ${fileCount} test file${fileCount === 1 ? '' : 's'} failed to load.`));
    process.exit(1);
  }

  // Compute the effective parallelism BEFORE handing config to the reporter,
  // so reporters can correctly suppress file headings / show project tags
  // when buckets or per-project `workers:` push the actual concurrency above
  // the global `config.workers` value.
  const { allocateBucketWorkers, bucketizeProjects, pinnedBucketSignatures, sharedDeviceGroup, targetSessionConfig, workerPlanNote, platformOfSerial, scopeDevicePinToPlatform, devicePinWorkersConflict, devicesPinnedByManyBuckets } = await import('./project.js');
  // A root `device` (from `--device` or the config) reached every project,
  // the other platform's too, whose bucket then counted as pinned to a serial
  // it cannot drive. Keep it on the projects of the device's own platform.
  if (config.device && new Set(projects.map((p) => p.effectiveConfig.platform ?? 'android')).size > 1) {
    scopeDevicePinToPlatform(projects, config.device, platformOfSerial(config.device));
  }
  const budgetCap = isExplicitWorkers(config) ? config.workers : undefined;
  const runBuckets = bucketizeProjects(projects);
  // Before any device setup: the sequential setup writes the device it
  // auto-picks onto the effective config, which would read as a pin later.
  const pinnedSignatures = pinnedBucketSignatures(runBuckets);
  // The root's own `device` (the user's pin, or none) as it is before any
  // setup writes an auto-picked serial onto it — see the project switch.
  const rootDeviceBeforeSetup = config.device;
  const allocation = allocateBucketWorkers(config.workers, runBuckets, budgetCap, pinnedSignatures);
  // The group a device target's sessions form: the largest `use.devices`
  // among the projects sharing that signature. A single-device project on a
  // target that also hosts a group project runs on the group's primary.
  const bucketGroup = (signature: string): DeviceGroupEntry[] =>
    sharedDeviceGroup(projects.filter((p) => p.deviceSignature === signature)).group;
  // The one-worker cap is per device, not per bucket: projects for two apps
  // inheriting one `--device` are two buckets, and each got a worker on it.
  // The sequential path runs them one after another on the device; UI and
  // watch keep a worker per target alive, so they cannot share one.
  const sharedPins = devicesPinnedByManyBuckets(runBuckets, pinnedSignatures);
  const describeSharedPins = sharedPins.map((p) => `${p.serial} (${p.projects.join(', ')})`).join('; ');
  if (sharedPins.length > 0 && (args.ui || args.watch)) {
    console.error(red(
      `${args.ui ? 'UI mode' : 'Watch mode'} runs each device target on a worker of its own, but these devices are pinned by `
      + `more than one: ${describeSharedPins}. Pass --project to run one of them, or pin each project to its own device.`,
    ));
    process.exit(1);
  }
  const totalWorkers = sharedPins.length > 0 ? 1 : [...allocation.values()].reduce((s, n) => s + n, 0);
  const maxFilesInAnyWave = Math.max(...projectWaves.map((wave) =>
    wave.reduce((sum, p) => sum + p.testFiles.length, 0),
  ));
  // A pinned device hosts one worker, so `--device` with a `--workers N` the
  // pin leaves unusable asks for two different runs. Both are explicit on this
  // command line: refuse rather than pick one — silently dropping either used
  // to run on devices the user never named (PILOT-261, PILOT-313). A `workers`
  // from the config file is a default, and the pin caps it with a note.
  const pinConflict = devicePinWorkersConflict(args.device, args.workers, totalWorkers, maxFilesInAnyWave);
  if (pinConflict) {
    console.error(red(pinConflict));
    process.exit(1);
  }
  const effectiveWorkers = Math.min(totalWorkers, maxFilesInAnyWave);

  // Warn only when the irreducible minimum (one worker per active bucket)
  // exceeds the user's explicit --workers value. Per-project `workers:`
  // inflation is now capped by the budget, so this only fires when there
  // are genuinely more device buckets than workers.
  // A pin capping the count is explained too, or a `workers: 4` config run
  // with `--device` looks like parallelism silently stopped working.
  // The shared-pin note only when it changed something: a one-worker run
  // already runs its projects one after another.
  const workerPlanWarning = sharedPins.length > 0
    ? (config.workers > 1
      ? `running one worker: ${describeSharedPins} — a device pinned by several projects runs them one after another`
      : undefined)
    : workerPlanNote({
    requested: config.workers,
    explicit: isExplicitWorkers(config),
    fromCli: args.workers !== undefined,
    running: totalWorkers,
    activeBuckets: [...allocation.values()].filter((n) => n > 0).length,
    pins: [...new Set(runBuckets
      .filter((b) => (allocation.get(b.signature) ?? 0) > 0)
      .flatMap((b) => pinnedSignatures.get(b.signature)?.pins ?? []))],
  });

  // Reflect the effective parallelism on the config so reporters see the
  // real worker count. Downstream dispatcher paths pass `workers` explicitly,
  // so this mutation is safe.
  config.workers = totalWorkers;

  // Pick the first project's effective config as the initial setup target.
  // For single-bucket runs this is identical to the root config.
  const initialProject = projects.find((p) => p.testFiles.length > 0) ?? projects[0];
  const initialEffectiveConfig = initialProject.effectiveConfig;
  const shouldShowLaunchProgress = args.ui || !args.watch;
  // Empty blob output directories here: after every argument refusal (a
  // refused run must not cost the previous blob) and before any device
  // launch (a run that dies launching must not leave the previous blob
  // posing as its own). UI mode reports through its own server, never these
  // reporters, so it must not empty a directory it will not rewrite.
  if (!args.ui) {
    const { prepareBlobOutputDirs } = await import('./merge-reports.js');
    const refusal = prepareBlobOutputDirs(reporters, config);
    if (refusal) {
      console.error(red(refusal));
      process.exit(1);
    }
  }
  printTapsmithBanner();
  // After the tsx re-exec, so it prints exactly once, and before any worker
  // is forked, so no child ever races it (PILOT-330).
  telemetry.printNoticeIfFirstRun(config);
  // Persist the anonymous id here too, before forking workers, so a fresh
  // machine's first parallel run shares one id instead of each worker minting
  // its own (PILOT-330 review).
  telemetry.ensureIdentity(config);
  if (shardMessage) console.log(dim(shardMessage));
  const launchProgress = shouldShowLaunchProgress
    ? new UiLaunchProgress(createUiLaunchSteps({
      config: initialEffectiveConfig,
      deviceGroupSize: bucketGroup(initialProject.deviceSignature).length,
      testFileCount: testFiles.length,
      workerCount: args.ui ? totalWorkers : effectiveWorkers,
      mode: args.ui ? 'ui' : 'test',
      projects: hasProjects ? projects : undefined,
      workerPlanWarning,
    }), {
      title: args.ui ? 'UI mode' : '',
    })
    : undefined;
  activeLaunchProgress = launchProgress;
  if (!launchProgress && workerPlanWarning) {
    process.stderr.write(`Note: ${workerPlanWarning}.\n`);
  }

  if (args.watch) {
    console.log(`\nStarting watch mode for ${testFiles.length} test file(s)...\n`);
  }

  // When a selection filter selects zero runnable tests — none reported, or
  // only skipped ones — that's a usage error (typically a typo'd
  // pattern), not a green run. The exit paths below fail loud rather than
  // reporting success.
  const zeroMatchFilterMessage =
    'No tests ran: every selected test was filtered out. Check your --grep / --grep-invert pattern (it matches against the full "describe > test" name).';

  // ─── Parallel mode ───
  // UI and watch modes handle their own execution — skip the dispatcher path.
  // Fall back to sequential when parallelism wouldn't help — either there's
  // only one test file, or all files are in sequential waves (e.g. setup → dependent).
  if (!args.ui && !args.watch) {

    if (effectiveWorkers > 1) {
      // The dispatcher manages its own daemons — one per worker — each with
      // exclusive ADB access to its assigned device. No discovery daemon needed.
      const { runParallel } = await import('./dispatcher.js');
      let fullResult: Awaited<ReturnType<typeof runParallel>>;
      try {
        fullResult = await runParallel({
          // One device target: its workers run under the target's config, not
          // the root, which may lack the device keys its projects' `use` holds
          // (PILOT-654). A multi-target run gives each bucket its own.
          config: runBuckets.length === 1 ? targetSessionConfig(initialEffectiveConfig, config) : config,
          reporter,
          testFiles,
          workers: totalWorkers,
          forceInstall: args.forceInstall,
          workerCap: budgetCap,
          projects: hasProjects ? projects : undefined,
          projectWaves: hasProjects ? projectWaves : undefined,
          launchProgress,
        });
      } catch (err) {
        // A run that fails to start after booting emulators still leaves them
        // running: name them before the error ends the process.
        preserveEmulatorsForReuse(emulatorsLaunchedThisProcess());
        throw err;
      }

      await reporter.onRunEnd(fullResult);
      preserveEmulatorsForReuse(emulatorsLaunchedThisProcess());
      const zeroMatch = filterRanNothing(!!selectionFilterActive, fullResult.tests);
      if (zeroMatch) console.error(red(zeroMatchFilterMessage));
      process.exit((fullResult.status === 'failed' || zeroMatch) ? 1 : 0);
    }
  }

  // ─── Sequential mode (workers: 1, default) ───
  let launchedEmulators: LaunchedEmulator[] = [];
  let client: TapsmithGrpcClient | undefined;
  let device: Device | undefined;
  let disposeActionProgressPrinter: (() => void) | undefined;
  let currentSequentialState: SequentialDeviceState | undefined;
  let sequentialExitCode = 1;
  let sequentialErrorEscaping = false;
  const sequentialStart = Date.now();

  // Route a crash through teardown so we don't orphan the daemon + its
  // xcodebuild runner (PILOT-230). Mutually exclusive with the parallel
  // dispatcher path, so it won't double-install with runParallel's handlers.
  installSequentialFatalHandlers(
    config,
    () => currentSequentialState?.deviceSerial,
    () => currentSequentialState?.sessions.slice(1) ?? [],
  );

  // Detect heterogeneous device-targeting projects. When projects share a
  // single signature, sequential mode runs unchanged. When they differ,
  // we tear down + re-provision between projects.
  const uniqueSignatures = new Set(projects.map((p) => p.deviceSignature));
  const isMultiBucketSequential = uniqueSignatures.size > 1;
  // Hint about --workers only when:
  //   - plain `tapsmith test` (UI/watch already provision per bucket)
  //   - the user did not pass --workers explicitly
  //   - config.workers is 1 (so we'd otherwise tear down + re-provision between buckets)
  //   - NO project has an explicit `workers:` value (otherwise parallelism is already happening)
  const anyExplicitWorkers = projects.some((p) => typeof p.workers === 'number' && p.workers > 0);
  if (
    isMultiBucketSequential
    && config.workers === 1
    && args.workers === undefined
    && !args.ui
    && !args.watch
    && !anyExplicitWorkers
    // A device pinned by several targets runs them one after another whatever
    // --workers says, so the tip would be advice that cannot help.
    && sharedPins.length === 0
  ) {
    process.stderr.write(
      dim(`Multiple device targets detected (${uniqueSignatures.size}). Tip: pass --workers ${uniqueSignatures.size} to run them in parallel.\n`),
    );
  }

  // A multi-target run goes on without a target that cannot start: its
  // files are reported failed and the other targets run (PILOT-400). UI and
  // watch set their primary device up on the next target instead (PILOT-415).
  // Targets with files to run: a target whose projects were all filtered
  // down to no files is not a target this run needs (a single effective
  // target keeps the single-target behaviour).
  const targetsWithFiles = new Set(projects.filter((p) => p.testFiles.length > 0).map((p) => p.deviceSignature));
  const toleratesTargetFailure = targetsWithFiles.size > 1;
  /** Device targets (by signature) that could not start, with the error. */
  const failedTargets = new Map<string, unknown>();
  const { deviceTargetLabel, isProgrammingError, noTargetCouldStart, targetStartWarning } = await import('./dispatcher.js');
  const warnTargetFailed = (signature: string) => {
    const fileCount = projects
      .filter((p) => p.deviceSignature === signature)
      .reduce((n, p) => n + p.testFiles.length, 0);
    process.stderr.write(yellow(`${targetStartWarning(deviceTargetLabel(signature), fileCount, !!(args.ui || args.watch))}\n`));
  };
  /** `announce: false` when the caller only knows later whether the others run. */
  const noteFailedTarget = (signature: string, err: unknown, announce = true) => {
    failedTargets.set(signature, err);
    // A TypeError and the like is a Tapsmith bug, not a missing device:
    // keep its stack, as the parallel path does.
    if (isProgrammingError(err) && err.stack) process.stderr.write(dim(`${err.stack}\n`));
    // The failed setup may have spawned this target's daemon. Nothing will
    // use it, and the next target's setup would overwrite the handle the
    // final teardown kills, orphaning it.
    stopSpawnedDaemon();
    if (announce) warnTargetFailed(signature);
  };

  // Plain `tapsmith test` reports a failed first target and switches to the
  // next between projects. UI and watch need a primary device to start on,
  // so they try each target in turn (PILOT-415).
  const { firstProjectPerTarget, UnavailableTargets } = await import('./unavailable-targets.js');
  const primaryCandidates = args.ui || args.watch
    ? [initialProject, ...firstProjectPerTarget(projects).filter((p) => p.deviceSignature !== initialProject.deviceSignature)]
    : [initialProject];

  try {
    for (const candidate of primaryCandidates) {
      // The setup writes the device it picks onto the config before steps
      // that can still fail; a failed target must not stay pinned to it.
      const { device: deviceBefore, daemonAddress: daemonAddressBefore } = candidate.effectiveConfig;
      try {
        currentSequentialState = await setupSequentialDevice(
          candidate.effectiveConfig,
          args.forceInstall,
          candidate.deviceSignature,
          launchProgress,
          bucketGroup(candidate.deviceSignature),
        );
        break;
      } catch (err) {
        // The setup marks the step that actually failed (primary, install,
        // agent, launch, device group); this only catches a failure that
        // happened before any step was reached. Re-labelling the primary here
        // used to print "✗ Primary device" for a group member that failed.
        const message = err instanceof Error ? err.message : String(err);
        if (!launchProgress?.hasFailure()) launchProgress?.fail('primary-device', message.split('\n')[0]);
        // Only what the ✗ row above does not already say (PILOT-569) — when
        // the run ends here. Another target's setup would redraw the rows,
        // taking this target's reason with them.
        const rowsAreFinal = !toleratesTargetFailure && launchRowsShareStderr();
        const unshown = launchProgress && rowsAreFinal ? unshownPart(message, launchProgress.shownFailures()) : message;
        if (unshown) console.error(red(unshown));
        if (!toleratesTargetFailure) {
          sequentialExitCode = 1;
          return;
        }
        // A Tapsmith bug is not a device that cannot start: surface it now,
        // not after setting up the next target.
        if ((args.ui || args.watch) && isProgrammingError(err)) throw err;
        const failedDaemon = spawnedDaemonProcess;
        // Whether the others still run is known only once one starts.
        noteFailedTarget(candidate.deviceSignature, err, !(args.ui || args.watch));
        // Let the failed target's daemon go before the next setup probes its
        // port: one still answering reads as another live session there, and
        // that skips the stale adb-forward sweep.
        if (failedDaemon && failedDaemon.exitCode === null && failedDaemon.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3_000);
            failedDaemon.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
        // The failed setup may have pinned the config to the device it picked
        // — the root config, for a `use`-less project — so neither the next
        // target nor a later retry of this one inherits it.
        candidate.effectiveConfig.device = deviceBefore;
        // And its daemon address, which may name the daemon just stopped.
        candidate.effectiveConfig.daemonAddress = daemonAddressBefore;
      }
    }
    if (args.ui || args.watch) {
      if (!currentSequentialState) {
        throw noTargetCouldStart([...failedTargets].map(([signature, err]) => ({ label: deviceTargetLabel(signature), err })));
      }
      for (const signature of failedTargets.keys()) warnTargetFailed(signature);
    }

    if (currentSequentialState) {
      client = currentSequentialState.client;
      device = currentSequentialState.device;
      launchedEmulators = currentSequentialState.launchedEmulators;
      // Mirror the chosen device serial onto the root config so any code path
      // still reading from `config.device` (UI/watch handoff) sees it.
      config.device = currentSequentialState.deviceSerial;
    }

    // ─── UI mode ───
    // If --ui is set, start the interactive UI server. It keeps the
    // daemon, emulator, and agent alive and serves a Preact SPA.
    // When workers > 1, the UI server manages its own daemons and workers.
    if (args.ui) {
      // UI and watch throw above when no target can start, so they always have one.
      if (!currentSequentialState || !client || !device) throw new Error('internal: UI mode without a started device');
      const { startUIServer } = await import('./ui-mode/ui-server.js');

      const uiScreenshotDir =
        config.screenshot !== 'never'
          ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
          : undefined;

      let uiWorkerGroups: string[][] | undefined;
      let uiConfigByDevice: Map<string, import('./worker-protocol.js').SerializedConfig> | undefined;
      let uiDeviceGroupByDevice: Map<string, DeviceGroupEntry[]> | undefined;
      let uiBucketByDevice: Map<string, string> | undefined;
      let uiBucketByProject: Map<string, string> | undefined;
      let uiWorkersOverride: number | undefined;
      let uiUnavailableTargets = new UnavailableTargets(undefined);

      if (isMultiBucketSequential) {
        // Multi-device-target projects: provision per-bucket devices.
        const perBucket = await provisionPerProjectDevices(config, projects, budgetCap, pinnedSignatures, failedTargets, rootDeviceBeforeSetup, launchProgress);
        uiUnavailableTargets = perBucket.unavailableTargets;
        uiWorkerGroups = perBucket.workerGroups;
        uiConfigByDevice = perBucket.configByDevice;
        uiDeviceGroupByDevice = perBucket.deviceGroupByDevice;
        uiBucketByDevice = perBucket.bucketByDevice;
        uiBucketByProject = perBucket.bucketByProject;
        uiWorkersOverride = perBucket.workerGroups.length;
        launchedEmulators = [...launchedEmulators, ...perBucket.launched];
      } else {
        const uiProvision = await provisionWorkerGroups(currentSequentialState, 'UI mode', {
          quiet: !args.tsxReexec,
          progress: launchProgress,
        });
        uiWorkerGroups = uiProvision.workerGroups;
        launchedEmulators = [...launchedEmulators, ...uiProvision.launched];
        if (uiWorkerGroups) uiWorkersOverride = uiWorkerGroups.length;
      }
      // Every UI session runs through persistent workers. With one device the
      // single worker adopts the primary daemon/agent set up above (and the
      // group members opened beside it), so the server always gets a group
      // list to build workers from.
      if (!uiWorkerGroups || uiWorkerGroups.length === 0) {
        if (!config.device) {
          throw new Error(
            'UI mode: no device selected after setup — the primary device setup should have set config.device. ' +
              'Re-run with a --device/serial, or report this as a bug.',
          );
        }
        uiWorkerGroups = [currentSequentialState.sessions.map((s) => s.serial)];
        uiWorkersOverride = 1;
      }

      const uiServer = await startUIServer({
        config,
        // The primary target's config, which carries the device keys a config
        // may keep only in its projects' `use` (PILOT-654).
        targetConfig: targetSessionConfig(currentSequentialState.effectiveConfig, config),
        configPath,
        device,
        client,
        deviceSerial: config.device!,
        // The primary setup may have moved the daemon to a free port; that
        // landed on the project's effective config (a copy when any project
        // declares `use`), not on `config`.
        daemonAddress: currentSequentialState?.effectiveConfig.daemonAddress ?? config.daemonAddress,
        testFiles,
        screenshotDir: uiScreenshotDir,
        launchedEmulators,
        forceInstall: args.forceInstall,
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
        workers: uiWorkersOverride,
        workerGroups: uiWorkerGroups,
        // `use.devices` lives on the project; `config` is the root and never
        // declares it.
        deviceGroup: currentSequentialState.deviceGroup,
        primaryGroupMembers: currentSequentialState.sessions.slice(1).map((s) => ({
          name: s.name, serial: s.serial, daemonAddress: s.daemonAddress,
        })),
        configByDevice: uiConfigByDevice,
        deviceGroupByDevice: uiDeviceGroupByDevice,
        bucketByDevice: uiBucketByDevice,
        bucketByProject: uiBucketByProject,
        unavailableTargets: uiUnavailableTargets,
      }, {
        port: args.uiPort,
        devUrl: args.uiDevUrl ?? process.env.TAPSMITH_UI_DEV_URL,
        launchProgress,
      });

      // Keep alive until user exits
      const cleanupAndExit = () => {
        uiServer.close();
        // The group members the sequential setup opened beside the primary run
        // on daemons this process spawned; the server only releases its own.
        for (const member of currentSequentialState?.sessions.slice(1) ?? []) closeDeviceSession(member);
        if (spawnedDaemonProcess) {
          try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
        }
        process.exit(0);
      };
      process.on('SIGINT', cleanupAndExit);
      process.on('SIGTERM', cleanupAndExit);
      await new Promise<void>(() => { /* never resolves */ });
    }

    // ─── Watch mode ───
    // If --watch is set, hand off to the watch coordinator. It keeps the
    // daemon, emulator, and agent alive and re-runs tests on file changes.
    // The watch coordinator handles its own cleanup and never returns.
    if (args.watch) {
      if (!currentSequentialState || !client || !device) throw new Error('internal: watch mode without a started device');
      const { runWatchMode } = await import('./watch.js');

      const watchScreenshotDir =
        config.screenshot !== 'never'
          ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
          : undefined;

      let watchWorkerGroups: string[][] | undefined;
      let watchConfigByDevice: Map<string, import('./worker-protocol.js').SerializedConfig> | undefined;
      let watchDeviceGroupByDevice: Map<string, DeviceGroupEntry[]> | undefined;
      let watchBucketByDevice: Map<string, string> | undefined;
      let watchBucketByProject: Map<string, string> | undefined;
      let watchWorkersOverride: number | undefined;
      let watchUnavailableTargets = new UnavailableTargets(undefined);

      if (isMultiBucketSequential) {
        const perBucket = await provisionPerProjectDevices(config, projects, budgetCap, pinnedSignatures, failedTargets, rootDeviceBeforeSetup);
        watchUnavailableTargets = perBucket.unavailableTargets;
        watchWorkerGroups = perBucket.workerGroups;
        watchConfigByDevice = perBucket.configByDevice;
        watchDeviceGroupByDevice = perBucket.deviceGroupByDevice;
        watchBucketByDevice = perBucket.bucketByDevice;
        watchBucketByProject = perBucket.bucketByProject;
        watchWorkersOverride = perBucket.workerGroups.length;
        launchedEmulators = [...launchedEmulators, ...perBucket.launched];
      } else {
        const watchProvision = await provisionWorkerGroups(currentSequentialState, 'Watch mode', { quiet: !args.tsxReexec });
        watchWorkerGroups = watchProvision.workerGroups;
        launchedEmulators = [...launchedEmulators, ...watchProvision.launched];
        if (watchWorkerGroups) watchWorkersOverride = watchWorkerGroups.length;
      }

      await runWatchMode({
        config,
        // As UI mode: the primary target's config, not the root (PILOT-654).
        targetConfig: targetSessionConfig(currentSequentialState.effectiveConfig, config),
        device,
        client,
        deviceSerial: config.device!,
        // The primary setup may have moved the daemon to a free port; that
        // landed on the project's effective config (a copy when any project
        // declares `use`), not on `config`.
        daemonAddress: currentSequentialState?.effectiveConfig.daemonAddress ?? config.daemonAddress,
        testFiles,
        screenshotDir: watchScreenshotDir,
        launchedEmulators,
        forceInstall: args.forceInstall,
        // The startup launch already probed for in-app hooks into this shared
        // object; watch-run children seed from it and report back, so warm
        // per-policy resets survive the fresh-child-per-run boundary.
        resetCapabilities: currentSequentialState?.capabilities ?? {},
        // The CLI keeps the group members' daemons alive across re-runs; each
        // child attaches to them the way it attaches to the primary's.
        groupMembers: currentSequentialState.sessions.slice(1).map((s) => ({
          name: s.name, deviceSerial: s.serial, daemonAddress: s.daemonAddress, resetCapabilities: s.capabilities,
          close: () => closeDeviceSession(s),
        })),
        deviceGroup: currentSequentialState.deviceGroup,
        closePrimaryDaemon: () => {
          if (spawnedDaemonProcess) {
            try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
          }
        },
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
        workers: watchWorkersOverride,
        workerGroups: watchWorkerGroups,
        configByDevice: watchConfigByDevice,
        deviceGroupByDevice: watchDeviceGroupByDevice,
        bucketByDevice: watchBucketByDevice,
        bucketByProject: watchBucketByProject,
        unavailableTargets: watchUnavailableTargets,
      });
      // runWatchMode never returns — exits via cleanup()
    }

    if (!args.ui && !args.watch) {
      launchProgress?.finish();
      reporter.onRunStart(config, testFiles.length);
      // Print live progress lines for slow device actions (app-state
      // save/restore, between-file resets, …) so long silent stretches are
      // visibly forward motion rather than a hang (PILOT-232). Installed
      // after launchProgress.finish() — startup has its own progress UI.
      disposeActionProgressPrinter = installActionProgressPrinter();
    }

    // Run tests
    const allResults: TestResult[] = [];
    const allSuites: SuiteResult[] = [];
    const setupDuration = Date.now() - sequentialStart;

    const screenshotDir =
      config.screenshot !== 'never'
        ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
        : undefined;

    const failedProjects = new Set<string>();
    /** Report a project on a target that could not start: each file failed. */
    const reportTargetStartFailure = async (project: import('./project.js').ResolvedProject, err: unknown) => {
      const { deviceTargetLabel, startFailureSuite, targetStartFailureResults } = await import('./dispatcher.js');
      for (const result of targetStartFailureResults(deviceTargetLabel(project.deviceSignature), [project], err)) {
        reporter.onTestFileStart(result.filePath!);
        reporter.onTestEnd(result);
        allResults.push(result);
        allSuites.push(startFailureSuite(result));
        reporter.onTestFileEnd(result.filePath!, [result]);
      }
      failedProjects.add(project.name);
    };
    const projectsWithFiles = projects.filter((p) => p.testFiles.length > 0);
    const showProjectHeaders = projectsWithFiles.length > 1;

    for (const wave of projectWaves) {
      for (const project of wave) {
        // A target that could not start: its files fail with the reason —
        // before the dependency check, so a dependent on the same target
        // fails too, as in the parallel path, rather than being skipped.
        if (project.testFiles.length > 0 && failedTargets.has(project.deviceSignature)) {
          await reportTargetStartFailure(project, failedTargets.get(project.deviceSignature));
          continue;
        }

        // Skip projects whose dependencies failed
        const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
        if (blockedBy) {
          console.log(dim(`Skipping project "${project.name}" — dependency "${blockedBy}" failed`));
          // Mark all tests in this project as skipped
          for (const file of project.testFiles) {
            reporter.onTestFileStart(file);
            const skippedResult: TestResult = {
              name: path.basename(file),
              fullName: path.basename(file),
              status: 'skipped',
              durationMs: 0,
              project: project.name,
            };
            allResults.push(skippedResult);
            reporter.onTestFileEnd(file, [skippedResult]);
          }
          failedProjects.add(project.name);
          continue;
        }

        let projectFailed = false;

        // ─── Per-project device switching ───
        // When this project's device signature differs from the currently
        // bound device (or none is, the first target having failed to
        // start), tear down the previous state and provision the new device
        // before running its files.
        if (project.testFiles.length > 0
          && currentSequentialState?.signature !== project.deviceSignature) {
          process.stdout.write(
            dim(`\nSwitching device for project "${project.name}" (target: ${project.deviceSignature.split('|').slice(0, 2).join(' ')})\n`),
          );
          if (currentSequentialState) teardownSequentialDevice(currentSequentialState);
          currentSequentialState = undefined;
          client = undefined;
          device = undefined;
          // Reset emulator tracking — the new state owns its own list
          launchedEmulators = [];
          // A `use`-less project's config *is* the root config, which now holds
          // the previous target's device (mirrored after the first setup for
          // the UI/watch handoff, which never reaches this loop). Put the
          // root's own device back, or this project is set up pinned to the
          // other target's serial — another platform's, even — and a scoped
          // `--device` for this platform is lost.
          if (project.effectiveConfig === config) config.device = rootDeviceBeforeSetup;
          try {
            currentSequentialState = await setupSequentialDevice(
              project.effectiveConfig,
              args.forceInstall,
              project.deviceSignature,
              undefined,
              bucketGroup(project.deviceSignature),
            );
          } catch (err) {
            console.error(red(`Failed to set up device for project "${project.name}": ${err instanceof Error ? err.message : String(err)}`));
            // Only a multi-target run switches devices, so the run goes on
            // without this target (PILOT-400): its projects fail here, and
            // any later ones on it through failedTargets above.
            noteFailedTarget(project.deviceSignature, err);
            await reportTargetStartFailure(project, err);
            continue;
          }
          client = currentSequentialState.client;
          device = currentSequentialState.device;
          launchedEmulators = currentSequentialState.launchedEmulators;
        }

        if (showProjectHeaders && project.testFiles.length > 0) {
          process.stdout.write(`\n${dim(`  ── Project: ${project.name} ──`)}\n`);
        }

        // Effective config for this project — only differs from root config
        // when projects override device-shaping fields via `use:`.
        const projectConfig = currentSequentialState?.effectiveConfig ?? config;

        for (const file of project.testFiles) {
          // The between-file app reset is the runner's job (declared policy,
          // recorded in the trace as fixture setup). The first file after a
          // device launch inherits what that launch actually did as its
          // prepared state — never a hand-built claim. Each session's
          // prepared state is consumed exactly once, by the first file.
          reporter.onTestFileStart(file);

          const projectGrepRe = normalizeGrep(project.grep);
          const projectGrepInvertRe = normalizeGrep(project.grepInvert);
          const suiteResult = await runTestFileWithRecovery(file, {
            // The run's `devices` is this project's own group (`use.devices`,
            // else the root's): the state's config carries whichever project
            // set the device up, and its group may be larger than this one's.
            config: { ...projectConfig, devices: project.effectiveConfig.devices },
            // The state holds the target's largest group; this project runs
            // on the first N of it (the runner checks the count).
            sessions: sessionsForRun(currentSequentialState!.sessions, project.effectiveConfig),
            screenshotDir,
            reporter,
            projectUseOptions: project.use,
            projectName: projectLabel(project),
            projectGrep: projectGrepRe.length > 0 ? projectGrepRe : undefined,
            projectGrepInvert: projectGrepInvertRe.length > 0 ? projectGrepInvertRe : undefined,
          });

          const fileResults = collectResults(suiteResult);
          allResults.push(...fileResults);
          allSuites.push(suiteResult);

          reporter.onTestFileEnd(file, fileResults);

          if (fileResults.some((r) => r.status === 'failed')) {
            projectFailed = true;
          }
        }

        if (projectFailed) {
          failedProjects.add(project.name);
        }
      }
    }

    const totalDurationMs = Date.now() - sequentialStart;
    const hasFailed = allResults.some((r) => r.status === 'failed');
    const fullResult: FullResult = {
      status: hasFailed ? 'failed' : 'passed',
      duration: totalDurationMs,
      setupDuration,
      tests: allResults,
      suites: allSuites,
    };
    await reporter.onRunEnd(fullResult);
    const zeroMatch = filterRanNothing(!!selectionFilterActive, allResults);
    if (zeroMatch) console.error(red(zeroMatchFilterMessage));
    sequentialExitCode = (hasFailed || zeroMatch) ? 1 : 0;
  } catch (err) {
    // Let main().catch own the exit for escaping errors. Its handler needs
    // async work (dynamic imports) before printing, so the exit timer in
    // the finally block below would kill the process before any error
    // message appears (PILOT-253).
    sequentialErrorEscaping = true;
    throw err;
  } finally {
    disposeActionProgressPrinter?.();
    for (const member of currentSequentialState?.sessions.slice(1) ?? []) closeDeviceSession(member);
    device?.close();
    client?.close();
    if (spawnedDaemonProcess) {
      try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    }
    // Leave emulators running for reuse by the next run, naming every one this
    // run launched — including a target whose setup failed after the boot.
    preserveEmulatorsForReuse(emulatorsLaunchedThisProcess());
    // Defer process.exit so any pending error handlers (unhandledRejection
    // etc.) in the current microtask queue run first — process.exit() in a
    // finally block swallows them. Skipped when an error is escaping:
    // main().catch prints it and exits with code 1 itself.
    if (!sequentialErrorEscaping) {
      // The last file's telemetry event is still in flight here; give it a
      // bounded moment rather than systematically dropping it (PILOT-330).
      setTimeout(() => {
        void telemetry.flush().finally(() => process.exit(sequentialExitCode));
      }, 0);
    }
  }
}

// ─── Infrastructure error recovery for single-worker mode ───

/**
 * Run a test file with automatic retry on infrastructure errors (agent
 * disconnection, gRPC unavailability, etc.). Mirrors the recovery logic
 * in worker-runner.ts for multi-worker mode.
 */
async function runTestFileWithRecovery(
  file: string,
  opts: {
    config: TapsmithConfig
    /** The device group, primary first. */
    sessions: DeviceSession[]
    screenshotDir: string | undefined
    reporter: ReporterDispatcher
    projectUseOptions?: Record<string, unknown>
    projectName?: string
    projectGrep?: RegExp[]
    projectGrepInvert?: RegExp[]
  },
): Promise<SuiteResult> {
  const grep = normalizeGrep(opts.config.grep);
  const grepInvert = normalizeGrep(opts.config.grepInvert);
  const { sessions } = opts;
  let firstAttemptSuite: SuiteResult | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const suite = await runTestFile(file, {
        config: opts.config,
        // Each session's prepared state (the startup launch on the first
        // file, a recovery relaunch on a retry — itself a fresh `clear`) is
        // consumed here, exactly once.
        devices: sessions.map((s): RunDevice => ({
          name: s.name,
          device: s.device,
          serial: s.serial,
          sessionContext: { ...s.context, config: { ...opts.config, device: s.serial } },
          prepared: consumePrepared(s),
        })),
        screenshotDir: opts.screenshotDir,
        reporter: opts.reporter,
        beforeEachTest: async (fullName) => {
          // Mirror the worker path: a recovery here relaunched the app, so any
          // beforeAll-established state (navigation, auth) is gone. Throw the
          // infra-shaped error so the file retries and beforeAll re-runs —
          // otherwise the test runs against the recovered app's home screen
          // and fails with a misleading assertion error. Every device of the
          // group is checked; a recovery on any of them retries the file.
          const recoveries: string[] = [];
          await Promise.all(sessions.map((s) => ensureSessionReady(
            { ...s.context, config: { ...opts.config, device: s.serial } },
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
        },
        abortFileOnError: isRecoverableInfrastructureError,
        resetCapabilities: sessions[0].capabilities,
        runMode: 'test',
        // In-process retries need the same ESM cache busting as worker
        // retries; otherwise import() returns the cached module and the
        // retry registers no tests.
        bustImportCache: attempt > 1,
        projectUseOptions: opts.projectUseOptions,
        projectName: opts.projectName,
        grep: grep.length > 0 ? grep : undefined,
        grepInvert: grepInvert.length > 0 ? grepInvert : undefined,
        projectGrep: opts.projectGrep,
        projectGrepInvert: opts.projectGrepInvert,
      });
      const fileResults = collectResults(suite);
      const infraFailure = fileResults.find(
        (r) => r.status === 'failed' && r.error && isRecoverableInfrastructureError(r.error),
      );
      if (!infraFailure) {
        // If this is a retry that produced fewer results than the first
        // attempt (e.g. crashed before running any tests), prefer the
        // first attempt's results so the original failure is visible.
        if (attempt === 2 && firstAttemptSuite) {
          const firstResults = collectResults(firstAttemptSuite);
          if (fileResults.length < firstResults.length) {
            return firstAttemptSuite;
          }
          // Tests that failed on the discarded first attempt must surface as
          // flaky, not as clean passes — the summary would otherwise hide
          // that the file was re-run at all.
          markFileRetryFlakes(firstAttemptSuite, suite);
        }
        return suite;
      }
      if (attempt === 2) {
        return suite;
      }
      firstAttemptSuite = suite;
      process.stderr.write(
        dim(`Recovering session after infrastructure error in ${path.basename(file)}: ${infraFailure.error?.message ?? 'unknown'}\n`),
      );
      await recoverDeviceSessions(sessions, `recovery for ${path.basename(file)}`);
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) {
        // If the retry itself crashed, return the first attempt's results
        // (which contain the original failure) so it's counted in the summary.
        if (firstAttemptSuite) return firstAttemptSuite;
        throw err;
      }
      process.stderr.write(
        dim(`Recovering session after infrastructure error in ${path.basename(file)}: ${err instanceof Error ? err.message : err}\n`),
      );
      await recoverDeviceSessions(sessions, `recovery for ${path.basename(file)}`);
    }
  }
  // Unreachable — loop always returns or throws
  throw new Error(`Exhausted recovery attempts for ${path.basename(file)}`);
}

main().catch(async (err) => {
  // If a SIGINT/SIGTERM handler is already in the middle of shutting down
  // the dispatcher, swallow the resulting "All workers became unavailable"
  // rejection — it's a consequence of our own cleanup, not a real failure.
  // The dispatcher's scheduleShutdownExit will exit the process with the
  // correct signal code momentarily.
  try {
    const { isDispatcherShuttingDown } = await import('./dispatcher.js');
    if (isDispatcherShuttingDown()) return;
  } catch { /* dispatcher not loaded — fall through */ }

  activeLaunchProgress?.finish();
  const shownFailures = launchRowsShareStderr() ? activeLaunchProgress?.shownFailures() : undefined;
  activeLaunchProgress = undefined;

  let isLaunchFailure = false;
  try {
    const { isLaunchSetupError } = await import('./dispatcher.js');
    isLaunchFailure = isLaunchSetupError(err);
  } catch { /* dispatcher not loaded — fall through */ }

  const message = err instanceof Error ? err.message : String(err);
  if (isLaunchFailure) {
    // What a ✗ launch row already showed is not repeated (PILOT-569).
    // Only the headline: the lines under it name each worker or target, and
    // a row may still show another target's reason.
    const unshown = shownFailures ? withoutShownHeadline(message, shownFailures) : message;
    if (!unshown) {
      console.error(red('Test run failed to start.'));
      if (process.env.TAPSMITH_DEBUG || process.env.DEBUG) console.error((err as Error)?.stack ?? err);
      process.exit(1);
    }
    const { headline: summary, detail: details } = splitHeadline(unshown);
    console.error(red(`Test run failed to start: ${summary}`));
    if (details) console.error(dim(details));
    if (process.env.TAPSMITH_DEBUG || process.env.DEBUG) {
      console.error((err as Error)?.stack ?? err);
    }
    process.exit(1);
  }

  // Tapsmith missing from the project (PILOT-551): the message is the whole
  // story and the fix; a stack of loader frames would bury it.
  // A bad key or value in the config (PILOT-552): the message names the file
  // and every problem; the loader's stack would bury them.
  // Only one traced to the config file: a test.use() error needs its stack to
  // point at the spec that made it.
  if (isTapsmithNotInstalledError(err) || (isConfigValidationError(err) && err.configPath)) {
    console.error(red(message));
    if (process.env.TAPSMITH_DEBUG || process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }

  // A config that could not be imported (PILOT-569): its message once, with
  // a code frame, not the message three times over tsx's loader frames.
  const configFailure = configLoadFailureOf(err);
  if (configFailure) {
    const { formatConfigLoadFailure } = await import('./config-load-report.js');
    console.error(formatConfigLoadFailure(err as Error, configFailure));
    if (process.env.TAPSMITH_DEBUG || process.env.DEBUG) console.error((err as Error).stack);
    process.exit(1);
  }

  console.error(red(`Fatal error: ${message}`));
  console.error((err as Error)?.stack ?? err);
  process.exit(1);
});
