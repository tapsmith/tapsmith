/**
 * The names `device.swipe()`, `locator.scroll()` and `device.pressKey()` take.
 *
 * They are typed as literal unions so an editor can autocomplete them, but
 * every signature also takes any other string (`SwipeDirection | (string & {})`):
 * the agents match names case-insensitively, the Android agent also takes a
 * numeric key code and the iOS agent a single character to type.
 *
 * **Parity contract:** `DEVICE_KEYS` is exactly the set of names the Android
 * agent's `resolveKeyCode` (`agent/.../ActionExecutor.kt`) accepts, uppercased.
 * `typed-params.test.ts` reads the agents' sources and fails on drift.
 */

// ─── Swipe directions ───

/**
 * A swipe or scroll direction, case-insensitive. `locator.scroll()` and
 * `scrollIntoView()` take the way the view scrolls (`"down"` reveals what is
 * below); `device.swipe()` takes the way the finger moves (`"up"` reveals what
 * is below).
 */
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

// ─── Device keys ───

/** Key names `device.pressKey()` accepts on Android, uppercased. */
export const DEVICE_KEYS = [
  'BACK',
  'HOME',
  'ENTER',
  'RETURN',
  'TAB',
  'DELETE',
  'BACKSPACE',
  'FORWARD_DELETE',
  'ESCAPE',
  'ESC',
  'MENU',
  'SEARCH',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'POWER',
  'CAMERA',
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
  'DPAD_CENTER',
  'SPACE',
  'RECENTS',
  'APP_SWITCH',
] as const;

/**
 * A named device key for `device.pressKey()`. Case-insensitive (`"enter"`
 * works too). Every name works on Android; iOS supports `HOME`, `ENTER` /
 * `RETURN`, `TAB`, `DELETE` / `BACKSPACE`, `ESCAPE` / `ESC` (submits, like
 * `ENTER`), `SPACE` and `BACK` (taps the navigation bar's back button).
 */
export type DeviceKey = typeof DEVICE_KEYS[number];
