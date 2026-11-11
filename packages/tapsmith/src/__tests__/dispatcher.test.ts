import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  planMultiBucket,
  mergeBucketResults,
  sendToWorkerProcess,
  PORTS_PER_BUCKET,
  handleParallelTestStartMessage,
  handleParallelTestEndMessage,
  handleParallelFileRetryMessage,
  handleParallelFileDoneMessage,
  pinnedWorkerDevices,
  isLaunchSetupError,
  LaunchSetupError,
  coordinateBuckets,
  deviceTargetLabel,
  targetStartFailureResults,
  noTargetCouldStart,
  targetUnavailableMessage,
  targetStartWarning,
  workerFailureMessage,
  skippingDeviceNotice,
  type BucketRunner,
  type DispatcherOptions,
} from '../dispatcher.js';
import { serializeTestResult, serializeSuiteResult } from '../worker-protocol.js';
import { withDetail } from '../error-detail.js';
import type { ResolvedProject } from '../project.js';
import type { TapsmithConfig } from '../config.js';
import type { FullResult } from '../reporter.js';
import type { LaunchProgressSink, LaunchStepId, LaunchStepState } from '../launch-progress.js';
import type { SuiteResult, TestResult } from '../runner.js';

// Planning is pure: we don't need a real reporter / testFiles — just enough
// of the DispatcherOptions shape to exercise the bucket logic.
function stubReporter(): DispatcherOptions['reporter'] {
  return {
    onRunStart: async () => {},
    onTestFileStart: () => {},
    onTestStart: () => {},
    onTestEnd: () => {},
    onTestFileEnd: () => {},
    onRunEnd: async () => {},
  } as unknown as DispatcherOptions['reporter'];
}

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'tapsmith-results',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function makeProject(
  name: string,
  deviceSignature: string,
  testFiles: string[],
  overrides: Partial<ResolvedProject> = {},
): ResolvedProject {
  return {
    name,
    testMatch: ['**/*.test.ts'],
    testIgnore: [],
    dependencies: [],
    testFiles,
    effectiveConfig: makeConfig(),
    deviceSignature,
    ...overrides,
  };
}

function makeOpts(projects: ResolvedProject[], workers: number): DispatcherOptions {
  return {
    config: makeConfig({ workers }),
    reporter: stubReporter(),
    testFiles: projects.flatMap((p) => p.testFiles),
    workers,
    forceInstall: false,
    networkApisInRun: false,
    projects,
  };
}

// ─── planMultiBucket ───

