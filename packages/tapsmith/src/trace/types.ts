/**
 * Trace data model types.
 *
 * Defines the schema for trace archives produced by the Tapsmith test runner.
 * A trace archive is a .zip file containing:
 *   - metadata.json  — format version, device/test info
 *   - trace.json     — NDJSON event log (actions, assertions, groups, console
 *                      and device/daemon logs, errors)
 *   - screenshots/   — PNGs keyed by action index
 *   - hierarchy/     — View hierarchy XML snapshots
 *   - sources.json   — Source files referenced by stack frames (optional)
 *   - network.json   — NDJSON network request log (optional)
 *   - network/       — Request/response bodies
 *
 * This is the public archive contract: keep it in step with
 * `schema/trace-format.schema.json` and `docs/trace-format.md`, and bump
 * `TRACE_FORMAT_VERSION` (trace-format.ts) for any change an existing reader
 * could misread.
 */

// ─── Trace Event Types ───

export type TraceEventType =
  | 'action'
  | 'assertion'
  | 'group-start'
  | 'group-end'
  | 'console'
  | 'attachment'
  | 'error'

/** Action categories for display grouping. */
export type ActionCategory =
  | 'tap'
  | 'type'
  | 'swipe'
  | 'scroll'
  | 'press-key'
  | 'navigation'
  | 'device'
  | 'assertion'
  | 'screenshot'
  | 'api'
  | 'network'
  | 'webview'
  | 'other'

/** Console output level. */
export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug'


// ─── Core Event Schema ───

export interface TraceEvent {
  /** Event type discriminator. */
  type: TraceEventType
  /** Monotonic action index (0-based). */
  actionIndex: number
  /** Wall-clock timestamp (ms since epoch). For completed actions/assertions, this is the completion time. */
  timestamp: number
  /** Device ID for multi-device support. */
  deviceId?: string
}

export interface ActionTraceEvent extends TraceEvent {
  type: 'action'
  /** Action category for display. */
  category: ActionCategory
  /** Human-readable action name (e.g. "tap", "type", "swipe"). */
  action: string
  /** Serialized selector, if applicable. */
  selector?: string
  /** Input value for type/clearAndType actions. */
  inputValue?: string
  /** Duration of the action in milliseconds. */
  duration: number
  /**
   * Wall-clock time allocated to this action in the linear trace timeline.
   * Includes idle/setup time since the previous completed action. In finalized
   * trace archives, the last action may also include trailing teardown time so
   * visible action durations add up to the recorded test duration.
   */
  wallDuration?: number
  /** Time between the previous completed action and this action starting. */
  gapBefore?: number
  /** Trailing time after this action that was allocated during finalization. */
  trailingTime?: number
  /** Best-effort wall-clock timestamp when the action began. */
  startTime?: number
  /** Best-effort wall-clock timestamp when the action completed. */
  endTime?: number
  /** Whether the action succeeded. */
  success: boolean
  /** Error message if the action failed. */
  error?: string
  /** Error stack trace. */
  errorStack?: string
  /** Element bounds at the time of the action. */
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Tap/swipe coordinates for overlay rendering. */
  point?: { x: number; y: number }
  /** End point for swipe/drag actions. */
  endPoint?: { x: number; y: number }
  /** Whether a "before" screenshot was captured. */
  hasScreenshotBefore: boolean
  /** Whether an "after" screenshot was captured. */
  hasScreenshotAfter: boolean
  /** Whether a "before" hierarchy snapshot was captured. */
  hasHierarchyBefore: boolean
  /** Whether an "after" hierarchy snapshot was captured. */
  hasHierarchyAfter: boolean
  /** Source location where the action was called. */
  sourceLocation?: SourceLocation
  /** Full user-code call stack at the time of the action (top frame first).
   * `sourceLocation` is `stack[0]`. */
  stack?: SourceLocation[]
  /** Wait time before the element was found (ms). */
  waitTime?: number
  /** Number of retries before success. */
  retryCount?: number
  /** Internal action log entries. */
  log?: string[]
  /**
   * Free-text second line for actions that have no selector (e.g. the
   * declared app reset: "satisfied by background preparation … (took 9.8s)").
   */
  detail?: string
  /**
   * Where the work behind this row happened: inline in this run, satisfied
   * by an earlier preparation, or skipped by policy.
   */
  origin?: 'inline' | 'prepared' | 'skipped'
}

