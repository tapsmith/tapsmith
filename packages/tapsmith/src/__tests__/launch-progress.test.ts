import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TapsmithConfig } from '../config.js';
import type { ResolvedProject } from '../project.js';
import { createUiLaunchSteps, formatLaunchTable, UiLaunchProgress, unshownPart, withoutShownHeadline, writesToSamePlace, type LaunchStep } from '../launch-progress.js';

class CaptureStream extends Writable {
  columns = 80;
  isTTY = true;
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  output(): string {
    return this.chunks.join('');
  }
}

const baseConfig = (overrides: Partial<TapsmithConfig> = {}): TapsmithConfig => ({
  timeout: 10_000,
  retries: 0,
  screenshot: 'only-on-failure',
  testMatch: ['tests/**/*.test.ts'],
  daemonAddress: '127.0.0.1:50051',
  rootDir: '/repo',
  outputDir: 'tapsmith-results',
  package: 'dev.tapsmith.testapp',
  workers: 1,
  launchEmulators: false,
  platform: 'android',
  ...overrides,
});

describe('createUiLaunchSteps', () => {
  it('builds a compact plan from a single Android config', () => {
    const steps = createUiLaunchSteps({
      config: baseConfig({ apk: 'app-debug.apk', workers: 1 }),
      testFileCount: 3,
      workerCount: 1,
    });

    expect(steps.map((s) => s.id)).toEqual([
      'config',
      'primary-device',
      'daemon',
      'app-install',
      'agent',
      'app-launch',
      'ui-workers',
      'ui-server',
      'mcp',
      'test-tree',
      'browser',
    ]);
    // A single-device UI session still runs through one persistent worker
    // that attaches to the primary device.
    expect(steps.find((s) => s.id === 'ui-workers')!.label).toBe('Worker');
    expect(steps[0]!.detail).toContain('1 worker');
    expect(steps[0]!.detail).toContain('3 test files');
    expect(steps.find((s) => s.id === 'app-install')!.detail).toBe('verify/install app-debug.apk');
  });

  it('adds worker-pool rows for parallel multi-project UI mode', () => {
    const android = baseConfig({ platform: 'android', apk: 'app.apk', workers: 4 });
    const ios = baseConfig({ platform: 'ios', app: 'Test.app', simulator: 'iPhone 17', workers: 4 });
    const projects: ResolvedProject[] = [
      {
        name: 'android',
        testMatch: ['tests/**/*.test.ts'],
        testIgnore: [],
        dependencies: [],
        testFiles: ['/repo/tests/home.test.ts'],
        effectiveConfig: android,
        deviceSignature: 'android|Pixel|',
      },
      {
        name: 'ios',
        testMatch: ['tests/**/*.test.ts'],
        testIgnore: [],
        dependencies: [],
        testFiles: ['/repo/tests/home.test.ts'],
        effectiveConfig: ios,
        deviceSignature: 'ios|iPhone 17|',
      },
    ];

    const steps = createUiLaunchSteps({
      config: android,
      projects,
      testFileCount: 12,
      workerCount: 4,
    });

    expect(steps[0]!.detail).toContain('android + ios');
    expect(steps.map((s) => s.id)).toContain('primary-device');
    expect(steps.map((s) => s.id)).toContain('worker-devices');
    // Exactly one workers row: the single-device "attach a worker" step must
    // not double up with the multi-device one (steps are keyed by id).
    expect(steps.filter((s) => s.id === 'ui-workers')).toHaveLength(1);
    expect(steps.find((s) => s.id === 'ui-workers')!.label).toBe('UI workers');
    expect(steps.find((s) => s.id === 'worker-devices')!.detail).toContain('across 2 targets');
  });

  it('reports a device group under one worker-devices row, whichever mode provisions it', () => {
    const group = baseConfig({ apk: 'app-debug.apk', devices: 2 });
    // Sequential CLI / single-worker UI: the group comes up right after the primary.
    const single = createUiLaunchSteps({ config: group, testFileCount: 1, workerCount: 1 });
    expect(single.filter((s) => s.id === 'worker-devices')).toHaveLength(1);
    expect(single.find((s) => s.id === 'worker-devices')!.label).toBe('Device group');
    // Multi-worker UI mode provisions every worker's group under its own
    // "Worker devices" row; a second row with the same id would never be
    // updated (steps are keyed by id) and sit pending for the whole launch.
    const multi = createUiLaunchSteps({ config: group, testFileCount: 4, workerCount: 2 });
    expect(multi.filter((s) => s.id === 'worker-devices')).toHaveLength(1);
    expect(multi.find((s) => s.id === 'worker-devices')!.label).toBe('Worker devices');
  });


  // PILOT-775: the Config line says how network capture runs.
  it('says on the Config line whether the trace captures network or the proxy starts on demand', () => {
    const detail = (config: Partial<TapsmithConfig>) =>
      createUiLaunchSteps({ config: baseConfig(config), testFileCount: 1, workerCount: 1, mode: 'test' })[0]!.detail;
    expect(detail({})).toContain('network: on demand');
    expect(detail({ trace: 'retain-on-failure' })).toContain('network: captured');
    expect(detail({ trace: { mode: 'on', network: false } })).toContain('network: on demand');
    // Records only retries, so a test's first attempt starts it on demand.
    expect(detail({ trace: 'on-first-retry' })).toContain('network: on demand');
  });

  it('says captured in UI mode, whose workers turn a missing or off trace on', () => {
    const detail = (config: Partial<TapsmithConfig>) =>
      createUiLaunchSteps({ config: baseConfig(config), testFileCount: 1, workerCount: 1, mode: 'ui' })[0]!.detail;
    expect(detail({})).toContain('network: captured');
    expect(detail({ trace: 'off' })).toContain('network: captured');
    expect(detail({ trace: { mode: 'on', network: false } })).toContain('network: on demand');
  });

  it('lists each network state once across projects', () => {
    const traced = baseConfig({ trace: 'on' });
    const project = (name: string, effectiveConfig: TapsmithConfig): ResolvedProject => ({
      name, testMatch: [], testIgnore: [], dependencies: [], testFiles: [], effectiveConfig, deviceSignature: name,
    });
    const steps = createUiLaunchSteps({
      config: traced,
      projects: [project('a', traced), project('b', baseConfig({})), project('c', traced)],
      testFileCount: 1,
      workerCount: 1,
      mode: 'test',
    });
    expect(steps[0]!.detail).toContain('network: captured + on demand');
  });

  it('uses worker-focused rows for headless parallel test mode', () => {
    const steps = createUiLaunchSteps({
      config: baseConfig({ apk: 'app-debug.apk', workers: 3 }),
      testFileCount: 8,
      workerCount: 3,
      mode: 'test',
    });

    expect(steps.map((s) => s.id)).toEqual([
      'config',
      'daemon',
      'worker-devices',
      'app-install',
      'agent',
      'app-launch',
      'ui-workers',
    ]);
    expect(steps.find((s) => s.id === 'daemon')!.label).toBe('Worker daemons');
    expect(steps.find((s) => s.id === 'ui-workers')!.label).toBe('Workers');
    expect(steps.find((s) => s.id === 'app-install')!.progress).toEqual({ done: 0, total: 3 });
    expect(steps.map((s) => s.id)).not.toContain('ui-server');
  });

  it('shows worker allocation warnings as launch plan rows', () => {
    const steps = createUiLaunchSteps({
      config: baseConfig({ apk: 'app-debug.apk', workers: 2 }),
      testFileCount: 8,
      workerCount: 2,
      mode: 'test',
      workerPlanWarning: 'requested 1 worker; running 2 because 2 device targets need one each',
    });

    const workerPlan = steps.find((s) => s.id === 'worker-plan');
    expect(steps.map((s) => s.id).slice(0, 3)).toEqual(['config', 'worker-plan', 'daemon']);
    expect(workerPlan).toMatchObject({
      label: 'Worker plan',
      state: 'warning',
      detail: 'requested 1 worker; running 2 because 2 device targets need one each',
    });
  });
});

