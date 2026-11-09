import type { Device } from "tapsmith"

const never = () => false
const noop = () => {}

/**
 * Start the network proxy now, before the app opens any connection, so every
 * request it makes goes through it. Call it first in the beforeEach of a
 * describe that talks to the network (real requests, route(), network waits).
 *
 * When the attempt's trace doesn't record network (tracing off, or
 * `network: false` as in the iOS provisioning lane), the proxy otherwise
 * starts at the test's first route() or network wait (PILOT-775), and by then
 * the app may hold a keep-alive connection, opened straight to the server by
 * an earlier test, that bypasses it: a route registered then never fires.
 * route() waits for the on-demand start, and the proxy stays up once started,
 * so a route that matches nothing, removed at once, is enough.
 *
 * Remove once the runner starts the proxy at session start for runs that use
 * the network APIs (PILOT-1013).
 */
export async function startNetworkProxy(device: Device): Promise<void> {
  await device.route(never, noop)
  await device.unroute(never, noop)
}
