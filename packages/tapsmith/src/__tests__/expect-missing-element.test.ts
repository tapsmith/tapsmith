/**
 * Assertions on a locator that matches nothing (PILOT-1198).
 *
 * As in Playwright, a single-element state or value assertion needs the
 * element in both polarities: `expect(missing).not.toBeChecked()` must wait
 * out its timeout and fail as "no element matched" rather than pass at once
 * because `undefined?.checked` is not `true`. Only the absence-style
 * assertions (`not.toBeVisible()`, `toBeHidden()`, `not.toExist()`,
 * `not.toBeInViewport()`, and the array/count forms) accept an empty match
 * set as their answer.
 */
import { describe, it, expect as vitestExpect, vi } from "vitest";
import { expect as tapsmithExpect, type TapsmithAssertions, type WebViewAssertions } from "../expect.js";
import { ElementHandle } from "../element-handle.js";
import { _text } from "../selectors.js";
import type { ElementInfo, TapsmithGrpcClient } from "../grpc-client.js";
import { WebViewHandle, type WebViewLocatorProbe } from "../webview-handle.js";

const TIMEOUT = 150;

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: "el-1",
    className: "android.widget.TextView",
    text: "",
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

/** A client whose every read returns `next()`'s elements. */
function clientOf(next: () => ElementInfo[]): { client: TapsmithGrpcClient; reads: () => number } {
  let reads = 0;
  const client = {
    findElement: vi.fn(async () => {
      const els = next();
      return { requestId: "1", found: els.length > 0, element: els[0], errorMessage: "" };
    }),
    findElements: vi.fn(async () => {
      reads++;
      return { requestId: "1", elements: next(), errorMessage: "" };
    }),
  } as unknown as TapsmithGrpcClient;
  return { client, reads: () => reads };
}

function missingHandle(): { handle: ElementHandle; reads: () => number } {
  const { client, reads } = clientOf(() => []);
  return { handle: new ElementHandle(client, _text("Compact list"), TIMEOUT), reads };
}

type Run = (a: TapsmithAssertions) => Promise<void>;

/**
 * Every single-element native matcher, with the phrase its message uses.
 * Each would pass in its negated form on a present element whose state is
 * the default one `makeElementInfo` gives (unchecked, empty, …).
 */
const SINGLE_ELEMENT_MATCHERS: Array<[string, Run, string]> = [
  ["toBeChecked", (a) => a.toBeChecked({ timeout: TIMEOUT }), "to be checked"],
  ["toBeDisabled", (a) => a.toBeDisabled({ timeout: TIMEOUT }), "to be disabled"],
  ["toBeEnabled", (a) => a.toBeEnabled({ timeout: TIMEOUT }), "to be enabled"],
  ["toBeEmpty", (a) => a.toBeEmpty({ timeout: TIMEOUT }), "to be empty"],
  ["toBeEditable", (a) => a.toBeEditable({ timeout: TIMEOUT }), "to be editable"],
  ["toBeFocused", (a) => a.toBeFocused({ timeout: TIMEOUT }), "to be focused"],
  ["toHaveText", (a) => a.toHaveText("Saved", { timeout: TIMEOUT }), 'to have text "Saved"'],
  ["toHaveText(RegExp)", (a) => a.toHaveText(/Saved/, { timeout: TIMEOUT }), "to have text /Saved/"],
  ["toContainText", (a) => a.toContainText("Saved", { timeout: TIMEOUT }), "to contain text Saved"],
  ["toHaveValue", (a) => a.toHaveValue("abc", { timeout: TIMEOUT }), 'to have value "abc"'],
  ["toHaveAttribute", (a) => a.toHaveAttribute("text", "abc", { timeout: TIMEOUT }), 'to have attribute "text" = "abc"'],
  ["toHaveAccessibleName", (a) => a.toHaveAccessibleName("Save", { timeout: TIMEOUT }), "to have accessible name Save"],
  ["toHaveAccessibleDescription", (a) => a.toHaveAccessibleDescription("Save", { timeout: TIMEOUT }), "to have accessible description Save"],
  ["toHaveRole", (a) => a.toHaveRole("button", { timeout: TIMEOUT }), 'to have role "button"'],
];

