/**
 * Matcher options (PILOT-547).
 *
 * `toBeVisible({ visible: false })` behaves like `toBeHidden()`, as in
 * Playwright, and an option a matcher does not support is refused at once
 * instead of being silently ignored.
 */
import { describe, it, expect as vitestExpect, vi } from "vitest";
import { expect as tapsmithExpect, flushSoftErrors } from "../expect.js";
import { ElementHandle } from "../element-handle.js";
import { _text } from "../selectors.js";
import { WebViewHandle, type WebViewLocatorProbe } from "../webview-handle.js";
import type {
  TapsmithGrpcClient,
  ElementInfo,
} from "../grpc-client.js";

// ─── Helpers ───

function el(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: "el-1",
    className: "android.widget.TextView",
    text: "Explore",
    contentDescription: "",
    resourceId: "",
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: "",
    checked: false,
    selected: false,
    focused: false,
    role: "",
    viewportRatio: 1.0,
    ...overrides,
  };
}

/** A client whose screen is `screen()` on every read — one tick's matches. */
function clientOf(screen: () => ElementInfo[]): TapsmithGrpcClient {
  return {
    findElement: vi.fn(async () => {
      const els = screen();
      return { requestId: "1", found: els.length > 0, element: els[0], errorMessage: "" };
    }),
    findElements: vi.fn(async () => ({ requestId: "1", elements: screen(), errorMessage: "" })),
  } as unknown as TapsmithGrpcClient;
}

function handleOf(screen: () => ElementInfo[], timeoutMs = 100): ElementHandle {
  return new ElementHandle(clientOf(screen), _text("Explore"), timeoutMs);
}

const visible = () => [el({ visible: true })];
const hidden = () => [el({ visible: false })];
const absent = () => [];

function webViewOf(matches: { visible: boolean }[]) {
  const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, 300);
  vi.spyOn(handle, "_probeLocator").mockImplementation(async () => ({
    count: matches.length,
    anyVisible: matches.some((m) => m.visible),
    targetVisible: matches[0]?.visible ?? false,
    sample: matches.map(() => ({ tag: "div", id: "", testId: "", ariaLabel: "", role: "", text: "A" })),
  }) as WebViewLocatorProbe);
  vi.spyOn(handle, "_evaluate").mockImplementation(async () => undefined);
  return handle;
}

// ─── toBeVisible({ visible }) ───

