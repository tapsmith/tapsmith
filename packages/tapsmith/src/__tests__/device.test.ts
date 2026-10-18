import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Device } from '../device.js';
import { isTestEndedError, runInAttemptContext } from '../attempt-fence.js';
import { selectorToProto } from '../selectors.js';
import type { TapsmithGrpcClient, ActionResponse } from '../grpc-client.js';
import { TraceCollector } from '../trace/trace-collector.js';
import type { ConsoleTraceEvent } from '../trace/types.js';
import { onActionProgress, type ActionProgressEvent } from '../action-progress.js';

// ─── Mock helpers ───

function successResponse(): ActionResponse {
  return {
    requestId: '1',
    success: true,
    errorType: '',
    errorMessage: '',
    screenshot: Buffer.alloc(0),
  };
}

function failureResponse(msg = 'Action failed'): ActionResponse {
  return {
    requestId: '1',
    success: false,
    errorType: 'ERROR',
    errorMessage: msg,
    screenshot: Buffer.alloc(0),
  };
}

function makeMockClient(overrides: Partial<TapsmithGrpcClient> = {}): TapsmithGrpcClient {
  return {
    doubleTap: vi.fn(async () => successResponse()),
    dragAndDrop: vi.fn(async () => successResponse()),
    pinchZoom: vi.fn(async () => successResponse()),
    focus: vi.fn(async () => successResponse()),
    blur: vi.fn(async () => successResponse()),
    selectOption: vi.fn(async () => successResponse()),
    highlight: vi.fn(async () => successResponse()),
    pressKey: vi.fn(async () => successResponse()),
    launchApp: vi.fn(async () => successResponse()),
    openDeepLink: vi.fn(async () => successResponse()),
    getCurrentPackage: vi.fn(async () => ({ requestId: '1', packageName: 'com.example.app' })),
    getCurrentActivity: vi.fn(async () => ({ requestId: '1', activity: '.MainActivity' })),
    terminateApp: vi.fn(async () => successResponse()),
    getAppState: vi.fn(async () => ({ requestId: '1', state: 'foreground' })),
    clearAppData: vi.fn(async () => successResponse()),
    grantPermission: vi.fn(async () => successResponse()),
    revokePermission: vi.fn(async () => successResponse()),
    setClipboard: vi.fn(async () => successResponse()),
    getClipboard: vi.fn(async () => ({ requestId: '1', text: 'clipboard text' })),
    setOrientation: vi.fn(async () => successResponse()),
    getOrientation: vi.fn(async () => ({ requestId: '1', orientation: 'portrait' })),
    isKeyboardShown: vi.fn(async () => ({ requestId: '1', shown: false })),
    hideKeyboard: vi.fn(async () => successResponse()),
    openNotifications: vi.fn(async () => successResponse()),
    openQuickSettings: vi.fn(async () => successResponse()),
    setColorScheme: vi.fn(async () => successResponse()),
    getColorScheme: vi.fn(async () => ({ requestId: '1', scheme: 'light' })),
    wakeDevice: vi.fn(async () => successResponse()),
    unlockDevice: vi.fn(async () => successResponse()),
    startAgent: vi.fn(async () => successResponse()),
    restartApp: vi.fn(async () => successResponse()),
    saveAppState: vi.fn(async () => successResponse()),
    restoreAppState: vi.fn(async () => successResponse()),
    listDevices: vi.fn(async () => ({ requestId: '1', devices: [] })),
    setDevice: vi.fn(async () => successResponse()),
    startNetworkCapture: vi.fn(async () => ({
      requestId: '1',
      success: true,
      proxyPort: 12345,
      errorMessage: '',
    })),
    stopNetworkCapture: vi.fn(async () => ({
      requestId: '1',
      success: true,
      entries: [],
      errorMessage: '',
    })),
    waitForIdle: vi.fn(async () => successResponse()),
    takeScreenshot: vi.fn(async () => ({
      requestId: '1',
      success: true,
      data: Buffer.alloc(0),
      errorMessage: '',
    })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy />',
      errorMessage: '',
    })),
    findElement: vi.fn(async () => ({
      requestId: '1',
      found: false,
      errorMessage: '',
    })),
    listWebViews: vi.fn(async () => ({
      requestId: '1',
      webviews: [],
      errorMessage: '',
    })),
    forwardWebViewPort: vi.fn(async () => ({
      requestId: '1',
      success: false,
      localPort: 0,
      errorMessage: 'not forwarded',
    })),
    closeWebViewPort: vi.fn(async () => successResponse()),
    ...overrides,
  } as unknown as TapsmithGrpcClient;
}

type LogHandler = (value?: unknown) => void;

