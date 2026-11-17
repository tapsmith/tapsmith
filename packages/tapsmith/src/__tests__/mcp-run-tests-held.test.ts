import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LOCATOR_PICKER_HINT } from '../locator-miss-hint.js';
import type { TestDispatcher, TestRunResult } from '../mcp/test-dispatcher.js';

// PILOT-1241: tapsmith_run_tests says when the device is still on the screen
// where a run of one test failed (its screen matches the one the failure's
// trace captured), and lists what there is closest to the locator that
// matched nothing.

const deviceTargetFor = vi.hoisted(() => vi.fn());
vi.mock('../mcp/tools/device-target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/tools/device-target.js')>()),
  deviceTargetFor,
}));

const { createMcpServer } = await import('../mcp/index.js');

const FILE = '/proj/e2e/login.test.ts';
const SCREEN = `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
<node class="android.widget.TextView" text="Sign In" tapsmith-role="heading" bounds="[63,273][1017,373]"/>
<node class="android.widget.EditText" text="Email" bounds="[63,400][1017,500]"/>
</node></hierarchy>`;
const HOME = `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
<node class="android.widget.TextView" text="Test Screens" bounds="[63,273][1017,373]"/>
<node class="android.widget.TextView" text="Login Form" bounds="[63,400][1017,500]"/>
</node></hierarchy>`;
let liveScreen = SCREEN;

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
/** A trace whose failed step (action 3) captured `failureScreen`; the test's error is that step's. */
function trace(events: Record<string, unknown>[], failureScreen = SCREEN): string {
  const error = events.find((e) => e.error)?.error as string | undefined;
  const p = path.join(dir, `trace-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(p, zipSync({
    'trace.json': new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join('\n')),
    'metadata.json': new TextEncoder().encode(JSON.stringify({ version: 1, error })),
    'hierarchy/action-003-before.xml': new TextEncoder().encode(failureScreen),
  }));
  return p;
}

const missError = `Expected element getByText("Sign Inn", { exact: true }) to be visible, but it was not. ${LOCATOR_PICKER_HINT}`;
const failedStep = { type: 'assertion', assertion: 'toBeVisible', error: 'not visible', duration: 3000, actionIndex: 3, hasHierarchyBefore: true };

function oneFailure(tracePath: string | undefined, error = missError): TestRunResult {
  return {
    status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 10,
    failures: [{ fullName: 'Login > signs in', filePath: FILE, error, tracePath, projectName: 'android' }],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
  deviceTargetFor.mockReset();
  liveScreen = SCREEN;
  deviceTargetFor.mockResolvedValue({
    client: {
      getUiHierarchy: async () => ({ hierarchyXml: liveScreen, errorMessage: '' }),
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

  it('claims nothing when the screen differs from the failure\'s, and does not say to run just that test again', async () => {
    liveScreen = HOME;
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep, { type: 'action', action: 'pressKey', duration: 5 }]))), { files: [FILE] });
    expect(t).not.toContain('DEVICE HELD');
    expect(t).toContain('The device\'s screen differs from the one the failure\'s trace captured');
    expect(t).toContain('NEXT STEP: the locator matched nothing. Once tapsmith_snapshot shows the screen the test failed on');
    expect(t).not.toContain('run just that test');
  });

  it('a failMissing-shaped miss (toHaveText on nothing) gets the closest list and next step', async () => {
    const error = `Expected element getByText("Sign Inn") to have text "Sign In", but no element matched. ${LOCATOR_PICKER_HINT}`;
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep]), error)), { files: [FILE] });
    expect(t).toContain('Closest on screen to getByText("Sign Inn"):');
    expect(t).toContain('NEXT STEP: the locator matched nothing on this screen.');
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
  });

  it('claims nothing, and keeps the usual step, when the device cannot be found', async () => {
    deviceTargetFor.mockRejectedValue(new Error('Several devices run project "android"'));
    const t = await callRunTests(makeDispatcher(oneFailure(trace([failedStep]))), { files: [FILE] });
    expect(t).toContain('FAIL: Login > signs in');
    expect(t).not.toContain('DEVICE HELD');
    expect(t).toContain('Read the failure\'s trace');
    // It already was one test: no advice to run it alone.
    expect(t).not.toContain('run just that test');
  });

  it('claims nothing without a trace, and does not say to run the one test it just ran', async () => {
    const t = await callRunTests(makeDispatcher(oneFailure(undefined)), { files: [FILE] });
    expect(t).not.toContain('DEVICE HELD');
    expect(t).not.toContain('run just that test');
    expect(deviceTargetFor).not.toHaveBeenCalled();
  });
});
