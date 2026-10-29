import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReporterDispatcher,
  createReporters,
  type TapsmithReporter,
  type FullResult,
} from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';

// ─── Test data helpers ───

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'my test',
    fullName: 'suite > my test',
    status: 'passed',
    durationMs: 42,
    ...overrides,
  };
}

function makeFullResult(overrides: Partial<FullResult> = {}): FullResult {
  return {
    status: 'passed',
    duration: 1000,
    tests: [makeTestResult()],
    suites: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp/test',
    outputDir: 'tapsmith-results',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

// Minimal terminal emulator: replays a stream of bytes (including the cursor
// escapes the list reporter uses) and returns the final visible lines. Used to
// assert what the user actually sees after in-place redraws.
function renderTerminal(stream: string): string[] {
  const lines: string[] = [''];
  let row = 0;
  let col = 0;
  const ensureRow = (): void => {
    while (lines.length <= row) lines.push('');
  };
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    if (ch === '\x1b') {
      const m = /^\x1b\[(\d*)([A-Za-z])/.exec(stream.slice(i));
      if (m) {
        const n = m[1] === '' ? 1 : parseInt(m[1], 10);
        const cmd = m[2];
        if (cmd === 'A') row = Math.max(0, row - n);
        else if (cmd === 'B') row += n;
        else if (cmd === 'K') {
          // 2K (and 0K here) clears the current line.
          ensureRow();
          lines[row] = '';
          col = 0;
        }
        // SGR ('m') and anything else: ignored (no visible effect).
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === '\n') {
      // TTY onlcr: newline returns to column 0 and moves down a row.
      row += 1;
      col = 0;
      ensureRow();
      continue;
    }
    if (ch === '\r') {
      col = 0;
      continue;
    }
    ensureRow();
    const line = lines[row];
    lines[row] = line.slice(0, col) + ch + line.slice(col + 1);
    col += 1;
  }
  return lines;
}

// ─── ReporterDispatcher ───

describe('ReporterDispatcher', () => {
  it('fans out onRunStart to all reporters', () => {
    const r1: TapsmithReporter = { onRunStart: vi.fn() };
    const r2: TapsmithReporter = { onRunStart: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1, r2]);

    const config = makeConfig();
    dispatcher.onRunStart(config, 3);

    expect(r1.onRunStart).toHaveBeenCalledWith(config, 3, undefined);
    expect(r2.onRunStart).toHaveBeenCalledWith(config, 3, undefined);
  });

  it('forwards the onRunStart merge flag', () => {
    const r1: TapsmithReporter = { onRunStart: vi.fn() };
    const config = makeConfig();
    new ReporterDispatcher([r1]).onRunStart(config, 0, { merge: true });
    expect(r1.onRunStart).toHaveBeenCalledWith(config, 0, { merge: true });
  });

  it('fans out onTestEnd to all reporters', () => {
    const r1: TapsmithReporter = { onTestEnd: vi.fn() };
    const r2: TapsmithReporter = { onTestEnd: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1, r2]);

    const test = makeTestResult();
    dispatcher.onTestEnd(test);

    expect(r1.onTestEnd).toHaveBeenCalledWith(test);
    expect(r2.onTestEnd).toHaveBeenCalledWith(test);
  });

  it('fans out onTestFileStart to all reporters', () => {
    const r1: TapsmithReporter = { onTestFileStart: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1]);

    dispatcher.onTestFileStart('/path/to/test.ts');
    expect(r1.onTestFileStart).toHaveBeenCalledWith('/path/to/test.ts');
  });

  it('fans out onTestStart metadata to all reporters', () => {
    const r1: TapsmithReporter = { onTestStart: vi.fn() };
    const r2: TapsmithReporter = { onTestStart: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1, r2]);
    const info = { workerIndex: 3, project: 'ios' };

    dispatcher.onTestStart('suite > test', '/path/to/test.ts', info);

    expect(r1.onTestStart).toHaveBeenCalledWith('suite > test', '/path/to/test.ts', info);
    expect(r2.onTestStart).toHaveBeenCalledWith('suite > test', '/path/to/test.ts', info);
  });

  it('fans out onTestFileEnd to all reporters', () => {
    const r1: TapsmithReporter = { onTestFileEnd: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1]);

    const results = [makeTestResult()];
    dispatcher.onTestFileEnd('/path/to/test.ts', results);
    expect(r1.onTestFileEnd).toHaveBeenCalledWith('/path/to/test.ts', results);
  });

  it('fans out onRunEnd to all reporters', async () => {
    const r1: TapsmithReporter = { onRunEnd: vi.fn() };
    const r2: TapsmithReporter = { onRunEnd: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1, r2]);

    const result = makeFullResult();
    await dispatcher.onRunEnd(result);

    expect(r1.onRunEnd).toHaveBeenCalledWith(result);
    expect(r2.onRunEnd).toHaveBeenCalledWith(result);
  });

  it('fans out onError to all reporters', () => {
    const r1: TapsmithReporter = { onError: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1]);

    const error = new Error('boom');
    dispatcher.onError(error);
    expect(r1.onError).toHaveBeenCalledWith(error);
  });

  it('catches errors in reporters without breaking other reporters', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r1: TapsmithReporter = {
      onTestEnd: () => {
        throw new Error('reporter broke');
      },
    };
    const r2: TapsmithReporter = { onTestEnd: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1, r2]);

    dispatcher.onTestEnd(makeTestResult());

    // r2 should still be called
    expect(r2.onTestEnd).toHaveBeenCalled();
    // Error should be logged to stderr
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('reporter broke'));
    stderrSpy.mockRestore();
  });

  it('fans out onTestFileRetry to all reporters', () => {
    const r1: TapsmithReporter = { onTestFileRetry: vi.fn() };
    const r2: TapsmithReporter = { onTestFileRetry: vi.fn() };
    const dispatcher = new ReporterDispatcher([r1, r2]);

    dispatcher.onTestFileRetry('/test.ts', 3);

    expect(r1.onTestFileRetry).toHaveBeenCalledWith('/test.ts', 3);
    expect(r2.onTestFileRetry).toHaveBeenCalledWith('/test.ts', 3);
  });

  it('handles reporters that only implement some hooks', () => {
    const r1: TapsmithReporter = {}; // no hooks
    const dispatcher = new ReporterDispatcher([r1]);

    // Should not throw
    dispatcher.onRunStart(makeConfig(), 1);
    dispatcher.onTestEnd(makeTestResult());
    dispatcher.onTestFileStart('/test.ts');
    dispatcher.onTestFileEnd('/test.ts', []);
    dispatcher.onError(new Error('test'));
  });

  it('awaits async onRunEnd reporters sequentially', async () => {
    const order: string[] = [];
    const r1: TapsmithReporter = {
      onRunEnd: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('r1');
      },
    };
    const r2: TapsmithReporter = {
      onRunEnd: async () => {
        order.push('r2');
      },
    };
    const dispatcher = new ReporterDispatcher([r1, r2]);
    await dispatcher.onRunEnd(makeFullResult());

    expect(order).toEqual(['r1', 'r2']);
  });
});