describe("negated single-element assertions on a missing element (PILOT-1198)", () => {
  for (const [name, run, phrase] of SINGLE_ELEMENT_MATCHERS) {
    it(`not.${name}() waits out its timeout and fails as no element matched`, async () => {
      const { handle, reads } = missingHandle();
      const start = Date.now();
      const err = await run(tapsmithExpect(handle).not).catch((e: unknown) => e);
      vitestExpect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      vitestExpect(message).toContain(`NOT ${phrase}, but no element matched`);
      vitestExpect(Date.now() - start).toBeGreaterThanOrEqual(TIMEOUT - 10);
      // It kept polling: a miss never settles the negated assertion.
      vitestExpect(reads()).toBeGreaterThan(1);
    });

    it(`${name}() on a missing element fails as no element matched`, async () => {
      const { handle } = missingHandle();
      const err = await run(tapsmithExpect(handle)).catch((e: unknown) => e);
      vitestExpect((err as Error).message).toMatch(
        new RegExp(`Expected element .* ${phrase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}, but no element matched`),
      );
      vitestExpect((err as Error).message).not.toContain("NOT");
    });
  }

  it("not.toBeChecked() passes once the element appears unchecked", async () => {
    let tick = 0;
    const { client } = clientOf(() => (++tick < 3 ? [] : [makeElementInfo({ checked: false })]));
    const handle = new ElementHandle(client, _text("Compact list"), 2_000);
    await tapsmithExpect(handle).not.toBeChecked({ timeout: 2_000 });
    vitestExpect(tick).toBeGreaterThanOrEqual(3);
  });

  it("not.toBeChecked() still passes at once on a present, unchecked element", async () => {
    const { client, reads } = clientOf(() => [makeElementInfo({ checked: false })]);
    const handle = new ElementHandle(client, _text("Compact list"), 5_000);
    const start = Date.now();
    await tapsmithExpect(handle).not.toBeChecked({ timeout: 5_000 });
    vitestExpect(Date.now() - start).toBeLessThan(1_000);
    vitestExpect(reads()).toBe(1);
  });

  it("not.toBeChecked() fails as checked, not as missing, when the last read found it checked", async () => {
    let tick = 0;
    const { client } = clientOf(() => (++tick < 2 ? [] : [makeElementInfo({ checked: true })]));
    const handle = new ElementHandle(client, _text("Compact list"), TIMEOUT);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeChecked({ timeout: TIMEOUT }),
    ).rejects.toThrow(/NOT to be checked, but it was$/);
  });

  it("not.toBeChecked() on an out-of-range nth() fails as no element matched", async () => {
    const { client } = clientOf(() => [makeElementInfo({ checked: false })]);
    const handle = new ElementHandle(client, _text("Compact list"), TIMEOUT).nth(3);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeChecked({ timeout: TIMEOUT }),
    ).rejects.toThrow("NOT to be checked, but no element matched");
  });

  describe("absence-style assertions still pass on a missing element (Playwright)", () => {
    it("not.toBeVisible()", async () => {
      await tapsmithExpect(missingHandle().handle).not.toBeVisible({ timeout: TIMEOUT });
    });
    it("toBeHidden()", async () => {
      await tapsmithExpect(missingHandle().handle).toBeHidden({ timeout: TIMEOUT });
    });
    it("not.toExist()", async () => {
      await tapsmithExpect(missingHandle().handle).not.toExist({ timeout: TIMEOUT });
    });
    it("not.toBeInViewport()", async () => {
      await tapsmithExpect(missingHandle().handle).not.toBeInViewport({ timeout: TIMEOUT });
    });
    it("toHaveCount(0)", async () => {
      await tapsmithExpect(missingHandle().handle).toHaveCount(0, { timeout: TIMEOUT });
    });
    it("not.toHaveText([...]) and not.toContainText([...])", async () => {
      await tapsmithExpect(missingHandle().handle).not.toHaveText(["a"], { timeout: TIMEOUT });
      await tapsmithExpect(missingHandle().handle).not.toContainText(["a"], { timeout: TIMEOUT });
    });
  });

  it("toBeInViewport() on a missing element fails as no element matched", async () => {
    await vitestExpect(
      tapsmithExpect(missingHandle().handle).toBeInViewport({ timeout: TIMEOUT }),
    ).rejects.toThrow("to be in viewport, but no element matched");
  });
});

