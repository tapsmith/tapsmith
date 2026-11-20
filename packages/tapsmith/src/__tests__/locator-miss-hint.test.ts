/**
 * PILOT-849: a locator miss lists the locators that do match the same words
 * on screen (asked of the device agent), and points at UI mode's picker and
 * the MCP tapsmith_test_locator tool.
 */
import { describe, it, expect as vitestExpect, vi } from "vitest";
import { expect as tapsmithExpect } from "../expect.js";
import { Device } from "../device.js";
import { LOCATOR_PICKER_HINT, nearMissHint, nearMissProbes } from "../locator-miss-hint.js";
import { _contentDesc, _hint, _label, _role, _text, _textContains, _testId, formatSelector, withParent } from "../selectors.js";
import type { ElementInfo, EvaluateSelectorsResponse, GetSystemAlertResponse, TapsmithGrpcClient } from "../grpc-client.js";
import type { Selector } from "../selectors.js";

function element(id: string, text: string, top = 0): ElementInfo {
  return {
    elementId: id, className: "android.widget.TextView", text, contentDescription: "", resourceId: "",
    enabled: true, visible: true, clickable: false, focusable: false, scrollable: false, hint: "",
    checked: false, selected: false, focused: false, role: "text", viewportRatio: 1,
    bounds: { left: 0, top, right: 300, bottom: top + 50 },
  } as ElementInfo;
}

/** A client whose finds miss, and whose evaluateSelectors answers per probe from `answer`. */
function missingClient(answer?: (s: Selector) => ElementInfo[]) {
  const evaluateSelectors = vi.fn(async (selectors: Selector[]): Promise<EvaluateSelectorsResponse> => ({
    requestId: "e",
    results: selectors.map((s) => ({ elements: answer ? answer(s) : [], errorMessage: "" })),
    errorMessage: "",
  }));
  const client = {
    findElement: vi.fn(async () => ({ requestId: "1", found: false, errorMessage: "" })),
    findElements: vi.fn(async () => ({ requestId: "1", elements: [] as ElementInfo[], errorMessage: "" })),
    evaluateSelectors,
  } as unknown as TapsmithGrpcClient;
  return { client, evaluateSelectors };
}

const err = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const codes = (s: Selector) => nearMissProbes(s).map((p) => formatSelector(p.selector));