function makeDeviceLogStream() {
  const handlers = new Map<string, LogHandler[]>();
  const stream = {
    cancel: vi.fn(),
    on: vi.fn((event: string, handler: LogHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return stream;
    }),
    emit(event: string, value?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
  };
  return stream;
}

function makeTraceCollector(tempDir: string): TraceCollector {
  return new TraceCollector({
    mode: 'on',
    screenshots: false,
    snapshots: false,
    sources: false,
    attachments: true,
    network: false,
    deviceLogs: true,
    daemonLogs: false,
  }, tempDir);
}

class FakeRouteStream extends EventEmitter {
  public writes: unknown[] = [];

  write(msg: unknown): boolean {
    this.writes.push(msg);
    const routeId = (msg as { registerRoute?: { routeId?: string } }).registerRoute?.routeId;
    if (routeId) {
      queueMicrotask(() => {
        this.emit('data', {
          registerRouteResponse: { routeId, success: true, errorMessage: '' },
        });
      });
    }
    return true;
  }
}

function deviceLogMessages(collector: TraceCollector): (string | undefined)[] {
  return collector.events
    .filter((event): event is ConsoleTraceEvent =>
      event.type === 'console' && event.source === 'device'
    )
    .map((event) => event.message);
}

// ─── getBy* locator factories ───

describe('Device locator factories', () => {
  it('getByText() defaults to substring match (textContains)', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByText('Submit');
    expect(selectorToProto(handle._selector)).toEqual({ textContains: 'Submit' });
  });

  it('getByText({exact: true}) uses exact text match', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByText('Submit', { exact: true });
    expect(selectorToProto(handle._selector)).toEqual({ text: 'Submit' });
  });

  it('getByRole() builds a role selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByRole('button', { name: 'Save' });
    expect(selectorToProto(handle._selector)).toEqual({
      role: { role: 'button', name: 'Save' },
    });
  });

  it('getByRole() defaults name to empty string', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByRole('checkbox');
    expect(selectorToProto(handle._selector)).toEqual({
      role: { role: 'checkbox', name: '' },
    });
  });

  it('getByDescription() builds a contentDesc selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByDescription('Close');
    expect(selectorToProto(handle._selector)).toEqual({ contentDesc: 'Close' });
  });

  it('getByPlaceholder() builds a hint selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByPlaceholder('Enter email');
    expect(selectorToProto(handle._selector)).toEqual({ hint: 'Enter email' });
  });

  it('getByTestId() builds a testId selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByTestId('submit-btn');
    expect(selectorToProto(handle._selector)).toEqual({ testId: 'submit-btn' });
  });

  it('locator({id}) builds an id selector serialized as resourceId', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.locator({ id: 'com.app:id/btn' });
    expect(selectorToProto(handle._selector)).toEqual({ resourceId: 'com.app:id/btn' });
  });

  it('locator({xpath}) builds an xpath selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.locator({ xpath: '//Button[@text="OK"]' });
    expect(selectorToProto(handle._selector)).toEqual({ xpath: '//Button[@text="OK"]' });
  });

  it('locator({className}) builds a className selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.locator({ className: 'android.widget.Button' });
    expect(selectorToProto(handle._selector)).toEqual({ className: 'android.widget.Button' });
  });

  it('locator() throws when no field is set', () => {
    const client = makeMockClient();
    const device = new Device(client);
    expect(() => device.locator({})).toThrow(/exactly one/);
  });

  it('locator() throws when multiple fields are set', () => {
    const client = makeMockClient();
    const device = new Device(client);
    expect(() => device.locator({ id: 'a', xpath: '//b' })).toThrow(/exactly one/);
  });
});

// ─── platform getter ───

describe('Device.platform', () => {
  it('defaults to android when no platform is configured', () => {
    const client = makeMockClient();
    const device = new Device(client);
    expect(device.platform).toBe('android');
  });

  it('reflects the configured platform', () => {
    const client = makeMockClient();
    expect(new Device(client, { platform: 'ios' }).platform).toBe('ios');
    expect(new Device(client, { platform: 'android' }).platform).toBe('android');
  });
});

// ─── Device Log Streaming ───

describe('Device device log streaming', () => {
  it('rebinds the log stream when a new trace collector starts', () => {
    const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-device-log-'));
    const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-device-log-'));
    const collector1 = makeTraceCollector(tempDir1);
    const collector2 = makeTraceCollector(tempDir2);
    const stream1 = makeDeviceLogStream();
    const stream2 = makeDeviceLogStream();
    const streams = [stream1, stream2];
    const deviceLogStream = vi.fn(() =>
      streams.shift() as unknown as ReturnType<TapsmithGrpcClient['deviceLogStream']>
    );
    const client = makeMockClient({ deviceLogStream });
    const device = new Device(client, { package: 'com.example.app' });

    try {
      device._startDeviceLogStream(collector1);
      stream1.emit('data', {
        level: 'info',
        tag: 'App',
        message: 'first',
        timestampMs: 1,
        pid: 10,
      });

      device._startDeviceLogStream(collector2);
      expect(stream1.cancel).toHaveBeenCalledTimes(1);
      expect(deviceLogStream).toHaveBeenCalledTimes(2);

      stream1.emit('end');
      device._startDeviceLogStream(collector2);
      expect(deviceLogStream).toHaveBeenCalledTimes(2);

      stream1.emit('data', {
        level: 'warn',
        tag: 'App',
        message: 'stale',
        timestampMs: 2,
        pid: 10,
      });
      stream2.emit('data', {
        level: 'warn',
        tag: 'App',
        message: 'second',
        timestampMs: 3,
        pid: 11,
      });

      expect(deviceLogMessages(collector1)).toEqual(['[App] first']);
      expect(deviceLogMessages(collector2)).toEqual(['[App] second']);

      device._stopDeviceLogStream();
      expect(stream2.cancel).toHaveBeenCalledTimes(1);
    } finally {
      collector1.cleanup();
      collector2.cleanup();
      fs.rmSync(tempDir1, { recursive: true, force: true });
      fs.rmSync(tempDir2, { recursive: true, force: true });
    }
  });
});

// ─── WebView management ───

