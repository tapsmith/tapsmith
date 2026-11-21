import { Device } from "tapsmith"

/**
 * Screen objects for native-ios-test-app (SwiftUI). One file, since each
 * screen is a handful of locators; same conventions as e2e/screens/.
 */

export class NativeHomeScreen {
  constructor(private device: Device) {}

  get title() { return this.device.getByRole("heading", { name: "Native Screens" }) }
  row(name: string) { return this.device.getByRole("button", { name, exact: true }) }
  /**
   * A pushed screen's back button is labelled with this screen's title — or,
   * on the iPhone Duo, which gives it no label, named "Back" (PILOT-1260).
   */
  get backButton() { return this.device.getByRole("button", { name: /^(Native Screens|Back)$/ }) }
}

export class NativeLoginScreen {
  constructor(private device: Device) {}

  get email() { return this.device.getByPlaceholder("Email") }
  get password() { return this.device.getByPlaceholder("Password") }
  get signIn() { return this.device.getByRole("button", { name: "Sign In" }) }
  get welcome() { return this.device.getByText("Welcome, sam@example.com", { exact: true }) }
  get invalid() { return this.device.getByText("Invalid credentials", { exact: true }) }
  /** The fields by role alone: a TextField, then a SecureField (both "textfield"). */
  textField(index: number) { return this.device.getByRole("textfield").nth(index) }
}

export class NativeTogglesScreen {
  constructor(private device: Device) {}

  get darkMode() { return this.device.getByRole("switch", { name: "Dark Mode" }) }
  get notifications() { return this.device.getByRole("switch", { name: "Notifications" }) }
  /** Every switch by role alone: one per Toggle, not its knob too (PILOT-790). */
  switches(options: { checked?: boolean } = {}) { return this.device.getByRole("switch", options) }
  /** A Toggle by its label (getByLabel keeps no live element on iOS). */
  labelled(name: string) { return this.device.getByLabel(name) }
  sizeSegment(name: string, options: { selected?: boolean } = {}) {
    return this.device.getByRole("button", { name, exact: true, ...options })
  }
  selectedSize(name: string) { return this.device.getByText(`Selected size: ${name}`, { exact: true }) }
  /** The Stepper's label text, not the Stepper or its buttons (PILOT-794). */
  quantity(n: number) { return this.device.getByText(`Quantity: ${n}`, { exact: true }) }
  get increment() { return this.device.getByRole("button", { name: "Increment" }) }
  /** A Stepper is a spin button, as ARIA has it (PILOT-702). */
  get stepper() { return this.device.getByRole("spinbutton", { name: "Quantity" }) }
  get slider() { return this.device.getByRole("slider", { name: "Volume" }) }
  /** A Form row by its text: a Toggle row reads its label, not its "0"/"1" (PILOT-895). */
  row(text: string) { return this.device.getByRole("listitem").filter({ hasText: text }) }
}

export class NativeListScreen {
  constructor(private device: Device) {}

  get list() { return this.device.getByRole("list") }
  item(n: number) { return this.device.getByRole("button", { name: `Item ${n}`, exact: true }) }
  get cells() { return this.device.getByRole("listitem") }
  detail(n: number) { return this.device.getByText(`Detail for Item ${n}`, { exact: true }) }
  get search() { return this.device.getByPlaceholder("Search items") }
}

export class NativeDialogsScreen {
  constructor(private device: Device) {}

  get showAlert() { return this.device.getByRole("button", { name: "Show Alert" }) }
  get showConfirmation() { return this.device.getByRole("button", { name: "Show Confirmation" }) }
  get showSheet() { return this.device.getByRole("button", { name: "Show Sheet" }) }
  result(text: string) { return this.device.getByText(`Result: ${text}`, { exact: true }) }

  get alert() { return this.device.getByRole("alert", { name: "Delete file?" }) }
  /** A native alert is the alert role without a name too (PILOT-919). */
  get anyAlert() { return this.device.getByRole("alert") }
  get alertMessage() { return this.device.getByText("This cannot be undone.", { exact: true }) }
  get alertDelete() { return this.alert.getByRole("button", { name: "Delete" }) }
  get alertCancel() { return this.alert.getByRole("button", { name: "Cancel" }) }
  /** Every button in the alert (PILOT-862). */
  get alertButtons() { return this.alert.getByRole("button") }

  get copyLink() { return this.device.getByRole("button", { name: "Copy Link" }) }
  get sheetContent() { return this.device.getByText("Sheet content", { exact: true }) }
  get sheetDone() { return this.device.getByRole("button", { name: "Done" }) }

  get actionsMenu() { return this.device.getByRole("button", { name: "Actions" }) }
  /** An open SwiftUI Menu's items are buttons, not menu items (docs/locators.md, PILOT-702). */
  menuItem(name: string) { return this.device.getByRole("button", { name, exact: true }) }
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
  get notTappable() { return this.device.getByPlaceholder("Not tappable") }
}

