import { describe, it, expect } from 'vitest';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { _text, _role, selectorToProto, withParent } from '../selectors.js';

// PILOT-848: one batch RPC evaluates every candidate selector against the same
// UI snapshot, so the request must carry them all, in order, as proto selectors.

function clientCapturing(capture: { request?: Record<string, unknown> }, response: unknown): TapsmithGrpcClient {
  const client = new TapsmithGrpcClient('localhost:1');
  const fake = (req: Record<string, unknown>, _opts: unknown, cb: (err: null, res: unknown) => void) => {
    capture.request = req;
    cb(null, response);
    return { cancel: () => {} };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swap the private proto-loaded client for a fake
  (client as any).client = { evaluateSelectors: fake };
  return client;
}

describe('evaluateSelectors', () => {
  it('sends every selector, in order, and returns one result per selector', async () => {
    const capture: { request?: Record<string, unknown> } = {};
    const results = [
      { elements: [{ text: 'Login' }], errorMessage: '' },
      { elements: [], errorMessage: 'Invalid regex' },
    ];
    const client = clientCapturing(capture, { requestId: 'r', results, errorMessage: '' });
    const res = await client.evaluateSelectors([_text('Login'), _role('button', { name: 'Go' })]);

    expect(capture.request?.selectors).toEqual([
      selectorToProto(_text('Login')),
      selectorToProto(_role('button', { name: 'Go' })),
    ]);
    expect(typeof capture.request?.requestId).toBe('string');
    expect(res.results).toEqual(results);
  });

  it('refuses a scoped selector instead of evaluating it unscoped', async () => {
    // Agents scope a find by a resolved parent element id, not by a nested
    // parent selector: sent as is, the parent would be silently ignored and
    // the count would be the unscoped one.
    const capture: { request?: Record<string, unknown> } = {};
    const client = clientCapturing(capture, { requestId: 'r', results: [], errorMessage: '' });
    await expect(client.evaluateSelectors([withParent(_text('Save'), _role('list'))]))
      .rejects.toThrow(/scoped/);
    expect(capture.request).toBeUndefined();
  });
});
