import { Device } from "tapsmith"

export class ScrollScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Scroll Testing", { exact: true }) }
  get sectionA() { return this.device.getByText("Section A", { exact: true }) }
  get firstItem() { return this.device.getByDescription("Item A-1") }

  item(id: string) { return this.device.getByDescription(`Item ${id}`) }
}