describe('Device.webview()', () => {
  it('fails within the device timeout when WebView discovery hangs', async () => {
    const listWebViews = vi.fn(() => new Promise<never>(() => {}));
    const client = makeMockClient({ listWebViews });
    const device = new Device(client, { timeout: 50 });
    const started = Date.now();

    await expect(device.webview()).rejects.toThrow(/Timed out waiting for WebView/);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(listWebViews).toHaveBeenCalled();
  });

  it('targets the configured app package by default', async () => {
    const listWebViews = vi.fn(async () => ({
      requestId: '1',
      webviews: [
        {
          socketName: 'webview_devtools_remote_foreign',
          pid: 111,
          packageName: 'com.google.android.googlequicksearchbox:search',
          url: '',
          title: '',
        },
        {
          socketName: 'webview_devtools_remote_app',
          pid: 222,
          packageName: 'com.example.app',
          url: '',
          title: '',
        },
      ],
      errorMessage: '',
    }));
    const forwardWebViewPort = vi.fn(async () => ({
      requestId: '1',
      success: false,
      localPort: 0,
      errorMessage: 'not forwarded',
    }));
    const client = makeMockClient({ listWebViews, forwardWebViewPort });
    const device = new Device(client, { timeout: 50, package: 'com.example.app' });

    await expect(device.webview()).rejects.toThrow(/Timed out waiting for WebView/);

    expect(forwardWebViewPort).toHaveBeenCalled();
    expect((forwardWebViewPort.mock.calls[0] as unknown[])[0]).toBe('webview_devtools_remote_app');
  });

  it('does not attach to another app when a package is configured', async () => {
    const listWebViews = vi.fn(async () => ({
      requestId: '1',
      webviews: [
        {
          socketName: 'webview_devtools_remote_foreign',
          pid: 111,
          packageName: 'com.google.android.googlequicksearchbox:search',
          url: '',
          title: '',
        },
      ],
      errorMessage: '',
    }));
    const forwardWebViewPort = vi.fn(async () => ({
      requestId: '1',
      success: true,
      localPort: 12345,
      errorMessage: '',
    }));
    const client = makeMockClient({ listWebViews, forwardWebViewPort });
    // Timeout must be generous enough that a CI event-loop stall can't expire
    // the deadline before the first listWebViews poll completes — otherwise
    // the error lacks the "No WebViews found" detail and the test flakes.
    const device = new Device(client, { timeout: 500, package: 'com.example.app' });

    await expect(device.webview()).rejects.toThrow(/No WebViews found for package "com.example.app"/);

    expect(forwardWebViewPort).not.toHaveBeenCalled();
  });

  it('records a failed WebView connect action in traces', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-webview-trace-'));
    const listWebViews = vi.fn(() => new Promise<never>(() => {}));
    const client = makeMockClient({ listWebViews });
    const device = new Device(client, { timeout: 50 });
    const collector = device.tracing._startManaged({
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true,
      network: false,
      deviceLogs: false,
      daemonLogs: false,
    }, tempDir);

    try {
      await expect(device.webview()).rejects.toThrow(/Timed out waiting for WebView/);
      const event = collector.events.find((ev) =>
        ev.type === 'action' &&
        ev.category === 'webview' &&
        ev.action === 'connect'
      );
      expect(event).toMatchObject({
        type: 'action',
        category: 'webview',
        action: 'connect',
        success: false,
      });
    } finally {
      device.tracing._stopManaged();
      collector.cleanup();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Device Management (PILOT-10) ───

// ─── launchApp() ───

describe('Device.launchApp()', () => {
  it('delegates to client.launchApp with package name', async () => {
    const launchApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ launchApp });
    const device = new Device(client);
    await device.launchApp('com.example.app');
    expect(launchApp).toHaveBeenCalledWith('com.example.app', undefined);
  });

  it('passes options through', async () => {
    const launchApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ launchApp });
    const device = new Device(client);
    await device.launchApp('com.example.app', { activity: '.MainActivity', clearData: true });
    expect(launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      clearData: true,
    });
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      launchApp: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.launchApp('com.example.app')).rejects.toThrow('Launch app failed');
  });
});

// ─── openDeepLink() ───

describe('Device.openDeepLink()', () => {
  it('delegates to client.openDeepLink', async () => {
    const openDeepLink = vi.fn(async () => successResponse());
    const client = makeMockClient({ openDeepLink });
    const device = new Device(client);
    await device.openDeepLink('myapp://settings');
    expect(openDeepLink).toHaveBeenCalledWith('myapp://settings', undefined);
  });

  it('passes forceColdLaunch through to the client', async () => {
    const openDeepLink = vi.fn(async () => successResponse());
    const client = makeMockClient({ openDeepLink });
    const device = new Device(client);
    await device.openDeepLink('myapp://reset', { forceColdLaunch: true });
    expect(openDeepLink).toHaveBeenCalledWith('myapp://reset', { forceColdLaunch: true });
  });

  it('forces cold launch on every call while _setForceColdDeepLinks is set', async () => {
    const openDeepLink = vi.fn(async () => successResponse());
    const client = makeMockClient({ openDeepLink });
    const device = new Device(client);

    device._setForceColdDeepLinks(true);
    await device.openDeepLink('myapp://settings');
    expect(openDeepLink).toHaveBeenLastCalledWith('myapp://settings', { forceColdLaunch: true });

    // An explicit warm request cannot override the retry-attempt flag.
    await device.openDeepLink('myapp://settings', { forceColdLaunch: false });
    expect(openDeepLink).toHaveBeenLastCalledWith('myapp://settings', { forceColdLaunch: true });

    device._setForceColdDeepLinks(false);
    await device.openDeepLink('myapp://settings');
    expect(openDeepLink).toHaveBeenLastCalledWith('myapp://settings', undefined);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      openDeepLink: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.openDeepLink('myapp://x')).rejects.toThrow('Open deep link failed');
  });
});

// ─── currentPackage() / currentActivity() ───

describe('Device.currentPackage()', () => {
  it('returns the package name', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const pkg = await device.currentPackage();
    expect(pkg).toBe('com.example.app');
  });
});

describe('Device.currentActivity()', () => {
  it('returns the activity name', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const activity = await device.currentActivity();
    expect(activity).toBe('.MainActivity');
  });
});

// ─── setDevice() ───

