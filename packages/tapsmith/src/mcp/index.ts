import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import figlet from 'figlet';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSnapshotTool } from './tools/snapshot.js';
import { registerScreenshotTool } from './tools/screenshot.js';
import { registerTestLocatorTool } from './tools/test-locator.js';
import { registerDeviceActionTools } from './tools/device-actions.js';
import { registerAppControlTools } from './tools/app-control.js';
import { registerListDevicesTool } from './tools/list-devices.js';
import { registerRunTestsTool } from './tools/run-tests.js';
import { registerReadTraceTool } from './tools/read-trace.js';
import { registerListResultsTool } from './tools/list-results.js';
import { registerSuiteStatusTool } from './tools/suite-status.js';
import { registerListTestsTool } from './tools/list-tests.js';
import { registerStopTestsTool } from './tools/stop-tests.js';
import { registerSessionInfoTool } from './tools/session-info.js';
import { registerWatchTool } from './tools/watch.js';
import { registerApiReferenceResource } from './api-reference.js';
import { closeAllClients, configureMcpConnection } from './connection.js';
import { readSdkVersion } from '../telemetry.js';
import { mcpActivityFilePath, uiPortFilePath } from './port-file.js';
import {
  McpEventEmitter,
  nextCallId,
  summarizeResult,
  truncateResultText,
  type McpClientInfo,
  type McpToolCallEvent,
} from './events.js';
import { HeadlessTestDispatcher } from './headless-dispatcher.js';
import { boundThrownError, boundToolResult } from './response-limits.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TestDispatcher } from './test-dispatcher.js';

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const ACTIVITY_MONITOR_MAX_READ_BYTES = 1024 * 1024;
/** How long shutdown waits for stderr to drain before exiting anyway. */
const STDERR_FLUSH_DEADLINE_MS = 1_000;

export type {
  TestDispatcher, TestRunResult, TestResultEntry, TestFailureDetail,
  TestTreeEntry, ProjectInfo, SessionInfo, DiscoveryError, DeviceTarget,
} from './test-dispatcher.js';

export interface McpServerOptions {
  name?: string
  events?: McpEventEmitter
  dispatcher?: TestDispatcher
}

export interface RunMcpServerOptions {
  configFile?: string
}

export interface RunMcpServerRuntimeOptions {
  /** Exit the process after cleanup when a shutdown signal arrives (default true). */
  exitOnSigint?: boolean
}

/** Signals that must run session cleanup before the process goes away. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export function createMcpServer(options?: McpServerOptions): McpServer {
  const { name = 'tapsmith', events, dispatcher } = options ?? {};

  const server = new McpServer({
    name,
    version: readSdkVersion(),
  });

  if (events) {
    wrapToolCallbacks(server, (toolName, callback) => (toolArgs) =>
      callToolWithEvents(events, toolName, toolArgs, callback));
  }
  // Installed after the events wrapper so it runs inside it: the activity log
  // and the UI's MCP panel then show the same bounded result the client gets.
  // Every tool, on both transports, including ones added later (PILOT-657).
  wrapToolCallbacks(server, (toolName, callback) => async () => {
    try {
      return boundToolResult(await callback() as CallToolResult, toolName);
    } catch (err) {
      throw boundThrownError(err);
    }
  });

  // The dispatcher is what turns a project name into a platform, and so into a
  // device. Both transports build the server here, so both route device tools
  // the same way runs are routed.
  registerSnapshotTool(server, dispatcher);
  registerScreenshotTool(server, dispatcher);
  registerTestLocatorTool(server, dispatcher);
  registerDeviceActionTools(server, dispatcher);
  registerAppControlTools(server, dispatcher);
  registerListDevicesTool(server, dispatcher);
  registerRunTestsTool(server, dispatcher);
  registerReadTraceTool(server);

  if (dispatcher) {
    registerListTestsTool(server, dispatcher);
    registerListResultsTool(server, dispatcher);
    registerSuiteStatusTool(server, dispatcher);
    registerStopTestsTool(server, dispatcher);
    registerSessionInfoTool(server, dispatcher);
    registerWatchTool(server, dispatcher);
  }

  registerApiReferenceResource(server);

  return server;
}

export function attachMcpClientEventReporting(
  server: McpServer,
  events: McpEventEmitter,
  onClose?: () => void,
  // Per-session callback for multi-client setups (UI mode): the shared `events`
  // emitter can't distinguish concurrent clients, so callers that track sessions
  // individually use this to learn this specific server's client identity.
  onClientInfo?: (info: McpClientInfo | null) => void,
): void {
  let connected = false;

  const previousOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    previousOnInitialized?.();
    const client = server.server.getClientVersion();
    connected = true;
    const info: McpClientInfo = {
      name: client?.name ?? 'Unknown',
      version: client?.version ?? '',
    };
    events.emitClientChange(info);
    onClientInfo?.(info);
  };

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    if (connected) {
      connected = false;
      events.emitClientChange(null);
      onClientInfo?.(null);
    }
    onClose?.();
    previousOnClose?.();
  };
}

type ToolCallbackWrapper = (
  toolName: string,
  callback: () => unknown,
) => (toolArgs: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Route every tool registered from here on through `wrap`. Patches
 * `server.tool` itself, so a later call wraps the callbacks an earlier one
 * already wrapped (the later wrapper runs innermost).
 */
