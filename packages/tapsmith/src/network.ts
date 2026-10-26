/**
 * Network route interception — Playwright-style `device.route()` API.
 *
 * Provides Route, TapsmithRequest, and the internal NetworkRouteManager that
 * bridges TypeScript route handlers to the Rust daemon's MITM proxy via a
 * bidirectional gRPC stream.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type * as grpc from '@grpc/grpc-js';
import type { TapsmithGrpcClient } from './grpc-client.js';
import { runOutsideAttempt } from './attempt-fence.js';
import { getActiveTraceCollector, extractStack } from './trace/trace-collector.js';
import type { SourceLocation } from './trace/types.js';

// ─── Public Types ───

/** An intercepted HTTP request. */
export class TapsmithRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly postData: Buffer | null;
  readonly isHttps: boolean;

  /** @internal */
  constructor(data: {
    method: string
    url: string
    headers: Array<{ name: string; value: string }>
    body: Buffer | Uint8Array | null
    isHttps: boolean
  }) {
    this.method = data.method;
    this.url = data.url;
    this.headers = {};
    for (const h of data.headers) {
      this.headers[h.name.toLowerCase()] = h.value;
    }
    this.postData = data.body && data.body.length > 0 ? Buffer.from(data.body) : null;
    this.isHttps = data.isHttps;
  }
}

/** Options for `route.continue()`. */
export interface RouteContinueOptions {
  url?: string
  method?: string
  headers?: Record<string, string>
  postData?: string | Buffer
}

/** Options for `route.fulfill()`. */
export interface RouteFulfillOptions {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
  contentType?: string
  /** Convenience: serialize as JSON and set content-type. */
  json?: unknown
  /** Read body from a file path. */
  path?: string
}

/** A route handler receives this object to decide how to handle the request. */
export class Route {
  private _interceptId: string;
  private _request: TapsmithRequest;
  private _resolved = false;
  private _sendDecision: (decision: RouteDecisionMsg) => void;
  private _awaitFetchedResponse: (() => Promise<FetchedResponseMsg>) | null = null;

  /** @internal */
  constructor(
    interceptId: string,
    request: TapsmithRequest,
    sendDecision: (decision: RouteDecisionMsg) => void,
    awaitFetchedResponse: () => Promise<FetchedResponseMsg>,
  ) {
    this._interceptId = interceptId;
    this._request = request;
    this._sendDecision = sendDecision;
    this._awaitFetchedResponse = awaitFetchedResponse;
  }

  /** The intercepted request. */
  request(): TapsmithRequest {
    return this._request;
  }

  /** Abort the request. */
  async abort(errorCode?: string): Promise<void> {
    this._ensureNotResolved();
    // Mark resolved *after* sending so a throw from _sendDecision (e.g. the
    // post-fetch phase guard) leaves _resolved=false — the handler's catch
    // can then fail-open via continueRequest without double-resolving.
    this._sendDecision({
      interceptId: this._interceptId,
      abort: { errorCode: errorCode ?? '' },
    });
    this._resolved = true;
  }

  /** Continue the request with optional overrides. */
  async continue(overrides?: RouteContinueOptions): Promise<void> {
    this._ensureNotResolved();
    this._sendDecision({
      interceptId: this._interceptId,
      continueRequest: {
        url: overrides?.url ?? '',
        method: overrides?.method ?? '',
        headers: overrides?.headers
          ? Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
          : [],
        postData: overrides?.postData
          ? Buffer.from(overrides.postData)
          : Buffer.alloc(0),
      },
    });
    this._resolved = true;
  }

