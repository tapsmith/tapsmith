import { Stack } from "expo-router"

/**
 * The Explore tab's own stack, as a tab with drill-down screens has. A warm
 * reset must leave it on its first screen even when the reset lands on
 * another tab: the e2e suite pushes the detail screen in one test and expects
 * the list in the next.
 */
export default function ExploreStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />
}
