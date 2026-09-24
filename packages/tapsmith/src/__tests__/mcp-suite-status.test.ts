import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerSuiteStatusTool } from '../mcp/tools/suite-status.js';
import { registerRunTestsTool } from '../mcp/tools/run-tests.js';
import type { TestDispatcher, TestResultEntry, TestTreeEntry } from '../mcp/test-dispatcher.js';

// PILOT-286: tapsmith_suite_status joins the discovered test tree with results
// accumulated across every run in the session, so batched runs build a
// complete passed/failed/skipped/not-run board instead of only the last run.

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

function makeToolCapture(): { server: McpServer; tools: Map<string, ToolCallback> } {
  const tools = new Map<string, ToolCallback>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, cb: ToolCallback): void => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

const extra = { _meta: undefined, sendNotification: async (): Promise<void> => {} };

function makeDispatcher(overrides: Partial<TestDispatcher> = {}): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ timeout: 0, retries: 0, projects: [] }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: false }),
    ...overrides,
  };
}

function testNode(filePath: string, fullName: string): TestTreeEntry {
  return { type: 'test', name: fullName.split(' > ').pop()!, fullName, filePath, status: 'idle' };
}

function fileNode(filePath: string, tests: TestTreeEntry[]): TestTreeEntry {
  return { type: 'file', name: filePath, fullName: filePath, filePath, status: 'idle', children: tests };
}

function projectNode(name: string, children: TestTreeEntry[]): TestTreeEntry {
  return { type: 'project', name, fullName: name, filePath: '', status: 'idle', children };
}

function result(
  filePath: string,
  fullName: string,
  status: TestResultEntry['status'],
  extras: Partial<TestResultEntry> = {},
): TestResultEntry {
  return { fullName, filePath, status, ...extras };
}

