import { NativeTabs } from "expo-router/unstable-native-tabs"

/**
 * Platform-native tabs (expo-router NativeTabs), as the stock
 * `create-expo-app` template uses: a real UITabBar on iOS, whose items are
 * buttons inside the tab bar, and a Material bottom navigation bar on
 * Android. getByRole("tab") must find the items, not the bar (PILOT-514).
 */
export default function NativeTabsLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Explore</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