export class NativeTabsScreen {
  constructor(private device: Device) {}

  get tabBar() { return this.device.getByRole("tablist") }
  get tabs() { return this.device.getByRole("tab") }
  get tabsInBar() { return this.tabBar.getByRole("tab") }
  tab(name: string, options: { selected?: boolean } = {}) { return this.device.getByRole("tab", { name, ...options }) }
  tabButton(name: string) { return this.device.getByRole("button", { name, exact: true }) }
  content(name: string) { return this.device.getByText(`${name} tab content`, { exact: true }) }
}

export class NativeSidebarTabsScreen {
  constructor(private device: Device) {}

  get tabBar() { return this.device.getByRole("tablist") }
  get tabs() { return this.device.getByRole("tab") }
  tab(name: string, options: { selected?: boolean } = {}) { return this.device.getByRole("tab", { name, ...options }) }
  content(name: string) { return this.device.getByText(`${name} tab content`, { exact: true }) }
}

export class NativeGesturesScreen {
  constructor(private device: Device) {}

  status(text: string) { return this.device.getByText(`Status: ${text}`, { exact: true }) }
  get longPressTarget() { return this.device.getByRole("button", { name: "Long press me" }) }
  get doubleTapTarget() { return this.device.getByRole("button", { name: "Double tap me" }) }
  get firstDoubleTapTarget() { return this.doubleTapTarget.first() }
  get swipeArea() { return this.device.getByTestId("swipe-area") }
  get pinchArea() { return this.device.getByTestId("pinch-area") }
}

export class NativeSlowLoadScreen {
  constructor(private device: Device) {}

  /**
   * An indeterminate ProgressView is an ActivityIndicator: a progressbar, as
   * ARIA and Android have it (PILOT-797). SwiftUI nests an unlabelled
   * indicator inside the labelled one, so name it.
   */
  get progress() { return this.device.getByRole("progressbar", { name: "Loading" }) }
  /** The same indicator by role alone (both of SwiftUI's nodes). */
  get anyProgress() { return this.device.getByRole("progressbar") }
  /** …which still matches "spinner", as it did before PILOT-797. */
  get spinner() { return this.device.getByRole("spinner", { name: "Loading" }) }
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

// ─── UIKit counterparts (hosted view controllers) ───

export class UIKitControlsScreen {
  constructor(private device: Device) {}

  /** A UISwitch with its own accessibilityLabel. */
  get wifi() { return this.device.getByRole("switch", { name: "Wi-Fi" }) }
  /** An unlabelled UISwitch beside a UILabel: the only switch with no name. */
  get bluetooth() { return this.device.getByRole("switch").nth(1) }
  status(text: string) { return this.device.getByText(text, { exact: true }) }
  segment(name: string, options: { selected?: boolean } = {}) {
    return this.device.getByRole("button", { name, exact: true, ...options })
  }
  get increment() { return this.device.getByRole("button", { name: "Increment" }) }
  /** A UIStepper is a spin button (PILOT-702): the only one on the screen. */
  get stepper() { return this.device.getByRole("spinbutton") }
  count(n: number) { return this.device.getByRole("text", { name: `Count: ${n}`, exact: true }) }
  get submit() { return this.device.getByRole("button", { name: "Submit" }) }
}

export class UIKitTableScreen {
  constructor(private device: Device) {}

  /** A row by its text (PILOT-895: a row's text is its child static text). */
  row(n: number) { return this.device.getByRole("listitem").filter({ hasText: `Row ${n}` }).first() }
  /** UIKit's disclosure indicator, a disabled button that taps through to its row. */
  chevron(n: number) { return this.row(n).getByRole("button", { name: "chevron", exact: true }) }
  checkmark(n: number) { return this.row(n).getByRole("button", { name: "checkmark", exact: true }) }
  moreInfo(n: number) { return this.row(n).getByRole("button", { name: "More Info", exact: true }) }
  /** The "Delete" swipe action, shown once the row is swiped left. */
  delete(n: number) { return this.row(n).getByRole("button", { name: "Delete", exact: true }) }
  /** Row 8's custom accessory: a UIButton that really is disabled. */
  get buy() { return this.device.getByRole("button", { name: "Buy", exact: true }) }
  /** Row 9's custom accessory: a disabled image-only button showing a checkmark. */
  get done() { return this.row(9).getByRole("button") }
  rowText(n: number) { return this.device.getByText(`Row ${n}`, { exact: true }) }
  get selection() { return this.device.getByTestId("uikit-table-selection") }
}

/**
 * A UIKit settings screen (`uikitsettings`): grouped rows with a UISwitch,
 * which UIKit labels with the row's texts joined by ", " ("Wi-Fi, Join
 * known networks"). Found by the row's title, as on Android.
 */
export class UIKitSettingsScreen {
  constructor(private device: Device) {}

