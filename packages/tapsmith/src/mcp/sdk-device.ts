/**
 * The SDK Device behind a device tool's client (PILOT-848).
 *
 * MCP tools resolve and act on locators through the same Device /
 * ElementHandle / WebViewHandle code a test uses, so strict mode, positions,
 * filters, scoping and WebView locators behave as they do in a spec. One
 * Device per client and device; a WebView connection is kept between tool
 * calls and closed when idle or when a test run starts (withEvaluatedLocator).
 */

import { Device } from '../device.js';
import type { Platform } from '../config.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { WebViewHandle } from '../webview-handle.js';
import { evaluateLocator, type EvaluatedLocator } from './locator-eval.js';

/** How long an MCP action or WebView query waits for its target, as before (resolveActionTarget). */
export const MCP_ACTION_TIMEOUT_MS = 5_000;

/**
 * How long a native action itself may take once its target is there — a
 * test's default budget: typing a long string on iOS, or any action on a
 * slow emulator, outlasts the 5 s wait.
 */
export const MCP_ACTION_RUN_TIMEOUT_MS = 30_000;

/**
 * How long connecting to a WebView may take: a cold connect (an iOS
 * inspector handshake, Android discovery and port forwarding) can outlast
 * the action budget on its own.
 */
const WEBVIEW_CONNECT_TIMEOUT_MS = 15_000;

/**
 * How long a WebView connection outlives the last tool call that used it.
 * Reconnecting costs ~10 s on iOS (the inspector lists no pages for a while
 * after a disconnect), so a burst of calls shares one connection; an idle
 * one is closed, as a test connecting to the same page alongside it would
 * wedge (PILOT-288).
 */
export const WEBVIEW_IDLE_CLOSE_MS = 15_000;
let idleCloseMs = WEBVIEW_IDLE_CLOSE_MS;

/** @internal — Tests shorten the idle close to watch it happen in real time. */
export function _setWebViewIdleCloseMs(ms: number): void {
  idleCloseMs = ms;
}

const devices = new WeakMap<TapsmithGrpcClient, Map<string, Device>>();
/** The simulator a Device's iOS WebView inspector is reached through. */
const simulators = new WeakMap<Device, string>();
/** The serial a tool Device was asked for, if any (one pooled client can serve several). */
const serials = new WeakMap<Device, string>();

/** The SDK Device for `client`'s device (`serial` when the tool resolved one). */
export async function sdkDeviceFor(client: TapsmithGrpcClient, serial: string | undefined): Promise<Device> {
  const key = serial ?? '';
  let perClient = devices.get(client);
  const cached = perClient?.get(key);
  if (cached) return cached;

  const { devices: listed } = await client.listDevices();
  // A serial names its device; without one, the only device listed is it.
  const info = serial ? listed.find((d) => d.serial === serial) : listed.length === 1 ? listed[0] : undefined;
  // Otherwise the device is unknown, but its platform is not when every
  // device the daemon sees shares one (two simulators, say).
  const platforms = new Set(listed.map((d) => d.platform));
  // An empty platform (a proto default) is as unknown as a missing one.
  const known = info?.platform || (platforms.size === 1 ? [...platforms][0] || undefined : undefined);
  const platform: Platform = known === 'ios' ? 'ios' : 'android';
  const device = new Device(client, { platform, timeout: MCP_ACTION_TIMEOUT_MS });
  if (serial) serials.set(device, serial);
  // On iOS the serial is the simulator's UDID, listed or not.
  const simulator = info?.serial ?? serial;
  if (platform === 'ios' && simulator) simulators.set(device, simulator);
  // A platform that is unknown, or taken from other devices than the one
  // asked for, is a guess: ask again next time rather than keep it (the
  // device may not be listed yet).
  if (known === undefined || (serial && !info)) return device;
  if (!perClient) devices.set(client, (perClient = new Map()));
  perClient.set(key, device);
  return device;
}

/** A WebView connection kept for a tool device between calls. */
interface OpenWebView {
  /** The Device that holds the connection (its own connect budget). */
  holder: Device
  packageName: string
  /** Tool calls using it now (at most one: calls are serialized); never idle-closed under one. */
  inUse: number
  idle?: ReturnType<typeof setTimeout>
}

/**
 * Test runs in progress. A run's own WebView connect would meet a second
 * session on the same page (PILOT-288), so held connections close when one
 * starts, and webview.* locators refuse until it ends.
 */
let activeTestRuns = 0;

/** A test run is starting: close the tools' WebViews and hold off new ones. */
export function beginTestRun(): void {
  activeTestRuns++;
  void closeMcpWebViews();
}

/** The run that `beginTestRun` marked has ended. */
export function endTestRun(): void {
  activeTestRuns = Math.max(0, activeTestRuns - 1);
}

/** The WebView call each (client, key) is waiting on, so calls run one at a time. */
const webViewLocks = new WeakMap<TapsmithGrpcClient, Map<string, Promise<void>>>();

