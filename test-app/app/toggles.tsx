import { useTapsmithResetEpoch } from "@tapsmith/react-native"
import { useEffect, useRef, useState } from "react"
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native"

export default function TogglesScreen() {
  const [darkMode, setDarkMode] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [sound, setSound] = useState(true)
  const [vibration, setVibration] = useState(false)

  const [agreed, setAgreed] = useState(false)
  const [newsletter, setNewsletter] = useState(false)

  const [selectedSize, setSelectedSize] = useState("medium")

  // A warm reset that lands on this screen (`appResetRoute: "/toggles"`)
  // navigates here rather than remounting, so put the screen back to its
  // initial state, scrolled to the top, when the epoch moves.
  const scrollRef = useRef<ScrollView>(null)
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setDarkMode(false)
    setNotifications(true)
    setSound(true)
    setVibration(false)
    setAgreed(false)
    setNewsletter(false)
    setSelectedSize("medium")
    scrollRef.current?.scrollTo({ y: 0, animated: false })
  }, [resetEpoch])

  const statusText = [
    darkMode ? "Dark mode on" : "Dark mode off",
    notifications ? "Notifications on" : "Notifications off",
  ].join(", ")

  return (
    <ScrollView ref={scrollRef} style={styles.container}>
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Switches
      </Text>

      <View style={styles.row}>
        <Text style={styles.label}>Dark Mode</Text>
        <Switch
          value={darkMode}
          onValueChange={setDarkMode}
          accessibilityRole="switch"
          accessibilityLabel="Dark Mode"
          accessibilityState={{ checked: darkMode }}
          testID="dark-mode-switch"
        />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Notifications</Text>
        <Switch
          value={notifications}
          onValueChange={setNotifications}
          accessibilityRole="switch"
          accessibilityLabel="Notifications"
          accessibilityState={{ checked: notifications }}
          testID="notifications-switch"
        />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Sound</Text>
        <Switch
          value={sound}
          onValueChange={setSound}
          accessibilityRole="switch"
          accessibilityLabel="Sound"
          accessibilityState={{ checked: sound }}
          testID="sound-switch"
        />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Vibration</Text>
        <Switch
          value={vibration}
          onValueChange={setVibration}
          accessibilityRole="switch"
          accessibilityLabel="Vibration"
          accessibilityState={{ checked: vibration }}
          testID="vibration-switch"
        />
      </View>

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Checkboxes
      </Text>

      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() => setAgreed(!agreed)}
        accessibilityRole="checkbox"
        accessibilityLabel="I agree to terms"
        accessibilityState={{ checked: agreed }}
        testID="agree-checkbox"
      >
        <View style={[styles.checkbox, agreed && styles.checkboxChecked]}>
          {agreed && <Text style={styles.checkmark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>I agree to terms and conditions</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() => setNewsletter(!newsletter)}
        accessibilityRole="checkbox"
        accessibilityLabel="Subscribe to newsletter"
        accessibilityState={{ checked: newsletter }}
        testID="newsletter-checkbox"
      >
        <View style={[styles.checkbox, newsletter && styles.checkboxChecked]}>
          {newsletter && <Text style={styles.checkmark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>Subscribe to newsletter</Text>
      </TouchableOpacity>

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Radio Buttons
      </Text>

      {["small", "medium", "large"].map((size) => (
        <TouchableOpacity
          key={size}
          style={styles.radioRow}
          onPress={() => setSelectedSize(size)}
          accessibilityRole="radio"
          accessibilityLabel={size.charAt(0).toUpperCase() + size.slice(1)}
          accessibilityState={{ checked: selectedSize === size }}
          testID={`radio-${size}`}
        >
          <View style={styles.radio}>
            {selectedSize === size && <View style={styles.radioSelected} />}
          </View>
          <Text style={styles.radioLabel}>{size.charAt(0).toUpperCase() + size.slice(1)}</Text>
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Status
      </Text>
      <Text style={styles.statusText} testID="status-text">
        {statusText}
      </Text>
      <Text style={styles.statusText} testID="selected-size">
        Size: {selectedSize}
      </Text>

      <View style={styles.spacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  sectionHeader: {
    fontSize: 20,
    fontWeight: "bold",
    padding: 16,
    paddingBottom: 8,
    color: "#1a1a1a",
  },
  row: {
    backgroundColor: "#fff",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
  },
  label: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  checkboxRow: {
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: "#ccc",
    borderRadius: 4,
    marginRight: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxChecked: {
    backgroundColor: "#007AFF",
    borderColor: "#007AFF",
  },
  checkmark: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
  checkboxLabel: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  radioRow: {
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
  },
  radio: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: "#ccc",
    borderRadius: 12,
    marginRight: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  radioSelected: {
    width: 12,
    height: 12,
    backgroundColor: "#007AFF",
    borderRadius: 6,
  },
  radioLabel: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  statusText: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    fontSize: 14,
    color: "#666",
  },
  spacer: {
    height: 32,
  },
})
