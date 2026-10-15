import { Device } from "tapsmith"

export class ApiCallsScreen {
  constructor(private device: Device) {}

  // The app shows "API Calls" twice (top-bar title + page heading) on both
  // platforms; this is a screen-arrival check, so either match proves it.
  get heading() { return this.device.getByText("API Calls", { exact: true }).first() }
  get fetchPostsButton() { return this.device.getByRole("button", { name: "Fetch Posts" }) }
  get fetchUserButton() { return this.device.getByRole("button", { name: "Fetch User" }) }
  get fetch404Button() { return this.device.getByRole("button", { name: "Fetch 404" }) }
  // Hits firestore.googleapis.com — a host in the daemon's built-in
  // passthrough list — to exercise the per-platform gate (PILOT-279).
  get fetchFirestoreHostButton() { return this.device.getByRole("button", { name: "Fetch Firestore Host" }) }
  get postsHeading() { return this.device.getByText("Posts", { exact: true }) }
  get userHeading() { return this.device.getByText("User", { exact: true }) }
  get errorMessage() { return this.device.getByText("Request failed") }
  // A <Text accessibilityRole="alert">: static text on iOS, found there by
  // its name (PILOT-718).
  get postsErrorAlert() { return this.device.getByRole("alert", { name: "Failed to fetch posts" }) }
}
