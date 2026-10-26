import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TapsmithRequest, Route, FetchedAPIResponse, NetworkRouteManager,
  matchUrlPattern, patternsEqual, runInRouteScope, currentRouteScope, type RouteScope,
} from '../network.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { currentAttemptToken, runInAttemptContext } from '../attempt-fence.js';

// ─── matchUrlPattern (glob matching) ───

describe('matchUrlPattern', () => {
  describe('string glob patterns', () => {
    it('matches exact URL', () => {
      expect(matchUrlPattern('https://example.com/api/posts', 'https://example.com/api/posts')).toBe(true);
    });

    it('does not match different URL', () => {
      expect(matchUrlPattern('https://example.com/api/users', 'https://example.com/api/posts')).toBe(false);
    });

    it('single * matches within a path segment', () => {
      expect(matchUrlPattern('https://example.com/api/posts', 'https://example.com/api/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/users', 'https://example.com/api/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/posts/1', 'https://example.com/api/*')).toBe(false);
    });

    it('** matches across path segments', () => {
      expect(matchUrlPattern('https://example.com/api/posts', '**/api/**')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/posts/1', '**/api/**')).toBe(true);
      expect(matchUrlPattern('http://localhost:3000/api/v2/users', '**/api/**')).toBe(true);
      expect(matchUrlPattern('https://example.com/other', '**/api/**')).toBe(false);
    });

    it('** prefix matches any host', () => {
      expect(matchUrlPattern('https://jsonplaceholder.typicode.com/posts', '**/posts*')).toBe(true);
      expect(matchUrlPattern('https://jsonplaceholder.typicode.com/posts?_limit=3', '**/posts*')).toBe(true);
      expect(matchUrlPattern('https://jsonplaceholder.typicode.com/users/1', '**/posts*')).toBe(false);
    });

    it('** requires a / separator (does not match example.comapi for **/api)', () => {
      // Regression: the optional-slash form `.*(?:/)?api` let `**/api` match
      // `example.comapi` (no separator). The separator is now required.
      expect(matchUrlPattern('https://example.com/api', '**/api')).toBe(true);
      expect(matchUrlPattern('https://example.comapi', '**/api')).toBe(false);
      expect(matchUrlPattern('https://example.com/api/posts', '**/api/**')).toBe(true);
      expect(matchUrlPattern('https://example.comapi/posts', '**/api/**')).toBe(false);
    });

    it('{a,b} matches alternatives', () => {
      expect(matchUrlPattern('https://example.com/api/posts', 'https://example.com/{api,v2}/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/v2/posts', 'https://example.com/{api,v2}/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/other/posts', 'https://example.com/{api,v2}/*')).toBe(false);
    });

    it('? matches single character', () => {
      expect(matchUrlPattern('https://example.com/api/v1/posts', 'https://example.com/api/v?/posts')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/v2/posts', 'https://example.com/api/v?/posts')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/v12/posts', 'https://example.com/api/v?/posts')).toBe(false);
    });
  });

  describe('RegExp patterns', () => {
    it('matches with regex', () => {
      expect(matchUrlPattern('https://example.com/api/posts', /\/api\/posts/)).toBe(true);
      expect(matchUrlPattern('https://example.com/api/users', /\/api\/posts/)).toBe(false);
    });
  });

  describe('predicate patterns', () => {
    it('matches with predicate function', () => {
      expect(matchUrlPattern('https://example.com/api/posts', (url) => url.pathname === '/api/posts')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/users', (url) => url.pathname === '/api/posts')).toBe(false);
    });
  });
});

// ─── patternsEqual (removeRoute support) ───

describe('patternsEqual', () => {
  it('compares strings by value', () => {
    expect(patternsEqual('**/api', '**/api')).toBe(true);
    expect(patternsEqual('**/api', '**/users')).toBe(false);
  });

  it('compares RegExps by source AND flags (not reference)', () => {
    expect(patternsEqual(/foo/, /foo/)).toBe(true);
    expect(patternsEqual(/foo/i, /foo/i)).toBe(true);
    expect(patternsEqual(/foo/, /foo/i)).toBe(false);       // different flags
    expect(patternsEqual(/foo/, /bar/)).toBe(false);         // different source
  });

  it('compares predicates by reference', () => {
    const a = (u: URL) => u.pathname === '/a';
    const b = (u: URL) => u.pathname === '/a';              // structurally identical, different ref
    expect(patternsEqual(a, a)).toBe(true);
    expect(patternsEqual(a, b)).toBe(false);
  });

  it('does not match across different pattern types', () => {
    expect(patternsEqual('**/api', /api/)).toBe(false);
    expect(patternsEqual(/api/, (u) => u.pathname === '/api')).toBe(false);
  });
});

// ─── TapsmithRequest ───

describe('TapsmithRequest', () => {
  it('constructs with correct properties', () => {
    const req = new TapsmithRequest({
      method: 'POST',
      url: 'https://example.com/api/posts',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer token' },
      ],
      body: Buffer.from('{"title":"test"}'),
      isHttps: true,
    });

    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://example.com/api/posts');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['authorization']).toBe('Bearer token');
    expect(req.postData?.toString()).toBe('{"title":"test"}');
    expect(req.isHttps).toBe(true);
  });

  it('lowercases header names', () => {
    const req = new TapsmithRequest({
      method: 'GET',
      url: 'https://example.com',
      headers: [{ name: 'X-Custom-Header', value: 'value' }],
      body: null,
      isHttps: true,
    });
    expect(req.headers['x-custom-header']).toBe('value');
  });

  it('sets postData to null for empty body', () => {
    const req = new TapsmithRequest({
      method: 'GET',
      url: 'https://example.com',
      headers: [],
      body: Buffer.alloc(0),
      isHttps: false,
    });
    expect(req.postData).toBeNull();
  });
});

// ─── FetchedAPIResponse ───

describe('FetchedAPIResponse', () => {
  it('parses JSON body', () => {
    const resp = new FetchedAPIResponse(
      200,
      { 'content-type': 'application/json' },
      Buffer.from('{"id":1,"name":"Test"}'),
    );
    expect(resp.status).toBe(200);
    expect(resp.json()).toEqual({ id: 1, name: 'Test' });
    expect(resp.text()).toBe('{"id":1,"name":"Test"}');
    expect(resp.body()).toEqual(Buffer.from('{"id":1,"name":"Test"}'));
  });
});

// ─── Route ───

describe('Route', () => {
  function makeRoute() {
    const decisions: unknown[] = [];
    const sendDecision = (d: unknown) => { decisions.push(d); };
    const awaitFetched = () => Promise.resolve({
      interceptId: 'test-id',
      status: 200,
      headers: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from('{"original":true}'),
    });
    const request = new TapsmithRequest({
      method: 'GET',
      url: 'https://example.com/api/posts',
      headers: [],
      body: null,
      isHttps: true,
    });
    const route = new Route('intercept-1', request, sendDecision, awaitFetched);
    return { route, decisions, request };
  }

  it('abort sends abort decision', async () => {
    const { route, decisions } = makeRoute();
    await route.abort('connectionrefused');
    expect(decisions).toHaveLength(1);
    expect((decisions[0] as Record<string, unknown>).abort).toEqual({ errorCode: 'connectionrefused' });
  });

  it('continue sends continue decision with overrides', async () => {
    const { route, decisions } = makeRoute();
    await route.continue({ url: 'https://other.com/api', method: 'POST' });
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as Record<string, unknown>;
    expect((d.continueRequest as Record<string, unknown>).url).toBe('https://other.com/api');
    expect((d.continueRequest as Record<string, unknown>).method).toBe('POST');
  });

  it('fulfill sends fulfill decision with JSON body', async () => {
    const { route, decisions } = makeRoute();
    await route.fulfill({ json: { id: 1 }, status: 201 });
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as Record<string, unknown>;
    const f = d.fulfill as Record<string, unknown>;
    expect(f.status).toBe(201);
    expect(f.contentType).toBe('application/json');
    expect(Buffer.from(f.body as Buffer).toString()).toBe('{"id":1}');
  });

  it('fulfill sends fulfill decision with string body', async () => {
    const { route, decisions } = makeRoute();
    await route.fulfill({ body: 'hello', contentType: 'text/plain', status: 200 });
    const f = (decisions[0] as Record<string, unknown>).fulfill as Record<string, unknown>;
    expect(Buffer.from(f.body as Buffer).toString()).toBe('hello');
    expect(f.contentType).toBe('text/plain');
  });

  it('throws if resolved twice', async () => {
    const { route } = makeRoute();
    await route.abort();
    await expect(route.abort()).rejects.toThrow('Route has already been handled');
  });

  it('request() returns the intercepted request', () => {
    const { route, request } = makeRoute();
    expect(route.request()).toBe(request);
    expect(route.request().url).toBe('https://example.com/api/posts');
  });

  it('throws if abort() is called after fetch()', async () => {
    const { route } = makeRoute();
    await route.fetch();
    await expect(route.abort()).rejects.toThrow(/After route\.fetch\(\), only route\.fulfill\(\)/);
  });

  it('throws if continue() is called after fetch()', async () => {
    const { route } = makeRoute();
    await route.fetch();
    await expect(route.continue()).rejects.toThrow(/After route\.fetch\(\), only route\.fulfill\(\)/);
  });

  it('force-resolves the route when fetch() rejects (no stale continue fail-open)', async () => {
    // When the daemon rejects the fetched-response promise (upstream-fail
    // sentinel or stream drop), route.fetch() throws and marks the route
    // resolved — so the handler's .catch path sees _isResolved=true and
    // skips the spurious continueRequest send.
    const decisions: unknown[] = [];
    const sendDecision = (d: unknown) => { decisions.push(d); };
    const awaitFetched = () => Promise.reject(new Error('upstream failed'));
    const request = new TapsmithRequest({
      method: 'GET',
      url: 'https://example.com/api',
      headers: [],
      body: null,
      isHttps: true,
    });
    const route = new Route('intercept-err', request, sendDecision, awaitFetched);

    await expect(route.fetch()).rejects.toThrow('upstream failed');
    expect(route._isResolved()).toBe(true);
  });

  it('fetch sends fetch then fulfillAfterFetch on subsequent fulfill', async () => {
    const { route, decisions } = makeRoute();
    const resp = await route.fetch();
    expect(resp.status).toBe(200);
    expect(resp.json()).toEqual({ original: true });

    // First decision is the fetch
    expect(decisions).toHaveLength(1);
    expect((decisions[0] as Record<string, unknown>).fetch).toBeDefined();

    // Now fulfill with modified data — should send fulfillAfterFetch
    await route.fulfill({ json: { modified: true } });
    expect(decisions).toHaveLength(2);
    expect((decisions[1] as Record<string, unknown>).fulfillAfterFetch).toBeDefined();
    const body = (decisions[1] as Record<string, Record<string, unknown>>).fulfillAfterFetch.body as Buffer;
    expect(Buffer.from(body).toString()).toBe('{"modified":true}');
  });
});

// ─── NetworkRouteManager unregister round-trip ───

/**
 * Minimal fake gRPC duplex stream for NetworkRouteManager tests. Records
 * written messages so tests can assert what was sent, and exposes `emitData`
 * so tests can drive the "daemon replied" path without a real daemon.
 */
class FakeDuplexStream extends EventEmitter {
  public writes: unknown[] = [];
  write(msg: unknown): boolean { this.writes.push(msg); return true; }
  end(): void { this.emit('end'); }
  emitData(msg: unknown): void { this.emit('data', msg); }
}

describe('NetworkRouteManager unregister round-trip', () => {
  function makeManager(): { manager: NetworkRouteManager; stream: FakeDuplexStream } {
    const stream = new FakeDuplexStream();
    const client = {
      networkRouteStream: () => stream,
    } as unknown as TapsmithGrpcClient;
    return { manager: new NetworkRouteManager(client), stream };
  }

  it('removeRoute waits for UnregisterRouteResponse before resolving', async () => {
    const { manager, stream } = makeManager();

    // Register a route first. addRoute also awaits a response from the daemon,
    // so we have to drive that round-trip too.
    const addP = manager.addRoute('**/api/*', async () => { /* noop */ });
    // Wait a microtask so the `registerRoute` write lands.
    await Promise.resolve();
    const registerMsg = stream.writes.find(
      (m): m is { registerRoute: { routeId: string } } =>
        typeof m === 'object' && m !== null && 'registerRoute' in m,
    );
    expect(registerMsg).toBeDefined();
    const routeId = registerMsg!.registerRoute.routeId;
    stream.emitData({ registerRouteResponse: { routeId, success: true, errorMessage: '' } });
    await addP;

    // Now the actual test: removeRoute should send unregisterRoute and WAIT.
    const removeP = manager.removeRoute('**/api/*');
    await Promise.resolve();
    const unregisterMsg = stream.writes.find(
      (m): m is { unregisterRoute: { routeId: string } } =>
        typeof m === 'object' && m !== null && 'unregisterRoute' in m,
    );
    expect(unregisterMsg).toBeDefined();
    expect(unregisterMsg!.unregisterRoute.routeId).toBe(routeId);

    // Critical: the promise must be pending until the daemon replies.
    // Race the remove promise against an immediately-resolved sentinel;
    // if remove is still pending, the sentinel wins.
    const pending = Symbol('pending');
    const raceResult = await Promise.race([
      removeP.then(() => 'resolved' as const),
      Promise.resolve(pending),
    ]);
    expect(raceResult).toBe(pending);
    // And while pending, `hasRoutes` is still true — a request dispatched
    // mid-round-trip would still find its routeInfo and hit the user's
    // handler rather than the "unknown route" fallback.
    expect(manager.hasRoutes).toBe(true);

    // Daemon replies — the promise now resolves.
    stream.emitData({ unregisterRouteResponse: { routeId, success: true } });
    await removeP;
    expect(manager.hasRoutes).toBe(false);
  });
});

// ─── NetworkRouteManager route scopes (PILOT-534) ───

/** A fake daemon stream that acknowledges every register/unregister at once. */
class AutoAckStream extends FakeDuplexStream {
  override write(msg: unknown): boolean {
    super.write(msg);
    const m = msg as { registerRoute?: { routeId: string }; unregisterRoute?: { routeId: string } };
    queueMicrotask(() => {
      if (m.registerRoute) {
        this.emitData({ registerRouteResponse: { routeId: m.registerRoute.routeId, success: true, errorMessage: '' } });
      } else if (m.unregisterRoute) {
        this.emitData({ unregisterRouteResponse: { routeId: m.unregisterRoute.routeId, success: true } });
      }
    });
    return true;
  }
}

describe('NetworkRouteManager route scopes', () => {
  function makeManager(): { manager: NetworkRouteManager; stream: AutoAckStream } {
    const stream = new AutoAckStream();
    const client = { networkRouteStream: () => stream } as unknown as TapsmithGrpcClient;
    return { manager: new NetworkRouteManager(client), stream };
  }
  const unregistered = (stream: FakeDuplexStream): number =>
    stream.writes.filter((m) => typeof m === 'object' && m !== null && 'unregisterRoute' in m).length;

  it('reads no scope outside runInRouteScope, and the scope inside it across awaits', async () => {
    const scope: RouteScope = { label: 'Suite' };
    expect(currentRouteScope()).toBeUndefined();
    await runInRouteScope(scope, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentRouteScope()).toBe(scope);
    });
    expect(currentRouteScope()).toBeUndefined();
  });

  it('removeTestRoutes keeps routes registered in a scope', async () => {
    const { manager, stream } = makeManager();
    const scope: RouteScope = { label: 'Suite' };
    await runInRouteScope(scope, () => manager.addRoute('**/posts*', () => {}));
    await manager.addRoute('**/users/*', () => {});
    expect(manager.hasTestRoutes).toBe(true);

    await manager.removeTestRoutes();
    expect(unregistered(stream)).toBe(1);
    expect(manager.hasTestRoutes).toBe(false);
    expect(manager.hasRoutes).toBe(true);

    await manager.removeScopeRoutes(scope);
    expect(unregistered(stream)).toBe(2);
    expect(manager.hasRoutes).toBe(false);
  });

  it('removeScopeRoutes removes only the given scope', async () => {
    const { manager } = makeManager();
    const outer: RouteScope = { label: 'Outer' };
    const inner: RouteScope = { label: 'Inner' };
    await runInRouteScope(outer, () => manager.addRoute('**/a', () => {}));
    await runInRouteScope(inner, () => manager.addRoute('**/b', () => {}));

    await manager.removeScopeRoutes(inner);
    expect(manager.hasRoutes).toBe(true);
    await manager.removeTestRoutes();
    expect(manager.hasRoutes).toBe(true);
    await manager.removeScopeRoutes(outer);
    expect(manager.hasRoutes).toBe(false);
  });

  it('opens the route stream outside the scope of the beforeAll that first needs it', async () => {
    // Callbacks the stream drives (route handlers) must not inherit the
    // scope, or a route a handler registers mid-test would outlive the test.
    let scopeAtOpen: RouteScope | undefined | 'not-opened' = 'not-opened';
    const stream = new AutoAckStream();
    const client = {
      networkRouteStream: () => { scopeAtOpen = currentRouteScope(); return stream; },
    } as unknown as TapsmithGrpcClient;
    const manager = new NetworkRouteManager(client);
    await runInRouteScope({ label: 'Suite' }, () => manager.addRoute('**/a', () => {}));
    expect(scopeAtOpen).toBeUndefined();
  });

  it('treats a route registered after its scope ended as a test route', async () => {
    const { manager } = makeManager();
    const scope: RouteScope = { label: 'Suite' };
    let late: Promise<void> | undefined;
    await runInRouteScope(scope, async () => {
      // Work the hook leaves running, which registers once the scope is over.
      late = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => manager.addRoute('**/late', () => {}));
    });
    scope.ended = true;
    await manager.removeScopeRoutes(scope);
    await late;
    expect(manager.hasTestRoutes).toBe(true);
    await manager.removeTestRoutes();
    expect(manager.hasRoutes).toBe(false);
  });

  it('runs route handlers outside any route scope', async () => {
    const { manager, stream } = makeManager();
    let scopeInHandler: RouteScope | undefined | 'not-called' = 'not-called';
    await manager.addRoute('**/a', async (route) => {
      scopeInHandler = currentRouteScope();
      await route.continue();
    });
    const register = stream.writes.find(
      (m): m is { registerRoute: { routeId: string } } => typeof m === 'object' && m !== null && 'registerRoute' in m,
    )!;
    // Deliver the intercepted request from inside a scope, as a stream
    // whose events inherited a beforeAll's async context would.
    await runInRouteScope({ label: 'Suite' }, async () => {
      stream.emitData({ interceptedRequest: {
        interceptId: 'i1', routeId: register.registerRoute.routeId, method: 'GET',
        url: 'https://example.com/a', headers: [], body: Buffer.alloc(0), isHttps: true,
      } });
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(scopeInHandler).toBeUndefined();
  });

  it('counts requests handed to a route handler, and resets when taken (PILOT-775)', async () => {
    const { manager, stream } = makeManager();
    await manager.addRoute('**/a', (route) => route.continue());
    const register = stream.writes.find(
      (m): m is { registerRoute: { routeId: string } } => typeof m === 'object' && m !== null && 'registerRoute' in m,
    )!;
    expect(manager.takeHandlerCalls()).toBe(0);
    for (const interceptId of ['i1', 'i2']) {
      stream.emitData({ interceptedRequest: {
        interceptId, routeId: register.registerRoute.routeId, method: 'GET',
        url: 'https://example.com/a', headers: [], body: Buffer.alloc(0), isHttps: true,
      } });
    }
    // A request for a route already removed reaches no handler.
    stream.emitData({ interceptedRequest: {
      interceptId: 'i3', routeId: 'gone', method: 'GET',
      url: 'https://example.com/a', headers: [], body: Buffer.alloc(0), isHttps: true,
    } });
    await new Promise((r) => setTimeout(r, 1));
    expect(manager.takeHandlerCalls()).toBe(2);
    expect(manager.takeHandlerCalls()).toBe(0);
  });

  it('removes the listeners a test added at its end, keeping a suite hook\'s (PILOT-775)', async () => {
    const { manager, stream } = makeManager();
    const fromTest = vi.fn();
    const fromHook = vi.fn();
    manager.addRequestListener(fromTest);
    await runInRouteScope({ label: 'Suite' }, async () => { manager.addResponseListener(fromHook); });

    manager.removeTestListeners();
    stream.emitData({ requestEvent: { method: 'GET', url: 'https://example.com/a', headers: [], body: Buffer.alloc(0), isHttps: true } });
    stream.emitData({ responseEvent: { url: 'https://example.com/a', status: 200, headers: [], body: Buffer.alloc(0) } });
    await new Promise((r) => setTimeout(r, 1));

    expect(fromTest).not.toHaveBeenCalled();
    expect(fromHook).toHaveBeenCalledTimes(1);
  });

  it('opens the route stream outside the attempt of the test that first needs it (PILOT-775)', async () => {
    // The stream outlives that test; its callbacks run in the context it was
    // opened in, which would read as a closed attempt in every later test.
    const stream = new AutoAckStream();
    let tokenAtOpen: unknown = 'not opened';
    const client = {
      networkRouteStream: () => { tokenAtOpen = currentAttemptToken(); return stream; },
    } as unknown as TapsmithGrpcClient;
    const manager = new NetworkRouteManager(client);

    await runInAttemptContext({ closed: false }, () => manager.addRoute('**/a', () => {}));

    expect(tokenAtOpen).toBeUndefined();
  });

  it('removes the listeners a suite scope added once it ends (PILOT-775)', async () => {
    const { manager, stream } = makeManager();
    const scope: RouteScope = { label: 'Suite' };
    const fromHook = vi.fn();
    const fromOtherScope = vi.fn();
    await runInRouteScope(scope, async () => { manager.addRequestListener(fromHook); });
    await runInRouteScope({ label: 'Other' }, async () => { manager.addRequestListener(fromOtherScope); });

    manager.removeScopeListeners(scope);
    stream.emitData({ requestEvent: { method: 'GET', url: 'https://example.com/a', headers: [], body: Buffer.alloc(0), isHttps: true } });
    await new Promise((r) => setTimeout(r, 1));

    expect(fromHook).not.toHaveBeenCalled();
    expect(fromOtherScope).toHaveBeenCalledTimes(1);
  });

  it('removeAllRoutes (device.unrouteAll) still removes scoped routes', async () => {
    const { manager } = makeManager();
    await runInRouteScope({ label: 'Suite' }, () => manager.addRoute('**/a', () => {}));
    await manager.removeAllRoutes();
    expect(manager.hasRoutes).toBe(false);
  });
});

// ─── NetworkRouteManager stream reconnect (PILOT-581) ───

describe('NetworkRouteManager stream reconnect (PILOT-581)', () => {
  type Write = Record<string, { routeId?: string } | undefined>;

  /** A client that hands out a fresh auto-acking stream on every open. */
  function makeManager(): { manager: NetworkRouteManager; streams: AutoAckStream[] } {
    const streams: AutoAckStream[] = [];
    const client = {
      networkRouteStream: () => {
        const s = new AutoAckStream();
        streams.push(s);
        return s;
      },
    } as unknown as TapsmithGrpcClient;
    return { manager: new NetworkRouteManager(client), streams };
  }
  const writesOf = (s: FakeDuplexStream, kind: string): Write[] =>
    (s.writes as Write[]).filter((m) => typeof m === 'object' && m !== null && kind in m);
  const unavailable = (): Error => Object.assign(new Error('14 UNAVAILABLE: Connection dropped'), { code: 14 });
  /** Drop a stream the way grpc-js does: an error, then the end of the read side. */
  const drop = (s: FakeDuplexStream): void => {
    s.emit('error', unavailable());
    s.emit('end');
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('re-sends subscribeEvents on the replacement stream without waiting for user code', async () => {
    const { manager, streams } = makeManager();
    manager.addRequestListener(() => {});
    expect(writesOf(streams[0], 'subscribeEvents')).toHaveLength(1);

    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(streams).toHaveLength(2);
    expect(writesOf(streams[1], 'subscribeEvents')).toHaveLength(1);
    await manager.dispose();
  });

  it('delivers events from the replacement stream to listeners added before the drop', async () => {
    const { manager, streams } = makeManager();
    const seen: string[] = [];
    manager.addRequestListener((req) => { seen.push(req.url); });
    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(5_000);

    streams[1].emitData({ requestEvent: {
      method: 'GET', url: 'https://example.com/users/1', headers: [], body: Buffer.alloc(0), isHttps: true, routeAction: '',
    } });
    expect(seen).toEqual(['https://example.com/users/1']);
    await manager.dispose();
  });

  it('subscribes the replacement stream when capture subscribed eagerly with no listener yet', async () => {
    const { manager, streams } = makeManager();
    manager.ensureEventsSubscribed();
    drop(streams[0]);
    // A later waitForRequest adds a listener before any reopen timer fires.
    manager.addRequestListener(() => {});
    expect(streams).toHaveLength(2);
    expect(writesOf(streams[1], 'subscribeEvents')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(streams).toHaveLength(2);
    await manager.dispose();
  });

  it('does not re-subscribe once every listener was removed before the drop', async () => {
    const { manager, streams } = makeManager();
    const listener = (): void => {};
    manager.addResponseListener(listener);
    manager.removeResponseListener(listener);
    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(10_000);
    // Nothing to restore, so nothing reopens.
    expect(streams).toHaveLength(1);
    await manager.dispose();
  });

  it('re-registers every confirmed route under its id, keeping its handler, scope and times counter', async () => {
    const { manager, streams } = makeManager();
    const scope: RouteScope = { label: 'Suite' };
    const hits: string[] = [];
    await runInRouteScope(scope, () => manager.addRoute('**/posts*', (route) => { hits.push('posts'); return route.continue(); }));
    await manager.addRoute('**/users/*', (route) => { hits.push('users'); return route.continue(); }, { times: 2 });
    const firstIds = writesOf(streams[0], 'registerRoute').map((m) => m.registerRoute!.routeId);
    expect(firstIds).toHaveLength(2);

    // Spend one of the two `times` before the drop.
    streams[0].emitData({ interceptedRequest: {
      interceptId: 'i0', routeId: firstIds[1], method: 'GET', url: 'https://example.com/users/1',
      headers: [], body: Buffer.alloc(0), isHttps: true,
    } });
    await flush();

    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(streams).toHaveLength(2);
    const replayed = writesOf(streams[1], 'registerRoute').map((m) => m.registerRoute!.routeId);
    expect(replayed.sort()).toEqual([...firstIds].sort());
    expect(manager.hasRoutes).toBe(true);
    // The scope survives: removing the test's routes keeps the suite's.
    expect(manager.hasTestRoutes).toBe(true);

    // The replacement stream dispatches to the same handler, and the
    // remaining `times` (1) is honoured: the route unregisters after it.
    streams[1].emitData({ interceptedRequest: {
      interceptId: 'i1', routeId: firstIds[1], method: 'GET', url: 'https://example.com/users/2',
      headers: [], body: Buffer.alloc(0), isHttps: true,
    } });
    await flush();
    expect(hits).toEqual(['users', 'users']);
    expect(writesOf(streams[1], 'unregisterRoute').map((m) => m.unregisterRoute!.routeId)).toEqual([firstIds[1]]);
    expect(manager.hasTestRoutes).toBe(false);
    expect(manager.hasRoutes).toBe(true);
    await manager.dispose();
  });

  it('replays state before a lazy call writes its own message, and opens only one replacement', async () => {
    const { manager, streams } = makeManager();
    await manager.addRoute('**/a', () => {});
    drop(streams[0]);
    // User code touches the manager before the reopen timer fires.
    await manager.addRoute('**/b', () => {});
    expect(streams).toHaveLength(2);
    const urls = writesOf(streams[1], 'registerRoute').map((m) => (m.registerRoute as { urlPattern: string }).urlPattern);
    expect(urls).toEqual(['**/a', '**/b']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(streams).toHaveLength(2);
    await manager.dispose();
  });

  it('does not replay a route whose registration the drop interrupted', async () => {
    const streams: FakeDuplexStream[] = [];
    const client = {
      networkRouteStream: () => {
        // The first stream never acknowledges; later ones do.
        const s = streams.length === 0 ? new FakeDuplexStream() : new AutoAckStream();
        streams.push(s);
        return s;
      },
    } as unknown as TapsmithGrpcClient;
    const manager = new NetworkRouteManager(client);
    manager.addRequestListener(() => {});
    const pending = manager.addRoute('**/a', () => {});
    drop(streams[0]);
    await expect(pending).rejects.toThrow(/during route registration/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(streams).toHaveLength(2);
    expect(writesOf(streams[1], 'registerRoute')).toHaveLength(0);
    expect(manager.hasRoutes).toBe(false);
    await manager.dispose();
  });

  it("ignores a stale stream's late end once its replacement is open", async () => {
    const { manager, streams } = makeManager();
    await manager.addRoute('**/a', () => {});
    streams[0].emit('error', unavailable());
    // Lazily reopened before the old stream's read side ended.
    await manager.addRoute('**/b', () => {});
    expect(streams).toHaveLength(2);
    streams[0].emit('end');
    await vi.advanceTimersByTimeAsync(10_000);
    // The replacement is still the live stream: no third one, and writes land on it.
    expect(streams).toHaveLength(2);
    await manager.removeAllRoutes();
    expect(writesOf(streams[1], 'unregisterRoute')).toHaveLength(2);
    await manager.dispose();
  });

  it('backs off while replacement streams keep failing, without ever giving up', async () => {
    const streams: FakeDuplexStream[] = [];
    const client = {
      networkRouteStream: () => {
        // The first stream is healthy; the daemon then stops answering.
        const s = streams.length === 0 ? new AutoAckStream() : new FakeDuplexStream();
        streams.push(s);
        return s;
      },
    } as unknown as TapsmithGrpcClient;
    const manager = new NetworkRouteManager(client);
    await manager.addRoute('**/a', () => {});
    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(300);
    expect(streams).toHaveLength(2);
    // The daemon is still unreachable: each replacement dies at once.
    drop(streams[1]);
    await vi.advanceTimersByTimeAsync(300);
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(streams).toHaveLength(3);
    drop(streams[2]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(streams).toHaveLength(4);
    // Retries never stop while there is state to restore, but stay spaced out.
    for (let i = 0; i < 20; i++) {
      drop(streams[streams.length - 1]);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(streams.length).toBe(24);
    expect(writesOf(streams[streams.length - 1], 'registerRoute')).toHaveLength(1);
    await manager.dispose();
  });

  it('starts the backoff over once a replacement stream is answering', async () => {
    const { manager, streams } = makeManager();
    await manager.addRoute('**/a', () => {});
    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(300);
    // The replayed registration was acknowledged on stream 2.
    expect(streams).toHaveLength(2);
    drop(streams[1]);
    await vi.advanceTimersByTimeAsync(300);
    expect(streams).toHaveLength(3);
    await manager.dispose();
  });

  it('does not reopen without state to restore, and dispose cancels a pending reopen', async () => {
    const { manager, streams } = makeManager();
    await manager.addRoute('**/a', () => {});
    await manager.removeAllRoutes();
    drop(streams[0]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(streams).toHaveLength(1);

    await manager.addRoute('**/b', () => {});
    expect(streams).toHaveLength(2);
    drop(streams[1]);
    await manager.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(streams).toHaveLength(2);
  });

  it('leaves no replay listeners behind once the daemon acknowledges, however many routes', async () => {
    const { manager, streams } = makeManager();
    for (let i = 0; i < 12; i++) await manager.addRoute(`**/r${i}`, () => {});
    const warnings: Error[] = [];
    const onWarning = (w: Error): void => { warnings.push(w); };
    process.on('warning', onWarning);
    try {
      drop(streams[0]);
      await vi.advanceTimersByTimeAsync(300);
      expect(writesOf(streams[1], 'registerRoute')).toHaveLength(12);
      await flush();
      // Only the manager's own data/error/end listeners remain.
      expect(streams[1].listenerCount('data')).toBe(1);
      expect(streams[1].listenerCount('end')).toBe(1);
      await new Promise<void>((r) => process.nextTick(r));
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
    await manager.dispose();
  });

  it('does not keep the process alive while waiting to reopen', async () => {
    const { manager, streams } = makeManager();
    await manager.addRoute('**/a', () => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    drop(streams[0]);
    const handle = setTimeoutSpy.mock.results.at(-1)?.value as { hasRef?: () => boolean } | undefined;
    expect(handle?.hasRef?.()).toBe(false);
    setTimeoutSpy.mockRestore();
    await manager.dispose();
  });
});
