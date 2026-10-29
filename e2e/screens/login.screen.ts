import { Device } from "tapsmith"

export class LoginScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Sign In", { exact: true }) }
  get emailField() { return this.device.getByRole("textfield", { name: "Email" }) }
  get passwordField() { return this.device.getByRole("textfield", { name: "Password" }) }
  /** The fields by role alone, in order: email, then the secure password field. */
  textField(index: number) { return this.device.getByRole("textfield").nth(index) }
  get signInButton() { return this.device.getByRole("button", { name: "Sign in" }) }
  // The link's accessibilityLabel: on iOS it hides the "Forgot password?" text inside it.
  get forgotPasswordLink() { return this.device.getByDescription("Forgot password") }
  get forgotPasswordText() { return this.device.getByText("Forgot password?") }
  get forgotPasswordTextExact() { return this.device.getByText("Forgot password?", { exact: true }) }
  get resetAlertMessage() { return this.device.getByText("Password reset not implemented", { exact: true }) }
  get resetAlertOk() { return this.device.getByRole("button", { name: "OK", exact: true }) }
}
