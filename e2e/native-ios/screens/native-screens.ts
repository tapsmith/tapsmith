import { Device } from "tapsmith"

/**
 * Screen objects for native-ios-test-app (SwiftUI). One file, since each
 * screen is a handful of locators; same conventions as e2e/screens/.
 */

export class NativeHomeScreen {
  constructor(private device: Device) {}

  get title() { return this.device.getByRole("heading", { name: "Native Screens" }) }
  row(name: string) { return this.device.getByRole("button", { name, exact: true }) }
  /** A pushed screen's back button is labelled with this screen's title, not "Back". */
  get backButton() { return this.device.getByRole("button", { name: "Native Screens" }) }
}

export class NativeLoginScreen {
  constructor(private device: Device) {}

  get email() { return this.device.getByPlaceholder("Email") }
  get password() { return this.device.getByPlaceholder("Password") }
  get signIn() { return this.device.getByRole("button", { name: "Sign In" }) }
  get welcome() { return this.device.getByText("Welcome, sam@example.com", { exact: true }) }
  get invalid() { return this.device.getByText("Invalid credentials", { exact: true }) }
}

export class NativeTogglesScreen {
  constructor(private device: Device) {}

  get darkMode() { return this.device.getByRole("switch", { name: "Dark Mode" }) }
  get notifications() { return this.device.getByRole("switch", { name: "Notifications" }) }
  sizeSegment(name: string, options: { selected?: boolean } = {}) {
    return this.device.getByRole("button", { name, exact: true, ...options })
  }
  selectedSize(name: string) { return this.device.getByText(`Selected size: ${name}`, { exact: true }) }
  /**
   * The Stepper's own label text. `getByText()` would also match the Stepper
   * and its two buttons (labelled "Quantity: 1, Increment"), hence the role
   * (PILOT-794).
   */
  quantity(n: number) { return this.device.getByRole("text", { name: `Quantity: ${n}`, exact: true }) }
  get increment() { return this.device.getByRole("button", { name: "Increment" }) }
  get slider() { return this.device.getByRole("slider", { name: "Volume" }) }
}

export class NativeListScreen {
  constructor(private device: Device) {}

  get list() { return this.device.getByRole("list") }
  item(n: number) { return this.device.getByRole("button", { name: `Item ${n}`, exact: true }) }
  get cells() { return this.device.getByRole("listitem") }
  detail(n: number) { return this.device.getByText(`Detail for Item ${n}`, { exact: true }) }
}

export class NativeDialogsScreen {
  constructor(private device: Device) {}

  get showAlert() { return this.device.getByRole("button", { name: "Show Alert" }) }
  get showConfirmation() { return this.device.getByRole("button", { name: "Show Confirmation" }) }
  get showSheet() { return this.device.getByRole("button", { name: "Show Sheet" }) }
  result(text: string) { return this.device.getByText(`Result: ${text}`, { exact: true }) }

  get alert() { return this.device.getByRole("alert", { name: "Delete file?" }) }
  get alertMessage() { return this.device.getByText("This cannot be undone.", { exact: true }) }
  get alertDelete() { return this.alert.getByRole("button", { name: "Delete" }) }
  get alertCancel() { return this.alert.getByRole("button", { name: "Cancel" }) }

  get copyLink() { return this.device.getByRole("button", { name: "Copy Link" }) }
  get sheetContent() { return this.device.getByText("Sheet content", { exact: true }) }
  get sheetDone() { return this.device.getByRole("button", { name: "Done" }) }
}

export class NativeScrollScreen {
  constructor(private device: Device) {}

  row(n: number) { return this.device.getByText(`Row ${n}`, { exact: true }) }
  get end() { return this.device.getByTestId("scroll-end") }
}

export class NativeKeyboardScreen {
  constructor(private device: Device) {}

  get name() { return this.device.getByPlaceholder("Your name") }
  get nothingSubmitted() { return this.device.getByText("Nothing submitted", { exact: true }) }
  submitted(text: string) { return this.device.getByText(`Submitted: ${text}`, { exact: true }) }
  get notes() { return this.device.getByTestId("notes") }
  get saveNotes() { return this.device.getByRole("button", { name: "Save Notes" }) }
}

export class NativeTabsScreen {
  constructor(private device: Device) {}

  get tabBar() { return this.device.getByRole("tablist") }
  tab(name: string, options: { selected?: boolean } = {}) { return this.device.getByRole("tab", { name, ...options }) }
  content(name: string) { return this.device.getByText(`${name} tab content`, { exact: true }) }
}

export class NativeGesturesScreen {
  constructor(private device: Device) {}

  status(text: string) { return this.device.getByText(`Status: ${text}`, { exact: true }) }
  get longPressTarget() { return this.device.getByRole("button", { name: "Long press me" }) }
  get doubleTapTarget() { return this.device.getByRole("button", { name: "Double tap me" }) }
  get swipeArea() { return this.device.getByTestId("swipe-area") }
}

export class NativeSlowLoadScreen {
  constructor(private device: Device) {}

  /** An indeterminate ProgressView is an ActivityIndicator: role `spinner`, not `progressbar` (PILOT-797). */
  get spinner() { return this.device.getByRole("spinner").first() }
  get loaded() { return this.device.getByText("Loaded content", { exact: true }) }
}

export class NativeAccessibilityScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByRole("heading", { name: "Section Heading" }) }
  get star() { return this.device.getByRole("image", { name: "Favourite star" }) }
  get increment() { return this.device.getByRole("button", { name: "Increment" }) }
  get incrementById() { return this.device.getByTestId("increment-button") }
  count(n: number) { return this.device.getByText(`Count: ${n}`, { exact: true }) }
  get disabledAction() { return this.device.getByRole("button", { name: "Disabled Action" }) }
  get link() { return this.device.getByRole("link", { name: "Tapsmith website" }) }
  get hidden() { return this.device.getByRole("text", { name: "Hidden from accessibility" }) }
  get hintTarget() { return this.device.getByText("Hint target", { exact: true }) }
}
