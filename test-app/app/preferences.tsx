import { useState } from "react"
import {
  Platform,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"

// React Native's `Settings` reads and writes the app's NSUserDefaults
// (`UserDefaults.standard`), the store Capacitor Preferences, @AppStorage and
// many auth SDKs keep their state in. iOS only.
const STORAGE_KEY = "tapsmith-preferences-test"

export default function PreferencesScreen() {
  const [inputText, setInputText] = useState("")
  const [storedValue, setStoredValue] = useState("")
  const [status, setStatus] = useState("")

  const handleSave = () => {
    Settings.set({ [STORAGE_KEY]: inputText })
    setStatus("Saved")
  }

  const handleLoad = () => {
    const value: unknown = Settings.get(STORAGE_KEY)
    setStoredValue(typeof value === "string" ? value : "")
    setStatus("Loaded")
  }

  if (Platform.OS !== "ios") {
    return (
      <View style={styles.container}>
        <Text style={styles.heading} accessibilityRole="header">
          Preferences
        </Text>
        <Text style={styles.statusText}>UserDefaults exist on iOS only.</Text>
      </View>
    )
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Preferences
      </Text>

      <Text style={styles.label}>Value to store in UserDefaults</Text>
      <TextInput
        style={styles.input}
        value={inputText}
        onChangeText={setInputText}
        placeholder="Enter a value"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Preference value"
        testID="preferences-input"
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.button}
          onPress={handleSave}
          accessibilityRole="button"
          accessibilityLabel="Save preference"
          testID="preferences-save-button"
        >
          <Text style={styles.buttonText}>Save</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          onPress={handleLoad}
          accessibilityRole="button"
          accessibilityLabel="Load preference"
          testID="preferences-load-button"
        >
          <Text style={styles.buttonText}>Load</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Stored value</Text>
      <View style={styles.valueBox}>
        <Text style={styles.valueText} testID="preferences-value">
          {storedValue || "(empty)"}
        </Text>
      </View>

      <Text style={styles.statusText} testID="preferences-status">
        {status}
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 16,
    color: "#1a1a1a",
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 6,
    color: "#333",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 24,
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    flex: 1,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  valueBox: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    minHeight: 60,
    marginBottom: 16,
  },
  valueText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  statusText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
})