describe("toBeVisible({ visible: false }) (PILOT-547)", () => {
  it("fails against a visible element, naming the option", async () => {
    const err = await tapsmithExpect(handleOf(visible))
      .toBeVisible({ visible: false, timeout: 50 })
      .catch((e: unknown) => e);
    vitestExpect(err).toBeInstanceOf(Error);
    vitestExpect((err as Error).message).toBe(
      'Expected element getByText("Explore", { exact: true }) to be hidden (toBeVisible({ visible: false })), but it was visible',
    );
  });

  it("passes when the element is hidden or absent", async () => {
    await tapsmithExpect(handleOf(hidden)).toBeVisible({ visible: false, timeout: 50 });
    await tapsmithExpect(handleOf(absent)).toBeVisible({ visible: false, timeout: 50 });
  });

  it("waits for the element to disappear within the timeout", async () => {
    let reads = 0;
    const handle = handleOf(() => (++reads < 3 ? visible() : absent()), 2_000);
    await tapsmithExpect(handle).toBeVisible({ visible: false, timeout: 2_000 });
    vitestExpect(reads).toBeGreaterThanOrEqual(3);
  });

  it("visible: true and an omitted visible keep asserting visibility", async () => {
    await tapsmithExpect(handleOf(visible)).toBeVisible({ visible: true, timeout: 50 });
    await tapsmithExpect(handleOf(visible)).toBeVisible({ visible: undefined, timeout: 50 });
    await vitestExpect(
      tapsmithExpect(handleOf(hidden)).toBeVisible({ visible: true, timeout: 50 }),
    ).rejects.toThrow("to be visible, but it was not");
  });

  it("shares one assertion between both states, as Playwright users write it", async () => {
    for (const isLoggedIn of [true, false]) {
      const screen = isLoggedIn ? visible : absent;
      await tapsmithExpect(handleOf(screen)).toBeVisible({ visible: isLoggedIn, timeout: 50 });
    }
  });

  it(".not.toBeVisible({ visible: false }) asserts visibility", async () => {
    await tapsmithExpect(handleOf(visible)).not.toBeVisible({ visible: false, timeout: 50 });
    await vitestExpect(
      tapsmithExpect(handleOf(hidden)).not.toBeVisible({ visible: false, timeout: 50 }),
    ).rejects.toThrow(
      'Expected element getByText("Explore", { exact: true }) NOT to be hidden (toBeVisible({ visible: false })), but it was',
    );
  });

  it(".not.toBeVisible({ visible: true }) is still an absence check", async () => {
    await tapsmithExpect(handleOf(hidden)).not.toBeVisible({ visible: true, timeout: 50 });
    await vitestExpect(
      tapsmithExpect(handleOf(visible)).not.toBeVisible({ visible: true, timeout: 50 }),
    ).rejects.toThrow("NOT to be visible");
  });

  it("is an absence check over every match, like toBeHidden (no strict-mode throw)", async () => {
    const two = (a: boolean, b: boolean) => () => [
      el({ elementId: "el-1", visible: a }),
      el({ elementId: "el-2", visible: b }),
    ];
    await tapsmithExpect(handleOf(two(false, false))).toBeVisible({ visible: false, timeout: 50 });
    await vitestExpect(
      tapsmithExpect(handleOf(two(true, false))).toBeVisible({ visible: false, timeout: 50 }),
    ).rejects.toThrow("but it was visible");
  });

  it(".not.toBeVisible({ visible: false }) evaluates over every match, exactly like .not.toBeHidden()", async () => {
    const two = (a: boolean, b: boolean) => () => [
      el({ elementId: "el-1", visible: a }),
      el({ elementId: "el-2", visible: b }),
    ];
    await tapsmithExpect(handleOf(two(true, false))).not.toBeVisible({ visible: false, timeout: 50 });
    await tapsmithExpect(handleOf(two(true, false))).not.toBeHidden({ timeout: 50 });
    await vitestExpect(
      tapsmithExpect(handleOf(two(false, false))).not.toBeVisible({ visible: false, timeout: 50 }),
    ).rejects.toThrow("NOT to be hidden (toBeVisible({ visible: false }))");
  });

  it("expect.soft records the failure instead of throwing", async () => {
    flushSoftErrors();
    await tapsmithExpect.soft(handleOf(visible)).toBeVisible({ visible: false, timeout: 50 });
    await tapsmithExpect.soft(handleOf(hidden)).toBeVisible({ visible: false, timeout: 50 });
    const errors = flushSoftErrors();
    vitestExpect(errors).toHaveLength(1);
    vitestExpect(errors[0].message).toContain("to be hidden (toBeVisible({ visible: false }))");
  });

  it("rejects a non-boolean visible at once", async () => {
    const start = Date.now();
    await vitestExpect(
      tapsmithExpect(handleOf(visible, 5_000)).toBeVisible({
        visible: "no" as unknown as boolean,
        timeout: 5_000,
      }),
    ).rejects.toThrow('toBeVisible() option "visible" must be a boolean, got a string.');
    vitestExpect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe("WebView toBeVisible({ visible: false }) (PILOT-547)", () => {
  it("fails while the element is visible", async () => {
    const wv = webViewOf([{ visible: true }]);
    await vitestExpect(
      tapsmithExpect(wv.getByText("A")).toBeVisible({ visible: false, timeout: 100 }),
    ).rejects.toThrow('Expected "text=A" to be hidden in WebView (toBeVisible({ visible: false }))');
  });

  it("passes when every match is hidden, and .not asserts visibility", async () => {
    await tapsmithExpect(webViewOf([{ visible: false }, { visible: false }]).getByText("A"))
      .toBeVisible({ visible: false, timeout: 100 });
    await tapsmithExpect(webViewOf([{ visible: true }]).getByText("A"))
      .not.toBeVisible({ visible: false, timeout: 100 });
  });
});

// ─── Trace records what visible: false checked ───

function mockCollector() {
  return {
    captureBeforeAction: vi.fn(async () => ({ actionIndex: 0, captures: {} })),
    addAssertionEvent: vi.fn(),
    _emitAssertionStarted: vi.fn(),
    setPendingOperation: vi.fn(),
    clearPendingOperation: vi.fn(),
  };
}

describe("trace event for toBeVisible({ visible: false }) (PILOT-547)", () => {
  it("native: the toBeVisible row records that it expected the element hidden", async () => {
    const collector = mockCollector();
    const traced = (screen: () => ElementInfo[]) => new ElementHandle(clientOf(screen), _text("Explore"), 100, {
      traceCapture: {
        collector,
        takeScreenshot: async () => undefined,
        captureHierarchy: async () => undefined,
      } as unknown as import("../trace/trace-collector.js").TraceCapture,
    });
    await tapsmithExpect(traced(absent)).toBeVisible({ visible: false, timeout: 50 });
    await tapsmithExpect(traced(visible)).not.toBeVisible({ visible: false, timeout: 50 });
    await tapsmithExpect(traced(visible)).toBeVisible({ timeout: 50 });
    const events = collector.addAssertionEvent.mock.calls.map((c) => c[0]);
    vitestExpect(events.map((e) => [e.assertion, e.passed, e.expected])).toEqual([
      ["toBeVisible", true, "hidden ({ visible: false })"],
      ["not.toBeVisible", true, "not hidden ({ visible: false })"],
      ["toBeVisible", true, undefined],
    ]);
  });

  it("WebView: the toBeVisible row records that it expected the element hidden", async () => {
    const collector = mockCollector();
    const wv = webViewOf([{ visible: false }]);
    wv._traceCtx = {
      collector,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
      deviceId: "d",
    } as unknown as NonNullable<typeof wv._traceCtx>;
    vi.spyOn(wv, "_getElementBounds").mockResolvedValue(undefined);
    await tapsmithExpect(wv.getByText("A")).toBeVisible({ visible: false, timeout: 100 });
    await tapsmithExpect(wv.getByText("A")).not.toBeVisible({ timeout: 100 });
    const events = collector.addAssertionEvent.mock.calls.map((c) => c[0]);
    vitestExpect(events.map((e) => [e.assertion, e.passed, e.expected])).toEqual([
      ["toBeVisible", true, "hidden ({ visible: false })"],
      ["not.toBeVisible", true, undefined],
    ]);
  });
});

// ─── Unsupported options are refused ───

describe("matcher options are validated (PILOT-547)", () => {
  it("refuses an unknown option at once instead of ignoring it", async () => {
    const start = Date.now();
    await vitestExpect(
      tapsmithExpect(handleOf(visible, 5_000)).toBeVisible({
        timeout: 5_000,
        visibel: false,
      } as unknown as { timeout: number }),
    ).rejects.toThrow('toBeVisible() does not support the option "visibel". Supported options: timeout, visible.');
    vitestExpect(Date.now() - start).toBeLessThan(1_000);
  });

  it("refuses unknown options on every locator matcher, with a hint for Playwright options Tapsmith lacks", async () => {
    const h = handleOf(visible);
    const bad = (o: Record<string, unknown>) => o as { timeout?: number };
    await vitestExpect(tapsmithExpect(h).toBeEnabled(bad({ enabled: false }))).rejects.toThrow(
      'toBeEnabled() does not support the option "enabled". Supported options: timeout. Use toBeDisabled() or .not.toBeEnabled() instead.',
    );
    await vitestExpect(tapsmithExpect(h).toBeChecked(bad({ checked: false }))).rejects.toThrow(
      'toBeChecked() does not support the option "checked". Supported options: timeout. Use .not.toBeChecked() instead.',
    );
    await vitestExpect(tapsmithExpect(h).toHaveText("Explore", bad({ ignoreCase: true }))).rejects.toThrow(
      'toHaveText() does not support the option "ignoreCase". Supported options: timeout. Use a RegExp with the i flag instead.',
    );
    await vitestExpect(tapsmithExpect(h).toBeInViewport(bad({ ratio: 0.5, foo: 1 }))).rejects.toThrow(
      'toBeInViewport() does not support the option "foo". Supported options: timeout, ratio.',
    );
    await vitestExpect(tapsmithExpect(h).not.toBeHidden(bad({ visible: false }))).rejects.toThrow(
      'toBeHidden() does not support the option "visible".',
    );
    await vitestExpect(tapsmithExpect(h).toHaveCount(1, bad({ x: 1 }))).rejects.toThrow(
      'toHaveCount() does not support the option "x".',
    );
    await vitestExpect(tapsmithExpect(h).toHaveAttribute("text", "Explore", bad({ x: 1 }))).rejects.toThrow(
      'toHaveAttribute() does not support the option "x".',
    );
  });

  it("refuses options that are not an object", async () => {
    await vitestExpect(
      tapsmithExpect(handleOf(visible)).toBeVisible(5000 as unknown as { timeout: number }),
    ).rejects.toThrow("toBeVisible() expects an options object such as { timeout: 5000 }, got a number.");
  });

  it("accepts undefined, null, an empty object and undefined values", async () => {
    const h = handleOf(visible);
    await tapsmithExpect(h).toBeVisible();
    await tapsmithExpect(h).toBeVisible(null as unknown as undefined);
    await tapsmithExpect(h).toBeVisible({});
    await tapsmithExpect(h).toBeVisible({ timeout: undefined });
    await tapsmithExpect(h).toBeInViewport({ ratio: 0.5, timeout: 50 });
  });

  it("expect.soft records an unsupported option as a failure", async () => {
    flushSoftErrors();
    await tapsmithExpect.soft(handleOf(visible)).toBeEnabled({ enabled: false } as unknown as { timeout: number });
    const errors = flushSoftErrors();
    vitestExpect(errors).toHaveLength(1);
    vitestExpect(errors[0]).toBeInstanceOf(TypeError);
  });

  it("refuses unknown options on WebView matchers too", async () => {
    const wv = webViewOf([{ visible: true }]);
    await vitestExpect(
      tapsmithExpect(wv.getByText("A")).toHaveText("A", { ignoreCase: true } as unknown as { timeout: number }),
    ).rejects.toThrow('toHaveText() does not support the option "ignoreCase".');
    await vitestExpect(
      tapsmithExpect(wv.getByText("A")).toBeHidden({ visible: false } as unknown as { timeout: number }),
    ).rejects.toThrow('toBeHidden() does not support the option "visible".');
  });
});

// ─── Chained getters (PILOT-850) ───

describe("a chained getter's assertion message names its parent (PILOT-850)", () => {
  it("shows the chain, not the child alone", async () => {
    const client = {
      findElements: vi.fn(async () => ({ requestId: "1", elements: [], errorMessage: "" })),
    } as unknown as TapsmithGrpcClient;
    const child = new ElementHandle(client, _text("Cart"), 50).getByText("Total");
    const err = await tapsmithExpect(child).toBeVisible({ timeout: 50 }).catch((e: unknown) => e);
    vitestExpect((err as Error).message).toContain('getByText("Cart", { exact: true }).getByText("Total")');
  });
});