function wrapToolCallbacks(server: McpServer, wrap: ToolCallbackWrapper): void {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]): unknown => {
    const toolName = typeof args[0] === 'string' ? args[0] : 'unknown_tool';
    const callbackIndex = lastFunctionIndex(args);
    if (callbackIndex < 0) return originalTool(...args);

    const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
    const wrappedCallback = (...callbackArgs: unknown[]): Promise<CallToolResult> => {
      const toolArgs = callbackArgs.length >= 2 && isRecord(callbackArgs[0])
        ? callbackArgs[0]
        : {};
      return wrap(toolName, () => callback(...callbackArgs))(toolArgs);
    };

    const wrappedArgs = [...args];
    wrappedArgs[callbackIndex] = wrappedCallback;
    return originalTool(...wrappedArgs);
  };
}

async function callToolWithEvents(
  events: McpEventEmitter,
  toolName: string,
  args: Record<string, unknown>,
  callback: () => unknown,
): Promise<CallToolResult> {
  const callId = nextCallId();
  const start = Date.now();

  events.emitToolCall({
    id: callId,
    tool: toolName,
    args,
    status: 'started',
    timestamp: start,
  });

  try {
    const result = await callback() as CallToolResult;
    const elapsed = Date.now() - start;
    const resultText = (result.content ?? [])
      .filter((c: { type: string }) => c.type === 'text')
      .map((c) => 'text' in c ? (c as { text: string }).text : '')
      .join('\n');
    const eventResultText = truncateResultText(resultText);
    const errorText = result.isError
      ? eventResultText.resultTruncated
        ? `${eventResultText.resultText}\n... truncated`
        : eventResultText.resultText || resultText || 'Unknown tool error'
      : undefined;

    events.emitToolCall({
      id: callId,
      tool: toolName,
      args,
      status: result.isError ? 'error' : 'completed',
      resultSummary: summarizeResult(toolName, resultText),
      ...eventResultText,
      error: errorText,
      durationMs: elapsed,
      timestamp: start,
    });

    return result;
  } catch (err) {
    events.emitToolCall({
      id: callId,
      tool: toolName,
      args,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      timestamp: start,
    });
    throw err;
  }
}

