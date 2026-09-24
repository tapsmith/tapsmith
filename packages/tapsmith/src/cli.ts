#!/usr/bin/env -S node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON

/**
 * CLI entry point for `npx tapsmith`.
 *
 * Commands:
 *   tapsmith test [files...]           Run tests
 *   tapsmith test --device <serial>    Target specific device
 *   tapsmith --version                 Print version
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, configPathOf, normalizeGrep, resolveDeviceStrategy, resolveDeviceGroup, primaryDevicePin, deviceGroupSize, assignGroupMemberDevices, EXPLICIT_WORKERS, isExplicitWorkers, type DeviceGroupEntry, type TapsmithConfig } from './config.js';
import figlet from 'figlet';
import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults, markFileRetryFlakes, type RunDevice, type TestResult, type SuiteResult } from './runner.js';
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
import { installActionProgressPrinter } from './action-progress-renderer.js';
import { discoverTestFiles } from './test-file-discovery.js';
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
  filterHealthyDevices,
  listAdbDevices,
  cleanupStaleEmulators,
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
import { findPidsOnPort, freeStaleAgentPort, pickFreePort } from './port-utils.js';
import { findDaemonBin } from './daemon-bin.js';
import {
  createUiLaunchSteps,
  UiLaunchProgress,
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
  console.log();
  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  console.log(banner.split('\n').map((line) => `${GREEN}${line}${RESET}`).join('\n'));
  console.log(dim(`v${getVersion()}`));
  console.log();
}

function argsAfterCommand(command: string): string[] {
  const idx = process.argv.indexOf(command);
  return idx >= 0 ? process.argv.slice(idx + 1) : [];
}

function commandArgsInclude(command: string, ...flags: string[]): boolean {
  const wanted = new Set(flags);
  return argsAfterCommand(command).some((arg) => wanted.has(arg));
}

/** Argv to forward to a subcommand's own parser, minus the tsx re-exec marker. */
function forwardedArgs(command: string): string[] {
  return argsAfterCommand(command).filter((a) => a !== '--__tsx-reexec');
}

function shouldPrintBannerForCommand(args: CliArgs): boolean {
  if (!args.command || args.version || args.help) return false;

  // Keep protocol and machine-readable surfaces byte-clean.
  if (args.command === 'mcp-server') return false;
  // A settings switch, not a run: no banner, like `--version`.
  if (args.command === 'telemetry') return false;
  if (args.command === 'list-devices' && commandArgsInclude(args.command, '--json')) return false;
  if (args.command === 'doctor' && commandArgsInclude(args.command, '--json')) return false;
  if (args.command === 'verify' && commandArgsInclude(args.command, '--json')) return false;

  // These commands render command-specific help after the top-level parser
  // stops, so suppress the decorative banner when the user only asked for help.
  if (commandArgsInclude(args.command, '--help', '-h')) return false;

  // `init` already owns its banner because the wizard can be called directly
  // from tests and package consumers.
  if (args.command === 'init') return false;

  // Test mode prints its banner after TypeScript re-exec and test discovery,
  // immediately before the launch output.
  if (args.command === 'test') return false;

  return new Set([
    'show-trace',
    'show-report',
    'merge-reports',
    'list-devices',
    'setup-ios',
    'setup-ios-device',
    'build-ios-agent',
    'create-avd',
    'configure-ios-network',
    'refresh-ios-network',
    'verify-ios-network',
    'verify',
    'doctor',
  ]).has(args.command);
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
  // Find tsx binary — first check local node_modules, then global
  const tapsmithPkgDir = path.resolve(import.meta.dirname, '..');
  const localTsx = path.join(tapsmithPkgDir, 'node_modules', '.bin', 'tsx');
  const tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';

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
    console.error(red(`Failed to start tsx: ${err.message}`));
    console.error(dim('Install tsx: npm install -g tsx'));
    process.exit(1);
  });

  // Prevent the current process from continuing
  // This is a "never" return since we rely on the child process
  return undefined as never;
}

// ─── Device health check ───

/**
 * Verify the target device is responsive before running tests.
 * Attempts ADB restart recovery if unresponsive, exits the process if not recoverable.
 */
