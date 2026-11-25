import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  test as tapsmithTest,
  beforeAll as tapsmithBeforeAll,
  collectResults,
  _internal,
  type RunOptions,
  type TestResult,
} from '../runner.js';
import { noteActionWarning, takeActionWarnings } from '../action-warnings.js';
import { formatWarnings } from '../reporters/base.js';
import type { TapsmithConfig } from '../config.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { ElementHandle } from '../element-handle.js';
import { _text } from '../selectors.js';
import { Tracing } from '../trace/tracing.js';

const { pushContext, popContext, runSuiteContext } = _internal;

const config: TapsmithConfig = {
  timeout: 30_000, retries: 0, screenshot: 'never', testMatch: [], daemonAddress: 'localhost:50051',
  rootDir: '/tmp', outputDir: 'out', workers: 1, launchEmulators: false,
};

function makeDevice(name?: string) {
  return {
    _client: {}, _traceDeviceId: name,
    tracing: new Tracing(async () => undefined, async () => undefined),
    waitForIdle: vi.fn(async () => {}),
  };
}

type FakeDevice = ReturnType<typeof makeDevice>;

async function run(
  devices: FakeDevice[],
  register: () => void,
  overrides: Partial<TapsmithConfig> = {},
): Promise<{ tests: TestResult[]; reported: TestResult[] }> {
  pushContext();
  register();
  const ctx = popContext();
  const reported: TestResult[] = [];
  const opts = {
    config: { ...config, ...overrides },
    devices: devices.map((device, i) => ({ name: device._traceDeviceId ?? `d${i}`, device })),
    resetCapabilities: {}, runMode: 'test', networkApisInRun: false,
    reporter: { onTestEnd: (t: TestResult) => { reported.push(t); } },
  } as unknown as RunOptions;
  return { tests: collectResults(await runSuiteContext(ctx, '', [], [], opts)), reported };
}

describe('action warnings in test results (PILOT-1495)', () => {
  it('adds them to a failed test, once each, and prints them', async () => {
    const d = makeDevice();
    const { tests: [failed] } = await run([d], () => {
      tapsmithTest('t', async () => {
        noteActionWarning(d._client, 'may only have closed the keyboard');
        noteActionWarning(d._client, 'may only have closed the keyboard');
        throw new Error('not visible');
      });
    });
    expect(failed).toMatchObject({ status: 'failed', warnings: ['may only have closed the keyboard'] });
    expect(formatWarnings(failed).join('\n')).toContain('may only have closed the keyboard');
  });

  it('says nothing for a passing test, and nothing of it reaches the next one', async () => {
    const d = makeDevice();
    const { tests: [passed, next] } = await run([d], () => {
      tapsmithTest('passes', async () => { noteActionWarning(d._client, 'w'); });
      tapsmithTest('fails', async () => { throw new Error('other'); });
    });
    expect(passed).toMatchObject({ status: 'passed' });
    expect(passed.warnings).toBeUndefined();
    expect(next.warnings).toBeUndefined();
  });

  it('reports the attempt whose error is reported', async () => {
    const d = makeDevice();
    let runs = 0;
    const flaky = await run([d], () => {
      tapsmithTest('flaky', async () => {
        if (runs++ > 0) return;
        noteActionWarning(d._client, 'w');
        throw new Error('not visible');
      });
    }, { retries: 1 });
    expect(flaky.reported[0]).toMatchObject({ _willRetry: true, warnings: ['w'] });
    expect(flaky.tests[0]).toMatchObject({ status: 'passed', warnings: ['w'] });

    runs = 0;
    const failed = await run([d], () => {
      tapsmithTest('fails twice', async () => {
        if (runs++ === 0) noteActionWarning(d._client, 'w');
        throw new Error('not visible');
      });
    }, { retries: 1 });
    expect(failed.tests[0].status).toBe('failed');
    expect(failed.tests[0].warnings).toBeUndefined();
  });

  it('names the device of a group', async () => {
    const [a, b] = [makeDevice('alice'), makeDevice('bob')];
    const { tests: [failed] } = await run([a, b], () => {
      tapsmithTest('t', async () => {
        noteActionWarning(b._client, 'w');
        throw new Error('not visible');
      });
    });
    expect(failed.warnings).toEqual(['[bob] w']);
  });

  it('adds a beforeAll\'s to the tests it failed', async () => {
    const d = makeDevice();
    const { tests: [failed] } = await run([d], () => {
      tapsmithBeforeAll(async () => {
        noteActionWarning(d._client, 'w');
        throw new Error('setup');
      });
      tapsmithTest('t', async () => {});
    });
    expect(failed).toMatchObject({ status: 'failed', warnings: ['w'] });
  });
});