// ─── createReporters ───

describe('createReporters', () => {
  // `reporter: ['html', CI ? { open: 'never' } : undefined]` — config
  // validation accepts it (PILOT-552), so it must create the reporter.
  it('creates a single [name, undefined] tuple with the reporter\'s default options', async () => {
    const reporters = await createReporters(['dot', undefined] as unknown as TapsmithConfig['reporter']);
    expect(reporters.map((r) => r.constructor.name)).toEqual(['DotReporter']);
  });

  it('creates a list reporter by default when not in CI', async () => {
    const origCI = process.env.CI;
    delete process.env.CI;

    const reporters = await createReporters(undefined);
    expect(reporters).toHaveLength(1);
    expect(reporters[0].constructor.name).toBe('ListReporter');

    if (origCI !== undefined) process.env.CI = origCI;
  });

  it('creates a list reporter by default even in CI', async () => {
    const origCI = process.env.CI;
    process.env.CI = 'true';

    const reporters = await createReporters(undefined);
    expect(reporters).toHaveLength(1);
    expect(reporters[0].constructor.name).toBe('ListReporter');

    if (origCI !== undefined) {
      process.env.CI = origCI;
    } else {
      delete process.env.CI;
    }
  });

  it('creates a single reporter from a string', async () => {
    const reporters = await createReporters('dot');
    expect(reporters).toHaveLength(1);
    expect(reporters[0].constructor.name).toBe('DotReporter');
  });

  it('creates a reporter with options from a tuple', async () => {
    const reporters = await createReporters(['json', { outputFile: 'custom.json' }]);
    expect(reporters).toHaveLength(1);
    expect(reporters[0].constructor.name).toBe('JsonReporter');
  });

  it('creates multiple reporters from an array', async () => {
    const reporters = await createReporters(['list', 'dot']);
    expect(reporters).toHaveLength(2);
    expect(reporters[0].constructor.name).toBe('ListReporter');
    expect(reporters[1].constructor.name).toBe('DotReporter');
  });

  it('creates multiple reporters with mixed config', async () => {
    const reporters = await createReporters([
      'list',
      ['json', { outputFile: 'out.json' }],
    ]);
    expect(reporters).toHaveLength(2);
    expect(reporters[0].constructor.name).toBe('ListReporter');
    expect(reporters[1].constructor.name).toBe('JsonReporter');
  });

  it('creates all built-in reporter types', async () => {
    const names = ['list', 'line', 'dot', 'json', 'junit', 'html', 'github', 'blob'];
    for (const name of names) {
      const reporters = await createReporters(name);
      expect(reporters).toHaveLength(1);
    }
  });

  it('throws for unknown reporter name', async () => {
    await expect(createReporters('nonexistent-reporter-xyz')).rejects.toThrow(
      /Unknown reporter "nonexistent-reporter-xyz"/,
    );
  });
});

// ─── Individual reporter behavior ───

