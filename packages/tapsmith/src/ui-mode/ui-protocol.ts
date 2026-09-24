/**
 * WebSocket protocol for UI mode.
 *
 * Defines all message types exchanged between the UI server and the
 * browser-based Preact SPA. JSON messages use a `type` discriminator;
 * binary WebSocket frames carry device screenshots.
 *
 * @see PILOT-87
 */

import type { WorkerReadiness } from './device-readiness.js';
export type { WorkerReadiness };
import type { AnyTraceEvent } from '../trace/types.js';

// ─── Shared Types ───

export type DevicePlatform = 'android' | 'ios'

export type DeviceFormFactor = 'phone' | 'tablet'

/** Device "skin" bucket — drives which bezel (image frame or CSS) is rendered. */
export type DeviceSkin = `${DevicePlatform}-${DeviceFormFactor}`

export function inferDevicePlatform(...values: Array<string | undefined>): DevicePlatform | undefined {
  const text = values.filter(Boolean).join(' ');
  if (/ios|iphone|ipad|simulator/i.test(text)) return 'ios';
  if (/android|emulator-|pixel|nexus|galaxy|generic_phone|avd/i.test(text)) return 'android';
  return undefined;
}

/** Tablet model hints found in simulator/emulator names and serials. */
const TABLET_RE = /ipad|tablet|\btab\b|\bsm-[tx]\d|nexus (?:7|9|10)|pixel\s*tablet|galaxy\s*tab|\bgts\d/i;

/**
 * Phone vs tablet. Name/serial hints are authoritative (an "iPad" is a tablet
 * whatever its screen ratio); the optional screen aspect ratio is a fallback for
 * opaque serials (e.g. bare `emulator-5554`) — tablets are squarer than phones.
 */
export function inferDeviceFormFactor(
  opts: { hints?: Array<string | undefined>; aspectRatio?: number } = {},
): DeviceFormFactor {
  const text = (opts.hints ?? []).filter(Boolean).join(' ');
  if (TABLET_RE.test(text)) return 'tablet';
  if (/iphone|pixel \d|generic_phone/i.test(text)) return 'phone';
  if (opts.aspectRatio && opts.aspectRatio > 0) {
    // Compare short side / long side. Phones are elongated (16:9 ≈ 0.56, taller
    // ones lower); tablets are closer to square (iPad ≈ 0.75, 5:3 Android
    // tablets = 0.6). 0.59 splits them: 16:9 phones stay phones, 5:3 tablets
    // are caught as tablets.
    const r = opts.aspectRatio <= 1 ? opts.aspectRatio : 1 / opts.aspectRatio;
    if (r >= 0.59) return 'tablet';
  }
  return 'phone';
}

/** Combine platform + form factor into the bezel bucket, or undefined if unknown. */
export function resolveDeviceSkin(
  platform: DevicePlatform | undefined,
  formFactor: DeviceFormFactor = 'phone',
): DeviceSkin | undefined {
  return platform ? `${platform}-${formFactor}` : undefined;
}

/**
 * One device of a worker's group. Every worker has at least its primary
 * (index 0); a `use.devices` project's workers have one entry per member.
 */
export interface WorkerDeviceInfo {
  /** Position in the group — the `deviceIndex` frames and commands carry. */
  index: number
  /** Group entry name (`alice`, `device-1`) — the trace's `deviceId`. */
  name: string
  deviceSerial: string
  displayName: string
  platform?: 'android' | 'ios'
  devicePixelRatio?: number
  isEmulator?: boolean
}

/** Per-worker status used by UI components. */
export interface WorkerInfo {
  workerId: number
  deviceSerial: string
  /** The worker's device group, primary first. Absent = single device (legacy servers). */
  devices?: WorkerDeviceInfo[]
  /** Friendly display name, e.g. "iPhone 16 #1" for iOS or the serial for Android. */
  displayName: string
  status: 'idle' | 'running' | 'done' | 'initializing' | 'error'
  currentFile?: string
  currentTest?: string
  passed: number
  failed: number
  skipped: number
  platform?: 'android' | 'ios'
  /** Logical-point → pixel scale. iOS only; unset for Android (= 1). */
  devicePixelRatio?: number
  isEmulator?: boolean
  /** Background device preparation state (see device-readiness.ts). */
  readiness?: WorkerReadiness
  /** Whether this worker prepares the device between runs. */
  speculation?: 'on' | 'off'
  /**
   * While running or preparing: how many of `devices` the current file (or
   * the file being prepared for) involves, primary first. A worker holds its
   * target's largest group, and a project declaring a smaller one leaves the
   * rest idle. Absent when idle, or on servers that do not report it.
   */
  activeDeviceCount?: number
}

