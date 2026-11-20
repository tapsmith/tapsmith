import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native"

const ROWS = Array.from({ length: 40 }, (_, i) => `Delayed row ${i + 1}`)

/**
 * A list that loads late: "Load list" shows a spinner, and nothing that
 * scrolls, for twelve seconds, then 40 rows. scrollIntoView() on a row, called
 * straight after the tap, has to wait for the list rather than take the
 * unchanging spinner for the end of the content (PILOT-1324). The spinner
 * screen holds still on purpose: no progress text that would change it. The
 * delay outlasts the swipes and settle waits scrollIntoView() makes before it
 * judges the end, even on a slow emulator, so the wait is always what is tested.
 */
export default function DelayedListScreen() {
  const [state, setState] = useState<"idle" | "loading" | "loaded">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const load = () => {
    setState("loading")
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState("loaded"), 12000)
  }

  if (state === "loaded") {
    return (
      <FlatList
        style={styles.container}
        data={ROWS}
        keyExtractor={(row) => row}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rowText}>{item}</Text>
          </View>
        )}
      />
    )
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.button}
        onPress={load}
        disabled={state === "loading"}
        accessibilityRole="button"
        accessibilityLabel="Load list"
        testID="load-list"
      >
        <Text style={styles.buttonText}>Load list</Text>
      </TouchableOpacity>
      {state === "loading" && (
        <ActivityIndicator
          style={styles.spinner}
          size="large"
          color="#007AFF"
          testID="list-loading"
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    margin: 16,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  spinner: { marginTop: 120 },
  row: {
    backgroundColor: "#fff",
    padding: 20,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 8,
  },
  rowText: { fontSize: 16, color: "#1a1a1a" },
})