describe('ListReporter', () => {
  let reporter: TapsmithReporter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;

  beforeEach(async () => {
    const { ListReporter } = await import('../reporters/list.js');
    reporter = new ListReporter();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('onTestFileStart is a no-op (file names are shown inline)', () => {
    reporter.onTestFileStart!('/path/to/test.ts');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('announces the file count at run start', () => {
    reporter.onRunStart!(makeConfig(), 3);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Running tests from 3 file(s)');
  });

  it('prints test result with status icon', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({ status: 'passed', fullName: 'my passing test' }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('my passing test');
  });

  it('prints a test warnings under its line (PILOT-398)', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({ status: 'passed', fullName: 'warned test', warnings: ['The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.'] }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('warned test');
    expect(output).toContain('⚠ The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.');
  });

  it('prints error details for failed tests', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'failing test',
      error: new Error('assertion failed'),
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('assertion failed');
  });

  it('prints error details for a failed attempt that will retry', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'flaky test',
      error: new Error('Test timed out after 90000ms'),
      _willRetry: true,
      retry: 0,
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Test timed out after 90000ms');
  });

  // A retry printed the same "✗ [7] …" line as the attempt before it, so it
  // looked like the test ran twice by mistake (PILOT-569). Playwright labels
  // each retry "(retry #N)".
  it('labels each retry attempt, and not the first', () => {
    reporter.onRunStart!(makeConfig(), 1);
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
    reporter.onTestEnd!(makeTestResult({ status: 'failed', fullName: 'flaky test', error: new Error('boom'), _willRetry: true, retry: 0 }));
    reporter.onTestEnd!(makeTestResult({ status: 'failed', fullName: 'flaky test', error: new Error('boom'), _willRetry: true, retry: 1 }));
    reporter.onTestEnd!(makeTestResult({ status: 'passed', fullName: 'flaky test', retry: 2, durationMs: 1200 }));
    const lines = strip(stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join(''))
      .split('\n').filter((l) => l.includes('flaky test'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toContain('retry #');
    expect(lines[1]).toContain('flaky test (retry #1) (');
    expect(lines[2]).toContain('flaky test (retry #2) (1.2s)');
  });

  it('prints the first-attempt error and trace in the flaky summary', () => {
    reporter.onRunStart!(makeConfig(), 1);
    const flakyTest = makeTestResult({
      status: 'passed',
      fullName: 'flaky test',
      retry: 1,
      firstAttemptError: new Error('Test timed out after 90000ms'),
      tracePath: '/traces/trace-flaky.zip',
    });
    reporter.onTestEnd!(flakyTest);
    reporter.onRunEnd!(makeFullResult({ tests: [flakyTest] }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('1 flaky');
    expect(output).toContain('Test timed out after 90000ms');
    expect(output).toContain('npx tapsmith show-trace /traces/trace-flaky.zip');
  });

  it('prints artifacts under the failing ✗ line, not again under the flaky ✓', () => {
    reporter.onRunStart!(makeConfig(), 1);
    // Failing attempt: error + its artifacts print here.
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'flaky test',
      error: new Error('boom'),
      screenshotPath: '/shots/fail.png',
      tracePath: '/traces/fail.zip',
      _willRetry: true,
      retry: 0,
    }));
    const midOutput = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(midOutput).toContain('Screenshot: /shots/fail.png');
    expect(midOutput).toContain('Trace: npx tapsmith show-trace /traces/fail.zip');

    stdoutSpy.mockClear();

    // Final flaky pass: links the failure's screenshot/trace (for blob/HTML)
    // but must not reprint them; the retry's own video still prints.
    reporter.onTestEnd!(makeTestResult({
      status: 'passed',
      fullName: 'flaky test',
      retry: 1,
      firstAttemptError: new Error('boom'),
      screenshotPath: '/shots/fail.png',
      tracePath: '/traces/fail.zip',
      videoPath: '/videos/retry.mp4',
      failedAttemptArtifacts: { screenshot: true, trace: true },
    }));
    const finalOutput = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(finalOutput).not.toContain('/shots/fail.png');
    expect(finalOutput).not.toContain('/traces/fail.zip');
    expect(finalOutput).toContain('Video: /videos/retry.mp4');
  });

  it('assigns monotonic counters across file retries', () => {
    reporter.onRunStart!(makeConfig({ workers: 1 }), 2);

    // Attempt 1: two tests stream before an infrastructure failure
    reporter.onTestEnd!(makeTestResult({ fullName: 'test A', status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ fullName: 'test B', status: 'failed', error: new Error('Agent connection dropped') }));

    // Infrastructure retry discards the 2 results — counter keeps going
    reporter.onTestFileRetry!('/file.ts', 2);

    // Attempt 2: retried tests continue the global counter
    reporter.onTestEnd!(makeTestResult({ fullName: 'test A', status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ fullName: 'test B', status: 'passed' }));

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const counterMatches = [...output.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
    expect(counterMatches).toEqual(['1', '2', '3', '4']);
  });

  it('keeps parallel counters monotonic when file retry arrives after interleaved output', () => {
    reporter.onRunStart!(makeConfig({ workers: 2 }), 2);

    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 1 test A', status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 2 test A', status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 2 test B', status: 'passed' }));

    reporter.onTestFileRetry!('/worker-1-file.ts', 1);
    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 1 retry test A', status: 'passed' }));

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const counterMatches = [...output.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
    expect(counterMatches).toEqual(['1', '2', '3', '4']);
  });

  it('includes relative file path in output', () => {
    reporter.onRunStart!(makeConfig({ workers: 2, rootDir: '/project' }), 2);
    reporter.onTestEnd!(makeTestResult({
      status: 'passed',
      fullName: 'my test',
      filePath: '/project/tests/login.test.ts',
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('› tests/login.test.ts ›');
    expect(output).toContain('my test');
  });

  it('includes file name inline in sequential mode', () => {
    reporter.onRunStart!(makeConfig({ workers: 1, rootDir: '/project' }), 1);
    reporter.onTestEnd!(makeTestResult({
      status: 'passed',
      fullName: 'my test',
      filePath: '/project/tests/login.test.ts',
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('tests/login.test.ts');
    expect(output).toContain('my test');
  });

  it('includes worker and project in TTY in-progress rows', async () => {
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      const { ListReporter } = await import('../reporters/list.js');
      const ttyReporter = new ListReporter();
      stdoutSpy.mockClear();

      ttyReporter.onRunStart!(makeConfig({
        workers: 2,
        rootDir: '/project',
        projects: [{ name: 'android' }, { name: 'ios' }],
      }), 2);
      ttyReporter.onTestStart!('suite > my test', '/project/tests/login.test.ts', {
        workerIndex: 3,
        project: 'ios',
      });

      const output = stripAnsi(stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join(''));
      expect(output).toContain('[1] [worker 3] [ios] › tests/login.test.ts › suite > my test');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalIsTTY });
    }
  });

  it('clears the in-progress line when a test logs to stdout (single worker)', async () => {
    // Regression: in single-worker mode the test runs in-process, so its
    // console.log lands on stdout between onTestStart (prints the dimmed
    // in-progress row) and onTestEnd (clears it). The reporter must clear and
    // redraw the live region around interleaved output, otherwise the cursor
    // math is off-by-N and the in-progress row is left stranded (duplicate).
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    // The reporter installs its own process.stdout.write interceptor, so we
    // can't use the describe-level spy here — record on the real stream.
    stdoutSpy.mockRestore();
    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const recorder = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const { ListReporter } = await import('../reporters/list.js');
      const ttyReporter = new ListReporter();
      ttyReporter.onRunStart!(makeConfig({ workers: 1, rootDir: '/project' }), 1);
      ttyReporter.onTestStart!('suite > test A', '/project/tests/a.test.ts', { project: undefined });
      // The test logs to stdout while it runs — must route through whatever
      // interceptor the reporter installed.
      process.stdout.write('log line 1\n');
      process.stdout.write('log line 2\n');
      ttyReporter.onTestEnd!(makeTestResult({
        fullName: 'suite > test A',
        status: 'passed',
        filePath: '/project/tests/a.test.ts',
      }));
      ttyReporter.onRunEnd!(makeFullResult({
        tests: [makeTestResult({ fullName: 'suite > test A', status: 'passed' })],
      }));

      const visible = renderTerminal(chunks.join(''));
      // The test's own logs survive.
      expect(visible).toContain('log line 1');
      expect(visible).toContain('log line 2');
      // The completed row is shown exactly once.
      const completedRows = visible.filter((l) => /✓.*\[1\].*suite > test A/.test(l));
      expect(completedRows).toHaveLength(1);
      // No stranded dimmed in-progress row (would read `[1] › … › suite > test A`
      // without the ✓ status icon).
      const strandedInProgress = visible.filter(
        (l) => l.includes('suite > test A') && !l.includes('✓'),
      );
      expect(strandedInProgress).toEqual([]);
    } finally {
      recorder.mockRestore();
      void realWrite;
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalIsTTY });
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    }
  });

  it('prints summary on onRunEnd', () => {
    reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed' }),
        makeTestResult({ status: 'failed', error: new Error('fail') }),
        makeTestResult({ status: 'skipped' }),
      ],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('1 passed');
    expect(output).toContain('1 failed');
    expect(output).toContain('1 skipped');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });
});

describe('LineReporter', () => {
  let reporter: TapsmithReporter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { LineReporter } = await import('../reporters/line.js');
    reporter = new LineReporter();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('announces the file count at run start', () => {
    reporter.onRunStart!(makeConfig(), 3);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Running tests from 3 file(s)');
  });

  it('labels a failed retry (PILOT-569)', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({ status: 'failed', fullName: 'flaky test', error: new Error('boom'), _willRetry: true, retry: 0 }));
    reporter.onTestEnd!(makeTestResult({ status: 'failed', fullName: 'flaky test', error: new Error('boom'), retry: 1 }));
    reporter.onTestEnd!(makeTestResult({ status: 'passed', fullName: 'other test', retry: 1 }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('flaky test (retry #1) (');
    expect(output).toContain('other test (retry #1) (');
  });

  it('keeps parallel progress counters monotonic after file retry notifications', () => {
    reporter.onRunStart!(makeConfig({ workers: 2 }), 2);
    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 1 test A', status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 2 test A', status: 'passed' }));
    reporter.onTestFileRetry!('/worker-1-file.ts', 1);
    reporter.onTestEnd!(makeTestResult({ fullName: 'worker 1 retry test A', status: 'passed' }));

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const counterMatches = [...output.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
    expect(counterMatches).toEqual(['1', '2', '3']);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalIsTTY });
  });
});

