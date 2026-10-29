/**
 * Emulator lifecycle management for parallel test execution.
 *
 * Provides utilities to discover AVDs, launch emulators on specific ports,
 * wait for boot, and clean up on exit. Used by the dispatcher when
 * `avd` is configured to auto-provision devices for workers.
 */

import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { isCI as runningInCi } from 'ci-info';
import lockfile from 'proper-lockfile';
import type { DeviceStrategy, EmulatorLaunchOptions } from './config.js';
import { decodeXmlEntities } from './xml-entities.js';
import { parseAdbDevicesOutput } from './adb-devices.js';
import { devicesHeldElsewhere } from './device-claims.js';
import { describeEmulatorAppNap, disableEmulatorAppNap, type EmulatorAppNapResult } from './emulator-app-nap.js';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const DEVICE_STABILITY_POLL_MS = 2_000;
const DEFAULT_DEVICE_STABILITY_TIMEOUT_MS = 20_000;
const REQUIRED_STABLE_HEALTH_CHECKS = 2;
const POST_BOOT_SETTLE_TIMEOUT_MS = 30_000;
const POST_BOOT_SETTLE_POLL_MS = 2_000;

// ─── Emulator PID manifest ───
//
// Tracks which emulators Tapsmith launched so they can be cleaned up on the next
// run if the previous process died without running its cleanup code.

interface EmulatorManifestEntry {
  serial: string
  pid: number
  avd: string
  port: number
  launchedAt: string
  /**
   * Still booting: recorded at spawn so an interrupted launch is never
   * orphaned, and cleared once it boots healthy. While its
   * launching process (`ownerPid`) lives, no other run touches it.
   */
  booting?: boolean
  /** The Tapsmith process that launched it. */
  ownerPid?: number
  /**
   * Windowed on macOS: whether App Nap was off for it at launch
   * (`disableEmulatorAppNap`). Absent for other launches, and for
   * any launched by a Tapsmith from before it turned App Nap off.
   */
  appNapDisabled?: boolean
}

function manifestPath(): string {
  return path.join(os.tmpdir(), 'tapsmith-emulators.json');
}

