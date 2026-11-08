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
 * Blur the focused input (and dismiss its keyboard) and let the blur land
 * before returning. The native blur event reaches JS a frame or more after
 * `dismiss()`, so an app whose `onBlur`/`onEndEditing` saves a draft would
 * otherwise write it back into the storage the reset is about to clear.
 * `keyboardDidHide` follows the blur on both platforms; without an on-screen
 * keyboard (a simulator's hardware keyboard) a short settle stands in for it.
 * Returns at once when nothing has focus.
 */
export async function blurFocusedInput(deps: KeyboardDeps): Promise<void> {
  const focused = deps.focusedInput() != null;
  if (!focused) {
    deps.dismiss();
    return;
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
  // One more turn, so work the blur handlers queued starts ahead of the clear.
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}