// ─── WebView locators ───

function webViewHandle(read: () => { count: number; value?: unknown } | Error) {
  const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, 400);
  let reads = 0;
  vi.spyOn(handle, "_probeLocator").mockImplementation(async (_loc, _timeoutMs, opts) => {
    reads++;
    const r = read();
    if (r instanceof Error) throw r;
    const probe: WebViewLocatorProbe = {
      count: r.count,
      anyVisible: r.count > 0,
      targetVisible: r.count > 0,
      sample: [],
    };
    if (opts?.valueJs) probe.target = r.count > 0 ? { found: true, value: r.value } : { found: false };
    return probe;
  });
  return { handle, reads: () => reads };
}

type WebViewRun = (a: WebViewAssertions) => Promise<void>;

const WEBVIEW_MATCHERS: Array<[string, WebViewRun, string]> = [
  ["toHaveText", (a) => a.toHaveText("Saved", { timeout: TIMEOUT }), 'to have text "Saved"'],
  ["toContainText", (a) => a.toContainText("Saved", { timeout: TIMEOUT }), 'to contain text "Saved"'],
  ["toHaveValue", (a) => a.toHaveValue("abc", { timeout: TIMEOUT }), 'to have value "abc"'],
  ["toHaveAttribute", (a) => a.toHaveAttribute("href", "/a", { timeout: TIMEOUT }), 'to have attribute "href" = "/a"'],
];

describe("WebView value assertions on a missing element (PILOT-1198)", () => {
  for (const [name, run, phrase] of WEBVIEW_MATCHERS) {
    it(`not.${name}() waits out its timeout and fails as no element matched`, async () => {
      const { handle, reads } = webViewHandle(() => ({ count: 0 }));
      const start = Date.now();
      const err = await run(tapsmithExpect(handle.locator("#gone")).not).catch((e: unknown) => e);
      vitestExpect((err as Error).message).toContain(`not ${phrase}, but no element matched`);
      vitestExpect(Date.now() - start).toBeGreaterThanOrEqual(TIMEOUT - 10);
      vitestExpect(reads()).toBeGreaterThan(1);
    });

    it(`${name}() on a missing element fails as no element matched`, async () => {
      const { handle } = webViewHandle(() => ({ count: 0 }));
      await vitestExpect(run(tapsmithExpect(handle.locator("#gone")))).rejects.toThrow(`${phrase}, but no element matched`);
    });

    it(`not.${name}() does not pass on a read that failed`, async () => {
      const { handle, reads } = webViewHandle(() => new Error("CDP socket closed"));
      await vitestExpect(run(tapsmithExpect(handle.locator("#x")).not)).rejects.toThrow(/could not be read|no element matched|CDP socket closed/);
      vitestExpect(reads()).toBeGreaterThan(1);
    });
  }

  it("not.toHaveText() still passes on a present element with other text", async () => {
    const { handle } = webViewHandle(() => ({ count: 1, value: "Draft" }));
    await tapsmithExpect(handle.locator("#status")).not.toHaveText("Saved", { timeout: TIMEOUT });
  });
});
