import { Device } from "tapsmith"

export class ScrollScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Scroll Testing", { exact: true }) }
  get sectionA() { return this.device.getByText("Section A", { exact: true }) }
  get firstItem() { return this.device.getByDescription("Item A-1") }
  get bottomButton() { return this.device.getByRole("button", { name: "Bottom button" }) }
  get bottomPresses() { return this.device.getByTestId("scroll-bottom-presses") }

  item(id: string) { return this.device.getByDescription(`Item ${id}`) }
}
