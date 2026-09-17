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
    // (`reality: "simulated"`, also under the newer `properties.hardware`).
    // Without this a booted simulator is taken for a physical device, and a
    // simulator run aborts looking for a device-slice xctestrun.
    const props = (d['properties'] as Record<string, unknown> | undefined) ?? {};
    const hardware = (props['hardware'] as Record<string, unknown> | undefined) ?? {};
    if (hwProps['reality'] === 'simulated' || hardware['reality'] === 'simulated') continue;

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
    });
  }
  return result;
}

/**
 * Returns true if `udid` matches a physical iOS device currently listed by
 * devicectl. Used by the CLI to branch install/launch between simctl and
 * devicectl paths.
 */
export function isPhysicalDevice(udid: string): boolean {
  if (!udid) return false;
  return listPhysicalDevices().some((d) => d.udid === udid);
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
 * how the preflight handles missing-dependency scenarios (`setup-ios-device`
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

function scratchJsonPath(purpose: string): string {
  return path.join(
    os.tmpdir(),
    `tapsmith-devicectl-${purpose}-${process.pid}-${Date.now()}.json`,
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
