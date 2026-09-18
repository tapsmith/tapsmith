import { WebSocket } from 'ws';
import type { ElementInfo, TapsmithGrpcClient } from './grpc-client.js';
import {
  buildStrictModeViolationError,
  STRICT_ERROR_MAX_ELEMENTS,
  truncateText,
  type StrictModeViolationError,
  POLL_INTERVAL_MS,
} from './element-handle.js';
import { WebViewLocator } from './webview-locator.js';
import type { TraceCollector } from './trace/trace-collector.js';
import { extractStack } from './trace/trace-collector.js';
import type { WebKitInspectorClient } from './webkit-inspector.js';

const WEB_SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const WEBVIEW_CLOSE_RPC_TIMEOUT_MS = 2_000;
const WEBVIEW_BEST_EFFORT_CDP_TIMEOUT_MS = 2_000;
const WEBVIEW_CDP_MESSAGE_TIMEOUT_MS = 30_000;

const ROLE_CSS_MAP: Record<string, string[]> = {
  button: ['button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]'],
  textfield: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', 'textarea', '[role="textbox"]'],
  checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
  radio: ['input[type="radio"]', '[role="radio"]'],
  link: ['a[href]', '[role="link"]'],
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
  img: ['img', '[role="img"]'],
  list: ['ul', 'ol', '[role="list"]'],
  listitem: ['li', '[role="listitem"]'],
  switch: ['[role="switch"]'],
  slider: ['input[type="range"]', '[role="slider"]'],
  combobox: ['select', '[role="combobox"]'],
  tab: ['[role="tab"]'],
  progressbar: ['progress', '[role="progressbar"]'],
  dialog: ['dialog', '[role="dialog"]'],
  image: ['img', '[role="img"]'],
};

// ─── Strict mode (PILOT-227) ───

/** @internal — DOM-derived description of one matched element. */
interface WebViewDomDescription {
  tag: string
  id: string
  testId: string
  ariaLabel: string
  role: string
  text: string
}

/** @internal — Single-tick snapshot of a locator's full match set. */
export interface WebViewLocatorProbe {
  count: number
  /** Whether ANY match is visible (short-circuits in-page). False when the
   * caller skipped visibility computation (count/strict-resolve paths). */
  anyVisible: boolean
  /** Whether the locator's target element (nth-aware, first by default) is
   * visible. False when out of range or visibility was skipped. */
  targetVisible: boolean
  /** DOM descriptions of the first {@link STRICT_ERROR_MAX_ELEMENTS} matches. */
  sample: WebViewDomDescription[]
  /** Value read from the target element in the same round-trip, when the
   * caller passed `valueJs` (assertion value ticks). `found: false` when
   * there is no target at the locator's position yet. */
  target?: { found: boolean; value?: unknown }
}

/** Best-effort unambiguous WebView locator suggestion for one DOM match. */
function suggestWebViewSelectorFor(d: WebViewDomDescription | undefined): string | undefined {
  if (!d) return undefined;
  if (d.testId) return `webview.getByTestId(${JSON.stringify(d.testId)})`;
  if (d.id) return `webview.locator(${JSON.stringify('#' + d.id)})`;
  if (d.ariaLabel) return `webview.getByLabel(${JSON.stringify(d.ariaLabel)})`;
  if (d.text) return `webview.getByText(${JSON.stringify(truncateText(d.text, 60))}, { exact: true })`;
  return undefined;
}

/**
 * Build a StrictModeViolationError for a WebView locator, reusing the native
 * message format. Element descriptions come from the DOM (tag, text, id,
 * data-testid, aria-label) mapped onto the ElementInfo shape.
 */
function buildWebViewStrictError(loc: WebViewLocator, probe: WebViewLocatorProbe): StrictModeViolationError {
  const elements: ElementInfo[] = probe.sample.map((d) => ({
    elementId: '',
    className: d.tag,
    text: d.text,
    contentDescription: d.ariaLabel,
    resourceId: d.testId,
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: '',
    checked: false,
    selected: false,
    focused: false,
    role: d.role,
    viewportRatio: 0,
  }));
  return buildStrictModeViolationError(`"${loc._selector}"`, elements, {
    totalCount: probe.count,
    suggest: (_el, i) => suggestWebViewSelectorFor(probe.sample[i]),
  });
}

/** Normalize a positional index against a match count (negative = from end). */
function normalizeNthIndex(nthIndex: number, count: number): number {
  return nthIndex < 0 ? count + nthIndex : nthIndex;
}

export interface WebViewTraceContext {
  collector: TraceCollector
  /** Group name of the device hosting this WebView (multi-device tests). */
  deviceId?: string
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
}

