import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { HeadlessTestDispatcher } from '../mcp/headless-dispatcher.js';
import type { TestResultEntry, TestRunResult } from '../mcp/test-dispatcher.js';
import type { WatchRunMessage } from '../watch-run.js';
import { STOPPED_BY_USER, TestAbortedError } from '../abort.js';
import { classifyEntryStatus, isInterruptedEntry } from '../mcp/test-dispatcher.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));

// A stop is not a failure, and it is not a blank either. Killing the in-flight
// child outright destroyed the run's own account of itself: `file-done` never
// arrived, so a run whose `list_results` listed a pass reported "0 passed, 0ms"
// in the same breath. The stop now asks the child to report before the signal,
// and whatever a killed child managed to stream is read back out of the store.

/** The private surface these tests drive directly. */
interface DispatcherInternals {
  _ensureInitialized: () => Promise<void>
  _runFileInChild: (
    filePath: string,
    useOptions?: unknown,
    projectName?: string,
    testFilter?: string,
  ) => Promise<{ results: unknown[]; suite: { durationMs: number } }>
  _ensureTargetForProject: (projectName?: string) => Promise<{ address: string; deviceSerial: string }>
  _testFiles: string[]
  _serializedConfig: unknown
  _scripts: { watchRunScript: string; discoverScript: string; tsxBin?: string; baseDir: string }
}

function internalsOf(dispatcher: HeadlessTestDispatcher): DispatcherInternals {
  return dispatcher as unknown as DispatcherInternals;
}

/** A dispatcher whose files exist and whose children are ours to script. */
function makeDispatcher(files: string[]): {
  dispatcher: HeadlessTestDispatcher
  internals: DispatcherInternals
} {
  const dispatcher = new HeadlessTestDispatcher();
  const internals = internalsOf(dispatcher);
  internals._ensureInitialized = async () => {};
  // Runs resolve device targets too; the targets are scripted below.
  (internals as unknown as { _devicesReady: boolean })._devicesReady = true;
  internals._testFiles = files;
  return { dispatcher, internals };
}

type ScriptedChild = EventEmitter & {
  send: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
};

function scriptedChild(): ScriptedChild {
  const child = new EventEmitter() as ScriptedChild;
  child.send = vi.fn();
  child.kill = vi.fn();
  return child;
}

/** A dispatcher wired to a scripted child, so the real IPC path is exercised. */
function armDispatcher(child: EventEmitter, files: string[]): HeadlessTestDispatcher {
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
  const { dispatcher, internals } = makeDispatcher(files);
  internals._serializedConfig = { rootDir: '/repo' };
  internals._scripts = {
    watchRunScript: '/sdk/watch-run.js',
    discoverScript: '/sdk/discover.js',
    baseDir: '/sdk',
  };
  internals._ensureTargetForProject = async () => ({
    address: '127.0.0.1:50051',
    deviceSerial: 'SIM-1',
  });
  return dispatcher;
}

interface StreamedResult {
  name: string
  fullName: string
  status: string
  durationMs: number
  error?: { message: string }
  workerIndex: number
}

/** A `test-end` IPC message, as the child streams one per finished test. */
function testEnd(fullName: string, status: string, durationMs: number, errorMessage?: string): {
  type: 'test-end'
  result: StreamedResult
} {
  return {
    type: 'test-end',
    result: {
      name: fullName,
      fullName,
      status,
      durationMs,
      error: errorMessage ? { message: errorMessage } : undefined,
      workerIndex: 0,
    },
  };
}

function fileDone(filePath: string, results: StreamedResult[], durationMs: number): unknown {
  return {
    type: 'file-done',
    filePath,
    results,
    suite: { name: '', tests: [], suites: [], durationMs },
  };
}

const FILE = '/repo/tests/slow.test.ts';

/**
 * Play a child through a whole file, as the real one does: a `test-end` per
 * finished test (which is what populates the result store) and then the
 * `file-done` the summary is built from. Tests that assert on both halves have
 * to send both, or the store looks empty and the disagreement is invisible.
 */
function playFile(child: ScriptedChild, results: StreamedResult[], durationMs: number): void {
  for (const result of results) child.emit('message', { type: 'test-end', result });
  child.emit('message', fileDone(FILE, results, durationMs));
}

/** Wait until the run message has gone out, i.e. the child is live. */
async function untilRunning(child: ScriptedChild): Promise<void> {
  await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fork).mockReset();
});

