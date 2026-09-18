import { describe, expect, test } from "../fixtures.js";

describe("List screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list");
  });

  // ─── Element Counting ───

  test("shows item count", async ({ listScreen }) => {
    await expect(listScreen.itemCount).toHaveText("30 items");
  });

  test("shows initial selected count", async ({ listScreen }) => {
    await expect(listScreen.selectedCount).toContainText("0 selected");
  });

  // ─── Positional Selection ───

  test("first() selects the first matching element", async ({ listScreen }) => {
    const info = listScreen.allItems.first();
    await expect(info).toHaveText("Item 1");
  });

  test("nth() selects item at specific index", async ({ listScreen }) => {
    const items = await listScreen.allItems.all();
    expect(items.length).toBeGreaterThan(1);
    const secondText = await items[1].getText();
    expect(secondText.length).toBeGreaterThan(0);
  });

  // ─── Filter ───

  test("filter({ hasNotText }) excludes matches", async ({ device }) => {
    const nonPremium = device
      .getByText("Item")
      .filter({ hasNotText: "Premium" });
    const count = await nonPremium.count();
    expect(count).toBeGreaterThan(0);
  });

  // ─── Selection ───

  test("tapping an item selects and deselects it", async ({ listScreen }) => {
    await listScreen.firstItem.tap();
    await expect(listScreen.selectedCount).toContainText("1 selected");

    await listScreen.firstItem.tap();
    await expect(listScreen.selectedCount).toContainText("0 selected");
  });

  // ─── all() ───

  test("all() returns array of element handles", async ({ listScreen }) => {
    const items = await listScreen.allItems.all();
    expect(items.length).toBeGreaterThan(0);
    const firstText = await items[0].getText();
    expect(firstText.length).toBeGreaterThan(0);
  });
});

// PILOT-349: and()/or() combine two separate hierarchy reads, and both agents
// mint a fresh elementId on every read. Keyed by id, and() was always empty
// and or() kept a shared match twice (a strict-mode violation on any
// single-element use) — on every device, for as long as the API existed. The
// unit mocks reuse ids across reads, so this is the only place the real
// contract is exercised: the operands must be combined by what is stable
// within one hierarchy (bounds + text), and this file is where that shows.
describe("List screen — and()/or() on a device", () => {
  // Before the all() describe on purpose: that one leaves focus in the search
  // box (Android's keyboard then covers the lower rows) and, on iOS, the list
  // scrolled a few rows — where XCUITest still reports the scrolled-off rows
  // as visible at frames under the header, so a tap on one lands on the
  // header instead (PILOT-223, PILOT-348). Here the list is as the deep link
  // mounted it.
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list");
  });

  test("and() intersects its operands", async ({ device, listScreen }) => {
    // getByRole("button") alone is ambiguous (every rendered row, plus the
    // header's back button); intersected with one row's label it is that row.
    const row = device.getByRole("button").and(listScreen.item(2));
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    // Disjoint operands: the item-count text is not a button.
    await expect(device.getByRole("button").and(listScreen.itemCount)).toHaveCount(0);
  });

  test("an action through and() lands on the intersected element", async ({ device, listScreen }) => {
    const row = device.getByRole("button").and(listScreen.item(2));
    await row.tap();
    await expect(listScreen.selectedCount).toContainText("1 selected");
    await row.tap(); // deselect, leave the screen as we found it
    await expect(listScreen.selectedCount).toContainText("0 selected");
  });

  test("or() unites its operands without duplicating a shared match", async ({ device, listScreen }) => {
    // The same row reached through two different selectors is ONE match, so
    // a single-element use of the union is not a strict-mode violation.
    const sameRow = listScreen.item(2).or(device.getByTestId("item-2"));
    await expect(sameRow).toHaveCount(1);
    await expect(sameRow).toBeVisible();
    // Distinct rows add up.
    await expect(listScreen.item(2).or(listScreen.item(3))).toHaveCount(2);
  });
});

