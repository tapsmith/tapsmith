import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/index.js';
import { TRACE_FORMAT_VERSION } from '../trace/trace-format.js';
import { MCP_RESPONSE_MAX_BYTES } from '../mcp/response-limits.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect as tapsmithExpect } from '../expect.js';
import { TraceCollector, setActiveTraceCollector } from '../trace/trace-collector.js';
import type { TraceConfig } from '../trace/types.js';

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

describe('tapsmith_read_trace format version', () => {
  it('reads a v1 archive recorded before paths became relative', async () => {
    const trace = writeTrace({
      metadata: { version: 1, testFile: '/home/runner/work/app/e2e/login.test.ts' },
      events: [{ type: 'action', action: 'tap' }],
    });
    const res = await readTrace({ path: trace });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('File: /home/runner/work/app/e2e/login.test.ts');
    expect(text(res)).not.toContain('relative to');
  });

  it('says what a v2 test path is relative to, so an agent does not resolve it against its own cwd', async () => {
    const trace = writeTrace({
      metadata: { version: 2, testFile: 'tests/login.test.ts' },
      events: [{ type: 'action', action: 'tap' }],
    });
    const out = text(await readTrace({ path: trace }));
    expect(out).toContain("File: tests/login.test.ts (relative to the project's rootDir)");
  });

  it('refuses an archive from a newer format instead of misreading it', async () => {
    const trace = writeTrace({
      metadata: { version: TRACE_FORMAT_VERSION + 1, tapsmithVersion: '9.9.9' },
      events: [{ type: 'action', action: 'tap' }],
    });
    const res = await readTrace({ path: trace });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`format version ${TRACE_FORMAT_VERSION + 1}`);
    expect(text(res)).toContain('Tapsmith 9.9.9');
    expect(text(res)).not.toContain('tap');
  });

  it('refuses a zip that is not a Tapsmith trace', async () => {
    for (const metadata of [null, {}]) {
      const res = await readTrace({ path: writeTrace({ metadata, events: [] }) });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('Not a Tapsmith trace');
    }
  });
});

describe('tapsmith_read_trace step rendering', () => {
  it('reports the device and test the trace came from', async () => {
    const trace = writeTrace({
      metadata: { version: 2, device: { model: 'iPhone 16', platform: 'ios' }, testFile: 'login.test.ts', duration: 4200 },
      events: [],
    });
    const out = text(await readTrace({ path: trace }));
    expect(out).toContain('Device: iPhone 16 (ios)');
    expect(out).toContain('File: login.test.ts');
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

  it('titles each group with the name the collector records', async () => {
    // The collector writes `name` (GroupTraceEvent); the reader once looked
    // for `title`, so every group printed as "### Test".
    const trace = writeTrace({
      events: [
        { type: 'group-start', name: 'signs in with a valid password' },
        { type: 'action', action: 'tap' },
      ],
    });
    expect(text(await readTrace({ path: trace }))).toContain('### signs in with a valid password');
  });

  it('marks a step the trace recorded as unsuccessful even with no error text', async () => {
    const trace = writeTrace({
      events: [
        { type: 'action', action: 'tap', success: false },
        { type: 'assertion', assertion: 'toBeVisible', passed: false },
        { type: 'action', action: 'swipe', success: true },
      ],
    });
    const out = text(await readTrace({ path: trace }));
    expect(out).toContain('1. [FAIL] tap');
    expect(out).toContain('2. [FAIL] expect toBeVisible');
    expect(out).toContain('3. [OK] swipe');
  });

  it('skips a line the writer left unparseable instead of failing the read', async () => {
    const target = path.join(tmpDir, 'trace.zip');
    const ndjson = [
      JSON.stringify({ type: 'action', action: 'tap' }),
      '{ half a line',
      JSON.stringify({ type: 'action', action: 'swipe' }),
    ].join('\n');
    fs.writeFileSync(target, zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify({ version: 1 })),
      'trace.json': new TextEncoder().encode(ndjson),
    }));
    const out = text(await readTrace({ path: target }));
    expect(out).toContain('tap');
    expect(out).toContain('swipe');
    expect(out).toContain('## Steps (2 events)');
  });
});

