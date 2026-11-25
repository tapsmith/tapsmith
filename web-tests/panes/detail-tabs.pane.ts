// Detail tabs — the bottom pane's Call / Log / Console / Source / Hierarchy /
// Locator / Network / Errors strip, plus the simple tab bodies. Network,
// Hierarchy and Locator are big enough to have panes of their own.
//
// Rendered by `src/trace-viewer/components/DetailTabs.tsx`, which UI mode
// imports, so this pane serves both apps.

import type { Page } from "@playwright/test"

export type DetailTab =
  | "Call"
  | "Log"
  | "Console"
  | "Source"
  | "Hierarchy"
  | "Locator"
  | "Network"
  | "Errors"

export class DetailTabsPane {
  constructor(private page: Page) {}

  get tabList() {
    return this.page.getByRole("tablist", { name: "Trace details" })
  }

  /** Matched on the leading label — Network and Errors carry a count too. */
  tab(name: DetailTab) {
    return this.tabList.getByRole("tab", { name: new RegExp(`^${name}\\b`) })
  }

  async select(name: DetailTab) {
    await this.tab(name).click()
  }

  /** Shown by whichever tab has nothing to display. */
  get noContent() {
    return this.page.getByTestId("no-content")
  }

  // ─── Call ───
  //
  // A CSS grid of alternating label/value cells rather than rows, so assertions
  // read the grid's contents rather than addressing individual pairs.

  get callGrid() {
    return this.page.getByTestId("call-grid")
  }

  // ─── Console ───

  get consoleSearch() {
    return this.page.getByRole("textbox", { name: "Filter console output" })
  }

  get consoleOutput() {
    return this.page.getByRole("log", { name: "Console output" })
  }

  get consoleEntries() {
    return this.page.getByTestId("log-entry")
  }

  get consoleTimestamps() {
    return this.page.getByTestId("log-time")
  }

  get consoleMessages() {
    return this.page.getByTestId("log-message")
  }

  /** A sortable column header; the active one reports `aria-pressed` and `data-sort-direction`. */
  consoleColumnHeader(name: "Time" | "Level" | "Source" | "Device" | "Message") {
    return this.page.getByRole("group", { name: "Sort console output" }).getByRole("button", { name })
  }

  get consoleColumnHeaders() {
    return this.page.getByRole("group", { name: "Sort console output" }).getByRole("button")
  }

  consoleTimeMode(mode: "relative" | "absolute") {
    return this.page.getByRole("group", { name: "Timestamp format" }).getByRole("button", { name: mode })
  }

  /** Per-device filter pill, shown when console lines came from more than one device. */
  consoleDevicePill(device: string) {
    return this.page.getByTestId("console-device-pill").filter({ hasText: device })
  }

  // ─── Hierarchy (multi-device) ───

  /** Which device's tree the Hierarchy tab shows; `aria-pressed` marks the shown one. */
  hierarchyDevicePill(device: string) {
    return this.page.getByRole("group", { name: "Hierarchy device" }).getByRole("button", { name: device, exact: true })
  }

  // ─── Source ───

  get sourceFilename() {
    return this.page.getByTestId("source-filename")
  }

  get sourceLines() {
    return this.page.getByTestId("source-line")
  }

  /**
   * The line the selected action came from. Marked `aria-current` rather than
   * only coloured, so it is addressable and audible.
   */
  get highlightedSourceLine() {
    return this.sourceLines.and(this.page.locator('[aria-current="true"]'))
  }

  /** A source line by its 1-based number. */
  sourceLine(number: number) {
    return this.page.locator(`[data-testid="source-line"][data-line="${number}"]`)
  }

  /**
   * A call-stack frame, shown when an event carries more than one. Matched on a
   * pattern rather than a literal name: the filename and the line live in
   * separate spans, so accessible-name computation joins them with a space the
   * visible text does not have ("gestures.test.ts :5").
   */
  stackFrame(fileName: string, line: number) {
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return this.page.getByRole("button", { name: new RegExp(`^${escaped}\\s*:${line}$`) })
  }

  // ─── Errors ───

  get errorEntries() {
    return this.page.getByTestId("error-entry")
  }

  /** Steps that passed with a warning, listed under a failed test's errors. */
  get warningEntries() {
    return this.page.getByTestId("warning-entry")
  }
}
