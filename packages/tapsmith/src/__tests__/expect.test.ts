import { describe, it, expect as vitestExpect, vi } from "vitest";
import { expect as tapsmithExpect } from "../expect.js";
import { ElementHandle } from "../element-handle.js";
import { _role, _text, selectorToProto, type Selector } from "../selectors.js";
import type {
  TapsmithGrpcClient,
  FindElementResponse,
  FindElementsResponse,
  ElementInfo,
} from "../grpc-client.js";

// ─── Mock helpers ───

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

function makeMockClient(
  findElementImpl: () => Promise<FindElementResponse>,
  findElementsImpl?: () => Promise<FindElementsResponse>,
): TapsmithGrpcClient {
  return {
    findElement: vi.fn(findElementImpl),
    // Assertions resolve through findElements (strict mode, PILOT-226) —
    // when no explicit impl is given, derive the list from the
    // single-element impl so tests keep describing one screen state.
    findElements: vi.fn(
      findElementsImpl ??
        (async () => {
          const res = await findElementImpl();
          return {
            requestId: "1",
            elements: res.found && res.element ? [res.element] : [],
            errorMessage: "",
          };
        }),
    ),
  } as unknown as TapsmithGrpcClient;
}

function makeHandle(
  client: TapsmithGrpcClient,
  selector = _text("Hello"),
  timeoutMs = 100,
): ElementHandle {
  return new ElementHandle(client, selector, timeoutMs);
}

// ─── toBeVisible() ───

describe("toBeVisible()", () => {
  it("passes when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeVisible({ timeout: 50 });
  });

  it("fails when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("to be visible");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("to be visible");
  });

  it("not.toBeVisible() passes when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeVisible({ timeout: 50 });
  });

  it("not.toBeVisible() fails when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("NOT to be visible");
  });
});

// ─── toBeEnabled() ───

describe("toBeEnabled()", () => {
  it("passes when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeEnabled({ timeout: 50 });
  });

  it("fails when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeEnabled({ timeout: 50 }),
    ).rejects.toThrow("to be enabled");
  });

  it("not.toBeEnabled() passes when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeEnabled({ timeout: 50 });
  });

  it("not.toBeEnabled() fails when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeEnabled({ timeout: 50 }),
    ).rejects.toThrow("NOT to be enabled");
  });
});

// ─── toHaveText() ───

describe("toHaveText()", () => {
  it("passes when text matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveText("Hello World", { timeout: 50 });
  });

  it("fails when text does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Wrong text" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveText("Expected text", { timeout: 50 }),
    ).rejects.toThrow('to have text "Expected text"');
  });

  it("includes actual text in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "actual" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveText("expected", { timeout: 50 }),
    ).rejects.toThrow('got "actual"');
  });

  it("not.toHaveText() passes when text differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "different" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveText("expected", { timeout: 50 });
  });

  it("not.toHaveText() fails when text matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "same" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveText("same", { timeout: 50 }),
    ).rejects.toThrow("NOT to have text");
  });
});

// ─── toExist() ───

describe("toExist()", () => {
  it("passes when element exists", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo(),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toExist({ timeout: 50 });
  });

  it("fails when element does not exist", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toExist({ timeout: 50 }),
    ).rejects.toThrow("to exist");
  });

  it("not.toExist() passes when element is absent", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toExist({ timeout: 50 });
  });

  it("not.toExist() fails when element exists", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo(),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toExist({ timeout: 50 }),
    ).rejects.toThrow("NOT to exist");
  });
});

// ─── toBeChecked() (PILOT-29) ───

describe("toBeChecked()", () => {
  it("passes when element is checked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeChecked({ timeout: 50 });
  });

  it("fails when element is not checked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeChecked({ timeout: 50 }),
    ).rejects.toThrow("to be checked");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeChecked({ timeout: 50 }),
    ).rejects.toThrow("to be checked");
  });

  it("not.toBeChecked() passes when element is unchecked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeChecked({ timeout: 50 });
  });

  it("not.toBeChecked() fails when element is checked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeChecked({ timeout: 50 }),
    ).rejects.toThrow("NOT to be checked");
  });
});

// ─── toBeDisabled() (PILOT-30) ───

describe("toBeDisabled()", () => {
  it("passes when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeDisabled({ timeout: 50 });
  });

  it("fails when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeDisabled({ timeout: 50 }),
    ).rejects.toThrow("to be disabled");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeDisabled({ timeout: 50 }),
    ).rejects.toThrow("to be disabled");
  });

  it("not.toBeDisabled() passes when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeDisabled({ timeout: 50 });
  });

  it("not.toBeDisabled() fails when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeDisabled({ timeout: 50 }),
    ).rejects.toThrow("NOT to be disabled");
  });
});

// ─── toBeHidden() (PILOT-31) ───

describe("toBeHidden()", () => {
  it("passes when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeHidden({ timeout: 50 });
  });

  it("passes when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeHidden({ timeout: 50 });
  });

  it("fails when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeHidden({ timeout: 50 }),
    ).rejects.toThrow("to be hidden");
  });

  it("not.toBeHidden() passes when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeHidden({ timeout: 50 });
  });

  it("not.toBeHidden() fails when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeHidden({ timeout: 50 }),
    ).rejects.toThrow("NOT to be hidden");
  });

  it("propagates infrastructure errors instead of treating them as hidden", async () => {
    // "Element gone" is an empty result, not a throw — a throw means the
    // daemon/agent failed, and a dead session must not read as "hidden".
    const client = makeMockClient(async () => {
      throw new Error("connection lost");
    });
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeHidden({ timeout: 50 }),
    ).rejects.toThrow("connection lost");
  });
});

