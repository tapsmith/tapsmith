import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { TestAbortedError, isAbortError, sleep, throwIfAborted } from '../abort.js';
import { runInAttemptContext, isTestEndedError } from '../attempt-fence.js';

// ─── Abort primitives ───

describe('abort primitives', () => {
  it('isAbortError matches TestAbortedError via brand, not instanceof', () => {
    const err = new TestAbortedError();
    expect(isAbortError(err)).toBe(true);
    expect(err.message).toBe('Stopped by user');
    expect(err.name).toBe('AbortError');
    expect(isAbortError(new Error('Stopped by user'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('throwIfAborted throws only when the signal has fired', () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    ac.abort();
    expect(() => throwIfAborted(ac.signal)).toThrow(TestAbortedError);
  });

  it('sleep resolves normally without a signal', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it('sleep rejects with a branded AbortError when the signal fires mid-sleep', async () => {
    const ac = new AbortController();
    const p = sleep(60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('sleep rejects immediately on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(60_000, ac.signal)).rejects.toSatisfy(isAbortError);
  });

  it('sleep removes its abort listener after a natural completion', async () => {
    const ac = new AbortController();
    await sleep(1, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});

// ─── gRPC call cancellation (PILOT-222) ───

type UnaryCallback = (err: Error | null, response?: unknown) => void;
type FakeMethod = (req: unknown, opts: unknown, cb: UnaryCallback) => { cancel: () => void };

function makeClient(fakeMethod: FakeMethod): TapsmithGrpcClient {
  const client = new TapsmithGrpcClient('localhost:1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swap the private proto-loaded client for a fake
  (client as any).client = { fakeMethod };
  return client;
}

function invokeCall(
  client: TapsmithGrpcClient,
  deadlineMs?: number,
  opts?: { bypassAbort?: boolean },
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercise the private unary-call wrapper directly
  return (client as any).call('fakeMethod', {}, deadlineMs, opts);
}

describe('TapsmithGrpcClient attempt fence', () => {
  it('rejects a call from a closed attempt context without dispatching', async () => {
    const fakeMethod = vi.fn();
    const client = makeClient(fakeMethod as unknown as FakeMethod);

    const token = { closed: false };
    const zombieCall = runInAttemptContext(token, async () => {
      token.closed = true; // attempt ends while the body is still running
      return invokeCall(client);
    });

    await expect(zombieCall).rejects.toSatisfy(isTestEndedError);
    expect(fakeMethod).not.toHaveBeenCalled();
  });

  it('dispatches normally from an open attempt context', async () => {
    const client = makeClient((_req, _opts, cb) => {
      cb(null, { ok: true });
      return { cancel: vi.fn() };
    });
    const token = { closed: false };
    await expect(
      runInAttemptContext(token, async () => invokeCall(client)),
    ).resolves.toEqual({ ok: true });
  });

  it('dispatches normally outside any attempt context', async () => {
    const client = makeClient((_req, _opts, cb) => {
      cb(null, { ok: true });
      return { cancel: vi.fn() };
    });
    await expect(invokeCall(client)).resolves.toEqual({ ok: true });
  });
});

describe('TapsmithGrpcClient abort signal', () => {
  it('cancels the in-flight call and rejects with a branded AbortError', async () => {
    let savedCb: UnaryCallback | undefined;
    const cancel = vi.fn(() => {
      // Mirror @grpc/grpc-js: cancel surfaces as a CANCELLED callback error.
      savedCb?.(Object.assign(new Error('1 CANCELLED: Cancelled on client'), { code: 1 }));
    });
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client);
    ac.abort();

    await expect(p).rejects.toSatisfy(isAbortError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when the signal is already aborted, without dispatching', async () => {
    const fakeMethod = vi.fn();
    const client = makeClient(fakeMethod as unknown as FakeMethod);

    const ac = new AbortController();
    ac.abort();
    client._setAbortSignal(ac.signal);

    await expect(invokeCall(client)).rejects.toSatisfy(isAbortError);
    expect(fakeMethod).not.toHaveBeenCalled();
  });

  it('rejects even when a successful response wins the race against cancel()', async () => {
    let savedCb: UnaryCallback | undefined;
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel: vi.fn() }; // cancel does nothing — response arrives anyway
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client);
    ac.abort();
    savedCb?.(null, { ok: true });

    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('normalizes any post-abort error to AbortError', async () => {
    let savedCb: UnaryCallback | undefined;
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client);
    ac.abort();
    // The transport reports an unrelated-looking error after cancellation.
    savedCb?.(Object.assign(new Error('14 UNAVAILABLE: connection dropped'), { code: 14 }));

    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('removes the abort listener once the call settles normally', async () => {
    const client = makeClient((_req, _opts, cb) => {
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    for (let i = 0; i < 5; i++) {
      await invokeCall(client);
    }
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('handles a callback that fires synchronously (no TDZ on the abort listener)', async () => {
    const client = makeClient((_req, _opts, cb) => {
      cb(null, { ok: true }); // settles before the method even returns
      return { cancel: vi.fn() };
    });
    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    await expect(invokeCall(client)).resolves.toEqual({ ok: true });
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('does not interfere with calls when no signal is set', async () => {
    const client = makeClient((_req, _opts, cb) => {
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });
    await expect(invokeCall(client)).resolves.toEqual({ ok: true });
  });
});

// ─── Cleanup RPCs bypass the abort signal (PILOT-235) ───

describe('TapsmithGrpcClient bypassAbort', () => {
  it('dispatches and resolves normally on an already-aborted signal', async () => {
    const fakeMethod = vi.fn((_req: unknown, _opts: unknown, cb: UnaryCallback) => {
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });
    const client = makeClient(fakeMethod);

    const ac = new AbortController();
    ac.abort();
    client._setAbortSignal(ac.signal);

    await expect(invokeCall(client, 60_000, { bypassAbort: true })).resolves.toEqual({ ok: true });
    expect(fakeMethod).toHaveBeenCalledTimes(1);
  });

  it('clamps the deadline when dispatched after the abort', async () => {
    let capturedDeadline: Date | undefined;
    const client = makeClient((_req, opts, cb) => {
      capturedDeadline = (opts as { deadline: Date }).deadline;
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    ac.abort();
    client._setAbortSignal(ac.signal);

    const before = Date.now();
    await invokeCall(client, 60_000, { bypassAbort: true });
    // 4s clamp (ABORTED_CLEANUP_DEADLINE_MS), not the requested 60s — must
    // stay under the UI server's 5s SIGKILL escalation grace.
    expect(capturedDeadline!.getTime() - before).toBeLessThanOrEqual(4_100);
    expect(capturedDeadline!.getTime() - before).toBeGreaterThan(3_000);
  });

  it('keeps the requested deadline when dispatched before any abort', async () => {
    let capturedDeadline: Date | undefined;
    const client = makeClient((_req, opts, cb) => {
      capturedDeadline = (opts as { deadline: Date }).deadline;
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);

    const before = Date.now();
    await invokeCall(client, 60_000, { bypassAbort: true });
    expect(capturedDeadline!.getTime() - before).toBeGreaterThan(50_000);
  });

  it('is not cancelled and still resolves when the abort fires mid-flight', async () => {
    let savedCb: UnaryCallback | undefined;
    const cancel = vi.fn();
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client, 60_000, { bypassAbort: true });
    ac.abort();
    savedCb?.(null, { ok: true });

    await expect(p).resolves.toEqual({ ok: true });
    expect(cancel).not.toHaveBeenCalled();
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('surfaces real errors instead of normalizing them post-abort', async () => {
    let savedCb: UnaryCallback | undefined;
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    ac.abort();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client, 60_000, { bypassAbort: true });
    savedCb?.(Object.assign(new Error('4 DEADLINE_EXCEEDED: Deadline exceeded'), { code: 4 }));

    await expect(p).rejects.toThrow('DEADLINE_EXCEEDED');
    await expect(p).rejects.not.toSatisfy(isAbortError);
  });
});

// ─── Capture start hold (PILOT-775) ───

describe('TapsmithGrpcClient holds RPCs for an on-demand capture start', () => {
  it('sends a call made while the start is in flight only once it settles', async () => {
    const fakeMethod = vi.fn((_req: unknown, _opts: unknown, cb: UnaryCallback) => {
      cb(null, { ok: true });
      return { cancel: vi.fn() };
    });
    const client = makeClient(fakeMethod as unknown as FakeMethod);
    let finishStart = (): void => {};
    client._holdForCaptureStart(new Promise<void>((resolve) => { finishStart = resolve; }));

    // e.g. the tap() after `const p = device.waitForRequest(...)` on a cold device
    const call = invokeCall(client);
    await new Promise((r) => setTimeout(r, 5));
    expect(fakeMethod).not.toHaveBeenCalled();

    finishStart();
    await expect(call).resolves.toEqual({ ok: true });
    expect(fakeMethod).toHaveBeenCalledTimes(1);

    // Released: later calls go straight through.
    await invokeCall(client);
    expect(fakeMethod).toHaveBeenCalledTimes(2);
  });
});