// Note: read/write is not atomic. Concurrent Tapsmith runs may race on this file.
// In practice this is rare and the worst case is a stale manifest entry that
// gets cleaned up on the next run via reclaimOrphanedEmulators().
function readManifest(): EmulatorManifestEntry[] {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf-8');
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeManifest(entries: EmulatorManifestEntry[]): void {
  try {
    fs.writeFileSync(manifestPath(), JSON.stringify(entries, null, 2));
  } catch {
    // Best effort — tmp dir might be read-only in exotic setups
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record launched emulators in the PID manifest so a future run can clean
 * them up if this process dies without running its cleanup code.
 */
export function recordLaunchedEmulators(
  launched: LaunchedEmulator[],
  /** `booting`: just spawned, not yet booted — see `EmulatorManifestEntry.booting`. */
  options: { booting?: boolean } = {},
): void {
  const serials = new Set(launched.map((emu) => emu.serial));
  // Replace any older record of the same serial: that emulator is gone, or
  // this one could not have its console port.
  const existing = readManifest().filter((entry) => !serials.has(entry.serial));
  const newEntries: EmulatorManifestEntry[] = launched.map((emu) => ({
    serial: emu.serial,
    pid: emu.process.pid ?? -1,
    avd: emu.avd,
    port: emu.port,
    launchedAt: new Date().toISOString(),
    ownerPid: process.pid,
    ...(options.booting ? { booting: true } : {}),
    ...(emu.appNapDisabled !== undefined ? { appNapDisabled: emu.appNapDisabled } : {}),
  }));
  writeManifest([...existing, ...newEntries]);
}

/**
 * Record emulators as booted: from now on any run may reuse them. Written
 * afresh rather than edited in place, because the manifest is not locked:
 * another run's reclaim may have rewritten it without the booting entry.
 */
function markLaunchedEmulatorsReady(launched: LaunchedEmulator[]): void {
  recordLaunchedEmulators(launched);
}

/**
 * Remove emulators from the PID manifest (called during normal cleanup).
 */
export function unrecordLaunchedEmulators(launched: LaunchedEmulator[]): void {
  const serials = new Set(launched.map((emu) => emu.serial));
  const existing = readManifest();
  writeManifest(existing.filter((entry) => !serials.has(entry.serial)));
}

export interface ReclaimResult {
  /** Serials of healthy emulators from the manifest that can be reused. */
  reusable: string[]
  /** Serials of emulators that were killed (unhealthy or dead process). */
  killed: string[]
  /**
   * Serials kept in the manifest, and neither reused nor killed this run:
   * the recorded PID is alive but its command line could not be read; adb
   * could not be queried or changed its answer; or the emulator
   * failed its checks while another live Tapsmith session holds it.
   */
  undetermined: string[]
  /**
   * Serials another live Tapsmith process (or a concurrent launch in this
   * one) is still booting: kept, and left alone.
   */
  booting: string[]
}

interface ReclaimDeps {
  readManifest: () => EmulatorManifestEntry[]
  writeManifest: (entries: EmulatorManifestEntry[]) => void
  /** `adb devices`, or why it could not be read — never "no devices" for a failure. */
  queryAdbDevices: () => AdbDeviceQuery
  /** Blocks for the settle delay between two `adb devices` looks. */
  sleep: (ms: number) => void
  isProcessAlive: (pid: number) => boolean
  readProcessArgs: (pid: number) => string[] | undefined
  findEmulatorPid: (serial: string) => number | undefined
  probeDeviceHealth: (serial: string) => DeviceHealthResult
  /** Serials another live Tapsmith session holds (its device claims): never stopped. */
  devicesHeldElsewhere: () => ReadonlySet<string>
  killEmulator: (serial: string) => void
  killProcess: (pid: number) => void
  platform: NodeJS.Platform
}

function resolveReclaimDeps(deps: Partial<ReclaimDeps>): ReclaimDeps {
  return {
    readManifest: deps.readManifest ?? readManifest,
    writeManifest: deps.writeManifest ?? writeManifest,
    queryAdbDevices: deps.queryAdbDevices ?? queryAdbDevices,
    sleep: deps.sleep ?? sleepSync,
    isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
    readProcessArgs: deps.readProcessArgs ?? readProcessArgs,
    findEmulatorPid: deps.findEmulatorPid ?? findEmulatorPid,
    probeDeviceHealth: deps.probeDeviceHealth ?? probeDeviceHealth,
    devicesHeldElsewhere: deps.devicesHeldElsewhere ?? (() => devicesHeldElsewhere()),
    killEmulator: deps.killEmulator ?? killEmulator,
    killProcess: deps.killProcess ?? killProcess,
    platform: deps.platform ?? process.platform,
  };
}

/**
 * The command line of a running process as its argv tokens, or `undefined`
 * when it cannot be read. Linux exposes the exact argv in
 * `/proc/<pid>/cmdline` (NUL-separated, no tool needed); elsewhere — and in
 * a sandbox without /proc — `ps` is used, with `-ww` so it is not truncated.
 */
export function readProcessArgs(pid: number, procRoot = '/proc'): string[] | undefined {
  try {
    const argv = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf-8').split('\0').filter((arg) => arg.length > 0);
    if (argv.length > 0) return argv;
  } catch {
    // No /proc (macOS) or the process is gone — fall back to ps
  }
  try {
    const output = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output ? output.split(/\s+/) : undefined;
  } catch {
    return undefined;
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already dead
  }
}

/**
 * Reclaim healthy emulators from previous Tapsmith runs, kill unhealthy ones.
 *
 * Reads the PID manifest and, for each entry, first proves the emulator is
 * still the one Tapsmith launched: the recorded PID is alive and its command
 * line carries Tapsmith's launch arguments for that AVD and port. A serial
 * alone proves nothing — it is just a console port, and a user's own
 * emulator started later takes the same default port.
 *
 * - **Not provably ours** (PID dead, or reused by another process): drop the
 *   entry and touch nothing — whatever holds that serial now is not ours.
 * - **Ours and healthy**: keep it running and in the manifest for reuse.
 * - **Ours but unhealthy or unresponsive**: kill it and drop the entry.
 *
 * "Unresponsive" needs adb to have answered — twice, a settle delay apart —
 * without the emulator online. When `adb devices` cannot be read at all (adb
 * not on PATH, timed out, restarting), an emulator's state is unknown, so
 * every live one is left running and kept on record: it may be
 * another session's, mid-test.
 *
 * This is what makes back-to-back `npx tapsmith test` fast — emulators survive
 * between runs and get reused instead of relaunched.
 */
export function reclaimOrphanedEmulators(
  deps: Partial<ReclaimDeps> = {},
  /** Whether this run would launch headless — to say when a reused emulator differs. */
  wantedHeadless?: boolean,
): ReclaimResult {
  const d = resolveReclaimDeps(deps);
  const entries = d.readManifest();
  if (entries.length === 0) return { reusable: [], killed: [], undetermined: [], booting: [] };

  // Deduplicate entries by serial — the manifest can accumulate duplicates
  // if previous runs crashed between record and unrecord.
  const uniqueBySerial = new Map<string, EmulatorManifestEntry>();
  for (const entry of entries) {
    uniqueBySerial.set(entry.serial, entry);
  }

  const reusable: string[] = [];
  const killed: string[] = [];
  const undetermined: string[] = [];
  const booting: string[] = [];
  const surviving: EmulatorManifestEntry[] = [];
  const { devices: adbDevices, unsettled } = queryAdbDevicesSettled(d, [...uniqueBySerial.values()]);
  const adbFailure = isAdbQueryFailure(adbDevices) ? adbDevices : undefined;
  const adbDeviceMap = new Map((isAdbQueryFailure(adbDevices) ? [] : adbDevices).map((device) => [device.serial, device]));
  const leftUnqueried: string[] = [];
  const leftFlapping: string[] = [];
  let held: ReadonlySet<string> | undefined;
  const heldElsewhere = (serial: string) => (held ??= d.devicesHeldElsewhere()).has(serial);

  for (const entry of uniqueBySerial.values()) {
    // Mid-boot in a run that is still going: unhealthy only because it has
    // not finished booting, and not this run's to reuse or stop. Once its
    // launcher has gone (an interrupted run), it is judged like any other.
    if (entry.booting && entry.ownerPid !== undefined && d.isProcessAlive(entry.ownerPid)) {
      surviving.push(entry);
      booting.push(entry.serial);
      continue;
    }

    const inAdb = adbDeviceMap.get(entry.serial);
    const alive = entry.pid > 0 && d.isProcessAlive(entry.pid);
    const argv = alive ? d.readProcessArgs(entry.pid) : undefined;

    // Alive but unreadable (e.g. `ps` timed out): ownership is undetermined.
    // Keep the record so the next run can decide, but neither reuse nor kill.
    if (alive && argv === undefined) {
      surviving.push(entry);
      undetermined.push(entry.serial);
      continue;
    }

    const owned = argv !== undefined
      && isTapsmithLaunchedEmulator(argv, { port: entry.port, avd: entry.avd });

    // Ours and alive, but adb could not say whether it is healthy: never kill
    // (or reuse) on a failed query. Kept for the next run to judge.
    if (owned && adbFailure) {
      surviving.push(entry);
      undetermined.push(entry.serial);
      leftUnqueried.push(entry.serial);
      continue;
    }

    // adb's two answers disagreed about it (online, then gone; gone, then
    // offline — a server restart mid-check): it is in flux, which proves
    // nothing about the emulator. Like unqueried: left running, judged next run.
    if (owned && inAdb?.state !== 'device' && unsettled.has(entry.serial)) {
      surviving.push(entry);
      undetermined.push(entry.serial);
      leftFlapping.push(entry.serial);
      continue;
    }

    if (!owned) {
      if (inAdb) {
        process.stderr.write(
          `${DIM}Dropping stale record of ${entry.serial} (AVD ${entry.avd}): can't confirm PID ${entry.pid} is still ` +
          `the emulator Tapsmith launched. Leaving whatever is now on ${entry.serial} alone.${RESET}\n`,
        );
      }
      continue;
    }

    // Ours. The argv shows our PID asked for this console port, not that it
    // holds it: when lsof names a different process on the port, our qemu
    // lost it and the serial is someone else's. Stop our (useless) process,
    // but neither reuse nor touch the serial.
    const listener = inAdb ? d.findEmulatorPid(entry.serial) : undefined;
    if (listener !== undefined && listener !== entry.pid) {
      process.stderr.write(
        `${YELLOW}Stopping Tapsmith emulator PID ${entry.pid} (AVD ${entry.avd}): it no longer holds ${entry.serial}. ` +
        `Leaving the emulator now on ${entry.serial} alone.${RESET}\n`,
      );
      d.killProcess(entry.pid);
      continue;
    }

    // Health check to decide reuse vs kill
    let killReason: string;
    if (inAdb && inAdb.state === 'device') {
      const health = d.probeDeviceHealth(entry.serial);
      if (health.healthy) {
        // Reused as launched: a changed `emulatorLaunchOptions` applies only
        // to new launches, so say which kind this is and how to relaunch it.
        const reusedHeadless = argv.includes('-no-window');
        const mode = reusedHeadless ? 'headless' : 'with a window';
        const differs = wantedHeadless !== undefined && wantedHeadless !== reusedHeadless;
        process.stderr.write(launchedThisProcess.has(entry.serial)
          ? `${DIM}Reusing emulator ${entry.serial} (AVD ${entry.avd}, ${mode}), launched earlier in this run.${RESET}\n`
          : `${DIM}Reusing emulator ${entry.serial} (AVD ${entry.avd}, ${mode}) from previous run.`
            + (differs
              ? ` This run would launch it ${wantedHeadless ? 'headless' : 'with a window'}: stop it (adb -s ${entry.serial} emu kill) to relaunch it that way.`
              : '')
            + `${RESET}\n`);
        // Launched by a Tapsmith that left App Nap on: macOS throttles it as
        // soon as its window is hidden (PILOT-515). Only a relaunch reads the
        // setting again.
        if (d.platform === 'darwin' && !reusedHeadless && entry.appNapDisabled === undefined) {
          process.stderr.write(
            `${YELLOW}${entry.serial} was launched before Tapsmith turned off macOS App Nap for the emulator, so macOS may `
            + 'slow it down while its window is hidden or the display sleeps, and adb commands then time out. '
            + `Stop it (adb -s ${entry.serial} emu kill) so the next run relaunches it with App Nap off.${RESET}\n`,
          );
        }
        reusable.push(entry.serial);
        // A launch interrupted mid-boot that has since booted: ready now.
        if (entry.booting) {
          const { booting: _booting, ...ready } = entry;
          surviving.push(ready);
        } else {
          surviving.push(entry);
        }
        continue;
      }
      killReason = `${YELLOW}Killing unhealthy emulator ${entry.serial} (AVD ${entry.avd}): ${health.reason ?? 'health check failed'}.${RESET}\n`;
    } else {
      killReason = `${YELLOW}Killing unresponsive emulator ${entry.serial} (PID ${entry.pid}, AVD ${entry.avd}).${RESET}\n`;
    }

    // Another live session is using it: whatever its state looks like from
    // here (an adb restart, a slow host), stopping it would kill that
    // session's run. Left running and on record.
    if (heldElsewhere(entry.serial)) {
      process.stderr.write(
        `${DIM}Leaving emulator ${entry.serial} (AVD ${entry.avd}) running: it failed Tapsmith's checks, but another Tapsmith session is using it.${RESET}\n`,
      );
      surviving.push(entry);
      undetermined.push(entry.serial);
      continue;
    }
    process.stderr.write(killReason);

    // Go through the serial (adb emu kill, then the port listener) only when
    // the listener is confirmed to be our PID; without lsof, signal the PID.
    if (listener === entry.pid) {
      d.killEmulator(entry.serial);
    }
    // Kill by PID as well — more reliable than ADB when the device is unresponsive
    d.killProcess(entry.pid);
    killed.push(entry.serial);
  }

  if (adbFailure && leftUnqueried.length > 0) {
    process.stderr.write(
      `${YELLOW}Couldn't query adb (${adbFailure.error}), so Tapsmith can't tell whether the emulator(s) it launched earlier `
      + `(${leftUnqueried.join(', ')}) are healthy: leaving them running and not reusing them this run.${RESET}\n`,
    );
  }

  if (leftFlapping.length > 0) {
    process.stderr.write(
      `${YELLOW}adb's state for ${leftFlapping.join(', ')} changed while Tapsmith checked it, so Tapsmith can't tell `
      + `whether it is healthy: leaving it running.${RESET}\n`,
    );
  }

  // Write back only the surviving healthy entries, plus any another run
  // recorded since the read above — the adb and health checks in between can
  // take seconds, and the file has no lock.
  const read = new Set(entries.map((entry) => `${entry.serial}:${entry.pid}`));
  const recordedSince = d.readManifest().filter((entry) => !read.has(`${entry.serial}:${entry.pid}`));
  d.writeManifest([...surviving, ...recordedSince]);
  return { reusable, killed, undetermined, booting };
}

/** How long to let adb settle before a second `adb devices` look (PILOT-710). */
const ADB_RECHECK_DELAY_MS = 3_000;

/**
 * `adb devices` for the reclaim pass. One look is enough when it shows every
 * live recorded emulator online. Otherwise — a failed query, or one that
 * lists a live emulator absent or not online — it looks again after a settle
 * delay, because a restarting adb server fails, then answers before its
 * emulators have reconnected, and a loaded host can time out once
 * (PILOT-710). It returns an answer only once adb has answered twice, and
 * that answer condemns only emulators both answers agree about: those whose
 * state differs between them are `unsettled`. Two failed looks return the
 * failure, which condemns nothing. Either count reaches two within three looks.
 */
function queryAdbDevicesSettled(
  d: ReclaimDeps,
  entries: readonly EmulatorManifestEntry[],
): { devices: AdbDeviceQuery, unsettled: Set<string> } {
  const unsettled = new Set<string>();
  const live = entries.filter((entry) =>
    !(entry.booting && entry.ownerPid !== undefined && d.isProcessAlive(entry.ownerPid))
    && entry.pid > 0 && d.isProcessAlive(entry.pid));
  const condemnsNone = (devices: AdbDeviceEntry[]) => live.every((entry) =>
    devices.some((device) => device.serial === entry.serial && device.state === 'device'));
  // Nothing alive to protect or condemn: one look, whatever it says.
  if (live.length === 0) return { devices: d.queryAdbDevices(), unsettled };

  const stateOf = (devices: AdbDeviceEntry[], serial: string) =>
    devices.find((device) => device.serial === serial)?.state ?? 'absent';
  let firstAnswer: AdbDeviceEntry[] | undefined;
  let failed = false;
  for (;;) {
    const result = d.queryAdbDevices();
    if (isAdbQueryFailure(result)) {
      // Two failures: adb is not coming back in time; judge nothing.
      if (failed) return { devices: result, unsettled };
      failed = true;
    } else {
      if (condemnsNone(result)) return { devices: result, unsettled };
      if (firstAnswer) {
        for (const entry of live) {
          if (stateOf(firstAnswer, entry.serial) !== stateOf(result, entry.serial)) unsettled.add(entry.serial);
        }
        return { devices: result, unsettled };
      }
      firstAnswer = result;
    }
    d.sleep(ADB_RECHECK_DELAY_MS);
  }
}

type ExecFileSyncLike = typeof execFileSync

export interface AdbDeviceEntry {
  serial: string
  state: string
}

/** `adb devices` could not be read; `error` says why, for the user. */
export interface AdbQueryFailure {
  error: string
}

/** The devices adb listed (possibly none), or why it could not be asked. */
export type AdbDeviceQuery = AdbDeviceEntry[] | AdbQueryFailure

export function isAdbQueryFailure(result: AdbDeviceQuery): result is AdbQueryFailure {
  return !Array.isArray(result);
}

// ─── ADB package queries ───

/**
 * Wait for a freshly installed package to appear in `pm path`.
 *
 * After `adb install`, the package manager may take a moment to index the
 * new app. This polls `pm path` instead of using a fixed sleep.
 */
export async function waitForPackageIndexed(
  serial: string,
  packageName: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isPackageInstalled(serial, packageName)) return;
    await sleep(500);
  }
  process.stderr.write(
    `${YELLOW}Warning: package ${packageName} not found by pm after ${Math.round(timeoutMs / 1000)}s — continuing anyway.${RESET}\n`,
  );
}

/**
 * Whether the APK installed on the device is byte-identical to `apkPath`.
 * `pm` keeps the installed base.apk as-is, so an md5 comparison tells a
 * rebuilt app from the one already on the device. `undefined` when either
 * side cannot be hashed (then callers fall back to "installed is fine").
 */
export function installedApkMatches(serial: string, packageName: string, apkPath: string): boolean | undefined {
  try {
    const pathOut = execFileSync(
      'adb', ['-s', serial, 'shell', 'pm', 'path', packageName],
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const devicePath = pathOut.split('\n').map((l) => l.trim()).find((l) => l.startsWith('package:'))?.slice('package:'.length);
    if (!devicePath) return undefined;
    const remote = execFileSync(
      'adb', ['-s', serial, 'shell', 'md5sum', devicePath],
      { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{32}$/.test(remote)) return undefined;
    const local = createHash('md5').update(fs.readFileSync(apkPath)).digest('hex');
    return remote === local;
  } catch {
    return undefined;
  }
}

/**
 * Check whether a package is installed on a device via ADB.
 */
export function isPackageInstalled(serial: string, packageName: string): boolean {
  try {
    const output = execFileSync(
      'adb', ['-s', serial, 'shell', 'pm', 'path', packageName],
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return output.includes('package:');
  } catch {
    return false;
  }
}

// ─── Emulator discovery ───

/**
 * List devices known to ADB, including offline transports, each with adb's
 * whole state string (`device`, `unauthorized`, `offline`, `no permissions
 * (…)`, …) — the run paths name an unusable device by it.
 */
export function listAdbDevices(exec: ExecFileSyncLike = execFileSync): AdbDeviceEntry[] {
  const result = queryAdbDevices(exec);
  return isAdbQueryFailure(result) ? [] : result;
}

const ADB_DEVICES_TIMEOUT_MS = 10_000;

/**
 * {@link listAdbDevices}, but a query that failed (adb not on PATH, timed
 * out, exited non-zero) is reported as such rather than as no devices — for
 * callers that act on a device's absence, such as killing it.
 */
export function queryAdbDevices(exec: ExecFileSyncLike = execFileSync): AdbDeviceQuery {
  try {
    const output = exec('adb', ['devices'], {
      encoding: 'utf-8',
      timeout: ADB_DEVICES_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseAdbDevicesOutput(output);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { error: 'adb was not found on PATH' };
    if (code === 'ETIMEDOUT') return { error: `\`adb devices\` timed out after ${ADB_DEVICES_TIMEOUT_MS / 1000} s` };
    // A non-zero exit's message is just "Command failed: adb devices"; adb's
    // own reason is the last line it wrote to stderr.
    const stderr = String((err as { stderr?: unknown } | undefined)?.stderr ?? '');
    const reason = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()
      ?? (err instanceof Error ? err.message : String(err)).split('\n')[0].trim();
    return { error: `\`adb devices\` failed: ${reason}` };
  }
}

/**
 * Clear stale offline emulator transports from ADB.
 *
 * Interrupted runs can leave emulator serials stuck in `offline` even after
 * the underlying process is gone. `adb reconnect offline` clears those stale
 * transports so future provisioning starts from a cleaner inventory.
 */
export function clearOfflineEmulatorTransports(): string[] {
  const offlineEmulators = listAdbDevices()
    .filter((device) => device.state === 'offline' && device.serial.startsWith('emulator-'))
    .map((device) => device.serial);

  if (offlineEmulators.length === 0) {
    return [];
  }

  try {
    execFileSync('adb', ['reconnect', 'offline'], {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch {
    // Best effort
  }

  return offlineEmulators;
}

interface CleanupDeps extends ReclaimDeps {
  resolveAvdName: (serial: string) => string | undefined
  waitForAdbSettle: (killedSerials: string[]) => void
}

export interface CleanupStaleResult {
  /** Healthy emulators from previous runs that are ready for reuse. */
  reusable: string[]
  /** Emulators that were killed (unhealthy, dead, or stale). */
  killed: string[]
}

/**
 * Clean up stale emulators and reclaim healthy ones for reuse.
 *
 * Two-phase approach:
 * 1. **Manifest-based**: Health-check emulators recorded by previous Tapsmith
 *    runs. Reuse healthy ones and kill unhealthy ones that are provably still
 *    Tapsmith-launched; drop every other entry without killing anything.
 * 2. **Heuristic**: Kill emulators matching the target AVD that are in an
 *    offline/unauthorized state, or that fail health checks — but only when
 *    the process on the console port was started with Tapsmith's launch
 *    arguments. This catches Tapsmith emulators whose manifest entry was lost;
 *    emulators Tapsmith did not launch are never killed.
 */
export function cleanupStaleEmulators(
  targetAvd?: string,
  deps: Partial<CleanupDeps> = {},
  /** Whether this run would launch headless (`resolveEmulatorLaunchSettings`). */
  wantedHeadless?: boolean,
): CleanupStaleResult {
  const d = resolveReclaimDeps(deps);
  const resolveAvdName = deps.resolveAvdName ?? getRunningAvdName;
  const settle = deps.waitForAdbSettle ?? waitForAdbSettle;

  // Phase 1: manifest-based reclaim/kill (precise)
  const reclaim = reclaimOrphanedEmulators(d, wantedHeadless);
  const handled = new Set([...reclaim.reusable, ...reclaim.killed, ...reclaim.undetermined, ...reclaim.booting]);

  // Phase 2: heuristic cleanup for Tapsmith emulators the manifest missed
  // (the manifest is not written atomically, so concurrent runs can lose an
  // entry). An emulator is only killed here when the process holding its
  // console port carries Tapsmith's launch arguments; a user's own emulator —
  // offline, unauthorized or mid-ANR — is left running.
  // Without an adb answer there is nothing to judge, so nothing to kill.
  const listed = d.queryAdbDevices();
  const devices = isAdbQueryFailure(listed) ? [] : listed;
  const killed = [...reclaim.killed];
  let heldInPhase2: ReadonlySet<string> | undefined;

  for (const device of devices) {
    if (!device.serial.startsWith('emulator-')) continue;
    if (handled.has(device.serial)) continue;

    // Only target emulators running the requested AVD (or all if none specified)
    if (targetAvd) {
      const avdName = resolveAvdName(device.serial);
      if (avdName && avdName !== targetAvd) continue;
    }

    let problem: string | undefined;
    if (device.state === 'offline' || device.state === 'unauthorized') {
      problem = device.state;
    } else if (device.state === 'device') {
      const health = d.probeDeviceHealth(device.serial);
      if (!health.healthy) problem = health.reason ?? 'health check failed';
    }
    if (!problem) continue;

    const port = Number(device.serial.slice('emulator-'.length));
    const pid = d.findEmulatorPid(device.serial);
    const argv = pid !== undefined ? d.readProcessArgs(pid) : undefined;
    if (argv === undefined || !isTapsmithLaunchedEmulator(argv, { port, avd: targetAvd })) {
      process.stderr.write(
        `${DIM}Leaving emulator ${device.serial} alone (${problem}): Tapsmith can't confirm it launched it.${RESET}\n`,
      );
      continue;
    }

    if ((heldInPhase2 ??= d.devicesHeldElsewhere()).has(device.serial)) {
      process.stderr.write(
        `${DIM}Leaving emulator ${device.serial} running (${problem}): another Tapsmith session is using it.${RESET}\n`,
      );
      continue;
    }

    process.stderr.write(
      `${YELLOW}Killing stale emulator ${device.serial}: ${problem}.${RESET}\n`,
    );
    d.killEmulator(device.serial);
    killed.push(device.serial);
  }

  // Wait for ADB to settle after kills. `adb emu kill` and process kills are
  // async — the transports linger in `adb devices` for a few seconds. Without
  // this wait, the very next `adb devices` call (in device discovery) will see
  // the dead emulators as "offline" or "device" and waste time on them.
  if (killed.length > 0) {
    settle(killed);
  }

  return { reusable: reclaim.reusable, killed };
}

/**
 * Dismiss system ANR/crash dialogs via ADB shell commands.
 *
 * This works at the ADB level — no agent or UI framework needed. It uses
 * `input keyevent` to press Enter/Back (which dismisses most system dialogs)
 * and force-stops the Launcher if it's in an ANR state.
 *
 * Call this before starting the Tapsmith agent on a freshly booted emulator.
 */
export function dismissSystemDialogsViaAdb(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): boolean {
  const hierarchy = readUiHierarchyViaAdb(serial, exec);
  if (!hierarchy) return false;

  const blockingDialog = detectBlockingSystemDialog(hierarchy);
  if (!blockingDialog) return false;

  const adb = (args: string[]) => {
    try {
      exec('adb', ['-s', serial, ...args], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch {
      // Best effort
    }
  };

  // Try pressing "Wait" or "OK" by sending ENTER keyevent
  adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
  // Small delay to let the dialog dismiss
  try {
    exec('adb', ['-s', serial, 'shell', 'sleep', '1'], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch { /* best effort */ }

  // Force-stop the Launcher to clear any ANR state
  adb(['shell', 'am', 'force-stop', 'com.google.android.apps.nexuslauncher']);
  adb(['shell', 'am', 'force-stop', 'com.android.launcher3']);

  // Press BACK to dismiss any remaining system dialogs
  adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);

  // Press HOME to reset to a clean state
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);

  // Verify the dialog is gone
  const afterHierarchy = readUiHierarchyViaAdb(serial, exec);
  if (afterHierarchy && detectBlockingSystemDialog(afterHierarchy)) {
    // Still there — try one more aggressive approach: dismiss ALL crash dialogs
    adb(['shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']);
    return false;
  }

  return true;
}

/**
 * Ensure ADB is running as root on the device. Returns true if adbd was
 * actually restarted (meaning ADB port forwards were lost and the caller
 * should re-establish connections).
 *
 * On userdebug/eng emulator images, `adb root` restarts adbd in root mode.
 * On production/non-rooted devices, this is a no-op that returns false.
 *
 * Call this BEFORE starting the Tapsmith agent to avoid disrupting UIAutomator2's
 * accessibility service connection.
 */
export function ensureAdbRoot(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): boolean {
  try {
    const output = String(exec('adb', ['-s', serial, 'root'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();

    if (output.includes('already running as root')) {
      return false;
    }

    if (output.includes('cannot run as root') || output.includes('adbd cannot run as root')) {
      return false;
    }

    // adbd was restarted — wait for device to come back
    try {
      exec('adb', ['-s', serial, 'wait-for-device'], {
        timeout: 15_000,
        stdio: 'ignore',
      });
    } catch {
      // Best effort
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for system services to settle after boot.
 *
 * Even after `sys.boot_completed=1`, critical services like the Launcher,
 * package manager, and input system can take several more seconds to
 * stabilize. This function polls for readiness of those services and
 * auto-dismisses any ANR dialogs that appear during settling.
 */
export async function waitForSystemSettle(
  serial: string,
  timeoutMs = POST_BOOT_SETTLE_TIMEOUT_MS,
  exec: ExecFileSyncLike = execFileSync,
  /** Stops the settle loop — e.g. the emulator exited, so there is nothing to settle. */
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();

  const adb = (args: string[], timeout = 5_000): string => {
    return String(exec('adb', ['-s', serial, ...args], {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  };

  while (Date.now() - start < timeoutMs && !signal?.aborted) {
    // Dismiss any ANR dialogs that pop up during boot settling
    dismissSystemDialogsViaAdb(serial, exec);

    let servicesReady = true;

    // Check that the launcher is running (not crashed)
    try {
      const launcherState = adb(['shell', 'dumpsys', 'activity', 'activities'], 10_000);
      const hasLauncher = launcherState.includes('com.google.android.apps.nexuslauncher')
        || launcherState.includes('com.android.launcher3')
        || launcherState.includes('Launcher');
      if (!hasLauncher) {
        servicesReady = false;
      }
    } catch {
      servicesReady = false;
    }

    // Check that the settings provider is available (indicates system is settled)
    try {
      const settingsResult = adb(['shell', 'settings', 'get', 'system', 'screen_brightness']);
      if (!settingsResult.trim() || settingsResult.includes('null')) {
        servicesReady = false;
      }
    } catch {
      servicesReady = false;
    }

    if (servicesReady) {
      // One final ANR check after services are ready
      const hierarchy = readUiHierarchyViaAdb(serial, exec);
      if (!hierarchy || !detectBlockingSystemDialog(hierarchy)) {
        return;
      }
      // Dialog still showing — dismiss and keep waiting
      dismissSystemDialogsViaAdb(serial, exec);
    }

    await sleep(POST_BOOT_SETTLE_POLL_MS);
  }

  // Timeout — still do one last dismissal attempt
  if (!signal?.aborted) dismissSystemDialogsViaAdb(serial, exec);
}

// ─── Emulator binary ───

/** Where the Android `emulator` binary is, as `resolveEmulatorBinary` found it. */
export interface EmulatorBinary {
  /** What to spawn: an absolute path, or the bare command for a PATH lookup. */
  command: string
  /** True when `command` exists (a file found in an SDK, or the command resolves on PATH). */
  found: boolean
  /** Every location checked, in order — for the not-found message. */
  tried: string[]
}

interface ResolveEmulatorDeps {
  exists: (file: string) => boolean
  onPath: (command: string) => boolean
  homedir: () => string
}

/**
 * Whether `command` is on `env.PATH`, found by looking in each directory —
 * not by running `which`, which slim images may not have.
 */
export function isOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? [`${command}.exe`, command] : [command];
  return (env.PATH ?? env.Path ?? '').split(p.delimiter).filter((dir) => dir.length > 0)
    .some((dir) => names.some((name) => exists(p.join(dir, name))));
}

/** A regular file — not a directory such as `<sdk>/emulator` when the SDK root is on PATH. */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where an Android SDK may be, in lookup order: `$ANDROID_HOME`,
 * `$ANDROID_SDK_ROOT`, then the default location for the OS (where Android
 * Studio installs it, without setting either variable).
 */
export function androidSdkRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sdkRoots: string[] = [];
  if (env.ANDROID_HOME) sdkRoots.push(env.ANDROID_HOME);
  if (env.ANDROID_SDK_ROOT) sdkRoots.push(env.ANDROID_SDK_ROOT);
  if (platform === 'darwin') sdkRoots.push(p.join(home, 'Library', 'Android', 'sdk'));
  else if (platform === 'win32') {
    if (env.LOCALAPPDATA) sdkRoots.push(p.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  } else sdkRoots.push(p.join(home, 'Android', 'Sdk'));
  return sdkRoots;
}

/**
 * Locate the Android `emulator` binary: `$ANDROID_HOME/emulator/emulator`,
 * then `$ANDROID_SDK_ROOT/…`, then the default SDK location for the OS
 * (where Android Studio installs it), then PATH. A stock Android Studio setup
 * puts `platform-tools` on PATH but not `emulator`, so PATH comes last.
 */
export function resolveEmulatorBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: Partial<ResolveEmulatorDeps> = {},
): EmulatorBinary {
  const exists = deps.exists ?? isFile;
  const onPath = deps.onPath ?? ((command: string) => isOnPath(command, env, platform, exists));
  const home = (deps.homedir ?? os.homedir)();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'emulator.exe' : 'emulator';

  const sdkRoots = androidSdkRoots(env, platform, home);

  const tried: string[] = [];
  for (const root of sdkRoots) {
    const candidate = p.join(root, 'emulator', binaryName);
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (exists(candidate)) return { command: candidate, found: true, tried };
  }
  tried.push('`emulator` on PATH');
  return { command: 'emulator', found: onPath('emulator'), tried };
}

/** The error for an emulator binary `resolveEmulatorBinary` could not find. */
export function emulatorNotFoundMessage(tried: readonly string[]): string {
  return `The Android emulator is not installed where Tapsmith looks (${tried.join(', ')}). `
    + 'Install "Android Emulator" from Android Studio (Settings → Languages & Frameworks → Android SDK → SDK Tools), '
    + 'or set ANDROID_HOME to the Android SDK that has it.';
}

/**
 * List available Android Virtual Devices (AVDs).
 * Runs `emulator -list-avds` and returns the AVD names.
 */
export function listAvds(emulator: string = resolveEmulatorBinary().command): string[] {
  try {
    const output = execFileSync(emulator, ['-list-avds'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Get the AVD name of a running emulator by its serial.
 * Runs `adb -s <serial> emu avd name`.
 */
export function getRunningAvdName(serial: string): string | undefined {
  try {
    const output = execFileSync('adb', ['-s', serial, 'emu', 'avd', 'name'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Output is "AVD_NAME\nOK\n"
    const lines = output.trim().split('\n');
    return lines[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ─── Emulator port management ───

/** Console ports the emulator accepts: even ports from 5554 to 5682 (`emulator -port`). */
const BASE_EMULATOR_PORT = 5554;
const MAX_EMULATOR_PORT = 5682;

/**
 * How long a port lock stays valid without its holder refreshing it.
 * proper-lockfile refreshes it from a timer every half of this; a synchronous
 * adb probe during the boot can hold the event loop for several seconds, so
 * the window is generous. A holder that dies frees the port after it.
 */
const PORT_LOCK_STALE_MS = 60_000;

/** A console port held for one launch until `release`. */
export interface PortReservation {
  port: number
  /** Frees the port for other launches. Safe to call more than once. */
  release: () => Promise<void>
}

/** Ports some launch in this process holds right now, whichever call made it. */
const reservedPorts = new Set<number>();

/**
 * Settles once the most recently spawned launch in this process has started
 * up, whichever provisionEmulators call spawned it — concurrent calls (two
 * device targets in one run) wait on each other too (PILOT-495).
 */
let startupGate: Promise<void> = Promise.resolve();

/**
 * Whether nothing listens on loopback `port`. A running emulator listens on
 * 127.0.0.1 for its console and adb ports, so binding there fails while it
 * runs. (A wildcard bind would not: macOS lets it share the port.)
 */
function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Whether something accepts connections on loopback `port`. Never binds it. */
function isLoopbackPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/** How long a launch waits, at most, for the one started before it to get going. */
const EMULATOR_STARTUP_WAIT_MS = 30_000;

/**
 * Wait until a just-spawned emulator has started up — its console port
 * accepts connections — or it exits, or {@link EMULATOR_STARTUP_WAIT_MS}
 * passes. Two instances of one AVD spawned at the same moment can crash
 * the second during startup (seen as SIGSEGV on Linux CI, PILOT-495), so
 * each launch waits for the one before it to get this far; the boots then
 * overlap from there.
 */
async function waitForEmulatorStartup(emu: LaunchedEmulator): Promise<void> {
  const deadline = Date.now() + EMULATOR_STARTUP_WAIT_MS;
  let exited = false;
  void emu.exited.then(() => { exited = true; });
  while (!exited && Date.now() < deadline) {
    if (await isLoopbackPortListening(emu.port)) return;
    await sleep(500);
  }
}

/**
 * Reserve an emulator console port for one launch.
 *
 * Picking a port that merely looks free left a window, between choosing it
 * and the emulator binding it, in which another launch could choose it too —
 * another Tapsmith process (UI mode beside `tapsmith test`, parallel CI jobs
 * on one host) or a concurrent launch in this one — and both runs would then
 * wait on the same `emulator-<port>`. So a port is taken only when:
 *
 * - no launch in this process holds it (claimed before any await, so
 *   concurrent callers can never pick the same one);
 * - this process gets the port's lock, a directory in the temp dir that
 *   every Tapsmith process takes before launching on that port (broken
 *   after {@link PORT_LOCK_STALE_MS} if its holder died);
 * - nothing listens on the console port or the adb port beside it — which
 *   catches an emulator another process launched earlier, once it is up.
 *
 * Hold the reservation until the boot has finished or failed: by then the
 * emulator holds the port itself, or nothing does.
 */
export async function reserveEmulatorPort(
  usedPorts: ReadonlySet<number>,
  deps: { isPortFree?: (port: number) => Promise<boolean> } = {},
): Promise<PortReservation> {
  const isPortFree = deps.isPortFree ?? isLoopbackPortFree;
  for (let port = BASE_EMULATOR_PORT; port <= MAX_EMULATOR_PORT; port += 2) {
    if (usedPorts.has(port) || reservedPorts.has(port)) continue;
    reservedPorts.add(port);
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await lockfile.lock(path.join(os.tmpdir(), `tapsmith-emulator-port-${port}`), {
        realpath: false,
        stale: PORT_LOCK_STALE_MS,
        // Losing the lock (a blocked event loop let it go stale) only weakens
        // the guard; proper-lockfile's default would throw from a timer.
        onCompromised: () => undefined,
      });
      if (await isPortFree(port) && await isPortFree(port + 1)) {
        const heldLock = unlock;
        let released = false;
        return {
          port,
          release: async () => {
            if (released) return;
            released = true;
            reservedPorts.delete(port);
            await heldLock().catch(() => undefined);
          },
        };
      }
    } catch {
      // Locked by another launch, or the temp dir is unusable: try the next port.
    }
    reservedPorts.delete(port);
    await unlock?.().catch(() => undefined);
  }
  throw new Error(
    `No free emulator console port between ${BASE_EMULATOR_PORT} and ${MAX_EMULATOR_PORT}: `
    + 'every one is in use or being launched on. Stop emulators you no longer need (adb -s <serial> emu kill).',
  );
}

/**
 * Get the serial for a given emulator console port.
 */
export function serialForPort(port: number): string {
  return `emulator-${port}`;
}

// ─── Emulator launch ───

export interface LaunchedEmulator {
  process: ChildProcess
  port: number
  serial: string
  avd: string
  /** Whether it was launched without a window (`EmulatorLaunchSettings.headless`). */
  headless: boolean
  /** The file the emulator's stdout and stderr go to; undefined when it could not be opened. */
  logPath: string | undefined
  /** Windowed on macOS: whether App Nap was off for it at launch (`EmulatorManifestEntry.appNapDisabled`). */
  appNapDisabled?: boolean
  /**
   * Settles when the process fails to spawn or exits — whenever that is.
   * During boot it means the launch failed (`describeEmulatorExit`).
   */
  exited: Promise<EmulatorExit>
}

/** How a launched emulator process ended. */
export type EmulatorExit =
  | { kind: 'spawn-error', error: NodeJS.ErrnoException }
  | { kind: 'exited', code: number | null, signal: NodeJS.Signals | null }

export interface DeviceHealthResult {
  serial: string
  healthy: boolean
  reason?: string
}

export interface DeviceSelectionResult {
  selectedSerials: string[]
  skippedDevices: Array<{ serial: string; reason: string }>
}

export interface DevicePrefilterResult extends DeviceSelectionResult {
  candidateSerials: string[]
}

function extractHierarchyXml(raw: string): string {
  const start = raw.indexOf('<');
  return start >= 0 ? raw.slice(start) : '';
}

/** Patterns that strongly indicate a system ANR/crash dialog — no ambiguity. */
const STRONG_DIALOG_PATTERNS = [
  /isn(?:'|’|&apos;)t responding/,
  /keeps stopping/,
];

export function detectBlockingSystemDialog(rawHierarchy: string): string | undefined {
  const hierarchy = rawHierarchy.toLowerCase();
  const strongPatterns = STRONG_DIALOG_PATTERNS;

  // Patterns that only indicate a system dialog when a strong pattern is also present.
  // "wait" and "close app" can appear in normal app UI, so we require them to
  // co-occur with a system dialog indicator to avoid false positives.
  const weakPatterns = [
    /text="wait"/,
    /close app/,
    /app info/,
  ];

  const hasStrongMatch = strongPatterns.some((pattern) => pattern.test(hierarchy));
  const hasWeakMatch = weakPatterns.some((pattern) => pattern.test(hierarchy));

  if (!hasStrongMatch && !hasWeakMatch) return undefined;
  // Weak matches alone are not sufficient — require at least one strong indicator
  if (!hasStrongMatch) return undefined;

  return blockingDialogTitle(rawHierarchy, strongPatterns) ?? GENERIC_BLOCKING_DIALOG;
}

const GENERIC_BLOCKING_DIALOG = 'an app isn\'t responding or keeps stopping';

/**
 * The dialog's own title ("Pixel Launcher isn't responding"), entity-decoded:
 * the `android:id/alertTitle` node when it matches, else the first system-drawn
 * text node that does, else the first of any package. Undefined when the phrase only appears outside a `text` attribute.
 */
function blockingDialogTitle(rawHierarchy: string, patterns: RegExp[]): string | undefined {
  const matches = (text: string) => patterns.some((p) => p.test(text.toLowerCase()));
  // Preference: the alert title, then any system-drawn node, then any node
  // (the app's own text can carry the phrase too).
  let systemDrawn: string | undefined;
  let first: string | undefined;
  for (const [node] of rawHierarchy.matchAll(/<node\b[^>]*>/g)) {
    const text = node.match(/\btext="([^"]*)"/)?.[1];
    if (!text) continue;
    const decoded = decodeXmlEntities(text).trim();
    if (!matches(decoded)) continue;
    if (node.includes('resource-id="android:id/alertTitle"')) return decoded;
    if (node.includes('package="android"')) systemDrawn ??= decoded;
    first ??= decoded;
  }
  return systemDrawn ?? first;
}

/**
 * True when a node drawn by the system (`package="android"`, which is how
 * system_server's ANR and crash dialogs appear) carries the dialog phrase —
 * as opposed to the app under test merely showing "… isn't responding" text.
 */
export function isSystemDrawnDialog(rawHierarchy: string): boolean {
  for (const [node] of rawHierarchy.matchAll(/<node\b[^>]*>/g)) {
    if (!node.includes('package="android"')) continue;
    const text = node.match(/\btext="([^"]*)"/)?.[1];
    if (text && STRONG_DIALOG_PATTERNS.some((p) => p.test(decodeXmlEntities(text).toLowerCase()))) return true;
  }
  return false;
}

/**
 * Processes that own an ANR / crash dialog window, via `dumpsys window`.
 *
 * The dialog itself is drawn by system_server — every node in its hierarchy
 * says `package="android"` — so the dump cannot tell the launcher's ANR from
 * the app under test's. The framework titles the dialog's window
 * `Application Not Responding: <process>` / `Application Error: <process>`,
 * and that is the one place the owner is recorded. Every owner is returned, in
 * the order listed: a thrashing emulator can show more than one such dialog,
 * and the window list cannot say which one the hierarchy's title belongs to.
 * Empty when adb fails or no such window is listed.
 */
export function blockingDialogOwnersViaAdb(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): string[] {
  try {
    const output = String(exec('adb', ['-s', serial, 'shell', 'dumpsys', 'window', 'windows'], {
      encoding: 'utf-8',
      timeout: 10_000,
      // The full window dump can pass execFileSync's 1 MiB default.
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const owners = new Set<string>();
    // The title names the process; a `:service` suffix is dropped so an app's
    // secondary process still reads as the app.
    for (const match of output.matchAll(/Window\{[0-9a-f]+ u\d+ (?:Application Not Responding|Application Error): ([^\s}:]+)(?::[^\s}]*)?\}/g)) {
      owners.add(match[1]);
    }
    return [...owners];
  } catch {
    return [];
  }
}

/** `"<title>" (<owner>)` — the one way a blocking dialog is named to users. */
export function formatBlockingDialog(title: string, owner?: string): string {
  return owner ? `"${title}" (${owner})` : `"${title}"`;
}

export function readUiHierarchyViaAdb(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): string | undefined {
  try {
    const output = String(exec('adb', ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const xml = extractHierarchyXml(output);
    return xml.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Flags, besides `-avd <name>` and `-port <n>`, that identify an emulator as
 * one Tapsmith launched. Every one of them is part of the real launch args
 * (`emulatorLaunchArgs` spreads this list in), so the ownership check cannot
 * drift from what `launchEmulator` spawns. Keep it to flags Tapsmith will
 * always pass: a user launching from Android Studio does not use `-read-only`.
 */
export const TAPSMITH_EMULATOR_IDENTITY_FLAGS = ['-read-only'] as const;

/**
 * How `launchEmulator` starts an emulator, resolved from
 * `emulatorLaunchOptions` and the environment (`resolveEmulatorLaunchSettings`).
 */
export interface EmulatorLaunchSettings {
  /** No window: software GPU and a cold boot (the CI profile). */
  headless: boolean
  /** Extra user arguments, appended after Tapsmith's own. */
  args: readonly string[]
}

const HEADLESS_LAUNCH: EmulatorLaunchSettings = { headless: true, args: [] };

/**
 * Why a window cannot be shown here, or `undefined` when it can: in CI, over
 * SSH, or on Linux with no X11/Wayland display. A window is never forced
 * where there is nothing to show it on.
 */
function emulatorWindowUnavailableReason(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isCi: boolean,
): string | undefined {
  // `ci-info` knows the CI systems that do not set CI (Jenkins, Azure
  // Pipelines, TeamCity, …); CI=… is checked too, for callers passing an env.
  if (isCi || (env.CI && env.CI !== 'false')) return 'this is a CI build';
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'this is an SSH session';
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'no display is available';
  return undefined;
}

/**
 * Resolve `emulatorLaunchOptions`. Locally the default is a window (AVD GPU mode
 * and a snapshot quick-boot: measured ~10 s from launch to a healthy device
 * against ~38 s for a headless cold boot); `headless: true` opts out. Where no window can be
 * shown — CI, SSH, Linux without a display — it is always headless, and
 * `windowUnavailable` says why when `headless: false` asked for one.
 */
export function resolveEmulatorLaunchSettings(
  options: EmulatorLaunchOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  /** From `ci-info` for the real environment; a caller's own `env` is judged by itself. */
  isCi: boolean = env === process.env && runningInCi,
): EmulatorLaunchSettings & { windowUnavailable?: string } {
  // `-no-window` in args is a request for headless: honour it with the whole
  // headless profile, not a windowed profile (snapshot load, host GPU) minus the window.
  const userArgs = options?.args ?? [];
  const isNoWindow = (arg: string) => arg === '-no-window' || arg === '--no-window';
  const askedHeadless = options?.headless === true || userArgs.some(isNoWindow);
  const args = userArgs.filter((arg) => !isNoWindow(arg));
  if (askedHeadless) return { headless: true, args };
  const windowUnavailable = emulatorWindowUnavailableReason(env, platform, isCi);
  return windowUnavailable ? { headless: true, args, windowUnavailable } : { headless: false, args };
}

/**
 * Flags that keep the emulator from stopping at a prompt nobody will answer
 * (PILOT-512). After any earlier emulator crash on the machine (its crash
 * database is shared by every project), the next launch otherwise opens a modal
 * crash-report consent dialog and never boots; and the emulator warns that its
 * metrics notice will become a one-time blocking prompt.
 */
const NO_BLOCKING_PROMPT_FLAGS = ['-crash-report-mode', 'never', '-no-metrics'] as const;

/**
 * The exact argv `launchEmulator` passes to the `emulator` binary.
 *
 * - **Headless** (`headless: true`, and always in CI): no window, SwiftShader,
 *   cold boot. Loading the AVD's snapshot headless fails anyway — the
 *   snapshot was saved by a windowed emulator with another renderer — and
 *   the failed attempt still rewrites the AVD's snapshot metadata.
 * - **Window** (the local default): the AVD's own GPU mode (no `-gpu`, so
 *   it matches the renderer its snapshot was saved with — normally the host
 *   GPU) and a quick-boot from the AVD's default snapshot. `-read-only` means nothing
 *   is saved back to the AVD (`-no-snapshot-save` says so explicitly).
 *
 * Both profiles answer no crash-report or metrics prompt
 * (`NO_BLOCKING_PROMPT_FLAGS`), and user args come last.
 */
export function emulatorLaunchArgs(
  avd: string,
  port: number,
  settings: EmulatorLaunchSettings = HEADLESS_LAUNCH,
): string[] {
  const profile = settings.headless
    ? ['-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim', '-no-audio', '-gpu', 'swiftshader_indirect', '-no-window']
    : ['-no-snapshot-save', '-no-boot-anim', '-no-audio'];
  return [
    '-avd', avd,
    '-port', String(port),
    ...TAPSMITH_EMULATOR_IDENTITY_FLAGS,
    ...NO_BLOCKING_PROMPT_FLAGS,
    ...profile,
    ...settings.args,
  ];
}

/**
 * Whether a process command line (`argv`, as tokens) is an emulator that
 * `launchEmulator` started on `port` — and, when given, for `avd`.
 *
 * The `emulator` launcher exec's qemu in place, so the PID Tapsmith records
 * is the qemu process and its argv still carries Tapsmith's arguments. A
 * serial is only a port and ports are reused, so this — not the serial — is
 * what proves an emulator is Tapsmith's to reuse or kill.
 */
export function isTapsmithLaunchedEmulator(
  argv: readonly string[],
  expected: { port: number, avd?: string },
): boolean {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (valueOf('-port') !== String(expected.port)) return false;
  const avd = valueOf('-avd');
  if (avd === undefined || (expected.avd !== undefined && avd !== expected.avd)) return false;
  return TAPSMITH_EMULATOR_IDENTITY_FLAGS.every((flag) => argv.includes(flag));
}

/** Numbers this process's launches, so each gets its own log file. */
let launchSequence = 0;

/**
 * Where a launched emulator's output goes: a file of its own, named for the
 * console port, this process and the launch (PILOT-439). A name per port alone
 * let two launches on one port write to the same file, so an early-exit
 * message could quote the other launch's output.
 */
function emulatorLogPath(port: number): string {
  launchSequence += 1;
  return path.join(os.tmpdir(), `tapsmith-emulator-${port}-${process.pid}-${launchSequence}.log`);
}

/**
 * Launch an emulator instance for the given AVD on the specified port.
 * Returns immediately — use `waitForBoot` to wait until the device is ready,
 * racing it against `exited` so a launch that dies is reported at once.
 */
export function launchEmulator(
  avd: string,
  port: number,
  settings: EmulatorLaunchSettings,
  emulator: string = resolveEmulatorBinary().command,
): LaunchedEmulator {
  const serial = serialForPort(port);
  const logPath = emulatorLogPath(port);

  // Output goes to a file, not a pipe: the emulator outlives this process,
  // and writing to a pipe nobody reads any more would kill it (SIGPIPE).
  let logFd: number | undefined;
  try {
    // O_EXCL (with O_NOFOLLOW for good measure): the temp dir may be shared,
    // so never write through a link or into a file someone planted at this name.
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
    logFd = fs.openSync(logPath, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o600);
  } catch {
    // Unwritable tmpdir — launch without a log rather than not at all.
  }
  const output = logFd ?? 'ignore';

  let proc: ChildProcess;
  try {
    proc = spawn(emulator, emulatorLaunchArgs(avd, port, settings), {
      // Detach so emulators survive parent exit — they're expensive to boot and
      // the next run will reuse them. The PID manifest tracks ownership so
      // orphans from crashes get cleaned up on the next startup.
      detached: true,
      stdio: ['ignore', output, output],
    });
  } finally {
    // The child has its own copy of the descriptor.
    if (logFd !== undefined) fs.closeSync(logFd);
  }
  proc.unref();

  const exited = new Promise<EmulatorExit>((resolve) => {
    // `on`, not `once`: a ChildProcess also emits 'error' when a later
    // kill() fails, and an 'error' with no listener would crash Tapsmith.
    proc.on('error', (error) => resolve({ kind: 'spawn-error', error }));
    proc.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
  });

  // Report the log only when this launch opened it: after a failed open the
  // path may be a planted link or someone else's file, not this output.
  return { process: proc, port, serial, avd, headless: settings.headless, logPath: logFd !== undefined ? logPath : undefined, exited };
}

/** The emulator refusing a `-read-only` instance beside a writable one of the same AVD. */
const WRITABLE_INSTANCE_RUNNING = /^(?:ERROR|FATAL)\b.*another emulator instance is running/im;

/** How many lines of the emulator's output an early-exit message quotes. */
const EXIT_OUTPUT_LINES = 3;

/** The non-empty lines of an emulator log. */
function logLines(log: string): string[] {
  return log.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The `INFO         | ` prefix of a line the emulator logs itself. */
const LOG_LEVEL_PREFIX = /^[A-Z_]+\s*\|\s*/;

/** The last few log lines, without their `LEVEL |` prefix or a trailing full stop. */
function quoteLogLines(lines: readonly string[]): string[] {
  return lines.slice(-EXIT_OUTPUT_LINES).map((line) => line.replace(LOG_LEVEL_PREFIX, '').replace(/\.+$/, ''));
}

/**
 * A launched emulator still running, but not booted within the boot timeout,
 * with the emulator's last output and where the rest of it is: a
 * launch stuck at a prompt says so in its log, and nowhere else.
 */
export function describeBootTimeout(
  timeout: EmulatorBootTimeoutError,
  emu: { logPath: string | undefined },
  readLog: (file: string) => string = (file) => fs.readFileSync(file, 'utf-8'),
): string {
  const base = timeout.message.replace(/\.$/, '');
  if (emu.logPath === undefined) return `${base}.`;
  let quoted: string[] = [];
  try {
    const lines = logLines(readLog(emu.logPath));
    // The emulator's own lines (`INFO | …`), not what it dumps between them:
    // a launch stuck at the crash-report dialog prints the pending report's
    // annotations after the line that says so.
    const own = lines.filter((line) => LOG_LEVEL_PREFIX.test(line));
    quoted = quoteLogLines(own.length > 0 ? own : lines);
  } catch {
    // The log has gone: name where it was.
  }
  const detail = quoted.length > 0 ? ` Its last output: ${quoted.join(' / ')}.` : '';
  return `${base}.${detail} Full output: ${emu.logPath}`;
}

/**
 * Why a launched emulator failed to boot, from how its process ended and
 * what it wrote to its log — so the user sees the emulator's own
 * reason at once instead of a boot timeout minutes later.
 */
export function describeEmulatorExit(
  exit: EmulatorExit,
  emu: { avd: string, logPath: string | undefined },
  emulator: EmulatorBinary,
  readLog: (file: string) => string = (file) => fs.readFileSync(file, 'utf-8'),
): string {
  if (exit.kind === 'spawn-error') {
    if (exit.error.code === 'ENOENT') return emulatorNotFoundMessage(emulator.tried);
    return `Could not start the Android emulator (${emulator.command}): ${exit.error.message}`;
  }
  let log = '';
  try {
    if (emu.logPath !== undefined) log = readLog(emu.logPath);
  } catch {
    // No log (unwritable tmpdir) — describe the exit alone.
  }
  if (WRITABLE_INSTANCE_RUNNING.test(log)) {
    return `AVD ${emu.avd} is already running without -read-only (opened from Android Studio, for example), `
      + 'and the emulator will not start a second instance beside it. '
      + 'Close that emulator, or point `avd` at another AVD.';
  }
  const lines = logLines(log);
  const errors = lines.filter((line) => /^(ERROR|FATAL)\b/.test(line));
  const quoted = quoteLogLines(errors.length > 0 ? errors : lines);
  const how = exit.code !== null ? `exit code ${exit.code}` : `signal ${exit.signal ?? 'unknown'}`;
  const detail = quoted.length > 0 ? `: ${quoted.join(' / ')}` : '';
  const where = emu.logPath !== undefined ? ` Full output: ${emu.logPath}` : '';
  return `The emulator exited during boot (${how})${detail}.${where}`;
}

/**
 * Probe whether a device is healthy enough to be assigned to a worker.
 *
 * Checks:
 * - ADB shell is responsive
 * - Emulators report boot completed
 * - Android package manager is responding
 */
export function probeDeviceHealth(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): DeviceHealthResult {
  const adb = (args: string[], timeout: number): string =>
    String(exec('adb', ['-s', serial, ...args], {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

  try {
    const echo = adb(['shell', 'echo', '__tapsmith_health_ok__'], 5_000);
    if (!echo.includes('__tapsmith_health_ok__')) {
      return { serial, healthy: false, reason: 'ADB shell did not respond correctly' };
    }
  } catch {
    return { serial, healthy: false, reason: 'ADB shell is unresponsive' };
  }

  if (serial.startsWith('emulator-')) {
    try {
      const bootCompleted = adb(['shell', 'getprop', 'sys.boot_completed'], 5_000).trim();
      if (bootCompleted !== '1') {
        return { serial, healthy: false, reason: 'emulator is not fully booted' };
      }
    } catch {
      return { serial, healthy: false, reason: 'emulator boot status could not be read' };
    }
  }

  try {
    const packageManager = adb(['shell', 'pm', 'path', 'android'], 10_000);
    if (!packageManager.includes('package:')) {
      return { serial, healthy: false, reason: 'package manager is not ready' };
    }
  } catch {
    return { serial, healthy: false, reason: 'package manager is unresponsive' };
  }

  const hierarchy = readUiHierarchyViaAdb(serial, exec);
  if (hierarchy) {
    const blockingDialog = detectBlockingSystemDialog(hierarchy);
    if (blockingDialog) {
      // Attempt ADB-level dismissal before declaring unhealthy
      dismissSystemDialogsViaAdb(serial, exec);

      // Re-check after dismissal
      const afterHierarchy = readUiHierarchyViaAdb(serial, exec);
      if (afterHierarchy) {
        const stillBlocked = detectBlockingSystemDialog(afterHierarchy);
        if (stillBlocked) {
          // Named only when unambiguous: several error windows cannot be told apart.
          const owners = blockingDialogOwnersViaAdb(serial, exec);
          const dialog = formatBlockingDialog(stillBlocked, owners.length === 1 ? owners[0] : undefined);
          return { serial, healthy: false, reason: `blocking system dialog detected: ${dialog}` };
        }
      }
    }
  }

  return { serial, healthy: true };
}

/**
 * Filter a device list down to healthy candidates, returning probe results
 * for any devices that should be excluded from worker assignment.
 */
export function filterHealthyDevices(
  serials: string[],
  exec: ExecFileSyncLike = execFileSync,
): { healthySerials: string[]; unhealthyDevices: DeviceHealthResult[] } {
  const healthySerials: string[] = [];
  const unhealthyDevices: DeviceHealthResult[] = [];

  for (const serial of serials) {
    const result = probeDeviceHealth(serial, exec);
    if (result.healthy) {
      healthySerials.push(serial);
    } else {
      unhealthyDevices.push(result);
    }
  }

  return { healthySerials, unhealthyDevices };
}

export function prefilterDevicesForStrategy(
  serials: string[],
  strategy: DeviceStrategy,
  avd: string | undefined,
  resolveAvdName: (serial: string) => string | undefined = getRunningAvdName,
): DevicePrefilterResult {
  if (strategy === 'prefer-connected') {
    return { candidateSerials: serials, selectedSerials: serials, skippedDevices: [] };
  }

  if (!avd) {
    throw new Error('deviceStrategy "avd-only" requires `avd` to be set in config');
  }

  const candidateSerials: string[] = [];
  const selectedSerials: string[] = [];
  const skippedDevices: Array<{ serial: string; reason: string }> = [];

  for (const serial of serials) {
    if (!serial.startsWith('emulator-')) {
      skippedDevices.push({
        serial,
        reason: `device is not an emulator instance of requested AVD ${avd}`,
      });
      continue;
    }

    const runningAvd = resolveAvdName(serial);
    if (runningAvd === avd) {
      candidateSerials.push(serial);
      selectedSerials.push(serial);
      continue;
    }

    if (runningAvd) {
      skippedDevices.push({
        serial,
        reason: `running AVD ${runningAvd} does not match requested AVD ${avd}`,
      });
      continue;
    }

    // If we cannot determine the AVD yet, keep the device in play so later
    // health/selection checks can make a more informed decision.
    candidateSerials.push(serial);
  }

  return { candidateSerials, selectedSerials, skippedDevices };
}

export function selectDevicesForStrategy(
  serials: string[],
  strategy: DeviceStrategy,
  avd: string | undefined,
  resolveAvdName: (serial: string) => string | undefined = getRunningAvdName,
): DeviceSelectionResult {
  if (strategy === 'prefer-connected') {
    return { selectedSerials: serials, skippedDevices: [] };
  }

  if (!avd) {
    throw new Error('deviceStrategy "avd-only" requires `avd` to be set in config');
  }

  const selectedSerials: string[] = [];
  const skippedDevices: Array<{ serial: string; reason: string }> = [];

  for (const serial of serials) {
    const runningAvd = serial.startsWith('emulator-') ? resolveAvdName(serial) : undefined;
    if (runningAvd === avd) {
      selectedSerials.push(serial);
      continue;
    }

    skippedDevices.push({
      serial,
      reason: serial.startsWith('emulator-')
        ? `running AVD ${runningAvd ?? 'unknown'} does not match requested AVD ${avd}`
        : `device is not an emulator instance of requested AVD ${avd}`,
    });
  }

  return { selectedSerials, skippedDevices };
}

/**
 * Disambiguate among already-running devices that all match the requested AVD
 * by preferring the instance(s) where the app under test is installed.
 *
 * The same AVD can be booted more than once (the emulator allows it with
 * `-read-only`), so AVD-name matching alone can select a foreign instance —
 * e.g. a leftover emulator from another project's run that happens to share
 * the generic AVD name but doesn't have this project's app installed. Selecting
 * it silently runs (and "restores app state") against the wrong app.
 *
 * Rule: when at least one matching instance has the package installed, drop the
 * ones that don't. When *none* have it (fresh boots before Tapsmith installs
 * the app, or no `package` configured), keep everything — this filter must not
 * reject a legitimately-empty freshly-booted emulator.
 */
export function filterPreferInstalledApp(
  serials: string[],
  packageName: string | undefined,
  isInstalled: (serial: string, packageName: string) => boolean = isPackageInstalled,
): DeviceSelectionResult {
  if (!packageName || serials.length <= 1) {
    return { selectedSerials: serials, skippedDevices: [] };
  }

  const installed: string[] = [];
  const missing: string[] = [];
  for (const serial of serials) {
    if (isInstalled(serial, packageName)) installed.push(serial);
    else missing.push(serial);
  }

  // No instance has the app yet (fresh boots / install pending) — leave the
  // set untouched so the normal install-then-run flow proceeds.
  if (installed.length === 0) {
    return { selectedSerials: serials, skippedDevices: [] };
  }

  return {
    selectedSerials: installed,
    skippedDevices: missing.map((serial) => ({
      serial,
      reason: `app ${packageName} is not installed (another running instance of AVD shares this name but has the app)`,
    })),
  };
}

/**
 * How long a launched emulator gets to reach `sys.boot_completed`. A cold
 * boot on a hosted CI runner (software GPU, shared cores, often beside
 * another emulator) regularly needs more than the two minutes that suffice
 * on a developer machine.
 */
export const EMULATOR_BOOT_TIMEOUT_MS = runningInCi ? 300_000 : 120_000;

const execFileAsync = promisify(execFile);

/** Thrown by `waitForBoot` when its `signal` aborts the wait. */
class BootWaitAborted extends Error {}

/** Thrown by `waitForBoot` when the emulator has not booted within its timeout. */
export class EmulatorBootTimeoutError extends Error {}

/**
 * Wait for an emulator to finish booting.
 * Polls `adb -s <serial> shell getprop sys.boot_completed` until it returns "1".
 */
export async function waitForBoot(
  serial: string,
  timeoutMs = EMULATOR_BOOT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  const pollInterval = 2_000;
  // Asynchronous, so an emulator that dies mid-wait (`LaunchedEmulator.exited`)
  // is noticed at once instead of after a blocking adb call returns.
  const adb = (args: string[], timeout: number) =>
    execFileAsync('adb', ['-s', serial, ...args], { encoding: 'utf-8', timeout, signal });
  const checkAborted = () => {
    if (signal?.aborted) throw new BootWaitAborted(`Stopped waiting for ${serial} to boot`);
  };

  // First wait for the device to appear in ADB
  while (Date.now() - start < timeoutMs) {
    checkAborted();
    try {
      await adb(['wait-for-device'], 10_000);
      break;
    } catch {
      checkAborted();
      await sleep(pollInterval);
    }
  }

  // Then wait for boot_completed
  while (Date.now() - start < timeoutMs) {
    checkAborted();
    try {
      const { stdout } = await adb(['shell', 'getprop', 'sys.boot_completed'], 5_000);
      if (stdout.trim() === '1') {
        // Boot flag is set — now wait for system services to actually settle.
        // This prevents the "passes health check then stalls" pattern where
        // the launcher/PM are still initializing.
        const remainingMs = Math.max(timeoutMs - (Date.now() - start), 10_000);
        await waitForSystemSettle(serial, remainingMs, execFileSync, signal);
        checkAborted();
        return;
      }
    } catch {
      // Device not ready yet
    }
    checkAborted();
    await sleep(pollInterval);
  }

  throw new EmulatorBootTimeoutError(`Emulator ${serial} did not boot within ${timeoutMs / 1000}s`);
}

export async function waitForDeviceStability(
  serial: string,
  timeoutMs = DEFAULT_DEVICE_STABILITY_TIMEOUT_MS,
  probe: (serial: string) => DeviceHealthResult = probeDeviceHealth,
  /** Stops probing — e.g. the emulator exited, so it can never become stable. */
  signal?: AbortSignal,
): Promise<DeviceHealthResult> {
  const start = Date.now();
  let consecutiveHealthy = 0;
  let lastResult: DeviceHealthResult = {
    serial,
    healthy: false,
    reason: 'device stability checks did not complete',
  };

  while (Date.now() - start < timeoutMs && !signal?.aborted) {
    const result = probe(serial);
    lastResult = result;

    if (result.healthy) {
      consecutiveHealthy += 1;
      if (consecutiveHealthy >= REQUIRED_STABLE_HEALTH_CHECKS) {
        return result;
      }
    } else {
      consecutiveHealthy = 0;
    }

    await sleep(DEVICE_STABILITY_POLL_MS);
  }

  return lastResult;
}

// ─── Emulator shutdown ───

/**
 * Find the OS PID of an emulator process by its console port.
 *
 * When ADB is unresponsive, `adb emu kill` silently fails. We need to find
 * and kill the process directly. The emulator listens on the console port,
 * so we use `lsof` to find the PID.
 */
export function findEmulatorPid(serial: string): number | undefined {
  const match = serial.match(/^emulator-(\d+)$/);
  if (!match) return undefined;

  const port = match[1];
  try {
    const output = execFileSync(
      'lsof',
      ['-ti', `TCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const pid = parseInt(output.trim().split('\n')[0], 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Kill an emulator by serial.
 *
 * Tries `adb emu kill` first (graceful), then falls back to finding and
 * killing the OS process directly. This handles cases where ADB is
 * unresponsive but the emulator process is still alive.
 */
export function killEmulator(serial: string): void {
  // Try graceful shutdown via ADB
  try {
    execFileSync('adb', ['-s', serial, 'emu', 'kill'], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch {
    // ADB may be unresponsive — fall through to process kill
  }

  // Also kill by OS process as a fallback. Even if `emu kill` succeeded,
  // this is harmless and ensures the process is actually gone.
  const pid = findEmulatorPid(serial);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already dead
    }
  }

  // Disconnect the ADB transport so it doesn't linger as offline/stale
  try {
    execFileSync('adb', ['disconnect', serial], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch {
    // Best effort
  }
}

/** How long each signal gets to stop a failed launch before the next. */
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 100;

interface StopLaunchedEmulatorDeps {
  sleep: (ms: number) => Promise<void>
  /** How long SIGTERM, then SIGKILL, gets to take effect. */
  graceMs: number
}

/**
 * Stop an emulator process this process launched, whose launch failed:
 * SIGTERM, then SIGKILL if it is still running after a grace
 * period. An emulator showing a modal dialog ignores SIGTERM.
 *
 * Only the spawned process is signalled, through its `ChildProcess` — which
 * does nothing once it has exited, so a PID the system has since reused is
 * never touched. (The `emulator` launcher exec's qemu, so that process is the
 * emulator.) Not its process group: that may hold helpers other emulators share.
 *
 * Resolves `true` once it has exited, `false` if it survived SIGKILL — the
 * caller must then keep it recorded, not forget it.
 */
export async function stopLaunchedEmulator(
  emu: Pick<LaunchedEmulator, 'process'>,
  deps: Partial<StopLaunchedEmulatorDeps> = {},
): Promise<boolean> {
  const wait = deps.sleep ?? sleep;
  const graceMs = deps.graceMs ?? STOP_GRACE_MS;
  const proc = emu.process;
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  // Never spawned, or already gone: nothing to stop.
  if (proc.pid === undefined || exited()) return true;

  const stoppedWithin = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!exited()) {
      if (Date.now() >= deadline) return false;
      await wait(STOP_POLL_MS);
    }
    return true;
  };
  const send = (sig: NodeJS.Signals) => {
    try {
      proc.kill(sig);
    } catch {
      // Exited in the meantime.
    }
  };

  send('SIGTERM');
  if (await stoppedWithin(graceMs)) return true;
  send('SIGKILL');
  return stoppedWithin(graceMs);
}

/**
 * Wait for killed emulator serials to disappear from `adb devices`.
 *
 * After killing emulators, their transports linger in ADB for a few seconds.
 * This function polls until all the specified serials are gone or in a
 * terminal state (offline), with a short timeout so we don't block forever.
 */
function waitForAdbSettle(killedSerials: string[], timeoutMs = 10_000): void {
  const start = Date.now();
  const pending = new Set(killedSerials);

  while (pending.size > 0 && Date.now() - start < timeoutMs) {
    const devices = listAdbDevices();
    const activeSerials = new Set(
      devices
        .filter((d) => d.state === 'device' || d.state === 'unauthorized')
        .map((d) => d.serial),
    );

    for (const serial of [...pending]) {
      if (!activeSerials.has(serial)) {
        pending.delete(serial);
      }
    }

    if (pending.size > 0) {
      sleepSync(1_000);
    }
  }
}

// ─── High-level orchestration ───

export interface ProvisionResult {
  launched: LaunchedEmulator[]
  allSerials: string[]
}

interface ProvisionDeps {
  resolveEmulatorBinary: () => EmulatorBinary
  listAvds: (emulator: string) => string[]
  listAdbDevices: () => AdbDeviceEntry[]
  getRunningAvdName: (serial: string) => string | undefined
  launchEmulator: (avd: string, port: number, settings: EmulatorLaunchSettings, emulator: string) => LaunchedEmulator
  waitForBoot: (serial: string, timeoutMs?: number, signal?: AbortSignal) => Promise<void>
  probeDeviceHealth: (serial: string) => DeviceHealthResult
  waitForDeviceStability: (
    serial: string,
    timeoutMs?: number,
    probe?: (serial: string) => DeviceHealthResult,
    signal?: AbortSignal,
  ) => Promise<DeviceHealthResult>
  killEmulator: (serial: string) => void
  /** Stops a failed launch's process; `false` when it survived (`stopLaunchedEmulator`). */
  stopLaunchedEmulator: (emu: LaunchedEmulator) => Promise<boolean>
  findEmulatorPid: (serial: string) => number | undefined
  reserveEmulatorPort: (usedPorts: ReadonlySet<number>) => Promise<PortReservation>
  /** Settles once a just-spawned emulator has started up (or will not). */
  waitForEmulatorStartup: (emu: LaunchedEmulator) => Promise<void>
  /** How many emulators boot at once. */
  launchConcurrency: number
  /** `resolveEmulatorLaunchSettings`, judged against the real environment. */
  resolveLaunchSettings: (options: EmulatorLaunchOptions | undefined) => EmulatorLaunchSettings & { windowUnavailable?: string }
  /** Turns macOS App Nap off for the emulator's qemu (`disableEmulatorAppNap`). */
  disableAppNap: (emulator: string) => EmulatorAppNapResult
  platform: NodeJS.Platform
}

/**
 * How many emulators to boot at once: one per two cores. An emulator boot
 * keeps several cores busy, so more at once only slows every boot down.
 */
function defaultLaunchConcurrency(): number {
  return Math.max(1, Math.floor(os.availableParallelism() / 2));
}

/**
 * The extra time a boot (and its stability checks) gets for each other boot
 * running beside it: about how long one boot's synchronous post-boot checks
 * hold the event loop on a busy host.
 */
const CONCURRENT_BOOT_ALLOWANCE_MS = 30_000;

/** How long a launch that exited 0 gets to show a backgrounded emulator on its console port. */
const CLEAN_EXIT_GRACE_MS = 5_000;

/**
 * Ensure enough emulators are running to satisfy the requested worker count.
 *
 * - Discovers already-running devices from the provided list
 * - Launches additional emulators if `launchEmulators` is true and an `avd` is specified
 * - Returns the full list of device serials and handles to launched emulators (for cleanup)
 */
export async function provisionEmulators(opts: {
  existingSerials: string[]
  occupiedSerials?: string[]
  workers: number
  avd?: string
  /**
   * The config's `emulatorLaunchOptions`. Required (though it may be
   * undefined) so no caller can forget to pass it.
   */
  launchOptions: EmulatorLaunchOptions | undefined
  onProgress?: (message: string, level?: 'info' | 'warning') => void
}, deps: Partial<ProvisionDeps> = {}): Promise<ProvisionResult> {
  const { existingSerials, occupiedSerials = existingSerials, workers, avd, onProgress } = opts;
  const logProgress = (message: string, level: 'info' | 'warning' = 'info') => {
    if (onProgress) {
      onProgress(message, level);
    } else if (level === 'warning') {
      process.stderr.write(`${YELLOW}${message}${RESET}\n`);
    } else {
      process.stderr.write(`${DIM}${message}${RESET}\n`);
    }
  };
  const resolvedDeps: ProvisionDeps = {
    resolveEmulatorBinary: deps.resolveEmulatorBinary ?? resolveEmulatorBinary,
    listAvds: deps.listAvds ?? listAvds,
    listAdbDevices: deps.listAdbDevices ?? listAdbDevices,
    getRunningAvdName: deps.getRunningAvdName ?? getRunningAvdName,
    launchEmulator: deps.launchEmulator ?? launchEmulator,
    waitForBoot: deps.waitForBoot ?? waitForBoot,
    probeDeviceHealth: deps.probeDeviceHealth ?? probeDeviceHealth,
    waitForDeviceStability: deps.waitForDeviceStability ?? waitForDeviceStability,
    killEmulator: deps.killEmulator ?? killEmulator,
    stopLaunchedEmulator: deps.stopLaunchedEmulator ?? ((emu) => stopLaunchedEmulator(emu)),
    findEmulatorPid: deps.findEmulatorPid ?? findEmulatorPid,
    reserveEmulatorPort: deps.reserveEmulatorPort ?? reserveEmulatorPort,
    waitForEmulatorStartup: deps.waitForEmulatorStartup ?? waitForEmulatorStartup,
    launchConcurrency: deps.launchConcurrency ?? defaultLaunchConcurrency(),
    resolveLaunchSettings: deps.resolveLaunchSettings ?? ((options) => resolveEmulatorLaunchSettings(options)),
    disableAppNap: deps.disableAppNap ?? ((command) => disableEmulatorAppNap(command)),
    platform: deps.platform ?? process.platform,
  };
  const needed = workers - existingSerials.length;

  if (needed <= 0) {
    return { launched: [], allSerials: existingSerials.slice(0, workers) };
  }

  // Without the binary nothing below can work: say so now, not after a boot
  // timeout (PILOT-417).
  const emulator = resolvedDeps.resolveEmulatorBinary();
  if (!emulator.found) {
    throw new Error(emulatorNotFoundMessage(emulator.tried));
  }

  const avds = resolvedDeps.listAvds(emulator.command);
  if (avds.length === 0) {
    throw new Error(
      `Need ${needed} more emulator(s) but no AVDs found. ` +
      'Create an AVD with Android Studio or `avdmanager`, or set the `avd` config option.',
    );
  }

  // Track which AVDs are already running. We still prefer the requested AVD
  // even when it is already in use, because Tapsmith launches new instances with
  // -read-only and should treat "N workers on N instances of the same AVD"
  // as the primary supported path.
  const runningAvds = new Set<string>();
  for (const serial of occupiedSerials) {
    if (serial.startsWith('emulator-')) {
      const name = resolvedDeps.getRunningAvdName(serial);
      if (name) runningAvds.add(name);
    }
  }

  const launchCandidates = resolveLaunchCandidates(avds, avd, runningAvds);

  // Determine which ports are already in use. Besides the caller's online
  // devices, reserve every emulator adb knows in any state: an offline or
  // unauthorized emulator Tapsmith did not launch is left running by
  // cleanupStaleEmulators and still holds its console port (PILOT-401).
  const usedPorts = new Set<number>();
  const adbSerials = resolvedDeps.listAdbDevices().map((device) => device.serial);
  for (const serial of [...occupiedSerials, ...adbSerials]) {
    const match = serial.match(/^emulator-(\d+)$/);
    if (match) {
      usedPorts.add(parseInt(match[1], 10));
    }
  }

  // Launch emulators
  const badAvds = new Set<string>();
  const existingCount = existingSerials.length;
  const existingNote = existingCount > 0
    ? ` (${existingCount} already connected, need ${workers} total)`
    : '';
  const settings = resolvedDeps.resolveLaunchSettings(opts.launchOptions);
  // Only an explicit `headless: false` is worth a warning; the default just
  // adapts, and the Starting line below says why.
  if (settings.windowUnavailable && opts.launchOptions?.headless === false) {
    logProgress(`Launching emulators headless although emulatorLaunchOptions.headless is false: ${settings.windowUnavailable}.`, 'warning');
  }
  // macOS App Nap throttles a windowed emulator once its window is hidden or
  // the display sleeps; the emulator reads the opt-out only at launch (PILOT-515).
  let appNapDisabled: boolean | undefined;
  if (!settings.headless && resolvedDeps.platform === 'darwin') {
    const appNap = resolvedDeps.disableAppNap(emulator.command);
    appNapDisabled = appNap.kind === 'disabled';
    const notice = describeEmulatorAppNap(appNap);
    if (notice) logProgress(notice.message, notice.level);
  }
  if (avd) {
    logProgress(`Launching ${needed} emulator(s) using AVD ${avd}${existingNote}...`);
  } else {
    logProgress(`Launching ${needed} emulator(s) from available AVDs (${launchCandidates.join(', ')})${existingNote}...`);
  }

  // Boots side by side share the host's event loop, which one boot's
  // synchronous post-boot checks hold for tens of seconds while the others'
  // polls wait. So each boot, and the stability checks after it, gets an
  // allowance for every other boot running beside it — not a multiple of the
  // whole budget, which would leave a wedged boot holding the batch for many
  // minutes on a host that boots many at once.
  const laneCount = Math.min(Math.max(1, resolvedDeps.launchConcurrency), needed);
  const sideBySideAllowanceMs = (laneCount - 1) * CONCURRENT_BOOT_ALLOWANCE_MS;
  const bootTimeoutMs = EMULATOR_BOOT_TIMEOUT_MS + sideBySideAllowanceMs;
  const stabilityTimeoutMs = DEFAULT_DEVICE_STABILITY_TIMEOUT_MS + sideBySideAllowanceMs;

  /**
   * Launch and boot one emulator, trying each candidate AVD that has not
   * already failed. Its failures are its own: they never stop the others.
   */
  const launchOne = async (index: number): Promise<LaunchedEmulator | undefined> => {
    for (const candidateAvd of launchCandidates) {
      if (badAvds.has(candidateAvd)) continue;

      let reservation: PortReservation;
      try {
        reservation = await resolvedDeps.reserveEmulatorPort(usedPorts);
      } catch (err) {
        logProgress(err instanceof Error ? err.message : String(err), 'warning');
        return undefined;
      }
      const { port } = reservation;
      // Never again in this call, even once the reservation is released.
      usedPorts.add(port);

      // Spawn only once the launch before this one has started up.
      const previousStarted = startupGate;
      let markStarted!: () => void;
      startupGate = new Promise<void>((resolve) => { markStarted = resolve; });

      let emu: LaunchedEmulator | undefined;
      const stopWaiting = new AbortController();
      let booting = true;
      let booted = false;
      try {
        await previousStarted;
        emu = resolvedDeps.launchEmulator(candidateAvd, port, settings, emulator.command);
        if (appNapDisabled !== undefined) emu.appNapDisabled = appNapDisabled;
        const launchedEmu = emu;
        void resolvedDeps.waitForEmulatorStartup(launchedEmu).catch(() => undefined).finally(markStarted);
        // Recorded at once, not when every boot is done: an interrupted run
        // leaves it recorded, so the next run reuses or stops it (PILOT-441).
        recordLaunchedEmulators([launchedEmu], { booting: true });
        bootingThisProcess.set(launchedEmu.serial, launchedEmu);
        logProgress(`Starting ${launchedEmu.serial} (port ${port}, AVD ${candidateAvd}, ${settings.headless ? `headless${settings.windowUnavailable ? `: ${settings.windowUnavailable}` : ''}` : 'with a window'})`);

        // Race the boot against the process ending: an emulator that fails to
        // spawn or exits during boot is reported with its own reason at once,
        // not after the full boot timeout (PILOT-417).
        const exitedDuringBoot = new Promise<never>((_resolve, reject) => {
          void launchedEmu.exited.then((exit) => {
            if (!booting) return;
            const fail = () => {
              // Abort first, so the boot branch cannot start another probe.
              stopWaiting.abort();
              reject(new EmulatorExitedError(describeEmulatorExit(exit, launchedEmu, emulator)));
            };
            if (exit.kind !== 'exited' || exit.code !== 0) {
              fail();
              return;
            }
            // A clean exit is either the emulator quitting (its window closed
            // mid-boot) or a launcher that backgrounds it (a PATH wrapper).
            // The backgrounded emulator holds its console port within seconds.
            setTimeout(() => {
              if (booting && resolvedDeps.findEmulatorPid(launchedEmu.serial) === undefined) fail();
            }, CLEAN_EXIT_GRACE_MS);
          });
        });
        exitedDuringBoot.catch(() => { /* surfaced through the race below */ });

        await Promise.race([
          (async () => {
            await resolvedDeps.waitForBoot(launchedEmu.serial, bootTimeoutMs, stopWaiting.signal);
            // The race may already have been lost to an exit: probe no further.
            if (stopWaiting.signal.aborted) return;
            const health = await resolvedDeps.waitForDeviceStability(
              launchedEmu.serial,
              stabilityTimeoutMs,
              resolvedDeps.probeDeviceHealth,
              stopWaiting.signal,
            );
            if (!health.healthy) {
              throw new Error(health.reason ?? 'device health probe failed');
            }
          })(),
          exitedDuringBoot,
        ]);
        markLaunchedEmulatorsReady([launchedEmu]);
        booted = true;
        return launchedEmu;
      } catch (err) {
        if (emu === undefined) throw err;
        badAvds.add(candidateAvd);
        const message = err instanceof EmulatorBootTimeoutError
          ? describeBootTimeout(err, emu)
          : err instanceof Error ? err.message : String(err);
        logProgress(
          `Skipping launched emulator ${emu.serial} (${candidateAvd}): ${message.replace(/\.$/, '')}.`,
          'warning',
        );
        // A process that already ended holds nothing to stop — and its port
        // may be someone else's by now, so never kill by serial then.
        let stopped = true;
        if (!(err instanceof EmulatorExitedError)) {
          resolvedDeps.killEmulator(emu.serial);
          stopped = await resolvedDeps.stopLaunchedEmulator(emu);
        }
        if (stopped) {
          unrecordLaunchedEmulators([emu]);
        } else {
          // Never left running untracked (PILOT-512): its record stays for a
          // later run's reclaim to judge.
          const pid = emu.process.pid;
          logProgress(
            `Emulator ${emu.serial} (PID ${pid}) did not exit even after SIGKILL, following its failed launch. `
            + 'It stays in Tapsmith\'s emulator record rather than running untracked.',
            'warning',
          );
        }
      } finally {
        booting = false;
        stopWaiting.abort();
        // Booted ones stay registered until provisionEmulators hands them
        // back, so an interrupt in the meantime stops them too.
        if (emu !== undefined && !booted) bootingThisProcess.delete(emu.serial);
        // Never spawned: let the next launch go ahead.
        if (emu === undefined) markStarted();
        await reservation.release();
      }
    }

    logProgress(
      `Unable to provision additional emulator ${index + 1}/${needed}; ${avd ? `AVD ${avd}` : 'all candidate AVDs'} did not start healthy (see above).`,
      'warning',
    );
    return undefined;
  };

  // Boot them side by side rather than one after another (PILOT-495), as many
  // at a time as the host has cores for: each boot is CPU-heavy, and too many
  // at once on a small host would push every one past its boot timeout.
  const results: Array<LaunchedEmulator | undefined> = new Array(needed).fill(undefined);
  let nextIndex = 0;
  const lanes = Array.from({ length: laneCount }, async () => {
    while (nextIndex < needed) {
      const index = nextIndex++;
      results[index] = await launchOne(index);
    }
  });
  // Every launch finishes (booted, or failed and stopped) before any error
  // escapes, so nothing is left booting unawaited.
  const settled = await Promise.allSettled(lanes);
  const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  const launched = results.filter((emu): emu is LaunchedEmulator => emu !== undefined);
  // Handed back now: the caller owns them from here.
  for (const emu of launched) bootingThisProcess.delete(emu.serial);
  if (failure) {
    for (const emu of launched) launchedThisProcess.set(emu.serial, emu);
    throw failure.reason;
  }

  if (launched.length > 0) {
    for (const emu of launched) launchedThisProcess.set(emu.serial, emu);
    logProgress(`Provisioned ${launched.length} healthy emulator(s).`);
    // Said now as well as at the end: a run that is interrupted (Ctrl+C)
    // never reaches its end-of-run notice, and the emulator survives it.
    for (const emu of launched) {
      logProgress(`${emu.serial} stays running after the run for faster reruns. Stop it with: adb -s ${emu.serial} emu kill`, 'warning');
    }
  }

  const allSerials = [
    ...existingSerials,
    ...launched.map((emu) => emu.serial),
  ].slice(0, workers);

  return { launched, allSerials };
}

/**
 * Normal exit cleanup — leave emulators running for reuse by the next run.
 *
 * Emulators are expensive to boot (30-60s). On normal exit we intentionally
 * keep them alive so the next `npx tapsmith test` can reuse them instantly.
 * The PID manifest is preserved so the next run knows they're ours.
 *
 * Only ADB port forwards (created by per-worker daemons) are cleaned up,
 * since stale forwards break subsequent runs.
 */
export function preserveEmulatorsForReuse(
  launched: LaunchedEmulator[],
  write: (text: string) => void = (text) => { process.stderr.write(text); },
): void {
  // Emulators stay alive and in the PID manifest so the next run can reuse
  // them via reclaimOrphanedEmulators(). Say so: a headless emulator has no
  // window or Dock icon, so otherwise nothing shows it is still running.
  for (const emu of launched) {
    // One that exited during the run (a closed window, a crash) is not left running.
    if (emu.process.exitCode != null || emu.process.signalCode != null) continue;
    // Named once per process, however many teardown paths reach here.
    if (announcedLeftRunning.has(emu.process)) continue;
    announcedLeftRunning.add(emu.process);
    write(`${DIM}${leftRunningNotice(emu)}${RESET}\n`);
  }
}

const announcedLeftRunning = new WeakSet<ChildProcess>();

/** The end-of-run line for an emulator Tapsmith leaves running (PILOT-402). */
function leftRunningNotice(emu: Pick<LaunchedEmulator, 'serial' | 'avd' | 'headless'>): string {
  return `Left ${emu.serial} (AVD ${emu.avd}${emu.headless ? ', headless' : ''}) running for faster reruns. `
    + `Stop it with: adb -s ${emu.serial} emu kill`;
}

/**
 * Emergency cleanup — kill everything. Used on SIGINT/SIGTERM or fatal errors
 * where we can't guarantee the emulators will be in a usable state.
 */
export function forceCleanupEmulators(launched: LaunchedEmulator[]): void {
  for (const emu of launched) {
    killEmulator(emu.serial);
    try {
      emu.process.kill('SIGTERM');
    } catch {
      // Already dead
    }
  }
  unrecordLaunchedEmulators(launched);
  for (const emu of launched) launchedThisProcess.delete(emu.serial);
}

/**
 * Every emulator this process launched and has not force-killed, whatever
 * became of the run that launched it — a target whose setup failed after the
 * boot, a project switch. It is what the end-of-run notice names, so an
 * emulator is never left running without one (PILOT-402).
 */
const launchedThisProcess = new Map<string, LaunchedEmulator>();

export function emulatorsLaunchedThisProcess(): LaunchedEmulator[] {
  return [...launchedThisProcess.values()];
}

/**
 * Emulators this process has spawned that `provisionEmulators` has not yet
 * handed back: still booting, or booted while others in its batch boot.
 */
const bootingThisProcess = new Map<string, LaunchedEmulator>();

/**
 * Emulators a provisioning in progress has launched and not yet handed back
 * — for an interrupted run to stop: the caller does not know about them yet,
 * so nothing else will.
 */
export function emulatorsBootingThisProcess(): LaunchedEmulator[] {
  return [...bootingThisProcess.values()];
}


function resolveLaunchCandidates(
  avds: string[],
  requestedAvd: string | undefined,
  runningAvds: Set<string>,
): string[] {
  if (!requestedAvd) {
    const available = avds.filter((avd) => !runningAvds.has(avd));
    if (available.length === 0) {
      throw new Error(
        'No launchable AVDs are available. All discovered AVDs are already running.',
      );
    }
    process.stderr.write(
      `${YELLOW}No avd specified in config. Use the 'avd' config option to control which AVD is launched.${RESET}\n`,
    );
    return available;
  }

  if (!avds.includes(requestedAvd)) {
    throw new Error(
      `AVD "${requestedAvd}" not found. Available AVDs: ${avds.join(', ') || '(none)'}`,
    );
  }

  // Same-AVD multi-instance is the normal path — no warning needed.

  return [requestedAvd];
}

// ─── Helpers ───

/** A launched emulator's process ended before it finished booting. */
class EmulatorExitedError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Block the current thread for `ms` milliseconds without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