function lastFunctionIndex(items: unknown[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (typeof items[i] === 'function') return i;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runMcpServer(
  options: RunMcpServerOptions = {},
  runtimeOptions: RunMcpServerRuntimeOptions = {},
): Promise<void> {

  // Discover UI server for event reporting
  const uiPort = discoverUiServerPort();
  const activityPath = mcpActivityFilePath();
  ensureActivityFile(activityPath);
  const events = new McpEventEmitter();
  const stopActivityMonitor = startActivityMonitor(activityPath);

  if (uiPort) {
    const sseUrl = `http://localhost:${uiPort}/mcp`;
    process.stderr.write(
      `[tapsmith-mcp] UI mode detected. For shared-session mode (recommended), connect via SSE instead:\n` +
      `[tapsmith-mcp]   ${sseUrl}\n`,
    );
    events.onToolCall((event) => {
      postToUiServer(uiPort, '/mcp-events', event);
    });
  }

  // Log tool calls and client events to stderr
  events.onToolCall((event) => {
    appendActivity(activityPath, { type: 'tool', pid: process.pid, cwd: process.cwd(), event });
    writeToolEvent(event);
  });

  // Log client connect/disconnect
  events.onClientChange((info) => {
    appendActivity(activityPath, { type: 'client', pid: process.pid, cwd: process.cwd(), timestamp: Date.now(), info });
    writeClientEvent(info);
  });

  // Headless dispatcher — lazy-initializes config, test files, and device
  // connection on first tool call (no startup cost)
  configureMcpConnection({ configFile: options.configFile });
  const dispatcher = new HeadlessTestDispatcher({ configFile: options.configFile });
  let cleanedUp = false;
  let exiting = false;
  /**
   * Clean up, then exit 0 once stderr has flushed — the one way this server
   * ends, whether the client signalled it or just closed stdin.
   */
  const shutdown = (): void => {
    cleanup();
    if (!(runtimeOptions.exitOnSigint ?? true) || exiting) return;
    exiting = true;
    // On macOS a piped stderr is asynchronous: exiting straight away can drop
    // the "Client disconnected" line and the daemon notes before them. The
    // write callback fires once everything queued ahead of it is flushed —
    // unless nobody is reading the pipe, so it gets a deadline. Unref'd: it
    // must not be the thing keeping a finished process alive.
    const exit = (): void => process.exit(0);
    setTimeout(exit, STDERR_FLUSH_DEADLINE_MS).unref();
    // Cleanup took the signal handlers down; a signal in this window (a client
    // that closed stdin and then sent SIGTERM, a second Ctrl-C) would
    // otherwise end the process by signal instead of exit 0.
    for (const signal of SHUTDOWN_SIGNALS) process.once(signal, exit);
    process.stderr.write('', exit);
  };
  // A client that died took the read ends of our pipes with it. Writing the
  // shutdown notes there fails with EPIPE, and an unhandled stream error would
  // turn a clean shutdown into a crash. Nothing is left to report it to.
  // A broken stdout means the client can no longer hear us even if stdin is
  // still open (a wrapper that died half-way): that is a disconnect too.
  process.stdout.on('error', () => onClientGone());
  process.stderr.on('error', () => {});
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, shutdown);
    process.stdin.off('end', onClientGone);
    process.stdin.off('close', onClientGone);
    stopActivityMonitor();
    dispatcher.dispose();
    closeAllClients();
  }
  // SIGTERM matters as much as SIGINT here: the MCP SDK's stdio client kills
  // its server with SIGTERM on shutdown, and node's default handling for it
  // terminates the process without running any of this — orphaning the daemon
  // (and its device agent) that the session started.
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, shutdown);

  const server = createMcpServer({ events, dispatcher });
  attachMcpClientEventReporting(server, events, cleanup);

  // Stdin EOF is the stdio transport's *primary* shutdown signal: the MCP spec
  // has a client close the server's stdin, wait for it to exit, and only then
  // fall back to SIGTERM — and a client killed outright closes the pipe without
  // signalling anything. The SDK's server transport never listens for it
  // (only `data` and `error`), so without this the server ran forever after
  // its client left, keeping the `--outlive-parent` daemon it started and that
  // daemon's device agent alive (PILOT-453). Closing the server runs `onclose`,
  // which reports the disconnect and cleans up like any other close.
  function onClientGone(): void {
    void server.close().catch(() => {}).finally(shutdown);
  }
  process.stdin.once('end', onClientGone);
  process.stdin.once('close', onClientGone);

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    cleanup();
    throw err;
  }

  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  process.stderr.write('\n' + banner.split('\n').map((line) => `${GREEN}${line}${RESET}`).join('\n') + '\n');
  process.stderr.write(`${DIM}v${readSdkVersion()}${RESET}\n`);
  process.stderr.write(`\n  ${DIM}MCP server running on stdio transport. Waiting for an MCP client on stdin...${RESET}\n`);
  process.stderr.write(`  ${DIM}Stdio clients start this command as a subprocess; another terminal cannot attach to this process.${RESET}\n`);
  process.stderr.write(`  ${DIM}This terminal is also watching MCP activity from client-owned Tapsmith subprocesses.${RESET}\n`);
  process.stderr.write(`\n  ${BOLD}Connect your AI agent${RESET}\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Codex CLI:${RESET}\n`);
  process.stderr.write(`    codex mcp add tapsmith-headless -- npx tapsmith mcp-server\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Claude Code:${RESET}\n`);
  process.stderr.write(`    claude mcp add tapsmith-headless -- npx tapsmith mcp-server\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Custom config:${RESET}\n`);
  process.stderr.write(`    npx tapsmith mcp-server --config tapsmith.config.ios.mjs\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Generic MCP stdio config:${RESET}\n`);
  process.stderr.write(`    { "mcpServers": { "tapsmith-headless": { "command": "npx", "args": ["tapsmith", "mcp-server"] } } }\n\n`);

}

