import { useEffect, useState } from "react"
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// device.hideKeyboard() on a screen with no scroll view (PILOT-363). On iOS
// the keyboard can't be dismissed by dragging a scroll view here, so what
// works depends on the focused field and the screen:
//
// - "Plain input" is single-line with the default "return" key, which puts
//   the keyboard away (and fires onSubmitEditing, counted as plainSubmits).
// - "Go input" has an action return key ("go") that submits without
//   blurring. Pressing it is an app action, so hideKeyboard() must not.
// - The multiline input's return key inserts a newline.
// - "Dismiss on background tap" wraps the screen in a backdrop that calls
//   Keyboard.dismiss() when a blank spot is tapped (counted as background).
// - "Put in scroll view" renders the same content inside a ScrollView
//   (keyboardShouldPersistTaps="handled"), the kind of screen a drag dismisses
//   on — which must still touch nothing else.
// - "Centre action" fills the middle of the screen, where a dismiss gesture
//   aimed at the screen centre would land. Nothing hideKeyboard() does may
//   tap it.
export default function KeyboardScreen() {
  const [plainText, setPlainText] = useState("")
  const [goText, setGoText] = useState("")
  const [multilineText, setMultilineText] = useState("")
  const [dismissOnBackgroundTap, setDismissOnBackgroundTap] = useState(false)
  const [inScrollView, setInScrollView] = useState(false)
  const [centreTaps, setCentreTaps] = useState(0)
  const [plainSubmits, setPlainSubmits] = useState(0)
  const [goSubmits, setGoSubmits] = useState(0)
  const [backgroundTaps, setBackgroundTaps] = useState(0)

  // A warm reset navigates here rather than remounting, so clear local state
  // explicitly when the epoch moves.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setPlainText("")
    setGoText("")
    setMultilineText("")
    setDismissOnBackgroundTap(false)
    setInScrollView(false)
    setCentreTaps(0)
    setPlainSubmits(0)
    setGoSubmits(0)
    setBackgroundTaps(0)
  }, [resetEpoch])

  const content = (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={plainText}
        onChangeText={setPlainText}
        onSubmitEditing={() => setPlainSubmits((n) => n + 1)}
        placeholder="Plain input"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Plain input"
        testID="keyboard-plain-input"
      />
      <TextInput
        style={styles.input}
        value={goText}
        onChangeText={setGoText}
        onSubmitEditing={() => setGoSubmits((n) => n + 1)}
        returnKeyType="go"
        submitBehavior="submit"
        placeholder="Go input"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Go input"
        testID="keyboard-go-input"
      />
      <TextInput
        style={styles.input}
        value={multilineText}
        onChangeText={setMultilineText}
        multiline
        placeholder="Multiline input"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Multiline input"
        testID="keyboard-multiline-input"
      />

      <Text testID="keyboard-counts">
        {`centre=${centreTaps} plainSubmits=${plainSubmits} goSubmits=${goSubmits} background=${backgroundTaps}`}
      </Text>

      <TouchableOpacity
        style={styles.smallButton}
        onPress={() => setDismissOnBackgroundTap((d) => !d)}
        accessibilityRole="button"
        accessibilityLabel={
          dismissOnBackgroundTap ? "Keep keyboard on background tap" : "Dismiss on background tap"
        }
      >
        <Text style={styles.smallButtonText}>
          {dismissOnBackgroundTap ? "Background tap: dismiss" : "Background tap: nothing"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.smallButton}
        onPress={() => setInScrollView((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={inScrollView ? "Take out of scroll view" : "Put in scroll view"}
      >
        <Text style={styles.smallButtonText}>
          {inScrollView ? "In a scroll view" : "No scroll view"}
        </Text>
      </TouchableOpacity>

      {/* Blank space: nothing to tap here. */}
      <View style={styles.blank} />

      <TouchableOpacity
        style={styles.centreButton}
        onPress={() => setCentreTaps((n) => n + 1)}
        accessibilityRole="button"
        accessibilityLabel="Centre action"
      >
        <Text style={styles.buttonText}>Centre action</Text>
      </TouchableOpacity>
    </View>
  )

  if (inScrollView) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.fill}
        keyboardShouldPersistTaps="handled"
      >
        {content}
      </ScrollView>
    )
  }
  if (!dismissOnBackgroundTap) return content
  return (
    <Pressable
      style={styles.fill}
      accessible={false}
      onPress={() => {
        setBackgroundTaps((n) => n + 1)
        Keyboard.dismiss()
      }}
    >
      {content}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
    backgroundColor: "#f5f5f5",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  smallButton: {
    alignSelf: "flex-start",
    backgroundColor: "#555",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  smallButtonText: {
    color: "#fff",
    fontSize: 14,
  },
  blank: {
    height: 24,
  },
  centreButton: {
    flex: 1,
    backgroundColor: "#007AFF",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
})
