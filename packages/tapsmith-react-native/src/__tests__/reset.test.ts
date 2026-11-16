import { describe, expect, it, vi } from 'vitest';
import { registerTapsmithReset, registeredHandlers, runResetPipeline } from '../reset.js';
import { hooksEnabledByDefault } from '../enabled.js';

describe('reset pipeline', () => {
  it('clears stores (clear or clearAll) before running handlers, in order', async () => {
    const order: string[] = [];
    const asyncStorage = { clear: vi.fn(async () => { order.push('async'); }) };
    const mmkv = { clearAll: vi.fn(() => { order.push('mmkv'); }) };
    const handler = vi.fn(async (req: { target: string }) => { order.push(`handler:${req.target}`); });

    await runResetPipeline({ target: '/login', nonce: 'n' }, [asyncStorage, mmkv], [handler]);

    expect(order).toEqual(['async', 'mmkv', 'handler:/login']);
  });

  it('propagates the first failure', async () => {
    const boom = { clear: vi.fn(async () => { throw new Error('boom'); }) };
    const handler = vi.fn();
    await expect(runResetPipeline({ target: '/', nonce: '' }, [boom], [handler])).rejects.toThrow('boom');
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps persisted data on a keep request: no clear, no reset handlers, only the reload', async () => {
    const order: string[] = [];
    const store = { clear: vi.fn(async () => { order.push('clear'); }) };
    const handler = vi.fn(async () => { order.push('reset'); });
    const reload = vi.fn(async (req: { target: string }) => { order.push(`reload:${req.target}`); });
    const settle = vi.fn(async () => { order.push('settle'); return true; });

    await runResetPipeline({ target: '/profile', nonce: 'n', keepData: true }, [store], [handler], settle, reload);

    expect(order).toEqual(['settle', 'reload:/profile']);
  });

  it('fails a keep request the app has no reload handler for, without touching its data', async () => {
    const store = { clear: vi.fn() };
    const handler = vi.fn();
    await expect(runResetPipeline({ target: '/', nonce: '', keepData: true }, [store], [handler]))
      .rejects.toThrow(/onReload/);
    expect(store.clear).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores the reload handler on an ordinary reset', async () => {
    const reload = vi.fn();
    const handler = vi.fn();
    await runResetPipeline({ target: '/', nonce: '' }, [], [handler], undefined, reload);
    expect(handler).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('registerTapsmithReset adds and removes handlers', () => {
    const h = vi.fn();
    const off = registerTapsmithReset(h);
    expect(registeredHandlers()).toContain(h);
    off();
    expect(registeredHandlers()).not.toContain(h);
  });
});

describe('enabled gate', () => {
  it('follows __DEV__ and the build-time flag', () => {
    const g = globalThis as { __DEV__?: boolean; process?: { env?: Record<string, string | undefined> } };
    const savedDev = g.__DEV__;
    const savedEnv = g.process?.env?.EXPO_PUBLIC_TAPSMITH_HOOKS;
    try {
      g.__DEV__ = false;
      if (g.process?.env) delete g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS;
      expect(hooksEnabledByDefault()).toBe(false);
      g.__DEV__ = true;
      expect(hooksEnabledByDefault()).toBe(true);
      g.__DEV__ = false;
      if (g.process?.env) g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS = '1';
      expect(hooksEnabledByDefault()).toBe(true);
    } finally {
      g.__DEV__ = savedDev;
      if (g.process?.env) {
        if (savedEnv === undefined) delete g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS;
        else g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS = savedEnv;
      }
    }
  });
});

describe('reset pipeline with a blur to settle (keyboard dismissal)', () => {
  it('starts the clear at once, ahead of the blur, then clears again once a focused input has blurred', async () => {
    const order: string[] = [];
    const store = { clear: vi.fn(async () => { order.push('clear'); }) };
    const handler = vi.fn(async () => { order.push('handler'); });
    // The clear is issued in the same tick as the reset link, so a screen the
    // link mounts reads cleared storage; the blur's onBlur write-back lands
    // during the settle and the second clear removes it.
    const settle = vi.fn(async () => {
      order.push('settle:start');
      await new Promise<void>((r) => { setTimeout(r, 5); });
      order.push('onBlur write');
      return true;
    });

    const run = runResetPipeline({ target: '/', nonce: 'n' }, [store], [handler], settle);
    expect(order).toEqual(['clear', 'settle:start']);
    await run;

    expect(order).toEqual(['clear', 'settle:start', 'onBlur write', 'clear', 'handler']);
  });

  it('clears once when no input had focus', async () => {
    const store = { clear: vi.fn(async () => undefined) };
    await runResetPipeline({ target: '/', nonce: 'n' }, [store], [], async () => false);
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('a failing settle does not fail the reset', async () => {
    const store = { clear: vi.fn(async () => undefined) };
    const handler = vi.fn();
    await runResetPipeline({ target: '/', nonce: 'n' }, [store], [handler], async () => { throw new Error('keyboard'); });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
