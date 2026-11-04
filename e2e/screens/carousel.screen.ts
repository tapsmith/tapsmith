import { Device } from "tapsmith"

export class CarouselScreen {
  constructor(private device: Device) {}

  get addButton() { return this.device.getByRole("button", { name: "Add to basket" }) }
  get added() { return this.device.getByTestId("carousel-added") }
  get likeButton() { return this.device.getByRole("button", { name: "Double-tap to like" }) }
  get likes() { return this.device.getByTestId("carousel-likes") }
  get giftWrap() { return this.device.getByRole("switch", { name: "Gift wrap" }) }
  get giftWrapState() { return this.device.getByTestId("carousel-gift-wrap-state") }
  get sizeButton() { return this.device.getByRole("button", { name: "Choose a size" }) }
  get sizeChosen() { return this.device.getByTestId("carousel-size-chosen") }
}
