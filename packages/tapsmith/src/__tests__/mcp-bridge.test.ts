import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest, type CallToolResult, type Implementation } from '@modelcontextprotocol/sdk/types.js';
import { DeviceClaimedError } from '../device-claims.js';
import { McpBridge, isDeviceUnavailableError, uiRequestNeverRan } from '../mcp/bridge.js';
import { assertNotHeldByUi, noDeviceMessage } from '../mcp/connection.js';
import { McpEventEmitter } from '../mcp/events.js';
import { McpSessionRouter } from '../mcp/http-session-router.js';
import type { UiSession } from '../mcp/ui-session.js';

// PILOT-1164: `tapsmith mcp-server --prefer-ui` passes each request to the
// project's running UI-mode session, or to a headless server when there is
// none, and moves between them as a UI session starts and ends.

/** A resolvable promise, to hold a tool call open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const textOf = (result: unknown): string =>
  ((result as CallToolResult).content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** What a stand-in backend was asked, and the gates its slow tool waits on. */
interface BackendProbe {
  calls: string[]
  started: Array<() => void>
  release: Array<() => void>
  clients: Implementation[]
}

function probe(): BackendProbe {
  return { calls: [], started: [], release: [], clients: [] };
}

/** A stand-in Tapsmith MCP server: `who` says which backend answered. */
function backendServer(who: string, p: BackendProbe): McpServer {
  const server = new McpServer({ name: `fake-${who}`, version: '0.0.0' });
  server.tool('who', `Says ${who}`, {}, () => {
    p.calls.push('who');
    return { content: [{ type: 'text' as const, text: who }] };
  });
  server.tool('tapsmith_session_info', 'Session info', {}, () => ({ content: [{ type: 'text' as const, text: `## Session\nfrom ${who}` }] }));
  server.tool('no_device', 'Fails for want of a device', {}, () => ({ isError: true, content: [{ type: 'text' as const, text: noDeviceMessage('android') }] }));
  server.tool('echo', 'Echo', { value: z.string() }, ({ value }) => ({ content: [{ type: 'text' as const, text: `${who}:${value}` }] }));
  server.tool('slow', 'Waits to be released, reporting progress', {}, async (_args, extra) => {
    p.calls.push('slow');
    const token = extra._meta?.progressToken;
    if (token !== undefined) {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: `${who} running` } });
    }
    const gate = deferred();
    p.release.push(gate.resolve);
    p.started.shift()?.();
    await Promise.race([gate.promise, new Promise<void>((resolve) => { extra.signal.addEventListener('abort', () => resolve()); })]);
    return { content: [{ type: 'text' as const, text: extra.signal.aborted ? `${who}:cancelled` : `${who}:done` }] };
  });
  server.resource('doc', 'tapsmith://api-reference', () => ({ contents: [{ uri: 'tapsmith://api-reference', text: `doc from ${who}` }] }));
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    if (client) p.clients.push(client);
  };
  return server;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An in-process backend client, and whether the bridge has closed it. */
async function inMemoryBackend(who: string, p: BackendProbe, info: Implementation): Promise<{ client: Client; closed: () => boolean }> {
  const server = backendServer(who, p);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(info, { capabilities: {} });
  await client.connect(clientSide);
  let closed = false;
  const close = client.close.bind(client);
  client.close = async () => { closed = true; await close(); };
  return { client, closed: () => closed };
}

interface Harness {
  agent: Client
  bridge: McpBridge
  ui: BackendProbe
  headless: BackendProbe
  /** Start or end the project's UI session, as discovery sees it. */
  setUiSession: (session: UiSession | undefined) => void
  headlessStarts: () => number
  headlessClosed: () => boolean[]
  uiConnects: () => number
  logs: string[]
}

const UI_SESSION: UiSession = { mcpUrl: 'http://127.0.0.1:9274/mcp', project: { cwd: '/work/app' }, pid: 4242, startedAt: '2026-11-11T10:00:00.000Z' };