describe("nearMissProbes()", () => {
  it("checks a named role's words under the other getters, then the role alone", () => {
    vitestExpect(codes(_role("button", { name: "Sign in" }))).toEqual([
      'getByText("Sign in")', 'getByLabel("Sign in")', 'getByPlaceholder("Sign in")', 'getByDescription("Sign in")',
      'getByRole("tab", { name: "Sign in" })', 'getByRole("button")',
    ]);
  });

  it("loosens an exact or state-filtered role name first", () => {
    vitestExpect(codes(_role("button", { name: "Sign in", exact: true }))[0]).toBe('getByRole("button", { name: "Sign in" })');
    vitestExpect(codes(_role("checkbox", { name: "Terms", checked: true }))[0]).toBe('getByRole("checkbox", { name: "Terms" })');
  });

  it("checks an exact text as a substring first, and each word getter under the others", () => {
    vitestExpect(codes(_text("Welcome"))).toEqual([
      'getByText("Welcome")', 'getByLabel("Welcome")', 'getByPlaceholder("Welcome")', 'getByDescription("Welcome")',
      'getByRole("tab", { name: "Welcome" })',
    ]);
    vitestExpect(codes(_hint("Email"))).toEqual(['getByText("Email")', 'getByLabel("Email")', 'getByDescription("Email")']);
    vitestExpect(codes(_label("Email"))).toEqual([
      'getByText("Email")', 'getByPlaceholder("Email")', 'getByDescription("Email")', 'getByRole("tab", { name: "Email" })',
    ]);
    vitestExpect(codes(_contentDesc("Close"))).toEqual([
      'getByText("Close")', 'getByLabel("Close")', 'getByPlaceholder("Close")', 'getByRole("tab", { name: "Close" })',
    ]);
    vitestExpect(codes(_textContains("Hi"))).toEqual([
      'getByLabel("Hi")', 'getByPlaceholder("Hi")', 'getByDescription("Hi")', 'getByRole("tab", { name: "Hi" })',
    ]);
  });

  it("also checks words ending in punctuation without it, as text and description (PILOT-880)", () => {
    // On iOS a React Native link labelled "Forgot password" hides its "Forgot password?" text.
    vitestExpect(codes(_textContains("Forgot password?"))).toEqual([
      'getByLabel("Forgot password?")', 'getByPlaceholder("Forgot password?")', 'getByDescription("Forgot password?")',
      'getByText("Forgot password")', 'getByDescription("Forgot password")', 'getByRole("tab", { name: "Forgot password?" })',
    ]);
    vitestExpect(codes(_text("Done!")).slice(-3, -1)).toEqual(['getByText("Done")', 'getByDescription("Done")']);
    vitestExpect(codes(_textContains("Forgot password? ")).slice(-3, -1)).toEqual([
      'getByText("Forgot password")', 'getByDescription("Forgot password")',
    ]);
    vitestExpect(codes(_role("link", { name: "Help?" })).slice(-4)).toEqual([
      'getByText("Help")', 'getByDescription("Help")', 'getByRole("tab", { name: "Help?" })', 'getByRole("link")',
    ]);
    // Punctuation alone, or none, adds nothing.
    vitestExpect(codes(_textContains("?"))).toEqual([
      'getByLabel("?")', 'getByPlaceholder("?")', 'getByDescription("?")', 'getByRole("tab", { name: "?" })',
    ]);
    vitestExpect(codes(_textContains("Hi")).length).toBe(4);
  });

  it("checks the words as a tab's name for a description, a text, a label or another role's name", () => {
    // A Flutter NavigationRail destination: its description is "Contact\nTab 2 of 3", and it is a tab named "Contact".
    vitestExpect(codes(_contentDesc("Contact")).at(-1)).toBe('getByRole("tab", { name: "Contact" })');
    vitestExpect(codes(_text("Contact")).at(-1)).toBe('getByRole("tab", { name: "Contact" })');
    vitestExpect(codes(_textContains("Contact")).at(-1)).toBe('getByRole("tab", { name: "Contact" })');
    vitestExpect(codes(_label("Contact")).at(-1)).toBe('getByRole("tab", { name: "Contact" })');
    vitestExpect(codes(_role("button", { name: "Contact" })).slice(-2)).toEqual([
      'getByRole("tab", { name: "Contact" })', 'getByRole("button")',
    ]);
    // Not for a tab query, nor for a placeholder, which only a text field has.
    vitestExpect(codes(_role("tab", { name: "Contact" })).join()).not.toContain('getByRole("tab", { name');
    vitestExpect(codes(_hint("Email")).join()).not.toContain("getByRole");
  });

  it("checks nothing for a scoped selector, an id, or a RegExp text, and only the role for a RegExp name", () => {
    vitestExpect(codes(withParent(_text("Row"), _role("list")))).toEqual([]);
    vitestExpect(codes(_testId("submit"))).toEqual([]);
    vitestExpect(codes(_textContains(/sign/i))).toEqual([]);
    vitestExpect(codes(_role("button", { name: /sign/i }))).toEqual(['getByRole("button")']);
    // An unnamed role has nothing to loosen and no words to check.
    vitestExpect(codes(_role("button"))).toEqual([]);
  });
});

