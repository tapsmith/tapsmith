import { describe, expect, test } from "../fixtures.js"

// A switch or checkbox with no name of its own, in a clickable settings row,
// is named by its row (PILOT-1323) — the androidx SwitchPreferenceCompat and
// CheckBoxPreference shape, on nearly every native Android settings screen.
// TalkBack reads such a row as "Full black, off, switch". The row is a list's
// row, so getByRole("listitem") finds it and not the layouts inside it.
//
// Android-only: the screen is native Android Views (test-app's
// with-native-settings-screen plugin); iOS has no such screen.

async function dump(device: unknown): Promise<string> {
  // Internal gRPC client: the hierarchy dump itself is what is under test.
  const client = (device as { _client: { getUiHierarchy(): Promise<{ hierarchyXml: string }> } })._client
  return (await client.getUiHierarchy()).hierarchyXml
}

describe("a nameless control in a Preference-style row", () => {
  test.beforeEach(async ({ nativeSettingsScreen }) => {
    await nativeSettingsScreen.open()
  })

  test("getByRole and getByLabel find the switch by its row's title", async ({ nativeSettingsScreen: s }) => {
    await expect(s.fullBlack).toHaveCount(1)
    await expect(s.fullBlackByLabel).toHaveCount(1)
    await expect(s.fullBlack).not.toBeChecked()
    await expect(s.dynamicColors).toBeChecked()

    await s.fullBlack.tap()
    await expect(s.fullBlack).toBeChecked()
    await expect(s.status("Full black: on")).toBeVisible()
    // Only that row's switch changed.
    await expect(s.dynamicColors).toBeChecked()
  })

  test("getByRole and getByLabel find the checkbox by its row's title", async ({ nativeSettingsScreen: s }) => {
    await expect(s.wifiOnly).toHaveCount(1)
    await expect(s.wifiOnlyByLabel).toHaveCount(1)
    await s.wifiOnly.tap()
    await expect(s.wifiOnly).toBeChecked()
  })

  test("a switch TalkBack focuses on its own is not named by its row", async ({ nativeSettingsScreen: s }) => {
    await expect(s.switches).toHaveCount(3)
    await expect(s.syncNowByName).toHaveCount(0)
  })

  test("listitem is each row, and scoping into one row finds its switch", async ({ nativeSettingsScreen: s }) => {
    await expect(s.rows).toHaveCount(4)
    await expect(s.row("Full black")).toHaveCount(1)
    await expect(s.row("Full black").getByRole("switch")).toHaveCount(1)
    await expect(s.row("Full black")).toHaveRole("listitem")
  })

  test("the hierarchy dump carries the switch's row name and label", async ({ device, nativeSettingsScreen: s }) => {
    await expect(s.fullBlack).toBeVisible()
    const tag = (await dump(device)).match(/<node\b[^>]*class="android\.widget\.Switch"[^>]*tapsmith-label="Full black"[^>]*>/)?.[0]
    expect(tag).toContain('tapsmith-name="Full black Use full black for the dark theme"')
  })
})