export type { AppResetPolicy } from '../app-reset.js';

// ─── Test Tree ───

export interface TestTreeNode {
  /** Deterministic ID: filePath + suite chain + test name. */
  id: string
  type: 'project' | 'file' | 'suite' | 'test'
  name: string
  filePath: string
  /** Fully qualified name: "suite > nested > test name". */
  fullName: string
  status: TestNodeStatus
  duration?: number
  error?: string
  children?: TestTreeNode[]
  watchEnabled?: boolean
  /** For project nodes: names of projects this depends on. */
  dependencies?: string[]
  /**
   * Declared isolation options in effect for this node (project `use` merged
   * with the file's `test.use()` cascade). Absent when nothing is declared —
   * the runner then resolves `auto` at run time.
   */
  use?: TestTreeUseOptions
}

export interface TestTreeUseOptions {
  appReset?: 'auto' | 'clear' | 'restart' | 'warm' | 'none'
  appResetScope?: 'auto' | 'file' | 'test'
  appState?: string
  /** Devices each test of the project drives (`use.devices`); absent = one. */
  devices?: number
  /** The group's member names (`alice`, `bob`), primary first; set with `devices`. */
  deviceNames?: string[]
}

/**
 * The isolation a test actually ran under: the declared options with `auto`
 * resolved by the runner (hooks detected → warm, …). Sent with `test-start`
 * so UI mode's Metadata tab can show the same Isolation row as the trace
 * viewer, which reads it from the packaged archive.
 */
export interface TestIsolation {
  appReset: 'clear' | 'restart' | 'warm' | 'none'
  appResetScope: 'file' | 'test'
  /** Saved app state restored before the test, when the scope declared one. */
  appState?: string
}

export type TestNodeStatus =
  | 'idle'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'

// ─── Server → Client messages ───

export interface TestTreeMessage {
  type: 'test-tree'
  files: TestTreeNode[]
}

export interface RunStartMessage {
  type: 'run-start'
  fileCount: number
  /** When running a single file, the file path. Used to scope trace clearing. */
  filePath?: string
  /** When running a single test, the test fullName. Used to scope trace clearing. */
  testFilter?: string
  /** When running a single file/test in a multi-project config, the project
   * the file belongs to. Lets the client scope trace clearing to just that
   * project's copy and leave sibling projects' traces intact. */
  projectName?: string
}

export interface RunEndMessage {
  type: 'run-end'
  /** Milliseconds from run start to the first traced action of the first test. */
  timeToFirstActionMs?: number
  /** How the first file's isolation was satisfied. */
  preflight?: { origin: 'prepared' | 'inline' | 'skipped' | 'unknown' }
  /** 'stopped' = the user stopped the run before it finished. */
  status: 'passed' | 'failed' | 'stopped'
  duration: number
  passed: number
  failed: number
  skipped: number
  /** Tests killed mid-flight by a user stop (not counted in `failed`). */
  interrupted?: number
}

export interface TestStartMessage {
  type: 'test-start'
  fullName: string
  filePath: string
  /** Worker that is running this test (multi-worker mode only). */
  workerId?: number
  /** Project this test belongs to. When set, the SPA scopes the update to
   * the matching project node — required when the same file is shared
   * across projects (multi-device configs). */
  projectName?: string
  /** True when this message only re-tags trace attribution to an
   * already-finished test (afterAll hooks are attributed to the last test
   * that ran). The SPA must not treat it as a new execution: no status
   * reset to 'running', no clearing of the test's accumulated trace. */
  attributionOnly?: boolean
  /** Resolved isolation for this execution (absent on attribution-only re-tags). */
  isolation?: TestIsolation
  /**
   * How many devices this test's run drives (its project's group). The SPA
   * sizes the trace's device panes from it: a single-device project running
   * on a worker that holds a group must not show the idle members' panes.
   * Absent = the worker's whole group (legacy servers).
   */
  deviceCount?: number
}

