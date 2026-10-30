// Top rail — result counts, elapsed timer, connection state.

import type { Page } from "@playwright/test"

export class RunControlsPane {
  constructor(private page: Page) {}

  // ─── Counts ───
  //
  // Located structurally and asserted on, rather than located by their text: a
  // text locator conflates the two, so a wrong count reports "element not
  // found" instead of showing what it actually said.

  get passedCount() {
    return this.page.getByTestId("count-passed")
  }

  get failedCount() {
    return this.page.getByTestId("count-failed")
  }

  get skippedCount() {
    return this.page.getByTestId("count-skipped")
  }

  /** Only rendered while a run is in flight. */
  get elapsed() {
    return this.page.getByRole("timer", { name: "Elapsed run time" })
  }

  // ─── Run failed ───

  /** Only rendered once at least one test has failed. */
  get rerunFailedButton() {
    return this.page.getByRole("button", { name: /Rerun Failed/ })
  }

  // ─── Connection ───

  /** Live region holding the device serial, or Connected/Disconnected. */
  get connection() {
    return this.page.getByRole("status", { name: "Device connection" })
  }

  /** One chip per device: a worker driving a group (`use.devices`) shows one per member. */
  get workerChips() {
    return this.page.getByTestId("worker-chip")
  }

  workerChip(displayName: string) {
    return this.workerChips.filter({ hasText: displayName })
  }

  /** Stands in for the device chips while the session's test workers start. */
  get workersStarting() {
    return this.page.getByTestId("workers-starting")
  }

  /** The short readiness word inside a chip ("ready", "preparing…", "stale"). */
  get readinessWords() {
    return this.page.getByTestId("worker-readiness")
  }

  /** Right-click menu on a worker chip. */
  workerMenu(workerId: number) {
    return this.page.getByRole("menu", { name: `Worker ${workerId} actions` })
  }

  get themeSelect() {
    return this.page.getByRole("combobox", { name: "Theme" })
  }

  // ─── Notifications ───
  //
  // The banner sits in the app chrome just below this rail. Deliberately located
  // by role and text rather than by an aria-label: naming a live region would
  // make assistive tech announce the label instead of the message.

  /**
   * The run notification banner. Errors render it as an assertive live region
   * and notices as a polite one, so `role` is worth asserting separately from
   * the message.
   */
  get notification() {
    return this.page.getByTestId("run-notification")
  }

  /** Server errors specifically — `alert` is unique to the error variant. */
  get errorBanner() {
    return this.page.getByRole("alert")
  }

  // ─── Flows ───

  async rerunFailed() {
    await this.rerunFailedButton.click()
  }

  /**
   * Fire a bare-key shortcut: `r` run-all, `f` run-failed, `Escape` stop,
   * `w` toggle-watch (see `keyboard-shortcuts.ts`). Pressed on `body` so no
   * input holds focus — the shortcuts are deliberately suppressed while typing.
   */
  async pressShortcut(key: string) {
    await this.page.locator("body").press(key)
  }
}
