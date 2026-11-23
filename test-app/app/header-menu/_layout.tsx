import { Stack, Tabs } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text } from "react-native"

/**
 * React Navigation bottom tabs under a header with a button at each end, as
 * an app with a drawer toggle in its header has. On iOS, XCTest's live query
 * lists the tab bar's buttons before the header's, although the header comes
 * first in the tree, so a positional locator
 * (getByRole("button").first()) must still tap the header's button.
 */
export default function HeaderMenuLayout() {
  const [menuTaps, setMenuTaps] = useState(0)
  const [addTaps, setAddTaps] = useState(0)
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Tabs
        screenOptions={{
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open menu"
              onPress={() => setMenuTaps((n) => n + 1)}
              style={styles.headerButton}
            >
              <Text style={styles.icon}>☰</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add item"
              onPress={() => setAddTaps((n) => n + 1)}
              style={styles.headerButton}
            >
              <Text style={styles.icon}>＋</Text>
            </Pressable>
          ),
          headerTitle: () => (
            <Text testID="header-menu-status">
              Menu {menuTaps}, add {addTaps}
            </Text>
          ),
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Home" }} />
        <Tabs.Screen name="more" options={{ title: "More" }} />
      </Tabs>
    </>
  )
}

const styles = StyleSheet.create({
  headerButton: { paddingHorizontal: 16, paddingVertical: 8 },
  icon: { fontSize: 20 },
})
