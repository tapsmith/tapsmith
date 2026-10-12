/**
 * `tapsmith doctor` — system health check for Tapsmith dependencies.
 *
 * Runs a non-interactive checklist of core, platform-specific, and network
 * capture prerequisites. Each check is wrapped in try/catch so one failure
 * doesn't prevent subsequent checks from running.
 *
 * Exit code 0 when all checks pass (warnings are OK), 1 when any hard error.
 * The --json schema is documented in docs/api-reference.md (CLI → JSON output).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findDaemonBin } from './daemon-bin.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import { formatJson, jsonError, stripAnsi, type JsonCheck } from './cli-json.js';
import { PLAY_IMAGE_CAPTURE_EFFECT, avdCaptureSupport, captureAvdFix, scanAvdImageTags, type AvdImageInfo } from './avd-images.js';
import { parseSimctlDevicesJson, tryExec } from './env-scan.js';
import { androidUnusableDeviceFix, parseAdbDevicesOutput, type AdbDevice } from './adb-devices.js';
import { isTapsmithNotInstalledError, type TapsmithConfig } from './config.js';
import { MIN_NODE_MAJOR, isSupportedNodeVersion } from './node-runtime.js';
import { emulatorNotFoundMessage, resolveEmulatorBinary, type EmulatorBinary } from './emulator.js';
import { hostArch, nodeUnderRosetta, ROSETTA_NODE_FIX } from './host-arch.js';
import { adbMissingFix, XCODE_FIX } from './toolchain.js';
import { isYarnPnp, YARN_PNP_FIX } from './yarn-pnp.js';

// ─── ANSI helpers ───

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;

// ─── Check result tracking ───

/** One check. Match on `id`: `label` may hold values (a version, a count) and its wording may change. */
export type CheckEntry = JsonCheck;

export type CheckList = CheckEntry[];

export interface DoctorInventory {
  avds: string[];
  simulators: Array<{ name: string; udid: string; state: string; runtime: string }>;
  connectedDevices: Array<{ serial: string; state: string }>;
}

export interface DoctorJson {
  ok: boolean;
  checks: CheckEntry[];
  inventory: DoctorInventory;
}

function plainCheck(check: CheckEntry): CheckEntry {
  const plain: CheckEntry = {
    ...check,
    label: stripAnsi(check.label),
  };
  if (check.detail !== undefined) plain.detail = stripAnsi(check.detail);
  if (check.fix !== undefined) plain.fix = stripAnsi(check.fix);
  return plain;
}

export function buildDoctorJson(checks: CheckList, inventory: DoctorInventory): DoctorJson {
  return {
    ok: !checks.some((c) => c.status === 'fail'),
    checks: checks.map(plainCheck),
    inventory,
  };
}

// Bundles the accumulating check list with whether to echo each check to
// stdout (suppressed in --json mode so stdout stays machine-clean). Passed
// explicitly rather than via module state so runDoctor is reentrant —
// concurrent or sequential invocations never share print state.
interface Reporter {
  checks: CheckList;
  print: boolean;
  /** Output of each command `run` has executed, null when it failed. */
  cache: Map<string, string | null>;
}

/**
 * Runs a command once per report: the planning, the checks and the inventory
 * all read the same `adb devices` / `simctl` output instead of re-executing
 * it. Undefined when the command failed or is not installed.
 */
const RUN_TIMEOUT_MS = 30_000;

function run(report: Reporter, cmd: string, args: string[]): string | undefined {
  const key = [cmd, ...args].join('\0');
  if (!report.cache.has(key)) {
    let out: string | null;
    try {
      // Bounded: a wedged adb server or CoreSimulator must not hang doctor.
      out = execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RUN_TIMEOUT_MS });
    } catch {
      out = null;
    }
    report.cache.set(key, out);
  }
  return report.cache.get(key) ?? undefined;
}

/** A dimmed line under a section heading saying why its checks did not run. */
function note(report: Reporter, text: string): void {
  if (report.print) console.log(dim(`  – ${text}`));
}

/** A check's line in the text output: the label, then its detail dimmed in parentheses. */
export function checkLine(label: string, detail: string | undefined): string {
  return detail ? `${label} ${dim(`(${detail})`)}` : label;
}

function record(report: Reporter, entry: CheckEntry): void {
  // Always the documented key order, and optional keys left out of the JSON
  // rather than printed as null.
  const ordered: CheckEntry = { id: entry.id, status: entry.status, label: entry.label };
  // An empty detail or fix is no detail or fix, in the JSON as in checkLine.
  if (entry.detail) ordered.detail = entry.detail;
  if (entry.fix) ordered.fix = entry.fix;
  report.checks.push(ordered);
}

function pass(report: Reporter, id: string, label: string, detail?: string): void {
  record(report, { status: 'pass', id, label, detail });
  if (report.print) console.log(`  ${green('✓')} ${checkLine(label, detail)}`);
}

function warn(report: Reporter, id: string, label: string, fix?: string, detail?: string): void {
  record(report, { status: 'warn', id, label, detail, fix });
  if (report.print) {
    console.log(`  ${yellow('⚠')} ${checkLine(label, detail)}`);
    if (fix) console.log(dim(`    ↳ ${fix}`));
  }
}

function fail(report: Reporter, id: string, label: string, fix?: string, detail?: string): void {
  record(report, { status: 'fail', id, label, detail, fix });
  if (report.print) {
    console.log(`  ${red('✗')} ${checkLine(label, detail)}`);
    if (fix) console.log(dim(`    ↳ ${fix}`));
  }
}

// ─── Individual checks ───

function checkNodeVersion(report: Reporter): void {
  try {
    const version = process.versions.node;
    if (isSupportedNodeVersion(version)) {
      pass(report, 'node', `Node.js ${version}`);
    } else {
      fail(report, 'node', `Node.js ${version} — requires >= ${MIN_NODE_MAJOR}`, `Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org)`);
    }
  } catch {
    fail(report, 'node', 'Node.js version check failed', `Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org)`);
  }
}

/**
 * An x64 Node on Apple Silicon (PILOT-559). Tapsmith picks arm64 simulator
 * agents and emulator images anyway, but npm installed the x64 builds of its
 * packages, which run translated, and the prebuilt simulator agent among
 * them cannot run on arm64 simulators. Nothing to say for a native Node.
 */
function checkNodeArch(report: Reporter): void {
  if (!nodeUnderRosetta()) return;
  warn(report, 'node-arch',
    'Node.js is x64, running under Rosetta on Apple Silicon — Tapsmith\'s packages run translated and the prebuilt iOS simulator agent cannot be used',
    ROSETTA_NODE_FIX);
}