type McpActivityRecord =
  | { type: 'client'; pid: number; cwd: string; timestamp: number; info: McpClientInfo | null }
  | { type: 'tool'; pid: number; cwd: string; event: McpToolCallEvent };

function ensureActivityFile(activityPath: string): void {
  try {
    fs.mkdirSync(path.dirname(activityPath), { recursive: true });
    if (!fs.existsSync(activityPath)) fs.writeFileSync(activityPath, '', 'utf-8');
  } catch {
    // Activity monitoring is best-effort. Never break MCP protocol handling.
  }
}

function appendActivity(activityPath: string, record: McpActivityRecord): void {
  try {
    fs.appendFileSync(activityPath, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    // Activity monitoring is best-effort. Never break MCP protocol handling.
  }
}

function startActivityMonitor(activityPath: string): () => void {
  let offset = 0;
  try {
    offset = fs.statSync(activityPath).size;
  } catch {
    // The first client-owned server will create the activity file.
  }

  const readNewLines = (): void => {
    let size = 0;
    try {
      size = fs.statSync(activityPath).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0;
    if (size === offset) return;

    const start = Math.max(offset, size - ACTIVITY_MONITOR_MAX_READ_BYTES);
    offset = size;
    const length = size - start;
    if (length <= 0) return;
    let content = '';
    try {
      const fd = fs.openSync(activityPath, 'r');
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        content = buffer.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as McpActivityRecord;
        if (record.pid === process.pid) continue;
        if (record.type === 'tool') writeToolEvent(record.event);
        else writeClientEvent(record.info);
      } catch {
        // Ignore partial or malformed log records.
      }
    }
  };

  // fs.watch uses native OS events instead of polling
  let watcher: fs.FSWatcher | null = null;
  try {
    ensureActivityFile(activityPath);
    watcher = fs.watch(activityPath, () => readNewLines());
  } catch {
    // Fall back to polling if fs.watch is unavailable (e.g. network filesystems)
    fs.watchFile(activityPath, { interval: 250 }, readNewLines);
  }
  return () => {
    if (watcher) watcher.close();
    else fs.unwatchFile(activityPath, readNewLines);
  };
}

function writeToolEvent(event: McpToolCallEvent): void {
  const time = formatTime(event.timestamp);
  if (event.status === 'started') {
    const argsStr = formatArgs(event.args);
    process.stderr.write(`  ${DIM}${time}${RESET} ${CYAN}▶${RESET} ${BOLD}${event.tool}${RESET}${argsStr}\n`);
  } else if (event.status === 'completed') {
    const dur = event.durationMs != null ? ` ${DIM}(${formatDuration(event.durationMs)})${RESET}` : '';
    const summary = event.resultSummary ? `  ${DIM}→ ${event.resultSummary}${RESET}` : '';
    process.stderr.write(`  ${DIM}${time}${RESET} ${GREEN}✓${RESET} ${event.tool}${dur}${summary}\n`);
  } else if (event.status === 'error') {
    const dur = event.durationMs != null ? ` ${DIM}(${formatDuration(event.durationMs)})${RESET}` : '';
    const errMsg = event.error ? `  ${RED}${event.error.split('\n')[0]}${RESET}` : '';
    process.stderr.write(`  ${DIM}${time}${RESET} ${RED}✗${RESET} ${event.tool}${dur}${errMsg}\n`);
  }
}

function writeClientEvent(info: McpClientInfo | null): void {
  if (info) {
    const ver = info.version ? ` v${info.version}` : '';
    process.stderr.write(`\n  ${GREEN}●${RESET} ${BOLD}${info.name}${RESET}${DIM}${ver}${RESET} connected\n\n`);
  } else {
    process.stderr.write(`\n  ${YELLOW}●${RESET} ${DIM}Client disconnected${RESET}\n\n`);
  }
}

function discoverUiServerPort(): number | null {
  try {
    const portFile = uiPortFilePath();
    const content = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(content, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // No UI server running
  }
  return null;
}

function postToUiServer(port: number, urlPath: string, data: unknown): void {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: urlPath,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.end(body);
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const key of keys) {
    const val = args[key];
    if (val === undefined || val === null) continue;
    if (typeof val === 'string') {
      const display = val.length > 60 ? val.slice(0, 57) + '...' : val;
      parts.push(`${key}=${display}`);
    } else if (Array.isArray(val)) {
      parts.push(`${key}=[${val.length}]`);
    } else {
      parts.push(`${key}=${String(val)}`);
    }
  }
  return parts.length > 0 ? ` \x1b[2m${parts.join(' ')}\x1b[0m` : '';
}
