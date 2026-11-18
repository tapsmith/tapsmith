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

  // ─── Device frames ───

  /**
   * The bezel around the screenshot. `data-frame` names the frame (`photo`,
   * `photo-landscape`, `phone`, `compact`, `tablet`, `foldable-outer`,
   * `foldable-inner`) or `css` for the CSS skin.
   */
  get bezel() {
    return this.page.getByTestId("screenshot-bezel")
  }

  paneBezel(device: string) {
    return this.pane(device).getByTestId("screenshot-bezel")
  }

  /**
   * How the screenshot sits in its frame: how much of the frame's screen
   * window it covers per axis (0–1), and whether the frame image covers the
   * whole frame box (a turned landscape photo must, once turned).
   */
  async frameFit(bezel = this.bezel): Promise<{ width: number; height: number; imageFillsBox: boolean }> {
    return bezel.evaluate((el) => {
      const win = el.querySelector(".dm-frame-screen-rect")!.getBoundingClientRect()
      const shot = el.querySelector(".dm-frame-screen-rect > img")!.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      const png = el.querySelector(".dm-frame-png")!.getBoundingClientRect()
      const near = (a: number, b: number) => Math.abs(a - b) < 1
      return {
        width: shot.width / win.width,
        height: shot.height / win.height,
        imageFillsBox: near(png.left, box.left) && near(png.top, box.top) && near(png.width, box.width) && near(png.height, box.height),
      }
    })
  }

  // ─── Flows ───

  async selectStage(name: ScreenshotStage) {
    await this.stage(name).click()
  }
}
