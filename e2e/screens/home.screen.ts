import { Device } from "tapsmith"

export class HomeScreen {
  constructor(private device: Device) {}

  get header() { return this.device.getByText("Test Screens", { exact: true }) }

  /**
   * The screen-sized carrier `@tapsmith/react-native` renders on every screen;
   * its text is the hooks marker (`tapsmith-hooks:1;epoch=…;nav=…`).
   */
  get hooksMarker() { return this.device.getByTestId("tapsmith-hooks") }

  // Navigation cards
  get loginCard() { return this.device.getByText("Login Form", { exact: true }) }
  get listCard() { return this.device.getByText("List", { exact: true }) }
  get togglesCard() { return this.device.getByText("Toggles", { exact: true }) }
  get spinnerCard() { return this.device.getByText("Spinner", { exact: true }) }
  get gesturesCard() { return this.device.getByText("Gestures", { exact: true }) }
  get dialogsCard() { return this.device.getByText("Dialogs", { exact: true }) }
  get slowLoadCard() { return this.device.getByText("Slow Load", { exact: true }) }
  get scrollCard() { return this.device.getByText("Scroll", { exact: true }) }
}