// ─── toBeEmpty() (PILOT-32) ───

describe("toBeEmpty()", () => {
  it("passes when element has empty text", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeEmpty({ timeout: 50 });
  });

  it("fails when element has text", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "some text" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow("to be empty");
  });

  it("includes actual text in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "content" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow('had text "content"');
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow("to be empty");
  });

  it("not.toBeEmpty() passes when element has text", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "some content" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeEmpty({ timeout: 50 });
  });

  it("not.toBeEmpty() fails when element is empty", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow("NOT to be empty");
  });
});

// ─── toBeFocused() (PILOT-33) ───

describe("toBeFocused()", () => {
  it("passes when element is focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeFocused({ timeout: 50 });
  });

  it("fails when element is not focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeFocused({ timeout: 50 }),
    ).rejects.toThrow("to be focused");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeFocused({ timeout: 50 }),
    ).rejects.toThrow("to be focused");
  });

  it("not.toBeFocused() passes when element is not focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeFocused({ timeout: 50 });
  });

  it("not.toBeFocused() fails when element is focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeFocused({ timeout: 50 }),
    ).rejects.toThrow("NOT to be focused");
  });
});

// ─── toContainText() (PILOT-34) ───

describe("toContainText()", () => {
  it("passes when text contains substring", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toContainText("World", { timeout: 50 });
  });

  it("passes when text matches regex", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "42 items found" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toContainText(/\d+ items/, { timeout: 50 });
  });

  it("fails when text does not contain substring", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toContainText("Missing", { timeout: 50 }),
    ).rejects.toThrow("to contain text");
  });

  it("fails when text does not match regex", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "no numbers here" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toContainText(/\d+ items/, { timeout: 50 }),
    ).rejects.toThrow("to contain text");
  });

  it("includes actual text in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "actual text" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toContainText("missing", { timeout: 50 }),
    ).rejects.toThrow('got "actual text"');
  });

  it("not.toContainText() passes when text does not contain", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toContainText("Missing", { timeout: 50 });
  });

  it("not.toContainText() fails when text contains", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toContainText("World", { timeout: 50 }),
    ).rejects.toThrow("NOT to contain text");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toContainText("anything", { timeout: 50 }),
    ).rejects.toThrow("to contain text");
  });
});

// ─── toHaveCount() (PILOT-35) ───

