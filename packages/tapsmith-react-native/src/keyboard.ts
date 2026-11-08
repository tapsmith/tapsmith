/**
 * The parts of React Native's `Keyboard` and `TextInput.State` the reset
 * needs, injected so the ordering can be tested without a native runtime.
 */
export interface KeyboardDeps {
  focusedInput(): unknown;
  isVisible(): boolean;
  dismiss(): void;
  /** Subscribe to `keyboardDidHide`; returns the unsubscribe. */
  onDidHide(cb: () => void): () => void;
}

/** Longest wait for the on-screen keyboard to report it has gone. */
const KEYBOARD_HIDE_CAP_MS = 1_000;
/** Wait for a focused input's blur with no on-screen keyboard to watch. */
const BLUR_SETTLE_MS = 100;
/**
 * Wait after `keyboardDidHide` for the input's own blur. A reset link that
 * navigates away hides the keyboard with the screen transition, and the
 * input's JS `onBlur` then arrives 30-45 ms after the hide event (measured on
 * an iOS 26.5 simulator). React Native has no app-wide blur event to wait on.
 */
const BLUR_AFTER_HIDE_MS = 150;

/**
 * Blur the focused input (and dismiss its keyboard) and let the blur land
 * before returning. The native blur event reaches JS a frame or more after
 * `dismiss()`, so an app whose `onBlur`/`onEndEditing` saves a draft writes
 * it back after the reset's clear; the reset clears again once this returns
 * true.
 * Waits for `keyboardDidHide`, then a short settle for the blur itself (the
 * hide can come first when the reset link navigates away); without an
 * on-screen keyboard (a simulator's hardware keyboard) a short settle stands
 * in for both.
 * Returns at once, with false, when nothing has focus; true once a focused
 * input has blurred.
 */
export async function blurFocusedInput(deps: KeyboardDeps): Promise<boolean> {
  const focused = deps.focusedInput() != null;
  if (!focused) {
    deps.dismiss();
    return false;
  }
  const visible = deps.isVisible();
  await new Promise<void>((resolve) => {
    let unsubscribe = (): void => {};
    const done = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, visible ? KEYBOARD_HIDE_CAP_MS : BLUR_SETTLE_MS);
    if (visible) unsubscribe = deps.onDidHide(done);
    deps.dismiss();
  });
  if (visible) await new Promise<void>((resolve) => { setTimeout(resolve, BLUR_AFTER_HIDE_MS); });
  // One more turn, so work the blur handlers queued starts ahead of the
  // second clear.
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  return true;
}