describe("a not-found error lists the near misses the agent finds", () => {
  it("in an action, before the off-screen hint and with the picker last", async () => {
    const { client } = missingClient((s) => (s.kind.type === "textContains" ? [element("t", "Sign in")] : []));
    const d = new Device(client, { platform: "android", timeout: 50 });
    const message = await err(d.getByRole("button", { name: "Sign in" }).tap());
    vitestExpect(message).toBe(
      'Element getByRole("button", { name: "Sign in" }) was not found after waiting 50ms. ' +
        'Nothing matches it, but on screen now this locator matches: getByText("Sign in") (1 element). ' +
        'It may be off-screen in a scrollable list: tap() does not scroll, so scroll it into view first with ' +
        'await locator.scrollIntoView() (scrollIntoView({ direction: "up" }) for one above the screen), then tap() it. ' +
        LOCATOR_PICKER_HINT,
    );
  });

  it("lists up to three, with their counts, in recommendation order", async () => {
    const { client } = missingClient((s) => {
      if (s.kind.type === "role") return [];
      return s.kind.type === "label" ? [element("a", "x"), element("b", "x", 100)] : [element("c", "x")];
    });
    const d = new Device(client, { platform: "ios", timeout: 50 });
    const message = await err(tapsmithExpect(d.getByRole("button", { name: "Go" })).toBeVisible({ timeout: 50 }));
    vitestExpect(message).toContain(
      'to be visible, but it was not. Nothing matches it, but on screen now these locators match: ' +
        'getByText("Go") (1 element), getByLabel("Go") (2 elements), getByPlaceholder("Go") (1 element). ' +
        LOCATOR_PICKER_HINT,
    );
  });

  it("says the role exists under other names when only the role matches", async () => {
    const { client } = missingClient((s) =>
      s.kind.type === "role" && s.kind.value.role === "button" ? [element("a", "Log in"), element("b", "Help", 100)] : []);
    const d = new Device(client, { platform: "android", timeout: 50 });
    vitestExpect(await err(d.getByRole("button", { name: "Sign in" }).find())).toBe(
      'Element getByRole("button", { name: "Sign in" }) was not found after waiting 50ms. ' +
        'getByRole("button") matches 2 elements on screen now, none named "Sign in". ' + LOCATOR_PICKER_HINT,
    );
  });

  it("in toExist, toHaveCount and waitFor failures", async () => {
    const { client } = missingClient((s) => (s.kind.type === "label" ? [element("l", "Email")] : []));
    const d = new Device(client, { platform: "ios", timeout: 50 });
    const near = 'Nothing matches it, but on screen now this locator matches: getByLabel("Email") (1 element).';
    vitestExpect(await err(tapsmithExpect(d.getByPlaceholder("Email")).toExist({ timeout: 50 }))).toContain(near);
    vitestExpect(await err(tapsmithExpect(d.getByPlaceholder("Email")).toHaveCount(1, { timeout: 50 }))).toContain(near);
    vitestExpect(await err(d.getByPlaceholder("Email").waitFor({ timeout: 50 }))).toContain(near);
  });

  it("names the description that fits a label without the text's \"?\" (PILOT-880)", async () => {
    const { client } = missingClient((s) =>
      (s.kind.type === "contentDesc" || s.kind.type === "textContains") && s.kind.value === "Forgot password"
        ? [element("l", "Forgot password")]
        : []);
    const d = new Device(client, { platform: "ios", timeout: 50 });
    vitestExpect(await err(d.getByText("Forgot password?", { exact: true }).tap())).toContain(
      'Nothing matches it, but on screen now these locators match: ' +
        'getByText("Forgot password") (1 element), getByDescription("Forgot password") (1 element).',
    );
  });

  it("only the picker when nothing near matches", async () => {
    const { client } = missingClient();
    const d = new Device(client, { platform: "ios", timeout: 50 });
    vitestExpect(await err(d.getByText("Nope", { exact: true }).find())).toBe(
      `Element getByText("Nope", { exact: true }) was not found after waiting 50ms. ${LOCATOR_PICKER_HINT}`,
    );
  });

  it("does not ask for a modified or scoped locator, but still points at the picker", async () => {
    const { client, evaluateSelectors } = missingClient(() => [element("x", "Row")]);
    const d = new Device(client, { platform: "ios", timeout: 50 });
    for (const handle of [d.getByText("Row").first(), d.getByRole("list").getByText("Row"), d.getByText("Row").filter({ hasText: "R" })]) {
      vitestExpect(await err(handle.find())).toContain(LOCATOR_PICKER_HINT);
    }
    vitestExpect(evaluateSelectors).not.toHaveBeenCalled();
  });

  it("says nothing more after a positional miss: the locator did match", async () => {
    const rows = [element("a", "Row 1"), element("b", "Row 2", 100)];
    const { client, evaluateSelectors } = missingClient();
    (client.findElements as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ requestId: "1", elements: rows, errorMessage: "" }));
    const d = new Device(client, { platform: "android", timeout: 50 });
    const message = await err(d.getByText("Row").nth(5).find());
    vitestExpect(message).not.toContain(LOCATOR_PICKER_HINT);
    vitestExpect(evaluateSelectors).not.toHaveBeenCalled();
  });

  it("says nothing more after an out-of-range nth() in assertions and waitFor either", async () => {
    const rows = [element("a", "Row 1"), element("b", "Row 2", 100)];
    const { client, evaluateSelectors } = missingClient();
    (client.findElements as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ requestId: "1", elements: rows, errorMessage: "" }));
    const d = new Device(client, { platform: "android", timeout: 50 });
    const row = () => d.getByText("Row").nth(5);
    // One at a time: each is started only when it is awaited, so none rejects unobserved.
    for (const failure of [
      () => tapsmithExpect(row()).toBeVisible({ timeout: 50 }),
      () => tapsmithExpect(row()).toExist({ timeout: 50 }),
      () => tapsmithExpect(row()).toHaveCount(1, { timeout: 50 }),
      () => row().waitFor({ timeout: 50 }),
    ]) {
      const message = await err(failure());
      vitestExpect(message).not.toBe("");
      vitestExpect(message).not.toContain(LOCATOR_PICKER_HINT);
    }
    vitestExpect(evaluateSelectors).not.toHaveBeenCalled();
  });

  it("keeps a no-wait read to one read: no near-miss check, the picker only", async () => {
    const { client, evaluateSelectors } = missingClient(() => [element("x", "Allow")]);
    // A device timeout of 0 is the explicit no-wait mode (an action's
    // { timeout: 0 } is refused).
    const d = new Device(client, { platform: "ios", timeout: 0 });
    vitestExpect(await err(d.getByText("Allow", { exact: true }).find())).toBe(
      `Element not found: getByText("Allow", { exact: true }). ${LOCATOR_PICKER_HINT}`,
    );
    vitestExpect(await err(tapsmithExpect(d.getByText("Allow", { exact: true })).toBeVisible({ timeout: 0 })))
      .toContain(`but it was not. ${LOCATOR_PICKER_HINT}`);
    vitestExpect(evaluateSelectors).not.toHaveBeenCalled();
  });

  it("checks for near misses no longer than the locator waited", async () => {
    const never = vi.fn(() => new Promise<EvaluateSelectorsResponse>(() => {}));
    const client = {
      findElement: vi.fn(async () => ({ requestId: "1", found: false, errorMessage: "" })),
      findElements: vi.fn(async () => ({ requestId: "1", elements: [] as ElementInfo[], errorMessage: "" })),
      evaluateSelectors: never,
    } as unknown as TapsmithGrpcClient;
    const d = new Device(client, { platform: "android", timeout: 50 });
    const started = Date.now();
    vitestExpect(await err(d.getByText("Gone").waitFor({ timeout: 50 }))).toContain(LOCATOR_PICKER_HINT);
    vitestExpect(never).toHaveBeenCalledTimes(1);
    // 50 ms of waiting, then at most 50 ms of checking — far below the 2 s cap.
    vitestExpect(Date.now() - started).toBeLessThan(1000);
  });

  it("not for a negated assertion that fails", async () => {
    const { client, evaluateSelectors } = missingClient();
    (client.findElements as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ requestId: "1", elements: [element("a", "Hi")], errorMessage: "" }));
    const d = new Device(client, { platform: "android", timeout: 50 });
    const message = await err(tapsmithExpect(d.getByText("Hi")).not.toBeVisible({ timeout: 50 }));
    vitestExpect(message).not.toContain(LOCATOR_PICKER_HINT);
    vitestExpect(evaluateSelectors).not.toHaveBeenCalled();
  });
});

