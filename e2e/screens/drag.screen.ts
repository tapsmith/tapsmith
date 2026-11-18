import { Device } from "tapsmith"

export class DragScreen {
  constructor(private device: Device) {}

  get dropResult() { return this.device.getByTestId("drop-result") }
  get source() { return this.device.getByDescription("Drag source") }
  get target() { return this.device.getByDescription("Drop target") }

  // An alert, and a list below the drag row (PILOT-1258)
  get showAlertButton() { return this.device.getByRole("button", { name: "Show alert" }) }
  get alertOk() { return this.device.getByRole("button", { name: "OK", exact: true }) }
  get list() { return this.device.getByTestId("drag-list") }
  listRow(n: number) { return this.device.getByText(`List row ${n}`, { exact: true }) }

  /** How many drops the screen has seen: it keeps its state across tests. */
  async dropCount(): Promise<number> {
    return Number((await this.dropResult.getText()).match(/^Drop (\d+):/)?.[1] ?? Number.NaN)
  }
}
