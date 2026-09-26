/**
 * `tapsmith list-devices` — print a table of connected devices.
 *
 * Queries the Tapsmith daemon for its merged device list (Android via ADB,
 * iOS simulators via simctl, iOS physical via devicectl) and enriches iOS
 * physical entries with extra state from `xcrun devicectl list devices`
 * (iOS version, pairing, Developer Mode, DDI availability, USB transport)
 * that the daemon doesn't surface. This is the single command users can
 * run to see what Tapsmith can target right now and whether any device
 * needs attention before `tapsmith test` will work.
 *
 * Output shape: NAME · PLATFORM · SERIAL · OS · STATUS. The STATUS cell
 * is either "Ready" or a one-line imperative fix ("Plug in via USB
 * cable"). Ready devices sort first. A `--json` flag emits the row model
 * for scripting.
 *
 * For per-device iOS preflight with richer hints, `tapsmith setup-ios-device`
 * does the heavy lifting.
 */

import { execFileSync, spawn } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { TapsmithGrpcClient, type DeviceInfoProto } from './grpc-client.js';
import { pickFreePort } from './port-utils.js';
import {
  listPhysicalDevices,
  listUsbAttachedIosDevices,
  type PhysicalDeviceInfo,
} from './ios-devicectl.js';

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

// ─── Row model ──────────────────────────────────────────────────────────

export interface DeviceRow {
  ready: boolean
  platform: string
  serial: string
  name: string
  /** Human-friendly OS version label for the OS column ("iOS 18.1",
   * "Android 14"). Empty when unknown. */
  osLabel: string
  /** Imperative one-liners describing how to make the device ready. Empty
   * when `ready` is true. Ordered by fix priority (attach USB first, then
   * pair, then Developer Mode, then DDI). */
  blockers: string[]
}

/**
 * Build rows for display from the daemon's merged device list plus the
 * devicectl cross-reference for iOS physical devices and the libimobiledevice
 * USB attachment set. Exported so tests can cover the enrichment logic
 * without a live daemon.
 *
 * @param usbAttached Set of UDIDs currently attached over USB (per
 *   `idevice_id -l`). Used only to flag iOS physical devices that
 *   devicectl knows about but which aren't actually cabled — Tapsmith's
 *   agent tunnel is USB-only, so `tapsmith test --device <udid>` against
 *   one would fail at tunnel setup.
 */
export function buildDeviceRows(
  daemonDevices: DeviceInfoProto[],
  devicectlDevices: PhysicalDeviceInfo[],
  usbAttached: Set<string> = new Set(),
): DeviceRow[] {
  const byUdid = new Map<string, PhysicalDeviceInfo>();
  for (const d of devicectlDevices) byUdid.set(d.udid, d);

  const rows = daemonDevices.map<DeviceRow>((device) => {
    const physical = byUdid.get(device.serial);
    const isUsbAttached = usbAttached.has(device.serial);
    const blockers = blockersFor(device, physical, isUsbAttached);
    return {
      ready: blockers.length === 0,
      platform: platformLabel(device),
      serial: device.serial,
      name: device.model || '',
      osLabel: osLabelFor(device, physical),
      blockers,
    };
  });

  // Ready devices first, so the user sees the happy path at the top.
  // Stable sort within each group preserves daemon order.
  return rows.slice().sort((a, b) => {
    if (a.ready === b.ready) return 0;
    return a.ready ? -1 : 1;
  });
}

function platformLabel(device: DeviceInfoProto): string {
  switch (device.platform) {
    case 'ios':
      return device.isEmulator ? 'ios-sim' : 'ios-device';
    case 'android':
      return device.isEmulator ? 'android-emu' : 'android';
    default:
      return device.platform || (device.isEmulator ? 'sim' : 'device');
  }
}

/**
 * Build the OS column label. Prefers devicectl's version for physical iOS
 * devices (the daemon doesn't have it), otherwise falls back to what the
 * daemon returned (Android via getprop, iOS sim via parsed runtime).
 */