describe("a not-found error names a system alert covering the app (iOS)", () => {
  const OPEN_IN = {
    requestId: "a", present: true, title: "Open in “priya-app”?", buttons: ["Cancel", "Open"],
  } as GetSystemAlertResponse;
  const COVERING = 'A system alert is covering the app: "Open in “priya-app”?" (buttons: Cancel, Open). ' +
    "Locators only see the app under test, so nothing behind the alert can be found, tapped or typed into " +
    "until it is closed: close it on the device, or tap one of its buttons with device.tapXY().";

  function alertClient(alert: () => Promise<GetSystemAlertResponse>) {
    const { client, evaluateSelectors } = missingClient();
    const getSystemAlert = vi.fn(alert);
    (client as unknown as { getSystemAlert: typeof getSystemAlert }).getSystemAlert = getSystemAlert;
    return { client, evaluateSelectors, getSystemAlert };
  }

  it("first, before the near misses and the picker", async () => {
    const { client } = alertClient(async () => OPEN_IN);
    const d = new Device(client, { platform: "ios", timeout: 50 });
    vitestExpect(await err(d.getByText("Sign in", { exact: true }).find())).toBe(
      `Element getByText("Sign in", { exact: true }) was not found after waiting 50ms. ${COVERING} ${LOCATOR_PICKER_HINT}`,
    );
  });

  it("in assertions and for a modified locator too: the alert does not depend on the locator", async () => {
    const { client } = alertClient(async () => OPEN_IN);
    const d = new Device(client, { platform: "ios", timeout: 50 });
    vitestExpect(await err(tapsmithExpect(d.getByText("Go")).toBeVisible({ timeout: 50 }))).toContain(COVERING);
    vitestExpect(await err(d.getByText("Row").first().find())).toContain(COVERING);
  });

  it("says nothing when no alert is up, or the device cannot say (an older agent)", async () => {
    for (const alert of [
      async () => ({ requestId: "a", present: false, title: "", buttons: [] }),
      async () => { throw new Error("12 UNIMPLEMENTED"); },
    ]) {
      const { client } = alertClient(alert);
      const d = new Device(client, { platform: "ios", timeout: 50 });
      vitestExpect(await err(d.getByText("Nope", { exact: true }).find())).toBe(
        `Element getByText("Nope", { exact: true }) was not found after waiting 50ms. ${LOCATOR_PICKER_HINT}`,
      );
    }
  });

  it("drops the off-screen hint, which would point the wrong way", async () => {
    const { client } = alertClient(async () => OPEN_IN);
    const d = new Device(client, { platform: "ios", timeout: 50 });
    const message = await err(d.getByText("Sign in", { exact: true }).tap());
    vitestExpect(message).toContain(COVERING);
    vitestExpect(message).not.toContain("off-screen");
  });

  it("names an untitled alert, and one without buttons", async () => {
    const { client } = alertClient(async () => ({ requestId: "a", present: true, title: "", buttons: [] }));
    const d = new Device(client, { platform: "ios", timeout: 50 });
    vitestExpect(await err(d.getByText("Go").find())).toContain(
      "A system alert is covering the app: an untitled alert (no buttons).",
    );
  });

  it("gives the near-miss check its own window: the device answers one agent call at a time", async () => {
    // The daemon and the agent serialise agent calls, so two sent at once
    // share one window only on paper. Model that: each call waits for the last.
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(ms: number, value: T) => {
      const next = queue.then(() => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms)));
      queue = next;
      return next;
    };
    const client = {
      findElement: vi.fn(async () => ({ requestId: "1", found: false, errorMessage: "" })),
      findElements: vi.fn(async () => ({ requestId: "1", elements: [] as ElementInfo[], errorMessage: "" })),
      getSystemAlert: vi.fn(() => serial(300, { requestId: "a", present: false, title: "", buttons: [] })),
      evaluateSelectors: vi.fn((selectors: Selector[]) => serial(300, {
        requestId: "e",
        errorMessage: "",
        results: selectors.map((s) => ({ elements: s.kind.type === "textContains" ? [element("t", "Sign in")] : [], errorMessage: "" })),
      })),
    } as unknown as TapsmithGrpcClient;
    const d = new Device(client, { platform: "ios", timeout: 500 });
    vitestExpect(await err(d.getByRole("button", { name: "Sign in" }).find())).toContain(
      'Nothing matches it, but on screen now this locator matches: getByText("Sign in") (1 element).',
    );
  });

  it("does not ask an Android device, a no-wait read, or past the locator's wait", async () => {
    const android = alertClient(async () => OPEN_IN);
    await err(new Device(android.client, { platform: "android", timeout: 50 }).getByText("Go").find());
    vitestExpect(android.getSystemAlert).not.toHaveBeenCalled();

    const noWait = alertClient(async () => OPEN_IN);
    await err(new Device(noWait.client, { platform: "ios", timeout: 0 }).getByText("Go").find());
    vitestExpect(noWait.getSystemAlert).not.toHaveBeenCalled();

    const hung = alertClient(() => new Promise<GetSystemAlertResponse>(() => {}));
    const started = Date.now();
    vitestExpect(await err(new Device(hung.client, { platform: "ios", timeout: 50 }).getByText("Go").find()))
      .toContain(LOCATOR_PICKER_HINT);
    vitestExpect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("nearMissHint() never gets in the way of the error", () => {
  const sel = _role("button", { name: "Go" });

  it("is empty when the client cannot ask, the agent errors, or the RPC rejects", async () => {
    vitestExpect(await nearMissHint({}, sel)).toBe("");
    vitestExpect(await nearMissHint({
      evaluateSelectors: async () => ({ requestId: "e", results: [], errorMessage: "agent too old" }),
    }, sel)).toBe("");
    vitestExpect(await nearMissHint({ evaluateSelectors: async () => { throw new Error("UNIMPLEMENTED"); } }, sel)).toBe("");
  });

  it("gives up at its budget, and at once on an aborted signal", async () => {
    const never = { evaluateSelectors: () => new Promise<EvaluateSelectorsResponse>(() => {}) };
    const started = Date.now();
    vitestExpect(await nearMissHint(never, sel, undefined, 20)).toBe("");
    vitestExpect(Date.now() - started).toBeLessThan(1000);
    const aborted = AbortSignal.abort();
    vitestExpect(await nearMissHint(never, sel, aborted)).toBe("");
    const controller = new AbortController();
    const pending = nearMissHint(never, sel, controller.signal);
    controller.abort();
    vitestExpect(await pending).toBe("");
  });

  it("counts a duplicated same-target node once, as strict mode does", async () => {
    const dup = [element("a", "Go"), element("b", "Go")];
    const hint = await nearMissHint({
      evaluateSelectors: async (s: Selector[]) => ({
        requestId: "e", errorMessage: "",
        results: s.map((x) => ({ elements: x.kind.type === "textContains" ? dup : [], errorMessage: "" })),
      }),
    }, sel);
    vitestExpect(hint).toContain('getByText("Go") (1 element)');
  });
});