describe("toHaveCount()", () => {
  it("passes when count matches", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveCount(3, { timeout: 50 });
  });

  it("passes with count 0 when no elements found", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: false,
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveCount(0, { timeout: 50 });
  });

  it("fails when count does not match", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveCount(5, { timeout: 50 }),
    ).rejects.toThrow("to have count 5");
  });

  it("includes actual count in error message", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveCount(5, { timeout: 50 }),
    ).rejects.toThrow("found 2");
  });

  it("counts the handle's modified match set, not its raw selector (PILOT-349 follow-up)", async () => {
    // Real agents mint a fresh elementId per read: churn ids so the and()
    // below can only intersect by stable identity.
    let nextId = 0;
    const row = (text: string, top: number) =>
      makeElementInfo({ elementId: `id-${++nextId}`, text, role: "button", bounds: { left: 0, top, right: 400, bottom: top + 60 } });
    const findElements = vi.fn(async (selector: Selector) => ({
      requestId: "1",
      elements: selectorToProto(selector).text === "Item 5"
        ? [row("Item 5", 100)]
        : [row("Back", 0), row("Item 5", 100), row("Item 6", 160)],
      errorMessage: "",
    }));
    const client = {
      findElement: vi.fn(async () => ({ requestId: "1", found: true, element: makeElementInfo(), errorMessage: "" })),
      findElements,
    } as unknown as TapsmithGrpcClient;
    const buttons = new ElementHandle(client, _role("button"), 5000);
    const item5 = new ElementHandle(client, _text("Item 5"), 5000);
    await tapsmithExpect(buttons.and(item5)).toHaveCount(1, { timeout: 200 });
    await tapsmithExpect(buttons.or(item5)).toHaveCount(3, { timeout: 200 });
    await tapsmithExpect(buttons.filter({ hasText: "Item" })).toHaveCount(2, { timeout: 200 });
    // An operand's own positional index survives the assertion path's
    // re-timed clone of the handle tree (PILOT-347): the FIRST button is
    // "Back", which item5 does not match; the second is Item 5.
    await tapsmithExpect(buttons.first().and(item5)).toHaveCount(0, { timeout: 200 });
    await tapsmithExpect(buttons.nth(1).and(item5)).toHaveCount(1, { timeout: 200 });
    await tapsmithExpect(buttons.nth(1).and(item5)).toBeVisible({ timeout: 200 });
    await tapsmithExpect(buttons.first().or(item5)).toHaveCount(2, { timeout: 200 });
    await tapsmithExpect(buttons.first()).toHaveCount(1, { timeout: 200 });
    await vitestExpect(
      tapsmithExpect(buttons.and(item5)).toHaveCount(3, { timeout: 100 }),
    ).rejects.toThrow("to have count 3, but found 1");
  });

  it("not.toHaveCount() passes when count differs", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveCount(5, { timeout: 50 });
  });

  it("not.toHaveCount() fails when count matches", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveCount(2, { timeout: 50 }),
    ).rejects.toThrow("NOT to have count");
  });

  it("surfaces a daemon-level failure as the real cause instead of counting it as 0", async () => {
    // A dead agent must not make `toHaveCount(0)` pass. Resolution errors
    // flow through the poll like every other assertion: retried to the
    // deadline, then rethrown as themselves.
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ({ requestId: "1", elements: [], errorMessage: "agent dead" }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveCount(0, { timeout: 100 }),
    ).rejects.toThrow(/findElements failed: agent dead/);
  });

  it("retries a stale-snapshot tick instead of failing on it (the UI changed mid-read)", async () => {
    // Android's StaleObjectException surfaces as a findElements error carrying
    // the stale signature. It says nothing about presence — the next tick does.
    let calls = 0;
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ++calls === 1
        ? { requestId: "1", elements: [], errorMessage: "Element is stale (UI changed): null" }
        : { requestId: "1", elements: [makeElementInfo(), makeElementInfo({ elementId: "el-2" })], errorMessage: "" },
    );
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveCount(2, { timeout: 2_000 });
    vitestExpect(calls).toBeGreaterThanOrEqual(2);
  });

  it("a stale tick landing LAST does not mask the real assertion failure once other ticks completed", async () => {
    // Ticks 1..n complete and observe count 0 (the element never appears);
    // the final ticks before the deadline are stale. The failure must be the
    // ordinary assertion message, not the could-not-evaluate stall error —
    // and the same for a stale landing on the post-deadline final attempt.
    let calls = 0;
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ++calls <= 1
        ? { requestId: "1", elements: [], errorMessage: "" }
        : { requestId: "1", elements: [], errorMessage: "Element is stale (UI changed): null" },
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveCount(2, { timeout: 400 }),
    ).rejects.toThrow(/to have count 2, but found 0/);
  });

  it("toBeVisible() fails fast on an or() duplicate of a clipped element (documented limitation, PILOT-360 tracks the design)", async () => {
    // Both operands read one clipped element; ids differ per read, so the
    // union holds 2 entries and strict mode refuses the ambiguity on the
    // first tick rather than burning the assertion budget.
    let id = 0;
    const clipped = () => makeElementInfo({ elementId: `u-${++id}`, text: "Item 25", visible: false, bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ({ requestId: "1", elements: [clipped()], errorMessage: "" }),
    );
    const a = new ElementHandle(client, _text("Item 25"), 5000);
    const b = new ElementHandle(client, _role("button"), 5000);
    const start = Date.now();
    await vitestExpect(
      tapsmithExpect(a.or(b)).toBeVisible({ timeout: 5000 }),
    ).rejects.toThrow(/resolved to 2 elements/);
    vitestExpect(Date.now() - start).toBeLessThan(2000);
  });

  it("timeout 0's single read hitting a stale snapshot is 'could not be evaluated', not a fabricated count", async () => {
    // With timeout 0 the poll loop never runs; the final attempt is the only
    // read. A stale there is not an observation either.
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ({ requestId: "1", elements: [], errorMessage: "Element is stale (UI changed): null" }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveCount(2, { timeout: 0 }),
    ).rejects.toThrow(/single non-waiting read \(timeout: 0\) landed mid-update/);
  });

  it("a stale read that lasts the whole budget fails as 'could not be evaluated', for either polarity", async () => {
    // No tick ever completed, so neither "found 2" nor "found 0" is a fact:
    // the failure must not claim an observation, and must not surface as a
    // raw infrastructure error either.
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ({ requestId: "1", elements: [], errorMessage: "Element is stale (UI changed): null" }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveCount(2, { timeout: 300 }),
    ).rejects.toThrow(/UI kept changing for the whole 300ms assertion timeout.*is stale \(UI changed\)/);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveCount(2, { timeout: 300 }),
    ).rejects.toThrow(/UI kept changing/);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeVisible({ timeout: 300 }),
    ).rejects.toThrow(/UI kept changing/);
  });

  it("counts a scoped handle (dialog.first().getByRole) within its parent only", async () => {
    // Two stacked dialogs, one button inside each; the old raw-selector count
    // reported every button on screen.
    const dialogs = [
      makeElementInfo({ elementId: "d1", text: "Dialog A", bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
      makeElementInfo({ elementId: "d2", text: "Dialog B", bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
    ];
    const buttons = [
      makeElementInfo({ elementId: "b1", text: "Submit", role: "button", bounds: { left: 10, top: 10, right: 90, bottom: 40 } }),
      makeElementInfo({ elementId: "b2", text: "Submit", role: "button", bounds: { left: 10, top: 110, right: 90, bottom: 140 } }),
    ];
    const client = {
      findElement: vi.fn(async () => ({ requestId: "1", found: true, element: makeElementInfo(), errorMessage: "" })),
      findElements: vi.fn(async (selector: Selector) => ({
        requestId: "1",
        elements: selectorToProto(selector).role ? buttons : dialogs,
        errorMessage: "",
      })),
    } as unknown as TapsmithGrpcClient;
    const dialog = new ElementHandle(client, _text("Dialog"), 5000);
    await tapsmithExpect(dialog.first().getByRole("button")).toHaveCount(1, { timeout: 200 });
    await tapsmithExpect(dialog.getByRole("button")).toHaveCount(2, { timeout: 200 });
    await vitestExpect(
      tapsmithExpect(dialog.first().getByRole("button")).toHaveCount(2, { timeout: 100 }),
    ).rejects.toThrow("to have count 2, but found 1");
  });

  it("on a handle from all() answers live by index, like count()", async () => {
    const rows3 = [
      makeElementInfo({ elementId: "r1", text: "A" }),
      makeElementInfo({ elementId: "r2", text: "B" }),
      makeElementInfo({ elementId: "r3", text: "C" }),
    ];
    let live = rows3;
    const client = makeMockClient(
      async () => ({ requestId: "1", found: true, element: makeElementInfo(), errorMessage: "" }),
      async () => ({ requestId: "1", elements: live, errorMessage: "" }),
    );
    const rows = await new ElementHandle(client, _role("listitem"), 5000).all();
    await tapsmithExpect(rows[2]).toHaveCount(1, { timeout: 200 });
    live = rows3.slice(0, 2);
    await tapsmithExpect(rows[2]).toHaveCount(0, { timeout: 200 });
    await tapsmithExpect(rows[0]).toHaveCount(1, { timeout: 200 });
  });
});

// ─── toHaveAttribute() (PILOT-36) ───

describe("toHaveAttribute()", () => {
  it("passes when attribute matches boolean", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAttribute("selected", true, {
      timeout: 50,
    });
  });

  it("passes when attribute matches string", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ className: "android.widget.Button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAttribute(
      "className",
      "android.widget.Button",
      { timeout: 50 },
    );
  });

  it("fails when attribute value does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveAttribute("selected", true, { timeout: 50 }),
    ).rejects.toThrow('to have attribute "selected"');
  });

  it("includes actual value in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ className: "android.widget.TextView" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveAttribute(
        "className",
        "android.widget.Button",
        { timeout: 50 },
      ),
    ).rejects.toThrow('got "android.widget.TextView"');
  });

  it("not.toHaveAttribute() passes when value differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveAttribute("selected", true, {
      timeout: 50,
    });
  });

  it("not.toHaveAttribute() fails when value matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveAttribute("selected", true, {
        timeout: 50,
      }),
    ).rejects.toThrow("NOT to have attribute");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveAttribute("enabled", true, { timeout: 50 }),
    ).rejects.toThrow("to have attribute");
  });
});

