import { describe, it, expect, vi } from 'vitest';
import { isRecoverableInfrastructureError, type MainToWorkerMessage, type SerializedConfig, type WorkerToMainMessage } from '../worker-protocol.js';
import { TestAbortedError } from '../abort.js';
import type { RunOptions, SuiteResult, TestResult } from '../runner.js';

const workerRunnerMocks = vi.hoisted(() => {
  const collectResults = (suite: { tests: unknown[]; suites: unknown[] }): unknown[] => [
    ...suite.tests,
    ...suite.suites.flatMap((child) => collectResults(child as { tests: unknown[]; suites: unknown[] })),
  ];

  return {
    runTestFile: vi.fn(),
    collectResults: vi.fn(collectResults),
  };
});

const sessionPreflightMocks = vi.hoisted(() => ({
  ensureSessionReady: vi.fn(async () => {}),
  launchConfiguredApp: vi.fn(async () => {}),
}));

vi.mock('../runner.js', () => ({
  runTestFile: workerRunnerMocks.runTestFile,
  collectResults: workerRunnerMocks.collectResults,
}));

vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: vi.fn().mockImplementation(() => ({
    waitForReady: vi.fn(async () => true),
    close: vi.fn(),
  })),
}));

vi.mock('../device.js', () => ({
  Device: vi.fn().mockImplementation(() => ({
    setDevice: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    installApk: vi.fn(async () => {}),
    startAgent: vi.fn(async () => {}),
    close: vi.fn(),
  })),
}));

vi.mock('../emulator.js', () => ({
  isPackageInstalled: vi.fn(() => true),
  // The installed build matches: only `forceInstall` can make a worker reinstall.
  installedApkMatches: vi.fn(() => true),
  waitForPackageIndexed: vi.fn(async () => {}),
}));

vi.mock('../ios-simulator.js', () => ({
  installApp: vi.fn(),
  isAppInstalled: vi.fn(() => true),
  probeSimulatorHealth: vi.fn(() => ({ healthy: true })),
  rebootSimulator: vi.fn(),
}));

vi.mock('../session-preflight.js', () => sessionPreflightMocks);

function makeSerializedConfig(overrides: Partial<SerializedConfig> = {}): SerializedConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    rootDir: '/tmp',
    outputDir: 'out',
    ...overrides,
  };
}

describe('isRecoverableInfrastructureError', () => {
  it('returns true for agent timeout errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Agent command timed out after 30000ms'))).toBe(true);
  });

  it('returns true for empty response errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Agent returned empty response'))).toBe(true);
  });

  it('returns true for agent disconnection errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Not connected to agent'))).toBe(true);
  });

  it('returns true for socket connection timeout', () => {
    expect(isRecoverableInfrastructureError(new Error('Timed out connecting to agent socket'))).toBe(true);
  });

  it('returns true for socket connection failure', () => {
    expect(isRecoverableInfrastructureError(new Error('Failed to connect to agent socket on port 18700'))).toBe(true);
  });

  it('returns true for gRPC UNAVAILABLE errors', () => {
    expect(isRecoverableInfrastructureError(new Error('14 UNAVAILABLE: No connection established'))).toBe(true);
  });

  it('returns true for gRPC DEADLINE_EXCEEDED errors (agent/daemon hung)', () => {
    expect(isRecoverableInfrastructureError(new Error('4 DEADLINE_EXCEEDED: Deadline exceeded'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRecoverableInfrastructureError(new Error('connect ECONNREFUSED 127.0.0.1:50051'))).toBe(true);
  });

  it('returns true when per-test preflight recovered the session', () => {
    expect(isRecoverableInfrastructureError(new Error('session recovered during before test suite > test'))).toBe(true);
  });

  it('returns true when network capture is disabled before a route test', () => {
    expect(isRecoverableInfrastructureError(new Error('Network capture disabled: proxy unavailable'))).toBe(true);
  });

  it('returns true for agent connection dropped', () => {
    expect(isRecoverableInfrastructureError(new Error('Agent connection dropped (empty response); reconnecting'))).toBe(true);
  });

  it('returns true for the TCP-reset variants of a dropped agent connection (PILOT-282)', () => {
    expect(isRecoverableInfrastructureError(new Error('Agent connection lost during read'))).toBe(true);
    expect(isRecoverableInfrastructureError(new Error('Agent connection lost and agent is unreachable'))).toBe(true);
  });

  it('returns false for assertion errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Expected "Login" to be visible'))).toBe(false);
  });

  it('returns false for test timeout errors (these are real test failures)', () => {
    expect(isRecoverableInfrastructureError(new Error('Test timed out after 60000ms'))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isRecoverableInfrastructureError(new Error('something went wrong'))).toBe(false);
  });

  it('returns false for user-stop aborts — a stop must never trigger session recovery (PILOT-222)', () => {
    expect(isRecoverableInfrastructureError(new TestAbortedError())).toBe(false);
    expect(isRecoverableInfrastructureError(new Error('Stopped by user'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isRecoverableInfrastructureError('Agent command timed out')).toBe(true);
    expect(isRecoverableInfrastructureError('random string')).toBe(false);
    expect(isRecoverableInfrastructureError(42)).toBe(false);
    expect(isRecoverableInfrastructureError(null)).toBe(false);
  });
});

