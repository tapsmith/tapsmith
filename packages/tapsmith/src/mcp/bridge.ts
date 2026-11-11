/**
 * `tapsmith mcp-server --prefer-ui`: one stdio MCP server that works in the
 * project's running UI-mode session when there is one, and headless when
 * there is not. The Tapsmith plugin registers this, so an agent
 * with nothing but the plugin drives the session the user can see.
 *
 * It holds no test or device state of its own. Every request is passed to one
 * of two backends, chosen per request:
 *
 * - **the UI session**, over its Streamable-HTTP MCP endpoint, when
 *   `findUiSession` finds one for this project;
 * - **a headless server**, a child `tapsmith mcp-server` over stdio, started
 *   when first needed and shut down when a UI session takes over.
 *
 * The rules for moving between them:
 *
 * - A UI session that appears is used from the next request on, and the
 *   headless child is shut down (its daemon, agent and device claim with it).
 *   While a headless request is still running (a test run), requests keep
 *   going headless, so `stop_tests` and `suite_status` reach that run; the
 *   first request after it ends moves over.
 * - A UI session that has gone is noticed on the next request, which runs
 *   headless. One that goes while a request is running fails that request
 *   with a message saying so, since it may or may not have completed.
 * - `tapsmith test --ui` asks a session like this one to give its devices up
 *   before it picks its own (`requestHeadlessYield`); `yieldHeadless` does,
 *   unless a headless request is running.
 */

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type CallToolResult,
  type Implementation,
} from '@modelcontextprotocol/sdk/types.js';
import { tapsmithExecCommand } from '../config.js';
import { markSessionYieldsToUi } from '../device-claims.js';
import { readSdkVersion } from '../telemetry.js';
import { YIELD_SIGNAL, YIELD_WAIT_MS as YIELD_REQUEST_MS } from '../ui-yield.js';
import { BRIDGED_ENV } from './port-file.js';
import { findUiSession, probeUiSession, type ProjectRef, type UiSession } from './ui-session.js';

// ─── Types ───

/** Asks the server to work in the project's UI session when one is running. */
export const PREFER_UI_ENV = 'TAPSMITH_MCP_PREFER_UI';

type BackendKind = 'ui' | 'headless';

interface Backend {
  kind: BackendKind
  client: Client
  /** The UI session, for a `ui` backend. */
  session?: UiSession
  /** Ends every request still running on a `ui` backend whose session has gone. */
  lost: AbortController
}

export interface McpBridgeOptions {
  project: ProjectRef
  /** How the project runs its own Tapsmith (`npx tapsmith`), for the hints. */
  execCommand?: string
  /** Test seams; the defaults find the UI session over HTTP and spawn the headless child. */
  findUiSession?: () => Promise<UiSession | undefined>
  probeUiSession?: (session: UiSession) => Promise<'alive' | 'gone' | 'unanswered'>
  connectUi?: (session: UiSession, client: Implementation) => Promise<Client>
  startHeadless?: (client: Implementation) => Promise<Client>
  log?: (line: string) => void
  /** How long requests wait, after a yield, for the UI session that asked for it (ms). */
  yieldWaitMs?: number
  /** How long a yield refused while a headless request was running is still honoured once it ends (ms). */
  yieldRequestMs?: number
  /** How often discovery is asked again during that wait (ms). */
  yieldPollMs?: number
  /** How often a UI session with requests running in it is asked whether it is still there (ms). */
  uiLivenessMs?: number
}

/** A request's backend went away while it was running. */
class BackendLostError extends McpError {
  /** The message without the `MCP error <code>:` prefix an McpError adds. */
  readonly detail: string;
  constructor(detail: string) {
    super(ErrorCode.ConnectionClosed, detail);
    this.detail = detail;
  }
}

/**
 * No request timeout of the bridge's own: a test run takes as long as it
 * takes, and the agent's client applies its own limit to the request it sent.
 * (The largest delay a Node timer accepts.)
 */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * After a yield, how long requests wait for the UI session that asked for it
 * before running headless again. It has to cover the time from the signal to
 * that session claiming its device, which is seconds: from then on the claim
 * keeps a new headless session off the device, however long the rest of the
 * UI session's start takes.
 */
const YIELD_WAIT_MS = 30_000;
const YIELD_POLL_MS = 500;
/**
 * How often a UI session is asked whether it is still there while requests
 * are running in it. A response stream that breaks when the session exits
 * does not fail its request (the MCP client only reports a transport error),
 * so without this a call the session died under would never be answered.
 */
const UI_LIVENESS_MS = 5_000;

