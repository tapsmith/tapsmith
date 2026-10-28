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
import type { ElementInfo, EvaluateSelectorsResponse, TapsmithGrpcClient } from "../grpc-client.js";
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
      'getByRole("button")',
    ]);
  });

  it("loosens an exact or state-filtered role name first", () => {
    vitestExpect(codes(_role("button", { name: "Sign in", exact: true }))[0]).toBe('getByRole("button", { name: "Sign in" })');
    vitestExpect(codes(_role("checkbox", { name: "Terms", checked: true }))[0]).toBe('getByRole("checkbox", { name: "Terms" })');
  });

  it("checks an exact text as a substring first, and each word getter under the others", () => {
    vitestExpect(codes(_text("Welcome"))).toEqual([
      'getByText("Welcome")', 'getByLabel("Welcome")', 'getByPlaceholder("Welcome")', 'getByDescription("Welcome")',
    ]);
    vitestExpect(codes(_hint("Email"))).toEqual(['getByText("Email")', 'getByLabel("Email")', 'getByDescription("Email")']);
    vitestExpect(codes(_label("Email"))).toEqual(['getByText("Email")', 'getByPlaceholder("Email")', 'getByDescription("Email")']);
    vitestExpect(codes(_contentDesc("Close"))).toEqual(['getByText("Close")', 'getByLabel("Close")', 'getByPlaceholder("Close")']);
    vitestExpect(codes(_textContains("Hi"))).toEqual(['getByLabel("Hi")', 'getByPlaceholder("Hi")', 'getByDescription("Hi")']);
  });

  it("also checks words ending in punctuation without it, as text and description (PILOT-880)", () => {
    // On iOS a React Native link labelled "Forgot password" hides its "Forgot password?" text.
    vitestExpect(codes(_textContains("Forgot password?"))).toEqual([
      'getByLabel("Forgot password?")', 'getByPlaceholder("Forgot password?")', 'getByDescription("Forgot password?")',
      'getByText("Forgot password")', 'getByDescription("Forgot password")',
    ]);
    vitestExpect(codes(_text("Done!")).slice(-2)).toEqual(['getByText("Done")', 'getByDescription("Done")']);
    vitestExpect(codes(_textContains("Forgot password? ")).slice(-2)).toEqual([
      'getByText("Forgot password")', 'getByDescription("Forgot password")',
    ]);
    vitestExpect(codes(_role("link", { name: "Help?" })).slice(-3)).toEqual([
      'getByText("Help")', 'getByDescription("Help")', 'getByRole("link")',
    ]);
    // Punctuation alone, or none, adds nothing.
    vitestExpect(codes(_textContains("?"))).toEqual(['getByLabel("?")', 'getByPlaceholder("?")', 'getByDescription("?")']);
    vitestExpect(codes(_textContains("Hi")).length).toBe(3);
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
        'await locator.scrollIntoView() (scrollIntoView({ direction: "down" }) for one above the screen), then tap() it. ' +
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
    const { client } = missingClient((s) => (s.kind.type === "role" ? [element("a", "Log in"), element("b", "Help", 100)] : []));
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
