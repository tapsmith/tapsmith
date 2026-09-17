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
import { closeAllClients, configureMcpConnection } from './connection.js';
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
    version: '0.1.0',
  });

  if (events) {
    wrapToolRegistrationsWithEvents(server, events);
  }

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

  // Register API reference as a resource
  // import.meta.dirname points to dist/mcp/ or src/mcp/ depending on build vs tsx
  const apiRefPath = path.resolve(import.meta.dirname, '../../../docs/api-reference.md');
  if (fs.existsSync(apiRefPath)) {
    server.resource(
      'Tapsmith API Reference',
      'tapsmith://api-reference',
      { description: 'Complete API reference for the Tapsmith mobile testing framework. Read this to understand available methods when writing tests.', mimeType: 'text/markdown' },
      () => ({
        contents: [{
          uri: 'tapsmith://api-reference',
          text: fs.readFileSync(apiRefPath, 'utf-8'),
          mimeType: 'text/markdown',
        }],
      }),
    );
  }

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

function wrapToolRegistrationsWithEvents(server: McpServer, events: McpEventEmitter): void {
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
      return callToolWithEvents(events, toolName, toolArgs, () => callback(...callbackArgs));
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

function parseMcpServerArgs(argv: string[]): RunMcpServerOptions & { help?: boolean } {
  const options: RunMcpServerOptions & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--config' || arg === '-c') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a config file path`);
      options.configFile = value;
    } else if (arg.startsWith('--config=')) {
      options.configFile = arg.slice('--config='.length);
    } else {
      throw new Error(`Unknown mcp-server argument: ${arg}`);
    }
  }
  return options;
}

function printMcpServerHelp(): void {
  process.stdout.write(`Usage: tapsmith mcp-server [options]\n\n`);
  process.stdout.write(`Run the Tapsmith MCP server on stdio transport.\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  -c, --config <file>  Tapsmith config file to load\n`);
  process.stdout.write(`  -h, --help           Show this help\n\n`);
  process.stdout.write(`Examples:\n`);
  process.stdout.write(`  codex mcp add tapsmith -- npx tapsmith mcp-server\n`);
  process.stdout.write(`  claude mcp add tapsmith -- npx tapsmith mcp-server\n`);
  process.stdout.write(`  npx tapsmith mcp-server --config tapsmith.config.ios.mjs\n`);
}

export async function runMcpServer(
  argv: string[] = [],
  runtimeOptions: RunMcpServerRuntimeOptions = {},
): Promise<void> {
  const options = parseMcpServerArgs(argv);
  if (options.help) {
    printMcpServerHelp();
    return;
  }

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
  const signalHandler = (): void => {
    cleanup();
    if (runtimeOptions.exitOnSigint ?? true) process.exit(0);
  };
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, signalHandler);
    stopActivityMonitor();
    dispatcher.dispose();
    closeAllClients();
  }
  // SIGTERM matters as much as SIGINT here: the MCP SDK's stdio client kills
  // its server with SIGTERM on shutdown, and node's default handling for it
  // terminates the process without running any of this — orphaning the daemon
  // (and its device agent) that the session started.
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, signalHandler);

  const server = createMcpServer({ events, dispatcher });
  attachMcpClientEventReporting(server, events, cleanup);

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    cleanup();
    throw err;
  }

  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  process.stderr.write('\n' + banner.split('\n').map((line) => `${GREEN}${line}${RESET}`).join('\n') + '\n');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf-8'));
    process.stderr.write(`${DIM}v${pkg.version}${RESET}\n`);
  } catch { /* version not available */ }
  process.stderr.write(`\n  ${DIM}MCP server running on stdio transport. Waiting for an MCP client on stdin...${RESET}\n`);
  process.stderr.write(`  ${DIM}Stdio clients start this command as a subprocess; another terminal cannot attach to this process.${RESET}\n`);
  process.stderr.write(`  ${DIM}This terminal is also watching MCP activity from client-owned tapsmith subprocesses.${RESET}\n`);
  process.stderr.write(`\n  ${BOLD}Connect your AI agent${RESET}\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Codex CLI:${RESET}\n`);
  process.stderr.write(`    codex mcp add tapsmith -- npx tapsmith mcp-server\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Claude Code:${RESET}\n`);
  process.stderr.write(`    claude mcp add tapsmith -- npx tapsmith mcp-server\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Custom config:${RESET}\n`);
  process.stderr.write(`    npx tapsmith mcp-server --config tapsmith.config.ios.mjs\n`);
  process.stderr.write(`  ${DIM}${CYAN}›${RESET}${DIM} Generic MCP stdio config:${RESET}\n`);
  process.stderr.write(`    { "mcpServers": { "tapsmith": { "command": "npx", "args": ["tapsmith", "mcp-server"] } } }\n\n`);

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
