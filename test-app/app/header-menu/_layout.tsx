import { Stack, Tabs } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"

/**
 * React Navigation bottom tabs under a header with a button at each end and
 * a text field between them, as an app with a drawer toggle in its header
 * has, and a second text field below the tabs. On iOS, XCTest's live query
 * lists the tab bar's buttons before the header's, and the field below the
 * tabs before the header's, although the header comes first in the tree, so
 * a positional locator (getByRole("button").first(),
 * getByRole("textfield").first()) must still act on the header's element.
 * The fields have no label, placeholder or testID, so nothing but their
 * place tells them apart.
 */
export default function HeaderMenuLayout() {
  const [menuTaps, setMenuTaps] = useState(0)
  const [addTaps, setAddTaps] = useState(0)
  const [search, setSearch] = useState("")
  const [note, setNote] = useState("")
  return (
    <View style={styles.container}>
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
            <TextInput
              value={search}
              onChangeText={setSearch}
              style={styles.field}
              autoCorrect={false}
            />
          ),
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Home" }} />
        <Tabs.Screen name="more" options={{ title: "More" }} />
      </Tabs>
      <View style={styles.footer}>
        <Text testID="header-menu-status">
          Menu {menuTaps}, add {addTaps}
        </Text>
        <Text testID="header-menu-fields">
          Search “{search}”, note “{note}”
        </Text>
        <TextInput value={note} onChangeText={setNote} style={styles.field} autoCorrect={false} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerButton: { paddingHorizontal: 16, paddingVertical: 8 },
  icon: { fontSize: 20 },
  field: {
    minWidth: 160,
    borderWidth: 1,
    borderColor: "#999",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  footer: { padding: 12, gap: 6 },
})
