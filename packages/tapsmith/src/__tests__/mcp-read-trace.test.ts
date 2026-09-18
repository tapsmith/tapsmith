import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// `tapsmith_read_trace` is how an agent finds out why a test failed, and it is
// the one tool that reads a file rather than a device. It had no coverage at
// all: not the archive it parses, not the log filtering that keeps a failed
// run's output small enough to reason about, not the two guards on the path.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-read-trace-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTrace(options: {
  name?: string
  events?: object[]
  metadata?: object | null
  screenshots?: Record<string, Buffer>
}): string {
  const files: Record<string, Uint8Array> = {};
  const encode = (s: string) => new TextEncoder().encode(s);
  if (options.metadata !== null) {
    files['metadata.json'] = encode(JSON.stringify(options.metadata ?? { version: 1 }));
  }
  if (options.events) {
    files['trace.json'] = encode(options.events.map((e) => JSON.stringify(e)).join('\n'));
  }
  for (const [name, data] of Object.entries(options.screenshots ?? {})) {
    files[`screenshots/${name}`] = new Uint8Array(data);
  }
  const target = path.join(tmpDir, options.name ?? 'trace.zip');
  fs.writeFileSync(target, zipSync(files));
  return target;
}

async function readTrace(args: Record<string, unknown>): Promise<CallToolResult> {
  const server = createMcpServer();
  const client = new Client({ name: 'read-trace-probe', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    return await client.callTool({ name: 'tapsmith_read_trace', arguments: args }) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function text(res: CallToolResult): string {
  return res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('tapsmith_read_trace path handling', () => {
  it('refuses anything that is not a .zip', async () => {
    const res = await readTrace({ path: path.join(tmpDir, 'trace.json') });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('must be a .zip file');
  });

  it('names the resolved path when the trace is not there', async () => {
    const missing = path.join(tmpDir, 'gone.zip');
    const res = await readTrace({ path: missing });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(`Trace file not found: ${missing}`);
  });

  it('resolves a relative path against the working directory', async () => {
    // Relative to the runner's cwd rather than chdir'ing into the fixture:
    // `process.chdir` is worker-global, and throws outright under vitest's
    // threads pool.
    const trace = writeTrace({ events: [{ type: 'action', action: 'tap' }] });
    const relative = path.relative(process.cwd(), trace);
    expect(path.isAbsolute(relative)).toBe(false);
    const res = await readTrace({ path: relative });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('tap');
  });

  it('reports a corrupt archive rather than throwing out of the tool', async () => {
    const broken = path.join(tmpDir, 'broken.zip');
    fs.writeFileSync(broken, Buffer.from('not really a zip'));
    const res = await readTrace({ path: broken });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Failed to read trace');
  });
});

describe('tapsmith_read_trace step rendering', () => {
  it('reports the device and test the trace came from', async () => {
    const trace = writeTrace({
      metadata: { device: { model: 'iPhone 16', platform: 'ios' }, testFile: 'login.test.ts', duration: 4200 },
      events: [],
    });
    const out = text(await readTrace({ path: trace }));
    expect(out).toContain('Device: iPhone 16 (ios)');
    expect(out).toContain('Test: login.test.ts');
    expect(out).toContain('Duration: 4200ms');
  });

  it('marks the step that failed, and shows what was expected', async () => {
    const trace = writeTrace({
      events: [
        { type: 'action', action: 'tap', selector: 'device.getByText("Login")', duration: 120 },
        { type: 'assertion', assertion: 'toHaveText', expected: 'Welcome', actual: 'Error', error: 'Timed out', duration: 5000 },
      ],
    });
    const out = text(await readTrace({ path: trace }));
    expect(out).toContain('1. [OK] tap (120ms)');
    expect(out).toContain('Locator: device.getByText("Login")');
    expect(out).toContain('2. [FAIL] expect toHaveText (5000ms)');
    expect(out).toContain('Expected: Welcome');
    expect(out).toContain('Actual: Error');
    expect(out).toContain('Error: Timed out');
  });

  it('titles each test with its group marker', async () => {
    const trace = writeTrace({
      events: [
        { type: 'group-start', title: 'signs in with a valid password' },
        { type: 'action', action: 'tap' },
      ],
    });
    expect(text(await readTrace({ path: trace }))).toContain('### signs in with a valid password');
  });

  it('skips a line the writer left unparseable instead of failing the read', async () => {
    const target = path.join(tmpDir, 'trace.zip');
    const ndjson = [
      JSON.stringify({ type: 'action', action: 'tap' }),
      '{ half a line',
      JSON.stringify({ type: 'action', action: 'swipe' }),
    ].join('\n');
    fs.writeFileSync(target, zipSync({ 'trace.json': new TextEncoder().encode(ndjson) }));
    const out = text(await readTrace({ path: target }));
    expect(out).toContain('tap');
    expect(out).toContain('swipe');
    expect(out).toContain('## Steps (2 events)');
  });
});

describe('tapsmith_read_trace device logs', () => {
  const events = [
    { type: 'action', action: 'tap' },
    { type: 'console', source: 'device', level: 'info', message: 'render complete' },
    { type: 'console', source: 'device', level: 'warn', message: 'slow frame' },
    { type: 'console', source: 'device', level: 'error', message: 'unhandled rejection' },
    { type: 'console', source: 'test', level: 'error', message: 'from the runner, not the device' },
  ];

  it('shows only errors and warnings by default', async () => {
    const out = text(await readTrace({ path: writeTrace({ events }) }));
    expect(out).toContain('[ERROR] unhandled rejection');
    expect(out).toContain('[WARN] slow frame');
    expect(out).not.toContain('render complete');
    expect(out).toContain('## Device Logs (2 entries)');
  });

  it('includes every level when asked for all', async () => {
    const out = text(await readTrace({ path: writeTrace({ events }), device_logs: 'all' }));
    expect(out).toContain('[INFO] render complete');
    expect(out).toContain('## Device Logs (3 entries)');
  });

  it('leaves the logs out entirely when asked for none', async () => {
    const out = text(await readTrace({ path: writeTrace({ events }), device_logs: 'none' }));
    expect(out).not.toContain('Device Logs');
    expect(out).toContain('tap');
  });

  it('never mixes runner output in with the device log', async () => {
    const out = text(await readTrace({ path: writeTrace({ events }), device_logs: 'all' }));
    expect(out).not.toContain('from the runner, not the device');
  });

  it('caps a flood of errors and says how many there really were', async () => {
    // A crashing app can log thousands of lines; handing them all to an agent
    // costs more context than the failure is worth.
    const flood = Array.from({ length: 60 }, (_, i) => ({
      type: 'console', source: 'device', level: 'error', message: `error ${i}`,
    }));
    const out = text(await readTrace({ path: writeTrace({ events: flood }) }));
    expect(out).toContain('## Device Logs (60 entries, showing last 50)');
    expect(out).toContain('error 59');
    expect(out).not.toContain('error 9\n');
  });

  it('rejects a log level it does not know', async () => {
    const res = await readTrace({ path: writeTrace({ events }), device_logs: 'verbose' });
    expect(res.isError).toBe(true);
  });
});

describe('tapsmith_read_trace screenshots', () => {
  it('leaves screenshots out unless asked', async () => {
    const trace = writeTrace({
      events: [{ type: 'action', action: 'tap' }],
      screenshots: { '001.png': PNG },
    });
    const res = await readTrace({ path: trace });
    expect(res.content.every((c) => c.type === 'text')).toBe(true);
  });

  it('returns each screenshot as an image, labelled and in order', async () => {
    const trace = writeTrace({
      events: [{ type: 'action', action: 'tap' }],
      screenshots: { '002-after.png': PNG, '001-before.png': PNG },
    });
    const res = await readTrace({ path: trace, include_screenshots: true });
    const images = res.content.filter((c) => c.type === 'image') as Array<{ data: string; mimeType: string }>;
    expect(images).toHaveLength(2);
    expect(images[0].mimeType).toBe('image/png');
    expect(Buffer.from(images[0].data, 'base64')).toEqual(PNG);

    const labels = res.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .filter((t) => t.includes('### Screenshot:'));
    expect(labels).toEqual(['\n### Screenshot: 001-before', '\n### Screenshot: 002-after']);
  });
});
