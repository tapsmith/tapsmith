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
 * for scripting (schema: docs/api-reference.md, CLI → JSON output).
 *
 * For per-device iOS preflight with richer hints, `tapsmith ios setup-device`
 * does the heavy lifting.
 */

import { execFileSync, spawn } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { TapsmithGrpcClient, type DeviceInfoProto } from './grpc-client.js';
import { pickFreePort } from './port-utils.js';
import { formatJson, jsonError } from './cli-json.js';
import { currentSession, listDeviceClaims, type DeviceClaim } from './device-claims.js';
import { androidUnusableDeviceFix } from './adb-devices.js';
import { androidToolchainBlocker, iosToolchainBlocker } from './toolchain.js';
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
  /**
   * The live Tapsmith session that has claimed this device, or
   * null when none has. A claimed device is refused to every other session.
   */
  inUseBy: DeviceHolder | null
}

/** Who holds a device, as `list-devices` reports it. */
export interface DeviceHolder {
  /** What started that session: `tapsmith test --ui`, `tapsmith mcp-server`. */
  command: string
  /** The session's root process. */
  pid: number
  /** The directory that session was started in. */
  project: string
  /** ISO time the device was claimed. */
  since: string
  /** The daemon that session drives the device through, when known. */
  daemonAddress: string | null
}

function holderOf(claim: DeviceClaim): DeviceHolder {
  return {
    command: claim.session.command,
    pid: claim.session.pid,
    project: claim.session.project,
    since: claim.claimedAt,
    daemonAddress: claim.daemonAddress ?? null,
  };
}

/** Live claims of sessions other than this one, by device. */
function liveClaimsByDevice(): Map<string, DeviceClaim> {
  const me = currentSession().id;
  const byDevice = new Map<string, DeviceClaim>();
  for (const { live, ...claim } of listDeviceClaims()) {
    if (live && claim.session.id !== me) byDevice.set(claim.device, claim);
  }
  return byDevice;
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
  /** Live claims of other sessions, by device serial. */
  claims: ReadonlyMap<string, DeviceClaim> = new Map(),
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
      inUseBy: claims.has(device.serial) ? holderOf(claims.get(device.serial)!) : null,
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
 * Android states a device can be used in: the daemon's `Discovered`/`Active`
 * for its usable devices, and adb's own `device`. Anything else is an adb
 * state the daemon reported under `unusableDevices` (unauthorized, offline,
 * `no permissions (…)`, …).
 */
const USABLE_ANDROID_STATES = new Set(['Discovered', 'Active', 'device']);

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

  if (device.platform === 'android' && !USABLE_ANDROID_STATES.has(device.state)) {
    blockers.push(androidUnusableDeviceFix(device.state, device.serial));
  }

  return blockers;
}

// ─── Rendering ──────────────────────────────────────────────────────────

/**
 * What to do when nothing was found, per platform: how to start a device, or
 * — on a machine without that platform's toolchain — what to install first,
 * since `xcrun simctl boot` needs Xcode and an emulator needs the SDK
 * (PILOT-558).
 */
function noDevicesHint(toolchain: ToolchainBlockers): string {
  const android = toolchain.android ?? 'start an emulator, or connect a device with USB debugging enabled';
  const ios = toolchain.ios ?? 'boot a simulator (xcrun simctl boot "<name>"), or plug in an iPhone';
  return dim('No devices detected.\n\n')
    + `  Android: ${android}.\n`
    + `  iOS: ${ios}.\n`
    + '  Then re-run `tapsmith list-devices`.\n';
}

function formatTable(rows: DeviceRow[]): string {

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
  const inUseCount = rows.filter((r) => r.inUseBy).length;
  const inUse = inUseCount > 0 ? ` · ${yellow(`${inUseCount} in use by other Tapsmith sessions`)}` : '';
  const summary = (blockedCount === 0
    ? green(`${readyCount} ready · 0 need attention`)
    : `${green(`${readyCount} ready`)} · ${yellow(`${blockedCount} need attention`)}`) + inUse;

  const lines = [headerLine, dim(separator), ...body, '', summary];

  // Footer hint: if any blocked row is a physical iOS device, point at
  // the guided fix command. We intentionally skip the hint for Android-
  // only blockers because `ios setup-device` wouldn't help there.
  const hasIosPhysicalBlocker = rows.some(
    (r) => !r.ready && r.platform === 'ios-device',
  );
  if (hasIosPhysicalBlocker) {
    lines.push(dim('Run `tapsmith ios setup-device` for guided fixes.'));
  }

  return lines.join('\n') + '\n';
}