// PILOT-917: an agent reading a failed trace saw every step [OK] and never the
// word "error" — the test's own status and error live in metadata.json.
describe('tapsmith_read_trace test result', () => {
  const failedMeta = {
    version: 2,
    testFile: 'tests/settings.test.ts',
    testName: 'settings > toggles dark mode',
    testStatus: 'failed',
    error: 'TypeError: expect(...).toBeSelected is not a function',
    device: { model: 'Pixel 9', platform: 'android' },
  };

  it('leads with the test name, its status and its error when no step failed', async () => {
    const trace = writeTrace({
      metadata: failedMeta,
      events: [
        { type: 'action', action: 'tap', success: true, duration: 80 },
        { type: 'assertion', assertion: 'toBeVisible', passed: true, duration: 40 },
        { type: 'console', source: 'device', level: 'error', message: 'unrelated device noise' },
      ],
    });
    const out = text(await readTrace({ path: trace }));
    const header = out.slice(0, out.indexOf('## Steps'));
    expect(out.startsWith('## Result')).toBe(true);
    expect(header).toContain('Test: settings > toggles dark mode');
    expect(header).toContain('Status: failed');
    expect(header).toContain('Error: TypeError: expect(...).toBeSelected is not a function');
    // Every step passed, so say where the error did not come from.
    expect(header).toContain('No traced step failed');
    // The error comes before the steps and the device logs.
    expect(out.indexOf('toBeSelected')).toBeLessThan(out.indexOf('1. [OK] tap'));
    expect(out.indexOf('toBeSelected')).toBeLessThan(out.indexOf('unrelated device noise'));
  });

  it('names the failing step in the header', async () => {
    const trace = writeTrace({
      metadata: { ...failedMeta, error: 'Timed out waiting for text "Welcome"' },
      events: [
        { type: 'group-start', name: 'toggles dark mode' },
        { type: 'action', action: 'tap', selector: 'getByText("Login")', success: true },
        { type: 'assertion', assertion: 'toHaveText', passed: false, error: 'Timed out waiting for text "Welcome"' },
      ],
    });
    const out = text(await readTrace({ path: trace }));
    const header = out.slice(0, out.indexOf('## Steps'));
    // Step numbers count events, so the group marker is event 1.
    expect(header).toContain('Failed step: 3. expect toHaveText');
    expect(header).not.toContain('No traced step failed');
    expect(out).toContain('3. [FAIL] expect toHaveText');
  });

  // The trace writer records every assertion with `soft: false`, so the
  // fixtures below do too: the reader must not lean on that field.
  it('does not blame a step whose failure the test caught when the error came from elsewhere', async () => {
    // try { await tap() } catch {} around an optional dialog, then a TypeError
    // in the test body: the caught tap is [FAIL] but did not fail the test.
    const trace = writeTrace({
      metadata: failedMeta,
      events: [
        { type: 'action', action: 'tap', success: false, error: 'No element found for getByText("Allow")' },
        { type: 'action', action: 'swipe', success: true },
      ],
    });
    const header = text(await readTrace({ path: trace })).split('## Steps')[0];
    expect(header).not.toContain('Failed step:');
    expect(header).toContain('No traced step failed with this error: the error was thrown outside a traced action or assertion');
    expect(header).toContain('Other failed steps, which did not stop the test (caught by the test code, or soft assertions): 1. tap');
  });

  it('names the step the test stopped on and lists soft failures separately', async () => {
    const trace = writeTrace({
      metadata: {
        ...failedMeta,
        error: 'element not found\n\n--- Additionally ---\n1 soft assertion(s) failed:\nsoft miss',
      },
      events: [
        { type: 'assertion', assertion: 'toBeVisible', passed: false, soft: false, error: 'soft miss' },
        { type: 'action', action: 'tap', success: true },
        { type: 'action', action: 'swipe', success: false, error: 'element not found', deviceId: 'bob' },
      ],
    });
    const header = text(await readTrace({ path: trace })).split('## Steps')[0];
    expect(header).toContain('Failed step: 3. bob: swipe (marked [FAIL] below)');
    expect(header).toContain('Other failed steps, which did not stop the test (caught by the test code, or soft assertions): 1. expect toBeVisible');
    expect(header).not.toContain('No traced step failed');
  });

  it('names every soft assertion when they alone failed the test', async () => {
    const trace = writeTrace({
      metadata: { ...failedMeta, error: '2 soft assertion(s) failed:\nfirst miss\nsecond miss' },
      events: [
        { type: 'assertion', assertion: 'toBeVisible', passed: false, soft: false, error: 'first miss' },
        { type: 'action', action: 'tap', success: true },
        { type: 'assertion', assertion: 'toHaveText', passed: false, soft: false, error: 'second miss' },
      ],
    });
    const header = text(await readTrace({ path: trace })).split('## Steps')[0];
    expect(header).toContain('Failed steps: 1. expect toBeVisible, 3. expect toHaveText (marked [FAIL] below)');
    expect(header).not.toContain('Other failed steps');
  });

  it('keeps a long failed-step list short and always names the last one', async () => {
    const events = Array.from({ length: 25 }, (_, i) => ({
      type: 'assertion', assertion: `check${i + 1}`, passed: false, soft: false, error: `miss ${i + 1};`,
    }));
    const error = `25 soft assertion(s) failed:\n${events.map((e) => e.error).join('\n')}`;
    const header = text(await readTrace({ path: writeTrace({ metadata: { ...failedMeta, error }, events }) })).split('## Steps')[0];
    expect(header).toContain('Failed steps: 1. expect check1, ');
    expect(header).toContain('9. expect check9, … 15 more …, 25. expect check25');
    expect(header).not.toContain('check10,');
  });

  // The fixtures above hand-copy one string into the step and the test error.
  // These record the steps through the real emitters, so the header is held
  // to the text they write next to the error they throw.
  describe('with steps recorded by the real expect()', () => {
    const traceConfig: TraceConfig = {
      mode: 'on', screenshots: false, snapshots: false, sources: false,
      attachments: false, network: false, deviceLogs: false, daemonLogs: false,
    };

    async function failedTraceOf(assertion: () => void): Promise<string> {
      const collector = new TraceCollector(traceConfig, tmpDir);
      setActiveTraceCollector(collector);
      let thrown: unknown;
      try {
        tapsmithExpect(2).toBe(2);
        assertion();
      } catch (err) {
        thrown = err;
      } finally {
        setActiveTraceCollector(null);
      }
      expect(thrown).toBeInstanceOf(Error);
      const trace = writeTrace({
        metadata: { ...failedMeta, error: (thrown as Error).message },
        events: [...collector.events],
      });
      return text(await readTrace({ path: trace })).split('## Steps')[0];
    }

    it.each([
      ['toBe', () => tapsmithExpect(3).toBe(4)],
      ['not.toBe', () => tapsmithExpect(3).not.toBe(3)],
      ['toHaveLength', () => tapsmithExpect([1, 2]).toHaveLength(3)],
      ['toBeTruthy', () => tapsmithExpect(0).toBeTruthy()],
      ['toThrow', () => tapsmithExpect(() => { throw new Error('nope'); }).toThrow('other')],
      ['not.toThrow', () => tapsmithExpect(() => { throw new Error('nope'); }).not.toThrow()],
    ])('names a failing expect(value).%s as the failed step', async (name, assertion) => {
      const header = await failedTraceOf(assertion);
      expect(header).toContain(`Failed step: 2. expect ${name} (marked [FAIL] below)`);
      expect(header).not.toContain('No traced step failed');
      expect(header).not.toContain('Other failed steps');
    });
  });

  it('reports a passing test as passed with no error line', async () => {
    const trace = writeTrace({
      metadata: { ...failedMeta, testStatus: 'passed', error: undefined, project: 'android' },
      events: [{ type: 'action', action: 'tap', success: true }],
    });
    const header = text(await readTrace({ path: trace })).split('## Steps')[0];
    expect(header).toContain('Status: passed');
    expect(header).toContain('Project: android');
    expect(header).not.toContain('Error');
    expect(header).not.toContain('No traced step failed');
  });

  it('clips a huge test error like a step value', async () => {
    const trace = writeTrace({
      metadata: { ...failedMeta, error: `boom ${'x'.repeat(50_000)}` },
      events: [],
    });
    const res = await readTrace({ path: trace });
    expect(text(res)).toContain('more characters');
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });

  it('prints nothing for result fields an older archive does not have', async () => {
    const trace = writeTrace({
      metadata: { version: 1, testFile: 'login.test.ts' },
      events: [{ type: 'action', action: 'tap' }],
    });
    const out = text(await readTrace({ path: trace }));
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('Status:');
    expect(out).toContain('File: login.test.ts');
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

// PILOT-657: a long trace with every screenshot, or a step with a huge error,
// must not build a response big enough for the client to drop the connection.
describe('tapsmith_read_trace response size', () => {
  it('keeps the latest screenshots that fit the image budget and says how many were left out', async () => {
    const big = Buffer.alloc(1024 * 1024, 7); // ~1.33 MiB as base64
    const screenshots: Record<string, Buffer> = {};
    for (let i = 1; i <= 12; i++) screenshots[`${String(i).padStart(3, '0')}.png`] = big;
    const trace = writeTrace({ events: [{ type: 'action', action: 'tap' }], screenshots });
    const res = await readTrace({ path: trace, include_screenshots: true });
    const images = res.content.filter((c) => c.type === 'image');
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBeLessThan(12);
    const t = text(res);
    expect(t).toContain('### Screenshot: 012');
    expect(t).not.toContain('### Screenshot: 001');
    expect(t).toMatch(/earlier screenshot\(s\) omitted/);
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });

  it('clips a huge step error and stays under the byte cap', async () => {
    const events = Array.from({ length: 400 }, (_, i) => ({
      type: 'assertion', assertion: 'toBeVisible', error: `${'x'.repeat(20_000)} step ${i}`, expected: 'y'.repeat(20_000),
    }));
    const res = await readTrace({ path: writeTrace({ events }) });
    const t = text(res);
    expect(t).toContain('more characters');
    expect(t).toContain('omitted here');
    // device_logs already defaults to errors: suggesting it would change nothing.
    expect(t).not.toContain('device_logs');
    expect(t).toContain('first and last steps are kept');
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });

  it('keeps the failing last step when a long device log section follows the steps', async () => {
    const steps = Array.from({ length: 400 }, (_, i) => ({
      type: 'assertion', assertion: 'toBeVisible', error: `${'x'.repeat(1_000)} step ${i}`,
    }));
    const logs = Array.from({ length: 400 }, (_, i) => ({
      type: 'console', source: 'device', level: 'info', message: `${'l'.repeat(600)} log ${i}`,
    }));
    const res = await readTrace({ path: writeTrace({ events: [...steps, ...logs] }), device_logs: 'all' });
    const t = text(res);
    expect(t).toContain('step 399');
    expect(t).toContain('## Device Logs');
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });
});