// PILOT-287 follow-up: the all() snapshot contract, on a device. Handles from
// all() answer from the capture they were created from, children scoped off
// them resolve the row LIVE by index (like .nth(i)), and expect() re-queries.
// Pinned here because the follow-up tickets (PILOT-344/345/346/347) edit
// exactly this code; PILOT-346 (live all()) is expected to rewrite this test
// deliberately, not to make it pass by accident.
describe("List screen — all() snapshot semantics", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list")
  })

  test("a check on rows[i] and an action on rows[i] address the same captured row", async ({ device, listScreen }) => {
    // FlatList virtualises: only the rendered window (~10 rows) is in the tree.
    const rows = device.getByRole("button")
    const captured = await rows.all()
    expect(captured.length).toBeGreaterThanOrEqual(5)

    // Snapshot readers: no re-query, so a check and the action it guards agree.
    expect(await captured[2].isVisible()).toBe(true)
    expect(await captured[2].isEnabled()).toBe(true)
    await captured[2].tap()
    await expect(listScreen.selectedCount).toContainText("1 selected")
    await captured[2].tap() // deselect, leave the screen as we found it
    await expect(listScreen.selectedCount).toContainText("0 selected")
  })

  test("a captured handle keeps answering from its capture; expect() and nth() see the live list", async ({ device, listScreen }) => {
    // Android merges a button's children into one accessibility node, so the
    // rows here have no separately addressable children; the live-by-index
    // rule for scoped children (rows[i].getByRole(…)) is unit-tested.
    const rows = device.getByRole("button")
    const captured = await rows.all()
    expect(captured.length).toBeGreaterThanOrEqual(5)
    // Buttons include the header's back button, so locate Item 2 by text.
    const texts = await Promise.all(captured.map((h) => h.getText()))
    const idx = texts.findIndex((t) => t.includes("Item 2"))
    expect(idx).toBeGreaterThan(0)

    // Filter the list down to Item 3 and Item 30.
    const search = device.getByTestId("search-input")
    await search.type("Item 3")
    await expect(listScreen.itemCount).toHaveText("2 items")
    try {
      // The captured handle still answers from its capture (documented; live
      // all() is PILOT-346) …
      expect(await captured[idx].isVisible()).toBe(true)
      expect(await captured[idx].getText()).toContain("Item 2")
      // … while expect() and .nth() re-query by index: that index now holds
      // Item 3 or Item 30, and the captured last index is gone from the screen.
      await expect(rows.nth(idx)).toContainText("Item 3")
      await expect(rows.nth(idx)).not.toContainText("Item 2")
      await expect(captured[idx]).toBeVisible()
      await expect(captured[captured.length - 1]).not.toBeVisible()
      expect(await rows.nth(captured.length - 1).isHidden()).toBe(true)
    } finally {
      await search.clear()
      await expect(listScreen.itemCount).toHaveText("30 items")
    }
  })
})

// PILOT-345: scrollIntoView() judges visibility against the element the
// locator actually denotes — filter/and/or/scope and the positional index all
// apply — not against the raw selector's first match.
//
// Last in the file on purpose: it leaves the list scrolled, and scrolling back
// with `scrollIntoView({ direction: "down" })` is not reliable here (a
// screen-wide "down" swipe at the default distance starts above this FlatList,
// on the item-count text — PILOT-348). The per-file app reset restores the
// screen for the next file.
describe("List screen — scrollIntoView on a modified locator", () => {
  // The swipes, settle sleeps and probe reads inside scrollIntoView() are not
  // progress-tracked, so they all count against the per-test timeout; on a
  // cold software-GPU CI emulator the ~3 s of fixed sleeps plus ~10 hierarchy
  // reads can approach the Android CI default of 15 s.
  test.use({ timeout: 45_000 })

  test("scrollIntoView() on a filtered locator scrolls to THAT row", async ({ device, listScreen }) => {
    // Establish the precondition inside the test, not in beforeAll, so a CI
    // retry cannot pass trivially against an already-scrolled list. A process
    // restart mounts the screen fresh on both platforms (list at the top,
    // search box empty, keyboard closed — the previous describe leaves focus
    // in the search box, and with the keyboard up a screen-wide "up" swipe
    // glide-types into it, PILOT-348). Re-opening the deep link alone is not
    // enough: it resets neither scroll nor focus, and `forceColdLaunch` only
    // applies to iOS simulators.
    // fallback: false — a restart that fails must fail THIS test, not quietly
    // escalate to a data clear that signs the app out for the rest of the shard.
    await device.resetApp({ mode: "restart", fallback: false })
    await device.openDeepLink("tapsmithtest:///list")
    await expect(listScreen.itemCount).toHaveText("30 items")

    // getByRole("button") alone is ambiguous (every rendered row, plus the
    // header's back button). Before the fix the scroll probe read that raw
    // selector, so this threw a strict-mode violation — or, for a raw selector
    // whose single visible match the filter excluded, reported "already
    // visible" and never swiped. Item 25 starts below the fold (the FlatList
    // may not even have rendered it yet) — assert it is not visible first, so
    // the scroll below is known to have been exercised.
    // Pin the locator shape first: a visible row through the same shape, so a
    // later "not visible after N scroll(s)" cannot be a platform text-exposure
    // mismatch masquerading as a scroll regression. Word-bounded: hasText is a
    // substring match and iOS mounts Items 10-19 into the tree straight away.
    await expect(device.getByRole("button").filter({ hasText: /\bItem 1\b/ })).toBeVisible()
    const row = device.getByRole("button").filter({ hasText: "Item 25" })
    await expect(row).not.toBeVisible()
    // ~15 rows of travel; 5 default swipes cover it about twice over on both CI
    // form factors, but the budget is not what this test is about.
    await row.scrollIntoView({ maxScrolls: 8 })
    await expect(row).toBeVisible()
  })
})