describe('Device.setDevice()', () => {
  it('delegates directly to daemon setDevice', async () => {
    const listDevices = vi.fn(async () => ({ requestId: '1', devices: [], unusableDevices: [] }));
    const setDevice = vi.fn(async () => successResponse());
    const client = makeMockClient({ listDevices, setDevice });
    const device = new Device(client);

    await device.setDevice('SIM-UDID', true, ['example.test'], ['pinned.example.test']);

    expect(listDevices).not.toHaveBeenCalled();
    expect(setDevice).toHaveBeenCalledWith(
      'SIM-UDID',
      true,
      ['example.test'],
      ['pinned.example.test'],
    );
  });
});

// ─── route() ───

describe('Device.route()', () => {
  it('fails fast when network capture startup failed', async () => {
    const client = makeMockClient({
      startNetworkCapture: vi.fn(async () => ({
        requestId: '1',
        success: false,
        proxyPort: 0,
        errorMessage: 'proxy unavailable',
      })),
    });
    const device = new Device(client);

    await device._startNetworkCapture();

    await expect(device.route('**/posts*', async () => undefined))
      .rejects.toThrow('Network capture disabled: proxy unavailable');
  });

  it('clears cached startup failure when network capture stops', async () => {
    const stream = new FakeRouteStream();
    const client = makeMockClient({
      startNetworkCapture: vi.fn(async () => ({
        requestId: '1',
        success: false,
        proxyPort: 0,
        errorMessage: 'proxy unavailable',
      })),
      networkRouteStream: vi.fn(
        () => stream as unknown as ReturnType<TapsmithGrpcClient['networkRouteStream']>,
      ),
    });
    const device = new Device(client);

    await device._startNetworkCapture();
    await expect(device.route('**/posts*', async () => undefined))
      .rejects.toThrow('Network capture disabled: proxy unavailable');

    await device._stopNetworkCapture();

    await expect(device.route('**/posts*', async () => undefined)).resolves.toBeUndefined();
    expect(stream.writes).toHaveLength(1);
  });

  // PILOT-775: mocking needs no trace config — the runner arms an on-demand
  // start and the first route() makes it.
  describe('on-demand network capture (PILOT-775)', () => {
    const makeOnDemand = (results: Array<{ success: boolean; errorMessage: string }>) => {
      const stream = new FakeRouteStream();
      const startNetworkCapture = vi.fn(async () => ({ requestId: '1', proxyPort: 1, ...(results.shift() ?? { success: true, errorMessage: '' }) }));
      const client = makeMockClient({
        startNetworkCapture,
        networkRouteStream: vi.fn(
          () => stream as unknown as ReturnType<TapsmithGrpcClient['networkRouteStream']>,
        ),
      });
      const device = new Device(client);
      const arm = (): void => device._setOnDemandNetworkCapture(async () => { await device._startNetworkCapture(); });
      return { device, startNetworkCapture, arm };
    };

    it('starts capture once for concurrent first calls, then not again while it runs', async () => {
      const { device, startNetworkCapture, arm } = makeOnDemand([]);
      arm();
      await Promise.all([
        device.route('**/a', async () => undefined),
        device.route('**/b', async () => undefined),
      ]);
      await device.route('**/c', async () => undefined);

      expect(startNetworkCapture).toHaveBeenCalledTimes(1);
      expect(device._networkProxyRunning).toBe(true);
      expect(device._takeProxyStartedOnDemand()).toBe(true);
    });

    it('does not count a start that found the proxy already running as a new one', async () => {
      const { device, arm } = makeOnDemand([]);
      arm();
      await device.route('**/a', async () => undefined);
      device._takeProxyStartedOnDemand();
      await device._stopNetworkCapture({ keepRunning: true });

      arm();
      await device.route('**/b', async () => undefined);

      expect(device._takeProxyStartedOnDemand()).toBe(false);
    });

    it('fails route() with the reason, tries once per arm, and tries again once re-armed', async () => {
      const { device, startNetworkCapture, arm } = makeOnDemand([
        { success: false, errorMessage: 'Network Extension not approved' },
        { success: true, errorMessage: '' },
      ]);
      arm();
      await expect(device.route('**/a', async () => undefined))
        .rejects.toThrow('Network capture disabled: Network Extension not approved');
      await expect(device.route('**/a', async () => undefined))
        .rejects.toThrow('Network capture disabled: Network Extension not approved');
      expect(startNetworkCapture).toHaveBeenCalledTimes(1);

      arm();
      await expect(device.route('**/a', async () => undefined)).resolves.toBeUndefined();
      expect(startNetworkCapture).toHaveBeenCalledTimes(2);
    });

    it('does not register a route whose test ended while the on-demand start ran', async () => {
      const stream = new FakeRouteStream();
      const token = { closed: false };
      const client = makeMockClient({
        startNetworkCapture: vi.fn(async () => {
          token.closed = true; // the test timed out meanwhile
          return { requestId: '1', proxyPort: 1, success: true, errorMessage: '' };
        }),
        networkRouteStream: vi.fn(() => stream as unknown as ReturnType<TapsmithGrpcClient['networkRouteStream']>),
      });
      const device = new Device(client);
      device._setOnDemandNetworkCapture(async () => { await device._startNetworkCapture(); });

      const err = await runInAttemptContext(token, () => device.route('**/a', async () => undefined).then(() => undefined, (e: unknown) => e));

      expect(isTestEndedError(err)).toBe(true);
      expect(stream.writes.filter((m) => typeof m === 'object' && m !== null && 'registerRoute' in m)).toEqual([]);
      expect(device._takeRouteRegistrations()).toBe(0);
    });

    it('starts capture on demand for device.on() too', async () => {
      const { device, startNetworkCapture, arm } = makeOnDemand([]);
      arm();
      device.on('request', () => {});
      await vi.waitFor(() => expect(device._networkProxyRunning).toBe(true));
      expect(startNetworkCapture).toHaveBeenCalledTimes(1);
    });

    it("does not retry on demand a trace's own start that failed in the same arm", async () => {
      const { device, startNetworkCapture, arm } = makeOnDemand([
        { success: false, errorMessage: 'proxy unavailable' },
      ]);
      arm();
      await device._startNetworkCapture();
      await expect(device.route('**/a', async () => undefined))
        .rejects.toThrow('Network capture disabled: proxy unavailable');
      expect(startNetworkCapture).toHaveBeenCalledTimes(1);
    });

    it('starts nothing when the runner has not armed it, or cleared it', async () => {
      const { device, startNetworkCapture, arm } = makeOnDemand([]);
      await device.route('**/a', async () => undefined);
      arm();
      device._setOnDemandNetworkCapture(null);
      await device.route('**/b', async () => undefined);

      expect(startNetworkCapture).not.toHaveBeenCalled();
      expect(device._networkProxyRunning).toBe(false);
    });
  });

  it('counts successful registrations for the runner and resets when taken (PILOT-517)', async () => {
    const stream = new FakeRouteStream();
    const client = makeMockClient({
      networkRouteStream: vi.fn(
        () => stream as unknown as ReturnType<TapsmithGrpcClient['networkRouteStream']>,
      ),
    });
    const device = new Device(client);

    await device.route('**/a', async () => undefined);
    await device.route('**/b', async () => undefined);

    expect(device._takeRouteRegistrations()).toBe(2);
    expect(device._takeRouteRegistrations()).toBe(0);
  });

  it('does not count a registration that failed', async () => {
    const client = makeMockClient({
      startNetworkCapture: vi.fn(async () => ({
        requestId: '1',
        success: false,
        proxyPort: 0,
        errorMessage: 'proxy unavailable',
      })),
    });
    const device = new Device(client);
    await device._startNetworkCapture();

    await expect(device.route('**/posts*', async () => undefined)).rejects.toThrow();
    expect(device._takeRouteRegistrations()).toBe(0);
  });

  it('passes keepRunning through when stopping network capture', async () => {
    const stopNetworkCapture = vi.fn(async () => ({
      requestId: '1',
      success: true,
      entries: [],
      errorMessage: '',
    }));
    const client = makeMockClient({ stopNetworkCapture });
    const device = new Device(client);

    await device._stopNetworkCapture({ keepRunning: true });

    expect(stopNetworkCapture).toHaveBeenCalledWith({ keepRunning: true });
  });
});

