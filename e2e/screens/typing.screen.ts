import { Device } from "tapsmith"

export class TypingScreen {
  constructor(private device: Device) {}

  /** A controlled field whose change handler holds the JavaScript thread (PILOT-1012). */
  get slowInput() { return this.device.getByRole("textfield", { name: "Slow input" }) }
  /** What the slow field holds, as `slow=<value>`. */
  get slowValue() { return this.device.getByTestId("typing-slow-value") }
  /** Drops the second key of the first text typed into it, once per visit (an iPad field just focused). */
  get lossyInput() { return this.device.getByRole("textfield", { name: "Lossy input" }) }
  /** What the lossy field holds, as `lossy=<value>`. */
  get lossyValue() { return this.device.getByTestId("typing-lossy-value") }
  /** Starts out holding "old", and selects its text as it takes the focus. */
  get selectInput() { return this.device.getByRole("textfield", { name: "Select-on-focus input" }) }
  /** What the select-on-focus field holds, as `select=<value>`. */
  get selectValue() { return this.device.getByTestId("typing-select-value") }
  /** Keeps digits only, with a dash after the third, as an input mask does. */
  get formattedInput() { return this.device.getByRole("textfield", { name: "Formatted input" }) }
  /** What the formatted field holds, as `fmt=<value>`. */
  get formattedValue() { return this.device.getByTestId("typing-formatted-value") }
  /** Removed once it holds four characters, as a code field that submits itself is. */
  get vanishingInput() { return this.device.getByRole("textfield", { name: "Vanishing input" }) }
  /** What the vanishing field held, as `vanish=<value>`. */
  get vanishingValue() { return this.device.getByTestId("typing-vanishing-value") }
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
