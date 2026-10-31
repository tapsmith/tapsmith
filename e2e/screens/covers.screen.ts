import { Device } from "tapsmith"

export class CoversScreen {
  constructor(private device: Device) {}

  get counts() { return this.device.getByTestId("covers-counts") }

  get loadBrieflyButton() { return this.device.getByRole("button", { name: "Load briefly" }) }
  get keepLoadingButton() { return this.device.getByRole("button", { name: "Keep loading" }) }
  get stopLoadingButton() { return this.device.getByRole("button", { name: "Stop loading" }) }
  get rowUnderHeaderButton() { return this.device.getByRole("button", { name: "Put row 5 under header" }) }

  get behindLoading() { return this.device.getByRole("button", { name: "Behind loading" }) }
  get loadingOverlay() { return this.device.getByTestId("loading-overlay") }
  get stickyHeader() { return this.device.getByText("Sticky header") }
  get footerAction() { return this.device.getByRole("button", { name: "Footer action" }) }

  /** A list row by its label ("Row 5"). */
  row(label: string) { return this.device.getByRole("button", { name: label, exact: true }) }
  /** Every row's "Add" button: all share the name, so pick one with nth(). */
  get addButtons() { return this.device.getByRole("button", { name: "Add", exact: true }) }

  /** The first row whose centre lies under the footer, by its label. */
  async rowUnderFooter(): Promise<string> {
    const footer = await this.footerAction.boundingBox()
    if (!footer) throw new Error("the footer is not on screen")
    for (let i = 1; i <= 30; i++) {
      const box = await this.row(`Row ${i}`).boundingBox({ timeout: 1_000 }).catch(() => null)
      if (!box) continue
      const midY = box.y + box.height / 2
      if (midY > footer.y && midY < footer.y + footer.height) return `Row ${i}`
    }
    throw new Error("no row sits under the footer")
  }
}