interface CDPResponse {
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface CDPTarget {
  id: string
  title: string
  url: string
  webSocketDebuggerUrl: string
  type: string
}

export class WebViewHandle {
  private _ws: WebSocket | null = null;
  private _msgId = 0;
  private _pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
  }>();
  private _client: TapsmithGrpcClient;
  private _localPort: number;
  private _timeoutMs: number;
  private _closed = false;
  private _webviewNativeBounds: { left: number; top: number; right: number; bottom: number } | undefined;
  /** @internal */
  _traceCtx: WebViewTraceContext | null = null;

  // iOS WebKit Inspector fields (alternative to CDP WebSocket)
  private _inspector: WebKitInspectorClient | null = null;
  private _inspectorAppId: string | null = null;
  private _inspectorPageId: number | null = null;

  /** @internal — Platform for bounds lookup (WebView class name differs). */
  _platform: 'android' | 'ios' = 'android';

  /** @internal */
  constructor(client: TapsmithGrpcClient, localPort: number, timeoutMs: number) {
    this._client = client;
    this._localPort = localPort;
    this._timeoutMs = timeoutMs;
  }

  /** @internal — Create a WebViewHandle backed by WebKit Inspector (iOS). */
  static _createFromInspector(
    client: TapsmithGrpcClient,
    inspector: WebKitInspectorClient,
    appId: string,
    pageId: number,
    timeoutMs: number,
  ): WebViewHandle {
    const handle = new WebViewHandle(client, 0, timeoutMs);
    handle._inspector = inspector;
    handle._inspectorAppId = appId;
    handle._inspectorPageId = pageId;
    handle._platform = 'ios';
    return handle;
  }

  private get _useInspector(): boolean {
    return this._inspector !== null;
  }

  private _throwIfClosed(): void {
    if (this._closed) {
      throw new Error('WebView handle is closed');
    }
  }

