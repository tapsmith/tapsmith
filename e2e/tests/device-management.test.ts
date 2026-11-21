import { test, expect, describe } from "tapsmith";
import type { Device } from "tapsmith";
import { screenShape } from "../utils/orientation.js";

const PKG = "dev.tapsmith.testapp";

// ─── Device Setup ───

describe("Device setup", () => {
  test("wake() wakes the device screen", async ({ device }) => {
    await device.wake();
  });

  test("unlock() dismisses the lock screen", async ({ device }) => {
    await device.unlock();
  });
});

// ─── App Lifecycle ───

describe("App lifecycle", () => {
  test("currentPackage() returns the foreground app", async ({ device }) => {
    const pkg = await device.currentPackage();
    expect(pkg).toBe(PKG);
  });

  test("getAppState() returns 'foreground' for active app", async ({
    device,
  }) => {
    const state = await device.getAppState(PKG);
    expect(state).toBe("foreground");
  });

  // Expo's default bundle id has a hyphen (com.anonymous.my-app): iOS allows
  // one, so the daemon must pass it to the agent; Android's package names
  // cannot have one, so it is refused up front with Android's rule.
  test("getAppState() takes a hyphenated iOS bundle id, refused on Android", async ({
    device,
  }) => {
    const id = "dev.tapsmith.not-installed";
    if (device.platform === "ios") {
      expect(await device.getAppState(id)).toBe("stopped");
    } else {
      const error = await device.getAppState(id).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /invalid Android package name.*letters, digits, dots and underscores/,
      );
    }
  });

  test("terminateApp() stops the app", async ({ device }) => {
    await device.terminateApp(PKG);
    const state = await device.getAppState(PKG);
    expect(state).toBe("stopped");
  });

  test("launchApp() with clearData starts fresh", async ({ device }) => {
    await device.launchApp(PKG, { clearData: true });
    const pkg = await device.currentPackage();
    expect(pkg).toBe(PKG);
  });
});

// ─── Deep Links ───

describe("Deep links", () => {
  test("openDeepLink() navigates to a screen", async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///login");
  });
});

// ─── Orientation ───

describe("Orientation", () => {
  // Tests in a file run in order on one device: the first records how the
  // device started, which is landscape on a landscape-native tablet.
  let before: string | undefined;

  // The screen's shape as the screenshot shows it. Checked on Android only:
  // some iOS simulator runtimes turn the device but not the app, so its
  // screen keeps its shape (the landscape tests skip there).
  const expectShape = async (device: Device, wanted: string) => {
    if (device.platform !== "android") return;
    await expect.poll(() => screenShape(device)).toBe(wanted);
  };

  test("setOrientation('landscape') changes to landscape", async ({
    device,
  }) => {
    before = await device.getOrientation();
    // From portrait, so the screen really turns on a device that starts out
    // landscape, and the shape check below can't pass before it has turned.
    await device.setOrientation("portrait");
    await expectShape(device, "portrait");
    await device.setOrientation("landscape");
    const orientation = await device.getOrientation();
    expect(orientation).toBe("landscape");
    await expectShape(device, "landscape");
    // End opposite to how the device started, so the next test can tell a
    // turn that was undone from one that never happened.
    if (before === "landscape") await device.setOrientation("portrait");
  });

  // The test above leaves the device turned. A test's turn is undone after
  // it, pass or fail, so the next test finds the device as it was (PILOT-1253).
  test("a turn made by the previous test is undone", async ({ device }) => {
    expect(await device.getOrientation()).toBe(before ?? "portrait");
  });

  test("setOrientation('portrait') restores portrait", async ({ device }) => {
    await device.setOrientation("portrait");
    const orientation = await device.getOrientation();
    expect(orientation).toBe("portrait");
    await expectShape(device, "portrait");
  });

  // setOrientation() resolves once the screen has turned, so the screen read
  // straight after it already has the new shape: no polling. Android only,
  // as expectShape above.
  describe("read straight after the turn", () => {
    test.use({ trace: "off" });

    test("the screen already has the new shape", async ({ device }) => {
      test.skip(device.platform !== "android", "some iOS simulator runtimes turn the device but not the app");
      for (const wanted of ["landscape", "portrait", "landscape", "portrait"] as const) {
        await device.setOrientation(wanted);
        expect(await screenShape(device)).toBe(wanted);
      }
    });
  });
});

// ─── Keyboard ───

describe("Keyboard", () => {
  test("isKeyboardShown() returns false when no keyboard visible", async ({
    device,
  }) => {
    const shown = await device.isKeyboardShown();
    expect(shown).toBe(false);
  });

  test("hideKeyboard() does not throw when no keyboard is shown", async ({
    device,
  }) => {
    await device.hideKeyboard();
  });
});

// ─── Clipboard ───

describe("Clipboard", () => {
  test("setClipboard() + getClipboard() round-trips text", async ({
    device,
  }) => {
    await device.setClipboard("Tapsmith E2E clipboard test!");
    const clipText = await device.getClipboard();
    expect(clipText).toBe("Tapsmith E2E clipboard test!");
  });
});

// ─── waitForIdle ───

describe("Wait for idle", () => {
  test("waitForIdle() completes without error", async ({ device }) => {
    await device.waitForIdle();
  });

  test("waitForIdle() with custom timeout", async ({ device }) => {
    await device.waitForIdle(5000);
  });
});