  /** A row's switch by its title, the getByRole name. */
  switch(title: string, options: { exact?: boolean } = {}) {
    return this.device.getByRole("switch", { name: title, ...options })
  }
  /** A row's switch by its title, the getByLabel label. */
  labelled(text: string) { return this.device.getByLabel(text) }
  get switches() { return this.device.getByRole("switch") }
  get status() { return this.device.getByTestId("uikit-settings-status") }
}

/**
 * A UIKit table in edit mode (`uikitedit`): account rows, each an initial, a
 * code and a name, with the Remove and Reorder controls UIKit labels with the
 * row's texts ("Remove A, 981 195, Alpha (a@example.com)", PILOT-1374).
 */
export class UIKitEditScreen {
  constructor(private device: Device) {}

  /** An account's name, the row's static text. */
  account(name: string) { return this.device.getByText(name, { exact: true }) }
  /** The row's static text, by role. */
  accountText(name: string) { return this.device.getByRole("text", { name, exact: true }) }
  /** A row's Remove control, named by the row's texts after the verb. */
  remove(name: string) { return this.device.getByRole("button", { name: `Remove ${name[0]}, 981 195, ${name}`, exact: true }) }
  /** The Delete button a Remove control reveals. */
  get confirmDelete() { return this.device.getByRole("button", { name: "Delete", exact: true }) }
  get codes() { return this.device.getByText("981 195", { exact: true }) }
}

export class UIKitDialogsScreen {
  constructor(private device: Device) {}

  get showAlert() { return this.device.getByRole("button", { name: "UIKit Alert" }) }
  get showSheet() { return this.device.getByRole("button", { name: "UIKit Action Sheet" }) }
  result(text: string) { return this.device.getByText(`Result: ${text}`, { exact: true }) }
  get alert() { return this.device.getByRole("alert", { name: "Remove item?" }) }
  get anyAlert() { return this.device.getByRole("alert") }
  /** Every button in the alert (PILOT-862). */
  get alertButtons() { return this.alert.getByRole("button") }
  get remove() { return this.alert.getByRole("button", { name: "Remove" }) }
  get exportPdf() { return this.device.getByRole("button", { name: "Export PDF" }) }
}

export class UIKitKeyboardScreen {
  constructor(private device: Device) {}

  get city() { return this.device.getByPlaceholder("City") }
  entered(text: string) { return this.device.getByText(`Entered: ${text}`, { exact: true }) }
  get notes() { return this.device.getByTestId("uikit-notes") }
  /** A UITextView that can't be edited: display text (PILOT-697). */
  get terms() { return this.device.getByTestId("uikit-terms") }
  /** The screen's inputs: the City field and the notes text view, not the terms. */
  get textFields() { return this.device.getByRole("textfield") }
}

export class UIKitGesturesScreen {
  constructor(private device: Device) {}

  status(text: string) { return this.device.getByText(`Status: ${text}`, { exact: true }) }
  get doubleTapTarget() { return this.device.getByRole("button", { name: "Double tap me" }) }
  get longPressTarget() { return this.device.getByRole("button", { name: "Long press me" }) }
  get pinchTarget() { return this.device.getByRole("button", { name: "Pinch me" }) }
}

export class NativeToolbarScreen {
  constructor(private device: Device) {}

  /** A bottom-toolbar item, or a list row (both buttons). */
  button(name: string) { return this.device.getByRole("button", { name, exact: true }) }
  /** Every toolbar on screen, by role alone (PILOT-1219). */
  get toolbars() { return this.device.getByRole("toolbar") }
  lastAction(name: string) { return this.device.getByText(`Last action: ${name}`, { exact: true }) }
}

/** Stacks presented full screen from the "Back Key" screen (PILOT-1225). */
export class NativeBackKeyScreen {
  constructor(private device: Device) {}

  get openSwiftUIStack() { return this.device.getByRole("button", { name: "Open SwiftUI Stack" }) }
  get openUIKitStack() { return this.device.getByRole("button", { name: "Open UIKit Stack" }) }
  /** Each stack's root has a leading Edit button and no back button. */
  get edit() { return this.device.getByRole("button", { name: "Edit", exact: true }) }
  get done() { return this.device.getByRole("button", { name: "Done", exact: true }) }

  get swiftUIRoot() { return this.device.getByRole("heading", { name: "SwiftUI Root" }) }
  get openSwiftUIDetail() { return this.device.getByRole("button", { name: "Open SwiftUI Detail" }) }
  get swiftUIDetail() { return this.device.getByText("SwiftUI detail content", { exact: true }) }

  get uikitEditing() { return this.device.getByText("Editing: off", { exact: true }) }
  get openUIKitDetail() { return this.device.getByRole("button", { name: "Open UIKit Detail" }) }
  get uikitDetail() { return this.device.getByText("UIKit detail content", { exact: true }) }
}
