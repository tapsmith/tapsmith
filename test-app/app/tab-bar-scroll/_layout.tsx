import { Tabs } from "expo-router"

/**
 * Lists above a React Navigation bottom tab bar (PILOT-1370). Each tab puts a
 * row just outside the part of its list where content shows: below the list,
 * behind the tab bar; above it, scrolled past; or under a bar the screen lays
 * over the list. On iOS such a row is on screen ("visible"), but a tap cannot
 * reach it until scrollIntoView() scrolls it in.
 */
export default function TabBarScrollLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: "Below" }} />
      <Tabs.Screen name="above" options={{ title: "Above" }} />
      <Tabs.Screen name="covered" options={{ title: "Covered" }} />
    </Tabs>
  )
}
