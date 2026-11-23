import { Device } from "tapsmith"

/** test-app/app/text-matching.tsx, reached by deep link (`openScreen(device, "/text-matching")`). */
export class TextMatchingScreen {
  constructor(private device: Device) {}

  get counts() { return this.device.getByTestId("text-matching-counts") }
  get startedCount() { return this.device.getByTestId("text-matching-started") }
  /** "Get started" as written, exactly: textTransform renders it as GET STARTED. */
  get getStartedExact() { return this.device.getByText("Get started", { exact: true }) }
  /** The field labelled "Full name", with placeholder "Your name". */
  get fullNameField() { return this.device.getByLabel("Full name") }
  /** The field with no accessibility label, only its placeholder "Nickname". */
  get nicknameField() { return this.device.getByPlaceholder("Nickname") }
  /** The gallery card's image, labelled like the caption under it. */
  get flowerGirlImage() { return this.device.getByRole("image", { name: "The Flower Girl", exact: true }) }
  /** The caption under that image. */
  get flowerGirlCaption() { return this.device.getByText("The Flower Girl", { exact: true }) }
}