  /** Fulfill the request with a mock response. */
  async fulfill(options?: RouteFulfillOptions): Promise<void> {
    this._ensureNotResolved();

    let body: Buffer = Buffer.alloc(0);
    let contentType = options?.contentType ?? '';

    if (options?.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json));
      if (!contentType) contentType = 'application/json';
    } else if (options?.path) {
      // Read *before* marking the route resolved so a failed read still lets
      // the handler's catch path fail-open via continueRequest.
      body = await readFile(options.path);
    } else if (options?.body !== undefined) {
      body = Buffer.from(options.body);
    }

    this._resolved = true;
    this._sendDecision({
      interceptId: this._interceptId,
      fulfill: {
        status: options?.status ?? 200,
        headers: options?.headers
          ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
          : [],
        body,
        contentType,
      },
    });
  }

  /** Fetch the actual response from upstream, allowing modification. */
  async fetch(overrides?: RouteContinueOptions): Promise<FetchedAPIResponse> {
    this._ensureNotResolved();

    // Send a RouteFetch decision
    this._sendDecision({
      interceptId: this._interceptId,
      fetch: {
        url: overrides?.url ?? '',
        method: overrides?.method ?? '',
        headers: overrides?.headers
          ? Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
          : [],
        postData: overrides?.postData
          ? Buffer.from(overrides.postData)
          : Buffer.alloc(0),
      },
    });

    // Wait for the daemon to send back the real upstream response.
    // If the daemon rejected (upstream-fetch failure → status=0 sentinel,
    // or stream died mid-fetch), lock the route SDK-side before rethrowing
    // so the outer handler's `.catch` fail-open path doesn't send a stale
    // `continueRequest` for an intercept the daemon already forgot (which
    // would trigger a spurious "RouteDecision for unknown intercept_id"
    // warning in the daemon).
    let fetched: FetchedResponseMsg;
    try {
      fetched = await this._awaitFetchedResponse!();
    } catch (err) {
      this._resolved = true;
      throw err;
    }

    const headers: Record<string, string> = {};
    for (const h of fetched.headers ?? []) {
      headers[h.name.toLowerCase()] = h.value;
    }

    // Replace _sendDecision so the next route.fulfill() sends
    // fulfill_after_fetch instead of a regular fulfill. After fetch(), only
    // fulfill() is legal — abort/continue would be a wrong-phase decision
    // that the daemon can't pair with the pending fulfill_after_fetch slot,
    // so reject them loudly instead of silently hanging the intercept.
    const originalSend = this._sendDecision;
    this._resolved = false;
    this._sendDecision = (decision: RouteDecisionMsg) => {
      if (decision.fulfill) {
        originalSend({
          interceptId: this._interceptId,
          fulfillAfterFetch: decision.fulfill,
        });
      } else if (decision.abort || decision.continueRequest || decision.fetch) {
        throw new Error(
          'After route.fetch(), only route.fulfill() is allowed. ' +
          'route.abort()/continue()/fetch() would leave the request in an inconsistent state.',
        );
      } else {
        originalSend(decision);
      }
    };

    return new FetchedAPIResponse(fetched.status, headers, Buffer.from(fetched.body ?? []));
  }

  private _ensureNotResolved(): void {
    if (this._resolved) {
      throw new Error('Route has already been handled');
    }
  }

  /** @internal — used by NetworkRouteManager to detect handlers that return without resolving. */
  _isResolved(): boolean {
    return this._resolved;
  }

  /**
   * @internal — NetworkRouteManager marks the route resolved after failing
   * open, so a late `route.fulfill()` from a background async chain throws
   * loudly (Route has already been handled) instead of silently sending a
   * decision the daemon can't pair with any pending intercept.
   */
  _forceResolve(): void {
    this._resolved = true;
  }
}

/** Response returned by `route.fetch()` — wraps the real upstream response. */
export class FetchedAPIResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  private readonly _body: Buffer;

  constructor(status: number, headers: Record<string, string>, body: Buffer) {
    this.status = status;
    this.headers = headers;
    this._body = body;
  }

  body(): Buffer {
    return this._body;
  }

  text(): string {
    return this._body.toString('utf-8');
  }

  json(): unknown {
    return JSON.parse(this.text());
  }
}

// ─── Internal Types (proto message shapes) ───

interface HeaderEntry {
  name: string
  value: string
}

interface RouteDecisionMsg {
  interceptId: string
  abort?: { errorCode: string }
  continueRequest?: {
    url: string
    method: string
    headers: HeaderEntry[]
    postData: Buffer
  }
  fulfill?: {
    status: number
    headers: HeaderEntry[]
    body: Buffer
    contentType: string
  }
  fetch?: {
    url: string
    method: string
    headers: HeaderEntry[]
    postData: Buffer
  }
  fulfillAfterFetch?: {
    status: number
    headers: HeaderEntry[]
    body: Buffer
    contentType: string
  }
}

interface InterceptedRequestMsg {
  interceptId: string
  routeId: string
  method: string
  url: string
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
  isHttps: boolean
}

interface FetchedResponseMsg {
  interceptId: string
  status: number
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
}

interface RegisteredRouteInfo {
  routeId: string
  urlPattern: string
  /**
   * Original user-supplied pattern. For regex/predicate patterns the daemon
   * is sent a `**` glob (it can't evaluate JS regexes), so every request
   * matches on the wire; we re-check this in the SDK before dispatching.
   */
  originalPattern: string | RegExp | ((url: URL) => boolean)
  handler: (route: Route) => Promise<void> | void
  timesRemaining?: number
  sourceLocation?: SourceLocation
  stack?: SourceLocation[]
  /** The suite scope that registered it; absent for a test's own route. */
  scope?: RouteScope
  /**
   * The daemon acknowledged the registration. Only confirmed routes are
   * replayed onto a replacement stream: one still awaiting its reply when
   * the stream dropped is rejected and removed by `addRoute` (PILOT-581).
   */
  confirmed?: boolean
}

// ─── Route Scopes (PILOT-534) ───

/**
 * @internal A describe scope whose `beforeAll`/`afterAll` hooks registered
 * routes. Those routes outlive each test and are removed when the scope ends,
 * the way Playwright keeps routes on a context created in `beforeAll` until it
 * is closed. A route registered anywhere else (a test, `beforeEach`,
 * `afterEach`, a test fixture) belongs to the test and is removed after it.
 */