// ─── toHaveAccessibleName() (PILOT-37) ───

describe("toHaveAccessibleName()", () => {
  it("passes when contentDescription matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Submit form" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAccessibleName("Submit form", {
      timeout: 50,
    });
  });

  it("falls back to text when contentDescription is empty", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Submit", contentDescription: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAccessibleName("Submit", { timeout: 50 });
  });

  it("supports regex matching", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Submit form now" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAccessibleName(/Submit.*now/, {
      timeout: 50,
    });
  });

  it("fails when accessible name does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Cancel", text: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveAccessibleName("Submit", { timeout: 50 }),
    ).rejects.toThrow("to have accessible name");
  });

  it("not.toHaveAccessibleName() passes when name differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Cancel" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveAccessibleName("Submit", {
      timeout: 50,
    });
  });

  it("not.toHaveAccessibleName() fails when name matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Submit" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveAccessibleName("Submit", { timeout: 50 }),
    ).rejects.toThrow("NOT to have accessible name");
  });
});

// ─── toHaveAccessibleDescription() (PILOT-37) ───

describe("toHaveAccessibleDescription()", () => {
  it("passes when hint matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter your email" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAccessibleDescription("Enter your email", {
      timeout: 50,
    });
  });

  it("supports regex matching", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Profile photo of user" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveAccessibleDescription(/Profile photo/, {
      timeout: 50,
    });
  });

  it("fails when hint does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter username" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveAccessibleDescription("Enter email", {
        timeout: 50,
      }),
    ).rejects.toThrow("to have accessible description");
  });

  it("not.toHaveAccessibleDescription() passes when hint differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter username" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveAccessibleDescription("Enter email", {
      timeout: 50,
    });
  });

  it("not.toHaveAccessibleDescription() fails when hint matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter email" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveAccessibleDescription("Enter email", {
        timeout: 50,
      }),
    ).rejects.toThrow("NOT to have accessible description");
  });
});

// ─── toHaveRole() (PILOT-38) ───

