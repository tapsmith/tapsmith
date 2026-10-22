/**
 * The SDK Device behind a device tool's client (PILOT-848).
 *
 * MCP tools resolve and act on locators through the same Device /
 * ElementHandle / WebViewHandle code a test uses, so strict mode, positions,
 * filters, scoping and WebView locators behave as they do in a spec. One
 * Device per client: its WebView connection is reused across calls.
 */

import { Device } from '../device.js';
import type { Platform } from '../config.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { WebViewHandle } from '../webview-handle.js';
import type { LocatorRoots } from './locator-eval.js';

/** How long an MCP action or WebView query waits for its target, as before (resolveActionTarget). */
export const MCP_ACTION_TIMEOUT_MS = 5_000;

const devices = new WeakMap<TapsmithGrpcClient, Map<string, Device>>();

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
  const device = new Device(client, {
    platform,
    // The iOS WebView inspector is reached through the simulator.
    simulator: platform === 'ios' ? info?.serial : undefined,
    timeout: MCP_ACTION_TIMEOUT_MS,
  });
  // An unknown platform is a guess: ask again next time rather than keep it
  // (the device may not be listed yet).
  if (known === undefined) return device;
  if (!perClient) devices.set(client, (perClient = new Map()));
  perClient.set(key, device);
  return device;
}

/**
 * The roots a locator string is built on: `device`, and `webview` connected
 * to the app in the foreground (the one the agent is looking at) on first use.
 */
export function locatorRoots(device: Device, client: TapsmithGrpcClient): LocatorRoots {
  return {
    device,
    webview: async (): Promise<WebViewHandle> => {
      const { packageName } = await client.getCurrentPackage();
      // Without the foreground package an Android WebView could be any app's
      // (Chrome, another debug app). iOS finds the app's page itself.
      if (!packageName && device.platform === 'android') {
        throw new Error('Could not tell which app is in the foreground, so its WebView could not be found. Try again once the app is showing.');
      }
      return device.webview(packageName || undefined);
    },
  };
}
