import { afterEach, describe, expect, it, vi } from 'vitest';
import { blurFocusedInput, type KeyboardDeps } from '../keyboard.js';

function fakeKeyboard(opts: { focused: boolean; visible: boolean; hideAfterMs?: number; blurAfterMs?: number }) {
  const listeners = new Set<() => void>();
  const order: string[] = [];
  const deps: KeyboardDeps = {
    focusedInput: () => (opts.focused ? {} : null),
    isVisible: () => opts.visible,
    dismiss: () => {
      order.push('dismiss');
      // The input's onBlur arrives from native a moment after the dismiss.
      setTimeout(() => order.push('onBlur'), opts.blurAfterMs ?? 10);
      if (opts.hideAfterMs !== undefined) setTimeout(() => { for (const l of [...listeners]) l(); }, opts.hideAfterMs);
    },
    onDidHide: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return { deps, order, listeners };
}

describe('blurFocusedInput', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lets a focused input\'s onBlur run before returning true, so the reset\'s second clear comes after it', async () => {
    const { deps, order, listeners } = fakeKeyboard({ focused: true, visible: true, hideAfterMs: 50 });
    expect(await blurFocusedInput(deps)).toBe(true);
    order.push('clear');
    expect(order).toEqual(['dismiss', 'onBlur', 'clear']);
    expect(listeners.size).toBe(0);
  });

  // A reset link that navigates away hides the keyboard with the transition:
  // keyboardDidHide then arrives ~30-45 ms before the input's JS onBlur
  // (measured on an iOS 26.5 simulator).
  it('waits out an onBlur that arrives after keyboardDidHide', async () => {
    const { deps, order } = fakeKeyboard({ focused: true, visible: true, hideAfterMs: 20, blurAfterMs: 80 });
    expect(await blurFocusedInput(deps)).toBe(true);
    order.push('clear');
    expect(order).toEqual(['dismiss', 'onBlur', 'clear']);
  });

  it('is bounded when the keyboard never reports hiding', async () => {
    vi.useFakeTimers();
    const { deps, order, listeners } = fakeKeyboard({ focused: true, visible: true });
    let done = false;
    void blurFocusedInput(deps).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(done).toBe(true);
    expect(order).toEqual(['dismiss', 'onBlur']);
    expect(listeners.size).toBe(0);
  });

  it('waits out the blur for a focused input with no on-screen keyboard (hardware keyboard)', async () => {
    const { deps, order } = fakeKeyboard({ focused: true, visible: false });
    expect(await blurFocusedInput(deps)).toBe(true);
    order.push('clear');
    expect(order).toEqual(['dismiss', 'onBlur', 'clear']);
  });

  it('costs nothing when no input has focus', async () => {
    vi.useFakeTimers();
    const { deps, order } = fakeKeyboard({ focused: false, visible: false });
    let result: boolean | undefined;
    void blurFocusedInput(deps).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(false);
    expect(order).toEqual(['dismiss']);
  });
});