describe('DotReporter', () => {
  let reporter: TapsmithReporter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;

  beforeEach(async () => {
    const { DotReporter } = await import('../reporters/dot.js');
    reporter = new DotReporter();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('outputs a character per test', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({ status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ status: 'failed', error: new Error('x') }));
    reporter.onTestEnd!(makeTestResult({ status: 'skipped' }));

    // Should have written dot characters (with ANSI color codes)
    // 3 test results + 1 header newline = at least 4 write calls
    expect(stdoutSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    // Strip ANSI codes and verify the actual dot characters
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const stripped = raw.replace(/\x1b\[\d+m/g, '');
    expect(stripped).toContain('·');
    expect(stripped).toContain('F');
    expect(stripped).toContain('○');
  });

  it('prints failure summary on onRunEnd', () => {
    reporter.onRunStart!(makeConfig(), 1);
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'broken test',
      error: new Error('oops'),
    }));
    reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({ status: 'failed', fullName: 'broken test', error: new Error('oops') })],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('broken test');
    expect(output).toContain('oops');
  });

  it('does not erase emitted progress when a file retry is reported', () => {
    reporter.onRunStart!(makeConfig({ workers: 2 }), 1);
    reporter.onTestEnd!(makeTestResult({ status: 'passed' }));
    reporter.onTestEnd!(makeTestResult({ status: 'failed', error: new Error('infra') }));

    const beforeRetry = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    reporter.onTestFileRetry?.('/file.ts', 2);
    const afterRetry = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');

    reporter.onTestEnd!(makeTestResult({ status: 'passed' }));
    const stripped = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('').replace(/\x1b\[\d+m/g, '');
    expect(afterRetry).toBe(beforeRetry);
    expect(stripped).toContain('·F·');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });
});

