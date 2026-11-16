import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isLoopbackHost,
  isSameOriginRequest,
  createLocalHttpServer,
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
function rawGet(port: number, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', method, headers, setHost: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('createLocalHttpServer', () => {
  async function guarded(): Promise<number> {
    return listen(createLocalHttpServer((_rq, rs) => {
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

  it('serves its own page and refuses every other page, local or not', async () => {
    const port = await guarded();
    expect((await rawGet(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, 'POST')).status).toBe(200);
    // A page on another local port (a dev server, any local tool) posting a
    // CORS "simple" request needs no preflight, so only the server can stop it.
    const other = await rawGet(port, { host: `127.0.0.1:${port}`, origin: 'http://localhost:3000' }, 'POST');
    expect(other.status).toBe(403);
    expect(other.body).toContain('http://localhost:3000');
    expect((await rawGet(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }, 'POST')).status).toBe(403);
    expect((await rawGet(port, { host: `127.0.0.1:${port}`, origin: 'null' }, 'POST')).status).toBe(403);
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

// Every HTTP or WebSocket server Tapsmith opens must go through the guarded
// factories above — a raw `http.createServer` or `new WebSocketServer` would
// let any web page in the browser reach it again (PILOT-1215).
describe('local listeners', () => {
  it('are all created through local-server-guard', () => {
    const srcDir = path.resolve(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || full.endsWith('local-server-guard.ts')) continue;
        const text = fs.readFileSync(full, 'utf-8');
        text.split('\n').forEach((line, i) => {
          if (/\bhttps?\.createServer\(|\bnew\s+WebSocketServer\(|\bnew\s+WebSocket\.Server\(/.test(line)) {
            offenders.push(`${path.relative(srcDir, full)}:${i + 1}`);
          }
        });
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