describe('planMultiBucket()', () => {
  it('assigns non-overlapping port ranges to each bucket', () => {
    const projects = [
      makeProject('a', 'android|emu1||', ['t1.test.ts']),
      makeProject('b', 'ios|iPhone 16|', ['t2.test.ts']),
      makeProject('c', 'android|emu2||', ['t3.test.ts']),
    ];
    const opts = makeOpts(projects, 3);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
      ['2-android|emu2||', 1],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.portOffset)).toEqual([
      0,
      PORTS_PER_BUCKET,
      PORTS_PER_BUCKET * 2,
    ]);
    // Each plan must have a strictly higher offset than the previous.
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].portOffset).toBeGreaterThanOrEqual(
        plans[i - 1].portOffset + PORTS_PER_BUCKET,
      );
    }
  });

  // Each bucket is its own runParallel call; a flag the plan dropped would
  // reach no worker of a multi-target run (PILOT-261).
  it('hands --force-install to every bucket', () => {
    const projects = [
      makeProject('a', 'android|emu1||', ['t1.test.ts']),
      makeProject('b', 'ios|iPhone 16|', ['t2.test.ts']),
    ];
    const plans = planMultiBucket({ ...makeOpts(projects, 2), forceInstall: true }, new Map([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
    ]));
    expect(plans.map((p) => p.bucketOpts.forceInstall)).toEqual([true, true]);
  });

  it('hands every bucket whether the run uses the network APIs (PILOT-1013)', () => {
    const projects = [
      makeProject('a', 'android|emu1||', ['t1.test.ts']),
      makeProject('b', 'ios|iPhone 16|', ['t2.test.ts']),
    ];
    const plans = planMultiBucket({ ...makeOpts(projects, 2), networkApisInRun: true }, new Map([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
    ]));
    expect(plans.map((p) => p.bucketOpts.networkApisInRun)).toEqual([true, true]);
  });

  it('routes each file only to the bucket that owns it', () => {
    const projects = [
      makeProject('android-smoke', 'android|emu1||', ['a.test.ts', 'b.test.ts']),
      makeProject('ios-smoke', 'ios|iPhone 16|', ['c.test.ts']),
    ];
    const opts = makeOpts(projects, 2);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans[0].bucketOpts.testFiles).toEqual(['a.test.ts', 'b.test.ts']);
    expect(plans[1].bucketOpts.testFiles).toEqual(['c.test.ts']);
    // A file must not leak between buckets.
    expect(plans[0].bucketOpts.testFiles).not.toContain('c.test.ts');
    expect(plans[1].bucketOpts.testFiles).not.toContain('a.test.ts');
  });

  it('passes the bucket-specific worker count into bucketOpts', () => {
    const projects = [
      makeProject('android', 'android|emu1||', ['a.test.ts'], { workers: 3 }),
      makeProject('ios', 'ios|iPhone 16|', ['b.test.ts']),
    ];
    const opts = makeOpts(projects, 2);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 3],
      ['1-ios|iPhone 16|', 2],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans[0].bucketOpts.workers).toBe(3);
    expect(plans[1].bucketOpts.workers).toBe(2);
  });

  it('omits buckets that received zero workers', () => {
    const projects = [
      makeProject('android', 'android|emu1||', ['a.test.ts']),
      makeProject('ios', 'ios|iPhone 16|', ['b.test.ts']),
    ];
    const opts = makeOpts(projects, 1);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 0],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans).toHaveLength(1);
    expect(plans[0].bucketOpts.workers).toBe(1);
  });

  it('keeps correct portOffset and workerIndexBase when a middle bucket has zero workers', () => {
    // Regression guard: if we incremented workerIndexBase for skipped buckets
    // or reused indices for portOffset, later buckets would collide.
    const projects = [
      makeProject('android1', 'android|emu1||', ['a.test.ts']),
      makeProject('android2', 'android|emu2||', ['b.test.ts']),
      makeProject('ios', 'ios|iPhone 16|', ['c.test.ts']),
    ];
    const opts = makeOpts(projects, 3);
    // Middle bucket (emu2) gets 0 workers; first and last get 2 each.
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 2],
      ['1-android|emu2||', 0],
      ['2-ios|iPhone 16|', 2],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans).toHaveLength(2);

    // First bucket: original index 0 → portOffset 0, workerIndexBase 0.
    expect(plans[0].bucketOpts.workers).toBe(2);
    expect(plans[0].portOffset).toBe(0);
    expect(plans[0].bucketOpts.workerIndexBase).toBe(0);

    // Third bucket: original index 2 → portOffset 2 * PORTS_PER_BUCKET,
    // workerIndexBase = 2 (one past the first bucket's 2 workers; the skipped
    // middle bucket contributes nothing).
    expect(plans[1].bucketOpts.workers).toBe(2);
    expect(plans[1].portOffset).toBe(PORTS_PER_BUCKET * 2);
    expect(plans[1].bucketOpts.workerIndexBase).toBe(2);
  });

  it('filters projectWaves to each bucket independently', () => {
    const androidA = makeProject('a-android', 'android|emu1||', ['a.test.ts']);
    const iosB = makeProject('b-ios', 'ios|iPhone 16|', ['b.test.ts']);
    const androidC = makeProject('c-android', 'android|emu1||', ['c.test.ts'], {
      dependencies: ['a-android'],
    });
    const projects = [androidA, iosB, androidC];
    const opts: DispatcherOptions = {
      ...makeOpts(projects, 2),
      // Wave 0: roots (androidA, iosB). Wave 1: androidC depends on androidA.
      projectWaves: [[androidA, iosB], [androidC]],
    };
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
    ]);

    const plans = planMultiBucket(opts, allocation);

    // Android bucket: wave 0 = [androidA], wave 1 = [androidC]
    const androidWaves = plans[0].bucketOpts.projectWaves ?? [];
    expect(androidWaves).toHaveLength(2);
    expect(androidWaves[0].map((p) => p.name)).toEqual(['a-android']);
    expect(androidWaves[1].map((p) => p.name)).toEqual(['c-android']);

    // iOS bucket: wave 0 = [iosB] only, wave 1 dropped entirely (empty after filter)
    const iosWaves = plans[1].bucketOpts.projectWaves ?? [];
    expect(iosWaves).toHaveLength(1);
    expect(iosWaves[0].map((p) => p.name)).toEqual(['b-ios']);
  });
});

// ─── parallel worker message accounting ───

