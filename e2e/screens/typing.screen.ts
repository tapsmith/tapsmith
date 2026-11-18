import { Device } from "tapsmith"

export class TypingScreen {
  constructor(private device: Device) {}

  /** A controlled field whose change handler holds the JavaScript thread (PILOT-1012). */
  get slowInput() { return this.device.getByRole("textfield", { name: "Slow input" }) }
  /** What the slow field holds, as `slow=<value>`. */
  get slowValue() { return this.device.getByTestId("typing-slow-value") }
  get secureInput() { return this.device.getByTestId("typing-secure-input") }
  /** How many characters the secure field holds, as `secure=<length>`. */
  get secureLength() { return this.device.getByTestId("typing-secure-length") }
  /** The first of the one-digit code boxes, which move the focus on by themselves. */
  get firstCodeBox() { return this.device.getByTestId("typing-code-1") }
  /** What the code boxes hold, as `code=<digits>`. */
  get codeValue() { return this.device.getByTestId("typing-code-value") }
  /** The first of the code boxes that move the focus on half a second after each digit. */
  get firstSlowCodeBox() { return this.device.getByTestId("typing-slow-code-1") }
  /** What the slow code boxes hold, as `slowcode=<digits>`. */
  get slowCodeValue() { return this.device.getByTestId("typing-slow-code-value") }
}
