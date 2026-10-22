import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { MCP_RESPONSE_MAX_BYTES } from '../mcp/response-limits.js';
import { createMcpServer } from '../mcp/index.js';
import { stdioTestArgs } from '../mcp/tools/run-tests.js';
import { runCli, type CliHandlers, type TestCommandArgs } from '../cli-program.js';
import type { TestDispatcher, TestFailureDetail, TestRunResult, TestTreeEntry } from '../mcp/test-dispatcher.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const FILE = '/proj/e2e/login.test.ts';

function makeDispatcher(overrides: Partial<TestDispatcher> = {}): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [FILE],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({
      platform: 'android', package: 'com.example', device: 'emulator-5554',
      timeout: 5000, retries: 0, projects: [],
    }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: true }),
    ...overrides,
  };
}

function treeWith(...names: string[]): TestTreeEntry[] {
  return [{
    type: 'file', name: 'login.test.ts', fullName: '', filePath: FILE, status: 'idle',
    children: names.map((n) => ({ type: 'test' as const, name: n, fullName: n, filePath: FILE, status: 'idle' })),
  }];
}

async function callRunTests(
  dispatcher: TestDispatcher,
  args: { files: string[]; test?: string },
): Promise<CallToolResult> {
  const server = createMcpServer({ dispatcher });
  try {
    const handlers = (server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<CallToolResult>>
    })._requestHandlers;
    const callTool = handlers.get('tools/call');
    const res = await callTool?.({ method: 'tools/call', params: { name: 'tapsmith_run_tests', arguments: args } }, {});
    return res as CallToolResult;
  } finally {
    server.close();
  }
}

function text(res: CallToolResult): string {
  return res.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
}

describe('tapsmith_run_tests result handling', () => {
  it('reports a passing run as success (not an error)', async () => {
    const result: TestRunResult = { status: 'passed', passed: 3, failed: 0, skipped: 0, duration: 100 };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('All tests passed: 3 passed');
  });

  it('lists result warnings on a passing run (PILOT-398)', async () => {
    const result: TestRunResult = { status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 100 };
    const res = await callRunTests(makeDispatcher({
      runFiles: async () => result,
      getResults: () => [{ fullName: 'signs in', filePath: FILE, status: 'passed', warnings: ['The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.'] }],
    }), { files: [FILE] });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('All tests passed: 1 passed');
    expect(text(res)).toContain('Warnings:\n  signs in: The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.');
  });

  it('a filter that matches nothing is an error that lists available tests', async () => {
    const result: TestRunResult = { status: 'passed', passed: 0, failed: 0, skipped: 2, duration: 50 };
    const dispatcher = makeDispatcher({
      runFiles: async () => result,
      getTestTree: () => treeWith('Login screen > submits the form', 'Login screen > shows an error'),
    });
    const res = await callRunTests(dispatcher, { files: [FILE], test: 'nonexistent test' });
    expect(res.isError).toBe(true);
    const t = text(res);
    expect(t).toContain('No test matched "nonexistent test"');
    expect(t).toContain('Login screen > submits the form');
    expect(t).toContain('Login screen > shows an error');
  });

  it('reports matched-but-all-skipped distinctly (not "no match")', async () => {
    const result: TestRunResult = { status: 'passed', passed: 0, failed: 0, skipped: 1, duration: 10 };
    const dispatcher = makeDispatcher({
      runFiles: async () => result,
      getTestTree: () => treeWith('Login screen > submits the form'),
    });
    const res = await callRunTests(dispatcher, { files: [FILE], test: 'submits' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('all marked .skip()');
  });

  it('an unknown file path is an error, not a silent pass', async () => {
    // Headless dispatcher returns failed/0/0/0 when no requested file is known.
    const result: TestRunResult = { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: ['/nope.test.ts'] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('no tests executed');
  });

  it('reports real test failures as an error', async () => {
    const result: TestRunResult = {
      status: 'failed', passed: 1, failed: 1, skipped: 0, duration: 100,
      failures: [{ fullName: 'Login screen > shows an error', filePath: FILE, error: 'boom' }],
    };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] });
    expect(res.isError).toBe(true);
    const t = text(res);
    expect(t).toContain('Tests failed: 1 passed, 1 failed');
    expect(t).toContain('FAIL: Login screen > shows an error');
  });

  it('a user stop reports partial results without isError', async () => {
    const result: TestRunResult = { status: 'stopped', passed: 2, failed: 0, skipped: 1, duration: 80 };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE], test: 'x' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('Run stopped by user');
  });
});

