/**
 * Shared environment scanning for `tapsmith init` and `tapsmith doctor`.
 */

import { execFileSync } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { rosettaNodeWarning } from './host-arch.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import { scanAvdImageTags, type AvdImageInfo } from './avd-images.js';
import { getRunningAvdName, resolveEmulatorBinary } from './emulator.js';
import { parseAdbDevicesOutput, type AdbDevice } from './adb-devices.js';
import { withoutHeldDevices } from './device-claims.js';
import { adbOffPathDir } from './toolchain.js';

// ─── Helpers ───

export function tryExec(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

// ─── Environment scanning ───

export interface EnvScan {
  nodeVersion: string;
  /** Why an x64 Node under Rosetta is a problem, with the fix; undefined for a native Node. */
  rosettaWarning: string | undefined;
  daemonBin: string | undefined;
  agentApk: boolean;
  agentTestApk: boolean;
  adbVersion: string | undefined;
  /** With no adb on PATH, the SDK platform-tools directory that has one. */
  adbOffPath?: string;
  androidHome: string | undefined;
  xcodeVersion: string | undefined;
  simulators: SimulatorInfo[];
  /** AVD names, in `emulator -list-avds` order (empty when the emulator binary is not found). */
  avds: string[];
  /** Each AVD's system image, for judging HTTPS capture (`avdCaptureSupport`). */
  avdImages: AvdImageInfo[];
  /** Android devices adb can use now (`adb devices` state `device`), in its order. */
  androidDevices: ConnectedAndroidDevice[];
  /** Android devices adb lists but cannot use (unauthorized, offline, …), for init's `--device` errors. */
  unusableAndroidDevices: AdbDevice[];
  isMacOS: boolean;
}

/** A connected Android device, as init offers it. */
export interface ConnectedAndroidDevice {
  serial: string;
  /** An emulator's AVD name; undefined for a physical device, or when it could not be read. */
  avd?: string;
  /** Another live Tapsmith session drives it: init never picks it. */
  held: boolean;
}

/** The AVD names of the running emulators init may pick: not held by another session. */
export function runningAvds(devices: readonly ConnectedAndroidDevice[]): string[] {
  return devices.filter((d) => !d.held && d.avd !== undefined).map((d) => d.avd as string);
}

/**
 * The usable Android devices in `adb devices` output, each emulator with its
 * AVD name (`readAvd`) and each device marked when another session holds it.
 */
export function scanAndroidDevices(
  adbDevicesOutput: string,
  readAvd: (serial: string) => string | undefined = getRunningAvdName,
  heldElsewhere: (serials: string[]) => string[] = (serials) => withoutHeldDevices(serials).held.map((c) => c.device),
): ConnectedAndroidDevice[] {
  const serials = parseAdbDevicesOutput(adbDevicesOutput).filter((d) => d.state === 'device').map((d) => d.serial);
  const held = new Set(heldElsewhere(serials));
  return serials.map((serial) => {
    const avd = serial.startsWith('emulator-') ? readAvd(serial) : undefined;
    return { serial, ...(avd !== undefined ? { avd } : {}), held: held.has(serial) };
  });
}

export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
  /**
   * The simulator's device type (`iPhone 16`), when simctl's device type list
   * names it. A simulator whose name differs is a custom one.
   */
  deviceTypeName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A readable runtime name from a simctl runtime id:
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-5` is `iOS 26.5` (PILOT-562).
 * A device-specific runtime (`iOS-27-2-iPhone19-4`) is named by its version
 * alone. An id not shaped `<os>-<n>-<n>…` keeps its words, hyphens as spaces.
 */
function simRuntimeName(id: string): string {
  const bare = id.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
  // A runtime built for one device model names it after the version
  // (`iOS-27-2-iPhone19-4`): the version is what tells runtimes apart here.
  const versioned = /^([A-Za-z]+)-(\d+(?:-\d+)*)(?:-[A-Za-z][\w-]*)?$/.exec(bare);
  return versioned ? `${versioned[1]} ${versioned[2].replace(/-/g, '.')}` : bare.replace(/-/g, ' ');
}

/**
 * `xcrun simctl list devicetypes -j` as identifier → name
 * (`com.apple.CoreSimulator.SimDeviceType.iPhone-16` → `iPhone 16`).
 */
export function parseSimctlDeviceTypesJson(output: string): Map<string, string> {
  const types = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return types;
  }
  const list = isRecord(data) ? data['devicetypes'] : undefined;
  if (!Array.isArray(list)) return types;
  for (const t of list) {
    if (isRecord(t) && typeof t['name'] === 'string' && typeof t['identifier'] === 'string') types.set(t['identifier'], t['name']);
  }
  return types;
}

/**
 * Whether a simulator has a name of its own rather than its device type's
 * (`PersonaA iPhone`, an `iPhone 16`). The config names a simulator by name,
 * so a custom name resolves only on the Mac that has it. False
 * when the device type is unknown: nothing can be said.
 */
export function isCustomSimulatorName(sim: SimulatorInfo): boolean {
  return sim.deviceTypeName !== undefined && sim.name !== sim.deviceTypeName;
}

export function parseSimctlDevicesJson(output: string, deviceTypes: Map<string, string> = new Map()): SimulatorInfo[] {
  const simulators: SimulatorInfo[] = [];
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return simulators;
  }

  const devices = isRecord(data) ? data['devices'] : undefined;
  if (!isRecord(devices)) return simulators;

  for (const [runtime, devs] of Object.entries(devices)) {
    if (!Array.isArray(devs)) continue;
    for (const device of devs) {
      if (!isRecord(device)) continue;
      const runtimeName = simRuntimeName(runtime);
      const typeId = device['deviceTypeIdentifier'];
      const deviceTypeName = typeof typeId === 'string' ? deviceTypes.get(typeId) : undefined;
      simulators.push({
        name: typeof device['name'] === 'string' ? device['name'] : '',
        udid: typeof device['udid'] === 'string' ? device['udid'] : '',
        state: typeof device['state'] === 'string' ? device['state'] : '',
        runtime: runtimeName,
        ...(deviceTypeName !== undefined ? { deviceTypeName } : {}),
      });
    }
  }
  return simulators;
}

// ─── Simulator choice (PILOT-562) ───

/**
 * The simulators init offers, best first: no Tapsmith worker
 * clones, iOS runtimes only (watchOS, tvOS and visionOS simulators cannot
 * run an iOS app, so with no iOS runtime there is nothing), one per name — a booted one, else the newest
 * runtime's, as the config names a simulator by name and the runner adopts a
 * booted one of that name. Stock-named simulators come before custom-named
 * ones, which only this Mac has; then a booted simulator, as
 * choosing it avoids a boot, then iPhones, then the rest, each newest runtime
 * first and in simctl's order within a runtime. The wizard lists them all
 * with the first selected, and `init --yes` picks the first.
 */
export function simulatorChoices(simulators: SimulatorInfo[]): SimulatorInfo[] {
  // Not the `<name> (Tapsmith Worker N)` clones parallel runs make: they
  // come and go with runs, and the config names the simulator they clone.
  const ios = simulators.filter((s) => /^iOS\b/.test(s.runtime) && !/ \(Tapsmith Worker \d+\)$/.test(s.name));
  const byName = new Map<string, SimulatorInfo>();
  for (const sim of ios) {
    const existing = byName.get(sim.name);
    if (!existing || rank(sim, existing) < 0) byName.set(sim.name, sim);
  }
  return [...byName.values()].sort((a, b) =>
    Number(isCustomSimulatorName(a)) - Number(isCustomSimulatorName(b))
    || Number(b.state === 'Booted') - Number(a.state === 'Booted')
    || Number(b.name.startsWith('iPhone')) - Number(a.name.startsWith('iPhone'))
    || newestFirst(a, b));
}

/**
 * {@link simulatorChoices} as the wizard lists them: a booted custom-named
 * simulator moves up to sit after the booted stock ones (or after the
 * default, when none is booted), so the simulator someone is already using
 * is a keypress away rather than at the end of a long list. The first choice,
 * which the wizard selects and `init --yes` takes, is unchanged: a stock one,
 * or with none, the booted custom one, already first.
 */
export function simulatorPickerChoices(simulators: SimulatorInfo[]): SimulatorInfo[] {
  const choices = simulatorChoices(simulators);
  if (choices.length === 0 || isCustomSimulatorName(choices[0])) return choices;
  const bootedCustom = choices.filter((s) => s.state === 'Booted' && isCustomSimulatorName(s));
  const rest = choices.filter((s) => !bootedCustom.includes(s));
  const firstUnbooted = rest.findIndex((s) => s.state !== 'Booted');
  const at = Math.max(1, firstUnbooted === -1 ? rest.length : firstUnbooted);
  return [...rest.slice(0, at), ...bootedCustom, ...rest.slice(at)];
}

/**
 * The simulator init proposes from `choices` ({@link simulatorChoices} or
 * {@link simulatorPickerChoices}): the first, unless a booted simulator has
 * the app installed and the first does not — that is the one the developer
 * is already using (PILOT-1517). Only booted simulators are asked about, and
 * nobody when the first choice is the only one booted, so `hasApp` (a simctl
 * lookup) runs only when there is a choice to make.
 */
export function preferredSimulator(
  choices: SimulatorInfo[],
  hasApp: (sim: SimulatorInfo) => boolean,
): SimulatorInfo | undefined {
  const first = choices[0];
  if (!first) return undefined;
  const otherBooted = choices.filter((s) => s !== first && s.state === 'Booted');
  if (otherBooted.length === 0) return first;
  if (first.state === 'Booted' && hasApp(first)) return first;
  return otherBooted.find(hasApp) ?? first;
}

/**
 * What `init --yes` says when a simulator other than the one it picked is
 * booted (PILOT-1517): the runner adopts a booted simulator of the configured
 * name, so a pick the developer did not mean drives someone else's simulator,
 * or boots a second one beside theirs. Names every booted simulator, which one
 * the config names and why, and how to choose another. Undefined when the
 * pick is the only booted simulator, or none is booted.
 */
export function bootedSimulatorsNote(
  choices: SimulatorInfo[],
  picked: SimulatorInfo,
  opts: { appInstalled?: string; rerun: string },
): string | undefined {
  const booted = choices.filter((s) => s.state === 'Booted');
  if (booted.every((s) => s === picked)) return undefined;
  const list = booted.map((s) => `'${s.name}' (${s.udid}, ${s.runtime})`).join(', ');
  const how = `To use another, re-run \`${opts.rerun}\` with any other flags you passed this time.`;
  if (picked.state !== 'Booted') {
    return `${list} ${booted.length === 1 ? 'is' : 'are'} booted, but the config names '${picked.name}', which is not: tests boot it instead. ${how}`;
  }
  const why = opts.appInstalled ? `, the one ${opts.appInstalled} is installed on` : '';
  return `${booted.length} iOS simulators are booted: ${list}; the config names '${picked.name}'${why}. ${how}`;
}

