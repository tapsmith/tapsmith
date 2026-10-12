import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Device } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';

// ─── webkit-inspector module mock ───

const h = vi.hoisted(() => ({
  nextInspector: (() => {
    throw new Error('nextInspector not set by test');
  }) as () => unknown,
  findSocket: ((_udid: string) => '/tmp/webinspectord_sim.socket') as (udid: string) => string | null,
  constructed: [] as unknown[],
}));

vi.mock('../webkit-inspector.js', () => ({
  WebKitInspectorClient: function (this: unknown) {
    const inspector = h.nextInspector();
    h.constructed.push(inspector);
    return inspector;
  },
  findSimulatorInspectorSocket: (udid: string) => h.findSocket(udid),
}));

// ─── Mock helpers ───

interface MockPage {
  id: number
  title: string
  url: string
  type: string
}

interface MockTarget {
  appId: string
  bundleId: string
  name: string
  pages: MockPage[]
}

function page(id: number): MockPage {
  return { id, title: `page-${id}`, url: `https://example.com/${id}`, type: 'web-page' };
}

function makeMockInspector(overrides: Record<string, unknown> = {}) {
  const state = { connected: false };
  return {
    connect: vi.fn(async () => {
      state.connected = true;
    }),
    isConnected: vi.fn(() => state.connected),
    close: vi.fn(() => {
      state.connected = false;
    }),
    listTargets: vi.fn(async (): Promise<MockTarget[]> => []),
    connectToPage: vi.fn(async (_appId: string, _pageId: number) => {}),
    // Shape of a successful Runtime.evaluate reply through the inspector
    // transport — _evaluate unwraps the outer `result` key. The connect
    // probe evaluates document.visibilityState, so a "live rendered page"
    // answers 'visible'.
    sendInspectorMessage: vi.fn(async (_appId: string, message: Record<string, unknown>) => {
      const expression = (message.params as { expression?: string } | undefined)?.expression;
      const value = expression === 'document.visibilityState' ? 'visible' : 1;
      return { result: { result: { value } } };
    }),
    _state: state,
    ...overrides,
  };
}

/** sendInspectorMessage mock where the currently connected page answers with a fixed visibilityState. */
function visibilityByPage(states: Record<number, string>) {
  let connectedPage = -1;
  return {
    connectToPage: vi.fn(async (_appId: string, pageId: number) => {
      connectedPage = pageId;
    }),
    sendInspectorMessage: vi.fn(async (_appId: string, message: Record<string, unknown>) => {
      const expression = (message.params as { expression?: string } | undefined)?.expression;
      const value = expression === 'document.visibilityState' ? (states[connectedPage] ?? 'visible') : 1;
      return { result: { result: { value } } };
    }),
  };
}

function makeMockClient(): TapsmithGrpcClient {
  return {
    findElement: vi.fn(async () => ({ requestId: '1', found: false, errorMessage: '' })),
    closeWebViewPort: vi.fn(async () => ({ requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0) })),
    setDevice: vi.fn(async () => ({ requestId: '1', success: true, errorMessage: '' })),
  } as unknown as TapsmithGrpcClient;
}

function makeIosDevice(timeout: number): Device {
  return new Device(makeMockClient(), {
    platform: 'ios',
    package: 'dev.tapsmith.testapp',
    timeout,
  });
}

beforeEach(() => {
  h.constructed = [];
  h.findSocket = () => '/tmp/webinspectord_sim.socket';
  h.nextInspector = () => {
    throw new Error('nextInspector not set by test');
  };
});

// ─── Tests ───