function osLabelFor(
  device: DeviceInfoProto,
  physical: PhysicalDeviceInfo | undefined,
): string {
  const version = physical?.osVersion || device.osVersion || '';
  if (!version) return '';
  switch (device.platform) {
    case 'ios':
      return `iOS ${version}`;
    case 'android':
      return `Android ${version}`;
    default:
      return version;
  }
}

/**
 * Imperative one-liners describing what the user needs to do to make the
 * device ready. Empty list = ready. Ordered so the action that unblocks
 * the rest comes first: USB attachment before pairing (you can't pair a
 * phone that isn't plugged in), pairing before Developer Mode, Developer
 * Mode before DDI.
 *
 * Physical iOS has the richest failure modes; iOS simulators and Android
 * are usually ready once the daemon lists them.
 */
function blockersFor(
  device: DeviceInfoProto,
  physical: PhysicalDeviceInfo | undefined,
  isUsbAttached: boolean,
): string[] {
  const blockers: string[] = [];

  if (device.platform === 'ios' && !device.isEmulator) {
    // Physical iOS readiness requires the full devicectl enrichment. If
    // it's missing (non-macOS host or devicectl unavailable) we can't
    // judge readiness — assume it's ready and let `tapsmith test` surface
    // any problem at attachment time.
    if (physical) {
      // Wi-Fi-only is a distinct, reassuring case from "nothing plugged
      // in at all": devicectl sees the device over the local network but
      // Tapsmith's wired-tunnel test flow needs a USB cable.
      if (!isUsbAttached) {
        if (physical.transportType === 'localNetwork') {
          blockers.push('Wi-Fi only — connect USB cable (wired tunnel required)');
        } else {
          blockers.push('Plug in via USB cable');
        }
      }
      if (!physical.isPaired) {
        blockers.push('Pair in Xcode → Window → Devices and Simulators');
      }
      if (physical.developerModeStatus === 'disabled') {
        blockers.push('Enable Developer Mode: Settings → Privacy & Security → Developer Mode');
      }
      // NB: we intentionally don't check `ddiServicesAvailable` here.
      // devicectl only reports it as `true` after something (Xcode) has
      // already mounted the Developer Disk Image in the current session,
      // so it false-alarms on devices where `tapsmith test` would succeed —
      // tapsmith mounts the DDI itself at test time.
    }
  }

  if (device.platform === 'android' && device.state) {
    // adb surfaces "unauthorized" when the device hasn't accepted the
    // RSA key yet and "offline" when the connection is broken.
    if (device.state === 'unauthorized') {
      blockers.push('Accept the USB debugging prompt on the device');
    }
    if (device.state === 'offline') {
      blockers.push('Reconnect cable or run `adb kill-server`');
    }
  }

  return blockers;
}

// ─── Rendering ──────────────────────────────────────────────────────────