describe('worker-runner IPC reporting', () => {
  it('streams test-end messages before file-done', async () => {
    const beforeListeners = process.listeners('message');
    const originalSend = process.send;
    const messages: WorkerToMainMessage[] = [];
    const waiters: Array<{
      predicate: (msg: WorkerToMainMessage) => boolean
      resolve: (msg: WorkerToMainMessage) => void
    }> = [];
    const waitForMessage = (predicate: (msg: WorkerToMainMessage) => boolean): Promise<WorkerToMainMessage> => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      });
    };
    const send = vi.fn((msg: WorkerToMainMessage) => {
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          const [waiter] = waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
      return true;
    });

    Object.defineProperty(process, 'send', { configurable: true, value: send });

    try {
      const streamedResult: TestResult = {
        name: 'streams',
        fullName: 'streams',
        status: 'passed',
        durationMs: 1,
      };
      workerRunnerMocks.runTestFile.mockImplementation(async (
        _filePath: string,
        opts: RunOptions,
      ): Promise<SuiteResult> => {
        opts.reporter?.onTestEnd?.(streamedResult);
        return { name: '', tests: [streamedResult], suites: [], durationMs: 1 };
      });

      await import('../worker-runner.js');
      const workerMessageListeners = process.listeners('message')
        .filter((listener) => !beforeListeners.includes(listener));
      expect(workerMessageListeners).toHaveLength(1);
      const emitWorkerMessage = (msg: MainToWorkerMessage): void => {
        (workerMessageListeners[0] as (message: MainToWorkerMessage) => void)(msg);
      };

      const ready = waitForMessage((msg) => msg.type === 'ready');
      emitWorkerMessage({
        type: 'init',
        workerId: 0,
        deviceSerial: 'device-1',
        deviceName: 'device-1',
        daemonPort: 19_000,
        config: makeSerializedConfig({ package: 'com.example.app' }),
        forceInstall: false,
      } satisfies MainToWorkerMessage);
      await ready;

      expect(sessionPreflightMocks.launchConfiguredApp).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        'worker startup launch',
        // The app was already installed (nothing installed, nothing cleared),
        // so the startup launch must not claim a fresh-install state.
        { freshInstall: false },
      );

      const done = waitForMessage((msg) => msg.type === 'file-done');
      emitWorkerMessage({
        type: 'run-file',
        filePath: '/tmp/streaming.test.ts',
      } satisfies MainToWorkerMessage);
      const fileDone = await done;

      const testEndIndex = messages.findIndex((msg) => msg.type === 'test-end');
      const fileDoneIndex = messages.findIndex((msg) => msg.type === 'file-done');
      expect(testEndIndex).toBeGreaterThan(-1);
      expect(fileDoneIndex).toBeGreaterThan(-1);
      expect(testEndIndex).toBeLessThan(fileDoneIndex);
      expect(fileDone).not.toHaveProperty('testEvents');
    } finally {
      for (const listener of process.listeners('message')) {
        if (!beforeListeners.includes(listener)) {
          process.removeListener('message', listener);
        }
      }
      if (originalSend) {
        Object.defineProperty(process, 'send', { configurable: true, value: originalSend });
      } else {
        Reflect.deleteProperty(process, 'send');
      }
      workerRunnerMocks.runTestFile.mockReset();
      workerRunnerMocks.collectResults.mockClear();
      sessionPreflightMocks.launchConfiguredApp.mockClear();
      sessionPreflightMocks.ensureSessionReady.mockClear();
    }
  });
});

// `--force-install` never reached parallel workers: the dispatcher's init
// message had no field for it, so `--workers 4 --force-install` kept every
// matching build (PILOT-261).
describe('worker-runner init', () => {
  async function initWorker(forceInstall: boolean): Promise<ReturnType<typeof vi.fn>> {
    vi.resetModules();
    const beforeListeners = process.listeners('message');
    const originalSend = process.send;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: vi.fn((msg: WorkerToMainMessage) => {
        if (msg.type === 'ready') resolveReady();
        return true;
      }),
    });
    try {
      await import('../worker-runner.js');
      const { Device } = await import('../device.js');
      const listener = process.listeners('message').find((l) => !beforeListeners.includes(l)) as (m: MainToWorkerMessage) => void;
      listener({
        type: 'init',
        workerId: 0,
        deviceSerial: 'device-1',
        deviceName: 'device-1',
        daemonPort: 19_000,
        config: makeSerializedConfig({ package: 'com.example.app', apk: 'app.apk' }),
        forceInstall,
      } satisfies MainToWorkerMessage);
      await ready;
      // The mocked module outlives resetModules: this init's Device is the latest.
      const device = vi.mocked(Device).mock.results.at(-1)!.value as { installApk: ReturnType<typeof vi.fn> };
      return device.installApk;
    } finally {
      for (const listener of process.listeners('message')) {
        if (!beforeListeners.includes(listener)) process.removeListener('message', listener);
      }
      if (originalSend) Object.defineProperty(process, 'send', { configurable: true, value: originalSend });
      else Reflect.deleteProperty(process, 'send');
      sessionPreflightMocks.launchConfiguredApp.mockClear();
      sessionPreflightMocks.ensureSessionReady.mockClear();
    }
  }

  it('reinstalls a matching build when told to force the install', async () => {
    const installApk = await initWorker(true);
    expect(installApk).toHaveBeenCalledWith('/tmp/app.apk');
  });

  it('keeps a matching build otherwise', async () => {
    const installApk = await initWorker(false);
    expect(installApk).not.toHaveBeenCalled();
  });
});
