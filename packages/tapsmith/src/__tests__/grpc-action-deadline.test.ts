import { describe, it, expect } from 'vitest';
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