describe('parallel worker message accounting', () => {
  function makeTest(id: string, overrides: Partial<TestResult> = {}): TestResult {
    return {
      name: id,
      fullName: id,
      status: 'passed',
      durationMs: 10,
      ...overrides,
    };
  }

  function makeSuite(tests: TestResult[]): SuiteResult {
    return { name: '', tests, suites: [], durationMs: 10 };
  }

  it('adds worker base and project metadata to parallel test start events', () => {
    const starts: Array<{
      fullName: string
      filePath: string | undefined
      info: { workerIndex?: number; project?: string } | undefined
    }> = [];
    const reporter = {
      onTestStart(
        fullName: string,
        filePath?: string,
        info?: { workerIndex?: number; project?: string },
      ): void {
        starts.push({ fullName, filePath, info });
      },
    };

    handleParallelTestStartMessage({
      type: 'test-start',
      workerId: 1,
      fullName: 'suite > test',
      filePath: '/test.ts',
      projectName: 'ios',
    }, reporter, 10);

    expect(starts).toEqual([{
      fullName: 'suite > test',
      filePath: '/test.ts',
      info: { workerIndex: 11, project: 'ios' },
    }]);
  });

  it('discards only final streamed results on retry and keeps file-done results canonical', () => {
    const workerTestCounts = new Map<number, number>();
    const reportedTests: TestResult[] = [];
    const retryEvents: Array<{ filePath: string; discardedCount: number }> = [];
    const reporter = {
      onTestEnd(test: TestResult): void {
        reportedTests.push(test);
      },
      onTestFileRetry(filePath: string, discardedCount: number): void {
        retryEvents.push({ filePath, discardedCount });
      },
    };

    workerTestCounts.set(0, 0);
    handleParallelTestEndMessage({
      type: 'test-end',
      workerId: 0,
      result: serializeTestResult(makeTest('first kept'), 0),
    }, workerTestCounts, reporter, 10);
    handleParallelTestEndMessage({
      type: 'test-end',
      workerId: 0,
      result: serializeTestResult(makeTest('test-level retry', {
        status: 'failed',
        error: new Error('first attempt'),
        retry: 0,
        _willRetry: true,
      }), 0),
    }, workerTestCounts, reporter, 10);
    handleParallelTestEndMessage({
      type: 'test-end',
      workerId: 0,
      result: serializeTestResult(makeTest('infra failure', {
        status: 'failed',
        error: new Error('Agent connection dropped'),
      }), 0),
    }, workerTestCounts, reporter, 10);

    expect(reportedTests.map((t) => t.fullName)).toEqual([
      'first kept',
      'test-level retry',
      'infra failure',
    ]);
    expect(reportedTests.map((t) => t.workerIndex)).toEqual([10, 10, 10]);
    expect(workerTestCounts.get(0)).toBe(2);

    const discarded = handleParallelFileRetryMessage({
      type: 'file-retry',
      workerId: 0,
      filePath: '/test.ts',
    }, workerTestCounts, reporter);

    expect(discarded).toBe(2);
    expect(workerTestCounts.get(0)).toBe(0);
    expect(retryEvents).toEqual([{ filePath: '/test.ts', discardedCount: 2 }]);

    const retryResult = makeTest('retry kept');
    handleParallelTestEndMessage({
      type: 'test-end',
      workerId: 0,
      result: serializeTestResult(retryResult, 0),
    }, workerTestCounts, reporter, 10);

    const { results, suite } = handleParallelFileDoneMessage({
      type: 'file-done',
      workerId: 0,
      filePath: '/test.ts',
      results: [serializeTestResult(retryResult, 0)],
      suite: serializeSuiteResult(makeSuite([retryResult]), 0),
    }, workerTestCounts, 10);
    const allResults: TestResult[] = [];
    allResults.push(...results);

    expect(workerTestCounts.has(0)).toBe(false);
    expect(allResults.map((t) => t.fullName)).toEqual(['retry kept']);
    expect(allResults[0].workerIndex).toBe(10);
    expect(suite.tests.map((t) => t.fullName)).toEqual(['retry kept']);
    expect(suite.tests[0].workerIndex).toBe(10);
  });
});

// ─── mergeBucketResults ───

describe('mergeBucketResults()', () => {
  function makeTest(id: string, status: TestResult['status'] = 'passed'): TestResult {
    return {
      name: id,
      fullName: id,
      status,
      durationMs: 10,
    };
  }

  function makeSuite(name: string): SuiteResult {
    return { name, tests: [], suites: [], durationMs: 0 };
  }

  function makeFullResult(
    status: FullResult['status'],
    duration: number,
    tests: TestResult[],
    setupDuration = 0,
  ): FullResult {
    return {
      status,
      duration,
      setupDuration,
      tests,
      suites: tests.map((t) => makeSuite(t.name)),
    };
  }

  it('uses max duration (buckets run in parallel)', () => {
    const a = makeFullResult('passed', 5000, [makeTest('a')]);
    const b = makeFullResult('passed', 7000, [makeTest('b')]);
    const merged = mergeBucketResults([a, b]);
    expect(merged.duration).toBe(7000);
  });

  it('uses max setupDuration', () => {
    const a = makeFullResult('passed', 1000, [makeTest('a')], 3000);
    const b = makeFullResult('passed', 1000, [makeTest('b')], 5000);
    const merged = mergeBucketResults([a, b]);
    expect(merged.setupDuration).toBe(5000);
  });

  it('concatenates tests and suites across buckets without dropping any', () => {
    const a = makeFullResult('passed', 1000, [makeTest('a1'), makeTest('a2')]);
    const b = makeFullResult('passed', 1000, [makeTest('b1')]);
    const merged = mergeBucketResults([a, b]);
    expect(merged.tests.map((t) => t.name)).toEqual(['a1', 'a2', 'b1']);
    expect(merged.suites).toHaveLength(3);
  });

  it('marks the merged run failed when any bucket failed', () => {
    const a = makeFullResult('passed', 1000, [makeTest('a')]);
    const b = makeFullResult('failed', 1000, [makeTest('b', 'failed')]);
    expect(mergeBucketResults([a, b]).status).toBe('failed');
  });

  it('returns passed and zero durations for an empty input (no buckets ran)', () => {
    const merged = mergeBucketResults([]);
    expect(merged.status).toBe('passed');
    expect(merged.duration).toBe(0);
    expect(merged.setupDuration).toBe(0);
    expect(merged.tests).toEqual([]);
    expect(merged.suites).toEqual([]);
  });
});

// ─── sendToWorkerProcess (PILOT-228) ───