export interface AssertionTraceEvent extends TraceEvent {
  type: 'assertion'
  /** Assertion method name (e.g. "toBeVisible", "toHaveText"). */
  assertion: string
  /** Serialized selector. */
  selector?: string
  /** Expected value. */
  expected?: string
  /** Actual value. */
  actual?: string
  /** Whether the assertion passed. */
  passed: boolean
  /** Whether this was a soft assertion. */
  soft: boolean
  /** Whether this was a negated assertion. */
  negated: boolean
  /** Duration of the assertion polling. */
  duration: number
  /**
   * Wall-clock time allocated to this assertion in the linear trace timeline.
   * Includes idle/setup time since the previous completed action/assertion. In
   * finalized trace archives, the last assertion may also include trailing
   * teardown time so visible durations add up to the recorded test duration.
   */
  wallDuration?: number
  /** Time between the previous completed action/assertion and this assertion starting. */
  gapBefore?: number
  /** Trailing time after this assertion that was allocated during finalization. */
  trailingTime?: number
  /** Best-effort wall-clock timestamp when the assertion began. */
  startTime?: number
  /** Best-effort wall-clock timestamp when the assertion completed. */
  endTime?: number
  /** Number of poll attempts. */
  attempts: number
  /** Error message if the assertion failed. */
  error?: string
  /** Element bounds at the time of the assertion (for screenshot overlay). */
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Source location. */
  sourceLocation?: SourceLocation
  /** Full user-code call stack at the time of the assertion (top frame first).
   * `sourceLocation` is `stack[0]`. */
  stack?: SourceLocation[]
  /** Whether a "before" screenshot was captured. */
  hasScreenshotBefore?: boolean
  /** Whether an "after" screenshot was captured. */
  hasScreenshotAfter?: boolean
  /** Whether a "before" hierarchy snapshot was captured. */
  hasHierarchyBefore?: boolean
  /** Whether an "after" hierarchy snapshot was captured. */
  hasHierarchyAfter?: boolean
}

export interface GroupTraceEvent extends TraceEvent {
  type: 'group-start' | 'group-end'
  /** Group name. */
  name: string
}

export interface ConsoleTraceEvent extends TraceEvent {
  type: 'console'
  /** Console level. */
  level: ConsoleLevel
  /** Console message. */
  message: string
  /** Source: 'test' for test code, 'device' for logcat/syslog, 'daemon' for tapsmith-core. */
  source: 'test' | 'device' | 'daemon'
}

/** Reserved in the format; nothing emits it yet. */
export interface AttachmentTraceEvent extends TraceEvent {
  type: 'attachment'
  /** Attachment name. */
  name: string
  /** MIME type. */
  contentType: string
  /** Path within the archive (relative to archive root). */
  path: string
  /** Original file size in bytes. */
  size: number
}

export interface ErrorTraceEvent extends TraceEvent {
  type: 'error'
  /** Error message. */
  message: string
  /** Error stack trace. */
  stack?: string
}

// ─── Source Location ───

export interface SourceLocation {
  file: string
  line: number
  column?: number
}

// ─── Trace Metadata ───

export interface TraceMetadata {
  /**
   * Archive format version (`TRACE_FORMAT_VERSION` in trace-format.ts). A
   * reader must refuse a version newer than it knows; see
   * docs/trace-format.md for what bumps it.
   */
  version: number
  /** Tapsmith SDK version. */
  tapsmithVersion: string
  /** Test file path — POSIX, relative to the project's rootDir (v2+; absolute in v1). */
  testFile: string
  /** Fully qualified test name. */
  testName: string
  /** Test status. */
  testStatus: 'passed' | 'failed' | 'skipped' | 'running' | 'idle'
  /** Test duration in ms. */
  testDuration: number
  /** Test start timestamp (ms since epoch). */
  startTime: number
  /** Test end timestamp (ms since epoch). */
  endTime: number
  /** Device info for the primary device (kept for readers of older traces). */
  device: TraceDeviceInfo
  /**
   * Every device the test drove, primary first, each carrying its group
   * `name` — the value events use as `deviceId`. Absent in traces recorded
   * before multi-device support; readers should fall back to `[device]`.
   */
  devices?: TraceDeviceInfo[]
  /** Trace configuration used. */
  traceConfig: TraceConfigSnapshot
  /** Total number of actions recorded. */
  actionCount: number
  /** Total number of screenshots. */
  screenshotCount: number
  /** Error message if the test failed. */
  error?: string
  /** Project name this test belongs to (when projects are configured). */
  project?: string
  /** App state archive restored before this test — POSIX, relative to rootDir (v2+). */
  appState?: string
  /** Declared app reset mode in effect for this test's scope. */
  appReset?: string
  /** Declared app reset scope ('file' | 'test') in effect for this test. */
  appResetScope?: string
}

