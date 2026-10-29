/**
 * `xcrun devicectl` wrappers for physical iOS devices.
 *
 * Simulator-equivalent operations (install, launch, terminate, list) that
 * work against real hardware via Apple's CoreDevice framework. Requires
 * Xcode 15+; falls back gracefully when devicectl is unavailable so dev
 * machines with older Xcode or no physical devices don't error.
 *
 * All calls invoke `xcrun devicectl` as a subprocess — parallel to how
 * `ios-simulator.ts` wraps `xcrun simctl`. They're synchronous-looking
 * (Promise-returning) and use a scratch JSON output file rather than
 * stdout parsing because devicectl occasionally intermixes provisioning
 * warnings on stdout when the device is unpaired or DDI services are
 * unavailable.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface PhysicalDeviceInfo {
  udid: string
  name: string
  osVersion: string
  isPaired: boolean
  ddiServicesAvailable: boolean
  bootState: string
  /** `enabled` / `disabled` / `unknown`. Only iOS 16+ devices report this. */
  developerModeStatus: string
  /**
   * How CoreDevice is currently reaching this device. `wired` means USB;
   * `localNetwork` means Wi-Fi pairing (device is on the same network and
   * was previously paired). Tapsmith's test flow needs USB attachment
   * (iproxy + xcodebuild over a wired tunnel), so wireless-only devices
   * are listable but can't currently be driven — `list-devices` flags
   * them so `tapsmith test` doesn't get blamed for the failure mode.
   */
  transportType: string
  /**
   * Whether CoreDevice can reach the device right now. devicectl also lists
   * devices the Mac only remembers (unplugged, out of Wi-Fi range, or paired
   * with another Mac); those report `tunnelState: "unavailable"` and no
   * transport. A cabled phone whose tunnel is merely idle (`disconnected`) is
   * connected, paired or not. The daemon's parser applies the same rule
   * (`isReachable`) and drops unconnected devices outright.
   */
  isConnected: boolean
}

// ─── Listing ───

/**
 * List connected physical iOS devices via `xcrun devicectl list devices`.
 *
 * Synchronous to match the cadence of `ios-simulator.ts::listSimulators` —
 * which the CLI calls during setup. Returns an empty array if devicectl
 * is not available (older Xcode, no Core Device services).
 */
export function listPhysicalDevices(): PhysicalDeviceInfo[] {
  const scratch = scratchJsonPath('list-devices');
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', scratch], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15_000,
    });
  } catch {
    // devicectl prints provisioning warnings to stderr on unpaired devices but
    // still produces valid JSON in the file. Swallow and try reading the file.
  }

  return readDeviceListScratch(scratch);
}

/**
 * {@link listPhysicalDevices} without blocking the event loop — for callers
 * that run beside other sessions (a device-selection retry in a worker or a
 * group), where a slow devicectl must not stall every other session's timers.
 */
async function listPhysicalDevicesAsync(): Promise<PhysicalDeviceInfo[]> {
  const scratch = scratchJsonPath('list-devices');
  try {
    await execFileAsync('xcrun', ['devicectl', 'list', 'devices', '--json-output', scratch], { timeout: 15_000 });
  } catch {
    // As in listPhysicalDevices: the JSON file may still be valid.
  }
  return readDeviceListScratch(scratch);
}

/** Parse and remove a `devicectl list devices` JSON file; never throws. */
function readDeviceListScratch(scratch: string): PhysicalDeviceInfo[] {
  if (!fs.existsSync(scratch)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(scratch, 'utf-8');
  } catch {
    // Scratch file vanished or unreadable — treat as no devices rather
    // than throwing; callers rely on this function never throwing.
    return [];
  } finally {
    try { fs.unlinkSync(scratch); } catch {}
  }

  try {
    return parseDevicectlDeviceList(raw);
  } catch {
    return [];
  }
}