// ─── terminateApp() ───

describe('Device.terminateApp()', () => {
  it('delegates to client.terminateApp', async () => {
    const terminateApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ terminateApp });
    const device = new Device(client);
    await device.terminateApp('com.example.app');
    expect(terminateApp).toHaveBeenCalledWith('com.example.app');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      terminateApp: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.terminateApp('com.example.app')).rejects.toThrow('Terminate app failed');
  });
});

// ─── getAppState() ───

describe('Device.getAppState()', () => {
  it('returns the app state', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const state = await device.getAppState('com.example.app');
    expect(state).toBe('foreground');
  });
});

// ─── sendToBackground() / bringToForeground() ───

describe('Device.sendToBackground()', () => {
  it('presses HOME key', async () => {
    const pressKey = vi.fn(async () => successResponse());
    const client = makeMockClient({ pressKey });
    const device = new Device(client);
    await device.sendToBackground();
    expect(pressKey).toHaveBeenCalledWith('HOME');
  });
});

describe('Device.bringToForeground()', () => {
  it('launches the app', async () => {
    const launchApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ launchApp });
    const device = new Device(client);
    await device.bringToForeground('com.example.app');
    expect(launchApp).toHaveBeenCalledWith('com.example.app', undefined);
  });
});

// ─── clearAppData() ───

describe('Device.clearAppData()', () => {
  it('delegates to client.clearAppData', async () => {
    const clearAppData = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearAppData });
    const device = new Device(client);
    await device.clearAppData('com.example.app');
    expect(clearAppData).toHaveBeenCalledWith('com.example.app');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearAppData: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.clearAppData('com.example.app')).rejects.toThrow('Clear app data failed');
  });
});

// ─── restartApp() ───

describe('Device.restartApp()', () => {
  it('delegates to client.restartApp with waitForIdle true by default', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client);
    await device.restartApp('com.example.app');
    expect(restartApp).toHaveBeenCalledWith('com.example.app', true);
  });

  it('passes waitForIdle false when specified', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client);
    await device.restartApp('com.example.app', { waitForIdle: false });
    expect(restartApp).toHaveBeenCalledWith('com.example.app', false);
  });

  it('uses config.package when packageName is omitted', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client, { package: 'com.example.configured' });
    await device.restartApp();
    expect(restartApp).toHaveBeenCalledWith('com.example.configured', true);
  });

  it('accepts options as the first argument when using config.package', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client, { package: 'com.example.configured' });
    await device.restartApp({ waitForIdle: false });
    expect(restartApp).toHaveBeenCalledWith('com.example.configured', false);
  });

  it('throws a helpful error when no package is available', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    await expect(device.restartApp()).rejects.toThrow(
      'Package name is required. Pass one explicitly or set `package` in your Tapsmith config.',
    );
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      restartApp: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.restartApp('com.example.app')).rejects.toThrow('Restart app failed');
  });
});

// ─── Permission management ───

describe('Device.grantPermission()', () => {
  it('delegates to client.grantPermission', async () => {
    const grantPermission = vi.fn(async () => successResponse());
    const client = makeMockClient({ grantPermission });
    const device = new Device(client);
    await device.grantPermission('com.example.app', 'android.permission.CAMERA');
    expect(grantPermission).toHaveBeenCalledWith('com.example.app', 'android.permission.CAMERA');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      grantPermission: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.grantPermission('com.example.app', 'android.permission.CAMERA')).rejects.toThrow('Grant permission failed');
  });
});