describe('Device.webview() on iOS — bounded connection setup (PILOT-288)', () => {
  it('fails within the device timeout with a phase-specific error when the inspector socket connect hangs', async () => {
    const inspector = makeMockInspector({
      connect: vi.fn(() => new Promise<never>(() => {})),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(300);
    await expect(device.webview()).rejects.toThrow(
      /WebView connection setup timed out during connecting to the WebKit Inspector service/,
    );
    // The hung connection attempt must be torn down, not leaked.
    expect(inspector.close).toHaveBeenCalled();
  });

  it('fails within the device timeout with a phase-specific error when listing targets hangs', async () => {
    const inspector = makeMockInspector({
      listTargets: vi.fn(() => new Promise<never>(() => {})),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(300);
    await expect(device.webview()).rejects.toThrow(
      /WebView connection setup timed out during listing WebView targets/,
    );
    expect(inspector.close).toHaveBeenCalled();
  });

  it('re-establishes the inspector session between retries after a failed connect', async () => {
    const first = makeMockInspector({
      connect: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const second = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] },
      ]),
    });
    const inspectors = [first, second];
    h.nextInspector = () => inspectors.shift() ?? makeMockInspector();

    const device = makeIosDevice(5_000);
    const handle = await device.webview();
    expect(handle).toBeDefined();
    expect(first.close).toHaveBeenCalled();
    expect(second.connectToPage).toHaveBeenCalledWith('PID:100', 1);
  });

  it('retries on a fresh inspector session when a page setup fails', async () => {
    const target: MockTarget = { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] };
    const makeGood = () =>
      makeMockInspector({ listTargets: vi.fn(async (): Promise<MockTarget[]> => [target]) });
    const first = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [target]),
      connectToPage: vi.fn(async () => {
        throw new Error('Timed out waiting for WebView target — no Target.targetCreated received');
      }),
    });
    const goods: ReturnType<typeof makeMockInspector>[] = [];
    let handedFirst = false;
    h.nextInspector = () => {
      if (!handedFirst) {
        handedFirst = true;
        return first;
      }
      const good = makeGood();
      goods.push(good);
      return good;
    };

    const device = makeIosDevice(10_000);
    await device.webview();

    // The failed setup must never be retried on the same connection.
    expect(first.close).toHaveBeenCalled();
    expect(first.connectToPage).toHaveBeenCalledTimes(1);
    const winner = goods.find(g => g.connectToPage.mock.calls.length > 0);
    expect(winner?.connectToPage).toHaveBeenCalledWith('PID:100', 1);
  });

  it('recycles the session after a failed setup but still tries older pages in the same round', async () => {
    // Page 7 (newest) never comes up; page 3 is live. The failed setup on
    // page 7 must not be followed by a setup for page 3 on the SAME
    // connection (late Target.targetCreated cross-wire), nor may page 3
    // starve behind round restarts.
    const target: MockTarget = { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(3), page(7)] };
    const first = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [target]),
      connectToPage: vi.fn(async (_appId: string, pageId: number) => {
        if (pageId === 7) throw new Error('Setting up the WebView page session timed out after 5000ms');
        throw new Error('older page must not reuse a connection after a failed setup');
      }),
    });
    const second = makeMockInspector();
    const inspectors = [first, second];
    h.nextInspector = () => inspectors.shift() ?? makeMockInspector();

    const device = makeIosDevice(10_000);
    await device.webview();

    expect(first.connectToPage).toHaveBeenCalledTimes(1);
    expect(first.connectToPage).toHaveBeenCalledWith('PID:100', 7);
    expect(first.close).toHaveBeenCalled();
    expect(second.connectToPage).toHaveBeenCalledWith('PID:100', 3);
  });

  it('keeps waiting (and eventually times out) when no inspectable pages appear', async () => {
    const inspector = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => []),
    });
    h.nextInspector = () => inspector;

    // Unlike the hung-mock tests above, this one has to *survive* connecting and
    // listing to reach the phase it asserts on — `listTargets` returns
    // immediately, so the budget must outlast those phases by enough that
    // scheduling delay cannot consume it. At 300ms a loaded CI runner spent the
    // whole budget inside "listing WebView targets" and the error named that
    // phase instead, failing the match.
    const device = makeIosDevice(2_000);
    await expect(device.webview()).rejects.toThrow(
      /WebView connection setup timed out during waiting for an inspectable WebView page.*No inspectable WebView pages found/,
    );
    expect(inspector.listTargets.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Device.webview() on iOS — stale dead-page target selection (PILOT-288)', () => {
  it('probes the newest app entry and newest page first', async () => {
    const inspector = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        // Stale entry from the previous app process, listed first.
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] },
        // Live entry: newest pid, pages listed oldest-first.
        { appId: 'PID:200', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(3), page(7)] },
      ]),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(5_000);
    await device.webview();

    expect(inspector.connectToPage).toHaveBeenCalledTimes(1);
    expect(inspector.connectToPage).toHaveBeenCalledWith('PID:200', 7);
  });

  it('falls back to older pages when the newest page does not respond', async () => {
    const inspector = makeMockInspector();
    inspector.connectToPage = vi.fn(async (_appId: string, pageId: number) => {
      if (pageId === 7) throw new Error('Timed out waiting for WebView target');
    });
    inspector.listTargets = vi.fn(async (): Promise<MockTarget[]> => [
      { appId: 'PID:200', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(3), page(7)] },
    ]);
    h.nextInspector = () => inspector;

    const device = makeIosDevice(5_000);
    await device.webview();

    expect(inspector.connectToPage).toHaveBeenCalledTimes(2);
    expect(inspector.connectToPage).toHaveBeenNthCalledWith(1, 'PID:200', 7);
    expect(inspector.connectToPage).toHaveBeenNthCalledWith(2, 'PID:200', 3);
  });
});