// ─── Failure classification ───

function errorCodes(err: unknown, depth = 0): string[] {
  if (typeof err !== 'object' || err === null || depth > 4) return [];
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  return [
    ...(typeof e.code === 'string' ? [e.code] : []),
    ...errorCodes(e.cause, depth + 1),
    ...(Array.isArray(e.errors) ? e.errors.flatMap((inner) => errorCodes(inner, depth + 1)) : []),
  ];
}

/**
 * Whether a failed UI request certainly never ran, so it can be sent again:
 * nothing was listening (the session ended), or the server does not know the
 * MCP session (the UI session was restarted on the same port, or reaped ours
 * while idle).
 *
 * @internal — exported for unit testing.
 */
export function uiRequestNeverRan(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 400 || err.code === 404;
  return errorCodes(err).includes('ECONNREFUSED');
}

/** Whether `err` says the backend itself failed, rather than the request it was given. */
function backendFailed(kind: BackendKind, err: unknown): boolean {
  if (err instanceof BackendLostError) return true;
  // The server's own answer to the request (unknown tool, invalid arguments).
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  if (kind === 'ui') return true;
  return err instanceof Error && /not connected/i.test(err.message);
}

// ─── Bridge ───

export class McpBridge {
  readonly server: Server;
  private readonly _options: McpBridgeOptions;
  private readonly _log: (line: string) => void;
  private _ui: Backend | undefined;
  private _headless: Backend | undefined;
  private _headlessInFlight = 0;
  private _uiInFlight = 0;
  private _uiLivenessTimer: ReturnType<typeof setInterval> | undefined;
  /** Until when requests wait for a UI session rather than start a headless one: set by a yield. */
  private _awaitUiUntil = 0;
  /** Until when a yield asked for while a headless request was running is done as soon as none is. */
  private _yieldRequestedUntil = 0;
  /** Serialises backend changes: two requests must not each start a headless child. */
  private _lock: Promise<unknown> = Promise.resolve();
  /** Backends being shut down, for `close` to wait on. */
  private readonly _closing = new Set<Promise<void>>();
  /** What the last tool call ran on, to tell the agent when that changes. */
  private _lastToolBackend: BackendKind | undefined;
  private _closed = false;

