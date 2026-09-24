import { describe, it, expect, vi, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerRunTestsTool } from '../mcp/tools/run-tests.js';
import { createMcpServer } from '../mcp/index.js';
import type { TestDispatcher, TestResultEntry, TestRunResult } from '../mcp/test-dispatcher.js';

// PILOT-285: tapsmith_run_tests must emit notifications/progress while a run
// executes so idle-timeout-based MCP clients (Claude Code aborts after 300s
// of silence) keep long runs alive.

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

interface ProgressNotificationRecord {
  method: string
  params: { progressToken?: string | number; progress: number; message?: string }
}

function makeToolCapture(): { server: McpServer; tools: Map<string, ToolCallback> } {
  const tools = new Map<string, ToolCallback>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, cb: ToolCallback): void => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function makeExtra(progressToken?: string | number): {
  extra: unknown
  notifications: ProgressNotificationRecord[]
} {
  const notifications: ProgressNotificationRecord[] = [];
  const extra = {
    _meta: progressToken === undefined ? undefined : { progressToken },
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async (n: ProgressNotificationRecord): Promise<void> => {
      notifications.push(n);
    },
  };
  return { extra, notifications };
}

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

const passedResult = (fullName: string, filePath: string): TestResultEntry => ({
  fullName,
  filePath,
  status: 'passed',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tapsmith_run_tests progress notifications', () => {
  it('emits an initial notification and periodic heartbeats with live counts while a run executes', async () => {
    vi.useFakeTimers();

    let resolveRun!: (r: TestRunResult) => void;
    const midRunResults: TestResultEntry[] = [];
    const dispatcher = makeDispatcher({
      runFiles: () => new Promise<TestRunResult>((resolve) => { resolveRun = resolve; }),
      getResults: () => midRunResults,
    });

    const { server, tools } = makeToolCapture();
    registerRunTestsTool(server, dispatcher);
    const runTests = tools.get('tapsmith_run_tests')!;

    const { extra, notifications } = makeExtra('tok-1');
    const callPromise = runTests({ files: ['/app/a.test.ts'] }, extra);

    // Initial notification fires as soon as the run starts — which is after
    // the `project` argument has been checked, so that a run about to be
    // refused never announces itself as started. That check awaits discovery,
    // hence the flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].params.progressToken).toBe('tok-1');
    expect(notifications[0].params.message).toContain('1 file(s)');

    // First heartbeat: nothing finished yet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notifications).toHaveLength(2);
    expect(notifications[1].params.message).toContain('0 test(s) finished');

    // A test completes mid-run; the next heartbeat reports it.
    midRunResults.push(passedResult('suite > one', '/app/a.test.ts'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notifications).toHaveLength(3);
    expect(notifications[2].params.message).toContain('1 test(s) finished (1 passed)');

    // progress must increase with each notification (MCP spec).
    expect(notifications.map((n) => n.params.progress)).toEqual([1, 2, 3]);

    resolveRun({ status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 42 });
    const result = await callPromise;
    expect(result.isError).toBeUndefined();

    // Heartbeat stops once the run finishes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifications).toHaveLength(3);
  });

  it('sends no notifications when the client did not supply a progressToken', async () => {
    vi.useFakeTimers();

    let resolveRun!: (r: TestRunResult) => void;
    const dispatcher = makeDispatcher({
      runFiles: () => new Promise<TestRunResult>((resolve) => { resolveRun = resolve; }),
    });

    const { server, tools } = makeToolCapture();
    registerRunTestsTool(server, dispatcher);
    const runTests = tools.get('tapsmith_run_tests')!;

    const { extra, notifications } = makeExtra(undefined);
    const callPromise = runTests({ files: ['/app/a.test.ts'] }, extra);

    await vi.advanceTimersByTimeAsync(60_000);
    resolveRun({ status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 42 });
    await callPromise;

    expect(notifications).toHaveLength(0);
  });

  it('delivers progress to a real MCP client end to end when it requests it', async () => {
    // Exercises the actual SDK plumbing over an in-memory transport: the
    // client's onprogress option makes it attach a progressToken, and the
    // server-side notification must arrive back as an onprogress callback.
    let resolveRun!: (r: TestRunResult) => void;
    const dispatcher = makeDispatcher({
      runFiles: () => new Promise<TestRunResult>((resolve) => { resolveRun = resolve; }),
    });
    const server = createMcpServer({ dispatcher });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const progressMessages: Array<string | undefined> = [];
    const callPromise = client.callTool(
      { name: 'tapsmith_run_tests', arguments: { files: ['/app/a.test.ts'] } },
      CallToolResultSchema,
      {
        onprogress: (p) => {
          progressMessages.push(p.message);
          // End the run once the initial notification has round-tripped.
          resolveRun({ status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 5 });
        },
        // Keep the test snappy; without progress this would abort long before.
        timeout: 5_000,
        resetTimeoutOnProgress: true,
      },
    );

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    expect(progressMessages.length).toBeGreaterThanOrEqual(1);
    expect(progressMessages[0]).toContain('Started test run');

    await client.close();
    await server.close();
  });

  it('accepts a numeric progressToken', async () => {
    const dispatcher = makeDispatcher({
      runFiles: async () => ({ status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 1 }),
    });

    const { server, tools } = makeToolCapture();
    registerRunTestsTool(server, dispatcher);
    const runTests = tools.get('tapsmith_run_tests')!;

    const { extra, notifications } = makeExtra(7);
    await runTests({ files: ['/app/a.test.ts'] }, extra);

    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0].params.progressToken).toBe(7);
  });
});
