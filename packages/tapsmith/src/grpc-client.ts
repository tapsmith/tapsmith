/**
 * gRPC client that connects to the Tapsmith Rust daemon.
 *
 * Wraps all TapsmithService RPCs as typed async methods. The proto file is loaded
 * dynamically via @grpc/proto-loader so no code-gen step is required.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { type Selector, selectorToProto } from './selectors.js';
import { TestAbortedError } from './abort.js';
import { isCurrentAttemptClosed, fencedRejection } from './attempt-fence.js';

// ─── Types mirroring proto messages ───

export interface ElementInfo {
  elementId: string;
  className: string;
  text: string;
  contentDescription: string;
  resourceId: string;
  enabled: boolean;
  visible: boolean;
  clickable: boolean;
  focusable: boolean;
  scrollable: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number };
  hint: string;
  checked: boolean;
  selected: boolean;
  focused: boolean;
  role: string;
  viewportRatio: number;
}

export interface ActionResponse {
  requestId: string;
  success: boolean;
  errorType: string;
  errorMessage: string;
  screenshot: Buffer;
}

export interface FindElementResponse {
  requestId: string;
  found: boolean;
  element?: ElementInfo;
  errorMessage: string;
}

export interface FindElementsResponse {
  requestId: string;
  elements: ElementInfo[];
  errorMessage: string;
}

export interface ScreenshotResponse {
  requestId: string;
  success: boolean;
  data: Buffer;
  errorMessage: string;
}

export interface UiHierarchyResponse {
  requestId: string;
  hierarchyXml: string;
  errorMessage: string;
}

export interface CaptureTraceStateResponse {
  requestId: string;
  success: boolean;
  errorMessage: string;
  screenshotData: Buffer;
  hierarchyXml: string;
  elementFound: boolean;
  element?: ElementInfo;
}

export interface DeviceInfoProto {
  serial: string;
  model: string;
  state: string;
  isEmulator: boolean;
  platform: string;
  /** Human-friendly OS version. Empty when the daemon can't determine it
   * (iOS physical, where CLI-side devicectl enrichment fills it in). */
  osVersion: string;
}

export interface ListDevicesResponse {
  requestId: string;
  devices: DeviceInfoProto[];
}

export interface PingResponse {
  version: string;
  agentConnected: boolean;
}

// ─── Device Management (PILOT-10) ───

export interface GetCurrentPackageResponse {
  requestId: string;
  packageName: string;
}

export interface GetCurrentActivityResponse {
  requestId: string;
  activity: string;
}

export interface GetAppStateResponse {
  requestId: string;
  state: string;
}

export interface GetClipboardResponse {
  requestId: string;
  text: string;
}

export interface GetOrientationResponse {
  requestId: string;
  orientation: string;
}

export interface IsKeyboardShownResponse {
  requestId: string;
  shown: boolean;
}

export interface GetColorSchemeResponse {
  requestId: string;
  scheme: string;
}

// ─── Video Recording (PILOT-114) ───

export interface StopVideoRecordingResponse {
  requestId: string;
  success: boolean;
  /** Host-local path to the finalised MP4. Empty when success is false. */
  videoPath: string;
  errorMessage: string;
  /** Wall-clock duration of the recording in milliseconds. */
  durationMs: number;
}

// ─── Trace Support (PILOT-85) ───

export interface GetLogcatResponse {
  requestId: string;
  logcat: string;
  errorMessage: string;
}

export interface DeviceLogEntry {
  level: string;
  message: string;
  tag: string;
  timestampMs: number;
  pid: number;
}

export interface DaemonLogEntry {
  level: string;
  message: string;
  target: string;
  requestId: string;
  timestampMs: number;
}

export interface WebViewInfo {
  socketName: string;
  pid: number;
  packageName: string;
  url: string;
  title: string;
}

export interface ListWebViewsResponse {
  requestId: string;
  webviews: WebViewInfo[];
  errorMessage: string;
}

export interface ForwardWebViewPortResponse {
  requestId: string;
  success: boolean;
  localPort: number;
  errorMessage: string;
}

export type AppState = 'not_installed' | 'stopped' | 'background' | 'foreground';
export type Orientation = 'portrait' | 'landscape';
export type ColorScheme = 'dark' | 'light';

export interface LaunchAppOptions {
  activity?: string;
  clearData?: boolean;
  waitForIdle?: boolean;
}

