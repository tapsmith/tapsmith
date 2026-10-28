import { Device } from "tapsmith"

/** test-app/app/text-matching.tsx, reached by deep link (`openScreen(device, "/text-matching")`). */
export class TextMatchingScreen {
  constructor(private device: Device) {}

  get counts() { return this.device.getByTestId("text-matching-counts") }
  get startedCount() { return this.device.getByTestId("text-matching-started") }
  /** The field labelled "Full name", with placeholder "Your name". */
  get fullNameField() { return this.device.getByLabel("Full name") }
  /** The field with no accessibility label, only its placeholder "Nickname". */
  get nicknameField() { return this.device.getByPlaceholder("Nickname") }
}
