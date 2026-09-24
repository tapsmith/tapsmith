/**
 * Device — the primary user-facing API for interacting with a mobile device.
 *
 * All methods accept a Selector and delegate to the Rust daemon via gRPC.
 * Auto-waiting is handled daemon-side; the SDK just passes the configured
 * timeout.
 */

import {
  type Selector,
  _text,
  _textContains,
  _role,
  _contentDesc,
  _hint,
  _testId,
  _label,
} from './selectors.js';
import * as grpc from '@grpc/grpc-js';
import {
  TapsmithGrpcClient,
  type ActionResponse,
  type ScreenshotResponse,
  type LaunchAppOptions,
  type OpenDeepLinkOptions,
  type AppState,
  type Orientation,
  type ColorScheme,
  type DeviceLogEntry,
  type CaptureTraceStateResponse,
  type DaemonLogEntry, type ResetAppRequestOptions, type ResetAppResponse } from './grpc-client.js';
import * as nodePath from 'node:path';
import { ElementHandle, locatorOptionsToSelector, type LocatorOptions } from './element-handle.js';
import { withActionProgress } from './action-progress.js';
import { DEFAULT_APP_RESET_COLD_EVERY, type TapsmithConfig } from './config.js';
import { Tracing } from './trace/tracing.js';
import { type TraceCollector, getActiveTraceCollector, extractStack } from './trace/trace-collector.js';
import type { ActionCategory, ConsoleLevel, NetworkCaptureRoute } from './trace/types.js';
import { tracedAction, type TracedActionExtra } from './trace/traced-action.js';
import { appResetModeFromWire } from './grpc-client.js';
import {
  NetworkRouteManager,
  type TapsmithRequest,
  type Route,
  type NetworkResponseEventData,
  matchUrlPattern,
} from './network.js';
import { WebViewHandle } from './webview-handle.js';
import type { WebKitInspectorClient } from './webkit-inspector.js';
import type { Platform } from './config.js';

type CaptureTraceStateOptions = {
  screenshot?: boolean;
  hierarchy?: boolean;
  elementSelector?: Selector;
};

const WEBVIEW_RPC_TIMEOUT_MS = 5_000;
const WEBVIEW_RETRY_INTERVAL_MS = 500;
/** Quick liveness probe (`1`) for a freshly connected WebView page — a dead
 * webinspectord target accepts the connection but never answers evaluates. */
const WEBVIEW_PAGE_PROBE_TIMEOUT_MS = 3_000;
const WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;
const WEBVIEW_CONNECT_LOG_LIMIT = 80;

