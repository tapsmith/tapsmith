import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { BuildCheckOutcome, DeviceSession } from '../device-session.js';
import type { UIWorkerChildMessage, UIWorkerMessage } from '../ui-mode/ui-protocol.js';

// PILOT-1397: a UI worker outlives many runs on a device the CLI set up, so
// before each file it re-checks the configured build and reinstalls a
// rebuilt app — and tells the server, for Device activity and the terminal.

const mocks = vi.hoisted(() => ({
  sessions: [] as DeviceSession[],
  order: [] as string[],
  outcome: { reinstalled: false } as BuildCheckOutcome,
  reinstallChangedBuild: vi.fn(),
  runTestFile: vi.fn(),
}));

vi.mock('../device-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-session.js')>();
  return {
    ...actual,
    openDeviceGroup: vi.fn(async () => mocks.sessions),
    reinstallChangedBuild: mocks.reinstallChangedBuild,
  };
});
vi.mock('../runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runner.js')>()),
  runTestFile: mocks.runTestFile,
}));
vi.mock('../session-preflight.js', () => ({
  ensureSessionReady: vi.fn(async () => {}),
  executeAppReset: vi.fn(async () => ({ steps: [], satisfiedBy: undefined })),
}));
vi.mock('../worker-protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-protocol.js')>();
  return { ...actual, configFromSerialized: () => ({ trace: 'on' }) };
});
vi.mock('../action-progress-renderer.js', () => ({ createActionProgressMessenger: () => () => {} }));
vi.mock('../device-claims.js', () => ({ currentSession: () => ({ id: 'test', pid: process.pid }) }));
vi.mock('../telemetry.js', () => ({ telemetry: { flush: vi.fn(async () => {}), recordRun: vi.fn() } }));

const sent: UIWorkerChildMessage[] = [];
let deliver: (msg: UIWorkerMessage) => void;
const realSend = process.send;

beforeAll(async () => {
  process.send = ((msg: unknown, ...rest: unknown[]) => {
    if (msg && typeof msg === 'object' && 'workerId' in msg) {
      sent.push(msg as UIWorkerChildMessage);
      return true;
    }
    return realSend ? (realSend as (...a: unknown[]) => boolean).call(process, msg, ...rest) : false;
  }) as typeof process.send;
  const before = new Set(process.listeners('message'));
  await import('../ui-mode/ui-worker.js');
  const listener = process.listeners('message').find((l) => !before.has(l));
  if (!listener) throw new Error('ui-worker registered no message listener');
  deliver = listener as (msg: UIWorkerMessage) => void;
});

afterAll(() => {
  process.send = realSend;
});

function fakeSession(name: string): DeviceSession {
  return {
    name,
    serial: name,
    device: {
      wake: vi.fn(async () => { mocks.order.push(`wake ${name}`); }),
      unlock: vi.fn(async () => {}),
      tracing: { _startManaged: vi.fn() },
    },
    client: { _setAbortSignal: vi.fn() },
    context: { name, notices: [] },
    capabilities: {},
  } as unknown as DeviceSession;
}

async function init(sessions: DeviceSession[]): Promise<void> {
  mocks.sessions = sessions;
  const readyBefore = sent.filter((m) => m.type === 'ready').length;
  deliver({
    type: 'init', workerId: 0, deviceSerial: sessions[0].serial, deviceName: sessions[0].name, daemonPort: 50051,
    config: {} as never, adoptPrimary: true, adoptPrepared: true, forceInstall: false, networkApisInRun: false,
  });
  await vi.waitFor(() => expect(sent.filter((m) => m.type === 'ready').length).toBe(readyBefore + 1));
}

async function runFile(): Promise<void> {
  const doneBefore = sent.filter((m) => m.type === 'file-done' || m.type === 'error').length;
  deliver({
    type: 'run-file', filePath: '/proj/tests/todos.test.ts', networkApisInRun: false,
    grep: { grep: [], grepInvert: [], projectGrep: [], projectGrepInvert: [] },
  });
  await vi.waitFor(() => expect(sent.filter((m) => m.type === 'file-done' || m.type === 'error').length).toBe(doneBefore + 1));
}

beforeEach(() => {
  sent.length = 0;
  mocks.order.length = 0;
  mocks.outcome = { reinstalled: false };
  mocks.reinstallChangedBuild.mockReset();
  mocks.reinstallChangedBuild.mockImplementation(async (s: DeviceSession) => {
    mocks.order.push(`check ${s.serial}`);
    return mocks.outcome;
  });
  mocks.runTestFile.mockReset();
  mocks.runTestFile.mockImplementation(async () => {
    mocks.order.push('run');
    return { name: '', tests: [], suites: [], durationMs: 0 };
  });
});

describe('ui-worker build check before each run', () => {
  it('checks the build of the device a file runs on, after waking it and before the run', async () => {
    const s = fakeSession('emulator-5554');
    await init([s]);
    await runFile();
    expect(mocks.order).toEqual(['wake emulator-5554', 'check emulator-5554', 'run']);
    expect(sent.some((m) => m.type === 'app-reinstalled')).toBe(false);
  });

  it('tells the server when it reinstalled a rebuilt app', async () => {
    const s = fakeSession('emulator-5554');
    await init([s]);
    mocks.outcome = { reinstalled: true, message: 'Reinstalled app-release.apk (build changed since the last run)', durationMs: 4_000 };
    await runFile();
    expect(sent.find((m) => m.type === 'app-reinstalled')).toMatchObject({
      type: 'app-reinstalled', workerId: 0, deviceSerial: 'emulator-5554',
      message: 'Reinstalled app-release.apk (build changed since the last run)', durationMs: 4_000,
    });
  });

  it('fails the file with the check\'s error, without running it', async () => {
    const s = fakeSession('emulator-5554');
    await init([s]);
    mocks.reinstallChangedBuild.mockRejectedValueOnce(new Error('App APK not found at /proj/app.apk'));
    await runFile();
    expect(mocks.runTestFile).not.toHaveBeenCalled();
    expect(sent.find((m) => m.type === 'error')).toMatchObject({ error: { message: expect.stringContaining('App APK not found') } });
  });
});