function formatTable(rows: DeviceRow[]): string {
  if (rows.length === 0) {
    return dim('No devices detected.\n\n') +
      '  Plug in an iPhone, boot an iOS simulator with `xcrun simctl boot`,\n' +
      '  or start an Android emulator — then re-run `tapsmith list-devices`.\n';
  }

  // Columns: NAME · PLATFORM · SERIAL · OS · STATUS. Name comes first
  // because humans scan device lists by name. No ✓/✗ column — the STATUS
  // cell already carries the ready/blocked signal via color (green
  // "Ready" vs. yellow blocker text).
  const EMPTY_OS = '—';
  const headers = ['NAME', 'PLATFORM', 'SERIAL', 'OS', 'STATUS'];
  const plain: string[][] = rows.map((r) => [
    r.name,
    r.platform,
    r.serial,
    r.osLabel || EMPTY_OS,
    statusStringPlain(r),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...plain.map((row) => row[i].length)),
  );

  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

  const headerLine = headers.map((h, i) => bold(pad(h, widths[i]))).join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('  ');

  const body = rows.map((r) => {
    const osCell = r.osLabel || EMPTY_OS;
    const statusTextCell = statusStringColored(r);
    const statusTextRaw = statusStringPlain(r);
    return [
      pad(r.name, widths[0]),
      pad(r.platform, widths[1]),
      pad(r.serial, widths[2]),
      pad(osCell, widths[3]),
      statusTextCell.padEnd(widths[4] + (statusTextCell.length - statusTextRaw.length)),
    ].join('  ');
  });

  const readyCount = rows.filter((r) => r.ready).length;
  const blockedCount = rows.length - readyCount;
  const summary = blockedCount === 0
    ? green(`${readyCount} ready · 0 need attention`)
    : `${green(`${readyCount} ready`)} · ${yellow(`${blockedCount} need attention`)}`;

  const lines = [headerLine, dim(separator), ...body, '', summary];

  // Footer hint: if any blocked row is a physical iOS device, point at
  // the guided fix command. We intentionally skip the hint for Android-
  // only blockers because `setup-ios-device` wouldn't help there.
  const hasIosPhysicalBlocker = rows.some(
    (r) => !r.ready && r.platform === 'ios-device',
  );
  if (hasIosPhysicalBlocker) {
    lines.push(dim('Run `tapsmith setup-ios-device` for guided fixes.'));
  }

  return lines.join('\n') + '\n';
}

/** Uncolored status cell — "Ready" or blockers joined with " · ". */
function statusStringPlain(r: DeviceRow): string {
  if (r.ready) return 'Ready';
  return r.blockers.join(' · ');
}

/** Colored status cell — "Ready" green, blockers yellow. */
function statusStringColored(r: DeviceRow): string {
  if (r.ready) return green('Ready');
  return r.blockers.map((b) => yellow(b)).join(' · ');
}

// ─── Daemon bootstrap ───────────────────────────────────────────────────

/**
 * Spin up an ephemeral `tapsmith-core` daemon, issue `ListDevices`, and tear
 * down. Same shape as `configure-ios-network`'s helper — this command is
 * short-lived and doesn't need to reuse a long-running daemon.
 */
async function listDevicesFromDaemon(): Promise<DeviceInfoProto[]> {
  const port = String(await pickFreePort());
  const bin = findDaemonBin();
  const child = spawn(
    bin,
    ['--port', port],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  const client = new TapsmithGrpcClient(`127.0.0.1:${port}`);
  const ready = await client.waitForReady(5_000);
  if (!ready) {
    child.kill();
    throw new Error(
      'Failed to start tapsmith-core daemon. Is the binary on PATH? ' +
      'Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.',
    );
  }
  try {
    const response = await client.listDevices();
    return response.devices;
  } finally {
    client.close();
    child.kill();
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────

export async function runListDevices(opts: { json: boolean }): Promise<void> {
  const jsonOutput = opts.json;

  let daemonDevices: DeviceInfoProto[];
  try {
    daemonDevices = await listDevicesFromDaemon();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    } else {
      console.error(red(msg));
    }
    process.exit(1);
  }

  // Physical iOS enrichment only runs on macOS — `xcrun devicectl` is
  // macOS-only. On other platforms we just show what the daemon returns.
  let physical: PhysicalDeviceInfo[] = [];
  let usbAttached: Set<string> = new Set();
  if (process.platform === 'darwin' && canRunXcrun()) {
    try {
      physical = listPhysicalDevices();
    } catch {
      // Non-fatal — daemon list still prints even without the enrichment.
    }
    try {
      usbAttached = listUsbAttachedIosDevices();
    } catch {
      // Non-fatal — USB flag just won't fire without libimobiledevice.
    }
  }

  const rows = buildDeviceRows(daemonDevices, physical, usbAttached);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ devices: rows }, null, 2) + '\n');
    return;
  }

  process.stdout.write('\n' + formatTable(rows) + '\n');
}

function canRunXcrun(): boolean {
  try {
    execFileSync('xcrun', ['--find', 'devicectl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
