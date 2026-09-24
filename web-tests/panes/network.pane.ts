// Network tab — the request list and its detail pane.
//
// The list is a real <table>, so rows and cells are addressable by their native
// roles with no extra hooks.

import type { Page } from "@playwright/test"

export type NetworkDetailTab = "Headers" | "Payload" | "Response" | "Timing"

export class NetworkPane {
  constructor(private page: Page) {}

  /** The warning shown when capture went through the host-wide macOS system proxy. */
  get hostWideNotice() {
    return this.page.getByRole("note").filter({ hasText: "macOS system proxy" })
  }

  get table() {
    return this.page.getByRole("table")
  }

  get search() {
    return this.page.getByRole("textbox", { name: "Filter network requests" })
  }

  /** Data rows only — `tbody` excludes the header row. */
  get rows() {
    return this.table.locator("tbody").getByRole("row")
  }

  /** A row by the request name shown in its first cell. */
  row(name: string) {
    return this.rows.filter({ hasText: name })
  }

  /** A filter pill; whether it is on is reported by `aria-pressed`. */
  pill(label: string) {
    return this.page.getByRole("button", { name: label, exact: true })
  }

  get columnHeaders() {
    return this.table.getByRole("columnheader")
  }

  // ─── Detail pane ───

  detailTab(name: NetworkDetailTab) {
    return this.page.getByRole("button", { name, exact: true })
  }

  get detailBody() {
    return this.page.getByTestId("net-detail-body")
  }

  /** The body toolbar's label — content type, or the decoder's verdict for a
   * gRPC/protobuf body (e.g. "gRPC · 2 messages"). */
  get bodyInfo() {
    return this.page.getByTestId("net-body-info")
  }

  /** Toggle between the decoded protobuf view and the raw bytes. Only rendered
   * for a body the decoder recognised.
   *
   * Addressed by testid, not by name: the JSON pretty-print toggle also reads
   * "Raw" while pretty is on, so a name-based locator matches that button too
   * and would silently drive the wrong control on a JSON body. */
  get decodeToggle() {
    return this.page.getByTestId("net-decode-toggle")
  }

  /** Toggle between pretty-printed and raw JSON. Only rendered for a JSON
   * content type, and never alongside {@link decodeToggle}. */
  get prettyToggle() {
    return this.page.getByRole("button", { name: /^(Pretty|Raw)$/ })
  }

  get detailClose() {
    return this.page.getByRole("button", { name: "Close", exact: true })
  }

  // ─── Flows ───

  async selectRow(name: string) {
    await this.row(name).click()
  }

  async openDetailTab(name: NetworkDetailTab) {
    await this.detailTab(name).click()
  }

  async filter(text: string) {
    await this.search.fill(text)
  }
}
