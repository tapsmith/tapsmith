/**
 * `test.use({ trace: NETWORK_TRACE })` for a describe whose tests talk to the
 * network (real requests, route(), waitForRequest/Response).
 *
 * CI traces only retried attempts (`on-all-retries`). Without a trace, the
 * network proxy starts on demand at a test's first route() or network wait
 * (PILOT-775), after the app may already hold a keep-alive connection, opened
 * straight to the server by an earlier test, that bypasses it: a route
 * registered then never fires. A trace that records network starts the proxy
 * before each test, so the app's requests all go through it.
 *
 * Remove once the runner starts the proxy at session start for runs that use
 * the network APIs (PILOT-1013).
 */
export const NETWORK_TRACE = {
  mode: "retain-on-failure",
  network: true,
  daemonLogs: true,
} as const