describe("toHaveRole()", () => {
  it("passes when role matches from role field", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveRole("button", { timeout: 50 });
  });

  it("falls back to className-based role resolution", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "",
        className: "android.widget.Button",
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveRole("button", { timeout: 50 });
  });

  it("passes with switch role", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "switch",
        className: "android.widget.Switch",
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveRole("switch", { timeout: 50 });
  });

  it("fails when role does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "button",
        className: "android.widget.Button",
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveRole("textfield", { timeout: 50 }),
    ).rejects.toThrow('to have role "textfield"');
  });

  it("includes actual role in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveRole("switch", { timeout: 50 }),
    ).rejects.toThrow('got "button"');
  });

  it("not.toHaveRole() passes when role differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveRole("textfield", { timeout: 50 });
  });

  it("not.toHaveRole() fails when role matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveRole("button", { timeout: 50 }),
    ).rejects.toThrow("NOT to have role");
  });

  it("accepts 'header' as an alias for 'heading'", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "heading" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    // Either spelling resolves to the same normalized role.
    await tapsmithExpect(handle).toHaveRole("header", { timeout: 50 });
    await tapsmithExpect(handle).toHaveRole("heading", { timeout: 50 });
  });

  it("accepts 'slider' as an alias for 'seekbar'", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "seekbar" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveRole("slider", { timeout: 50 });
    await tapsmithExpect(handle).toHaveRole("seekbar", { timeout: 50 });
  });

  it("aliases work in both directions (agent reports alias, user passes canonical)", async () => {
    // RN sometimes surfaces the role as the user-facing alias rather than the
    // canonical Tapsmith spelling — make sure normalizeRole works either way.
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "header" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveRole("heading", { timeout: 50 });
    await tapsmithExpect(handle).toHaveRole("header", { timeout: 50 });
  });

  it("normalizes role case", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "Heading" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveRole("HEADER", { timeout: 50 });
  });

  // ─── Alias-map parity check ───
  // Lock the set of aliases the SDK recognizes so drift between the
  // three places (SDK expect.ts, Android ElementFinder.kt, iOS
  // RoleMapping.swift) fails a unit test instead of quietly mis-matching
  // in production. If you add a new alias, update all three.
  describe("ROLE_ALIASES parity", () => {
    // The canonical set as of this commit. Pairs express "user can pass
    // X and it normalizes to Y". Both directions are covered by
    // toHaveRole's poll (agent reports canonical or alias; user passes
    // either).
    const expectedAliases: Array<[string, string]> = [
      ["header", "heading"],
      ["heading", "heading"],
      ["slider", "seekbar"],
      ["seekbar", "seekbar"],
      ["search", "searchfield"],
      ["searchfield", "searchfield"],
    ];

    for (const [input, canonical] of expectedAliases) {
      it(`normalizes "${input}" → "${canonical}"`, async () => {
        const client = makeMockClient(async () => ({
          requestId: "1",
          found: true,
          element: makeElementInfo({ role: canonical }),
          errorMessage: "",
        }));
        const handle = makeHandle(client);
        await tapsmithExpect(handle).toHaveRole(input, { timeout: 50 });
      });
    }
  });
});

// ─── toHaveValue() (PILOT-39) ───

describe("toHaveValue()", () => {
  it("passes when value matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "test@example.com" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toHaveValue("test@example.com", { timeout: 50 });
  });

  it("fails when value does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "wrong@example.com" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveValue("test@example.com", { timeout: 50 }),
    ).rejects.toThrow('to have value "test@example.com"');
  });

  it("includes actual value in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "actual" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveValue("expected", { timeout: 50 }),
    ).rejects.toThrow('got "actual"');
  });

  it("not.toHaveValue() passes when value differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "different" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toHaveValue("expected", { timeout: 50 });
  });

  it("not.toHaveValue() fails when value matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "same" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toHaveValue("same", { timeout: 50 }),
    ).rejects.toThrow("NOT to have value");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toHaveValue("any", { timeout: 50 }),
    ).rejects.toThrow("to have value");
  });
});

// ─── toBeEditable() (PILOT-40) ───

describe("toBeEditable()", () => {
  it("passes when element is an enabled textfield by role", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeEditable({ timeout: 50 });
  });

  it("passes when element is an enabled EditText by className", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "",
        className: "android.widget.EditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeEditable({ timeout: 50 });
  });

  it("passes with Material TextInputEditText", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "com.google.android.material.textfield.TextInputEditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeEditable({ timeout: 50 });
  });

  it("fails when element is not a textfield", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "button",
        className: "android.widget.Button",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeEditable({ timeout: 50 }),
    ).rejects.toThrow("to be editable");
  });

  it("fails when textfield is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: false,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeEditable({ timeout: 50 }),
    ).rejects.toThrow("to be editable");
  });

  it("not.toBeEditable() passes when element is not editable", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "button",
        className: "android.widget.Button",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeEditable({ timeout: 50 });
  });

  it("not.toBeEditable() passes when textfield is disabled (read-only)", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: false,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeEditable({ timeout: 50 });
  });

  it("not.toBeEditable() fails when element is editable", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeEditable({ timeout: 50 }),
    ).rejects.toThrow("NOT to be editable");
  });
});

// ─── toBeInViewport() (PILOT-41) ───