// PILOT-657: a run with many long failures, each with a failure screenshot,
// built one response big enough that the client dropped the MCP connection.
describe('tapsmith_run_tests response size', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-run-size-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** A trace whose last screenshot is `screenshotBytes` of PNG-ish data. */
  function traceWithScreenshot(name: string, screenshotBytes: number): string {
    const target = path.join(tmpDir, `${name}.zip`);
    const events = Array.from({ length: 30 }, (_, i) => JSON.stringify({
      type: 'action', action: 'tap', selector: `getByText("${'s'.repeat(2_000)}${i}")`, error: i === 29 ? 'x'.repeat(5_000) : undefined,
    })).join('\n');
    fs.writeFileSync(target, zipSync({
      'trace.json': new TextEncoder().encode(events),
      'screenshots/001.png': new Uint8Array(screenshotBytes).fill(7),
    }, { level: 0 }));
    return target;
  }

  function failures(count: number, errorChars: number, withTraces: boolean): TestFailureDetail[] {
    const trace = withTraces ? traceWithScreenshot('shared', 1024 * 1024) : undefined;
    return Array.from({ length: count }, (_, i) => ({
      fullName: `Suite > failing test ${i}`,
      filePath: `/proj/e2e/file-${i % 8}.test.ts`,
      error: `Error ${i}: ${'e'.repeat(errorChars)}`,
      tracePath: trace,
    }));
  }

  it('stays under the byte cap with many long failures and screenshots, and says where the rest is', async () => {
    const result: TestRunResult = {
      status: 'failed', passed: 2, failed: 200, skipped: 0, duration: 1000,
      failures: failures(200, 50_000, true),
    };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] });
    expect(res.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    const t = text(res);
    expect(t.startsWith('Tests failed: 2 passed, 200 failed')).toBe(true);
    expect(t).toContain('FAIL: Suite > failing test 0');
    expect(t).toContain('more characters');
    expect(t).toContain('tapsmith_list_results');
    expect(t).toMatch(/150 more failure\(s\) not listed/);
    expect(res.content.filter((c) => c.type === 'image').length).toBeLessThanOrEqual(3);
  });

  it('lists every failure by name when there are only a few, each error clipped', async () => {
    const result: TestRunResult = {
      status: 'failed', passed: 0, failed: 16, skipped: 2, duration: 1000,
      failures: failures(16, 20_000, false),
    };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] });
    const t = text(res);
    for (let i = 0; i < 16; i++) expect(t).toContain(`failing test ${i}`);
    expect(t).not.toContain('not listed');
    expect(t).not.toContain('omitted here');
    expect(Buffer.byteLength(t, 'utf8')).toBeLessThan(100 * 1024);
  });

  it('promises no screenshots when no failure had a trace to take one from', async () => {
    const result: TestRunResult = {
      status: 'failed', passed: 0, failed: 5, skipped: 0, duration: 10,
      failures: failures(5, 10, false),
    };
    const t = text(await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] }));
    expect(t).not.toContain('screenshots');
  });

  it('attaches screenshots from the first failures that have one, skipping a failure with no trace', async () => {
    const withTraces = failures(5, 10, true);
    const result: TestRunResult = {
      status: 'failed', passed: 0, failed: 6, skipped: 0, duration: 10,
      failures: [{ fullName: 'file failed to load', filePath: FILE, error: 'Cannot find module' }, ...withTraces],
    };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(text(res)).toContain('screenshots for 3 of them');
  });

  // QA of PILOT-657: traces with long steps and device logs made the ten
  // detailed failures alone overflow the text budget, so the boundary cut
  // failure names out of the middle.
  it('names every listed failure when detailed traces are long, without the boundary cutting', async () => {
    const trace = path.join(tmpDir, 'chatty.zip');
    const events = [
      ...Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: 'action', action: 'tap', selector: `getByText("${'s'.repeat(600)}${i}")` })),
      ...Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'console', source: 'device', level: 'error', message: `${'w'.repeat(800)}${i}` })),
    ].join('\n');
    fs.writeFileSync(trace, zipSync({ 'trace.json': new TextEncoder().encode(events) }));
    const many = failures(16, 20_000, false).map((f) => ({ ...f, tracePath: trace }));
    const result: TestRunResult = { status: 'failed', passed: 1, failed: 16, skipped: 0, duration: 10, failures: many };
    const t = text(await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] }));
    for (let i = 0; i < 16; i++) expect(t).toContain(`FAIL: Suite > failing test ${i}`);
    expect(t).not.toContain('omitted here');
    expect(t).toMatch(/Details shown for the first \d+ failure\(s\)/);
  });

  it('attaches only the screenshots that fit the image budget, and says how many', async () => {
    const big = traceWithScreenshot('big', 2 * 1024 * 1024); // ~2.7 MiB as base64
    const many = failures(5, 10, false).map((f) => ({ ...f, tracePath: big }));
    const result: TestRunResult = { status: 'failed', passed: 0, failed: 5, skipped: 0, duration: 10, failures: many };
    const res = await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(text(res)).toContain('screenshots for 1 of them');
    expect(text(res)).not.toContain('image(s) omitted');
  });

  it('keeps a short failure exactly as before', async () => {
    const result: TestRunResult = {
      status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 10,
      failures: [{ fullName: 'Login > fails', filePath: FILE, error: 'expected visible' }],
    };
    const t = text(await callRunTests(makeDispatcher({ runFiles: async () => result }), { files: [FILE] }));
    expect(t).toBe('Tests failed: 0 passed, 1 failed, 0 skipped (10ms)\n\nFAIL: Login > fails\n  Error: expected visible');
  });
});

