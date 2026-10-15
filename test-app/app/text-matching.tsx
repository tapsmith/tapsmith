import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// Text whose whitespace is not a plain ASCII space (PILOT-510). Locators
// normalize whitespace like Playwright, so each of these is found with a query
// typed with ordinary single spaces:
//
// - "Welcome to&nbsp;Expo" is the stock create-expo-app heading: the agents
//   expose the label with U+00A0 between "to" and "Expo". Tapping it counts.
// - "Line one\nLine two" breaks over two lines.
// - "Spaced   out" has a run of spaces.
// - "Save draft" is a button whose accessibility label uses U+202F (a narrow
//   no-break space), for getByRole's name; tapping it counts.
// - "Full name" is a text field whose accessibility label uses U+00A0, for
//   getByLabel.
// - "Get started" renders as "GET STARTED" through textTransform, as the
//   stock Expo template's button does: a non-exact getByText ignores case
//   (PILOT-522), so getByText("get started") finds it. Tapping it counts.
// - "Full name" above the field, also uppercased: getByText("full name")
//   matches it and the field, two element types (PILOT-522).
// - "Nickname", uppercased, above a field with no accessibility label and
//   the placeholder "Nickname": getByText("nickname") finds the field only
//   through its placeholder (PILOT-522).
//
// Reached by deep link only (not on the home list, so the home cards keep
// their positions).

export default function TextMatchingScreen() {
  const [welcomeTaps, setWelcomeTaps] = useState(0)
  const [saveTaps, setSaveTaps] = useState(0)
  const [startedTaps, setStartedTaps] = useState(0)
  const [name, setName] = useState("")
  const [nickname, setNickname] = useState("")

  // A warm reset navigates here rather than remounting, so clear local state
  // explicitly when the epoch moves.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setWelcomeTaps(0)
    setSaveTaps(0)
    setStartedTaps(0)
    setName("")
    setNickname("")
  }, [resetEpoch])

  return (
    <View style={styles.container}>
      <Text style={styles.heading} onPress={() => setWelcomeTaps((n) => n + 1)}>
        Welcome to&nbsp;Expo
      </Text>
      <Text style={styles.uppercase} onPress={() => setStartedTaps((n) => n + 1)}>
        Get started
      </Text>
      <Text style={styles.body}>{"Line one\nLine two"}</Text>
      <Text style={styles.body}>{"Spaced   out"}</Text>
      <Pressable
        style={styles.button}
        onPress={() => setSaveTaps((n) => n + 1)}
        accessibilityRole="button"
        accessibilityLabel={"Save draft"}
      >
        <Text style={styles.buttonText}>Save</Text>
      </Pressable>
      <Text style={styles.uppercase}>Full name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Your name"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={"Full name"}
      />
      <Text style={styles.uppercase}>Nickname</Text>
      <TextInput
        style={styles.input}
        value={nickname}
        onChangeText={setNickname}
        placeholder="Nickname"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text testID="text-matching-counts">{`welcome=${welcomeTaps} save=${saveTaps}`}</Text>
      <Text testID="text-matching-started">{`started=${startedTaps}`}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 16,
    gap: 12,
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#1a1a1a",
  },
  body: {
    fontSize: 16,
    color: "#333",
  },
  uppercase: {
    fontSize: 16,
    fontWeight: "600",
    color: "#007AFF",
    textTransform: "uppercase",
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ccc",
    padding: 12,
    fontSize: 16,
  },
})
