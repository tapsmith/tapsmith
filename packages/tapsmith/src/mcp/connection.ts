import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { withFileLockSync } from '../file-lock.js';
import { TapsmithGrpcClient, type DeviceInfoProto } from '../grpc-client.js';
import { findDaemonBin } from '../daemon-bin.js';
import { pickFreePort } from '../port-utils.js';
import { resolveDeviceGroup, primaryDevicePin, type TapsmithConfig } from '../config.js';
import { loadMcpConfig } from './config-loader.js';
import { describeUnusableAndroidDevices, pinnedDeviceUnusableMessage, type AdbStateEntry } from '../device-advice.js';
import { uiPortFilePath, allUiPortFiles, mcpDaemonRegistryPath } from './port-file.js';
import { openDaemonLog, readDaemonLogSince } from './daemon-log.js';
import { awaitDaemonStart, daemonStartFailure, spawnDaemonBinary, type DaemonStartFailed } from '../daemon-start.js';
import { withDetail } from '../error-detail.js';
import {
  DaemonClaimedError,
  DeviceClaimedError,
  claimDevice,
  claimDeviceOrThrow,
  currentSession,
  daemonDriverElsewhere,
  heldDevicesNote,
  releaseDeviceClaim,
  withoutHeldDevices,
} from '../device-claims.js';

const DEFAULT_ADDRESS = 'localhost:50051';

// ─── Connection Pool ───

/**
 * Where a pooled daemon came from. It decides what we may do to it.
 *
 * The line that matters is whether something else is still driving it. A
 * daemon we `started`, one the user `configured` us to use, or an `orphan`
 * whose starting session is gone, are all ours: they can be repointed and have
 * an agent started on them. A `peer` MCP session's and a `ui` worker's are
 * mid-run for someone else — repointing one sends their next action to our
 * device, and starting an agent installs our config's artifacts on theirs.
 */
type DaemonSource = 'started' | 'peer' | 'orphan' | 'configured' | 'ui';

/** Sources we are free to repoint and start agents on. */
function isOurs(source: DaemonSource): boolean {
  return source === 'started' || source === 'configured' || source === 'orphan';
}

/** Sources that record themselves in the shared registry, and so must unregister. */
function isRegistered(source: DaemonSource): boolean {
  return source === 'started' || source === 'peer' || source === 'orphan';
}

interface DaemonConnection {
  client: TapsmithGrpcClient
  address: string
  devices: string[]
  daemonProcess?: ChildProcess
  source: DaemonSource
  /**
   * Platform this daemon serves — set when it was started for one, or when a
   * platform target claimed a platform-less one. Unknown only for a daemon we
   * found and have not claimed.
   */
  platform?: string
  /** Set once a platform target claims this daemon, so a second cannot. */
  claimedBy?: string
  /**
   * The device this daemon was pointed at. A daemon can list devices it is not
   * driving, so this — not `devices` — says which connection serves a serial.
   */
  preparedDevice?: string
  /** The device this daemon reports as Active, refreshed with the device index. */
  activeDevice?: string
  /**
   * The device discovery claimed for this session because the adopted daemon
   * was already pointed at it (PILOT-381) — given back with the connection.
   */
  claimedDevice?: string
  /**
   * Set when this daemon was pointed at `preparedDevice` but its agent would
   * not start. Both facts are true and both matter: the daemon really did move,
   * so nothing may assume otherwise — and it is not a device this session can
   * act on, so it must not be counted as one.
   */
  agentFailed?: boolean
}

let _connections: DaemonConnection[] = [];
let _deviceIndex: Map<string, DaemonConnection> = new Map();
let _sessionDevices: Set<string> | null = null;
let _ready = false;
let _connectingPromise: Promise<void> | null = null;
let _configFile: string | undefined;
/** Whether this process is the UI server, whose worker daemons are its own. */
let _uiMode = false;
/**
 * The config discovery loaded, kept for work that happens between discoveries.
 *
 * Repointing a daemon has to start that config's agent on the new device, and
 * a device tool has no config of its own to hand down.
 */
let _discoveredConfig: TapsmithConfig | null = null;
/** Addresses a running UI session told us it owns, from the last discovery. */
let _uiOwned: Set<string> = new Set();
/**
 * Device serials a running UI session told us it holds, from the last discovery.
 *
 * Refusing that session's *daemons* (`_uiOwned`) was not enough: a headless
 * session then started its own daemon and its own agent on the very devices
 * that session was driving. Measured: `tapsmith mcp-server` beside a UI run
 * logged "Ignoring localhost:50051 — it belongs to a running UI-mode session"
 * and, two lines later, "Using device: emulator-5554" — the UI run's device.
 * A group config claimed one per member.
 */
let _uiHeld: Set<string> = new Set();
/** The UI server's in-process ownership answer; see `configureMcpConnection`. */
let _uiDaemonPorts: (() => UiDaemonPorts) | undefined;

/**
 * Configure the connection pool for the server that is about to use it.
 *
 * `uiMode` says this process *is* the UI server, whose MCP endpoint drives that
 * session's own worker daemons. A headless server is documented as getting its
 * own session, daemon and device, independent of any UI session — so only the
 * UI server asks the UI server what it is running. Both call sites state their
 * whole configuration; there is no merging of successive calls.
 */
export function configureMcpConnection(options?: {
  configFile?: string
  uiMode?: boolean
  /**
   * The UI server's own answer to "which daemons and devices are this
   * session's", read in-process by its MCP endpoint (PILOT-564). Without it a
   * UI-mode endpoint asks over HTTP via the per-project port file, which a
   * second UI session in the project overwrites.
   */
  uiDaemonPorts?: () => UiDaemonPorts
}): void {
  _configFile = options?.configFile;
  _uiMode = options?.uiMode ?? false;
  _uiDaemonPorts = options?.uiDaemonPorts;
}

export function getSessionDeviceSerials(): Set<string> | null {
  return _sessionDevices;
}

export function getAllDaemonAddresses(): string | null {
  if (_connections.length === 0) return null;
  return _connections.map(c => c.address).join(',');
}

