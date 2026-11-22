import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { zipSync } from 'fflate';

// We need to test the server module. Mock `open` to avoid opening a browser.
import { vi } from 'vitest';
vi.mock('open', () => ({ default: vi.fn() }));

import { showTrace } from '../trace/show-trace-server.js';
import { TRACE_FORMAT_VERSION } from '../trace/trace-format.js';

describe('showTrace', () => {
  let cleanup: (() => void) | undefined;
  let tempDir: string;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createDummyTrace(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    const metadata = { version: TRACE_FORMAT_VERSION, testName: 'test', testStatus: 'passed', testDuration: 100, device: { serial: 'emu' } };
    const zipData = zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify(metadata)),
      'trace.json': new TextEncoder().encode(''),
    });
    const tracePath = path.join(tempDir, 'trace.zip');
    fs.writeFileSync(tracePath, zipData);
    return tracePath;
  }

  it('starts server and serves trace zip', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    expect(result.port).toBeGreaterThan(0);

    // Fetch the trace zip
    const resp = await fetch(`http://127.0.0.1:${result.port}/trace.zip`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('application/zip');
  });

  it('serves viewer HTML at root', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    const resp = await fetch(`http://127.0.0.1:${result.port}/`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/html');
  });

  it('returns 404 for unknown paths', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    const resp = await fetch(`http://127.0.0.1:${result.port}/unknown`);
    expect(resp.status).toBe(404);
  });

  // PILOT-1215: another web page must not be able to read the local trace —
  // neither cross-origin (no CORS grant) nor through a DNS-rebound hostname.
  it('does not grant other origins read access to the trace', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    const resp = await fetch(`http://127.0.0.1:${result.port}/trace.zip`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses requests addressed to a non-loopback host', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    const status = await new Promise<number>((resolve, reject) => {
      http.request(
        { host: '127.0.0.1', port: result.port, path: '/trace.zip', headers: { host: `evil.example:${result.port}` }, setHost: false },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      ).on('error', reject).end();
    });
    expect(status).toBe(403);
  });

  it('throws for non-existent trace file', async () => {
    await expect(showTrace({ tracePath: '/tmp/nonexistent.zip' })).rejects.toThrow('not found');
  });

  it('returns the URL it opened, which loads the trace', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    expect(result.url).toBe(`http://127.0.0.1:${result.port}/?trace=/trace.zip`);
    const open = (await import('open')).default as unknown as ReturnType<typeof vi.fn>;
    expect(open).toHaveBeenLastCalledWith(result.url);
  });

  function writeTraceFile(name: string, data: Uint8Array | string): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, data);
    return file;
  }

  it('refuses a corrupt archive before starting a server or opening a browser', async () => {
    const open = (await import('open')).default as unknown as ReturnType<typeof vi.fn>;
    open.mockClear();
    const tracePath = writeTraceFile('bad.zip', 'this is not a zip archive');
    await expect(showTrace({ tracePath, port: 0 })).rejects.toThrow(/Not a readable trace archive: .*bad\.zip/);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a zip that is not a Tapsmith trace', async () => {
    const open = (await import('open')).default as unknown as ReturnType<typeof vi.fn>;
    open.mockClear();
    const tracePath = writeTraceFile('other.zip', zipSync({ 'readme.txt': new TextEncoder().encode('hi') }));
    await expect(showTrace({ tracePath, port: 0 })).rejects.toThrow(/Not a Tapsmith trace/);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a trace in a newer format version, naming the upgrade', async () => {
    const metadata = { version: TRACE_FORMAT_VERSION + 1, tapsmithVersion: '99.0.0' };
    const tracePath = writeTraceFile('newer.zip', zipSync({ 'metadata.json': new TextEncoder().encode(JSON.stringify(metadata)) }));
    await expect(showTrace({ tracePath, port: 0 })).rejects.toThrow(/Upgrade Tapsmith/);
  });

  it('refuses a trace whose metadata.json is not JSON', async () => {
    const tracePath = writeTraceFile('badmeta.zip', zipSync({ 'metadata.json': new TextEncoder().encode('{not json') }));
    await expect(showTrace({ tracePath, port: 0 })).rejects.toThrow(/Not a Tapsmith trace/);
  });

  it('throws for non-zip file', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    const txtPath = path.join(tempDir, 'trace.txt');
    fs.writeFileSync(txtPath, 'not a zip');
    await expect(showTrace({ tracePath: txtPath })).rejects.toThrow('.zip');
  });
});