describe('Device.revokePermission()', () => {
  it('delegates to client.revokePermission', async () => {
    const revokePermission = vi.fn(async () => successResponse());
    const client = makeMockClient({ revokePermission });
    const device = new Device(client);
    await device.revokePermission('com.example.app', 'android.permission.CAMERA');
    expect(revokePermission).toHaveBeenCalledWith('com.example.app', 'android.permission.CAMERA');
  });
});

// ─── Clipboard ───

describe('Device.setClipboard()', () => {
  it('delegates to client.setClipboard', async () => {
    const setClipboard = vi.fn(async () => successResponse());
    const client = makeMockClient({ setClipboard });
    const device = new Device(client);
    await device.setClipboard('Hello, world!');
    expect(setClipboard).toHaveBeenCalledWith('Hello, world!');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      setClipboard: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.setClipboard('x')).rejects.toThrow('Set clipboard failed');
  });
});

describe('Device.getClipboard()', () => {
  it('returns clipboard text', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const text = await device.getClipboard();
    expect(text).toBe('clipboard text');
  });
});

// ─── Orientation ───

describe('Device.setOrientation()', () => {
  it('delegates to client.setOrientation', async () => {
    const setOrientation = vi.fn(async () => successResponse());
    const client = makeMockClient({ setOrientation });
    const device = new Device(client);
    await device.setOrientation('landscape');
    expect(setOrientation).toHaveBeenCalledWith('landscape');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      setOrientation: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.setOrientation('landscape')).rejects.toThrow('Set orientation failed');
  });
});

describe('Device.getOrientation()', () => {
  it('returns the orientation', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const orientation = await device.getOrientation();
    expect(orientation).toBe('portrait');
  });
});

// ─── Keyboard ───

describe('Device.isKeyboardShown()', () => {
  it('returns keyboard visibility', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const shown = await device.isKeyboardShown();
    expect(shown).toBe(false);
  });

  it('returns true when keyboard is shown', async () => {
    const client = makeMockClient({
      isKeyboardShown: vi.fn(async () => ({ requestId: '1', shown: true })),
    });
    const device = new Device(client);
    const shown = await device.isKeyboardShown();
    expect(shown).toBe(true);
  });
});

describe('Device.hideKeyboard()', () => {
  it('delegates to client.hideKeyboard', async () => {
    const hideKeyboard = vi.fn(async () => successResponse());
    const client = makeMockClient({ hideKeyboard });
    const device = new Device(client);
    await device.hideKeyboard();
    expect(hideKeyboard).toHaveBeenCalled();
  });
});

// ─── Navigation convenience ───

describe('Device.pressHome()', () => {
  it('presses HOME key', async () => {
    const pressKey = vi.fn(async () => successResponse());
    const client = makeMockClient({ pressKey });
    const device = new Device(client);
    await device.pressHome();
    expect(pressKey).toHaveBeenCalledWith('HOME');
  });
});

describe('Device.openNotifications()', () => {
  it('delegates to client.openNotifications', async () => {
    const openNotifications = vi.fn(async () => successResponse());
    const client = makeMockClient({ openNotifications });
    const device = new Device(client);
    await device.openNotifications();
    expect(openNotifications).toHaveBeenCalled();
  });
});

describe('Device.openQuickSettings()', () => {
  it('delegates to client.openQuickSettings', async () => {
    const openQuickSettings = vi.fn(async () => successResponse());
    const client = makeMockClient({ openQuickSettings });
    const device = new Device(client);
    await device.openQuickSettings();
    expect(openQuickSettings).toHaveBeenCalled();
  });
});

describe('Device.pressRecentApps()', () => {
  it('presses APP_SWITCH key', async () => {
    const pressKey = vi.fn(async () => successResponse());
    const client = makeMockClient({ pressKey });
    const device = new Device(client);
    await device.pressRecentApps();
    expect(pressKey).toHaveBeenCalledWith('APP_SWITCH');
  });
});

// ─── Color scheme ───

describe('Device.setColorScheme()', () => {
  it('delegates to client.setColorScheme', async () => {
    const setColorScheme = vi.fn(async () => successResponse());
    const client = makeMockClient({ setColorScheme });
    const device = new Device(client);
    await device.setColorScheme('dark');
    expect(setColorScheme).toHaveBeenCalledWith('dark');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      setColorScheme: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.setColorScheme('dark')).rejects.toThrow('Set color scheme failed');
  });
});

describe('Device.getColorScheme()', () => {
  it('returns the color scheme', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const scheme = await device.getColorScheme();
    expect(scheme).toBe('light');
  });
});

// ─── wake() / unlock() ───

describe('Device.wake()', () => {
  it('delegates to client.wakeDevice', async () => {
    const wakeDevice = vi.fn(async () => successResponse());
    const client = makeMockClient({ wakeDevice });
    const device = new Device(client);
    await device.wake();
    expect(wakeDevice).toHaveBeenCalled();
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      wakeDevice: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.wake()).rejects.toThrow('Wake device failed');
  });
});

describe('Device.unlock()', () => {
  it('delegates to client.unlockDevice', async () => {
    const unlockDevice = vi.fn(async () => successResponse());
    const client = makeMockClient({ unlockDevice });
    const device = new Device(client);
    await device.unlock();
    expect(unlockDevice).toHaveBeenCalled();
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      unlockDevice: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.unlock()).rejects.toThrow('Unlock device failed');
  });
});

// ─── startAgent() with APK paths ───

