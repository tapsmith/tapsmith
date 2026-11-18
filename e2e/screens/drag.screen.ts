import { Device } from "tapsmith"

export class DragScreen {
  constructor(private device: Device) {}

  get dropResult() { return this.device.getByTestId("drop-result") }
  get source() { return this.device.getByDescription("Drag source") }
  get target() { return this.device.getByDescription("Drop target") }

  /** How many drops the screen has seen: it keeps its state across tests. */
  async dropCount(): Promise<number> {
    return Number((await this.dropResult.getText()).match(/^Drop (\d+):/)?.[1] ?? Number.NaN)
  }
}
