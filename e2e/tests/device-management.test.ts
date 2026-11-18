import { test, expect, describe } from "tapsmith";

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
  test("setOrientation('landscape') changes to landscape", async ({
    device,
  }) => {
    await device.setOrientation("landscape");
    const orientation = await device.getOrientation();
    expect(orientation).toBe("landscape");
  });

  // The test above leaves the device turned. A test's turn is undone after
  // it, pass or fail, so the next test finds the device as it was (PILOT-1253).
  test("a turn made by the previous test is undone", async ({ device }) => {
    expect(await device.getOrientation()).toBe("portrait");
  });

  test("setOrientation('portrait') restores portrait", async ({ device }) => {
    await device.setOrientation("portrait");
    const orientation = await device.getOrientation();
    expect(orientation).toBe("portrait");
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
