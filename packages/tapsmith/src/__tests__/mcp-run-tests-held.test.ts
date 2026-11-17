import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LOCATOR_PICKER_HINT } from '../locator-miss-hint.js';
import type { TestDispatcher, TestRunResult } from '../mcp/test-dispatcher.js';

// PILOT-1241: tapsmith_run_tests says when the device is still on the screen
// where a run of one test failed, and lists what there is closest to the
// locator that matched nothing.

const deviceTargetFor = vi.hoisted(() => vi.fn());
vi.mock('../mcp/tools/device-target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/tools/device-target.js')>()),
  deviceTargetFor,
}));

const { createMcpServer } = await import('../mcp/index.js');

const FILE = '/proj/e2e/login.test.ts';
const SCREEN = `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
<node class="android.widget.TextView" text="Sign In" tapsmith-role="heading" bounds="[63,273][1017,373]"/>
</node></hierarchy>`;

function makeDispatcher(result: TestRunResult): TestDispatcher {
  return {
    runFiles: async () => result,
    runAll: async () => result,
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [FILE],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ platform: 'android', package: 'com.example', device: 'emulator-5554', timeout: 5000, retries: 0, projects: [] }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    classifyUnmatchedFile: () => undefined,
    refreshTestFiles: async () => {},
    toggleWatch: () => ({ enabled: true }),
  };
}

async function callRunTests(dispatcher: TestDispatcher, args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer({ dispatcher });
  try {
    const handlers = (server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<CallToolResult>>
    })._requestHandlers;
    const res = await handlers.get('tools/call')?.({ method: 'tools/call', params: { name: 'tapsmith_run_tests', arguments: args } }, {});
    return (res as CallToolResult).content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  } finally {
    server.close();
  }
}

let dir: string;
function trace(events: object[]): string {
  const p = path.join(dir, `trace-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(p, zipSync({
    'trace.json': new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join('\n')),
    'metadata.json': new TextEncoder().encode('{"version":1}'),
  }));
  return p;
}

const missError = `Expected element getByText("Sign Inn", { exact: true }) to be visible, but it was not. ${LOCATOR_PICKER_HINT}`;
const failedStep = { type: 'assertion', assertion: 'toBeVisible', error: 'not visible', duration: 3000 };

function oneFailure(tracePath: string | undefined, error = missError): TestRunResult {
  return {
    status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 10,
    failures: [{ fullName: 'Login > signs in', filePath: FILE, error, tracePath, projectName: 'android' }],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
  deviceTargetFor.mockReset();
  deviceTargetFor.mockResolvedValue({
    client: {
      getUiHierarchy: async () => ({ hierarchyXml: SCREEN, errorMessage: '' }),
      evaluateSelectors: async (selectors: { kind: { type: string; value: unknown } }[]) => ({
        requestId: 'r', errorMessage: '',
        results: selectors.map(() => ({
          elements: [{ elementId: '', className: 'android.widget.TextView', text: 'Sign In', bounds: { left: 63, top: 273, right: 1017, bottom: 373 } }],
          errorMessage: '',
        })),
      }),
    },
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('tapsmith_run_tests on a failed run of one test', () => {
  it('says the device is held and lists the closest elements, on the failed test\'s project and device', async () => {
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep]))), { files: [FILE], test: 'signs in', device: 'emulator-5554' });
    expect(t).toContain('DEVICE HELD: the device is still on the screen where "Login > signs in" failed');
    expect(t).toContain('Closest on screen to getByText("Sign Inn", { exact: true }):\n  - heading "Sign In": device.getByRole("heading", { name: "Sign In" })');
    expect(t).toContain('NEXT STEP: the locator matched nothing on this screen.');
    // Replaces the step that sends the agent to the trace.
    expect(t).not.toContain('Read the failure\'s trace');
    expect(deviceTargetFor).toHaveBeenCalledWith({ device: 'emulator-5554', project: 'android' }, expect.anything());
  });

  it('claims nothing when a hook acted on the device after the failed step', async () => {
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep, { type: 'action', action: 'pressKey', duration: 5 }]))), { files: [FILE] });
    expect(t).not.toContain('DEVICE HELD');
    expect(t).toContain('Read the failure\'s trace');
    expect(deviceTargetFor).not.toHaveBeenCalled();
  });

  it('claims nothing for a run of several tests, and says how to get the screen held', async () => {
    const result = { ...oneFailure(trace([failedStep])), passed: 2 };
    const t = await callRunTests(makeDispatcher(result), { files: [FILE] });
    expect(t).not.toContain('DEVICE HELD');
    expect(t).toContain('To try locators on the screen where it failed, run just that test');
  });

  it('says only that the device is held for a failure that is not a locator miss', async () => {
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep]), 'expected "a" to be "b"')), { files: [FILE] });
    expect(t).toContain('DEVICE HELD');
    expect(t).not.toContain('NEXT STEP');
    expect(deviceTargetFor).not.toHaveBeenCalled();
  });

  it('keeps the failure report when the device cannot be read', async () => {
    deviceTargetFor.mockRejectedValue(new Error('Several devices run project "android"'));
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep]))), { files: [FILE] });
    expect(t).toContain('FAIL: Login > signs in');
    expect(t).toContain('DEVICE HELD');
    expect(t).toContain('(Could not read the screen for the elements closest to getByText("Sign Inn", { exact: true }): Several devices run project "android")');
  });
});
