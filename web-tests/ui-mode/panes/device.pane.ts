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

  /**
   * The bezel around the single mirror. Its `data-bezel` says which one:
   * `image` (photographic phone frame), `css-phone`, `css-tablet` or `none`.
   */
  get bezel() {
    return this.page.getByTestId("device-bezel").filter({ has: this.canvas })
  }

  /** The bezel around a grid tile's mirror. */
  bezelFor(workerLabel: string) {
    return this.page.getByTestId("device-bezel").filter({ has: this.mirrorFor(workerLabel) })
  }

  /**
   * How much of the bezel's screen opening the canvas covers, per axis (0–1).
   * The opening is the photo frame's screen window, or the CSS skin's content
   * box. A frame of the wrong shape letterboxes, so one axis drops well below 1.
   */
  async canvasFill(canvas = this.canvas): Promise<{ width: number; height: number }> {
    return canvas.evaluate((el) => {
      const bezel = el.closest("[data-bezel]") as HTMLElement | null
      if (!bezel) throw new Error("Mirror canvas has no bezel")
      const c = el.getBoundingClientRect()
      const window = bezel.querySelector(".dm-frame-screen-rect")
      let w: number
      let h: number
      if (window) {
        const r = window.getBoundingClientRect()
        w = r.width
        h = r.height
      } else {
        const r = bezel.getBoundingClientRect()
        const cs = getComputedStyle(bezel)
        w = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        h = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      }
      return { width: c.width / w, height: c.height / h }
    })
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
