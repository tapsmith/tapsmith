import { Device } from "tapsmith"

export class DelayedListScreen {
  constructor(private device: Device) {}

  get loadButton() { return this.device.getByRole("button", { name: "Load list" }) }
  row(n: number) { return this.device.getByText(`Delayed row ${n}`, { exact: true }) }
}
