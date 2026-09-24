import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TestDispatcher, TestResultEntry } from '../mcp/test-dispatcher.js';

// `tapsmith_list_results` is what an agent reads straight after a run. Its
// helper (`readTraceSummary`) was covered; the tool that filters, counts and
// formats around it was not — including the interrupted accounting added with
// the stop rework, which has to stay consistent with what suite_status reports.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-results-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function result(overrides: Partial<TestResultEntry> = {}): TestResultEntry {
  return {
    fullName: 'signs in',
    filePath: '/proj/e2e/login.test.ts',
    status: 'passed',
    duration: 120,
    ...overrides,
  };
}

function dispatcherWith(results: TestResultEntry[]): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => results,
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ timeout: 0, retries: 0, projects: [] }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: false }),
  };
}

async function listResults(
  dispatcher: TestDispatcher,
  args: Record<string, unknown> = {},
): Promise<string> {
  const server = createMcpServer({ dispatcher });
  const client = new Client({ name: 'list-results-probe', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const res = await client.callTool({ name: 'tapsmith_list_results', arguments: args }) as CallToolResult;
    return res.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  } finally {
    await client.close();
    await server.close();
  }
}

function traceZip(events: object[]): string {
  const target = path.join(tmpDir, `trace-${events.length}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(target, zipSync({
    'trace.json': new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join('\n')),
  }));
  return target;
}

describe('tapsmith_list_results with nothing to report', () => {
  it('tells the agent to run tests first when nothing has run', async () => {
    const out = await listResults(dispatcherWith([]));
    expect(out).toContain('No test results yet');
    expect(out).toContain('tapsmith_run_tests');
  });

  it('distinguishes "nothing matched your filter" from "nothing ran"', async () => {
    // Told the wrong one, an agent re-runs a suite that already ran.
    const out = await listResults(dispatcherWith([result()]), { status: 'failed' });
    expect(out).toBe('No results match the filter.');
  });
});

describe('tapsmith_list_results reporting', () => {
  it('counts each status and lists every test with its file', async () => {
    const out = await listResults(dispatcherWith([
      result({ fullName: 'signs in' }),
      result({ fullName: 'rejects a bad password', status: 'failed', error: 'Timed out', duration: 5000 }),
      result({ fullName: 'remembers me', status: 'skipped', duration: undefined }),
    ]));
    expect(out).toContain('Results: 1 passed, 1 failed, 1 skipped (3 total)');
    expect(out).toContain('[PASS] signs in (120ms)');
    expect(out).toContain('[FAIL] rejects a bad password (5000ms)');
    expect(out).toContain('Error: Timed out');
    expect(out).toContain('[SKIP] remembers me');
    expect(out).toContain('/proj/e2e/login.test.ts');
  });

  it('names the project a result came from', async () => {
    const out = await listResults(dispatcherWith([result({ projectName: 'ios' })]));
    expect(out).toContain('[PASS] signs in (120ms) [ios]');
  });

  it('counts a stopped test as interrupted, not as a failure', async () => {
    // The disagreement the stop rework fixed: a test the user stopped is not a
    // failure, and reporting it as one sends an agent debugging its own stop.
    const out = await listResults(dispatcherWith([
      result({ fullName: 'signs in' }),
      result({ fullName: 'takes a while', status: 'interrupted', duration: undefined }),
    ]));
    expect(out).toContain('Results: 1 passed, 0 failed, 0 skipped, 1 interrupted (2 total)');
    expect(out).toContain('[STOP] takes a while');
  });

  it('says nothing about interruptions in a run nobody stopped', async () => {
    const out = await listResults(dispatcherWith([result()]));
    expect(out).toContain('Results: 1 passed, 0 failed, 0 skipped (1 total)');
    expect(out).not.toContain('interrupted');
  });
});

describe('tapsmith_list_results filters', () => {
  const results = [
    result({ fullName: 'signs in', filePath: '/proj/e2e/login.test.ts' }),
    result({ fullName: 'shows the feed', filePath: '/proj/e2e/feed.test.ts', status: 'failed', error: 'boom' }),
    result({ fullName: 'signs out', filePath: '/proj/e2e/login.test.ts', status: 'failed', error: 'boom' }),
  ];

  it('filters by status', async () => {
    const out = await listResults(dispatcherWith(results), { status: 'failed' });
    expect(out).toContain('Results: 0 passed, 2 failed, 0 skipped (2 total)');
    expect(out).not.toContain('signs in (');
  });

  it('filters by a file path substring', async () => {
    const out = await listResults(dispatcherWith(results), { file: 'login' });
    expect(out).toContain('signs in');
    expect(out).toContain('signs out');
    expect(out).not.toContain('shows the feed');
  });

  it('applies both filters together', async () => {
    const out = await listResults(dispatcherWith(results), { status: 'failed', file: 'login' });
    expect(out).toContain('(1 total)');
    expect(out).toContain('signs out');
  });

  it('rejects a status that is not a test outcome', async () => {
    const out = await listResults(dispatcherWith(results), { status: 'flaky' });
    expect(out).toContain('Invalid arguments for tool tapsmith_list_results');
    expect(out).toContain('passed');
    expect(out).not.toContain('Results:');
  });
});

describe('tapsmith_list_results details', () => {
  it('links the trace without reading it unless details are asked for', async () => {
    const tracePath = traceZip([{ type: 'action', action: 'tap', selector: 'device.getByText("Login")' }]);
    const out = await listResults(dispatcherWith([
      result({ status: 'failed', error: 'boom', tracePath }),
    ]));
    expect(out).toContain(`Trace: ${tracePath}`);
    expect(out).not.toContain('Steps leading to failure');
  });

  it('shows the steps and device errors leading to a failure', async () => {
    const tracePath = traceZip([
      { type: 'action', action: 'tap', selector: 'device.getByText("Login")', duration: 100 },
      { type: 'console', source: 'device', level: 'error', message: 'NetworkError: timeout' },
      { type: 'assertion', assertion: 'toBeVisible', error: 'Timed out', duration: 5000 },
    ]);
    const out = await listResults(dispatcherWith([
      result({ status: 'failed', error: 'Timed out', tracePath }),
    ]), { details: true });
    expect(out).toContain('Steps leading to failure:');
    expect(out).toContain('[OK] tap');
    expect(out).toContain('[FAIL] expect toBeVisible');
    expect(out).toContain('Device logs (errors/warnings):');
    expect(out).toContain('NetworkError: timeout');
  });

  it('reads no trace for a test that passed', async () => {
    const tracePath = traceZip([{ type: 'action', action: 'tap' }]);
    const out = await listResults(dispatcherWith([result({ tracePath })]), { details: true });
    expect(out).toContain(`Trace: ${tracePath}`);
    expect(out).not.toContain('Steps leading to failure');
  });

  it('still lists a failure whose trace was never written', async () => {
    // Trace packaging can fail on its own — losing the result along with it
    // would hide the failure entirely.
    const out = await listResults(dispatcherWith([
      result({ status: 'failed', error: 'boom', tracePath: path.join(tmpDir, 'never-written.zip') }),
    ]), { details: true });
    expect(out).toContain('[FAIL] signs in');
    expect(out).toContain('Error: boom');
    expect(out).not.toContain('Steps leading to failure');
  });
});
