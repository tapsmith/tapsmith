import { router } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

/**
 * NativeTabs keeps a visited tab's screen mounted, so this counter's React
 * state outlives a reset that only re-navigates. The e2e suite checks that a
 * warm reset gives the next test a fresh one, and that a screen pushed on
 * this tab's stack is gone after a reset that lands on another tab.
 */
export default function ExploreTab() {
  const [count, setCount] = useState(0)
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Explore content</Text>
      <Text style={styles.text}>{`Explore count: ${count}`}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setCount((c) => c + 1)}
        style={styles.button}
      >
        <Text style={styles.text}>Count up</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/native-tabs/explore/detail")}
        style={styles.button}
      >
        <Text style={styles.text}>Open detail</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  text: { fontSize: 18 },
  button: { paddingHorizontal: 16, paddingVertical: 8 },
})