export interface OpenDeepLinkOptions {
  /**
   * Skip the warm in-process delivery attempt on iOS simulators and
   * cold-relaunch the app with the URL instead. Use when the deep link must
   * start from a fresh process (e.g. a state-clearing reset between test
   * files). No effect on Android or physical iOS, which always deliver warm.
   */
  forceColdLaunch?: boolean;
}

// ─── App reset (declared isolation) ───

export type AppResetRequestMode = 'warm' | 'restart' | 'clear';

export interface ResetAppRequestOptions {
  mode: AppResetRequestMode;
  /** Escalate warm → restart → clear when a rung fails. */
  allowFallback: boolean;
  /** Legacy explicit reset deep link (`resetAppDeepLink`). */
  resetDeepLink?: string;
  /** Deliver a warm reset cold (terminate + relaunch); set on retry attempts. */
  forceCold?: boolean;
  /** Force a cold relaunch after this many consecutive warm resets (0 = off). */
  coldEveryNResets?: number;
  waitForIdle?: boolean;
  idleTimeoutMs?: number;
  /** Route the reset should land on (default "/"). */
  targetPath?: string;
  /**
   * When warm cannot run (or land), fall back to clear instead of restart.
   * Set by the runner's declared isolation policy — its promise is
   * state-clearing, and a restart keeps persisted data. Explicit
   * `device.resetApp()` calls keep the gentler restart fallback.
   */
  fallbackToClear?: boolean;
}

export interface ResetAppStep {
  name: string;
  durationMs: number;
  ok: boolean;
  detail: string;
}

export interface ResetAppResponse extends ActionResponse {
  modeRequested: string;
  modeUsed: string;
  fellBack: boolean;
  coldLaunch: boolean;
  reason: string;
  durationMs: number;
  hooksDetected: boolean;
  epochBefore: number;
  epochAfter: number;
  steps: ResetAppStep[];
}

const APP_RESET_WIRE_MODE: Record<AppResetRequestMode, string> = {
  warm: 'APP_RESET_MODE_WARM',
  restart: 'APP_RESET_MODE_RESTART',
  clear: 'APP_RESET_MODE_CLEAR',
};

export function appResetModeFromWire(value: string): AppResetRequestMode | undefined {
  return (Object.keys(APP_RESET_WIRE_MODE) as AppResetRequestMode[])
    .find((k) => APP_RESET_WIRE_MODE[k] === value);
}

// ─── Swipe / scroll options exposed to the SDK ───

export interface SwipeOptions {
  speed?: number;
  distance?: number;
  timeoutMs?: number;
}

export interface ScrollOptions {
  scrollUntilVisible?: Selector;
  distance?: number;
  timeoutMs?: number;
}

// ─── Client ───

const PROTO_PATH = (() => {
  const bundled = path.resolve(import.meta.dirname, 'proto/tapsmith.proto');
  if (fs.existsSync(bundled)) return bundled;
  return path.resolve(import.meta.dirname, '../../../proto/tapsmith.proto');
})();
const DEFAULT_ADDRESS = 'localhost:50051';

/**
 * Deadline for cleanup RPCs dispatched after the run has been aborted
 * (PILOT-235). Must stay under the UI server's STOP_GRACE_MS (5s) so a
 * graceful stop can finish cleanup before the SIGKILL escalation lands.
 */
const ABORTED_CLEANUP_DEADLINE_MS = 4_000;

function requestId(): string {
  return crypto.randomUUID();
}

/**
 * gRPC deadline for an element action that can block on the agent for its
 * whole action timeout — the iOS agent waits out a covered target before it
 * fails (PILOT-223). The default 60 s would cut a longer timeout short with
 * DEADLINE_EXCEEDED while the agent is still waiting, and it would then tap
 * in the middle of whatever the test does next.
 */
function actionCallDeadlineMs(timeoutMs: number | undefined): number {
  return Math.max(60_000, (timeoutMs ?? 0) + daemonReadHeadroomMs() + 25_000);
}

/** The daemon's wait for an agent command sent with no timeout. */
const DAEMON_DEFAULT_AGENT_WAIT_MS = 30_000;

/**
 * gRPC deadline for a gesture that takes time of its own after the action
 * timeout (a long press's hold, a double tap's interval): the daemon waits for
 * it on top of the timeout — or on top of its default wait, for a zero one.
 */
function gestureCallDeadlineMs(timeoutMs: number | undefined, gestureMs: number): number {
  const base = timeoutMs && timeoutMs > 0 ? timeoutMs : DAEMON_DEFAULT_AGENT_WAIT_MS;
  return actionCallDeadlineMs(base + gestureMs);
}