export interface RouteScope {
  /** For debugging only: the scope's describe path, or the file. */
  readonly label: string
  /**
   * Set once the scope has ended and its routes are being removed. A route
   * registered after that (work the hook left running) belongs to whatever
   * test is running then, so it can never outlive every cleanup.
   */
  ended?: boolean
}

const routeScopeStorage = new AsyncLocalStorage<RouteScope>();

/**
 * @internal Run a suite-level hook so every route it registers — including
 * from work it leaves running — is tagged with `scope`.
 */
export function runInRouteScope<T>(scope: RouteScope, fn: () => Promise<T>): Promise<T> {
  return routeScopeStorage.run(scope, fn);
}

/** @internal The suite scope registering routes now; `undefined` inside a test. */
export function currentRouteScope(): RouteScope | undefined {
  const scope = routeScopeStorage.getStore();
  return scope?.ended ? undefined : scope;
}

// ─── URL Pattern Matching ───

/** Match a URL against a glob/regex/predicate pattern (used SDK-side for event filtering). */
export function matchUrlPattern(
  url: string,
  pattern: string | RegExp | ((url: URL) => boolean),
): boolean {
  if (typeof pattern === 'string') {
    return globMatch(pattern, url);
  } else if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(url);
  } else {
    try {
      return pattern(new URL(url));
    } catch {
      return false;
    }
  }
}

const _globCache = new Map<string, RegExp>();

function globMatch(pattern: string, url: string): boolean {
  if (_globCache.size > 1000) _globCache.clear();
  let re = _globCache.get(pattern);
  if (!re) {
    re = globToRegex(pattern);
    _globCache.set(pattern, re);
  }
  return re.test(url);
}

