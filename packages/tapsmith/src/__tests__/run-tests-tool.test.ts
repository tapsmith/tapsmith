import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../mcp/index.js';
import type { TestDispatcher, TestRunResult, TestTreeEntry } from '../mcp/test-dispatcher.js';
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