  /** @internal — Get the screen-space bounds of an element inside the WebView. */
  async _getElementBounds(selectorOrFinderJs: string, finderJs?: string): Promise<{ left: number; top: number; right: number; bottom: number } | undefined> {
    try {
      const finder = finderJs ?? `document.querySelector(${JSON.stringify(selectorOrFinderJs)})`;
      // On Android, XCUITest returns bounds in px so we scale by devicePixelRatio.
      // On iOS, XCUITest returns bounds in points (= CSS px), so no scaling needed.
      const useDpr = this._platform === 'android';
      const rect = await this._evaluate(`(() => {
        const el = (${finder});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const dpr = ${useDpr ? 'window.devicePixelRatio || 1' : '1'};
        return { left: r.left * dpr, top: r.top * dpr, right: r.right * dpr, bottom: r.bottom * dpr };
      })()`, WEBVIEW_BEST_EFFORT_CDP_TIMEOUT_MS) as { left: number; top: number; right: number; bottom: number } | null;
      if (!rect) return undefined;

      // Look up the native WebView element's bounds to translate to screen coords.
      // Re-fetch each time since the WebView may have moved (scrolling, layout changes).
      {
        const webviewClassName = this._platform === 'ios'
          ? 'XCUIElementTypeWebView'
          : 'android.webkit.WebView';
        try {
          const res = await this._client.findElement(
            { kind: { type: 'className', value: webviewClassName } },
            200,
          );
          if (res.found && res.element?.bounds) {
            this._webviewNativeBounds = res.element.bounds;
          }
        } catch { /* best-effort */ }
      }

      if (this._webviewNativeBounds) {
        const wb = this._webviewNativeBounds;
        return {
          left: Math.round(wb.left + rect.left),
          top: Math.round(wb.top + rect.top),
          right: Math.round(wb.left + rect.right),
          bottom: Math.round(wb.top + rect.bottom),
        };
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async _traced<T>(action: string, selector: string | undefined, fn: (deadline: number) => Promise<T>, finderJs?: string): Promise<T> {
    const ctx = this._traceCtx;
    if (!ctx) return fn(Date.now() + this._timeoutMs);

    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const selectorStr = selector ? `css=${selector}` : undefined;

    const { actionIndex, captures: beforeCaptures } = await ctx.collector.captureBeforeAction(
      ctx.takeScreenshot,
      ctx.captureHierarchy,
    );

    // Stream a "started" lifecycle signal so UI mode can render an in-flight
    // row with a spinner while the WebView action runs.
    ctx.collector._emitActionStarted({
      category: 'webview',
      action,
      selector: selectorStr,
      sourceLocation,
      stack,
      deviceId: ctx.deviceId,
      log: [`webview.${action}(${selectorStr ?? ''})`],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
    }, actionIndex);

    const start = Date.now();
    const deadline = start + this._timeoutMs;
    let success = true;
    let error: string | undefined;
    let result: T;
    let failedByTimeout = false;
    let timeoutError: string | undefined;

    ctx.collector.setPendingOperation((errorMessage: string) => {
      failedByTimeout = true;
      timeoutError = errorMessage;
      ctx.collector.addActionEvent({
        category: 'webview', action, selector: selectorStr,
        duration: Date.now() - start, success: false, error: errorMessage,
        log: [`webview.${action}(${selectorStr ?? ''}) timed out: ${errorMessage}`],
        hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
        hasScreenshotAfter: false,
        hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
        hasHierarchyAfter: false,
        sourceLocation,
        stack,
        deviceId: ctx.deviceId,
      }, actionIndex);
    }, stack);

    try {
      result = await fn(deadline);
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      ctx.collector.clearPendingOperation();
      if (!failedByTimeout) {
        ctx.collector.addActionEvent({
          category: 'webview', action, selector: selectorStr,
          duration: Date.now() - start, success, error,
          log: [`webview.${action}(${selectorStr ?? ''}) failed: ${error}`],
          hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
          hasScreenshotAfter: false,
          hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
          hasHierarchyAfter: false,
          sourceLocation,
          stack,
          deviceId: ctx.deviceId,
        }, actionIndex);
      }
      throw err;
    }

    ctx.collector.clearPendingOperation();
    if (failedByTimeout) {
      throw new Error(timeoutError ?? `webview.${action}() timed out`);
    }

    // Look up element bounds after action succeeds (best-effort)
    let bounds: { left: number; top: number; right: number; bottom: number } | undefined;
    let point: { x: number; y: number } | undefined;
    if (selector) {
      bounds = await this._getElementBounds(selector, finderJs);
      if (bounds && action === 'click') {
        point = {
          x: (bounds.left + bounds.right) / 2,
          y: (bounds.top + bounds.bottom) / 2,
        };
      }
    }

    ctx.collector.addActionEvent({
      category: 'webview', action, selector: selectorStr,
      duration: Date.now() - start, success, error,
      bounds, point,
      log: [`webview.${action}(${selectorStr ?? ''})`],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      sourceLocation,
      stack,
      deviceId: ctx.deviceId,
    }, actionIndex);

    return result;
  }

  /** @internal — Connect to the WebView's CDP endpoint. */
  async _connect(): Promise<void> {
    this._throwIfClosed();
    const targets = await this._fetchTargets();
    this._throwIfClosed();
    const page = targets.find(t => t.type === 'page') ?? targets[0];
    if (!page) {
      throw new Error(
        'No WebView targets found. Ensure the WebView is visible and has debugging enabled.',
      );
    }

    let wsUrl = page.webSocketDebuggerUrl;
    // ios-webkit-debug-proxy may return relative WS URLs — make absolute
    if (wsUrl && !wsUrl.startsWith('ws')) {
      wsUrl = `ws://127.0.0.1:${this._localPort}${wsUrl}`;
    }

    if (!wsUrl) {
      throw new Error('WebView target did not expose a CDP WebSocket URL');
    }

    await this._connectWebSocket(wsUrl);
    this._throwIfClosed();
    await this._send('Runtime.enable', {}, Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS));
    this._throwIfClosed();
    await this._send('Page.enable', {}, Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS));
  }

  private async _fetchTargets(): Promise<CDPTarget[]> {
    // Retry with backoff for up to 10s. The outer loop in _webviewAndroid
    // owns the full timeout and re-lists WebViews / re-forwards ports
    // between attempts, so we keep this window short.
    const deadline = Date.now() + Math.min(this._timeoutMs, 10_000);
    let delayMs = 100;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      this._throwIfClosed();
      try {
        const fetchTimeoutMs = Math.max(1, Math.min(5000, deadline - Date.now()));
        const resp = await fetch(`http://127.0.0.1:${this._localPort}/json`, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        this._throwIfClosed();
        if (!resp.ok) {
          throw new Error(`CDP /json returned ${resp.status}`);
        }
        return (await resp.json()) as CDPTarget[];
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (Date.now() + delayMs >= deadline) break;
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 2000);
      }
    }

    throw new Error(
      `WebView debug socket not available after retry: ${lastError?.message}`,
    );
  }