describe('Device.startAgent()', () => {
  it('delegates to client.startAgent with package name', async () => {
    const startAgent = vi.fn(async () => successResponse());
    const client = makeMockClient({ startAgent });
    const device = new Device(client);
    await device.startAgent('com.example.app');
    expect(startAgent).toHaveBeenCalledWith('com.example.app', undefined, undefined, undefined, undefined, false);
  });

  it('passes APK paths through', async () => {
    const startAgent = vi.fn(async () => successResponse());
    const client = makeMockClient({ startAgent });
    const device = new Device(client);
    await device.startAgent('com.example.app', '/path/agent.apk', '/path/test.apk');
    expect(startAgent).toHaveBeenCalledWith('com.example.app', '/path/agent.apk', '/path/test.apk', undefined, undefined, false);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      startAgent: vi.fn(async () => failureResponse('Agent not installed')),
    });
    const device = new Device(client);
    await expect(device.startAgent('com.example.app')).rejects.toThrow('Agent not installed');
  });
});

// ─── saveAppState() ───

describe('Device.saveAppState()', () => {
  it('delegates to client.saveAppState with package name and path', async () => {
    const saveAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ saveAppState });
    const device = new Device(client);
    await device.saveAppState('com.example.app', './auth-state.tar.gz');
    expect(saveAppState).toHaveBeenCalledWith('com.example.app', './auth-state.tar.gz');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      saveAppState: vi.fn(async () => failureResponse('Permission denied')),
    });
    const device = new Device(client);
    await expect(device.saveAppState('com.example.app', './state.tar.gz')).rejects.toThrow('Permission denied');
  });

  it('uses default package name from config', async () => {
    const saveAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ saveAppState });
    const device = new Device(client, { package: 'com.default.app' });
    await device.saveAppState(undefined as unknown as string, './state.tar.gz');
    expect(saveAppState).toHaveBeenCalledWith('com.default.app', './state.tar.gz');
  });
});

// ─── restoreAppState() ───

describe('Device.restoreAppState()', () => {
  it('delegates to client.restoreAppState with package name and path', async () => {
    const restoreAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ restoreAppState });
    const device = new Device(client);
    await device.restoreAppState('com.example.app', './auth-state.tar.gz');
    expect(restoreAppState).toHaveBeenCalledWith('com.example.app', './auth-state.tar.gz');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      restoreAppState: vi.fn(async () => failureResponse('Archive not found')),
    });
    const device = new Device(client);
    await expect(device.restoreAppState('com.example.app', './state.tar.gz')).rejects.toThrow('Archive not found');
  });

  it('uses default package name from config', async () => {
    const restoreAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ restoreAppState });
    const device = new Device(client, { package: 'com.default.app' });
    await device.restoreAppState(undefined as unknown as string, './state.tar.gz');
    expect(restoreAppState).toHaveBeenCalledWith('com.default.app', './state.tar.gz');
  });
});

// ─── Action progress emission (PILOT-232) ───

describe('Device action progress events', () => {
  function collectProgress() {
    const events: ActionProgressEvent[] = [];
    const unsubscribe = onActionProgress((ev) => events.push(ev));
    return { events, unsubscribe };
  }

  it('emits start/end around saveAppState with package and archive target', async () => {
    const { events, unsubscribe } = collectProgress();
    try {
      const device = new Device(makeMockClient());
      await device.saveAppState('com.example.app', './states/auth-state.tar.gz');
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'start', action: 'saveAppState', target: 'com.example.app → auth-state.tar.gz',
      });
      expect(events[1]).toMatchObject({ kind: 'end', action: 'saveAppState', success: true });
    } finally {
      unsubscribe();
    }
  });

  it('emits without an active trace collector', async () => {
    const { events, unsubscribe } = collectProgress();
    try {
      const restartApp = vi.fn(async () => successResponse());
      const device = new Device(makeMockClient({ restartApp }), { package: 'com.example.app' });
      await device.restartApp();
      expect(events.map((e) => `${e.kind}:${e.action}`)).toEqual(['start:restartApp', 'end:restartApp']);
      expect(events[0].target).toBe('com.example.app');
    } finally {
      unsubscribe();
    }
  });

  it('emits a failed end event when the RPC reports failure', async () => {
    const { events, unsubscribe } = collectProgress();
    try {
      const client = makeMockClient({
        restoreAppState: vi.fn(async () => failureResponse('Archive not found')),
      });
      const device = new Device(client);
      await expect(device.restoreAppState('com.example.app', './state.tar.gz')).rejects.toThrow('Archive not found');
      expect(events[1]).toMatchObject({
        kind: 'end', action: 'restoreAppState', success: false, error: 'Archive not found',
      });
    } finally {
      unsubscribe();
    }
  });

  it('emits around startAgent', async () => {
    const { events, unsubscribe } = collectProgress();
    try {
      const device = new Device(makeMockClient());
      await device.startAgent('com.example.app');
      expect(events.map((e) => `${e.kind}:${e.action}`)).toEqual(['start:startAgent', 'end:startAgent']);
    } finally {
      unsubscribe();
    }
  });

  it('emits around clearAppData, launchApp, and terminateApp', async () => {
    const { events, unsubscribe } = collectProgress();
    try {
      const device = new Device(makeMockClient());
      await device.clearAppData('com.example.app');
      await device.launchApp('com.example.app');
      await device.terminateApp('com.example.app');
      expect(events.filter((e) => e.kind === 'start').map((e) => e.action))
        .toEqual(['clearAppData', 'launchApp', 'terminateApp']);
    } finally {
      unsubscribe();
    }
  });
});

// ─── resetApp ───