function globToRegex(pattern: string): RegExp {
  let re = '^';
  const chars = [...pattern];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] === '*') {
      if (i + 1 < chars.length && chars[i + 1] === '*') {
        re += '.*';
        i += 2;
        // A trailing `/` after `**` is required, not optional —
        // otherwise `**/api` would match `example.comapi`. Mirrors
        // the Rust impl in route_handler.rs::glob_to_regex (keep in sync).
        if (i < chars.length && chars[i] === '/') {
          re += '/';
          i++;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (chars[i] === '?') {
      re += '[^/]';
      i++;
    } else if (chars[i] === '{') {
      const close = chars.indexOf('}', i);
      if (close !== -1) {
        const group = chars.slice(i + 1, close).join('');
        const alts = group.split(',').map(escapeRegex).join('|');
        re += `(${alts})`;
        i = close + 1;
      } else {
        re += escapeRegex(chars[i]);
        i++;
      }
    } else {
      re += escapeRegex(chars[i]);
      i++;
    }
  }

  re += '$';
  return new RegExp(re);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Structural equality for user-supplied URL patterns. Needed by `unroute`
 * because regex/predicate patterns all share the sentinel glob `**` on the
 * daemon side, so comparing by `urlPattern` string would collapse every
 * regex/predicate route into a single bucket.
 *
 * @internal — exported only for unit-test visibility.
 */
export function patternsEqual(
  a: string | RegExp | ((url: URL) => boolean),
  b: string | RegExp | ((url: URL) => boolean),
): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (typeof a === 'function' && typeof b === 'function') {
    return a === b;
  }
  return false;
}

/** Convert a URL pattern to the glob string sent to the daemon. */
function patternToGlob(pattern: string | RegExp | ((url: URL) => boolean)): string {
  if (typeof pattern === 'string') {
    return pattern;
  }
  // For RegExp and predicate patterns, we use a catch-all glob on the daemon
  // and do the filtering SDK-side in the handler dispatch.
  return '**';
}

// ─── NetworkRouteManager ───

/** First delay before reopening a dropped route stream; doubles per failed attempt. */
const REOPEN_INITIAL_DELAY_MS = 250;
/** Upper bound on the reopen backoff. */
const REOPEN_MAX_DELAY_MS = 5_000;

function formatRoutePattern(pattern: string | RegExp | ((url: URL) => boolean)): string {
  if (typeof pattern === 'string') return pattern;
  if (pattern instanceof RegExp) return String(pattern);
  return '(predicate)';
}

/**
 * Manages the bidirectional gRPC stream for network route interception.
 * Opened lazily on the first `device.route()` call.
 * @internal
 */
export class NetworkRouteManager {
  private _client: TapsmithGrpcClient;
  private _stream: grpc.ClientDuplexStream<unknown, unknown> | null = null;
  private _routes: Map<string, RegisteredRouteInfo> = new Map();
  private _pendingFetches: Map<string, {
    resolve: (resp: FetchedResponseMsg) => void
    reject: (err: Error) => void
  }> = new Map();
  private _requestListeners: Set<(req: TapsmithRequest) => void> = new Set();
  private _responseListeners: Set<(resp: NetworkResponseEventData) => void> = new Set();
  /**
   * The route scope each request/response listener was added in (undefined
   * for a test's own), so listeners end with their test or scope like routes
   * do (PILOT-775): the route manager now outlives the test whenever a proxy
   * is running, traced or not.
   */
  private _listenerScopes: Map<unknown, RouteScope | undefined> = new Map();
  /**
   * Whether daemon network events are wanted (a listener, or network
   * capture's eager subscription). This is intent, kept across streams; the
   * subscription itself lives on the daemon's per-stream handler, so every
   * new stream re-sends it (PILOT-581).
   */
  private _eventsWanted = false;
  /** The stream `subscribeEvents` was last sent on. */
  private _subscribedStream: grpc.ClientDuplexStream<unknown, unknown> | null = null;
  /** Pending eager reopen after a dropped stream, and its current backoff. */
  private _reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private _reopenDelayMs = REOPEN_INITIAL_DELAY_MS;
  private _disposed = false;
  /** Requests handed to a route handler since the runner last took the count (PILOT-775). */
  private _handlerCalls = 0;

  constructor(client: TapsmithGrpcClient) {
    this._client = client;
  }

  /** Lazily open the bidi stream, replaying its state onto a fresh one. */
  private _ensureStream(): grpc.ClientDuplexStream<unknown, unknown> {
    if (this._disposed) throw new Error('NetworkRouteManager is disposed');
    if (this._stream) return this._stream;
    this._cancelReopen();

    // Opened outside any route scope: the stream outlives the beforeAll that
    // may open it, and callbacks it drives (route handlers) must not inherit
    // that scope, or a route a handler registers mid-test would be kept as
    // the scope's instead of removed after the test (PILOT-534).
    // Outside any attempt context too: the stream outlives the test whose
    // route() may open it, and its callbacks run in the context it was
    // opened in (PILOT-775).
    const stream = routeScopeStorage.exit(() => runOutsideAttempt(() => this._client.networkRouteStream()));
    this._stream = stream;

    // Route handlers run outside any route scope, whatever async context
    // the stream's events arrive in: a route a handler registers belongs to
    // the running test (PILOT-534).
    stream.on('data', (msg: ServerMessage) => {
      // The daemon is answering on this stream: a later drop starts its
      // reconnect backoff from the beginning again.
      if (this._stream === stream) this._reopenDelayMs = REOPEN_INITIAL_DELAY_MS;
      routeScopeStorage.exit(() => this._onServerMessage(msg));
    });

    stream.on('error', (err: Error) => {
      // CANCELLED (1) and UNAVAILABLE (14) are expected during teardown
      // and daemon reconnection. RST_STREAM with code 0 is a clean HTTP/2
      // close (e.g. proxy teardown between test files); the manager reopens
      // and replays its state either way (PILOT-581).
      const code = (err as grpc.ServiceError).code;
      const isCleanReset = code === 13 && err.message.includes('RST_STREAM with code 0');
      // `dispose()` half-closes the stream with `end()`; the daemon's own close
      // can then land here as INTERNAL/STREAM_CLOSED (`RST_STREAM with code 5`)
      // once we have stopped reading. That raced teardown is not actionable —
      // it printed after every run's summary — but the same code mid-run means
      // a lost route decision, so only suppress it once we are disposing.
      // A stale stream (already replaced) has nothing left to report.
      if (!this._disposed && this._stream === stream && code !== 1 && code !== 14 && !isCleanReset) {
        console.warn('[tapsmith] NetworkRoute stream error:', err.message);
      }
      this._onStreamDropped(stream, `NetworkRoute stream error: ${err.message}`);
    });

    stream.on('end', () => {
      this._onStreamDropped(stream, 'NetworkRoute stream closed');
    });

    this._replayState(stream);
    return stream;
  }

  /**
   * Restore what lived on the daemon's handler for the previous stream: the
   * event subscription and every confirmed route, under the same ids so
   * their handlers, scopes and `times` counters carry on (PILOT-581). Written
   * before any caller's own message, so a lazy reopen keeps their order.
   */
  private _replayState(stream: grpc.ClientDuplexStream<unknown, unknown>): void {
    if (this._eventsWanted) {
      this._subscribedStream = stream;
      stream.write({ subscribeEvents: {} });
    }
    const replayed = [...this._routes.values()].filter((info) => info.confirmed);
    if (replayed.length === 0) return;
    // One listener for all the replies, removed with the last one, so a
    // replay of many routes adds no per-route listeners to the stream.
    const awaiting = new Map(replayed.map((info) => [info.routeId, info]));
    const done = () => {
      stream.removeListener('data', onReply);
      stream.removeListener('end', done);
    };
    const onReply = (msg: ServerMessage) => {
      const reply = msg.registerRouteResponse;
      const info = reply && awaiting.get(reply.routeId);
      if (!reply || !info) return;
      awaiting.delete(reply.routeId);
      if (!reply.success) {
        console.warn(
          `[tapsmith] Could not restore route ${formatRoutePattern(info.originalPattern)} after the ` +
          `NetworkRoute stream reconnected: ${reply.errorMessage || 'unknown error'}`,
        );
      }
      if (awaiting.size === 0) done();
    };
    stream.on('data', onReply);
    stream.on('end', done);
    for (const info of replayed) {
      stream.write({ registerRoute: { routeId: info.routeId, urlPattern: info.urlPattern } });
    }
  }

  /**
   * A stream errored or ended. Only the live stream's drop counts — a
   * replaced stream's late `end` must not discard its replacement. When
   * there is state the daemon has lost (routes, an event subscription),
   * reopen without waiting for user code: a `beforeAll` route must keep
   * mocking a test that never touches the network API (PILOT-581).
   */
  private _onStreamDropped(stream: grpc.ClientDuplexStream<unknown, unknown>, reason: string): void {
    if (this._stream !== stream) return;
    this._stream = null;
    this._subscribedStream = null;
    this._rejectPendingFetches(reason);
    this._scheduleReopen();
  }

  private _hasStateToRestore(): boolean {
    if (this._eventsWanted) return true;
    for (const info of this._routes.values()) {
      if (info.confirmed) return true;
    }
    return false;
  }

  private _scheduleReopen(): void {
    if (this._disposed || this._reopenTimer) return;
    // Deferred (never synchronous), so a registration the drop interrupted
    // settles first and is not replayed.
    const delay = this._reopenDelayMs;
    this._reopenDelayMs = Math.min(delay * 2, REOPEN_MAX_DELAY_MS);
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = null;
      if (this._disposed || this._stream || !this._hasStateToRestore()) return;
      try {
        this._ensureStream();
      } catch {
        // Opening a call does not throw for an unreachable daemon (the
        // stream errors instead, which schedules the next attempt).
      }
    }, delay);
    // A run that is ending must not wait on a reconnect attempt.
    this._reopenTimer.unref?.();
  }

  private _cancelReopen(): void {
    if (!this._reopenTimer) return;
    clearTimeout(this._reopenTimer);
    this._reopenTimer = null;
  }

  /** Best-effort write to the stream. Silently no-ops if the stream is down. */
  private _safeWrite(msg: unknown): void {
    const stream = this._stream;
    if (!stream) return;
    try {
      stream.write(msg);
    } catch {
      // Stream closed between check and write — drop the message.
      this._onStreamDropped(stream, 'NetworkRoute stream closed');
    }
  }

  /** Register a route handler. */
  async addRoute(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler: (route: Route) => Promise<void> | void,
    options?: { times?: number },
  ): Promise<void> {
    const routeId = crypto.randomUUID();
    const urlPattern = patternToGlob(pattern);

    // Capture source location at registration time — used by trace events
    // when the handler fires so the viewer can highlight the test code.
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];

    this._routes.set(routeId, {
      routeId,
      urlPattern,
      originalPattern: pattern,
      handler,
      timesRemaining: options?.times,
      sourceLocation,
      stack,
      scope: currentRouteScope(),
    });

    const stream = this._ensureStream();

    return new Promise<void>((resolve, reject) => {
      // Wire all three listeners so the promise always settles: data for
      // the success/failure reply, error/end so a stream death during
      // registration rejects instead of leaking a listener + hanging the
      // caller. The `cleanup` closure detaches all three whichever wins.
      const cleanup = () => {
        stream.removeListener('data', onResponse);
        stream.removeListener('error', onStreamError);
        stream.removeListener('end', onStreamEnd);
      };
      const onResponse = (msg: ServerMessage) => {
        if (msg.registerRouteResponse?.routeId === routeId) {
          cleanup();
          if (msg.registerRouteResponse.success) {
            const info = this._routes.get(routeId);
            if (info) info.confirmed = true;
            resolve();
          } else {
            this._routes.delete(routeId);
            reject(new Error(msg.registerRouteResponse.errorMessage || 'Failed to register route'));
          }
        }
      };
      const onStreamError = (err: Error) => {
        cleanup();
        this._routes.delete(routeId);
        reject(new Error(`NetworkRoute stream error during route registration: ${err.message}`));
      };
      const onStreamEnd = () => {
        cleanup();
        this._routes.delete(routeId);
        reject(new Error('NetworkRoute stream closed during route registration'));
      };
      stream.on('data', onResponse);
      stream.on('error', onStreamError);
      stream.on('end', onStreamEnd);

      stream.write({
        registerRoute: {
          routeId,
          urlPattern,
        },
      });
    });
  }

  /** Remove a route handler. */
  async removeRoute(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler?: (route: Route) => Promise<void> | void,
  ): Promise<void> {
    const toRemove: string[] = [];

    for (const [id, info] of this._routes) {
      if (patternsEqual(info.originalPattern, pattern)) {
        if (!handler || info.handler === handler) {
          toRemove.push(id);
        }
      }
    }

    await Promise.all(toRemove.map((id) => this._unregisterAndAwait(id)));
  }

  /** Remove all routes. */
  async removeAllRoutes(): Promise<void> {
    await this._removeWhere(() => true);
  }

  /**
   * Remove the routes the current test registered, keeping those a suite
   * scope's `beforeAll`/`afterAll` registered (PILOT-534).
   */
  async removeTestRoutes(): Promise<void> {
    await this._removeWhere((info) => info.scope === undefined);
  }

  /** Remove the routes `scope`'s hooks registered, once that scope has ended (see `RouteScope.ended`). */
  async removeScopeRoutes(scope: RouteScope): Promise<void> {
    await this._removeWhere((info) => info.scope === scope);
  }

  private async _removeWhere(match: (info: RegisteredRouteInfo) => boolean): Promise<void> {
    const ids = [...this._routes.values()].filter(match).map((info) => info.routeId);
    await Promise.all(ids.map((id) => this._unregisterAndAwait(id)));
  }

  /**
   * Send an UnregisterRoute and wait for the daemon's
   * UnregisterRouteResponse before resolving. Mirrors `addRoute`.
   *
   * Critically: `_routes` is NOT cleared until the daemon confirms. If
   * we cleared eagerly, a request in flight in the proxy could hit the
   * still-registered daemon route, the daemon would send an
   * InterceptedRequest, and the SDK would fall through the "unknown
   * route" branch and send a continue fallback — leaving the request
   * tagged `route_action: "continued"` (MODIFIED badge) even though
   * the user had called `unroute()`.
   *
   * Keeping the SDK-side entry alive during the round-trip means any
   * racing dispatch still invokes the user's handler (which is the
   * correct behaviour for requests that happened *before* the `await
   * unroute()` returned). After this promise resolves, the daemon is
   * guaranteed to no longer match the route, so no further dispatches
   * can happen.
   */
  private _unregisterAndAwait(routeId: string): Promise<void> {
    const stream = this._ensureStream();
    return new Promise<void>((resolve) => {
      const cleanup = () => {
        stream.removeListener('data', onResponse);
        stream.removeListener('error', onStreamIssue);
        stream.removeListener('end', onStreamIssue);
      };
      const finish = () => {
        cleanup();
        this._routes.delete(routeId);
        resolve();
      };
      const onResponse = (msg: ServerMessage) => {
        if (msg.unregisterRouteResponse?.routeId === routeId) {
          finish();
        }
      };
      // Stream issues still resolve (not reject): the caller is tearing
      // down, not asserting network health. Drop SDK-side state too —
      // without a stream we can't dispatch anyway.
      const onStreamIssue = () => finish();
      stream.on('data', onResponse);
      stream.on('error', onStreamIssue);
      stream.on('end', onStreamIssue);
      this._safeWrite({ unregisterRoute: { routeId } });
    });
  }

  /**
   * Eagerly subscribe to daemon network events.
   *
   * Called during network capture startup so the subscription message
   * reaches the daemon well before test code calls waitForRequest().
   * Without this, there is a race: the subscription fires lazily on the
   * first listener, and a fast HTTP request can beat the daemon processing
   * the subscribe message.
   */
  ensureEventsSubscribed(): void {
    this._eventsWanted = true;
    // A new stream sends the subscription as part of its replay.
    const stream = this._ensureStream();
    if (this._subscribedStream === stream) return;
    this._subscribedStream = stream;
    stream.write({ subscribeEvents: {} });
  }

  /** Subscribe to request events. */
  addRequestListener(handler: (req: TapsmithRequest) => void): void {
    this._requestListeners.add(handler);
    this._listenerScopes.set(handler, currentRouteScope());
    this.ensureEventsSubscribed();
  }

  /** Unsubscribe from request events. */
  removeRequestListener(handler: (req: TapsmithRequest) => void): void {
    this._requestListeners.delete(handler);
    if (!this._responseListeners.has(handler as never)) this._listenerScopes.delete(handler);
    this._unsubscribeIfUnused();
  }

  /** Subscribe to response events. */
  addResponseListener(handler: (resp: NetworkResponseEventData) => void): void {
    this._responseListeners.add(handler);
    this._listenerScopes.set(handler, currentRouteScope());
    this.ensureEventsSubscribed();
  }

  /** Unsubscribe from response events. */
  removeResponseListener(handler: (resp: NetworkResponseEventData) => void): void {
    this._responseListeners.delete(handler);
    if (!this._requestListeners.has(handler as never)) this._listenerScopes.delete(handler);
    this._unsubscribeIfUnused();
  }

  /** Remove the request/response listeners the current test added (PILOT-775). */
  removeTestListeners(): void {
    this._removeListenersWhere((scope) => scope === undefined);
  }

  /** Remove the listeners `scope`'s hooks or fixtures added, once it has ended (PILOT-775). */
  removeScopeListeners(scope: RouteScope): void {
    this._removeListenersWhere((s) => s === scope);
  }

  private _removeListenersWhere(match: (scope: RouteScope | undefined) => boolean): void {
    let removed = false;
    for (const [listener, scope] of [...this._listenerScopes]) {
      if (!match(scope)) continue;
      this._requestListeners.delete(listener as (req: TapsmithRequest) => void);
      this._responseListeners.delete(listener as (resp: NetworkResponseEventData) => void);
      this._listenerScopes.delete(listener);
      removed = true;
    }
    if (removed) this._unsubscribeIfUnused();
  }

  private _unsubscribeIfUnused(): void {
    if (this._requestListeners.size > 0 || this._responseListeners.size > 0 || !this._eventsWanted) return;
    this._eventsWanted = false;
    if (this._stream && this._subscribedStream === this._stream) {
      this._subscribedStream = null;
      this._safeWrite({ unsubscribeEvents: {} });
    }
  }

  /**
   * How many intercepted requests reached a route handler since the last
   * call, then reset. The runner reads it after each test to tell a route
   * that never fired from one that did (PILOT-775).
   */
  takeHandlerCalls(): number {
    const n = this._handlerCalls;
    this._handlerCalls = 0;
    return n;
  }

  /** Whether any routes are registered. */
  get hasRoutes(): boolean {
    return this._routes.size > 0;
  }

  /** Whether any route registered by the current test is still registered. */
  get hasTestRoutes(): boolean {
    for (const info of this._routes.values()) {
      if (info.scope === undefined) return true;
    }
    return false;
  }

  /** Close the stream and clean up. */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._cancelReopen();

    this._routes.clear();
    this._rejectPendingFetches('NetworkRouteManager disposed');
    this._requestListeners.clear();
    this._responseListeners.clear();
    this._listenerScopes.clear();

    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  /** Handle an incoming server message. */
  private _onServerMessage(msg: ServerMessage): void {
    if (msg.interceptedRequest) {
      this._handleInterceptedRequest(msg.interceptedRequest);
    } else if (msg.fetchedResponse) {
      this._handleFetchedResponse(msg.fetchedResponse);
    } else if (msg.requestEvent) {
      this._handleRequestEvent(msg.requestEvent);
    } else if (msg.responseEvent) {
      this._handleResponseEvent(msg.responseEvent);
    }
    // registerRouteResponse / unregisterRouteResponse handled inline
  }

  /** Dispatch an intercepted request to the matching route handler. */
  private _handleInterceptedRequest(msg: InterceptedRequestMsg): void {
    const routeInfo = this._routes.get(msg.routeId);
    if (!routeInfo) {
      // Route was removed while request was in flight — continue upstream
      this._safeWrite({
        routeDecision: {
          interceptId: msg.interceptId,
          continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
        },
      });
      return;
    }

    // For regex/predicate patterns the daemon matches on a `**` glob, so we
    // re-check in the SDK. If the real pattern doesn't match, don't invoke
    // the handler — just continue the request upstream.
    if (typeof routeInfo.originalPattern !== 'string'
        && !matchUrlPattern(msg.url, routeInfo.originalPattern)) {
      this._safeWrite({
        routeDecision: {
          interceptId: msg.interceptId,
          continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
        },
      });
      return;
    }

    // Check times remaining
    if (routeInfo.timesRemaining !== undefined) {
      routeInfo.timesRemaining--;
      if (routeInfo.timesRemaining <= 0) {
        this._routes.delete(routeInfo.routeId);
        this._safeWrite({
          unregisterRoute: { routeId: routeInfo.routeId },
        });
      }
    }

    const request = new TapsmithRequest({
      method: msg.method,
      url: msg.url,
      headers: msg.headers,
      body: msg.body,
      isHttps: msg.isHttps,
    });

    // Track which route action the handler takes for trace events
    let routeAction = 'continue';
    const sendDecision = (decision: RouteDecisionMsg) => {
      if (decision.abort) routeAction = 'abort';
      else if (decision.fulfill || decision.fulfillAfterFetch) routeAction = 'fulfill';
      else if (decision.fetch) routeAction = 'fetch';
      else routeAction = 'continue';
      this._safeWrite({ routeDecision: decision });
    };

    const awaitFetchedResponse = (): Promise<FetchedResponseMsg> => {
      return new Promise<FetchedResponseMsg>((resolve, reject) => {
        this._pendingFetches.set(msg.interceptId, { resolve, reject });
      });
    };

    const route = new Route(msg.interceptId, request, sendDecision, awaitFetchedResponse);

    const startTime = Date.now();
    this._handlerCalls++;

    // Run the handler. If it throws, rejects, or returns without calling
    // abort/continue/fulfill/fetch, continue the request (fail-open).
    Promise.resolve()
      .then(() => routeInfo.handler(route))
      .then(() => {
        if (!route._isResolved()) {
          console.warn(
            `[tapsmith] Route handler for ${msg.method} ${msg.url} returned without calling ` +
            `abort/continue/fulfill/fetch — continuing request upstream. Make sure the handler ` +
            `awaits one of these (or returns the promise).`,
          );
          this._safeWrite({
            routeDecision: {
              interceptId: msg.interceptId,
              continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
            },
          });
          // Lock the route so a late async tail in the handler that calls
          // route.fulfill() throws loudly instead of sending a stale
          // decision the daemon can't route back to any pending intercept.
          route._forceResolve();
          routeAction = 'continue';
        }
        this._emitRouteTraceEvent(msg, routeAction, startTime, true, undefined, routeInfo.sourceLocation, routeInfo.stack);
      })
      .catch((err) => {
        console.warn(`[tapsmith] Route handler error: ${err}`);
        // Fail-open: continue the request (only if the handler hasn't
        // already resolved the route — don't double-send a decision).
        if (!route._isResolved()) {
          this._safeWrite({
            routeDecision: {
              interceptId: msg.interceptId,
              continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
            },
          });
          route._forceResolve();
        }
        this._emitRouteTraceEvent(msg, 'continue', startTime, false, String(err), routeInfo.sourceLocation, routeInfo.stack);
      });
  }

  /** Emit a trace event for a route handler invocation. */
  private _emitRouteTraceEvent(
    msg: InterceptedRequestMsg,
    action: string,
    startTime: number,
    success: boolean,
    error?: string,
    sourceLocation?: SourceLocation,
    stack?: SourceLocation[],
  ): void {
    const collector = getActiveTraceCollector();
    if (!collector) return;

    const duration = Date.now() - startTime;
    let shortUrl: string;
    try {
      const url = new URL(msg.url);
      shortUrl = url.pathname + url.search;
    } catch {
      shortUrl = msg.url;
    }

    collector.addActionEvent({
      category: 'network',
      action: `route.${action}`,
      duration,
      success,
      error,
      log: [
        `${msg.method} ${msg.url}`,
        `route.${action}() (${duration}ms)`,
      ],
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
      selector: shortUrl,
      sourceLocation,
      stack,
    });
  }

  /** Deliver a fetched response to the pending fetch promise. */
  private _handleFetchedResponse(msg: FetchedResponseMsg): void {
    const pending = this._pendingFetches.get(msg.interceptId);
    if (!pending) return;
    this._pendingFetches.delete(msg.interceptId);
    // Daemon signals upstream-fetch failure with status 0 (not a valid HTTP
    // status, matches the proto default). Reject so user code can catch it
    // instead of hanging.
    if (msg.status === 0) {
      pending.reject(new Error('route.fetch() failed: upstream request error'));
      return;
    }
    pending.resolve(msg);
  }

  /** Reject all in-flight route.fetch() promises. */
  private _rejectPendingFetches(reason: string): void {
    if (this._pendingFetches.size === 0) return;
    const err = new Error(reason);
    for (const { reject } of this._pendingFetches.values()) {
      reject(err);
    }
    this._pendingFetches.clear();
  }

  /** Notify request event listeners. */
  private _handleRequestEvent(msg: RequestEventMsg): void {
    const request = new TapsmithRequest({
      method: msg.method,
      url: msg.url,
      headers: msg.headers,
      body: msg.body,
      isHttps: msg.isHttps,
    });
    for (const listener of this._requestListeners) {
      try {
        listener(request);
      } catch {
        // ignore listener errors
      }
    }
  }

  /** Notify response event listeners. */
  private _handleResponseEvent(msg: ResponseEventMsg): void {
    const data: NetworkResponseEventData = {
      method: msg.method,
      url: msg.url,
      status: msg.status,
      headers: {},
      body: msg.body ? Buffer.from(msg.body) : null,
      routeAction: msg.routeAction || undefined,
    };
    for (const h of msg.headers ?? []) {
      data.headers[h.name.toLowerCase()] = h.value;
    }
    for (const listener of this._responseListeners) {
      try {
        listener(data);
      } catch {
        // ignore listener errors
      }
    }
  }
}

/** Data emitted for response events. */
export interface NetworkResponseEventData {
  method: string
  url: string
  status: number
  headers: Record<string, string>
  body: Buffer | null
  routeAction?: string
}

// ─── Internal server message shape (from proto) ───

interface ServerMessage {
  registerRouteResponse?: { routeId: string; success: boolean; errorMessage: string }
  unregisterRouteResponse?: { routeId: string; success: boolean }
  interceptedRequest?: InterceptedRequestMsg
  fetchedResponse?: FetchedResponseMsg
  requestEvent?: RequestEventMsg
  responseEvent?: ResponseEventMsg
}

interface RequestEventMsg {
  method: string
  url: string
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
  isHttps: boolean
  routeAction: string
}

interface ResponseEventMsg {
  method: string
  url: string
  status: number
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
  routeAction: string
}