export interface TestStatusMessage {
  type: 'test-status'
  /** Test full name (unique within its file). */
  fullName: string
  filePath: string
  status: TestNodeStatus
  duration?: number
  error?: string
  tracePath?: string
  videoPath?: string
  /** Worker that ran this test (multi-worker mode only). */
  workerId?: number
  /** Project this test belongs to. When set, the SPA scopes the update to
   * the matching project node — required when the same file is shared
   * across projects (multi-device configs). */
  projectName?: string
}

export interface FileStatusMessage {
  type: 'file-status'
  filePath: string
  status: 'running' | 'done'
  /** Project this file belongs to. When set, the SPA scopes the update to
   * the matching project node. */
  projectName?: string
}

export interface TraceEventMessage {
  type: 'trace-event'
  /** Absolute test file path. Absent on older servers. */
  filePath?: string
  /** The full name of the test this event belongs to. */
  testFullName: string
  /** Worker that produced this trace event (multi-worker mode only). */
  workerId?: number
  /** Project the test belongs to. Used to scope trace storage so the same
   * test running under multiple projects (multi-device configs) doesn't
   * collide on a single trace map entry. */
  projectName?: string
  event: AnyTraceEvent
  /** Lifecycle stage of the action/assertion. Omitted = legacy completed.
   * 'started' fires immediately after the before-capture so UI mode can show
   * an in-progress row with a spinner; 'completed' carries the final result. */
  lifecycle?: 'started' | 'completed'
  /** Base64-encoded PNG screenshot taken before the action. */
  screenshotBefore?: string
  /** Base64-encoded PNG screenshot taken after the action. */
  screenshotAfter?: string
  /** Hierarchy XML captured before the action. */
  hierarchyBefore?: string
  /** Hierarchy XML captured after the action. */
  hierarchyAfter?: string
}

export interface HierarchyUpdateMessage {
  type: 'hierarchy-update'
  xml: string
  /** Worker the hierarchy was captured from (0 in single-worker mode) so
   * clients can discard updates for a device they're no longer mirroring. */
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
}

export interface WatchEventMessage {
  type: 'watch-event'
  filePath: string
  /** Present when the watch event is scoped to a specific test fullName or
   * describe prefix. Omitted for whole-file watches. */
  testFilter?: string
  /** Present when the watch is scoped to a specific project (multi-device
   * configs share the same file across projects, so watch state must be
   * per-project to match the project-specific run it will trigger). */
  projectName?: string
  event: 'changed' | 'added' | 'removed' | 'watch-enabled' | 'watch-disabled'
}

export interface WorkerStatusMessage {
  type: 'worker-status'
  workerId: number
  deviceSerial: string
  deviceModel?: string
  currentFile?: string
  currentTest?: string
  status: 'idle' | 'running' | 'done' | 'initializing' | 'error'
  passed: number
  failed: number
  skipped: number
  /** Background device preparation state. */
  readiness?: import('./device-readiness.js').WorkerReadiness
  speculation?: 'on' | 'off'
  /** See `WorkerInfo.activeDeviceCount`. */
  activeDeviceCount?: number
}

/**
 * Something happened to a device outside a traced test: a background
 * preparation, a validation, a worker recycle, a burst of mirror gestures.
 * Same start/end merge-by-id shape as `mcp-tool-call`.
 */
export interface DeviceActivityMessage {
  type: 'device-activity'
  id: string
  workerId: number
  kind: 'prepare' | 'validate' | 'recycle' | 'mirror' | 'respawn'
  status: 'started' | 'completed' | 'error' | 'cancelled'
  /** e.g. "Prepare device (clear)", "Mirror: 3 taps" */
  label: string
  /** Last progress line, error message, or outcome summary. */
  detail?: string
  policy?: import('../app-reset.js').AppResetPolicy
  forFile?: string
  timestamp: number
  durationMs?: number
}