  constructor(options: McpBridgeOptions) {
    this._options = options;
    this._log = options.log ?? ((line) => { process.stderr.write(`[tapsmith-mcp] ${line}\n`); });
    this.server = new Server(
      { name: 'tapsmith', version: readSdkVersion() },
      { capabilities: { tools: {}, resources: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
      this._forward((client, backend) => client.request({ method: 'tools/list', params: request.params }, ListToolsResultSchema, { signal: AbortSignal.any([extra.signal, backend.lost.signal]) })).then((r) => r.result));
    this.server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
      this._forward((client, backend) => client.request({ method: 'resources/list', params: request.params }, ListResourcesResultSchema, { signal: AbortSignal.any([extra.signal, backend.lost.signal]) })).then((r) => r.result));
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
      this._forward((client, backend) => client.request({ method: 'resources/templates/list', params: request.params }, ListResourceTemplatesResultSchema, { signal: AbortSignal.any([extra.signal, backend.lost.signal]) })).then((r) => r.result));
    this.server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
      this._forward((client, backend) => client.request({ method: 'resources/read', params: request.params }, ReadResourceResultSchema, { signal: AbortSignal.any([extra.signal, backend.lost.signal]) })).then((r) => r.result));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const progressToken = request.params._meta?.progressToken;
      let ran: { result: CallToolResult; backend: Backend };
      try {
        ran = await this._forward((client, backend) => client.request(
          { method: 'tools/call', params: request.params },
          CallToolResultSchema,
          {
            signal: AbortSignal.any([extra.signal, backend.lost.signal]),
            timeout: NO_TIMEOUT_MS,
            // The backend's progress, under the token the agent's client chose.
            ...(progressToken !== undefined ? {
              onprogress: (progress) => {
                void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
              },
            } : {}),
          },
        ) as Promise<CallToolResult>);
      } catch (err) {
        if (!(err instanceof BackendLostError)) throw err;
        return { isError: true, content: [{ type: 'text' as const, text: err.detail }] };
      }
      return this._annotate(request.params.name, ran.result, ran.backend);
    });
  }

  /** Which backend requests are going to now, if one is up. */
  get activeBackend(): BackendKind | undefined {
    if (this._headless && this._headlessInFlight > 0) return 'headless';
    return this._ui ? 'ui' : this._headless ? 'headless' : undefined;
  }

  /**
   * Give up the headless session's devices for a UI session that is starting
   * (`tapsmith test --ui` asked). Refused while a headless request is running:
   * that run keeps its device, and the devices are given up when it ends if
   * the UI session is still waiting. Returns whether anything was given up now.
   */
  yieldHeadless(): boolean {
    if (!this._headless) return false;
    if (this._headlessInFlight > 0) {
      // The request keeps its device. If it ends while the UI session is
      // still waiting, the hand-over happens then.
      this._yieldRequestedUntil = Date.now() + (this._options.yieldRequestMs ?? YIELD_REQUEST_MS);
      return false;
    }
    this._yieldRequestedUntil = 0;
    this._log('A UI-mode session is starting for this project: ending the headless session so it can use its devices.');
    this._dropBackend(this._headless);
    // Requests from here on wait for that session: a headless one started
    // now would take the device straight back.
    this._awaitUiUntil = Date.now() + (this._options.yieldWaitMs ?? YIELD_WAIT_MS);
    return true;
  }

  /** Shut both backends down and wait for the headless child to exit. */
  async close(): Promise<void> {
    this._closed = true;
    this._stopUiLiveness();
    if (this._ui) this._loseBackend(this._ui);
    if (this._headless) this._dropBackend(this._headless);
    await Promise.all([...this._closing]);
  }

  // ─── Routing ───

  private _clientInfo(): Implementation {
    // The agent's own name, so the UI's list of connected agents names it.
    const client = this.server.getClientVersion();
    return { name: client?.name ?? 'tapsmith-mcp-server', version: client?.version ?? readSdkVersion() };
  }

  private _dropBackend(backend: Backend): void {
    if (this._ui === backend) this._ui = undefined;
    if (this._headless === backend) this._headless = undefined;
    const closing: Promise<void> = backend.client.close().catch(() => {}).finally(() => { this._closing.delete(closing); });
    this._closing.add(closing);
  }

  /** Drop a backend that has gone, failing the requests still running on it: they will never be answered. */
  private _loseBackend(backend: Backend): void {
    backend.lost.abort(new BackendLostError(lostMessage(backend)));
    this._dropBackend(backend);
  }

  /**
   * The backend for the next request, connecting or starting it as needed. A
   * headless one is returned already counted as in flight (the caller counts
   * it out), so nothing ends it between being chosen and being used.
   */
  private _pick(): Promise<Backend> {
    const next = this._lock.then(async (): Promise<Backend> => {
      const backend = await this._choose();
      if (backend.kind === 'headless') this._headlessInFlight++;
      return backend;
    });
    this._lock = next.catch(() => {});
    return next;
  }

  private async _choose(): Promise<Backend> {
    if (this._closed) throw new McpError(ErrorCode.ConnectionClosed, 'The Tapsmith MCP server is shutting down.');
    // A headless run in flight keeps every request until it ends.
    if (this._headless && this._headlessInFlight > 0) return this._headless;
    if (this._ui?.session) {
      // Asked before every request, so one is never sent into a session
      // that has ended: a failure after sending cannot say whether the call
      // ran. A session too busy to answer in time is still there.
      const ui = this._ui;
      const state = await (this._options.probeUiSession ?? probeUiSession)(this._ui.session);
      if (state !== 'gone') return ui;
      this._log(`The UI-mode session at ${ui.session?.mcpUrl} has ended.`);
      this._loseBackend(ui);
    }

    const find = this._options.findUiSession ?? (() => findUiSession(this._options.project));
    let session = await find();
    // A yield just ended the headless session for a UI session that is still
    // starting (it publishes itself last): wait for it.
    if (!session && this._awaitUiUntil > Date.now()) {
      this._log('Waiting for the UI-mode session that is starting for this project.');
      while (!session && !this._closed && this._awaitUiUntil > Date.now()) {
        await new Promise<void>((resolve) => { setTimeout(resolve, this._options.yieldPollMs ?? YIELD_POLL_MS); });
        session = await find();
      }
      if (this._closed) throw new McpError(ErrorCode.ConnectionClosed, 'The Tapsmith MCP server is shutting down.');
      if (!session) this._log('No UI-mode session came up.');
    }
    if (session) {
      this._awaitUiUntil = 0;
      try {
        const client = await (this._options.connectUi ?? connectUiSession)(session, this._clientInfo());
        const backend: Backend = { kind: 'ui', client, session, lost: new AbortController() };
        // A broken response stream reaches the client only as a transport
        // error, with its request left pending: ask whether the session is
        // still there.
        client.onerror = () => { void this._checkUiAlive(backend); };
        this._ui = backend;
        this._log(`Working in the UI-mode session at ${session.mcpUrl}.`);
        if (this._headless) {
          this._log('Ending the headless session.');
          this._dropBackend(this._headless);
        }
        return this._ui;
      } catch (err) {
        this._log(`Could not connect to the UI-mode session at ${session.mcpUrl} (${messageOf(err)}); running headless.`);
      }
    }
    if (!this._headless) {
      const client = await (this._options.startHeadless ?? ((info) => startHeadlessServer(this._options.project, info)))(this._clientInfo());
      const backend: Backend = { kind: 'headless', client, lost: new AbortController() };
      // A child that exits by itself (a crash, a yield) is no longer a backend.
      client.onclose = () => { if (this._headless === backend) this._headless = undefined; };
      this._headless = backend;
      this._log('Running headless: no UI-mode session is running for this project.');
    }
    return this._headless;
  }

  /**
   * Fail the requests running in a UI session that has ended. Their response
   * streams break without failing them, so nothing else would.
   */
  private async _checkUiAlive(backend: Backend): Promise<void> {
    if (this._ui !== backend || !backend.session) return;
    const state = await (this._options.probeUiSession ?? probeUiSession)(backend.session).catch(() => 'unanswered' as const);
    if (state !== 'gone' || this._ui !== backend) return;
    this._log(`The UI-mode session at ${backend.session.mcpUrl} has ended.`);
    this._loseBackend(backend);
  }

  private _stopUiLiveness(): void {
    if (this._uiLivenessTimer) clearInterval(this._uiLivenessTimer);
    this._uiLivenessTimer = undefined;
  }

  /** Count a request into (`+1`) or out of (`-1`) the UI session, asking after the session while any is running. */
  private _countUiRequest(change: 1 | -1): void {
    this._uiInFlight += change;
    if (this._uiInFlight > 0 && !this._uiLivenessTimer) {
      this._uiLivenessTimer = setInterval(() => {
        if (this._ui) void this._checkUiAlive(this._ui);
      }, this._options.uiLivenessMs ?? UI_LIVENESS_MS);
      this._uiLivenessTimer.unref?.();
    } else if (this._uiInFlight <= 0) {
      this._stopUiLiveness();
    }
  }

  /** Send one request to the current backend, moving to the other when that one has gone. */
  private async _forward<T>(send: (client: Client, backend: Backend) => Promise<T>): Promise<{ result: T; backend: Backend }> {
    for (let attempt = 0; ; attempt++) {
      const backend = await this._pick();
      if (backend.kind === 'ui') this._countUiRequest(1);
      try {
        return { result: await send(backend.client, backend), backend };
      } catch (err) {
        if (!backendFailed(backend.kind, err)) throw err;
        const live = this._ui === backend || this._headless === backend;
        if (live) this._loseBackend(backend);
        if (backend.kind === 'ui') {
          if (attempt === 0 && uiRequestNeverRan(err)) {
            if (live) this._log(`The UI-mode session at ${backend.session?.mcpUrl} no longer knows this connection: connecting again.`);
            continue;
          }
          if (live) this._log(`The UI-mode session at ${backend.session?.mcpUrl} stopped answering (${messageOf(err)}).`);
        } else if (live) {
          this._log(`The headless session ended unexpectedly (${messageOf(err)}).`);
        }
        throw err instanceof BackendLostError ? err : new BackendLostError(lostMessage(backend));
      } finally {
        if (backend.kind === 'ui') this._countUiRequest(-1);
        else if (--this._headlessInFlight === 0 && this._yieldRequestedUntil > Date.now()) this.yieldHeadless();
      }
    }
  }

  // ─── What the agent is told ───

  private _annotate(tool: string, result: CallToolResult, backend: Backend): CallToolResult {
    const notes: string[] = [];
    const previous = this._lastToolBackend;
    this._lastToolBackend = backend.kind;
    if (previous && previous !== backend.kind) {
      notes.push(backend.kind === 'ui'
        ? `Note: a UI-mode session is now running for this project, so this call ran in it (${backend.session?.mcpUrl}) and later ones will too. `
          + 'The headless session has ended: its results and watches are gone, and the UI session has its own.'
        : 'Note: the UI-mode session this server was working in has ended, so this call ran headless and later ones will too. '
          + 'The UI session\'s results and watches are gone; the headless session has its own.');
    }
    if (tool === 'tapsmith_session_info' && !result.isError) notes.push(this._modeSection(backend));
    if (backend.kind === 'headless' && result.isError && isDeviceUnavailableError(textOf(result))) {
      notes.push(
        `This server is running headless. It works in this project's UI-mode session whenever one is running: the user can start one with \`${this._exec()} test --ui\` `
        + `in ${this._options.project.cwd} and watch the agent work. If one is starting now, call again once it is up.`,
      );
    }
    if (notes.length === 0) return result;
    return { ...result, content: [...(result.content ?? []), ...notes.map((text) => ({ type: 'text' as const, text }))] };
  }

  private _exec(): string {
    return this._options.execCommand ?? 'npx tapsmith';
  }

  private _modeSection(backend: Backend): string {
    const exec = this._exec();
    if (backend.kind === 'ui') {
      return '## Mode\n'
        + `UI mode: working in the running UI-mode session at ${backend.session?.mcpUrl}`
        + `${backend.session?.pid ? ` (pid ${backend.session.pid})` : ''}. Test runs and device actions show in its window. `
        + 'If that session ends, this server carries on headless from the next call.';
    }
    return '## Mode\n'
      + 'Headless: no UI-mode session is running for this project. '
      + `To watch the agent work, the user can run \`${exec} test --ui\` in ${this._options.project.cwd}; `
      + 'this server works in that session from the next call after it is up (once any test run in progress here has ended).';
  }
}