  private _connectWebSocket(url: string): Promise<void> {
    this._throwIfClosed();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS);
      const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => {
        finish(() => {
          ws.terminate();
          reject(new Error(`WebView CDP WebSocket connection timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      function finish(fn: () => void) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      }
      ws.on('open', () => {
        finish(() => {
          if (this._closed) {
            ws.terminate();
            reject(new Error('WebView handle is closed'));
            return;
          }
          this._ws = ws;
          resolve();
        });
      });
      ws.on('error', (err) => {
        if (!this._ws) {
          finish(() => reject(err));
        }
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as CDPResponse;
        if (msg.id !== undefined) {
          const pending = this._pending.get(msg.id);
          if (pending) {
            this._pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`CDP error: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result ?? {});
            }
          }
        }
      });
      ws.on('close', () => {
        if (!this._ws) {
          finish(() => reject(new Error('WebView CDP WebSocket closed before opening')));
        }
        this._ws = null;
        for (const [, p] of this._pending) {
          p.reject(new Error('WebView CDP connection closed'));
        }
        this._pending.clear();
      });
    });
  }

  /** @internal */
  async _send(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    this._throwIfClosed();
    if (this._useInspector) {
      const id = ++this._msgId;
      // Honor the caller's timeout — best-effort callers (DOM dumps, page
      // probes) pass a short one so a dead inspector target fails fast
      // instead of hanging for the default 30s.
      return this._inspector!.sendInspectorMessage(this._inspectorAppId!, {
        id,
        method,
        params,
      }, timeoutMs);
    }

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebView CDP connection is not open');
    }
    const id = ++this._msgId;
    return new Promise((resolve, reject) => {
      const messageTimeoutMs = Math.max(1, Math.min(timeoutMs ?? WEBVIEW_CDP_MESSAGE_TIMEOUT_MS, WEBVIEW_CDP_MESSAGE_TIMEOUT_MS));
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP message timed out (method=${method}, id=${id})`));
      }, messageTimeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this._ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** @internal — Evaluate JS and return the result value. */
  async _evaluate(expression: string, timeoutMs?: number): Promise<unknown> {
    const rawResult = await this._send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);
    // WebKit Inspector wraps the response in a 'result' key at the top level
    const result = (this._useInspector
      ? (rawResult as Record<string, unknown>).result as Record<string, unknown> | undefined ?? rawResult
      : rawResult
    ) as { result?: { value?: unknown; type?: string; subtype?: string; description?: string }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      throw new Error(`WebView JS error: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  /** @internal — Wait for a CSS selector to match an element in the DOM. */
  async _waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this._timeoutMs;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const found = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}) !== null`,
        remaining,
      );
      if (found) return;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    throw new Error(
      `Timed out waiting for selector "${selector}" in WebView (${timeout}ms)`,
    );
  }

  /**
   * @internal — Single-tick probe of a locator's full match set: count,
   * per-match visibility, and DOM descriptions of the first matches (for
   * strict violation messages). Pass `visibility: false` on paths that only
   * need the count (strict resolve, count()) to skip a getComputedStyle
   * call per match. Pass `valueJs` (an expression over `el`) to also read a
   * value from the target element in the same round-trip — the whole
   * count-check + read is then one atomic DOM snapshot.
   */
  async _probeLocator(
    loc: WebViewLocator,
    timeoutMs?: number,
    opts?: { visibility?: boolean; valueJs?: string },
  ): Promise<WebViewLocatorProbe> {
    const withVisibility = opts?.visibility !== false;
    // The target index mirrors _finderJs: nth-aware, defaulting to the first
    // match — strict callers throw on count > 1 before consulting the target.
    const nthIndex = loc._nthIndex ?? 0;
    const idxJs = nthIndex >= 0 ? String(nthIndex) : `els.length - ${-nthIndex}`;
    const targetJs = opts?.valueJs
      ? `(() => {
          const el = els[${idxJs}] ?? null;
          if (!el) return { found: false };
          return { found: true, value: (${opts.valueJs}) };
        })()`
      : 'undefined';
    const probe = await this._evaluate(`(() => {
      const els = (${loc._finderAllJs});
      const vis = (el) => {
        // No client rects ⇒ not rendered at all (covers ancestors with
        // display:none, which the element's own computed style would miss).
        if (el.getClientRects().length === 0) return false;
        const s = window.getComputedStyle(el);
        if (!s) return false;
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      return {
        count: els.length,
        anyVisible: ${withVisibility ? 'els.some(vis)' : 'false'},
        targetVisible: ${withVisibility ? `(els[${idxJs}] ? vis(els[${idxJs}]) : false)` : 'false'},
        sample: els.slice(0, ${STRICT_ERROR_MAX_ELEMENTS}).map((el) => ({
          tag: (el.tagName || '').toLowerCase(),
          id: el.id || '',
          testId: el.getAttribute('data-testid') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          text: (el.textContent || '').trim().slice(0, 80),
        })),
        target: ${targetJs},
      };
    })()`, timeoutMs);
    return probe as WebViewLocatorProbe;
  }

  /**
   * @internal — Strict auto-waiting resolution for locator actions (PILOT-227).
   *
   * Polls until the locator resolves to a target: exactly one match, or —
   * for positionally-narrowed locators — the nth index in range. Resolving
   * to more than one match without a positional modifier throws a
   * StrictModeViolationError immediately (no further waiting), mirroring
   * native locators. (A race between this check and the subsequent action
   * evaluate is accepted — both see elements in document order.)
   */
  async _resolveLocatorStrict(loc: WebViewLocator, timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this._timeoutMs;
    const deadline = Date.now() + timeout;
    while (true) {
      const remaining = Math.max(1, deadline - Date.now());
      const probe = await this._probeLocator(loc, remaining, { visibility: false });
      if (loc._nthIndex !== undefined) {
        const idx = normalizeNthIndex(loc._nthIndex, probe.count);
        if (idx >= 0 && idx < probe.count) return;
      } else {
        if (probe.count > 1) throw buildWebViewStrictError(loc, probe);
        if (probe.count === 1) return;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    throw new Error(
      `Timed out waiting for "${loc._selector}" in WebView (${timeout}ms)`,
    );
  }

  /**
   * @internal — Single-tick assertion resolution (expect.ts, PILOT-227).
   *
   * When `strict` is true and the locator has no positional modifier,
   * resolving to more than one match throws a StrictModeViolationError
   * (which propagates out of the assertion poll loop). Absence-style checks
   * (toBeHidden, negated visibility/existence) pass `strict: false` and
   * evaluate their condition over the full match set.
   */
  async _assertionTickLocator(
    loc: WebViewLocator,
    strict: boolean,
  ): Promise<{ exists: boolean; anyVisible: boolean; allHidden: boolean }> {
    const probe = await this._probeLocator(loc, Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS));
    if (loc._nthIndex !== undefined) {
      const idx = normalizeNthIndex(loc._nthIndex, probe.count);
      const exists = idx >= 0 && idx < probe.count;
      const visible = exists && probe.targetVisible;
      return { exists, anyVisible: visible, allHidden: !visible };
    }
    if (strict && probe.count > 1) throw buildWebViewStrictError(loc, probe);
    // allHidden ≡ !anyVisible: an empty match set is vacuously all-hidden.
    return {
      exists: probe.count > 0,
      anyVisible: probe.anyVisible,
      allHidden: !probe.anyVisible,
    };
  }

  /** @internal — Count matches for a locator (single tick, no auto-wait). */
  async _countLocator(loc: WebViewLocator): Promise<number> {
    const probe = await this._probeLocator(
      loc,
      Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS),
      { visibility: false },
    );
    if (loc._nthIndex !== undefined) {
      const idx = normalizeNthIndex(loc._nthIndex, probe.count);
      return idx >= 0 && idx < probe.count ? 1 : 0;
    }
    return probe.count;
  }

  /**
   * @internal — Single-tick strict value read for assertion polls (expect.ts).
   *
   * Resolves the target once — throwing a StrictModeViolationError on an
   * ambiguous match — then reads `valueJs` (an expression over `el`) from it.
   * Never auto-waits, so each assertion poll tick stays bounded by the
   * assertion's own timeout instead of the locator's full auto-wait budget.
   * Returns `{ found: false }` when there is no target yet (or it vanished
   * between the probe and the read — the caller's poll loop retries).
   */
  async _valueTickLocator(loc: WebViewLocator, valueJs: string): Promise<{ found: boolean; value?: unknown }> {
    const tickTimeout = Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS);
    // Single round-trip: the probe reads the target value in the same DOM
    // snapshot as the strictness count, so the check and the read can't race.
    const probe = await this._probeLocator(loc, tickTimeout, { visibility: false, valueJs });
    if (loc._nthIndex === undefined && probe.count > 1) {
      throw buildWebViewStrictError(loc, probe);
    }
    return probe.target ?? { found: false };
  }

  // ─── Locator-based actions (used by WebViewLocator) ───

  /** @internal */
  async _clickLocator(loc: WebViewLocator): Promise<void> {
    return this._traced('click', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      await this._evaluate(`(${loc._finderJs}).click()`, remainingUntil(deadline));
    }, loc._finderJs);
  }

  /** @internal */
  async _fillLocator(loc: WebViewLocator, value: string): Promise<void> {
    return this._traced('fill', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const escaped = JSON.stringify(value);
      await this._evaluate(`(() => {
        const el = (${loc._finderJs});
        el.value = ${escaped};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`, remainingUntil(deadline));
    }, loc._finderJs);
  }

  /** @internal */
  async _textContentLocator(loc: WebViewLocator): Promise<string> {
    return this._traced('textContent', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(`(${loc._finderJs}).textContent`, remainingUntil(deadline));
      return (result as string) ?? '';
    }, loc._finderJs);
  }

  /** @internal */
  async _innerHTMLLocator(loc: WebViewLocator): Promise<string> {
    return this._traced('innerHTML', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(`(${loc._finderJs}).innerHTML`, remainingUntil(deadline));
      return (result as string) ?? '';
    }, loc._finderJs);
  }

  /** @internal */
  async _inputValueLocator(loc: WebViewLocator): Promise<string> {
    return this._traced('inputValue', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(`(${loc._finderJs}).value`, remainingUntil(deadline));
      return (result as string) ?? '';
    }, loc._finderJs);
  }

  /** @internal */
  async _getAttributeLocator(loc: WebViewLocator, name: string): Promise<string | null> {
    return this._traced('getAttribute', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(
        `(${loc._finderJs}).getAttribute(${JSON.stringify(name)})`,
        remainingUntil(deadline),
      );
      return result as string | null;
    }, loc._finderJs);
  }

  /** @internal — Single-tick visibility query. Strict: an ambiguous locator
   * (no positional modifier, >1 match) throws instead of silently reporting
   * the first match's visibility. Traced under the calling probe's name
   * (`isVisible`/`isHidden`) like every other locator method, so the probe
   * shows up as its own row in a trace rather than leaving a gap. */
  async _isVisibleLocator(loc: WebViewLocator, action: 'isVisible' | 'isHidden' = 'isVisible'): Promise<boolean> {
    return this._traced(action, loc._selector, async () => {
      const probe = await this._probeLocator(loc, Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS));
      if (loc._nthIndex !== undefined) {
        const idx = normalizeNthIndex(loc._nthIndex, probe.count);
        return idx >= 0 && idx < probe.count && probe.targetVisible;
      }
      if (probe.count > 1) throw buildWebViewStrictError(loc, probe);
      return probe.count === 1 && probe.targetVisible;
    }, loc._finderJs);
  }

  /**
   * @internal — Dump the WebView DOM as hierarchy XML nodes for the Locator Playground.
   * Each visible DOM element becomes a node with bounds in screen coordinates.
   */
  async _dumpDomHierarchy(): Promise<string | undefined> {
    try {
      // Ensure we have the native WebView bounds for coordinate translation
      if (!this._webviewNativeBounds) {
        const webviewClassName = this._platform === 'ios'
          ? 'XCUIElementTypeWebView'
          : 'android.webkit.WebView';
        try {
          const res = await this._client.findElement(
            { kind: { type: 'className', value: webviewClassName } },
            200,
          );
          if (res.found && res.element?.bounds) {
            this._webviewNativeBounds = res.element.bounds;
          }
        } catch { /* best-effort */ }
      }

      const wb = this._webviewNativeBounds;
      if (!wb) return undefined;

      const useDpr = this._platform === 'android';

      // Evaluate JS to walk the DOM and produce a hierarchy
      const domData = await this._evaluate(`(() => {
        const dpr = ${useDpr ? 'window.devicePixelRatio || 1' : '1'};
        function walk(el, depth) {
          if (depth > 20) return null;
          const tag = el.tagName?.toLowerCase() || '';
          if (!tag || tag === 'script' || tag === 'style' || tag === 'head') return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          const node = {
            tag: tag,
            id: el.id || '',
            cls: el.className || '',
            text: el.children.length === 0 ? (el.textContent || '').trim().slice(0, 200) : '',
            placeholder: el.placeholder || '',
            role: el.getAttribute('role') || '',
            ariaLabel: (() => {
              var lblBy = el.getAttribute('aria-labelledby');
              if (lblBy) { var ref = document.getElementById(lblBy); if (ref) return ref.textContent?.trim() || ''; }
              if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
              if (el.id) { var lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']'); if (lbl) return lbl.textContent?.trim() || ''; }
              if (el.closest && el.closest('label')) { var wrapper = el.closest('label'); var clone = wrapper.cloneNode(true); clone.querySelectorAll('input,select,textarea').forEach(function(c){c.remove();}); var t = clone.textContent?.trim(); if (t) return t; }
              return '';
            })(),
            testId: el.getAttribute('data-testid') || '',
            type: el.getAttribute('type') || '',
            href: tag === 'a' ? (el.getAttribute('href') || '') : '',
            bounds: {
              left: Math.round(r.left * dpr),
              top: Math.round(r.top * dpr),
              right: Math.round(r.right * dpr),
              bottom: Math.round(r.bottom * dpr),
            },
            children: [],
          };
          for (const child of el.children) {
            const c = walk(child, depth + 1);
            if (c) node.children.push(c);
          }
          return node;
        }
        return walk(document.body, 0);
      })()`, WEBVIEW_BEST_EFFORT_CDP_TIMEOUT_MS) as DomNode | null;

      if (!domData) return undefined;

      // Convert to hierarchy XML format
      const lines: string[] = [];
      function renderNode(node: DomNode) {
        const bounds = `[${wb!.left + node.bounds.left},${wb!.top + node.bounds.top}][${wb!.left + node.bounds.right},${wb!.top + node.bounds.bottom}]`;
        const attrs: string[] = [
          `bounds="${bounds}"`,
          `class="webview.${node.tag}"`,
          `webview-tag="${node.tag}"`,
        ];
        if (node.text) attrs.push(`text="${escapeXmlAttr(node.text)}"`);
        if (node.id) attrs.push(`webview-id="${escapeXmlAttr(node.id)}"`);
        if (node.cls) attrs.push(`webview-class="${escapeXmlAttr(typeof node.cls === 'string' ? node.cls : '')}"`);
        if (node.placeholder) attrs.push(`hint="${escapeXmlAttr(node.placeholder)}"`);
        if (node.role) attrs.push(`webview-role="${escapeXmlAttr(node.role)}"`);
        if (node.ariaLabel) attrs.push(`content-desc="${escapeXmlAttr(node.ariaLabel)}"`);
        if (node.testId) attrs.push(`webview-testid="${escapeXmlAttr(node.testId)}"`);
        if (node.type) attrs.push(`webview-type="${escapeXmlAttr(node.type)}"`);
        if (node.href) attrs.push(`webview-href="${escapeXmlAttr(node.href)}"`);
        attrs.push('webview="true"');

        if (node.children.length === 0) {
          lines.push(`<webview.${node.tag} ${attrs.join(' ')} />`);
        } else {
          lines.push(`<webview.${node.tag} ${attrs.join(' ')}>`);
          for (const child of node.children) {
            renderNode(child);
          }
          lines.push(`</webview.${node.tag}>`);
        }
      }

      renderNode(domData);
      return lines.join('\n');
    } catch {
      return undefined;
    }
  }

  // ─── Public API ───

  async click(selector: string): Promise<void> {
    return this._traced('click', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).click()`,
        remainingUntil(deadline),
      );
    });
  }

  async fill(selector: string, value: string): Promise<void> {
    return this._traced('fill', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const escaped = JSON.stringify(value);
      await this._evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${escaped};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`, remainingUntil(deadline));
    });
  }

  async textContent(selector: string): Promise<string> {
    return this._traced('textContent', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).textContent`,
        remainingUntil(deadline),
      );
      return (result as string) ?? '';
    });
  }

  async innerHTML(selector: string): Promise<string> {
    return this._traced('innerHTML', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).innerHTML`,
        remainingUntil(deadline),
      );
      return (result as string) ?? '';
    });
  }

  async getAttribute(selector: string, name: string): Promise<string | null> {
    return this._traced('getAttribute', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(name)})`,
        remainingUntil(deadline),
      );
      return result as string | null;
    });
  }

  async inputValue(selector: string): Promise<string> {
    return this._traced('inputValue', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value`,
        remainingUntil(deadline),
      );
      return (result as string) ?? '';
    });
  }

  async isVisible(selector: string): Promise<boolean> {
    return this._traced('isVisible', selector, () => this._isVisibleSelector(selector));
  }

  /**
   * The opposite of {@link isVisible}: `true` when no element matches the
   * selector or the match is not visible. One DOM read, no auto-wait. Mirrors
   * `ElementHandle.isHidden()` / `WebViewLocator.isHidden()`. Traced under its
   * own name, like the locator form, so the check is a row in the trace.
   */
  async isHidden(selector: string): Promise<boolean> {
    return this._traced('isHidden', selector, async () => !(await this._isVisibleSelector(selector)));
  }

  /** Single DOM read behind the string-selector visibility probes. */
  private async _isVisibleSelector(selector: string): Promise<boolean> {
    const result = await this._evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (el.getClientRects().length === 0) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    })()`, Math.min(this._timeoutMs, WEB_SOCKET_CONNECT_TIMEOUT_MS));
    return result as boolean;
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return this._traced('evaluate', undefined, async (deadline) => {
      return (await this._evaluate(expression, remainingUntil(deadline))) as T;
    });
  }

  async goto(url: string): Promise<void> {
    return this._traced('goto', url, async (deadline) => {
      await this._send('Page.navigate', { url }, remainingUntil(deadline));
    });
  }

  async title(): Promise<string> {
    return (await this._evaluate('document.title')) as string;
  }

  async url(): Promise<string> {
    return (await this._evaluate('window.location.href')) as string;
  }

  // ─── Playwright-style locators ───

  /** Locate an element by its visible text content. Substring match by default. */
  getByText(text: string, options?: { exact?: boolean }): WebViewLocator {
    const escaped = JSON.stringify(text);
    const finderAllJs = options?.exact
      ? `(() => { const out = []; for (const el of document.querySelectorAll('*')) { if (el.children.length === 0 && el.textContent?.trim() === ${escaped}) out.push(el); } return out; })()`
      : `(() => { const out = []; for (const el of document.querySelectorAll('*')) { if (el.children.length === 0 && el.textContent?.includes(${escaped})) out.push(el); } return out; })()`;
    return new WebViewLocator(this, `text=${text}`, this._timeoutMs, finderAllJs);
  }

  /** Locate an element by its ARIA/HTML role, optionally filtered by accessible name. */
  getByRole(role: string, options?: { name?: string }): WebViewLocator {
    const cssSelectors = ROLE_CSS_MAP[role];
    // `!== undefined` (not truthiness) so an explicit empty name still filters.
    const hasName = options?.name !== undefined;
    const displaySuffix = hasName ? `[name=${options!.name}]` : '';
    if (!cssSelectors) {
      // Filter [role] elements by attribute comparison rather than
      // interpolating the role into a CSS selector, where special
      // characters could break the query.
      const roleEscaped = JSON.stringify(role);
      const finderAllJs = hasName
        ? `(() => { const out = []; for (const el of document.querySelectorAll('[role]')) { if (el.getAttribute('role') === ${roleEscaped} && (el.getAttribute('aria-label') === ${JSON.stringify(options!.name)} || el.textContent?.trim() === ${JSON.stringify(options!.name)})) out.push(el); } return out; })()`
        : `(() => { const out = []; for (const el of document.querySelectorAll('[role]')) { if (el.getAttribute('role') === ${roleEscaped}) out.push(el); } return out; })()`;
      return new WebViewLocator(this, `role=${role}${displaySuffix}`, this._timeoutMs, finderAllJs);
    }

    const selectorList = cssSelectors.join(', ');
    const displayName = `role=${role}${displaySuffix}`;

    if (!hasName) {
      return new WebViewLocator(this, displayName, this._timeoutMs,
        `Array.from(document.querySelectorAll(${JSON.stringify(selectorList)}))`);
    }

    // Non-null: hasName guarantees options.name is set (TS can't narrow through the const).
    const nameEscaped = JSON.stringify(options!.name);
    // W3C Accessible Name computation (matches Playwright's getByRole):
    // 1. aria-labelledby  2. aria-label  3. <label> (for or wrapping)
    // 4. title  5. placeholder  6. textContent (buttons/links only)
    const finderAllJs = `(() => {
      function accessibleName(el) {
        var lblBy = el.getAttribute('aria-labelledby');
        if (lblBy) { var ref = document.getElementById(lblBy); if (ref) return ref.textContent?.trim() || ''; }
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        if (el.id) { var lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']'); if (lbl) return lbl.textContent?.trim() || ''; }
        if (el.closest('label')) { var wrapper = el.closest('label'); var clone = wrapper.cloneNode(true); clone.querySelectorAll('input,select,textarea').forEach(function(c){c.remove();}); var t = clone.textContent?.trim(); if (t) return t; }
        if (el.getAttribute('title')) return el.getAttribute('title');
        if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
        return el.textContent?.trim() || '';
      }
      const out = [];
      for (const el of document.querySelectorAll(${JSON.stringify(selectorList)})) {
        if (accessibleName(el) === ${nameEscaped}) out.push(el);
      }
      return out;
    })()`;
    return new WebViewLocator(this, displayName, this._timeoutMs, finderAllJs);
  }

  /** Locate an element by its placeholder text. */
  getByPlaceholder(text: string): WebViewLocator {
    return new WebViewLocator(this, `placeholder=${text}`, this._timeoutMs,
      `Array.from(document.querySelectorAll('[placeholder=' + JSON.stringify(${JSON.stringify(text)}) + ']'))`);
  }

  /** Locate an element by its `data-testid` attribute. */
  getByTestId(testId: string): WebViewLocator {
    return new WebViewLocator(this, `testId=${testId}`, this._timeoutMs,
      `Array.from(document.querySelectorAll('[data-testid=' + JSON.stringify(${JSON.stringify(testId)}) + ']'))`);
  }

  /** Locate an element by its `aria-label`. */
  getByLabel(text: string): WebViewLocator {
    return new WebViewLocator(this, `label=${text}`, this._timeoutMs,
      `Array.from(document.querySelectorAll('[aria-label=' + JSON.stringify(${JSON.stringify(text)}) + ']'))`);
  }

  /** Locate an element by CSS selector. */
  locator(cssSelector: string): WebViewLocator {
    return new WebViewLocator(this, cssSelector, this._timeoutMs);
  }

  /** @internal — Check if this handle is still usable (WebSocket open or inspector connected). */
  _isAlive(): boolean {
    if (this._closed) return false;
    if (this._useInspector) {
      return this._inspector !== null && this._inspector.isConnected() && !this._inspector.pageReplaced;
    }
    return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this._inspector) {
      this._inspector.close();
      this._inspector = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._localPort > 0) {
      try {
        await this._client.closeWebViewPort(this._localPort, WEBVIEW_CLOSE_RPC_TIMEOUT_MS);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

function remainingUntil(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface DomNode {
  tag: string
  id: string
  cls: string | { toString(): string }
  text: string
  placeholder: string
  role: string
  ariaLabel: string
  testId: string
  type: string
  href: string
  bounds: { left: number; top: number; right: number; bottom: number }
  children: DomNode[]
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