describe('an action whose answer carries a warning (PILOT-1495)', () => {
  const tracing = new Tracing(async () => undefined, async () => undefined);
  const element = { elementId: 'e1', enabled: true, visible: true, viewportRatio: 1, text: 'Item 7' };
  const client = (warning: string) => {
    const answer = vi.fn(async () => ({ requestId: '', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0), warning }));
    return {
      findElements: vi.fn(async () => ({ requestId: '', elements: [element], errorMessage: '' })),
      findElement: vi.fn(async () => ({ requestId: '', found: true, element, errorMessage: '' })),
      tap: answer, doubleTap: answer, longPress: answer,
    } as unknown as TapsmithGrpcClient;
  };

  beforeEach(async () => { await tracing.start({ sources: false }); });
  afterEach(async () => { await tracing.stop(); });

  it.each(['tap', 'doubleTap', 'longPress'] as const)('%s(): the step carries it, and so does the test', async (action) => {
    const c = client('may only have closed the keyboard');
    const collector = tracing._currentCollector!;
    const trace = { collector, takeScreenshot: async () => undefined, captureHierarchy: async () => undefined };
    const handle = new ElementHandle(c, _text('Item 7'), 2000);
    Object.defineProperty(handle, '_traceCapture', { get: () => trace });
    await handle[action]();

    const step = collector.events.find((e) => e.type === 'action');
    expect(step).toMatchObject({ action, success: true, warning: 'may only have closed the keyboard' });
    expect((step as { log?: string[] }).log).toContain('Warning: may only have closed the keyboard');
    const [noted] = takeActionWarnings(c);
    expect(noted).toMatch(new RegExp(`^${action}\\(\\) on .*Item 7.*: may only have closed the keyboard$`));
    expect(takeActionWarnings(c)).toEqual([]);
  });

  it('setChecked(): nothing, since the state it read back says the tap worked', async () => {
    const c = client('may only have closed the keyboard');
    let reads = 0;
    c.findElements = vi.fn(async () => ({ requestId: '', elements: [{ ...element, checked: reads++ > 0 }], errorMessage: '' })) as never;
    await new ElementHandle(c, _text('Switch'), 2000).setChecked(true);
    expect(takeActionWarnings(c)).toEqual([]);
  });

  it('setChecked(): the warning, on the step and in the test, when the state did not change', async () => {
    const c = client('may only have closed the keyboard');
    c.findElements = vi.fn(async () => ({ requestId: '', elements: [{ ...element, checked: false }], errorMessage: '' })) as never;
    const collector = tracing._currentCollector!;
    const handle = new ElementHandle(c, _text('Switch'), 300);
    Object.defineProperty(handle, '_traceCapture', { get: () => ({ collector, takeScreenshot: async () => undefined, captureHierarchy: async () => undefined }) });
    await expect(handle.setChecked(true)).rejects.toThrow('did not change');
    expect(collector.events.find((e) => e.type === 'action')).toMatchObject({ success: false, warning: 'may only have closed the keyboard' });
    expect(takeActionWarnings(c)).toEqual([expect.stringMatching(/^setChecked\(\) on .*: may only have closed the keyboard$/)]);
  });

  it('nothing is noted when the answer has none', async () => {
    const c = client('');
    await new ElementHandle(c, _text('Item 7'), 2000).tap();
    expect(takeActionWarnings(c)).toEqual([]);
  });
});