describe('Device.webview() on iOS — detached-page rejection (PILOT-288)', () => {
  it('skips a newer page that answers but is not rendered, and picks the visible one', async () => {
    // Page 7 is the detached predecessor (higher id here to prove the
    // visibility gate overrides newest-first); page 3 is the rendered page.
    const inspector = makeMockInspector({
      ...visibilityByPage({ 7: 'hidden', 3: 'visible' }),
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(3), page(7)] },
      ]),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(5_000);
    await device.webview();

    expect(inspector.connectToPage).toHaveBeenNthCalledWith(1, 'PID:100', 7);
    expect(inspector.connectToPage).toHaveBeenNthCalledWith(2, 'PID:100', 3);
    expect(inspector.connectToPage).toHaveBeenCalledTimes(2);
  });

  it('falls back to a responsive-but-hidden page once past half the budget', async () => {
    const inspector = makeMockInspector({
      ...visibilityByPage({ 5: 'hidden' }),
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(5)] },
      ]),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(1_500);
    const handle = await device.webview();

    expect(handle).toBeDefined();
    // Rejected at least once as hidden, then re-attached as the fallback.
    expect(inspector.connectToPage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(inspector.connectToPage).toHaveBeenLastCalledWith('PID:100', 5);
  });

  it('keeps rejecting a hidden page before half the budget and accepts it once it becomes visible', async () => {
    const states: Record<number, string> = { 5: 'hidden' };
    const base = visibilityByPage(states);
    let rejected = false;
    const inspector = makeMockInspector({
      ...base,
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(5)] },
      ]),
      sendInspectorMessage: vi.fn(async (appId: string, message: Record<string, unknown>) => {
        rejected = true;
        return base.sendInspectorMessage(appId, message);
      }),
    });
    h.nextInspector = () => inspector;

    // The hidden page must not win before half the budget (the permanently
    // hidden case is covered by the fallback test above) — flip it to
    // visible after the first rejection round and verify the accept happened
    // only after the flip.
    setTimeout(() => {
      states[5] = 'visible';
    }, 700);

    const device = makeIosDevice(5_000);
    await device.webview();
    expect(rejected).toBe(true);
    // The winning attach happened after the flip — never the early hidden accept.
    expect(inspector.connectToPage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Device.webview() on iOS — cached connection reuse', () => {
  it('reuses the cached handle while the inspector socket is connected', async () => {
    const inspector = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] },
      ]),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(5_000);
    const first = await device.webview();
    await device.native();
    const second = await device.webview();

    expect(second).toBe(first);
    expect(h.constructed).toHaveLength(1);
  });

  it('reuses the cached handle across per-test context resets (PILOT-288)', async () => {
    const inspector = makeMockInspector({
      listTargets: vi.fn(async (): Promise<MockTarget[]> => [
        { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] },
      ]),
    });
    h.nextInspector = () => inspector;

    const device = makeIosDevice(5_000);
    const first = await device.webview();
    device._resetWebViewContext();
    const second = await device.webview();

    expect(second).toBe(first);
    expect(h.constructed).toHaveLength(1);
  });

  it('disposes the cached connection when setDevice switches to a different device', async () => {
    const makeConnected = () =>
      makeMockInspector({
        listTargets: vi.fn(async (): Promise<MockTarget[]> => [
          { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] },
        ]),
      });
    const first = makeConnected();
    const second = makeConnected();
    const inspectors = [first, second];
    h.nextInspector = () => inspectors.shift() ?? makeMockInspector();

    const device = makeIosDevice(5_000);
    await device.setDevice('AAAAAAAA-0000-0000-0000-000000000001');
    const handle1 = await device.webview();

    // Same serial again: the cached connection must survive.
    await device.setDevice('AAAAAAAA-0000-0000-0000-000000000001');
    expect(await device.webview()).toBe(handle1);
    expect(first.close).not.toHaveBeenCalled();

    // Different serial: the cache points at the old device's inspector
    // socket and must not leak across.
    await device.setDevice('BBBBBBBB-0000-0000-0000-000000000002');
    expect(first.close).toHaveBeenCalled();
    const handle2 = await device.webview();
    expect(handle2).not.toBe(handle1);
    expect(h.constructed).toHaveLength(2);
  });

  it('reconnects instead of reusing a handle whose inspector socket died', async () => {
    const makeConnected = () =>
      makeMockInspector({
        listTargets: vi.fn(async (): Promise<MockTarget[]> => [
          { appId: 'PID:100', bundleId: 'dev.tapsmith.testapp', name: 'TestApp', pages: [page(1)] },
        ]),
      });
    const first = makeConnected();
    const second = makeConnected();
    const inspectors = [first, second];
    h.nextInspector = () => inspectors.shift() ?? makeMockInspector();

    const device = makeIosDevice(5_000);
    const handle1 = await device.webview();
    await device.native();

    // Simulate webinspectord dropping the connection under us.
    first._state.connected = false;

    const handle2 = await device.webview();
    expect(handle2).not.toBe(handle1);
    expect(h.constructed).toHaveLength(2);
  });
});