/** `In use by \`tapsmith test --ui\` (pid 4242)` — another session holds it. */
function inUseText(holder: DeviceHolder): string {
  return `In use by \`${holder.command}\` (pid ${holder.pid})`;
}

/** Uncolored status cell — "Ready", or blockers and who holds it joined with " · ". */
function statusStringPlain(r: DeviceRow): string {
  const parts = r.ready ? [] : [...r.blockers];
  if (r.inUseBy) parts.push(inUseText(r.inUseBy));
  return parts.length === 0 ? 'Ready' : parts.join(' · ');
}

/** Colored status cell — "Ready" green, blockers yellow, held devices yellow. */
function statusStringColored(r: DeviceRow): string {
  const parts = r.ready ? [] : r.blockers.map((b) => yellow(b));
  if (r.inUseBy) parts.push(yellow(inUseText(r.inUseBy)));
  return parts.length === 0 ? green('Ready') : parts.join(' · ');
}

// ─── Daemon bootstrap ───────────────────────────────────────────────────

/** A failure the `--json` output reports under its own code. */
export class ListDevicesError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
    this.name = 'ListDevicesError';
  }
}

const DAEMON_BIN_FIX = 'Reinstall tapsmith (npm install tapsmith), or set TAPSMITH_DAEMON_BIN to the tapsmith-core binary';

/**
 * SIGTERM the ephemeral daemon, and SIGKILL it if it has not exited within
 * `graceMs` (a ListDevices call stuck on a hung adb): the CLI is held open for
 * at most that long, and no daemon is left behind.
 */
function stopDaemon(child: ReturnType<typeof spawn>, graceMs = 3_000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const force = setTimeout(() => { child.kill('SIGKILL'); }, graceMs);
  child.once('exit', () => { clearTimeout(force); });
}

/**
 * Wait up to `timeoutMs` for the daemon to accept connections, in short
 * steps: grpc-js keeps a waitForReady deadline armed after the client is
 * closed, so one long wait would hold the process open for the whole timeout
 * even when the daemon has already failed. `gaveUp` stops the loop once the
 * caller has stopped waiting (the daemon exited).
 */
async function waitForDaemon(
  client: TapsmithGrpcClient,
  timeoutMs: number,
  gaveUp: () => boolean,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0 || gaveUp()) return false;
    if (await client.waitForReady(Math.min(stepMs, left))) return true;
  }
}

/**
 * Spin up an ephemeral `tapsmith-core` daemon, issue `ListDevices`, and tear
 * down. Same shape as `ios network configure`'s helper — this command is
 * short-lived and doesn't need to reuse a long-running daemon. Finding,
 * starting and querying the daemon fail as a ListDevicesError naming the
 * stage; anything else (no free port, a broken install) propagates as is.
 */