export interface TraceDeviceInfo {
  serial: string
  /**
   * Group name (`alice`, `device-1`) matching `TraceEvent.deviceId`. Set on
   * every entry of `TraceMetadata.devices`; undefined on the legacy `device`.
   */
  name?: string
  platform?: 'android' | 'ios'
  model?: string
  osVersion?: string
  screenResolution?: { width: number; height: number }
  isEmulator: boolean
  packageName?: string
  /** Device pixel ratio (e.g. 3 for retina iOS). Bounds are in logical points; screenshots in pixels. */
  devicePixelRatio?: number
  /**
   * How this device's network traffic reached the capture proxy, when network
   * capture ran. `ios-system-proxy` means the host-wide macOS fallback: the
   * captured entries may include traffic from other apps on the Mac, and
   * requests to localhost are missing. Absent in older traces.
   */
  networkCaptureRoute?: NetworkCaptureRoute
}

/**
 * Route a device's traffic took into the capture proxy (mirrors the daemon's
 * `NetworkCaptureRoute` enum):
 * - `ios-network-extension` — iOS simulator, per-process Network Extension (isolated)
 * - `ios-system-proxy` — iOS simulator, macOS system proxy fallback (host-wide)
 * - `ios-device-proxy` — physical iOS device, installed Wi-Fi proxy profile
 * - `android-transparent` — Android iptables transparent redirect
 * - `android-http-proxy` — Android global HTTP proxy fallback (proxy-aware clients only)
 */
export type NetworkCaptureRoute =
  | 'ios-network-extension'
  | 'ios-system-proxy'
  | 'ios-device-proxy'
  | 'android-transparent'
  | 'android-http-proxy'

export interface TraceConfigSnapshot {
  screenshots: boolean
  snapshots: boolean
  sources: boolean
  network: boolean
  deviceLogs: boolean
  daemonLogs: boolean
}

// ─── Trace Configuration ───

/**
 * Every trace recording mode, in the order help text and errors list them.
 * The `TraceMode` type is derived from it, so the CLI's `--trace` choices and
 * config validation can never drift from the type.
 */
export const TRACE_MODES = [
  'off',
  'on',
  'on-first-retry',
  'on-all-retries',
  'retain-on-failure',
  'retain-on-first-failure',
  'retain-on-failure-and-retries',
] as const;

export type TraceMode = (typeof TRACE_MODES)[number]

