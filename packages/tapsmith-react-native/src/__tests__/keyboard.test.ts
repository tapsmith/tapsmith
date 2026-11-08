import { afterEach, describe, expect, it, vi } from 'vitest';
import { blurFocusedInput, type KeyboardDeps } from '../keyboard.js';

function fakeKeyboard(opts: { focused: boolean; visible: boolean; hideAfterMs?: number }) {
  const listeners = new Set<() => void>();
  const order: string[] = [];
  const deps: KeyboardDeps = {
    focusedInput: () => (opts.focused ? {} : null),
    isVisible: () => opts.visible,
    dismiss: () => {
      order.push('dismiss');
      // The input's onBlur arrives from native a moment after the dismiss.
      setTimeout(() => order.push('onBlur'), 10);
      if (opts.hideAfterMs !== undefined) setTimeout(() => { for (const l of [...listeners]) l(); }, opts.hideAfterMs);
    },
    onDidHide: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return { deps, order, listeners };
}

describe('blurFocusedInput', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lets a focused input\'s onBlur run before returning, so it cannot land after the reset clears storage', async () => {
    const { deps, order, listeners } = fakeKeyboard({ focused: true, visible: true, hideAfterMs: 50 });
    await blurFocusedInput(deps);
    order.push('clear');
    expect(order).toEqual(['dismiss', 'onBlur', 'clear']);
    expect(listeners.size).toBe(0);
  });

  it('is bounded when the keyboard never reports hiding', async () => {
    vi.useFakeTimers();
    const { deps, order, listeners } = fakeKeyboard({ focused: true, visible: true });
    let done = false;
    void blurFocusedInput(deps).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(done).toBe(true);
    expect(order).toEqual(['dismiss', 'onBlur']);
    expect(listeners.size).toBe(0);
  });

  it('waits out the blur for a focused input with no on-screen keyboard (hardware keyboard)', async () => {
    const { deps, order } = fakeKeyboard({ focused: true, visible: false });
    await blurFocusedInput(deps);
    order.push('clear');
    expect(order).toEqual(['dismiss', 'onBlur', 'clear']);
  });

  it('costs nothing when no input has focus', async () => {
    vi.useFakeTimers();
    const { deps, order } = fakeKeyboard({ focused: false, visible: false });
    let done = false;
    void blurFocusedInput(deps).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(order).toEqual(['dismiss']);
  });
});
