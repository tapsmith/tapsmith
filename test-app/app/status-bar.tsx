import { useState } from "react"
import { StatusBar, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

// Content laid out edge to edge, from the top of the screen, under the system
// status bar (no header, no safe-area inset). The status bar takes a touch in
// its band, so a button drawn there cannot be tapped:
//
// - "Under the status bar" fits inside the band.
// - "Partly under the status bar" starts inside the band and reaches a little
//   below it: its centre is under the bar, so a tap must aim at the part below.
//
// Each button counts its own taps, so a test can tell whether a touch got
// through. "Hide status bar" hides the bar, after which both can be tapped
// where they are.

export default function StatusBarScreen() {
  const insets = useSafeAreaInsets()
  const [underTaps, setUnderTaps] = useState(0)
  const [partlyTaps, setPartlyTaps] = useState(0)
  const [barHidden, setBarHidden] = useState(false)
  // The safe-area top inset: the status bar's band, or a little more (on an
  // iPhone with a Dynamic Island the inset is 62 pt, the bar 54 pt).
  const band = Math.max(insets.top, 24)

  return (
    <View style={styles.container}>
      <StatusBar hidden={barHidden} />
      <TouchableOpacity
        testID="status-bar-under"
        style={[styles.button, styles.under, { top: 4, height: band * 0.6 }]}
        onPress={() => setUnderTaps((n) => n + 1)}
        accessibilityRole="button"
        accessibilityLabel="Under the status bar"
      >
        <Text style={styles.buttonText}>Under</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="status-bar-partly"
        style={[styles.button, styles.partly, { top: band * 0.2, height: band * 0.6 + 16 }]}
        onPress={() => setPartlyTaps((n) => n + 1)}
        accessibilityRole="button"
        accessibilityLabel="Partly under the status bar"
      >
        <Text style={styles.buttonText}>Partly under</Text>
      </TouchableOpacity>
      <Text testID="status-bar-counts" style={[styles.counts, { top: band + 120 }]}>
        {`under=${underTaps} partly=${partlyTaps}`}
      </Text>
      <TouchableOpacity
        testID="status-bar-hide"
        style={[styles.button, styles.toggle, { top: band + 180 }]}
        onPress={() => setBarHidden((h) => !h)}
        accessibilityRole="button"
        accessibilityLabel={barHidden ? "Show status bar" : "Hide status bar"}
      >
        <Text style={styles.buttonText}>{barHidden ? "Show status bar" : "Hide status bar"}</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  button: {
    position: "absolute",
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
  },
  // Side by side, so neither is drawn over the other.
  under: { left: 16, width: "42%", backgroundColor: "#1e66f5" },
  partly: { right: 16, width: "42%", backgroundColor: "#40a02b" },
  toggle: { left: 16, right: 16, height: 48, backgroundColor: "#6c6f85" },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  counts: { position: "absolute", left: 16, right: 16, fontSize: 16 },
})
