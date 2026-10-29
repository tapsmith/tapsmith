import { Device } from "tapsmith"

export class GesturesScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Gesture Testing", { exact: true }) }
  get lastGesture() { return this.device.getByTestId("last-gesture") }
  get tapCount() { return this.device.getByTestId("tap-count") }
  get tapArea() { return this.device.getByRole("button", { name: "Tap area" }) }
  get firstTapArea() { return this.tapArea.first() }
  get longPressArea() { return this.device.getByRole("button", { name: "Long press area" }) }
  get draggable() { return this.device.getByDescription("Draggable item") }
  get dropZone() { return this.device.getByDescription("Drop zone") }
  get pinchArea() { return this.device.getByDescription("Pinch to zoom area") }
  get swipeArea() { return this.device.getByDescription("Swipe area") }
  get noGestureText() { return this.device.getByText("Last gesture: None", { exact: true }) }
}
