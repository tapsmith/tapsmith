import { describe, it, expect } from 'vitest';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { _text, selectorToProto } from '../selectors.js';

// PILOT-998: one scrollIntoView() step is one ScrollStep call, carrying the
// selector beside the drag's direction, distance and (when known) region.

function clientCapturing(capture: { request?: Record<string, unknown> }, response: unknown): TapsmithGrpcClient {
  const client = new TapsmithGrpcClient('localhost:1');
  const fake = (req: Record<string, unknown>, _opts: unknown, cb: (err: null, res: unknown) => void) => {
    capture.request = req;
    cb(null, response);
    return { cancel: () => {} };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swap the private proto-loaded client for a fake
  (client as any).client = { scrollStep: fake };
  return client;
}

const answer = { requestId: 'r', elements: [], errorMessage: '', moved: 'MOVED_YES', swiped: true, unsupported: false };

describe('scrollStep', () => {
  it('sends the selector, the read budget and the drag', async () => {
    const capture: { request?: Record<string, unknown> } = {};
    const client = clientCapturing(capture, answer);
    const region = { left: 0, top: 100, right: 400, bottom: 900 };
    const res = await client.scrollStep(_text('Row 60'), 250, { direction: 'up', distance: 0.8, region, findFirst: true });

    expect(capture.request).toMatchObject({
      selector: selectorToProto(_text('Row 60')),
      timeoutMs: 250,
      direction: 'up',
      distance: 0.8,
      region,
      findFirst: true,
    });
    expect(res).toEqual(answer);
  });

  it('leaves out a region and findFirst it was not given', async () => {
    const capture: { request?: Record<string, unknown> } = {};
    const client = clientCapturing(capture, answer);
    await client.scrollStep(_text('Row 60'), 250, { direction: 'down', distance: 0.3 });

    expect(capture.request).not.toHaveProperty('region');
    expect(capture.request).not.toHaveProperty('findFirst');
  });
});
