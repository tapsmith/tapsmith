import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PreparedState } from '../app-reset.js';
import type { DeviceSession } from '../device-session.js';
import type { UIWorkerChildMessage, UIWorkerMessage } from '../ui-mode/ui-protocol.js';

// The UI worker's per-session prepared records (PILOT-1195). The server
// invalidates its readiness claim when the mirror or an MCP tool touches the
// device, but the run consumes the worker's own record — so the worker has to
// forget it too, or the next background preparation finds "nothing to do" and
// the run reports a reset that never happened.

const mocks = vi.hoisted(() => ({
  sessions: [] as DeviceSession[],
  executeAppReset: vi.fn(async (_ctx: unknown, _policy: unknown, _opts?: unknown) => ({ steps: [] as unknown[], satisfiedBy: undefined })),
}));

vi.mock('../device-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-session.js')>();
  return { ...actual, openDeviceGroup: vi.fn(async () => mocks.sessions) };
});
vi.mock('../session-preflight.js', () => ({
  ensureSessionReady: vi.fn(async () => {}),
  executeAppReset: mocks.executeAppReset,
}));
vi.mock('../worker-protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-protocol.js')>();
  return { ...actual, configFromSerialized: () => ({ trace: 'on' }) };
});
vi.mock('../action-progress-renderer.js', () => ({ createActionProgressMessenger: () => () => {} }));
vi.mock('../device-claims.js', () => ({ currentSession: () => ({ id: 'test', pid: process.pid }) }));

const CLEAR = { mode: 'clear', scope: 'file' } as const;
const sent: UIWorkerChildMessage[] = [];
let deliver: (msg: UIWorkerMessage) => void;
const realSend = process.send;

beforeAll(async () => {
  // Capture the worker's messages; pass anything else (the test runner's own
  // IPC, under the forks pool) through untouched.
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

function fakeSession(name: string, prepared?: PreparedState): DeviceSession {
  return {
    name,
    serial: name,
    device: { wake: vi.fn(async () => {}), unlock: vi.fn(async () => {}), tracing: {} },
    client: { _setAbortSignal: vi.fn() },
    context: { name },
    capabilities: {},
    prepared,
  } as unknown as DeviceSession;
}

const startupClaim = (): PreparedState => ({ policy: CLEAR, preparedAt: 1_000, durationMs: 0, source: 'startup launch' });

async function init(sessions: DeviceSession[]): Promise<void> {
  mocks.sessions = sessions;
  const readyBefore = sent.filter((m) => m.type === 'ready').length;
  deliver({
    type: 'init',
    workerId: 0,
    deviceSerial: sessions[0].serial,
    deviceName: sessions[0].name,
    daemonPort: 50051,
    config: {} as never,
    adoptPrimary: true,
    adoptPrepared: true,
    forceInstall: false,
    networkApisInRun: false,
  });
  await vi.waitFor(() => expect(sent.filter((m) => m.type === 'ready').length).toBe(readyBefore + 1));
}

let prepareSeq = 0;
function prepare(devices?: number): string {
  const prepareId = `p-${++prepareSeq}`;
  deliver({ type: 'prepare', prepareId, policy: CLEAR, projectUseOptions: devices ? { devices } as never : undefined });
  return prepareId;
}

async function settled(prepareId: string): Promise<void> {
  await vi.waitFor(() => expect(sent.some((m) => (m.type === 'prepared' || m.type === 'prepare-failed') && m.prepareId === prepareId)).toBe(true));
}

beforeEach(() => {
  mocks.executeAppReset.mockClear();
  mocks.executeAppReset.mockImplementation(async () => ({ steps: [], satisfiedBy: undefined }));
});

describe('ui-worker prepared records', () => {
  it('a preparation skips a device whose record still satisfies the policy (control)', async () => {
    const s = fakeSession('alice', startupClaim());
    await init([s]);
    const id = prepare();
    await settled(id);
    expect(mocks.executeAppReset).not.toHaveBeenCalled();
    expect(s.prepared?.source).toBe('startup launch');
  });

  it('after the device is touched, the next preparation really resets it', async () => {
    const s = fakeSession('alice', startupClaim());
    await init([s]);
    deliver({ type: 'invalidate-prepared' });
    const id = prepare();
    await settled(id);
    expect(mocks.executeAppReset).toHaveBeenCalledTimes(1);
    expect(s.prepared?.source).toBe('background preparation');
    expect(s.prepared!.preparedAt).toBeGreaterThan(1_000);
  });

  it('forgets the record a preparation sets after a touch that arrived while it ran', async () => {
    const s = fakeSession('alice');
    await init([s]);
    let release!: () => void;
    mocks.executeAppReset.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ steps: [], satisfiedBy: undefined });
    }));
    const id = prepare();
    await vi.waitFor(() => expect(mocks.executeAppReset).toHaveBeenCalledTimes(1));
    // The gesture lands mid-reset; the server also cancels, but a reset that
    // already finished on the device sets its record regardless.
    deliver({ type: 'invalidate-prepared' });
    release();
    await settled(id);
    await vi.waitFor(() => expect(s.prepared).toBeUndefined());
  });

  it('forgets every device of the group', async () => {
    const a = fakeSession('alice', startupClaim());
    const b = fakeSession('bob', startupClaim());
    await init([a, b]);
    deliver({ type: 'invalidate-prepared' });
    const id = prepare(2);
    await settled(id);
    expect(mocks.executeAppReset).toHaveBeenCalledTimes(2);
    expect(a.prepared?.source).toBe('background preparation');
    expect(b.prepared?.source).toBe('background preparation');
  });
});