describe('sendToWorkerProcess()', () => {
  function fakeProc(overrides: Partial<ChildProcess>): ChildProcess {
    return { connected: true, ...overrides } as unknown as ChildProcess;
  }

  /** Let queued microtasks (deferred failure callbacks) run. */
  const flushMicrotasks = () => new Promise<void>((r) => { setTimeout(r, 0); });

  it('reports failure without calling send() when the IPC channel is closed', async () => {
    const send = vi.fn();
    const onSendFailure = vi.fn();
    sendToWorkerProcess(fakeProc({ connected: false, send }), { type: 'shutdown' }, onSendFailure);
    expect(send).not.toHaveBeenCalled();
    // Deferred: callers must not be re-entered synchronously mid-dispatch-loop.
    expect(onSendFailure).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(onSendFailure).toHaveBeenCalledOnce();
    expect(onSendFailure.mock.calls[0][0].message).toMatch(/IPC channel is closed/);
  });

  it('reports an asynchronous send failure (EPIPE to a dead child) instead of crashing', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const send = vi.fn((_msg: unknown, cb: (err: Error | null) => void) => {
      cb(epipe);
      return true;
    });
    const onSendFailure = vi.fn();
    sendToWorkerProcess(fakeProc({ send: send as unknown as ChildProcess['send'] }), { type: 'shutdown' }, onSendFailure);
    await flushMicrotasks();
    expect(onSendFailure).toHaveBeenCalledOnce();
    expect(onSendFailure.mock.calls[0][0]).toBe(epipe);
  });

  it('reports a synchronous send throw (ERR_IPC_CHANNEL_CLOSED race)', async () => {
    const send = vi.fn(() => {
      throw new Error('Channel closed');
    });
    const onSendFailure = vi.fn();
    sendToWorkerProcess(fakeProc({ send: send as unknown as ChildProcess['send'] }), { type: 'shutdown' }, onSendFailure);
    expect(onSendFailure).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(onSendFailure).toHaveBeenCalledOnce();
    expect(onSendFailure.mock.calls[0][0].message).toMatch(/Channel closed/);
  });

  it('does not report failure on a successful send', async () => {
    const send = vi.fn((_msg: unknown, cb: (err: Error | null) => void) => {
      cb(null);
      return true;
    });
    const onSendFailure = vi.fn();
    sendToWorkerProcess(fakeProc({ send: send as unknown as ChildProcess['send'] }), { type: 'shutdown' }, onSendFailure);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledOnce();
    expect(onSendFailure).not.toHaveBeenCalled();
  });
});

