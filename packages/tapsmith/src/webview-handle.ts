import { WebSocket } from 'ws';
import type { ElementInfo, TapsmithGrpcClient } from './grpc-client.js';
import {
  buildStrictModeViolationError,
  STRICT_ERROR_MAX_ELEMENTS,
  type StrictModeViolationError,
} from './element-handle.js';
import { WebViewLocator } from './webview-locator.js';
import { escapeJsString } from './js-string-escape.js';
import { checkOptions, checkTimeout, type TimeoutOptions } from './action-options.js';
import { cssIdSelector } from './css-selector.js';
import { ACTION_RETRY_DELAYS_MS, backoff } from './retry-schedule.js';
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
  /** No child elements: the only kind of element webview.getByText finds. */
  leaf: boolean
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
  // Copy-paste-safe string literals, like the native suggestions (PILOT-659).
  const lit = (v: string): string => `"${escapeJsString(v)}"`;
  if (d.testId) return `webview.getByTestId(${lit(d.testId)})`;
  if (d.id) return `webview.locator(${lit(cssIdSelector(d.id))})`;
  if (d.ariaLabel) return `webview.getByLabel(${lit(d.ariaLabel)})`;
  // getByText finds leaf elements only: a parent's text would resolve to the
  // child holding it, or to nothing when it spans several (PILOT-666).
  if (d.text && d.leaf) {
    // An exact match needs the whole text: a long one is suggested as its
    // leading part, matched as a substring.
    const exact = d.text.length <= 60;
    return `webview.getByText(${lit(exact ? d.text : d.text.slice(0, 60))}${exact ? ', { exact: true }' : ''})`;
  }
  return undefined;
}

/**
 * Slack for judging a failed read as having run into the deadline: the
 * transport's timer and `Date.now()` can disagree by a millisecond or two.
 */
const DEADLINE_SLACK_MS = 250;

/**
 * Whether a wait loop's read that failed with `err` is the loop's deadline
 * miss rather than an error of its own (PILOT-840). The last read starts with
 * whatever is left of the timeout, often a few milliseconds, so its CDP or
 * WebKit Inspector request times out: that means "not found in time". It is
 * the miss only when the page has answered an earlier read (a connection that
 * never answers is reported as itself, as the native loops report a stalled
 * agent) and the deadline is reached (CDP caps a request at 30 s, so a read
 * of a longer wait can time out early). Any other failure is its own error.
 */