describe('GitHubActionsReporter', () => {
  let reporter: TapsmithReporter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;

  beforeEach(async () => {
    const { GitHubActionsReporter } = await import('../reporters/github.js');
    reporter = new GitHubActionsReporter();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('emits ::error annotations at run end', async () => {
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({
        status: 'failed',
        fullName: 'login > rejects invalid password',
        error: new Error('Expected element to be visible'),
      })],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('::error');
    expect(output).toContain('Expected element to be visible');
  });

  it('emits a ::warning for each test warning, with no location (PILOT-398)', async () => {
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({ status: 'passed', fullName: 'signs in', warnings: ['The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.'] })],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('::warning title=warning: signs in::');
    expect(output).toContain('Example keeps stopping');
  });

  it('does not emit annotations for passing tests', async () => {
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({ status: 'passed' })],
    }));
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does not emit annotations for skipped tests', async () => {
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({ status: 'skipped' })],
    }));
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does not emit annotations mid-run (onTestEnd / onTestFileEnd)', () => {
    const failed = makeTestResult({
      status: 'failed',
      fullName: 'streamed failure',
      error: new Error('live failure'),
    });
    reporter.onTestEnd?.(failed);
    reporter.onTestFileEnd?.('/test.ts', [failed]);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('only emits annotations for failed tests in mixed results', async () => {
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test A' }),
        makeTestResult({ status: 'failed', fullName: 'test B', error: new Error('fail') }),
        makeTestResult({ status: 'skipped', fullName: 'test C' }),
      ],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('test B');
    expect(output).not.toContain('test A');
    expect(output).not.toContain('test C');
  });

  it('emits ::warning annotations for flaky tests with the first-attempt error', async () => {
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({
        status: 'passed',
        fullName: 'flaky test',
        retry: 1,
        firstAttemptError: new Error('Test timed out after 90000ms'),
      })],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('::warning');
    expect(output).toContain('flaky: flaky test');
    expect(output).toContain('Test timed out after 90000ms');
    expect(output).not.toContain('::error');
  });

  it('anchors annotations to the test file, not tapsmith internals', async () => {
    const error = new Error('Expected element to be visible');
    error.stack = [
      'Error: Expected element to be visible',
      '    at fail (/repo/packages/tapsmith/src/expect.ts:445:17)',
      '    at Object.toContainText (/repo/packages/tapsmith/src/expect.ts:665:9)',
      '    at async Object.fn (/repo/e2e/tests/gestures.test.ts:27:5)',
    ].join('\n');
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({ status: 'failed', fullName: 'double tap', error })],
    }));
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('file=/repo/e2e/tests/gestures.test.ts,line=27');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });
});

