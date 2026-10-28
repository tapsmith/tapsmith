import { Device } from "tapsmith"

export class LoginScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Sign In", { exact: true }) }
  get emailField() { return this.device.getByRole("textfield", { name: "Email" }) }
  get passwordField() { return this.device.getByRole("textfield", { name: "Password" }) }
  get signInButton() { return this.device.getByRole("button", { name: "Sign in" }) }
  get forgotPasswordLink() { return this.device.getByText("Forgot password?", { exact: true }) }
  // The default substring form: on iOS the link's accessibilityLabel
  // ("Forgot password") hides its "Forgot password?" text (PILOT-880).
  get forgotPasswordLinkBySubstring() { return this.device.getByText("Forgot password?") }
  get resetAlertMessage() { return this.device.getByText("Password reset not implemented", { exact: true }) }
  get resetAlertOk() { return this.device.getByRole("button", { name: "OK", exact: true }) }
}
