/**
 * iOS simulator management utilities.
 *
 * Parallel to `emulator.ts` for Android, this module wraps `xcrun simctl`
 * commands for discovering, booting, and managing iOS simulators.
 *
 * All simctl calls are synchronous (`execFileSync`) because the parallel
 * provisioning loop needs deterministic ordering — clone, boot, and health
 * checks must complete in sequence per simulator. `Atomics.wait` is used for
 * brief sleeps between retries since `setTimeout` requires an async context.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLockSync } from './file-lock.js';
import { iosToolchainBlocker } from './toolchain.js';
import { DeviceClaimedError, claimDevice, currentSession, devicesHeldElsewhere, withoutHeldDevices } from './device-claims.js';

export interface SimulatorInfo {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  runtime: string
  deviceType: string
}

/**
 * List all available iOS simulators.
 * Returns only simulators marked as available by Xcode.
 */
export function listSimulators(): SimulatorInfo[] {
  try {
    const output = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf-8',
      timeout: 30_000,
      // A failure is reported as "no simulators" by the caller; xcrun's own
      // "unable to find utility" lines would only repeat on every retry.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(output) as {
      devices: Record<string, Array<{
        udid: string
        name: string
        state: string
        isAvailable: boolean
        deviceTypeIdentifier?: string
      }>>
    };

    const simulators: SimulatorInfo[] = [];
    for (const [runtime, devices] of Object.entries(parsed.devices)) {
      for (const device of devices) {
        if (device.isAvailable) {
          simulators.push({
            udid: device.udid,
            name: device.name,
            state: device.state,
            isAvailable: device.isAvailable,
            runtime,
            deviceType: device.deviceTypeIdentifier ?? '',
          });
        }
      }
    }

    return simulators;
  } catch {
    return [];
  }
}

/**
 * Get the screen scale (device pixel ratio) for an iOS simulator.
 * iPads are @2x, all modern iPhones are @3x.
 * Falls back to 3 if the device is unknown.
 */
export function getSimulatorScreenScale(udid: string): number {
  const sim = listSimulators().find((s) => s.udid === udid);
  if (sim && /iPad/i.test(sim.name)) return 2;
  if (sim && /iPhone (6|7|8|SE|XR|11)(?!.*Plus|.*Max|.*Pro)/i.test(sim.name)) return 2;
  return 3;
}

/**
 * List booted iOS simulators.
 */
export function listBootedSimulators(): SimulatorInfo[] {
  return listSimulators().filter((s) => s.state === 'Booted');
}

/** Whether `name` is one Tapsmith gives its clones of `source` (`<source> (Tapsmith Worker N)`). */
function isTapsmithCloneOf(name: string, source: string): boolean {
  const suffix = name.startsWith(`${source} (Tapsmith Worker `) ? name.slice(source.length) : '';
  return /^ \(Tapsmith Worker \d+\)$/.test(suffix);
}

/**
 * The booted simulators a run may adopt for `simulator: <configured>`: those
 * whose name or UDID is the configured value, and Tapsmith's own clones of it
 * (`<configured> (Tapsmith Worker N)`, the names `provisionSimulators` gives
 * them). Any other booted simulator is left alone — it may be one
 * the developer is using — and so is one another live Tapsmith session has
 * claimed.
 *
 * Only simulators on one iOS runtime are returned, because the agent's
 * xctestrun is OS-version-specific (one built for iOS 26.4 fails on 26.1):
 * the runtime of `compatibleWith` when given (the session's primary), else of
 * the first match. `among` restricts the result to those UDIDs, in that order
 * (e.g. the simulators the daemon reports).
 */
export function listAdoptableBootedSimulators(
  configured: string,
  opts: { among?: readonly string[]; compatibleWith?: string } = {},
): SimulatorInfo[] {
  const booted = listBootedSimulators();
  // Never one another live Tapsmith session holds (PILOT-381): adopting it
  // puts two sessions' agents on one simulator.
  const held = new Set(withoutHeldDevices(booted.map((s) => s.udid)).held.map((c) => c.device));
  let matching = booted.filter((s) =>
    (s.name === configured || s.udid === configured || isTapsmithCloneOf(s.name, configured)) && !held.has(s.udid),
  );
  if (opts.among) {
    const byUdid = new Map(matching.map((s) => [s.udid, s]));
    matching = opts.among.flatMap((udid) => {
      const sim = byUdid.get(udid);
      return sim ? [sim] : [];
    });
  }
  const anchor = opts.compatibleWith !== undefined
    ? booted.find((s) => s.udid === opts.compatibleWith)
    : matching[0];
  if (!anchor) return [];
  return matching.filter((s) => s.runtime === anchor.runtime);
}

/**
 * Boot a simulator by UDID.
 */
export function bootSimulator(udid: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'boot', udid], {
      timeout: 30_000,
    });
  } catch (err) {
    // "Unable to boot device in current state: Booted" is not an error.
    // Check both the error message and stderr output.
    const errObj = err as { message?: string; stderr?: Buffer | string };
    const msg = errObj.message ?? '';
    const stderr = errObj.stderr?.toString() ?? '';
    if (!msg.includes('Booted') && !stderr.includes('Booted')) {
      throw err;
    }
  }
}

