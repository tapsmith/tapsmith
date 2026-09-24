import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerStopTestsTool } from '../mcp/tools/stop-tests.js';
import type { TestDispatcher, TestRunResult } from '../mcp/test-dispatcher.js';

type ToolHandler = () => Promise<{ content: Array<{ type: string; text: string }> }>;

function makeDispatcher(overrides: Partial<TestDispatcher> = {}): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: vi.fn(),
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ timeout: 5000, retries: 0, projects: [] }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: true }),
    ...overrides,
  };
}

/** Register the tool against a stub server and return its handler. */
function getHandler(dispatcher: TestDispatcher): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h;
    },
  } as unknown as McpServer;
  registerStopTestsTool(server, dispatcher);
  if (!handler) throw new Error('tool handler was not registered');
  return handler;
}

describe('tapsmith_stop_tests', () => {
  it('reports when no run is in progress', async () => {
    const handler = getHandler(makeDispatcher({ isRunning: () => false }));
    const result = await handler();
    expect(result.content[0].text).toBe('No test run is currently in progress.');
  });

  it('stops the run and reports the actual outcome', async () => {
    const stopped: TestRunResult = { status: 'stopped', passed: 3, failed: 1, skipped: 2, interrupted: 1, duration: 1234 };
    const stop = vi.fn();
    const handler = getHandler(makeDispatcher({
      isRunning: () => true,
      stop,
      waitForRunEnd: vi.fn(async () => stopped),
    }));

    const result = await handler();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toBe(
      'Run stopped: 3 passed, 1 failed, 2 skipped, 1 interrupted. Use tapsmith_list_results for details.',
    );
  });

  it('omits the interrupted count when no tests were interrupted', async () => {
    const stopped: TestRunResult = { status: 'stopped', passed: 5, failed: 0, skipped: 0, duration: 100 };
    const handler = getHandler(makeDispatcher({
      isRunning: () => true,
      waitForRunEnd: async () => stopped,
    }));

    const result = await handler();
    expect(result.content[0].text).toBe(
      'Run stopped: 5 passed, 0 failed, 0 skipped. Use tapsmith_list_results for details.',
    );
  });

  it('reports "still terminating" when the run does not end within the wait window', async () => {
    const handler = getHandler(makeDispatcher({
      isRunning: () => true,
      waitForRunEnd: async () => null,
    }));

    const result = await handler();
    expect(result.content[0].text).toContain('Stop requested; the run is still terminating');
  });

  it('degrades gracefully for dispatchers without waitForRunEnd', async () => {
    const handler = getHandler(makeDispatcher({ isRunning: () => true }));
    const result = await handler();
    expect(result.content[0].text).toContain('still terminating');
  });
});
