/**
 * Warning for an iOS simulator app talking to a server on the Mac's loopback
 * interface. A simulator shares the Mac's network stack, so
 * `localhost` in the app is the Mac — and no capture route sees that
 * traffic: macOS never offers loopback connections to the Network Extension,
 * and the system-proxy fallback bypasses `localhost`. The daemon notices the
 * connections (`StopNetworkCaptureResponse.loopbackDestinations`); without
 * this the run just captured nothing for them, with routes that never fired.
 */

// ─── Message ───

/** Servers named before the list is summarised as "and N more". */
const MAX_NAMED = 5;

const DOCS_URL = 'https://tapsmith.dev/platform/ios-network-capture/#requests-to-localhost-are-not-captured';

function named(destinations: readonly string[]): string {
  const shown = destinations.slice(0, MAX_NAMED).join(', ');
  const more = destinations.length > MAX_NAMED ? ` and ${destinations.length - MAX_NAMED} more` : '';
  return `${shown}${more}`;
}

export function loopbackCaptureWarning(destinations: readonly string[]): string {
  return (
    `the app connected to a server on this Mac's loopback interface (${named(destinations)}), and an iOS ` +
    'simulator\'s network capture cannot see requests to localhost: macOS never routes loopback connections ' +
    'through Tapsmith\'s proxy. Those requests are missing from the trace, and device.route(), ' +
    'waitForRequest() and waitForResponse() cannot see them. To capture them, point the app at the Mac\'s LAN ' +
    'address instead of localhost or 127.0.0.1 (the output of `ipconfig getifaddr en0`), with the server ' +
    `listening on that interface. See ${DOCS_URL}`
  );
}

/** The reason a failed test's routes never fired, for `device.route() handlers never fired`. */
export function loopbackUnfiredRouteReason(destinations: readonly string[]): string {
  return (
    `the app connected to a server on this Mac's loopback interface (${named(destinations)}), and on an iOS ` +
    'simulator network capture and routes cannot see requests to localhost (point the app at the Mac\'s LAN address ' +
    `instead of localhost — see ${DOCS_URL})`
  );
}