export async function listDevicesFromDaemon(
  opts: {
    findBin?: () => string;
    readyTimeoutMs?: number;
    connect?: (address: string) => TapsmithGrpcClient;
    spawnDaemon?: typeof spawn;
  } = {},
): Promise<DeviceInfoProto[]> {
  let bin: string;
  try {
    bin = (opts.findBin ?? findDaemonBin)();
  } catch (err) {
    throw new ListDevicesError('DAEMON_NOT_FOUND', err instanceof Error ? err.message : String(err), DAEMON_BIN_FIX);
  }

  const port = String(await pickFreePort());
  let child: ReturnType<typeof spawn>;
  try {
    child = (opts.spawnDaemon ?? spawn)(bin, ['--port', port], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (err) {
    // Some failures (ENOEXEC, EBADARCH: a corrupt or wrong-arch binary) throw
    // here rather than emitting 'error'.
    throw new ListDevicesError(
      'DAEMON_START_FAILED',
      `Failed to start the tapsmith-core daemon (${bin}): ${err instanceof Error ? err.message : String(err)}`,
      DAEMON_BIN_FIX,
    );
  }
  // The others (ENOENT, EACCES) emit 'error', which with no listener would
  // crash the process instead of being reported; a daemon that starts and
  // exits at once (a crash, a missing library) is as broken. Either is known
  // at once, so neither waits out the ready timeout.
  let spawnError: string | undefined;
  let exitedEarly = false;
  const spawnFailed = new Promise<false>((resolve) => {
    child.on('error', (err) => { spawnError = err.message; resolve(false); });
    child.on('exit', (code, signal) => {
      if (spawnError === undefined) {
        spawnError = signal ? `it was killed by ${signal}` : `it exited with code ${code}`;
        exitedEarly = true;
      }
      resolve(false);
    });
  });

  let client: TapsmithGrpcClient | undefined;
  try {
    // Inside the try: a client that cannot be built (a missing proto file)
    // must not leave the daemon just spawned running.
    client = (opts.connect ?? ((address) => new TapsmithGrpcClient(address)))(`127.0.0.1:${port}`);
    const readyTimeoutMs = opts.readyTimeoutMs ?? 5_000;
    const ready = await Promise.race([waitForDaemon(client, readyTimeoutMs, () => spawnError !== undefined), spawnFailed]);
    if (!ready && spawnError) {
      throw new ListDevicesError(
        'DAEMON_START_FAILED',
        `Failed to start the tapsmith-core daemon (${bin}): ${spawnError}`,
        // A binary that could not be run is a broken install; one that ran and
        // exited may have lost a port race, so a retry comes first.
        exitedEarly ? `Re-run npx tapsmith list-devices; if it keeps failing: ${DAEMON_BIN_FIX}` : DAEMON_BIN_FIX,
      );
    }
    if (!ready) {
      // It started but did not answer: a slow or loaded host as often as a
      // broken binary, so reinstalling is not the first thing to try.
      throw new ListDevicesError(
        'DAEMON_START_FAILED',
        `The tapsmith-core daemon (${bin}) did not answer within ${readyTimeoutMs / 1000} s`,
        'Re-run npx tapsmith list-devices; if it keeps failing, run npx tapsmith doctor --json',
      );
    }
    try {
      const response = await client.listDevices();
      // Usable devices first; the ones adb cannot use come back as rows that
      // are not ready, each with its fix.
      return [...response.devices, ...response.unusableDevices];
    } catch (err) {
      throw new ListDevicesError(
        'LIST_DEVICES_FAILED',
        `The daemon could not list devices: ${err instanceof Error ? err.message : String(err)}`,
        'Re-run npx tapsmith list-devices; if it keeps failing, run npx tapsmith doctor --json',
      );
    }
  } finally {
    client?.close();
    stopDaemon(child);
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────

/** Per platform, why it cannot run on this machine; undefined when it can. */
export interface ToolchainBlockers {
  android: string | undefined;
  ios: string | undefined;
}

export interface ListDevicesDeps {
  fetchDevices: () => Promise<DeviceInfoProto[]>;
  /** devicectl + USB cross-reference for physical iOS devices. */
  enrich: () => { physical: PhysicalDeviceInfo[]; usbAttached: Set<string> };
  /** Live claims of other Tapsmith sessions, by device. */
  claims: () => ReadonlyMap<string, DeviceClaim>;
  /** Why each platform cannot run here (`androidToolchainBlocker` / `iosToolchainBlocker`); read only when nothing was found. */
  toolchain: () => ToolchainBlockers;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Physical iOS enrichment; macOS only — `xcrun devicectl` is macOS-only. */
function enrichFromHost(): { physical: PhysicalDeviceInfo[]; usbAttached: Set<string> } {
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
  return { physical, usbAttached };
}

/** Runs the command and returns the process exit code. */
export async function runListDevices(opts: { json: boolean }, overrides: Partial<ListDevicesDeps> = {}): Promise<number> {
  const deps: ListDevicesDeps = {
    fetchDevices: () => listDevicesFromDaemon(),
    enrich: enrichFromHost,
    claims: liveClaimsByDevice,
    toolchain: () => ({ android: androidToolchainBlocker(), ios: iosToolchainBlocker() }),
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    ...overrides,
  };

  let rows: DeviceRow[];
  try {
    const daemonDevices = await deps.fetchDevices();
    const { physical, usbAttached } = deps.enrich();
    rows = buildDeviceRows(daemonDevices, physical, usbAttached, deps.claims());
  } catch (err) {
    // Text mode lets an unexpected error reach the CLI's fatal-error handler,
    // stack and all, like the other commands.
    if (!opts.json && !(err instanceof ListDevicesError)) throw err;
    const failure = err instanceof ListDevicesError
      ? jsonError(err.code, err.message, { fix: err.fix })
      : jsonError('UNEXPECTED_ERROR', `list-devices could not finish: ${err instanceof Error ? err.message : String(err)}`, {
        fix: 'To see the full error, run the same command again without --json',
      });
    if (opts.json) {
      deps.stdout(formatJson(failure));
    } else {
      deps.stderr(red(failure.error.message) + '\n');
      if (failure.error.fix) deps.stderr(dim(failure.error.fix) + '\n');
    }
    return 1;
  }

  if (opts.json) {
    deps.stdout(formatJson({ devices: rows }));
    return 0;
  }

  deps.stdout('\n' + (rows.length === 0 ? noDevicesHint(deps.toolchain()) : formatTable(rows)) + '\n');
  return 0;
}

function canRunXcrun(): boolean {
  try {
    execFileSync('xcrun', ['--find', 'devicectl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