/** A bridge between an agent client and in-process stand-ins for both backends. */
async function harness(opts: {
  uiSession?: UiSession
  connectUi?: (session: UiSession, info: Implementation) => Promise<Client>
  /** What asking the connected UI session says, when not simply whether it is still the one discovery finds. */
  probe?: () => 'alive' | 'gone' | 'unanswered' | undefined
} = {}): Promise<Harness> {
  const ui = probe();
  const headless = probe();
  let session = opts.uiSession;
  let uiConnects = 0;
  const headlessClosed: Array<() => boolean> = [];
  const logs: string[] = [];
  const bridge = new McpBridge({
    project: { cwd: '/work/app' },
    findUiSession: () => Promise.resolve(session),
    probeUiSession: (connected) => Promise.resolve(opts.probe?.() ?? (session?.mcpUrl === connected.mcpUrl ? 'alive' : 'gone')),
    connectUi: opts.connectUi ?? (async (_session, info) => {
      uiConnects++;
      return (await inMemoryBackend('ui', ui, info)).client;
    }),
    startHeadless: async (info) => {
      const backend = await inMemoryBackend('headless', headless, info);
      headlessClosed.push(backend.closed);
      return backend.client;
    },
    log: (line) => { logs.push(line); },
  });
  const [agentSide, bridgeSide] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(bridgeSide);
  const agent = new Client({ name: 'claude-code', version: '2.1.0' }, { capabilities: {} });
  await agent.connect(agentSide);
  cleanups.push(async () => {
    await agent.close();
    await bridge.close();
  });
  return {
    agent, bridge, ui, headless, logs,
    setUiSession: (s) => { session = s; },
    headlessStarts: () => headlessClosed.length,
    headlessClosed: () => headlessClosed.map((c) => c()),
    uiConnects: () => uiConnects,
  };
}

const who = async (agent: Client): Promise<string> => textOf(await agent.callTool({ name: 'who', arguments: {} })).split('\n')[0];

describe('McpBridge routing', () => {
  it('runs headless when no UI session is running, starting one headless server', async () => {
    const h = await harness();
    expect(await who(h.agent)).toBe('headless');
    expect(await who(h.agent)).toBe('headless');
    expect(h.headlessStarts()).toBe(1);
    expect(h.uiConnects()).toBe(0);
    expect(h.bridge.activeBackend).toBe('headless');
  });

  it('works in the UI session when one is running, and never starts a headless server', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    expect(await who(h.agent)).toBe('ui');
    expect(textOf(await h.agent.callTool({ name: 'echo', arguments: { value: 'hi' } }))).toBe('ui:hi');
    expect(h.headlessStarts()).toBe(0);
    expect(h.uiConnects()).toBe(1);
  });

  it('names the agent, not itself, to the backend', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    await who(h.agent);
    expect(h.ui.clients).toEqual([{ name: 'claude-code', version: '2.1.0' }]);
  });

  it('lists the tools and reads the resources of the backend in use', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    const { tools } = await h.agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(['who', 'tapsmith_session_info', 'no_device', 'echo', 'slow']);
    expect(tools.find((t) => t.name === 'who')?.description).toBe('Says ui');
    expect((await h.agent.listResources()).resources.map((r) => r.uri)).toEqual(['tapsmith://api-reference']);
    expect((await h.agent.readResource({ uri: 'tapsmith://api-reference' })).contents[0]).toMatchObject({ text: 'doc from ui' });
  });

  it('passes a tool\'s own error straight through', async () => {
    const h = await harness();
    const result = await h.agent.callTool({ name: 'echo', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/value/);
    await expect(h.agent.callTool({ name: 'nope', arguments: {} })).resolves.toMatchObject({ isError: true });
    // The headless server is still the backend: the request failed, not the server.
    expect(await who(h.agent)).toBe('headless');
    expect(h.headlessStarts()).toBe(1);
  });

  it('relays a run\'s progress to the agent', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    const progress: unknown[] = [];
    const started = deferred();
    h.ui.started.push(started.resolve);
    const call = h.agent.callTool({ name: 'slow', arguments: {} }, undefined, { onprogress: (p) => { progress.push(p); } });
    await started.promise;
    h.ui.release.shift()?.();
    expect(textOf(await call)).toBe('ui:done');
    expect(progress).toEqual([{ progress: 1, total: 2, message: 'ui running' }]);
  });

  it('cancels the backend\'s call when the agent cancels its own', async () => {
    const h = await harness();
    const started = deferred();
    h.headless.started.push(started.resolve);
    const abort = new AbortController();
    const call = h.agent.callTool({ name: 'slow', arguments: {} }, undefined, { signal: abort.signal });
    await started.promise;
    abort.abort('stop');
    await expect(call).rejects.toThrow();
    // The stand-in's handler saw the cancellation and returned.
    await expect.poll(() => h.bridge.activeBackend).toBe('headless');
    expect(await who(h.agent)).toBe('headless');
  });
});

