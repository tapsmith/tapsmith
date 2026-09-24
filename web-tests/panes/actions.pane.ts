// Actions panel — the per-test action list. Shared with the standalone trace
// viewer (`src/trace-viewer/components/ActionsPanel.tsx`).
//
// The list is addressed by test id rather than a listbox role: it interleaves
// group headers ("beforeAll Hooks", "Test") with the action rows, which a
// listbox may not contain, and it has no keyboard operability to justify one.

import type { Page } from "@playwright/test"

export class ActionsPane {
  constructor(private page: Page) {}

  get list() {
    return this.page.getByTestId("actions-list")
  }

  /** One row per traced action or assertion; group headers are not included. */
  get items() {
    return this.page.getByTestId("action-item")
  }

  /**
   * Section headers ("APP RESET", "BEFORE ALL", "TEST BODY", …). A group with
   * no visible rows renders no header, so this only lists sections with content.
   */
  get groups() {
    return this.page.getByTestId("action-group")
  }

  item(name: string) {
    return this.items.filter({ hasText: name })
  }

  get selectedItem() {
    return this.items.and(this.page.locator('[data-selected="true"]'))
  }

  /** Rows still awaiting their `lifecycle: "completed"` event. */
  get inProgressItems() {
    return this.items.and(this.page.locator('[aria-busy="true"]'))
  }

  /** The "Metadata" header tab (tests only — files and suites have no metadata). */
  get metadataTab() {
    return this.page.locator(".actions-header-tab", { hasText: "Metadata" })
  }

  /** The Isolation row of the Metadata tab: the reset mode and scope the test ran under. */
  get isolation() {
    return this.page.getByTestId("metadata-isolation")
  }

  /** The Network capture row of the Metadata tab: how the device's traffic was captured. */
  get networkRoute() {
    return this.page.getByTestId("metadata-network-route")
  }

  /** Per-row device badges — present only in a multi-device trace. */
  get deviceTags() {
    return this.page.getByTestId("action-device")
  }

  /** One Metadata-tab row per device of a multi-device trace. */
  get metadataDevices() {
    return this.page.getByTestId("metadata-device")
  }

  /**
   * Stands in for the list while the device is busy outside a traced action —
   * either the generic wait or, when the server reports one, the actual
   * operation in flight.
   */
  get preflightMessage() {
    return this.page.getByTestId("preflight-message")
  }
}
