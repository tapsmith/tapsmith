import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { attachMcpClientEventReporting, createMcpServer } from './index.js';
import type { McpEventEmitter, McpClientInfo } from './events.js';
import type { TestDispatcher } from './test-dispatcher.js';

const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
const DEFAULT_SESSION_GRACE_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const SOCKET_KEEPALIVE_DELAY_MS = 15_000;
// Cap request bodies so a misbehaving/malicious client can't OOM the process.
// MCP JSON-RPC payloads are tiny; 10 MB is generous headroom.
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export interface McpSessionRouterOptions {
  /** Server name reported to clients. */
  name?: string
  /** Shared event emitter — every session reports tool calls into this. */
  events: McpEventEmitter
  /** Shared dispatcher driving the one underlying device/test session. */
  dispatcher?: TestDispatcher
  /** Called whenever the set of connected clients changes. */
  onClientsChanged?: (clients: McpClientInfo[]) => void
  /** SSE keep-alive interval (ms). Set to 0 to disable. */
  keepAliveIntervalMs?: number
  /**
   * Grace period (ms) before reaping a session whose standby SSE stream closed
   * cleanly and was not resumed. Set to 0 to reap immediately on close.
   */
  sessionGraceMs?: number
  /**
   * Reap a session that has had no inbound request and no writable standby
   * stream for this long (ms). Backstop for clients that vanish without an
   * explicit DELETE or a clean stream close (e.g. Claude Code's /mcp reconnect,
   * which abandons the old session). Set to 0 to disable the idle sweep.
   */
  idleTimeoutMs?: number
  /** How often the idle/liveness sweep runs (ms). */
  sweepIntervalMs?: number
  /** Max accepted request body size in bytes (defaults to 10 MB). */
  maxRequestBodyBytes?: number
}

/** Thrown by readJsonBody when a request body exceeds the configured limit. */
class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

interface McpSession {
  transport: StreamableHTTPServerTransport
  server: ReturnType<typeof createMcpServer>
  /** Timestamp of the last inbound request on this session. */
  lastActivityAt: number
  /** The open standby GET SSE response, if the client currently holds one. */
  standbyRes?: http.ServerResponse
}

/**
 * Routes Streamable-HTTP MCP requests across multiple concurrent sessions.
 * A single transport instance is one MCP session in the SDK, so a
 * single shared transport can never accept a second `initialize` — breaking
 * reconnects and multi-client. This router follows the SDK's documented
 * multi-session pattern: a fresh transport + McpServer per `initialize`, keyed
 * by the `Mcp-Session-Id` header. Every per-session McpServer is built from the
 * same shared `dispatcher`/`events`, so multiple agents drive the one device
 * session and report into one activity feed.
 *
 * Liveness/cleanup uses multiple signals because no single one is reliable
 * (clients may not keep a standby stream, may not send DELETE, and may abandon
 * sessions half-open on reconnect): explicit DELETE → immediate; a clean
 * standby-stream close → reap after a short grace; a failed keep-alive write →
 * reap (dead standby); and an idle sweep as the final backstop.
 */
