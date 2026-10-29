import type { Device } from "tapsmith"

/**
 * Fail unless the software keyboard is on screen, naming the usual reason
 * when it is not. With a hardware keyboard connected to an iOS simulator, iOS
 * keeps the software keyboard off screen and isKeyboardShown() is false
 * (PILOT-792), so a bare `expect(...).toBe(true)` would only say "false".
 */
export async function expectSoftwareKeyboardShown(device: Device): Promise<void> {
  if (await device.isKeyboardShown()) return
  throw new Error(
    "Expected the software keyboard on screen, but isKeyboardShown() is false. On an iOS " +
      "simulator, a connected hardware keyboard (Simulator: I/O > Keyboard > Connect Hardware " +
      "Keyboard) keeps the software keyboard off screen: disconnect it and run again.",
  )
}
