import { describe, it, expect } from 'vitest';
import {
  MCP_EVENT_RESULT_TEXT_LIMIT,
  McpEventEmitter,
  nextCallId,
  summarizeResult,
  truncateResultText,
  type McpClientInfo,
  type McpToolCallEvent,
} from '../mcp/events.js';
import { attachMcpClientEventReporting, createMcpServer } from '../mcp/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('summarizeResult()', () => {
  it('summarizes snapshot with element and locator counts', () => {
    const result = '- [1] Button "Login"\n- [2] TextField\n\n## Suggested Locators\ndevice.getByRole("button")\ndevice.getByText("Login")';
    expect(summarizeResult('tapsmith_snapshot', result)).toBe('2 elements, 2 locators');
  });

  it('returns "PNG image captured" for screenshot', () => {
    expect(summarizeResult('tapsmith_screenshot', '')).toBe('PNG image captured');
  });

  it('summarizes test_locator match', () => {
    const result = JSON.stringify({ matched: true, count: 3, elements: [] });
    expect(summarizeResult('tapsmith_test_locator', result)).toBe('matched 3 elements');
  });

  it('summarizes test_locator no match', () => {
    const result = JSON.stringify({ matched: false, count: 0, elements: [] });
    expect(summarizeResult('tapsmith_test_locator', result)).toBe('no match');
  });

  it('summarizes list_devices with platform counts', () => {
    const result = JSON.stringify([
      { serial: 'emulator-5554', platform: 'android' },
      { serial: 'emulator-5556', platform: 'android' },
      { serial: 'ABC-123', platform: 'ios' },
    ]);
    expect(summarizeResult('tapsmith_list_devices', result)).toBe('2 android, 1 ios');
  });

  it('summarizes list_devices without platform', () => {
    const result = JSON.stringify([{ serial: 'emulator-5554' }, { serial: 'abc123' }]);
    expect(summarizeResult('tapsmith_list_devices', result)).toBe('2 devices');
  });

  it('summarizes run_tests with pass and fail counts', () => {
    expect(summarizeResult('tapsmith_run_tests', 'Tests failed: 3 passed, 1 failed, 0 skipped'))
      .toBe('3 passed, 1 failed');
  });

  it('summarizes run_tests all passed', () => {
    expect(summarizeResult('tapsmith_run_tests', 'All tests passed: 5 passed, 0 skipped (1234ms)'))
      .toBe('5 passed');
  });

  it('returns "OK" for successful device actions', () => {
    for (const tool of ['tapsmith_tap', 'tapsmith_type', 'tapsmith_swipe', 'tapsmith_press_key', 'tapsmith_launch_app']) {
      expect(summarizeResult(tool, 'OK')).toBe('OK');
    }
  });

  it('summarizes read_trace step count', () => {
    expect(summarizeResult('tapsmith_read_trace', '## Steps (12 events)\n...')).toBe('## Steps (12 events)');
  });

  it('summarizes list_tests with projects', () => {
    expect(summarizeResult('tapsmith_list_tests', 'Projects: android, ios\n\n[project] android\n  [file] test.ts'))
      .toBe('Projects: android, ios');
  });

  it('summarizes list_tests file count fallback', () => {
    expect(summarizeResult('tapsmith_list_tests', '25 test file(s):\n/path/to/test.ts')).toBe('25 test file');
  });

  it('summarizes list_results', () => {
    expect(summarizeResult('tapsmith_list_results', 'Results: 10 passed, 2 failed, 1 skipped (13 total)'))
      .toBe('10 passed, 2 failed, 1 skipped');
  });

  it('summarizes stop_tests', () => {
    expect(summarizeResult('tapsmith_stop_tests', 'Stop signal sent. The running test will be terminated.'))
      .toBe('stopped');
    expect(summarizeResult('tapsmith_stop_tests', 'No test run is currently in progress.'))
      .toBe('nothing running');
  });

  it('summarizes session_info', () => {
    expect(summarizeResult('tapsmith_session_info', '## Session\nDevice: ...')).toBe('session info');
  });

  it('summarizes watch toggle', () => {
    expect(summarizeResult('tapsmith_watch', 'Watch enabled for file [android]. Will re-run on save.'))
      .toBe('watch enabled');
    expect(summarizeResult('tapsmith_watch', 'Watch disabled for file [android].'))
      .toBe('watch disabled');
  });

  it('truncates unknown tools to 60 chars', () => {
    const long = 'a'.repeat(100);
    expect(summarizeResult('unknown_tool', long)).toBe('a'.repeat(60));
  });
});

describe('nextCallId()', () => {
  it('returns unique IDs', () => {
    const a = nextCallId();
    const b = nextCallId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^mcp-\d+-\d+$/);
  });
});

describe('truncateResultText()', () => {
  it('keeps small text results for UI rendering', () => {
    expect(truncateResultText('[{"serial":"emulator-5554"}]')).toEqual({
      resultText: '[{"serial":"emulator-5554"}]',
    });
  });

  it('bounds large text results for UI rendering', () => {
    const result = truncateResultText('a'.repeat(MCP_EVENT_RESULT_TEXT_LIMIT + 1));
    expect(result.resultText).toHaveLength(MCP_EVENT_RESULT_TEXT_LIMIT);
    expect(result.resultTruncated).toBe(true);
  });
});

describe('MCP tool call event wrapping', () => {
  it('emits the direct SDK tool result text for UI rendering', async () => {
    const events = new McpEventEmitter();
    const toolEvents: McpToolCallEvent[] = [];
    events.onToolCall(event => toolEvents.push(event));

    const server = createMcpServer({ events, dispatcher: makeDispatcher() });
    try {
      const handlers = (server.server as unknown as {
        _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<CallToolResult>>
      })._requestHandlers;
      const callTool = handlers.get('tools/call');
      expect(callTool).toBeDefined();

      await callTool?.({
        method: 'tools/call',
        params: { name: 'tapsmith_session_info', arguments: {} },
      }, {});

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[1]).toMatchObject({
        tool: 'tapsmith_session_info',
        status: 'completed',
        resultSummary: 'session info',
      });
      expect(toolEvents[1].resultText).toContain('## Session');
    } finally {
      server.close();
    }
  });
});

describe('MCP client event reporting', () => {
  it('emits client connect and disconnect events from the MCP lifecycle', async () => {
    const events = new McpEventEmitter();
    const clientEvents: Array<McpClientInfo | null> = [];
    events.onClientChange(event => clientEvents.push(event));

    const server = createMcpServer({ events, dispatcher: makeDispatcher() });
    const client = new Client({ name: 'probe-client', version: '1.2.3' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    attachMcpClientEventReporting(server, events);
    await server.connect(serverTransport);

    try {
      await client.connect(clientTransport);

      expect(clientEvents[0]).toEqual({
        name: 'probe-client',
        version: '1.2.3',
      });

      await client.close();
      expect(clientEvents.at(-1)).toBeNull();
    } finally {
      await server.close();
    }
  });
});

function makeDispatcher(): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({
      platform: 'android',
      package: 'com.example',
      device: 'emulator-5554',
      timeout: 5000,
      retries: 0,
      projects: [],
    }),
    resolveDeviceName: () => undefined,
    toggleWatch: () => ({ enabled: true }),
  };
}