describe('stop asks the child to report before killing it', () => {
  it('sends an abort rather than signalling straight away', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    dispatcher.stop();

    expect(child.send).toHaveBeenLastCalledWith({ type: 'abort' });
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('message', fileDone(FILE, [], 0));
    await run;
  });

  it('counts what the aborted run reported, instead of nothing at all', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    // Two tests finished before the user hit stop; the third was cut short.
    dispatcher.stop();
    child.emit('message', fileDone(FILE, [
      testEnd('Suite > first', 'passed', 1200).result,
      testEnd('Suite > second', 'passed', 800).result,
      testEnd('Suite > third', 'failed', 90, STOPPED_BY_USER).result,
    ], 2090));

    const result = await run;

    expect(result.status).toBe('stopped');
    expect(result.passed).toBe(2);
    expect(result.interrupted).toBe(1);
    // The stopped test is subtracted back out — the runner reports it as a
    // failure carrying the stop marker, and a stop is not a failure.
    expect(result.failed).toBe(0);
    expect(result.duration).toBe(2090);
  });

  it('counts interrupted tests, not interrupted files', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    dispatcher.stop();
    child.emit('message', fileDone(FILE, [
      testEnd('Suite > a', 'failed', 10, STOPPED_BY_USER).result,
      testEnd('Suite > b', 'failed', 10, STOPPED_BY_USER).result,
    ], 20));

    // Two tests stopped inside one file. Counting files would say 1 here,
    // which reads as one test next to `passed`/`failed`/`skipped`.
    expect((await run).interrupted).toBe(2);
  });

  it('keeps a genuine failure alongside a stopped test in the same file', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    dispatcher.stop();
    child.emit('message', fileDone(FILE, [
      testEnd('Suite > broken', 'failed', 30, 'expected true to be false').result,
      testEnd('Suite > cut', 'failed', 5, STOPPED_BY_USER).result,
    ], 35));

    const result = await run;
    expect(result.failed).toBe(1);
    expect(result.interrupted).toBe(1);
  });

  it('escalates to a signal when the abort goes unanswered', async () => {
    vi.useFakeTimers();
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    void dispatcher.runFiles([FILE]);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());

    dispatcher.stop();
    expect(child.kill).not.toHaveBeenCalled();

    // The child never answers: the signal is the backstop, not the opener.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalled();
  });

  it('does not signal a child that answered in time', async () => {
    vi.useFakeTimers();
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());

    dispatcher.stop();
    child.emit('message', fileDone(FILE, [], 0));
    await run;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('a child killed without reporting is salvaged from the store', () => {
  it('reports the tests that streamed before the kill, not zero', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    // Each finished test streams a `test-end` as it goes …
    child.emit('message', testEnd('Suite > first', 'passed', 1500));
    child.emit('message', testEnd('Suite > second', 'passed', 900));
    // … and then the child dies without ever sending `file-done`.
    dispatcher.stop();
    child.emit('exit', 143);

    const result: TestRunResult = await run;

    expect(result.status).toBe('stopped');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    // Reported, not invented: the duration is the sum of what actually ran.
    expect(result.duration).toBe(2400);
  });

  it('agrees with list_results — the disagreement that started this', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    child.emit('message', testEnd('Gestures screen > shows heading', 'passed', 3875));
    dispatcher.stop();
    child.emit('exit', 143);

    const result = await run;
    const listed = dispatcher.getResults();

    expect(result.passed).toBe(listed.filter((r) => r.status === 'passed').length);
    expect(result.passed).toBe(1);
  });

  // Two stopped tests, one file: a file count would say 1 here and look
  // right by accident, which is how the units drifted in the first place.
  it('salvages stopped tests per test, not per file', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    child.emit('message', testEnd('Suite > cut-a', 'failed', 40, STOPPED_BY_USER));
    child.emit('message', testEnd('Suite > cut-b', 'failed', 25, STOPPED_BY_USER));
    dispatcher.stop();
    child.emit('exit', 143);

    const result = await run;
    expect(result.interrupted).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('leaves no phantom file-level failure behind', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    dispatcher.stop();
    child.emit('exit', 143);
    await run;

    expect(dispatcher.getResults().filter((r: TestResultEntry) => r.fileLevelFailure)).toEqual([]);
    expect(dispatcher.getResults().map((r) => r.fullName)).not.toContain(
      'slow.test.ts — file failed to run',
    );
  });
});