export interface TraceConfig {
  /** Trace recording mode. */
  mode: TraceMode
  /** Whether to capture screenshots before/after each action. */
  screenshots: boolean
  /** Whether to capture view hierarchy snapshots. */
  snapshots: boolean
  /** Whether to include test source files. */
  sources: boolean
  /** Whether to include user-added attachments. */
  attachments: boolean
  /**
   * Whether to capture network traffic via the MITM HTTP proxy.
   * When enabled (the default), Tapsmith starts a proxy that intercepts
   * app traffic, which is also required for `device.route()`,
   * `device.waitForRequest()`, and `device.waitForResponse()` to function.
   * Set to `false` to disable network capture and route interception.
   */
  network: boolean
  /**
   * Glob-style host patterns to retain in captured network entries
   * (allowlist). Defaults to `undefined` — keep every captured entry.
   *
   * Matters most for physical iOS devices and Android emulators, where
   * Tapsmith's proxy is system-wide and sees every app's traffic, including
   * OS background services (captive portal checks, analytics, push,
   * iCloud/Google sync). Set an allowlist of hostnames that match the
   * app(s) under test so the trace only keeps relevant entries:
   *
   *     trace: {
   *       mode: 'on',
   *       networkHosts: ['*.myapp.com', 'api.example.com'],
   *     }
   *
   * iOS simulators already filter per-PID (via the macOS Network
   * Extension redirector), so leaving this unset is fine for sim-only
   * runs. On physical iOS and Android emulators, unset = verbose traces
   * with system noise.
   *
   * Patterns use glob semantics: `*` matches one hostname segment,
   * `**` (or a leading `*.`) matches any number. Matching is
   * case-insensitive. See `filterEntriesByHosts` for the exact rules.
   */
  networkHosts?: string[]
  /**
   * Glob-style host patterns to drop from captured network entries
   * (denylist). Defaults to `undefined` — drop nothing.
   *
   * Use this when you want a broad capture (no allowlist) but need to
   * scrub known-noisy hosts — e.g. Android emulator system traffic:
   *
   *     trace: {
   *       mode: 'on',
   *       networkIgnoreHosts: [
   *         'connectivitycheck.gstatic.com',
   *         '*.googleapis.com',
   *         '*.google.com',
   *         'play.googleapis.com',
   *         'mtalk.google.com',
   *         'android.clients.google.com',
   *       ],
   *     }
   *
   * When both `networkHosts` and `networkIgnoreHosts` are set, an entry
   * is kept iff it matches the allowlist AND does NOT match the
   * denylist. Deny wins.
   *
   * Same glob syntax as `networkHosts`.
   */
  networkIgnoreHosts?: string[]
  /**
   * Glob-style host patterns whose TLS connections bypass MITM
   * interception entirely. Defaults to `undefined` — no host-based
   * passthrough.
   *
   * Matching connections are tunneled end-to-end to the real server: the
   * app sees the server's genuine certificate, but Tapsmith cannot
   * capture the traffic and `device.route()` can never match it. Each
   * tunneled connection appears in the trace as a single `CONNECT` entry
   * marked `passthrough`.
   *
   * Use this for hosts the app reaches with certificate pinning or embedded
   * roots, which MITM interception would otherwise break:
   *
   *     trace: {
   *       mode: 'on',
   *       networkPassthroughHosts: ['pinned-api.example.com'],
   *     }
   *
   * HTTP/2 traffic (including gRPC) is intercepted and captured when the
   * client trusts Tapsmith's MITM CA — Firestore on Android does. HTTP/2-capable
   * clients that reject the generated certificate, such as Firestore's iOS SDK
   * with its embedded roots, may be tunneled dynamically and appear as
   * `passthrough`; `firestore.googleapis.com` is tunneled by default on iOS.
   *
   * Patterns match against the TLS SNI hostname with the same glob
   * syntax as `networkHosts`.
   */
  networkPassthroughHosts?: string[]
  /** Additional cleartext HTTP/1.1 or HTTP/2 ports to capture on Android.
   * Ports 80 and 443 are always included. For Firebase emulators, use
   * [8080, 9099, 5001, 9199]. Requires a rootable Android device. */
  networkHttpPorts?: number[]
  /** Whether to stream device logs (Android logcat / iOS simulator syslog). Default: true. */
  deviceLogs: boolean
  /** Whether to stream the tapsmith-core daemon's own logs into the trace. Default: false. */
  daemonLogs: boolean
}

/** Parse a string shorthand or object into a full TraceConfig. */
export function resolveTraceConfig(
  input: TraceMode | Partial<TraceConfig> | undefined | null,
): TraceConfig {
  const defaults: TraceConfig = {
    mode: 'off',
    screenshots: true,
    snapshots: true,
    sources: true,
    attachments: true,
    network: true,
    deviceLogs: true,
    daemonLogs: false,
  };

  // == null also catches explicit `trace: null` from untyped .mjs configs.
  if (input == null) return defaults;

  // `|| 'off'`, not `?? 'off'`: an untyped config's '' or `{ mode: false }`
  // (validateRecordingModes lets both through as off) must resolve to exactly
  // 'off', since consumers test `mode !== 'off'` to arm network capture.
  if (typeof input === 'string') {
    return { ...defaults, mode: input || 'off' };
  }

  // Also keeps an explicit-undefined mode in object form from clobbering the
  // default (mirrors resolveVideoConfig).
  return { ...defaults, ...input, mode: input.mode || 'off' };
}