describe('formatLaunchTable', () => {
  it('renders status, progress counts, and details in stable columns', () => {
    const steps: LaunchStep[] = [
      { id: 'config', label: 'Config', state: 'done', detail: '4 workers | 31 test files' },
      {
        id: 'ui-workers',
        label: 'UI workers',
        state: 'running',
        detail: 'Worker 2: starting Tapsmith agent',
        progress: { done: 2, total: 4 },
      },
    ];

    const table = formatLaunchTable(steps, { color: false, columns: 90 });

    expect(table).toContain('UI mode');
    expect(table).toMatch(/^UI mode\n\nSTEP/);
    expect(table).toContain('Config      ✓');
    expect(table).toContain('UI workers  2/4');
    expect(table).toContain('Worker 2: starting Tapsmith agent');
  });

  it('renders degraded worker startup as a warning instead of success', () => {
    const steps: LaunchStep[] = [
      {
        id: 'ui-workers',
        label: 'UI workers',
        state: 'warning',
        detail: '2/4 UI worker(s) ready; 2 failed',
        progress: { done: 2, total: 4 },
      },
    ];

    const table = formatLaunchTable(steps, { color: false, columns: 90 });

    expect(table).toContain('UI workers  2/4');
    expect(table).toContain('2/4 UI worker(s) ready; 2 failed');
    expect(table).not.toContain('UI workers  ✓');
  });

  it('renders spinner frames for running table rows', () => {
    const steps: LaunchStep[] = [
      { id: 'primary-device', label: 'Primary device', state: 'running', detail: 'checking emulator-5554' },
      {
        id: 'ui-workers',
        label: 'UI workers',
        state: 'running',
        detail: 'Worker 2: starting Tapsmith agent',
        progress: { done: 2, total: 4 },
      },
    ];

    const table = formatLaunchTable(steps, { color: false, columns: 90, spinnerFrame: '⠙' });

    expect(table).toContain('Primary device  ⠙');
    expect(table).toContain('UI workers      ⠙ 2/4');
  });

  it('omits the title block when the title is empty', () => {
    const steps: LaunchStep[] = [
      { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
    ];

    const table = formatLaunchTable(steps, { color: false, columns: 90, title: '' });

    expect(table).toMatch(/^STEP\s+STATUS\s+DETAILS/);
    expect(table).not.toContain('UI mode');
    expect(table).not.toContain('Test run');
  });
});

describe('UiLaunchProgress', () => {
  it('streams row updates without an initial table in non-interactive output', () => {
    const stream = new CaptureStream();
    const progress = new UiLaunchProgress(
      [
        { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
        { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
        { id: 'daemon', label: 'Daemon', state: 'pending', detail: 'start tapsmith-core' },
      ],
      { stream, forceInteractive: false, color: false, title: '' },
    );

    progress.start('primary-device');
    progress.complete('primary-device', 'emulator-5554 awake and unlocked');
    progress.complete('daemon', 'connected to tapsmith-core v0.1.1');
    progress.finish();

    const output = stream.output();
    expect(output).not.toContain('Test run');
    expect(output).toMatch(/^✓\s+Config: 1 worker \| 1 test file\n/);
    expect(output).toContain('✓     Config: 1 worker | 1 test file\n');
    expect(output).toContain('…     Primary device: select connected Android device\n');
    expect(output).toContain('✓     Primary device: emulator-5554 awake and unlocked\n');
    expect(output).toContain('✓     Daemon: connected to tapsmith-core v0.1.1\n');
    expect(output).not.toContain('STEP');
    expect(output).not.toContain('DETAILS');
  });

  it('does not regress completed progress rows back to running', () => {
    const stream = new CaptureStream();
    const progress = new UiLaunchProgress(
      [
        { id: 'daemon', label: 'Worker daemons', state: 'pending', detail: 'start 2 worker daemons', progress: { done: 0, total: 2 } },
      ],
      { stream, forceInteractive: false, color: false, title: '' },
    );

    progress.start('daemon', 'starting 2 worker daemon(s)');
    progress.update('daemon', {
      state: 'running',
      detail: 'Worker 1: daemon ready on localhost:50101',
      progress: { done: 1, total: 2 },
    });
    progress.update('daemon', {
      state: 'done',
      detail: '2/2 worker daemon(s) ready',
      progress: { done: 2, total: 2 },
    });
    progress.update('daemon', {
      state: 'running',
      detail: 'Worker 1: connecting to daemon on localhost:50102',
      progress: { done: 2, total: 2 },
    });
    progress.finish();

    const output = stream.output();
    expect(output).toContain('✓     Worker daemons: 2/2 worker daemon(s) ready\n');
    expect(output).not.toContain('Worker 1: connecting to daemon on localhost:50102');
  });

  it('redraws interactive tables with row clearing instead of cursor save/restore', () => {
    const stream = new CaptureStream();
    const progress = new UiLaunchProgress(
      [
        { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
        { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
      ],
      { stream, forceInteractive: true, color: false },
    );

    progress.start('primary-device', 'checking emulator-5554');
    progress.finish();

    const output = stream.output();
    expect(output).not.toContain('\x1b[s');
    expect(output).not.toContain('\x1b[u');
    expect(output).toContain('\x1b[1G');
    expect(output).toContain('\x1b[0J');
  });

  it('animates running rows in interactive output', () => {
    vi.useFakeTimers();
    try {
      const stream = new CaptureStream();
      const progress = new UiLaunchProgress(
        [
          { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
          { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
        ],
        { stream, forceInteractive: true, color: false },
      );

      progress.start('primary-device', 'checking emulator-5554');
      expect(stream.output()).toContain('Primary device  ⠋');

      vi.advanceTimersByTime(120);

      expect(stream.output()).toContain('Primary device  ⠙');
      progress.complete('primary-device', 'ready');
      progress.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('redraws the table around external stdout writes while active', () => {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const chunks: string[] = [];
    const captureWrite = ((
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write;

    process.stdout.write = captureWrite;
    process.stderr.write = captureWrite as typeof process.stderr.write;

    try {
      const progress = new UiLaunchProgress(
        [
          { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
          { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
        ],
        { forceInteractive: true, color: false },
      );

      process.stdout.write('external log\n');
      progress.complete('primary-device', 'ready');
      progress.finish();
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    const output = chunks.join('');
    expect(output.match(/external log/g)).toHaveLength(1);
    expect(output).toContain('\x1b[0Jexternal log\nUI mode');
  });
});

// A start error used to print twice: on its ✗ row, then again in red below
// the rows (PILOT-569).
describe('start errors the launch rows already showed', () => {
  const AGENT_ERROR = 'The iOS agent port 18700 is held by a Tapsmith runner for another device. Stop that session.';
  const steps = (): LaunchStep[] => [
    { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
    { id: 'agent', label: 'Agent', state: 'pending', detail: 'start iOS agent' },
  ];

  it('drops a line that only repeats a failed row\'s detail, label and all', () => {
    expect(unshownPart(`Device (ABC): Failed to start agent: ${AGENT_ERROR}`, [AGENT_ERROR])).toBe('');
  });

  it('keeps what the error adds beyond the row', () => {
    expect(unshownPart('No online devices found.\nStart the emulator yourself.', ['No online devices found.']))
      .toBe('Start the emulator yourself.');
  });

  it('keeps a line the detail is only part of', () => {
    expect(unshownPart('no online device found, and no AVD to boot', ['no online device found']))
      .toBe('no online device found, and no AVD to boot');
  });

  // The dispatcher fails every unfinished phase with the same detail.
  it('drops a detail shown on several rows once, keeping the lines that name each device', () => {
    const progress = new UiLaunchProgress([
      { id: 'app-install', label: 'App install', state: 'pending', detail: '' },
      { id: 'agent', label: 'Agent', state: 'pending', detail: '' },
      { id: 'app-launch', label: 'App launch', state: 'pending', detail: '' },
    ], { stream: new CaptureStream(), forceInteractive: false, color: false, title: '' });
    for (const id of ['app-install', 'agent', 'app-launch'] as const) progress.fail(id, 'INSTALL_FAILED_INSUFFICIENT_STORAGE');
    progress.finish();
    const message = 'No worker could start: INSTALL_FAILED_INSUFFICIENT_STORAGE\n'
      + 'Worker 1 (emulator-5554): INSTALL_FAILED_INSUFFICIENT_STORAGE\n'
      + 'Worker 2 (emulator-5556): INSTALL_FAILED_INSUFFICIENT_STORAGE';
    expect(unshownPart(message, progress.shownFailures())).toBe(
      'Worker 1 (emulator-5554): INSTALL_FAILED_INSUFFICIENT_STORAGE\n'
      + 'Worker 2 (emulator-5556): INSTALL_FAILED_INSUFFICIENT_STORAGE',
    );
  });

  it('keeps everything when nothing was shown', () => {
    expect(unshownPart('Failed to start agent: boom', [])).toBe('Failed to start agent: boom');
  });

  it('reports a non-interactive row\'s detail as shown in full', () => {
    const progress = new UiLaunchProgress(steps(), { stream: new CaptureStream(), forceInteractive: false, color: false, title: '' });
    progress.fail('agent', AGENT_ERROR);
    progress.finish();
    expect(progress.shownFailures()).toEqual([AGENT_ERROR]);
  });

  it('does not count a detail the interactive table cut short', () => {
    const stream = new CaptureStream();
    const progress = new UiLaunchProgress(steps(), { stream, forceInteractive: true, color: false, title: '' });
    progress.fail('agent', AGENT_ERROR);
    progress.finish();
    expect(stream.output()).toContain('…');
    expect(progress.shownFailures()).toEqual([]);

    const wide = new CaptureStream();
    wide.columns = 200;
    const shown = new UiLaunchProgress(steps(), { stream: wide, forceInteractive: true, color: false, title: '' });
    shown.fail('agent', AGENT_ERROR);
    shown.finish();
    expect(shown.shownFailures()).toEqual([AGENT_ERROR]);
  });
});

// The rows go to stdout and the error to stderr: leaving the reason out of
// the error is only safe where both reach the same place. `verify --json`
// ignores the child's stdout and reports its stderr (PILOT-569).
describe('writesToSamePlace', () => {
  it('is true for one terminal, pipe or file', () => {
    expect(writesToSamePlace({ dev: 1, ino: 7 }, { dev: 1, ino: 7 })).toBe(true);
  });

  it('is false for separate destinations, or one that cannot be read', () => {
    expect(writesToSamePlace({ dev: 1, ino: 7 }, { dev: 1, ino: 8 })).toBe(false);
    expect(writesToSamePlace({ dev: 1, ino: 7 }, { dev: 2, ino: 7 })).toBe(false);
    expect(writesToSamePlace(undefined, { dev: 1, ino: 7 })).toBe(false);
  });
});

// A summary error ("No worker could start: …", "No device target could
// start") names each worker or target on its own line; only its headline
// can repeat a row (PILOT-569).
describe('withoutShownHeadline', () => {
  it('drops a headline that repeats a row, keeping every labelled line', () => {
    expect(withoutShownHeadline('No worker could start: D\nWorker 1 (emulator-5554): D', ['D']))
      .toBe('Worker 1 (emulator-5554): D');
  });

  it('keeps a target-labelled line whose reason a stale row shows', () => {
    const message = 'No device target could start\n  android: D1\n  ios: D2';
    expect(withoutShownHeadline(message, ['D1'])).toBe(message);
  });

  it('is empty for a one-line error a row showed', () => {
    expect(withoutShownHeadline('Failed to start agent: D', ['D'])).toBe('');
  });
});