export interface UIPreferences {
  /** Prepare the device (run the declared app reset) in the background between runs. */
  prepareBetweenRuns: boolean
  /** Quiet time after a run before the device is prepared (0 = immediately). */
  prepareDelayMs: number
}

// No grace by default: warm resets are sub-second, and the trace already holds
// the post-action screenshots, so waiting only delays the next run. The mirror
// interaction hold (ui-server.ts) still applies when the user is poking the device.
export const DEFAULT_UI_PREFERENCES: UIPreferences = { prepareBetweenRuns: true, prepareDelayMs: 0 };

export interface PreferencesMessage {
  type: 'preferences'
  preferences: UIPreferences
}

export interface WorkersInfoMessage {
  type: 'workers-info'
  workers: Array<{
    workerId: number
    deviceSerial: string
    displayName: string
    platform?: 'android' | 'ios'
    devicePixelRatio?: number
    /** The worker's device group, primary first (one entry for single-device workers). */
    devices?: WorkerDeviceInfo[]
  }>
}

export interface DeviceInfoMessage {
  type: 'device-info'
  serial: string
  model?: string
  isEmulator: boolean
  screenWidth?: number
  screenHeight?: number
  platform?: 'android' | 'ios'
  tapsmithVersion?: string
  devicePixelRatio?: number
}

export interface SourceMessage {
  type: 'source'
  /** Absolute path of the source file — unique key for the client sources map. */
  path: string
  /** Basename for display. */
  fileName: string
  content: string
}

/** Full current entry list, with either complete bodies or changed bodies. */
export interface NetworkMessage {
  type: 'network'
  /** Absolute test file path. Absent on older servers. */
  filePath?: string
  /** Effective network capture setting for this test; absent for older workers. */
  networkCaptureEnabled?: boolean
  /** How the capture reached the proxy; `ios-system-proxy` is host-wide (entries may include other apps' traffic). */
  networkCaptureRoute?: import('../trace/types.js').NetworkCaptureRoute | null
  /** Omitted for full snapshots, including reconnect replay. */
  bodyMode?: 'patch'
  testFullName: string
  /** Project the test belongs to. Used to scope trace storage in multi-device
   * configs so the same test under multiple projects doesn't collide. */
  projectName?: string
  entries: import('../trace/types.js').NetworkEntry[]
  /** Request/response bodies keyed by path (e.g. `network/res-0.bin`).
   * Encoded as base64; decoded lazily on the client when rendering. */
  bodies?: Record<string, string>
}

export interface ErrorMessage {
  type: 'error'
  message: string
  stack?: string
}

// ─── MCP messages ───

export interface McpStatusMessage {
  type: 'mcp-status'
  running: boolean
  mcpUrl?: string
  /** Primary (first) connected client — kept for back-compat with single-client UI. */
  clientName?: string
  clientVersion?: string
  /** Number of MCP clients currently attached to the shared session. */
  connectedCount?: number
  /** All currently attached MCP clients. */
  clients?: { name: string; version: string }[]
}

export interface McpToolCallMessage {
  type: 'mcp-tool-call'
  id: string
  tool: string
  args: Record<string, unknown>
  status: 'started' | 'completed' | 'error'
  resultSummary?: string
  resultText?: string
  resultTruncated?: boolean
  error?: string
  durationMs?: number
  timestamp: number
}

export interface RunStateMessage {
  type: 'run-state'
  isRunning: boolean
  startedAt?: number
}

/**
 * Live progress for a slow device action outside the traced-test window
 * (between-file preflight reset, recovery). Lets the Actions panel show
 * what's happening (e.g. "Clearing app data (com.foo)…") instead of a
 * generic waiting state. No `message` means the action finished — clear
 * the indicator for that worker. @see PILOT-232
 */
export interface RunProgressMessage {
  type: 'run-progress'
  workerId: number
  message?: string
}