describe('accounting that must survive the stop rework', () => {
  it('still records a genuine child failure as a file-level failure', async () => {
    const { dispatcher, internals } = makeDispatcher([FILE]);
    internals._runFileInChild = async () => {
      throw new Error("Cannot find module './missing.js'");
    };

    const result = await dispatcher.runFiles([FILE]);

    expect(result.status).toBe('failed');
    expect(result.failed).toBe(1);
    expect(result.interrupted).toBeUndefined();
    const failure = dispatcher.getResults().find((r) => r.fileLevelFailure);
    expect(failure?.fullName).toBe('slow.test.ts — file failed to run');
    expect(failure?.error).toContain('Cannot find module');
  });

  it('omits `interrupted` entirely from a run nobody stopped', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    child.emit('message', fileDone(FILE, [testEnd('Suite > fine', 'passed', 10).result], 10));

    const result = await run;
    expect(result.status).toBe('passed');
    expect(result.passed).toBe(1);
    expect(result.interrupted).toBeUndefined();
  });

  it('stops the queue rather than carrying the stop into the next file', async () => {
    const SECOND = '/repo/tests/second.test.ts';
    const { dispatcher, internals } = makeDispatcher([FILE, SECOND]);
    const started: string[] = [];
    internals._runFileInChild = async (filePath: string) => {
      started.push(filePath);
      dispatcher.stop();
      throw new Error('Test worker exited with code 143 without sending results');
    };

    const result: TestRunResult = await dispatcher.runFiles([FILE, SECOND]);

    expect(started).toEqual([FILE]);
    expect(result.status).toBe('stopped');
    expect(result.failed).toBe(0);
  });
});

describe('a stopped test is reported as stopped, not as a failure', () => {
  it('classifies the entry the runner produced', () => {
    const stopped = { fullName: 'a', filePath: FILE, status: 'failed' as const, error: STOPPED_BY_USER };
    expect(classifyEntryStatus(stopped).status).toBe('interrupted');
    expect(isInterruptedEntry(stopped)).toBe(true);
  });

  it('leaves a genuine failure alone', () => {
    const broken = { fullName: 'a', filePath: FILE, status: 'failed' as const, error: 'expected 1 to be 2' };
    expect(classifyEntryStatus(broken).status).toBe('failed');
    expect(isInterruptedEntry(broken)).toBe(false);
  });

  // The residual half of the same disagreement: the summary said "0 failed,
  // 1 interrupted" while list_results rendered that very test as [FAIL].
  it('does not show up as a failure in the results list', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    dispatcher.stop();
    playFile(child, [
      testEnd('Suite > done', 'passed', 100).result,
      testEnd('Suite > cut', 'failed', 10, STOPPED_BY_USER).result,
    ], 110);
    const result = await run;

    const listed = dispatcher.getResults();
    expect(listed.find((r) => r.fullName === 'Suite > cut')?.status).toBe('interrupted');
    expect(listed.filter((r) => r.status === 'failed')).toEqual([]);
    // Both halves of the answer now agree on every count, not just on `passed`.
    expect(result.failed).toBe(listed.filter((r) => r.status === 'failed').length);
    expect(result.interrupted).toBe(listed.filter((r) => r.status === 'interrupted').length);
  });

  it('is not listed among a run\'s failures', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [FILE]);
    const run = dispatcher.runFiles([FILE]);
    await untilRunning(child);

    dispatcher.stop();
    playFile(child, [
      testEnd('Suite > broken', 'failed', 30, 'expected true to be false').result,
      testEnd('Suite > cut', 'failed', 5, STOPPED_BY_USER).result,
    ], 35);
    const result = await run;

    const named = (result.failures ?? []).map((f) => f.fullName);
    expect(named).toContain('Suite > broken');
    expect(named).not.toContain('Suite > cut');
  });
});

// The two transports classify a stopped test by this exact string. If the
// runner's default abort message drifts from the constant, both silently start
// counting the user's own stop as a test failure again.
describe('the stop marker both transports match on', () => {
  it('is what an aborted test actually carries', () => {
    expect(new TestAbortedError().message).toBe(STOPPED_BY_USER);
  });
});

describe('run child naming', () => {
  const RUN_FILE = '/repo/tests/a.test.ts';

  it('tells the child this is a run, so preflight errors do not say "watch"', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [RUN_FILE]);

    const run = internalsOf(dispatcher)._runFileInChild(RUN_FILE);
    await untilRunning(child);

    const msg = child.send.mock.calls[0][0] as WatchRunMessage;
    expect(msg.label).toBe('Run');

    child.emit('exit', 0);
    await expect(run).rejects.toThrow();
  });

  it('names a dead child a test worker, not a watch worker', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child, [RUN_FILE]);

    const run = internalsOf(dispatcher)._runFileInChild(RUN_FILE);
    await untilRunning(child);
    child.emit('exit', 143);

    await expect(run).rejects.toThrow(/Test worker exited with code 143/);
    await expect(run).rejects.not.toThrow(/Watch worker/);
  });
});