describe("toBeInViewport()", () => {
  it("passes when element is in viewport", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 1.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeInViewport({ timeout: 50 });
  });

  it("passes when element is partially in viewport", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.3 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeInViewport({ timeout: 50 });
  });

  it("passes with ratio option when ratio is sufficient", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.75 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).toBeInViewport({ timeout: 50, ratio: 0.5 });
  });

  it("fails when element is not in viewport", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeInViewport({ timeout: 50 }),
    ).rejects.toThrow("to be in viewport");
  });

  it("fails when ratio is below required threshold", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.3 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeInViewport({ timeout: 50, ratio: 0.5 }),
    ).rejects.toThrow("to be in viewport");
  });

  it("includes ratio info in error message when ratio specified", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.2 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeInViewport({ timeout: 50, ratio: 0.5 }),
    ).rejects.toThrow("ratio >= 0.5");
  });

  it("not.toBeInViewport() passes when element is off-screen", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.toBeInViewport({ timeout: 50 });
  });

  it("not.toBeInViewport() fails when element is on-screen", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 1.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeInViewport({ timeout: 50 }),
    ).rejects.toThrow("NOT to be in viewport");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      tapsmithExpect(handle).toBeInViewport({ timeout: 50 }),
    ).rejects.toThrow("to be in viewport");
  });
});

// ─── Timeout and polling ───

describe("polling behavior", () => {
  it("retries until element becomes visible within timeout", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: callCount >= 3 }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, _text("delayed"), 2000);
    await tapsmithExpect(handle).toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("propagates client errors immediately instead of polling past them", async () => {
    // Mirrors the action path (_waitForEnabled): infrastructure failures
    // surface with their real cause rather than burning the assertion
    // timeout into a misleading "expected to be visible" message.
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      throw new Error("connection error");
    });
    const handle = makeHandle(client, _text("retry"), 2000);
    const start = Date.now();
    await vitestExpect(
      tapsmithExpect(handle).toBeVisible({ timeout: 2000 }),
    ).rejects.toThrow("connection error");
    vitestExpect(callCount).toBe(1);
    vitestExpect(Date.now() - start).toBeLessThan(1_000);
  });

  it("uses handle timeout when no explicit timeout given", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client, _text("test"), 500);
    // Should not throw - uses the 500ms handle timeout
    await tapsmithExpect(handle).toBeVisible();
  });

  it("retries toBeChecked until condition is met", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ checked: callCount >= 3 }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, _text("toggle"), 2000);
    await tapsmithExpect(handle).toBeChecked({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ─── Negated polling (fast-path) ───

describe("negated assertion polling", () => {
  it("not.toBeVisible() returns immediately when element is not visible", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: false }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, _text("hidden"), 5000);
    const start = Date.now();
    await tapsmithExpect(handle).not.toBeVisible({ timeout: 5000 });
    const elapsed = Date.now() - start;
    // Should return almost immediately, well under the 5s timeout
    vitestExpect(elapsed).toBeLessThan(2000);
    vitestExpect(callCount).toBeLessThanOrEqual(3);
  });

  it("not.toBeVisible() polls until element disappears", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      // Visible for first 2 calls, then hidden
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: callCount < 3 }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, _text("disappearing"), 2000);
    await tapsmithExpect(handle).not.toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("not.toBeVisible() fails if element stays visible past timeout", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client, _text("sticky"), 300);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeVisible({ timeout: 300 }),
    ).rejects.toThrow("NOT to be visible");
  });

  it("not.toBeChecked() returns immediately when unchecked", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ checked: false }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, _text("switch"), 5000);
    const start = Date.now();
    await tapsmithExpect(handle).not.toBeChecked({ timeout: 5000 });
    const elapsed = Date.now() - start;
    vitestExpect(elapsed).toBeLessThan(2000);
    vitestExpect(callCount).toBeLessThanOrEqual(3);
  });

  it("not.toExist() returns immediately when element does not exist", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: false,
        element: undefined as unknown as ElementInfo,
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, _text("gone"), 5000);
    const start = Date.now();
    await tapsmithExpect(handle).not.toExist({ timeout: 5000 });
    const elapsed = Date.now() - start;
    vitestExpect(elapsed).toBeLessThan(2000);
    vitestExpect(callCount).toBeLessThanOrEqual(3);
  });
});

// ─── Double negation ───

describe("double negation", () => {
  it("not.not behaves like positive assertion", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.not.toBeVisible({ timeout: 50 });
  });

  it("not.not works for new assertions too", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await tapsmithExpect(handle).not.not.toBeChecked({ timeout: 50 });
  });
});

// ─── wrapAssertionWithTrace ───