describe('Device.resetApp()', () => {
  it('sends the configured appResetColdEvery (0 = off) with mid-test resets', async () => {
    const resetApp = vi.fn(async () => ({
      requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0),
      modeRequested: 'APP_RESET_MODE_WARM', modeUsed: 'APP_RESET_MODE_WARM', fellBack: false, coldLaunch: false,
      reason: '', durationMs: 10, hooksDetected: true, epochBefore: 1, epochAfter: 2, steps: [],
    }));
    const client = makeMockClient({ resetApp } as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app', appResetColdEvery: 0 });

    await device.resetApp();

    expect(resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ coldEveryNResets: 0 }));
  });

  it('a scope override applied by the runner changes what mid-test resets send', async () => {
    const resetApp = vi.fn(async () => ({
      requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0),
      modeRequested: 'APP_RESET_MODE_WARM', modeUsed: 'APP_RESET_MODE_WARM', fellBack: false, coldLaunch: false,
      reason: '', durationMs: 10, hooksDetected: true, epochBefore: 1, epochAfter: 2, steps: [],
    }));
    const client = makeMockClient({ resetApp } as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app', appResetColdEvery: 10 });

    device._setAppResetColdEvery(0);
    await device.resetApp();
    expect(resetApp).toHaveBeenLastCalledWith('com.example.app', expect.objectContaining({ coldEveryNResets: 0 }));

    device._setAppResetColdEvery(10);
    await device.resetApp();
    expect(resetApp).toHaveBeenLastCalledWith('com.example.app', expect.objectContaining({ coldEveryNResets: 10 }));
  });

  it('runs the daemon ladder and maps the structured outcome', async () => {
    const resetApp = vi.fn(async () => ({
      requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0),
      modeRequested: 'APP_RESET_MODE_WARM', modeUsed: 'APP_RESET_MODE_RESTART', fellBack: true, coldLaunch: true,
      reason: 'warm reset via in-app hooks failed (epoch did not advance within 3000ms)',
      durationMs: 1234, hooksDetected: true, epochBefore: 3, epochAfter: 0,
      steps: [
        { name: 'warm-hooks', durationMs: 3000, ok: false, detail: 'epoch did not advance within 3000ms' },
        { name: 'restart', durationMs: 900, ok: true, detail: '' },
      ],
    }));
    const client = makeMockClient({ resetApp } as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app' });

    const result = await device.resetApp({ target: '/login' });

    expect(resetApp).toHaveBeenCalledWith('com.example.app', {
      mode: 'warm', allowFallback: true, resetDeepLink: undefined, forceCold: false,
      // Honours the configured warm-window bound (default 10) like the
      // runner's own resets — never "unbounded" for lack of an option.
      coldEveryNResets: 10, waitForIdle: undefined, targetPath: '/login',
    });
    expect(result).toEqual({
      modeRequested: 'warm', modeUsed: 'restart', fellBack: true, coldLaunch: true,
      reason: 'warm reset via in-app hooks failed (epoch did not advance within 3000ms)',
      durationMs: 1234, hooksDetected: true, epochBefore: 3, epochAfter: 0,
      steps: [
        { name: 'warm-hooks', durationMs: 3000, ok: false, detail: 'epoch did not advance within 3000ms' },
        { name: 'restart', durationMs: 900, ok: true },
      ],
    });
  });

  it('throws with the daemon error when the ladder is exhausted', async () => {
    const resetApp = vi.fn(async () => ({
      requestId: '1', success: false, errorType: 'RESET_FAILED', errorMessage: 'clear failed (pm clear did not report success)',
      screenshot: Buffer.alloc(0), modeRequested: 'APP_RESET_MODE_CLEAR', modeUsed: 'APP_RESET_MODE_CLEAR',
      fellBack: false, coldLaunch: false, reason: '', durationMs: 10, hooksDetected: false, epochBefore: 0, epochAfter: 0, steps: [],
    }));
    const client = makeMockClient({ resetApp } as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app' });

    await expect(device.resetApp({ mode: 'clear', fallback: false })).rejects.toThrow('clear failed');
  });

  it('retry attempts force a cold delivery', async () => {
    const resetApp = vi.fn(async () => ({
      requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0),
      modeRequested: 'APP_RESET_MODE_WARM', modeUsed: 'APP_RESET_MODE_WARM', fellBack: false, coldLaunch: true,
      reason: 'cold relaunch: retry attempt', durationMs: 5000, hooksDetected: false, epochBefore: 0, epochAfter: 0, steps: [],
    }));
    const client = makeMockClient({ resetApp } as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app' });
    device._setForceColdDeepLinks(true);

    await device.resetApp();

    expect(resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ forceCold: true }));
  });
});

describe('Device.close() network capture teardown', () => {
  function fakeStream() {
    return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  }

  it('releases the proxy for real (keepRunning:false) when capture was started', async () => {
    const stopNetworkCapture = vi.fn(async () => ({
      requestId: '1', success: true, entries: [], errorMessage: '',
    }));
    const client = makeMockClient({
      stopNetworkCapture,
      networkRouteStream: vi.fn(() => fakeStream()),
      close: vi.fn(),
    } as unknown as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app' });

    // The runner keeps the proxy alive across files (keepRunning:true); the
    // session ending is where it is torn down for good.
    await device._startNetworkCapture();
    await device._stopNetworkCapture({ keepRunning: true });
    stopNetworkCapture.mockClear();

    await device.close();

    expect(stopNetworkCapture).toHaveBeenCalledTimes(1);
    expect(stopNetworkCapture).toHaveBeenCalledWith({ keepRunning: false });
  });

  it('does not stop capture on close when it was never started', async () => {
    const stopNetworkCapture = vi.fn(async () => ({
      requestId: '1', success: true, entries: [], errorMessage: '',
    }));
    const client = makeMockClient({
      stopNetworkCapture,
      close: vi.fn(),
    } as unknown as Partial<TapsmithGrpcClient>);
    const device = new Device(client, { package: 'com.example.app' });

    await device.close();

    expect(stopNetworkCapture).not.toHaveBeenCalled();
  });
});
