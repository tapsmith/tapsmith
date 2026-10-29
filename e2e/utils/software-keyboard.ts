import type { Device } from "tapsmith"

/** How long the software keyboard gets to come on screen. */
const KEYBOARD_TIMEOUT_MS = 5_000

/**
 * Wait for the software keyboard to be on screen, and fail naming the usual
 * reason when it never is. With a hardware keyboard connected to an iOS
 * simulator, iOS keeps the software keyboard off screen and isKeyboardShown()
 * is false (PILOT-792), so a bare `expect(...).toBe(true)` would only say
 * "false". Polls, since a keyboard raised a moment ago may not be up yet.
 */
export async function expectSoftwareKeyboardShown(device: Device): Promise<void> {
  const deadline = Date.now() + KEYBOARD_TIMEOUT_MS
  while (!(await device.isKeyboardShown())) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Expected the software keyboard on screen, but isKeyboardShown() was still false after ${KEYBOARD_TIMEOUT_MS} ms. ` +
          "On an iOS simulator, a connected hardware keyboard (Simulator: I/O > Keyboard > Connect " +
          "Hardware Keyboard) keeps the software keyboard off screen: disconnect it and run again.",
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