async function checkDeviceHealth(serial: string | undefined): Promise<void> {
  const target = serial ?? 'any connected device';

  if (serial) {
    const stable = await waitForDeviceStability(serial, 20_000, probeDeviceHealth);
    if (stable.healthy) return;

    if (stable.reason && !stable.reason.includes('ADB shell')) {
      console.error(red(`Device ${target} is not ready: ${stable.reason}.`));
      process.exit(1);
    }
  }

  // Quick ADB responsiveness check (5s timeout)
  const adbArgs = serial
    ? ['-s', serial, 'shell', 'echo', '__tapsmith_health_ok__']
    : ['shell', 'echo', '__tapsmith_health_ok__'];

  const tryAdb = (): boolean => {
    try {
      const result = execFileSync('adb', adbArgs, {
        timeout: 5_000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return result.trim().includes('__tapsmith_health_ok__');
    } catch {
      return false;
    }
  };

  if (tryAdb()) {
    return;
  }

  // Device is unresponsive — try ADB restart recovery
  console.log(yellow(`Device ${target} is unresponsive. Restarting ADB server...`));

  try {
    execFileSync('adb', ['kill-server'], { timeout: 5_000, stdio: 'ignore' });
  } catch {
    // kill-server can fail if daemon isn't running
  }
  // Give ADB time to fully shut down
  await new Promise((r) => setTimeout(r, 2_000));

  try {
    execFileSync('adb', ['start-server'], { timeout: 10_000, stdio: 'ignore' });
  } catch {
    console.error(red('Failed to restart ADB server.'));
    console.error(dim('  Check that Android SDK platform-tools are installed and on PATH.'));
    process.exit(1);
  }

  // Wait for device to come back
  await new Promise((r) => setTimeout(r, 3_000));

  if (!serial ? tryAdb() : (await waitForDeviceStability(serial, 20_000, probeDeviceHealth)).healthy) {
    console.log(dim('ADB recovered. Device is responsive.'));
    return;
  }

  // Still unresponsive — give the user actionable guidance
  console.error(red(`Device ${target} is not responding.`));
  console.error('');
  console.error('  Possible causes:');
  console.error(dim('    • Emulator crashed or froze — restart it'));
  console.error(dim('    • Multiple emulators competing for the same port'));
  console.error(dim('    • USB device disconnected'));
  console.error('');
  console.error('  Try:');
  console.error(dim('    $ adb kill-server && adb start-server'));
  console.error(dim('    $ adb devices -l'));
  if (serial?.startsWith('emulator')) {
    console.error(dim(`    $ adb -s ${serial} emu kill  # restart the emulator`));
  }
  process.exit(1);
}

// ─── Daemon management ───


/** Track the daemon process we spawned so we can kill it on exit. */
let spawnedDaemonProcess: ReturnType<typeof spawn> | undefined;

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
  process.on('unhandledRejection', (reason) => runFatalTeardown('rejection', reason));
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
      if (progress) progress.note(`port ${requestedPort} is in use by another Tapsmith session; starting on ${address}`);
      else console.log(dim(`Daemon port ${requestedPort} is in use by another Tapsmith session; starting on ${address}`));
    } else {
      const pids = findPidsOnPort(port);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      if (pids.length > 0) await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // No daemon running, nothing to kill
  }

  // Remove stale ADB port forwards whose HOST side is the default agent port
  // (18700). A previous Android instance may have left a forward that hijacks
  // traffic meant for the iOS XCUITest agent. Each line is "<serial> <local>
  // <remote>" — match `local === tcp:18700` exactly so we don't try to remove
  // forwards whose remote side happens to be 18700 but whose host port is not
  // (which would print "listener 'tcp:18700' not found").
  //
  // Skipped entirely when another live Tapsmith session owns the requested
  // port: its agent forward and agent process are not stale, they are that
  // session's — sweeping them would cut it off from its device, which is
  // exactly what starting on a free port above set out to avoid.
  if (!sharingWithLiveSession) try {
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
  if (!sharingWithLiveSession) {
    freeStaleAgentPort(18700, progress
      ? ({ port, pid }) => progress.update('daemon', {
        state: 'running',
        detail: `cleared stale agent port ${port} (pid ${pid})`,
      })
      : undefined);
  }

  // Start a fresh daemon
  const resolvedBin = process.env.TAPSMITH_DAEMON_BIN ?? daemonBin ?? findDaemonBin();
  const daemonArgs = ['--port', port];
  if (platform) daemonArgs.push('--platform', platform);
  // Optional: redirect the spawned daemon's stdout/stderr to a file when
  // `TAPSMITH_DAEMON_LOG=<path>` is set. Useful for debugging daemon-side
  // behaviour (MITM proxy pre-start, `/tapsmith.pac` serves, agent startup)
  // without spinning up a separate daemon process. Off by default — the
  // env var is the only way to enable it.
  let daemonStdio: 'ignore' | ['ignore', number, number] = 'ignore';
  const daemonLogPath = process.env.TAPSMITH_DAEMON_LOG;
  if (daemonLogPath) {
    const fd = fs.openSync(daemonLogPath, 'a');
    daemonStdio = ['ignore', fd, fd];
  }
  const child = spawn(resolvedBin, daemonArgs, {
    stdio: daemonStdio,
  });
  child.on('error', () => {
    // Handled below via waitForReady timeout
  });
  child.unref();
  spawnedDaemonProcess = child;

  // Wait for daemon to be ready. First-exec of a freshly-downloaded unsigned
  // binary on a loaded CI runner can take ~30s before the listener binds
  // (macOS scans the binary), and grpc-js reconnect backoff grows ~1.6x per
  // attempt so a single 10s window can skip right past the moment the server
  // comes up. Retry in bounded windows up to 60s total, bailing early if the
  // daemon process exited (crash — no point waiting out the budget).
  const newClient = new TapsmithGrpcClient(address);
  let daemonExitCode: number | null | undefined;
  child.on('exit', (code) => {
    daemonExitCode = code ?? -1;
  });
  const connectDeadline = Date.now() + 60_000;
  let started = false;
  while (!started && Date.now() < connectDeadline && daemonExitCode === undefined) {
    started = await newClient.waitForReady(10_000);
  }
  if (!started) {
    const reason = daemonExitCode !== undefined
      ? `tapsmith-core exited with code ${daemonExitCode} during startup`
      : 'failed to start tapsmith-core (not ready after 60s)';
    progress?.fail('daemon', reason);
    console.error(red(`Failed to start Tapsmith daemon (${reason}). Is tapsmith-core installed?`));
    process.exit(1);
  }

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
 */
async function setupSequentialDevice(
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
    throw new Error(
      'No online devices found. Connect a device, start an emulator, or set `avd` in your config to auto-launch emulators.',
    );
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
    await checkDeviceHealth(deviceSerial);
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
      console.error(dim('  so this step recurs weekly. Re-run `tapsmith build-ios-agent`'));
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
          progress.note(`Run \`tapsmith refresh-ios-network ${deviceSerial}\` and reinstall the updated profile.`);
        } else {
          console.log();
          console.log('\x1b[33m⚠ Host IP drift detected.\x1b[0m');
          console.log(
            dim(`  Installed profile points at ${drift.sidecarHostIp}, Mac is now ${drift.currentHostIp}.`),
          );
          console.log(
            dim(`  Run \`tapsmith refresh-ios-network ${deviceSerial}\` and reinstall the updated`),
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
        label: 'Device',
        client,
        forceInstall,
        freshDevice: deviceJustLaunched,
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
    throw err;
  }
  completePrimary(`${deviceSerial} selected`);
  if (!progress) console.log(dim(`Using device: ${deviceSerial}`));

  // Physical-iOS provisioning-profile expiry warning, now that the xctestrun
  // is resolved. Three-point surfacing (here + build-ios-agent tail +
  // setup-ios-device preflight) so users hit the warning whichever path they
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
      + (cfg.platform === 'ios'
        ? 'Boot more simulators matching `simulator`, or pin members with `device`.'
        : 'Connect more devices, set `avd` so emulators can be launched, or pin members with `device`.'),
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
  try { state.device.close(); } catch { /* already closed */ }
  try { state.client.close(); } catch { /* already closed */ }
  if (spawnedDaemonProcess) {
    try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    spawnedDaemonProcess = undefined;
  }
  preserveEmulatorsForReuse(state.launchedEmulators);
}

function listConnectedDeviceSerials(): string[] {
  return listAdbDevices()
    .filter((d) => d.state === 'device')
    .map((d) => d.serial);
}

async function ensureSequentialTargetDevice(
  config: Awaited<ReturnType<typeof loadConfig>>,
  progress?: LaunchProgressSink,
): Promise<{ selectedSerial?: string; launched: LaunchedEmulator[] }> {
  // The first `use.devices` member's pin, or root `device` — not `config.device`
  // alone, which left a group pinning both members with its primary auto-picked.
  const pinned = primaryDevicePin(config);
  if (pinned) {
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
    const { listBootedSimulators, provisionSimulator, cleanupStaleSimulators } = await import('./ios-simulator.js');
    // If no simulator is configured, try to auto-resolve a single paired
    // physical device. Mirrors how simulators are picked by name — the
    // user should not have to hand-parse `devicectl` JSON in their config.
    if (!config.simulator) {
      try {
        const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
        const udid = resolvePhysicalIosDevice();
        const message = `Auto-detected physical iOS device ${udid}.`;
        if (progress) progress.note(message);
        else process.stderr.write(`${DIM}${message}${RESET}\n`);
        return { selectedSerial: udid, launched: [] };
      } catch (e) {
        console.error(
          red(
            `No simulator specified and physical device auto-detect failed: ${(e as Error).message}\n` +
              `Set \`simulator\` (e.g. simulator: "iPhone 16") or \`device\` in your config.`,
          ),
        );
        process.exit(1);
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
    const booted = listBootedSimulators();
    const matching = booted.find((s) => s.name === simulatorName || s.udid === simulatorName);
    if (matching) {
      const message = `Reusing already-booted simulator ${matching.udid} (${matching.name}).`;
      if (progress) progress.update('primary-device', { state: 'running', detail: `reusing already-booted ${matching.name}` });
      else process.stderr.write(`${DIM}${message}${RESET}\n`);
      return { selectedSerial: matching.udid, launched: [] };
    }

    // Boot the simulator
    try {
      const udid = provisionSimulator(simulatorName, config.app);
      return { selectedSerial: udid, launched: [] };
    } catch (e) {
      console.error(red(`Failed to provision iOS simulator: ${(e as Error).message}`));
      process.exit(1);
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
  const staleResult = cleanupStaleEmulators(config.avd);
  if (staleResult.killed.length > 0) {
    const message = `Cleaned up ${staleResult.killed.length} stale emulator(s).`;
    if (progress) progress.note(message);
    else process.stderr.write(`${DIM}${message}${RESET}\n`);
  }

  const deviceStrategy = resolveDeviceStrategy(config);
  const onlineSerials = listConnectedDeviceSerials();
  const prefilteredOnline = prefilterDevicesForStrategy(
    onlineSerials,
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

  if (selectedOnline.selectedSerials.length > 0) {
    return { selectedSerial: selectedOnline.selectedSerials[0], launched: [] };
  }

  if (!config.launchEmulators) {
    return { selectedSerial: undefined, launched: [] };
  }

  progress?.update('primary-device', { state: 'running', detail: 'launching Android emulator' });
  const provision = await provisionEmulators({
    existingSerials: [],
    occupiedSerials: onlineSerials,
    workers: 1,
    avd: config.avd,
    onProgress: (message, level) => {
      if (!progress) return;
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
    selectedSerial: selectedProvisioned.selectedSerials[0],
    launched: provision.launched,
  };
}

// ─── Argument parsing ───

interface CliArgs {
  command: string;
  files: string[];
  device?: string;
  workers?: number;
  shard?: { current: number; total: number };
  trace?: string;
  /** `--video <mode>` override. See `VideoMode` in config for accepted values. */
  video?: string;
  watch: boolean;
  ui: boolean;
  uiPort?: number;
  uiDevUrl?: string;
  config?: string;
  forceInstall: boolean;
  version: boolean;
  help: boolean;
  tsxReexec: boolean;
  /** Pattern from `--grep` / `-g`. Compiled to a RegExp later. */
  grep?: string;
  /** Pattern from `--grep-invert`. Compiled to a RegExp later. */
  grepInvert?: string;
  /** Reporter override from `--reporter`. */
  reporter?: string;
  /** Project name(s) from `--project` (repeatable). Filters which configured projects run. */
  project?: string[];
}

function compileGrepPattern(pattern: string, flag: string): RegExp {
  try {
    const match = pattern.match(/^\/(.*)\/([gimusy]*)$/);
    if (match) return new RegExp(match[1], match[2]);
    return new RegExp(pattern);
  } catch (err) {
    console.error(red(`${flag} is not a valid regular expression: ${(err as Error).message}`));
    process.exit(1);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: '',
    files: [],
    watch: false,
    ui: false,
    version: false,
    help: false,
    forceInstall: false,
    tsxReexec: false,
  };

  const rest = argv.slice(2);
  let i = 0;

  while (i < rest.length) {
    const arg = rest[i];

    if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--device' || arg === '-d') {
      args.device = rest[++i];
    } else if (arg?.startsWith('--device=')) {
      args.device = arg.slice('--device='.length);
    } else if (arg === '--workers' || arg === '-j') {
      const val = parseInt(rest[++i], 10);
      if (isNaN(val) || val < 1) {
        console.error(red('--workers must be a positive integer'));
        process.exit(1);
      }
      args.workers = val;
    } else if (arg?.startsWith('--workers=') || arg?.startsWith('-j=')) {
      const raw = arg.startsWith('--workers=')
        ? arg.slice('--workers='.length)
        : arg.slice('-j='.length);
      const val = parseInt(raw, 10);
      if (isNaN(val) || val < 1) {
        console.error(red('--workers must be a positive integer'));
        process.exit(1);
      }
      args.workers = val;
    } else if (arg?.startsWith('--shard=')) {
      const shardStr = arg.slice('--shard='.length);
      const match = shardStr.match(/^(\d+)\/(\d+)$/);
      if (!match) {
        console.error(red('--shard must be in the format x/y (e.g. --shard=1/4)'));
        process.exit(1);
      }
      const current = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      if (current < 1 || current > total) {
        console.error(red(`Invalid shard: ${current}/${total}. Current must be between 1 and total.`));
        process.exit(1);
      }
      args.shard = { current, total };
    } else if (arg === '--trace') {
      args.trace = rest[++i] ?? 'on';
    } else if (arg?.startsWith('--trace=')) {
      args.trace = arg.slice('--trace='.length);
    } else if (arg === '--video') {
      args.video = rest[++i] ?? 'on';
    } else if (arg?.startsWith('--video=')) {
      args.video = arg.slice('--video='.length);
    } else if (arg === '--watch' || arg === '-w') {
      args.watch = true;
    } else if (arg === '--ui') {
      args.ui = true;
    } else if (arg === '--ui-port') {
      const val = parseInt(rest[++i], 10);
      if (isNaN(val) || val < 0) {
        console.error(red('--ui-port must be a non-negative integer'));
        process.exit(1);
      }
      args.uiPort = val;
    } else if (arg?.startsWith('--ui-port=')) {
      const val = parseInt(arg.slice('--ui-port='.length), 10);
      if (isNaN(val) || val < 0) {
        console.error(red('--ui-port must be a non-negative integer'));
        process.exit(1);
      }
      args.uiPort = val;
    } else if (arg === '--ui-dev-url') {
      args.uiDevUrl = rest[++i];
    } else if (arg?.startsWith('--ui-dev-url=')) {
      args.uiDevUrl = arg.slice('--ui-dev-url='.length);
    } else if (arg === '--config' || arg === '-c') {
      args.config = rest[++i];
    } else if (arg?.startsWith('--config=')) {
      args.config = arg.slice('--config='.length);
    } else if (arg === '--reporter') {
      args.reporter = rest[++i];
    } else if (arg?.startsWith('--reporter=')) {
      args.reporter = arg.slice('--reporter='.length);
    } else if (arg === '--project') {
      const val = rest[++i];
      if (!val) {
        console.error(red('--project requires a project name'));
        process.exit(1);
      }
      (args.project ??= []).push(val);
    } else if (arg?.startsWith('--project=')) {
      const val = arg.slice('--project='.length);
      if (!val) {
        console.error(red('--project requires a project name'));
        process.exit(1);
      }
      (args.project ??= []).push(val);
    } else if (arg === '--grep' || arg === '-g') {
      args.grep = rest[++i];
    } else if (arg?.startsWith('--grep=')) {
      args.grep = arg.slice('--grep='.length);
    } else if (arg?.startsWith('-g=')) {
      args.grep = arg.slice('-g='.length);
    } else if (arg === '--grep-invert') {
      args.grepInvert = rest[++i];
    } else if (arg?.startsWith('--grep-invert=')) {
      args.grepInvert = arg.slice('--grep-invert='.length);
    } else if (arg === '--force-install') {
      args.forceInstall = true;
    } else if (arg === '--__tsx-reexec') {
      args.tsxReexec = true;
    } else if (!arg.startsWith('-') && !args.command) {
      args.command = arg;
      // Subcommands with their own argument parsers: stop consuming here
      // so downstream flags (e.g. `build-ios-agent --verbose --team-id X`)
      // aren't rejected by the top-level parser. The subcommand handler
      // re-parses from process.argv after the command name.
      if (
        arg === 'build-ios-agent'
        || arg === 'create-avd'
        || arg === 'configure-ios-network'
        || arg === 'refresh-ios-network'
        || arg === 'verify-ios-network'
        || arg === 'verify'
        || arg === 'list-devices'
        || arg === 'mcp-server'
        || arg === 'doctor'
        || arg === 'init'
        || arg === 'telemetry'
      ) {
        break;
      }
    } else if (!arg.startsWith('-')) {
      args.files.push(arg);
    } else {
      console.error(red(`Unknown argument: ${arg}`));
      process.exit(1);
    }

    i++;
  }

  return args;
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
  const rowProgress = opts?.reportProgress === false ? undefined : opts?.progress;
  rowProgress?.start('worker-devices', `preparing ${wanted} worker device(s)`);

  let serials: string[];
  let reusedSimulatorCount = 0;
  if (config.platform === 'ios') {
    const { listCompatibleBootedSimulators, provisionSimulators, cleanupStaleSimulators } = await import('./ios-simulator.js');
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
    const compatible = listCompatibleBootedSimulators(config.device!);
    const others = compatible
      .filter((s) => s.udid !== config.device && !pinned.includes(s.udid))
      .slice(0, Math.max(0, wanted - 1 - pinned.length));
    if (others.length > 0) {
      reusedSimulatorCount += others.length;
      if (opts?.progress) {
        opts.progress.update('worker-devices', {
          state: 'running',
          detail: `reusing ${others.length} booted simulator(s) from previous run`,
        });
      } else {
        for (const sim of others) {
          process.stderr.write(`${DIM}Reusing simulator ${sim.udid} (${sim.name}) from previous run.${RESET}\n`);
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
    const others = allConnected.filter((s) => s !== config.device && !pinned.includes(s));
    serials = [config.device!, ...pinned, ...others].filter(Boolean);

    if (serials.length < wanted && config.launchEmulators) {
      const provision = await provisionEmulators({
        existingSerials: serials,
        occupiedSerials: allConnected,
        workers: wanted,
        avd: config.avd,
        onProgress: (message, level) => {
          if (!opts?.progress) return;
          if (level === 'warning') opts.progress.note(message);
          else opts.progress.update('worker-devices', { state: 'running', detail: message });
        },
      });
      launched = provision.launched;
      for (const e of provision.launched) freshSerials.add(e.serial);
      serials = provision.allSerials;
    }
  }

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
}

/**
 * Provision devices for a single bucket using its effective config and a
 * fixed worker count. Returns the device serials successfully provisioned
 * (may be fewer than requested if hardware constraints prevent it).
 */
async function provisionDevicesForBucket(
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
    // A pinned group is exactly one worker: the primary (pinned or the first
    // device found), then the members in order — each keeping its pin, the
    // unpinned ones taking the next free device provisioned here. Nothing to
    // provision when every entry is pinned.
    const group = pinnedGroup.map((e) => ({ ...e }));
    if (group.every((e) => e.device)) {
      // Every device named outright: the same pins-only group (and the same
      // refusal of an Android pin that is not connected) as the parallel path.
      const { pinnedWorkerDevices } = await import('./dispatcher.js');
      const pins = pinnedWorkerDevices(group, listConnectedDeviceSerials(), effectiveConfig.platform === 'ios')!;
      return { serials: pins, launched: [], reusedSimulatorCount: 0 };
    }
    const pool = await provisionDevicesForBucket({ ...effectiveConfig, devices: undefined, device: undefined }, group.length, progress);
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
    const booted = listBootedSimulators().filter(
      (s) => s.name === effectiveConfig.simulator || s.udid === effectiveConfig.simulator,
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
        if (!progress) return;
        if (level === 'warning') progress.note(message);
        else progress.update('worker-devices', { state: 'running', detail: message });
      },
    });
    return { serials: provision.allUdids, launched: [], reusedSimulatorCount: provision.reusedUdids.length };
  }

  // Android
  const allConnected = listConnectedDeviceSerials();
  const deviceStrategy = resolveDeviceStrategy(effectiveConfig);
  const prefiltered = prefilterDevicesForStrategy(
    allConnected,
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

  const provision = await provisionEmulators({
    existingSerials: serials,
    occupiedSerials: allConnected,
    workers: desiredWorkers,
    avd: effectiveConfig.avd,
    onProgress: (message, level) => {
      if (!progress) return;
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
 */
async function provisionPerProjectDevices(
  rootConfig: TapsmithConfig,
  projects: import('./project.js').ResolvedProject[],
  budgetCap: number | undefined,
  /** Buckets that pin a device, taken before the sequential setup ran (see `allocateBucketWorkers`). */
  pinnedSignatures: import('./project.js').PinnedBuckets,
  progress?: LaunchProgressSink,
): Promise<PerProjectProvisionResult> {
  progress?.start('worker-devices', 'preparing devices across project targets');
  const result: PerProjectProvisionResult = {
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

  // Provision each bucket's devices in parallel — Android emulators and
  // iOS simulators both have multi-second cold-start costs, and there's
  // no cross-bucket dependency. Preserves per-bucket ordering in the
  // aggregated result by collecting into position-indexed slots.
  const tasks = bucketEntries.map(async ({ signature, projects: bucketProjects }) => {
    const desiredWorkers = allocation.get(signature) ?? 0;
    if (desiredWorkers === 0) return null;

    // The bucket's projects share its devices: provision for the largest
    // group any of them declares (a smaller project runs on the first N).
    const bucketEffective = sharedDeviceGroup(bucketProjects).config;
    const groupSize = deviceGroupSize(bucketEffective);
    // Every pin, the primary's included, from the snapshot taken before the
    // sequential setup: that setup has since written its auto-picked serial
    // onto the root config `use`-less projects share, which is not a pin.
    const snapshot = pinnedSignatures.get(signature);
    const pinned = [...(snapshot?.pins ?? [])];
    const workersWanted = pinned.length > 0 ? 1 : desiredWorkers;
    const desiredDevices = workersWanted * groupSize;
    progress?.update(
      'worker-devices',
      { state: 'running', detail: `preparing ${desiredDevices} device(s) for ${bucketProjects.map((p) => p.name).join(', ')}` },
    );
    const provisioned = await provisionDevicesForBucket(bucketEffective, desiredDevices, progress, snapshot?.group);

    if (provisioned.serials.length === 0) {
      throw new Error(
        `Failed to provision any devices for bucket "${signature.split('|').slice(0, 2).join(' ')}".`,
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
      if (progress) progress.note(message);
      else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
    }

    return { signature, bucketEffective, provisioned, groupSize };
  });

  const outcomes = await Promise.all(tasks);

  for (const outcome of outcomes) {
    if (!outcome) continue;
    const { signature, bucketEffective, provisioned, groupSize } = outcome;
    result.launched.push(...provisioned.launched);
    result.reusedSimulatorCount += provisioned.reusedSimulatorCount;
    const bucketSerialized = serializeConfig({ ...bucketEffective, devices: rootConfig.devices });
    // Whole groups only: a trailing partial group has no worker to serve.
    const usable = provisioned.serials.slice(0, Math.floor(provisioned.serials.length / groupSize) * groupSize);
    for (const serial of usable) {
      result.deviceSerials.push(serial);
      result.configByDevice.set(serial, bucketSerialized);
      result.deviceGroupByDevice.set(serial, resolveDeviceGroup({ devices: bucketEffective.devices, device: serial }));
      result.bucketByDevice.set(serial, signature);
    }
    for (let i = 0; i < usable.length; i += groupSize) {
      result.workerGroups.push(usable.slice(i, i + groupSize));
    }
  }

  const reuseSuffix = result.reusedSimulatorCount > 0 ? ` (${result.reusedSimulatorCount} reused)` : '';
  progress?.complete('worker-devices', `${result.deviceSerials.length} device(s)${reuseSuffix}: ${result.deviceSerials.join(', ')}`);
  return result;
}

function printHelp(): void {
  printTapsmithBanner();
  console.log(`${bold('Mobile app testing framework')}

${bold('Usage:')}
  tapsmith test [files...]           Run test files
  tapsmith test --watch              Watch test files and re-run on change
  tapsmith test --ui                 Open interactive UI mode
  tapsmith test --ui --ui-port 8080  UI mode on specific port
  tapsmith test --device <serial>    Target specific device/simulator
  tapsmith test --workers <n>        Run tests in parallel across n devices
  tapsmith test --shard=x/y          Run shard x of y (for CI)
  tapsmith test --trace <mode>       Record traces (on, retain-on-failure, etc.)
  tapsmith test --video <mode>       Record videos (on, retain-on-failure, etc.)
  tapsmith show-trace <file.zip>     Open trace viewer in browser
  tapsmith show-report [dir]         Open HTML test report
  tapsmith merge-reports [dir]       Merge blob reports from sharded runs
  tapsmith list-devices              List connected devices (Android, iOS sim, iOS physical)
  tapsmith list-devices --json       Same, as JSON for scripting
  tapsmith setup-ios                 First-run setup for iOS network capture (macOS only)
  tapsmith setup-ios-device          Preflight checklist for physical iOS device testing
  tapsmith build-ios-agent           Build the signed TapsmithAgent runner for physical iOS devices
  tapsmith create-avd                Create an Android AVD that supports HTTPS network capture
  tapsmith configure-ios-network <udid>   Generate a network capture profile (.mobileconfig) for a physical iOS device
  tapsmith refresh-ios-network <udid>     Regenerate the network capture profile after a host Wi-Fi change
  tapsmith verify-ios-network <udid>      Verify HTTPS capture for a normal system-trust client on a physical iOS device
  tapsmith init                      Initialize a new Tapsmith project (interactive wizard)
  tapsmith init --yes [--json]       Non-interactive init for scripts/AI agents (see init --help)
  tapsmith verify [--json]           Run one test end-to-end to prove the setup works
  tapsmith doctor [--json] [-c file] Check system health (--json includes fixes + device inventory)
  tapsmith mcp-server [--config file] Run MCP server for LLM/agent integration (stdio transport)
  tapsmith telemetry [status|enable|disable]  Show or switch anonymous usage telemetry for this machine
  tapsmith --version                 Print version
  tapsmith --help                    Show this help

${bold('Options:')}
  -w, --watch              Watch test files and re-run on change
  -d, --device <serial>    Target a specific device or simulator by serial/UDID
  -j, --workers <n>        Number of parallel workers (default: 1)
  --shard=x/y              Split tests across CI machines (e.g. --shard=1/4)
  --trace <mode>           Trace mode: off, on, on-first-retry, on-all-retries,
                           retain-on-failure, retain-on-first-failure,
                           retain-on-failure-and-retries
  --video <mode>           Video mode (same set as --trace). Records the
                           device screen for the lifetime of each test.
  -c, --config <path>      Path to config file (default: tapsmith.config.ts)
  -g, --grep <pattern>     Run only tests whose fullName matches this regex
  --grep-invert <pattern>  Skip tests whose fullName matches this regex
  --reporter <name>        Override the reporter (list, line, dot, json, junit, html, github)
  --project <name>         Only run the named project from your config (repeatable;
                           dependencies run automatically)
  --force-install          Reinstall the app even if already installed
  -v, --version            Print version
  -h, --help               Show this help
`);
}

// ─── Main ───

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(getVersion());
    return;
  }

  // Stamp one telemetry session id into the environment before any child is
  // forked (the tsx re-exec, workers, watch/MCP run children all inherit it),
  // so every per-file event of this invocation shares one session (PILOT-330).
  ensureSessionEnv();

  // Subcommands that print their own command-specific help on --help.
  // Other commands (e.g. `tapsmith test --help`) fall back to the top-level
  // help below.
  const subcommandsWithOwnHelp = new Set<string>([
    'build-ios-agent',
    'create-avd',
    'configure-ios-network',
    'refresh-ios-network',
    'verify-ios-network',
    'init',
    'verify',
  ]);

  if (args.help && !(args.command && subcommandsWithOwnHelp.has(args.command))) {
    printHelp();
    return;
  }
  if (!args.command) {
    printHelp();
    return;
  }

  if (shouldPrintBannerForCommand(args)) {
    printTapsmithBanner();
  }

  if (args.command === 'show-report') {
    const reportDir = args.files[0] ?? 'tapsmith-report';
    const reportPath = path.resolve(process.cwd(), reportDir, 'index.html');
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
    return;
  }

  if (args.command === 'show-trace') {
    const traceFile = args.files[0];
    if (!traceFile) {
      console.error(red('Usage: tapsmith show-trace <trace.zip>'));
      process.exit(1);
    }
    const { showTrace } = await import('./trace/show-trace-server.js');
    try {
      console.log(bold('Opening trace viewer'));
      console.log(dim(path.resolve(traceFile)));
      const server = await showTrace({ tracePath: traceFile });
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
    return;
  }

  if (args.command === 'merge-reports') {
    const { runMergeReports } = await import('./merge-reports.js');
    const config = await loadConfig(undefined, args.config);
    const code = await runMergeReports(args.files[0] ?? 'blob-report', config);
    if (code !== 0) process.exit(code);
    return;
  }

  if (args.command === 'list-devices') {
    const { runListDevices } = await import('./list-devices.js');
    const forwardedArgv = forwardedArgs('list-devices');
    await runListDevices(forwardedArgv);
    return;
  }

  if (args.command === 'setup-ios') {
    const { runSetupIos } = await import('./setup-ios.js');
    await runSetupIos();
    return;
  }

  if (args.command === 'setup-ios-device') {
    const { runSetupIosDevice } = await import('./setup-ios-device.js');
    await runSetupIosDevice();
    return;
  }

  if (args.command === 'configure-ios-network') {
    const { runConfigureIosNetwork } = await import('./configure-ios-network.js');
    const forwardedArgv = forwardedArgs('configure-ios-network');
    await runConfigureIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'refresh-ios-network') {
    const { runRefreshIosNetwork } = await import('./configure-ios-network.js');
    const forwardedArgv = forwardedArgs('refresh-ios-network');
    await runRefreshIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'verify-ios-network') {
    const { runVerifyIosNetwork } = await import('./verify-ios-network.js');
    const forwardedArgv = forwardedArgs('verify-ios-network');
    await runVerifyIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'build-ios-agent') {
    const { runBuildIosAgent } = await import('./build-ios-agent.js');
    // Everything after the subcommand name is forwarded; drop the verb.
    const forwardedArgv = forwardedArgs('build-ios-agent');
    await runBuildIosAgent(forwardedArgv);
    return;
  }

  if (args.command === 'init') {
    const { runInit } = await import('./init.js');
    const forwardedArgv = forwardedArgs('init');
    await runInit(forwardedArgv);
    return;
  }

  if (args.command === 'create-avd') {
    const { runCreateAvd } = await import('./create-avd.js');
    const forwardedArgv = forwardedArgs('create-avd');
    await runCreateAvd(forwardedArgv);
    return;
  }

  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    const forwardedArgv = forwardedArgs('doctor');
    await runDoctor(forwardedArgv);
    return;
  }

  if (args.command === 'telemetry') {
    const { runTelemetryCommand } = await import('./telemetry-cli.js');
    process.exitCode = await runTelemetryCommand(forwardedArgs('telemetry'));
    return;
  }

  if (args.command === 'mcp-server') {
    const { runMcpServer } = await import('./mcp/index.js');
    const forwardedArgv = forwardedArgs('mcp-server');
    await runMcpServer(forwardedArgv);
    return;
  }

  if (args.command === 'verify') {
    const { runVerify } = await import('./verify.js');
    const forwardedArgv = forwardedArgs('verify');
    await runVerify(forwardedArgv);
    return;
  }

  if (args.command !== 'test') {
    console.error(red(`Unknown command: ${args.command}`));
    printHelp();
    process.exit(1);
  }

  // Load config
  const config = await loadConfig(undefined, args.config);
  const configPath = configPathOf(config);
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
    config.trace = args.trace as TapsmithConfig['trace'];
  }
  if (args.video) {
    config.video = args.video as TapsmithConfig['video'];
  }
  if (args.grep !== undefined) {
    config.grep = compileGrepPattern(args.grep, '--grep');
  }
  if (args.grepInvert !== undefined) {
    config.grepInvert = compileGrepPattern(args.grepInvert, '--grep-invert');
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
  const { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectsForFile, validateProjectNames, projectLabel } = await import('./project.js');
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
    for (const project of projects) {
      project.testFiles = await discoverTestFiles(project.testMatch, config.rootDir, undefined, project.testIgnore);
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
    const explicitPaths = args.files.map((f: string) => path.resolve(config.rootDir, f));

    // Find which projects the explicit files belong to
    const targetProjectNames = new Set<string>();
    const filesByProject = new Map<string, string[]>();
    for (const filePath of new Set(explicitPaths)) {
      for (const name of findProjectsForFile(filePath, allProjects, config.rootDir)) {
        // When `--project` is given, only keep matches in the selected set.
        if (selectedSet && !selectedSet.has(name)) continue;
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

    // Discover files: dependency projects get their full testMatch, target projects get only explicit files
    for (const project of projects) {
      if (targetProjectNames.has(project.name)) {
        project.testFiles = filesByProject.get(project.name) ?? [];
      } else {
        // Dependency project — run all its files
        project.testFiles = await discoverTestFiles(project.testMatch, config.rootDir, undefined, project.testIgnore);
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
    defaultProject.testFiles = await discoverTestFiles(config.testMatch, config.rootDir, args.files);
    projects = [defaultProject];
    projectWaves = [[defaultProject]];
  }

  // Flat list for backward-compatible code paths (reporters, tsx check, etc.)
  let testFiles = projects.flatMap((p) => p.testFiles);
  // Deduplicate (a file could match multiple projects' globs)
  testFiles = [...new Set(testFiles)].sort();

  if (testFiles.length === 0) {
    console.error(red('No test files found.'));
    process.exit(1);
  }

  let shardMessage: string | undefined;
  // Apply sharding — deterministic split within each project. Setup projects
  // (depended on by others) only run on shards that have tests from their dependents.
  if (config.shard) {
    const { current, total } = config.shard;
    if (hasProjects) {
      const depTargets = new Set(projects.flatMap((p) => p.dependencies));
      // First pass: shard non-setup projects
      for (const project of projects) {
        if (depTargets.has(project.name)) continue;
        project.testFiles = project.testFiles.filter((_, i) => i % total === current - 1);
      }
      // Second pass: skip setup projects whose dependents have no files in this shard
      for (const project of projects) {
        if (!depTargets.has(project.name)) continue;
        const hasDependentTests = projects.some(
          (p) => p.dependencies.includes(project.name) && p.testFiles.length > 0,
        );
        if (!hasDependentTests) {
          project.testFiles = [];
        }
      }
      testFiles = projects.flatMap((p) => p.testFiles);
    } else {
      testFiles = testFiles.filter((_, i) => i % total === current - 1);
    }
    if (testFiles.length === 0) {
      console.log(dim(`Shard ${current}/${total}: no test files in this shard.`));
      // Still leave this shard's (empty) blob, or merge-reports would report
      // the shard as missing whenever there are fewer files than shards.
      const { writeEmptyShardBlob } = await import('./merge-reports.js');
      await writeEmptyShardBlob(config);
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

  // Compute the effective parallelism BEFORE handing config to the reporter,
  // so reporters can correctly suppress file headings / show project tags
  // when buckets or per-project `workers:` push the actual concurrency above
  // the global `config.workers` value.
  const { allocateBucketWorkers, bucketizeProjects, pinnedBucketSignatures, sharedDeviceGroup, workerPlanNote, platformOfSerial, scopeDevicePinToPlatform, devicePinWorkersConflict, devicesPinnedByManyBuckets } = await import('./project.js');
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

  // A selection filter (grep / grep-invert, at root or any project) is active.
  // When such a filter selects zero runnable tests — i.e. every discovered test
  // ends up skipped — that's a usage error (typically a typo'd pattern), not a
  // green run. The exit paths below fail loud rather than reporting success.
  const selectionFilterActive =
    config.grep !== undefined || config.grepInvert !== undefined ||
    (hasProjects && projects.some((p) => p.grep !== undefined || p.grepInvert !== undefined));
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
      const fullResult = await runParallel({
        config,
        reporter,
        testFiles,
        workers: totalWorkers,
        forceInstall: args.forceInstall,
        workerCap: budgetCap,
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
        launchProgress,
      });

      await reporter.onRunEnd(fullResult);
      const zeroMatch = selectionFilterActive
        && fullResult.tests.length > 0
        && fullResult.tests.every((t) => t.status === 'skipped');
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

  try {
    try {
      currentSequentialState = await setupSequentialDevice(
        initialEffectiveConfig,
        args.forceInstall,
        initialProject.deviceSignature,
        launchProgress,
        bucketGroup(initialProject.deviceSignature),
      );
    } catch (err) {
      // The setup marks the step that actually failed (primary, install,
      // agent, launch, device group); this only catches a failure that
      // happened before any step was reached. Re-labelling the primary here
      // used to print "✗ Primary device" for a group member that failed.
      if (!launchProgress?.hasFailure()) launchProgress?.fail('primary-device', (err as Error).message);
      console.error(red((err as Error).message));
      sequentialExitCode = 1;
      return;
    }

    client = currentSequentialState.client;
    device = currentSequentialState.device;
    launchedEmulators = currentSequentialState.launchedEmulators;
    // Mirror the chosen device serial onto the root config so any code path
    // still reading from `config.device` (UI/watch handoff) sees it.
    config.device = currentSequentialState.deviceSerial;

    // ─── UI mode ───
    // If --ui is set, start the interactive UI server. It keeps the
    // daemon, emulator, and agent alive and serves a Preact SPA.
    // When workers > 1, the UI server manages its own daemons and workers.
    if (args.ui) {
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

      if (isMultiBucketSequential) {
        // Multi-device-target projects: provision per-bucket devices.
        const perBucket = await provisionPerProjectDevices(config, projects, budgetCap, pinnedSignatures, launchProgress);
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

      if (isMultiBucketSequential) {
        const perBucket = await provisionPerProjectDevices(config, projects, budgetCap, pinnedSignatures);
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
    const projectsWithFiles = projects.filter((p) => p.testFiles.length > 0);
    const showProjectHeaders = projectsWithFiles.length > 1;

    for (const wave of projectWaves) {
      for (const project of wave) {
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
        // bound device, tear down the previous state and provision the
        // new device before running its files.
        if (project.testFiles.length > 0 && currentSequentialState
          && currentSequentialState.signature !== project.deviceSignature) {
          process.stdout.write(
            dim(`\nSwitching device for project "${project.name}" (target: ${project.deviceSignature.split('|').slice(0, 2).join(' ')})\n`),
          );
          teardownSequentialDevice(currentSequentialState);
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
            console.error(red(`Failed to set up device for project "${project.name}": ${(err as Error).message}`));
            sequentialExitCode = 1;
            return;
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
    const zeroMatch = selectionFilterActive
      && allResults.length > 0
      && allResults.every((r) => r.status === 'skipped');
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
    // Leave emulators running for reuse by the next run.
    preserveEmulatorsForReuse(launchedEmulators);
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
  activeLaunchProgress = undefined;

  let isLaunchFailure = false;
  try {
    const { isLaunchSetupError } = await import('./dispatcher.js');
    isLaunchFailure = isLaunchSetupError(err);
  } catch { /* dispatcher not loaded — fall through */ }

  const message = err instanceof Error ? err.message : String(err);
  if (isLaunchFailure) {
    const [summary, ...detailLines] = message.split('\n');
    console.error(red(`Test run failed to start: ${summary}`));
    const details = detailLines.join('\n').trim();
    if (details) console.error(dim(details));
    if (process.env.TAPSMITH_DEBUG || process.env.DEBUG) {
      console.error((err as Error)?.stack ?? err);
    }
    process.exit(1);
  }

  console.error(red(`Fatal error: ${message}`));
  console.error((err as Error)?.stack ?? err);
  process.exit(1);
});
