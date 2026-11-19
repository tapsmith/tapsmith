import { Device } from "tapsmith"

export class TurnedScreen {
  constructor(private device: Device) {}

  get padResult() { return this.device.getByTestId("turned-pad-result") }
  get pad() { return this.device.getByDescription("Gesture pad") }
  get sizeButton() { return this.device.getByRole("button", { name: "Pick a size" }) }
  get sizeChosen() { return this.device.getByTestId("turned-size-chosen") }
  get field() { return this.device.getByTestId("turned-field") }

  /** How many gestures the pad has seen: the screen keeps its state across tests. */
  async padCount(): Promise<number> {
    return Number((await this.padResult.getText()).match(/^Pad (\d+):/)?.[1] ?? Number.NaN)
  }
}
