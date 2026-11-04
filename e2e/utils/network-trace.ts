/**
 * `test.use({ trace: NETWORK_TRACE })` for a describe whose tests talk to the
 * network (real requests, route(), waitForRequest/Response).
 *
 * CI traces only retried attempts (`on-all-retries`). Without a trace, the
 * network proxy starts on demand at a test's first route() or network wait —
 * after the app may already hold a keep-alive connection, opened directly to
 * the server by an earlier test, that bypasses the proxy, so the route never
 * fires. A trace that records network starts the proxy before each test, so
 * the app's first request of the shard already goes through it.
 *
 * Network only: no screenshots or hierarchy snapshots, the per-action cost CI
 * stopped paying. Remove once the proxy starts at session start for runs that
 * use the network APIs (PILOT-1013).
 */
export const NETWORK_TRACE = {
  mode: "retain-on-failure",
  screenshots: false,
  snapshots: false,
  network: true,
} as const
