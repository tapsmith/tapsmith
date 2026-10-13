/**
 * The hint a role-only miss carries on iOS for roles React Native publishes
 * nothing for there (PILOT-718): getByRole("alert") can't find RN's alert
 * Text on iOS, and used to fail with no clue why.
 */
import { describe, it, expect as vitestExpect, vi } from "vitest";
import { expect as tapsmithExpect } from "../expect.js";
import { Device } from "../device.js";
import { iosUnnamedRoleMissHint } from "../roles.js";
import type { ElementInfo, TapsmithGrpcClient } from "../grpc-client.js";

const HINT = /On iOS, React Native publishes no "alert" role that getByRole\("alert"\) can see without a name: pass the element's name — getByRole\("alert", \{ name: "…" \}\) — or use getByText\(\) or getByTestId\(\)\.$/;

function emptyClient(): TapsmithGrpcClient {
  return {
    findElement: vi.fn(async () => ({ requestId: "1", found: false, errorMessage: "" })),
    findElements: vi.fn(async (): Promise<{ requestId: string; elements: ElementInfo[]; errorMessage: string }> =>
      ({ requestId: "1", elements: [], errorMessage: "" })),
  } as unknown as TapsmithGrpcClient;
}

const device = (platform: "ios" | "android") =>
  new Device(emptyClient(), { platform, timeout: 50 });

describe("iosUnnamedRoleMissHint()", () => {
  const role = (r: string, name = "") => ({ role: r, name });

  it("explains an unnamed alert, combobox or RN generic-view role on iOS", () => {
    vitestExpect(iosUnnamedRoleMissHint(role("alert"), "ios")).toMatch(HINT);
    for (const r of ["combobox", "menuitem", "timer", "Alert"]) {
      vitestExpect(iosUnnamedRoleMissHint(role(r), "ios"), r).toContain(`getByRole(${JSON.stringify(r)}, { name: "…" })`);
    }
  });

  it("says nothing for a named query, another platform, or a role iOS can see", () => {
    vitestExpect(iosUnnamedRoleMissHint(role("alert", "Failed"), "ios")).toBe("");
    vitestExpect(iosUnnamedRoleMissHint({ role: "alert", name: "", nameRegex: { source: "x", flags: "" } }, "ios")).toBe("");
    vitestExpect(iosUnnamedRoleMissHint(role("alert"), "android")).toBe("");
    vitestExpect(iosUnnamedRoleMissHint(role("alert"), undefined)).toBe("");
    // tablist: the agent matches a native tab bar without a name.
    for (const r of ["button", "checkbox", "radio", "heading", "text", "tablist"]) {
      vitestExpect(iosUnnamedRoleMissHint(role(r), "ios"), r).toBe("");
    }
  });
});

describe("a role-only miss on iOS carries the hint", () => {
  it("in toBeVisible and toHaveCount failures", async () => {
    await vitestExpect(tapsmithExpect(device("ios").getByRole("alert")).toBeVisible({ timeout: 50 }))
      .rejects.toThrow(HINT);
    await vitestExpect(tapsmithExpect(device("ios").getByRole("alert")).toHaveCount(1, { timeout: 50 }))
      .rejects.toThrow(HINT);
  });

  it("in an action's not-found error, through first() and scoping", async () => {
    const d = device("ios");
    await vitestExpect(d.getByRole("alert").tap()).rejects.toThrow(HINT);
    await vitestExpect(d.getByRole("alert").first().find()).rejects.toThrow(HINT);
    await vitestExpect(d.getByTestId("screen").getByRole("alert").find()).rejects.toThrow(HINT);
    await vitestExpect(d.getByTestId("screen").first().getByRole("alert").find()).rejects.toThrow(HINT);
  });

  it("in toExist and waitFor failures", async () => {
    await vitestExpect(tapsmithExpect(device("ios").getByRole("alert")).toExist({ timeout: 50 }))
      .rejects.toThrow(HINT);
    await vitestExpect(device("ios").getByRole("alert").waitFor({ timeout: 50 })).rejects.toThrow(HINT);
    await vitestExpect(device("ios").getByRole("alert").waitFor({ state: "attached", timeout: 50 })).rejects.toThrow(HINT);
  });

  it("not when the query found an element that isn't visible", async () => {
    const hiddenAlert: ElementInfo = {
      elementId: "a", className: "XCUIElementTypeOther", text: "Saved", contentDescription: "", resourceId: "",
      enabled: true, visible: false, clickable: false, focusable: false, scrollable: false, hint: "",
      checked: false, selected: false, focused: false, role: "", viewportRatio: 0,
    };
    const client = {
      findElement: vi.fn(async () => ({ requestId: "1", found: true, element: hiddenAlert, errorMessage: "" })),
      findElements: vi.fn(async () => ({ requestId: "1", elements: [hiddenAlert], errorMessage: "" })),
    } as unknown as TapsmithGrpcClient;
    const d = new Device(client, { platform: "ios", timeout: 50 });
    const err = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
    const visible = await err(tapsmithExpect(d.getByRole("alert")).toBeVisible({ timeout: 50 }));
    vitestExpect(visible).toContain("to be visible, but it was not");
    vitestExpect(visible).not.toContain("On iOS");
    const waited = await err(d.getByRole("alert").waitFor({ timeout: 50 }));
    vitestExpect(waited).toContain('did not reach state "visible"');
    vitestExpect(waited).not.toContain("On iOS");
  });

  it("not on Android, nor for a named query", async () => {
    const err = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
    vitestExpect(await err(tapsmithExpect(device("android").getByRole("alert")).toBeVisible({ timeout: 50 })))
      .not.toContain("On iOS");
    vitestExpect(await err(tapsmithExpect(device("ios").getByRole("alert", { name: "Failed" })).toBeVisible({ timeout: 50 })))
      .not.toContain("On iOS");
  });
});
