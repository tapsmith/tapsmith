/**
 * PILOT-522: a non-exact getByText ignores case, as Playwright's does, and
 * `{ exact: true }` doesn't. The text-matching screen has "Get started"
 * rendered as "GET STARTED" through textTransform (the stock Expo template's
 * button, which a newcomer could not find with getByText("get started")) and
 * the "Welcome to Expo" heading.
 */
import { beforeEach, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"
import { TextMatchingScreen } from "../screens/text-matching.screen.js"

describe("Case-insensitive substring getByText (PILOT-522)", () => {
  // Tests tap counters on one screen, so each needs a fresh app state.
  test.use({ appResetScope: "test" })

  let screen: TextMatchingScreen

  beforeEach(async ({ device }) => {
    screen = new TextMatchingScreen(device)
    await openScreen(device, "/text-matching")
  })

  test("getByText finds textTransform-uppercased text typed in any case", async ({ device }) => {
    await device.getByText("get started").tap()
    await expect(screen.startedCount).toHaveText("started=1")
    await device.getByText("Get Started").tap()
    await expect(screen.startedCount).toHaveText("started=2")
  })

  test("a differently-cased substring resolves to its element for actions", async ({ device }) => {
    await expect(device.getByText("WELCOME TO expo")).toHaveCount(1)
    await device.getByText("welcome to").tap()
    await expect(screen.counts).toHaveText("welcome=1 save=0")
  })

  test("exact matching stays case-sensitive", async ({ device }) => {
    await expect(device.getByText("welcome to expo", { exact: true })).toHaveCount(0)
    await expect(device.getByText("Welcome to Expo", { exact: true })).toHaveCount(1)
  })
})