/**
 * The headroom the daemon adds to an action's timeout while it waits for the
 * agent (`TAPSMITH_AGENT_READ_HEADROOM_MS`, default 5 s), parsed the way the
 * daemon parses it. The daemon is spawned with this process's environment, so
 * this is the value it uses.
 */
function daemonReadHeadroomMs(): number {
  const raw = process.env.TAPSMITH_AGENT_READ_HEADROOM_MS?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return 5_000;
}

export class TapsmithGrpcClient {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private client: grpc.Client & Record<string, Function>;
  private address: string;
  private _abortSignal?: AbortSignal;

  constructor(address: string = DEFAULT_ADDRESS) {
    this.address = address;
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proto-loader returns untyped package definitions
    const TapsmithService = (proto.tapsmith as any).TapsmithService as grpc.ServiceClientConstructor;
    this.client = new TapsmithService(
      this.address,
      grpc.credentials.createInsecure(),
      {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,  // 64MB
        'grpc.max_send_message_length': 64 * 1024 * 1024,     // 64MB
        'grpc.keepalive_time_ms': 30_000,                      // ping every 30s
        'grpc.keepalive_timeout_ms': 10_000,                   // 10s to respond
        'grpc.keepalive_permit_without_calls': 1,              // ping even when idle
      },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    ) as grpc.Client & Record<string, Function>;
  }

  // ── Helpers ──

  /**
   * @internal Set (or clear) the signal that cancels in-flight unary calls.
   * Set by the runner for the duration of a test file; one client instance
   * serves Device, ElementHandle, and expect, so this single set-point covers
   * every RPC issued by tests and hooks.
   */
  _setAbortSignal(signal: AbortSignal | undefined): void {
    this._abortSignal = signal;
  }

  /** @internal */
  _getAbortSignal(): AbortSignal | undefined {
    return this._abortSignal;
  }

  private call<T>(
    method: string,
    request: Record<string, unknown>,
    deadlineMs?: number,
    opts?: { bypassAbort?: boolean },
  ): Promise<T> {
    const signal = this._abortSignal;
    const bypassAbort = opts?.bypassAbort ?? false;
    if (signal?.aborted && !bypassAbort) return Promise.reject(new TestAbortedError());
    // A test body abandoned by the runner's timeout keeps executing; fence
    // its device RPCs so it cannot drive the device while the retry (or the
    // next test) is running. Cleanup RPCs (bypassAbort) are runner-issued
    // and never originate from a test attempt context, but keep the guard
    // symmetric with the abort check above.
    if (!bypassAbort && isCurrentAttemptClosed()) {
      return fencedRejection<T>(`'${method}'`);
    }
    // Cleanup RPCs (bypassAbort) must still reach the daemon after a stop —
    // they release daemon-held resources (video recorder, network capture)
    // that would otherwise leak past the run and break every later run
    // (PILOT-235). Their post-abort deadline is clamped so a wedged daemon
    // can't stall the stop: it sits under the UI server's 5s SIGKILL
    // escalation grace, giving cleanup a chance to land before the worker
    // is force-killed. (A bypass call already in flight when the abort
    // fires keeps its original deadline; the escalation backstop and the
    // daemon's stale-recording self-heal cover that window.)
    const effectiveDeadlineMs = bypassAbort && signal?.aborted
      ? Math.min(deadlineMs ?? 60_000, ABORTED_CLEANUP_DEADLINE_MS)
      : deadlineMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const deadline = new Date(Date.now() + effectiveDeadlineMs);
      // onAbort is declared before the dispatch so a callback that fires
      // synchronously can reference it without hitting the temporal dead
      // zone. Referencing grpcCall inside onAbort is safe: the abort
      // listener is only registered after grpcCall is initialized below.
      let callbackFired = false;
      const onAbort = (): void => grpcCall.cancel();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic RPC dispatch on proto-loaded client
      const grpcCall = (this.client as any)[method](request, { deadline }, (err: grpc.ServiceError | null, response: T) => {
        callbackFired = true;
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted && !bypassAbort) {
          // After an abort, no call settles successfully — even if the
          // response won the race against cancel() — and any error
          // (CANCELLED or otherwise) is normalized so callers see one
          // distinguishable type.
          reject(new TestAbortedError());
        } else if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      }) as grpc.ClientUnaryCall;
      // No abort race here: AbortController.abort() can only run between
      // tasks, never midway through this synchronous block (and an
      // already-aborted signal was rejected before the Promise was built).
      // The callbackFired guard keeps a synchronously-settled call from
      // registering a listener it would never remove. Bypass calls never
      // register: an abort must not cancel cleanup.
      if (signal && !bypassAbort && !callbackFired) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private selectorProto(selector: Selector): Record<string, unknown> {
    return selectorToProto(selector);
  }