describe("wrapAssertionWithTrace", () => {
  function makeTracedHandle(
    client: TapsmithGrpcClient,
    collector: {
      captureBeforeAction: ReturnType<typeof vi.fn>;
      captureAfterAction: ReturnType<typeof vi.fn>;
      addAssertionEvent: ReturnType<typeof vi.fn>;
    },
  ): ElementHandle {
    const traceCapture = {
      collector,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
    };
    return new ElementHandle(client, _text("Traced"), 100, {
      traceCapture: traceCapture as unknown as import("../trace/trace-collector.js").TraceCapture,
    });
  }

  function makeMockCollector() {
    return {
      config: { screenshots: false, snapshots: false, sources: false, attachments: false, network: false, mode: 'on' as const },
      captureBeforeAction: vi.fn(async () => ({
        actionIndex: 0,
        captures: {},
      })),
      captureAfterAction: vi.fn(async () => ({})),
      addAssertionEvent: vi.fn(),
      _emitAssertionStarted: vi.fn(),
      setPendingOperation: vi.fn(),
      clearPendingOperation: vi.fn(),
      trackPendingCapture: vi.fn(),
    };
  }

  it("emits a passing assertion event when tracing is active", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).toBeVisible({ timeout: 50 });

    vitestExpect(collector.addAssertionEvent).toHaveBeenCalledTimes(1);
    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.assertion).toBe("toBeVisible");
    vitestExpect(event.passed).toBe(true);
    vitestExpect(event.negated).toBe(false);
    vitestExpect(event.soft).toBe(false);
  });

  it("emits a failing assertion event when tracing is active", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await vitestExpect(
      tapsmithExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("to be visible");

    vitestExpect(collector.addAssertionEvent).toHaveBeenCalledTimes(1);
    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.assertion).toBe("toBeVisible");
    vitestExpect(event.passed).toBe(false);
    vitestExpect(event.error).toBeDefined();
  });

  it("emits negated assertion event for not.toBeVisible()", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).not.toBeVisible({ timeout: 50 });

    vitestExpect(collector.addAssertionEvent).toHaveBeenCalledTimes(1);
    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.assertion).toBe("not.toBeVisible");
    vitestExpect(event.negated).toBe(true);
    vitestExpect(event.passed).toBe(true);
  });

  it("captures before screenshot (no after — viewer uses next action's before)", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).toBeVisible({ timeout: 50 });

    vitestExpect(collector.captureBeforeAction).toHaveBeenCalledTimes(1);
    vitestExpect(collector.captureAfterAction).not.toHaveBeenCalled();
  });

  it("records bounds for a visible element", async () => {
    const bounds = { left: 10, top: 20, right: 110, bottom: 60 };
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true, bounds }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).toBeVisible({ timeout: 50 });

    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.bounds).toEqual(bounds);
  });

  it("records no bounds when the element is present but hidden (toBeHidden)", async () => {
    // findElement matches hidden elements with a real frame — a passing
    // toBeHidden must not carry that rectangle into the trace, or the viewer
    // draws a box over empty space where the element used to be.
    const bounds = { left: 10, top: 20, right: 110, bottom: 60 };
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false, bounds }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).toBeHidden({ timeout: 50 });

    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.passed).toBe(true);
    vitestExpect(event.bounds).toBeUndefined();
  });

  it("does not fall back to stale before-bounds when the element is removed", async () => {
    // Element is visible when the assertion starts (before-bounds captured),
    // then removed from the hierarchy — the passing toBeHidden must record no
    // bounds instead of the pre-removal position.
    const bounds = { left: 10, top: 20, right: 110, bottom: 60 };
    const collector = makeMockCollector();
    let findElementCalls = 0;
    const client = makeMockClient(
      async () => {
        findElementCalls += 1;
        return findElementCalls === 1
          ? {
              requestId: "1",
              found: true,
              element: makeElementInfo({ visible: true, bounds }),
              errorMessage: "",
            }
          : { requestId: "1", found: false, errorMessage: "" };
      },
      async () => ({ requestId: "1", elements: [], errorMessage: "" }),
    );
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).toBeHidden({ timeout: 50 });

    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.passed).toBe(true);
    vitestExpect(event.bounds).toBeUndefined();
  });

  it("records no bounds when the post-assertion lookup errors", async () => {
    // A transient lookup failure after a passing toBeHidden must not
    // resurrect the pre-assertion bounds — a missing box beats a stale one.
    const bounds = { left: 10, top: 20, right: 110, bottom: 60 };
    const collector = makeMockCollector();
    let findElementCalls = 0;
    const client = makeMockClient(
      async () => {
        findElementCalls += 1;
        if (findElementCalls > 1) throw new Error("agent connection lost");
        return {
          requestId: "1",
          found: true,
          element: makeElementInfo({ visible: true, bounds }),
          errorMessage: "",
        };
      },
      async () => ({ requestId: "1", elements: [], errorMessage: "" }),
    );
    const handle = makeTracedHandle(client, collector);

    await tapsmithExpect(handle).toBeHidden({ timeout: 50 });

    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.passed).toBe(true);
    vitestExpect(event.bounds).toBeUndefined();
  });
});

// ─── Strict mode (PILOT-226) ───

