import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Everything else tests the MCP server in-process. Nothing tested that
// `tapsmith mcp-server` — the command every agent's config actually runs —
// starts, speaks the protocol on stdio, and shuts down cleanly. The failures
// this catches are the ones a unit test cannot see: a tool that throws while
// registering, output that corrupts the stream, an argument the CLI drops, and
// a SIGTERM that kills the process before it can release the daemon it started.
//
// No device is involved: every tool called here answers without one.

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const CLI = path.join(PKG_ROOT, 'src', 'cli.ts');

/**
 * Node with tsx's loader, rather than the `tsx` shim.
 *
 * The shim runs the CLI as a *grandchild*, which breaks both things this file
 * needs from a child process: the exit code observed is the shim's and not the
 * server's (so a SIGTERM that skipped cleanup is indistinguishable from one
 * that ran it), and killing the shim leaves the server behind, reparented to
 * init — an orphan per run, holding whatever the session had open.
 */
const NODE = process.execPath;
const TSX_LOADER = pathToFileURL(path.join(PKG_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const SERVER_ARGS = ['--import', TSX_LOADER, CLI, 'mcp-server'];

/** Long enough for a cold start on a loaded CI box, short enough to fail. */
const START_TIMEOUT_MS = 30_000;

let tmpDir: string;
/** Every process a test started, so none can outlive it. */
let spawned: ChildProcessWithoutNullStreams[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-mcp-stdio-'));
  spawned = [];
});

afterEach(async () => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit', 5_000).catch(() => {});
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * The server's environment: its own activity file and a working directory with
 * no Tapsmith config, so a test can never disturb — or adopt — a real session's
 * state.
 */
function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAPSMITH_MCP_ACTIVITY_FILE: path.join(tmpDir, 'activity.ndjson'),
    NO_COLOR: '1',
  };
}

function spawnServer(args: string[] = []): ChildProcessWithoutNullStreams {
  const child = spawn(NODE, [...SERVER_ARGS, ...args], {
    cwd: tmpDir,
    env: serverEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  spawned.push(child);
  // Without this, a spawn failure (no loader, a partial install) emits `error`
  // with nothing listening: the promise below never settles and the unhandled
  // event takes the vitest worker down instead of failing the test.
  child.on('error', (err) => { spawnError = err; });
  return child;
}

let spawnError: Error | undefined;

beforeEach(() => { spawnError = undefined; });

function stdioTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: NODE,
    args: SERVER_ARGS,
    cwd: tmpDir,
    env: serverEnv() as Record<string, string>,
    stderr: 'ignore',
  });
}

