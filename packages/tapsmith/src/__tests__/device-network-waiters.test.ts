import { describe, it, expect, vi, afterEach } from 'vitest';
import { Device, pendingWaiterMark } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { NetworkRouteManager, NetworkResponseEventData, TapsmithRequest } from '../network.js';
import { isTestEndedError, runInAttemptContext } from '../attempt-fence.js';

// PILOT-543: waitForRequest/waitForResponse are tied to the test that creates
// them, so one a failed test never awaited cannot time out later, unhandled,
// and take the whole run down.

type Listener<T> = (event: T) => void;

function makeDevice(opts: {
  /** A proxy already up from an earlier test (a trace or on-demand start). */
  proxyRunning?: boolean
  /** The daemon's answer to an on-demand start, when the runner armed one. */
  onDemand?: { success: boolean; errorMessage?: string }
} = { proxyRunning: true }): {
  device: Device
  emitRequest: (url: string) => void
  emitResponse: (url: string) => void
  listenerCount: () => number
} {
  const requestListeners = new Set<Listener<TapsmithRequest>>();
  const responseListeners = new Set<Listener<NetworkResponseEventData>>();
  const manager = {
    addRequestListener: (l: Listener<TapsmithRequest>) => requestListeners.add(l),
    removeRequestListener: (l: Listener<TapsmithRequest>) => requestListeners.delete(l),
    addResponseListener: (l: Listener<NetworkResponseEventData>) => responseListeners.add(l),
    removeResponseListener: (l: Listener<NetworkResponseEventData>) => responseListeners.delete(l),
    ensureEventsSubscribed: () => {},
  };
  const client = {
    startNetworkCapture: vi.fn(async () => ({
      success: opts.onDemand?.success ?? false,
      proxyPort: 1,
      errorMessage: opts.onDemand?.errorMessage ?? '',
    })),
  };
  const device = new Device(client as unknown as TapsmithGrpcClient, { timeout: 30_000 });
  device._routeManager = manager as unknown as NetworkRouteManager;
  if (opts.proxyRunning) {
    // As after a start in an earlier test: the proxy is up, this test's
    // capture is not.
    (device as unknown as { _networkCaptureEverStarted: boolean })._networkCaptureEverStarted = true;
  }
  if (opts.onDemand) {
    device._setOnDemandNetworkCapture(async () => { await device._startNetworkCapture(); });
  }
  return {
    device,
    emitRequest: (url) => { for (const l of [...requestListeners]) l({ url } as TapsmithRequest); },
    emitResponse: (url) => { for (const l of [...responseListeners]) l({ url, status: 200 } as NetworkResponseEventData); },
    listenerCount: () => requestListeners.size + responseListeners.size,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Device network waiters (PILOT-543)', () => {
  it('cancelling ends the waiter without an unhandled rejection, and stops listening', async () => {
    const { device, listenerCount } = makeDevice();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const mark = pendingWaiterMark();
      // Never awaited — the step after it failed.
      void device.waitForResponse('**/products?*');
      expect(listenerCount()).toBe(1);

      device._cancelPendingWaiters(mark);
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).not.toHaveBeenCalled();
      expect(listenerCount()).toBe(0);
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('a caller still awaiting a cancelled waiter learns the test ended', async () => {
    const { device } = makeDevice();
    const p = device.waitForRequest(/\/api\//);

    device._cancelPendingWaiters();

    const err = await p.catch((e: unknown) => e);
    expect(isTestEndedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/waitForRequest\(\) rejected/);
  });

  it('leaves waiters created before the mark alone (a beforeAll waiter outlives the test)', async () => {
    const { device, emitResponse } = makeDevice();
    const fromBeforeAll = device.waitForResponse('**/config');
    const mark = pendingWaiterMark();
    const fromTest = device.waitForResponse('**/config');

    device._cancelPendingWaiters(mark);
    emitResponse('https://example.com/config');

    await expect(fromBeforeAll).resolves.toMatchObject({ url: 'https://example.com/config' });
    expect(isTestEndedError(await fromTest.catch((e: unknown) => e))).toBe(true);
  });

  it('a waiter that already resolved is not touched by cancellation', async () => {
    const { device, emitRequest } = makeDevice();
    const p = device.waitForRequest('**/login');
    emitRequest('https://example.com/login');

    device._cancelPendingWaiters();

    await expect(p).resolves.toMatchObject({ url: 'https://example.com/login' });
  });

  it('points the timeout error at the waitFor call, not at a timer', async () => {
    vi.useFakeTimers();
    const { device, listenerCount } = makeDevice();
    const p = device.waitForResponse('**/products', { timeout: 500 });
    const settled = p.then(() => new Error('resolved'), (e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;

    expect(err.message).toBe('waitForResponse timed out after 500ms');
    expect(err.stack!.split('\n')[0]).toBe('Error: waitForResponse timed out after 500ms');
    expect(err.stack).toContain('device-network-waiters.test.ts');
    expect(listenerCount()).toBe(0);
  });
});

// PILOT-775: the runner starts capture on a test's first network wait, and a
// wait that could never see a request says why instead of only timing out.
describe('Device network waiters and on-demand capture (PILOT-775)', () => {
  it('says no capture was running when a wait times out with no proxy', async () => {
    vi.useFakeTimers();
    const { device } = makeDevice({ proxyRunning: false });
    const settled = device.waitForRequest('**/products', { timeout: 500 }).then(() => new Error('resolved'), (e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;

    expect(err.message).toMatch(/^waitForRequest timed out after 500ms\. No network capture was running on this device/);
    expect(err.message).toContain('https://tapsmith.dev/guides/network/#prerequisites');
  });

  it('starts capture on demand, and says the proxy only started with the wait when it times out', async () => {
    vi.useFakeTimers();
    const { device } = makeDevice({ proxyRunning: false, onDemand: { success: true } });
    const settled = device.waitForResponse('**/products', { timeout: 500 }).then(() => new Error('resolved'), (e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;

    expect(device._networkProxyRunning).toBe(true);
    expect(device._takeProxyStartedOnDemand()).toBe(true);
    expect(device._takeProxyStartedOnDemand()).toBe(false);
    expect(err.message).toMatch(/^waitForResponse timed out after 500ms\. The network proxy started on demand with this wait/);
  });

  it('resolves a wait whose request arrives after an on-demand start', async () => {
    const { device, emitRequest } = makeDevice({ proxyRunning: false, onDemand: { success: true } });
    const p = device.waitForRequest('**/login');
    await new Promise((r) => setTimeout(r, 0));
    emitRequest('https://example.com/login');
    await expect(p).resolves.toMatchObject({ url: 'https://example.com/login' });
  });

  it('rejects at once, with the reason, when the on-demand start fails', async () => {
    const { device, listenerCount } = makeDevice({
      proxyRunning: false,
      onDemand: { success: false, errorMessage: 'Network Extension not approved' },
    });
    const err = await device.waitForResponse('**/products').then(() => new Error('resolved'), (e: unknown) => e as Error);

    expect(err.message).toBe('waitForResponse() cannot see any request: Network capture disabled: Network Extension not approved');
    expect(listenerCount()).toBe(0);
  });

  it('refuses a waiter from a test attempt that has already ended', async () => {
    const { device, listenerCount } = makeDevice();
    const token = { closed: true };

    const err = await runInAttemptContext(token, () => device.waitForResponse('**/x').catch((e: unknown) => e));

    expect(isTestEndedError(err)).toBe(true);
    expect(listenerCount()).toBe(0);
  });
});