// A fully pinned device group (`--device`, root `device`, every `use.devices`
// member pinned) runs on exactly its pins. The Android branch used to pick
// from whatever was connected and ignore a `--device` pin (PILOT-261).
describe('pinnedWorkerDevices', () => {
  it('returns every pin, primary first, when all are connected', () => {
    const group = [{ name: 'alice', device: 'emulator-5556' }, { name: 'bob', device: 'emulator-5554' }];
    expect(pinnedWorkerDevices(group, ['emulator-5554', 'emulator-5556', 'emulator-5558'], false, []))
      .toEqual(['emulator-5556', 'emulator-5554']);
  });

  it('is undefined while any member is left to auto-pick', () => {
    expect(pinnedWorkerDevices([{ name: 'alice', device: 'X' }, { name: 'bob' }], ['X', 'Y'], false, [])).toBeUndefined();
    expect(pinnedWorkerDevices([{ name: 'device-1' }], ['X'], false, [])).toBeUndefined();
  });

  it('refuses an Android pin that is not connected, naming what is', () => {
    let error: unknown;
    try {
      pinnedWorkerDevices([{ name: 'device-1', device: 'emulator-5560' }], ['emulator-5554'], false, []);
    } catch (err) {
      error = err;
    }
    expect(isLaunchSetupError(error)).toBe(true);
    expect((error as Error).message).toContain('emulator-5560');
    expect((error as Error).message).toContain('Connected: emulator-5554');
  });

  it('says nothing is connected rather than listing an empty set', () => {
    expect(() => pinnedWorkerDevices([{ name: 'device-1', device: 'emulator-5560' }], [], false, []))
      .toThrow(/No Android devices are connected/);
  });

  // PILOT-457: an unauthorized phone is attached, not missing.
  it('names the adb state and fix of a pin adb lists but cannot use', () => {
    let error: unknown;
    try {
      pinnedWorkerDevices(
        [{ name: 'alice', device: 'R5CR1234XYZ' }, { name: 'bob', device: 'emulator-5560' }],
        ['emulator-5554'],
        false,
        [{ serial: 'R5CR1234XYZ', state: 'unauthorized' }],
      );
    } catch (err) {
      error = err;
    }
    expect(isLaunchSetupError(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain('R5CR1234XYZ is attached, but adb reports it unauthorized. Accept the USB debugging prompt on the device.');
    expect(message).not.toMatch(/R5CR1234XYZ[^.]*not connected/);
    expect(message).toContain('Pinned device emulator-5560 is not connected');
  });

  it('does not follow "attached" with "No Android devices are connected"', () => {
    expect(() => pinnedWorkerDevices(
      [{ name: 'device-1', device: 'R5C' }],
      [],
      false,
      [{ serial: 'R5C', state: 'unauthorized' }],
    )).toThrow(/^Pinned device R5C is attached, but adb reports it unauthorized\. Accept the USB debugging prompt on the device\.$/);
  });

  it('still lists the connected devices when every missing pin is attached but unusable', () => {
    expect(() => pinnedWorkerDevices(
      [{ name: 'device-1', device: 'R5C' }],
      ['emulator-5554'],
      false,
      [{ serial: 'R5C', state: 'unauthorized' }],
    )).toThrow(/Accept the USB debugging prompt on the device\. Connected: emulator-5554\.$/);
  });

  it('never calls a pin adb lists as usable "attached but unusable" (it came online between two adb calls)', () => {
    expect(() => pinnedWorkerDevices(
      [{ name: 'device-1', device: 'emulator-5560' }],
      [],
      false,
      [{ serial: 'emulator-5560', state: 'device' }],
    )).toThrow(/Pinned device emulator-5560 is not connected/);
  });

  it('takes iOS pins as given: the daemon lists only booted simulators, and the sequential path does not require one', () => {
    expect(pinnedWorkerDevices([{ name: 'device-1', device: 'SIM-UDID' }], [], true, [])).toEqual(['SIM-UDID']);
  });
});

// ─── coordinateBuckets ───

// A multi-target run (android + ios projects) used to abort every bucket when
// one could not start: the ready bucket's tests never ran (PILOT-400). Now a
// bucket that fails before dispatch is reported — each of its files failed,
// with the target-labelled reason — and the other buckets still run, the way
// Playwright fails a project whose browser cannot launch and runs the rest.
describe('coordinateBuckets()', () => {
  interface Recorder {
    reporter: DispatcherOptions['reporter']
    events: string[]
    ended: TestResult[]
  }

  function recordingReporter(): Recorder {
    const events: string[] = [];
    const ended: TestResult[] = [];
    const reporter = {
      onRunStart: () => { events.push('run-start'); },
      onTestFileStart: (f: string) => { events.push(`file-start:${f}`); },
      onTestStart: () => {},
      onTestEnd: (t: TestResult) => { events.push(`end:${t.project}:${t.name}`); ended.push(t); },
      onTestFileEnd: (f: string) => { events.push(`file-end:${f}`); },
      onRunEnd: async () => {},
    } as unknown as DispatcherOptions['reporter'];
    return { reporter, events, ended };
  }

  interface ProgressRecorder {
    sink: LaunchProgressSink
    log: Array<{ id: LaunchStepId; state: LaunchStepState | 'finish'; detail?: string }>
  }

  function recordingProgress(): ProgressRecorder {
    const log: ProgressRecorder['log'] = [];
    const sink: LaunchProgressSink = {
      start: (id, detail) => { log.push({ id, state: 'running', detail }); },
      complete: (id, detail) => { log.push({ id, state: 'done', detail }); },
      fail: (id, detail) => { log.push({ id, state: 'failed', detail }); },
      hasFailure: () => log.some((e) => e.state === 'failed'),
      shownFailures: () => [],
      skip: (id, detail) => { log.push({ id, state: 'skipped', detail }); },
      update: (id, patch) => { if (patch.state) log.push({ id, state: patch.state, detail: patch.detail }); },
      note: () => {},
      finish: () => { log.push({ id: 'browser', state: 'finish' }); },
    };
    return { sink, log };
  }

  function passing(name: string, project: string): FullResult {
    return {
      status: 'passed',
      duration: 100,
      setupDuration: 10,
      tests: [{ name, fullName: name, status: 'passed', durationMs: 5, project }],
      suites: [],
    };
  }

  /** A bucket that reaches the barrier, then (once released) returns `result`. */
  function readyBucket(label: string, projects: ResolvedProject[], result: FullResult, onDispatch?: () => void): BucketRunner {
    return {
      label,
      projects,
      run: async (beforeDispatch) => {
        await beforeDispatch();
        onDispatch?.();
        return result;
      },
    };
  }

  /** A bucket whose start fails with `err`, optionally after `delayMs`. */
  function failingBucket(label: string, projects: ResolvedProject[], err: unknown, delayMs = 0): BucketRunner {
    return {
      label,
      projects,
      run: async () => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        throw err;
      },
    };
  }

  function coordination(rec: Recorder, progress?: ProgressRecorder) {
    return {
      config: makeConfig(),
      reporter: rec.reporter,
      testFileCount: 3,
      launchProgress: progress?.sink,
      totalWorkers: 2,
      readyCounter: { count: 1 },
      phaseCounters: {
        daemon: { count: 1 },
        'app-install': { count: 1 },
        agent: { count: 1 },
        'app-launch': { count: 1 },
      },
      quiet: true,
    };
  }

  const androidProject = makeProject('android', 'android|Pixel_6', ['/t/a.test.ts', '/t/b.test.ts']);
  const iosProject = makeProject('ios', 'ios|iPhone 17', ['/t/a.test.ts']);

  it('runs the ready bucket and reports the failed bucket\'s files as failed with a labelled reason', async () => {
    const rec = recordingReporter();
    let iosDispatched = false;
    const result = await coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('No worker could start: launcher ANR\ndetails')),
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios'), () => { iosDispatched = true; }),
    ], coordination(rec));

    expect(iosDispatched).toBe(true);
    expect(result.status).toBe('failed');
    const failed = result.tests.filter((t) => t.status === 'failed');
    expect(failed.map((t) => [t.project, t.name, t.filePath])).toEqual([
      ['android', 'a.test.ts', '/t/a.test.ts'],
      ['android', 'b.test.ts', '/t/b.test.ts'],
    ]);
    // The whole reason: its later lines carry the hints.
    expect(failed[0].error?.message).toBe('Device target "android Pixel_6" could not start: No worker could start: launcher ANR\n  details');
    expect(result.tests.filter((t) => t.status === 'passed').map((t) => t.name)).toEqual(['ios test']);
  });

  it('prints a failed target\'s whole reason indented under its warning', async () => {
    const rec = recordingReporter();
    let stderr = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    try {
      await coordinateBuckets([
        failingBucket('ios iPhone 17', [iosProject], new LaunchSetupError('iOS simulator agent build failed (exit 65)\nerror: x\nFull build log: /tmp/b.log')),
        readyBucket('android Pixel_6', [androidProject], passing('android test', 'android')),
      ], { ...coordination(rec), quiet: false });
    } finally {
      spy.mockRestore();
    }
    const plain = stderr.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain(
      'Device target ios iPhone 17 could not start; its 1 test file(s) are reported as failed. The other device targets still run.\n'
      + '  iOS simulator agent build failed (exit 65)\n  error: x\n  Full build log: /tmp/b.log\n',
    );
  });

  it('reports the failed files after onRunStart and before the ready bucket dispatches', async () => {
    const rec = recordingReporter();
    await coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('boom')),
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios'), () => { rec.events.push('ios-dispatch'); }),
    ], coordination(rec));
    expect(rec.events).toEqual([
      'run-start',
      'file-start:/t/a.test.ts', 'end:android:a.test.ts', 'file-end:/t/a.test.ts',
      'file-start:/t/b.test.ts', 'end:android:b.test.ts', 'file-end:/t/b.test.ts',
      'ios-dispatch',
    ]);
  });

  it('waits for a bucket that fails after the ready one reached the barrier', async () => {
    const rec = recordingReporter();
    const result = await coordinateBuckets([
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios')),
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('late'), 20),
    ], coordination(rec));
    expect(result.tests.map((t) => t.status).sort()).toEqual(['failed', 'failed', 'passed']);
  });

  it('reports failed targets in bucket order, whatever order they failed in', async () => {
    const rec = recordingReporter();
    const third = makeProject('ios-ipad', 'ios|iPad', ['/t/c.test.ts']);
    const result = await coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('slow'), 15),
      readyBucket('ios iPhone 17', [iosProject], passing('one', 'ios')),
      failingBucket('ios iPad', [third], new LaunchSetupError('fast')),
    ], coordination(rec));
    expect(result.tests.filter((t) => t.status === 'failed').map((t) => t.project)).toEqual(['android', 'android', 'ios-ipad']);
  });

  it('keeps a three-bucket barrier counting a failed start as arrived', async () => {
    const rec = recordingReporter();
    const third = makeProject('ios-ipad', 'ios|iPad', ['/t/c.test.ts']);
    const result = await coordinateBuckets([
      readyBucket('ios iPhone 17', [iosProject], passing('one', 'ios')),
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('x'), 5),
      readyBucket('ios iPad', [third], passing('two', 'ios-ipad')),
    ], coordination(rec));
    expect(result.tests.filter((t) => t.status === 'passed').map((t) => t.name)).toEqual(['one', 'two']);
  });

  it('reports every file of every project in the failed bucket, and none for a project with no files', async () => {
    const rec = recordingReporter();
    const setup = makeProject('android:setup', 'android|Pixel_6', ['/t/auth.setup.ts']);
    const empty = makeProject('android:empty', 'android|Pixel_6', []);
    const result = await coordinateBuckets([
      failingBucket('android Pixel_6', [setup, androidProject, empty], new LaunchSetupError('x')),
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios')),
    ], coordination(rec));
    expect(result.tests.filter((t) => t.status === 'failed').map((t) => `${t.project}:${t.name}`)).toEqual([
      'android:setup:auth.setup.ts',
      'android:a.test.ts',
      'android:b.test.ts',
    ]);
  });

  it('treats any error before the barrier as a failed start while another bucket runs', async () => {
    const rec = recordingReporter();
    const result = await coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new TypeError('adb exploded')),
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios')),
    ], coordination(rec));
    expect(result.tests.find((t) => t.status === 'failed')?.error?.message)
      .toBe('Device target "android Pixel_6" could not start: adb exploded');
  });

  it('fails to start, listing each target\'s reason, when every bucket fails', async () => {
    const rec = recordingReporter();
    const run = coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('No online devices found.\nhint')),
      failingBucket('ios iPhone 17', [iosProject], new LaunchSetupError('No booted iOS simulators found.'), 5),
    ], coordination(rec));
    await expect(run).rejects.toSatisfy((err: unknown) => {
      if (!isLaunchSetupError(err)) return false;
      const [summary, ...details] = err.message.split('\n');
      return summary === 'No device target could start'
        && details.includes('android Pixel_6: No online devices found.')
        && details.includes('ios iPhone 17: No booted iOS simulators found.');
    });
    expect(rec.events).not.toContain('run-start');
  });

  it('puts the failed files in suites too, so suite-driven reporters (JUnit, JSON) list them', async () => {
    const rec = recordingReporter();
    const iosResult = { ...passing('ios test', 'ios'), suites: [{ name: '', tests: [], suites: [], durationMs: 5 }] };
    const result = await coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('x')),
      readyBucket('ios iPhone 17', [iosProject], iosResult),
    ], coordination(rec));
    expect(result.suites).toHaveLength(3);
    expect(result.suites.slice(0, 2).map((s) => s.tests.map((t) => `${t.project}:${t.name}:${t.status}`))).toEqual([
      ['android:a.test.ts:failed'],
      ['android:b.test.ts:failed'],
    ]);
  });

  it('keeps each target\'s hint lines when every bucket fails', async () => {
    const rec = recordingReporter();
    const run = coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('Failed to start worker daemon.\nRun: lsof -ti tcp:50052 | xargs kill')),
      failingBucket('ios iPhone 17', [iosProject], new LaunchSetupError('No booted iOS simulators found.')),
    ], coordination(rec));
    await expect(run).rejects.toThrow(/android Pixel_6: Failed to start worker daemon\.\n {2}Run: lsof -ti tcp:50052 \| xargs kill\nios iPhone 17: No booted/);
  });

  it('throws a lone bucket\'s own error unchanged, as a single-target run would', async () => {
    const rec = recordingReporter();
    const err = new LaunchSetupError('No worker could start: ANR\nWorker 0 (emulator-5554): ANR\nFix the worker failure above');
    await expect(coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], err),
    ], coordination(rec))).rejects.toBe(err);
  });

  it('returns an empty passing result for no buckets', async () => {
    const rec = recordingReporter();
    const result = await coordinateBuckets([], coordination(rec));
    expect(result.status).toBe('passed');
    expect(result.tests).toEqual([]);
  });

  it('lists every target when every bucket fails, a plain-Error provisioning failure included', async () => {
    const rec = recordingReporter();
    const plain = new Error('Physical iOS device bucket failed to resolve');
    let caught: unknown;
    try {
      await coordinateBuckets([
        failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('No online devices found.')),
        failingBucket('ios iPhone 17', [iosProject], plain),
      ], coordination(rec));
    } catch (err) {
      caught = err;
    }
    expect(isLaunchSetupError(caught)).toBe(true);
    expect((caught as Error).message).toContain('android Pixel_6: No online devices found.');
    expect((caught as Error).message).toContain('ios iPhone 17: Physical iOS device bucket failed to resolve');
  });

  it('rethrows a programming error as itself when every bucket fails, so it shows as a bug with its stack', async () => {
    const rec = recordingReporter();
    const bug = new TypeError("Cannot read properties of undefined (reading 'serial')");
    await expect(coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('No online devices found.')),
      failingBucket('ios iPhone 17', [iosProject], bug),
    ], coordination(rec))).rejects.toBe(bug);
  });

  it('releases the barrier even when rendering the start throws, so no bucket hangs', async () => {
    const rec = recordingReporter();
    let released = false;
    const throwing = { ...rec.reporter, onRunStart: () => { throw new Error('reporter bug'); } } as unknown as DispatcherOptions['reporter'];
    const run = coordinateBuckets([
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios'), () => { released = true; }),
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('x'), 5),
    ], { ...coordination(rec), reporter: throwing });
    await expect(run).rejects.toThrow('reporter bug');
    expect(released).toBe(true);
  });

  it('still rejects the run for a bucket that fails after dispatch, once every bucket has settled', async () => {
    const rec = recordingReporter();
    let iosFinished = false;
    const midRun = new Error('All workers became unavailable');
    await expect(coordinateBuckets([
      { label: 'android Pixel_6', projects: [androidProject], run: async (before) => { await before(); throw midRun; } },
      { label: 'ios iPhone 17', projects: [iosProject], run: async (before) => {
        await before();
        await new Promise((r) => setTimeout(r, 20));
        iosFinished = true;
        return passing('ios test', 'ios');
      } },
    ], coordination(rec))).rejects.toBe(midRun);
    // The sibling ran to its own teardown instead of being orphaned by an
    // early rejection (the process exits right after).
    expect(iosFinished).toBe(true);
  });

  it('shows a failed bucket as a launch warning, not a failure, when another bucket runs', async () => {
    const rec = recordingReporter();
    const progress = recordingProgress();
    await coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('No worker could start: ANR')),
      readyBucket('ios iPhone 17', [iosProject], passing('ios test', 'ios')),
    ], coordination(rec, progress));
    expect(progress.log.filter((e) => e.state === 'failed')).toEqual([]);
    const devices = progress.log.filter((e) => e.id === 'worker-devices').at(-1);
    expect(devices?.state).toBe('warning');
    expect(devices?.detail).toContain('android Pixel_6 could not start: No worker could start: ANR');
    expect(progress.log.at(-1)?.state).toBe('finish');
  });

  it('marks the launch failed when every bucket fails', async () => {
    const rec = recordingReporter();
    const progress = recordingProgress();
    await expect(coordinateBuckets([
      failingBucket('android Pixel_6', [androidProject], new LaunchSetupError('a')),
      failingBucket('ios iPhone 17', [iosProject], new LaunchSetupError('b')),
    ], coordination(rec, progress))).rejects.toThrow();
    expect(progress.log.some((e) => e.id === 'worker-devices' && e.state === 'failed')).toBe(true);
    expect(progress.log.at(-1)?.state).toBe('finish');
  });
});