describe('JsonReporter', () => {
  it('writes JSON report to file on onRunEnd', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-json-'));
    const outputFile = path.join(tmpDir, 'results.json');

    const { JsonReporter } = await import('../reporters/json.js');
    const reporter = new JsonReporter({ outputFile });

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test a' }),
        makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('fail') }),
      ],
      suites: [{
        name: 'suite',
        durationMs: 100,
        tests: [
          makeTestResult({ status: 'passed', fullName: 'test a' }),
          makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('fail') }),
        ],
        suites: [],
      }],
    }));

    const report = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(report.stats.total).toBe(2);
    expect(report.stats.passed).toBe(1);
    expect(report.stats.failed).toBe(1);
    expect(report.suites).toHaveLength(1);
    expect(report.suites[0].tests).toHaveLength(2);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('writes a test warnings (PILOT-398)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-json-'));
    const outputFile = path.join(tmpDir, 'results.json');
    const { JsonReporter } = await import('../reporters/json.js');
    const reporter = new JsonReporter({ outputFile });
    const warned = makeTestResult({ status: 'passed', fullName: 'test a', warnings: ['The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.'] });
    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({ tests: [warned], suites: [{ name: 'suite', durationMs: 1, tests: [warned], suites: [] }] }));

    const report = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(report.suites[0].tests[0].warnings).toEqual(['The app under test (com.example.app) showed "Example keeps stopping"; Tapsmith dismissed it.']);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('writes the file-level failure flag of a file that failed to load (PILOT-545)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-json-'));
    const outputFile = path.join(tmpDir, 'results.json');
    const { JsonReporter } = await import('../reporters/json.js');
    const reporter = new JsonReporter({ outputFile });
    const loadFailure = makeTestResult({ status: 'failed', fullName: 'a.test.ts — failed to load', error: new Error('Cannot find module'), fileLevelFailure: true });
    const ordinary = makeTestResult({ status: 'passed', fullName: 'test a' });
    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({ tests: [loadFailure, ordinary], suites: [{ name: 'suite', durationMs: 1, tests: [loadFailure, ordinary], suites: [] }] }));

    const report = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(report.suites[0].tests[0].fileLevelFailure).toBe(true);
    expect(report.suites[0].tests[1]).not.toHaveProperty('fileLevelFailure');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('honors TAPSMITH_JSON_OUTPUT_FILE over the outputFile option', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-json-'));
    const optionFile = path.join(tmpDir, 'option.json');
    const overrideFile = path.join(tmpDir, 'override.json');

    process.env.TAPSMITH_JSON_OUTPUT_FILE = overrideFile;
    try {
      const { JsonReporter } = await import('../reporters/json.js');
      const reporter = new JsonReporter({ outputFile: optionFile });
      reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
      await reporter.onRunEnd!(makeFullResult({
        tests: [makeTestResult({ status: 'passed', fullName: 'test a' })],
        suites: [],
      }));

      expect(fs.existsSync(overrideFile)).toBe(true);
      expect(fs.existsSync(optionFile)).toBe(false);
    } finally {
      delete process.env.TAPSMITH_JSON_OUTPUT_FILE;
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('JUnitReporter', () => {
  it('writes JUnit XML to file on onRunEnd', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-junit-'));
    const outputFile = path.join(tmpDir, 'results.xml');

    const { JUnitReporter } = await import('../reporters/junit.js');
    const reporter = new JUnitReporter({ outputFile });

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test a' }),
        makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('assert fail') }),
        makeTestResult({ status: 'skipped', fullName: 'test c' }),
      ],
      suites: [{
        name: 'suite',
        durationMs: 200,
        tests: [
          makeTestResult({ status: 'passed', fullName: 'test a' }),
          makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('assert fail') }),
          makeTestResult({ status: 'skipped', fullName: 'test c' }),
        ],
        suites: [],
      }],
    }));

    const xml = fs.readFileSync(outputFile, 'utf-8');
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<skipped/>');
    expect(xml).toContain('assert fail');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('escapes XML special characters', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-junit-'));
    const outputFile = path.join(tmpDir, 'results.xml');

    const { JUnitReporter } = await import('../reporters/junit.js');
    const reporter = new JUnitReporter({ outputFile });

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({
          status: 'failed',
          fullName: 'test <with> "special" & chars',
          error: new Error('Expected <div> & "value"'),
        }),
      ],
    }));

    const xml = fs.readFileSync(outputFile, 'utf-8');
    expect(xml).toContain('&lt;with&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('HtmlReporter', () => {
  it('writes an HTML report on onRunEnd', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-html-'));

    const { HtmlReporter } = await import('../reporters/html.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new HtmlReporter({ outputFolder: tmpDir, open: 'never' });

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test a', warnings: ['The app under test (x) showed "X keeps stopping"; Tapsmith dismissed it.'] }),
        makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('oops') }),
      ],
    }));

    const indexPath = path.join(tmpDir, 'index.html');
    expect(fs.existsSync(indexPath)).toBe(true);

    const html = fs.readFileSync(indexPath, 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Tapsmith Test Report');
    expect(html).toContain('test a');
    expect(html).toContain('test b');
    // PILOT-398: warnings reach the report's data and its renderer.
    expect(html).toContain('X keeps stopping');
    expect(html).toContain('warning-msg');

    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('HtmlReporter stack (PILOT-841)', () => {
  it('shows the user frames under the message, not the SDK frames or the message again', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-html-'));
    const { HtmlReporter } = await import('../reporters/html.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const err = new Error('Expected: 1\nReceived: 2');
      err.stack = [
        'Error: Expected: 1',
        'Received: 2',
        ...Array.from({ length: 5 }, (_, i) => `    at f${i} (/proj/node_modules/tapsmith/dist/expect.js:${i + 1}:1)`),
        '    at async Object.fn (/proj/tests/login.test.ts:12:7)',
      ].join('\n');
      const reporter = new HtmlReporter({ outputFolder: tmpDir, open: 'never' });
      reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
      await reporter.onRunEnd!(makeFullResult({
        tests: [makeTestResult({ status: 'failed', fullName: 'test b', error: err })],
      }));
      const html = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf-8');
      expect(html).toContain('/proj/tests/login.test.ts:12:7');
      expect(html).not.toContain('tapsmith/dist/expect.js');
    } finally {
      stderrSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('BlobReporter', () => {
  it('writes a blob file and can be merged', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-blob-'));

    const { BlobReporter, mergeBlobs } = await import('../reporters/blob.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new BlobReporter({ outputDir: tmpDir });

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'shard1 test' }),
        makeTestResult({ status: 'failed', fullName: 'shard1 fail', error: new Error('err') }),
      ],
      suites: [{
        name: 'suite1',
        durationMs: 100,
        tests: [
          makeTestResult({ status: 'passed', fullName: 'shard1 test' }),
          makeTestResult({ status: 'failed', fullName: 'shard1 fail', error: new Error('err') }),
        ],
        suites: [],
      }],
    }));

    // Verify blob files exist
    const blobFiles = fs.readdirSync(tmpDir).filter((f: string) => f.endsWith('.jsonl'));
    expect(blobFiles.length).toBeGreaterThan(0);

    // Merge and verify
    const merged = mergeBlobs(tmpDir);
    expect(merged.tests).toHaveLength(2);
    expect(merged.tests[0].fullName).toBe('shard1 test');
    expect(merged.tests[1].fullName).toBe('shard1 fail');
    expect(merged.tests[1].error?.message).toBe('err');
    expect(merged.suites).toHaveLength(1);

    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('round-trips firstAttemptError and the linked (failed-attempt) trace', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-blob-flaky-'));
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-blob-flaky-trace-'));
    const tracePath = path.join(traceDir, 'trace-flaky-attempt0.zip');
    fs.writeFileSync(tracePath, 'zip-bytes');

    const { BlobReporter, mergeBlobs } = await import('../reporters/blob.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new BlobReporter({ outputDir: tmpDir });

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1);
    await reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({
        status: 'passed',
        fullName: 'flaky test',
        retry: 1,
        firstAttemptError: new Error('Test timed out after 90000ms'),
        tracePath,
      })],
    }));

    const merged = mergeBlobs(tmpDir);
    expect(merged.tests).toHaveLength(1);
    expect(merged.tests[0].firstAttemptError?.message).toBe('Test timed out after 90000ms');
    // The failed attempt's trace file itself travelled inside the blob.
    expect(merged.tests[0].tracePath).toBe(path.join(tmpDir, 'trace-flaky-attempt0.zip'));
    expect(fs.existsSync(merged.tests[0].tracePath!)).toBe(true);

    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true });
    fs.rmSync(traceDir, { recursive: true });
  });
});