/**
 * Yarn Plug'n'Play (PILOT-560): `test`, `verify` and `mcp-server` refuse to
 * run there, so say so before the user gets that far.
 */
function checkYarnPnp(report: Reporter): void {
  if (!isYarnPnp()) return;
  fail(report, 'yarn-pnp', "Yarn Plug'n'Play install — Tapsmith can't run tests from zip archives", YARN_PNP_FIX);
}

function checkDaemonBin(report: Reporter): void {
  try {
    const bin = findDaemonBin();
    pass(report, 'daemon', 'Tapsmith daemon found', bin);
  } catch {
    fail(report, 'daemon', 'Tapsmith daemon not found — try reinstalling: npm install tapsmith', 'Reinstall tapsmith: npm install tapsmith (or set TAPSMITH_DAEMON_BIN)');
  }
}

/**
 * Whether there is a config file, found exactly as `loadConfig` finds it:
 * `-c` when given, else every supported name in the working directory. A
 * `-c` path that does not exist is left to the `config-load` failure.
 */
function checkConfigFile(report: Reporter, configFile: string | undefined, findConfigFile: (dir: string, file?: string) => string | undefined): void {
  try {
    const found = findConfigFile(process.cwd(), configFile);
    if (found && fs.existsSync(found)) {
      pass(report, 'config', 'Config file found', path.relative(process.cwd(), found) || found);
    } else if (!configFile) {
      warn(report, 'config', 'No tapsmith.config.ts (or .js, .mjs) found in current directory', 'Run: npx tapsmith init --yes (or npx tapsmith init for the wizard)');
    }
  } catch {
    warn(report, 'config', 'Could not check for config file');
  }
}

// ─── Android checks ───