/**
 * How long a freshly booted simulator gets to finish booting. `simctl boot`
 * returns as soon as the device reaches the `Booted` state, well before
 * SpringBoard, installd and the launch services are up; on a hosted CI
 * runner that already hosts another simulator the rest takes minutes.
 */
export const SIMULATOR_BOOT_TIMEOUT_MS = process.env.CI ? 300_000 : 120_000;

/**
 * Block until a booted simulator has actually finished booting
 * (`simctl bootstatus -b`), so the install and agent start that follow do
 * not race installd and time out on a simulator that is technically
 * `Booted`. Returns false (rather than throwing) when the wait times out or
 * `bootstatus` is unavailable: the caller's install / agent start retry on
 * their own, and a slow simulator is still better than no simulator.
 */
export function waitForSimulatorBootComplete(udid: string, timeoutMs = SIMULATOR_BOOT_TIMEOUT_MS): boolean {
  try {
    execFileSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: timeoutMs, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shutdown a simulator by UDID.
 */
export function shutdownSimulator(udid: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'shutdown', udid], {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch {
    // Shutting down an already-shutdown simulator is fine
  }
}

/**
 * Reboot a simulator: shutdown then boot. Handles simulators stuck in
 * "Shutting Down" state by waiting for the shutdown to complete before
 * booting.
 */
export function rebootSimulator(udid: string): void {
  shutdownSimulator(udid);

  // Wait for the simulator to fully shut down (up to 15s).
  // Simulators in "Shutting Down" state take a few seconds to transition
  // to "Shutdown" before they can be booted again.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sims = listSimulators();
    const sim = sims.find((s) => s.udid === udid);
    if (!sim || sim.state === 'Shutdown') break;
    if (sim.state === 'Booted') break; // Already booted (shutdown was no-op)
    // Still shutting down — wait (busy-loop with Atomics for sub-second sync sleep)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  bootSimulator(udid);

  // Wait for the simulator to be ready (launchd responsive)
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    const result = probeSimulatorHealth(udid);
    if (result.healthy) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

/** `simctl install` transiently fails on a freshly booted/contended simulator
 *  (installd not ready yet); a short-backoff retry reliably recovers it. */
const INSTALL_ATTEMPTS = 3;
const INSTALL_RETRY_DELAY_MS = 2000;

/**
 * Install an app bundle on a simulator (blocking).
 */
export function installApp(udid: string, appPath: string): void {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt++) {
    try {
      execFileSync('xcrun', ['simctl', 'install', udid, appPath], {
        timeout: 60_000,
        stdio: 'ignore',
      });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < INSTALL_ATTEMPTS) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INSTALL_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/**
 * Install an app bundle on a simulator (non-blocking). Use this when the
 * install can run concurrently with other setup work (e.g. agent startup).
 */
export async function installAppAsync(udid: string, appPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('xcrun', ['simctl', 'install', udid, appPath], { timeout: 60_000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < INSTALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, INSTALL_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

/**
 * Check whether an app bundle is already installed on a simulator.
 */
export function isAppInstalled(udid: string, bundleId: string): boolean {
  try {
    execFileSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], {
      timeout: 10_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** `simctl get_app_container`'s exit status for an app that is not installed (ENOENT). */
const SIMCTL_APP_NOT_INSTALLED_EXIT = 2;

/**
 * Install the app on a simulator that does not have it, straight after the
 * simulator booted. `installed` is true when it did, so the session that
 * opens next can take it as a fresh install (no data to clear) instead of
 * checking and reinstalling it. An app already there is left to the session's
 * build check, and so is anything uncertain: a lookup or install that fails
 * leaves the install to the session. `outcome` says which, for the progress
 * line.
 *
 * Done here rather than only in the session: on a hosted CI runner a freshly
 * installed app's first launch was slow enough that installing it right
 * before the agent started pushed the agent past its startup bound.
 */
export function installAppIfAbsent(
  udid: string,
  appPath: string,
  bundleId: string,
): { installed: boolean; outcome: string } {
  // Only a definite "not installed" counts: simctl's ENOENT exit. A lookup
  // that timed out or failed some other way on a busy simulator says nothing,
  // and installing over an app that is there keeps its data — calling that
  // fresh would skip the startup clear.
  try {
    execFileSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], {
      timeout: 30_000,
      stdio: 'ignore',
    });
    return { installed: false, outcome: 'already installed' };
  } catch (err) {
    const { signal, status } = err as { signal?: string | null; status?: number | null };
    if (signal) return { installed: false, outcome: 'could not tell whether it is installed (lookup timed out)' };
    if (status !== SIMCTL_APP_NOT_INSTALLED_EXIT) {
      return { installed: false, outcome: `could not tell whether it is installed (simctl exit ${status ?? 'unknown'})` };
    }
  }
  try {
    installApp(udid, appPath);
    return { installed: true, outcome: 'installed' };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { installed: false, outcome: `install failed (${message})` };
  }
}

/**
 * True when the app installed on the simulator has a main executable
 * byte-identical to the candidate bundle's. Presence alone is not a safe
 * install-skip signal: simulator state can outlive a run (CI runners have
 * handed back device sets with an app from a previous job; local reruns
 * follow app rebuilds), and skipping install on a stale bundle silently
 * tests old app code. Any read/lookup failure returns false so callers
 * reinstall — the only cost of a false negative is one redundant install.
 */
export function installedAppMatches(udid: string, bundleId: string, appPath: string): boolean {
  try {
    const container = execFileSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], {
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!container) return false;
    const executable = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleExecutable', path.join(appPath, 'Info.plist')],
      { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!executable) return false;
    const digest = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    return digest(path.join(container, executable)) === digest(path.join(appPath, executable));
  } catch {
    return false;
  }
}

/**
 * Find a simulator matching the given name (or UDID).
 * Prefers booted simulators. Returns undefined if no match found.
 */
export function findSimulator(
  nameOrUdid: string,
  /** By-name matches to pass over (simulators other sessions hold). A UDID is always honoured. */
  skip: ReadonlySet<string> = new Set(),
): SimulatorInfo | undefined {
  const all = listSimulators();

  // Try exact UDID match first
  const byUdid = all.find((s) => s.udid === nameOrUdid);
  if (byUdid) return byUdid;

  // Try name match, preferring booted ones
  const byName = all.filter((s) => s.name === nameOrUdid && !skip.has(s.udid));
  const booted = byName.find((s) => s.state === 'Booted');
  if (booted) return booted;

  return byName[0];
}

const FIND_SIMULATOR_ATTEMPTS = 4;
const FIND_SIMULATOR_RETRY_DELAY_MS = 3000;

/**
 * Provision a simulator for testing: find by name, and boot it and wait for
 * the boot to finish if it is not booted. Returns its UDID, and whether the
 * boot is known to be complete (false when the wait timed out).
 *
 * The app is not installed here; the caller decides (`installAppIfAbsent`).
 *
 * The lookup is retried: `simctl list` can transiently fail or return an
 * empty device set while CoreSimulator is busy (concurrent boots on CI
 * runners) — `listSimulators()` maps that to `[]`, which is
 * indistinguishable from the simulator genuinely not existing. Seen on CI
 * as a fatal "No iOS simulator found matching 'iPhone 17'" minutes after
 * the workflow booted that exact simulator.
 */
export function provisionSimulator(
  simulatorName: string,
  retry: { attempts: number; delayMs: number } = {
    attempts: FIND_SIMULATOR_ATTEMPTS,
    delayMs: FIND_SIMULATOR_RETRY_DELAY_MS,
  },
): { udid: string; bootComplete: boolean } {
  // A same-named simulator another live session holds is not this run's to
  // take (PILOT-381): pass over it to another one of that name.
  const held = devicesHeldElsewhere();
  let sim = findSimulator(simulatorName, held);
  for (let attempt = 1; !sim && attempt < retry.attempts; attempt++) {
    // Every one of that name held: no retry will free it — say by whom.
    if (held.size > 0) {
      const [holder] = withoutHeldDevices(listSimulators().filter((s) => s.name === simulatorName).map((s) => s.udid)).held;
      if (holder) throw new DeviceClaimedError(holder.device, holder);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retry.delayMs);
    sim = findSimulator(simulatorName, held);
  }
  if (!sim) {
    // With only the command-line tools (or nothing), simctl does not exist:
    // "run xcrun simctl" would fail too (PILOT-558).
    const noXcode = process.platform === 'darwin' ? iosToolchainBlocker() : undefined;
    if (noXcode) throw new Error(`${noXcode}.`);
    throw new Error(
      `No iOS simulator found matching '${simulatorName}'. ` +
        `Run 'xcrun simctl list devices' to see available simulators.`,
    );
  }

  // Claimed before it is booted, so a session starting alongside takes
  // another one (PILOT-381).
  const claim = claimDevice(sim.udid, currentSession());
  if (!claim.ok) throw new DeviceClaimedError(sim.udid, claim.holder);
  if (sim.state !== 'Booted') bootSimulator(sim.udid);
  // As provisionSimulators does: what follows (the daemon's device
  // selection, the install, the agent start) would otherwise race a
  // simulator that is `Booted` but not up. Also when it was found `Booted`:
  // another process may have just booted it. A timeout is not fatal — they
  // retry on their own — but it is reported: a simulator still booting
  // cannot be trusted to say which apps it holds. On a settled simulator the
  // wait returns at once.
  return { udid: sim.udid, bootComplete: waitForSimulatorBootComplete(sim.udid) };
}

/**
 * Poll until a simulator reaches the expected state.
 */
function waitForSimulatorState(udid: string, expectedState: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sims = listSimulators();
    const sim = sims.find((s) => s.udid === udid);
    if (sim?.state === expectedState) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

// ─── Parallel provisioning ───

export interface ClonedSimulator {
  udid: string
  name: string
  cloned: boolean
}

export interface ProvisionSimulatorsResult {
  /** All simulator UDIDs available for workers (existing booted + newly booted/cloned). */
  allUdids: string[]
  /** Simulators that were cloned and should be cleaned up after the run. */
  clonedSimulators: ClonedSimulator[]
  /** UDIDs that were freshly booted or cloned — need longer init timeouts. */
  freshUdids: Set<string>
  /** UDIDs reused from a previous run during this provisioning pass. */
  reusedUdids: string[]
}

/**
 * Create a new simulator from a device type and runtime, returning the new UDID.
 */
export function createSimulator(name: string, deviceType: string, runtime: string): string {
  const output = execFileSync('xcrun', ['simctl', 'create', name, deviceType, runtime], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return output.trim();
}

/**
 * Clone a simulator, returning the new UDID.
 */
export function cloneSimulator(sourceUdid: string, newName: string): string {
  const output = execFileSync('xcrun', ['simctl', 'clone', sourceUdid, newName], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  // simctl clone prints the new UDID on stdout
  return output.trim();
}

/**
 * Delete a simulator by UDID.
 */
export function deleteSimulator(udid: string): void {
  try {
    shutdownSimulator(udid);
    execFileSync('xcrun', ['simctl', 'delete', udid], {
      timeout: 30_000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort cleanup
  }
}

// ─── Simulator manifest ───
//
// Tracks which simulators Tapsmith cloned so they can be reused across runs
// (or cleaned up if the previous process died without cleanup).

interface SimulatorManifestEntry {
  udid: string
  name: string
  sourceName: string
  createdAt: string
}

function simulatorManifestPath(): string {
  // Per-user filename so multi-user systems sharing /tmp don't collide and
  // so unrelated users' manifests can't interfere with each other's cleanup.
  // os.userInfo().username is reliable on macOS, Linux, and Windows.
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    username = String(process.getuid?.() ?? 'shared');
  }
  // Sanitize: usernames are typically [a-zA-Z0-9_-], but be defensive.
  const safe = username.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(os.tmpdir(), `tapsmith-simulators-${safe}.json`);
}

// Ensure the manifest file exists so proper-lockfile has something to lock.
// proper-lockfile requires the target file to exist; we create an empty
// JSON array if it's missing.
function ensureManifestFile(): string {
  const file = simulatorManifestPath();
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, '[]', { flag: 'wx' });
    } catch {
      // Lost the race with another process — that's fine, the file now exists.
    }
  }
  return file;
}

// Atomic write via temp file + rename. POSIX rename is atomic, so concurrent
// readers see either the old or the new file, never a partial write.
function atomicWriteManifest(file: string, entries: SimulatorManifestEntry[]): void {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * How long a held manifest lock stays valid before another process may break
 * it.
 *
 * One value for every acquirer, deliberately. `proper-lockfile` judges
 * staleness against the *acquirer's* window, not the holder's, so a caller
 * declaring a longer window protects nothing: any other caller using the
 * default would break the lock on its own schedule and both would proceed —
 * and the original holder's `release()` then removes the new holder's lock
 * directory, because the removal is unconditional.
 *
 * Short, because the sweep heartbeats. Sizing it to cover the whole sweep
 * instead — it runs synchronous `simctl` calls per entry, which block the
 * event loop and stop proper-lockfile's own refresh timer — meant a run killed
 * mid-sweep left a lock nobody could break for minutes, and every run in that
 * window stalled and then skipped its cleanup entirely.
 */
const MANIFEST_STALE_MS = 60_000;

// Run a read-modify-write operation under an exclusive file lock so concurrent
// Tapsmith runs can't corrupt the manifest. proper-lockfile uses a `.lock` dir
// next to the target file with retry/backoff and stale-lock detection.
function withManifestLock<T>(
  fn: (entries: SimulatorManifestEntry[], heartbeat: () => void) => { result: T; updated?: SimulatorManifestEntry[] },
  options?: { onContended?: () => T; waitBudget?: 'brief' | 'sweep' },
): T {
  const file = ensureManifestFile();
  // withFileLockSync, not lockfile.lockSync directly: the sync API rejects a
  // `retries` option ("Cannot use retries with the sync api"), so passing one
  // threw every time and this always ran unlocked.
  const outcome = withFileLockSync(file, (heartbeat) => {
    const entries = readManifestUnlocked(file);
    const { result, updated } = fn(entries, heartbeat);
    // Best effort inside the lock too. While the lock never worked, every call
    // took the fallback below, where a failed write is swallowed; letting it
    // throw here would turn bookkeeping nobody waits on into a failed run.
    if (updated !== undefined) {
      try { atomicWriteManifest(file, updated); } catch { /* stale entry cleaned up next run */ }
    }
    return { result };
  // A bookkeeping write waits briefly and then proceeds unlocked; the sweep
  // waits longer, because giving up means cloning every simulator fresh. Every
  // millisecond here is spent in `Atomics.wait` on the main thread, so the
  // budget is a few seconds, not the length of a sweep — a holder that dies is
  // reclaimed by the stale window, not by us out-waiting it.
  }, options?.waitBudget === 'sweep'
    ? { attempts: 20, waitMs: 250, staleMs: MANIFEST_STALE_MS }
    : { attempts: 10, waitMs: 50, staleMs: MANIFEST_STALE_MS });
  if (outcome.locked) return outcome.value.result;

  // Couldn't acquire the lock. For bookkeeping the unlocked fallback below is
  // fine — worst case is a stale entry cleaned up next run, same as the prior
  // behavior. Callers whose work *deletes* simulators pass `onContended` to opt
  // out instead: running unlocked there means two sweeps deleting each other's
  // simulators, which is the whole reason for the lock.
  if (options?.onContended) return options.onContended();

  const entries = readManifestUnlocked(file);
  const { result, updated } = fn(entries, () => {});
  if (updated !== undefined) {
    try { atomicWriteManifest(file, updated); } catch { /* best effort */ }
  }
  return result;
}

function readManifestUnlocked(file: string): SimulatorManifestEntry[] {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * Record cloned simulators in the manifest so a future run can reuse them.
 */
export function recordClonedSimulators(
  clones: ClonedSimulator[],
  sourceName: string,
): void {
  withManifestLock((existing) => {
    const existingUdids = new Set(existing.map((e) => e.udid));
    const newEntries: SimulatorManifestEntry[] = clones
      .filter((c) => !existingUdids.has(c.udid))
      .map((c) => ({
        udid: c.udid,
        name: c.name,
        sourceName,
        createdAt: new Date().toISOString(),
      }));
    return { result: undefined, updated: [...existing, ...newEntries] };
  });
}

/**
 * A sweep's surviving entries, plus any that appeared while it was sweeping.
 *
 * Phase 1 holds the lock across a `simctl` call per entry, which is long enough
 * that a concurrent run recording a fresh clone gives up waiting and writes
 * unlocked — that is the documented fallback for bookkeeping. Writing the
 * sweep's own list wholesale would then erase the clone's entry, and the *next*
 * run's phase 2 deletes any `Tapsmith Worker` simulator the manifest does not
 * know about: a live simulator, deleted out from under the run using it.
 *
 * Re-reading here rather than trusting the entry list the sweep started with
 * shrinks the window from the length of a sweep to the moment before the write,
 * and the rule is exact — the sweep only ever means to drop what it handled.
 *
 * Adds the udids it finds to `handledUdids`, so phase 2 spares them too.
 */
function withConcurrentAdditions(
  surviving: SimulatorManifestEntry[],
  handledUdids: Set<string>,
): SimulatorManifestEntry[] {
  const known = new Set(surviving.map((e) => e.udid));
  const appeared = readManifestUnlocked(ensureManifestFile())
    .filter((e) => !known.has(e.udid) && !handledUdids.has(e.udid));
  if (appeared.length === 0) return surviving;
  // Marked handled, not just kept. Phase 2 runs after this, outside the lock,
  // and deletes any `Tapsmith Worker N` simulator that phase 1 did not record —
  // so keeping the manifest entry while leaving the udid unhandled deletes the
  // very simulator the entry describes, and leaves the record pointing at
  // nothing. The entry and the simulator have to survive together.
  for (const entry of appeared) handledUdids.add(entry.udid);
  return [...surviving, ...appeared];
}

/** Whether the manifest names this simulator *now*, not when the sweep began. */
function isRecordedInManifest(udid: string): boolean {
  return readManifestUnlocked(ensureManifestFile()).some((e) => e.udid === udid);
}

/**
 * Remove simulators from the manifest (called during force-cleanup).
 */
export function unrecordSimulators(udids: string[]): void {
  const toRemove = new Set(udids);
  withManifestLock((existing) => ({
    result: undefined,
    updated: existing.filter((e) => !toRemove.has(e.udid)),
  }));
}

// ─── Health checks ───

export interface SimulatorHealthResult {
  udid: string
  healthy: boolean
  reason?: string
}

/**
 * Probe whether a simulator is healthy and usable for testing.
 *
 * Checks: exists in simctl list, is booted, launchd is responsive.
 */
export function probeSimulatorHealth(udid: string): SimulatorHealthResult {
  // Check 1: exists and is booted
  const sims = listSimulators();
  const sim = sims.find((s) => s.udid === udid);
  if (!sim) {
    return { udid, healthy: false, reason: 'simulator no longer exists' };
  }
  if (sim.state !== 'Booted') {
    return { udid, healthy: false, reason: `simulator is ${sim.state}, not Booted` };
  }

  // Check 2: launchd is responsive (proves the sim's system services are running)
  try {
    execFileSync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'print', 'system'], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch {
    return { udid, healthy: false, reason: 'simulator launchd is unresponsive' };
  }

  return { udid, healthy: true };
}

/**
 * Batch health-check a list of simulator UDIDs.
 */
export function filterHealthySimulators(
  udids: string[],
): { healthyUdids: string[]; unhealthySimulators: SimulatorHealthResult[] } {
  const healthyUdids: string[] = [];
  const unhealthySimulators: SimulatorHealthResult[] = [];

  for (const udid of udids) {
    const result = probeSimulatorHealth(udid);
    if (result.healthy) {
      healthyUdids.push(udid);
    } else {
      unhealthySimulators.push(result);
    }
  }

  return { healthyUdids, unhealthySimulators };
}

// ─── Stale cleanup ───

/**
 * Kill orphaned xcodebuild XCUITest runners targeting the given simulator UDIDs.
 *
 * Must run BEFORE shutting down/deleting those simulators: an XCUITest runner
 * actively re-boots its target simulator after a `simctl shutdown`, so deleting
 * the sim first just lets the surviving runner boot a replacement and keep the
 * host loaded. Synchronous (execFileSync) so it's safe to call from crash/exit
 * handlers that must finish before the process exits.
 *
 * The `simctl terminate` mirrors the daemon's own kill_existing_agents_on
 * (tapsmith-core/src/ios/agent_launch.rs).
 */
export function killAgentRunnersForSimulators(udids: string[]): void {
  // Skip empty/falsy UDIDs: an empty value makes the pkill pattern `id=` match
  // every xcodebuild runner and would kill unrelated sessions.
  const validUdids = udids.filter(Boolean);
  if (validUdids.length === 0) return;

  // Kill all matching runners in ONE pkill via ERE alternation rather than one
  // spawn per UDID. This runs during emergency teardown when the host may
  // already be overloaded (the PILOT-230 scenario), so minimizing process
  // spawns matters. UDIDs are hex + hyphens, so they need no regex escaping,
  // and macOS `pkill -f` matches with extended regular expressions.
  try {
    execFileSync('pkill', ['-f', `xcodebuild.*test-without-building.*id=(${validUdids.join('|')})`], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch {
    // No matching process — fine
  }

  // `simctl terminate` takes a single UDID, so it stays per-UDID.
  for (const udid of validUdids) {
    try {
      execFileSync('xcrun', ['simctl', 'terminate', udid, 'dev.tapsmith.agent.xctrunner'], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch {
      // Agent not running on this sim — fine
    }
  }
}

export interface CleanupStaleSimulatorsResult {
  /** UDIDs of healthy clones ready for reuse. */
  reusable: string[]
  /** UDIDs of deleted clones. */
  killed: string[]
}

/**
 * Clean up stale simulators from previous runs and identify reusable clones.
 *
 * Phase 1: Manifest-based — health-check tracked clones, reuse healthy ones, delete unhealthy.
 * Phase 2: Heuristic — delete orphaned "Tapsmith Worker" sims not in manifest.
 * Phase 3: Kill stale xcodebuild processes referencing deleted sims.
 */
export function cleanupStaleSimulators(
  simulatorName: string,
): CleanupStaleSimulatorsResult {
  const reusable: string[] = [];
  const killed: string[] = [];
  const handledUdids = new Set<string>();
  // Clones another live Tapsmith session is driving are neither reused nor
  // deleted here (PILOT-381): both would pull a simulator out from under it.
  const heldElsewhere = devicesHeldElsewhere();

  // Phase 1: manifest-based reclamation. Hold the manifest lock across the
  // entire read-modify-write so two concurrent Tapsmith runs don't both try to
  // reclaim the same simulator. The lock is released before phase 2/3, which
  // operate on simulators outside the manifest.
  const swept = withManifestLock<boolean>((manifest, heartbeat) => {
    const surviving: SimulatorManifestEntry[] = [];

    for (const entry of manifest) {
      // Each iteration blocks the event loop on `simctl`, so the lock's own
      // refresh timer never runs — say we are alive by hand, or a slow sweep
      // looks abandoned and a concurrent run breaks the lock underneath it.
      heartbeat();

      // Only reclaim clones matching the current simulator name, and never
      // one another session holds.
      if (entry.sourceName !== simulatorName || heldElsewhere.has(entry.udid)) {
        surviving.push(entry);
        handledUdids.add(entry.udid);
        continue;
      }

      const health = probeSimulatorHealth(entry.udid);
      handledUdids.add(entry.udid);

      if (health.healthy) {
        reusable.push(entry.udid);
        surviving.push(entry);
      } else if (health.reason === 'simulator no longer exists') {
        // Already gone — just drop from manifest
        killed.push(entry.udid);
      } else {
        // Exists but unhealthy — delete it
        deleteSimulator(entry.udid);
        killed.push(entry.udid);
      }
    }

    return { result: true, updated: withConcurrentAdditions(surviving, handledUdids) };
  }, { waitBudget: 'sweep', onContended: () => false });

  if (!swept) {
    // Another run is sweeping right now. Don't fall through: phase 2 deletes by
    // name pattern alone and spares only what phase 1 recorded in
    // `handledUdids`, so continuing with an empty set would delete the very
    // clones that run is reclaiming. Skipping costs this run its reusable
    // clones — it clones fresh instead — and the next sweep cleans up.
    //
    // Said out loud because the symptom otherwise reads as "reuse is broken":
    // a process killed with SIGKILL mid-sweep leaves its lock behind, and
    // every run for the next MANIFEST_STALE_MS clones fresh with no clue why.
    // (An ordinary Ctrl-C is fine — proper-lockfile removes held locks from
    // its own exit hook.)
    console.error(
      'Skipping simulator cleanup: another Tapsmith run holds the simulator manifest lock. '
      + 'This run will clone fresh simulators instead of reusing any.',
    );
    return { reusable, killed };
  }

  // Phase 2: heuristic cleanup — delete orphaned "Tapsmith Worker" sims
  const allSims = listSimulators();
  const tapsmithWorkerPattern = /\(Tapsmith Worker \d+\)$/;

  for (const sim of allSims) {
    if (handledUdids.has(sim.udid)) continue;
    if (!tapsmithWorkerPattern.test(sim.name)) continue;
    if (heldElsewhere.has(sim.udid)) continue;
    // Read again, immediately before deleting. Phase 1's view of the manifest
    // is as old as the sweep, and the lock is released by now — a run that
    // recorded a clone in between would otherwise have it deleted here on the
    // strength of a snapshot taken before it existed.
    if (isRecordedInManifest(sim.udid)) continue;

    deleteSimulator(sim.udid);
    killed.push(sim.udid);
  }

  // Phase 3: kill stale xcodebuild processes for deleted sims
  killAgentRunnersForSimulators(killed);

  return { reusable, killed };
}

// ─── Reuse helpers ───

/**
 * Preserve cloned simulators for reuse by the next run.
 * Intentionally a no-op — clones stay booted and in the manifest.
 */
export function preserveSimulatorsForReuse(_cloned: ClonedSimulator[]): void {
  // No-op. Simulators stay alive and in the manifest so the next run
  // can reuse them via cleanupStaleSimulators().
}

/**
 * Emergency cleanup — delete all cloned simulators and remove from manifest.
 * Used on SIGINT/SIGTERM or fatal errors.
 */
export function forceCleanupSimulators(cloned: ClonedSimulator[]): void {
  const udids: string[] = [];
  for (const sim of cloned) {
    deleteSimulator(sim.udid);
    udids.push(sim.udid);
  }
  unrecordSimulators(udids);
}

/**
 * Provision multiple iOS simulators for parallel test execution.
 *
 * Strategy:
 * 1. Start with already-booted simulators matching the name
 * 2. Boot any shutdown simulators that match the name
 * 3. If still not enough, clone the source simulator to create new instances
 *
 * Returns UDIDs for all provisioned simulators.
 */
export function provisionSimulators(opts: {
  /** Simulator name to match (e.g. "iPhone 16"). */
  simulatorName: string
  /** Number of simulators needed. */
  workers: number
  /** UDIDs already assigned to existing workers — skip these. */
  existingUdids?: string[]
  /** Path to .app bundle — install on freshly booted sims so workers don't have to. */
  appPath?: string
  /** UDIDs of reusable clones from cleanupStaleSimulators() — use before cloning new ones. */
  reusableUdids?: string[]
  /** Receives human-readable provisioning events. */
  onProgress?: (message: string, level?: 'info' | 'warning') => void
}): ProvisionSimulatorsResult {
  const { simulatorName, workers, existingUdids = [], reusableUdids = [] } = opts;
  const existingSet = new Set(existingUdids);
  const allUdids = [...existingUdids];
  const clonedSimulators: ClonedSimulator[] = [];
  const freshUdids = new Set<string>();
  const reusedUdids: string[] = [];
  const logProgress = (message: string, level: 'info' | 'warning' = 'info') => {
    if (opts.onProgress) {
      opts.onProgress(message, level);
    } else if (level === 'warning') {
      process.stderr.write(`${message}\n`);
    } else {
      process.stderr.write(`\x1b[2m${message}\x1b[0m\n`);
    }
  };

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids, reusedUdids };
  }

  // Determine the primary simulator's runtime so we only reuse/boot
  // simulators on the same OS version. Mismatched runtimes cause
  // xcodebuild test-without-building to fail.
  const allSims = listSimulators();
  // Simulators another live Tapsmith session holds: never adopted, reused,
  // pruned or shut down as a clone source here (PILOT-381).
  const heldElsewhere = devicesHeldElsewhere();
  // Each simulator is claimed as it is taken — before it is booted or has
  // the app installed — so a session provisioning at the same time cannot
  // adopt it in the tens of seconds that takes (PILOT-381). One another
  // session claimed since the snapshot above is passed over.
  const claimNow = (udid: string): boolean => {
    const ok = claimDevice(udid, currentSession()).ok;
    if (!ok) heldElsewhere.add(udid);
    return ok;
  };
  const primarySim = existingUdids.length > 0
    ? allSims.find((s) => s.udid === existingUdids[0])
    : undefined;
  const primaryRuntime = primarySim?.runtime;

  // Phase 0a: reuse healthy clones from previous runs (already booted)
  for (const udid of reusableUdids) {
    if (allUdids.length >= workers) break;
    if (existingSet.has(udid) || heldElsewhere.has(udid)) continue;
    const sim = allSims.find((s) => s.udid === udid);
    if (primaryRuntime && sim?.runtime !== primaryRuntime) {
      // Runtime mismatch — delete the stale clone so it gets re-created
      deleteSimulator(udid);
      continue;
    }
    if (!claimNow(udid)) continue;
    logProgress(`Reusing simulator ${udid} (${sim?.name ?? 'unknown'}) from previous run.`);
    reusedUdids.push(udid);
    allUdids.push(udid);
    // Track as cloned so callers know to manage them
    if (sim) {
      clonedSimulators.push({ udid, name: sim.name, cloned: true });
    }
  }

  // Prune excess reusable clones beyond what we need
  // Re-read the claims right before deleting: a clone another session
  // claimed since the snapshot above is that session's now.
  const heldNow = devicesHeldElsewhere();
  const unusedReusable = reusableUdids.filter((u) => !allUdids.includes(u) && !heldElsewhere.has(u) && !heldNow.has(u));
  if (unusedReusable.length > 0) {
    for (const udid of unusedReusable) {
      deleteSimulator(udid);
    }
    unrecordSimulators(unusedReusable);
  }

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids, reusedUdids };
  }

  const matching = allSims.filter((s) =>
    s.name === simulatorName
    && !existingSet.has(s.udid)
    && !allUdids.includes(s.udid)
    && !heldElsewhere.has(s.udid)
    && (!primaryRuntime || s.runtime === primaryRuntime),
  );

  // Phase 0b: collect already-booted simulators not yet assigned
  const alreadyBooted = matching.filter((s) => s.state === 'Booted');
  for (const sim of alreadyBooted) {
    if (allUdids.length >= workers) break;
    if (!claimNow(sim.udid)) continue;
    // Booted by anyone — this run did not record it, so not "from previous run".
    logProgress(`Reusing already-booted simulator ${sim.udid} (${sim.name}).`);
    reusedUdids.push(sim.udid);
    allUdids.push(sim.udid);
  }

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids, reusedUdids };
  }

  // Phase 1: boot any shutdown simulators that match the name
  const shutdown = matching.filter((s) => s.state === 'Shutdown');
  for (const sim of shutdown) {
    if (allUdids.length >= workers) break;
    if (!claimNow(sim.udid)) continue;
    bootSimulator(sim.udid);
    if (opts.appPath) {
      try { installApp(sim.udid, opts.appPath); } catch { /* may already be installed */ }
    }
    allUdids.push(sim.udid);
    freshUdids.add(sim.udid);
  }

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids, reusedUdids };
  }

  // Phase 2: clone the source simulator to create new instances.
  // simctl clone requires a shutdown source. Prefer a shutdown one; if all
  // matching sims are booted, temporarily shut one down for cloning.
  const refreshed = listSimulators();
  const runtimeMatch = (s: SimulatorInfo) =>
    s.name === simulatorName && (!primaryRuntime || s.runtime === primaryRuntime);
  let source = refreshed.find((s) => runtimeMatch(s) && s.state === 'Shutdown');
  let shutdownForClone = false;
  if (!source) {
    // All matching sims are booted — shut one down temporarily to use as clone source.
    // Never shut down sims in existingUdids — they may have an active agent session.
    const candidate = refreshed.find((s) => runtimeMatch(s) && !existingSet.has(s.udid) && !heldElsewhere.has(s.udid));
    // Claimed before it is shut down: this run boots it again and uses it, and
    // one another session claimed since the snapshot must not be touched.
    if (candidate && candidate.state === 'Booted' && claimNow(candidate.udid)) {
      shutdownSimulator(candidate.udid);
      waitForSimulatorState(candidate.udid, 'Shutdown', 10_000);
      source = candidate;
      shutdownForClone = true;
      const idx = allUdids.indexOf(candidate.udid);
      if (idx >= 0) allUdids.splice(idx, 1);
    }
  }

  if (!source) {
    // No shutdown simulator available for cloning (the only matching sim is
    // in active use). Create new simulators from scratch using the primary's
    // device type and runtime — this doesn't require a shutdown source.
    if (primarySim) {
      while (allUdids.length < workers) {
        const createIndex = allUdids.length;
        const createName = `${simulatorName} (Tapsmith Worker ${createIndex})`;
        try {
          const newUdid = createSimulator(createName, primarySim.deviceType, primarySim.runtime);
          // Recorded before it is booted, and one at a time. A concurrent run's
          // phase 2 deletes any `Tapsmith Worker N` the manifest does not know,
          // so every second between creating one and recording it is a second
          // it can be deleted from under us — and recording the whole batch at
          // the end left each one exposed for the boot and app install of every
          // simulator after it.
          recordClonedSimulators([{ udid: newUdid, name: createName, cloned: true }], simulatorName);
          claimNow(newUdid);
          bootSimulator(newUdid);
          if (!waitForSimulatorBootComplete(newUdid)) {
            logProgress(`Simulator ${createName} is still booting after ${SIMULATOR_BOOT_TIMEOUT_MS / 1000}s; continuing`, 'warning');
          }
          if (opts.appPath) {
            try { installApp(newUdid, opts.appPath); } catch { /* worker will retry */ }
          }
          allUdids.push(newUdid);
          clonedSimulators.push({ udid: newUdid, name: createName, cloned: true });
          freshUdids.add(newUdid);
        } catch (err) {
          logProgress(`Failed to create simulator for worker ${createIndex}: ${err instanceof Error ? err.message : err}`, 'warning');
          break;
        }
      }
    }
  } else {
    try {
      while (allUdids.length < workers) {
        const cloneIndex = allUdids.length;
        const cloneName = `${simulatorName} (Tapsmith Worker ${cloneIndex})`;
        try {
          const newUdid = cloneSimulator(source.udid, cloneName);
          // Recorded immediately — see the create path above for why.
          recordClonedSimulators([{ udid: newUdid, name: cloneName, cloned: true }], simulatorName);
          claimNow(newUdid);
          bootSimulator(newUdid);
          if (!waitForSimulatorBootComplete(newUdid)) {
            logProgress(`Simulator ${cloneName} is still booting after ${SIMULATOR_BOOT_TIMEOUT_MS / 1000}s; continuing`, 'warning');
          }
          if (opts.appPath) {
            try { installApp(newUdid, opts.appPath); } catch { /* worker will retry */ }
          }
          allUdids.push(newUdid);
          clonedSimulators.push({ udid: newUdid, name: cloneName, cloned: true });
          freshUdids.add(newUdid);
        } catch (err) {
          logProgress(`Failed to clone simulator for worker ${cloneIndex}: ${err instanceof Error ? err.message : err}`, 'warning');
          break;
        }
      }
    } finally {
      // Re-boot the source if we shut it down for cloning, and re-add to pool
      if (shutdownForClone) {
        bootSimulator(source.udid);
        if (!allUdids.includes(source.udid)) {
          allUdids.unshift(source.udid);
        }
      }
    }
  }

  // Nothing to record here any more: each simulator is written to the manifest
  // as it is created, which is the only way it is not deletable by another run
  // in the meantime.

  return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids, reusedUdids };
}