// Exported for unit tests.
export function parseDevicectlDeviceList(json: string): PhysicalDeviceInfo[] {
  const data = JSON.parse(json) as unknown;
  const result: PhysicalDeviceInfo[] = [];
  if (typeof data !== 'object' || data === null) return result;
  const root = data as Record<string, unknown>;
  const devices = (root['result'] as Record<string, unknown> | undefined)?.['devices'];
  if (!Array.isArray(devices)) return result;

  for (const entry of devices) {
    if (typeof entry !== 'object' || entry === null) continue;
    const d = entry as Record<string, unknown>;
    const hwProps = (d['hardwareProperties'] as Record<string, unknown> | undefined) ?? {};
    const devProps = (d['deviceProperties'] as Record<string, unknown> | undefined) ?? {};
    const connProps = (d['connectionProperties'] as Record<string, unknown> | undefined) ?? {};

    // Only iOS devices — devicectl also lists watchOS/macOS/tvOS.
    if (hwProps['platform'] !== 'iOS') continue;
    // Only real hardware — from Xcode 27 devicectl lists simulators too
    // (`reality: "simulated"`, served by the CoreSimulator provider; older
    // devicectl versions lack `reality`, so the provider is the fallback
    // signal). Without this a booted simulator is taken for a physical
    // device, and a simulator run aborts looking for a device-slice
    // xctestrun. Read from the same dictionaries as every other field: Xcode
    // 27 deprecates these in favour of a differently shaped `properties`
    // tree, which is a whole-parser migration, not a per-field fallback.
    if (hwProps['reality'] === 'simulated') continue;
    const provider = typeof devProps['provider'] === 'string' ? (devProps['provider'] as string) : '';
    if (provider.includes('CoreSimulator')) continue;

    const udid = typeof hwProps['udid'] === 'string' ? (hwProps['udid'] as string) : '';
    if (!udid) continue;

    const name =
      (typeof devProps['name'] === 'string' && (devProps['name'] as string)) ||
      (typeof d['name'] === 'string' && (d['name'] as string)) ||
      udid;

    result.push({
      udid,
      name,
      osVersion: typeof devProps['osVersionNumber'] === 'string'
        ? (devProps['osVersionNumber'] as string)
        : '',
      isPaired: connProps['pairingState'] === 'paired',
      ddiServicesAvailable: devProps['ddiServicesAvailable'] === true,
      bootState: typeof devProps['bootState'] === 'string'
        ? (devProps['bootState'] as string)
        : 'unknown',
      developerModeStatus: typeof devProps['developerModeStatus'] === 'string'
        ? (devProps['developerModeStatus'] as string)
        : 'unknown',
      transportType: typeof connProps['transportType'] === 'string'
        ? (connProps['transportType'] as string)
        : 'unknown',
      isConnected: isReachable(connProps),
    });
  }
  return result;
}

/**
 * The connection rule shared with the daemon's parser (`tapsmith-core/src/ios/device.rs`):
 * a device is unreachable only when its tunnel is `unavailable` AND devicectl
 * gives no transport for it — the shape of a device the Mac merely remembers.
 * A missing tunnelState (older devicectl) or any transport keeps the device,
 * so a cabled phone CoreDevice has no tunnel to (e.g. a MobileDevice-only
 * entry) is never hidden.
 */
function isReachable(connProps: Record<string, unknown>): boolean {
  if (connProps['tunnelState'] !== 'unavailable') return true;
  return typeof connProps['transportType'] === 'string' && connProps['transportType'] !== '';
}

/** A simulator UDID; physical ones are `8-16` or 40 hex digits. */
const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Returns true if `udid` matches a physical iOS device currently listed by
 * devicectl. Used by the CLI to branch install/launch between simctl and
 * devicectl paths.
 *
 * A simulator-shaped UDID is answered without devicectl: no physical
 * device's hardware UDID has that shape, and a simulator session asks this
 * several times during setup. On a hosted macOS runner whose simulator was
 * just booted, each of those devicectl calls ran into its 15 s timeout.
 */
export function isPhysicalDevice(udid: string): boolean {
  if (!udid || SIMULATOR_UDID.test(udid)) return false;
  return listPhysicalDevices().some((d) => d.udid === udid);
}

/**
 * Why `udid` cannot be used, when it is a physical device devicectl only
 * remembers (unplugged, out of Wi-Fi range, or paired with another Mac):
 * the daemon does not list such a device, so selecting it fails with a bare
 * "not found". Undefined when it is not such a device — connected, a
 * simulator, or unknown.
 */
export async function describeUnreachablePhysicalDevice(udid: string): Promise<string | undefined> {
  // A simulator's "not found" is a CoreSimulator stall, the case the
  // selection retry exists for; devicectl may be stalled with it, so do not
  // spend the retry budget asking.
  if (SIMULATOR_UDID.test(udid)) return undefined;
  const device = (await listPhysicalDevicesAsync()).find((d) => d.udid === udid);
  if (!device || device.isConnected) return undefined;
  return `${device.name} (${udid}) is not connected: this Mac remembers it, but cannot reach it now. `
    + 'Plug it in with a USB cable and unlock it, then re-run. `tapsmith list-devices` shows the devices that are connected.';
}

