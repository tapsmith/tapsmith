import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  isLoopbackHost,
  isLoopbackOrigin,
  isSameOriginRequest,
  refuseForeignHost,
  createLocalWebSocketServer,
} from '../local-server-guard.js';

function req(headers: Record<string, string | undefined>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe('isLoopbackHost', () => {
  it.each([
    '127.0.0.1:8080', '127.0.0.1', 'localhost:9274', 'LOCALHOST:1', 'localhost', '[::1]:5000', '[::1]',
  ])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    undefined, '', 'evil.example', 'evil.example:8080', 'localhost.evil.example:8080', '127.0.0.1.nip.io:8080',
    '0.0.0.0:8080', '192.168.1.5:8080', '[::2]:8080', 'localhost:8080@evil',
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it.each([undefined, 'http://localhost:6274', 'http://127.0.0.1:9274', 'https://localhost', 'http://[::1]:3000'])(
    'accepts %s',
    (origin) => { expect(isLoopbackOrigin(origin)).toBe(true); },
  );

  it.each(['https://evil.example', 'http://localhost.evil.example', 'null', 'not a url', 'file:///tmp/x.html', 'chrome-extension://abc'])(
    'refuses %s',
    (origin) => { expect(isLoopbackOrigin(origin)).toBe(false); },
  );
});

describe('isSameOriginRequest', () => {
  it('accepts a request with no Origin (non-browser client)', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080' }))).toBe(true);
  });

  it('accepts the page the server itself served', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }))).toBe(true);
    expect(isSameOriginRequest(req({ host: 'localhost:8080', origin: 'http://localhost:8080' }))).toBe(true);
    expect(isSameOriginRequest(req({ host: 'LocalHost:8080', origin: 'http://localhost:8080' }))).toBe(true);
  });

  it('refuses another site, another loopback port, and opaque origins', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080', origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:3000' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080', origin: 'http://localhost:8080' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080', origin: 'null' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8080', origin: 'https://127.0.0.1:8080' }))).toBe(false);
  });

  it('refuses an Origin when the request has no Host', () => {
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:8080' }))).toBe(false);
  });
});

// ─── Real servers: the wiring the UI server, MCP endpoint and show-trace use ───

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Raw request, so the Host header can be anything (fetch forbids setting it). */
function rawGet(port: number, headers: Record<string, string>, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, headers, setHost: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('refuseForeignHost', () => {
  async function guarded(): Promise<number> {
    return listen(http.createServer((rq, rs) => {
      if (refuseForeignHost(rq, rs)) return;
      rs.writeHead(200);
      rs.end('ok');
    }));
  }

  it('serves loopback hosts', async () => {
    const port = await guarded();
    expect((await rawGet(port, { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await rawGet(port, { host: `localhost:${port}` })).status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
  });

  it('refuses a DNS-rebound host with 403 and a reason', async () => {
    const port = await guarded();
    const res = await rawGet(port, { host: `evil.example:${port}` });
    expect(res.status).toBe(403);
    expect(res.body).toContain('evil.example');
    expect(res.body).toMatch(/127\.0\.0\.1|localhost/);
  });

  it('refuses a request with no Host header', async () => {
    const port = await guarded();
    // Node answers 400 itself for HTTP/1.1 without Host; the guard covers the rest.
    expect([400, 403]).toContain((await rawGet(port, {})).status);
  });
});

describe('createLocalWebSocketServer', () => {
  async function start(onRefused?: (origin: string | undefined, host: string | undefined) => void): Promise<{ port: number; wss: WebSocketServer }> {
    const server = http.createServer();
    const wss = createLocalWebSocketServer(server, { onRefused });
    wss.on('connection', (ws) => ws.send('hello'));
    const port = await listen(server);
    return { port, wss };
  }

  function connect(port: number, headers: Record<string, string> = {}, origin?: string): Promise<{ ok: true } | { ok: false; status: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers, ...(origin ? { origin } : {}) });
      ws.once('message', () => { ws.close(); resolve({ ok: true }); });
      ws.once('unexpected-response', (_rq, res) => { resolve({ ok: false, status: res.statusCode ?? 0 }); ws.terminate(); });
      ws.once('error', () => { /* reported via unexpected-response */ });
    });
  }

  it('accepts its own page and non-browser clients', async () => {
    const { port } = await start();
    expect(await connect(port)).toEqual({ ok: true });
    expect(await connect(port, {}, `http://127.0.0.1:${port}`)).toEqual({ ok: true });
    expect(await connect(port, { host: `localhost:${port}` }, `http://localhost:${port}`)).toEqual({ ok: true });
  });

  it('refuses a page from another site with 403', async () => {
    const { port } = await start();
    expect(await connect(port, {}, 'https://evil.example')).toEqual({ ok: false, status: 403 });
  });

  it('refuses a page from another local app', async () => {
    const { port } = await start();
    expect(await connect(port, {}, 'http://127.0.0.1:3000')).toEqual({ ok: false, status: 403 });
  });

  it('refuses a DNS-rebound Host even when Origin matches it', async () => {
    const { port } = await start();
    expect(await connect(port, { host: `evil.example:${port}` }, `http://evil.example:${port}`)).toEqual({ ok: false, status: 403 });
  });

  it('reports each refused origin once', async () => {
    const onRefused = vi.fn();
    const { port } = await start(onRefused);
    await connect(port, {}, 'https://evil.example');
    await connect(port, {}, 'https://evil.example');
    await connect(port, {}, 'https://other.example');
    expect(onRefused).toHaveBeenCalledTimes(2);
    expect(onRefused).toHaveBeenNthCalledWith(1, 'https://evil.example', `127.0.0.1:${port}`);
  });
});