// The dispatcher-less fallback spawns `tapsmith test`: its argv has to be one
// the CLI accepts. It used to pass `--test <filter>`, a flag the CLI never had,
// so every filtered run in that mode failed at argument parsing.
describe('stdioTestArgs()', () => {
  it('builds a plain run', () => {
    expect(stdioTestArgs({ files: [FILE] })).toEqual(['test', FILE, '--trace', 'on']);
  });

  it('passes project and device', () => {
    expect(stdioTestArgs({ files: [FILE], project: 'android', device: 'emulator-5554' }))
      .toEqual(['test', FILE, '--trace', 'on', '--project=android', '--device=emulator-5554']);
  });

  it('turns the test filter into a case-insensitive literal --grep', async () => {
    const args = stdioTestArgs({ files: [FILE], testFilter: '-Checkout (v2)?' });
    const h: string[] = [];
    let seen: TestCommandArgs | undefined;
    const code = await runCli(args, {
      handlers: { test: async (a: TestCommandArgs) => { seen = a; } } as Partial<CliHandlers> as CliHandlers,
      version: '0',
      io: { out: (t) => h.push(t), err: (t) => h.push(t) },
    });
    expect(h.join('')).toBe('');
    expect(code).toBe(0);
    expect(seen?.files).toEqual([FILE]);
    // Same semantics as the dispatcher's `test` filter: a case-insensitive substring.
    expect(seen?.grep?.test('cart > -checkout (V2)? works')).toBe(true);
    expect(seen?.grep?.test('cart > checkout v2 works')).toBe(false);
  });
});