/** Union of all server → client JSON messages. */
export type ServerMessage =
  | TestTreeMessage
  | RunStartMessage
  | RunEndMessage
  | RunStateMessage
  | TestStartMessage
  | TestStatusMessage
  | FileStatusMessage
  | TraceEventMessage
  | HierarchyUpdateMessage
  | WatchEventMessage
  | WorkerStatusMessage
  | WorkersInfoMessage
  | DeviceInfoMessage
  | SourceMessage
  | NetworkMessage
  | ErrorMessage
  | McpStatusMessage
  | McpToolCallMessage
  | RunProgressMessage
  | DeviceActivityMessage
  | PreferencesMessage

// ─── Client → Server messages ───

export interface RunTestCommand {
  type: 'run-test'
  fullName: string
  filePath: string
  /** Project the test belongs to. Required when the same file is shared
   * across multiple projects (e.g. one Android and one iOS project both
   * matching `**\/*.test.ts`) so the server can route to the correct device. */
  projectName?: string
  /** When true, run dependency projects before this test. */
  runDeps?: boolean
}

export interface RunFileCommand {
  type: 'run-file'
  filePath: string
  /** Project the file belongs to. Required when the same file is shared
   * across multiple projects so the server can route to the correct device. */
  projectName?: string
  /** When true, run dependency projects before this file. */
  runDeps?: boolean
}

export interface RunAllCommand {
  type: 'run-all'
}

export interface RunProjectCommand {
  type: 'run-project'
  projectName: string
  /** When true, run dependency projects before this project. */
  runDeps?: boolean
}

export interface RunFailedCommand {
  type: 'run-failed'
}

export interface StopRunCommand {
  type: 'stop-run'
}

export interface ToggleWatchCommand {
  type: 'toggle-watch'
  /** File path to toggle, or 'all' for all files. */
  filePath: string
  /** Test fullName or describe prefix to scope the watch to. Omit (or
   * pass undefined) to toggle watching the whole file. */
  testFilter?: string
  /** Project to scope the watch to in multi-project configs — the same file
   * appears under each project, and the watched entry must remember which
   * one so re-runs route to the right device. */
  projectName?: string
}

export interface RequestHierarchyCommand {
  type: 'request-hierarchy'
  /** Target worker (multi-worker mode). Defaults to the selected worker. */
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
}

export interface RequestSourceCommand {
  type: 'request-source'
  /** Absolute path of the source file to read from disk. */
  path: string
}

export interface MirrorTapCommand {
  type: 'mirror-tap'
  /** X normalized to 0–1. */
  x: number
  /** Y normalized to 0–1. */
  y: number
  /** Target worker (multi-worker mode). Defaults to the selected worker. */
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  /** True when the user overrode the lock to interact during a run. */
  force?: boolean
}