/**
 * Returns true when a resolved trace config actively wants network capture:
 * tracing is on in some mode AND the network sub-channel hasn't been
 * explicitly disabled. Used by the CLI to tell the daemon whether to
 * pre-arm the physical-iOS MITM proxy — when false, the daemon skips
 * every OCSP/passthrough code path, eliminating the basic-track failure
 * surface for users who just want to run tests on a real phone.
 */
export function isNetworkTracingEnabled(
  input: TraceMode | Partial<TraceConfig> | undefined,
): boolean {
  const resolved = resolveTraceConfig(input);
  return resolved.mode !== 'off' && resolved.network !== false;
}

/**
 * Return the configured `trace.networkHosts` glob allowlist for the
 * PAC script served by the daemon. Returns `[]` when tracing is off or
 * no allowlist is set — the daemon interprets `[]` as "route every
 * host through the proxy".
 */
export function networkHostsForPac(
  input: TraceMode | Partial<TraceConfig> | undefined,
): string[] {
  if (!isNetworkTracingEnabled(input)) return [];
  const resolved = resolveTraceConfig(input);
  return resolved.networkHosts ?? [];
}

/**
 * Return the configured `trace.networkPassthroughHosts` glob list for the
 * daemon's MITM proxy. TLS connections whose SNI matches are tunneled
 * end-to-end without interception (PILOT-231). Returns `[]` when tracing
 * is off or the option is unset — the daemon interprets `[]` as "no
 * host-based passthrough".
 */
export function networkPassthroughHosts(
  input: TraceMode | Partial<TraceConfig> | undefined,
): string[] {
  if (!isNetworkTracingEnabled(input)) return [];
  const resolved = resolveTraceConfig(input);
  return resolved.networkPassthroughHosts ?? [];
}

// ─── Network Types (Phase 6) ───

export interface NetworkEntry {
  /** Request index. */
  index: number
  /** Group name of the device whose proxy captured this request (multi-device tests). */
  deviceId?: string
  /** Action index this request is associated with. */
  actionIndex: number
  /** Timestamp of request start. */
  startTime: number
  /** Start of this test's observation when the request began before this test.
   * Original timestamps, duration, sizes and bodies remain cumulative. */
  observedStartTime?: number
  /** Timestamp of response end, or snapshot time when inFlight. */
  endTime: number
  /** HTTP method. */
  method: string
  /** Full URL. */
  url: string
  /** HTTP status code. */
  status: number
  /** Response content type. */
  contentType: string
  /** Request size in bytes. */
  requestSize: number
  /** Response size in bytes. */
  responseSize: number
  /** Duration in ms (elapsed so far when inFlight). */
  duration: number
  /** Open at capture time. Bodies are frozen, cumulative snapshots, capped at 1 MiB each. */
  inFlight?: boolean
  /** Path to request body file in archive (if large). */
  requestBodyPath?: string
  /** Path to response body file in archive (if large). */
  responseBodyPath?: string
  /** Request headers. */
  requestHeaders: Record<string, string>
  /** Response headers. */
  responseHeaders: Record<string, string>
  /** Request body bytes (transient — not serialized to archive JSON). */
  requestBody?: Buffer
  /** Response body bytes (transient — not serialized to archive JSON). */
  responseBody?: Buffer
  /**
   * How this request was handled by a route: "mocked", "aborted",
   * "continued", "fetched". The special value "passthrough" marks a
   * synthetic per-connection entry for TLS traffic tunneled without MITM
   * (hosts in `trace.networkPassthroughHosts`, clients whose ALPN offers no
   * protocol the proxy speaks, or HTTP/2-capable clients that reject the
   * generated MITM certificate) -- no request/response detail is available
   * for those.
   */
  routeAction?: 'mocked' | 'aborted' | 'continued' | 'fetched' | 'passthrough'
}

// ─── Union type for all events ───

export type AnyTraceEvent =
  | ActionTraceEvent
  | AssertionTraceEvent
  | GroupTraceEvent
  | ConsoleTraceEvent
  | AttachmentTraceEvent
  | ErrorTraceEvent