/**
 * `err` from selecting `udid`, or — when it is the daemon's "not found" for a
 * phone devicectl only remembers — an error that names that cause instead of
 * advising a ListDevices that will never list it. For paths with no selection
 * retry of their own (MCP).
 */
export async function explainDeviceNotFound(udid: string, err: unknown): Promise<unknown> {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('not found. Run ListDevices')) return err;
  const unreachable = await describeUnreachablePhysicalDevice(udid);
  return unreachable ? new Error(unreachable) : err;
}

/**
 * Return the set of iOS device UDIDs that are currently attached via USB,
 * as reported by `idevice_id -l` (libimobiledevice). Tapsmith's agent tunnel
 * uses iproxy which is a USB-only transport, so this is the ground-truth
 * signal for "can `tapsmith test` drive this device right now?".
 *
 * devicectl's `transportType` is NOT a reliable proxy for this: CoreDevice
 * reports `localNetwork` even for cabled devices once Wi-Fi pairing exists.
 *
 * Returns an empty set if libimobiledevice isn't installed, which matches
 * how the preflight handles missing-dependency scenarios (`ios setup-device`
 * will surface the missing tool with a fix-it hint).
 */
export function listUsbAttachedIosDevices(): Set<string> {
  try {
    const out = execFileSync('idevice_id', ['-l'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return new Set(
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch {
    return new Set();
  }
}

// ─── App lifecycle ───

/**
 * Install an `.app` bundle on a physical device via devicectl.
 *
 * The `.app` bundle must be signed with a provisioning profile matching
 * the device. Signing errors surface verbatim from xcodebuild via the
 * Error's message.
 */
export async function installAppOnDevice(udid: string, appPath: string): Promise<void> {
  const scratch = scratchJsonPath('install-app');
  try {
    await execFileAsync(
      'xcrun',
      ['devicectl', 'device', 'install', 'app', '--device', udid, '--json-output', scratch, appPath],
      { timeout: 120_000 },
    );
  } catch (err) {
    const hint = extractDevicectlErrorHint(scratch) ?? '';
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `devicectl install failed for ${appPath} on ${udid}:\n${detail}${
        hint ? `\n  hint: ${hint}` : ''
      }`,
    );
  } finally {
    try { fs.unlinkSync(scratch); } catch {}
  }
}

/**
 * Check whether an app with the given bundle ID is already installed on the
 * device. Used to skip reinstall on subsequent runs.
 */
export async function isAppInstalledOnDevice(udid: string, bundleId: string): Promise<boolean> {
  const scratch = scratchJsonPath('info-apps');
  try {
    await execFileAsync(
      'xcrun',
      [
        'devicectl',
        'device',
        'info',
        'apps',
        '--device',
        udid,
        '--include-all-apps',
        '--json-output',
        scratch,
      ],
      { timeout: 30_000 },
    );
    const body = fs.readFileSync(scratch, 'utf-8');
    const data = JSON.parse(body) as Record<string, unknown>;
    const result = data['result'] as Record<string, unknown> | undefined;
    const apps = result?.['apps'];
    if (!Array.isArray(apps)) return false;
    return apps.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const a = entry as Record<string, unknown>;
      return a['bundleIdentifier'] === bundleId;
    });
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(scratch); } catch {}
  }
}

// ─── Helpers ───

let scratchSeq = 0;

/** Unique per call, even for concurrent async calls in one millisecond. */
function scratchJsonPath(purpose: string): string {
  return path.join(
    os.tmpdir(),
    `tapsmith-devicectl-${purpose}-${process.pid}-${Date.now()}-${scratchSeq++}.json`,
  );
}

/**
 * Extract an actionable hint from devicectl's JSON error output. devicectl
 * wraps localized NSError strings as `{ "string": "..." }` objects under
 * `error.userInfo.NSLocalizedDescription`.
 */
function extractDevicectlErrorHint(jsonPath: string): string | undefined {
  if (!fs.existsSync(jsonPath)) return undefined;
  let body: string;
  try {
    body = fs.readFileSync(jsonPath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const error = data['error'] as Record<string, unknown> | undefined;
    const userInfo = error?.['userInfo'] as Record<string, unknown> | undefined;
    const desc = userInfo?.['NSLocalizedDescription'];
    if (typeof desc === 'string') return desc;
    if (desc && typeof desc === 'object') {
      const nested = (desc as Record<string, unknown>)['string'];
      if (typeof nested === 'string') return nested;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