export async function ensureConnected(device?: string): Promise<TapsmithGrpcClient> {
  if (_ready && _connections.length > 0) {
    if (device) {
      const conn = _deviceIndex.get(device);
      if (conn) {
        const alive = await conn.client.waitForReady(1_000);
        if (alive) return conn.client;
        removeConnection(conn);
      }
      // Device not found or daemon died — re-discover (new daemons may have started)
      _ready = false;
    } else {
      // No specific device — return default
      const defaultConn = _connections[0];
      const alive = await defaultConn.client.waitForReady(1_000);
      if (alive) return defaultConn.client;
      removeConnection(defaultConn);
      // Fall through to re-discover
      _ready = false;
    }
  }

  // First-time init (with mutex to prevent concurrent discovery)
  if (_connectingPromise) {
    await _connectingPromise;
    return ensureConnected(device);
  }
  _connectingPromise = discover();
  try {
    await _connectingPromise;
  } finally {
    _connectingPromise = null;
  }

  if (_connections.length === 0) {
    // Why, in the tool result: few MCP clients show the server's stderr,
    // where these reasons used to be the only place they appeared (PILOT-463).
    throw new Error(_discoveryFailures.length > 0
      ? withDetail('No Tapsmith daemon is available', _discoveryFailures.flatMap((m) => m.split('\n')))
      : 'No Tapsmith daemon is available: the session closed while one was starting.');
  }

  _ready = true;

  if (device) {
    const conn = _deviceIndex.get(device);
    if (conn) return conn.client;
    const available = [..._deviceIndex.keys()];
    throw new Error(
      `Device "${device}" not found in any connected daemon. ` +
      `Available devices: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }

  return _connections[0].client;
}

export interface SessionDevice {
  serial: string
  platform?: string
}

/**
 * The device a device tool should act on, and the client that serves it.
 *
 * `ensureConnected()` with no device falls back to the first pooled daemon —
 * a fair guess when a session had one, and now merely the first platform to
 * resolve. Nothing in the response said which device answered, so a screenshot
 * taken while debugging an iOS failure could be the Android emulator's.
 *
 * `platform` is how a caller says which one it means without knowing a serial:
 * tools take a project name, which maps to a platform, which maps here. Serials
 * change between runs; project names do not.
 */
export async function resolveDeviceTarget(
  request?: { device?: string; project?: RequestedProject },
): Promise<{ client: TapsmithGrpcClient; device?: string }> {
  const { device, project } = request ?? {};
  if (device) return { client: await clientPointedAt(device), device };

  // Discovery has to run before the session can say what it is driving.
  await ensureConnected();
  // UI mode spawns its worker daemons on the first run, which is usually after
  // the first tool call — and the pool is cached once discovery has succeeded.
  // Without this refresh a UI session keeps answering from the primary daemon
  // and reports no per-platform devices at all, however many workers exist.
  await refreshUiConnections();
  const targets = sessionTargetDevices();

  if (project) {
    const chosen = selectProjectDevice(targets, project);
    if ('error' in chosen) throw new Error(chosen.error);
    return forDevice(chosen.serial);
  }

  // The daemon that *holds* the device, not whichever sits at index 0 — those
  // are different connections as soon as the session has a daemon it has not
  // pointed anywhere, and answering from the wrong one is the whole failure
  // this function exists to prevent.
  if (targets.length === 1) return forDevice(targets[0].serial);
  // Asked for again rather than held across the refresh: retiring the last UI
  // worker closes that connection's client, and the pool it left behind may be
  // empty — in which case this re-discovers instead of handing back a client
  // that is already closed, which surfaces as an opaque "Channel closed".
  if (targets.length === 0) return { client: await ensureConnected() };
  const ambiguous = ambiguousDeviceMessage(targets);
  if (ambiguous) throw new Error(ambiguous);
  return forDevice(primaryDevice(targets)!.serial);
}

/** A project a caller named, and the platform it runs on (which may be none). */
export interface RequestedProject {
  name: string
  platform?: string
}

/**
 * The device a named project runs on, or why it cannot be picked.
 *
 * Matched on the project's platform, `undefined` included: a config whose root
 * declares no platform gives its unqualified projects exactly that, and they
 * run on the session's unqualified device. Treating that as "no project was
 * named" fell through to the generic path, whose message told the caller to
 * pass the `project` they had just passed.
 *
 * @internal — exported for unit testing.
 */
export function selectProjectDevice(
  targets: SessionDevice[],
  project: RequestedProject,
): { serial: string } | { error: string } {
  const match = targets.filter((t) => t.platform === project.platform);
  if (match.length === 1) return { serial: match[0].serial };
  const called = project.platform ? `${project.platform} ` : '';
  if (match.length === 0) {
    return {
      error: `This session has no ${called}device for project "${project.name}". ${describeTargets(targets)}`,
    };
  }
  // Several devices for one project are that project's workers. The caller
  // answered the only question they could — which project — so refusing here
  // would leave `project` unable to select anything on a parallel run, and
  // send them back to a serial for a device they never picked.
  return { serial: primaryDevice(match)!.serial };
}

async function forDevice(serial: string): Promise<{ client: TapsmithGrpcClient; device: string }> {
  return { client: await clientPointedAt(serial), device: serial };
}

/**
 * The client for a device, with its daemon actually pointed at it.
 *
 * Pooled connections are shared, so a tool naming a device explicitly moves the
 * daemon for every later tool too. Doing that without recording it left the
 * session's own account of itself wrong: `preparedDevice` still named the old
 * device, so a following no-argument call resolved to it, was handed the same
 * client, saw nothing to change — and answered from the device the explicit
 * call had moved to, while `session_info` reported the old one.
 *
 * Pointing is skipped when the daemon is already there, which is the common
 * case and keeps a round trip off every call.
 */
async function clientPointedAt(serial: string): Promise<TapsmithGrpcClient> {
  const client = await ensureConnected(serial);
  const conn = _deviceIndex.get(serial);
  if (!conn) return client;

  // Ask the daemon, and fall back to our notes only when it cannot be reached.
  // `preparedDevice` records what *this* process did and `activeDevice` is a
  // cached read; a registered daemon can be adopted by a second session that
  // has moved it since. Acting on either belief is the failure this function
  // exists to prevent — reporting one device while acting on another.
  const pointedAt = await currentDevice(conn) ?? conn.preparedDevice ?? conn.activeDevice;

  // Already there. Nothing to move, whoever owns it — and refusing here
  // contradicted the step that got us here: a peer's daemon has no
  // `preparedDevice` of ours, so its device arrives through `activeDevice`,
  // which `sessionDevicesFrom` counts and `resolveDeviceTarget` may select.
  // The tool then failed with "which is driving X … use the device it already
  // holds", where X was the device it had just been asked for.
  if (pointedAt === serial) return client;

  if (conn.preparedDevice === serial) {
    throw new Error(
      `Another session has pointed that daemon at ${pointedAt}, so it no longer drives `
      + `${serial}. Moving it back would leave the agent attached to ${pointedAt}. `
      + `Re-run this against a session of your own, or use ${pointedAt}.`,
    );
  }
  // Only a daemon that is ours to drive. A UI worker's and a peer session's are
  // both mid-run for someone else, and moving one sends their next action to
  // our device — the same line `findConnectionForPlatform` draws, for the same
  // reason.
  if (!isOurs(conn.source)) {
    const owner = conn.source === 'ui' ? 'a UI-mode worker' : 'another MCP session';
    throw new Error(
      `Device ${serial} is only reachable through a daemon belonging to ${owner}`
      + `${pointedAt ? `, which is driving ${pointedAt}` : ''}. Pointing it at ${serial} would `
      + 'redirect that run. Use the device it already holds, or a session of your own.',
    );
  }
  // A daemon this session has already pointed somewhere is not moved.
  //
  // `set_device` does not detach the agent, and forcing a fresh `StartAgent`
  // afterwards is not enough either: measured against two booted simulators,
  // a snapshot taken after repointing came back with the *previous* device's
  // screen — the throwaway showed only SpringBoard while the response
  // described the test app. Serving that as the named device's state, with
  // `preparedDevice` updated so nothing looks wrong, is the worst of the
  // options. A session drives one device per platform; say so instead.
  if (conn.preparedDevice && !conn.agentFailed) {
    throw new Error(
      `This session drives ${conn.preparedDevice} on that daemon, and pointing it at `
      + `${serial} would leave the agent attached to ${conn.preparedDevice} — actions would `
      + `report ${serial} while acting on ${conn.preparedDevice}. Use ${conn.preparedDevice}, `
      + 'or start a session configured for the device you want.',
    );
  }
  // Nothing prepared here yet — an adopted daemon we have not pointed anywhere,
  // or one whose agent never started, which serves no device as it stands.
  // Pointing it is what makes it this session's, agent included.
  await prepareTarget(conn, serial, _discoveredConfig);
  return client;
}

/**
 * Why this session cannot pick a device on the caller's behalf, or null when it
 * can. @internal — exported for unit testing.
 */
export function ambiguousDeviceMessage(targets: SessionDevice[]): string | null {
  if (targets.length <= 1) return null;
  // Only a session spanning platforms has a choice the caller must make.
  // Several devices on one platform are the workers of a single run — clones
  // of one config, running the same tests — so any of them answers the
  // question, and `primaryDevice` picks one. Demanding a serial there made
  // every no-argument device tool fail on the common `workers: 2` UI session,
  // for an argument the caller could only get from `session_info`.
  const platforms = new Set(targets.map((t) => t.platform));
  if (platforms.size <= 1) return null;
  return `This session is driving devices on ${platforms.size} platforms, `
    + `so there is no single default. ${describeTargets(targets)} `
    + 'Pass `project` to say which one this should act on, or `device` for a specific serial.';
}

/**
 * The device a session acts on when the caller names none.
 *
 * First, not "best": for UI mode that is worker 0, the device the UI itself
 * treats as primary, and for a headless session the one it prepared first.
 * Stable ordering is what makes this defensible — the same session answers the
 * same way for every call, so a snapshot and the tap that follows it land on
 * one device.
 *
 * @internal — exported for unit testing.
 */
export function primaryDevice(targets: SessionDevice[]): SessionDevice | undefined {
  return targets[0];
}

function describeTargets(targets: SessionDevice[]): string {
  if (targets.length === 0) return 'It is driving none.';
  const listed = targets
    .map((t) => (t.platform ? `${t.platform}: ${t.serial}` : t.serial))
    .join(', ');
  return `Devices: ${listed}.`;
}

/**
 * The devices this session is actually driving — not every device it can see.
 *
 * A daemon lists devices it was never pointed at (two booted simulators, say),
 * and treating those as targets would demand an argument from a session that
 * only ever uses one. `preparedDevice` is what we pointed a daemon at, and for
 * a UI worker it is what the UI server told us that worker holds — the two
 * transports answer this the same way.
 *
 * @internal — exported for unit testing.
 */
export function sessionTargetDevices(): SessionDevice[] {
  return sessionDevicesFrom(_connections);
}

/** The decision behind {@link sessionTargetDevices}. @internal — exported for unit testing. */
export function sessionDevicesFrom(
  connections: Array<{
    preparedDevice?: string
    activeDevice?: string
    platform?: string
    agentFailed?: boolean
  }>,
): SessionDevice[] {
  const bySerial = new Map<string, SessionDevice>();
  for (const conn of connections) {
    // A daemon pointed at a device whose agent never started is not a device
    // this session can act on. Counting it made every no-argument device tool
    // refuse as ambiguous over a target that could not serve one anyway.
    if (conn.agentFailed) continue;
    // `devices` is refreshed from each daemon's own list, so the one it reports
    // Active is what it drives even when nothing here pointed it there — a
    // daemon found at the default address, say.
    const serial = conn.preparedDevice ?? conn.activeDevice;
    if (!serial) continue;
    // A platform-tagged connection wins over an untagged one reporting the same
    // serial — a daemon nothing claimed still names whichever device is Active,
    // and letting it overwrite the tag would leave the device matching no
    // project at all, so a valid `project` argument would be refused.
    const known = bySerial.get(serial);
    if (known?.platform && !conn.platform) continue;
    bySerial.set(serial, { serial, platform: conn.platform });
  }
  // Deliberately not `_sessionDevices`: that is what the UI server *says* it
  // has, and a worker whose daemon we could not reach is not something this
  // session can act on. Counting it made a one-device session refuse every
  // device tool as ambiguous, naming a phantom that no argument could select.
  return [...bySerial.values()];
}

/**
 * UI worker connections the UI server no longer lists.
 *
 * A worker that dies mid-run is retired and its daemon killed, so it drops out
 * of `/api/daemon-ports`. Dropping it here too is what keeps the session
 * honest: the connection still carries the `preparedDevice` it was handed, and
 * `sessionTargetDevices` reads that in preference to anything live — so a
 * session that lost one of two workers would go on refusing every device tool
 * as ambiguous, naming a device no argument could successfully select.
 *
 * Only `ui` connections: every other source answers to something other than
 * the UI server's worker list, and absence from it says nothing about them.
 *
 * @internal — exported for unit testing.
 */
export function retiredUiConnections<T extends { address: string; source: string }>(
  connections: T[],
  daemons: Array<{ address: string }>,
): T[] {
  return connections.filter(
    (c) => c.source === 'ui' && !daemons.some((d) => d.address === c.address),
  );
}

/**
 * Re-sync this session's UI worker daemons with the ones the UI server has.
 *
 * Cheap enough to do per interactive call: one loopback GET, and connections
 * we already hold are left alone. Silent on every failure — a session with no
 * UI server behind it is the normal case, not an error.
 */
async function refreshUiConnections(): Promise<void> {
  const { reachable, daemons, deviceSerials } = await discoverFromUiServer();
  if (!reachable) return;
  if (deviceSerials.size > 0) _sessionDevices = deviceSerials;

  for (const conn of retiredUiConnections(_connections, daemons)) {
    log(`UI worker daemon at ${conn.address} is gone — dropping it from this session`);
    removeConnection(conn);
  }

  const added: DaemonConnection[] = [];
  for (const daemon of daemons) {
    if (_connections.some((c) => c.address === daemon.address)) continue;
    const client = new TapsmithGrpcClient(daemon.address);
    try {
      if (!(await client.waitForReady(1_000))) { client.close(); continue; }
    } catch {
      client.close();
      continue;
    }
    added.push({
      client,
      address: daemon.address,
      devices: [],
      source: 'ui',
      platform: daemon.platform,
      preparedDevice: daemon.deviceSerial,
    });
  }
  if (added.length === 0) return;
  _connections.push(...added);
  await refreshDeviceIndex();
}

/**
 * Every device the pooled daemons list, deduped by serial: the usable ones,
 * and those adb lists but cannot use (`unusableDevices`: unauthorized,
 * offline, …) — a serial usable on any daemon is usable.
 */
export async function listAllDevices(): Promise<{ devices: DeviceInfoProto[]; unusable: DeviceInfoProto[] }> {
  await ensureConnected();
  const perConn = await Promise.all(_connections.map(async (conn) => {
    try {
      const { devices, unusableDevices } = await conn.client.listDevices();
      return { devices, unusable: unusableDevices ?? [] };
    } catch {
      return { devices: [], unusable: [] };
    }
  }));
  return mergeDeviceLists(perConn);
}

/**
 * Several daemons' lists as one, deduped by serial. Usable devices are taken
 * first, so a serial usable on any daemon is never also listed unusable.
 * A daemon keeps its active device as `Disconnected` once adb stops listing
 * it as usable — and lists it under `unusable` too, with adb's state, which
 * is the entry kept; a `Disconnected` one with no adb entry goes last.
 *
 * @internal — exported for unit testing.
 */
export function mergeDeviceLists(
  perConn: ReadonlyArray<{ devices: DeviceInfoProto[]; unusable: DeviceInfoProto[] }>,
): { devices: DeviceInfoProto[]; unusable: DeviceInfoProto[] } {
  const seen = new Set<string>();
  const firstSeen = (d: DeviceInfoProto): boolean => {
    if (seen.has(d.serial)) return false;
    seen.add(d.serial);
    return true;
  };
  const all = perConn.flatMap((c) => c.devices);
  const disconnected = (d: DeviceInfoProto): boolean => d.state === 'Disconnected';
  const devices = all.filter((d) => !disconnected(d)).filter(firstSeen);
  const unusable = [...perConn.flatMap((c) => c.unusable), ...all.filter(disconnected)].filter(firstSeen);
  return { devices, unusable };
}

// ─── Discovery ───

/**
 * Whether discovery's own daemon should select a device (and start its agent).
 *
 * Only in a UI session, whose endpoint normally adopts the UI's own daemons.
 * A headless session resolves a target per platform before any run or device
 * tool, and `prepareTarget` selects the device and starts the agent then — on
 * the device the run named, if it named one. Selecting here first put an
 * agent on whichever device looked best, another session's as likely as not,
 * on nothing more than a `list_devices` (PILOT-342).
 *
 * That holds with no config file too (the session runs on the defaults, which
 * still resolve targets), and with one that fails to load: the load error is
 * the session's answer, not a reason to claim a device (PILOT-262).
 *
 * @internal — exported for unit testing.
 */
export function discoverySelectsDevice(opts: { uiMode: boolean }): boolean {
  return opts.uiMode;
}

/**
 * Why the last discovery ended with no daemon to use, for the error
 * `ensureConnected` throws: the start failure in the daemon's own words, a
 * failed setup, a found daemon that could not be reached.
 */
let _discoveryFailures: string[] = [];

/**
 * Give back this process's hold on `device` (PILOT-381). Never in the UI
 * server, whose MCP endpoint runs in the very process that provisioned the UI
 * session's devices: its hold is the UI session's, and lasts as long as it.
 */
function giveBack(device: string, from?: DaemonConnection): void {
  if (_uiMode) return;
  // Another pooled daemon of this session still serves it: keep it. Not the
  // one it is being given back from (`from`: its target failed, or it is
  // being repointed), which still records the device but no longer serves it.
  if (_connections.some((c) => c !== from && (c.preparedDevice === device || c.claimedDevice === device))) return;
  releaseDeviceClaim(device, currentSession());
}

/**
 * Drop the daemons another live Tapsmith session is driving a device through
 * (PILOT-381). Adopting one — the default `localhost:50051` fallback found
 * another worktree's daemon this way — let this session restart that session's
 * agent and repoint its device. A daemon counts as that session's when the
 * device it is pointed at now is one the other session claimed through it
 * (not by address alone: a port a dead daemon left can be reused by an
 * unrelated one), or — whichever daemon it came through — when another
 * session holds that device at all: starting our agent on it would restart
 * theirs.
 *
 * A daemon this session may drive (`isOurs`: a configured or orphaned one)
 * and keeps is pointed at a device the session now drives, so that device is
 * claimed here; if another session claims it first, the daemon is dropped.
 */
async function withoutOtherSessionsDaemons<T extends { client: TapsmithGrpcClient; address: string; source: DaemonSource; claimedDevice?: string }>(
  live: T[],
  /** The config's platform, when it has one: a daemon serving another is not adopted. */
  platform?: string,
): Promise<T[]> {
  const session = currentSession();
  const kept = await Promise.all(live.map(async (daemon) => {
    let listed: DeviceInfoProto[] | undefined;
    let asked = false;
    const listedDevices = async (): Promise<DeviceInfoProto[] | undefined> => {
      if (!asked) {
        asked = true;
        listed = await daemon.client.listDevices().then(({ devices }) => devices).catch(() => undefined);
      }
      return listed;
    };
    const activeDevice = async (): Promise<string | undefined> => {
      const devices = await listedDevices();
      return devices ? activeDeviceOf(devices) : undefined;
    };
    const drop = (why: string): null => {
      log(`Ignoring ${daemon.address} — ${why}`);
      daemon.client.close();
      return null;
    };
    const holder = await daemonDriverElsewhere(daemon.address, activeDevice, session);
    if (holder) return drop(`another Tapsmith session is driving ${holder.device} through it`);
    // A daemon found rather than started, serving another platform (PILOT-564).
    // The claims above see only sessions that share this HOME and hold a
    // claim right now; a session in its startup window, under another HOME, or
    // a daemon driven by something else entirely is invisible to them. Adopting
    // one for this config repointed it to our device and started our agent on
    // it, so its owner's next action ran against the wrong platform — and it is
    // no use to us anyway. A UI worker's platform is its session's, and one
    // already pooled was judged when it joined.
    if (platform && daemon.source !== 'ui' && !_connections.some((c) => c.address === daemon.address)) {
      const why = otherPlatformReason(await listedDevices(), platform);
      if (why) return drop(why);
    }
    // UI workers' and peers' devices are their owners' to claim. A daemon
    // already pooled is re-listed by every discovery: what it serves was
    // claimed (or deliberately given back) when it was prepared.
    if (!isOurs(daemon.source) || _connections.some((c) => c.address === daemon.address)) return daemon;
    const device = await activeDevice();
    if (!device) return daemon;
    const claim = claimDevice(device, session, { daemonAddress: daemon.address });
    if (!claim.ok) return drop(`it is pointed at ${device}, which another Tapsmith session is driving`);
    daemon.claimedDevice = device;
    return daemon;
  }));
  return kept.filter((d): d is Awaited<T> => d !== null);
}

/**
 * Why a daemon that lists `devices` cannot serve `platform`, or null when it
 * can (or when it cannot be told: no listing, no platforms reported).
 *
 * It cannot when the device it is pointed at is another platform's — taking it
 * would move it off that device — or when it lists devices but none of this
 * platform's, as a daemon started with `--platform` for the other one does.
 *
 * @internal — exported for unit testing.
 */
export function otherPlatformReason(devices: DeviceInfoProto[] | undefined, platform: string): string | null {
  if (!devices) return null;
  const active = devices.find((d) => d.state === 'Active');
  if (active?.platform && active.platform !== platform) {
    return `it is driving ${active.serial}, an ${active.platform} device, and this session's config is for ${platform}`;
  }
  const platforms = [...new Set(devices.map((d) => d.platform).filter(Boolean))];
  if (platforms.length > 0 && !platforms.includes(platform)) {
    return `it serves ${platforms.join(' and ')} devices only, and this session's config is for ${platform}`;
  }
  return null;
}

/**
 * The one platform every project of `config` runs on, or undefined when they
 * span two. A config that names none runs on Android, as everywhere else.
 *
 * @internal — exported for unit testing.
 */
export function singlePlatformOf(config: Pick<TapsmithConfig, 'platform' | 'projects'>): string | undefined {
  const root = config.platform ?? 'android';
  const platforms = new Set((config.projects ?? []).map((p) => p.use?.platform ?? root));
  if (platforms.size === 0) platforms.add(root);
  return platforms.size === 1 ? [...platforms][0] : undefined;
}

async function discover(): Promise<void> {
  const generation = _sessionGeneration;
  _discoveryFailures = [];
  // A config that fails to load leaves discovery without one; the session's
  // tools report the load error.
  const config = await loadMcpConfig(_configFile).then((result) => result.config).catch(() => null);
  _discoveredConfig = config;
  const sessionPlatform = config ? singlePlatformOf(config) : undefined;

  // Collect candidate addresses from all sources, remembering where each came
  // from — provenance decides whether we may repoint that daemon later.
  const candidates = new Map<string, DaemonSource>();
  const addCandidate = (address: string, source: DaemonSource): void => {
    // First source wins, except that `ui` overrides whatever named the address
    // first. A UI worker's daemon is mid-run for someone else however else it
    // was reached, and the sources ahead of it here are both `configured`,
    // which `isOurs` would have us repoint and install our agent on.
    if (!candidates.has(address) || source === 'ui') candidates.set(address, source);
  };

  // Whether the user named an address for us. A pin means "this daemon", so a
  // pinned session that cannot reach it must not quietly land somewhere else.
  const pinned = Boolean(process.env.TAPSMITH_DAEMON_ADDRESS ?? config?.daemonAddress);

  // 1. Env var (supports comma-separated for multi-daemon)
  if (process.env.TAPSMITH_DAEMON_ADDRESS) {
    for (const addr of process.env.TAPSMITH_DAEMON_ADDRESS.split(',')) {
      const trimmed = addr.trim();
      if (trimmed) addCandidate(trimmed, 'configured');
    }
  }

  // 2. Config file
  if (config?.daemonAddress) {
    addCandidate(config.daemonAddress, 'configured');
  }

  // 3. UI mode discovery — query the UI server for worker daemon ports
  const uiDaemons = await discoverFromUiServer();
  const uiByAddress = new Map(uiDaemons.daemons.map((d) => [d.address, d]));
  for (const daemon of uiDaemons.daemons) {
    addCandidate(daemon.address, 'ui');
  }
  if (uiDaemons.deviceSerials.size > 0) {
    _sessionDevices = uiDaemons.deviceSerials;
  }
  // The UI server's endpoint drives that session's daemons and no others
  // (PILOT-564). Its config names the address the session *asked* for, but a
  // UI run that found another session on that port started on a free one —
  // so the address in the config is then someone else's daemon, which this
  // endpoint adopted, claimed a device on and repointed. The session's own
  // primary daemon is what it publishes in `owned`.
  const uiOwnsCandidates = _uiMode && uiDaemons.reachable;
  if (uiOwnsCandidates) {
    const owned = new Set(uiDaemons.owned.map(normalizeDaemonAddress));
    for (const [address, source] of [...candidates]) {
      if (source !== 'ui' && !owned.has(normalizeDaemonAddress(address))) {
        log(`Ignoring ${address} — it is not one of this UI session's daemons`);
        candidates.delete(address);
      }
    }
    const known = new Set([...candidates.keys()].map(normalizeDaemonAddress));
    for (const address of uiDaemons.owned) {
      if (!known.has(normalizeDaemonAddress(address))) {
        known.add(normalizeDaemonAddress(address));
        addCandidate(address, 'configured');
      }
    }
  }

  // 4. Include existing connections so re-discovery doesn't spawn redundant daemons
  for (const conn of _connections) {
    addCandidate(conn.address, conn.source);
  }

  // 5. Daemons started by other MCP sessions in this project. Without this each
  // session starts its own daemon on a random port and they pile up, all
  // driving the same device.
  //
  // Headless sessions only, and it is the same independence the UI server gets
  // from the other direction: adopting a headless session's daemon here would
  // put its device in the UI session's pool, and every UI device tool without a
  // `project` would refuse as ambiguous over a device the UI run never had.
  if (usesDaemonRegistry()) {
    for (const { address, orphaned } of readDaemonRegistry()) {
      addCandidate(address, orphaned ? 'orphan' : 'peer');
    }
  }

  // A UI session's daemons are its own, primary one included. Dropped here
  // rather than guarded later: this address arrives as `configured`, which
  // `isOurs` would let us repoint and install our agent on, so by the time any
  // ownership guard runs the run has already been taken over.
  if (!_uiMode) {
    // Assigned every time, empty included: a UI session that has since exited
    // owns nothing, and keeping the old set would go on excluding the default
    // address from the fallback probe for the rest of this process's life.
    const holdings = await uiSessionHoldings();
    _uiOwned = holdings.addresses;
    _uiHeld = holdings.devices;
    for (const address of [...candidates.keys()]) {
      if (_uiOwned.has(normalizeDaemonAddress(address))) {
        log(`Ignoring ${address} — it belongs to a running UI-mode session`);
        candidates.delete(address);
      }
    }
  }

  // Probe candidates in parallel
  type LiveDaemon = { client: TapsmithGrpcClient; address: string; source: DaemonSource; claimedDevice?: string };
  const probeAll = async (entries: Array<[string, DaemonSource]>): Promise<LiveDaemon[]> => {
    const results = await Promise.all(entries.map(async ([address, source]) => {
      let client: TapsmithGrpcClient | undefined;
      try {
        client = new TapsmithGrpcClient(address);
        const alive = await client.waitForReady(1_000);
        if (alive) return { client, address, source };
        client.close();
      } catch {
        client?.close();
      }
      return null;
    }));
    return results.filter((r): r is LiveDaemon => r !== null);
  };

  let live = await withoutOtherSessionsDaemons(await probeAll([...candidates]), sessionPlatform);

  // 6. Default address — a last resort, and one judged on what answered rather
  // than on how many addresses we had. Skipping it whenever the candidate list
  // was non-empty stopped being safe once the registry started filling that
  // list: a peer session that is still alive but whose daemon has died leaves
  // a candidate that answers nothing, and the default port — where a
  // hand-started daemon lives — would then never be probed at all.
  //
  // Never against a pin, though. A user who named an address meant that daemon;
  // falling through to 50051 because theirs is briefly down would hand the
  // session an unrelated daemon, classified `configured` and so treated as ours
  // to repoint and install this config's agent artifacts on.
  if (live.length === 0 && !pinned && !uiOwnsCandidates && !candidates.has(DEFAULT_ADDRESS)
      && !_uiOwned.has(normalizeDaemonAddress(DEFAULT_ADDRESS))) {
    live = await withoutOtherSessionsDaemons(await probeAll([[DEFAULT_ADDRESS, 'configured']]), sessionPlatform);
  }
  // Probing is the liveness check, so this is the moment we know which
  // registered daemons are gone. Drop them rather than re-probing dead ports
  // on every future session.
  pruneDaemonRegistry(live.map((l) => l.address));

  if (live.length > 0) {
    // Connect to all live daemons in parallel, then batch-update shared state
    const notAdopted: string[] = [];
    const newConns = await Promise.all(live.map(async ({ client, address, source, claimedDevice }) => {
      if (_connections.some(c => c.address === address)) {
        client.close();
        return null;
      }
      try {
        // Only on a daemon that is ours to drive. A 'peer' or 'ui' daemon
        // belongs to a live session of someone else's, and one reporting no
        // agent is usually between runs rather than free — installing our
        // config's agent artifacts on its active device puts a different
        // platform's app on a device we do not own. An 'orphan' has no such
        // owner left, so recovering its agent here is exactly right.
        //
        // Not for a config spanning platforms either: its root config is no
        // one platform's, and the daemon may be pointed at either. Each
        // platform's target starts its own agent when it claims a daemon. Nor
        // without a config, which says nothing of the platform and whose
        // tools report its load error instead.
        if (isOurs(source) && sessionPlatform) {
          const { agentConnected } = await client.ping();
          if (!agentConnected) await startAgentFromConfig(client, config);
        }
        log(`Connected to daemon at ${address}`);
        // Adopting a peer session's daemon makes us a user of it, so its
        // starter must not kill it while we are still here.
        if (source === 'peer' || source === 'orphan') registerDaemon(address);
        // A UI worker's device and platform come from the UI server, not from
        // anything we did to the daemon — record them so this connection
        // answers the same questions a headless one does.
        const ui = uiByAddress.get(address);
        return {
          client,
          address,
          devices: [],
          source,
          platform: ui?.platform,
          preparedDevice: ui?.deviceSerial,
          claimedDevice,
        } as DaemonConnection;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to connect to daemon at ${address}: ${msg}`);
        _discoveryFailures.push(`Could not connect to the daemon at ${address}: ${msg}`);
        client.close();
        // Not adopted after all: give back the device discovery claimed for
        // it — once the daemons that were adopted are pooled, since one of
        // them may be pointed at the same device.
        if (claimedDevice) notAdopted.push(claimedDevice);
        return null;
      }
    }));
    _connections.push(...newConns.filter((c): c is DaemonConnection => c !== null));
    for (const device of notAdopted) giveBack(device);
    if (_connections.length > 0) {
      await refreshDeviceIndex();
      return;
    }
    // Every daemon that answered the probe then failed to connect — stale,
    // wedged, or not a Tapsmith daemon at all. That leaves us exactly where
    // finding none does, so do what finding none does (PILOT-489). Their
    // failures stay recorded, for the error if our own start fails too.
    log('No daemon found could be used, starting one...');
  }

  // A session that closed while we were probing must not get a daemon: it
  // would be spawned detached, registered, and never stopped.
  if (generation !== _sessionGeneration) return;

  // 7. No usable daemon — start our own
  let conn: DaemonConnection | null;
  try {
    // The session's one platform, Android included when the config names none:
    // a daemon without `--platform` would pick any free device, including the
    // other platform's that a found daemon was just refused over.
    conn = await startDaemon(sessionPlatform ?? config?.platform);
    // The connection keeps the config's own platform, unset included: device
    // tools match a project to its device by that value, and a project that
    // names no platform carries none.
    if (conn) conn.platform = config?.platform;
  } catch (err) {
    _discoveryFailures.push(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!conn) return;

  try {
    // Record what it was pointed at: a platform-less daemon picks whichever
    // device is Active and starts that platform's agent, so a later target
    // claiming this daemon for a *different* device must know it is repointing
    // one — otherwise the daemon reports an agent connected and the second
    // platform silently runs against the first one's.
    // A device a UI session holds is never preferred: the target's own guard
    // refuses that pin by name.
    conn.preparedDevice = discoverySelectsDevice({ uiMode: _uiMode })
      ? await setDeviceAndAgent(conn.client, conn.address, config)
      : undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Daemon started but setup failed: ${msg}`);
    _discoveryFailures.push(`Started a daemon, but setting it up failed: ${msg}`);
    // `removeConnection` already unregisters a daemon we started; a second call
    // would take the registry lock again, and that lock blocks the event loop.
    removeConnection(conn);
    return;
  }

  await refreshDeviceIndex();
}

/**
 * Start a daemon for `platform` and add it to the pool.
 *
 * A daemon only serves the platform it was started for, so a session spanning
 * Android and iOS needs one of each — hence this is callable outside the
 * initial discovery.
 */
/** Every port this session has handed to a daemon, gRPC and agent alike. */
const _issuedPorts = new Set<number>();

/** Daemons spawned by `startDaemon` that have not yet joined `_connections`. */
const _startingDaemons = new Set<ChildProcess>();

/**
 * Bumped by `closeAllClients`. A tool call still in flight when the session
 * closes keeps running its awaits; a `startDaemon` that began before the close
 * must not spawn a daemon, or add one to the freshly reset connection list,
 * after it.
 */
let _sessionGeneration = 0;

/**
 * A free port this session has not already given out.
 *
 * `pickFreePort` binds `:0` and closes again, so two calls in a row can be
 * handed the same port — nothing holds it in between, and with no connection
 * made there is no TIME_WAIT to keep it reserved. That is a hazard within one
 * daemon, which would serve gRPC on the port it also forwards its agent to,
 * and *between* two: a session spanning both platforms starts a daemon per
 * platform, and the second one's gRPC port can be the first one's agent port,
 * which stays unbound until that agent actually starts. Either way one agent
 * never attaches. Other spawn paths avoid this by drawing agent ports from
 * their own 18700+ band; this one picks both, so it has to remember.
 */
async function pickUnissuedPort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await pickFreePort();
    if (_issuedPorts.has(port)) continue;
    _issuedPorts.add(port);
    return port;
  }
  throw new Error('Could not find a free port this session has not already used');
}

/**
 * Arguments for a daemon this session spawns.
 *
 * @internal — exported for unit testing.
 */
export function daemonSpawnArgs(port: string, agentPort: string, platform?: string): string[] {
  // `--outlive-parent`: a daemon otherwise shuts down (stopping its agents)
  // when the process that spawned it exits (PILOT-299). This one is detached
  // so it can outlive this session and be adopted from the registry — see
  // startDaemon below.
  const args = ['--port', port, '--agent-port', agentPort, '--outlive-parent'];
  if (platform) args.push('--platform', platform);
  return args;
}

/**
 * Start a daemon and add it to the pool. Throws when it does not start, with
 * the daemon's own output and log path in the message; null only when the
 * session closed while it was starting.
 *
 * @internal — exported for unit testing.
 */
export async function startDaemon(
  platform?: string,
  /** The group member it is for, named in the failure. */
  member?: string,
): Promise<DaemonConnection | null> {
  const generation = _sessionGeneration;
  const sessionClosed = (): boolean => generation !== _sessionGeneration;
  log(platform ? `Starting an ${platform} daemon...` : 'No daemon found, starting one...');
  const port = String(await pickUnissuedPort());
  // Its own agent port, like every other daemon we spawn (see dispatcher.ts
  // and ui-server.ts). Daemons default to a shared one, which was harmless
  // while a session had a single daemon — but a session now runs one per
  // platform, and the second would attach to the first platform's agent:
  // iOS tools would drive the Android device, and iOS-only calls would come
  // back as "Unknown method".
  const agentPort = String(await pickUnissuedPort());
  const bin = findDaemonBin();
  const daemonArgs = daemonSpawnArgs(port, agentPort, platform);
  if (sessionClosed()) return null;

  // `detached`, not just `unref`. A daemon may outlive the session that started
  // it — that is the whole point of the registry, and `closeAllClients`
  // deliberately leaves one running when a peer has adopted it. Without its own
  // process group, a Ctrl-C in the starter's shell is delivered to the group and
  // kills the daemon anyway, before any of that reasoning runs. `unref` only
  // stops it holding *our* event loop open, which is a different problem.
  // Output goes to a log file, not a pipe back to us. The daemon is meant to
  // outlive this server when a peer adopts it, and once we exit a pipe has no
  // reader: the daemon's writes fail with EPIPE for the rest of its life, and
  // its logs are gone anyway (PILOT-453).
  const daemonLog = openDaemonLog(log);
  const stdio: StdioOptions = daemonLog ? ['ignore', daemonLog.fd, daemonLog.fd] : 'ignore';
  let daemonSpawn: ReturnType<typeof spawnDaemonBinary>;
  try {
    daemonSpawn = spawnDaemonBinary(bin, daemonArgs, { stdio, detached: true });
  } finally {
    // The child has its own copy; ours would only leak a descriptor per daemon.
    if (daemonLog) {
      try { fs.closeSync(daemonLog.fd); } catch { /* already closed */ }
    }
  }
  const logNote = daemonLog ? ` — log: ${daemonLog.path}` : '';
  /**
   * A failed start quotes what the daemon said, since it no longer says it
   * here — "recent" output, not "its": sessions in a project share the
   * default log, so a daemon starting alongside this one may have written
   * lines there too.
   */
  const startFailure = (outcome: DaemonStartFailed): Error => {
    const message = daemonStartFailure(
      `Failed to start ${platform ? `an ${platform}` : 'a Tapsmith'} daemon${member ? ` for group member "${member}"` : ''}`,
      {
        ...outcome,
        recentOutput: daemonLog ? readDaemonLogSince(daemonLog) : '',
        logPath: daemonLog?.path,
        hints: daemonLog ? [] : ['Its output was discarded: the daemon log could not be opened.'],
      },
    );
    log(message);
    return new Error(message);
  };
  if (!daemonSpawn.ok) throw startFailure(daemonSpawn);
  const daemonProcess = daemonSpawn.child;
  daemonProcess.unref();
  daemonProcess.on('error', (err) => { log(`Daemon process error: ${err.message}`); });

  // Until it is in `_connections`, only this set lets `closeAllClients` find
  // it: a client that leaves during the seconds a daemon takes to answer would
  // otherwise strand a detached, unregistered daemon that outlives us by
  // design (PILOT-453).
  _startingDaemons.add(daemonProcess);
  try {
    const address = `127.0.0.1:${port}`;
    const client = new TapsmithGrpcClient(address);
    // Ends early when the daemon exits or cannot be spawned, which a gRPC
    // readiness wait cannot see.
    const started = await awaitDaemonStart(daemonProcess, (ms) => client.waitForReady(ms), {
      budgetMs: 10_000,
      address,
    });
    if (!started.ok) {
      client.close();
      daemonProcess.kill();
      if (sessionClosed()) return null;
      throw startFailure(started);
    }

    try {
      const { version } = await client.ping();
      log(`Started daemon v${version} on port ${port} (agent ${agentPort})${platform ? ` [${platform}]` : ''}${logNote}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      client.close();
      daemonProcess.kill();
      if (sessionClosed()) return null;
      throw startFailure({ ok: false, cause: `tapsmith-core started but did not respond: ${msg}`, spawnFailed: false });
    }

    if (sessionClosed()) {
      client.close();
      daemonProcess.kill();
      return null;
    }

    registerDaemon(address, daemonProcess.pid);
    const conn: DaemonConnection = {
      client,
      address,
      devices: [],
      daemonProcess,
      source: 'started',
      platform,
    };
    _connections.push(conn);
    return conn;
  } catch (err) {
    daemonProcess.kill();
    throw err;
  } finally {
    _startingDaemons.delete(daemonProcess);
  }
}

/** Tear down a daemon we started but cannot use, so it does not linger. */
function discardDaemon(conn: DaemonConnection): void {
  // Just `removeConnection`: it unregisters every source that registered, and
  // each extra `unregisterDaemon` is another locked registry write — the lock
  // spins on `Atomics.wait`, so the cost lands on the event loop, on a path
  // that runs whenever a platform fails to provision.
  removeConnection(conn);
}

// ─── Per-platform targets ───

export interface PlatformTarget {
  /** Address of the daemon serving this platform's device. */
  address: string
  deviceSerial: string
  platform?: string
  /**
   * The rest of a `use.devices` group, each on its own daemon, in member
   * order. Absent for single-device targets.
   */
  members?: PlatformTargetMember[]
}

export interface PlatformTargetMember {
  /** Group entry name (`bob`). */
  name: string
  address: string
  deviceSerial: string
}

/**
 * Whether the daemon behind a resolved target is still answering — dropping it
 * from the pool when it is not.
 *
 * A target is resolved once and then handed to every run child, which connects
 * to `address` itself. Nothing revisits that decision, so a daemon that dies
 * mid-session — killed by hand, OOM, a crash — leaves the session pointing at a
 * dead port with no way back short of restarting the server. Callers holding a
 * cached target check here and re-resolve when this comes back false.
 *
 * The pruning is not tidiness. Re-resolving adds a *new* connection beside the
 * dead one, and nothing else would ever remove it: `ensureConnected()` probes
 * only `_connections[0]`. Its stale `preparedDevice` survives every
 * `refreshDeviceIndex`, so the session goes on advertising a device that no
 * longer exists — enough to make every no-argument tool refuse as ambiguous,
 * and `project: "ios"` match two iOS devices, one of them a shut-down
 * simulator.
 */
export async function platformTargetIsLive(target: PlatformTarget): Promise<boolean> {
  const conn = _connections.find((c) => c.address === target.address);
  if (!conn) return false;
  try {
    if (await conn.client.waitForReady(1_000)) return true;
  } catch {
    // Unreachable — treated the same as a failed probe.
  }
  removeConnection(conn);
  return false;
}

/**
 * Resolve a daemon + device + running agent for one project's platform.
 *
 * A multi-platform config has no top-level `platform`, so the session-wide
 * setup could not tell which agent artifacts to use and started none: iOS
 * projects failed with "iOS agent is not configured" no matter how the run was
 * requested. Each project's *effective* config carries its own platform, app
 * and agent paths, so resolve a target per platform from that instead.
 */
export async function ensurePlatformTarget(
  config: TapsmithConfig,
  /** Where the primary's pin came from, for the missing-device message. */
  pinSource: 'config' | 'run_tests' = 'config',
): Promise<PlatformTarget> {
  const group = resolveDeviceGroup(config);
  // An unpinned primary must not take a device a member is pinned to.
  const memberPins = group.slice(1).flatMap((e) => (e.device ? [e.device] : []));
  const primary = await ensurePrimaryTarget(config, pinSource, memberPins);
  if (group.length <= 1) return primary;
  // A `use.devices` project: one more daemon + device per member, each
  // prepared like the primary. Members never share a daemon (a daemon holds
  // one device), and never reuse the primary's device.
  const members: PlatformTargetMember[] = [];
  const taken = [primary.deviceSerial];
  try {
    for (const entry of group.slice(1)) {
      const member = await ensureMemberTarget(config, entry.name, entry.device, taken);
      members.push(member);
      taken.push(member.deviceSerial);
    }
  } catch (err) {
    for (const m of members) {
      const conn = _connections.find((c) => c.address === m.address);
      if (conn) discardDaemon(conn);
    }
    await refreshDeviceIndex();
    throw err;
  }
  return { ...primary, members };
}

/** A daemon + device + agent for one group member beyond the primary. */
async function ensureMemberTarget(
  config: TapsmithConfig,
  name: string,
  wantedSerial: string | undefined,
  exclude: string[],
): Promise<PlatformTargetMember> {
  const platform = config.platform;
  assertNotHeldByUi(wantedSerial, uiHeldDevices(), name);
  assertPinNotClaimed(wantedSerial);
  const conn = await startDaemon(platform, name);
  if (!conn) throw new Error(`The session closed while a daemon for group member "${name}" was starting.`);
  const serial = (await pickDevice(conn, platform, wantedSerial, exclude))?.serial;
  if (!serial) {
    const { serials, all, unusable } = await visibleDevices(conn, platform);
    const visible = serials.filter((s) => !exclude.includes(s));
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw new Error(
      `${noDeviceMessageWithClaims(all, platform, wantedSerial, visible, uiHeldDevices(), 'config', unusable)} (needed for group member "${name}"; `
      + `${exclude.join(', ')} already serve the group's other members)`,
    );
  }
  conn.claimedBy = `${platform ?? 'default'}:${name}`;
  try {
    await prepareTarget(conn, serial, config);
  } catch (err) {
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw err;
  }
  await refreshDeviceIndex();
  return { name, address: conn.address, deviceSerial: serial };
}

async function ensurePrimaryTarget(
  config: TapsmithConfig,
  pinSource: 'config' | 'run_tests' = 'config',
  /** Serials the group's members are pinned to, never auto-picked for the primary. */
  exclude: string[] = [],
): Promise<PlatformTarget> {
  const platform = config.platform;
  const key = platform ?? 'default';
  // The first group member's pin, root `device` included. Reading `config.device`
  // here honoured `bob`'s pin and auto-picked `alice`'s.
  const wanted = primaryDevicePin(config);
  await ensureConnected();
  // After discovery, which learns what UI sessions hold; before this target
  // starts any daemon: a pinned device another session drives is refused
  // outright, not silently taken over.
  assertNotHeldByUi(wanted, uiHeldDevices(), undefined, pinSource);
  assertPinNotClaimed(wanted);

  const existing = await findConnectionForPlatform(platform, key, wanted, exclude);
  if (existing) {
    // Claim it only for as long as the claim holds: a failed prepare would
    // otherwise leave the daemon marked as this platform's forever, so no
    // other platform could take it and this one would start a second daemon
    // on its next attempt.
    const previousClaim = existing.conn.claimedBy;
    const previousPlatform = existing.conn.platform;
    existing.conn.claimedBy = key;
    // A daemon started without `--platform` serves whichever platform claims
    // it, and from here it serves only that one. Recording it is what lets a
    // caller name a device by its project: without it the session knows it
    // drives an emulator but not that the emulator is the android target.
    existing.conn.platform ??= platform;
    try {
      await prepareTarget(existing.conn, existing.serial, config);
    } catch (err) {
      existing.conn.claimedBy = previousClaim;
      existing.conn.platform = previousPlatform;
      throw err;
    }
    return { address: existing.conn.address, deviceSerial: existing.serial, platform };
  }

  // Nothing reusable serves this platform — daemons are per-platform, so start
  // one dedicated to it.
  const conn = await startDaemon(platform);
  if (!conn) throw new Error(`The session closed while a ${platform ?? 'Tapsmith'} daemon was starting.`);

  const serial = (await pickDevice(conn, platform, wanted, exclude))?.serial;
  if (!serial) {
    // Ask what it *could* see before discarding it, so a config pinning a
    // serial that does not exist is not reported as "no device available"
    // while the device the user is looking at sits there booted.
    const { serials: visible, all, unusable } = await visibleDevices(conn, platform);
    // A daemon with no device to drive is dead weight: it would sit in the pool
    // and the shared registry, and a second unsatisfiable platform would start
    // yet another one.
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw new Error(noDeviceMessageWithClaims(all, platform, wanted, visible, uiHeldDevices(), pinSource, unusable));
  }

  conn.claimedBy = key;
  try {
    await prepareTarget(conn, serial, config);
  } catch (err) {
    // Same reasoning as the no-device case above: a daemon we started and
    // could not prepare is dead weight, and leaving it pooled means the next
    // attempt starts another one beside it.
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw err;
  }
  await refreshDeviceIndex();
  return { address: conn.address, deviceSerial: serial, platform };
}

/**
 * Serials the daemon lists for `platform` that no UI session holds — what a
 * failed pick could have chosen — and the attached devices adb cannot use
 * (unauthorized, offline, …), which explain why there is none. Both empty if
 * the daemon cannot be reached.
 */
async function visibleDevices(
  conn: DaemonConnection,
  platform: string | undefined,
): Promise<{ serials: string[]; all: string[]; unusable: DeviceInfoProto[] }> {
  try {
    const { devices, unusableDevices } = await conn.client.listDevices();
    const forPlatform = (list: DeviceInfoProto[]) => (platform ? list.filter((d) => d.platform === platform) : list);
    const all = forPlatform(devices).map((d) => d.serial);
    const held = heldDevices(all);
    return {
      serials: all.filter((serial) => !held.has(serial)),
      all,
      unusable: forPlatform(unusableDevices ?? []),
    };
  } catch {
    return { serials: [], all: [], unusable: [] };
  }
}

/** The devices a running UI session holds — none when this process *is* the UI server, whose devices are its own. */
function uiHeldDevices(): Set<string> {
  return _uiMode ? new Set() : _uiHeld;
}

/**
 * Every device this session must not pick: a running UI session's, and any
 * another live Tapsmith session has claimed (PILOT-381). The UI server's own
 * MCP endpoint is the UI session, so its claims are its own.
 */
function heldDevices(serials: Iterable<string>): Set<string> {
  const held = new Set(uiHeldDevices());
  for (const claim of withoutHeldDevices([...serials], currentSession()).held) held.add(claim.device);
  return held;
}

/**
 * Refuse a pin another live session has claimed, naming it — before a daemon
 * is started for it, and rather than reporting the pin as "not available".
 */
function assertPinNotClaimed(wanted: string | undefined): void {
  if (!wanted) return;
  const [holder] = withoutHeldDevices([wanted], currentSession()).held;
  if (holder) throw new DeviceClaimedError(wanted, holder);
}

/** The no-device message, plus which devices other sessions hold (there may be the missing ones). */
function noDeviceMessageWithClaims(
  candidates: readonly string[],
  ...args: Parameters<typeof noDeviceMessage>
): string {
  return noDeviceMessage(...args) + heldDevicesNote(withoutHeldDevices(candidates, currentSession()).held);
}

/**
 * The refusal for pinning a device a running UI-mode session is driving.
 *
 * Silent takeover was the harm — the pin was honoured and the other session's
 * next action landed on a device with a second agent on it — so an explicit
 * pin of a held device fails loudly here, before any daemon is started.
 *
 * @internal — exported for unit testing.
 */
export function assertNotHeldByUi(
  wanted: string | undefined,
  held: Set<string>,
  memberName?: string,
  /** Where the pin came from — see {@link noDeviceMessage}. */
  source: 'config' | 'run_tests' = 'config',
): void {
  if (!wanted || !held.has(wanted)) return;
  if (source === 'run_tests') {
    throw new Error(
      `Device "${wanted}", requested with \`device\`, is being driven by a running \`tapsmith test --ui\` session. `
      + 'Headless MCP sessions get their own devices, so pass a different one, or connect to that session\'s MCP endpoint instead.',
    );
  }
  const forWhom = memberName ? ` for group member "${memberName}"` : '';
  throw new Error(
    `Device "${wanted}" is pinned${forWhom} in your config, but a running \`tapsmith test --ui\` session is driving it. `
    + 'Headless MCP sessions get their own devices, so pin a different one, or connect to that session\'s MCP endpoint instead.',
  );
}

export function noDeviceMessage(
  platform?: string,
  wanted?: string,
  visible: string[] = [],
  heldByUi: Iterable<string> = [],
  /**
   * Where `wanted` came from: the config, or a `run_tests` call's `device`.
   * The fix differs — edit the config, or pass another device — and telling a
   * caller to edit a config that pins nothing sends them the wrong way.
   */
  source: 'config' | 'run_tests' = 'config',
  /**
   * Attached devices adb cannot use, with their adb state (the daemon's
   * `unusableDevices`): a pin among them is attached, not missing, and any of
   * them is the likeliest reason nothing is available (PILOT-457).
   */
  unusable: readonly AdbStateEntry[] = [],
): string {
  const relevant = platform ? unusable.filter((d) => (d.platform ?? platform) === platform) : unusable;
  // A visible pin was not refused for its adb state (a usable device can
  // share its serial with an unusable one).
  if (wanted && !visible.includes(wanted)) {
    const blocked = pinnedDeviceUnusableMessage(wanted, relevant, 'any');
    if (blocked) return blocked;
  }
  const attached = describeUnusableAndroidDevices(relevant);
  // Also after a missing pin's message: a stale pin of the very phone that is
  // attached but unauthorized is a common way to get here.
  const alsoAttached = attached.length > 0 ? ` ${attached.join(' ')}` : '';
  const what = [platform ? `No ${platform} device is available.` : 'No device is available.', ...attached].join(' ');
  // The devices are there, but a UI session is driving every one of them. Telling
  // the user to boot a simulator beside the one they are looking at would send
  // them the wrong way — say who has the devices instead.
  const held = [...heldByUi];
  if (!wanted && visible.length === 0 && held.length > 0) {
    return `${what} ${held.length === 1 ? 'The only one visible' : 'Every visible device'} (${held.join(', ')}) `
      + 'is being driven by a running `tapsmith test --ui` session. Headless MCP sessions get their own devices: '
      + 'start another device, or connect to that session\'s MCP endpoint instead.';
  }
  // A pinned serial that does not exist is a different problem with a
  // different fix, and telling the user to boot a simulator when one is
  // already booted sends them looking in the wrong place entirely.
  if (wanted && visible.length > 0 && source === 'run_tests') {
    return `Device "${wanted}" is not available. `
      + `${platform ? `Visible ${platform} devices` : 'Visible devices'}: ${visible.join(', ')}. `
      + 'Pass one of those as `device`, or start that device.' + alsoAttached;
  }
  if (wanted && source === 'run_tests') {
    return `Device "${wanted}" is not available, and no other ${platform ?? 'device'} was found. Start it, or pass another \`device\`.${alsoAttached}`;
  }
  if (wanted && visible.length > 0) {
    return `Device "${wanted}" from your config is not available. `
      + `${platform ? `Visible ${platform} devices` : 'Visible devices'}: ${visible.join(', ')}. `
      + 'Update `device` in your config, or start that device.'
      // A top-level `device` is inherited by every project that does not
      // override it, so one pinned for the Android emulator is also asked of
      // the iOS target — which reports a booted simulator as "not available"
      // and sends the user looking for a device problem they do not have.
      + (platform
        ? ` If "${wanted}" belongs to another platform, set \`device\` inside the `
          + 'relevant project\'s `use` rather than at the top level, where every '
          + 'project inherits it.'
        : '')
      + alsoAttached;
  }
  if (wanted) {
    return `Device "${wanted}" from your config is not available, and no other `
      + `${platform ?? 'device'} was found. Start it, or update \`device\` in your config.${alsoAttached}`;
  }
  if (platform === 'android') return `${what} Start an emulator (or connect a device) and try again.`;
  if (platform === 'ios') return `${what} Boot a simulator (or connect a device) and try again.`;
  return `${what} Connect a device or start an emulator and try again.`;
}

/**
 * A pooled daemon this platform may take over, if any.
 *
 * Two things make a daemon unusable even when it can see a matching device:
 *
 * - It belongs to a live UI-mode run. Claiming it means `setDevice`-ing it out
 *   from under that run, whose next action then lands on the wrong device.
 * - Another platform already claimed it. A daemon started without `--platform`
 *   lists both Android and iOS devices, so a multi-platform session would find
 *   the same daemon twice; the second claim repoints it away from the first
 *   platform's device, and `startAgentFromConfig` skips the agent because the
 *   daemon already reports one connected (the first platform's).
 * - It belongs to a live peer MCP session and is already pointed somewhere
 *   else. The registry lists a peer's daemon precisely because that session is
 *   still running, so the UI-mode reasoning applies unchanged: repointing it
 *   sends the peer's next tap to our device. Adopting it is only safe when it
 *   already serves the device we want — the case reuse exists for — or when it
 *   has no active device yet.
 */
async function findConnectionForPlatform(
  platform: string | undefined,
  key: string,
  wantedSerial: string | undefined,
  exclude: string[] = [],
): Promise<{ conn: DaemonConnection; serial: string } | null> {
  for (const conn of _connections) {
    if (conn.source === 'ui') continue;
    if (conn.claimedBy && conn.claimedBy !== key) continue;
    // A daemon started for another platform cannot serve this one.
    if (conn.platform && platform && conn.platform !== platform) continue;
    const choice = await pickDevice(conn, platform, wantedSerial, exclude);
    if (!choice) continue;
    if (conn.source === 'peer' && isRepointing(choice.activeSerial, choice.serial)) continue;
    // A daemon this session did not start, pointed at another platform's
    // device, is not moved across (PILOT-564): whoever pointed it there is
    // likely still driving it. A multi-platform config keeps such a daemon at
    // discovery for the platform it serves; this one starts its own.
    // A project that names no platform runs on Android. Nor is another
    // platform's device taken on it: a project that names none picks from
    // every device the daemon lists, the one it is driving first.
    if (conn.source !== 'started') {
      const effective = platform ?? 'android';
      if (crossesPlatform(choice, effective)) continue;
      if (choice.platform && choice.platform !== effective) continue;
    }
    if (!takesClaimedDaemon(conn, choice.serial)) continue;
    return { conn, serial: choice.serial };
  }
  return null;
}

/**
 * Whether a target may take this daemon for `serial`. Targets on one platform
 * claim under the platform key, so a second target (a solo project beside a
 * group, two differently pinned projects) was handed a daemon the first had
 * already prepared — and repointed it to its own device under the first
 * target, whose runs and tools then acted on the wrong device. Sharing the
 * device it already serves is the shared-device model; moving it is not. A
 * daemon whose agent failed serves nothing and may be taken.
 *
 * @internal — exported for unit testing.
 */
export function takesClaimedDaemon(
  conn: Pick<DaemonConnection, 'claimedBy' | 'preparedDevice' | 'agentFailed'>,
  serial: string,
): boolean {
  if (!conn.claimedBy || !conn.preparedDevice || conn.agentFailed) return true;
  return conn.preparedDevice === serial;
}

interface DeviceChoice {
  /** The device this daemon would serve for us. */
  serial: string
  /** The device it is pointed at now, whoever pointed it there. */
  activeSerial?: string
  /** That device's platform, when the daemon reports one. */
  activePlatform?: string
  /** The platform of `serial`, when the daemon reports one. */
  platform?: string
}

/**
 * Whether taking `choice` moves its daemon off a device of a platform other
 * than `platform`.
 *
 * @internal — exported for unit testing.
 */
export function crossesPlatform(choice: DeviceChoice, platform: string | undefined): boolean {
  if (!platform || !choice.activePlatform || choice.activePlatform === platform) return false;
  return isRepointing(choice.activeSerial, choice.serial);
}

/**
 * Whether taking `serial` on a daemon currently pointed at `currentDevice`
 * moves it off another device.
 *
 * Both places that need this answer get it wrong on their own. A daemon whose
 * current device is unknown must be treated as *not* being moved: forcing an
 * agent restart on one that already serves this device tears down a working
 * agent, possibly mid-run.
 */
export function isRepointing(currentDevice: string | undefined, serial: string): boolean {
  return currentDevice !== undefined && currentDevice !== serial;
}

async function pickDevice(
  conn: DaemonConnection,
  platform: string | undefined,
  wantedSerial: string | undefined,
  exclude: string[] = [],
): Promise<DeviceChoice | undefined> {
  let devices: DeviceInfoProto[];
  try {
    ({ devices } = await conn.client.listDevices());
  } catch {
    return undefined;
  }
  return chooseDevice(devices, { platform, wantedSerial, exclude, heldByUi: heldDevices(devices.map((d) => d.serial)) });
}

/**
 * The device a daemon listing `devices` should serve.
 *
 * A wanted serial is taken only if the daemon lists it; otherwise the pick is
 * the active/online device, then a discovered one, then anything. `exclude`
 * holds the serials already serving this group's other members, and
 * `heldByUi` the devices a running UI-mode session drives — neither is picked,
 * and a wanted serial in either is not honoured (the caller reports the held
 * case with a message naming the UI session; see {@link assertNotHeldByUi}).
 *
 * @internal — exported for unit testing.
 */
export function chooseDevice(
  devices: DeviceInfoProto[],
  opts: { platform?: string; wantedSerial?: string; exclude?: string[]; heldByUi?: Set<string> },
): DeviceChoice | undefined {
  const { platform, wantedSerial, exclude = [], heldByUi = new Set<string>() } = opts;
  const activeSerial = activeDeviceOf(devices);
  const activePlatform = devices.find((d) => d.serial === activeSerial)?.platform || undefined;
  const candidates = (platform ? devices.filter((d) => d.platform === platform) : devices)
    .filter((d) => !exclude.includes(d.serial) && !heldByUi.has(d.serial));
  const serial = wantedSerial
    ? candidates.find((d) => d.serial === wantedSerial)?.serial
    : (
        candidates.find((d) => d.state === 'Active' || d.state === 'online')
        ?? candidates.find((d) => d.state === 'Discovered')
        ?? candidates[0]
      )?.serial;
  const chosenPlatform = devices.find((d) => d.serial === serial)?.platform || undefined;
  return serial ? { serial, activeSerial, activePlatform, platform: chosenPlatform } : undefined;
}

/**
 * The device a daemon is pointed at, as the daemon itself reports it.
 *
 * `set_device` marks its target `Active` and demotes the previous one, so this
 * is the one piece of daemon state that survives across processes — unlike
 * `preparedDevice`, which only records what *this* process did.
 */
function activeDeviceOf(devices: DeviceInfoProto[]): string | undefined {
  return devices.find((d) => d.state === 'Active')?.serial;
}

/** {@link activeDeviceOf} for a connection; undefined if the daemon can't be reached. */
async function currentDevice(conn: DaemonConnection): Promise<string | undefined> {
  try {
    const { devices } = await conn.client.listDevices();
    return activeDeviceOf(devices);
  } catch {
    return undefined;
  }
}

/** Point a daemon at a device and make sure its agent is running. */
async function prepareTarget(
  conn: DaemonConnection,
  serial: string,
  config: TapsmithConfig | null,
): Promise<void> {
  // Ask the daemon where it is pointed *before* moving it. `agentConnected` is
  // daemon-global and `set_device` does not disconnect the agent, so a daemon
  // repointed to a different device still reports one as connected — the
  // platform's real agent would never start and the session would drive the
  // previous device's agent. Force a start exactly when the device changed.
  //
  // The daemon's own `Active` device, not `preparedDevice`: the latter records
  // only what this process did, so an adopted 'peer' or 'configured' daemon
  // already serving another device looks untouched and the force is skipped.
  // Fall back to `preparedDevice` when the daemon can't be reached — forcing on
  // a daemon that already serves this device would tear down a working agent,
  // including one a peer session is mid-run against.
  const wasPointedAt = await currentDevice(conn) ?? conn.preparedDevice;
  // Never move a daemon another live session is driving its device through,
  // nor take a device another session holds (PILOT-381).
  const daemonHolder = await daemonDriverElsewhere(conn.address, async () => wasPointedAt, currentSession());
  if (daemonHolder) throw new DaemonClaimedError(conn.address, daemonHolder);
  claimDeviceOrThrow(serial, currentSession(), { daemonAddress: conn.address });
  // A target that does not come up gives its device back: an MCP server
  // lives for hours, and other sessions would otherwise be refused a device
  // it is not driving. Not when this daemon already served the device before
  // this call (an agent restart that failed): the session still routes tools
  // to it and will prepare it again, so it stays the session's.
  const alreadyServed = conn.preparedDevice === serial || conn.claimedDevice === serial;
  const releaseOnFailure = (): void => {
    if (!alreadyServed) giveBack(serial, conn);
  };
  try {
    await setDeviceExplained(conn.client, serial);
  } catch (err) {
    releaseOnFailure();
    throw err;
  }
  const repointed = isRepointing(wasPointedAt, serial);
  // Moved off a device this session had pointed it at: give that one back,
  // unless another of its daemons still serves it (PILOT-381).
  const previous = conn.preparedDevice ?? conn.claimedDevice;
  if (repointed && previous && previous !== serial) {
    conn.claimedDevice = undefined;
    giveBack(previous, conn);
  }
  // Record the move before starting the agent: `setDevice` has already
  // happened, so if the agent start throws, the next claim must still see this
  // daemon as pointed here rather than assume it never moved.
  conn.preparedDevice = serial;
  try {
    await startAgentFromConfig(conn.client, config, { force: repointed, required: true, serial });
    conn.agentFailed = false;
  } catch (err) {
    // Deliberately *not* rolling `preparedDevice` back: `set_device` already
    // happened, and a later claim that assumed the daemon never moved would
    // skip the forced agent start it needs. Recording the failure instead
    // keeps both facts, so a broken target is not counted as a device the
    // session drives.
    conn.agentFailed = true;
    releaseOnFailure();
    throw err;
  }
  // The daemon that was prepared for a serial is the one that serves it, even
  // when another daemon can merely see it.
  _deviceIndex.set(serial, conn);
}

export interface UiDaemonRecord {
  address: string
  deviceSerial?: string
  platform?: string
}

interface UiDiscoveryResult {
  /**
   * Whether the UI server answered. An empty `daemons` list means "no workers"
   * only when it did — otherwise it means "no UI server here", and the two must
   * not be confused: one is grounds for dropping worker connections, the other
   * would drop every one of them on a single timed-out poll.
   */
  reachable: boolean
  daemons: UiDaemonRecord[]
  deviceSerials: Set<string>
  /** Every address the UI session drives, including its primary daemon. */
  owned: string[]
  /**
   * Every device the UI session holds — its whole provisioned set, so the
   * primary counts before its worker has spawned and group members count
   * alongside it. Falls back to the worker daemons' serials for a UI server
   * that predates the field.
   */
  heldDevices: string[]
}

const EMPTY_DISCOVERY: UiDiscoveryResult = { reachable: false, daemons: [], deviceSerials: new Set(), owned: [], heldDevices: [] };

/**
 * Addresses a running UI session is using, so a headless one can stay off them.
 *
 * Not the same question as `discoverFromUiServer`, and asked even in headless
 * mode. A UI run's *primary* daemon sits at the default `daemonAddress`, which
 * every headless session probes and classifies `configured` — a source `isOurs`
 * lets it repoint and start its own agent on, so the `ui` and `peer` guards
 * never come near it. Measured: a headless iOS session beside a UI Android run
 * claimed that daemon and pointed it at a simulator.
 *
 * @internal — exported for unit testing.
 */
export function normalizeDaemonAddress(address: string): string {
  // Split on the *last* colon: the port is what follows it, and an IPv6 host
  // is full of the things. Brackets come off with it.
  const separator = address.lastIndexOf(':');
  if (separator < 0) return address;
  const host = address.slice(0, separator).replace(/^\[|\]$/g, '');
  const port = address.slice(separator + 1);
  const loopback = host === 'localhost' || host === '::1' || host === '' ? '127.0.0.1' : host;
  return `${loopback}:${port}`;
}

/**
 * What every running UI session on this machine holds: the daemon addresses a
 * headless session must not adopt, and the device serials it must not pick.
 *
 * @internal — exported for unit testing.
 */
export async function uiSessionHoldings(): Promise<{ addresses: Set<string>; devices: Set<string> }> {
  const files = allUiPortFiles();
  const addresses = new Set<string>();
  const devices = new Set<string>();
  if (files.length === 0) return { addresses, devices };
  const perServer = await Promise.all(files.map((f) => queryUiServerAt(f)));
  for (const result of perServer) {
    for (const address of result.owned) addresses.add(normalizeDaemonAddress(address));
    for (const serial of result.heldDevices) devices.add(serial);
  }
  return { addresses, devices };
}

async function discoverFromUiServer(): Promise<UiDiscoveryResult> {
  // A headless session does not attach to a UI run's workers. Sharing them made
  // it inherit that session's devices — so a headless `tap` beside a two-worker
  // UI run refused as ambiguous over devices belonging to someone else's run,
  // and a UI worker retiring changed what the headless session thought it had.
  if (!_uiMode) return EMPTY_DISCOVERY;
  if (_uiDaemonPorts) {
    try {
      return parseUiDaemonPorts(_uiDaemonPorts());
    } catch (err) {
      // This server answering for itself cannot be "unreachable": treat a
      // failure as owning nothing, so the endpoint starts its own daemon
      // rather than falling back to whatever answers on the configured port.
      log(`UI server discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ...EMPTY_DISCOVERY, reachable: true };
    }
  }
  return queryUiServer();
}

/** What a UI server publishes at `/api/daemon-ports`. */
export interface UiDaemonPorts {
  daemons?: UiDaemonRecord[]
  owned?: string[]
  devices?: string[]
}

function parseUiDaemonPorts(data: UiDaemonPorts): UiDiscoveryResult {
  if (!Array.isArray(data.daemons)) return EMPTY_DISCOVERY;
  const daemons = data.daemons.filter((d) => Boolean(d.address));
  const workerSerials = daemons.map(d => d.deviceSerial).filter(Boolean) as string[];
  return {
    reachable: true,
    daemons,
    deviceSerials: new Set(workerSerials),
    owned: Array.isArray(data.owned) ? data.owned.filter((a) => typeof a === 'string') : daemons.map((d) => d.address),
    heldDevices: Array.isArray(data.devices) ? data.devices.filter((s) => typeof s === 'string') : workerSerials,
  };
}

function queryUiServer(): Promise<UiDiscoveryResult> {
  return queryUiServerAt(uiPortFilePath());
}

async function queryUiServerAt(portFile: string): Promise<UiDiscoveryResult> {
  let portFileContent: string;
  try {
    portFileContent = (await fs.promises.readFile(portFile, 'utf-8')).trim();
  } catch {
    return EMPTY_DISCOVERY;
  }
  const uiMcpPort = Number.parseInt(portFileContent, 10);
  if (!Number.isFinite(uiMcpPort) || uiMcpPort <= 0) return EMPTY_DISCOVERY;

  try {
    const json = await httpGet(`http://127.0.0.1:${uiMcpPort}/api/daemon-ports`, 2_000);
    // The UI server publishes each worker's platform alongside its address. We
    // used to drop it, which left UI-mode sessions unable to answer "which
    // device does the ios project run on?" — the one question routing a device
    // tool by project needs. Headless knows it from `conn.platform`; this is
    // the same fact from the other transport.
    return parseUiDaemonPorts(JSON.parse(json) as UiDaemonPorts);
  } catch (err) {
    log(`UI server discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_DISCOVERY;
  }
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Daemon Registry ───

/**
 * Which daemons the MCP sessions of this project are using.
 *
 * Each record is one session's *use* of one daemon, so a daemon is only torn
 * down when the last session using it goes away. Recording only the starter
 * would let its shutdown kill a daemon a peer had adopted, and that peer
 * cannot recover — its resolved targets are cached from init and would keep
 * pointing at a dead address.
 *
 * Best-effort throughout: a missing, unreadable or malformed registry just
 * means we start our own daemon, which is what happened before it existed.
 * Liveness is never trusted from the file — every address is probed like any
 * other candidate.
 */
interface DaemonRegistryEntry {
  address: string
  /** Session holding this daemon open. Entries of dead pids are pruned. */
  pid: number
  /**
   * The daemon process itself, recorded by whichever session started it.
   * A session that merely adopted the address has no child handle, so without
   * this the last session out could not shut the daemon down and it would
   * outlive every user with no one left to reap it.
   */
  daemonPid?: number
}

/**
 * Only loopback addresses are accepted from the registry.
 *
 * Unlike every other candidate source — an env var, the user's own config, a
 * port file this process wrote — the registry lives at a path derived solely
 * from the project directory, in a shared temp directory. On a multi-user host
 * anyone can plant one, and an accepted address receives the session's
 * screenshots and UI trees and decides what it believes the device shows.
 */
function isLoopbackAddress(address: string): boolean {
  const match = /^(.+):(\d+)$/.exec(address);
  if (!match) return false;
  const [, host, port] = match;
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * The registry file, once its directory is known to be private to this user.
 *
 * `mkdirSync(..., { mode })` applies the mode only when it creates the
 * directory, so a pre-existing one is used with whatever permissions it
 * already has — and the name is only `tapsmith-<uid>`, which anyone on a
 * shared host can create first in a sticky temp dir. Loosen permissions we
 * own back to 0700; refuse the registry outright when it belongs to someone
 * else, since planting entries there is exactly the redirect the loopback
 * filter cannot catch. Returns null when the registry cannot be trusted, in
 * which case sessions simply stop sharing daemons.
 */
function privateRegistryFile(): string | null {
  const file = mcpDaemonRegistryPath();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    if (stat.mode & 0o077) fs.chmodSync(dir, 0o700);
    return file;
  } catch {
    return null;
  }
}

function readRegistryEntries(): DaemonRegistryEntry[] {
  const file = privateRegistryFile();
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): DaemonRegistryEntry[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { address, pid, daemonPid } = entry as Partial<DaemonRegistryEntry>;
    if (typeof address !== 'string' || !isLoopbackAddress(address)) return [];
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return [];
    const validDaemonPid = typeof daemonPid === 'number' && Number.isInteger(daemonPid) && daemonPid > 0
      ? daemonPid
      : undefined;
    return [{ address, pid, daemonPid: validDaemonPid }];
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read, transform and write the registry under an exclusive lock.
 *
 * Read-modify-write over a shared file is a lost-update race: two sessions
 * registering at the same moment each overwrite the other's entry, and the
 * next session then starts a third daemon on the same device — the pile-up
 * the registry exists to prevent.
 */
/**
 * Collapse duplicate rows for one session and address, keeping the daemon pid.
 *
 * Last-write-wins would let a later pid-less row — a peer adoption after a
 * re-`discover()`, say — overwrite the row that recorded which process to
 * reap, leaving the daemon unreapable.
 */
function mergeByAddressAndPid(entries: DaemonRegistryEntry[]): Map<string, DaemonRegistryEntry> {
  const merged = new Map<string, DaemonRegistryEntry>();
  for (const entry of entries) {
    const key = `${entry.address}::${entry.pid}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, ...entry, daemonPid: entry.daemonPid ?? existing.daemonPid } : entry);
  }
  return merged;
}

/**
 * Give every session holding an address the daemon pid recorded for it.
 *
 * Only the session that *started* a daemon knows its pid; a peer adopts the
 * address alone. That pid then lived on exactly one row, which disappears as
 * soon as the starter exits or is killed — after which the remaining sessions
 * have no way to reap the daemon, and it holds the device forever. Copying it
 * to every row for the address means any survivor can finish the job.
 */
function shareDaemonPids(entries: DaemonRegistryEntry[]): DaemonRegistryEntry[] {
  const known = new Map<string, number>();
  for (const entry of entries) {
    if (entry.daemonPid) known.set(entry.address, entry.daemonPid);
  }
  return entries.map((entry) => (
    entry.daemonPid ? entry : { ...entry, daemonPid: known.get(entry.address) }
  ));
}

function updateRegistry(
  transform: (entries: DaemonRegistryEntry[]) => DaemonRegistryEntry[],
): void {
  const file = privateRegistryFile();
  if (!file) return;
  try {
    // `wx`, not exists-then-write: two sessions starting together both see it
    // missing, and the loser's `[]` lands on top of the winner's entry while
    // the winner holds the lock — so neither can see the other's daemon and
    // both start one, which is the pile-up this file exists to prevent.
    try {
      fs.writeFileSync(file, '[]', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const { locked } = withFileLockSync(file, () => {
      // Share before transforming as well as after: the row being removed here
      // is often the only one carrying the daemon pid, and the same is true of
      // a row about to be dropped for a dead session.
      const current = shareDaemonPids(readRegistryEntries());
      const next = transform(current).filter(entryIsLive);
      const deduped = shareDaemonPids([...mergeByAddressAndPid(next).values()]);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(deduped), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, file);
    });
    // A dropped write is not fatal, but it is worth saying: the session then
    // holds a daemon no peer knows about, and whoever started it may reap it
    // mid-session believing nobody else is attached.
    if (!locked) log(`Warning: could not lock the daemon registry at ${file}; this session's daemon record was not written`);
  } catch {
    // The registry is an optimisation; never fail a session over it.
  }
}

/**
 * Whether a registry row still describes something real.
 *
 * A row outlives its session when the daemon that session started is still
 * running. That row is the only record of the daemon's pid, so dropping it
 * strands the process: no later session can find it to reuse, and none can
 * find it to reap. Sessions killed with SIGKILL never reach `closeAllClients`,
 * which makes this the ordinary way daemons leak rather than an edge case.
 *
 * Checked in that order because `isTapsmithDaemonProcess` shells out to `ps` —
 * a live session is the common row and answers for free.
 */
function entryIsLive(entry: DaemonRegistryEntry): boolean {
  if (isProcessAlive(entry.pid)) return true;
  return Boolean(entry.daemonPid && isTapsmithDaemonProcess(entry.daemonPid));
}

/**
 * Daemons this project's MCP sessions are using, and whether each still has an
 * owner.
 *
 * `orphaned` is what separates "another session is driving this" from "the
 * session that started this is gone". The second is ours to repoint, to start
 * an agent on, and eventually to reap; treating it as a peer would leave it
 * running untouched forever.
 *
 * @internal — exported for unit testing.
 */
export function readDaemonRegistry(): Array<{ address: string; orphaned: boolean }> {
  const byAddress = new Map<string, boolean>();
  for (const entry of readRegistryEntries()) {
    if (!entryIsLive(entry)) continue;
    const orphaned = !isProcessAlive(entry.pid);
    // Any live owner wins: one dead session's row must not mark an address
    // orphaned while another session is still using the same daemon.
    byAddress.set(entry.address, (byAddress.get(entry.address) ?? true) && orphaned);
  }
  return [...byAddress].map(([address, orphaned]) => ({ address, orphaned }));
}

/**
 * Whether this server shares daemons through the registry at all.
 *
 * The UI server's daemons are its workers', and a headless session's are its
 * own — neither should end up in the other's pool. So the UI server neither
 * reads the registry nor writes to it, and never becomes a registered user
 * keeping some other session's daemon alive.
 */
function usesDaemonRegistry(): boolean {
  return !_uiMode;
}

/** Record that this session is using a daemon. @internal — exported for unit testing. */
export function registerDaemon(address: string, daemonPid?: number): void {
  if (!usesDaemonRegistry()) return;
  if (!isLoopbackAddress(address)) return;
  updateRegistry((entries) => [...entries, { address, pid: process.pid, daemonPid }]);
}

/** The daemon process behind an address, if its starter recorded one. */
function registeredDaemonPid(address: string): number | undefined {
  return readRegistryEntries().find((e) => e.address === address && e.daemonPid)?.daemonPid;
}

/**
 * Whether a pid is a Tapsmith daemon, checked before signalling a process we
 * did not spawn — pids are reused, and a registry entry may be stale.
 */
function isTapsmithDaemonProcess(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' })
      .includes('tapsmith-core');
  } catch {
    return false;
  }
}

/** Drop this session's use of a daemon. @internal — exported for unit testing. */
export function unregisterDaemon(address: string): void {
  if (!usesDaemonRegistry()) return;
  updateRegistry((entries) => entries.filter((e) => !(e.address === address && e.pid === process.pid)));
}

/**
 * Whether any other live session is still using a daemon — i.e. whether
 * killing it on our way out would pull it from under them.
 */
function daemonInUseByOthers(address: string): boolean {
  return readRegistryEntries().some(
    (e) => e.address === address && e.pid !== process.pid && isProcessAlive(e.pid),
  );
}

/**
 * Drop *our own* records for addresses that failed to answer a probe.
 *
 * Only ours: another session's entry may be for a daemon it can still reach
 * (a different network view, or a daemon started microseconds ago), and
 * deleting it would make its owner invisible to everyone else.
 *
 * @internal — exported for unit testing.
 */
export function pruneDaemonRegistry(liveAddresses: string[]): void {
  if (!usesDaemonRegistry()) return;
  const live = new Set(liveAddresses);
  // A daemon whose process is still running has not gone away — a 1s probe can
  // time out under load or a GC pause. Dropping the row on that evidence loses
  // the recorded pid, and an adopted daemon then has nothing left to reap it.
  const gone = (entry: DaemonRegistryEntry): boolean =>
    !live.has(entry.address) && !(entry.daemonPid && isTapsmithDaemonProcess(entry.daemonPid));
  const entries = readRegistryEntries();
  const stale = entries.some((e) => e.pid === process.pid && gone(e));
  if (!stale) return;
  updateRegistry((current) => current.filter((e) => e.pid !== process.pid || !gone(e)));
}

// ─── Device Index ───

async function refreshDeviceIndex(): Promise<void> {
  const results = await Promise.all(_connections.map(async (conn) => {
    try {
      const { devices } = await conn.client.listDevices();
      return { conn, devices };
    } catch {
      return { conn, devices: [] as DeviceInfoProto[] };
    }
  }));
  _deviceIndex.clear();
  // Prepared bindings first. A platform-less daemon enumerates every device,
  // including ones a *second* daemon was started to drive, so first-seen-wins
  // would route an iOS tap to the daemon holding the Android emulator.
  for (const { conn } of results) {
    if (conn.preparedDevice) _deviceIndex.set(conn.preparedDevice, conn);
  }
  for (const { conn, devices } of results) {
    conn.devices = devices.map(d => d.serial);
    conn.activeDevice = activeDeviceOf(devices);
    for (const d of devices) {
      if (!_deviceIndex.has(d.serial)) {
        _deviceIndex.set(d.serial, conn);
      } else if (_deviceIndex.get(d.serial) !== conn) {
        log(`Device ${d.serial} visible from multiple daemons — using ${_deviceIndex.get(d.serial)!.address}`);
      }
    }
  }
}

function removeConnection(conn: DaemonConnection): void {
  conn.client.close();
  // Dropping an unresponsive daemon is not licence to kill one other sessions
  // are still registered against — a failed readiness probe here can be a
  // transient stall, and they may well still be talking to it. Only the
  // sources that ever registered pay for the locked registry write: this runs
  // from `ensureConnected` whenever a 1s probe fails, and the lock blocks the
  // event loop while it waits.
  let stopped = false;
  if (isRegistered(conn.source)) {
    unregisterDaemon(conn.address);
    if (conn.daemonProcess && !daemonInUseByOthers(conn.address)) {
      conn.daemonProcess.kill();
      stopped = true;
    }
  } else if (conn.daemonProcess) {
    conn.daemonProcess.kill();
    stopped = true;
  }
  _connections = _connections.filter(c => c !== conn);
  for (const [serial, c] of _deviceIndex) {
    if (c === conn) _deviceIndex.delete(serial);
  }
  // A daemon this session stopped no longer drives the device it prepared
  // (PILOT-381): give the claim back unless another of its daemons serves it.
  // Not one left running — dropped after a 1 s stall, it is still pointed at
  // the device and the session may well go on driving it once it answers; nor
  // a UI worker's, whose device is the UI session's.
  if (stopped && conn.source !== 'ui') {
    for (const device of new Set([conn.preparedDevice, conn.claimedDevice])) {
      if (device && !_connections.some((c) => c.preparedDevice === device || c.claimedDevice === device)) {
        giveBack(device);
      }
    }
  }
}

// ─── Device & Agent Setup ───

/** Points the daemon at a device and starts its agent; returns that device. */
async function setDeviceAndAgent(
  client: TapsmithGrpcClient,
  address: string,
  config: TapsmithConfig | null,
): Promise<string | undefined> {
  let serial: string | undefined;

  const pinned = config ? primaryDevicePin(config) : undefined;
  assertNotHeldByUi(pinned, uiHeldDevices());
  if (pinned) {
    serial = pinned;
  } else {
    const { devices } = await client.listDevices();
    const held = heldDevices(devices.map((d) => d.serial));
    const free = devices.filter((d) => !held.has(d.serial));
    const best = free.find(d => d.state === 'Active' || d.state === 'online')
      ?? free.find(d => d.state === 'Discovered');
    serial = best?.serial;
  }

  if (!serial) {
    log('No devices found — device tools will fail until one is connected');
    return undefined;
  }

  claimDeviceOrThrow(serial, currentSession(), { daemonAddress: address });
  try {
    await setDeviceExplained(client, serial);
    log(`Using device: ${serial}`);
    await startAgentFromConfig(client, config, { serial });
  } catch (err) {
    // The caller drops this daemon: give back the device it never drove.
    giveBack(serial);
    throw err;
  }
  return serial;
}

/**
 * Start the device agent described by `config`.
 *
 * `force` re-starts one the daemon already reports as connected; `required`
 * makes a failure the caller's problem instead of a log line. Discovery starts
 * agents opportunistically and must survive a failure — but a platform target
 * that cannot start its agent is not a working target, and reporting it as one
 * gives the session a device whose every run fails.
 */
async function startAgentFromConfig(
  client: TapsmithGrpcClient,
  config: TapsmithConfig | null,
  options?: { force?: boolean; required?: boolean; serial?: string },
): Promise<void> {
  if (!options?.force) {
    const { agentConnected } = await client.ping();
    if (agentConnected) return;
  }

  const rootDir = config?.rootDir ?? process.cwd();
  const agentApk = config?.agentApk ? path.resolve(rootDir, config.agentApk) : undefined;
  const agentTestApk = config?.agentTestApk ? path.resolve(rootDir, config.agentTestApk) : undefined;

  let iosXctestrun: string | undefined;
  if (config?.platform === 'ios') {
    try {
      iosXctestrun = await iosXctestrunForAgentStart(config, options?.serial);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Warning: no iOS agent to start (${msg}). Device tools may not work.`);
      if (options?.required) throw new Error(`Failed to start the agent on this device: ${msg}`);
      return;
    }
  }

  try {
    log('Starting agent on device...');
    await client.startAgent(
      config?.package ?? '',
      agentApk,
      agentTestApk,
      iosXctestrun,
    );
    log('Agent started');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Warning: agent start failed (${msg}). Device tools may not work.`);
    if (options?.required) throw new Error(`Failed to start the agent on this device: ${msg}`);
  }
}

/**
 * The xctestrun this session hands the daemon when it starts an iOS agent
 * itself (its `run_tests` children adopt that agent). A hand-set path
 * (`iosXctestrun` / `TAPSMITH_IOS_XCTESTRUN`) or a physical device resolves
 * exactly like every test run path (`resolveAgentArtifacts`): a missing
 * hand-set file is refused, and a physical device gets the device build — a
 * checkout's or the npm install's — instead of a simulator one (PILOT-264).
 * A simulator with nothing set keeps the plain lookup: the shared path would
 * build the simulator agent on demand, which logs to stdout (the stdio MCP
 * protocol channel) and holds the tool call for the whole xcodebuild.
 */
export async function iosXctestrunForAgentStart(
  config: TapsmithConfig,
  serial: string | undefined,
): Promise<string | undefined> {
  const handSet = config.iosXctestrun || process.env.TAPSMITH_IOS_XCTESTRUN;
  if (serial) {
    const { isPhysicalDevice } = await import('../ios-devicectl.js');
    if (handSet || isPhysicalDevice(serial)) {
      const { resolveAgentArtifacts } = await import('../device-session.js');
      const artifacts = await resolveAgentArtifacts(config, serial, undefined, { requireXctestrun: true });
      return artifacts.iosXctestrunPath;
    }
  }
  // No device known (recovering an orphaned daemon's agent), or a simulator.
  if (config.iosXctestrun) return path.resolve(config.rootDir, config.iosXctestrun);
  if (process.env.TAPSMITH_IOS_XCTESTRUN) return process.env.TAPSMITH_IOS_XCTESTRUN;
  try {
    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    return findSimulatorXctestrun();
  } catch {
    return undefined; // not on macOS, or nothing built
  }
}

// ─── Utilities ───

function log(msg: string): void {
  process.stderr.write(`[tapsmith-mcp] ${msg}\n`);
}

export function closeAllClients(): void {
  _sessionGeneration++;
  // Never registered, so no peer can be using one: always ours to stop.
  for (const starting of _startingDaemons) {
    try { starting.kill(); } catch { /* already gone */ }
  }
  _startingDaemons.clear();
  for (const conn of _connections) {
    conn.client.close();
    // Drop our claim first, then keep the daemon alive if a peer session still
    // holds one: it adopted this address from the registry and has no process
    // of its own to fall back on.
    if (!isRegistered(conn.source)) continue;
    // Read the daemon's pid before dropping our record: an adopted daemon has
    // no child handle here, and we may be the last session able to reap it.
    const daemonPid = conn.daemonProcess?.pid ?? registeredDaemonPid(conn.address);
    unregisterDaemon(conn.address);
    if (daemonInUseByOthers(conn.address)) {
      log(`Leaving daemon at ${conn.address} running — another session is still using it`);
      continue;
    }
    if (conn.daemonProcess) {
      conn.daemonProcess.kill();
    } else if (daemonPid && isTapsmithDaemonProcess(daemonPid)) {
      try { process.kill(daemonPid); } catch { /* already gone */ }
    }
  }
  _connections = [];
  _deviceIndex = new Map();
  _discoveredConfig = null;
  _uiOwned = new Set();
  _issuedPorts.clear();
  _sessionDevices = null;
  _ready = false;
  _connectingPromise = null;
  _configFile = undefined;
}

/**
 * `setDevice`, except that the daemon's "not found" for a phone devicectl
 * only remembers is thrown as the not-connected error (PILOT-386). Any other
 * refusal (`success: false`) is left as before: not thrown here.
 * Exported for tests.
 */
export async function setDeviceExplained(client: TapsmithGrpcClient, serial: string): Promise<void> {
  const res = await client.setDevice(serial);
  if (res?.success !== false) return;
  const { explainDeviceNotFound } = await import('../ios-devicectl.js');
  const refusal = new Error(res.errorMessage);
  const explained = await explainDeviceNotFound(serial, refusal);
  if (explained !== refusal) throw explained;
}
