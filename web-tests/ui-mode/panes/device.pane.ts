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
   * `image` (a frame image), `css-phone` / `css-tablet` (the CSS skin, if the
   * frame image fails to load) or `none`. An image bezel's `data-frame` names
   * the frame: `photo`, `photo-landscape`, `phone`, `compact`, `tablet`,
   * `foldable-outer` or `foldable-inner`.
   */
  get bezel() {
    return this.page.getByTestId("device-bezel").filter({ has: this.canvas })
  }

  /** The bezel around a grid tile's mirror. */
  bezelFor(workerLabel: string) {
    return this.page.getByTestId("device-bezel").filter({ has: this.mirrorFor(workerLabel) })
  }

  /**
   * How much of the bezel's screen opening the canvas covers, per axis (0–1),
   * and `shape`: the canvas box's aspect over the frame's. The opening is the
   * photo frame's screen window, or the CSS skin's content box. A frame of the
   * wrong shape letterboxes, so one axis drops well below 1; a canvas box that
   * lost the frame's shape letterboxes the picture inside it (shape ≠ 1), which
   * also skews tap mapping.
   */
  async canvasFill(canvas = this.canvas): Promise<{ width: number; height: number; shape: number }> {
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
      const frame = el as HTMLCanvasElement
      return { width: c.width / w, height: c.height / h, shape: (c.width / c.height) / (frame.width / frame.height) }
    })
  }

  /**
   * Whether the frame image covers the whole bezel box (a landscape photo
   * frame is the portrait image turned, so its box must match once turned).
   */
  async frameImageFillsBezel(canvas = this.canvas): Promise<boolean> {
    return canvas.evaluate((el) => {
      const bezel = el.closest("[data-bezel]")
      const img = bezel?.querySelector(".dm-frame-png")
      if (!bezel || !img) throw new Error("Mirror canvas has no frame image")
      const b = bezel.getBoundingClientRect()
      const r = img.getBoundingClientRect()
      return Math.abs(r.left - b.left) < 1 && Math.abs(r.top - b.top) < 1
        && Math.abs(r.width - b.width) < 1 && Math.abs(r.height - b.height) < 1
    })
  }

  /** Make the frame image fail to load, as a broken asset would: the bezel falls back to the CSS skin. */
  async failFrameImage(canvas = this.canvas): Promise<void> {
    await canvas.evaluate((el) => {
      const img = el.closest("[data-bezel]")?.querySelector(".dm-frame-png")
      if (!img) throw new Error("Mirror canvas has no frame image")
      img.dispatchEvent(new Event("error"))
    })
  }

  /**
   * Where the CSS skin draws its camera (`::after`) and side buttons
   * (`::before`), relative to the bezel box (0–1 fractions of its width and
   * height, centres).
   */
  async skinDecorations(canvas = this.canvas): Promise<{ camera: { x: number; y: number }; buttons: { x: number; y: number } }> {
    return canvas.evaluate((el) => {
      const bezel = el.closest("[data-bezel]") as HTMLElement | null
      if (!bezel) throw new Error("Mirror canvas has no bezel")
      const b = bezel.getBoundingClientRect()
      const centre = (pseudo: string) => {
        const cs = getComputedStyle(bezel, pseudo)
        const m = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform)
        // left/top are resolved to px; the translate(-50%) part is in the matrix.
        const x = parseFloat(cs.left) + m.e + parseFloat(cs.width) / 2
        const y = parseFloat(cs.top) + m.f + parseFloat(cs.height) / 2
        return { x: x / b.width, y: y / b.height }
      }
      return { camera: centre("::after"), buttons: centre("::before") }
    })
  }

  /** Whether the bezel draws its notch / punch-hole decoration (over the top of the screen). */
  async bezelCutoutShown(canvas = this.canvas): Promise<boolean> {
    return canvas.evaluate((el) => {
      const bezel = el.closest("[data-bezel]")
      if (!bezel) throw new Error("Mirror canvas has no bezel")
      return getComputedStyle(bezel, "::after").display !== "none"
    })
  }

  /** Whether the canvas lies wholly inside the browser window. */
  async canvasInsideWindow(canvas = this.canvas): Promise<boolean> {
    return canvas.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 0.5 && r.right <= window.innerWidth + 0.5
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