/** Passes with the version, or reports the missing adb (see `planPlatforms`) and returns false. */
function checkAdb(report: Reporter, required: boolean, targeted: boolean): boolean {
  const versionOutput = run(report, 'adb', ['--version']);
  if (versionOutput !== undefined) {
    const versionMatch = versionOutput.match(/Version\s+([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    pass(report, 'adb', `ADB ${version}`);
    return true;
  }
  // Install an SDK, install platform-tools, or add them to PATH: whichever is missing.
  const fix = adbMissingFix();
  if (required) fail(report, 'adb', 'ADB not found on PATH', fix);
  else if (targeted) warn(report, 'adb', 'ADB not found on PATH — the config\'s Android projects cannot run on this machine', `${fix}. Meanwhile, select the other projects with --project`);
  else warn(report, 'adb', 'ADB not found on PATH — Android checks skipped', `To test on Android: ${fix}`);
  return false;
}

/** The Android SDK variable doctor reports: ANDROID_HOME, else the older ANDROID_SDK_ROOT. */
export function androidSdkVariable(env: NodeJS.ProcessEnv): { name: string; path: string } | undefined {
  if (env.ANDROID_HOME) return { name: 'ANDROID_HOME', path: env.ANDROID_HOME };
  if (env.ANDROID_SDK_ROOT) return { name: 'ANDROID_SDK_ROOT', path: env.ANDROID_SDK_ROOT };
  return undefined;
}

function checkAndroidHome(report: Reporter): void {
  try {
    const sdk = androidSdkVariable(process.env);
    if (sdk) {
      pass(report, 'android-home', sdk.name, sdk.path);
    } else {
      warn(report, 'android-home', 'ANDROID_HOME not set', 'Set ANDROID_HOME to your Android SDK location');
    }
  } catch {
    warn(report, 'android-home', 'Could not check ANDROID_HOME');
  }
}

export interface AndroidDevicesSummary {
  status: 'pass' | 'warn' | 'fail';
  label: string;
  detail?: string;
  fix?: string;
}

/**
 * Judge `adb devices`: a device adb lists but cannot use (unauthorized,
 * offline, no permissions) is named with its state and the fix, never
 * counted as "no devices" — the inventory lists it, so doctor must too.
 */
export function summarizeAndroidDevices(devices: AdbDevice[]): AndroidDevicesSummary {
  const ready = devices.filter((d) => d.state === 'device');
  const unusable = devices.filter((d) => d.state !== 'device');
  const unusableList = unusable.map((d) => `${d.serial} (${d.state})`).join(', ');
  const readyLabel = `${ready.length} device${ready.length === 1 ? '' : 's'} connected`;
  if (ready.length > 0 && unusable.length === 0) {
    return { status: 'pass', label: readyLabel, detail: ready.map((d) => d.serial).join(', ') };
  }
  if (unusable.length > 0) {
    const fix = unusable.map((d) => androidUnusableDeviceFix(d.state, d.serial)).filter((f, i, arr) => arr.indexOf(f) === i).join('; ');
    // A usable device beside it keeps tests running, so still only a warning;
    // but the broken one is named with its fix — it may be the one wanted.
    return ready.length > 0
      ? { status: 'warn', label: `${readyLabel}, ${unusable.length} not usable`, detail: `${ready.map((d) => d.serial).join(', ')}; not usable: ${unusableList}`, fix }
      : {
        status: 'warn',
        label: `${unusable.length} Android device${unusable.length === 1 ? ' is' : 's are'} attached but not usable`,
        detail: unusableList,
        fix,
      };
  }
  return { status: 'warn', label: 'No Android devices connected', fix: 'Start an emulator or connect a device with USB debugging enabled' };
}

function checkConnectedDevices(report: Reporter): void {
  const output = run(report, 'adb', ['devices']);
  if (output === undefined) {
    warn(report, 'android-devices', 'Could not list Android devices', 'Run `adb devices` to see the error; `adb kill-server` restarts a stuck adb server');
    return;
  }
  const summary = summarizeAndroidDevices(parseAdbDevicesOutput(output));
  if (summary.status === 'pass') pass(report, 'android-devices', summary.label, summary.detail);
  else warn(report, 'android-devices', summary.label, summary.fix, summary.detail);
}

function checkAgentApks(report: Reporter): void {
  try {
    const apk = findAgentApk();
    const testApk = findAgentTestApk();
    if (apk && testApk) {
      pass(report, 'android-agent', 'Android agent', apk.includes(path.join('@tapsmith', 'agent-android')) ? '@tapsmith/agent-android' : 'monorepo build');
    } else if (apk || testApk) {
      warn(report, 'android-agent', 'Android agent incomplete — one APK found but not both', 'npm install @tapsmith/agent-android');
    } else {
      warn(report, 'android-agent', 'Android agent not found — install @tapsmith/agent-android or build from source in agent/', 'npm install @tapsmith/agent-android');
    }
  } catch {
    warn(report, 'android-agent', 'Could not locate Android agent');
  }
}

/** One `app-apk` row for every APK the config installs, so a consumer matching on the id reads the verdict. */
function checkAppApk(report: Reporter, config: TapsmithConfig | undefined, required: boolean): void {
  if (!config) return;
  try {
    const apks = [...new Set(configAndroidApks(config).map((apk) => path.resolve(config.rootDir ?? process.cwd(), apk)))];
    if (apks.length === 0) return;
    const missing = apks.filter((apk) => !fs.existsSync(apk));
    if (missing.length === 0) {
      pass(report, 'app-apk', `App APK${apks.length === 1 ? '' : 's'} exist${apks.length === 1 ? 's' : ''}`, apks.map((apk) => path.basename(apk)).join(', '));
    } else {
      // A mixed config's machine may run only its iOS projects (see planPlatform).
      const mark = required ? fail : warn;
      mark(report, 'app-apk', `App APK not found at ${missing.join(', ')}`, 'Build your app APK, or fix the apk path in your Tapsmith config');
    }
  } catch {
    warn(report, 'app-apk', 'Could not check app APK path');
  }
}

// ─── Emulator binary (PILOT-417) ───

/** An Android scope's AVD and whether Tapsmith will launch it (`launchEmulators`, on by default with `avd`). */
export interface AvdLaunch {
  avd: string;
  launch: boolean;
}

/**
 * Judge the emulator binary for the configured AVDs. Missing is a failure
 * when Tapsmith will launch one — the run would otherwise wait out the boot
 * timeout for a process that never started — and a warning when only an
 * already-running emulator is used (`launchEmulators: false`), or when this
 * machine is not expected to run the Android projects (`required` false).
 */
export function summarizeEmulatorBinary(bin: EmulatorBinary, avds: AvdLaunch[], required: boolean): AndroidDevicesSummary {
  if (bin.found) {
    return { status: 'pass', label: 'Android emulator found', detail: path.isAbsolute(bin.command) ? bin.command : `${bin.command} (on PATH)` };
  }
  const launched = avds.filter((a) => a.launch).map((a) => a.avd);
  const names = [...new Set((launched.length > 0 ? launched : avds.map((a) => a.avd)))].join(', ');
  const detail = `tried: ${bin.tried.join(', ')}`;
  const fix = emulatorNotFoundMessage(bin.tried);
  if (launched.length === 0) {
    return { status: 'warn', label: `Android emulator not found — only an already-running emulator of ${names} can be used (launchEmulators is off)`, detail, fix };
  }
  return { status: required ? 'fail' : 'warn', label: `Android emulator not found — Tapsmith cannot launch ${names}`, detail, fix };
}

function checkEmulatorBinary(report: Reporter, avds: AvdLaunch[], required: boolean): void {
  if (avds.length === 0) return;
  try {
    const summary = summarizeEmulatorBinary(resolveEmulatorBinary(), avds, required);
    if (summary.status === 'pass') pass(report, 'android-emulator', summary.label, summary.detail);
    else if (summary.status === 'warn') warn(report, 'android-emulator', summary.label, summary.fix, summary.detail);
    else fail(report, 'android-emulator', summary.label, summary.fix, summary.detail);
  } catch {
    warn(report, 'android-emulator', 'Could not check for the Android emulator');
  }
}

// ─── AVD system image check ───

export interface AvdImageSummary {
  status: 'pass' | 'warn';
  label: string;
  detail?: string;
  fix?: string;
}

/**
 * Judge the scanned AVDs for HTTPS-capture capability.
 *
 * When the tapsmith config names an `avd`, that AVD is what test runs will
 * actually boot, so the verdict follows it: a capture-capable configured AVD
 * passes even if unrelated Play-image AVDs exist on the machine (they're
 * mentioned as context, not warned about). Without a configured AVD, any
 * Play-image AVD produces a warning since Tapsmith may pick up a matching
 * running emulator.
 */
export function summarizeAvdImages(avds: AvdImageInfo[], configuredAvd?: string | string[]): AvdImageSummary | undefined {
  const playStore = avds.filter((a) => avdCaptureSupport(a) === 'play-image');
  const unreadable = avds.filter((a) => avdCaptureSupport(a) === 'unknown');

  const configuredNames = (Array.isArray(configuredAvd) ? configuredAvd : configuredAvd ? [configuredAvd] : [])
    .filter((name, i, arr) => arr.indexOf(name) === i);
  // With no AVDs and nothing configured there is nothing to judge — but a
  // configured AVD on an AVD-less machine must still be reported as missing.
  if (avds.length === 0 && configuredNames.length === 0) return undefined;
  if (configuredNames.length > 0) {
    const missing = configuredNames.filter((name) => !avds.some((a) => a.name === name));
    const configured = avds.filter((a) => configuredNames.includes(a.name));
    const configuredPlay = configured.filter((a) => avdCaptureSupport(a) === 'play-image');
    const configuredUnreadable = configured.filter((a) => avdCaptureSupport(a) === 'unknown');
    const issues: string[] = [
      ...missing.map((name) => `Configured AVD ${name} not found on this machine`),
      ...configuredPlay.map((a) => `Configured AVD ${a.name} uses a Google Play system image — ${PLAY_IMAGE_CAPTURE_EFFECT}`),
      ...configuredUnreadable.map((a) => `Could not read the system image tag of configured AVD ${a.name}`),
    ];
    if (issues.length > 0) {
      // Every fix is non-destructive (PILOT-404): a missing AVD is created
      // under its configured name (nothing exists to overwrite), and an
      // existing AVD that can't capture is never recreated in place — that
      // would wipe its data — so the fix points `avd` elsewhere instead.
      const fixes: string[] = [];
      if (missing.length > 0) fixes.push(`Run: ${missing.map((name) => `npx tapsmith create-avd --name ${name}`).join(' && ')}`);
      const bad = [...configuredPlay, ...configuredUnreadable];
      if (bad.length > 0) {
        fixes.push(captureAvdFix(avds, { replacing: bad.map((a) => a.name), apiLevel: bad[0].apiLevel, reserved: missing }));
      }
      return {
        status: 'warn',
        label: issues.join('; '),
        fix: fixes.join('; '),
      };
    }
    const otherPlay = playStore.filter((a) => !configuredNames.includes(a.name));
    const context = otherPlay.length > 0
      ? `; ${otherPlay.length} other AVD${otherPlay.length === 1 ? '' : 's'} on this machine use${otherPlay.length === 1 ? 's' : ''} a Play image (${otherPlay.map((a) => a.name).join(', ')})`
      : '';
    const tags = configured.map((a) => a.tagId).filter((t, i, arr) => arr.indexOf(t) === i).join(', ');
    return {
      status: 'pass',
      label: `Configured AVD${configuredNames.length === 1 ? '' : 's'} ${configuredNames.join(', ')} support${configuredNames.length === 1 ? 's' : ''} HTTPS capture`,
      detail: `${tags}${context}`,
    };
  }

  if (playStore.length > 0) {
    const capable = avds.length - playStore.length - unreadable.length;
    const context = capable > 0 ? `; ${capable} other AVD${capable === 1 ? ' is' : 's are'} capture-capable` : '';
    return {
      status: 'warn',
      label: `${playStore.length} of ${avds.length} AVD${avds.length === 1 ? '' : 's'} use${playStore.length === 1 ? 's' : ''} a Google Play system image — ${PLAY_IMAGE_CAPTURE_EFFECT}`,
      detail: `${playStore.map((a) => a.name).join(', ')}${context}`,
      fix: captureAvdFix(avds, { apiLevel: playStore[0].apiLevel }),
    };
  }

  // Don't silently vouch for AVDs whose config.ini couldn't be read.
  const detail = unreadable.length > 0
    ? `${avds.length - unreadable.length} of ${avds.length} AVDs verified — could not read: ${unreadable.map((a) => a.name).join(', ')}`
    : `${avds.length} AVD${avds.length === 1 ? '' : 's'} checked`;
  return { status: 'pass', label: 'AVD system images support HTTPS capture', detail };
}

function checkAvdImages(report: Reporter, configuredAvd?: string | string[]): void {
  try {
    const summary = summarizeAvdImages(scanAvdImageTags(), configuredAvd);
    if (!summary) return;
    if (summary.status === 'pass') {
      pass(report, 'avd-images', summary.label, summary.detail);
    } else {
      warn(report, 'avd-images', summary.label, summary.fix, summary.detail);
    }
  } catch {
    warn(report, 'avd-images', 'Could not check AVD system images');
  }
}

// ─── No usable platform ───

/** The machine has neither platform's toolchain, so no test can run (PILOT-558). */
function checkNoPlatform(report: Reporter): void {
  if (process.platform === 'darwin') {
    fail(report, 'no-platform', 'Neither Android nor iOS tests can run on this machine: ADB is not on PATH and Xcode is not installed',
      `Set up at least one. Android: ${adbMissingFix()}. iOS: ${XCODE_FIX}`);
  } else {
    fail(report, 'no-platform', 'Android tests cannot run on this machine, and iOS testing needs macOS: ADB is not on PATH',
      adbMissingFix());
  }
}

// ─── iOS checks ───

/** Passes with the version, or reports the missing Xcode (see `planPlatforms`) and returns false. */
function checkXcode(report: Reporter, required: boolean, targeted: boolean): boolean {
  const output = run(report, 'xcodebuild', ['-version']);
  if (output !== undefined) {
    const versionMatch = output.match(/Xcode\s+(\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    pass(report, 'xcode', `Xcode ${version}`);
    return true;
  }
  if (required) fail(report, 'xcode', 'Xcode not installed', XCODE_FIX);
  else if (targeted) warn(report, 'xcode', 'Xcode not installed — the config\'s iOS projects cannot run on this machine', `${XCODE_FIX}. Meanwhile, select the other projects with --project`);
  else warn(report, 'xcode', 'Xcode not installed — iOS checks skipped', `To test on iOS: ${XCODE_FIX}`);
  return false;
}

function checkSimctl(report: Reporter, required: boolean): void {
  if (run(report, 'xcrun', ['simctl', 'list', 'devices', 'available', '-j']) !== undefined) {
    pass(report, 'simctl', 'iOS simulators available');
    return;
  }
  // It fails for a missing command-line tools install, but also for a slow or
  // wedged CoreSimulator, so the fix starts with seeing the real error.
  const label = 'xcrun simctl failed or timed out';
  const fix = 'Run: xcrun simctl list devices to see the error (xcode-select --install if the command-line tools are missing)';
  if (required) fail(report, 'simctl', label, fix);
  else warn(report, 'simctl', label, fix);
}

async function checkSimulatorXctestrun(report: Reporter): Promise<void> {
  try {
    const { findSimulatorXctestrun, extractSdkVersion, getInstalledSimulatorSdkVersion } = await import('./ios-device-resolve.js');
    const found = findSimulatorXctestrun();
    if (!found) {
      // The first simulator run builds it (ensureSimulatorAgent); the npm
      // package is an optional dependency for Node's arch only, so under
      // Rosetta npm cannot install the arm64 one the simulators need.
      const skip = nodeUnderRosetta()
        ? 'To skip the build, use an arm64 Node (see the Node.js warning above)'
        : `To skip the build: npm install @tapsmith/agent-ios-simulator-${hostArch()}`;
      warn(report, 'ios-sim-agent', 'No simulator xctestrun found', `Nothing to run now: your first iOS simulator test run builds it from source (a few minutes, needs Xcode). ${skip}`);
      return;
    }

    const xctestrunSdk = extractSdkVersion(found);
    const sdkLabel = xctestrunSdk ? `, SDK ${xctestrunSdk}` : '';
    const source = found.includes(path.join('.tapsmith', 'ios-simulator-agent'))
      ? 'auto-build cache'
      : found.includes('agent-ios-simulator')
        ? '@tapsmith/agent-ios-simulator'
        : 'DerivedData';
    const installedSdk = getInstalledSimulatorSdkVersion();

    if (installedSdk && xctestrunSdk && xctestrunSdk !== installedSdk) {
      warn(report, 'ios-sim-agent', `Simulator xctestrun built for iOS ${xctestrunSdk} but installed SDK is ${installedSdk} — will auto-build on first test run`);
    } else {
      pass(report, 'ios-sim-agent', 'Simulator xctestrun found', `${source}${sdkLabel}`);
    }
  } catch {
    warn(report, 'ios-sim-agent', 'Could not check for simulator xctestrun');
  }
}

// ─── Network Capture checks ───

function checkMitmCa(report: Reporter): void {
  try {
    const caPath = path.join(os.homedir(), '.tapsmith', 'ca.pem');
    if (fs.existsSync(caPath)) {
      pass(report, 'mitm-ca', 'MITM CA exists', '~/.tapsmith/ca.pem');
    } else {
      // Nothing to do: the daemon creates ~/.tapsmith/ca.pem the first time
      // it captures traffic, on either platform.
      pass(report, 'mitm-ca', 'MITM CA not created yet', 'created automatically on the first run with network capture');
    }
  } catch {
    warn(report, 'mitm-ca', 'Could not check for MITM CA');
  }
}

/**
 * Where the daemon will find mitmproxy's `Mitmproxy Redirector.app`, checked
 * in the daemon's own order (`resolve_redirector_path` in ios_redirect.rs),
 * so a pip/pipx install that unpacked the redirector is not reported
 * missing. Undefined when none of them has it.
 */
export function findMitmRedirector(
  env: NodeJS.ProcessEnv,
  homedir: string,
  exists: (p: string) => boolean,
  listDir: (dir: string) => string[],
): string | undefined {
  if (env.TAPSMITH_REDIRECTOR_APP && exists(env.TAPSMITH_REDIRECTOR_APP)) return 'TAPSMITH_REDIRECTOR_APP';
  const bin = path.join('Mitmproxy Redirector.app', 'Contents', 'MacOS', 'Mitmproxy Redirector');
  if (exists(path.join('/Applications', bin))) return '/Applications';
  if (exists(path.join(homedir, '.tapsmith', 'redirector', bin))) return '~/.tapsmith/redirector';
  // The daemon extracts the redirector from the tarball inside the Homebrew
  // cask on first use (`find_brew_tarball`), so look for that tarball rather
  // than trusting `brew list`.
  const tarball = path.join('mitmproxy.app', 'Contents', 'Resources', 'mitmproxy_macos', 'Mitmproxy Redirector.app.tar');
  for (const caskroom of ['/opt/homebrew/Caskroom/mitmproxy', '/usr/local/Caskroom/mitmproxy']) {
    if (listDir(caskroom).some((version) => exists(path.join(caskroom, version, tarball)))) return 'Homebrew cask';
  }
  return undefined;
}

function checkMitmproxy(report: Reporter): void {
  try {
    const listDir = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    };
    const source = findMitmRedirector(process.env, os.homedir(), fs.existsSync, listDir);
    if (source) {
      pass(report, 'mitmproxy', 'mitmproxy installed', source);
    } else {
      warn(report, 'mitmproxy', 'mitmproxy redirector not found — needed for iOS simulator network capture', 'Run: brew install mitmproxy');
    }
  } catch {
    warn(report, 'mitmproxy', 'Could not check for mitmproxy');
  }
}

function checkNetworkExtension(report: Reporter): void {
  try {
    const output = execFileSync('systemextensionsctl', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bundleId = 'org.mitmproxy.macos-redirector.network-extension';
    if (output.includes(bundleId) && output.includes('[activated enabled]')) {
      pass(report, 'network-extension', 'Network Extension enabled');
    } else if (output.includes(bundleId)) {
      warn(report, 'network-extension', 'Network Extension found but not fully enabled — check System Settings → General → Login Items & Extensions → Network Extensions', 'Run: npx tapsmith ios network setup-simulator, then enable it in System Settings → General → Login Items & Extensions → Network Extensions');
    } else {
      warn(report, 'network-extension', 'Network Extension not installed — required for iOS network capture', 'It registers on your first iOS simulator test run with network capture; approve it then. Run: npx tapsmith ios network setup-simulator for the steps');
    }
  } catch {
    warn(report, 'network-extension', 'Could not check Network Extension status');
  }
}

// ─── macOS system proxy (PILOT-319) ───

/** One service's `networksetup -getwebproxy` / `-getsecurewebproxy` reading. */
export interface ServiceProxySetting {
  service: string
  kind: 'HTTP' | 'HTTPS'
  enabled: boolean
  server: string
  port: number
}

/** `~/.tapsmith/ios-system-proxy.json`, written by the daemon that holds the fallback. */
export interface SystemProxyOwnerRecord {
  pid: number
  port: number
  service: string
  /** Owner's `ps -o lstart=` start time; absent in records from older daemons. */
  started?: string
}

export function parseNetworksetupProxy(stdout: string): { enabled: boolean; server: string; port: number } {
  const field = (name: string): string =>
    stdout.split('\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '';
  return {
    enabled: field('Enabled').toLowerCase() === 'yes',
    server: field('Server'),
    port: Number.parseInt(field('Port'), 10) || 0,
  };
}

export type SystemProxyAssessment =
  | { status: 'pass'; label: string; detail?: string }
  | { status: 'warn'; label: string; fix: string };

/**
 * Judge the host's system proxy. Tapsmith's iOS fallback points the active
 * service at `127.0.0.1:<port>`; a daemon killed before shutdown leaves that
 * behind, and every app on the Mac then fails to connect until it's cleared.
 */
export function assessSystemProxy(
  settings: ServiceProxySetting[],
  record: SystemProxyOwnerRecord | undefined,
  ownerAlive: boolean,
): SystemProxyAssessment {
  const enabled = settings.filter((s) => s.enabled);
  const loopback = enabled.filter((s) => s.server === '127.0.0.1' || s.server === 'localhost');
  if (loopback.length === 0) {
    if (enabled.length > 0) {
      const s = enabled[0];
      return { status: 'pass', label: `macOS system proxy is ${s.server}:${s.port} on ${s.service}`, detail: 'not set by Tapsmith; the iOS fallback will not overwrite it' };
    }
    return { status: 'pass', label: 'macOS system proxy not set by Tapsmith' };
  }
  // The daemon always writes 127.0.0.1, so a `localhost` entry is never its.
  const ours = (s: ServiceProxySetting): boolean =>
    !!record && s.server === '127.0.0.1' && record.service === s.service && record.port === s.port;
  if (record && ownerAlive && loopback.every(ours)) {
    return { status: 'pass', label: 'macOS system proxy in use by a running Tapsmith daemon', detail: `pid ${record.pid}, iOS fallback` };
  }
  // A live daemon's own entries are never reported or offered for switching
  // off — only the others, even when both kinds are present.
  const flagged = record && ownerAlive ? loopback.filter((s) => !ours(s)) : loopback;
  return assessFlagged(flagged, flagged.every(ours));
}

function assessFlagged(loopback: ServiceProxySetting[], allOurs: boolean): SystemProxyAssessment {
  // One command per flagged (service, kind): turning off both kinds per
  // service would also switch off a live daemon's entry on the same service.
  const fix = [...new Set(loopback.map((s) =>
    `networksetup -${s.kind === 'HTTP' ? 'setwebproxystate' : 'setsecurewebproxystate'} "${s.service}" off`))]
    .join(' && ');
  const where = loopback.map((s) => `${s.kind} ${s.server}:${s.port} on ${s.service}`).join(', ');
  if (allOurs) {
    return {
      status: 'warn',
      label: `macOS system proxy left behind by an exited Tapsmith daemon (${where}) — host traffic is being sent to a dead port. The next Tapsmith run resets it automatically`,
      fix: `Run: ${fix}`,
    };
  }
  return {
    status: 'warn',
    label: `macOS system proxy points at ${where}, which Tapsmith does not own. If an earlier Tapsmith run left it behind, turn it off; if it is another local proxy (Charles, Proxyman), the iOS system-proxy fallback will refuse to run while it is set`,
    fix: `Run: ${fix}`,
  };
}

function listNetworkServices(): string[] {
  const out = execFileSync('/usr/sbin/networksetup', ['-listallnetworkservices'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  return out
    .split('\n')
    .slice(1) // "An asterisk (*) denotes that a network service is disabled."
    .map((l) => l.replace(/^\*/, '').trim())
    .filter(Boolean);
}

function readServiceProxy(service: string, kind: 'HTTP' | 'HTTPS'): ServiceProxySetting {
  const flag = kind === 'HTTP' ? '-getwebproxy' : '-getsecurewebproxy';
  const out = execFileSync('/usr/sbin/networksetup', [flag, service], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  return { service, kind, ...parseNetworksetupProxy(out) };
}

function readOwnerRecord(): SystemProxyOwnerRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.tapsmith', 'ios-system-proxy.json'), 'utf-8')) as Partial<SystemProxyOwnerRecord>;
    if (typeof raw.pid === 'number' && typeof raw.port === 'number' && typeof raw.service === 'string') {
      return {
        pid: raw.pid, port: raw.port, service: raw.service,
        started: typeof raw.started === 'string' ? raw.started : undefined,
      };
    }
  } catch { /* no record */ }
  return undefined;
}

/**
 * Whether the record's owner is still running — the same process, not one
 * that reused its pid after the owner was killed (that must still read as
 * "left behind"). Mirrors the daemon's check: the recorded start time must
 * match, falling back to the process name for records without one. A `ps`
 * failure on a live pid counts as live, as in the daemon, so doctor never
 * tells the user to switch off a running daemon's proxy.
 */
function isLiveOwner(record: SystemProxyOwnerRecord): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const ps = (field: string): string | undefined => {
    try {
      return execFileSync('/bin/ps', ['-p', String(record.pid), '-o', `${field}=`], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
        // Same zone and locale the daemon records `started` in.
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      }).trim();
    } catch {
      return undefined;
    }
  };
  if (record.started) {
    const started = ps('lstart');
    return started === undefined || started === record.started;
  }
  const comm = ps('comm');
  return comm === undefined || comm.includes('tapsmith');
}

function checkSystemProxy(report: Reporter): void {
  try {
    const settings: ServiceProxySetting[] = [];
    for (const service of listNetworkServices()) {
      try {
        settings.push(readServiceProxy(service, 'HTTP'));
      } catch { /* service without proxy settings (e.g. some VPNs) */ }
      try {
        settings.push(readServiceProxy(service, 'HTTPS'));
      } catch { /* read independently: one failing must not drop the other */ }
    }
    const record = readOwnerRecord();
    const result = assessSystemProxy(settings, record, record ? isLiveOwner(record) : false);
    if (result.status === 'pass') pass(report, 'system-proxy', result.label, result.detail);
    else warn(report, 'system-proxy', result.label, result.fix);
  } catch {
    warn(report, 'system-proxy', 'Could not check the macOS system proxy');
  }
}

// ─── Main entry point ───

/**
 * How doctor reports a config that `loadConfig` rejected.
 *
 * Always a failure: `tapsmith test` exits on the same error. There is no
 * "no config file" case to filter out — without one `loadConfig` returns the
 * defaults instead of rejecting — so an error that merely mentions ENOENT (a
 * config reading a missing file at the top level) is a real one too.
 *
 * @internal — exported for unit testing.
 */
export function configLoadFailure(err: unknown): { message: string; hint: string } {
  // A config written by `npx tapsmith init` in a project without Tapsmith
  // (PILOT-551): the fix is the install, not the config.
  if (isTapsmithNotInstalledError(err)) {
    return {
      message: `Tapsmith isn't installed in this project (${err.configPath} imports it)${err.installCommand.note ? `. ${err.installCommand.note}` : ''}`,
      hint: `Run: ${err.installCommand.display}`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('Config file not found')) {
    return { message, hint: 'Check the -c/--config path' };
  }
  return {
    message: `Config file has errors: ${message}`,
    hint: 'Fix the config error above; tapsmith test stops on it too',
  };
}

export interface DoctorDeps {
  /** Runs every check, printing them unless `json`; swapped out by tests. */
  report: (opts: { json: boolean; config?: string }) => Promise<DoctorJson>;
  stdout: (text: string) => void;
}

/**
 * Runs the command and returns the process exit code: 1 when a check fails.
 * Under --json, stdout is the report, or — when doctor itself breaks — the
 * shared error envelope, never nothing.
 */
export async function runDoctor(opts: { json: boolean; config?: string }, overrides: Partial<DoctorDeps> = {}): Promise<number> {
  const deps: DoctorDeps = {
    report: doctorReport,
    stdout: (text) => { process.stdout.write(text); },
    ...overrides,
  };
  // Text mode lets an unexpected error reach the CLI's fatal-error handler,
  // stack and all.
  if (!opts.json) return (await deps.report(opts)).ok ? 0 : 1;
  let result: DoctorJson;
  try {
    result = await deps.report(opts);
  } catch (err) {
    deps.stdout(formatJson(jsonError(
      'UNEXPECTED_ERROR',
      `doctor could not finish: ${err instanceof Error ? err.message : String(err)}`,
      { fix: 'To see the full error, run the same command again without --json' },
    )));
    return 1;
  }
  deps.stdout(formatJson(result));
  return result.ok ? 0 : 1;
}

// ─── Platform gating ───

export type DoctorPlatform = 'android' | 'ios';

type PlatformScope = Pick<TapsmithConfig, 'platform' | 'app' | 'simulator' | 'iosXctestrun' | 'apk'>;
type PlatformConfig = PlatformScope & { projects?: Array<{ name?: string; use?: Partial<PlatformScope> }> };

/**
 * What each test scope runs with: every project's `use` over the root, or
 * the root alone when there are no projects (the root itself runs nothing
 * then, as in the runner).
 */
function platformScopes(config: PlatformConfig): Array<{ project?: string; scope: PlatformScope; platform: DoctorPlatform }> {
  const scopes = config.projects && config.projects.length > 0
    ? config.projects.map((p) => ({
      project: p.name,
      scope: {
        platform: p.use?.platform ?? config.platform,
        app: p.use?.app ?? config.app,
        simulator: p.use?.simulator ?? config.simulator,
        iosXctestrun: p.use?.iosXctestrun ?? config.iosXctestrun,
        apk: p.use?.apk ?? config.apk,
      },
    }))
    : [{ project: undefined, scope: config as PlatformScope }];
  return scopes.map(({ project, scope }) => ({ project, scope, platform: scopePlatform(scope) }));
}

/**
 * A scope's platform: its `platform`, else iOS when it sets an iOS-only
 * field (the runner refuses that without `platform: 'ios'` — see
 * `platformlessIosFields` — but the user clearly means iOS), else Android,
 * the runner's default.
 */
function scopePlatform(scope: PlatformScope): DoctorPlatform {
  if (scope.platform) return scope.platform === 'ios' ? 'ios' : 'android';
  if (scope.app != null || scope.simulator != null || scope.iosXctestrun != null) return 'ios';
  return 'android';
}

/** The platforms a loaded config runs tests on. */
export function configPlatformTargets(config: PlatformConfig): Set<DoctorPlatform> {
  return new Set(platformScopes(config).map((s) => s.platform));
}

/**
 * iOS-only fields set without `platform` — the runner refuses those
 * (`resolvePlatformFixture`), so doctor must too, rather than infer iOS and
 * report a config healthy that `tapsmith test` rejects. One entry per scope:
 * the project's name, or undefined for the root.
 */
export function platformlessIosFields(config: PlatformConfig): Array<{ project?: string; fields: string[] }> {
  const iosFields = ['app', 'simulator', 'iosXctestrun'] as const;
  const byOwner = new Map<string | undefined, Set<string>>();
  const projects = config.projects ?? [];
  for (const { project, scope } of platformScopes(config)) {
    if (scope.platform != null) continue;
    for (const field of iosFields) {
      if (scope[field] == null) continue;
      // A field a project inherits is the root's to fix, reported once.
      const own = projects.length === 0 || projects.find((p) => p.name === project)?.use?.[field] != null;
      const owner = own ? project : undefined;
      if (!byOwner.has(owner)) byOwner.set(owner, new Set());
      byOwner.get(owner)!.add(field);
    }
  }
  return [...byOwner].map(([project, fields]) => ({ project, fields: [...fields] }));
}

/** The app APKs the config's Android scopes install, each once (projects' `use.apk` included). */
export function configAndroidApks(config: PlatformConfig): string[] {
  const apks = platformScopes(config)
    .filter((s) => s.platform === 'android' && s.scope.apk)
    .map((s) => s.scope.apk as string);
  return [...new Set(apks)];
}

/**
 * Whether a platform's section runs, and what a missing toolchain costs.
 *
 * - The config targets only it: run, and a missing adb / Xcode is a
 *   failure — `tapsmith test` cannot run anything. iOS on a non-Mac too.
 * - The config targets it and another platform: run, but a missing
 *   toolchain is a warning — this machine can still run the other
 *   platform's projects (`--project`), as a Linux Android CI job does with
 *   a mixed config — unless that other platform cannot run either.
 * - A loaded config does not target it: skip, with a note saying why.
 * - No usable config (`targets` undefined): judge the machine. A missing
 *   toolchain is one warning ("… checks skipped") with its install fix,
 *   never an exit 1 — nothing says the user wants that platform.
 */
export type PlatformPlan =
  | { run: true; required: boolean }
  | { run: false; note: string };

export function planPlatform(
  platform: DoctorPlatform,
  targets: Set<DoctorPlatform> | undefined,
  host: NodeJS.Platform,
  /** Mixed configs only: whether the config's other platform can run here. */
  otherUsable = false,
): PlatformPlan {
  const name = platform === 'android' ? 'Android' : 'iOS';
  if (targets && !targets.has(platform)) {
    const others = [...targets].map((t) => (t === 'android' ? 'Android' : 'iOS')).join(' and ');
    return { run: false, note: `skipped: the config targets ${others} only` };
  }
  if (platform === 'ios' && host !== 'darwin' && !targets) {
    return { run: false, note: `skipped: ${name} testing needs macOS` };
  }
  // A mixed config is only let off when the other platform can run: a
  // machine that runs neither of its platforms must still fail.
  return { run: true, required: !!targets && (targets.size === 1 || !otherUsable) };
}

async function doctorReport(opts: { json: boolean; config?: string }): Promise<DoctorJson> {
  const printing = !opts.json;
  const configFile = opts.config;

  const checks: CheckList = [];
  const report: Reporter = { checks, print: printing, cache: new Map() };

  if (printing) {
    console.log();
    console.log(bold('Tapsmith Doctor'));
  }

  // Load the config the way `tapsmith test` does; it decides which platforms
  // are judged and feeds the APK path and AVD image checks.
  const { loadConfig, findConfigFile, configPathOf, effectiveConfigForProject } = await import('./config.js');
  let config: TapsmithConfig | undefined;
  try {
    config = await loadConfig(undefined, configFile);
  } catch (err) {
    const failure = configLoadFailure(err);
    fail(report, 'config-load', failure.message, failure.hint);
  }

  // Only a config file the user wrote says which platforms they test; the
  // built-in defaults (no file) and a broken config say nothing.
  const targets = config && configPathOf(config) ? configPlatformTargets(config) : undefined;
  const mixed = !!targets && targets.size > 1;
  const adbUsable = (): boolean => run(report, 'adb', ['--version']) !== undefined;
  const xcodeUsable = (): boolean => process.platform === 'darwin' && run(report, 'xcodebuild', ['-version']) !== undefined;
  const androidPlan = planPlatform('android', targets, process.platform, mixed && xcodeUsable());
  const iosPlan = planPlatform('ios', targets, process.platform, mixed && adbUsable());

  // The AVDs each Android scope launches, with the runner's own merge of
  // project `use` over the root (launchEmulators defaults on with an avd).
  // loadConfig rejects a malformed project `use`; should this merge still
  // throw, report that as the config error it is (as `tapsmith test` does),
  // not as doctor crashing.
  const scopes: TapsmithConfig[] = [];
  if (config && configPathOf(config)) {
    if (config.projects && config.projects.length > 0) {
      const projectErrors: string[] = [];
      for (const project of config.projects) {
        try {
          scopes.push(effectiveConfigForProject(config, project));
        } catch (err) {
          projectErrors.push(`project ${project.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // One row, so a consumer matching on the id sees every broken project.
      if (projectErrors.length > 0) {
        fail(report, 'config-load', `Config file has errors: ${projectErrors.join('; ')}`, 'Fix the config error above; tapsmith test stops on it too');
      }
    } else {
      scopes.push(config);
    }
  }
  const avdLaunches: AvdLaunch[] = scopes
    .filter((scope) => scopePlatform(scope) === 'android' && !!scope.avd)
    .map((scope) => ({ avd: scope.avd as string, launch: scope.launchEmulators !== false }));

  // The AVDs Android runs boot — the same list the emulator check judges,
  // so the two never disagree about which AVDs the config uses.
  const configuredAvds = [...new Set(avdLaunches.map((a) => a.avd))];

  // ─── Core ───
  if (printing) {
    console.log();
    console.log(`  ${bold('Core')}`);
  }
  checkNodeVersion(report);
  checkNodeArch(report);
  checkYarnPnp(report);
  checkDaemonBin(report);
  checkConfigFile(report, configFile, findConfigFile);
  // A config's own platforms already fail when none can run (planPlatform);
  // without one, a machine that runs neither must not pass either (PILOT-558).
  const noPlatform = !targets && !adbUsable() && !xcodeUsable();
  if (noPlatform) checkNoPlatform(report);
  if (config && configPathOf(config)) {
    // One row, so a consumer matching on the id sees every offending scope.
    const platformless = platformlessIosFields(config);
    if (platformless.length > 0) {
      const where = platformless.map(({ project, fields }) => `${project ? `project ${project}` : 'the config'} sets ${fields.join(', ')}`);
      const fixes = platformless.map(({ project }) => (project ? `project ${project}'s use` : 'the config'));
      fail(report, 'config-platform', `iOS-only fields without \`platform\` — ${where.join('; ')} — tapsmith test refuses it`,
        `Add platform: 'ios' to ${fixes.join(' and ')}`);
    }
  }

  // ─── Android ───
  if (printing) {
    console.log();
    console.log(`  ${bold('Android')}`);
  }
  let androidChecked = false;
  if (!androidPlan.run) {
    note(report, androidPlan.note);
  } else {
    const adbOk = checkAdb(report, androidPlan.required, !!targets);
    // Without a config asking for Android, a missing adb ends the section:
    // its other checks only matter to someone testing Android. A config
    // that targets Android (even alongside iOS) keeps its APK and AVD checks.
    androidChecked = adbOk || !!targets;
    if (androidChecked) {
      checkAndroidHome(report);
      if (adbOk) checkConnectedDevices(report);
      checkAgentApks(report);
      // With adb here, Android runs on this machine, so its APK must exist.
      checkAppApk(report, config, androidPlan.required || (adbOk && !!targets));
      checkEmulatorBinary(report, avdLaunches, androidPlan.required || adbOk);
    }
  }

  // ─── iOS ───
  if (printing) {
    console.log();
    console.log(`  ${bold('iOS')}`);
  }
  let iosChecked = false;
  if (!iosPlan.run) {
    note(report, iosPlan.note);
  } else if (process.platform !== 'darwin') {
    if (iosPlan.required) {
      fail(report, 'xcode', 'iOS testing needs macOS, and the config targets iOS', 'Run the iOS tests on a Mac with Xcode installed');
    } else {
      warn(report, 'xcode', 'iOS testing needs macOS — the config\'s iOS projects cannot run on this machine', 'Run the iOS projects on a Mac with Xcode installed; select the others here with --project');
    }
  } else {
    iosChecked = true;
    if (checkXcode(report, iosPlan.required, !!targets)) {
      // With Xcode here, the config's iOS projects run on this machine.
      checkSimctl(report, !!targets);
      await checkSimulatorXctestrun(report);
    } else {
      // A config that targets iOS still gets its capture guidance (mitmproxy,
      // Network Extension), as a targeted Android keeps its APK/AVD checks.
      iosChecked = iosPlan.required || !!targets;
    }
  }

  // ─── Network Capture ───
  if (printing) {
    console.log();
    console.log(`  ${bold('Network Capture')}`);
  }
  checkMitmCa(report);
  if (androidChecked) {
    // Filesystem-only, so it runs even when adb is missing: the
    // missing/Play-image diagnosis is still useful.
    checkAvdImages(report, configuredAvds);
  }
  if (process.platform === 'darwin') {
    // mitmproxy and its Network Extension capture iOS simulator traffic only.
    if (iosChecked) {
      checkMitmproxy(report);
      checkNetworkExtension(report);
    }
    // Host health: a left-behind proxy breaks the whole Mac, whatever the project.
    checkSystemProxy(report);
  }

  // ─── Summary ───
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const errors = checks.filter((c) => c.status === 'fail').length;

  if (printing) {
    console.log();
    const parts: string[] = [];
    parts.push(green(`${passed} check${passed === 1 ? '' : 's'} passed`));
    if (warnings > 0) parts.push(yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`));
    if (errors > 0) parts.push(red(`${errors} error${errors === 1 ? '' : 's'}`));
    console.log(parts.join(', ') + (noPlatform ? red(' — no platform can run tests on this machine') : ''));
    console.log();
  }

  // The inventory lists what is on the machine whatever the config targets,
  // reusing the checks' adb/simctl output where they already ran.
  const adbDevices = run(report, 'adb', ['devices']);
  const simctl = process.platform === 'darwin' ? run(report, 'xcrun', ['simctl', 'list', 'devices', 'available', '-j']) : undefined;
  const avdList = tryExec(resolveEmulatorBinary().command, ['-list-avds']);
  const inventory: DoctorInventory = {
    avds: avdList ? avdList.split('\n').map((l) => l.trim()).filter(Boolean) : [],
    simulators: simctl ? parseSimctlDevicesJson(simctl) : [],
    connectedDevices: adbDevices ? parseAdbDevicesOutput(adbDevices) : [],
  };

  return buildDoctorJson(checks, inventory);
}