// The sequential path reports a target that cannot start with the same
// results as the parallel one.
describe('targetStartFailureResults()', () => {
  it('labels the target from its signature', () => {
    expect(deviceTargetLabel('android|Pixel_6|emulator')).toBe('android Pixel_6');
    expect(deviceTargetLabel('ios|iPhone 17')).toBe('ios iPhone 17');
  });

  it('fails each file once with the whole reason and no dispatcher stack', () => {
    const project = makeProject('android', 'android|Pixel_6', ['/t/a.test.ts', '/t/b.test.ts']);
    const results = targetStartFailureResults('android Pixel_6', [project], new Error('No online devices found.\nConnect a device'));
    expect(results.map((r) => [r.name, r.filePath, r.status, r.project])).toEqual([
      ['a.test.ts', '/t/a.test.ts', 'failed', 'android'],
      ['b.test.ts', '/t/b.test.ts', 'failed', 'android'],
    ]);
    // The later lines carry the hints (a build excerpt, the log path).
    expect(results[0].error?.message).toBe('Device target "android Pixel_6" could not start: No online devices found.\n  Connect a device');
    expect(results[0].error?.stack).toBeUndefined();
  });

  it('accepts a non-Error rejection', () => {
    const project = makeProject('ios', 'ios|iPhone 17', ['/t/a.test.ts']);
    expect(targetStartFailureResults('ios iPhone 17', [project], 'boom')[0].error?.message)
      .toBe('Device target "ios iPhone 17" could not start: boom');
  });
});