describe('McpBridge: a UI session that starts or ends after the agent connected', () => {
  it('moves to a UI session started later on the next call, and ends the headless session', async () => {
    const h = await harness();
    expect(await who(h.agent)).toBe('headless');
    h.setUiSession(UI_SESSION);
    const result = await h.agent.callTool({ name: 'who', arguments: {} });
    expect(textOf(result)).toMatch(/^ui\nNote: a UI-mode session is now running for this project, so this call ran in it \(http:\/\/127\.0\.0\.1:9274\/mcp\)/);
    expect(h.headlessClosed()).toEqual([true]);
    // Said once.
    expect(textOf(await h.agent.callTool({ name: 'who', arguments: {} }))).toBe('ui');
    expect(h.logs).toContain('Working in the UI-mode session at http://127.0.0.1:9274/mcp.');
  });

  it('keeps a headless run in flight, and the calls made during it, headless; then moves', async () => {
    const h = await harness();
    const started = deferred();
    h.headless.started.push(started.resolve);
    const run = h.agent.callTool({ name: 'slow', arguments: {} });
    await started.promise;
    h.setUiSession(UI_SESSION);
    // stop_tests and suite_status must reach the run that is going.
    expect(await who(h.agent)).toBe('headless');
    expect(h.bridge.activeBackend).toBe('headless');
    expect(h.uiConnects()).toBe(0);
    h.headless.release.shift()?.();
    expect(textOf(await run)).toBe('headless:done');
    expect(await who(h.agent)).toBe('ui');
    expect(h.headlessClosed()).toEqual([true]);
  });

  it('runs headless again once the UI session has gone', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    expect(await who(h.agent)).toBe('ui');
    h.setUiSession(undefined);
    const result = await h.agent.callTool({ name: 'who', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/^headless\nNote: the UI-mode session this server was working in has ended, so this call ran headless/);
    expect(h.headlessStarts()).toBe(1);
    expect(h.ui.calls).toEqual(['who']);
    expect(h.logs).toContain('The UI-mode session at http://127.0.0.1:9274/mcp has ended.');
  });

  it('moves to the UI session that replaced the one it was working in', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    expect(await who(h.agent)).toBe('ui');
    h.setUiSession({ ...UI_SESSION, mcpUrl: 'http://127.0.0.1:50999/mcp', pid: 4343 });
    expect(await who(h.agent)).toBe('ui');
    expect(h.uiConnects()).toBe(2);
    expect(h.headlessStarts()).toBe(0);
  });

  it('stays with a UI session that is too busy to say it is still there', async () => {
    const h = await harness({ uiSession: UI_SESSION, probe: () => 'unanswered' });
    expect(await who(h.agent)).toBe('ui');
    // Discovery would not find it either: it is not asked.
    h.setUiSession(undefined);
    expect(await who(h.agent)).toBe('ui');
    expect(h.uiConnects()).toBe(1);
    expect(h.headlessStarts()).toBe(0);
  });

  it('falls back to headless when the UI session cannot be connected to', async () => {
    const h = await harness({ uiSession: UI_SESSION, connectUi: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    expect(await who(h.agent)).toBe('headless');
    expect(h.logs).toContain('Could not connect to the UI-mode session at http://127.0.0.1:9274/mcp (connect ECONNREFUSED); running headless.');
  });

  it('starts a new headless server when the last one died', async () => {
    const h = await harness();
    expect(await who(h.agent)).toBe('headless');
    // The child exits by itself.
    await (h.bridge as unknown as { _headless: { client: Client } })._headless.client.close();
    expect(await who(h.agent)).toBe('headless');
    expect(h.headlessStarts()).toBe(2);
  });
});

describe('McpBridge.yieldHeadless', () => {
  it('ends an idle headless session, and the next call starts another', async () => {
    const h = await harness();
    await who(h.agent);
    expect(h.bridge.yieldHeadless()).toBe(true);
    expect(h.headlessClosed()).toEqual([true]);
    expect(h.bridge.activeBackend).toBeUndefined();
    expect(await who(h.agent)).toBe('headless');
    expect(h.headlessStarts()).toBe(2);
  });

  it('refuses while a headless call is running, and when there is no headless session', async () => {
    const h = await harness();
    expect(h.bridge.yieldHeadless()).toBe(false);
    const started = deferred();
    h.headless.started.push(started.resolve);
    const run = h.agent.callTool({ name: 'slow', arguments: {} });
    await started.promise;
    expect(h.bridge.yieldHeadless()).toBe(false);
    expect(h.headlessClosed()).toEqual([false]);
    h.headless.release.shift()?.();
    expect(textOf(await run)).toBe('headless:done');
  });
});

describe('McpBridge: tapsmith_session_info', () => {
  it('says it is headless and how to watch the agent work', async () => {
    const h = await harness();
    const text = textOf(await h.agent.callTool({ name: 'tapsmith_session_info', arguments: {} }));
    expect(text).toContain('## Session\nfrom headless');
    expect(text).toContain('## Mode\nHeadless: no UI-mode session is running for this project. '
      + 'To watch the agent work, the user can run `npx tapsmith test --ui` in /work/app;');
  });

  it('names the UI session it is working in', async () => {
    const h = await harness({ uiSession: UI_SESSION });
    const text = textOf(await h.agent.callTool({ name: 'tapsmith_session_info', arguments: {} }));
    expect(text).toContain('## Session\nfrom ui');
    expect(text).toContain('## Mode\nUI mode: working in the running UI-mode session at http://127.0.0.1:9274/mcp (pid 4242).');
  });
});

describe('McpBridge: headless device errors', () => {
  it('adds how to start a UI session to a headless no-device error', async () => {
    const h = await harness();
    const result = await h.agent.callTool({ name: 'no_device', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `${noDeviceMessage('android')}\n`
      + 'This server is running headless. It works in this project\'s UI-mode session whenever one is running: '
      + 'the user can start one with `npx tapsmith test --ui` in /work/app and watch the agent work. If one is starting now, call again once it is up.',
    );
  });

  it('leaves a UI session\'s errors, and other headless errors, as they are', async () => {
    const ui = await harness({ uiSession: UI_SESSION });
    expect(textOf(await ui.agent.callTool({ name: 'no_device', arguments: {} }))).toBe(noDeviceMessage('android'));
    const headless = await harness();
    expect(textOf(await headless.agent.callTool({ name: 'echo', arguments: {} }))).not.toContain('running headless');
  });

  // The matcher reads messages written elsewhere: these are those messages.
  it('recognises the messages for no device, a held device and a claimed device', () => {
    const thrown = (fn: () => void): string => {
      try { fn(); } catch (err) { return (err as Error).message; }
      throw new Error('did not throw');
    };
    const held = new Set(['emulator-5554']);
    const messages = [
      noDeviceMessage(),
      noDeviceMessage('ios'),
      noDeviceMessage('android', undefined, [], ['emulator-5554']),
      noDeviceMessage('android', 'emulator-5556', ['emulator-5554']),
      noDeviceMessage('android', 'emulator-5556'),
      noDeviceMessage('android', 'emulator-5556', ['emulator-5554'], [], 'run_tests'),
      noDeviceMessage('android', 'emulator-5556', [], [], 'run_tests'),
      thrown(() => assertNotHeldByUi('emulator-5554', held)),
      thrown(() => assertNotHeldByUi('emulator-5554', held, 'bob')),
      thrown(() => assertNotHeldByUi('emulator-5554', held, undefined, 'run_tests')),
      new DeviceClaimedError('emulator-5554', {
        device: 'emulator-5554',
        session: { id: 's', pid: 1, command: 'tapsmith test --ui', project: '/work/app', startedAt: '2026-11-11T10:00:00.000Z' },
        claimantPid: 1,
        claimedAt: '2026-11-11T10:00:00.000Z',
      }).message,
    ];
    for (const message of messages) expect(isDeviceUnavailableError(message), message).toBe(true);
  });

  it('does not take other failures for one', () => {
    expect(isDeviceUnavailableError('No element matches getByText("Save") within 5000ms.')).toBe(false);
    expect(isDeviceUnavailableError('Unknown project "ios". Available: android.')).toBe(false);
    expect(isDeviceUnavailableError('The config failed to load: tapsmith.config.ts')).toBe(false);
  });
});

describe('uiRequestNeverRan', () => {
  it('is true when nothing listened, or the server does not know the session', () => {
    expect(uiRequestNeverRan(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }))).toBe(true);
    expect(uiRequestNeverRan(new StreamableHTTPError(400, 'Bad Request: No valid session ID provided'))).toBe(true);
    expect(uiRequestNeverRan(new StreamableHTTPError(404, 'Session not found'))).toBe(true);
  });

  it('is false for a failure that may have followed the request', () => {
    expect(uiRequestNeverRan(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }))).toBe(false);
    expect(uiRequestNeverRan(new StreamableHTTPError(500, 'Internal Server Error'))).toBe(false);
    expect(uiRequestNeverRan(new Error('terminated'))).toBe(false);
  });
});

