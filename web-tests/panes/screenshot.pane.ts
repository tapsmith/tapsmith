// Screenshot panel — the captured screen for the selected action, and its
// before/action/after stages.

import type { Page } from "@playwright/test"

export type ScreenshotStage = "Action" | "Before" | "After"

export class ScreenshotPane {
  constructor(private page: Page) {}

  /** The screenshot itself; its alt text names the stage being shown. */
  get image() {
    return this.page.getByRole("img", { name: /^Screenshot / })
  }

  /** Shown when an action is selected but captured no screenshot. */
  get emptyState() {
    return this.page.getByTestId("screenshot-empty")
  }

  /** Shown when the trace has no screenshots at all. */
  get viewerEmpty() {
    return this.page.getByTestId("viewer-empty")
  }

  /** The box drawn around the element the selected step acted on or checked. */
  get elementBox() {
    return this.page.getByTestId("screenshot-element-box")
  }

  get stages() {
    return this.page.getByRole("tablist", { name: "Screenshot stage" })
  }

  stage(name: ScreenshotStage) {
    return this.stages.getByRole("tab", { name, exact: true })
  }

  /** The test name shown in the panel header. */
  get title() {
    return this.page.getByTestId("viewer-title")
  }

  // ─── Multi-device panes ───
  //
  // A trace recorded on a device group shows one pane per device instead of the
  // single image; `image` would then match several and trip strict mode.

  get panes() {
    return this.page.getByTestId("screenshot-pane")
  }

  /** One device's pane; `data-acting` / `data-active` report its role. */
  pane(device: string) {
    return this.panes.and(this.page.locator(`[data-device="${device}"]`))
  }

  paneImage(device: string) {
    return this.pane(device).getByRole("img", { name: /^Screenshot / })
  }

  /** The "acting" / "selected" role text under a pane's device name. */
  paneRole(device: string) {
    return this.pane(device).getByTestId("screenshot-pane-role")
  }

  // ─── Flows ───

  async selectStage(name: ScreenshotStage) {
    await this.stage(name).click()
  }
}