function isDeadlineMiss(err: unknown, answered: boolean, deadline: number): boolean {
  return answered && Date.now() >= deadline - DEADLINE_SLACK_MS &&
    err instanceof Error && /^(CDP|WebKit Inspector) message timed out\b/.test(err.message);
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

/**
 * A connection to the app's WebView, from `device.webview()`. Its locators
 * and selector methods query the DOM. Actions and value reads, such as
 * `click()` and `textContent()`, auto-wait, as native ones do; snapshot
 * reads, such as `isVisible()` and `isHidden()`, and `evaluate()` do not.
 */
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

  /** @internal — The timeout every later wait on this handle gets (set once connected). */
  _setTimeoutMs(timeoutMs: number): void {
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

  private async _traced<T>(
    action: string,
    selector: string | undefined,
    fn: (deadline: number) => Promise<T>,
    finderJs?: string,
    timeoutMs: number = this._timeoutMs,
  ): Promise<T> {
    const ctx = this._traceCtx;
    if (!ctx) return fn(Date.now() + timeoutMs);

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
    const deadline = start + timeoutMs;
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

  /** @internal — The run's abort signal (a user stop), from the device client. */
  _getAbortSignal(): AbortSignal | undefined {
    return this._client._getAbortSignal?.();
  }

  /** @internal — Wait for a CSS selector to match an element in the DOM. */
  async _waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this._timeoutMs;
    const deadline = Date.now() + timeout;
    let lastReadError: unknown;
    let answered = false;
    const nextDelay = backoff(ACTION_RETRY_DELAYS_MS);
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let found: unknown;
      try {
        found = await this._evaluate(
          `document.querySelector(${JSON.stringify(selector)}) !== null`,
          remaining,
        );
      } catch (err) {
        // A read that ran into the deadline (its transport timed out) is a
        // miss at the deadline, not an error of its own (PILOT-840).
        if (!isDeadlineMiss(err, answered, deadline)) throw err;
        lastReadError = err;
        break;
      }
      answered = true;
      if (found) return;
      await sleep(nextDelay(deadline));
    }
    throw new Error(
      `Timed out waiting for selector "${selector}" in WebView (${timeout}ms)`,
      lastReadError === undefined ? undefined : { cause: lastReadError },
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
          leaf: el.children.length === 0,
        })),
        target: ${targetJs},
      };
    })()`, timeoutMs);
    return probe as WebViewLocatorProbe;
  }

  /**
   * @internal — Strict auto-waiting resolution for locator actions.
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
    let lastReadError: unknown;
    let answered = false;
    const nextDelay = backoff(ACTION_RETRY_DELAYS_MS);
    while (true) {
      const remaining = Math.max(1, deadline - Date.now());
      let probe: WebViewLocatorProbe;
      try {
        probe = await this._probeLocator(loc, remaining, { visibility: false });
      } catch (err) {
        // The last read starts with what is left of the timeout, often a few
        // milliseconds: its transport timing out means the locator was not
        // found in time, and the error should say that (PILOT-840).
        if (!isDeadlineMiss(err, answered, deadline)) throw err;
        lastReadError = err;
        break;
      }
      answered = true;
      if (loc._nthIndex !== undefined) {
        const idx = normalizeNthIndex(loc._nthIndex, probe.count);
        if (idx >= 0 && idx < probe.count) return;
      } else {
        if (probe.count > 1) throw buildWebViewStrictError(loc, probe);
        if (probe.count === 1) return;
      }
      if (Date.now() >= deadline) break;
      await sleep(nextDelay(deadline));
    }
    throw new Error(
      `Timed out waiting for "${loc._selector}" in WebView (${timeout}ms)`,
      lastReadError === undefined ? undefined : { cause: lastReadError },
    );
  }

  /**
   * @internal — Single-tick assertion resolution (expect.ts).
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
   * @internal — A locator's current matches with their screen bounds, mapped
   * as {@link _dumpDomHierarchy} maps its nodes, so UI mode's live Locator
   * tab can draw them on the device mirror and tell a picked element from
   * another. Single tick; at most `max` matches are described.
   * `bounds` is absent when the WebView's place on screen is not known.
   */
  async _liveMatches(loc: WebViewLocator, timeoutMs: number, max = 200): Promise<{
    count: number
    total: number
    matches: Array<{ tag: string; id: string; testId: string; bounds?: { left: number; top: number; right: number; bottom: number } }>
    /** Where the WebView is on screen, when found: matches outside it are scrolled out of view. */
    viewport?: { left: number; top: number; right: number; bottom: number }
  }> {
    const nth = loc._nthIndex;
    const idxJs = nth === undefined ? 'null' : nth >= 0 ? String(nth) : `els.length - ${-nth}`;
    const useDpr = this._platform === 'android';
    const found = await this._evaluate(`(() => {
      const els = (${loc._finderAllJs});
      const idx = ${idxJs};
      const picked = idx === null ? els.slice(0, ${max}) : (idx >= 0 && idx < els.length ? [els[idx]] : []);
      const dpr = ${useDpr ? 'window.devicePixelRatio || 1' : '1'};
      return {
        total: els.length,
        matches: picked.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: (el.tagName || '').toLowerCase(),
            id: el.id || '',
            testId: el.getAttribute('data-testid') || '',
            rect: { left: r.left * dpr, top: r.top * dpr, right: r.right * dpr, bottom: r.bottom * dpr },
          };
        }),
      };
    })()`, timeoutMs) as { total: number; matches: Array<{ tag: string; id: string; testId: string; rect: { left: number; top: number; right: number; bottom: number } }> };
    // Found afresh each time: the WebView may have moved, or left the screen
    // while its page stays loaded (a covered stack screen) — then a cached
    // place would draw its matches over whatever is showing now.
    let wb: { left: number; top: number; right: number; bottom: number } | undefined;
    try {
      const res = await this._client.findElement(
        { kind: { type: 'className', value: this._platform === 'ios' ? 'XCUIElementTypeWebView' : 'android.webkit.WebView' } },
        200,
      );
      if (res.found && res.element?.bounds) wb = this._webviewNativeBounds = res.element.bounds;
    } catch { /* best-effort: bounds stay unknown */ }
    const count = nth === undefined ? found.total : found.matches.length;
    return {
      count,
      total: found.total,
      viewport: wb,
      matches: found.matches.map(({ rect, ...m }) => ({
        ...m,
        bounds: wb
          ? {
            left: Math.round(wb.left + rect.left),
            top: Math.round(wb.top + rect.top),
            right: Math.round(wb.left + rect.right),
            bottom: Math.round(wb.top + rect.bottom),
          }
          : undefined,
      })),
    };
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
  async _clickLocator(loc: WebViewLocator, timeoutMs?: number): Promise<void> {
    return this._traced('click', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      await this._evaluate(`(${loc._finderJs}).click()`, remainingUntil(deadline));
    }, loc._finderJs, timeoutMs);
  }

  /** @internal */
  async _fillLocator(loc: WebViewLocator, value: string, timeoutMs?: number): Promise<void> {
    return this._traced('fill', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const escaped = JSON.stringify(value);
      await this._evaluate(`(() => {
        const el = (${loc._finderJs});
        el.value = ${escaped};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`, remainingUntil(deadline));
    }, loc._finderJs, timeoutMs);
  }

  /** @internal */
  async _textContentLocator(loc: WebViewLocator, timeoutMs?: number): Promise<string> {
    return this._traced('textContent', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(`(${loc._finderJs}).textContent`, remainingUntil(deadline));
      return (result as string) ?? '';
    }, loc._finderJs, timeoutMs);
  }

  /** @internal */
  async _innerHTMLLocator(loc: WebViewLocator, timeoutMs?: number): Promise<string> {
    return this._traced('innerHTML', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(`(${loc._finderJs}).innerHTML`, remainingUntil(deadline));
      return (result as string) ?? '';
    }, loc._finderJs, timeoutMs);
  }

  /** @internal */
  async _inputValueLocator(loc: WebViewLocator, timeoutMs?: number): Promise<string> {
    return this._traced('inputValue', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(`(${loc._finderJs}).value`, remainingUntil(deadline));
      return (result as string) ?? '';
    }, loc._finderJs, timeoutMs);
  }

  /** @internal */
  async _getAttributeLocator(loc: WebViewLocator, name: string, timeoutMs?: number): Promise<string | null> {
    return this._traced('getAttribute', loc._selector, async (deadline) => {
      await this._resolveLocatorStrict(loc, remainingUntil(deadline));
      const result = await this._evaluate(
        `(${loc._finderJs}).getAttribute(${JSON.stringify(name)})`,
        remainingUntil(deadline),
      );
      return result as string | null;
    }, loc._finderJs, timeoutMs);
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
            // The attribute alone: what webview.getByLabel matches (PILOT-666).
            ariaLabelAttr: el.getAttribute('aria-label') || '',
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
        // Always written, so a reader can tell "no aria-label" from a dump
        // that predates the attribute.
        attrs.push(`webview-aria-label="${escapeXmlAttr(node.ariaLabelAttr ?? '')}"`);
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

  /**
   * `webview.click(selector)` on the first element matching the CSS selector, once it is in the DOM.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   including the wait for the selector. Defaults to the WebView's timeout.
   */
  async click(selector: string, options?: TimeoutOptions): Promise<void> {
    const timeout = checkTimeout('webview.click()', checkOptions('webview.click()', options, ['timeout'])?.timeout);
    return this._traced('click', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).click()`,
        remainingUntil(deadline),
      );
    }, undefined, timeout);
  }

  /**
   * `webview.fill(selector, value)` on the first element matching the CSS selector, once it is in the DOM.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   including the wait for the selector. Defaults to the WebView's timeout.
   */
  async fill(selector: string, value: string, options?: TimeoutOptions): Promise<void> {
    const timeout = checkTimeout('webview.fill()', checkOptions('webview.fill()', options, ['timeout'])?.timeout);
    return this._traced('fill', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const escaped = JSON.stringify(value);
      await this._evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${escaped};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`, remainingUntil(deadline));
    }, undefined, timeout);
  }

  /**
   * `webview.textContent(selector)` on the first element matching the CSS selector, once it is in the DOM.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   including the wait for the selector. Defaults to the WebView's timeout.
   */
  async textContent(selector: string, options?: TimeoutOptions): Promise<string> {
    const timeout = checkTimeout('webview.textContent()', checkOptions('webview.textContent()', options, ['timeout'])?.timeout);
    return this._traced('textContent', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).textContent`,
        remainingUntil(deadline),
      );
      return (result as string) ?? '';
    }, undefined, timeout);
  }

  /**
   * `webview.innerHTML(selector)` on the first element matching the CSS selector, once it is in the DOM.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   including the wait for the selector. Defaults to the WebView's timeout.
   */
  async innerHTML(selector: string, options?: TimeoutOptions): Promise<string> {
    const timeout = checkTimeout('webview.innerHTML()', checkOptions('webview.innerHTML()', options, ['timeout'])?.timeout);
    return this._traced('innerHTML', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).innerHTML`,
        remainingUntil(deadline),
      );
      return (result as string) ?? '';
    }, undefined, timeout);
  }

  /**
   * `webview.getAttribute(selector, name)` on the first element matching the CSS selector, once it is in the DOM.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   including the wait for the selector. Defaults to the WebView's timeout.
   */
  async getAttribute(selector: string, name: string, options?: TimeoutOptions): Promise<string | null> {
    const timeout = checkTimeout('webview.getAttribute()', checkOptions('webview.getAttribute()', options, ['timeout'])?.timeout);
    return this._traced('getAttribute', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(name)})`,
        remainingUntil(deadline),
      );
      return result as string | null;
    }, undefined, timeout);
  }

  /**
   * `webview.inputValue(selector)` on the first element matching the CSS selector, once it is in the DOM.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   including the wait for the selector. Defaults to the WebView's timeout.
   */
  async inputValue(selector: string, options?: TimeoutOptions): Promise<string> {
    const timeout = checkTimeout('webview.inputValue()', checkOptions('webview.inputValue()', options, ['timeout'])?.timeout);
    return this._traced('inputValue', selector, async (deadline) => {
      await this._waitForSelector(selector, remainingUntil(deadline));
      const result = await this._evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value`,
        remainingUntil(deadline),
      );
      return (result as string) ?? '';
    }, undefined, timeout);
  }

  /**
   * Whether the first element matching the CSS selector is visible right now
   * (one DOM read, no auto-wait).
   *
   * @param options.timeout - Accepted, and checked, for Playwright parity; it
   *   has no effect, since the call never waits.
   */
  async isVisible(selector: string, options?: TimeoutOptions): Promise<boolean> {
    checkTimeout('webview.isVisible()', checkOptions('webview.isVisible()', options, ['timeout'])?.timeout);
    return this._traced('isVisible', selector, () => this._isVisibleSelector(selector));
  }

  /**
   * The opposite of {@link isVisible}: `true` when no element matches the
   * selector or the match is not visible. One DOM read, no auto-wait. Mirrors
   * `ElementHandle.isHidden()` / `WebViewLocator.isHidden()`. Traced under its
   * own name, like the locator form, so the check is a row in the trace.
   */
  async isHidden(selector: string, options?: TimeoutOptions): Promise<boolean> {
    checkTimeout('webview.isHidden()', checkOptions('webview.isHidden()', options, ['timeout'])?.timeout);
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

  /**
   * Run a JavaScript expression in the WebView's page and return its value.
   * Does not wait for anything first.
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return this._traced('evaluate', undefined, async (deadline) => {
      return (await this._evaluate(expression, remainingUntil(deadline))) as T;
    });
  }

  /**
   * Navigate the WebView to `url`. Resolves once navigation starts, not when
   * the page has loaded: assert on the new page's content to wait for it.
   */
  async goto(url: string): Promise<void> {
    return this._traced('goto', url, async (deadline) => {
      await this._send('Page.navigate', { url }, remainingUntil(deadline));
    });
  }

  /** The page's `document.title`, read now. */
  async title(): Promise<string> {
    return (await this._evaluate('document.title')) as string;
  }

  /** The page's current URL, read now. */
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

  /**
   * Close the connection to the WebView. `device.native()` keeps it open for
   * reuse; the runner closes it at the end of the test file.
   */
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
  ariaLabelAttr?: string
  testId: string
  type: string
  href: string
  bounds: { left: number; top: number; right: number; bottom: number }
  children: DomNode[]
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