// ─── Over real HTTP ───

/** A real Streamable-HTTP MCP endpoint of stand-in servers, one per MCP session. */
async function httpBackend(p: BackendProbe): Promise<{ url: string; server: http.Server; forgetSessions: () => void; kill: () => Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url === '/api/daemon-ports') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project: UI_SESSION.project, pid: UI_SESSION.pid, startedAt: UI_SESSION.startedAt }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'POST' && !sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport); },
        });
        await backendServer('ui', p).connect(transport as Transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }));
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const kill = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  };
  cleanups.push(kill);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, server, forgetSessions: () => transports.clear(), kill };
}

/** A bridge whose UI backend is reached over real HTTP (the default connection). */
async function httpHarness(url: string): Promise<Harness> {
  const headless = probe();
  let session: UiSession | undefined = { ...UI_SESSION, mcpUrl: url };
  const headlessClosed: Array<() => boolean> = [];
  const logs: string[] = [];
  const bridge = new McpBridge({
    project: { cwd: '/work/app' },
    findUiSession: () => Promise.resolve(session),
    startHeadless: async (info) => {
      const backend = await inMemoryBackend('headless', headless, info);
      headlessClosed.push(backend.closed);
      return backend.client;
    },
    log: (line) => { logs.push(line); },
  });
  const [agentSide, bridgeSide] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(bridgeSide);
  const agent = new Client({ name: 'codex', version: '0.163.0' }, { capabilities: {} });
  await agent.connect(agentSide);
  cleanups.push(async () => {
    await agent.close();
    await bridge.close();
  });
  return {
    agent, bridge, ui: probe(), headless, logs,
    setUiSession: (s) => { session = s; },
    headlessStarts: () => headlessClosed.length,
    headlessClosed: () => headlessClosed.map((c) => c()),
    uiConnects: () => 0,
  };
}

