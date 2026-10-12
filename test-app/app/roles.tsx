import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

// React Native accessibilityRole values with no native widget (PILOT-664).
// Android publishes each as a role description on a generic View; iOS's new
// architecture publishes nothing for them, so tests find them there by name.
const MENU_ITEMS = ["Copy", "Paste"]

export default function RolesScreen() {
  const [lastAction, setLastAction] = useState("none")
  const [bold, setBold] = useState(false)

  return (
    <View style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Roles
      </Text>

      <View style={styles.menu} accessibilityRole="menu" testID="edit-menu">
        {MENU_ITEMS.map((item) => (
          <Pressable
            key={item}
            style={styles.menuItem}
            onPress={() => setLastAction(item)}
            accessibilityRole="menuitem"
            accessibilityLabel={item}
            testID={`menu-item-${item.toLowerCase()}`}
          >
            <Text style={styles.menuItemText}>{item}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.toggle, bold && styles.toggleOn]}
        onPress={() => setBold(!bold)}
        accessibilityRole="togglebutton"
        accessibilityLabel="Bold"
        accessibilityState={{ checked: bold }}
        testID="bold-toggle"
      >
        <Text style={styles.toggleText}>B</Text>
      </Pressable>

      {/* A View, not a Text: iOS reports an RN Text as static text, whatever its role. */}
      <View style={styles.timer} accessible accessibilityRole="timer" accessibilityLabel="Elapsed time" testID="elapsed-timer">
        <Text style={styles.timerText}>00:42</Text>
      </View>

      <Text style={styles.status} testID="roles-status">
        {`Last action: ${lastAction}, bold ${bold ? "on" : "off"}`}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#fff" },
  heading: { fontSize: 22, fontWeight: "700", marginBottom: 16 },
  menu: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, marginBottom: 16 },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16 },
  menuItemText: { fontSize: 16 },
  toggle: {
    width: 48,
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#888",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  toggleOn: { backgroundColor: "#cde" },
  toggleText: { fontSize: 18, fontWeight: "700" },
  timer: { marginBottom: 16 },
  timerText: { fontSize: 18 },
  status: { fontSize: 14, color: "#333" },
})