/** Wait for the (client, key) WebView to be free; resolves with its release. */
async function lockWebView(client: TapsmithGrpcClient, key: string): Promise<() => void> {
  let locks = webViewLocks.get(client);
  if (!locks) webViewLocks.set(client, (locks = new Map()));
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  locks.set(key, tail);
  await previous;
  return () => {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  };
}

/**
 * Open connections by daemon client and target (platform and simulator): a
 * tool Device is rebuilt each call while its platform is undetermined, so
 * it cannot be the key.
 */
const openWebViews = new Map<TapsmithGrpcClient, Map<string, OpenWebView>>();

function webViewKey(device: Device): string {
  return `${device.platform}|${serials.get(device) ?? ''}|${simulators.get(device) ?? ''}`;
}

async function closeWebView(client: TapsmithGrpcClient, key: string): Promise<void> {
  const perClient = openWebViews.get(client);
  const open = perClient?.get(key);
  if (!perClient || !open) return;
  perClient.delete(key);
  if (perClient.size === 0) openWebViews.delete(client);
  clearTimeout(open.idle);
  await open.holder._disposeWebViewManager().catch(() => {});
}

function closeWhenIdle(client: TapsmithGrpcClient, key: string, open: OpenWebView): void {
  clearTimeout(open.idle);
  open.idle = setTimeout(() => {
    if (open.inUse === 0 && openWebViews.get(client)?.get(key) === open) void closeWebView(client, key);
  }, idleCloseMs);
  open.idle.unref?.();
}

/**
 * Close every WebView connection the MCP tools hold, before a test run
 * connects to the same page (PILOT-288).
 */
export async function closeMcpWebViews(): Promise<void> {
  await Promise.all([...openWebViews].flatMap(([client, perClient]) => [...perClient.keys()].map((key) => closeWebView(client, key))));
}

/**
 * Build `source` on the SDK's locator builder for `device` and hand the
 * result to `use`. A `webview.…` locator is connected to the WebView of the
 * app the daemon reports as current (on iOS, the session's app); the
 * connection is kept for the next call, and closed once idle, when another
 * app becomes current, or when a test run starts (closeMcpWebViews).
 */
export async function withEvaluatedLocator<T>(
  device: Device,
  client: TapsmithGrpcClient,
  source: string,
  use: (evaluated: EvaluatedLocator) => Promise<T>,
  options: {
    /**
     * A WebView connection the caller already holds to use instead of one
     * of these tools' own (UI mode's picker connection, which a second one
     * on the same page would wedge, PILOT-288).
     */
    webview?: () => Promise<WebViewHandle>
    /**
     * Runs before any WebView connection is used or made, and throws to
     * refuse it (UI mode's live tab: no WebView on screen, so not worth a
     * connect that can only time out).
     */
    beforeConnect?: () => void
  } = {},
): Promise<T> {
  const refuseConnect = (): void => {
    if (activeTestRuns > 0) {
      throw new Error('A test run is in progress: webview locators are unavailable until it finishes, since a second connection to its page can stall it.');
    }
    options.beforeConnect?.();
  };
  const held = options.webview;
  if (held) {
    // The caller's connection is shared with the page a run drives, too.
    return use(await evaluateLocator(source, { device, webview: async () => { refuseConnect(); return held(); } }));
  }
  const key = webViewKey(device);
  let used: OpenWebView | undefined;
  let release: (() => void) | undefined;
  const webview = async (): Promise<WebViewHandle> => {
    // One WebView call at a time per device, connect and action together:
    // two calls connecting at once would open two sessions on the page.
    release = await lockWebView(client, key);
    refuseConnect();
    // Read under the lock: a call queued behind one that switched apps acts
    // on the app that is current now.
    const { packageName } = await client.getCurrentPackage();
    // Without the current app a WebView could be any app's (Chrome, Safari,
    // another debug app): both platforms fall back to the first one found.
    if (!packageName) {
      throw new Error('Could not tell which app is current, so its WebView could not be found. Set the app in the config, or try again once it is showing.');
    }
    let open = openWebViews.get(client)?.get(key);
    if (open && open.packageName !== packageName) {
      // Another app is current: the old connection would act on its page.
      await closeWebView(client, key);
      open = undefined;
    }
    // A run may have started during the awaits above.
    refuseConnect();
    if (!open) {
      open = {
        holder: new Device(client, { platform: device.platform, simulator: simulators.get(device), timeout: WEBVIEW_CONNECT_TIMEOUT_MS }),
        packageName,
        inUse: 0,
      };
      let perClient = openWebViews.get(client);
      if (!perClient) openWebViews.set(client, (perClient = new Map()));
      perClient.set(key, open);
    }
    open.inUse++;
    used = open;
    clearTimeout(open.idle);
    // Reuses the live connection, or connects again if it died.
    const handle = await open.holder._webviewOfApp(packageName);
    // The connect had its own budget; waits on the page get the action one.
    handle._setTimeoutMs(MCP_ACTION_TIMEOUT_MS);
    return handle;
  };
  try {
    return await use(await evaluateLocator(source, { device, webview }));
  } finally {
    if (used) {
      used.inUse--;
      if (used.inUse === 0) closeWhenIdle(client, key, used);
    }
    release?.();
  }
}