describe("strict mode for assertions", () => {
  const twoMatches = [
    makeElementInfo({ elementId: "el-1", text: "Sign in to continue", visible: true }),
    makeElementInfo({ elementId: "el-2", text: "Sign in", visible: true }),
  ];

  function makeMultiMatchClient(elements: ElementInfo[]): TapsmithGrpcClient {
    return makeMockClient(
      async () => ({
        requestId: "1",
        found: elements.length > 0,
        element: elements[0],
        errorMessage: "",
      }),
      async () => ({ requestId: "1", elements, errorMessage: "" }),
    );
  }

  it("toBeVisible throws StrictModeViolationError immediately on multiple matches", async () => {
    const client = makeMultiMatchClient(twoMatches);
    const handle = makeHandle(client, _text("Sign in"), 5_000);
    const start = Date.now();
    await vitestExpect(
      tapsmithExpect(handle).toBeVisible({ timeout: 5_000 }),
    ).rejects.toThrow(/^strict mode violation/);
    // Must not burn the assertion timeout polling
    vitestExpect(Date.now() - start).toBeLessThan(2_000);
  });

  it("toHaveText throws on multiple matches", async () => {
    const client = makeMultiMatchClient(twoMatches);
    const handle = makeHandle(client, _text("Sign in"), 5_000);
    await vitestExpect(
      tapsmithExpect(handle).toHaveText("Sign in", { timeout: 5_000 }),
    ).rejects.toThrow(/^strict mode violation/);
  });

  it(".first() disambiguates for assertions (positional modifiers honored)", async () => {
    const client = makeMultiMatchClient(twoMatches);
    const handle = makeHandle(client, _text("Sign in"), 1_000);
    await tapsmithExpect(handle.first()).toBeVisible({ timeout: 1_000 });
    await tapsmithExpect(handle.nth(1)).toHaveText("Sign in", { timeout: 1_000 });
    await tapsmithExpect(handle.last()).toHaveText("Sign in", { timeout: 1_000 });
  });

  it("not.toBeVisible is an absence check — no strict throw, passes when all hidden", async () => {
    const hidden = twoMatches.map((el) => ({ ...el, visible: false }));
    const client = makeMultiMatchClient(hidden);
    const handle = makeHandle(client, _text("Sign in"), 200);
    await tapsmithExpect(handle).not.toBeVisible({ timeout: 200 });
  });

  it("not.toBeVisible fails (without strict throw) while any match is visible", async () => {
    const client = makeMultiMatchClient(twoMatches);
    const handle = makeHandle(client, _text("Sign in"), 200);
    await vitestExpect(
      tapsmithExpect(handle).not.toBeVisible({ timeout: 200 }),
    ).rejects.toThrow("NOT to be visible");
  });

  it("toBeHidden evaluates over all matches without strict throw", async () => {
    const hidden = twoMatches.map((el) => ({ ...el, visible: false }));
    await tapsmithExpect(makeHandle(makeMultiMatchClient(hidden), _text("Sign in"), 200)).toBeHidden({ timeout: 200 });
    // One of two still visible → not hidden
    const oneVisible = [twoMatches[0], { ...twoMatches[1], visible: false }];
    await vitestExpect(
      tapsmithExpect(makeHandle(makeMultiMatchClient(oneVisible), _text("Sign in"), 200)).toBeHidden({ timeout: 200 }),
    ).rejects.toThrow("to be hidden");
  });

  it("not.toExist is exempt from strict mode", async () => {
    const client = makeMultiMatchClient(twoMatches);
    const handle = makeHandle(client, _text("Sign in"), 200);
    await vitestExpect(
      tapsmithExpect(handle).not.toExist({ timeout: 200 }),
    ).rejects.toThrow("NOT to exist");
  });

  it("toHaveCount is exempt from strict mode", async () => {
    const client = makeMultiMatchClient(twoMatches);
    const handle = makeHandle(client, _text("Sign in"), 1_000);
    await tapsmithExpect(handle).toHaveCount(2, { timeout: 1_000 });
  });
});

describe("assertion probe timeouts (PR #124 review)", () => {
  it("and() operands resolve with the short poll timeout, not the handle timeout", async () => {
    const timeouts: number[] = [];
    const client = {
      findElement: vi.fn(async () => ({ requestId: "1", found: false, errorMessage: "" })),
      findElements: vi.fn(async (_sel: unknown, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        return { requestId: "1", elements: [makeElementInfo({ visible: true })], errorMessage: "" };
      }),
    } as unknown as TapsmithGrpcClient;
    const a = new ElementHandle(client, _text("A"), 30_000);
    const b = new ElementHandle(client, _text("B"), 30_000);
    await tapsmithExpect(a.and(b)).toBeVisible({ timeout: 1_000 });
    vitestExpect(timeouts.length).toBeGreaterThan(0);
    for (const t of timeouts) {
      vitestExpect(t).toBeLessThanOrEqual(500);
    }
  });
});

// ─── Transient agent-command timeout handling ───

describe("transient agent-command timeout handling (slow-emulator flake regression)", () => {
  // The daemon stamps this when the on-device agent is alive but too slow to
  // answer a findElements this tick (e.g. an uninterruptible hierarchy dump on
  // a loaded CI emulator). Assertions retry it within their budget instead of
  // failing on the first slow tick.
  const AGENT_TIMEOUT_MSG = "Agent command timed out after 5.25s";

  it("toBeVisible() retries through a transient agent timeout and then passes", async () => {
    let calls = 0;
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => {
        calls++;
        return calls < 2
          ? { requestId: "1", elements: [], errorMessage: AGENT_TIMEOUT_MSG }
          : { requestId: "1", elements: [makeElementInfo({ visible: true })], errorMessage: "" };
      },
    );
    const handle = makeHandle(client, _text("Hello"), 5000);
    await tapsmithExpect(handle).toBeVisible({ timeout: 1000 });
    vitestExpect(calls).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a persistent agent timeout as the infra error, not a generic assertion failure", async () => {
    const client = makeMockClient(
      async () => ({ requestId: "1", found: false, errorMessage: "" }),
      async () => ({ requestId: "1", elements: [], errorMessage: AGENT_TIMEOUT_MSG }),
    );
    const handle = makeHandle(client, _text("Hello"), 300);
    await vitestExpect(
      tapsmithExpect(handle).toBeVisible({ timeout: 300 }),
    ).rejects.toThrow(/Agent command timed out/);
  });
});