  /**
   * Target fields for an element action: by selector, or by the agent-cached
   * `elementId`. When `elementId` is set the agent acts on that exact
   * previously-found element instead of re-finding by selector — this is how a
   * positional/filtered handle addresses the specific element it resolved.
   */
  private actionTarget(selector: Selector | undefined, elementId: string | undefined): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (elementId) fields.elementId = elementId;
    if (selector) fields.selector = this.selectorProto(selector);
    return fields;
  }

  // ── RPCs ──

  async findElement(selector: Selector, timeoutMs?: number): Promise<FindElementResponse> {
    return this.call<FindElementResponse>('findElement', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async findElements(selector: Selector, timeoutMs?: number): Promise<FindElementsResponse> {
    return this.call<FindElementsResponse>('findElements', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async tap(selector: Selector | undefined, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('tap', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    }, actionCallDeadlineMs(timeoutMs));
  }

  async longPress(selector: Selector | undefined, durationMs?: number, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('longPress', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      durationMs: durationMs ?? 0,
      timeoutMs: timeoutMs ?? 0,
    }, gestureCallDeadlineMs(timeoutMs, durationMs || 1_000));
  }

  async typeText(selector: Selector | undefined, text: string, timeoutMs?: number, typingDelayMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('typeText', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      text,
      timeoutMs: timeoutMs ?? 0,
      typingDelayMs: typingDelayMs ?? 0,
    }, actionCallDeadlineMs(timeoutMs));
  }

  async clearText(selector: Selector | undefined, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('clearText', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    }, actionCallDeadlineMs(timeoutMs));
  }

  async clearAndType(selector: Selector | undefined, text: string, timeoutMs?: number, typingDelayMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('clearAndType', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      text,
      timeoutMs: timeoutMs ?? 0,
      typingDelayMs: typingDelayMs ?? 0,
    }, actionCallDeadlineMs(timeoutMs));
  }

  async swipe(direction: string, options?: SwipeOptions): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      direction,
      speed: options?.speed ?? 2000,
      distance: options?.distance ?? 0.6,
    };
    if (options?.timeoutMs != null) request.timeoutMs = options.timeoutMs;
    return this.call<ActionResponse>('swipe', request);
  }

  async tapXY(x: number, y: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('tapCoordinates', {
      requestId: requestId(),
      x,
      y,
    });
  }

  async longPressXY(x: number, y: number, durationMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('longPressCoordinates', {
      requestId: requestId(),
      x,
      y,
      durationMs: durationMs ?? 0,
    });
  }

  async dragXY(fromX: number, fromY: number, toX: number, toY: number, durationMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('dragCoordinates', {
      requestId: requestId(),
      fromX,
      fromY,
      toX,
      toY,
      durationMs: durationMs ?? 0,
    });
  }

  async inputText(text: string, typingDelayMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('inputText', {
      requestId: requestId(),
      text,
      typingDelayMs: typingDelayMs ?? 0,
    });
  }

  async touchDown(x: number, y: number, tMs = 0): Promise<ActionResponse> {
    return this.call<ActionResponse>('touchDown', { requestId: requestId(), x, y, tMs });
  }

  async touchMove(x: number, y: number, tMs = 0): Promise<ActionResponse> {
    return this.call<ActionResponse>('touchMove', { requestId: requestId(), x, y, tMs });
  }

  async touchUp(x: number, y: number, tMs = 0): Promise<ActionResponse> {
    return this.call<ActionResponse>('touchUp', { requestId: requestId(), x, y, tMs });
  }

  async touchCancel(): Promise<ActionResponse> {
    return this.call<ActionResponse>('touchCancel', { requestId: requestId() });
  }

  async scroll(
    container: Selector | undefined,
    direction: string,
    options?: ScrollOptions & { elementId?: string },
  ): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      direction,
    };
    if (options?.elementId) request.elementId = options.elementId;
    else if (container) request.container = this.selectorProto(container);
    if (options?.scrollUntilVisible) {
      request.scrollUntilVisible = this.selectorProto(options.scrollUntilVisible);
    }
    if (options?.distance != null) request.distance = options.distance;
    if (options?.timeoutMs != null) request.timeoutMs = options.timeoutMs;
    return this.call<ActionResponse>('scroll', request);
  }

  async pressKey(key: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('pressKey', {
      requestId: requestId(),
      key,
    });
  }

  async takeScreenshot(): Promise<ScreenshotResponse> {
    return this.call<ScreenshotResponse>('takeScreenshot', {
      requestId: requestId(),
    });
  }

  async getUiHierarchy(deadlineMs?: number): Promise<UiHierarchyResponse> {
    return this.call<UiHierarchyResponse>('getUiHierarchy', {
      requestId: requestId(),
    }, deadlineMs);
  }

  async captureTraceState(options: {
    screenshot?: boolean;
    hierarchy?: boolean;
    elementSelector?: Selector;
  }): Promise<CaptureTraceStateResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      screenshot: options.screenshot ?? false,
      hierarchy: options.hierarchy ?? false,
    };
    if (options.elementSelector) {
      request.elementSelector = this.selectorProto(options.elementSelector);
    }
    return this.call<CaptureTraceStateResponse>('captureTraceState', request, 5_000);
  }

  async waitForIdle(timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('waitForIdle', {
      requestId: requestId(),
      timeoutMs: timeoutMs ?? 0,
      // Cold app launches on loaded CI runners legitimately exceed the 60s
      // default call deadline; keep comfortable headroom over the requested
      // idle wait so the daemon's own timeout reports first.
    }, Math.max(120_000, (timeoutMs ?? 0) + 30_000));
  }

  async installApk(apkPath: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('installApk', {
      requestId: requestId(),
      apkPath,
    }, 120_000);
  }

  async listDevices(deadlineMs?: number): Promise<ListDevicesResponse> {
    return this.call<ListDevicesResponse>('listDevices', {
      requestId: requestId(),
    }, deadlineMs);
  }

  async setDevice(
    serial: string,
    networkTracingEnabled = false,
    networkHosts: string[] = [],
    passthroughHosts: string[] = [],
  ): Promise<ActionResponse> {
    return this.call<ActionResponse>('setDevice', {
      requestId: requestId(),
      serial,
      networkTracingEnabled,
      networkHosts,
      passthroughHosts,
    }, 120_000);
  }

  async startAgent(
    targetPackage: string,
    agentApkPath?: string,
    agentTestApkPath?: string,
    iosXctestrunPath?: string,
    iosAppPath?: string,
    networkTracingEnabled = false,
  ): Promise<ActionResponse> {
    return this.call<ActionResponse>('startAgent', {
      requestId: requestId(),
      targetPackage,
      agentApkPath: agentApkPath ?? '',
      agentTestApkPath: agentTestApkPath ?? '',
      iosXctestrunPath: iosXctestrunPath ?? '',
      iosAppPath: iosAppPath ?? '',
      networkTracingEnabled,
      // Must comfortably exceed the daemon's internal agent-launch wait (150s
      // in agent_launch.rs) plus simulator configuration around it, so the
      // daemon's clean, retryable failure text reaches us instead of a bare
      // DEADLINE_EXCEEDED.
    }, 240_000);
  }

  async ping(): Promise<PingResponse> {
    return this.call<PingResponse>('ping', {});
  }

  // ── Element Actions (PILOT-2) ──

  async doubleTap(selector: Selector | undefined, timeoutMs?: number, intervalMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('doubleTap', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
      intervalMs: intervalMs ?? 0,
    }, gestureCallDeadlineMs(timeoutMs, (intervalMs || 100) + 100));
  }

  async dragAndDrop(
    source: Selector | undefined,
    target: Selector | undefined,
    timeoutMs?: number,
    ids?: { sourceElementId?: string; targetElementId?: string },
  ): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      timeoutMs: timeoutMs ?? 0,
    };
    if (ids?.sourceElementId) request.sourceElementId = ids.sourceElementId;
    else if (source) request.sourceSelector = this.selectorProto(source);
    if (ids?.targetElementId) request.targetElementId = ids.targetElementId;
    else if (target) request.targetSelector = this.selectorProto(target);
    return this.call<ActionResponse>('dragAndDrop', request);
  }

  async selectOption(
    selector: Selector | undefined,
    option: string | { index: number },
    timeoutMs?: number,
    elementId?: string,
  ): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    };
    if (typeof option === 'string') {
      request.option = option;
    } else {
      request.index = option.index;
    }
    return this.call<ActionResponse>('selectOption', request);
  }

  async pinchZoom(selector: Selector | undefined, scale: number, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('pinchZoom', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      scale,
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async focus(selector: Selector | undefined, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('focus', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    }, actionCallDeadlineMs(timeoutMs));
  }

  async blur(selector: Selector | undefined, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('blur', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async highlight(selector: Selector | undefined, durationMs?: number, timeoutMs?: number, elementId?: string): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    };
    if (durationMs != null) request.durationMs = durationMs;
    return this.call<ActionResponse>('highlight', request);
  }

  async takeElementScreenshot(selector: Selector | undefined, timeoutMs?: number, elementId?: string): Promise<ScreenshotResponse> {
    return this.call<ScreenshotResponse>('takeElementScreenshot', {
      requestId: requestId(),
      ...this.actionTarget(selector, elementId),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  // ── Device Management (PILOT-10) ──

  async resetApp(packageName: string, options: ResetAppRequestOptions): Promise<ResetAppResponse> {
    // The daemon may walk the whole ladder (warm deep link incl. its cold
    // fallback and re-deliveries, then restart, then clear + relaunch); keep
    // the deadline above that budget so the client gets a structured answer.
    return this.call<ResetAppResponse>('resetApp', {
      requestId: requestId(),
      packageName,
      mode: APP_RESET_WIRE_MODE[options.mode],
      allowFallback: options.allowFallback,
      resetDeepLink: options.resetDeepLink ?? '',
      forceCold: options.forceCold ?? false,
      coldEveryNResets: options.coldEveryNResets ?? 0,
      waitForIdle: options.waitForIdle ?? true,
      idleTimeoutMs: options.idleTimeoutMs ?? 0,
      targetPath: options.targetPath ?? '/',
      fallbackToClear: options.fallbackToClear ?? false,
    }, 600_000);
  }

  async restartApp(packageName: string, waitForIdle = true): Promise<ActionResponse> {
    return this.call<ActionResponse>('restartApp', {
      requestId: requestId(),
      packageName,
      waitForIdle,
    }, 120_000);
  }

  async launchApp(packageName: string, options?: LaunchAppOptions): Promise<ActionResponse> {
    return this.call<ActionResponse>('launchApp', {
      requestId: requestId(),
      packageName,
      activity: options?.activity ?? '',
      clearData: options?.clearData ?? false,
      waitForIdle: options?.waitForIdle ?? true,
    }, 120_000);
  }

  async openDeepLink(uri: string, options?: OpenDeepLinkOptions): Promise<ActionResponse> {
    // iOS simulator deep links try a warm in-process delivery first (bounded
    // at 8s), then can terminate + cold-launch the app, accept the "Open in
    // <app>?" prompt, and re-deliver up to 3 times if the first cold,
    // trust-gated openurl doesn't foreground the app — that path's worst
    // case is ~148s (8s warm attempt + 3 × (terminate 4s + 28s prompt timeout
    // + 13s verify) + sleeps). On top of that, a dead-compositor detection
    // escalates once per session to a full simulator reboot + agent restart,
    // which took ~4 minutes on a CI runner with CoreSimulator under pressure
    // (every step daemon-side is individually bounded, so the call does
    // terminate). Keep this deadline above the whole recovery budget so the
    // client gets the daemon's clean retryable error — or the recovered
    // success — never a bare DEADLINE_EXCEEDED for a call the daemon is
    // still processing.
    return this.call<ActionResponse>('openDeepLink', {
      requestId: requestId(),
      uri,
      forceColdLaunch: options?.forceColdLaunch ?? false,
    }, 420_000);
  }

  async getCurrentPackage(): Promise<GetCurrentPackageResponse> {
    return this.call<GetCurrentPackageResponse>('getCurrentPackage', {
      requestId: requestId(),
    });
  }

  async getCurrentActivity(): Promise<GetCurrentActivityResponse> {
    return this.call<GetCurrentActivityResponse>('getCurrentActivity', {
      requestId: requestId(),
    });
  }

  async terminateApp(packageName: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('terminateApp', {
      requestId: requestId(),
      packageName,
    });
  }

  async getAppState(packageName: string, deadlineMs?: number): Promise<GetAppStateResponse> {
    return this.call<GetAppStateResponse>('getAppState', {
      requestId: requestId(),
      packageName,
    }, deadlineMs);
  }

  async clearAppData(packageName: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('clearAppData', {
      requestId: requestId(),
      packageName,
    });
  }

  async grantPermission(packageName: string, permission: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('grantPermission', {
      requestId: requestId(),
      packageName,
      permission,
    });
  }

  async revokePermission(packageName: string, permission: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('revokePermission', {
      requestId: requestId(),
      packageName,
      permission,
    });
  }

  async setClipboard(text: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('setClipboard', {
      requestId: requestId(),
      text,
    });
  }

  async getClipboard(): Promise<GetClipboardResponse> {
    return this.call<GetClipboardResponse>('getClipboard', {
      requestId: requestId(),
    });
  }

  async setOrientation(orientation: Orientation): Promise<ActionResponse> {
    return this.call<ActionResponse>('setOrientation', {
      requestId: requestId(),
      orientation,
    });
  }

  async getOrientation(): Promise<GetOrientationResponse> {
    return this.call<GetOrientationResponse>('getOrientation', {
      requestId: requestId(),
    });
  }

  async isKeyboardShown(): Promise<IsKeyboardShownResponse> {
    return this.call<IsKeyboardShownResponse>('isKeyboardShown', {
      requestId: requestId(),
    });
  }

  async hideKeyboard(): Promise<ActionResponse> {
    return this.call<ActionResponse>('hideKeyboard', {
      requestId: requestId(),
    });
  }

  async openNotifications(): Promise<ActionResponse> {
    return this.call<ActionResponse>('openNotifications', {
      requestId: requestId(),
    });
  }

  async openQuickSettings(): Promise<ActionResponse> {
    return this.call<ActionResponse>('openQuickSettings', {
      requestId: requestId(),
    });
  }

  async setColorScheme(scheme: ColorScheme): Promise<ActionResponse> {
    return this.call<ActionResponse>('setColorScheme', {
      requestId: requestId(),
      scheme,
    });
  }

  async getColorScheme(): Promise<GetColorSchemeResponse> {
    return this.call<GetColorSchemeResponse>('getColorScheme', {
      requestId: requestId(),
    });
  }

  async wakeDevice(): Promise<ActionResponse> {
    return this.call<ActionResponse>('wakeDevice', {
      requestId: requestId(),
    });
  }

  async unlockDevice(): Promise<ActionResponse> {
    return this.call<ActionResponse>('unlockDevice', {
      requestId: requestId(),
    });
  }

  // ── Trace Support (PILOT-85) ──

  async startNetworkCapture(options?: { requireIsolation?: boolean; httpPorts?: number[] }): Promise<{ success: boolean; proxyPort: number; errorMessage: string }> {
    return this.call('startNetworkCapture', {
      requestId: requestId(),
      requireIsolation: options?.requireIsolation ?? false,
      httpPorts: options?.httpPorts ?? [],
    });
  }

  async stopNetworkCapture(options?: { keepRunning?: boolean }): Promise<{
    success: boolean;
    entries: Array<{
      method: string;
      url: string;
      statusCode: number;
      contentType: string;
      requestSize: number;
      responseSize: number;
      startTimeMs: number;
      durationMs: number;
      requestHeadersJson: string;
      responseHeadersJson: string;
      requestBody: Buffer;
      responseBody: Buffer;
      isHttps: boolean;
      routeAction: string;
      inFlight: boolean;
      captureId?: string;
      requestBodyOmitted?: boolean;
      responseBodyOmitted?: boolean;
    }>;
    errorMessage: string;
  }> {
    // bypassAbort: stopping capture is cleanup — it must reach the daemon
    // even when the run was stopped, or the proxy keeps capturing into a
    // session nobody will drain (PILOT-235).
    return this.call('stopNetworkCapture', {
      requestId: requestId(),
      keepRunning: options?.keepRunning ?? false,
    }, 30_000, { bypassAbort: true });
  }

  async snapshotNetworkCapture(knownBodies: Array<{ captureId: string; requestBodySize: number; responseBodySize: number }> = []): ReturnType<TapsmithGrpcClient['stopNetworkCapture']> {
    return this.call('snapshotNetworkCapture', { requestId: requestId(), knownBodies, incrementalBodies: true }, 10_000);
  }

  // ── Video Recording (PILOT-114) ──

  async startVideoRecording(options?: { size?: { width: number; height: number } }): Promise<ActionResponse> {
    return this.call<ActionResponse>('startVideoRecording', {
      requestId: requestId(),
      sizeWidth: options?.size?.width ?? 0,
      sizeHeight: options?.size?.height ?? 0,
    });
  }

  async stopVideoRecording(): Promise<StopVideoRecordingResponse> {
    // Stopping a recording can take several seconds while ffmpeg / simctl
    // flushes the MOOV atom and adb pulls the file off the device. Keep
    // the deadline generous so we don't surface spurious DEADLINE_EXCEEDED
    // errors during teardown of legitimately-large recordings.
    // bypassAbort: a stopped run must still stop its recorder, or the
    // orphan blocks video for every later run until the daemon restarts
    // (PILOT-235). Post-abort the deadline is clamped instead.
    return this.call<StopVideoRecordingResponse>('stopVideoRecording', {
      requestId: requestId(),
    }, 60_000, { bypassAbort: true });
  }

  // ── Physical iOS device network profile (PILOT-185) ──

  async generateIosNetworkProfile(args: {
    udid: string
    ssid?: string
    deviceName?: string
  }): Promise<{
    success: boolean
    errorMessage: string
    profilePath: string
    hostIp: string
    port: number
    ssid: string
  }> {
    return this.call('generateIosNetworkProfile', {
      requestId: requestId(),
      udid: args.udid,
      ssid: args.ssid ?? '',
      deviceName: args.deviceName ?? '',
    });
  }

  // ── App State Snapshot (PILOT-115) ──

  async saveAppState(packageName: string, path: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('saveAppState', {
      requestId: requestId(),
      packageName,
      path,
    }, 300_000);
  }

  async restoreAppState(packageName: string, path: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('restoreAppState', {
      requestId: requestId(),
      packageName,
      path,
    }, 300_000);
  }

  async getLogcat(packageName: string, sinceMs?: number, untilMs?: number): Promise<GetLogcatResponse> {
    return this.call<GetLogcatResponse>('getLogcat', {
      requestId: requestId(),
      packageName,
      sinceMs: sinceMs ?? 0,
      untilMs: untilMs ?? 0,
    });
  }

  // ── Device Log Streaming (PILOT-193) ──

  /**
   * Open a server-side streaming RPC for device log streaming.
   * Cancel the returned stream to stop.
   * @internal
   */
  deviceLogStream(packageName: string): grpc.ClientReadableStream<DeviceLogEntry> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic RPC dispatch on proto-loaded client
    return (this.client as any).streamDeviceLogs({
      requestId: requestId(),
      packageName,
    }) as grpc.ClientReadableStream<DeviceLogEntry>;
  }

  /**
   * Open a server-side streaming RPC for daemon log streaming.
   * Cancel the returned stream to stop.
   * @internal
   */
  daemonLogStream(): grpc.ClientReadableStream<DaemonLogEntry> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic RPC dispatch on proto-loaded client
    return (this.client as any).streamDaemonLogs({
      requestId: requestId(),
    }) as grpc.ClientReadableStream<DaemonLogEntry>;
  }

  // ── Network Route Interception ──

  /**
   * Open a bidirectional streaming RPC for network route interception.
   * Returns a duplex stream for sending/receiving route messages.
   * @internal
   */
  networkRouteStream(): grpc.ClientDuplexStream<unknown, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic RPC dispatch on proto-loaded client
    return (this.client as any).networkRoute() as grpc.ClientDuplexStream<unknown, unknown>;
  }

  // ── WebView Testing (PILOT-116) ──

  async listWebViews(deadlineMs?: number): Promise<ListWebViewsResponse> {
    return this.call<ListWebViewsResponse>('listWebViews', {
      requestId: requestId(),
    }, deadlineMs);
  }

  async forwardWebViewPort(socketName: string, deadlineMs?: number): Promise<ForwardWebViewPortResponse> {
    return this.call<ForwardWebViewPortResponse>('forwardWebViewPort', {
      requestId: requestId(),
      socketName,
    }, deadlineMs);
  }

  async closeWebViewPort(localPort: number, deadlineMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('closeWebViewPort', {
      requestId: requestId(),
      localPort,
    }, deadlineMs);
  }

  // ── Lifecycle ──

  close(): void {
    this.client.close();
  }

  /**
   * Wait until the daemon is reachable (up to `timeoutMs`).
   * Resolves `true` if connected, `false` on timeout.
   */
  async waitForReady(timeoutMs: number = 5000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- waitForReady is on grpc.Client but not in the TS type surface
      (this.client as any).waitForReady(deadline, (err: Error | null) => {
        resolve(!err);
      });
    });
  }
}
