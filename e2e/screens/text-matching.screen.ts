import { Device } from "tapsmith"

/** test-app/app/text-matching.tsx, reached by deep link (`openScreen(device, "/text-matching")`). */
export class TextMatchingScreen {
  constructor(private device: Device) {}

  get counts() { return this.device.getByTestId("text-matching-counts") }
  get startedCount() { return this.device.getByTestId("text-matching-started") }
}
