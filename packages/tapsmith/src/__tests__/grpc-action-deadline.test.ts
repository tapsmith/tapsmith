import { describe, it, expect, afterEach, vi } from 'vitest';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { _text } from '../selectors.js';

// PILOT-223: element actions can now block on the agent for their whole action
// timeout (waiting out a covered target), so the gRPC deadline must outlast
// it — or a long timeout fails early with DEADLINE_EXCEEDED while the agent
// keeps waiting and taps later, in the middle of the next step.

type Capture = { deadlineMs?: number };

function clientCapturing(method: string, capture: Capture): TapsmithGrpcClient {
  const client = new TapsmithGrpcClient('localhost:1');
  const fake = (_req: unknown, opts: { deadline: Date }, cb: (err: null, res: unknown) => void) => {
    capture.deadlineMs = opts.deadline.getTime() - Date.now();
    cb(null, { success: true });
    return { cancel: () => {} };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swap the private proto-loaded client for a fake
  (client as any).client = { [method]: fake };
  return client;
}

const sel = _text('Submit');
const calls: Array<[string, (c: TapsmithGrpcClient, timeoutMs: number) => Promise<unknown>]> = [
  ['tap', (c, t) => c.tap(sel, t)],
  ['longPress', (c, t) => c.longPress(sel, 500, t)],
  ['doubleTap', (c, t) => c.doubleTap(sel, t)],
  ['typeText', (c, t) => c.typeText(sel, 'x', t)],
  ['clearText', (c, t) => c.clearText(sel, t)],
  ['clearAndType', (c, t) => c.clearAndType(sel, 'x', t)],
  ['focus', (c, t) => c.focus(sel, t)],
];

describe('element action gRPC deadlines', () => {
  for (const [method, invoke] of calls) {
    it(`${method}: outlasts a long action timeout`, async () => {
      const capture: Capture = {};
      await invoke(clientCapturing(method, capture), 90_000);
      expect(capture.deadlineMs).toBeGreaterThanOrEqual(119_000);
    });

    it(`${method}: keeps the 60 s default for short timeouts`, async () => {
      const capture: Capture = {};
      await invoke(clientCapturing(method, capture), 5_000);
      expect(capture.deadlineMs).toBeGreaterThan(59_000);
      expect(capture.deadlineMs).toBeLessThanOrEqual(60_000);
    });
  }
});

describe('gesture gRPC deadlines', () => {
  it('long press also outlasts the hold, which the daemon waits on top of the timeout', async () => {
    const capture: Capture = {};
    await clientCapturing('longPress', capture).longPress(sel, 60_000, 90_000);
    expect(capture.deadlineMs).toBeGreaterThanOrEqual(179_000);
  });

  it("a zero timeout counts as the daemon's 30 s default wait, plus the hold", async () => {
    const capture: Capture = {};
    await clientCapturing('longPress', capture).longPress(sel, 40_000, 0);
    // Daemon: 30 s + 40 s hold + 5 s headroom.
    expect(capture.deadlineMs).toBeGreaterThan(75_000);
  });

  it('double tap also outlasts its interval', async () => {
    const capture: Capture = {};
    await clientCapturing('doubleTap', capture).doubleTap(sel, 90_000, 30_000);
    expect(capture.deadlineMs).toBeGreaterThanOrEqual(149_000);
  });
});

describe('element action gRPC deadlines with a raised daemon read headroom', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('outlasts timeout + TAPSMITH_AGENT_READ_HEADROOM_MS, which the daemon adds', async () => {
    // The daemon (spawned with this process's environment) waits the action
    // timeout plus this headroom for the agent; a client deadline inside that
    // window would turn a late answer into DEADLINE_EXCEEDED.
    vi.stubEnv('TAPSMITH_AGENT_READ_HEADROOM_MS', '40000');
    const capture: Capture = {};
    await clientCapturing('tap', capture).tap(sel, 90_000);
    expect(capture.deadlineMs).toBeGreaterThan(130_000);
  });

  it('ignores an unparseable value, like the daemon does', async () => {
    vi.stubEnv('TAPSMITH_AGENT_READ_HEADROOM_MS', 'lots');
    const capture: Capture = {};
    await clientCapturing('tap', capture).tap(sel, 90_000);
    expect(capture.deadlineMs).toBeGreaterThanOrEqual(119_000);
    expect(capture.deadlineMs).toBeLessThanOrEqual(120_000);
  });
});