// ─── Base formatting utilities ───

describe('base formatting utilities', () => {
  it('formatDuration formats milliseconds and seconds', async () => {
    const { formatDuration } = await import('../reporters/base.js');
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.0s');
  });

  it('statusIcon returns different icons per status', async () => {
    const { statusIcon } = await import('../reporters/base.js');
    const passed = statusIcon('passed');
    const failed = statusIcon('failed');
    const skipped = statusIcon('skipped');

    // They should all be different (include ANSI codes)
    expect(passed).not.toBe(failed);
    expect(failed).not.toBe(skipped);
  });

  it('formatError includes message and stack', async () => {
    const { formatError } = await import('../reporters/base.js');
    const err = new Error('test error');
    const output = formatError(err);
    expect(output).toContain('test error');
  });

  it('formatError indents every line of a multi-line message, not just the first', async () => {
    const { formatError } = await import('../reporters/base.js');
    const err = new Error('Device target "ios" could not start: build failed (exit 65)\n  error: no signing\n  Log: /tmp/b.log');
    err.stack = undefined;
    const plain = formatError(err, '    ').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.split('\n')).toEqual([
      '    Device target "ios" could not start: build failed (exit 65)',
      '      error: no signing',
      '      Log: /tmp/b.log',
    ]);
  });

  it('formatError shows a multi-line message once, then the real frames', async () => {
    const { formatError } = await import('../reporters/base.js');
    const err = new Error('Expected: 1\nReceived: 2');
    err.stack = 'Error: Expected: 1\nReceived: 2\n    at one (/x/a.js:1:1)\n    at two (/x/b.js:2:2)';
    const plain = formatError(err).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.split('\n').filter((l) => l.includes('Received: 2'))).toHaveLength(1);
    expect(plain).toContain('at one (/x/a.js:1:1)');
    expect(plain).toContain('at two (/x/b.js:2:2)');
  });

  it('formatError shows the user frame of an npm install, not the first three SDK frames (PILOT-841)', async () => {
    const { formatError } = await import('../reporters/base.js');
    const err = new Error('Expected element getByText("x") to be visible, but it was not.');
    err.stack = [
      `Error: ${err.message}`,
      '    at fail (/proj/node_modules/tapsmith/src/expect.ts:548:17)',
      '    at Object.toBeVisible (/proj/node_modules/tapsmith/src/expect.ts:632:9)',
      '    at async Object.toBeVisible (/proj/node_modules/tapsmith/src/expect.ts:475:7)',
      '    at async Object.fn (/proj/tests/tabs.tapsmith.ts:6:5)',
      '    at async testFn (/proj/node_modules/tapsmith/dist/runner.js:2167:33)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
    ].join('\n');
    const plain = formatError(err).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('at async Object.fn (/proj/tests/tabs.tapsmith.ts:6:5)');
    expect(plain).not.toContain('expect.ts');
    expect(plain).not.toContain('runner.js');
    expect(plain).not.toContain('node:internal');
  });

  it('formatError skips a multi-line message under any error name, even after a worker rebuilt the error as a plain Error (PILOT-841)', async () => {
    // --workers and watch send errors across a process boundary as
    // { message, stack } and rebuild them with new Error(message): the name
    // is lost, but the stack still opens with the original one.
    const { formatError } = await import('../reporters/base.js');
    const message = 'strict mode violation: getByText(/^Item/) resolved to 3 elements:\n  1) text "Item 1"\n  2) text "Item 2"\n  3) text "Item 3"';
    for (const header of ['StrictModeViolationError', 'TypeError', 'TypeError [ERR_INVALID_ARG_TYPE]']) {
      const err = Object.assign(new Error(message), {
        stack: [
          `${header}: ${message}`,
          '    at ElementHandle.tap (/proj/node_modules/tapsmith/src/element-handle.ts:2651:37)',
          '    at async Object.fn (/proj/tests/strict.test.ts:5:3)',
        ].join('\n'),
      });
      const plain = formatError(err).replace(/\x1b\[[0-9;]*m/g, '');
      expect(plain, header).toContain('at async Object.fn (/proj/tests/strict.test.ts:5:3)');
      expect(plain.split('\n').filter((l) => l.includes('text "Item 2"')), header).toHaveLength(1);
    }
  });

  it('formatError skips the stack header even when the message grew after the stack was set (soft / unhandled errors appended)', async () => {
    // The runner appends "--- Additionally ---" blocks to a failed test's
    // message; expect() set the stack before that, so the stack no longer
    // opens with the whole message. Whatever the header holds, the frames
    // are what starts at the first "at" line.
    const { formatError, errorStackFrames } = await import('../reporters/base.js');
    const first = 'Expected element getByTestId("x") to contain text zulu, but got "alpha\nbravo\ncharlie\ndelta"';
    const err = new Error(`${first}\n\n--- Additionally ---\nExpected 2, received 1`);
    err.stack = [`Error: ${first}`, '    at async Object.fn (/proj/tests/softlong.test.ts:8:3)'].join('\n');
    expect(errorStackFrames(err, 3)).toEqual(['    at async Object.fn (/proj/tests/softlong.test.ts:8:3)']);
    const plain = formatError(err).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.split('\n').filter((l) => l.trim() === 'bravo')).toHaveLength(1);
  });

  it('formatError keeps the first frame of a stack with no header line', async () => {
    const { errorStackFrames } = await import('../reporters/base.js');
    const err = Object.assign(new Error('boom'), { stack: '    at /proj/tests/a.test.ts:1:1\n    at /proj/tests/b.test.ts:2:2' });
    expect(errorStackFrames(err, 3)).toEqual(['    at /proj/tests/a.test.ts:1:1', '    at /proj/tests/b.test.ts:2:2']);
  });

  it('formatError caps the user frames at three', async () => {
    const { formatError } = await import('../reporters/base.js');
    const err = new Error('boom');
    err.stack = ['Error: boom', ...[1, 2, 3, 4].map((n) => `    at f${n} (/proj/tests/h${n}.ts:${n}:1)`)].join('\n');
    const plain = formatError(err).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('h3.ts');
    expect(plain).not.toContain('h4.ts');
  });

  it('formatError still prints frames for an error with no user frame (a runner timeout)', async () => {
    const { formatError } = await import('../reporters/base.js');
    const err = new Error('Test timed out after 90000ms');
    err.stack = [
      'Error: Test timed out after 90000ms',
      '    at Timeout.check (/proj/node_modules/tapsmith/dist/runner.js:1701:115)',
      '    at listOnTimeout (node:internal/timers:585:17)',
    ].join('\n');
    const plain = formatError(err).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('at Timeout.check (/proj/node_modules/tapsmith/dist/runner.js:1701:115)');
  });

  it('formatError renders the snippet from the user frame, skipping npm-installed framework frames', async () => {
    // A timeout error's top frame points at the framework. In the monorepo
    // that path contains /packages/tapsmith/ — but for npm installs it is
    // node_modules/tapsmith/dist/, which an earlier ad-hoc filter missed,
    // rendering a snippet of compiled dist/runner.js instead of the test.
    const { formatError } = await import('../reporters/base.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-fmt-err-'));
    const testFile = path.join(tempDir, 'example.test.ts');
    fs.writeFileSync(testFile, [
      "test('signs up', async () => {",
      "  await device.tap(text('Sign up'));",
      "  await field.type('user@example.com');",
      '});',
    ].join('\n'));

    try {
      const err = new Error('Test timed out after 90000ms');
      err.stack = [
        'Error: Test timed out after 90000ms',
        '    at Timeout.check (/proj/node_modules/tapsmith/dist/runner.js:1701:115)',
        `    at ${testFile}:3:15`,
        '    at listOnTimeout (node:internal/timers:585:17)',
      ].join('\n');

      const output = formatError(err);
      expect(output).toContain("await field.type('user@example.com');");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