/** Booted first, then the newer runtime. */
function rank(a: SimulatorInfo, b: SimulatorInfo): number {
  return Number(b.state === 'Booted') - Number(a.state === 'Booted') || newestFirst(a, b);
}

function newestFirst(a: SimulatorInfo, b: SimulatorInfo): number {
  return b.runtime.localeCompare(a.runtime, undefined, { numeric: true });
}

export function scanEnvironment(): EnvScan {
  const isMacOS = process.platform === 'darwin';
  const nodeVersion = process.versions.node;
  const rosettaWarning = rosettaNodeWarning();

  let daemonBin: string | undefined;
  try {
    daemonBin = findDaemonBin();
  } catch {
    // not found
  }

  const agentApk = !!findAgentApk();
  const agentTestApk = !!findAgentTestApk();

  let adbVersion: string | undefined;
  const adbOut = tryExec('adb', ['--version']);
  if (adbOut) {
    const match = adbOut.match(/Version\s+([\d.]+)/);
    adbVersion = match?.[1] ?? 'installed';
  }

  const adbOffPath = adbVersion ? undefined : adbOffPathDir();
  const androidHome = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];

  let xcodeVersion: string | undefined;
  if (isMacOS) {
    const xcOut = tryExec('xcodebuild', ['-version']);
    if (xcOut) {
      const match = xcOut.match(/Xcode\s+([\d.]+)/);
      xcodeVersion = match?.[1] ?? 'installed';
    }
  }

  const simulators: SimulatorInfo[] = [];
  if (isMacOS) {
    const simOut = tryExec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    if (simOut) {
      const typesOut = tryExec('xcrun', ['simctl', 'list', 'devicetypes', '-j']);
      simulators.push(...parseSimctlDevicesJson(simOut, typesOut ? parseSimctlDeviceTypesJson(typesOut) : undefined));
    }
  }

  let avds: string[] = [];
  const avdOut = tryExec(resolveEmulatorBinary().command, ['-list-avds']);
  if (avdOut) {
    avds = avdOut.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  const avdImages = scanAvdImageTags();

  const adbDevicesOut = adbVersion ? tryExec('adb', ['devices']) : undefined;
  const androidDevices = adbDevicesOut ? scanAndroidDevices(adbDevicesOut) : [];
  const unusableAndroidDevices = adbDevicesOut ? parseAdbDevicesOutput(adbDevicesOut).filter((d) => d.state !== 'device') : [];

  return { nodeVersion, rosettaWarning, daemonBin, agentApk, agentTestApk, adbVersion, ...(adbOffPath ? { adbOffPath } : {}), androidHome, xcodeVersion, simulators, avds, avdImages, androidDevices, unusableAndroidDevices, isMacOS };
}
