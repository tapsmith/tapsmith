import { Device } from "tapsmith"

export class AccessibilityScreen {
  constructor(private device: Device) {}

  // Navigation
  get heading() { return this.device.getByText("Accessibility Testing", { exact: true }) }
  get navCard() { return this.device.getByDescription("Accessibility") }

  // Roles
  get roleButton() { return this.device.getByRole("button", { name: "Submit form" }) }
  get roleLink() { return this.device.getByRole("link", { name: "Visit website" }) }
  get roleHeader() { return this.device.getByRole("heading", { name: "Section header" }) }
  get roleImage() { return this.device.getByRole("image", { name: "Profile photo" }) }
  get roleAlert() { return this.device.getByRole("alert", { name: "Warning message" }) }

  // Content descriptions
  get closeIcon() { return this.device.getByDescription("Close menu") }
  get cartIcon() { return this.device.getByDescription("Shopping cart with 3 items") }
  get avatar() { return this.device.getByDescription("User avatar") }

  // States
  /** A progressbar view whose accessibilityValue text is "65%". */
  get uploadProgress() { return this.device.getByTestId("state-progress") }

  // Grouped elements
  get groupedProfile() { return this.device.getByDescription("John Doe, Software Engineer, Online") }
}
