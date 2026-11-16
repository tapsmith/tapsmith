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
 * wsServer.ts), every request must name a loopback Host. A browser Origin
 * must be stricter than Playwright's "any loopback port": it must be the very
 * host the request is addressed to — the page this server served — because a
 * page on another local port (a dev server, any local tool) can still post a
 * CORS "simple" request with no preflight, and none of these servers has a
 * cross-origin browser client.
 *
 * A request with no Origin header is allowed: it is a local process such as
 * `tapsmith mcp-server` or an MCP client — or a browser's no-cors GET/HEAD
 * (an `<img>`, `<script>` or navigation), which is the one kind of browser
 * request that carries no Origin. Browsers always send Origin on WebSocket
 * handshakes and on every other cross-origin request. So a page can still
 * trigger a guarded GET, though it cannot read the response: GET routes on
 * these servers must not change anything.
 */

import * as http from 'node:http';
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
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // `null` (file://, sandboxed iframes) and garbage
  }
  return url.protocol === 'http:' && url.host.toLowerCase() === host;
}

/**
 * True when a request comes from this machine and not from another web page:
 * it names a loopback Host (no DNS rebinding) and its Origin, if any, is the
 * page this server served.
 */
function isLocalRequest(req: http.IncomingMessage): boolean {
  return isLoopbackHost(req.headers.host) && isSameOriginRequest(req);
}

function refusalReason(req: http.IncomingMessage): string {
  return isLoopbackHost(req.headers.host)
    ? `Forbidden: Tapsmith does not accept requests from pages on "${req.headers.origin ?? ''}".\n`
    : `Forbidden: Tapsmith only answers requests addressed to 127.0.0.1 or localhost, not "${req.headers.host ?? ''}".\n`;
}

/**
 * An HTTP server that answers 403 to any request that is not local (see
 * {@link isLocalRequest}) before `handler` sees it. Every HTTP server Tapsmith
 * opens is created here (a unit test enforces it).
 */
export function createLocalHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): http.Server {
  return http.createServer((req, res) => {
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(refusalReason(req));
      return;
    }
    void handler(req, res);
  });
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
      if (isLocalRequest(req)) {
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
