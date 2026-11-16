/**
 * Guards for the HTTP and WebSocket servers Tapsmith opens on loopback
 * (UI mode, its MCP endpoint, `tapsmith show-trace`) — PILOT-1215.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not other web pages:
 * any site open in the user's browser can open a WebSocket to
 * ws://127.0.0.1:<port> (WebSockets are not subject to CORS), and a
 * DNS-rebinding site can reach every route under its own hostname. So, as
 * Playwright does for its own local servers (`computeAllowedHosts` /
 * `isAllowedHost` in packages/utils/httpServer.ts, `_isAllowedOrigin` in
 * wsServer.ts), every request must name a loopback Host, and a browser
 * Origin must be loopback too. The UI's WebSocket goes one step further and
 * accepts only the UI's own page: Origin must be the very host it connects to.
 *
 * A request with no Origin header is not from a web page (browsers always
 * send Origin on WebSocket handshakes and on cross-origin requests), so it is
 * a local process such as `tapsmith mcp-server` or an MCP client, and is
 * allowed.
 */

import type * as http from 'node:http';
import { WebSocketServer } from 'ws';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The hostname part of a Host header (`[::1]:80` → `[::1]`, `a:80` → `a`). */
function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end < 0 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon < 0 ? host : host.slice(0, colon);
}

/** True when a Host header names this machine's loopback interface. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  const hostname = hostnameOf(lower);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  // Whatever follows the hostname must be a bare `:port`.
  const rest = lower.slice(hostname.length);
  return rest === '' || /^:\d{1,5}$/.test(rest);
}

function parseHttpOrigin(origin: string): URL | undefined {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a request's Origin is absent (not a web page) or is a page served
 * from this machine's loopback interface, on any port. Opaque origins
 * (`null`: file://, sandboxed iframes) and non-web schemes are refused.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const url = parseHttpOrigin(origin);
  return url !== undefined && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/**
 * True when a request's Origin is absent (not a web page) or is exactly the
 * origin the request is addressed to — i.e. the page this server served.
 * Comparing with the Host header, not a fixed port, keeps the check right
 * behind a port forward, where the page and the socket both use the
 * forwarded port.
 */
export function isSameOriginRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host?.toLowerCase();
  if (!host) return false;
  const url = parseHttpOrigin(origin);
  return url !== undefined && url.protocol === 'http:' && url.host.toLowerCase() === host;
}

/**
 * Answers 403 and returns true when an HTTP request does not name a loopback
 * Host (a DNS-rebinding page) or carries a browser Origin that is not
 * loopback. Call first in a request handler: `if (refuseForeignHost(req, res)) return;`.
 */
export function refuseForeignHost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const host = req.headers.host;
  if (!isLoopbackHost(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`Forbidden: Tapsmith only answers requests addressed to 127.0.0.1 or localhost, not "${host ?? ''}".\n`);
    return true;
  }
  const origin = req.headers.origin;
  if (!isLoopbackOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`Forbidden: Tapsmith does not accept requests from pages on "${origin ?? ''}".\n`);
    return true;
  }
  return false;
}

export interface LocalWebSocketServerOptions {
  /**
   * Called once per distinct refused Origin (or once for a refused Host with
   * no Origin), so the server can tell the user why a client was turned away.
   */
  onRefused?: (origin: string | undefined, host: string | undefined) => void
}

/**
 * A WebSocketServer on `server` that completes the handshake only for the
 * page `server` itself served (or a non-browser client) addressed to a
 * loopback Host. Anything else gets 403 Forbidden before the upgrade.
 */
export function createLocalWebSocketServer(
  server: http.Server,
  options: LocalWebSocketServerOptions = {},
): WebSocketServer {
  const reported = new Set<string>();
  return new WebSocketServer({
    server,
    verifyClient: ({ req }, done) => {
      if (isLoopbackHost(req.headers.host) && isSameOriginRequest(req)) {
        done(true);
        return;
      }
      const key = `${req.headers.origin ?? ''}\n${req.headers.origin === undefined ? (req.headers.host ?? '') : ''}`;
      if (options.onRefused && !reported.has(key) && reported.size < 50) {
        reported.add(key);
        options.onRefused(req.headers.origin, req.headers.host);
      }
      done(false, 403, 'Forbidden');
    },
  });
}
