/**
 * The SDK Device behind a device tool's client (PILOT-848).
 *
 * MCP tools resolve and act on locators through the same Device /
 * ElementHandle / WebViewHandle code a test uses, so strict mode, positions,
 * filters, scoping and WebView locators behave as they do in a spec. One
 * Device per client and device; a WebView is connected for one tool call
 * and closed after it (withEvaluatedLocator).
 */

import { Device } from '../device.js';
import type { Platform } from '../config.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { WebViewHandle } from '../webview-handle.js';
import { evaluateLocator, type EvaluatedLocator } from './locator-eval.js';

/** How long an MCP action or WebView query waits for its target, as before (resolveActionTarget). */
export const MCP_ACTION_TIMEOUT_MS = 5_000;

/**
 * How long connecting to a WebView may take: a cold connect (an iOS
 * inspector handshake, Android discovery and port forwarding) can outlast
 * the action budget on its own.
 */
const WEBVIEW_CONNECT_TIMEOUT_MS = 15_000;

const devices = new WeakMap<TapsmithGrpcClient, Map<string, Device>>();
/** The simulator a Device's iOS WebView inspector is reached through. */
const simulators = new WeakMap<Device, string>();

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
  const known = info?.platform ?? (platforms.size === 1 ? [...platforms][0] : undefined);
  const platform: Platform = known === 'ios' ? 'ios' : 'android';
  const device = new Device(client, { platform, timeout: MCP_ACTION_TIMEOUT_MS });
  if (platform === 'ios' && info) simulators.set(device, info.serial);
  // An unknown platform is a guess: ask again next time rather than keep it
  // (the device may not be listed yet).
  if (known === undefined) return device;
  if (!perClient) devices.set(client, (perClient = new Map()));
  perClient.set(key, device);
  return device;
}

/**
 * Build `source` on the SDK's locator builder for `device` and hand the
 * result to `use`. A `webview.…` locator is connected, for this call only,
 * to the WebView of the app the daemon reports as current (on iOS, the
 * session's app) and closed afterwards: a WebView session left open by the
 * MCP server would wedge a test connecting to the same page (PILOT-288),
 * and could outlive the app or screen it was opened on.
 */
export async function withEvaluatedLocator<T>(
  device: Device,
  client: TapsmithGrpcClient,
  source: string,
  use: (evaluated: EvaluatedLocator) => Promise<T>,
): Promise<T> {
  let webviewDevice: Device | undefined;
  const webview = async (): Promise<WebViewHandle> => {
    const { packageName } = await client.getCurrentPackage();
    // Without the current package an Android WebView could be any app's
    // (Chrome, another debug app). iOS finds the app's page itself.
    if (!packageName && device.platform === 'android') {
      throw new Error('Could not tell which app is in the foreground, so its WebView could not be found. Try again once the app is showing.');
    }
    webviewDevice = new Device(client, { platform: device.platform, simulator: simulators.get(device), timeout: WEBVIEW_CONNECT_TIMEOUT_MS });
    const handle = await webviewDevice.webview(packageName || undefined);
    // The connect had its own budget; waits on the page get the action one.
    handle._setTimeoutMs(MCP_ACTION_TIMEOUT_MS);
    return handle;
  };
  try {
    return await use(await evaluateLocator(source, { device, webview }));
  } finally {
    await webviewDevice?._disposeWebViewManager().catch(() => {});
  }
}