describe('McpBridge over a real HTTP endpoint', () => {
  it('calls tools in the UI session and relays progress', async () => {
    const p = probe();
    const ui = await httpBackend(p);
    const h = await httpHarness(ui.url);
    expect(await who(h.agent)).toBe('ui');
    expect(p.clients).toEqual([{ name: 'codex', version: '0.163.0' }]);
    const progress: unknown[] = [];
    const started = deferred();
    p.started.push(started.resolve);
    const call = h.agent.callTool({ name: 'slow', arguments: {} }, undefined, { onprogress: (x) => { progress.push(x); } });
    await started.promise;
    p.release.shift()?.();
    expect(textOf(await call)).toBe('ui:done');
    expect(progress).toEqual([{ progress: 1, total: 2, message: 'ui running' }]);
  });

  it('reconnects and sends the call again when the UI session no longer knows its MCP session', async () => {
    const p = probe();
    const ui = await httpBackend(p);
    const h = await httpHarness(ui.url);
    expect(await who(h.agent)).toBe('ui');
    // The UI session was restarted on the same port (or reaped ours while idle).
    ui.forgetSessions();
    const result = await h.agent.callTool({ name: 'who', arguments: {} });
    expect(textOf(result)).toBe('ui');
    expect(p.calls).toEqual(['who', 'who']);
    expect(p.clients).toHaveLength(2);
    expect(h.headlessStarts()).toBe(0);
  });

  it('runs headless from the next call when the UI session has exited', async () => {
    const ui = await httpBackend(probe());
    const h = await httpHarness(ui.url);
    expect(await who(h.agent)).toBe('ui');
    await ui.kill();
    h.setUiSession(undefined);
    const result = await h.agent.callTool({ name: 'who', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/^headless\nNote: the UI-mode session this server was working in has ended/);
  });

  it('fails a call the UI session died under, saying it may not have completed, and runs headless next', async () => {
    const p = probe();
    const ui = await httpBackend(p);
    const h = await httpHarness(ui.url);
    const started = deferred();
    p.started.push(started.resolve);
    const call = h.agent.callTool({ name: 'slow', arguments: {} });
    await started.promise;
    await ui.kill();
    h.setUiSession(undefined);
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `The UI-mode session at ${ui.url} ended (or stopped answering) while this call was running, so it may not have completed. `
      + 'Call again: this server runs headless when no UI-mode session is running for the project.',
    );
    expect(await who(h.agent)).toMatch(/^headless/);
    // Sent once: a call that may have run is never sent again.
    expect(p.calls).toEqual(['slow']);
  });

  it('works against the UI server\'s own MCP router, reconnecting after it drops the session', async () => {
    const router = new McpSessionRouter({ name: 'tapsmith-ui', events: new McpEventEmitter(), sweepIntervalMs: 0, keepAliveIntervalMs: 0 });
    const server = http.createServer((req, res) => {
      if (req.url === '/api/daemon-ports') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project: UI_SESSION.project, pid: UI_SESSION.pid, startedAt: UI_SESSION.startedAt }));
      } else {
        void router.handleRequest(req, res);
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(async () => {
      router.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    });
    const h = await httpHarness(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const names = async (): Promise<string[]> => (await h.agent.listTools()).tools.map((t) => t.name);
    expect(await names()).toContain('tapsmith_snapshot');
    expect(router.clientList).toEqual([{ name: 'codex', version: '0.163.0' }]);
    router.close();
    expect(router.sessionCount).toBe(0);
    expect(await names()).toContain('tapsmith_snapshot');
    expect(router.sessionCount).toBe(1);
    expect(h.headlessStarts()).toBe(0);
  });
});