function textOf(result: CallToolResult): string {
  return (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/**
 * Whether a headless tool error says the session has no device to use: none
 * is running, or the one it wants is held by another session (a UI-mode one,
 * often). Those are the errors a UI-mode session answers, so the bridge adds
 * how to start one. Matched on the messages `mcp/connection.ts` and
 * `device-claims.ts` write; `mcp-bridge.test.ts` holds the two together.
 *
 * @internal — exported for unit testing.
 */
export function isDeviceUnavailableError(text: string): boolean {
  return /\bNo (?:\w+ )?device is available\b/.test(text)
    || /\bDevice "[^"]+"[^.]* is not available\b/.test(text)
    || /\bis in use by another Tapsmith session\b/.test(text)
    || /\ba running `tapsmith test --ui` session\b/.test(text);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lostMessage(backend: Backend): string {
  return backend.kind === 'ui'
    ? `The UI-mode session at ${backend.session?.mcpUrl} ended (or stopped answering) while this call was running, so it may not have completed. `
      + 'Call again: this server runs headless when no UI-mode session is running for the project.'
    : 'The headless Tapsmith session ended while this call was running, so it may not have completed. Call again to start a new one.';
}

// ─── Default backends ───

async function connectUiSession(session: UiSession, info: Implementation): Promise<Client> {
  const client = new Client(info, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(session.mcpUrl)) as Transport);
  return client;
}

/**
 * The headless server as a child process, not in this one: its connection
 * state is per process, so ending it (for a UI session to take its device)
 * and starting another later is closing one child and spawning the next.
 */
async function startHeadlessServer(project: ProjectRef, info: Implementation): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== PREFER_UI_ENV) env[key] = value;
  }
  env[BRIDGED_ENV] = '1';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...process.execArgv,
      fileURLToPath(new URL('../bin.js', import.meta.url)),
      'mcp-server',
      ...(project.configFile ? ['--config', project.configFile] : []),
    ],
    env,
    cwd: project.cwd,
    stderr: 'inherit',
  });
  const client = new Client(info, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// ─── Entry point ───

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export async function runMcpBridge(options: { configFile?: string }): Promise<void> {
  const cwd = process.cwd();
  const bridge = new McpBridge({
    project: { cwd, configFile: options.configFile },
    execCommand: await tapsmithExecCommand(cwd).catch(() => undefined),
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bridge.server.close().catch(() => {})
      .then(() => bridge.close())
      .finally(() => process.exit(0));
  };
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, shutdown);
  // The client closing stdin is the stdio transport's shutdown signal, and the
  // SDK's server transport does not listen for it (PILOT-453).
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.stdout.on('error', shutdown);
  process.stderr.on('error', () => {});
  // The handler first, then the mark that makes UI sessions send the signal.
  // No such signal on Windows, where nothing sends it either.
  if (process.platform !== 'win32') {
    process.on(YIELD_SIGNAL, () => { bridge.yieldHeadless(); });
    markSessionYieldsToUi();
  }

  await bridge.server.connect(new StdioServerTransport());
  process.stderr.write(
    `[tapsmith-mcp] tapsmith ${readSdkVersion()} MCP server on stdio, in ${cwd}: `
    + 'works in this project\'s UI-mode session (tapsmith test --ui) when one is running, headless otherwise.\n',
  );
}
