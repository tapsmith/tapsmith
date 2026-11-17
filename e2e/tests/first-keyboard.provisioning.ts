import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

/**
 * The first type() on a simulator that has never shown its keyboard
 * (PILOT-1226). On its first keyboard, iOS covers it with a first-use intro
 * sheet — swipe typing ("Speed up your typing by sliding your finger…"), or
 * with two keyboard languages the multilingual one ("Type English and
 * Polish") — and every key typed until it is dismissed is lost. Tapsmith marks
 * the intros as shown when the agent starts on a simulator.
 *
 * Deliberately NOT named `*.test.ts`: it proves something only on a fresh
 * simulator, which the provisioning lane creates (with a second keyboard
 * language) and the sharded suites never use. No retries: the sheet appears
 * once, so a retry would pass whether or not the intros were suppressed.
 */
describe("the first keyboard on a fresh simulator", () => {
  test.describe.configure({ retries: 0 })

  test("the first type() lands", async ({ device, typingScreen }) => {
    await openScreen(device, "/typing")
    await typingScreen.slowInput.type("hello")
    await expect(typingScreen.slowValue).toHaveText("slow=hello")
  })
})
