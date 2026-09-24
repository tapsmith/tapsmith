import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpEventEmitter, type McpClientInfo } from '../mcp/events.js';
import { McpSessionRouter } from '../mcp/http-session-router.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';

// Spin up a real HTTP server backed by the router and connect real MCP clients
// over loopback — this exercises session-id routing end to end.

interface Harness {
  url: string
  router: McpSessionRouter
  clients: McpClientInfo[]
  close: () => Promise<void>
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length) {
    await harnesses.pop()!.close();
  }
});

async function startHarness(
  opts: { sessionGraceMs?: number; idleTimeoutMs?: number; sweepIntervalMs?: number; maxRequestBodyBytes?: number } = {},
): Promise<Harness> {
  const events = new McpEventEmitter();
  const clients: McpClientInfo[] = [];
  const router = new McpSessionRouter({
    name: 'tapsmith-test',
    events,
    dispatcher: makeDispatcher(),
    onClientsChanged: (list) => { clients.length = 0; clients.push(...list); },
    keepAliveIntervalMs: 0, // disable the SSE keep-alive timer in tests
    sessionGraceMs: opts.sessionGraceMs ?? 0, // reap immediately on clean close unless a test opts in
    idleTimeoutMs: opts.idleTimeoutMs ?? 0, // disable the idle sweep unless a test opts in
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    ...(opts.maxRequestBodyBytes != null ? { maxRequestBodyBytes: opts.maxRequestBodyBytes } : {}),
  });

  const server = http.createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/mcp') {
      router.handleRequest(req, res).catch(() => {
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const harness: Harness = {
    url: `http://127.0.0.1:${port}/mcp`,
    router,
    clients,
    close: () => new Promise<void>((resolve) => {
      router.close();
      // SSE GET streams keep connections open; force them shut so close resolves.
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  harnesses.push(harness);
  return harness;
}

interface ConnectedClient {
  client: Client
  transport: StreamableHTTPClientTransport
}

async function connectClient(url: string, name: string): Promise<ConnectedClient> {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}

describe('McpSessionRouter', () => {
  it('lets a second client initialize a fresh session (PILOT-221 regression)', async () => {
    const { url, router } = await startHarness();

    const a = await connectClient(url, 'client-a');
    // The original single-transport server rejected this second `initialize`
    // with HTTP 400. With per-session transports it must succeed.
    const b = await connectClient(url, 'client-b');

    expect(router.sessionCount).toBe(2);

    // Both sessions remain independently usable.
    const toolsA = await a.client.listTools();
    const toolsB = await b.client.listTools();
    expect(toolsA.tools.length).toBeGreaterThan(0);
    expect(toolsB.tools.length).toBeGreaterThan(0);

    await a.client.close();
    await b.client.close();
  });

  it('tracks connected clients and prunes a terminated session', async () => {
    const { url, router } = await startHarness();

    const a = await connectClient(url, 'client-a');
    const b = await connectClient(url, 'client-b');
    expect(router.clientCount).toBe(2);
    expect(router.clientList.map(c => c.name).sort()).toEqual(['client-a', 'client-b']);

    // Explicitly terminate one session (HTTP DELETE). The other must stay
    // connected — one client leaving never wipes the others.
    await a.transport.terminateSession();
    await a.client.close();
    await waitFor(() => router.clientCount === 1);
    expect(router.clientList.map(c => c.name)).toEqual(['client-b']);

    await b.client.close();
  });

  it('reaps a session whose standby stream closes and is not resumed', async () => {
    // Mirrors the real bug: a client (e.g. Claude Code /mcp reconnect) drops and
    // re-initializes under a new id instead of resuming, so the old session would
    // linger forever and inflate the count. The reaper bounds that.
    const { url, router } = await startHarness({ sessionGraceMs: 50 });

    const a = await connectClient(url, 'client-a');
    const b = await connectClient(url, 'client-b');
    expect(router.sessionCount).toBe(2);

    // Drop one client's connection without an explicit DELETE.
    await a.transport.close();
    await a.client.close();

    await waitFor(() => router.sessionCount === 1 && router.clientCount === 1);
    expect(router.clientList.map(c => c.name)).toEqual(['client-b']);

    await b.client.close();
  });

  it('reaps an idle session with no live standby stream (sweep backstop)', async () => {
    // A client that initializes but never keeps a standby GET stream open (or
    // abandons it half-open on reconnect, so close never fires) would otherwise
    // linger forever. The idle sweep is the catch-all.
    const { url, router } = await startHarness({ idleTimeoutMs: 60, sweepIntervalMs: 20 });

    const sessionId = await rawInitialize(url);
    expect(sessionId).toBeTruthy();
    expect(router.sessionCount).toBe(1);

    // No further traffic and no standby stream → the sweep reaps it.
    await waitFor(() => router.sessionCount === 0);
  });

  it('rejects requests carrying an unknown session id with 400', async () => {
    const { url } = await startHarness();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });

  it('returns a JSON-RPC parse error (-32700) for malformed JSON', async () => {
    const { url } = await startHarness();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error?: { code?: number } };
    expect(json.error?.code).toBe(-32700);
  });

  it('returns 413 when the request body exceeds the limit', async () => {
    const { url } = await startHarness({ maxRequestBodyBytes: 64 });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(200) } }),
    });
    expect(res.status).toBe(413);
    const json = await res.json() as { error?: { message?: string } };
    expect(json.error?.message).toMatch(/Payload Too Large/i);
  });

  it('rejects a non-initialize POST with no session id with 400', async () => {
    const { url } = await startHarness();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });

  it('closes all sessions on router.close()', async () => {
    const { url, router, close } = await startHarness();
    await connectClient(url, 'client-a');
    await connectClient(url, 'client-b');
    expect(router.sessionCount).toBe(2);

    // close() is invoked by the harness teardown; call it explicitly here.
    await close();
    harnesses.length = 0;
    expect(router.sessionCount).toBe(0);
    expect(router.clientCount).toBe(0);
  });
});

/**
 * Initialize a session over raw HTTP without keeping a standby GET stream open
 * (simulating a POST-only or half-open client). Returns the new session id.
 */
async function rawInitialize(url: string): Promise<string | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  return sessionId;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

function makeDispatcher(): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({
      platform: 'android',
      package: 'com.example',
      device: 'emulator-5554',
      timeout: 5000,
      retries: 0,
      projects: [],
    }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: true }),
  };
}
