import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-514: getByRole("tab") matched the tab *containers* — iOS's UITabBar,
// Android's TabWidget / TabLayout — so getByRole("tab", { name: "Explore" }),
// the first locator most users write against the stock create-expo-app
// template (NativeTabs), found nothing. A UITabBar's items are buttons inside
// the bar: they are now the tabs, and the bar is a "tablist".
describe("getByRole('tab') on platform-native tabs (expo-router NativeTabs)", () => {
  test.beforeEach(async ({ device, nativeTabsScreen }) => {
    await openScreen(device, "/native-tabs")
    await expect(nativeTabsScreen.homeContent).toBeVisible()
  })

  test("finds each tab by name and switches tabs", async ({ nativeTabsScreen }) => {
    await expect(nativeTabsScreen.tabs).toHaveCount(2)
    const explore = nativeTabsScreen.tab("Explore")
    await expect(explore).toHaveRole("tab")

    await explore.tap()
    await expect(nativeTabsScreen.exploreContent).toBeVisible()

    // A role-only match re-binds the right live element for the action.
    await nativeTabsScreen.tabs.first().tap()
    await expect(nativeTabsScreen.homeContent).toBeVisible()
  })

  test("the iOS tab bar is a tablist, not a tab", async ({ platform, nativeTabsScreen }) => {
    test.skip(platform !== "ios", "Android's bottom navigation bar publishes no tablist role")
    await expect(nativeTabsScreen.tabBar).toHaveCount(1)
    await expect(nativeTabsScreen.tabBar).toHaveRole("tablist")
  })
})