describe('tapsmith mcp-server over real stdio', () => {
  it('serves its tool set, and dispatches a call, to a client that spawns it', async () => {
    const client = new Client({ name: 'stdio-probe', version: '1.0.0' }, { capabilities: {} });

    try {
      await client.connect(stdioTransport());

      // Clients show and log this; a hardcoded placeholder told every agent
      // it was talking to 0.1.0 whatever was installed (PILOT-267).
      const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')) as { version: string };
      expect(client.getServerVersion()).toMatchObject({ name: 'tapsmith', version: pkg.version });

      // The inventory itself is pinned in mcp-device-tools; what matters here
      // is that a spawned server registers both halves of the surface without
      // a device, rather than dying partway through registration.
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining([
        'tapsmith_snapshot', 'tapsmith_tap', 'tapsmith_list_devices',
        'tapsmith_run_tests', 'tapsmith_suite_status', 'tapsmith_watch',
      ]));

      const res = await client.callTool({
        name: 'tapsmith_read_trace',
        arguments: { path: path.join(tmpDir, 'no-such-trace.zip') },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('Trace file not found');

      // Still alive and answering after an error result.
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);

      // The resource docs/agents.md points agents at. It never registered, so
      // resources/list was a "Method not found" error (PILOT-359).
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain('tapsmith://api-reference');
    } finally {
      await client.close();
    }
  }, START_TIMEOUT_MS);

  it('keeps its banner off stdout, where it would corrupt the protocol', async () => {
    // The server prints a figlet banner and connection instructions on start.
    // On stdout, every one of those lines is a parse error for the client, and
    // the session dies before the first tool call.
    const child = spawnServer();
    const out = collect(child);

    const request = (id: number, method: string, params: unknown = {}) =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    child.stdin.write(request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raw-probe', version: '1.0.0' },
    }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(request(2, 'tools/list'));

    await waitFor(() => out.stdout.includes('"id":2'), START_TIMEOUT_MS);

    const lines = out.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(() => JSON.parse(line), `stdout line is not JSON-RPC: ${line}`).not.toThrow();
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
    // The banner is not lost — it just belongs on the other stream.
    expect(out.stderr).toContain('MCP server running on stdio transport');
  }, START_TIMEOUT_MS);

  it('runs its own shutdown on SIGTERM instead of being killed by it', async () => {
    // A stdio client kills its server with SIGTERM. Node's default handling
    // terminates the process without running any cleanup — orphaning the
    // daemon, and the device agent behind it, that the session started.
    const child = spawnServer();
    const out = collect(child);
    const exited = once(child, 'exit', START_TIMEOUT_MS);

    // Answering on stdout is the only readiness signal that does not depend on
    // what the banner happens to say.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
    })}\n`);
    await waitFor(() => out.stdout.includes('"id":1'), START_TIMEOUT_MS);
    child.kill('SIGTERM');

    // Cleanup, then exit(0). Node's default handling cannot produce that: it
    // ends the process on the signal, reported here as signalCode SIGTERM.
    await exited;
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
  }, START_TIMEOUT_MS);

  it('shuts down and exits 0 when its client closes stdin without signalling (PILOT-453)', async () => {
    // Not every client signals its server: many just close the pipe and walk
    // away. The server used to ignore that EOF and run forever — and with it
    // the daemon it started (`--outlive-parent`) and that daemon's device
    // agent, holding the simulator until something killed them by hand.
    const child = spawnServer();
    const out = collect(child);
    const exited = once(child, 'exit', START_TIMEOUT_MS);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
    })}\n`);
    await waitFor(() => out.stdout.includes('"id":1'), START_TIMEOUT_MS);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await waitFor(() => out.stderr.includes('raw-probe'), START_TIMEOUT_MS);
    child.stdin.end();

    await exited;
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
    // It went through the shutdown path, not out by accident.
    expect(out.stderr).toContain('Client disconnected');
  }, START_TIMEOUT_MS);

  it('exits 0, not on an EPIPE crash, when its client died and took the pipes with it', async () => {
    // A killed client closes every pipe at once. The shutdown still writes its
    // notes ("Client disconnected", daemon release) to a stderr with no reader.
    const child = spawnServer();
    const out = collect(child);
    const exited = once(child, 'exit', START_TIMEOUT_MS);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
    })}\n`);
    await waitFor(() => out.stdout.includes('"id":1'), START_TIMEOUT_MS);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await waitFor(() => out.stderr.includes('raw-probe'), START_TIMEOUT_MS);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.end();

    await exited;
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
  }, START_TIMEOUT_MS);

  it('shuts down when it can no longer reach its client on stdout, even with stdin open', async () => {
    // A wrapper between client and server that dies half-way: nothing the
    // server says arrives any more, but no EOF ever comes either.
    const child = spawnServer();
    const out = collect(child);
    const exited = once(child, 'exit', START_TIMEOUT_MS);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
    })}\n`);
    await waitFor(() => out.stdout.includes('"id":1'), START_TIMEOUT_MS);
    child.stdout.destroy();
    // The reply to this is what discovers the broken pipe.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

    await exited;
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
  }, START_TIMEOUT_MS);

  it('exits on stdin EOF even before a client ever initialized', async () => {
    // A client that spawns the server and dies before its handshake leaves the
    // same pipe closed behind it; the server must not wait on it forever.
    const child = spawnServer();
    const out = collect(child);
    const exited = once(child, 'exit', START_TIMEOUT_MS);
    await waitFor(() => out.stderr.includes('MCP server running on stdio transport'), START_TIMEOUT_MS);
    child.stdin.end();

    await exited;
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
  }, START_TIMEOUT_MS);
});

describe('tapsmith mcp-server arguments', () => {
  it('documents the flags an agent config needs, and exits', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--config');
    expect(stdout).toContain('claude mcp add tapsmith-headless -- npx tapsmith mcp-server');
  }, START_TIMEOUT_MS);

  it('refuses an argument it does not know rather than starting anyway', async () => {
    // Starting despite a misspelled flag is worse than failing: the session
    // runs against the wrong config and nothing says so.
    const { code, stderr } = await run(['--confg', 'tapsmith.config.mjs']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('--confg');
  }, START_TIMEOUT_MS);
});

// ─── Helpers ───

function collect(child: ChildProcessWithoutNullStreams): { stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => { out.stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { out.stderr += chunk; });
  return out;
}

function once(child: ChildProcessWithoutNullStreams, event: 'exit', timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    child.once(event, () => { clearTimeout(timer); resolve(); });
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (spawnError) throw new Error(`Could not start the server: ${spawnError.message}`);
    if (Date.now() > deadline) throw new Error('Timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnServer(args);
  const out = collect(child);
  await once(child, 'exit', START_TIMEOUT_MS);
  if (spawnError) throw new Error(`Could not start the server: ${spawnError.message}`);
  return { code: child.exitCode, ...out };
}
