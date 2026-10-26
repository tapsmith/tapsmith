// Device pane — the live screen mirror.
//
// Pick mode, worker views and mirror gestures are phase-2 surfaces; their
// locators go in alongside the specs that prove them, rather than sitting here
// unverified.

import type { Page } from "@playwright/test"

export class DevicePane {
  constructor(private page: Page) {}

  get root() {
    return this.page.getByRole("region", { name: "Live device mirror" })
  }

  get canvas() {
    return this.page.getByLabel("Device screen mirror", { exact: true })
  }

  /** Why there's no picture yet — "Waiting for device" / "Starting mirror…". */
  get mirrorStatus() {
    return this.page.getByTestId("mirror-status")
  }

  get mirrorStatusHint() {
    return this.page.getByTestId("mirror-status-hint")
  }

  /** One canvas per worker in the multi-device grid, named by worker. */
  mirrorFor(workerLabel: string) {
    return this.page.getByLabel(`Device screen mirror — ${workerLabel}`)
  }

  get pickToggle() {
    return this.page.getByRole("button", { name: /^(Pick an element|Picking element|Select a device tab)/ })
  }

  /** The element a pick at the pointer would take, outlined on the mirror while picking. */
  get pickHover() {
    return this.page.getByTestId("mirror-pick-hover")
  }

  get lockToggle() {
    return this.page.getByRole("button", { name: /^Interaction (locked|unlocked)/ })
  }

  // ─── Worker tabs ───

  get workerTabs() {
    return this.page.getByRole("tablist", { name: "Device views" })
  }

  workerTab(label: string) {
    return this.workerTabs.getByRole("tab", { name: label })
  }

  // ─── Flows ───

  async selectWorkerView(label: string) {
    await this.workerTab(label).click()
  }

  async enablePickMode() {
    await this.pickToggle.click()
  }

  /**
   * Click the mirror at a fractional position of its box, matching how the SPA
   * normalises pointer coordinates to 0–1 before sending a mirror command.
   */
  async tapMirrorAt(fractionX: number, fractionY: number) {
    const box = await this.canvas.boundingBox()
    if (!box) throw new Error("Device mirror canvas is not visible")
    await this.page.mouse.click(box.x + box.width * fractionX, box.y + box.height * fractionY)
  }
}