function textOf(callResult: CallToolResult): string {
  return (callResult.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

// A test the user stopped reached no verdict, but the board must not file it
// under "not run" — that conflates the test we cut short with the ones we never
// attempted, and disagrees with `list_results` about the very same run.
describe('tapsmith_suite_status and a stopped test', () => {
  const FILE = '/repo/tests/gestures.test.ts';
  const tree = [projectNode('default', [fileNode(FILE, [
    testNode(FILE, 'Gestures > first'),
    testNode(FILE, 'Gestures > cut'),
    testNode(FILE, 'Gestures > never started'),
  ])])];

  function boardFor(results: TestResultEntry[]): Promise<string> {
    const { server, tools } = makeToolCapture();
    const dispatcher = makeDispatcher({ getTestTree: () => tree, getResults: () => results });
    registerSuiteStatusTool(server, dispatcher);
    return tools.get('tapsmith_suite_status')!({ details: true }, extra).then(textOf);
  }

  it('shows it as stopped, not as never attempted', async () => {
    const text = await boardFor([
      result(FILE, 'Gestures > first', 'passed', { projectName: 'default' }),
      result(FILE, 'Gestures > cut', 'interrupted', { projectName: 'default', error: 'Stopped by user' }),
    ]);
    expect(text).toContain('[STOP] Gestures > cut');
    // The one that never started is the only 'not run' on this board.
    expect(text).toContain('1 passed, 1 interrupted, 1 not run');
  });

  it('does not count it as a failure', async () => {
    const text = await boardFor([
      result(FILE, 'Gestures > cut', 'interrupted', { projectName: 'default', error: 'Stopped by user' }),
    ]);
    expect(text).toContain('0 failed');
    expect(text).toContain('1 interrupted');
    expect(text).not.toContain('[FAIL]');
  });

  it('still retires a file-level failure, because the file did run', async () => {
    const text = await boardFor([
      result(FILE, `${FILE} — file failed to run`, 'failed', {
        projectName: 'default', error: 'Cannot find module', fileLevelFailure: true,
      }),
      result(FILE, 'Gestures > cut', 'interrupted', { projectName: 'default', error: 'Stopped by user' }),
    ]);
    expect(text).not.toContain('file failed to run');
  });
});

describe('tapsmith_suite_status', () => {
  it('reports every discovered test as passed, failed, skipped, or not run', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [
        testNode('/app/a.test.ts', 'auth > logs in'),
        testNode('/app/a.test.ts', 'auth > logs out'),
      ]),
      fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed'),
        result('/app/a.test.ts', 'auth > logs out', 'failed', { error: 'boom' }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 1 failed, 0 skipped, 1 not run (2/3 tests run)');
    expect(text).toContain('/app/a.test.ts: 1 passed, 1 failed');
    expect(text).toContain('FAIL: auth > logs out — boom');
    expect(text).toContain('/app/b.test.ts: 1 not run');
  });

  it('accumulates results across batched run_tests calls', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')]),
      fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')]),
      fileNode('/app/c.test.ts', [testNode('/app/c.test.ts', 'search > finds item')]),
    ];
    // Simulates the dispatcher's reset-per-run behaviour: getResults() only
    // ever returns the most recent batch.
    let currentResults: TestResultEntry[] = [];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => currentResults,
      runFiles: async (files: string[]) => {
        currentResults = files.includes('/app/a.test.ts')
          ? [result('/app/a.test.ts', 'auth > logs in', 'passed')]
          : [result('/app/b.test.ts', 'cart > adds item', 'failed', { error: 'nope' })];
        return { status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 1 };
      },
    });

    const { server, tools } = makeToolCapture();
    registerRunTestsTool(server, dispatcher);
    registerSuiteStatusTool(server, dispatcher);
    const runTests = tools.get('tapsmith_run_tests')!;
    const suiteStatus = tools.get('tapsmith_suite_status')!;

    await runTests({ files: ['/app/a.test.ts'] }, extra);
    await runTests({ files: ['/app/b.test.ts'] }, extra);

    const text = textOf(await suiteStatus({}, extra));
    // Batch 1's pass survives batch 2 replacing the dispatcher's results.
    expect(text).toContain('Suite status: 1 passed, 1 failed, 0 skipped, 1 not run (2/3 tests run)');
    expect(text).toContain('/app/a.test.ts: 1 passed');
    expect(text).toContain('/app/b.test.ts: 1 failed');
    expect(text).toContain('/app/c.test.ts: 1 not run');
  });

  it('captures results from runs it never saw start (read-time merge)', async () => {
    const tree = [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      // e.g. a run triggered from the UI, not through tapsmith_run_tests
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'passed')],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 0 not run (1/1 tests run)');
  });

  it('joins project-grouped trees using the project name', async () => {
    const tree = [
      projectNode('android', [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])]),
      projectNode('ios', [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed', { projectName: 'android' }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    // Only the android run counts; the ios copy of the same test is not run.
    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 1 not run (1/2 tests run)');
    expect(text).toContain('/app/a.test.ts [android]: 1 passed');
    expect(text).toContain('/app/a.test.ts [ios]: 1 not run');
  });

  it("joins a project the config genuinely named 'default' on its own name", async () => {
    // The e2e iOS config really does name a project "default" alongside
    // "authentication" and "authenticated". The dispatcher records its results
    // under that name, so the join has to use it too: stripping "default" to
    // undefined here missed every result and reported a finished run as
    // entirely not run.
    const tree = [
      projectNode('default', [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])]),
      projectNode('authenticated', [fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')])]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed', { projectName: 'default' }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 1 not run (1/2 tests run)');
    expect(text).toContain('/app/a.test.ts [default]: 1 passed');
    expect(text).toContain('/app/b.test.ts [authenticated]: 1 not run');
  });

  it('joins project-less results when the config declares no projects', async () => {
    // The other half of the same contract: a config with no projects gets a
    // synthesized one, which never becomes a tree node — so the tree is bare
    // files and the results carry no projectName.
    const tree = [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'passed')],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 0 not run (1/1 tests run)');
    expect(text).toContain('/app/a.test.ts: 1 passed');
  });

  // A file that fails to *load* declares no tests, so it has no tree node for
  // the board to hang a row on — and the board is exactly where a reader looks
  // to find out what happened. It used to be the one place the failure never
  // appeared.
  it('shows a file that failed to run, which has no node in the test tree', async () => {
    const tree = [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed'),
        result('/app/broken.test.ts', 'broken.test.ts — file failed to run', 'failed', {
          error: "Cannot find module '/app/fixtures.js'",
          fileLevelFailure: true,
        }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 1 failed, 0 skipped, 0 not run (2/2 tests run)');
    expect(text).toContain('/app/broken.test.ts: 1 failed');
    expect(text).toContain("Cannot find module '/app/fixtures.js'");
  });

  // The empty tree and the file-level failure have the same cause — every file
  // failed to load — so the board bailed on "nothing discovered" in exactly the
  // case these entries were added for, moments after the run reported them.
  it('shows file-level failures when no file in the suite could be loaded', async () => {
    const dispatcher = makeDispatcher({
      getTestTree: () => [],
      getResults: () => [
        result('/app/a.test.ts', 'a.test.ts — file failed to run', 'failed', {
          error: "Cannot find module '/app/fixtures.js'",
          fileLevelFailure: true,
        }),
        result('/app/b.test.ts', 'b.test.ts — file failed to run', 'failed', {
          error: "Cannot find module '/app/fixtures.js'",
          fileLevelFailure: true,
        }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).not.toContain('No test files discovered');
    expect(text).toContain('Suite status: 0 passed, 2 failed');
    expect(text).toContain('/app/a.test.ts');
    expect(text).toContain('/app/b.test.ts');
  });

  it('still says nothing was discovered when there is nothing at all', async () => {
    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, makeDispatcher({ getTestTree: () => [] }));
    expect(textOf(await tools.get('tapsmith_suite_status')!({}, extra)))
      .toContain('No test files discovered');
  });

  // Files were found, they just declare no tests. Blaming a filter the caller
  // never passed sends the reader looking for an argument they did not use.
  it('does not blame a filter when none was given', async () => {
    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, makeDispatcher({
      getTestTree: () => [fileNode('/app/empty.test.ts', [])],
    }));
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));
    expect(text).not.toContain('filter');
    expect(text).toContain('declare none');
  });

  // The synthetic entry is keyed on a name no real test has, so nothing would
  // ever overwrite it: without retiring it explicitly, fixing the import error
  // and re-running green still left the board reporting the original failure
  // for the rest of the session.
  it('retires a file-level failure once the file runs for real', async () => {
    const tree = [fileNode('/app/broken.test.ts', [testNode('/app/broken.test.ts', 'cart > adds item')])];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/broken.test.ts', 'broken.test.ts — file failed to run', 'failed', {
          error: "Cannot find module '/app/fixtures.js'",
          fileLevelFailure: true,
        }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    // First call: the file could not run.
    expect(textOf(await tools.get('tapsmith_suite_status')!({}, extra))).toContain('1 failed');

    // The user fixes it and re-runs; the file now reports a real result.
    dispatcher.getResults = (): ReturnType<typeof dispatcher.getResults> => [
      result('/app/broken.test.ts', 'cart > adds item', 'passed'),
    ];
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 0 not run (1/1 tests run)');
    expect(text).not.toContain('file failed to run');
  });

  it('does not duplicate a failure that the test tree already accounts for', async () => {
    const tree = [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'failed', { error: 'boom' })],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 0 passed, 1 failed, 0 skipped, 0 not run (1/1 tests run)');
  });

  it('ignores in-flight (running/idle) statuses when merging', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [
        testNode('/app/a.test.ts', 'auth > logs in'),
        testNode('/app/a.test.ts', 'auth > logs out'),
      ]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed'),
        result('/app/a.test.ts', 'auth > logs out', 'running'),
      ],
      isRunning: () => true,
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 1 not run (1/2 tests run)');
    expect(text).toContain('A test run is in progress');
  });

  it('supports the details flag and file filter', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [
        testNode('/app/a.test.ts', 'auth > logs in'),
        testNode('/app/a.test.ts', 'auth > logs out'),
      ]),
      fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'passed')],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const suiteStatus = tools.get('tapsmith_suite_status')!;

    const detailed = textOf(await suiteStatus({ details: true, file: 'a.test.ts' }, extra));
    expect(detailed).toContain('[PASS] auth > logs in');
    expect(detailed).toContain('[ -- ] auth > logs out');
    expect(detailed).not.toContain('b.test.ts');
  });

  it('keeps completed results on the board when a run fails part-way', async () => {
    const tree = [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])];
    let currentResults: TestResultEntry[] = [];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => currentResults,
      runFiles: async () => {
        currentResults = [result('/app/a.test.ts', 'auth > logs in', 'passed')];
        throw new Error('device disconnected');
      },
    });

    const { server, tools } = makeToolCapture();
    registerRunTestsTool(server, dispatcher);
    registerSuiteStatusTool(server, dispatcher);

    await expect(tools.get('tapsmith_run_tests')!({ files: ['/app/a.test.ts'] }, extra))
      .rejects.toThrow('device disconnected');
    // Simulate the next run resetting the dispatcher's results: only the
    // session store's merge-on-rejection keeps the passed test visible.
    currentResults = [];

    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));
    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 0 not run (1/1 tests run)');
  });

  it('reports when no test files are discovered', async () => {
    const dispatcher = makeDispatcher();
    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));
    expect(text).toBe('No test files discovered.');
  });
});
