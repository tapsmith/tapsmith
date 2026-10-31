import { Device } from "tapsmith"

export class CarouselScreen {
  constructor(private device: Device) {}

  get addButton() { return this.device.getByRole("button", { name: "Add to basket" }) }
  get added() { return this.device.getByTestId("carousel-added") }
}
