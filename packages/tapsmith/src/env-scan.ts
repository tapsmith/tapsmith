/**
 * Shared environment scanning for `tapsmith init` and `tapsmith doctor`.
 */

import { execFileSync } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { rosettaNodeWarning } from './host-arch.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import { scanAvdImageTags, type AvdImageInfo } from './avd-images.js';
import { resolveEmulatorBinary } from './emulator.js';
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
  /** Why an x64 Node under Rosetta is a problem, with the fix; undefined for a native Node (PILOT-559). */
  rosettaWarning: string | undefined;
  daemonBin: string | undefined;
  agentApk: boolean;
  agentTestApk: boolean;
  adbVersion: string | undefined;
  /** With no adb on PATH, the SDK platform-tools directory that has one (PILOT-832). */
  adbOffPath?: string;
  androidHome: string | undefined;
  xcodeVersion: string | undefined;
  simulators: SimulatorInfo[];
  /** AVD names, in `emulator -list-avds` order (empty when the emulator binary is not found). */
  avds: string[];
  /** Each AVD's system image, for judging HTTPS capture (`avdCaptureSupport`). */
  avdImages: AvdImageInfo[];
  isMacOS: boolean;
}

export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
  /**
   * The simulator's device type (`iPhone 16`), when simctl's device type list
   * names it. A simulator whose name differs is a custom one (PILOT-721).
   */
  deviceTypeName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A readable runtime name from a simctl runtime id:
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-5` is `iOS 26.5` (PILOT-562).
 * An id not shaped `<os>-<n>-<n>…` keeps its words, hyphens as spaces.
 */
function simRuntimeName(id: string): string {
  const bare = id.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
  const versioned = /^([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(bare);
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
 * so a custom name resolves only on the Mac that has it (PILOT-721). False
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
 * The simulators init offers, best first (PILOT-562): no Tapsmith worker
 * clones, iOS runtimes only (watchOS, tvOS and visionOS simulators cannot
 * run an iOS app, so with no iOS runtime there is nothing), one per name — a booted one, else the newest
 * runtime's, as the config names a simulator by name and the runner adopts a
 * booted one of that name. Stock-named simulators come before custom-named
 * ones, which only this Mac has (PILOT-721); then a booted simulator, as
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

  return { nodeVersion, rosettaWarning, daemonBin, agentApk, agentTestApk, adbVersion, ...(adbOffPath ? { adbOffPath } : {}), androidHome, xcodeVersion, simulators, avds, avdImages, isMacOS };
}