// Every target of a session failing: the parallel path and UI/watch fail the
// start with one message that lists each target's reason (PILOT-400, PILOT-415).
describe('noTargetCouldStart()', () => {
  it('is a launch failure listing each target with its hint lines indented', () => {
    const err = noTargetCouldStart([
      { label: 'android Pixel_6', err: new Error('No online devices found.\nSet `avd`') },
      { label: 'ios iPhone 17', err: 'boom' },
    ]);
    expect(isLaunchSetupError(err)).toBe(true);
    expect(err.message.split('\n')).toEqual([
      'No device target could start',
      'android Pixel_6: No online devices found.',
      '  Set `avd`',
      'ios iPhone 17: boom',
    ]);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('targetUnavailableMessage()', () => {
  it('names the target and keeps the whole reason, its later lines indented under the headline', () => {
    expect(targetUnavailableMessage('android Pixel_6', new Error('No online devices found.\nhint')))
      .toBe('Device target "android Pixel_6" could not start: No online devices found.\n  hint');
    expect(targetUnavailableMessage('ios iPhone 17', 'boom')).toBe('Device target "ios iPhone 17" could not start: boom');
  });

  it('keeps an agent build failure\'s error lines and log path (PILOT-464)', () => {
    const build = 'iOS simulator agent build failed (exit 65)\nerror: Signing requires a development team\nFull build log: /tmp/agent-build.log';
    expect(targetUnavailableMessage('ios iPhone 17', new Error(build)).split('\n')).toEqual([
      'Device target "ios iPhone 17" could not start: iOS simulator agent build failed (exit 65)',
      '  error: Signing requires a development team',
      '  Full build log: /tmp/agent-build.log',
    ]);
  });

  it('bounds a runaway reason, keeping its tail', () => {
    const lines = ['headline', ...Array.from({ length: 200 }, (_, i) => `noise ${i}`), 'Log: /tmp/last.log'];
    const message = targetUnavailableMessage('ios iPhone 17', new Error(lines.join('\n')));
    expect(message.split('\n').length).toBeLessThanOrEqual(41);
    expect(message.endsWith('  Log: /tmp/last.log')).toBe(true);
  });
});

describe('worker start failures', () => {
  it('lists a worker\'s reason with its later lines indented', () => {
    expect(workerFailureMessage('Worker 1 (sim-a)', 'iOS simulator agent build failed (exit 65)\nerror: x\nLog: /tmp/b.log'))
      .toBe('Worker 1 (sim-a): iOS simulator agent build failed (exit 65)\n  error: x\n  Log: /tmp/b.log');
  });

  it('says which device it skips without punctuation after the reason\'s log path', () => {
    const notice = skippingDeviceNotice('sim-a', 'build failed\nLog: /tmp/b.log');
    expect(notice).toBe('Skipping device sim-a: build failed\n  Log: /tmp/b.log');
  });

  it('nests a daemon\'s own output through worker, target and run unchanged in substance (PILOT-463 through PILOT-464)', () => {
    const daemon = 'Failed to start worker daemon\n  tapsmith-core exited with code 1 before answering\n  Recent daemon output:\n    Error: Address already in use (os error 48)';
    // As runParallel builds it when its only worker fails.
    const worker = new LaunchSetupError(withDetail(
      'No worker could start: Failed to start worker daemon',
      workerFailureMessage('Worker 1 (emulator-5554)', daemon).split('\n'),
    ));
    const run = noTargetCouldStart([{ label: 'android Pixel_6', err: worker }, { label: 'ios iPhone 17', err: 'boom' }]);
    expect(run.message.split('\n')).toEqual([
      'No device target could start',
      'android Pixel_6: No worker could start: Failed to start worker daemon',
      '    Worker 1 (emulator-5554): Failed to start worker daemon',
      '        tapsmith-core exited with code 1 before answering',
      '        Recent daemon output:',
      '          Error: Address already in use (os error 48)',
      'ios iPhone 17: boom',
    ]);
  });
});

describe('targetStartWarning()', () => {
  it('says the other targets still run', () => {
    expect(targetStartWarning('android Pixel_6', 2, false)).toBe(
      'Device target android Pixel_6 could not start; its 2 test file(s) are reported as failed. The other device targets still run.',
    );
  });

  it('says a re-run retries it in a session that keeps going', () => {
    expect(targetStartWarning('ios iPhone 17', 1, true)).toBe(
      'Device target ios iPhone 17 could not start; its 1 test file(s) are reported as failed. The other device targets still run. '
      + 'Running its tests again retries it.',
    );
  });
});