export interface MirrorLongPressCommand {
  type: 'mirror-long-press'
  x: number
  y: number
  durationMs: number
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorSwipeCommand {
  type: 'mirror-swipe'
  fromX: number
  fromY: number
  toX: number
  toY: number
  durationMs: number
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorInputTextCommand {
  type: 'mirror-input-text'
  text: string
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorPressKeyCommand {
  type: 'mirror-press-key'
  key: string
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorTouchStartCommand {
  type: 'mirror-touch-start'
  /** X normalized to 0–1. */
  x: number
  /** Y normalized to 0–1. */
  y: number
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorTouchMoveCommand {
  type: 'mirror-touch-move'
  x: number
  y: number
  /** Milliseconds since touch-start. */
  tMs: number
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorTouchEndCommand {
  type: 'mirror-touch-end'
  x: number
  y: number
  tMs: number
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface MirrorTouchCancelCommand {
  type: 'mirror-touch-cancel'
  workerId?: number
  /** Which device of the worker's group (0 = primary). */
  deviceIndex?: number
  force?: boolean
}

export interface SetFilterCommand {
  type: 'set-filter'
  name?: string
  status?: 'all' | 'passed' | 'failed' | 'skipped'
}

export interface SelectWorkerCommand {
  type: 'select-worker'
  /** Worker ID whose device to mirror. */
  workerId: number
  /** Which device of the worker's group to mirror (0 = primary). */
  deviceIndex?: number
}

export interface SelectWorkerViewCommand {
  type: 'select-worker-view'
  /** 'all' to poll all workers simultaneously, or a specific worker ID. */
  mode: 'all' | number
  /** With a worker ID: which device of its group to mirror (0 = primary). */
  deviceIndex?: number
}

export interface RespawnWorkerCommand {
  type: 'respawn-worker'
  workerId: number
}

/**
 * Restart a worker's Node process against its existing daemon so the next run
 * imports fresh code (page objects, fixtures, helpers — anything the ESM cache
 * would otherwise keep). The device is untouched.
 */
export interface RecycleWorkerCommand {
  type: 'recycle-worker'
  workerId: number
}

/** Client preferences the server needs to act on (persisted client-side). */
export interface SetPreferencesCommand {
  type: 'set-preferences'
  preferences: Partial<UIPreferences>
}

/** Prepare the device now (even with background preparation off). */
export interface PrepareNowCommand {
  type: 'prepare-now'
  workerId?: number
}

export interface CancelPrepareCommand {
  type: 'cancel-prepare'
  workerId?: number
}

/** The node the user has selected — the strongest hint for what runs next. */
export interface SelectNodeCommand {
  type: 'select-node'
  filePath?: string
  projectName?: string
}

/** Union of all client → server JSON messages. */
export type ClientMessage =
  | RunTestCommand
  | RunFileCommand
  | RunAllCommand
  | RunFailedCommand
  | RunProjectCommand
  | StopRunCommand
  | ToggleWatchCommand
  | RequestHierarchyCommand
  | RequestSourceCommand
  | MirrorTapCommand
  | MirrorLongPressCommand
  | MirrorSwipeCommand
  | MirrorInputTextCommand
  | MirrorPressKeyCommand
  | MirrorTouchStartCommand
  | MirrorTouchMoveCommand
  | MirrorTouchEndCommand
  | MirrorTouchCancelCommand
  | SetFilterCommand
  | SelectWorkerCommand
  | SelectWorkerViewCommand
  | RespawnWorkerCommand
  | RecycleWorkerCommand
  | SetPreferencesCommand
  | PrepareNowCommand
  | CancelPrepareCommand
  | SelectNodeCommand

// ─── Binary frame helpers ───

/**
 * Binary WebSocket frames are tagged with a `kind` byte (byte 0). Only PNG
 * screenshot frames are carried today; the tag is retained for wire stability.
 */
export const FRAME_KIND_SCREENSHOT = 0;

/**
 * Screenshot frame layout:
 *   byte  0:    uint8  kind = 0
 *   bytes 1-4:  uint32 BE frame sequence number
 *   bytes 5-6:  uint16 BE worker ID (0 for single-worker mode)
 *   bytes 7-8:  uint16 BE width
 *   bytes 9-10: uint16 BE height
 *   byte  11:   uint8  device index within the worker's group (0 = primary)
 *   bytes 12+:  raw PNG data
 */
export const SCREEN_FRAME_HEADER_SIZE = 12;

export function encodeScreenFrame(
  seq: number,
  workerId: number,
  width: number,
  height: number,
  png: Buffer,
  deviceIndex = 0,
): Buffer {
  const header = Buffer.alloc(SCREEN_FRAME_HEADER_SIZE);
  header.writeUInt8(FRAME_KIND_SCREENSHOT, 0);
  header.writeUInt32BE(seq, 1);
  header.writeUInt16BE(workerId, 5);
  header.writeUInt16BE(width, 7);
  header.writeUInt16BE(height, 9);
  header.writeUInt8(deviceIndex, 11);
  return Buffer.concat([header, png]);
}

export type DecodedBinaryFrame =
  | { kind: 'screenshot'; seq: number; workerId: number; deviceIndex: number; width: number; height: number; pngOffset: number }

export function decodeBinaryFrame(data: ArrayBuffer): DecodedBinaryFrame {
  const view = new DataView(data);
  return {
    kind: 'screenshot',
    seq: view.getUint32(1),
    workerId: view.getUint16(5),
    width: view.getUint16(7),
    height: view.getUint16(9),
    deviceIndex: view.getUint8(11),
    pngOffset: SCREEN_FRAME_HEADER_SIZE,
  };
}

/** Key for per-device mirror state: a worker's device, `w<worker>:d<device>`. */
export function mirrorKey(workerId: number, deviceIndex = 0): string {
  return `w${workerId}:d${deviceIndex}`;
}

// ─── IPC protocol (child processes ↔ UI server) ───

// ─── Discovery IPC ───

export interface UIDiscoverMessage {
  type: 'discover'
  filePath: string
}

export interface UIDiscoverResultMessage {
  type: 'discover-result'
  filePath: string
  tree: TestTreeNode
}

export interface UIDiscoverErrorMessage {
  type: 'discover-error'
  filePath: string
  error: { message: string; stack?: string }
}

export type UIDiscoverChildMessage =
  | UIDiscoverResultMessage
  | UIDiscoverErrorMessage

// ─── UI Worker IPC (persistent worker ↔ UI server) ───

/** Server → UI worker: initialize with device, daemon, config. */
export interface UIWorkerInitMessage {
  type: 'init'
  workerId: number
  deviceSerial: string
  /** The primary's group entry name — see `InitMessage.deviceName`. */
  deviceName: string
  daemonPort: number
  config: import('../worker-protocol.js').SerializedConfig
  screenshotDir?: string
  freshEmulator?: boolean
  /**
   * The daemon at `daemonPort` already has this device selected, the agent
   * running and the app launched (the CLI's primary-device setup). Skip
   * install / startAgent / the cold launch: connect, re-select the device and
   * verify the session — the launch that already happened is this worker's
   * prepared state for the first file.
   */
  adoptPrimary?: boolean
  /**
   * With `adoptPrimary`: the CLI's startup launch has not been consumed by
   * any test yet, so it is this worker's `clear · file` prepared state. Only
   * the initial spawn sets this — a respawned worker re-adopts a daemon whose
   * app has run tests since, and must not claim a reset that never ran.
   */
  adoptPrepared?: boolean
  /**
   * `--force-install`: reinstall the app on every device this worker sets up
   * (an adopted device was installed by the CLI already). Set on the initial
   * spawn only — a respawn mid-session must not wipe the app under test.
   * Required, like `InitMessage.forceInstall`.
   */
  forceInstall: boolean
  /**
   * The rest of the device group (`devices[1..]`) for a `use.devices`
   * project, each on a daemon the server spawned for it. Omitted for
   * single-device workers.
   */
  groupMembers?: import('../worker-protocol.js').WorkerGroupMember[]
}

/** Server → UI worker: run a test file. */
export interface UIWorkerRunFileMessage {
  type: 'run-file'
  filePath: string
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions
  projectName?: string
  testFilter?: string
  /** The device already satisfies this file's policy (background preparation). */
  preparedFor?: import('../app-reset.js').PreparedState
}

/** Server → UI worker: reset the app in the background to `policy`. */
export interface UIWorkerPrepareMessage {
  type: 'prepare'
  prepareId: string
  policy: import('../app-reset.js').AppResetPolicy
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions
  projectName?: string
  forFile?: string
}

export interface UIWorkerCancelPrepareMessage {
  type: 'cancel-prepare'
  prepareId: string
}

/** Server → UI worker: shut down gracefully. */
export interface UIWorkerShutdownMessage {
  type: 'shutdown'
}

/** Server → UI worker: abort the current run (let current test finish, skip rest). */
export interface UIWorkerAbortMessage {
  type: 'abort'
}

export type UIWorkerMessage =
  | UIWorkerInitMessage
  | UIWorkerRunFileMessage
  | UIWorkerShutdownMessage
  | UIWorkerAbortMessage
  | UIWorkerPrepareMessage
  | UIWorkerCancelPrepareMessage

/** UI worker → server: worker is ready. */
export interface UIWorkerReadyMessage {
  type: 'ready'
  workerId: number
  /** Policy the startup launch left the app in, when it did launch. */
  policy?: import('../app-reset.js').AppResetPolicy
  /** Runtime reset capabilities probed after launch (in-app hooks detected?). */
  capabilities?: import('../app-reset.js').ResetCapabilities
}

/**
 * UI worker → server: the worker's runtime reset capabilities changed since
 * `ready` (e.g. a reset detected in-app hooks the startup probe missed). The
 * server merges it into its per-worker snapshot so policy resolution for
 * background preparation agrees with the runner's own.
 */
export interface UIWorkerCapabilitiesMessage {
  type: 'capabilities'
  workerId: number
  capabilities: import('../app-reset.js').ResetCapabilities
}

/** UI worker → server: a background preparation finished. */
export interface UIWorkerPreparedMessage {
  type: 'prepared'
  workerId: number
  prepareId: string
  policy: import('../app-reset.js').AppResetPolicy
  startedAt: number
  durationMs: number
  steps: string[]
  /**
   * Set when the device already satisfied the policy (e.g. the startup
   * launch): the preparation that did the work, so the UI and the runner's
   * summary row credit it rather than this no-op pass.
   */
  satisfiedBy?: import('../app-reset.js').PreparedState
}

export interface UIWorkerPrepareFailedMessage {
  type: 'prepare-failed'
  workerId: number
  prepareId: string
  error: { message: string }
  cancelled: boolean
}

/** UI worker → server: progress during initialization, and live slow-device-
 * action progress during the between-file preflight (empty string = clear).
 * @see PILOT-232 */
export interface UIWorkerProgressMessage {
  type: 'progress'
  workerId: number
  message: string
}

/** UI worker → server: test starting. */
export interface UIWorkerTestStartMessage {
  type: 'test-start'
  workerId: number
  fullName: string
  filePath: string
  /** Re-tag of trace attribution for a finished test (see TestStartMessage). */
  attributionOnly?: boolean
  /** Resolved isolation for this execution (see TestStartMessage). */
  isolation?: TestIsolation
}

/** UI worker → server: test completed. */
export interface UIWorkerTestEndMessage {
  type: 'test-end'
  workerId: number
  result: import('../worker-protocol.js').SerializedTestResult
}

/** UI worker → server: real-time trace event. */
export interface UIWorkerTraceEventMessage {
  type: 'trace-event'
  workerId: number
  event: AnyTraceEvent
  /** Lifecycle stage. Omitted = legacy completed. */
  lifecycle?: 'started' | 'completed'
  screenshotBefore?: string
  screenshotAfter?: string
  hierarchyBefore?: string
  hierarchyAfter?: string
}

/** UI worker → server: test source code. */
export interface UIWorkerSourceMessage {
  type: 'source'
  workerId: number
  path: string
  fileName: string
  content: string
}

/** UI worker → server: network entries. */
export interface UIWorkerNetworkMessage {
  type: 'network'
  /** Effective network capture setting for this test; absent for older workers. */
  networkCaptureEnabled?: boolean
  /** How the capture reached the proxy; `ios-system-proxy` is host-wide. */
  networkCaptureRoute?: import('../trace/types.js').NetworkCaptureRoute | null
  /** Omitted for full snapshots, including reconnect replay. */
  bodyMode?: 'patch'
  workerId: number
  entries: import('../trace/types.js').NetworkEntry[]
  bodies?: Record<string, string>
}

/** UI worker → server: file execution completed. */
export interface UIWorkerFileDoneMessage {
  type: 'file-done'
  workerId: number
  filePath: string
  results: import('../worker-protocol.js').SerializedTestResult[]
  suite: import('../worker-protocol.js').SerializedSuiteResult
}

/** UI worker → server: error. */
export interface UIWorkerErrorMessage {
  type: 'error'
  workerId: number
  error: { message: string; stack?: string }
}

export type UIWorkerChildMessage =
  | UIWorkerReadyMessage
  | UIWorkerProgressMessage
  | UIWorkerTestStartMessage
  | UIWorkerTestEndMessage
  | UIWorkerTraceEventMessage
  | UIWorkerSourceMessage
  | UIWorkerNetworkMessage
  | UIWorkerFileDoneMessage
  | UIWorkerErrorMessage
  | UIWorkerPreparedMessage
  | UIWorkerPrepareFailedMessage
  | UIWorkerCapabilitiesMessage