type WebViewInfo = Awaited<ReturnType<TapsmithGrpcClient['listWebViews']>>['webviews'][number];

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function sleepUpTo(ms: number, deadline: number): Promise<void> {
  const timeout = Math.min(ms, remainingMs(deadline));
  if (timeout <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, timeout));
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) {
    throw new Error(`${label} timed out`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendWebViewConnectLog(log: string[] | undefined, message: string): void {
  if (!log) return;
  if (log.length < WEBVIEW_CONNECT_LOG_LIMIT) {
    log.push(message);
  } else if (log.length === WEBVIEW_CONNECT_LOG_LIMIT) {
    log.push('Further WebView connection logs omitted');
  }
}

function webViewMatchesPackage(webview: WebViewInfo, packageName: string): boolean {
  return webview.packageName === packageName || webview.packageName.startsWith(`${packageName}:`);
}

function describeWebView(webview: WebViewInfo): string {
  const packageName = webview.packageName || 'unknown package';
  const pid = webview.pid ? `pid ${webview.pid}` : 'unknown pid';
  return `${webview.socketName} (${pid}, ${packageName})`;
}

/** WIRApplicationIdentifierKey is "PID:<n>" — extract n for newest-first ordering. */
function inspectorAppPid(appId: string): number {
  const match = /(\d+)/.exec(appId);
  return match ? Number(match[1]) : -1;
}

// ─── Types for device-level actions ───

/** Options for `device.swipe()`. */
export interface SwipeOptions {
  /** Swipe speed in pixels/second. Default `2000`. */
  speed?: number;
  /** Fraction of the screen to swipe across, 0–1. Default `0.6`. */
  distance?: number;
  /** Per-action timeout. Defaults to the device default. */
  timeoutMs?: number;
}

export class Device {
  /** @internal */
  readonly _client: TapsmithGrpcClient;
  private _defaultTimeoutMs: number;
  private _appResetColdEvery: number;
  private readonly defaultPackageName?: string;
  /** @internal */
  readonly _platform: Platform;
  /** @internal — Simulator UDID for iOS WebView connections. */
  readonly _simulatorUdid?: string;
  /** @internal — Serial of the explicitly selected device (for iOS simulators
   * this is the UDID). Set by setDevice(); preferred over `_simulatorUdid`
   * (usually a device NAME from config) for inspector-socket discovery. */
  private _deviceSerial?: string;

  /** Programmatic tracing API. */
  readonly tracing: Tracing;

  /**
   * @internal — Group name of this device in a multi-device test (`alice`,
   * `device-2`). Stamped as `deviceId` on every trace event it produces so a
   * shared trace can tell the devices apart. Unset for single-device runs.
   */
  _traceDeviceId?: string;

  /** @internal — Cached device info from the daemon (model, osVersion, etc.). */
  _cachedDeviceInfo: { model?: string; osVersion?: string; isEmulator?: boolean } | null = null;

  /** @internal — Network route manager (lazily created). */
  _routeManager: NetworkRouteManager | null = null;
  private _networkCaptureActive = false;
  /**
   * Whether network capture was ever started this session. The runner keeps
   * the proxy alive across files (stable port for warm-reset-persisted apps),
   * so `close()` is the point that releases it — but only when capture was
   * actually used, to avoid a wasted teardown RPC on non-network runs.
   */
  private _networkCaptureEverStarted = false;
  private _networkCaptureError: string | undefined;
  /**
   * @internal — How the last successful capture start routed this device's
   * traffic (recorded per device in trace metadata). Undefined when capture
   * is not running or the daemon predates route reporting.
   */
  _networkCaptureRoute: NetworkCaptureRoute | undefined;
  /** Set by the runner on retry attempts — see _setForceColdDeepLinks. */
  private _forceColdDeepLinks = false;

  /** @internal — Active WebView handle, if in WebView context. */
  _activeWebView: WebViewHandle | null = null;

  /** @internal — Cached WebView handle kept alive across native()/webview() switches. */
  private _cachedWebView: WebViewHandle | null = null;
  private _webviewGeneration = 0;

  /** @internal — Active device log stream. */
  private _logStream: grpc.ClientReadableStream<DeviceLogEntry> | null = null;
  private _logStreamCollector: TraceCollector | null = null;
  private _daemonLogStream: grpc.ClientReadableStream<DaemonLogEntry> | null = null;
  private _daemonLogStreamCollector: TraceCollector | null = null;

  private _typingDelayMs: number;
  private _doubleTapIntervalMs: number;

  constructor(client: TapsmithGrpcClient, config?: Partial<Pick<TapsmithConfig, 'timeout' | 'package' | 'platform' | 'simulator' | 'typingDelay' | 'doubleTapInterval' | 'appResetColdEvery'>>) {
    this._client = client;
    this._defaultTimeoutMs = config?.timeout ?? 30_000;
    this._appResetColdEvery = config?.appResetColdEvery ?? DEFAULT_APP_RESET_COLD_EVERY;
    this._typingDelayMs = config?.typingDelay ?? 0;
    this._doubleTapIntervalMs = config?.doubleTapInterval ?? 0;
    this.defaultPackageName = config?.package;
    this._platform = config?.platform ?? 'android';
    this._simulatorUdid = config?.simulator;
    this.tracing = new Tracing(
      () => this._takeScreenshotBuffer(),
      () => this._captureHierarchy(),
    );
  }

  /**
   * The platform this device is running — `'android'` or `'ios'`. Useful for
   * branching on platform-specific behaviour in tests (e.g. soft-keyboard
   * handling or native dialog labels).
   */
  get platform(): Platform {
    return this._platform;
  }

  private _ensureRouteManager(): NetworkRouteManager {
    if (!this._routeManager) {
      this._routeManager = new NetworkRouteManager(this._client);
    }
    return this._routeManager;
  }

  /**
   * @internal — Get the current default timeout. Used by the runner for test.use().
   * Not safe for concurrent use — relies on the runner's one-device-per-worker model.
   */
  _getDefaultTimeout(): number {
    return this._defaultTimeoutMs;
  }

  /** @internal — Override the default timeout. Used by the runner for test.use(). */
  _setDefaultTimeout(timeoutMs: number): void {
    this._defaultTimeoutMs = timeoutMs;
  }

  /** @internal */
  _getAppResetColdEvery(): number {
    return this._appResetColdEvery;
  }

  /**
   * @internal — the runner applies a scope's `test.use({ appResetColdEvery })`
   * here so explicit `device.resetApp()` calls inside that scope honour it
   * like the runner's own resets do.
   */
  _setAppResetColdEvery(n: number): void {
    this._appResetColdEvery = n;
  }

  /** @internal — Get the active trace collector, if any. */
  private get _traceCollector(): TraceCollector | null {
    return this.tracing._currentCollector ?? getActiveTraceCollector();
  }

  /** @internal — Take a screenshot and return the raw buffer. */
  private async _takeScreenshotBuffer(): Promise<Buffer | undefined> {
    try {
      const res = await this._client.takeScreenshot();
      return res.success ? res.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * @internal — Best-effort WebView DOM dump for the UI-mode live element
   * picker, so picking inside a WebView suggests `webview.*` locators even
   * when no test session has called `device.webview()`. Untraced (no
   * collector events) and leaves `_activeWebView` untouched; the underlying
   * connection is cached, so repeated polls are cheap.
   *
   * Returns `undefined` when the hierarchy shows no WebView on screen
   * (cheap check, safe to call every poll) and `null` when a WebView is
   * present but connecting/dumping failed (callers should back off — the
   * connect attempt spins until the configured timeout).
   */
  async _dumpWebViewDomForInspection(hierarchyXml: string): Promise<string | null | undefined> {
    const marker = this._platform === 'ios' ? 'XCUIElementTypeWebView' : 'android.webkit.WebView';
    if (!hierarchyXml.includes(marker)) return undefined;
    // _establishWebView (unlike _connectWebView) never writes _activeWebView,
    // so a poll cannot clobber a handle a concurrent test session activated.
    // Captured outside attempt() so the connected handle stays disposable even
    // if something between connect and dump throws — disposal must not depend
    // on _dumpDomHierarchy's (current) never-throws contract.
    let activeHandle: WebViewHandle | undefined;
    const attempt = async (): Promise<string | undefined> => {
      const handle = await this._establishWebView();
      activeHandle = handle;
      return handle._dumpDomHierarchy();
    };
    // Dispose a connection whose dump failed: it can be "alive" (socket open)
    // yet bound to a page that no longer exists — e.g. the WebView remounted
    // when the user navigated away and back. Never close a handle a test
    // session is actively using.
    const dispose = () => {
      const handle = activeHandle;
      activeHandle = undefined;
      if (handle && this._activeWebView !== handle && this._cachedWebView === handle) {
        this._cachedWebView = null;
        handle.close().catch(() => {});
        return true;
      }
      return false;
    };
    const debug = (msg: string) => {
      if (process.env.TAPSMITH_DEBUG_WEBVIEW) console.error(`[webview-inspect] ${msg}`);
    };
    try {
      const dom = await attempt();
      if (dom !== undefined) return dom;
      debug('first dump returned undefined');
    } catch (err) {
      debug(`first attempt threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!dispose()) return null;
    debug('disposed stale handle; retrying with a fresh connect');
    // The first attempt likely reused a stale cached connection — retry once
    // with a fresh connect (which probes pages) before reporting failure.
    try {
      const dom = await attempt();
      if (dom !== undefined) return dom;
      debug('second dump returned undefined');
    } catch (err) {
      debug(`second attempt threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    dispose();
    return null;
  }

  private async _appendActiveWebViewDom(xml: string | undefined): Promise<string | undefined> {
    if (!xml || !this._activeWebView) return xml;
    try {
      const webviewDom = await this._activeWebView._dumpDomHierarchy();
      if (webviewDom) {
        const lastClose = xml.lastIndexOf('</');
        if (lastClose !== -1) {
          return xml.slice(0, lastClose) + webviewDom + '\n' + xml.slice(lastClose);
        }
      }
    } catch { /* best-effort */ }
    return xml;
  }

  /** @internal — Capture the view hierarchy XML, including WebView DOM when active. */
  private async _captureHierarchy(): Promise<string | undefined> {
    try {
      const res = await this._client.getUiHierarchy();
      return await this._appendActiveWebViewDom(res.hierarchyXml || undefined);
    } catch {
      return undefined;
    }
  }

  /** @internal — Capture batched trace state, preserving WebView DOM hierarchy enrichment. */
  private async _captureTraceState(options: CaptureTraceStateOptions): Promise<CaptureTraceStateResponse> {
    const res = await this._client.captureTraceState(options);
    if (options.hierarchy && res.hierarchyXml) {
      return {
        ...res,
        hierarchyXml: await this._appendActiveWebViewDom(res.hierarchyXml) ?? res.hierarchyXml,
      };
    }
    return res;
  }

  /** @internal — Run an action RPC and throw on failure. */
  /**
   * @internal — Wrap an action with trace recording (before/after screenshots + hierarchy).
   */
  private async _tracedAction(
    action: string,
    category: ActionCategory,
    selector: Selector | undefined,
    fn: () => Promise<ActionResponse>,
    fallbackMsg: string,
    extra?: TracedActionExtra,
  ): Promise<void> {
    const collector = this._traceCollector;
    const ctx = collector ? {
      collector,
      deviceId: this._traceDeviceId,
      takeScreenshot: () => this._takeScreenshotBuffer(),
      captureHierarchy: () => this._captureHierarchy(),
      findElement: (sel: Selector, timeout: number) => this._client.findElement(sel, timeout),
      ...(this._platform === 'ios' ? {
        captureTraceState: (opts: CaptureTraceStateOptions) => this._captureTraceState(opts),
      } : {}),
    } : undefined;
    return tracedAction(ctx, action, category, selector, fn, fallbackMsg, extra);
  }

  // ── Locators (Playwright-style getBy* methods) ──

  /**
   * Locate an element by visible text. Substring match by default; pass
   * `{ exact: true }` for an exact match.
   */
  getByText(text: string, options?: { exact?: boolean }): ElementHandle {
    return this._handle(options?.exact ? _text(text) : _textContains(text));
  }

  /** Locate an element by accessibility role, optionally filtering by name or state. */
  getByRole(role: string, options?: { name?: string; checked?: boolean; disabled?: boolean; selected?: boolean; expanded?: boolean }): ElementHandle {
    return this._handle(_role(role, options));
  }

  /**
   * Locate an element by its accessibility description (Android
   * `contentDescription`, iOS `accessibilityLabel`).
   */
  getByDescription(text: string): ElementHandle {
    return this._handle(_contentDesc(text));
  }

  /** Locate an element by placeholder text (Android hint, iOS placeholder). */
  getByPlaceholder(text: string): ElementHandle {
    return this._handle(_hint(text));
  }

  /** Locate an element by its test ID. */
  getByTestId(testId: string): ElementHandle {
    return this._handle(_testId(testId));
  }

  /**
   * Locate an input element by its associated label text. Finds form controls
   * (text fields, checkboxes, switches, etc.) whose accessible name is derived
   * from a nearby label.
   *
   * - Android: follows `labelFor`/`labeledBy` relationships, or matches inputs
   *   whose `contentDescription` equals the label text.
   * - iOS: matches input elements whose `accessibilityLabel` equals the text.
   */
  getByLabel(text: string): ElementHandle {
    return this._handle(_label(text));
  }

  /**
   * Escape hatch: locate an element by native id, xpath, or class name.
   * Prefer accessible getters (`getByRole`, `getByText`, `getByDescription`)
   * when possible.
   */
  locator(options: LocatorOptions): ElementHandle {
    return this._handle(locatorOptionsToSelector(options));
  }

  /** @internal */
  private _handle(selector: Selector): ElementHandle {
    const traceCapture = this._traceCollector ? {
      collector: this._traceCollector,
      deviceId: this._traceDeviceId,
      takeScreenshot: () => this._takeScreenshotBuffer(),
      captureHierarchy: () => this._captureHierarchy(),
      ...(this._platform === 'ios' ? {
        captureTraceState: (opts: CaptureTraceStateOptions) => this._captureTraceState(opts),
      } : {}),
    } : undefined;
    return new ElementHandle(this._client, selector, this._defaultTimeoutMs, { traceCapture, typingDelay: this._typingDelayMs, doubleTapInterval: this._doubleTapIntervalMs });
  }

  // ── Device-level actions ──

  async swipe(direction: string, options?: SwipeOptions): Promise<void> {
    return this._tracedAction('swipe', 'swipe', undefined,
      () => this._client.swipe(direction, { ...options, timeoutMs: options?.timeoutMs ?? this._defaultTimeoutMs }),
      'Swipe failed');
  }

  async pressKey(key: string): Promise<void> {
    return this._tracedAction('pressKey', 'press-key', undefined,
      () => this._client.pressKey(key), 'Press key failed');
  }

  /** Press the hardware back button. @platform android */
  async pressBack(): Promise<void> {
    return this.pressKey('BACK');
  }

  /**
   * Tap at raw screen coordinates (logical points). Prefer selector-based
   * `tap()` in tests; this is for coordinate-driven interaction.
   */
  async tapXY(x: number, y: number): Promise<void> {
    return this._tracedAction('tapXY', 'tap', undefined,
      () => this._client.tapXY(x, y), 'Coordinate tap failed');
  }

  /** Long-press at raw screen coordinates (logical points). */
  async longPressXY(x: number, y: number, options?: { duration?: number }): Promise<void> {
    return this._tracedAction('longPressXY', 'tap', undefined,
      () => this._client.longPressXY(x, y, options?.duration), 'Coordinate long-press failed');
  }

  /** Drag/swipe from one point to another (logical points). */
  async dragXY(from: { x: number; y: number }, to: { x: number; y: number }, options?: { duration?: number }): Promise<void> {
    return this._tracedAction('dragXY', 'swipe', undefined,
      () => this._client.dragXY(from.x, from.y, to.x, to.y, options?.duration), 'Coordinate drag failed');
  }

  /** Type text into whatever currently has focus. */
  async inputText(text: string): Promise<void> {
    return this._tracedAction('inputText', 'type', undefined,
      () => this._client.inputText(text, this._typingDelayMs), 'Input text failed', { inputValue: text });
  }

  // ── Utilities ──

  async takeScreenshot(): Promise<ScreenshotResponse> {
    return this._client.takeScreenshot();
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const res = await this._client.waitForIdle(timeoutMs ?? this._defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Wait for idle timed out');
    }
  }

  async installApk(apkPath: string): Promise<void> {
    const res = await this._client.installApk(apkPath);
    if (!res.success) {
      throw new Error(res.errorMessage || 'APK install failed');
    }
  }

  async listDevices() {
    return this._client.listDevices();
  }

  async setDevice(
    serial: string,
    networkTracingEnabled = false,
    networkHosts: string[] = [],
    passthroughHosts: string[] = [],
  ): Promise<void> {
    const res = await this._client.setDevice(
      serial,
      networkTracingEnabled,
      networkHosts,
      passthroughHosts,
    );
    if (!res.success) {
      throw new Error(res.errorMessage || 'Set device failed');
    }
    // For iOS simulators the serial IS the UDID. WebView inspector-socket
    // discovery must use it: the config `simulator` field is usually a NAME,
    // and resolving by name on a multi-simulator host can land on another
    // worker's simulator — both workers then drive the SAME WebView page,
    // silently corrupting each other's tests (PILOT-288).
    if (this._deviceSerial !== undefined && this._deviceSerial !== serial) {
      // A cached WebView connection belongs to the previous device's
      // inspector socket — drop it rather than serve the wrong device.
      await this._disposeWebViewManager();
    }
    this._deviceSerial = serial;
  }

  async startAgent(
    targetPackage: string,
    agentApkPath?: string,
    agentTestApkPath?: string,
    iosXctestrunPath?: string,
    iosAppPath?: string,
    networkTracingEnabled = false,
  ): Promise<void> {
    return withActionProgress('startAgent', targetPackage || undefined, async () => {
      const res = await this._client.startAgent(
        targetPackage,
        agentApkPath,
        agentTestApkPath,
        iosXctestrunPath,
        iosAppPath,
        networkTracingEnabled,
      );
      if (!res.success) {
        throw new Error(res.errorMessage || 'Start agent failed');
      }
    });
  }

  // ── Device Management (PILOT-10) ──

  private requirePackageName(packageName?: string): string {
    const resolved = packageName ?? this.defaultPackageName;
    if (!resolved) {
      throw new Error(
        'Package name is required. Pass one explicitly or set `package` in your Tapsmith config.',
      );
    }
    return resolved;
  }

  async restartApp(options?: { waitForIdle?: boolean }): Promise<void>;
  async restartApp(packageName: string, options?: { waitForIdle?: boolean }): Promise<void>;
  async restartApp(
    packageOrOptions?: string | { waitForIdle?: boolean },
    maybeOptions?: { waitForIdle?: boolean },
  ): Promise<void> {
    const packageName = typeof packageOrOptions === 'string' ? packageOrOptions : undefined;
    const options = typeof packageOrOptions === 'string' ? maybeOptions : packageOrOptions;
    const pkg = this.requirePackageName(packageName);
    await this._disposeWebViewManager();
    return withActionProgress('restartApp', pkg,
      () => this._tracedAction('restartApp', 'device', undefined,
        () => this._client.restartApp(pkg, options?.waitForIdle ?? true),
        'Restart app failed'));
  }

  async launchApp(packageName: string, options?: LaunchAppOptions): Promise<void> {
    return withActionProgress('launchApp', packageName,
      () => this._tracedAction('launchApp', 'navigation', undefined,
        () => this._client.launchApp(packageName, options),
        'Launch app failed'));
  }

  /**
   * Bring the app to a known state — the same reset the runner performs for
   * the declared `appReset` policy, callable mid-test. Runs the daemon's
   * ladder (warm in-app hook → restart → clear, when `fallback` is on) and
   * reports which rung actually ran.
   */
  async resetApp(options: AppResetOptions = {}): Promise<AppResetResult> {
    return this._resetApp(this.requirePackageName(), options);
  }

  /** @internal — runner/preflight entry point with policy inputs. */
  async _resetApp(packageName: string, options: InternalAppResetOptions): Promise<AppResetResult> {
    const mode = options.mode ?? 'warm';
    let response: ResetAppResponse | undefined;
    const request: ResetAppRequestOptions = {
      mode,
      allowFallback: options.fallback ?? true,
      resetDeepLink: options.resetDeepLink,
      // Retry attempts force cold *delivery* of the hook (see
      // _setForceColdDeepLinks). On platforms without cold delivery the
      // daemon delivers warm in place rather than downgrading to a restart,
      // so an explicit resetApp() reports the same modeUsed on every attempt.
      forceCold: (options.forceCold ?? false) || this._forceColdDeepLinks,
      // Mid-test resetApp() calls share the daemon's warm-window state with
      // the runner's resets, so they honour the same `appResetColdEvery`
      // (0 = off) — sending nothing would mean "never bound the window".
      coldEveryNResets: options.coldEveryNResets ?? this._appResetColdEvery,
      waitForIdle: options.waitForIdle,
      targetPath: options.target,
      fallbackToClear: options.fallbackToClear,
    };
    if (mode !== 'warm') await this._disposeWebViewManager();
    await withActionProgress('resetApp', packageName,
      () => this._tracedAction('resetApp', 'device', undefined,
        async () => {
          response = await this._client.resetApp(packageName, request);
          if (mode === 'warm' && response.success && appResetModeFromWire(response.modeUsed) !== 'warm') {
            // The process was recreated after all — drop cached WebView state.
            await this._disposeWebViewManager();
          }
          return response;
        },
        'App reset failed',
        {
          detail: () => (response ? describeAppResetResponse(mode, response) : undefined),
          skipBeforeCapture: options.skipTraceCapture,
        }));
    return toAppResetResult(mode, response!);
  }

  async openDeepLink(uri: string, options?: OpenDeepLinkOptions): Promise<void> {
    // On retry attempts the runner forces every deep link cold (see
    // _setForceColdDeepLinks); an explicit forceColdLaunch option can only
    // add to that, never override it back to warm.
    const effectiveOptions = this._forceColdDeepLinks
      ? { ...options, forceColdLaunch: true }
      : options;
    // Progress-tracked: delivery can legitimately run for minutes when the
    // daemon rides out re-deliveries, a trust prompt, or the black-display
    // reboot escalation — the user should see a heartbeat, and the runner's
    // test timeout excludes tracked slow-action time.
    return withActionProgress('openDeepLink', uri,
      () => this._tracedAction('openDeepLink', 'navigation', undefined,
        () => this._client.openDeepLink(uri, effectiveOptions),
        'Open deep link failed'));
  }

  /**
   * @internal — When set, every openDeepLink call sends forceColdLaunch,
   * regardless of per-call options. The runner enables this for retry
   * attempts: a cold terminate + relaunch recreates the app's render
   * surface, which is the recovery path for simulators whose display has
   * stopped updating while the a11y tree stays healthy (July 2026 CI
   * finding — warm delivery verifies against the a11y tree and would
   * otherwise carry that broken state into the retry).
   */
  _setForceColdDeepLinks(force: boolean): void {
    this._forceColdDeepLinks = force;
  }

  async currentPackage(): Promise<string> {
    const res = await this._client.getCurrentPackage();
    return res.packageName;
  }

  /** Return the current foreground activity name (e.g. `.MainActivity`). @platform android */
  async currentActivity(): Promise<string> {
    const res = await this._client.getCurrentActivity();
    return res.activity;
  }

  async terminateApp(packageName?: string): Promise<void> {
    const pkg = packageName ?? this.requirePackageName();
    return withActionProgress('terminateApp', pkg,
      () => this._tracedAction('terminateApp', 'device', undefined,
        () => this._client.terminateApp(pkg),
        'Terminate app failed'));
  }

  async getAppState(packageName: string, options?: { timeout?: number }): Promise<AppState> {
    const res = await this._client.getAppState(packageName, options?.timeout);
    return res.state as AppState;
  }

  /** Send the app to the background by pressing the home key. @platform android */
  async sendToBackground(): Promise<void> {
    return this.pressKey('HOME');
  }

  async bringToForeground(packageName: string): Promise<void> {
    return this.launchApp(packageName);
  }

  async saveAppState(packageName: string, path: string): Promise<void> {
    const pkg = this.requirePackageName(packageName);
    return withActionProgress('saveAppState', `${pkg} → ${nodePath.basename(path)}`,
      () => this._tracedAction('saveAppState', 'device', undefined,
        () => this._client.saveAppState(pkg, path),
        'Save app state failed'));
  }

  async restoreAppState(packageName: string, path: string): Promise<void> {
    const pkg = this.requirePackageName(packageName);
    return withActionProgress('restoreAppState', `${pkg} → ${nodePath.basename(path)}`,
      () => this._tracedAction('restoreAppState', 'device', undefined,
        () => this._client.restoreAppState(pkg, path),
        'Restore app state failed'));
  }

  /** Clear app data (AsyncStorage, caches, etc.) and stop the app. */
  async clearAppData(packageName: string): Promise<void> {
    return withActionProgress('clearAppData', packageName,
      () => this._tracedAction('clearAppData', 'device', undefined,
        () => this._client.clearAppData(packageName),
        'Clear app data failed'));
  }

  /** Programmatically grant a runtime permission. @platform android */
  async grantPermission(packageName: string, permission: string): Promise<void> {
    return this._tracedAction('grantPermission', 'device', undefined,
      () => this._client.grantPermission(packageName, permission),
      'Grant permission failed');
  }

  /** Revoke a previously granted runtime permission. @platform android */
  async revokePermission(packageName: string, permission: string): Promise<void> {
    return this._tracedAction('revokePermission', 'device', undefined,
      () => this._client.revokePermission(packageName, permission),
      'Revoke permission failed');
  }

  async setClipboard(text: string): Promise<void> {
    return this._tracedAction('setClipboard', 'device', undefined,
      () => this._client.setClipboard(text),
      'Set clipboard failed');
  }

  async getClipboard(): Promise<string> {
    const res = await this._client.getClipboard();
    return res.text;
  }

  async setOrientation(orientation: Orientation): Promise<void> {
    return this._tracedAction('setOrientation', 'device', undefined,
      () => this._client.setOrientation(orientation),
      'Set orientation failed');
  }

  async getOrientation(): Promise<Orientation> {
    const res = await this._client.getOrientation();
    return res.orientation as Orientation;
  }

  async isKeyboardShown(): Promise<boolean> {
    const res = await this._client.isKeyboardShown();
    return res.shown;
  }

  async hideKeyboard(): Promise<void> {
    return this._tracedAction('hideKeyboard', 'device', undefined,
      () => this._client.hideKeyboard(),
      'Hide keyboard failed');
  }

  async wake(): Promise<void> {
    return this._tracedAction('wake', 'device', undefined,
      () => this._client.wakeDevice(),
      'Wake device failed');
  }

  async unlock(): Promise<void> {
    return this._tracedAction('unlock', 'device', undefined,
      () => this._client.unlockDevice(),
      'Unlock device failed');
  }

  /** Press the home button. @platform android */
  async pressHome(): Promise<void> {
    return this.pressKey('HOME');
  }

  /** Open the notification shade. @platform android */
  async openNotifications(): Promise<void> {
    return this._tracedAction('openNotifications', 'device', undefined,
      () => this._client.openNotifications(),
      'Open notifications failed');
  }

  /** Open the quick settings panel. @platform android */
  async openQuickSettings(): Promise<void> {
    return this._tracedAction('openQuickSettings', 'device', undefined,
      () => this._client.openQuickSettings(),
      'Open quick settings failed');
  }

  /** Open the recent apps screen. @platform android */
  async pressRecentApps(): Promise<void> {
    return this.pressKey('APP_SWITCH');
  }

  /** Set the device color scheme (dark/light). @platform android */
  async setColorScheme(scheme: ColorScheme): Promise<void> {
    return this._tracedAction('setColorScheme', 'device', undefined,
      () => this._client.setColorScheme(scheme),
      'Set color scheme failed');
  }

  async getColorScheme(): Promise<ColorScheme> {
    const res = await this._client.getColorScheme();
    return res.scheme as ColorScheme;
  }

  /**
   * @internal — Start network capture (used by the runner).
   *
   * Returns the ephemeral proxy port and any non-fatal warning the daemon
   * surfaced (e.g. iOS NE redirector setup failed because the SE isn't
   * approved, CA install was best-effort). The runner logs `errorMessage`
   * as a visible warning so users aren't left wondering why their trace
   * has no network entries.
   */
  async _startNetworkCapture(options?: { requireIsolation?: boolean; httpPorts?: number[] }): Promise<{
    proxyPort: number
    success: boolean
    errorMessage: string
  }> {
    let res: Awaited<ReturnType<TapsmithGrpcClient['startNetworkCapture']>>;
    try {
      res = await this._client.startNetworkCapture(options);
    } catch (err) {
      this._networkCaptureActive = false;
      this._networkCaptureError = err instanceof Error ? err.message : String(err);
      // The daemon's state is unknown (a timed-out start may have completed),
      // and a proxy kept running from an earlier test still routes the same
      // way; keep its route so entries drained from it stay labelled.
      if (!this._networkCaptureEverStarted) this._networkCaptureRoute = undefined;
      throw err;
    }
    // Kept across the stop that ends the test: the trace metadata is written
    // after capture has been drained.
    this._networkCaptureRoute = res.success ? res.route : undefined;
    if (res.success) {
      this._networkCaptureActive = true;
      this._networkCaptureEverStarted = true;
      this._networkCaptureError = undefined;
      this._ensureRouteManager().ensureEventsSubscribed();
    } else {
      this._networkCaptureActive = false;
      this._networkCaptureError = res.errorMessage || 'Network capture failed to start';
    }
    return {
      proxyPort: res.proxyPort,
      success: res.success,
      errorMessage: res.errorMessage,
    };
  }

  /**
   * @internal — Whether this device's daemon holds a network proxy: a start
   * succeeded at some point and nothing has released it since. Stays true
   * across `_stopNetworkCapture({ keepRunning: true })` drains.
   */
  get _networkProxyRunning(): boolean {
    return this._networkCaptureEverStarted;
  }

  /** @internal — Read live capture without ending the active capture session. */
  async _snapshotNetworkCapture(knownBodies?: Parameters<TapsmithGrpcClient['snapshotNetworkCapture']>[0]): ReturnType<TapsmithGrpcClient['snapshotNetworkCapture']> {
    return this._client.snapshotNetworkCapture(knownBodies);
  }

  /** @internal — Stop network capture and return entries (used by the runner). */
  async _stopNetworkCapture(options?: { keepRunning?: boolean }): Promise<ReturnType<TapsmithGrpcClient['stopNetworkCapture']>> {
    try {
      return await this._client.stopNetworkCapture(options);
    } finally {
      this._networkCaptureActive = false;
      this._networkCaptureError = undefined;
    }
  }

  /** @internal — Start video recording on the device (used by the runner, PILOT-114). */
  async _startVideoRecording(options?: { size?: { width: number; height: number } }): Promise<{
    success: boolean
    errorMessage: string
  }> {
    const res = await this._client.startVideoRecording(options);
    return { success: res.success, errorMessage: res.errorMessage };
  }

  /** @internal — Stop video recording and return path to the MP4 (used by the runner, PILOT-114). */
  async _stopVideoRecording(): Promise<{
    success: boolean
    videoPath: string
    errorMessage: string
    durationMs: number
  }> {
    const res = await this._client.stopVideoRecording();
    return {
      success: res.success,
      videoPath: res.videoPath,
      errorMessage: res.errorMessage,
      durationMs: res.durationMs,
    };
  }

  /** @internal — Fetch and cache device info from the daemon. */
  async _fetchDeviceInfo(serial: string): Promise<{ model?: string; osVersion?: string; isEmulator?: boolean }> {
    if (this._cachedDeviceInfo) return this._cachedDeviceInfo;
    try {
      const resp = await this._client.listDevices();
      const match = resp.devices?.find(d => d.serial === serial);
      this._cachedDeviceInfo = {
        model: match?.model || undefined,
        osVersion: match?.osVersion || undefined,
        isEmulator: match?.isEmulator,
      };
    } catch {
      this._cachedDeviceInfo = {};
    }
    return this._cachedDeviceInfo;
  }

  // ─── Device Log Streaming (PILOT-193) ───

  /** @internal — Start streaming device logs into the active trace collector. */
  _startDeviceLogStream(collector: TraceCollector): void {
    if (!this.defaultPackageName) return;
    if (this._logStream) {
      if (this._logStreamCollector === collector) return;
      this._stopDeviceLogStream();
    }

    const stream = this._client.deviceLogStream(this.defaultPackageName);
    this._logStream = stream;
    this._logStreamCollector = collector;

    const clearStream = () => {
      if (this._logStream === stream) {
        this._logStream = null;
        this._logStreamCollector = null;
      }
    };

    stream.on('data', (entry: DeviceLogEntry) => {
      if (this._logStream !== stream) return;
      const level = mapDeviceLogLevel(entry.level);
      const message = entry.tag
        ? `[${entry.tag}] ${entry.message}`
        : entry.message;
      collector.addLogcatEntry(level, message, this._traceDeviceId, entry.timestampMs);
    });

    stream.on('error', (err: Error) => {
      const code = (err as grpc.ServiceError).code;
      const isCleanReset = code === grpc.status.INTERNAL && err.message?.includes('RST_STREAM with code 0');
      if (code !== grpc.status.CANCELLED && !isCleanReset) {
        console.warn('[tapsmith] Device log stream error:', err.message);
      }
      clearStream();
    });

    stream.on('end', () => {
      clearStream();
    });
  }

  /** @internal — Stop streaming device logs. */
  _stopDeviceLogStream(): void {
    const stream = this._logStream;
    this._logStream = null;
    this._logStreamCollector = null;
    stream?.cancel();
  }

  /** @internal — Start streaming the daemon's own logs into the active trace collector. */
  _startDaemonLogStream(collector: TraceCollector): void {
    if (this._daemonLogStream) {
      if (this._daemonLogStreamCollector === collector) return;
      this._stopDaemonLogStream();
    }

    const stream = this._client.daemonLogStream();
    this._daemonLogStream = stream;
    this._daemonLogStreamCollector = collector;

    const clearStream = () => {
      if (this._daemonLogStream === stream) {
        this._daemonLogStream = null;
        this._daemonLogStreamCollector = null;
      }
    };

    stream.on('data', (entry: DaemonLogEntry) => {
      if (!entry || this._daemonLogStream !== stream) return;
      const level = mapDeviceLogLevel(entry.level);
      const message = entry.target
        ? `[${entry.target}] ${entry.message}`
        : entry.message;
      collector.addDaemonLogEntry(level, message, this._traceDeviceId, entry.timestampMs);
    });

    stream.on('error', (err: Error) => {
      const code = (err as grpc.ServiceError).code;
      const isCleanReset = code === grpc.status.INTERNAL && err.message?.includes('RST_STREAM with code 0');
      if (code !== grpc.status.CANCELLED && !isCleanReset) {
        console.warn('[tapsmith] Daemon log stream error:', err.message);
      }
      clearStream();
    });

    stream.on('end', () => {
      clearStream();
    });
  }

  /** @internal — Stop streaming daemon logs. */
  _stopDaemonLogStream(): void {
    const stream = this._daemonLogStream;
    this._daemonLogStream = null;
    this._daemonLogStreamCollector = null;
    stream?.cancel();
  }

  // ─── Network Route Interception ───

  /**
   * Intercept network requests matching a URL pattern. The handler receives a
   * `Route` object that can `abort()`, `continue()`, `fulfill()`, or `fetch()`
   * the request.
   *
   * Requires network tracing to be enabled (`trace` mode is not `'off'` and
   * `network` is `true`, which is the default). Without it, the MITM proxy
   * is not active and route handlers will never fire.
   */
  async route(
    url: string | RegExp | ((url: URL) => boolean),
    handler: (route: Route) => Promise<void> | void,
    options?: { times?: number },
  ): Promise<void> {
    const start = Date.now();
    const stack = extractStack(new Error().stack ?? '');
    const source = stack[0];
    if (!this._networkCaptureActive && this._networkCaptureError) {
      const error = `Network capture disabled: ${this._networkCaptureError}`;
      this._emitNetworkAction('route', formatPattern(url), start, false, error, source, stack);
      throw new Error(error);
    }
    await this._ensureRouteManager().addRoute(url, handler, options);
    this._emitNetworkAction('route', formatPattern(url), start, true, undefined, source, stack);
  }

  /**
   * Remove a previously registered route handler.
   * If `handler` is omitted, all handlers for the pattern are removed.
   */
  async unroute(
    url: string | RegExp | ((url: URL) => boolean),
    handler?: (route: Route) => Promise<void> | void,
  ): Promise<void> {
    if (!this._routeManager) return;
    const start = Date.now();
    const stack = extractStack(new Error().stack ?? '');
    const source = stack[0];
    await this._routeManager.removeRoute(url, handler);
    this._emitNetworkAction('unroute', formatPattern(url), start, true, undefined, source, stack);
  }

  /** Remove all registered route handlers. */
  async unrouteAll(): Promise<void> {
    if (!this._routeManager) return;
    const start = Date.now();
    const stack = extractStack(new Error().stack ?? '');
    const source = stack[0];
    await this._routeManager.removeAllRoutes();
    this._emitNetworkAction('unrouteAll', undefined, start, true, undefined, source, stack);
  }

  /**
   * Wait for a request matching the pattern.
   *
   * Requires network tracing to be enabled (same prerequisite as `route()`).
   */
  waitForRequest(
    urlOrPredicate: string | RegExp | ((request: TapsmithRequest) => boolean),
    options?: { timeout?: number },
  ): Promise<TapsmithRequest> {
    const timeout = options?.timeout ?? this._defaultTimeoutMs;
    const manager = this._ensureRouteManager();

    return new Promise<TapsmithRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        manager.removeRequestListener(listener);
        reject(new Error(`waitForRequest timed out after ${timeout}ms`));
      }, timeout);

      const listener = (req: TapsmithRequest) => {
        const matches = typeof urlOrPredicate === 'function'
          ? urlOrPredicate(req)
          : matchUrlPattern(req.url, urlOrPredicate);
        if (matches) {
          clearTimeout(timer);
          manager.removeRequestListener(listener);
          resolve(req);
        }
      };
      manager.addRequestListener(listener);
    });
  }

  /**
   * Wait for a response matching the pattern.
   *
   * Requires network tracing to be enabled (same prerequisite as `route()`).
   */
  waitForResponse(
    urlOrPredicate: string | RegExp | ((response: NetworkResponseEventData) => boolean),
    options?: { timeout?: number },
  ): Promise<NetworkResponseEventData> {
    const timeout = options?.timeout ?? this._defaultTimeoutMs;
    const manager = this._ensureRouteManager();

    return new Promise<NetworkResponseEventData>((resolve, reject) => {
      const timer = setTimeout(() => {
        manager.removeResponseListener(listener);
        reject(new Error(`waitForResponse timed out after ${timeout}ms`));
      }, timeout);

      const listener = (resp: NetworkResponseEventData) => {
        const matches = typeof urlOrPredicate === 'function'
          ? urlOrPredicate(resp)
          : matchUrlPattern(resp.url, urlOrPredicate);
        if (matches) {
          clearTimeout(timer);
          manager.removeResponseListener(listener);
          resolve(resp);
        }
      };
      manager.addResponseListener(listener);
    });
  }

  /** Subscribe to network request/response events. */
  on(event: 'request', handler: (request: TapsmithRequest) => void): void;
  on(event: 'response', handler: (response: NetworkResponseEventData) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation
  on(event: string, handler: (...args: any[]) => void): void {
    const manager = this._ensureRouteManager();
    if (event === 'request') {
      manager.addRequestListener(handler as (req: TapsmithRequest) => void);
    } else {
      manager.addResponseListener(handler as (resp: NetworkResponseEventData) => void);
    }
  }

  /** Unsubscribe from network events. */
  off(event: 'request', handler: (request: TapsmithRequest) => void): void;
  off(event: 'response', handler: (response: NetworkResponseEventData) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation
  off(event: string, handler: (...args: any[]) => void): void {
    if (!this._routeManager) return;
    if (event === 'request') {
      this._routeManager.removeRequestListener(handler as (req: TapsmithRequest) => void);
    } else {
      this._routeManager.removeResponseListener(handler as (resp: NetworkResponseEventData) => void);
    }
  }

  /** @internal — Dispose the route manager (called by the runner during cleanup). */
  async _disposeRouteManager(): Promise<void> {
    if (this._routeManager) {
      await this._routeManager.dispose();
      this._routeManager = null;
    }
  }

  // ─── WebView Testing (PILOT-116) ───

  /**
   * Switch to a WebView context for hybrid app testing.
   *
   * Returns a `WebViewHandle` that supports CSS selectors, `click()`, `fill()`,
   * `textContent()`, `evaluate()`, and `locator()` for web content interaction.
   *
   * @param packageName - Optional package name to target a specific WebView
   *   when multiple are present.
   */
  async webview(packageName?: string): Promise<WebViewHandle> {
    return this._tracedWebViewConnect(packageName);
  }

  private async _tracedWebViewConnect(packageName?: string): Promise<WebViewHandle> {
    const collector = this._traceCollector;
    if (!collector) {
      return this._connectWebView(packageName);
    }

    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const targetPackageName = packageName ?? this.defaultPackageName;
    const selector = targetPackageName ? `package=${targetPackageName}` : undefined;
    // The capture reserves this action's index; every emit below must hand it
    // back, or the event lands one index past its own before-screenshot.
    const { actionIndex, captures: beforeCaptures } = await collector.captureBeforeAction(
      () => this._takeScreenshotBuffer(),
      () => this._captureHierarchy(),
    );
    const connectLog = [`device.webview(${packageName ? JSON.stringify(packageName) : ''})`];
    if (!packageName && targetPackageName) {
      appendWebViewConnectLog(connectLog, `Using configured app package "${targetPackageName}" as the WebView target`);
    }

    collector._emitActionStarted({
      category: 'webview',
      action: 'connect',
      selector,
      sourceLocation,
      stack,
      log: connectLog,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
    }, actionIndex);

    const start = Date.now();
    let failedByTimeout = false;
    let timeoutError: string | undefined;
    collector.setPendingOperation((errorMessage: string) => {
      failedByTimeout = true;
      timeoutError = errorMessage;
      collector.addActionEvent({
        category: 'webview',
        action: 'connect',
        selector,
        duration: Date.now() - start,
        success: false,
        error: errorMessage,
        log: [`device.webview() timed out: ${errorMessage}`, ...connectLog.slice(1)],
        hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
        hasScreenshotAfter: false,
        hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
        hasHierarchyAfter: false,
        sourceLocation,
        stack,
      }, actionIndex);
    }, stack);

    let handle: WebViewHandle | undefined;
    try {
      handle = await this._connectWebView(packageName, connectLog);
    } catch (err) {
      collector.clearPendingOperation();
      if (!failedByTimeout) {
        const message = err instanceof Error ? err.message : String(err);
        collector.addActionEvent({
          category: 'webview',
          action: 'connect',
          selector,
          duration: Date.now() - start,
          success: false,
          error: message,
          log: [`device.webview() failed: ${message}`, ...connectLog.slice(1)],
          hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
          hasScreenshotAfter: false,
          hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
          hasHierarchyAfter: false,
          sourceLocation,
          stack,
        }, actionIndex);
      }
      throw err;
    }

    collector.clearPendingOperation();
    if (failedByTimeout) {
      throw new Error(timeoutError ?? 'device.webview() timed out');
    }

    collector.addActionEvent({
      category: 'webview',
      action: 'connect',
      selector,
      duration: Date.now() - start,
      success: true,
      log: ['device.webview() connected', ...connectLog.slice(1)],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      sourceLocation,
      stack,
    }, actionIndex);

    return handle;
  }

  /**
   * Establish (or reuse) a WebView connection WITHOUT promoting it to the
   * session's active WebView. The picker path uses this directly — writing
   * `_activeWebView` from a poll would race a test session that connects
   * concurrently (the poll's multi-second connect resolving after the test's
   * would clobber the test's activation).
   */
  private async _establishWebView(packageName?: string, log?: string[]): Promise<WebViewHandle> {
    if (this._cachedWebView?._isAlive()) {
      appendWebViewConnectLog(log, 'Reusing cached WebView connection');
      this._applyTraceCtx(this._cachedWebView);
      return this._cachedWebView;
    }
    this._cachedWebView = null;
    const generation = this._webviewGeneration;

    if (this._platform === 'ios') {
      return this._webviewIos(packageName, generation, log);
    }
    return this._webviewAndroid(packageName, generation, log);
  }

  private async _connectWebView(packageName?: string, log?: string[]): Promise<WebViewHandle> {
    const handle = await this._establishWebView(packageName, log);
    this._activeWebView = handle;
    return handle;
  }

  private async _webviewAndroid(packageName: string | undefined, generation: number, log?: string[]): Promise<WebViewHandle> {
    const deadline = Date.now() + this._defaultTimeoutMs;
    const targetPackageName = packageName ?? this.defaultPackageName;

    let lastError = '';
    while (remainingMs(deadline) > 0) {
      let list: Awaited<ReturnType<TapsmithGrpcClient['listWebViews']>>;
      try {
        list = await withDeadline(
          this._client.listWebViews(Math.min(WEBVIEW_RPC_TIMEOUT_MS, remainingMs(deadline))),
          deadline,
          'Listing WebViews',
        );
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        appendWebViewConnectLog(log, `List WebViews failed: ${lastError}`);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }
      if (list.errorMessage) {
        lastError = list.errorMessage;
        appendWebViewConnectLog(log, `List WebViews returned error: ${lastError}`);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }

      const discovered = list.webviews;
      appendWebViewConnectLog(
        log,
        discovered.length > 0
          ? `Discovered WebViews: ${discovered.map(describeWebView).join(', ')}`
          : 'Discovered no WebViews',
      );

      let candidates = discovered;
      if (targetPackageName) {
        candidates = discovered.filter(w => webViewMatchesPackage(w, targetPackageName));
      }

      if (candidates.length === 0) {
        lastError = targetPackageName
          ? `No WebViews found for package "${targetPackageName}"`
          : 'No WebViews found';
        appendWebViewConnectLog(log, lastError);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }

      for (const target of candidates) {
        appendWebViewConnectLog(log, `Trying ${describeWebView(target)}`);
        let fwd: Awaited<ReturnType<TapsmithGrpcClient['forwardWebViewPort']>>;
        try {
          fwd = await withDeadline(
            this._client.forwardWebViewPort(target.socketName, Math.min(WEBVIEW_RPC_TIMEOUT_MS, remainingMs(deadline))),
            deadline,
            'Forwarding WebView debug port',
          );
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          appendWebViewConnectLog(log, `Forwarding ${target.socketName} failed: ${lastError}`);
          continue;
        }
        if (!fwd.success) {
          lastError = `Failed to forward WebView port: ${fwd.errorMessage}`;
          appendWebViewConnectLog(log, `${lastError} (${target.socketName})`);
          continue;
        }

        const attemptDeadline = Date.now() + Math.min(WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs(deadline));
        const handle = new WebViewHandle(this._client, fwd.localPort, Math.max(1, remainingMs(attemptDeadline)));
        this._applyTraceCtx(handle);
        try {
          await withDeadline(handle._connect(), attemptDeadline, 'Connecting to WebView CDP endpoint');
          if (generation !== this._webviewGeneration) {
            await handle.close();
            throw new Error('WebView connection was disposed before it completed');
          }

          appendWebViewConnectLog(log, `Connected to ${describeWebView(target)} on local port ${fwd.localPort}`);
          this._cachedWebView = handle;
          return handle;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          appendWebViewConnectLog(log, `Connecting to ${target.socketName} failed: ${lastError}`);
          await handle.close();
          continue;
        }
      }

      await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
    }

    throw new Error(
      `Timed out waiting for WebView (${this._defaultTimeoutMs}ms). ${lastError}. ` +
      'Ensure the app has a visible WebView with debugging enabled ' +
      '(WebView.setWebContentsDebuggingEnabled(true)).',
    );
  }

  private async _webviewIos(_packageName: string | undefined, generation: number, log?: string[]): Promise<WebViewHandle> {
    const { WebKitInspectorClient, findSimulatorInspectorSocket } = await import('./webkit-inspector.js');

    // Prefer the explicitly selected device serial (= simulator UDID) over
    // the config `simulator` value, which is usually a name and cannot
    // disambiguate between multiple booted simulators (PILOT-288).
    const udid = this._deviceSerial ?? this._simulatorUdid ?? '';
    const deadline = Date.now() + this._defaultTimeoutMs;
    let lastError = '';
    let lastPhase = 'discovering the WebKit Inspector socket';
    let socketPath: string | null = null;
    let inspector: WebKitInspectorClient | null = null;
    let hiddenFallback: { appId: string; pageId: number; desc: string } | undefined;

    // Every phase of connection setup is bounded and retried until the device
    // timeout: webinspectord can wedge mid-handshake (a Unix socket connect
    // that never completes, listings that never arrive), and a hung phase
    // must fail fast and retry on a fresh session — which typically succeeds —
    // instead of stalling until the caller's test timeout (PILOT-288).
    try {
      while (remainingMs(deadline) > 0) {
        // A fallback candidate is only ever used within the round that
        // discovered it — a page recorded in an earlier round may be gone.
        hiddenFallback = undefined;
        if (!socketPath) {
          lastPhase = 'discovering the WebKit Inspector socket';
          socketPath = findSimulatorInspectorSocket(udid, remainingMs(deadline));
          if (!socketPath) {
            lastError =
              `No WebKit Inspector socket found for simulator "${udid}". ` +
              'Ensure the iOS simulator is booted; with multiple booted simulators the device must be identified by UDID';
            appendWebViewConnectLog(log, lastError);
            await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
            continue;
          }
          appendWebViewConnectLog(log, `Simulator "${udid}" → WebKit Inspector socket ${socketPath}`);
        }

        if (!inspector?.isConnected()) {
          inspector?.close();
          lastPhase = 'connecting to the WebKit Inspector service';
          inspector = new WebKitInspectorClient();
          const attemptDeadline = Math.min(Date.now() + WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS, deadline);
          try {
            await withDeadline(inspector.connect(socketPath), attemptDeadline, 'Connecting to the WebKit Inspector service');
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            appendWebViewConnectLog(log, `WebKit Inspector connect failed: ${lastError}`);
            inspector.close();
            inspector = null;
            // The simulator may have rebooted out from under us — rediscover.
            socketPath = null;
            await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
            continue;
          }
        }

        lastPhase = 'listing WebView targets';
        let targets: Awaited<ReturnType<WebKitInspectorClient['listTargets']>>;
        try {
          targets = await withDeadline(
            inspector.listTargets(),
            Math.min(Date.now() + WEBVIEW_RPC_TIMEOUT_MS, deadline),
            'Listing WebView targets',
          );
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          appendWebViewConnectLog(log, `Listing WebView targets failed: ${lastError}`);
          inspector.close();
          inspector = null;
          await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
          continue;
        }

        // Find the target app's WebView pages — prefer matching by package/name,
        // fall back to any app with inspectable pages.
        const matchesPkg = (t: { bundleId: string; name: string }) => {
          if (_packageName) return t.bundleId === _packageName || t.name === _packageName;
          if (this.defaultPackageName) return t.bundleId === this.defaultPackageName;
          return false;
        };
        const withPages = targets.filter(t => t.pages.length > 0);
        const matching = withPages.filter(matchesPkg);
        // After an app relaunch, webinspectord keeps advertising the previous
        // process's entry for tens of seconds — and its dead pages can keep
        // answering evaluates against their frozen DOM, so the responsiveness
        // probe below cannot reject them. The live page is the newest one:
        // probe apps newest-pid-first and pages newest-id-first.
        const candidates = (matching.length > 0 ? matching : withPages)
          .slice()
          .sort((a, b) => inspectorAppPid(b.appId) - inspectorAppPid(a.appId));

        if (candidates.length === 0) {
          lastPhase = 'waiting for an inspectable WebView page';
          lastError = 'No inspectable WebView pages found';
          appendWebViewConnectLog(log, lastError);
          await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
          continue;
        }
        appendWebViewConnectLog(
          log,
          `Candidate WebView pages: ${candidates
            .map(t => `${t.appId}[${t.pages.map(p => p.id).sort((a, b) => b - a).join(',')}]`)
            .join(' ')}`,
        );

        lastPhase = 'connecting to a WebView page';
        let handle: WebViewHandle | undefined;
        outer: for (const appTarget of candidates) {
          const pages = appTarget.pages.slice().sort((a, b) => b.id - a.id);
          for (const page of pages) {
            if (!inspector) break outer;
            const pageDesc = `${page.title || page.url || page.id}`;
            appendWebViewConnectLog(log, `Connecting to iOS WebView page "${pageDesc}" (app ${appTarget.appId})`);
            let sessionReady = false;
            try {
              const attemptDeadline = Math.min(Date.now() + WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS, deadline);
              await withDeadline(
                inspector.connectToPage(appTarget.appId, page.id),
                attemptDeadline,
                'Setting up the WebView page session',
              );
              sessionReady = true;
              const candidate = WebViewHandle._createFromInspector(
                this._client, inspector, appTarget.appId, page.id, this._defaultTimeoutMs,
              );
              // Liveness probe: the page must answer AND be the rendered
              // document. After a WebView remount, the detached predecessor
              // can linger in listings and keep answering evaluates against a
              // DOM nobody sees (its state matches the previous session) —
              // only `document.visibilityState` tells the two apart. A
              // responsive-but-hidden page is remembered as a last-resort
              // fallback for apps whose WebView is legitimately off-screen.
              const visibility = await candidate._evaluate(
                'document.visibilityState',
                Math.min(WEBVIEW_PAGE_PROBE_TIMEOUT_MS, Math.max(1, remainingMs(deadline))),
              );
              if (inspector.pageReplaced) {
                lastError = `Page "${pageDesc}" was replaced while connecting`;
                appendWebViewConnectLog(log, lastError);
                continue;
              }
              if (visibility !== 'visible') {
                lastError = `Page "${pageDesc}" answers but is not rendered (visibilityState=${String(visibility)}) — likely a detached predecessor of the current WebView`;
                appendWebViewConnectLog(log, lastError);
                hiddenFallback ??= { appId: appTarget.appId, pageId: page.id, desc: pageDesc };
                continue;
              }
              appendWebViewConnectLog(log, `Page ${page.id} ("${pageDesc}") is responsive and visible — accepting`);
              handle = candidate;
              break outer;
            } catch (err) {
              lastError = `Page "${pageDesc}" did not respond: ${err instanceof Error ? err.message : String(err)}`;
              appendWebViewConnectLog(log, lastError);
              if (!sessionReady) {
                // A timed-out page-session setup can deliver its late
                // Target.targetCreated during the NEXT setup on this
                // connection and cross-wire the session to the wrong page —
                // never reuse a connection after a failed setup. Reconnect
                // fresh so the round's remaining candidates still get tried
                // (a dead newest page must not starve a live older one).
                inspector.close();
                inspector = null;
                lastPhase = 'connecting to the WebKit Inspector service';
                const fresh = new WebKitInspectorClient();
                try {
                  await withDeadline(
                    fresh.connect(socketPath),
                    Math.min(Date.now() + WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS, deadline),
                    'Connecting to the WebKit Inspector service',
                  );
                  inspector = fresh;
                  lastPhase = 'connecting to a WebView page';
                } catch (e) {
                  fresh.close();
                  lastError = e instanceof Error ? e.message : String(e);
                  appendWebViewConnectLog(log, `WebKit Inspector reconnect failed: ${lastError}`);
                  break outer;
                }
              }
            }
          }
        }

        // No visible page: once past half the budget, settle for a
        // responsive-but-hidden page rather than timing out — some apps keep
        // their WebView off-screen, and the visibility gate must not break
        // them. The detached-predecessor case resolves before this because
        // the real page gets listed within a couple of seconds of a remount.
        if (!handle && inspector && hiddenFallback && remainingMs(deadline) < this._defaultTimeoutMs / 2) {
          try {
            const attemptDeadline = Math.min(Date.now() + WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS, deadline);
            await withDeadline(
              inspector.connectToPage(hiddenFallback.appId, hiddenFallback.pageId),
              attemptDeadline,
              'Setting up the WebView page session',
            );
            const candidate = WebViewHandle._createFromInspector(
              this._client, inspector, hiddenFallback.appId, hiddenFallback.pageId, this._defaultTimeoutMs,
            );
            await candidate._evaluate('1', Math.min(WEBVIEW_PAGE_PROBE_TIMEOUT_MS, Math.max(1, remainingMs(deadline))));
            if (!inspector.pageReplaced) {
              appendWebViewConnectLog(log, `No visible WebView page appeared — falling back to non-rendered page "${hiddenFallback.desc}"`);
              handle = candidate;
            }
          } catch (err) {
            lastError = `Fallback page "${hiddenFallback.desc}" did not respond: ${err instanceof Error ? err.message : String(err)}`;
            appendWebViewConnectLog(log, lastError);
            hiddenFallback = undefined;
            // A failed fallback setup carries the same late-targetCreated
            // cross-wire risk as any failed setup.
            inspector.close();
            inspector = null;
          }
        }

        if (!handle) {
          // A page session that fails to come up can stay wedged on this
          // inspector connection for many retries while a fresh connection
          // succeeds immediately (observed in PILOT-288 traces: the next
          // test's connect works) — retry each round on a fresh session.
          inspector?.close();
          inspector = null;
          await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
          continue;
        }

        this._applyTraceCtx(handle);
        // The handle owns the inspector connection from here on.
        inspector = null;
        if (generation !== this._webviewGeneration) {
          await handle.close();
          throw new Error('WebView connection was disposed before it completed');
        }

        this._cachedWebView = handle;
        return handle;
      }

      throw new Error(
        `WebView connection setup timed out during ${lastPhase} (${this._defaultTimeoutMs}ms). ${lastError}. ` +
        'Ensure the WebView has webviewDebuggingEnabled={true} (sets isInspectable on iOS 16.4+).',
      );
    } finally {
      inspector?.close();
    }
  }

  private _applyTraceCtx(handle: WebViewHandle): void {
    if (this._traceCollector) {
      handle._traceCtx = {
        collector: this._traceCollector,
        deviceId: this._traceDeviceId,
        takeScreenshot: () => this._takeScreenshotBuffer(),
        captureHierarchy: () => this._captureHierarchy(),
      };
    }
  }

  /** Switch back to native context. The WebView connection stays alive for reuse. */
  async native(): Promise<void> {
    this._activeWebView = null;
  }

  /**
   * @internal — Per-test reset: return to the native context but keep the
   * WebView connection cached for the next test. Re-establishing the iOS
   * inspector session per test churns webinspectord and is the main trigger
   * for wedged page sessions and stale-target connects (PILOT-288); a dead
   * connection is detected by `_isAlive()` and reconnected on next use.
   */
  _resetWebViewContext(): void {
    this._activeWebView = null;
  }

  /** @internal — Dispose the WebView manager (called by the runner during cleanup). */
  async _disposeWebViewManager(): Promise<void> {
    this._webviewGeneration++;
    this._activeWebView = null;
    if (this._cachedWebView) {
      await this._cachedWebView.close();
      this._cachedWebView = null;
    }
  }

  /** Emit a trace event for a network management action (route/unroute). */
  private _emitNetworkAction(
    action: string,
    pattern: string | undefined,
    start: number,
    success: boolean,
    error?: string,
    sourceLocation?: import('./trace/types.js').SourceLocation,
    stack?: import('./trace/types.js').SourceLocation[],
  ): void {
    const collector = this._traceCollector;
    if (!collector) return;
    collector.addActionEvent({
      category: 'network',
      action,
      duration: Date.now() - start,
      success,
      error,
      selector: pattern,
      log: pattern ? [`${action}(${pattern})`] : [action],
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
      sourceLocation,
      stack,
    });
  }

  async close(): Promise<void> {
    await this._close({ closeClient: true });
  }

  /**
   * @internal — `close()` for a Device whose gRPC client belongs to someone
   * else (a session adopting the CLI's shared client): tears down everything
   * this Device started but leaves the client open for its owner.
   */
  async _close(opts: { closeClient: boolean; releaseNetwork?: boolean }): Promise<void> {
    // Stop device log stream (synchronous)
    this._stopDeviceLogStream();
    this._stopDaemonLogStream();

    // Release the network proxy for real. The runner keeps it alive across
    // files (a stable port so a warm-reset-persisted app keeps valid
    // keep-alive sockets); the session ending is the point to tear it down.
    // A caller that only borrowed the daemon (a watch re-run child attached
    // to its parent's session) passes `releaseNetwork: false` so the proxy —
    // and the app's keep-alive sockets to it — survive to the next run.
    if (this._networkCaptureEverStarted && (opts.releaseNetwork ?? true)) {
      try {
        await this._stopNetworkCapture({ keepRunning: false });
      } catch {
        // Best-effort; the daemon also cleans up the proxy on shutdown.
      }
      this._networkCaptureEverStarted = false;
    }

    // Dispose the route manager (closes gRPC stream)
    if (this._routeManager) {
      await this._routeManager.dispose();
      this._routeManager = null;
    }

    // Close any active WebView handle
    if (this._activeWebView) {
      await this._activeWebView.close();
      this._activeWebView = null;
    }

    if (opts.closeClient) this._client.close();
  }
}

function mapDeviceLogLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'debug': return 'debug';
    case 'info': return 'info';
    case 'warn': return 'warn';
    case 'error': return 'error';
    default: return 'log';
  }
}

function formatPattern(url: string | RegExp | ((url: URL) => boolean)): string {
  if (typeof url === 'string') return url;
  if (url instanceof RegExp) return url.toString();
  return '<predicate>';
}

// ─── App reset types ───

export interface AppResetOptions {
  /** How far to reset. Default `'warm'` (falls back per `fallback`). */
  mode?: 'warm' | 'restart' | 'clear';
  /** Escalate warm → restart → clear when a rung fails. Default `true`. */
  fallback?: boolean;
  /**
   * Route to land on after an in-app (warm) reset — the reset deep link's
   * path. A `restart`/`clear` rung leaves the app at its launch route; check
   * `modeUsed` and navigate if the route matters. Default `'/'`.
   */
  target?: string;
}

/** @internal */
export interface InternalAppResetOptions extends AppResetOptions {
  resetDeepLink?: string;
  forceCold?: boolean;
  coldEveryNResets?: number;
  waitForIdle?: boolean;
  /**
   * Skip the trace's before-action capture (screenshot + hierarchy) for this
   * reset. The runner sets it for fixture-setup resets, where the pre-reset
   * screen is the previous test's leftover state.
   */
  skipTraceCapture?: boolean;
  /**
   * Warm falls back to clear instead of restart. Set by the runner's declared
   * isolation policy (its promise is state-clearing; a restart keeps data);
   * public `device.resetApp()` keeps the gentler restart fallback.
   */
  fallbackToClear?: boolean;
}

export interface AppResetResult {
  modeRequested: 'warm' | 'restart' | 'clear';
  /** The rung that actually ran. */
  modeUsed: 'warm' | 'restart' | 'clear';
  fellBack: boolean;
  /** The app process was recreated (cold delivery, restart or clear). */
  coldLaunch: boolean;
  /** Why a fallback or cold relaunch happened, when it did. */
  reason?: string;
  durationMs: number;
  /** `@tapsmith/react-native` reset hooks were detected in the app. */
  hooksDetected: boolean;
  epochBefore?: number;
  epochAfter?: number;
  steps: Array<{ name: string; durationMs: number; ok: boolean; detail?: string }>;
}

function toAppResetResult(requested: 'warm' | 'restart' | 'clear', r: ResetAppResponse): AppResetResult {
  return {
    modeRequested: requested,
    modeUsed: appResetModeFromWire(r.modeUsed) ?? requested,
    fellBack: r.fellBack,
    coldLaunch: r.coldLaunch,
    ...(r.reason ? { reason: r.reason } : {}),
    durationMs: r.durationMs,
    hooksDetected: r.hooksDetected,
    ...(r.hooksDetected ? { epochBefore: r.epochBefore, epochAfter: r.epochAfter } : {}),
    steps: (r.steps ?? []).map((st) => ({
      name: st.name,
      durationMs: st.durationMs,
      ok: st.ok,
      ...(st.detail ? { detail: st.detail } : {}),
    })),
  };
}

function describeAppResetResponse(requested: 'warm' | 'restart' | 'clear', r: ResetAppResponse): string {
  const used = appResetModeFromWire(r.modeUsed) ?? requested;
  const via = used === 'warm'
    ? (r.hooksDetected
      ? `warm reset via @tapsmith/react-native (epoch ${r.epochBefore}→${r.epochAfter})`
      : 'warm reset via resetAppDeepLink')
    : used === 'restart' ? 'terminated and relaunched (data kept)' : 'cleared app data and relaunched';
  const secs = `${(r.durationMs / 1000).toFixed(1)}s`;
  if (!r.success) return `${via} — failed: ${r.errorMessage}`;
  return r.reason ? `${via}, ${secs} — ${r.reason}` : `${via}, ${secs}`;
}