export class McpSessionRouter {
  private readonly sessions = new Map<string, McpSession>();
  private readonly clients = new Map<string, McpClientInfo>();
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly keepAliveIntervalMs: number;
  private readonly sessionGraceMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRequestBodyBytes: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: McpSessionRouterOptions) {
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.sessionGraceMs = options.sessionGraceMs ?? DEFAULT_SESSION_GRACE_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;

    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (this.idleTimeoutMs > 0 && sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Currently connected clients (one entry per live session that finished init). */
  get clientList(): McpClientInfo[] {
    return [...this.clients.values()];
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Live session count (includes sessions that haven't finished init yet). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Handle a request to the `/mcp` endpoint (POST / GET / DELETE). */
  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;

    // Read the JSON body once for POSTs. A malformed payload gets a JSON-RPC
    // Parse error (-32700) instead of bubbling up as a 500.
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req, this.maxRequestBodyBytes);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) this.respondPayloadTooLarge(res);
        else this.respondParseError(res);
        return;
      }
    }

    if (existing) {
      // Any traffic on a session means its owner is alive — refresh liveness.
      existing.lastActivityAt = Date.now();
      this.cancelReap(sessionId!);
      if (req.method === 'POST') {
        await existing.transport.handleRequest(req, res, body);
      } else {
        // GET opens the standby SSE stream; track it, keep it alive, and reap if
        // it closes (a reconnect re-opens it and refreshes liveness above).
        if (req.method === 'GET') this.registerStandbyStream(sessionId!, existing, res);
        await existing.transport.handleRequest(req, res);
      }
      return;
    }

    // No (or unknown) session id — only a fresh `initialize` POST may start one.
    if (req.method === 'POST' && !sessionId && isInitializeRequest(body)) {
      await this.createSession(req, res, body);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    }));
  }

  private respondParseError(res: http.ServerResponse): void {
    if (res.headersSent || res.writableEnded) return; // client likely gone
    try {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
        id: null,
      }));
    } catch { /* connection already gone */ }
  }

  private respondPayloadTooLarge(res: http.ServerResponse): void {
    if (res.headersSent || res.writableEnded) return; // client likely gone
    try {
      res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Payload Too Large: request body exceeds limit' },
        id: null,
      }));
    } catch { /* connection already gone */ }
  }

  /** Tear down every live session. */
  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.reapTimers.values()) clearTimeout(timer);
    this.reapTimers.clear();
    // Snapshot: transport.close() fires onclose → cleanupSession, which mutates
    // the map mid-iteration.
    for (const { transport, server, standbyRes } of [...this.sessions.values()]) {
      if (standbyRes && !standbyRes.writableEnded) {
        try { standbyRes.end(); } catch { /* already closed */ }
      }
      try { transport.close(); } catch { /* already closed */ }
      try { server.close(); } catch { /* already closed */ }
    }
    this.sessions.clear();
    this.clients.clear();
  }

  private async createSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const server = createMcpServer({
      name: this.options.name ?? 'tapsmith',
      events: this.options.events,
      dispatcher: this.options.dispatcher,
    });
    // Capture the session id at init time. Don't read transport.sessionId during
    // teardown — the SDK may clear it on close, which would skip cleanup and
    // leak the session (and leave a stale entry in the client list).
    let boundSessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        boundSessionId = sessionId;
        this.sessions.set(sessionId, { transport, server, lastActivityAt: Date.now() });
      },
      onsessionclosed: (sessionId) => { this.cleanupSession(sessionId); },
    });
    transport.onclose = () => { if (boundSessionId) this.cleanupSession(boundSessionId); };
    // Track this session's client identity (keyed by sessionId) so callers can
    // show every connected agent — a single shared emitter can't tell them apart.
    attachMcpClientEventReporting(server, this.options.events, undefined, (info) => {
      if (!boundSessionId) return;
      if (info) this.clients.set(boundSessionId, info);
      else this.clients.delete(boundSessionId);
      this.options.onClientsChanged?.(this.clientList);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      // Init failed — don't leave a registered-but-unusable session/server
      // behind. cleanupSession only closes the server if the session made it
      // into the map, so always server.close() too (idempotent if already done).
      try { transport.close(); } catch { /* already closed */ }
      if (boundSessionId) this.cleanupSession(boundSessionId);
      try { server.close(); } catch { /* already closed */ }
      throw err;
    }
  }

  private registerStandbyStream(sessionId: string, session: McpSession, res: http.ServerResponse): void {
    session.standbyRes = res;
    // OS-level keepalive helps detect a peer that vanished without a FIN, so the
    // socket eventually errors and fires 'close' instead of hanging half-open.
    res.socket?.setKeepAlive(true, SOCKET_KEEPALIVE_DELAY_MS);
    // Writing to a dropped peer surfaces EPIPE/ECONNRESET as an async 'error'
    // event; without a listener that crashes the whole process. Swallow it —
    // the following 'close' does the cleanup.
    res.on('error', () => {});
    this.attachKeepAlive(res);
    res.on('close', () => {
      // Only react if this is still the active standby. A reconnect registers
      // the new stream before the old one's 'close' fires, so reaping here
      // unconditionally would destroy a freshly-attached, live session.
      if (session.standbyRes !== res) return;
      session.standbyRes = undefined;
      this.scheduleReap(sessionId);
    });
  }

  private cleanupSession(sessionId: string): void {
    this.cancelReap(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.clients.delete(sessionId);
    try { session.server.close(); } catch { /* already closed */ }
    this.options.onClientsChanged?.(this.clientList);
  }

  /** Force a session closed now (its transport.onclose runs cleanupSession). */
  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try { session.transport.close(); } catch { /* already closed */ }
    // Belt and braces in case the transport didn't fire onclose.
    this.cleanupSession(sessionId);
  }

  /**
   * Reap a session whose standby SSE stream closed cleanly, after the grace
   * period (a resume re-opens the stream and cancels this).
   */
  private scheduleReap(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    if (this.sessionGraceMs <= 0) { this.reapSession(sessionId); return; }
    this.cancelReap(sessionId);
    const timer = setTimeout(() => {
      this.reapTimers.delete(sessionId);
      this.reapSession(sessionId);
    }, this.sessionGraceMs);
    timer.unref?.();
    this.reapTimers.set(sessionId, timer);
  }

  private cancelReap(sessionId: string): void {
    const timer = this.reapTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reapTimers.delete(sessionId);
    }
  }

  /**
   * Periodic backstop: reap sessions that are idle with no writable standby
   * stream. Catches clients that abandoned a session without DELETE or a clean
   * stream close (the standby socket is half-open / already destroyed).
   */
  private sweep(): void {
    const now = Date.now();
    // Snapshot: reapSession() deletes from the map mid-iteration.
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      const standbyDead = !!session.standbyRes && (session.standbyRes.writableEnded || session.standbyRes.destroyed);
      const hasLiveStandby = !!session.standbyRes && !standbyDead;
      if (hasLiveStandby) continue; // genuinely connected — leave it alone
      // Reap a detectably-dead standby always; reap on idle only when the idle
      // timeout is enabled (idleTimeoutMs <= 0 means "don't reap on idle").
      const idleExpired = this.idleTimeoutMs > 0 && now - session.lastActivityAt > this.idleTimeoutMs;
      if (standbyDead || idleExpired) {
        this.reapSession(sessionId);
      }
    }
  }

  private attachKeepAlive(res: http.ServerResponse): void {
    if (this.keepAliveIntervalMs <= 0) return;
    const interval = setInterval(() => {
      if (res.writableEnded || res.destroyed) { clearInterval(interval); return; }
      // SSE comment lines (`:` prefix) are ignored by EventSource parsers; Node
      // `res.write` calls are discrete, so a comment lands between the
      // transport's events and never splits one. A dead peer is reaped via the
      // standby stream's 'error'/'close' handlers, not here — but this runs in a
      // setInterval, so guard the write defensively: an unexpected synchronous
      // throw must not escape and crash the process.
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(interval);
      }
    }, this.keepAliveIntervalMs);
    const stop = (): void => clearInterval(interval);
    res.on('close', stop);
    res.on('finish', stop);
  }
}

/**
 * Buffer and JSON-parse a request body. The StreamableHTTP transport can read
 * the raw stream itself, but to route by session and detect `initialize` we
 * have to consume the body first, then hand the parsed value to handleRequest.
 */
function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Collect raw Buffer chunks and decode once at the end: this counts the
    // limit in actual bytes (not UTF-16 code units) and avoids corrupting a
    // multi-byte character split across a chunk boundary.
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        // Pause rather than destroy so the socket survives long enough for the
        // caller to send a 413 before the connection is closed.
        req.pause();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      settled = true;
      if (size === 0) { resolve(undefined); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
    });
    req.on('error', (err) => { settled = true; reject(err); });
    // If the request is aborted before 'end', 'close' fires without 'end' —
    // settle the promise instead of leaking it (and its listeners) forever.
    req.on('close', () => {
      if (!settled) reject(new Error('Request connection closed before body was received'));
    });
  });
}
